#!/usr/bin/env tsx
// =============================================================
// NFT Contract abfragen (read-only, kein Wallet noetig)
//
// Verwendung:
//   npx tsx src/query-nft.ts --contract <CONTRACT_ADRESSE>
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
    console.error('Verwendung: npx tsx src/query-nft.ts --contract <CONTRACT_ADRESSE>');
    process.exit(1);
  }
  return { contract: parsed.contract };
}

async function main() {
  const args = parseArgs();

  setNetworkId(NETWORK);

  // Contract-Modul laden (fuer die ledger() Funktion)
  const contractPath = path.resolve(__dirname, '../contracts/managed/my-nft');
  const contractModule = await import(path.join(contractPath, 'contract', 'index.js'));
  const ledgerParser = contractModule.ledger;

  // Indexer abfragen
  const provider = indexerPublicDataProvider(ENDPOINTS.indexerHttp, ENDPOINTS.indexerWs);

  console.log(`=== NFT Contract Query ===`);
  console.log(`Contract: ${args.contract}`);
  console.log(`Netzwerk: ${NETWORK}`);
  console.log('');

  // Contract State vom Indexer holen
  const contractState = await provider.queryContractState(args.contract);

  if (!contractState) {
    console.error('Contract nicht gefunden oder noch nicht synchronisiert.');
    process.exit(1);
  }

  // Ledger State parsen
  const state = ledgerParser(contractState.data);

  console.log('--- Collection Info ---');
  console.log(`  Name:         ${state.collectionName}`);
  console.log(`  Symbol:       ${state.collectionSymbol}`);
  console.log(`  Owner:        ${Buffer.from(state.contractOwner.bytes).toString('hex')}`);
  console.log(`  Total Supply: ${state.nextTokenId}`);
  console.log('');

  // Alle NFTs auflisten
  const supply = Number(state.nextTokenId);
  if (supply === 0) {
    console.log('Keine NFTs gemintet.');
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
  console.error('Fehler:', err.message || err);
  process.exit(1);
});
