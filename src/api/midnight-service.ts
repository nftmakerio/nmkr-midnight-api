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
  InMemoryTransactionHistoryStorage,
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
import { fileURLToPath } from 'node:url';
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
// Uses WalletManager cache if available, otherwise creates temporary wallet

async function getWalletCtx(seed: string, _cfg?: NetworkConfig): Promise<{ ctx: WalletContext; cached: boolean }> {
  return walletManager.getOrCreateContext(seed);
}

async function withWallet<T>(seed: string, cfg: NetworkConfig, fn: (ctx: WalletContext, state: any) => Promise<T>): Promise<T> {
  const { ctx, cached } = await getWalletCtx(seed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    return await fn(ctx, state);
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
    network: cfg.networkId,
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

export async function getBalanceBySeed(seed: string) {
  const cfg = activeNetwork();
  return withWallet(seed, cfg, async (_ctx, state) => {
    const nightBalance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    const dust = getDustBalance(state.dust);
    const info = getWalletInfo(seed);
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

    const ttl = new Date(Date.now() + 30 * 60 * 1000);
    const recipe = await (sender.facade as any).transferTransaction(
      tokenTransfer,
      { shieldedSecretKeys: sender.shieldedSecretKeys, dustSecretKey },
      { ttl },
    );

    const signFn = (payload: Uint8Array) => sender.unshieldedKeystore.signData(payload);
    const signedRecipe = await (sender.facade as any).signRecipe(recipe, signFn);
    const finalizedTx = await sender.facade.finalizeTransaction(signedRecipe.transaction);
    const txHash = await sender.facade.submitTransaction(finalizedTx);

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
      network: cfg.networkId,
    };
  } finally {
    if (!senderCached) await sender.facade.stop();
    if (dustCtx && !dustCached) await dustCtx.facade.stop();
  }
}

export async function registerDust(seed: string) {
  const cfg = activeNetwork();
  const { ctx, cached } = await getWalletCtx(seed);
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
        network: cfg.networkId,
      };
    }

    if (unregistered.length === 0 && dustCoins === 0) {
      return {
        status: 'no_utxos',
        message: 'No NIGHT UTXOs available. Please receive NIGHT first.',
        nightFormatted: `${Number(nightBalance) / 1_000_000} NIGHT`,
        dustCoins: 0,
        registeredUtxos: 0,
        unregisteredUtxos: 0,
        network: cfg.networkId,
      };
    }

    const recipe = await (ctx.facade as any).registerNightUtxosForDustGeneration(
      unregistered,
      ctx.unshieldedKeystore.getPublicKey(),
      (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload),
    );
    const finalized = await (ctx.facade as any).finalizeRecipe(recipe);
    const txHash = await ctx.facade.submitTransaction(finalized);

    return {
      status: 'registered',
      message: `${unregistered.length} NIGHT UTXO(s) registered for Dust generation.`,
      txHash,
      nightFormatted: `${Number(nightBalance) / 1_000_000} NIGHT`,
      registeredUtxos: unregistered.length,
      network: cfg.networkId,
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

  const contractModule = await import(path.join(CONTRACT_PATH, 'contract', 'index.js'));
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(params.seed);
  try {

    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();
    const ownerPubKey = { bytes: Buffer.from(coinPublicKey, 'hex') };
    const mintTo = resolvedTo
      ? { bytes: Buffer.from(resolvedTo, 'hex') }
      : ownerPubKey;

    const bridge = await createProviderBridge(ctx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-state-${Date.now()}`,
        walletProvider: bridge,
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
    const mintResult = await deployed.callTx.mint(mintTo, params.uri, params.name, tokenImage, tokenMediaType);

    return {
      contractAddress,
      tokenId: mintResult.public?.result?.toString() ?? '0',
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
      network: cfg.networkId,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
  }
}

export async function queryNftContract(contractAddress: string) {
  const cfg = activeNetwork();

  const contractModule = await import(path.join(CONTRACT_PATH, 'contract', 'index.js'));
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
    network: cfg.networkId,
  };
}

export async function getUtxos(seed: string) {
  const cfg = activeNetwork();
  return withWallet(seed, cfg, async (_ctx, state) => {
    const info = getWalletInfo(seed);
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
      network: cfg.networkId,
      totalNight: Number(totalRaw) / 1_000_000,
      totalRaw: totalRaw.toString(),
      utxoCount: utxos.length,
      utxos,
    };
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
        network: cfg.networkId,
      };
    }
  }

  throw new Error('Transaction not found');
}

export async function getTransactionHistory(seed: string) {
  const cfg = activeNetwork();
  const { ctx, cached } = await getWalletCtx(seed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const info = getWalletInfo(seed);
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
      try { indexerTx = await getTransaction(hash, network); } catch {}

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
      network: cfg.networkId,
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

  const contractModule = await import(path.join(CONTRACT_PATH, 'contract', 'index.js'));
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(seed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();
    const ownerPubKey = { bytes: Buffer.from(coinPublicKey, 'hex') };

    const bridge = await createProviderBridge(ctx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-collection-${Date.now()}`,
        walletProvider: bridge,
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
      network: cfg.networkId,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
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
    });
    return { ...result, newCollection: true };
  }

  // Mint on existing contract
  const resolvedTo = resolveToCoinPublicKey(params.toCoinPublicKey, params.toShieldedAddress);

  const contractModule = await import(path.join(CONTRACT_PATH, 'contract', 'index.js'));
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(params.ownerSeed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();
    const ownerPubKey = { bytes: Buffer.from(coinPublicKey, 'hex') };
    const mintTo = resolvedTo
      ? { bytes: Buffer.from(resolvedTo, 'hex') }
      : ownerPubKey;

    const bridge = await createProviderBridge(ctx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);

    const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-mint-${Date.now()}`,
        walletProvider: bridge,
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
    const mintResult = await contract.callTx.mint(mintTo, params.uri, params.name, tokenImage, tokenMediaType);

    return {
      contractAddress: params.contractAddress,
      tokenId: mintResult.public?.result?.toString() ?? '?',
      owner: resolvedTo || coinPublicKey,
      uri: params.uri,
      name: params.name,
      image: tokenImage,
      mediaType: tokenMediaType,
      network: cfg.networkId,
      newCollection: false,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
  }
}

export async function transferNft(params: {
  ownerSeed: string;
  contractAddress: string;
  tokenId: string;
  toCoinPublicKey?: string;
  toShieldedAddress?: string;

}) {
  const cfg = activeNetwork();
  const resolvedTo = resolveToCoinPublicKey(params.toCoinPublicKey, params.toShieldedAddress);
  if (!resolvedTo) throw new Error('Either toCoinPublicKey or toShieldedAddress is required');

  const contractModule = await import(path.join(CONTRACT_PATH, 'contract', 'index.js'));
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(params.ownerSeed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();

    const bridge = await createProviderBridge(ctx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);

    const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-transfer-${Date.now()}`,
        walletProvider: bridge,
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
      network: cfg.networkId,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
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
): Promise<{ result: T; coinPublicKey: string }> {
  const cfg = activeNetwork();
  const contractModule = await import(path.join(CONTRACT_PATH, 'contract', 'index.js'));
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(ownerSeed);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();

    const bridge = await createProviderBridge(ctx);
    const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_PATH);
    const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `nft-call-${Date.now()}`,
        walletProvider: bridge,
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

    const result = await fn(contract);
    return { result, coinPublicKey };
  } finally {
    if (!cached) await ctx.facade.stop();
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
}) {
  const cfg = activeNetwork();
  const resolvedTo = resolveToCoinPublicKey(params.toCoinPublicKey, params.toShieldedAddress);
  if (!resolvedTo) throw new Error('Either toCoinPublicKey or toShieldedAddress is required');

  const { coinPublicKey } = await callContract(params.ownerSeed, params.contractAddress, async (contract) => {
    const approveTo = { bytes: Buffer.from(resolvedTo, 'hex') };
    return contract.callTx.approve(approveTo, BigInt(params.tokenId));
  });

  return {
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
    owner: coinPublicKey,
    approved: resolvedTo,
    network: cfg.networkId,
  };
}

