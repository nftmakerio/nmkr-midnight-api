// =============================================================
// Fast-Sync — apply cached ledger events to a fresh shielded wallet
// without ever talking to the indexer at request time.
//
// Reads events from MySQL in batches and replays them via the SDK's
// CoreWallet.replayEventsWithChanges, which internally filters and
// decrypts outputs for the provided secret keys.
// =============================================================

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Deep-load CoreWallet. The SDK's package.json `exports` doesn't expose
// dist/v1/CoreWallet.js, but the file is shipped — so resolve via filesystem
// to bypass the exports check.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coreWalletPath = path.resolve(
  __dirname,
  '../../../node_modules/@midnight-ntwrk/wallet-sdk-shielded/dist/v1/CoreWallet.js',
);
const { CoreWallet } = await import(pathToFileURL(coreWalletPath).href);
import { getPool } from './db.js';
import { ACTIVE_NETWORK } from '../networks.js';

export interface FastSyncResult {
  network: string;
  syncedTo: number;
  appliedEvents: number;
  relevantEvents: number;
  durationMs: number;
  coinPublicKey: string;
  availableCoins: Array<{ value: string; type: string }>;
  totalBalance: Record<string, string>;
  // Serialized state — can be cached & resumed later
  // (omitted by default to keep response small; pass includeState=true)
  serializedState?: string;
}

const BATCH_SIZE = 5000;

/**
 * Fast-sync a shielded wallet from the local MySQL event cache.
 * Returns balance + UTXOs without ever hitting the indexer.
 */
export async function fastSyncShielded(seedHex: string, opts: { fromIndex?: number; includeState?: boolean } = {}): Promise<FastSyncResult> {
  const start = Date.now();

  // 1. Derive the Zswap role key from the seed (BIP32 with Midnight path)
  const seedBytes = Buffer.from(seedHex, 'hex');
  const hdResult = HDWallet.fromSeed(seedBytes);
  if (hdResult.type !== 'seedOk') throw new Error('Invalid seed for HD derivation');
  const roleResult = hdResult.hdWallet.selectAccount(0).selectRole(Roles.Zswap).deriveKeyAt(0);
  if (roleResult.type !== 'keyDerived') throw new Error('Could not derive Zswap key');
  const zswapKey = roleResult.key;

  const secretKeys = ledger.ZswapSecretKeys.fromSeed(zswapKey);
  const coinPublicKey: string =
    (secretKeys.coinPublicKey as any)?.toHexString?.() ?? String(secretKeys.coinPublicKey);

  // 2. Empty shielded wallet
  let wallet: any = (CoreWallet as any).initEmpty(secretKeys, ACTIVE_NETWORK.networkId);

  // 3. Stream events from MySQL in batches and replay
  const pool = getPool();
  let fromId = opts.fromIndex ?? 0;
  let totalApplied = 0;
  let totalRelevant = 0;
  let highestSeen = fromId;

  while (true) {
    // LIMIT can't be a prepared param in mysql2 default protocol — inline it
    const [rows]: any = await pool.execute(
      `SELECT id, raw_hex FROM zswap_events WHERE id > ? ORDER BY id ASC LIMIT ${BATCH_SIZE}`,
      [fromId],
    );
    if (!rows || rows.length === 0) break;

    // Deserialize raw bytes to Event objects
    const events: any[] = [];
    for (const r of rows) {
      try { events.push(ledger.Event.deserialize(Buffer.from(r.raw_hex, 'hex'))); }
      catch (err: any) {
        // Unparseable events (e.g. v9 on preprod) — skip, log once at end if any
        totalApplied++;
      }
    }

    if (events.length > 0) {
      const [updated, changes]: [any, any[]] = (CoreWallet as any).replayEventsWithChanges(wallet, secretKeys, events);
      wallet = updated;
      totalRelevant += (changes || []).length;
    }
    totalApplied += rows.length;
    highestSeen = rows[rows.length - 1].id;
    fromId = highestSeen;

    if (rows.length < BATCH_SIZE) break;
  }

  // 4. Extract balance + UTXOs from the final wallet state.
  // ZswapLocalState exposes `coins: Set<QualifiedShieldedCoinInfo>`.
  const localState = wallet.state;
  const available: Array<{ value: string; type: string; nonce?: string }> = [];
  const totals: Record<string, bigint> = {};

  try {
    const coinSet: Set<any> = (localState as any).coins ?? new Set();
    for (const c of coinSet) {
      const v = BigInt(c.value ?? 0);
      const t = ((c.type as any)?.toHexString?.() ?? String(c.type ?? 'unknown'));
      available.push({
        value: v.toString(),
        type: t,
        nonce: (c.nonce as any)?.toHexString?.() ?? undefined,
      });
      totals[t] = (totals[t] ?? 0n) + v;
    }
  } catch (err: any) {
    console.error(`[FastSync] coin extraction failed: ${err.message}`);
  }

  return {
    network: ACTIVE_NETWORK.networkId,
    syncedTo: highestSeen,
    appliedEvents: totalApplied,
    relevantEvents: totalRelevant,
    durationMs: Date.now() - start,
    coinPublicKey,
    availableCoins: available,
    totalBalance: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()])),
    serializedState: opts.includeState ? (wallet.state.serialize?.() ?? null) : undefined,
  };
}

