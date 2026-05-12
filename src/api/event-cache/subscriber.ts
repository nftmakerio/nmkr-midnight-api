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

export class EventCacheSubscriber {
  private wsZswap: WebSocket | null = null;
  private wsDust: WebSocket | null = null;
  private stopping = false;
  private progress: Record<StreamName, StreamProgress> = {
    zswap: { applied: 0, highest: 0, connected: false, insertsPerSec: 0, lastInsertAt: 0 },
    dust:  { applied: 0, highest: 0, connected: false, insertsPerSec: 0, lastInsertAt: 0 },
  };

  /** Start both subscriptions. Never throws — failures cause reconnect. */
  async start(): Promise<void> {
    this.stopping = false;
    // Resume from last stored id
    this.progress.zswap.applied = await this.loadLastId('zswap');
    this.progress.dust.applied  = await this.loadLastId('dust');
    console.log(`[EventCache] Resuming zswap from id=${this.progress.zswap.applied}, dust from id=${this.progress.dust.applied}`);
    this.connectStream('zswap');
    this.connectStream('dust');
  }

  stop(): void {
    this.stopping = true;
    try { this.wsZswap?.close(); } catch {}
    try { this.wsDust?.close(); } catch {}
  }

  getStatus() {
    return {
      network: ACTIVE_NETWORK.networkId,
      indexer: ACTIVE_NETWORK.indexerWs,
      zswap: { ...this.progress.zswap },
      dust:  { ...this.progress.dust },
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

    ws.on('message', async (raw: Buffer) => {
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
        try {
          await this.storeEvent(stream, data);
        } catch (err: any) {
          console.error(`[EventCache/${stream}] store error: ${err.message?.substring(0, 200)}`);
        }
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

  private async storeEvent(stream: StreamName, data: any): Promise<void> {
    const id = data.id;
    const raw = data.raw;
    if (typeof id !== 'number' || typeof raw !== 'string') return;
    const maxId = data.maxId ?? null;
    this.progress[stream].highest = Math.max(this.progress[stream].highest, maxId || id);

    const pool = getPool();
    if (stream === 'zswap') {
      await pool.execute(
        'INSERT IGNORE INTO zswap_events (id, raw_hex, protocol_version, max_id_at_fetch) VALUES (?, ?, ?, ?)',
        [id, raw, data.protocolVersion ?? null, maxId],
      );
    } else {
      await pool.execute(
        'INSERT IGNORE INTO dust_events (id, raw_hex, event_type, max_id_at_fetch) VALUES (?, ?, ?, ?)',
        [id, raw, data.type ?? null, maxId],
      );
    }
    await pool.execute(
      'UPDATE cache_state SET last_id = ?, highest_seen = ?, updated_at = NOW() WHERE stream = ?',
      [id, this.progress[stream].highest, stream],
    );
    // Rolling 1s rate
    const now = Date.now();
    const last = this.progress[stream].lastInsertAt || now;
    const dt = (now - last) / 1000;
    if (dt > 0) {
      this.progress[stream].insertsPerSec = Math.round(1 / dt * 10) / 10;
    }
    this.progress[stream].lastInsertAt = now;
    this.progress[stream].applied = id;
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
