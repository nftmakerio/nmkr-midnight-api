// =============================================================
// Request-scoped log capture
//
// Captures everything written to console.* DURING a request — including
// deep SDK output (e.g. "Wallet.Sync", WASM "unreachable", RPC errors) —
// and exposes it as a `debug` field on the JSON response so external
// callers can display / protocol it.
//
// - AsyncLocalStorage ties captured logs to the in-flight request, even
//   across the SDK's async/await boundaries.
// - console.* is patched ONCE; objects are serialized properly (no more
//   "[object Object]"); 64-char hex seeds are redacted.
// - Attached to every ERROR response (status >= 400); on success only when
//   opted in via ?debug=1, header X-Debug, or env API_DEBUG=1.
// =============================================================

import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';
import type { Request, Response, NextFunction } from 'express';

export interface LogEntry { level: string; ts: number; msg: string; }
export interface CapturedError { message: string; stack?: string; }
export interface RequestLogStore {
  id: string;
  start: number;
  logs: LogEntry[];
  errors: CapturedError[];
}

const als = new AsyncLocalStorage<RequestLogStore>();

const MAX_LOGS = 300;          // cap entries per request
const MAX_MSG_LEN = 4000;      // cap each message
let reqCounter = 0;

// ---- redaction ----------------------------------------------------------
// Mask 64-char hex runs (seeds / secret keys) so they never flow back out.
function redact(s: string): string {
  if (!s) return s;
  return s.replace(/\b[0-9a-fA-F]{64}\b/g, (m) => m.slice(0, 8) + '…[redacted]');
}

function serializeArgs(args: any[]): string {
  const parts = args.map((a) =>
    typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: 140, maxStringLength: 2000 }),
  );
  let msg = parts.join(' ');
  if (msg.length > MAX_MSG_LEN) msg = msg.slice(0, MAX_MSG_LEN) + '…[truncated]';
  return redact(msg);
}

function push(level: string, args: any[]) {
  const store = als.getStore();
  if (!store) return;
  if (store.logs.length >= MAX_LOGS) store.logs.shift();
  store.logs.push({ level, ts: Date.now(), msg: serializeArgs(args) });
  // If an Error object was logged, keep its stack in errors[] too.
  for (const a of args) {
    if (a instanceof Error && a.stack) {
      store.errors.push({ message: a.message, stack: redact(a.stack) });
    }
  }
}

// ---- console patching (idempotent) --------------------------------------
let installed = false;
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;
  const levels: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = ['log', 'info', 'warn', 'error', 'debug'];
  for (const lvl of levels) {
    const orig = (console as any)[lvl].bind(console);
    (console as any)[lvl] = (...args: any[]) => {
      orig(...args);                 // still write to stdout/stderr as before
      try { push(lvl, args); } catch { /* never let logging break a request */ }
    };
  }
}

// ---- explicit error helper ---------------------------------------------
// Records the responded error (with stack) into the request store, then
// sends the standard { error } body. The res.json wrapper adds `debug`.
export function sendError(res: Response, err: any, status = 500): Response {
  const store = als.getStore();
  if (store) {
    store.errors.push({
      message: err?.message ?? String(err),
      stack: err?.stack ? redact(String(err.stack)) : undefined,
    });
  }
  return res.status(status).json({ error: err?.message ?? String(err) });
}

// ---- middleware ---------------------------------------------------------
function wantsDebug(req: Request, statusCode: number): boolean {
  if (statusCode >= 400) return true;                       // always on errors
  if (process.env.API_DEBUG === '1') return true;           // global opt-in
  if (req.headers['x-debug'] != null) return true;          // per-request header
  const q = (req.query?.debug as string | undefined);
  return q === '1' || q === 'true';                         // per-request query
}

function buildDebug(store: RequestLogStore, statusCode: number) {
  return {
    requestId: store.id,
    durationMs: Date.now() - store.start,
    status: statusCode,
    errors: store.errors,
    logs: store.logs,
  };
}

export function requestLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const store: RequestLogStore = {
    id: `${Date.now().toString(36)}-${(++reqCounter).toString(36)}`,
    start: Date.now(),
    logs: [],
    errors: [],
  };
  als.run(store, () => {
    const origJson = res.json.bind(res);
    (res as any).json = (body: any) => {
      try {
        if (wantsDebug(req, res.statusCode) && body && typeof body === 'object' && !Array.isArray(body)) {
          body = { ...body, debug: buildDebug(store, res.statusCode) };
        }
      } catch { /* attaching debug must never break the response */ }
      return origJson(body);
    };
    next();
  });
}
