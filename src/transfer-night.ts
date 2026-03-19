#!/usr/bin/env tsx
// =============================================================
// NIGHT Token Transfer on Midnight Preview
//
// Usage:
//   npx tsx src/transfer-night.ts \
//     --sender-seed <HEX_SEED> \
//     --to <RECIPIENT_ADDRESS> \
//     --amount <AMOUNT> \
//     [--dust-seed <HEX_SEED>]    # Optional: separate Dust provider
//
// Prerequisites:
//   1. Proof server running (local on port 6300)
//   2. Sender wallet has enough NIGHT
//   3. Dust provider has enough DUST (or sender itself)
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
import * as Rx from 'rxjs';
import { UnshieldedAddress, MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { ENDPOINTS, NETWORK } from './config.js';

// Make WebSocket globally available (Node.js has no native WebSocket)
// @ts-expect-error: Needed for GraphQL subscriptions
globalThis.WebSocket = WebSocket;

// ---- Seed derivation (HD wallet) ----

function deriveKeysFromSeed(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') {
    throw new Error('Failed to initialize HDWallet from seed');
  }

  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivationResult.type !== 'keysDerived') {
    throw new Error('Failed to derive keys');
  }

  hdWallet.hdWallet.clear();
  return derivationResult.keys;
}

// ---- Wallet configuration ----

function buildShieldedConfig() {
  return {
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: ENDPOINTS.indexerHttp,
      indexerWsUrl: ENDPOINTS.indexerWs,
    },
    provingServerUrl: new URL(ENDPOINTS.proofServer),
    relayURL: new URL(ENDPOINTS.nodeRpc.replace(/^http/, 'ws')),
  };
}

function buildUnshieldedConfig() {
  return {
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: ENDPOINTS.indexerHttp,
      indexerWsUrl: ENDPOINTS.indexerWs,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  };
}

function buildDustConfig() {
  return {
    networkId: getNetworkId(),
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    indexerClientConnection: {
      indexerHttpUrl: ENDPOINTS.indexerHttp,
      indexerWsUrl: ENDPOINTS.indexerWs,
    },
    provingServerUrl: new URL(ENDPOINTS.proofServer),
    relayURL: new URL(ENDPOINTS.nodeRpc.replace(/^http/, 'ws')),
  };
}

// ---- Create and start wallet ----

interface WalletContext {
  facade: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

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
      ShieldedWallet({
        ...config,
      }).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config: any) =>
      UnshieldedWallet({
        ...config,
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
      }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (config: any) =>
      DustWallet({
        ...config,
        costParameters: {
          additionalFeeOverhead: 300_000_000_000_000n,
          feeBlocksMargin: 5,
        },
      }).startWithSeed(keys[Roles.Dust], ledger.LedgerParameters.initialParameters().dust),
  }) as WalletFacade;

  await facade.start(shieldedSecretKeys, dustSecretKey);

  return { facade, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

// ---- Wait for wallet sync ----

async function waitForSync(facade: WalletFacade, label: string): Promise<void> {
  console.log(`  Syncing ${label}...`);
  await Rx.firstValueFrom(
    facade.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((state: any) => state.isSynced),
    ),
  );
  const state: any = await Rx.firstValueFrom(facade.state());
  const nightBalance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  // Dust balance: try walletBalance() or availableCoins
  let dustInfo = 'unknown';
  try {
    if (typeof state.dust.walletBalance === 'function') {
      dustInfo = `${state.dust.walletBalance(new Date())} DUST`;
    } else {
      dustInfo = `${state.dust.availableCoins?.length ?? 0} DUST coins`;
    }
  } catch { dustInfo = 'N/A'; }
  console.log(`  ${label}: ${nightBalance} NIGHT, ${dustInfo}`);
}

// ---- CLI arguments ----

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (key && value) {
      parsed[key] = value;
    }
  }

  const missing: string[] = [];
  if (!parsed['sender-seed']) missing.push('--sender-seed');
  if (!parsed.to) missing.push('--to');
  if (!parsed.amount) missing.push('--amount');

  if (missing.length > 0) {
    console.error(`Error: Missing arguments: ${missing.join(', ')}`);
    console.error('');
    console.error('Usage:');
    console.error('  npx tsx src/transfer-night.ts \\');
    console.error('    --sender-seed <HEX_SEED> \\');
    console.error('    --to <RECIPIENT_ADDRESS> \\');
    console.error('    --amount <AMOUNT> \\');
    console.error('    [--dust-seed <HEX_SEED>]');
    process.exit(1);
  }

  return {
    senderSeed: parsed['sender-seed'],
    to: parsed.to,
    amount: parsed.amount,
    dustSeed: parsed['dust-seed'] || null,
  };
}

