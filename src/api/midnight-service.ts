// =============================================================
// Midnight Service Layer — all blockchain operations
// Supports preview, preprod and mainnet
// =============================================================

import { WebSocket } from 'ws';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v7';
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
import { type NetworkConfig, type NetworkName, getNetwork } from './networks.js';
import { walletManager, type WalletContext } from './wallet-manager.js';

// @ts-expect-error: Needed for GraphQL subscriptions
globalThis.WebSocket = WebSocket;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(__dirname, '../../contracts/managed/nmkr-nft');

// ---- Network Helpers ----

function useNetwork(network?: string): NetworkConfig {
  const cfg = getNetwork(network);
  setNetworkId(cfg.networkId as any);
  return cfg;
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

async function getWalletCtx(seed: string, cfg: NetworkConfig): Promise<{ ctx: WalletContext; cached: boolean }> {
  return walletManager.getOrCreateContext(seed, cfg);
}

async function withWallet<T>(seed: string, cfg: NetworkConfig, fn: (ctx: WalletContext, state: any) => Promise<T>): Promise<T> {
  const { ctx, cached } = await getWalletCtx(seed, cfg);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    return await fn(ctx, state);
  } finally {
    // Only stop if it was a temporary wallet (not cached)
    if (!cached) {
      if (!cached) await ctx.facade.stop();
    }
  }
}

// ================================================================
// Public API
// ================================================================

export function createNewWallet(network?: string) {
  const cfg = useNetwork(network);
  // Generate 24-word mnemonic (256 bits of entropy)
  const mnemonic = bip39.generateMnemonic(256);
  // Derive full 64-byte seed from mnemonic (compatible with 1AM/Lace wallets)
  const seed = bip39.mnemonicToSeedSync(mnemonic).toString('hex');
  return { ...getWalletInfo(seed, network), mnemonic };
}

