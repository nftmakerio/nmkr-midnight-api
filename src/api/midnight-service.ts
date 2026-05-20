// =============================================================
// Midnight Service Layer — all blockchain operations
// Supports preview, preprod and mainnet
// =============================================================

import { WebSocket } from 'ws';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles, generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import {
  ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey,
  MidnightBech32m, UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as Rx from 'rxjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as bip39 from 'bip39';
import { type NetworkConfig, ACTIVE_NETWORK } from './networks.js';
import { walletManager, type WalletContext } from './wallet-manager.js';

// @ts-expect-error: Needed for GraphQL subscriptions
globalThis.WebSocket = WebSocket;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(__dirname, '../../contracts/managed/nmkr-nft');

// ---- Network ----
// Single fixed network per instance (set via MIDNIGHT_NETWORK env var)

let networkInitialized = false;
function activeNetwork(): NetworkConfig {
  if (!networkInitialized) {
    setNetworkId(ACTIVE_NETWORK.networkId as any);
    networkInitialized = true;
  }
  return ACTIVE_NETWORK;
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

// ---- Wallet helpers ----
// Uses WalletManager cache if available, otherwise creates temporary wallet.
// "Fast" = only wait for unshielded + dust (seconds). Use for reads.
// "Full" = wait for complete sync incl. shielded (can take minutes). Use for writes.

async function getWalletCtxFast(seedOrAddress: string): Promise<{ ctx: WalletContext; cached: boolean }> {
  return walletManager.getOrCreateContextFast(seedOrAddress);
}

async function getWalletCtx(seed: string): Promise<{ ctx: WalletContext; cached: boolean }> {
  return walletManager.getOrCreateContext(seed);
}

async function withWalletFast<T>(seedOrAddress: string, fn: (ctx: WalletContext, state: any) => Promise<T>): Promise<T> {
  const { ctx, cached } = await getWalletCtxFast(seedOrAddress);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    return await fn(ctx, state);
  } finally {
    if (!cached) await ctx.facade.stop();
  }
}

// Retryable errors: STALE_UTXO, submission errors, balance failures
// These happen when the wallet state is slightly behind the chain.
// Waiting for a fresh state update and retrying usually fixes them.
const RETRYABLE_PATTERNS = [
  'STALE_UTXO',
  'stale',
  'Transaction submission error',
  'could not balance',
  'Insufficient',
  'consumed by another',
];

const MAX_TX_RETRIES = 2;
const RETRY_WAIT_MS = 6_000; // wait 6s for new block/state update

function isRetryableError(err: any): boolean {
  const msg = err?.message || err?.toString?.() || '';
  return RETRYABLE_PATTERNS.some(p => msg.includes(p));
}

// Generic retry wrapper for any async operation that might fail with STALE_UTXO etc.
// Waits for a fresh wallet state between retries (6s = ~1 block time).
async function withRetry<T>(ctx: WalletContext, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_TX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt < MAX_TX_RETRIES && isRetryableError(err)) {
        console.log(`[Retry] Attempt ${attempt + 1}/${MAX_TX_RETRIES} failed: ${err.message?.substring(0, 80)}. Waiting ${RETRY_WAIT_MS / 1000}s...`);
        await Rx.firstValueFrom(
          ctx.facade.state().pipe(Rx.skip(1), Rx.take(1), Rx.timeout(RETRY_WAIT_MS)),
        ).catch(() => {});
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

async function withWallet<T>(seed: string, cfg: NetworkConfig, fn: (ctx: WalletContext, state: any) => Promise<T>): Promise<T> {
  const { ctx, cached } = await getWalletCtx(seed);
  try {
    return await withRetry(ctx, async () => {
      const state: any = await Rx.firstValueFrom(ctx.facade.state());
      return fn(ctx, state);
    });
  } finally {
    if (!cached) await ctx.facade.stop();
  }
}

// ================================================================
// Public API
// ================================================================

export function createNewWallet() {
  const cfg = activeNetwork();
  // Generate 24-word mnemonic (256 bits of entropy)
  const mnemonic = bip39.generateMnemonic(256);
  // Derive full 64-byte seed from mnemonic (compatible with 1AM/Lace wallets)
  const seed = bip39.mnemonicToSeedSync(mnemonic).toString('hex');
  return { ...getWalletInfo(seed), mnemonic };
}

export function getWalletInfo(seed: string) {
  const cfg = activeNetwork();
  const keys = deriveKeysFromSeed(seed);
  const zswapKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const coinPublicKey = zswapKeys.coinPublicKey as string;
  const encPublicKey = zswapKeys.encryptionPublicKey as string;
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const shieldedCpk = ShieldedCoinPublicKey.fromHexString(coinPublicKey);
  const shieldedEpk = ShieldedEncryptionPublicKey.fromHexString(encPublicKey);
  const shieldedAddr = MidnightBech32m.encode(getNetworkId(), new ShieldedAddress(shieldedCpk, shieldedEpk));

  return {
    seed,
    coinPublicKey,
    shieldedAddress: shieldedAddr.asString(),
    unshieldedAddress: unshieldedKeystore.getBech32Address().asString(),
  };
}

export function recoverFromMnemonic(mnemonic: string) {
  const cfg = activeNetwork();
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }
  // Use full 64-byte seed (compatible with 1AM/Lace wallets)
  const seed = bip39.mnemonicToSeedSync(mnemonic).toString('hex');
  return getWalletInfo(seed);
}

export async function getVersionInfo() {
  const cfg = activeNetwork();

  // API version from package.json
  const fs = await import('node:fs');
  let apiVersion = 'unknown';
  let dependencies: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));
    apiVersion = pkg.version;
    dependencies = Object.fromEntries(
      Object.entries(pkg.dependencies as Record<string, string>)
        .filter(([k]) => k.startsWith('@midnight-ntwrk/'))
    );
  } catch {}

  // Node.js version
  const nodeVersion = process.version;

  // Compact compiler + zkir versions (if available locally)
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const tryExec = async (cmd: string, args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
      return stdout.trim();
    } catch { return null; }
  };
  const compactc = await tryExec('compactc', ['--version']);
  const zkir = await tryExec('zkir', ['--version']);

  // Compiled contract version info
  let contractInfo: any = null;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(CONTRACT_PATH, 'compiler/contract-info.json'), 'utf-8'));
    contractInfo = {
      compilerVersion: info['compiler-version'],
      languageVersion: info['language-version'],
      runtimeVersion: info['runtime-version'],
    };
  } catch {}

  // Proof server version
  let proofServerVersion: string | null = null;
  try {
    const res = await fetch(`${cfg.proofServer}/version`, { signal: AbortSignal.timeout(5000) });
    proofServerVersion = (await res.text()).trim();
  } catch {}

  // Midnight Node version + chain
  let nodeRpcVersion: string | null = null;
  let nodeRpcChain: string | null = null;
  try {
    const httpUrl = cfg.nodeRpc.replace(/^wss?:/, 'https:');
    const [verRes, chainRes] = await Promise.all([
      fetch(httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_version', params: [] }),
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()),
      fetch(httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_chain', params: [] }),
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()),
    ]);
    nodeRpcVersion = verRes.result || null;
    nodeRpcChain = chainRes.result || null;
  } catch {}

  // Indexer reachability (it doesn't expose a version via GraphQL)
  let indexerReachable = false;
  try {
    const res = await fetch(cfg.indexerHttp, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: AbortSignal.timeout(5000),
    });
    indexerReachable = res.ok;
  } catch {}

  return {
    api: {
      version: apiVersion,
      nodeJs: nodeVersion,
    },
    network: {
      name: cfg.networkId,
      nodeRpc: cfg.nodeRpc,
      nodeRpcVersion,
      nodeRpcChain,
      indexer: cfg.indexerHttp,
      indexerReachable,
      proofServer: cfg.proofServer,
      proofServerVersion,
    },
    tooling: {
      compactc,
      zkir,
    },
    contract: contractInfo,
    dependencies,
  };
}

