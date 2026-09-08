// =============================================================
// Shielded bootstrap — build a FACADE-COMPATIBLE shielded (zswap) state cache
// via a robust, strict-order replay, bypassing the facade's cold-sync that
// does not scale on large ledgers (preprod zswap ~1.5M events).
//
// Same technique as dust-bootstrap.ts, but for the shielded sub-wallet:
//   - stream zswapLedgerEvents in strict id order (clean resume on reconnect)
//   - CoreWallet.replayEventsWithChanges (wallet-sdk-shielded) in batches
//   - progress.appliedIndex = last event id (facade resumes from there)
//   - serialize with the SDK's own capability → wallet-state-cache dust field
// =============================================================

import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CoreWallet, Serialization } from '@midnight-ntwrk/wallet-sdk-shielded/v1';
import { ACTIVE_NETWORK } from './networks.js';
import { STATE_CACHE_DIR } from './wallet-manager.js';

const ZSWAP_QUERY = `subscription Z($id: Int){ zswapLedgerEvents(id:$id){ id raw maxId } }`;
const BATCH = 5000;

function zswapKeysFromSeed(seedHex: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('invalid seed');
  const r = hd.hdWallet.selectAccount(0).selectRole(Roles.Zswap).deriveKeyAt(0);
  if (r.type !== 'keyDerived') throw new Error('cannot derive zswap key');
  return ledger.ZswapSecretKeys.fromSeed(r.key);
}

export interface ShieldedBootstrapResult {
  network: string;
  appliedEvents: number;
  syncedToId: number;
  tipId: number;
  cacheFile: string;
  durationMs: number;
}

export async function bootstrapShieldedCache(
  seedHex: string,
  log: (msg: string) => void = () => {},
): Promise<ShieldedBootstrapResult> {
  const start = Date.now();
  setNetworkId(ACTIVE_NETWORK.networkId as any);
  const nid = getNetworkId();
  const zk = zswapKeysFromSeed(seedHex);

  let cw: any = CoreWallet.initEmpty(zk, nid);
  let appliedId = 0, applied = 0, tipId = 0;
  let pending: Array<{ id: number; raw: string }> = [];

  const applyBatch = (force = false) => {
    while (pending.length >= BATCH || (force && pending.length)) {
      const slice = pending.splice(0, BATCH);
      const objs: any[] = [];
      for (const e of slice) { try { objs.push(ledger.Event.deserialize(Buffer.from(e.raw, 'hex'))); } catch {} }
      if (objs.length) {
        const [next] = CoreWallet.replayEventsWithChanges(cw, zk, objs);
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
      pending = [];
      ws = new WebSocket(ACTIVE_NETWORK.indexerWs, ['graphql-transport-ws']);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
      ws.on('message', (buf: Buffer) => {
        let m: any; try { m = JSON.parse(buf.toString()); } catch { return; }
        if (m.type === 'connection_ack') {
          ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: ZSWAP_QUERY, variables: { id: appliedId || null } } }));
          return;
        }
        if (m.type === 'next' && m.id === '1') {
          const d = m.payload?.data?.zswapLedgerEvents;
          if (!d || typeof d.id !== 'number' || typeof d.raw !== 'string') return;
          if (typeof d.maxId === 'number') tipId = d.maxId;
          if (d.id <= appliedId) return;
          pending.push({ id: d.id, raw: d.raw });
          if (pending.length >= BATCH) {
            applyBatch();
            if (applied % 100000 < BATCH) log(`applied ${applied} (id=${appliedId}/${tipId})`);
          }
          clearTimeout(idle);
          idle = setTimeout(() => { applyBatch(true); finish(); }, 8000);
          if (appliedId >= tipId && pending.length === 0) { applyBatch(true); finish(); }
        }
      });
      ws.on('close', () => { if (done) return; setTimeout(connect, 1200); });
      ws.on('error', () => {});
    };
    connect();
  });
  applyBatch(true);

  cw = CoreWallet.updateProgress(cw, {
    appliedIndex: BigInt(appliedId),
    highestIndex: BigInt(tipId || appliedId),
    highestRelevantWalletIndex: BigInt(appliedId),
    highestRelevantIndex: BigInt(tipId || appliedId),
    isConnected: false,
  });

  const ser = Serialization.makeDefaultV1SerializationCapability().serialize(cw);

  fs.mkdirSync(STATE_CACHE_DIR, { recursive: true });
  const cacheFile = path.join(STATE_CACHE_DIR, `${seedHex.substring(0, 16)}.json`);
  let existing: any = { shielded: '', unshielded: '', dust: '' };
  if (fs.existsSync(cacheFile)) { try { existing = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch {} }
  existing.shielded = ser;
  fs.writeFileSync(cacheFile, JSON.stringify(existing));

  return {
    network: ACTIVE_NETWORK.networkId,
    appliedEvents: applied,
    syncedToId: appliedId,
    tipId,
    cacheFile,
    durationMs: Date.now() - start,
  };
}
