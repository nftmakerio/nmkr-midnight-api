// =============================================================
// Wallet Manager — persistent wallet connections with live sync
//
// Features:
//   - Auto-reconnect on connection loss (up to 3 retries, then periodic)
//   - Activity tracking: lastAccessed timestamp updated on every query
//   - Auto-suspend: disconnects wallets idle for >15 min (saves resources)
//   - Auto-resume: re-connects suspended wallets when queried again
//   - Auto-purge: permanently removes wallets not accessed for 14 days
//   - Housekeeping runs every 60 seconds
//
// One instance = one network (set via MIDNIGHT_NETWORK env var)
// =============================================================

import { WebSocket } from 'ws';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import {
  ShieldedCoinPublicKey, ShieldedEncryptionPublicKey,
  ShieldedAddress, MidnightBech32m,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as Rx from 'rxjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type NetworkConfig, ACTIVE_NETWORK } from './networks.js';

// @ts-expect-error: Needed for GraphQL subscriptions
globalThis.WebSocket = WebSocket;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH_FILE = path.resolve(__dirname, '../../watched-wallets.json');
const ADDRESS_WATCH_FILE = path.resolve(__dirname, '../../watched-addresses.json');

// Timings
const IDLE_SUSPEND_MS = 15 * 60 * 1000;       // 15 min -> suspend (disconnect WebSocket)
const PURGE_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days -> permanent removal
const HOUSEKEEPING_MS = 60 * 1000;             // run housekeeping every 60s
const RECONNECT_DELAY_MS = 10_000;             // wait 10s before reconnect attempt
const MAX_RECONNECT_RETRIES = 3;               // retry 3 times, then wait for housekeeping

// ---- Types ----

export interface WatchedWalletInfo {
  seed: string;
  label?: string;
  addedAt: string;
  lastAccessed: string;   // updated on every query / getOrCreateContext
}

export interface WalletContext {
  facade: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

type WalletStatus = 'active' | 'suspended' | 'reconnecting';

interface ManagedWallet {
  info: WatchedWalletInfo;
  ctx: WalletContext | null;   // null when suspended
  status: WalletStatus;
  synced: boolean;
  lastState: any;
  reconnectAttempts: number;
  addresses: {
    coinPublicKey: string;
    shieldedAddress: string;
    unshieldedAddress: string;
  };
}

// ---- Helpers ----

function deriveKeysFromSeed(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hdWallet.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();
  return result.keys;
}

function getAddresses(seed: string, networkId: string) {
  const keys = deriveKeysFromSeed(seed);
  const zswapKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const coinPublicKey = zswapKeys.coinPublicKey as string;
  const encPublicKey = zswapKeys.encryptionPublicKey as string;
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);
  const shieldedCpk = ShieldedCoinPublicKey.fromHexString(coinPublicKey);
  const shieldedEpk = ShieldedEncryptionPublicKey.fromHexString(encPublicKey);
  const shieldedAddr = MidnightBech32m.encode(networkId, new ShieldedAddress(shieldedCpk, shieldedEpk));
  return {
    coinPublicKey,
    shieldedAddress: shieldedAddr.asString(),
    unshieldedAddress: unshieldedKeystore.getBech32Address().asString(),
  };
}

const isSynced = (s: any) =>
  s.isSynced === true ||
  s.shielded?.progress?.isStrictlyComplete === true ||
  s.shielded?.progress?.isCompleteWithin === true;

// ================================================================
// Wallet Manager
// ================================================================

class WalletManager {
  private wallets = new Map<string, ManagedWallet>();          // key = seed
  private addressIndex = new Map<string, string>();            // address -> seed (lookup index)
  private subscriptions = new Map<string, Rx.Subscription>();
  private housekeepingInterval: ReturnType<typeof setInterval> | null = null;

  async initialize() {
    const saved = this.loadFromDisk();
    console.log(`[WalletManager] Loading ${saved.length} watched wallet(s)...`);
    for (const info of saved) {
      // Only connect if recently accessed (< 15 min), otherwise start suspended
      const lastAccess = new Date(info.lastAccessed).getTime();
      const idle = Date.now() - lastAccess;
      if (idle < IDLE_SUSPEND_MS) {
        try {
          await this.connect(info);
          console.log(`[WalletManager] Connected: ${info.label || info.seed.substring(0, 12)}...`);
        } catch (err: any) {
          console.error(`[WalletManager] Failed: ${info.seed.substring(0, 12)}...: ${err.message}`);
          this.addSuspended(info);
        }
      } else {
        this.addSuspended(info);
        console.log(`[WalletManager] Suspended (idle ${Math.round(idle / 60000)}min): ${info.label || info.seed.substring(0, 12)}...`);
      }
    }
    console.log(`[WalletManager] ${this.wallets.size} wallet(s) loaded (${this.activeCount()} active, ${this.suspendedCount()} suspended).`);

    // Start housekeeping
    this.housekeepingInterval = setInterval(() => this.housekeep(), HOUSEKEEPING_MS);
  }

  async add(seed: string, label?: string): Promise<ManagedWallet> {
    // Check by seed
    const existing = this.wallets.get(seed);
    if (existing) {
      existing.info.lastAccessed = new Date().toISOString();
      if (existing.status === 'suspended') await this.resume(existing);
      this.saveToDisk();
      return existing;
    }

    // Check by address (same wallet, different seed format?)
    const addresses = getAddresses(seed, ACTIVE_NETWORK.networkId);
    const byAddr = this.findByAddress(addresses.unshieldedAddress);
    if (byAddr) {
      byAddr.info.lastAccessed = new Date().toISOString();
      if (byAddr.status === 'suspended') await this.resume(byAddr);
      this.saveToDisk();
      return byAddr;
    }

    const now = new Date().toISOString();
    const info: WatchedWalletInfo = { seed, label, addedAt: now, lastAccessed: now };
    const managed = await this.connect(info);
    this.saveToDisk();
    return managed;
  }

  async remove(seed: string): Promise<boolean> {
    const managed = this.wallets.get(seed);
    if (!managed) return false;
    this.unindexAddresses(managed);
    await this.disconnect(seed);
    this.wallets.delete(seed);
    this.saveToDisk();
    return true;
  }

  get(seed: string): ManagedWallet | null {
    return this.wallets.get(seed) || null;
  }

  findByAddress(address: string): ManagedWallet | null {
    // Fast lookup via index
    const seed = this.addressIndex.get(address);
    if (seed) return this.wallets.get(seed) || null;
    // Fallback: scan
    for (const m of this.wallets.values()) {
      if (m.addresses.shieldedAddress === address) return m;
      if (m.addresses.unshieldedAddress === address) return m;
      if (m.addresses.coinPublicKey === address) return m;
    }
    return null;
  }

  private indexAddresses(managed: ManagedWallet) {
    this.addressIndex.set(managed.addresses.unshieldedAddress, managed.info.seed);
    this.addressIndex.set(managed.addresses.shieldedAddress, managed.info.seed);
    this.addressIndex.set(managed.addresses.coinPublicKey, managed.info.seed);
  }

  private unindexAddresses(managed: ManagedWallet) {
    this.addressIndex.delete(managed.addresses.unshieldedAddress);
    this.addressIndex.delete(managed.addresses.shieldedAddress);
    this.addressIndex.delete(managed.addresses.coinPublicKey);
  }

  async removeByAddress(address: string): Promise<boolean> {
    const m = this.findByAddress(address);
    if (!m) return false;
    return this.remove(m.info.seed);
  }

  // Called by the service layer on every wallet-using operation.
  // Accepts a seed OR an address. If an address is given and it's in the
  // watch list, the stored seed is used automatically.
  // Updates lastAccessed, resumes if suspended, waits for sync.
  async getOrCreateContext(seedOrAddress: string): Promise<{ ctx: WalletContext; cached: boolean }> {
    // Try direct seed lookup first, then address lookup
    let managed = this.get(seedOrAddress) || this.findByAddress(seedOrAddress);

    if (managed) {
      managed.info.lastAccessed = new Date().toISOString();

      // Resume if suspended
      if (managed.status === 'suspended' || !managed.ctx) {
        await this.resume(managed);
      }

      // Wait for sync
      if (managed.ctx) {
        await Rx.firstValueFrom(managed.ctx.facade.state().pipe(Rx.filter(isSynced)));
        return { ctx: managed.ctx, cached: true };
      }
    }

    // Not watched — seedOrAddress must be a seed to create temporary wallet
    const ctx = await this.createWalletContext(seedOrAddress);
    await Rx.firstValueFrom(
      ctx.facade.state().pipe(Rx.throttleTime(5_000), Rx.filter(isSynced)),
    );
    return { ctx, cached: false };
  }

  // Get the seed for a watched address (internal use only — never expose via API)
  getSeedForAddress(address: string): string | null {
    const managed = this.findByAddress(address);
    return managed ? managed.info.seed : null;
  }

  list(): any[] {
    return Array.from(this.wallets.values()).map(m => {
      const nightBalance = m.lastState?.unshielded?.balances?.[unshieldedToken().raw] ?? 0n;
      const utxoCount = m.lastState?.unshielded?.availableCoins?.length ?? 0;

      let dustRaw = '0';
      try {
        const cb = m.lastState?.dust?.capabilities?.coinsAndBalances;
        if (cb && typeof cb.getWalletBalance === 'function') {
          dustRaw = cb.getWalletBalance(m.lastState.dust.state, new Date()).toString();
        }
      } catch {}
      const dustNum = Number(dustRaw) / 1_000_000_000_000;

      return {
        label: m.info.label,
        status: m.status,
        synced: m.synced,
        addedAt: m.info.addedAt,
        lastAccessed: m.info.lastAccessed,
        ...m.addresses,
        balances: {
          night: nightBalance.toString(),
          nightFormatted: `${Number(nightBalance) / 1_000_000} NIGHT`,
          dustRaw,
          dustFormatted: `${dustNum.toFixed(4)} DUST`,
          dustCoins: m.lastState?.dust?.availableCoins?.length ?? 0,
          utxoCount,
        },
      };
    });
  }

  // ---- Internal: connect / disconnect / suspend / resume ----

  private async connect(info: WatchedWalletInfo): Promise<ManagedWallet> {
    const cfg = ACTIVE_NETWORK;
    setNetworkId(cfg.networkId as any);

    const addresses = getAddresses(info.seed, cfg.networkId);
    const ctx = await this.createWalletContext(info.seed);

    const managed: ManagedWallet = {
      info, ctx, status: 'active', synced: false, lastState: null,
      reconnectAttempts: 0, addresses,
    };
    this.wallets.set(info.seed, managed);
    this.indexAddresses(managed);
    this.subscribe(managed);
    return managed;
  }

  private addSuspended(info: WatchedWalletInfo) {
    const addresses = getAddresses(info.seed, ACTIVE_NETWORK.networkId);
    const managed: ManagedWallet = {
      info, ctx: null, status: 'suspended', synced: false, lastState: null,
      reconnectAttempts: 0, addresses,
    };
    this.wallets.set(info.seed, managed);
    this.indexAddresses(managed);
  }

  private subscribe(managed: ManagedWallet) {
    if (!managed.ctx) return;

    // Clean up old subscription
    const oldSub = this.subscriptions.get(managed.info.seed);
    if (oldSub) oldSub.unsubscribe();

    const sub = managed.ctx.facade.state().pipe(Rx.throttleTime(3_000)).subscribe({
      next: (state: any) => {
        managed.lastState = state;
        managed.synced = isSynced(state);
        managed.reconnectAttempts = 0; // reset on successful data
      },
      error: (err) => {
        console.error(`[WalletManager] Sync error for ${managed.info.seed.substring(0, 12)}...: ${err.message}`);
        managed.synced = false;
        this.attemptReconnect(managed);
      },
    });
    this.subscriptions.set(managed.info.seed, sub);
  }

  private async attemptReconnect(managed: ManagedWallet) {
    managed.reconnectAttempts++;
    if (managed.reconnectAttempts > MAX_RECONNECT_RETRIES) {
      console.warn(`[WalletManager] Max retries reached for ${managed.info.seed.substring(0, 12)}... — will retry in housekeeping`);
      managed.status = 'suspended';
      await this.disconnect(managed.info.seed, false); // don't remove from map
      return;
    }

    managed.status = 'reconnecting';
    console.log(`[WalletManager] Reconnecting ${managed.info.seed.substring(0, 12)}... (attempt ${managed.reconnectAttempts}/${MAX_RECONNECT_RETRIES})`);

    await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));

    try {
      await this.disconnect(managed.info.seed, false);
      const ctx = await this.createWalletContext(managed.info.seed);
      managed.ctx = ctx;
      managed.status = 'active';
      this.subscribe(managed);
      console.log(`[WalletManager] Reconnected: ${managed.info.seed.substring(0, 12)}...`);
    } catch (err: any) {
      console.error(`[WalletManager] Reconnect failed: ${err.message}`);
      managed.status = 'suspended';
    }
  }

  private async resume(managed: ManagedWallet) {
    console.log(`[WalletManager] Resuming ${managed.info.label || managed.info.seed.substring(0, 12)}...`);
    try {
      const ctx = await this.createWalletContext(managed.info.seed);
      managed.ctx = ctx;
      managed.status = 'active';
      managed.reconnectAttempts = 0;
      this.subscribe(managed);
    } catch (err: any) {
      console.error(`[WalletManager] Resume failed: ${err.message}`);
      managed.status = 'suspended';
      throw err;
    }
  }

  private async disconnect(seed: string, removeFromMap = true) {
    const sub = this.subscriptions.get(seed);
    if (sub) { sub.unsubscribe(); this.subscriptions.delete(seed); }

    const managed = this.wallets.get(seed);
    if (managed?.ctx) {
      try { await managed.ctx.facade.stop(); } catch {}
      managed.ctx = null;
      managed.synced = false;
    }
  }

  // ---- Housekeeping: suspend idle, purge stale, reconnect failed ----

  private async housekeep() {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [seed, managed] of this.wallets) {
      const lastAccess = new Date(managed.info.lastAccessed).getTime();
      const idleMs = now - lastAccess;

      // Purge: not accessed for 14 days -> permanent removal
      if (idleMs > PURGE_AFTER_MS) {
        console.log(`[WalletManager] Purging ${managed.info.label || seed.substring(0, 12)}... (idle ${Math.round(idleMs / 86400000)} days)`);
        toRemove.push(seed);
        continue;
      }

      // Suspend: active but not accessed for 15 min -> disconnect to save resources
      if (managed.status === 'active' && idleMs > IDLE_SUSPEND_MS) {
        console.log(`[WalletManager] Suspending ${managed.info.label || seed.substring(0, 12)}... (idle ${Math.round(idleMs / 60000)} min)`);
        await this.disconnect(seed, false);
        managed.status = 'suspended';
      }

      // Retry reconnect for suspended wallets that were recently accessed
      if (managed.status === 'suspended' && idleMs < IDLE_SUSPEND_MS && !managed.ctx) {
        console.log(`[WalletManager] Auto-resuming ${managed.info.label || seed.substring(0, 12)}...`);
        try {
          await this.resume(managed);
        } catch {}
      }
    }

    for (const seed of toRemove) {
      const m = this.wallets.get(seed);
      if (m) this.unindexAddresses(m);
      await this.disconnect(seed, false);
      this.wallets.delete(seed);
    }

    if (toRemove.length > 0) this.saveToDisk();
  }

  private activeCount() { return [...this.wallets.values()].filter(m => m.status === 'active').length; }
  private suspendedCount() { return [...this.wallets.values()].filter(m => m.status === 'suspended').length; }

  // ---- Wallet creation ----

  private async createWalletContext(seed: string): Promise<WalletContext> {
    const cfg = ACTIVE_NETWORK;
    setNetworkId(cfg.networkId as any);

    const keys = deriveKeysFromSeed(seed);
    const networkId = getNetworkId();
    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
    const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

    const walletConfig = {
      networkId,
      indexerClientConnection: { indexerHttpUrl: cfg.indexerHttp, indexerWsUrl: cfg.indexerWs },
      provingServerUrl: new URL(cfg.proofServer),
      relayURL: new URL(cfg.nodeRpc.replace(/^http/, 'ws')),
    };

    const facade = await (WalletFacade as any).init({
      configuration: walletConfig,
      shielded: (config: any) => ShieldedWallet({ ...config }).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (config: any) => UnshieldedWallet({ ...config, txHistoryStorage: new InMemoryTransactionHistoryStorage() }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
      dust: (config: any) => DustWallet({ ...config, costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 } }).startWithSeed(keys[Roles.Dust], ledger.LedgerParameters.initialParameters().dust),
    }) as WalletFacade;

    await facade.start(shieldedSecretKeys, dustSecretKey);
    return { facade, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
  }

  // ---- Persistence ----

  private loadFromDisk(): WatchedWalletInfo[] {
    try {
      if (fs.existsSync(WATCH_FILE)) {
        const raw = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf-8'));
        return raw.map((w: any) => ({
          seed: w.seed,
          label: w.label,
          addedAt: w.addedAt || new Date().toISOString(),
          lastAccessed: w.lastAccessed || w.addedAt || new Date().toISOString(),
        }));
      }
    } catch {}
    return [];
  }

  private saveToDisk() {
    const data = Array.from(this.wallets.values()).map(m => ({
      seed: m.info.seed,
      label: m.info.label,
      addedAt: m.info.addedAt,
      lastAccessed: m.info.lastAccessed,
    }));
    fs.writeFileSync(WATCH_FILE, JSON.stringify(data, null, 2));
  }
}