export function resolveShieldedAddress(shieldedAddr: string) {
  const parsed = MidnightBech32m.parse(shieldedAddr);
  const network = parsed.network;
  setNetworkId(network as any);
  const shielded = parsed.decode(ShieldedAddress, network);
  return {
    coinPublicKey: shielded.coinPublicKey.toHexString(),
    encryptionPublicKey: shielded.encryptionPublicKey.toHexString(),
    network,
    shieldedAddress: shieldedAddr,
  };
}

export async function getBalanceByAddress(address: string) {
  const cfg = activeNetwork();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const args = ['balance', address, '--json', '--network', cfg.networkId];

  const { stdout } = await execFileAsync('midnight', args, { timeout: 30_000 });
  const result = JSON.parse(stdout.trim());
  return {
    address: result.address,
    network: result.network || cfg.networkId,
    balances: result.balances,
    utxoCount: result.utxoCount,
    txCount: result.txCount,
  };
}

function getDustBalance(dustState: any): { dustRaw: string; dustFormatted: string; dustCoins: number } {
  let dustRaw = '0';
  try {
    const cb = dustState.capabilities?.coinsAndBalances;
    if (cb && typeof cb.getWalletBalance === 'function') {
      dustRaw = cb.getWalletBalance(dustState.state, new Date()).toString();
    }
  } catch {}
  const dustNum = Number(dustRaw) / 1_000_000_000_000;
  return {
    dustRaw,
    dustFormatted: `${dustNum.toFixed(4)} DUST`,
    dustCoins: dustState.availableCoins?.length ?? 0,
  };
}

// Accepts a seed OR an address (if the address is in the watch list,
// the stored seed is used automatically).
export async function getBalanceBySeed(seedOrAddress: string) {
  const cfg = activeNetwork();
  const resolvedSeed = walletManager.getSeedForAddress(seedOrAddress) || seedOrAddress;
  return withWalletFast(resolvedSeed, async (_ctx, state) => {
    const nightBalance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    const dust = getDustBalance(state.dust);
    const info = getWalletInfo(resolvedSeed);
    return {
      ...info,
      balances: {
        night: nightBalance.toString(),
        nightFormatted: `${Number(nightBalance) / 1_000_000} NIGHT`,
        ...dust,
      },
    };
  });
}

export interface NightRecipient {
  toAddress: string;
  amount: string | number | bigint;  // raw units (1 NIGHT = 1_000_000 raw)
}

export async function transferNight(params: {
  senderSeed: string;
  recipients: NightRecipient[];
  dustSeed?: string;
}) {
  const cfg = activeNetwork();

  if (!Array.isArray(params.recipients) || params.recipients.length === 0) {
    throw new Error('At least one recipient is required');
  }

  const { ctx: sender, cached: senderCached } = await getWalletCtx(params.senderSeed);
  let dustSecretKey = sender.dustSecretKey;
  let dustCtx: WalletContext | null = null;
  let dustCached = false;

  try {
    if (params.dustSeed && params.dustSeed !== params.senderSeed) {
      const dust = await getWalletCtx(params.dustSeed);
      dustSecretKey = dust.ctx.dustSecretKey;
      dustCtx = dust.ctx;
      dustCached = dust.cached;
    }

    const outputs = params.recipients.map(r => {
      const parsedAddr = MidnightBech32m.parse(r.toAddress);
      const receiverAddress = parsedAddr.decode(UnshieldedAddress, getNetworkId());
      const amountRaw = BigInt(r.amount);
      if (amountRaw <= 0n) throw new Error(`Invalid amount for ${r.toAddress}: must be > 0`);
      return { type: unshieldedToken().raw, amount: amountRaw, receiverAddress };
    });

    const tokenTransfer = [{
      type: 'unshielded' as const,
      outputs,
    }];

    const txHash = await withRetry(sender, async () => {
      const ttl = new Date(Date.now() + 30 * 60 * 1000);
      const recipe = await (sender.facade as any).transferTransaction(
        tokenTransfer,
        { shieldedSecretKeys: sender.shieldedSecretKeys, dustSecretKey },
        { ttl },
      );
      const signFn = (payload: Uint8Array) => sender.unshieldedKeystore.signData(payload);
      const signedRecipe = await (sender.facade as any).signRecipe(recipe, signFn);
      const finalizedTx = await sender.facade.finalizeTransaction(signedRecipe.transaction);
      return sender.facade.submitTransaction(finalizedTx);
    });

    const recipientsOut = params.recipients.map(r => ({
      toAddress: r.toAddress,
      amount: BigInt(r.amount).toString(),
      amountNight: Number(BigInt(r.amount)) / 1_000_000,
    }));
    const totalRaw = recipientsOut.reduce((s, r) => s + BigInt(r.amount), 0n);

    return {
      txHash,
      recipients: recipientsOut,
      totalRaw: totalRaw.toString(),
      totalNight: Number(totalRaw) / 1_000_000,
    };
  } finally {
    if (!senderCached) await sender.facade.stop();
    if (dustCtx && !dustCached) await dustCtx.facade.stop();
  }
}