export function getWalletInfo(seed: string, network?: string) {
  const cfg = useNetwork(network);
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

export function recoverFromMnemonic(mnemonic: string, network?: string) {
  const cfg = useNetwork(network);
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }
  // Use full 64-byte seed (compatible with 1AM/Lace wallets)
  const seed = bip39.mnemonicToSeedSync(mnemonic).toString('hex');
  return getWalletInfo(seed, network);
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

export async function getBalanceByAddress(address: string, network?: string) {
  const cfg = useNetwork(network);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const args = ['balance', address, '--json'];
  if (network) args.push('--network', cfg.networkId);

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

export async function getBalanceBySeed(seed: string, network?: string) {
  const cfg = useNetwork(network);
  return withWallet(seed, cfg, async (_ctx, state) => {
    const nightBalance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    const dust = getDustBalance(state.dust);
    const info = getWalletInfo(seed, network);
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

export async function transferNight(params: {
  senderSeed: string;
  toAddress: string;
  amount: number;
  dustSeed?: string;
  network?: string;
}) {
  const cfg = useNetwork(params.network);
  const amountRaw = BigInt(Math.round(params.amount * 1_000_000));

  const { ctx: sender, cached: senderCached } = await getWalletCtx(params.senderSeed, cfg);
  let dustSecretKey = sender.dustSecretKey;
  let dustCtx: WalletContext | null = null;
  let dustCached = false;

  try {
    if (params.dustSeed && params.dustSeed !== params.senderSeed) {
      const dust = await getWalletCtx(params.dustSeed, cfg);
      dustSecretKey = dust.ctx.dustSecretKey;
      dustCtx = dust.ctx;
      dustCached = dust.cached;
    }

    const parsedAddr = MidnightBech32m.parse(params.toAddress);
    const receiverAddress = parsedAddr.decode(UnshieldedAddress, getNetworkId());

    const tokenTransfer = [{
      type: 'unshielded' as const,
      outputs: [{ type: unshieldedToken().raw, amount: amountRaw, receiverAddress }],
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

    return { txHash, amount: params.amount, amountRaw: amountRaw.toString(), to: params.toAddress, network: cfg.networkId };
  } finally {
    if (!senderCached) await sender.facade.stop();
    if (dustCtx && !dustCached) await dustCtx.facade.stop();
  }
}

export async function registerDust(seed: string, network?: string) {
  const cfg = useNetwork(network);
  const { ctx, cached } = await getWalletCtx(seed, cfg);
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
  collection?: string;
  symbol?: string;
  network?: string;
}) {
  const cfg = useNetwork(params.network);
  const resolvedTo = resolveToCoinPublicKey(params.toCoinPublicKey, params.toShieldedAddress);

  const contractModule = await import(path.join(CONTRACT_PATH, 'contract', 'index.js'));
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(params.seed, cfg);
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
      args: [params.collection || 'MidnightNFT', params.symbol || 'MNFT', ownerPubKey],
    });

    const contractAddress = deployed.deployTxData.public.contractAddress;
    const mintResult = await deployed.callTx.mint(mintTo, params.uri);

    return {
      contractAddress,
      tokenId: mintResult.public?.result?.toString() ?? '0',
      owner: resolvedTo || coinPublicKey,
      uri: params.uri,
      collection: params.collection || 'MidnightNFT',
      symbol: params.symbol || 'MNFT',
      network: cfg.networkId,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
  }
}

export async function queryNftContract(contractAddress: string, network?: string) {
  const cfg = useNetwork(network);

  const contractModule = await import(path.join(CONTRACT_PATH, 'contract', 'index.js'));
  const ledgerParser = contractModule.ledger;

  const provider = indexerPublicDataProvider(cfg.indexerHttp, cfg.indexerWs);
  const contractState = await provider.queryContractState(contractAddress);
  if (!contractState) throw new Error('Contract not found');

  const state = ledgerParser(contractState.data);
  const tokens: any[] = [];
  for (const [tokenId, owner] of state.owners) {
    let uri = '';
    try { if (state.tokenURIs.member(tokenId)) uri = state.tokenURIs.lookup(tokenId); } catch {}
    tokens.push({
      tokenId: tokenId.toString(),
      owner: Buffer.from(owner.bytes).toString('hex'),
      uri,
    });
  }

  return {
    contractAddress,
    collectionName: state.collectionName,
    collectionSymbol: state.collectionSymbol,
    contractOwner: Buffer.from(state.contractOwner.bytes).toString('hex'),
    totalSupply: Number(state.nextTokenId),
    tokens,
    network: cfg.networkId,
  };
}

export async function getUtxos(seed: string, network?: string) {
  const cfg = useNetwork(network);
  return withWallet(seed, cfg, async (_ctx, state) => {
    const info = getWalletInfo(seed, network);
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

export async function getTransaction(txHash: string, network?: string) {
  const cfg = useNetwork(network);

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

export async function getTransactionHistory(seed: string, network?: string) {
  const cfg = useNetwork(network);
  const { ctx, cached } = await getWalletCtx(seed, cfg);
  try {
    const state: any = await Rx.firstValueFrom(ctx.facade.state());
    const info = getWalletInfo(seed, network);
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
  network?: string;
}) {
  const cfg = useNetwork(params.network);

  // Generate seed or use existing one
  const seed = params.seed || Buffer.from(generateRandomSeed()).toString('hex');
  const walletInfo = getWalletInfo(seed, params.network);

  const contractModule = await import(path.join(CONTRACT_PATH, 'contract', 'index.js'));
  const compiledContract = CompiledContract.make('nmkr-nft', contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(CONTRACT_PATH, 'keys')),
  );

  const { ctx, cached } = await getWalletCtx(seed, cfg);
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
      args: [params.collection, params.symbol, ownerPubKey],
    });

    return {
      contractAddress: deployed.deployTxData.public.contractAddress,
      ownerSeed: seed,
      ownerCoinPublicKey: coinPublicKey,
      unshieldedAddress: walletInfo.unshieldedAddress,
      collection: params.collection,
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
  toCoinPublicKey?: string;
  toShieldedAddress?: string;
  collection?: string;       // only when creating a new collection
  symbol?: string;           // only when creating a new collection
  network?: string;
}) {
  const cfg = useNetwork(params.network);

  // If no contractAddress -> automatically create a new collection
  if (!params.contractAddress) {
    const result = await deployAndMintNft({
      seed: params.ownerSeed,
      toCoinPublicKey: params.toCoinPublicKey,
      toShieldedAddress: params.toShieldedAddress,
      uri: params.uri,
      collection: params.collection || 'MidnightNFT',
      symbol: params.symbol || 'MNFT',
      network: params.network,
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

  const { ctx, cached } = await getWalletCtx(params.ownerSeed, cfg);
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

    const mintResult = await contract.callTx.mint(mintTo, params.uri);

    return {
      contractAddress: params.contractAddress,
      tokenId: mintResult.public?.result?.toString() ?? '?',
      owner: resolvedTo || coinPublicKey,
      uri: params.uri,
      network: cfg.networkId,
      newCollection: false,
    };
  } finally {
    if (!cached) await ctx.facade.stop();
  }
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
