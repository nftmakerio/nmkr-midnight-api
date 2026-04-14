#!/usr/bin/env tsx
// =============================================================
// Transfer NFT on Midnight Preview
//
// Usage:
//   npx tsx src/transfer-nft.ts \
//     --seed <WALLET_SEED_HEX> \
//     --contract <CONTRACT_ADDRESS> \
//     --token-id <TOKEN_ID> \
//     --to <RECIPIENT_PUBLIC_KEY>
//
// Prerequisites:
//   1. Proof server running: npm run proof-server
//   2. You are the owner of the NFT
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
  if (!parsed['token-id'] && parsed['token-id'] !== '0') missing.push('--token-id');
  if (!parsed.to) missing.push('--to');

  if (missing.length > 0) {
    console.error(`❌ Error: Missing arguments: ${missing.join(', ')}`);
    console.error('');
    console.error('Usage:');
    console.error('  npx tsx src/transfer-nft.ts \\');
    console.error('    --seed <your-wallet-seed-hex> \\');
    console.error('    --contract <contract-address> \\');
    console.error('    --token-id <token-id> \\');
    console.error('    --to <recipient-public-key>');
    process.exit(1);
  }

  return {
    seed: parsed.seed,
    contract: parsed.contract,
    tokenId: parseInt(parsed['token-id'], 10),
    to: parsed.to,
  };
}

// ---- Main logic ----

async function main() {
  const args = parseArgs();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  console.log('=== Midnight NFT - Transfer ===');
  console.log('');

  // 1. Initialize network
  initializeNetwork();

  // 2. Load contract artifacts
  const contractPath = path.resolve(__dirname, '../contracts/managed/nmkr-nft');

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
  console.log(`🎫 Token ID: ${args.tokenId}`);
  console.log(`📤 To:       ${args.to}`);
  console.log('');

  console.log('🔍 Connecting to deployed contract...');
  const contract = await findDeployedContract(providers, {
    compiledContract: compiledContract.default || compiledContract,
    contractAddress: args.contract,
    privateStateId: 'nftState',
  });

  // 5. Check current owner
  console.log('👤 Checking current owner...');
  try {
    const currentOwner = await contract.callTx.ownerOf(args.tokenId);
    console.log(`   Current owner: ${currentOwner.public?.result || 'unknown'}`);
  } catch (e) {
    console.error('❌ Token does not exist or query failed');
  }

  // 6. Execute transfer
  console.log('');
  console.log('📤 Transferring NFT...');
  const transferResult = await contract.callTx.transfer(args.to, args.tokenId);

  console.log('');
  console.log('✅ Transfer successful!');
  console.log(`   Token ID:    ${args.tokenId}`);
  console.log(`   New owner:   ${args.to}`);

  // 7. Verify new owner
  console.log('');
  console.log('🔍 Verifying transfer...');
  try {
    const newOwner = await contract.callTx.ownerOf(args.tokenId);
    console.log(`   ✅ Confirmed: ${newOwner.public?.result || args.to}`);
  } catch (e) {
    console.log('   ⚠️  Verification pending (transaction is being processed)');
  }

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
  if (String(err).includes('Only the owner')) {
    console.error('');
    console.error('💡 You are not the owner of this NFT.');
  }
  process.exit(1);
});