export async function registerDust(seedOrAddress: string) {
  const cfg = activeNetwork();
  const resolvedSeed = walletManager.getSeedForAddress(seedOrAddress) || seedOrAddress;
  const { ctx, cached } = await getWalletCtxFast(resolvedSeed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const nightBalance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    const dustCoins = state.dust.availableCoins?.length ?? 0;

    const unregistered = state.unshielded.availableCoins.filter(
      (coin: any) => coin.meta?.registeredForDustGeneration !== true,
    );

    if (unregistered.length === 0 && dustCoins > 0) {
      return {
        status: 'already_registered',
        message: 'All NIGHT UTXOs are already registered for Dust.',
        nightFormatted: `${Number(nightBalance) / 1_000_000} NIGHT`,
        dustCoins,
        registeredUtxos: state.unshielded.availableCoins.length,
        unregisteredUtxos: 0,
      };
    }

    if (unregistered.length === 0 && dustCoins === 0) {
      const totalUtxos = state.unshielded.availableCoins?.length ?? 0;
      if (totalUtxos > 0) {
        return {
          status: 'waiting_for_dust',
          message: 'All NIGHT UTXOs are registered. Dust is generating — this can take several minutes.',
          nightFormatted: `${Number(nightBalance) / 1_000_000} NIGHT`,
          dustCoins: 0,
          registeredUtxos: totalUtxos,
          unregisteredUtxos: 0,
        };
      }
      return {
        status: 'no_utxos',
        message: 'No NIGHT UTXOs available. Please receive NIGHT first.',
        nightFormatted: `${Number(nightBalance) / 1_000_000} NIGHT`,
        dustCoins: 0,
        registeredUtxos: 0,
        unregisteredUtxos: 0,
      };
    }

    const txHash = await withRetry(ctx, async () => {
      const recipe = await (ctx.facade as any).registerNightUtxosForDustGeneration(
        unregistered,
        ctx.unshieldedKeystore.getPublicKey(),
        (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload),
      );
      const finalized = await (ctx.facade as any).finalizeRecipe(recipe);
      return ctx.facade.submitTransaction(finalized);
    });

    return {
      status: 'registered',
      message: `${unregistered.length} NIGHT UTXO(s) registered for Dust generation.`,
      txHash,
      nightFormatted: `${Number(nightBalance) / 1_000_000} NIGHT`,
      registeredUtxos: unregistered.length,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
  }
}

// String length limits (validated in the API, not enforced on-chain)
export const FIELD_LIMITS = {
  collection: 64,
  symbol: 32,
  name: 64,
  uri: 128,
  image: 128,
  mediaType: 64,
};

function checkLen(field: keyof typeof FIELD_LIMITS, value: string): void {
  const limit = FIELD_LIMITS[field];
  if (value.length > limit) {
    throw new Error(`${field} exceeds maximum length of ${limit} characters (got ${value.length})`);
  }
}

// Helper function: resolve CoinPublicKey from various formats
function resolveToCoinPublicKey(toCoinPublicKey?: string, toShieldedAddress?: string): string | undefined {
  if (toCoinPublicKey) return toCoinPublicKey;
  if (toShieldedAddress) {
    const resolved = resolveShieldedAddress(toShieldedAddress);
    return resolved.coinPublicKey;
  }
  return undefined;
}

export async function deployAndMintNft(params: {
  seed: string;
  toCoinPublicKey?: string;
  toShieldedAddress?: string;
  uri: string;
  name: string;
  image?: string;          // optional per-token image URI
  mediaType?: string;      // optional MIME type
  collection?: string;
  symbol?: string;
  transferable?: boolean;  // default: true
  collectionImage?: string;     // collection-level image (only on new collection)
  collectionMediaType?: string; // collection-level MIME (only on new collection)
  dustSeed?: string;
}) {
  const cfg = activeNetwork();
  const resolvedTo = resolveToCoinPublicKey(params.toCoinPublicKey, params.toShieldedAddress);
  const transferable = params.transferable !== false;
  const collectionName = params.collection || 'MidnightNFT';
  const symbolStr = params.symbol || 'MNFT';
  const tokenImage = params.image || '';
  const tokenMediaType = params.mediaType || '';
  const collImage = params.collectionImage || '';
  const collMedia = params.collectionMediaType || '';

  checkLen('collection', collectionName);
  checkLen('symbol', symbolStr);
  checkLen('name', params.name);
  checkLen('uri', params.uri);
  checkLen('image', tokenImage);
  checkLen('mediaType', tokenMediaType);
  checkLen('image', collImage);
  checkLen('mediaType', collMedia);

  const contractModule = await import(pathToFileURL(path.join(CONTRACT_PATH, 'contract', 'index.js')).href);
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(params.seed);
  const { dustCtx, dustCached } = await resolveDustCtx(params.dustSeed, params.seed);
  try {

    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();
    const ownerPubKey = { bytes: Buffer.from(coinPublicKey, 'hex') };
    const mintTo = resolvedTo
      ? { bytes: Buffer.from(resolvedTo, 'hex') }
      : ownerPubKey;

    const bridge = await createProviderBridge(ctx, dustCtx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-state-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
        privateStoragePasswordProvider: () => Promise.resolve(process.env.PRIVATE_STATE_PASSWORD || 'Midnight-NFT-Local-Dev-2026!'),
        accountId: coinPublicKey.substring(0, 32),
      }),
      publicDataProvider: indexerPublicDataProvider(cfg.indexerHttp, cfg.indexerWs),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
      walletProvider: bridge,
      midnightProvider: bridge,
    };

    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId: 'nftPrivateState',
      initialPrivateState: {},
      args: [collectionName, symbolStr, ownerPubKey, transferable, collImage, collMedia],
    });

    const contractAddress = deployed.deployTxData.public.contractAddress;
    const mintResult = await withRetry(ctx, () =>
      deployed.callTx.mint(mintTo, params.uri, params.name, tokenImage, tokenMediaType),
    );

    return {
      contractAddress,
      tokenId: mintResult.private?.result?.toString() ?? '0',
      owner: resolvedTo || coinPublicKey,
      uri: params.uri,
      name: params.name,
      image: tokenImage,
      mediaType: tokenMediaType,
      collection: collectionName,
      symbol: symbolStr,
      transferable,
      collectionImage: collImage,
      collectionMediaType: collMedia,
      ownerSeed: params.seed,
      ownerCoinPublicKey: coinPublicKey,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
    if (dustCtx && !dustCached) await dustCtx.facade.stop();
  }
}

