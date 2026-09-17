// =============================================================
// Out-of-process dust-bootstrap runner.
//
// Spawned by WalletManager.spawnDustBootstrap() as a detached child so the
// memory- and CPU-heavy dust replay (applying ~1.5M ledger events through the
// WASM) never blocks the API's event loop and never cold-syncs the full dust
// ledger into the API process (which OOMs). Writes a facade-restorable cache
// to wallet-state-cache-<net>/<seed16>.json, which the wallet then restore()s.
//
// Usage: tsx bootstrap-runner.ts --config config.<net>.json --seed <hex>
// (ACTIVE_NETWORK — indexer/network — is resolved from --config via networks.ts)
// =============================================================

import { bootstrapDustCache } from './dust-bootstrap.js';

const argv = process.argv;
const si = argv.indexOf('--seed');
const seed = si >= 0 ? argv[si + 1] : argv[argv.length - 1];

if (!seed || !/^[0-9a-fA-F]{128}$/.test(seed)) {
  console.error('[bootstrap-runner] missing/invalid --seed (expected 128 hex chars)');
  process.exit(2);
}

const tag = seed.substring(0, 8);
const t0 = Date.now();
console.log(`[bootstrap-runner ${tag}] starting dust bootstrap`);

bootstrapDustCache(seed, (m) => console.log(`[bootstrap-runner ${tag}] ${m}`))
  .then((r) => {
    console.log(`[bootstrap-runner ${tag}] DONE in ${Math.round((Date.now() - t0) / 1000)}s -> ${JSON.stringify(r)}`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(`[bootstrap-runner ${tag}] FAILED: ${e?.message || e}`);
    process.exit(1);
  });
