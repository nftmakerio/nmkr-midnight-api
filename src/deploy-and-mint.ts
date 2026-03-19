#!/usr/bin/env tsx
// =============================================================
// NFT Contract deployen + NFT minten auf Midnight Preview
//
// Verwendung:
//   npx tsx src/deploy-and-mint.ts \
//     --seed <WALLET_SEED_HEX> \
//     --to <EMPFÄNGER_PUBLIC_KEY> \
//     --uri "ipfs://QmXyz.../metadata.json" \
//     --name "Mein erstes NFT"
//
// Voraussetzungen:
//   1. Proof-Server läuft: npm run proof-server
//   2. Contract kompiliert: npm run compile
//   3. Wallet hat NIGHT + DUST
// =============================================================

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { initializeNetwork, createProviders } from './wallet-setup.js';
import { NFT_COLLECTION } from './config.js';
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

  if (!parsed.seed) {
    console.error('❌ Fehler: --seed <WALLET_SEED_HEX> ist erforderlich');
    console.error('');
    console.error('Verwendung:');
    console.error('  npx tsx src/deploy-and-mint.ts \\');
    console.error('    --seed <dein-wallet-seed-hex> \\');
    console.error('    --to <empfänger-public-key> \\');
    console.error('    --uri "ipfs://..." \\');
    console.error('    --name "NFT Name"');
    process.exit(1);
  }

  return {
    seed: parsed.seed,
    to: parsed.to || '', // wenn leer, geht an den eigenen Key
    uri: parsed.uri || 'ipfs://placeholder/metadata.json',
    name: parsed.name || 'Midnight NFT #1',
  };
}

// ---- Hauptlogik ----

async function main() {
  const args = parseArgs();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  console.log('=== Midnight NFT - Deploy & Mint ===');
  console.log('');

  // 1. Netzwerk initialisieren
  initializeNetwork();

  // 2. Kompilierten Contract laden
  const contractPath = path.resolve(__dirname, '../contracts/managed/my-nft');
  console.log(`📦 Lade Contract von: ${contractPath}`);

  let compiledContract: any;
  try {
    compiledContract = await import(
      path.join(contractPath, 'contract', 'index.js')
    );
  } catch (e) {
    console.error('❌ Contract nicht gefunden! Zuerst kompilieren:');
    console.error('   npm run compile');
    process.exit(1);
  }

  // 3. Provider erstellen
  const providers = createProviders(
    path.join(contractPath, 'keys'),
    'nft-private-state'
  );

  // 4. Contract deployen
  console.log('');
  console.log('🚀 Deploye NFT Contract...');
  console.log(`   Collection: ${NFT_COLLECTION.name} (${NFT_COLLECTION.symbol})`);

  const deployed = await deployContract(providers, {
    compiledContract: compiledContract.default || compiledContract,
    privateStateId: 'nftState',
    initialPrivateState: {},
    // Constructor-Argumente:
    // name, symbol, owner (der eigene Public Key)
    args: [NFT_COLLECTION.name, NFT_COLLECTION.symbol, args.seed],
  });

  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log(`✅ Contract deployed!`);
  console.log(`   Adresse: ${contractAddress}`);

  // 5. NFT minten
  console.log('');
  console.log('🎨 Minte NFT...');
  console.log(`   Name: ${args.name}`);
  console.log(`   URI:  ${args.uri}`);

  const recipient = args.to || args.seed; // an sich selbst wenn kein Empfänger
  console.log(`   An:   ${recipient}`);

  const mintResult = await deployed.callTx.mint(recipient, args.uri);

  console.log('');
  console.log('✅ NFT erfolgreich gemintet!');
  console.log(`   Token-ID: ${mintResult.public?.result || 'siehe Transaktion'}`);

  // 6. Optional: Transfer an andere Adresse
  if (args.to && args.to !== args.seed) {
    console.log('');
    console.log(`📤 NFT wird an ${args.to} transferiert...`);
    // Transfer ist schon im mint enthalten, da wir direkt an "to" minten
    console.log('✅ NFT ist beim Empfänger!');
  }

  // 7. Zusammenfassung
  console.log('');
  console.log('=== Zusammenfassung ===');
  console.log(`  Contract:  ${contractAddress}`);
  console.log(`  Token-ID:  0`);
  console.log(`  Besitzer:  ${recipient}`);
  console.log(`  URI:       ${args.uri}`);
  console.log(`  Netzwerk:  preview`);
  console.log('');
  console.log('Nächste Schritte:');
  console.log('  - NFT transferieren:  npx tsx src/transfer-nft.ts --contract <addr> --token-id 0 --to <addr>');
  console.log('  - Weitere minten:     npx tsx src/mint.ts --contract <addr> --to <addr> --uri "ipfs://..."');

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
  process.exit(1);
});