export async function queryNftContract(contractAddress: string) {
  const cfg = activeNetwork();

  const contractModule = await import(pathToFileURL(path.join(CONTRACT_PATH, 'contract', 'index.js')).href);
  const ledgerParser = contractModule.ledger;

  const provider = indexerPublicDataProvider(cfg.indexerHttp, cfg.indexerWs);
  const contractState = await provider.queryContractState(contractAddress);
  if (!contractState) throw new Error('Contract not found');

  const state = ledgerParser(contractState.data);
  const tokens: any[] = [];
  for (const [tokenId, owner] of state.owners) {
    let uri = '';
    let name = '';
    let image = '';
    let mediaType = '';
    try { if (state.tokenURIs.member(tokenId)) uri = state.tokenURIs.lookup(tokenId); } catch {}
    try { if (state.tokenNames?.member(tokenId)) name = state.tokenNames.lookup(tokenId); } catch {}
    try { if (state.tokenImages?.member(tokenId)) image = state.tokenImages.lookup(tokenId); } catch {}
    try { if (state.tokenMediaTypes?.member(tokenId)) mediaType = state.tokenMediaTypes.lookup(tokenId); } catch {}
    tokens.push({
      tokenId: tokenId.toString(),
      owner: Buffer.from(owner.bytes).toString('hex'),
      name,
      uri,
      image,
      mediaType,
    });
  }

  return {
    contractAddress,
    collectionName: state.collectionName,
    collectionSymbol: state.collectionSymbol,
    collectionImage: state.collectionImage ?? '',
    collectionMediaType: state.collectionMediaType ?? '',
    contractOwner: Buffer.from(state.contractOwner.bytes).toString('hex'),
    transferable: state.transferable === true,
    totalSupply: Number(state.nextTokenId),
    tokens,
  };
}

export async function getUtxos(seedOrAddress: string) {
  const cfg = activeNetwork();
  const resolvedSeed = walletManager.getSeedForAddress(seedOrAddress) || seedOrAddress;
  return withWalletFast(resolvedSeed, async (_ctx, state) => {
    const info = getWalletInfo(resolvedSeed);
    const utxos = state.unshielded.availableCoins.map((coin: any, i: number) => ({
      index: i,
      value: coin.utxo.value?.toString(),
      night: Number(coin.utxo.value) / 1_000_000,
      tokenType: coin.utxo.type,
      intentHash: coin.utxo.intentHash,
      outputNo: coin.utxo.outputNo,
      ctime: coin.meta?.ctime,
      registeredForDustGeneration: coin.meta?.registeredForDustGeneration ?? false,
    }));
    const totalRaw = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    return {
      address: info.unshieldedAddress,
      totalNight: Number(totalRaw) / 1_000_000,
      totalRaw: totalRaw.toString(),
      utxoCount: utxos.length,
      utxos,
    };
  });
}

/**
 * Get full unshielded transaction history for an address — directly from
 * the indexer's GraphQL subscription, without any wallet sync or seed.
 *
 * Returns all transactions where the address appears as input (sent) or
 * output (received), including spent UTXOs (full history, not just current).
 */
export async function getAddressTransactions(address: string) {
  const cfg = activeNetwork();
  const wsUrl = cfg.indexerWs;

  return new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, ['graphql-transport-ws']);
    const hardTimeout = setTimeout(() => { try { ws.close(); } catch {} ; reject(new Error('Indexer query timeout')); }, 120_000);
    const transactions: any[] = [];
    let progressSeen = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const finish = async () => {
      clearTimeout(hardTimeout);
      if (idleTimer) clearTimeout(idleTimer);
      try { ws.close(); } catch {}
      transactions.sort((a, b) => (b.txId ?? 0) - (a.txId ?? 0));

      // Enrich each tx with full inputs/outputs (the subscription filters them
      // to our own address, so we lose the counterparty info).
      // Important: enrich 'self' too — a multi-recipient transfer where the
      // sender also gets change comes back as type='self' but does have
      // external recipients that we'd otherwise miss.
      const enrichTasks = transactions
        .filter(t => t.txHash)
        .map(async t => {
          try {
            const full = await getTransaction(t.txHash);
            const myAddr = address;
            t.allInputs = full.inputs;
            t.allOutputs = full.outputs;
            t.counterparties = {
              senders: [...new Set(full.inputs.filter((i: any) => i.from !== myAddr).map((i: any) => i.from))],
              receivers: [...new Set(full.outputs.filter((o: any) => o.to !== myAddr).map((o: any) => o.to))],
            };
          } catch {}
        });
      await Promise.allSettled(enrichTasks);

      resolve({
        address,
        network: cfg.networkId,
        transactionCount: transactions.length,
        transactions,
      });
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      // After progress is seen, close once there's been 2s of silence
      // (subscription may still emit historical txs after the progress signal).
      idleTimer = setTimeout(() => {
        if (progressSeen) finish();
      }, 2000);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'connection_init' }));
    });
    ws.on('message', (raw: any) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({
          id: '1', type: 'subscribe',
          payload: {
            query: `subscription S($address: UnshieldedAddress!) { unshieldedTransactions(address: $address, transactionId: null) {
              ... on UnshieldedTransaction {
                type: __typename
                transaction { id hash protocolVersion block { timestamp } ... on RegularTransaction { transactionResult { status } } }
                createdUtxos { owner tokenType value outputIndex intentHash ctime registeredForDustGeneration }
                spentUtxos { owner tokenType value outputIndex intentHash ctime registeredForDustGeneration }
              }
              ... on UnshieldedTransactionsProgress { type: __typename highestTransactionId }
            } }`,
            variables: { address },
          }
        }));
      } else if (msg.type === 'next' && msg.id === '1') {
        const evt = msg.payload?.data?.unshieldedTransactions;
        if (!evt) return;
        if (evt.type === 'UnshieldedTransaction') {
          const isReceiver = (evt.createdUtxos || []).some((u: any) => u.owner === address);
          const isSender   = (evt.spentUtxos   || []).some((u: any) => u.owner === address);
          const inFromMe   = (evt.spentUtxos   || []).filter((u: any) => u.owner === address);
          const outToMe    = (evt.createdUtxos || []).filter((u: any) => u.owner === address);
          const otherIn    = (evt.spentUtxos   || []).filter((u: any) => u.owner !== address);
          const otherOut   = (evt.createdUtxos || []).filter((u: any) => u.owner !== address);

          const totalIn  = inFromMe.reduce((s: number, u: any) => s + Number(u.value), 0);
          const totalOut = outToMe.reduce((s: number, u: any) => s + Number(u.value), 0);
          const netRaw   = totalOut - totalIn;

          transactions.push({
            txId: evt.transaction?.id,
            txHash: evt.transaction?.hash,
            timestamp: evt.transaction?.block?.timestamp ? new Date(parseInt(evt.transaction.block.timestamp)).toISOString() : null,
            status: evt.transaction?.transactionResult?.status,
            type: isSender && isReceiver ? 'self' : isSender ? 'sent' : 'received',
            netAmountRaw: netRaw.toString(),
            netAmount: netRaw / 1_000_000,
            netFormatted: `${netRaw >= 0 ? '+' : ''}${(netRaw / 1_000_000).toFixed(6)} NIGHT`,
            counterparties: {
              senders:   [...new Set(otherIn.map((u: any) => u.owner))],
              receivers: [...new Set(otherOut.map((u: any) => u.owner))],
            },
            myInputs:  inFromMe.map((u: any) => ({ value: u.value, night: Number(u.value) / 1_000_000, intentHash: u.intentHash, outputIndex: u.outputIndex })),
            myOutputs: outToMe.map((u: any)  => ({ value: u.value, night: Number(u.value) / 1_000_000, intentHash: u.intentHash, outputIndex: u.outputIndex, registeredForDust: u.registeredForDustGeneration })),
            allInputs:  (evt.spentUtxos   || []).map((u: any) => ({ from: u.owner, value: u.value, night: Number(u.value) / 1_000_000, tokenType: u.tokenType })),
            allOutputs: (evt.createdUtxos || []).map((u: any) => ({ to: u.owner,   value: u.value, night: Number(u.value) / 1_000_000, tokenType: u.tokenType, outputIndex: u.outputIndex })),
          });
          resetIdle();
        } else if (evt.type === 'UnshieldedTransactionsProgress') {
          progressSeen = true;
          resetIdle();
        }
      } else if (msg.type === 'error') {
        clearTimeout(hardTimeout);
        if (idleTimer) clearTimeout(idleTimer);
        try { ws.close(); } catch {}
        reject(new Error(`Indexer error: ${JSON.stringify(msg.payload)}`));
      } else if (msg.type === 'complete') {
        finish();
      }
    });
    ws.on('error', (err: any) => { clearTimeout(hardTimeout); if (idleTimer) clearTimeout(idleTimer); reject(err); });
  });
}