// ================================================================
// Address Watch — lightweight CLI-based polling (no seed required)
// Same activity tracking and auto-purge as WalletManager.
// ================================================================

interface WatchedAddress {
  address: string;
  label?: string;
  addedAt: string;
  lastAccessed: string;
  lastBalance: any;
  lastChecked: string | null;
}

class AddressWatcher {
  private addresses = new Map<string, WatchedAddress>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs = 30_000;

  initialize() {
    const saved = this.loadFromDisk();
    for (const entry of saved) this.addresses.set(entry.address, entry);
    console.log(`[AddressWatcher] Loaded ${this.addresses.size} watched address(es).`);
    if (this.addresses.size > 0) this.startPolling();
  }

  add(address: string, label?: string): WatchedAddress {
    if (this.addresses.has(address)) {
      const existing = this.addresses.get(address)!;
      existing.lastAccessed = new Date().toISOString();
      this.saveToDisk();
      return existing;
    }

    const now = new Date().toISOString();
    const entry: WatchedAddress = {
      address, label, addedAt: now, lastAccessed: now,
      lastBalance: null, lastChecked: null,
    };
    this.addresses.set(address, entry);
    this.saveToDisk();

    if (!this.pollInterval) this.startPolling();
    this.pollAddress(entry).catch(() => {});
    return entry;
  }

