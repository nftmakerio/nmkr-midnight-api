#!/usr/bin/env node
// =============================================================
// Midnight Worker — JSON-RPC helper for the C# SDK
//
// Reads a single JSON request from stdin, executes the operation,
// writes one JSON line to stdout, exits.
//
// Request format:
//   { "op": "createCollection", "params": {...} }
//   { "op": "mint",             "params": {...} }
//   { "op": "transferNight",    "params": {...} }
//   { "op": "info",             "params": {"seed": "..."} }
//
// Response: { "ok": true, "result": ... }  or  { "ok": false, "error": "..." }
//
// Usage:
//   echo '{"op":"info","params":{"seed":"..."}}' | node midnight-worker.mjs
//
// The worker uses MIDNIGHT_NETWORK env var to pick the network
// (preview / preprod / mainnet) and reads the same config files
// as the API server.
// =============================================================

import { readFileSync } from 'node:fs';

// Read all of stdin synchronously (we expect a single JSON message)
const stdinChunks = [];
for await (const chunk of process.stdin) stdinChunks.push(chunk);
const stdinStr = Buffer.concat(stdinChunks).toString('utf-8').trim();

let req;
try {
  req = JSON.parse(stdinStr);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: `Invalid JSON: ${e.message}` }));
  process.exit(1);
}

try {
  // Lazy-load the service to avoid pulling in the full sync stack for simple ops
  const svc = await import('../src/api/midnight-service.js')
    .catch(() => import('../src/api/midnight-service.ts'));

  let result;
  switch (req.op) {
    case 'info':
      result = svc.getWalletInfo(req.params.seed);
      break;

    case 'recoverFromMnemonic':
      result = svc.recoverFromMnemonic(req.params.mnemonic);
      break;

    case 'createNewWallet':
      result = svc.createNewWallet();
      break;

    case 'transferNight':
      result = await svc.transferNight(req.params);
      break;

    case 'createCollection':
      result = await svc.createCollection(req.params);
      break;

    case 'mint':
      result = await svc.mintNft(req.params);
      break;

    case 'transferNft':
      result = await svc.transferNft(req.params);
      break;

    case 'queryNft':
      result = await svc.queryNftContract(req.params.contractAddress);
      break;

    case 'registerDust':
      result = await svc.registerDust(req.params.seed);
      break;

    case 'getBalance':
      result = await svc.getBalanceBySeed(req.params.seed);
      break;

    default:
      throw new Error(`Unknown op: ${req.op}`);
  }

  // BigInts → strings before JSON encoding
  const safeResult = JSON.parse(JSON.stringify(result, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v));

  process.stdout.write(JSON.stringify({ ok: true, result: safeResult }) + '\n');
  process.exit(0);
} catch (err) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: err.message || String(err),
    stack: process.env.WORKER_DEBUG ? err.stack : undefined,
  }) + '\n');
  process.exit(1);
}