export async function getTransaction(txHash: string) {
  const cfg = activeNetwork();

  // Try with hash and identifier
  for (const field of ['hash', 'identifier']) {
    const query = `{ transactions(offset: {${field}:"${txHash}"}) { hash block { height timestamp } unshieldedCreatedOutputs { owner value tokenType outputIndex } unshieldedSpentOutputs { owner value tokenType } contractActions { address } } }`;
    const result: any = await fetch(cfg.indexerHttp, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }).then(r => r.json());

    if (result.data?.transactions?.length > 0) {
      const tx = result.data.transactions[0];
      return {
        txHash: tx.hash,
        blockHeight: tx.block?.height,
        timestamp: tx.block?.timestamp ? new Date(parseInt(tx.block.timestamp)).toISOString() : null,
        inputs: (tx.unshieldedSpentOutputs || []).map((o: any) => ({
          from: o.owner,
          value: o.value,
          night: Number(o.value) / 1_000_000,
          tokenType: o.tokenType,
        })),
        outputs: (tx.unshieldedCreatedOutputs || []).map((o: any) => ({
          to: o.owner,
          value: o.value,
          night: Number(o.value) / 1_000_000,
          tokenType: o.tokenType,
          outputIndex: o.outputIndex,
        })),
        contractActions: (tx.contractActions || []).map((a: any) => a.address),
      };
    }
  }

  throw new Error('Transaction not found');
}

export async function getTransactionHistory(seedOrAddress: string) {
  // Always resolve to an unshielded address and fetch the full history from
  // the indexer. No wallet sync needed, full history (sent + received).
  let unshieldedAddress: string;
  if (/^mn_addr_/.test(seedOrAddress)) {
    unshieldedAddress = seedOrAddress;
  } else if (/^mn_shield-addr_/.test(seedOrAddress)) {
    // Shielded address alone doesn't reveal the unshielded one — needs the seed.
    const knownSeed = walletManager.getSeedForAddress(seedOrAddress);
    if (!knownSeed) throw new Error('shielded address is not in watch list; pass a seed or unshielded address');
    unshieldedAddress = getWalletInfo(knownSeed).unshieldedAddress;
  } else {
    // Treat as a seed
    unshieldedAddress = getWalletInfo(seedOrAddress).unshieldedAddress;
  }
  return getAddressTransactions(unshieldedAddress);
}

// ---- Legacy wallet-centric history (only currently-owned UTXOs grouped by intentHash) ----
// Kept for backward compatibility but no longer used by /api/wallet/transactions.
export async function getWalletScopedTransactionHistory(seedOrAddress: string) {
  const cfg = activeNetwork();
  const resolvedSeed = walletManager.getSeedForAddress(seedOrAddress) || seedOrAddress;
  const { ctx, cached } = await getWalletCtxFast(resolvedSeed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const info = getWalletInfo(resolvedSeed);
    const myAddress = info.unshieldedAddress;

    // Group UTXOs by intentHash (= transactions affecting this wallet)
    const txMap = new Map<string, { utxos: any[], ctime: string | null }>();
    for (const coin of state.unshielded.availableCoins) {
      const hash = coin.utxo.intentHash;
      if (!hash) continue;
      if (!txMap.has(hash)) txMap.set(hash, { utxos: [], ctime: null });
      const entry = txMap.get(hash)!;
      entry.utxos.push(coin);
      if (coin.meta?.ctime) entry.ctime = coin.meta.ctime;
    }

    // For each transaction: try indexer lookup, otherwise fall back to UTXO-based
    const transactions: any[] = [];
    for (const [hash, data] of txMap) {
      // Try indexer lookup for full FROM/TO details
      let indexerTx: any = null;
      try { indexerTx = await getTransaction(hash); } catch {}

      if (indexerTx) {
        const isSender = indexerTx.inputs.some((o: any) => o.from === myAddress);
        const isReceiver = indexerTx.outputs.some((o: any) => o.to === myAddress);
        const totalIn = indexerTx.inputs.filter((o: any) => o.from === myAddress).reduce((s: number, o: any) => s + o.night, 0);
        const totalOut = indexerTx.outputs.filter((o: any) => o.to === myAddress).reduce((s: number, o: any) => s + o.night, 0);
        const netAmount = totalOut - totalIn;

        transactions.push({
          intentHash: hash,
          txHash: indexerTx.txHash,
          type: isSender && isReceiver ? 'self' : isSender ? 'sent' : 'received',
          netAmount,
          netFormatted: `${netAmount >= 0 ? '+' : ''}${netAmount.toFixed(6)} NIGHT`,
          timestamp: indexerTx.timestamp || data.ctime,
          blockHeight: indexerTx.blockHeight,
          inputs: indexerTx.inputs,
          outputs: indexerTx.outputs,
        });
      } else {
        // Fallback: UTXO data only (no indexer match)
        const totalReceived = data.utxos.reduce((s: number, c: any) => s + Number(c.utxo.value) / 1_000_000, 0);
        transactions.push({
          intentHash: hash,
          type: 'received',
          netAmount: totalReceived,
          netFormatted: `+${totalReceived.toFixed(6)} NIGHT`,
          timestamp: data.ctime,
          utxos: data.utxos.map((c: any) => ({
            value: c.utxo.value?.toString(),
            night: Number(c.utxo.value) / 1_000_000,
            outputNo: c.utxo.outputNo,
          })),
          note: 'Details limited — transaction not found in indexer (e.g. airdrop/genesis)',
        });
      }
    }

    // Most recent first
    transactions.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });

    return {
      address: myAddress,
      transactionCount: transactions.length,
      transactions,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
  }
}

