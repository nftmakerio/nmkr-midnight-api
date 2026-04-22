// =============================================================
// Network configuration for Midnight
// One instance = one network. Determined by MIDNIGHT_NETWORK env var.
// =============================================================

export type NetworkName = 'preview' | 'preprod' | 'mainnet';

export interface NetworkConfig {
  networkId: NetworkName;
  nodeRpc: string;
  indexerHttp: string;
  indexerWs: string;
  proofServer: string;
  blockfrostProjectId?: string;  // if set, use Blockfrost endpoints with auth
}

// Blockfrost configuration (optional — set BLOCKFROST_PROJECT_ID to enable)
const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID || '';

// Blockfrost endpoint patterns per network
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

// Default Midnight endpoints (no auth required)
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
    indexerHttp: 'https://indexer.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.midnight.network/api/v4/graphql/ws',
    nodeRpc: 'https://rpc.midnight.network',
  },
};

const NETWORKS: Record<NetworkName, NetworkConfig> = Object.fromEntries(
  (['preview', 'preprod', 'mainnet'] as NetworkName[]).map(n => {
    const endpoints = BLOCKFROST_PROJECT_ID ? BLOCKFROST_ENDPOINTS[n] : DEFAULT_ENDPOINTS[n];
    return [n, {
      networkId: n,
      ...endpoints,
      proofServer: process.env.MIDNIGHT_PROOF_SERVER || 'http://localhost:6300',
      blockfrostProjectId: BLOCKFROST_PROJECT_ID || undefined,
    }];
  }),
) as Record<NetworkName, NetworkConfig>;

const envNetwork = (process.env.MIDNIGHT_NETWORK || 'preprod').toLowerCase() as NetworkName;
if (!NETWORKS[envNetwork]) {
  throw new Error(`Invalid MIDNIGHT_NETWORK="${envNetwork}". Must be: preview, preprod, mainnet`);
}

// The active network for this instance — determined at startup
export const ACTIVE_NETWORK: NetworkConfig = NETWORKS[envNetwork];

// Public URL (for Swagger — set via MIDNIGHT_API_URL env)
export const PUBLIC_API_URL: string =
  process.env.MIDNIGHT_API_URL || `https://midnight-api.${envNetwork}.nmkr.io`;
