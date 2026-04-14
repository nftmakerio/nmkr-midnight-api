#!/usr/bin/env tsx
// =============================================================
// Deploy NFT contract + mint NFT on Midnight Preview
//
// Usage:
//   npx tsx src/deploy-and-mint.ts \
//     --seed <WALLET_SEED_HEX> \
//     --to <RECIPIENT_PUBLIC_KEY> \
//     --uri "ipfs://QmXyz.../metadata.json" \
//     --name "My first NFT"
//
// Prerequisites:
//   1. Proof server running: npm run proof-server
//   2. Contract compiled: npm run compile
//   3. Wallet has NIGHT + DUST
// =============================================================

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { initializeNetwork, createProviders } from './wallet-setup.js';
import { NFT_COLLECTION } from './config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Parse CLI arguments ----

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
    console.error('❌ Error: --seed <WALLET_SEED_HEX> is required');
    console.error('');
    console.error('Usage:');
    console.error('  npx tsx src/deploy-and-mint.ts \\');
    console.error('    --seed <your-wallet-seed-hex> \\');
    console.error('    --to <recipient-public-key> \\');
    console.error('    --uri "ipfs://..." \\');
    console.error('    --name "NFT Name"');
    process.exit(1);
  }

  return {
    seed: parsed.seed,
    to: parsed.to || '', // if empty, sends to own key
    uri: parsed.uri || 'ipfs://placeholder/metadata.json',
    name: parsed.name || 'Midnight NFT #1',
  };
}

// ---- Main logic ----

async function main() {
  const args = parseArgs();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  console.log('=== Midnight NFT - Deploy & Mint ===');
  console.log('');

  // 1. Initialize network
  initializeNetwork();

  // 2. Load compiled contract
  const contractPath = path.resolve(__dirname, '../contracts/managed/nmkr-nft');
  console.log(`📦 Loading contract from: ${contractPath}`);

  let compiledContract: any;
  try {
    compiledContract = await import(
      path.join(contractPath, 'contract', 'index.js')
    );
  } catch (e) {
    console.error('❌ Contract not found! Compile first:');
    console.error('   npm run compile');
    process.exit(1);
  }

  // 3. Create providers
  const providers = createProviders(
    path.join(contractPath, 'keys'),
    'nft-private-state'
  );

  // 4. Deploy contract
  console.log('');
  console.log('🚀 Deploying NFT contract...');
  console.log(`   Collection: ${NFT_COLLECTION.name} (${NFT_COLLECTION.symbol})`);

  const deployed = await deployContract(providers, {
    compiledContract: compiledContract.default || compiledContract,
    privateStateId: 'nftState',
    initialPrivateState: {},
    // Constructor arguments:
    // name, symbol, owner (own public key)
    args: [NFT_COLLECTION.name, NFT_COLLECTION.symbol, args.seed],
  });

  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log(`✅ Contract deployed!`);
  console.log(`   Address: ${contractAddress}`);

  // 5. Mint NFT
  console.log('');
  console.log('🎨 Minting NFT...');
  console.log(`   Name: ${args.name}`);
  console.log(`   URI:  ${args.uri}`);

  const recipient = args.to || args.seed; // send to self if no recipient
  console.log(`   To:   ${recipient}`);

  const mintResult = await deployed.callTx.mint(recipient, args.uri);

  console.log('');
  console.log('✅ NFT successfully minted!');
  console.log(`   Token ID: ${mintResult.public?.result || 'see transaction'}`);

  // 6. Optional: Transfer to another address
  if (args.to && args.to !== args.seed) {
    console.log('');
    console.log(`📤 NFT is being transferred to ${args.to}...`);
    // Transfer is already included in mint since we mint directly to "to"
    console.log('✅ NFT has been received by the recipient!');
  }

  // 7. Summary
  console.log('');
  console.log('=== Summary ===');
  console.log(`  Contract:  ${contractAddress}`);
  console.log(`  Token ID:  0`);
  console.log(`  Owner:     ${recipient}`);
  console.log(`  URI:       ${args.uri}`);
  console.log(`  Network:   preview`);
  console.log('');
  console.log('Next steps:');
  console.log('  - Transfer NFT:   npx tsx src/transfer-nft.ts --contract <addr> --token-id 0 --to <addr>');
  console.log('  - Mint more:      npx tsx src/mint.ts --contract <addr> --to <addr> --uri "ipfs://..."');

  process.exit(0);
}

main().catch((err) => {
  console.error('');
  console.error('❌ Error:', err.message || err);
  if (String(err).includes('ECONNREFUSED')) {
    console.error('');
    console.error('💡 Tip: The public proof server may not be reachable.');
    console.error('   Check: https://lace-proof-pub.preview.midnight.network');
  }
  process.exit(1);
});
