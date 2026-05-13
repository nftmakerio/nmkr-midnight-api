// =============================================================
// Indexer subscriber — opens long-running graphql-transport-ws
// connections to the Midnight indexer and writes every event
// it sees to MySQL.
//
// We open TWO subscriptions:
//   - zswapLedgerEvents (shielded ledger events)
//   - dustLedgerEvents
//
// Resumes from the last stored id on restart.
// =============================================================

import { WebSocket } from 'ws';
import { ACTIVE_NETWORK } from '../networks.js';
import { getPool } from './db.js';

type StreamName = 'zswap' | 'dust';

interface StreamProgress {
  applied: number;   // last id we persisted
  highest: number;   // chain tip last reported by the indexer
  connected: boolean;
  insertsPerSec: number;
  lastInsertAt: number;
}

const ZSWAP_QUERY = `
  subscription Z($id: Int) {
    zswapLedgerEvents(id: $id) {
      id
      raw
      protocolVersion
      maxId
    }
  }`;

const DUST_QUERY = `
  subscription D($id: Int) {
    dustLedgerEvents(id: $id) {
      type: __typename
      id
      raw
      maxId
    }
  }`;

interface QueuedEvent {
  id: number;
  raw: string;
  maxId: number | null;
  protocolVersion?: number | null;
  type?: string | null;
}

export class EventCacheSubscriber {
  private wsZswap: WebSocket | null = null;
  private wsDust: WebSocket | null = null;
  private stopping = false;
  private progress: Record<StreamName, StreamProgress> = {
    zswap: { applied: 0, highest: 0, connected: false, insertsPerSec: 0, lastInsertAt: 0 },
    dust:  { applied: 0, highest: 0, connected: false, insertsPerSec: 0, lastInsertAt: 0 },
  };

  // Event queues — events arrive via the WS message handler in a tight loop
  // and are drained by a background flusher that does bulk INSERTs. This
  // decouples the WS read rate from the DB write rate, so a slow DB cannot
  // cause the WS to fall behind and be dropped by the server.
  private queueZswap: QueuedEvent[] = [];
  private queueDust: QueuedEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private readonly FLUSH_INTERVAL_MS = 500;
  private readonly FLUSH_BATCH_SIZE = 500;

  /** Start both subscriptions. Never throws — failures cause reconnect. */
  async start(): Promise<void> {
    this.stopping = false;
    // Resume from last stored id
    this.progress.zswap.applied = await this.loadLastId('zswap');
    this.progress.dust.applied  = await this.loadLastId('dust');
    console.log(`[EventCache] Resuming zswap from id=${this.progress.zswap.applied}, dust from id=${this.progress.dust.applied}`);
    this.startFlusher();
    this.connectStream('zswap');
    this.connectStream('dust');
  }

  stop(): void {
    this.stopping = true;
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    try { this.wsZswap?.close(); } catch {}
    try { this.wsDust?.close(); } catch {}
  }

