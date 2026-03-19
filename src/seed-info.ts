#!/usr/bin/env tsx
// =============================================================
// Derive all addresses from a seed
//
// Usage:
//   npx tsx src/seed-info.ts <SEED_HEX>
//   npx tsx src/seed-info.ts --seed <SEED_HEX>
// =============================================================

import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { createKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import {
  ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, MidnightBech32m,
} from '@midnight-ntwrk/wallet-sdk-address-format';

const args = process.argv.slice(2);
let seed = args.find(a => !a.startsWith('--'));
if (!seed && args.includes('--seed')) {
  seed = args[args.indexOf('--seed') + 1];
}

if (!seed || !/^[0-9a-fA-F]{64}$/.test(seed)) {
  console.error('Usage: npx tsx src/seed-info.ts <SEED_HEX>');
  console.error('       npx tsx src/seed-info.ts --seed <SEED_HEX>');
  console.error('');
  console.error('The seed must be 64 hex characters (32 bytes) long.');
  process.exit(1);
}

const hdw = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
if (hdw.type !== 'seedOk') {
  console.error('Invalid seed.');
  process.exit(1);
}

const dr = hdw.hdWallet
  .selectAccount(0)
  .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
  .deriveKeysAt(0);
hdw.hdWallet.clear();

if (dr.type !== 'keysDerived') {
  console.error('Key derivation failed.');
  process.exit(1);
}

const keys = dr.keys;
const zswapKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
const coinPubKey = zswapKeys.coinPublicKey;
const encPubKey = zswapKeys.encryptionPublicKey;
const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], 'preview');

const shieldedCpk = ShieldedCoinPublicKey.fromHexString(coinPubKey);
const shieldedEpk = ShieldedEncryptionPublicKey.fromHexString(encPubKey);
const shieldedAddr = MidnightBech32m.encode('preview', new ShieldedAddress(shieldedCpk, shieldedEpk));

console.log('');
console.log('=== Midnight Wallet Info ===');
console.log('');
console.log('Seed:               ', seed);
console.log('');
console.log('CoinPublicKey:      ', coinPubKey);
console.log('Shielded address:   ', shieldedAddr.asString());
console.log('Unshielded address: ', unshieldedKeystore.getBech32Address().asString());
console.log('');
