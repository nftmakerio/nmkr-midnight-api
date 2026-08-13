// =============================================================
// Access log — writes EVERY API call to a daily text file.
//
// Captures: timestamp, caller IP, method + path + query, the FULL request
// JSON body, and the response body + status + duration. One file per day
// (access-YYYY-MM-DD.log).
//
// TESTING AID: request bodies contain seeds / mnemonics in plain text, so
// this is OPT-IN via env and off by default:
//   ACCESS_LOG=1            enable
//   ACCESS_LOG_DIR=<path>   log directory (default: <project>/logs)
//   ACCESS_LOG_MASK=1       redact seeds/mnemonics in the log (default: full)
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response, NextFunction } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ACCESS_LOG_ENABLED = process.env.ACCESS_LOG === '1' || process.env.ACCESS_LOG === 'true';
const LOG_DIR = process.env.ACCESS_LOG_DIR || path.resolve(__dirname, '../../logs');
const MASK = process.env.ACCESS_LOG_MASK === '1' || process.env.ACCESS_LOG_MASK === 'true';
const MAX_BODY = 256 * 1024;   // cap each logged body to keep files sane

// ---- daily write stream (rotates when the local date changes) ----
let stream: fs.WriteStream | null = null;
let streamDate = '';

function localDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function getStream(): fs.WriteStream {
  const date = localDate();
  if (!stream || date !== streamDate) {
    try { stream?.end(); } catch { /* ignore */ }
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(path.join(LOG_DIR, `access-${date}.log`), { flags: 'a' });
    streamDate = date;
  }
  return stream;
}

// ---- optional secret masking ----
const SECRET_KEYS = ['seed', 'seedOrAddress', 'senderSeed', 'ownerSeed', 'dustSeed', 'mnemonic'];
function mask(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  const clone: any = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const k of Object.keys(clone)) {
    if (SECRET_KEYS.includes(k) && typeof clone[k] === 'string') clone[k] = clone[k].slice(0, 8) + '…[masked]';
    else if (typeof clone[k] === 'object') clone[k] = mask(clone[k]);
  }
  return clone;
}

function fmt(v: any): string {
  let s: string;
  try { s = JSON.stringify(MASK ? mask(v) : v); } catch { s = String(v); }
  if (s == null) return '';
  if (s.length > MAX_BODY) s = s.slice(0, MAX_BODY) + `…[truncated ${s.length - MAX_BODY} chars]`;
  return s;
}

export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!ACCESS_LOG_ENABLED) return next();

  const start = Date.now();
  const startedAt = new Date().toISOString();
  const ip = req.ip || req.socket?.remoteAddress || '-';
  let responseBody: any;

  // Capture the response body written via res.json (wraps the current
  // res.json, so it sees the final payload incl. any `debug` field).
  const origJson = res.json.bind(res);
  (res as any).json = (body: any) => { responseBody = body; return origJson(body); };

  res.on('finish', () => {
    try {
      const durationMs = Date.now() - start;
      const hasBody = req.body && Object.keys(req.body).length > 0;
      const hasQuery = req.query && Object.keys(req.query).length > 0;
      const block =
        `===== ${startedAt} | ${ip} | ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms) =====\n` +
        (hasQuery ? `QUERY  ${fmt(req.query)}\n` : '') +
        `BODY   ${hasBody ? fmt(req.body) : '(empty)'}\n` +
        `RESULT ${responseBody !== undefined ? fmt(responseBody) : '(non-JSON or no body)'}\n\n`;
      getStream().write(block);
    } catch { /* never let logging break the response */ }
  });

  next();
}
