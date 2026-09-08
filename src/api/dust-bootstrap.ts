// =============================================================
// Dust bootstrap — build a FACADE-COMPATIBLE dust state cache without the
// facade's fragile cold-sync.
//
// The facade's own dust sync cold-loads the whole dust ledger in one go and
// breaks on WS reconnect ("non-linearly into dust commitment tree") — on
// preprod it never converges. This module instead streams the dust events
// in strict id order (resuming cleanly on reconnect), applies them via the
// SDK's CoreWallet.applyEventsWithChanges, sets progress.appliedIndex to the
// last event id, serializes with the SDK's own capability, and writes it into
// wallet-state-cache-<net>/<seed16>.json. The facade then restore()s it and
// resumes the subscription from appliedIndex (small delta) — no cold-sync.
// =============================================================

import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CoreWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet/v1';
import { ACTIVE_NETWORK } from './networks.js';
import { STATE_CACHE_DIR } from './wallet-manager.js';

// makeDefaultV1SerializationCapability is not re-exported from the package
// root/v1 — deep-load it (same technique the project uses for CoreWallet).
const serMod: any = await import(
  pathToFileURL(path.resolve(
    process.cwd(),
    'node_modules/@midnight-ntwrk/wallet-sdk-dust-wallet/dist/v1/Serialization.js',
  )).href
);
const makeDefaultV1SerializationCapability = serMod.makeDefaultV1SerializationCapability;

const DUST_QUERY = `subscription D($id: Int){ dustLedgerEvents(id:$id){ id raw maxId } }`;
const BATCH = 5000;

function dustSecretKeyFromSeed(seedHex: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('invalid seed');
  const r = hd.hdWallet.selectAccount(0).selectRole(Roles.Dust).deriveKeyAt(0);
  if (r.type !== 'keyDerived') throw new Error('cannot derive dust key');
  return ledger.DustSecretKey.fromSeed(r.key);
}

export interface DustBootstrapResult {
  network: string;
  appliedEvents: number;
  syncedToId: number;
  tipId: number;
  dustBalanceRaw: string;
  cacheFile: string;
  durationMs: number;
}

/**
 * Stream the whole preprod/preview dust ledger, build the wallet's dust
 * CoreWallet in strict order, and write a facade-restorable cache.
 */
export async function bootstrapDustCache(
  seedHex: string,
  log: (msg: string) => void = () => {},
): Promise<DustBootstrapResult> {
  const start = Date.now();
  setNetworkId(ACTIVE_NETWORK.networkId as any);
  const nid = getNetworkId();
  const dustSk = dustSecretKeyFromSeed(seedHex);

  let cw: any = CoreWallet.initEmpty(ledger.LedgerParameters.initialParameters().dust, dustSk, nid);
  const now = new Date();

  let appliedId = 0;         // highest dust event id applied (== resume point)
  let applied = 0;
  let tipId = 0;
  let pending: Array<{ id: number; raw: string }> = [];

  const applyBatch = (force = false) => {
    while (pending.length >= BATCH || (force && pending.length)) {
      const slice = pending.splice(0, BATCH);
      const objs: any[] = [];
      for (const e of slice) { try { objs.push(ledger.Event.deserialize(Buffer.from(e.raw, 'hex'))); } catch {} }
      if (objs.length) {
        const [next] = CoreWallet.applyEventsWithChanges(cw, dustSk, objs, now);
        cw = next;
      }
      applied += slice.length;
      appliedId = slice[slice.length - 1].id;
    }
  };

  await new Promise<void>((resolve) => {
    let ws: WebSocket, idle: any, done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(idle); try { ws.close(); } catch {} resolve(); };
    const connect = () => {
      pending = [];                              // clean resume from appliedId
      ws = new WebSocket(ACTIVE_NETWORK.indexerWs, ['graphql-transport-ws']);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
      ws.on('message', (buf: Buffer) => {
        let m: any; try { m = JSON.parse(buf.toString()); } catch { return; }
        if (m.type === 'connection_ack') {
          ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: DUST_QUERY, variables: { id: appliedId || null } } }));
          return;
        }
        if (m.type === 'next' && m.id === '1') {
          const d = m.payload?.data?.dustLedgerEvents;
          if (!d || typeof d.id !== 'number' || typeof d.raw !== 'string') return;
          if (typeof d.maxId === 'number') tipId = d.maxId;
          if (d.id <= appliedId) return;          // dedupe across reconnects
          pending.push({ id: d.id, raw: d.raw });
          if (pending.length >= BATCH) {
            applyBatch();
            if (applied % 100000 < BATCH) log(`applied ${applied} (id=${appliedId}/${tipId})`);
          }
          clearTimeout(idle);
          idle = setTimeout(() => { applyBatch(true); finish(); }, 8000);   // quiet at tip → done
          if (appliedId >= tipId && pending.length === 0) { applyBatch(true); finish(); }
        }
      });
      ws.on('close', () => { if (done) return; setTimeout(connect, 1200); });
      ws.on('error', () => {});
    };
    connect();
  });
  applyBatch(true);

  // Tell the facade we are synced up to `appliedId` so restore() resumes the
  // dust subscription from there (dustLedgerEvents(id: appliedIndex)) instead
  // of cold-syncing from 0.
  cw = CoreWallet.updateProgress(cw, {
    appliedIndex: BigInt(appliedId),
    highestIndex: BigInt(tipId || appliedId),
    highestRelevantWalletIndex: BigInt(appliedId),
    highestRelevantIndex: BigInt(tipId || appliedId),
    isConnected: false,
  });

  let dustBalanceRaw = '0';
  try { dustBalanceRaw = cw.state.walletBalance(new Date()).toString(); } catch {}

  const ser = makeDefaultV1SerializationCapability().serialize(cw);

  fs.mkdirSync(STATE_CACHE_DIR, { recursive: true });
  const cacheFile = path.join(STATE_CACHE_DIR, `${seedHex.substring(0, 16)}.json`);
  let existing: any = { shielded: '', unshielded: '', dust: '' };
  if (fs.existsSync(cacheFile)) { try { existing = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch {} }
  existing.dust = ser;
  fs.writeFileSync(cacheFile, JSON.stringify(existing));

  return {
    network: ACTIVE_NETWORK.networkId,
    appliedEvents: applied,
    syncedToId: appliedId,
    tipId,
    dustBalanceRaw,
    cacheFile,
    durationMs: Date.now() - start,
  };
}