// ================================================================
// Collection + Mint (separate operations)
// ================================================================

export async function createCollection(params: {
  seed?: string;       // Optional: if null, a new wallet is generated
  collection: string;
  symbol: string;
  transferable?: boolean;  // default: true
  image?: string;          // optional collection-level image URI
  mediaType?: string;      // optional MIME type for the collection image
  dustSeed?: string;
}) {
  const cfg = activeNetwork();
  const transferable = params.transferable !== false;
  const image = params.image || '';
  const mediaType = params.mediaType || '';

  checkLen('collection', params.collection);
  checkLen('symbol', params.symbol);
  checkLen('image', image);
  checkLen('mediaType', mediaType);

  // Generate seed or use existing one
  const seed = params.seed || Buffer.from(generateRandomSeed()).toString('hex');
  const walletInfo = getWalletInfo(seed);

  const contractModule = await import(pathToFileURL(path.join(CONTRACT_PATH, 'contract', 'index.js')).href);
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(seed);
  const { dustCtx, dustCached } = await resolveDustCtx(params.dustSeed, seed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();
    const ownerPubKey = { bytes: Buffer.from(coinPublicKey, 'hex') };

    const bridge = await createProviderBridge(ctx, dustCtx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-collection-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
        privateStoragePasswordProvider: () => Promise.resolve(process.env.PRIVATE_STATE_PASSWORD || 'Midnight-NFT-Local-Dev-2026!'),
        accountId: coinPublicKey.substring(0, 32),
      }),
      publicDataProvider: indexerPublicDataProvider(cfg.indexerHttp, cfg.indexerWs),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
      walletProvider: bridge,
      midnightProvider: bridge,
    };

    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId: 'nftPrivateState',
      initialPrivateState: {},
      args: [params.collection, params.symbol, ownerPubKey, transferable, image, mediaType],
    });

    return {
      contractAddress: deployed.deployTxData.public.contractAddress,
      ownerSeed: seed,
      ownerCoinPublicKey: coinPublicKey,
      unshieldedAddress: walletInfo.unshieldedAddress,
      collection: params.collection,
      image,
      mediaType,
      symbol: params.symbol,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
    if (dustCtx && !dustCached) await dustCtx.facade.stop();
  }
}

export async function mintNft(params: {
  ownerSeed: string;
  contractAddress?: string;  // if null -> create new collection
  uri: string;
  name: string;
  image?: string;            // optional per-token image URI
  mediaType?: string;        // optional MIME type
  toCoinPublicKey?: string;
  toShieldedAddress?: string;
  collection?: string;       // only when creating a new collection
  symbol?: string;           // only when creating a new collection
  transferable?: boolean;    // only when creating a new collection (default true)
  collectionImage?: string;     // only when creating a new collection
  collectionMediaType?: string; // only when creating a new collection
  dustSeed?: string;
}) {
  if (!params.name) throw new Error('name is required');
  const cfg = activeNetwork();

  checkLen('name', params.name);
  checkLen('uri', params.uri);
  checkLen('image', params.image || '');
  checkLen('mediaType', params.mediaType || '');

  // If no contractAddress -> automatically create a new collection
  if (!params.contractAddress) {
    const result = await deployAndMintNft({
      seed: params.ownerSeed,
      toCoinPublicKey: params.toCoinPublicKey,
      toShieldedAddress: params.toShieldedAddress,
      uri: params.uri,
      name: params.name,
      image: params.image,
      mediaType: params.mediaType,
      collection: params.collection || 'MidnightNFT',
      symbol: params.symbol || 'MNFT',
      transferable: params.transferable,
      collectionImage: params.collectionImage,
      collectionMediaType: params.collectionMediaType,
      dustSeed: params.dustSeed,
    });
    return { ...result, newCollection: true };
  }

  // Mint on existing contract
  const resolvedTo = resolveToCoinPublicKey(params.toCoinPublicKey, params.toShieldedAddress);

  const contractModule = await import(pathToFileURL(path.join(CONTRACT_PATH, 'contract', 'index.js')).href);
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(params.ownerSeed);
  const { dustCtx, dustCached } = await resolveDustCtx(params.dustSeed, params.ownerSeed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();
    const ownerPubKey = { bytes: Buffer.from(coinPublicKey, 'hex') };
    const mintTo = resolvedTo
      ? { bytes: Buffer.from(resolvedTo, 'hex') }
      : ownerPubKey;

    const bridge = await createProviderBridge(ctx, dustCtx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);

    const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-mint-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
        privateStoragePasswordProvider: () => Promise.resolve(process.env.PRIVATE_STATE_PASSWORD || 'Midnight-NFT-Local-Dev-2026!'),
        accountId: coinPublicKey.substring(0, 32),
      }),
      publicDataProvider: indexerPublicDataProvider(cfg.indexerHttp, cfg.indexerWs),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
      walletProvider: bridge,
      midnightProvider: bridge,
    };

    const contract = await findDeployedContract(providers, {
      compiledContract,
      contractAddress: params.contractAddress,
      privateStateId: 'nftPrivateState',
      initialPrivateState: {},
    });

    const tokenImage = params.image || '';
    const tokenMediaType = params.mediaType || '';
    const mintResult = await withRetry(ctx, () =>
      contract.callTx.mint(mintTo, params.uri, params.name, tokenImage, tokenMediaType),
    );

    return {
      contractAddress: params.contractAddress,
      tokenId: mintResult.private?.result?.toString() ?? '?',
      owner: resolvedTo || coinPublicKey,
      uri: params.uri,
      name: params.name,
      image: tokenImage,
      mediaType: tokenMediaType,
      newCollection: false,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
    if (dustCtx && !dustCached) await dustCtx.facade.stop();
  }
}

