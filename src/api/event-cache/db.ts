// =============================================================
// MySQL connection pool for the event cache
//
// Config via env vars (preferred) or via config.<network>.json `db` section.
// Defaults to localhost root/no-password — adjust for production.
// =============================================================

import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE_NETWORK } from '../networks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  ssl: boolean;
}

function loadDbConfig(): DbConfig {
  // Try to read from the active config file
  let fileCfg: any = {};
  try {
    const configArg = process.argv.indexOf('--config');
    const path1 = configArg >= 0 ? process.argv[configArg + 1] : '';
    const path2 = process.env.MIDNIGHT_CONFIG || '';
    const path3 = `config.${ACTIVE_NETWORK.networkId}.json`;
    for (const p of [path1, path2, path3].filter(Boolean)) {
      if (fs.existsSync(p)) {
        fileCfg = (JSON.parse(fs.readFileSync(p, 'utf-8')) || {}).db || {};
        break;
      }
    }
  } catch { /* ignore */ }

  const sslEnv = process.env.MIDNIGHT_DB_SSL;
  return {
    host:     process.env.MIDNIGHT_DB_HOST     || fileCfg.host     || '127.0.0.1',
    port: Number(process.env.MIDNIGHT_DB_PORT  || fileCfg.port     || 3306),
    user:     process.env.MIDNIGHT_DB_USER     || fileCfg.user     || 'midnight',
    password: process.env.MIDNIGHT_DB_PASSWORD || fileCfg.password || '',
    database: process.env.MIDNIGHT_DB_NAME     || fileCfg.database || `midnight_cache_${ACTIVE_NETWORK.networkId}`,
    connectionLimit: Number(process.env.MIDNIGHT_DB_POOL || fileCfg.connectionLimit || 10),
    // SSL: enabled by default for non-localhost (e.g. DigitalOcean / RDS).
    ssl: sslEnv ? sslEnv !== 'false' : (fileCfg.ssl !== false &&
      !['127.0.0.1', 'localhost', '::1'].includes(process.env.MIDNIGHT_DB_HOST || fileCfg.host || '127.0.0.1')),
  };
}

export const DB_CONFIG = loadDbConfig();

let pool: mysql.Pool | null = null;
export function getPool(): mysql.Pool {
  if (!pool) {
    const { ssl, ...rest } = DB_CONFIG;
    pool = mysql.createPool({
      ...rest,
      waitForConnections: true,
      multipleStatements: true,  // for schema bootstrap
      // For DigitalOcean / RDS the default SSL options work fine.
      ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }
  return pool;
}

/** Test DB connectivity. Returns true if reachable, false otherwise. */
export async function pingDb(): Promise<boolean> {
  try {
    const p = getPool();
    const [rows]: any = await p.query('SELECT 1 AS ok');
    return rows?.[0]?.ok === 1;
  } catch {
    return false;
  }
}

/**
 * Apply schema.sql on startup (idempotent — uses CREATE TABLE IF NOT EXISTS).
 * Caller should ensure the database itself exists; we don't CREATE DATABASE
 * because the user may want to manage that out-of-band.
 */
export async function applySchema(): Promise<void> {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  const p = getPool();
  await p.query(schema);
}

export async function closeDb(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
