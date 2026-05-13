// =============================================================
// Event-cache module — public API
// =============================================================

export { eventCacheSubscriber } from './subscriber.js';
export { DB_CONFIG, pingDb, applySchema, closeDb, getPool } from './db.js';
export { fastSyncShielded, fastSyncDust } from './fast-sync.js';

import { eventCacheSubscriber } from './subscriber.js';
import { pingDb, applySchema, DB_CONFIG } from './db.js';

/**
 * Initialize the event cache:
 *   1. ping MySQL
 *   2. apply the schema (idempotent)
 *   3. start the subscribers
 *
 * Returns false if MySQL is unreachable — the API server then keeps running
 * without fast-sync support (we log a warning and move on).
 */
/**
 * READONLY mode: skip the subscriber daemon entirely. Use this on instances
 * that share a MySQL with a dedicated writer instance, to avoid opening
 * redundant WebSockets to the indexer (and hitting per-IP connection limits).
 *
 * Set via env: MIDNIGHT_CACHE_READONLY=true
 * Or via config.<network>.json: { "cacheReadonly": true }
 */
function isReadonly(): boolean {
  const env = process.env.MIDNIGHT_CACHE_READONLY;
  if (env !== undefined) return env === 'true' || env === '1';
  // Also accept config — read directly to avoid coupling with networks.ts
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const candidates = [
      process.argv[process.argv.indexOf('--config') + 1],
      process.env.MIDNIGHT_CONFIG,
      `config.${process.env.MIDNIGHT_NETWORK || 'preprod'}.json`,
    ].filter(Boolean);
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (cfg.cacheReadonly === true) return true;
        break;
      }
    }
  } catch {}
  return false;
}

export async function initEventCache(): Promise<boolean> {
  const readonly = isReadonly();
  console.log(`[EventCache] DB target: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database} (readonly=${readonly})`);
  const ok = await pingDb();
  if (!ok) {
    console.warn(`[EventCache] MySQL not reachable — fast-sync disabled. Set MIDNIGHT_DB_* env vars or db section in config.<network>.json to enable.`);
    return false;
  }
  if (!readonly) {
    try {
      await applySchema();
    } catch (err: any) {
      console.warn(`[EventCache] schema apply failed: ${err.message} — make sure database '${DB_CONFIG.database}' exists.`);
      return false;
    }
    await eventCacheSubscriber.start();
    console.log(`[EventCache] subscribers started (writer mode)`);
  } else {
    console.log(`[EventCache] readonly mode — no subscriber, fast-sync reads only from shared DB`);
  }
  return true;
}