// ---- Main logic ----

async function main() {
  const args = parseArgs();

  // NIGHT amounts: 1 NIGHT = 1_000_000 raw
  const amountRaw = BigInt(Math.round(parseFloat(args.amount) * 1_000_000));

  console.log('=== Midnight NIGHT Transfer ===');
  console.log('');

  // 1. Initialize network
  setNetworkId(NETWORK);
  console.log(`Network:    ${NETWORK}`);
  console.log(`Indexer:    ${ENDPOINTS.indexerHttp}`);
  console.log(`Proof:      ${ENDPOINTS.proofServer}`);
  console.log(`Amount:     ${args.amount} NIGHT (${amountRaw} raw)`);
  console.log(`Recipient:  ${args.to}`);
  console.log(`Dust prov:  ${args.dustSeed ? 'separate seed' : 'sender = dust provider'}`);
  console.log('');

  // 2. Create and sync sender wallet
  console.log('[1/4] Creating sender wallet...');
  const sender = await createAndStartWallet(args.senderSeed);
  await waitForSync(sender.facade, 'Sender');

  const senderState: any = await Rx.firstValueFrom(sender.facade.state());
  const senderNight = senderState.unshielded.balances[unshieldedToken().raw] ?? 0n;

  if (senderNight < amountRaw) {
    console.error(`Error: Not enough NIGHT. Available: ${senderNight}, Required: ${amountRaw}`);
    await sender.facade.stop();
    process.exit(1);
  }

  // 3. Dust provider (optional separate wallet)
  let dustSecretKey = sender.dustSecretKey;
  let dustFacade: WalletFacade | null = null;

  if (args.dustSeed) {
    console.log('[2/4] Creating separate dust provider...');
    const dustProvider = await createAndStartWallet(args.dustSeed);
    await waitForSync(dustProvider.facade, 'Dust provider');
    dustSecretKey = dustProvider.dustSecretKey;
    dustFacade = dustProvider.facade;
  } else {
    console.log('[2/4] Sender is also the dust provider.');
  }

  // 4. Create transfer
  console.log('[3/4] Creating transfer transaction...');

  // Decode recipient address from bech32m into UnshieldedAddress object
  const parsedAddr = MidnightBech32m.parse(args.to);
  const receiverAddress = parsedAddr.decode(UnshieldedAddress, getNetworkId());

  const tokenTransfer = [
    {
      type: 'unshielded' as const,
      outputs: [
        {
          type: unshieldedToken().raw,
          amount: amountRaw,
          receiverAddress,
        },
      ],
    },
  ];

  const ttl = new Date(Date.now() + 30 * 60 * 1000);

  // v2.0.0 API: transferTransaction(outputs, secretKeys, options)
  const recipe = await (sender.facade as any).transferTransaction(
    tokenTransfer,
    { shieldedSecretKeys: sender.shieldedSecretKeys, dustSecretKey },
    { ttl },
  );

  console.log('  Transaction created, signing...');

  // Sign the unproven transaction
  const signFn = (payload: Uint8Array) => sender.unshieldedKeystore.signData(payload);
  const signedRecipe = await (sender.facade as any).signRecipe(recipe, signFn);

  console.log('  Finalizing (ZK proof via proof server)...');

  // Prove + bind via the facade (uses proof server)
  const finalizedTx = await sender.facade.finalizeTransaction(signedRecipe.transaction);

  // 5. Submit
  console.log('[4/4] Submitting transaction...');
  const txHash = await sender.facade.submitTransaction(finalizedTx);

  console.log('');
  console.log('=== Transfer successful! ===');
  console.log(`  TX hash:     ${txHash}`);
  console.log(`  Amount:      ${args.amount} NIGHT`);
  console.log(`  Recipient:   ${args.to}`);
  console.log(`  Network:     ${NETWORK}`);

  // Clean up
  await sender.facade.stop();
  if (dustFacade) {
    await dustFacade.stop();
  }

  process.exit(0);
}

main().catch(async (err) => {
  console.error('');
  console.error('Error:', err.message || err);
  if (err.stack) {
    console.error(err.stack);
  }
  if (String(err).includes('ECONNREFUSED')) {
    console.error('');
    console.error('Tip: Is the proof server reachable? Check:');
    console.error(`  curl ${ENDPOINTS.proofServer}/health`);
  }
  process.exit(1);
});
