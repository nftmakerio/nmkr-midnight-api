#!/usr/bin/env tsx
// =============================================================
// NFT Contract Deploy + Mint on Midnight Preview
//
// Usage:
//   npx tsx src/deploy-and-mint-v2.ts --seed <HEX_SEED>
//
// Options:
//   --name "My NFT"         NFT name (default: "Midnight NFT #0")
//   --uri "ipfs://..."      Metadata URI (default: placeholder)
//   --collection "MidNFT"   Collection name (default: "MidnightNFT")
//   --symbol "MNFT"         Collection symbol (default: "MNFT")
//
// Prerequisites:
//   1. Contract compiled: compact --skip-zk contracts/my-nft.compact contracts/managed/my-nft
//   2. Proof server running on localhost:6300
//   3. Wallet has NIGHT + DUST
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
import { ENDPOINTS, NETWORK } from './config.js';

// @ts-expect-error: Needed for GraphQL subscriptions
globalThis.WebSocket = WebSocket;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Types ----

interface WalletContext {
  facade: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

// ---- HD-Wallet Key Derivation ----

function deriveKeysFromSeed(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Failed to initialize HDWallet from seed');
  const result = hdWallet.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Failed to derive keys');
  hdWallet.hdWallet.clear();
  return result.keys;
}

// ---- Wallet Setup (same as transfer-night.ts) ----

async function createAndStartWallet(seed: string): Promise<WalletContext> {
  const keys = deriveKeysFromSeed(seed);
  const networkId = getNetworkId();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  const walletConfig = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: ENDPOINTS.indexerHttp,
      indexerWsUrl: ENDPOINTS.indexerWs,
    },
    provingServerUrl: new URL(ENDPOINTS.proofServer),
    relayURL: new URL(ENDPOINTS.nodeRpc.replace(/^http/, 'ws')),
  };

  const facade = await (WalletFacade as any).init({
    configuration: walletConfig,
    shielded: (config: any) =>
      ShieldedWallet({ ...config }).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config: any) =>
      UnshieldedWallet({ ...config, txHistoryStorage: new InMemoryTransactionHistoryStorage() })
        .startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (config: any) =>
      DustWallet({ ...config, costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 } })
        .startWithSeed(keys[Roles.Dust], ledger.LedgerParameters.initialParameters().dust),
  }) as WalletFacade;

  await facade.start(shieldedSecretKeys, dustSecretKey);
  return { facade, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

// ---- WalletProvider + MidnightProvider Bridge ----
// (bridges wallet-sdk-facade to midnight-js contract API)

async function createProviderBridge(ctx: WalletContext) {
  const state: any = await Rx.firstValueFrom(
    ctx.facade.state().pipe(Rx.filter((s: any) => s.isSynced)),
  );

  return {
    getCoinPublicKey() {
      return state.shielded.coinPublicKey.toHexString();
    },
    getEncryptionPublicKey() {
      return state.shielded.encryptionPublicKey.toHexString();
    },
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await (ctx.facade as any).balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );

      // Sign the recipe
      const signFn = (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload);
      const signedRecipe = await (ctx.facade as any).signRecipe(recipe, signFn);

      return (ctx.facade as any).finalizeRecipe(signedRecipe);
    },
    submitTx(tx: any) {
      return ctx.facade.submitTransaction(tx);
    },
  };
}

// ---- CLI Args ----

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (key && value) parsed[key] = value;
  }
  if (!parsed.seed) {
    console.error('Error: --seed <HEX_SEED> is required');
    console.error('');
    console.error('Usage:');
    console.error('  npx tsx src/deploy-and-mint-v2.ts --seed <HEX_SEED> [--name "NFT Name"] [--uri "ipfs://..."]');
    process.exit(1);
  }
  return {
    seed: parsed.seed,
    name: parsed.name || 'Midnight NFT #0',
    uri: parsed.uri || 'ipfs://example/metadata.json',
    collection: parsed.collection || 'MidnightNFT',
    symbol: parsed.symbol || 'MNFT',
    to: parsed.to || null, // CoinPublicKey of the recipient (hex), or null = send to self
  };
}

// ---- Main ----

