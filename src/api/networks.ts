// =============================================================
// Network configuration for Midnight
// One instance = one network. Config loaded from:
//   1. Config file: config.<network>.json (via --config or MIDNIGHT_CONFIG)
//   2. Environment variables (MIDNIGHT_NETWORK, PORT, etc.)
//   3. Defaults
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
  blockfrostProjectId?: string;
}

// ---- Load config file ----

interface ConfigFile {
  network?: string;
  port?: number;
  proofServer?: string;
  apiUrl?: string;
  blockfrostProjectId?: string;
  nodeOptions?: string;
}

function loadConfigFile(): ConfigFile {
  // Check --config CLI arg, MIDNIGHT_CONFIG env, or auto-detect from MIDNIGHT_NETWORK
  const args = process.argv;
  const configArgIdx = args.indexOf('--config');
  let configPath = '';

  if (configArgIdx >= 0 && args[configArgIdx + 1]) {
    configPath = args[configArgIdx + 1];
  } else if (process.env.MIDNIGHT_CONFIG) {
    configPath = process.env.MIDNIGHT_CONFIG;
  } else {
    // Auto-detect: config.<network>.json in project root
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

// ---- Blockfrost ----

const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID || configFile.blockfrostProjectId || '';

const BLOCKFROST_ENDPOINTS: Record<NetworkName, { indexerHttp: string; indexerWs: string; nodeRpc: string }> = {
  preview: {
    indexerHttp: 'https://midnight-preview.blockfrost.io/api/v0',
    indexerWs: 'wss://midnight-preview.blockfrost.io/api/v0/ws',
    nodeRpc: 'https://rpc.midnight-preview.blockfrost.io',
  },
  preprod: {
    indexerHttp: 'https://midnight-preprod.blockfrost.io/api/v0',
    indexerWs: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
    nodeRpc: 'https://rpc.midnight-preprod.blockfrost.io',
  },
  mainnet: {
    indexerHttp: 'https://midnight-mainnet.blockfrost.io/api/v0',
    indexerWs: 'wss://midnight-mainnet.blockfrost.io/api/v0/ws',
    nodeRpc: 'https://rpc.midnight-mainnet.blockfrost.io',
  },
};

const DEFAULT_ENDPOINTS: Record<NetworkName, { indexerHttp: string; indexerWs: string; nodeRpc: string }> = {
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

const endpoints = BLOCKFROST_PROJECT_ID ? BLOCKFROST_ENDPOINTS[envNetwork] : DEFAULT_ENDPOINTS[envNetwork];

export const ACTIVE_NETWORK: NetworkConfig = {
  networkId: envNetwork,
  ...endpoints,
  proofServer: process.env.MIDNIGHT_PROOF_SERVER || configFile.proofServer || 'http://localhost:6300',
  blockfrostProjectId: BLOCKFROST_PROJECT_ID || undefined,
};

// Public URL for Swagger
export const PUBLIC_API_URL: string =
  process.env.MIDNIGHT_API_URL || configFile.apiUrl || `https://midnight-api.${envNetwork}.nmkr.io`;

// Port (used by server.ts)
export const PORT: number =
  Number(process.env.PORT) || configFile.port || 3000;