  private startFlusher() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => { this.flushQueues().catch(() => {}); }, this.FLUSH_INTERVAL_MS);
  }

  private async flushQueues() {
    if (this.flushing) return;          // skip if previous flush still in flight
    if (this.queueZswap.length === 0 && this.queueDust.length === 0) return;
    this.flushing = true;
    try {
      // Drain up to FLUSH_BATCH_SIZE per stream per tick
      const z = this.queueZswap.splice(0, this.FLUSH_BATCH_SIZE);
      const d = this.queueDust.splice(0, this.FLUSH_BATCH_SIZE);
      if (z.length > 0) await this.bulkInsert('zswap', z);
      if (d.length > 0) await this.bulkInsert('dust', d);
    } catch (err: any) {
      console.error(`[EventCache] flush error: ${err.message?.substring(0, 200)}`);
    } finally {
      this.flushing = false;
    }
  }

  private async bulkInsert(stream: StreamName, events: QueuedEvent[]) {
    const pool = getPool();
    const placeholders = events.map(() => '(?, ?, ?, ?)').join(',');
    if (stream === 'zswap') {
      const flat: any[] = [];
      for (const e of events) flat.push(e.id, e.raw, e.protocolVersion ?? null, e.maxId);
      await pool.query(
        `INSERT IGNORE INTO zswap_events (id, raw_hex, protocol_version, max_id_at_fetch) VALUES ${placeholders}`,
        flat,
      );
    } else {
      const flat: any[] = [];
      for (const e of events) flat.push(e.id, e.raw, e.type ?? null, e.maxId);
      await pool.query(
        `INSERT IGNORE INTO dust_events (id, raw_hex, event_type, max_id_at_fetch) VALUES ${placeholders}`,
        flat,
      );
    }
    const lastId = events[events.length - 1].id;
    this.progress[stream].applied = lastId;
    this.progress[stream].lastInsertAt = Date.now();
    this.progress[stream].insertsPerSec = Math.round(events.length / (this.FLUSH_INTERVAL_MS / 1000));
    await pool.execute(
      'UPDATE cache_state SET last_id = ?, highest_seen = ?, updated_at = NOW() WHERE stream = ?',
      [lastId, this.progress[stream].highest, stream],
    );
  }

  getStatus() {
    return {
      network: ACTIVE_NETWORK.networkId,
      indexer: ACTIVE_NETWORK.indexerWs,
      zswap: { ...this.progress.zswap, queueDepth: this.queueZswap.length },
      dust:  { ...this.progress.dust,  queueDepth: this.queueDust.length },
    };
  }

  // ---- Internals ----

  private connectStream(stream: StreamName) {
    if (this.stopping) return;
    const url = ACTIVE_NETWORK.indexerWs;
    const ws = new WebSocket(url, ['graphql-transport-ws']);
    if (stream === 'zswap') this.wsZswap = ws; else this.wsDust = ws;

    ws.on('open', () => {
      this.progress[stream].connected = true;
      ws.send(JSON.stringify({ type: 'connection_init' }));
    });

    ws.on('message', (raw: Buffer) => {
      // Sync handler — do NOT await DB writes here, otherwise slow DB
      // latency stalls the WS read loop and the indexer drops us.
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'connection_ack') {
        const query = stream === 'zswap' ? ZSWAP_QUERY : DUST_QUERY;
        const startId = this.progress[stream].applied || null;
        ws.send(JSON.stringify({
          id: '1', type: 'subscribe',
          payload: { query, variables: { id: startId } },
        }));
        console.log(`[EventCache] ${stream} subscription open (from id=${startId ?? 'genesis'})`);
        return;
      }

      if (msg.type === 'next' && msg.id === '1') {
        const data = msg.payload?.data?.[stream === 'zswap' ? 'zswapLedgerEvents' : 'dustLedgerEvents'];
        if (!data) return;
        if (typeof data.id !== 'number' || typeof data.raw !== 'string') return;
        const queued: QueuedEvent = {
          id: data.id,
          raw: data.raw,
          maxId: data.maxId ?? null,
          protocolVersion: data.protocolVersion ?? null,
          type: data.type ?? null,
        };
        if (stream === 'zswap') this.queueZswap.push(queued);
        else                    this.queueDust.push(queued);
        this.progress[stream].highest = Math.max(this.progress[stream].highest, data.maxId || data.id);
        return;
      }

      if (msg.type === 'error') {
        console.error(`[EventCache/${stream}] indexer error: ${JSON.stringify(msg.payload).substring(0, 200)}`);
      }
    });

    ws.on('close', () => {
      this.progress[stream].connected = false;
      if (this.stopping) return;
      const delay = 5000 + Math.random() * 2000;
      console.log(`[EventCache/${stream}] socket closed — reconnecting in ${Math.round(delay/1000)}s`);
      setTimeout(() => this.connectStream(stream), delay);
    });

    ws.on('error', () => { /* close will fire next */ });
  }

  private async loadLastId(stream: StreamName): Promise<number> {
    try {
      const pool = getPool();
      const [rows]: any = await pool.execute('SELECT last_id FROM cache_state WHERE stream = ?', [stream]);
      return rows?.[0]?.last_id ?? 0;
    } catch { return 0; }
  }
}

export const eventCacheSubscriber = new EventCacheSubscriber();
