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
export async function initEventCache(): Promise<boolean> {
  console.log(`[EventCache] DB target: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  const ok = await pingDb();
  if (!ok) {
    console.warn(`[EventCache] MySQL not reachable — fast-sync disabled. Set MIDNIGHT_DB_* env vars or db section in config.<network>.json to enable.`);
    return false;
  }
  try {
    await applySchema();
  } catch (err: any) {
    console.warn(`[EventCache] schema apply failed: ${err.message} — make sure database '${DB_CONFIG.database}' exists.`);
    return false;
  }
  await eventCacheSubscriber.start();
  console.log(`[EventCache] subscribers started`);
  return true;
}