export async function mintBatchNft(params: {
  ownerSeed: string;
  contractAddress: string;
  items: Array<{
    name: string;
    uri: string;
    image?: string;
    mediaType?: string;
    toCoinPublicKey?: string;
    toShieldedAddress?: string;
  }>;
  dustSeed?: string;
}) {
  if (!params.contractAddress) throw new Error('contractAddress is required for mintBatch');
  if (!params.items || params.items.length === 0) throw new Error('items must contain at least one entry');
  const cfg = activeNetwork();

  // Validate all items up front
  for (const item of params.items) {
    if (!item.name) throw new Error('each item.name is required');
    if (!item.uri) throw new Error('each item.uri is required');
    checkLen('name', item.name);
    checkLen('uri', item.uri);
    checkLen('image', item.image || '');
    checkLen('mediaType', item.mediaType || '');
  }

  const contractModule = await import(pathToFileURL(path.join(CONTRACT_PATH, 'contract', 'index.js')).href);
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(params.ownerSeed);
  const { dustCtx, dustCached } = await resolveDustCtx(params.dustSeed, params.ownerSeed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();
    const ownerPubKey = { bytes: Buffer.from(coinPublicKey, 'hex') };

    const bridge = await createProviderBridge(ctx, dustCtx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);

    const { findDeployedContract, withContractScopedTransaction } =
      await import('@midnight-ntwrk/midnight-js-contracts');
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-batch-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
        privateStoragePasswordProvider: () => Promise.resolve(process.env.PRIVATE_STATE_PASSWORD || 'Midnight-NFT-Local-Dev-2026!'),
        accountId: coinPublicKey.substring(0, 32),
      }),
      publicDataProvider: indexerPublicDataProvider(cfg.indexerHttp, cfg.indexerWs),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
      walletProvider: bridge,
      midnightProvider: bridge,
    };

    const contract = await findDeployedContract(providers, {
      compiledContract,
      contractAddress: params.contractAddress,
      privateStateId: 'nftPrivateState',
      initialPrivateState: {},
    });

    // Resolve all recipients up front
    const resolved = params.items.map((item) => {
      const r = resolveToCoinPublicKey(item.toCoinPublicKey, item.toShieldedAddress);
      return r ? { bytes: Buffer.from(r, 'hex') } : ownerPubKey;
    });

    // Per-call results captured inside the scope
    const callResults: Array<{ tokenId: string; result: any }> = [];

    const finalized = await (withContractScopedTransaction as any)(
      providers,
      async (txCtx: any) => {
        for (let i = 0; i < params.items.length; i++) {
          const item = params.items[i];
          // First argument must be the txCtx — that's how callTx routes the
          // call through the scoped transaction instead of submitting directly.
          const r = await (contract.callTx as any).mint(
            txCtx,
            resolved[i],
            item.uri,
            item.name,
            item.image || '',
            item.mediaType || '',
          );
          callResults.push({
            tokenId: r.private?.result?.toString() ?? '?',
            result: r,
          });
        }
      },
      { scopeName: `mintBatch-${params.items.length}` },
    );

    return {
      contractAddress: params.contractAddress,
      txHash: (finalized as any)?.public?.txHash ?? null,
      mintedCount: callResults.length,
      tokens: callResults.map((c, i) => ({
        tokenId: c.tokenId,
        name: params.items[i].name,
        uri: params.items[i].uri,
        image: params.items[i].image || '',
        mediaType: params.items[i].mediaType || '',
        owner: params.items[i].toCoinPublicKey
          ?? (params.items[i].toShieldedAddress ? resolveToCoinPublicKey(undefined, params.items[i].toShieldedAddress) : null)
          ?? coinPublicKey,
      })),
    };
  } finally {
    if (!cached) await ctx.facade.stop();
    if (dustCtx && !dustCached) await dustCtx.facade.stop();
  }
}

export async function transferNft(params: {
  ownerSeed: string;
  contractAddress: string;
  tokenId: string;
  toCoinPublicKey?: string;
  toShieldedAddress?: string;
  dustSeed?: string;
}) {
  const cfg = activeNetwork();
  const resolvedTo = resolveToCoinPublicKey(params.toCoinPublicKey, params.toShieldedAddress);
  if (!resolvedTo) throw new Error('Either toCoinPublicKey or toShieldedAddress is required');

  const contractModule = await import(pathToFileURL(path.join(CONTRACT_PATH, 'contract', 'index.js')).href);
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(params.ownerSeed);
  const { dustCtx, dustCached } = await resolveDustCtx(params.dustSeed, params.ownerSeed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();

    const bridge = await createProviderBridge(ctx, dustCtx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);

    const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-transfer-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
        privateStoragePasswordProvider: () => Promise.resolve(process.env.PRIVATE_STATE_PASSWORD || 'Midnight-NFT-Local-Dev-2026!'),
        accountId: coinPublicKey.substring(0, 32),
      }),
      publicDataProvider: indexerPublicDataProvider(cfg.indexerHttp, cfg.indexerWs),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
      walletProvider: bridge,
      midnightProvider: bridge,
    };

    const contract = await findDeployedContract(providers, {
      compiledContract,
      contractAddress: params.contractAddress,
      privateStateId: 'nftPrivateState',
      initialPrivateState: {},
    });

    const transferTo = { bytes: Buffer.from(resolvedTo, 'hex') };
    const tokenIdBigInt = BigInt(params.tokenId);

    await contract.callTx.transfer(transferTo, tokenIdBigInt);

    return {
      contractAddress: params.contractAddress,
      tokenId: params.tokenId,
      from: coinPublicKey,
      to: resolvedTo,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
    if (dustCtx && !dustCached) await dustCtx.facade.stop();
  }
}

// ================================================================
// Approve / Burn helpers
// ================================================================

// Internal helper: connect to a deployed contract, then call a circuit on it.
// Returns whatever the circuit returned via mintResult.public.result.
async function callContract<T>(
  ownerSeed: string,
  contractAddress: string,
  fn: (contract: any) => Promise<T>,
  dustSeed?: string,
): Promise<{ result: T; coinPublicKey: string }> {
  const cfg = activeNetwork();
  const contractModule = await import(pathToFileURL(path.join(CONTRACT_PATH, 'contract', 'index.js')).href);
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(ownerSeed);
  const { dustCtx, dustCached } = await resolveDustCtx(dustSeed, ownerSeed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();

    const bridge = await createProviderBridge(ctx, dustCtx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);
    const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-call-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
        privateStoragePasswordProvider: () => Promise.resolve(process.env.PRIVATE_STATE_PASSWORD || 'Midnight-NFT-Local-Dev-2026!'),
        accountId: coinPublicKey.substring(0, 32),
      }),
      publicDataProvider: indexerPublicDataProvider(cfg.indexerHttp, cfg.indexerWs),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
      walletProvider: bridge,
      midnightProvider: bridge,
    };

    const contract = await findDeployedContract(providers, {
      compiledContract,
      contractAddress,
      privateStateId: 'nftPrivateState',
      initialPrivateState: {},
    });

    const result = await withRetry(ctx, () => fn(contract));
    return { result, coinPublicKey };
  } finally {
    if (!cached) await ctx.facade.stop();
    if (dustCtx && !dustCached) await dustCtx.facade.stop();
  }
}