async function main() {
  const args = parseArgs();
  const contractPath = path.resolve(__dirname, '../contracts/managed/my-nft');

  console.log('=== Midnight NFT - Deploy & Mint ===');
  console.log('');

  // 1. Network
  setNetworkId(NETWORK);
  console.log(`Network:    ${NETWORK}`);
  console.log(`Proof:      ${ENDPOINTS.proofServer}`);
  console.log(`Collection: ${args.collection} (${args.symbol})`);
  console.log(`NFT Name:   ${args.name}`);
  console.log(`NFT URI:    ${args.uri}`);
  console.log('');

  // 2. Load contract artifacts
  console.log('[1/5] Loading compiled contract...');
  let contractModule: any;
  try {
    contractModule = await import(path.join(contractPath, 'contract', 'index.js'));
  } catch (e) {
    console.error('Contract not found! Compile first:');
    console.error('  compact --skip-zk contracts/my-nft.compact contracts/managed/my-nft');
    process.exit(1);
  }

  // Prepare CompiledContract with ZK artifacts
  const ContractClass = contractModule.Contract || contractModule.default?.Contract;
  const compiledContract = CompiledContract.make('my-nft', ContractClass).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(contractPath, 'keys')),
  );
  console.log('  Contract loaded.');

  // 3. Create wallet
  console.log('[2/5] Creating wallet...');
  const ctx = await createAndStartWallet(args.seed);

  // Wait for sync
  console.log('  Syncing...');
  await Rx.firstValueFrom(
    ctx.facade.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((s: any) => s.isSynced),
    ),
  );
  const state: any = await Rx.firstValueFrom(ctx.facade.state());
  const nightBalance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`  Balance: ${nightBalance} NIGHT`);

  // Get coin public key for the contract owner
  const coinPublicKey = state.shielded.coinPublicKey.toHexString();
  console.log(`  CoinPubKey: ${coinPublicKey.substring(0, 16)}...`);

  // 4. Create providers
  console.log('[3/5] Configuring providers...');
  const walletAndMidnightProvider = await createProviderBridge(ctx);
  // NodeZkConfigProvider expects the base directory (contains keys/ and zkir/ subdirectories)
  const zkConfigProvider = new NodeZkConfigProvider(contractPath);
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'nft-private-state',
      walletProvider: walletAndMidnightProvider,
      privateStoragePasswordProvider: () => Promise.resolve('Midnight-NFT-Local-Dev-2026!'),
      accountId: coinPublicKey.substring(0, 32),
    }),
    publicDataProvider: indexerPublicDataProvider(ENDPOINTS.indexerHttp, ENDPOINTS.indexerWs),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(ENDPOINTS.proofServer, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };

  // 5. Deploy contract
  console.log('[4/5] Deploying NFT contract...');

  // Owner of the contract (the deployer is allowed to mint)
  const ownerPubKey = { bytes: Buffer.from(coinPublicKey, 'hex') };
  // Recipient of the NFT (--to or send to self)
  const mintTo = args.to
    ? { bytes: Buffer.from(args.to, 'hex') }
    : ownerPubKey;

  if (args.to) {
    console.log(`  Mint to:  ${args.to.substring(0, 16)}...`);
  }

  const deployed = await deployContract(providers, {
    compiledContract,
    privateStateId: 'nftPrivateState',
    initialPrivateState: {},
    args: [args.collection, args.symbol, ownerPubKey],
  });

  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log(`  Contract deployed!`);
  console.log(`  Address: ${contractAddress}`);

  // 6. Mint NFT
  console.log('[5/5] Minting NFT...');

  const mintResult = await deployed.callTx.mint(mintTo, args.uri);

  console.log('');
  console.log('=== NFT successfully minted! ===');
  console.log(`  Contract:    ${contractAddress}`);
  console.log(`  Token ID:    ${mintResult.public?.result ?? 0}`);
  console.log(`  Owner:       ${coinPublicKey.substring(0, 16)}...`);
  console.log(`  URI:         ${args.uri}`);
  console.log(`  Collection:  ${args.collection} (${args.symbol})`);
  console.log(`  Network:     ${NETWORK}`);

  await ctx.facade.stop();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('');
  console.error('Error:', err.message || err);
  if (err.stack) console.error(err.stack);
  if (String(err).includes('ECONNREFUSED')) {
    console.error('');
    console.error('Tip: Is the proof server reachable?');
    console.error(`  curl ${ENDPOINTS.proofServer}/health`);
  }
  process.exit(1);
});
