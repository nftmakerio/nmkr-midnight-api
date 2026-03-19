#!/usr/bin/env tsx
// =============================================================
// Weiteres NFT minten auf einem bereits deployyten Contract
//
// Verwendung:
//   npx tsx src/mint.ts \
//     --seed <WALLET_SEED_HEX> \
//     --contract <CONTRACT_ADRESSE> \
//     --to <EMPFÄNGER_PUBLIC_KEY> \
//     --uri "ipfs://QmXyz.../metadata.json"
//
// Voraussetzungen:
//   1. Proof-Server läuft: npm run proof-server
//   2. Du bist der Contract-Owner
// =============================================================

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { initializeNetwork, createProviders } from './wallet-setup.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- CLI-Argumente parsen ----

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
  if (!parsed.seed) missing.push('--seed');
  if (!parsed.contract) missing.push('--contract');
  if (!parsed.to) missing.push('--to');

  if (missing.length > 0) {
    console.error(`❌ Fehler: Fehlende Argumente: ${missing.join(', ')}`);
    console.error('');
    console.error('Verwendung:');
    console.error('  npx tsx src/mint.ts \\');
    console.error('    --seed <dein-wallet-seed-hex> \\');
    console.error('    --contract <contract-adresse> \\');
    console.error('    --to <empfänger-public-key> \\');
    console.error('    --uri "ipfs://..."');
    process.exit(1);
  }

  return {
    seed: parsed.seed,
    contract: parsed.contract,
    to: parsed.to,
    uri: parsed.uri || 'ipfs://placeholder/metadata.json',
  };
}

// ---- Hauptlogik ----

async function main() {
  const args = parseArgs();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  console.log('=== Midnight NFT - Mint ===');
  console.log('');

  // 1. Netzwerk initialisieren
  initializeNetwork();

  // 2. Contract-Artifacts laden
  const contractPath = path.resolve(__dirname, '../contracts/managed/my-nft');

  let compiledContract: any;
  try {
    compiledContract = await import(
      path.join(contractPath, 'contract', 'index.js')
    );
  } catch (e) {
    console.error('❌ Contract-Artifacts nicht gefunden!');
    console.error('   Zuerst kompilieren: npm run compile');
    process.exit(1);
  }

  // 3. Provider erstellen
  const providers = createProviders(
    path.join(contractPath, 'keys'),
    'nft-private-state'
  );

  // 4. Existierenden Contract finden
  console.log(`📋 Contract: ${args.contract}`);
  console.log(`📤 Empfänger: ${args.to}`);
  console.log(`🔗 URI: ${args.uri}`);
  console.log('');

  console.log('🔍 Verbinde mit deployed Contract...');
  const contract = await findDeployedContract(providers, {
    compiledContract: compiledContract.default || compiledContract,
    contractAddress: args.contract,
    privateStateId: 'nftState',
  });

  // 5. Aktuellen Supply prüfen
  console.log('📊 Prüfe aktuellen Supply...');
  try {
    const supply = await contract.callTx.totalSupply();
    console.log(`   Aktuelle Anzahl NFTs: ${supply.public?.result || 'unbekannt'}`);
  } catch (e) {
    // totalSupply ist optional
  }

  // 6. Mint ausführen
  console.log('');
  console.log('🎨 Minte neues NFT...');
  const mintResult = await contract.callTx.mint(args.to, args.uri);

  const tokenId = mintResult.public?.result;

  console.log('');
  console.log('✅ NFT erfolgreich gemintet!');
  console.log(`   Token-ID: ${tokenId || 'siehe Transaktion'}`);
  console.log(`   Besitzer: ${args.to}`);
  console.log(`   URI:      ${args.uri}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('');
  console.error('❌ Fehler:', err.message || err);
  if (String(err).includes('ECONNREFUSED')) {
    console.error('');
    console.error('💡 Tipp: Der öffentliche Proof-Server ist evtl. nicht erreichbar.');
    console.error('   Prüfe: https://lace-proof-pub.preview.midnight.network');
  }
  if (String(err).includes('Nur der Contract-Owner')) {
    console.error('');
    console.error('💡 Nur der Contract-Owner darf neue NFTs minten.');
  }
  process.exit(1);
});