/**
 * Fast-sync the DUST wallet for a seed from cached events.
 * Returns dust balance + UTXOs without hitting the indexer.
 */
export async function fastSyncDust(seedHex: string, opts: { fromIndex?: number } = {}) {
  const start = Date.now();

  const seedBytes = Buffer.from(seedHex, 'hex');
  const hdResult = HDWallet.fromSeed(seedBytes);
  if (hdResult.type !== 'seedOk') throw new Error('Invalid seed for HD derivation');
  const roleResult = hdResult.hdWallet.selectAccount(0).selectRole(Roles.Dust).deriveKeyAt(0);
  if (roleResult.type !== 'keyDerived') throw new Error('Could not derive Dust key');
  const dustKey = roleResult.key;

  const dustSecretKey = ledger.DustSecretKey.fromSeed(dustKey);

  // Empty DustLocalState
  const initialParams = ledger.LedgerParameters.initialParameters().dust;
  let state: any = new (ledger as any).DustLocalState(initialParams);

  const pool = getPool();
  let fromId = opts.fromIndex ?? 0;
  let totalApplied = 0;
  let highestSeen = fromId;
  let v9Errors = 0;

  while (true) {
    const [rows]: any = await pool.execute(
      `SELECT id, raw_hex FROM dust_events WHERE id > ? ORDER BY id ASC LIMIT ${BATCH_SIZE}`,
      [fromId],
    );
    if (!rows || rows.length === 0) break;

    const events: any[] = [];
    for (const r of rows) {
      try { events.push(ledger.Event.deserialize(Buffer.from(r.raw_hex, 'hex'))); }
      catch { v9Errors++; }
    }

    if (events.length > 0) {
      try {
        state = state.replayEvents(dustSecretKey, events);
      } catch (err: any) {
        // WASM "unreachable" on v9 events — abort here and return what we have.
        v9Errors += events.length;
        break;
      }
    }
    totalApplied += rows.length;
    highestSeen = rows[rows.length - 1].id;
    fromId = highestSeen;
    if (rows.length < BATCH_SIZE) break;
  }

  const utxos = ((state as any).utxos ?? []) as any[];
  let totalRaw = 0n;
  try { totalRaw = state.walletBalance(new Date()); } catch {}

  return {
    network: ACTIVE_NETWORK.networkId,
    syncedTo: highestSeen,
    appliedEvents: totalApplied,
    v9DeserializeErrors: v9Errors,
    durationMs: Date.now() - start,
    dustBalanceRaw: totalRaw.toString(),
    dustBalanceFormatted: `${(Number(totalRaw) / 1_000_000_000_000).toFixed(4)} DUST`,
    utxoCount: utxos.length,
    utxos: utxos.slice(0, 20).map((u: any) => ({
      initialValue: String(u.initialValue ?? 0),
      seq: u.seq,
      mtIndex: u.mtIndex?.toString?.() ?? null,
      ctime: u.ctime ?? null,
    })),
  };
}
