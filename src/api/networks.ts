// =============================================================
// Network configuration for Midnight
// One instance = one network. Config sources (in order of precedence):
//   1. CLI args / env vars (MIDNIGHT_NETWORK, MIDNIGHT_INDEXER_HTTP, ...)
//   2. Config file: config.<network>.json (via --config or MIDNIGHT_CONFIG)
//   3. Public defaults
//
// Custom indexer/node URLs are passed by the caller — no special-casing.
// If a custom URL fails on startup, we fall back to the public default.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type NetworkName = 'preview' | 'preprod' | 'mainnet';

export interface NetworkConfig {
  networkId: NetworkName;
  nodeRpc: string;
  indexerHttp: string;
  indexerWs: string;
  proofServer: string;
}

interface ConfigFile {
  network?: string;
  port?: number;
  proofServer?: string;
  apiUrl?: string;
  indexerHttp?: string;
  indexerWs?: string;
  nodeRpc?: string;
}

function loadConfigFile(): ConfigFile {
  const args = process.argv;
  const configArgIdx = args.indexOf('--config');
  let configPath = '';

  if (configArgIdx >= 0 && args[configArgIdx + 1]) {
    configPath = args[configArgIdx + 1];
  } else if (process.env.MIDNIGHT_CONFIG) {
    configPath = process.env.MIDNIGHT_CONFIG;
  } else {
    const network = process.env.MIDNIGHT_NETWORK || 'preprod';
    const autoPath = path.resolve(__dirname, `../../config.${network}.json`);
    if (fs.existsSync(autoPath)) configPath = autoPath;
  }

  if (configPath && fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      console.log(`[Config] Loaded from ${configPath}`);
      return JSON.parse(raw);
    } catch (err: any) {
      console.error(`[Config] Failed to parse ${configPath}: ${err.message}`);
    }
  }

  return {};
}

const configFile = loadConfigFile();

// ---- Public defaults (fallback) ----

export const PUBLIC_ENDPOINTS: Record<NetworkName, { indexerHttp: string; indexerWs: string; nodeRpc: string }> = {
  preview: {
    indexerHttp: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    nodeRpc: 'https://rpc.preview.midnight.network',
  },
  preprod: {
    indexerHttp: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    nodeRpc: 'https://rpc.preprod.midnight.network',
  },
  mainnet: {
    indexerHttp: 'https://indexer.mainnet.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.mainnet.midnight.network/api/v4/graphql/ws',
    nodeRpc: 'https://rpc.mainnet.midnight.network',
  },
};

// ---- Build active config ----

const envNetwork = (configFile.network || process.env.MIDNIGHT_NETWORK || 'preprod').toLowerCase() as NetworkName;
if (!['preview', 'preprod', 'mainnet'].includes(envNetwork)) {
  throw new Error(`Invalid network "${envNetwork}". Must be: preview, preprod, mainnet`);
}

const defaults = PUBLIC_ENDPOINTS[envNetwork];

// Resolve URLs: env > config file > public default
const indexerHttp = process.env.MIDNIGHT_INDEXER_HTTP || configFile.indexerHttp || defaults.indexerHttp;
const indexerWs = process.env.MIDNIGHT_INDEXER_WS || configFile.indexerWs || defaults.indexerWs;
const nodeRpc = process.env.MIDNIGHT_NODE_RPC || configFile.nodeRpc || defaults.nodeRpc;

export const ACTIVE_NETWORK: NetworkConfig = {
  networkId: envNetwork,
  indexerHttp,
  indexerWs,
  nodeRpc,
  proofServer: process.env.MIDNIGHT_PROOF_SERVER || configFile.proofServer || 'http://localhost:6300',
};

// Whether we are using a custom indexer (not the public default)
export const USING_CUSTOM_INDEXER = indexerHttp !== defaults.indexerHttp;

// Public URL for Swagger
export const PUBLIC_API_URL: string =
  process.env.MIDNIGHT_API_URL || configFile.apiUrl || `https://midnight-api.${envNetwork}.nmkr.io`;

// Port (used by server.ts)
export const PORT: number =
  Number(process.env.PORT) || configFile.port || 3000;

// ---- Indexer health check + fallback ----
// If the configured indexer is unreachable on startup, fall back to the public one.
// Call this once during server startup before any wallet operations.
export async function checkIndexerAndFallback(): Promise<void> {
  if (!USING_CUSTOM_INDEXER) return;

  const customUrl = ACTIVE_NETWORK.indexerHttp;
  const ok = await pingIndexer(customUrl);
  if (ok) {
    console.log(`[Network] Custom indexer OK: ${customUrl}`);
    return;
  }

  console.warn(`[Network] Custom indexer unreachable: ${customUrl}`);
  console.warn(`[Network] Falling back to public endpoints for ${envNetwork}`);
  ACTIVE_NETWORK.indexerHttp = defaults.indexerHttp;
  ACTIVE_NETWORK.indexerWs = defaults.indexerWs;
  ACTIVE_NETWORK.nodeRpc = defaults.nodeRpc;
}

async function pingIndexer(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