// Approve / revoke an operator for ALL tokens of the caller in this collection.
export async function setApprovalForAllNft(params: {
  ownerSeed: string;
  contractAddress: string;
  operatorCoinPublicKey?: string;
  operatorShieldedAddress?: string;
  approved: boolean;
}) {
  const cfg = activeNetwork();
  const resolvedOperator = resolveToCoinPublicKey(params.operatorCoinPublicKey, params.operatorShieldedAddress);
  if (!resolvedOperator) throw new Error('Either operatorCoinPublicKey or operatorShieldedAddress is required');

  const { coinPublicKey } = await callContract(params.ownerSeed, params.contractAddress, async (contract) => {
    const operator = { bytes: Buffer.from(resolvedOperator, 'hex') };
    return contract.callTx.setApprovalForAll(operator, params.approved);
  });

  return {
    contractAddress: params.contractAddress,
    owner: coinPublicKey,
    operator: resolvedOperator,
    approved: params.approved,
    network: cfg.networkId,
  };
}

// Destroy a token. Only the current owner may call this.
export async function burnNft(params: {
  ownerSeed: string;
  contractAddress: string;
  tokenId: string;
}) {
  const cfg = activeNetwork();
  const { coinPublicKey } = await callContract(params.ownerSeed, params.contractAddress, async (contract) => {
    return contract.callTx.burn(BigInt(params.tokenId));
  });

  return {
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
    burnedBy: coinPublicKey,
    network: cfg.networkId,
  };
}

// ---- Provider Bridge (internal) ----

async function createProviderBridge(ctx: WalletContext) {
  const state: any = await Rx.firstValueFrom(
    ctx.facade.state().pipe(Rx.filter((s: any) => s.isSynced)),
  );
  return {
    getCoinPublicKey() { return state.shielded.coinPublicKey.toHexString(); },
    getEncryptionPublicKey() { return state.shielded.encryptionPublicKey.toHexString(); },
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await (ctx.facade as any).balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signFn = (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload);
      const signedRecipe = await (ctx.facade as any).signRecipe(recipe, signFn);
      return (ctx.facade as any).finalizeRecipe(signedRecipe);
    },
    submitTx(tx: any) { return ctx.facade.submitTransaction(tx); },
  };
}