  remove(address: string): boolean {
    if (!this.addresses.has(address)) return false;
    this.addresses.delete(address);
    this.saveToDisk();
    if (this.addresses.size === 0 && this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    return true;
  }

  // Mark as accessed (called when balance is queried for this address)
  touch(address: string) {
    const entry = this.addresses.get(address);
    if (entry) {
      entry.lastAccessed = new Date().toISOString();
    }
  }

  list(): any[] {
    return Array.from(this.addresses.values()).map(e => ({
      address: e.address,
      label: e.label,
      addedAt: e.addedAt,
      lastAccessed: e.lastAccessed,
      lastBalance: e.lastBalance,
      lastChecked: e.lastChecked,
    }));
  }

  private startPolling() {
    if (this.pollInterval) return;
    console.log(`[AddressWatcher] Starting poll every ${this.pollIntervalMs / 1000}s...`);
    this.pollInterval = setInterval(() => this.pollAllAndPurge(), this.pollIntervalMs);
    this.pollAllAndPurge();
  }

  private async pollAllAndPurge() {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [address, entry] of this.addresses) {
      const lastAccess = new Date(entry.lastAccessed).getTime();
      const idleMs = now - lastAccess;

      // Purge addresses not accessed for 14 days
      if (idleMs > PURGE_AFTER_MS) {
        console.log(`[AddressWatcher] Purging ${address.substring(0, 30)}... (idle ${Math.round(idleMs / 86400000)} days)`);
        toRemove.push(address);
        continue;
      }

      // Only poll addresses accessed in the last 15 min
      if (idleMs < IDLE_SUSPEND_MS) {
        await this.pollAddress(entry).catch(() => {});
      }
    }

    for (const addr of toRemove) this.addresses.delete(addr);
    if (toRemove.length > 0) this.saveToDisk();
  }

