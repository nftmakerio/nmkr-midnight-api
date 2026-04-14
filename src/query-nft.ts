#!/usr/bin/env tsx
// =============================================================
// Query NFT contract (read-only, no wallet needed)
//
// Usage:
//   npx tsx src/query-nft.ts --contract <CONTRACT_ADDRESS>
// =============================================================

import { WebSocket } from 'ws';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINTS, NETWORK } from './config.js';

// @ts-expect-error: Needed for GraphQL subscriptions
globalThis.WebSocket = WebSocket;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (key && value) parsed[key] = value;
  }
  if (!parsed.contract) {
    console.error('Usage: npx tsx src/query-nft.ts --contract <CONTRACT_ADDRESS>');
    process.exit(1);
  }
  return { contract: parsed.contract };
}

async function main() {
  const args = parseArgs();

  setNetworkId(NETWORK);

  // Load contract module (for the ledger() function)
  const contractPath = path.resolve(__dirname, '../contracts/managed/nmkr-nft');
  const contractModule = await import(path.join(contractPath, 'contract', 'index.js'));
  const ledgerParser = contractModule.ledger;

  // Query the indexer
  const provider = indexerPublicDataProvider(ENDPOINTS.indexerHttp, ENDPOINTS.indexerWs);

  console.log(`=== NFT Contract Query ===`);
  console.log(`Contract: ${args.contract}`);
  console.log(`Network:  ${NETWORK}`);
  console.log('');

  // Fetch contract state from indexer
  const contractState = await provider.queryContractState(args.contract);

  if (!contractState) {
    console.error('Contract not found or not yet synchronized.');
    process.exit(1);
  }

  // Parse ledger state
  const state = ledgerParser(contractState.data);

  console.log('--- Collection Info ---');
  console.log(`  Name:         ${state.collectionName}`);
  console.log(`  Symbol:       ${state.collectionSymbol}`);
  console.log(`  Owner:        ${Buffer.from(state.contractOwner.bytes).toString('hex')}`);
  console.log(`  Total Supply: ${state.nextTokenId}`);
  console.log('');

  // List all NFTs
  const supply = Number(state.nextTokenId);
  if (supply === 0) {
    console.log('No NFTs minted.');
  } else {
    console.log(`--- ${supply} NFT(s) ---`);
    for (const [tokenId, owner] of state.owners) {
      const ownerHex = Buffer.from(owner.bytes).toString('hex');
      let uri = '?';
      try {
        if (state.tokenURIs.member(tokenId)) {
          uri = state.tokenURIs.lookup(tokenId);
        }
      } catch { /* ignore */ }

      console.log(`  Token #${tokenId}`);
      console.log(`    Owner: ${ownerHex}`);
      console.log(`    URI:   ${uri}`);
      console.log('');
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
