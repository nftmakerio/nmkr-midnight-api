// =============================================================
// Wallet Manager — persistent wallet connections with live sync
// =============================================================

import { WebSocket } from 'ws';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v7';
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
import { type NetworkConfig, getNetwork } from './networks.js';

// @ts-expect-error: Needed for GraphQL subscriptions
globalThis.WebSocket = WebSocket;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH_FILE = path.resolve(__dirname, '../../watched-wallets.json');

// ---- Types ----

export interface WatchedWalletInfo {
  seed: string;
  network: string;
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

// ---- Key Derivation ----

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
  private wallets = new Map<string, ManagedWallet>(); // key = seed:network
  private subscriptions = new Map<string, Rx.Subscription>();

  private key(seed: string, network: string) { return `${seed}:${network}`; }

  // Load watched wallets from disk and connect them
  async initialize() {
    const saved = this.loadFromDisk();
    console.log(`[WalletManager] Loading ${saved.length} watched wallet(s)...`);
    for (const info of saved) {
      try {
        await this.connect(info);
        console.log(`[WalletManager] Connected: ${info.label || info.seed.substring(0, 12)}... (${info.network})`);
      } catch (err: any) {
        console.error(`[WalletManager] Failed to connect ${info.seed.substring(0, 12)}...: ${err.message}`);
      }
    }
    console.log(`[WalletManager] ${this.wallets.size} wallet(s) active.`);
  }

  // Add a wallet to watch
  async add(seed: string, network: string, label?: string): Promise<ManagedWallet> {
    const k = this.key(seed, network);
    if (this.wallets.has(k)) {
      return this.wallets.get(k)!;
    }

    const info: WatchedWalletInfo = {
      seed,
      network,
      label,
      addedAt: new Date().toISOString(),
    };

    const managed = await this.connect(info);
    this.saveToDisk();
    return managed;
  }

  // Remove a wallet from watch
  async remove(seed: string, network: string): Promise<boolean> {
    const k = this.key(seed, network);
    const managed = this.wallets.get(k);
    if (!managed) return false;

    // Stop subscription
    const sub = this.subscriptions.get(k);
    if (sub) { sub.unsubscribe(); this.subscriptions.delete(k); }

    // Stop wallet
    try { await managed.ctx.facade.stop(); } catch {}

    this.wallets.delete(k);
    this.saveToDisk();
    return true;
  }

  // Get a managed wallet (or null)
  get(seed: string, network: string): ManagedWallet | null {
    return this.wallets.get(this.key(seed, network)) || null;
  }

  // Get wallet context for a seed — uses cached if available, otherwise creates temporary
  async getOrCreateContext(seed: string, cfg: NetworkConfig): Promise<{ ctx: WalletContext; cached: boolean }> {
    const managed = this.get(seed, cfg.networkId);
    if (managed && managed.synced) {
      return { ctx: managed.ctx, cached: true };
    }

    // Not watched — create temporary wallet
    const ctx = await this.createWalletContext(seed, cfg);

    // Wait for sync
    await Rx.firstValueFrom(
      ctx.facade.state().pipe(Rx.throttleTime(5_000), Rx.filter((s: any) => s.isSynced)),
    );

    return { ctx, cached: false };
  }

  // List all watched wallets with current state
  list(): any[] {
    return Array.from(this.wallets.values()).map(m => {
      const nightBalance = m.lastState?.unshielded?.balances?.[unshieldedToken().raw] ?? 0n;
      const dustCoins = m.lastState?.dust?.availableCoins?.length ?? 0;
      const utxoCount = m.lastState?.unshielded?.availableCoins?.length ?? 0;
      return {
        label: m.info.label,
        network: m.info.network,
        synced: m.synced,
        addedAt: m.info.addedAt,
        ...m.addresses,
        balances: {
          night: nightBalance.toString(),
          nightFormatted: `${Number(nightBalance) / 1_000_000} NIGHT`,
          dustCoins,
          utxoCount,
        },
      };
    });
  }

  // ---- Internal ----

  private async connect(info: WatchedWalletInfo): Promise<ManagedWallet> {
    const k = this.key(info.seed, info.network);
    const cfg = getNetwork(info.network);
    setNetworkId(cfg.networkId as any);

    const addresses = getAddresses(info.seed, cfg.networkId);
    const ctx = await this.createWalletContext(info.seed, cfg);

    const managed: ManagedWallet = {
      info,
      ctx,
      synced: false,
      lastState: null,
      addresses,
    };
    this.wallets.set(k, managed);

    // Subscribe to state updates (live sync)
    const sub = ctx.facade.state().pipe(
      Rx.throttleTime(3_000),
    ).subscribe({
      next: (state: any) => {
        managed.lastState = state;
        managed.synced = state.isSynced === true;
      },
      error: (err) => {
        console.error(`[WalletManager] Sync error for ${info.seed.substring(0, 12)}...: ${err.message}`);
        managed.synced = false;
      },
    });
    this.subscriptions.set(k, sub);

    // Don't wait for sync — it happens in background via the subscription
    return managed;
  }

  private async createWalletContext(seed: string, cfg: NetworkConfig): Promise<WalletContext> {
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
        return JSON.parse(fs.readFileSync(WATCH_FILE, 'utf-8'));
      }
    } catch {}
    return [];
  }

  private saveToDisk() {
    const data = Array.from(this.wallets.values()).map(m => m.info);
    fs.writeFileSync(WATCH_FILE, JSON.stringify(data, null, 2));
  }
}

// Singleton instance
export const walletManager = new WalletManager();