  private async pollAddress(entry: WatchedAddress) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const args = ['balance', entry.address, '--json', '--network', ACTIVE_NETWORK.networkId];
      const { stdout } = await execFileAsync('midnight', args, { timeout: 30_000 });
      const result = JSON.parse(stdout.trim());

      entry.lastBalance = {
        balances: result.balances,
        utxoCount: result.utxoCount,
        txCount: result.txCount,
      };
      entry.lastChecked = new Date().toISOString();
    } catch {
      entry.lastChecked = new Date().toISOString();
    }
  }

  private loadFromDisk(): WatchedAddress[] {
    try {
      if (fs.existsSync(ADDRESS_WATCH_FILE)) {
        const raw = JSON.parse(fs.readFileSync(ADDRESS_WATCH_FILE, 'utf-8'));
        return raw.map((a: any) => ({
          address: a.address,
          label: a.label,
          addedAt: a.addedAt || new Date().toISOString(),
          lastAccessed: a.lastAccessed || a.addedAt || new Date().toISOString(),
          lastBalance: null,
          lastChecked: null,
        }));
      }
    } catch {}
    return [];
  }

  private saveToDisk() {
    const data = Array.from(this.addresses.values()).map(
      ({ address, label, addedAt, lastAccessed }) => ({ address, label, addedAt, lastAccessed }),
    );
    fs.writeFileSync(ADDRESS_WATCH_FILE, JSON.stringify(data, null, 2));
  }
}

export const walletManager = new WalletManager();
export const addressWatcher = new AddressWatcher();
