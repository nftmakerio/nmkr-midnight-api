// =============================================================
// Wallet Manager — persistent wallet connections with live sync
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

// ---- Types ----

export interface WatchedWalletInfo {
  seed: string;
  label?: string;
  addedAt: string;
}

export interface WalletContext {
  facade: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

interface ManagedWallet {
  info: WatchedWalletInfo;
  ctx: WalletContext;
  synced: boolean;
  lastState: any;
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

// ---- Wallet Manager Singleton ----

class WalletManager {
  private wallets = new Map<string, ManagedWallet>();
  private subscriptions = new Map<string, Rx.Subscription>();

  async initialize() {
    const saved = this.loadFromDisk();
    console.log(`[WalletManager] Loading ${saved.length} watched wallet(s)...`);
    for (const info of saved) {
      try {
        await this.connect(info);
        console.log(`[WalletManager] Connected: ${info.label || info.seed.substring(0, 12)}...`);
      } catch (err: any) {
        console.error(`[WalletManager] Failed to connect ${info.seed.substring(0, 12)}...: ${err.message}`);
      }
    }
    console.log(`[WalletManager] ${this.wallets.size} wallet(s) active.`);
  }

  async add(seed: string, label?: string): Promise<ManagedWallet> {
    if (this.wallets.has(seed)) return this.wallets.get(seed)!;

    const info: WatchedWalletInfo = { seed, label, addedAt: new Date().toISOString() };
    const managed = await this.connect(info);
    this.saveToDisk();
    return managed;
  }

  async remove(seed: string): Promise<boolean> {
    const managed = this.wallets.get(seed);
    if (!managed) return false;

    const sub = this.subscriptions.get(seed);
    if (sub) { sub.unsubscribe(); this.subscriptions.delete(seed); }

    try { await managed.ctx.facade.stop(); } catch {}

    this.wallets.delete(seed);
    this.saveToDisk();
    return true;
  }

  get(seed: string): ManagedWallet | null {
    return this.wallets.get(seed) || null;
  }

  // Find a watched wallet by any of its addresses (shielded, unshielded, coinPublicKey)
  findByAddress(address: string): ManagedWallet | null {
    for (const m of this.wallets.values()) {
      if (m.addresses.shieldedAddress === address) return m;
      if (m.addresses.unshieldedAddress === address) return m;
      if (m.addresses.coinPublicKey === address) return m;
    }
    return null;
  }

  async removeByAddress(address: string): Promise<boolean> {
    const m = this.findByAddress(address);
    if (!m) return false;
    return this.remove(m.info.seed);
  }

  async getOrCreateContext(seed: string): Promise<{ ctx: WalletContext; cached: boolean }> {
    const managed = this.get(seed);
    if (managed && managed.synced) {
      return { ctx: managed.ctx, cached: true };
    }

    // Not watched — create temporary wallet
    const ctx = await this.createWalletContext(seed);
    await Rx.firstValueFrom(
      ctx.facade.state().pipe(Rx.throttleTime(5_000), Rx.filter((s: any) => s.isSynced)),
    );
    return { ctx, cached: false };
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
        synced: m.synced,
        addedAt: m.info.addedAt,
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

  // ---- Internal ----

  private async connect(info: WatchedWalletInfo): Promise<ManagedWallet> {
    const cfg = ACTIVE_NETWORK;
    setNetworkId(cfg.networkId as any);

    const addresses = getAddresses(info.seed, cfg.networkId);
    const ctx = await this.createWalletContext(info.seed);

    const managed: ManagedWallet = {
      info, ctx, synced: false, lastState: null, addresses,
    };
    this.wallets.set(info.seed, managed);

    const sub = ctx.facade.state().pipe(Rx.throttleTime(3_000)).subscribe({
      next: (state: any) => {
        managed.lastState = state;
        managed.synced = state.isSynced === true;
      },
      error: (err) => {
        console.error(`[WalletManager] Sync error for ${info.seed.substring(0, 12)}...: ${err.message}`);
        managed.synced = false;
      },
    });
    this.subscriptions.set(info.seed, sub);

    return managed;
  }

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

  private loadFromDisk(): WatchedWalletInfo[] {
    try {
      if (fs.existsSync(WATCH_FILE)) {
        const raw = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf-8'));
        // Strip legacy `network` field if present
        return raw.map((w: any) => ({ seed: w.seed, label: w.label, addedAt: w.addedAt }));
      }
    } catch {}
    return [];
  }

  private saveToDisk() {
    const data = Array.from(this.wallets.values()).map(m => m.info);
    fs.writeFileSync(WATCH_FILE, JSON.stringify(data, null, 2));
  }
}

// ================================================================
// Address Watch — lightweight CLI-based polling (no seed required)
// ================================================================

interface WatchedAddress {
  address: string;
  label?: string;
  addedAt: string;
  lastBalance: any;
  lastChecked: string | null;
}

const ADDRESS_WATCH_FILE = path.resolve(__dirname, '../../watched-addresses.json');

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
    if (this.addresses.has(address)) return this.addresses.get(address)!;

    const entry: WatchedAddress = {
      address, label, addedAt: new Date().toISOString(),
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

  list(): WatchedAddress[] {
    return Array.from(this.addresses.values());
  }

  private startPolling() {
    if (this.pollInterval) return;
    console.log(`[AddressWatcher] Starting poll every ${this.pollIntervalMs / 1000}s...`);
    this.pollInterval = setInterval(() => this.pollAll(), this.pollIntervalMs);
    this.pollAll();
  }

  private async pollAll() {
    for (const entry of this.addresses.values()) {
      await this.pollAddress(entry).catch(() => {});
    }
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
        return raw.map((a: any) => ({ ...a, lastBalance: null, lastChecked: null }));
      }
    } catch {}
    return [];
  }

  private saveToDisk() {
    const data = Array.from(this.addresses.values()).map(({ address, label, addedAt }) =>
      ({ address, label, addedAt }));
    fs.writeFileSync(ADDRESS_WATCH_FILE, JSON.stringify(data, null, 2));
  }
}

export const walletManager = new WalletManager();
export const addressWatcher = new AddressWatcher();
