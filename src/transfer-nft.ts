#!/usr/bin/env tsx
// =============================================================
// NFT transferieren auf Midnight Preview
//
// Verwendung:
//   npx tsx src/transfer-nft.ts \
//     --seed <WALLET_SEED_HEX> \
//     --contract <CONTRACT_ADRESSE> \
//     --token-id <TOKEN_ID> \
//     --to <EMPFÄNGER_PUBLIC_KEY>
//
// Voraussetzungen:
//   1. Proof-Server läuft: npm run proof-server
//   2. Du bist der Besitzer des NFTs
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
  if (!parsed['token-id'] && parsed['token-id'] !== '0') missing.push('--token-id');
  if (!parsed.to) missing.push('--to');

  if (missing.length > 0) {
    console.error(`❌ Fehler: Fehlende Argumente: ${missing.join(', ')}`);
    console.error('');
    console.error('Verwendung:');
    console.error('  npx tsx src/transfer-nft.ts \\');
    console.error('    --seed <dein-wallet-seed-hex> \\');
    console.error('    --contract <contract-adresse> \\');
    console.error('    --token-id <token-id> \\');
    console.error('    --to <empfänger-public-key>');
    process.exit(1);
  }

  return {
    seed: parsed.seed,
    contract: parsed.contract,
    tokenId: parseInt(parsed['token-id'], 10),
    to: parsed.to,
  };
}

// ---- Hauptlogik ----

async function main() {
  const args = parseArgs();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  console.log('=== Midnight NFT - Transfer ===');
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
  console.log(`🎫 Token-ID: ${args.tokenId}`);
  console.log(`📤 An:       ${args.to}`);
  console.log('');

  console.log('🔍 Verbinde mit deployed Contract...');
  const contract = await findDeployedContract(providers, {
    compiledContract: compiledContract.default || compiledContract,
    contractAddress: args.contract,
    privateStateId: 'nftState',
  });

  // 5. Aktuellen Besitzer prüfen
  console.log('👤 Prüfe aktuellen Besitzer...');
  try {
    const currentOwner = await contract.callTx.ownerOf(args.tokenId);
    console.log(`   Aktueller Besitzer: ${currentOwner.public?.result || 'unbekannt'}`);
  } catch (e) {
    console.error('❌ Token existiert nicht oder Abfrage fehlgeschlagen');
  }

  // 6. Transfer ausführen
  console.log('');
  console.log('📤 Transferiere NFT...');
  const transferResult = await contract.callTx.transfer(args.to, args.tokenId);

  console.log('');
  console.log('✅ Transfer erfolgreich!');
  console.log(`   Token-ID:       ${args.tokenId}`);
  console.log(`   Neuer Besitzer: ${args.to}`);

  // 7. Neuen Besitzer verifizieren
  console.log('');
  console.log('🔍 Verifiziere Transfer...');
  try {
    const newOwner = await contract.callTx.ownerOf(args.tokenId);
    console.log(`   ✅ Bestätigt: ${newOwner.public?.result || args.to}`);
  } catch (e) {
    console.log('   ⚠️  Verifizierung noch ausstehend (Transaktion in Verarbeitung)');
  }

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
  if (String(err).includes('Nur der Besitzer')) {
    console.error('');
    console.error('💡 Du bist nicht der Besitzer dieses NFTs.');
  }
  process.exit(1);
});