// Approve a single spender for ONE specific token. Subsequent transfer() by
// the approved spender is allowed even though they don't own the token.
export async function approveNft(params: {
  ownerSeed: string;
  contractAddress: string;
  tokenId: string;
  toCoinPublicKey?: string;
  toShieldedAddress?: string;
  dustSeed?: string;
}) {
  const cfg = activeNetwork();
  const resolvedTo = resolveToCoinPublicKey(params.toCoinPublicKey, params.toShieldedAddress);
  if (!resolvedTo) throw new Error('Either toCoinPublicKey or toShieldedAddress is required');

  const { coinPublicKey } = await callContract(params.ownerSeed, params.contractAddress, async (contract) => {
    const approveTo = { bytes: Buffer.from(resolvedTo, 'hex') };
    return contract.callTx.approve(approveTo, BigInt(params.tokenId));
  }, params.dustSeed);

  return {
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
    owner: coinPublicKey,
    approved: resolvedTo,
  };
}

// Approve / revoke an operator for ALL tokens of the caller in this collection.
export async function setApprovalForAllNft(params: {
  ownerSeed: string;
  contractAddress: string;
  operatorCoinPublicKey?: string;
  operatorShieldedAddress?: string;
  approved: boolean;
  dustSeed?: string;
}) {
  const cfg = activeNetwork();
  const resolvedOperator = resolveToCoinPublicKey(params.operatorCoinPublicKey, params.operatorShieldedAddress);
  if (!resolvedOperator) throw new Error('Either operatorCoinPublicKey or operatorShieldedAddress is required');

  const { coinPublicKey } = await callContract(params.ownerSeed, params.contractAddress, async (contract) => {
    const operator = { bytes: Buffer.from(resolvedOperator, 'hex') };
    return contract.callTx.setApprovalForAll(operator, params.approved);
  }, params.dustSeed);

  return {
    contractAddress: params.contractAddress,
    owner: coinPublicKey,
    operator: resolvedOperator,
    approved: params.approved,
  };
}

// Destroy a token. Only the current owner may call this.
export async function burnNft(params: {
  ownerSeed: string;
  contractAddress: string;
  tokenId: string;
  dustSeed?: string;
}) {
  const cfg = activeNetwork();
  const { coinPublicKey } = await callContract(params.ownerSeed, params.contractAddress, async (contract) => {
    return contract.callTx.burn(BigInt(params.tokenId));
  }, params.dustSeed);

  return {
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
    burnedBy: coinPublicKey,
  };
}

// ---- Provider Bridge (internal) ----

// Creates the provider bridge that midnight-js uses for balancing, signing and submitting.
// If a separate dustCtx is provided, its dust keys are used for fee payment instead of the
// main wallet's keys. This lets one wallet own/authorize the contract while another pays fees.
async function createProviderBridge(ctx: WalletContext, dustCtx?: WalletContext) {
  const state: any = await Rx.firstValueFrom(
    ctx.facade.state().pipe(Rx.filter((s: any) => s.isSynced)),
  );
  // When a separate dustCtx is provided, we must use its facade for dust balancing
  // because the owner facade (ctx) doesn't have the dust payer's dust coins.
  const useSeparateDust = !!dustCtx;
  const dustSecretKey = dustCtx ? dustCtx.dustSecretKey : ctx.dustSecretKey;
  return {
    getCoinPublicKey() { return state.shielded.coinPublicKey.toHexString(); },
    getEncryptionPublicKey() { return state.shielded.encryptionPublicKey.toHexString(); },
    async balanceTx(tx: any, ttl?: Date) {
      const expiry = ttl ?? new Date(Date.now() + 30 * 60 * 1000);

      if (useSeparateDust) {
        // Step 1: Owner balances shielded + unshielded (no dust)
        const ownerRecipe = await (ctx.facade as any).balanceUnboundTransaction(
          tx,
          { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
          { ttl: expiry, tokenKindsToBalance: ['shielded', 'unshielded'] },
        );
        // Step 2: DustPayer balances dust using the base transaction from step 1
        const baseTx = ownerRecipe.baseTransaction ?? tx;
        const txsToBalance = ownerRecipe.balancingTransaction
          ? [baseTx, ownerRecipe.balancingTransaction]
          : [baseTx];
        const dustBalancingTx = await (dustCtx!.facade as any).dust.balanceTransactions(
          dustSecretKey, txsToBalance, expiry,
        );
        // Step 3: Merge into final recipe
        const mergedBalancing = (ctx.facade as any).mergeUnprovenTransactions(
          ownerRecipe.balancingTransaction, dustBalancingTx,
        );
        const finalRecipe = {
          type: 'UNBOUND_TRANSACTION',
          baseTransaction: baseTx,
          balancingTransaction: mergedBalancing ?? undefined,
        };
        const signFn = (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload);
        const signedRecipe = await (ctx.facade as any).signRecipe(finalRecipe, signFn);
        return (ctx.facade as any).finalizeRecipe(signedRecipe);
      }

      // No separate dust payer — standard single-wallet flow
      const recipe = await (ctx.facade as any).balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey },
        { ttl: expiry },
      );
      const signFn = (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload);
      const signedRecipe = await (ctx.facade as any).signRecipe(recipe, signFn);
      return (ctx.facade as any).finalizeRecipe(signedRecipe);
    },
    submitTx(tx: any) { return ctx.facade.submitTransaction(tx); },
  };
}

// Helper: resolve optional dustSeed to a WalletContext
async function resolveDustCtx(dustSeed?: string, ownerSeed?: string): Promise<{ dustCtx: WalletContext | undefined; dustCached: boolean }> {
  if (dustSeed && dustSeed !== ownerSeed) {
    const { ctx, cached } = await getWalletCtx(dustSeed);
    return { dustCtx: ctx, dustCached: cached };
  }
  return { dustCtx: undefined, dustCached: true };
}
