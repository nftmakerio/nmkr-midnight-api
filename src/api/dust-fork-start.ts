// =============================================================
// Where the dust event timeline crosses the ledger-9 fork.
//
// wallet-sdk 2.x can start a fresh dust wallet at the fork instead of replaying
// the whole ledger-8 dust history (`skipLedgerV8DustHistory`). Its built-in
// search opens one short subscription per halving with a 10 s timeout each and
// a 30 s ceiling overall; against Blockfrost that regularly runs out, and the
// wallet then silently replays ~1.8M ledger-8 dust events (days, at the dust
// replay rate). The fork point never changes once the chain has crossed it, so
// we search for it patiently once, cache it per network, and hand it to the SDK
// as `dustTimelineStartProbe`.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Option } from 'effect';
import { ProtocolVersion } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { DefaultForkSchedule } from '@midnight-ntwrk/wallet-sdk-facade';
import { ACTIVE_NETWORK } from './networks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.resolve(__dirname, `../../dust-fork-start.${ACTIVE_NETWORK.networkId}.json`);
const QUERY = 'subscription D($id: Int){ dustLedgerEvents(id:$id){ id protocolVersion maxId } }';
const PROBE_TIMEOUT_MS = 60_000;

interface Probe { id: number; version: number; maxId: number }
export interface DustForkStart { cursor: bigint; version: bigint }

// First dust event at or after `id` (null = the start of the timeline).
function firstDustEventFrom(id: number | null): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ACTIVE_NETWORK.indexerWs, ['graphql-transport-ws']);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`dust event probe at ${id} timed out`)); }, PROBE_TIMEOUT_MS);
    const done = (fn: () => void) => { clearTimeout(timer); try { ws.close(); } catch {} fn(); };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
    ws.on('error', (e) => done(() => reject(e)));
    ws.on('message', (buf: Buffer) => {
      let m: any; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: QUERY, variables: { id } } }));
      } else if (m.type === 'next') {
        const d = m.payload?.data?.dustLedgerEvents;
        if (d) done(() => resolve({ id: d.id, version: Number(d.protocolVersion), maxId: d.maxId }));
        else if (m.payload?.errors) done(() => reject(new Error(JSON.stringify(m.payload.errors).slice(0, 200))));
      } else if (m.type === 'error' || m.type === 'complete') {
        done(() => reject(new Error(`dust event probe at ${id}: ${m.type}`)));
      }
    });
  });
}

// Same invariant as the SDK's narrowToBoundary: every event below `low` is below
// the boundary, `atHigh` (the first event from `high`) is not.
async function narrow(low: number, high: number, atHigh: Probe, boundary: number): Promise<DustForkStart> {
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const probed = await firstDustEventFrom(middle);
    if (probed.version >= boundary) { high = middle; atHigh = probed; }
    else low = probed.id + 1;
  }
  return { cursor: BigInt(low - 1), version: BigInt(atHigh.version) };
}

async function search(boundary: number): Promise<DustForkStart | null> {
  const first = await firstDustEventFrom(null);
  const last = await firstDustEventFrom(first.maxId);
  if (first.version >= boundary || last.version < boundary) return null;   // nothing to skip / not forked yet
  return narrow(first.id + 1, last.id, last, boundary);
}

let inflight: Promise<DustForkStart | null> | null = null;

export async function dustForkStart(): Promise<DustForkStart | null> {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (c.network === ACTIVE_NETWORK.networkId && c.cursor !== undefined) {
      return { cursor: BigInt(c.cursor), version: BigInt(c.version) };
    }
  } catch {}
  if (!inflight) {
    inflight = (async () => {
      const t0 = Date.now();
      const boundary = Number(DefaultForkSchedule.v9);
      const r = await search(boundary);
      if (r) {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({
          network: ACTIVE_NETWORK.networkId, cursor: r.cursor.toString(), version: r.version.toString(),
          boundary, foundAt: new Date().toISOString(),
        }, null, 2));
        console.log(`[DustForkStart] ${ACTIVE_NETWORK.networkId}: ledger-9 dust starts after event ${r.cursor} (version ${r.version}), found in ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      return r;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

// The probe handed to the SDK (an Option, like the SDK's own search). It must
// answer within the SDK's 30 s ceiling, so it only ever reads the cache;
// warmDustForkStart() fills it at startup. None = start as without the probe.
export function dustTimelineStartProbe(): Promise<Option.Option<{ cursor: bigint; version: any }>> {
  return dustForkStartCached().then((r) => r
    ? Option.some({ cursor: r.cursor, version: ProtocolVersion.ProtocolVersion(r.version) })
    : Option.none());
}

let cached: DustForkStart | null = null;
async function dustForkStartCached(): Promise<DustForkStart | null> {
  if (cached) return cached;
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (c.network === ACTIVE_NETWORK.networkId) cached = { cursor: BigInt(c.cursor), version: BigInt(c.version) };
  } catch {}
  return cached;
}

export async function warmDustForkStart(): Promise<DustForkStart | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await dustForkStart();
      if (r) cached = r;
      return r;
    } catch (e: any) {
      console.warn(`[DustForkStart] search attempt ${attempt} failed: ${e?.message || e}`);
    }
  }
  return null;
}
