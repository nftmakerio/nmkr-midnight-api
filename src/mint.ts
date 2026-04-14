#!/usr/bin/env tsx
// =============================================================
// Mint additional NFTs on an already deployed contract
//
// Usage:
//   npx tsx src/mint.ts \
//     --seed <WALLET_SEED_HEX> \
//     --contract <CONTRACT_ADDRESS> \
//     --to <RECIPIENT_PUBLIC_KEY> \
//     --uri "ipfs://QmXyz.../metadata.json"
//
// Prerequisites:
//   1. Proof server running: npm run proof-server
//   2. You are the contract owner
// =============================================================

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { initializeNetwork, createProviders } from './wallet-setup.js';
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

  const missing: string[] = [];
  if (!parsed.seed) missing.push('--seed');
  if (!parsed.contract) missing.push('--contract');
  if (!parsed.to) missing.push('--to');

  if (missing.length > 0) {
    console.error(`❌ Error: Missing arguments: ${missing.join(', ')}`);
    console.error('');
    console.error('Usage:');
    console.error('  npx tsx src/mint.ts \\');
    console.error('    --seed <your-wallet-seed-hex> \\');
    console.error('    --contract <contract-address> \\');
    console.error('    --to <recipient-public-key> \\');
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

// ---- Main logic ----

async function main() {
  const args = parseArgs();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  console.log('=== Midnight NFT - Mint ===');
  console.log('');

  // 1. Initialize network
  initializeNetwork();

  // 2. Load contract artifacts
  const contractPath = path.resolve(__dirname, '../contracts/managed/my-nft');

  let compiledContract: any;
  try {
    compiledContract = await import(
      path.join(contractPath, 'contract', 'index.js')
    );
  } catch (e) {
    console.error('❌ Contract artifacts not found!');
    console.error('   Compile first: npm run compile');
    process.exit(1);
  }

  // 3. Create providers
  const providers = createProviders(
    path.join(contractPath, 'keys'),
    'nft-private-state'
  );

  // 4. Find existing contract
  console.log(`📋 Contract: ${args.contract}`);
  console.log(`📤 Recipient: ${args.to}`);
  console.log(`🔗 URI: ${args.uri}`);
  console.log('');

  console.log('🔍 Connecting to deployed contract...');
  const contract = await findDeployedContract(providers, {
    compiledContract: compiledContract.default || compiledContract,
    contractAddress: args.contract,
    privateStateId: 'nftState',
  });

  // 5. Check current supply
  console.log('📊 Checking current supply...');
  try {
    const supply = await contract.callTx.totalSupply();
    console.log(`   Current NFT count: ${supply.public?.result || 'unknown'}`);
  } catch (e) {
    // totalSupply is optional
  }

  // 6. Execute mint
  console.log('');
  console.log('🎨 Minting new NFT...');
  const mintResult = await contract.callTx.mint(args.to, args.uri);

  const tokenId = mintResult.public?.result;

  console.log('');
  console.log('✅ NFT successfully minted!');
  console.log(`   Token ID: ${tokenId || 'see transaction'}`);
  console.log(`   Owner:    ${args.to}`);
  console.log(`   URI:      ${args.uri}`);

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
  if (String(err).includes('Only the contract owner')) {
    console.error('');
    console.error('💡 Only the contract owner is allowed to mint new NFTs.');
  }
  process.exit(1);
});
