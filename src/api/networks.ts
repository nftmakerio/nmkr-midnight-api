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
}

const NETWORKS: Record<NetworkName, NetworkConfig> = {
  preview: {
    networkId: 'preview',
    nodeRpc: 'https://rpc.preview.midnight.network',
    indexerHttp: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    proofServer: process.env.MIDNIGHT_PROOF_SERVER || 'http://localhost:6300',
  },
  preprod: {
    networkId: 'preprod',
    nodeRpc: 'https://rpc.preprod.midnight.network',
    indexerHttp: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    proofServer: process.env.MIDNIGHT_PROOF_SERVER || 'http://localhost:6300',
  },
  mainnet: {
    networkId: 'mainnet',
    nodeRpc: 'https://rpc.midnight.network',
    indexerHttp: 'https://indexer.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.midnight.network/api/v4/graphql/ws',
    proofServer: process.env.MIDNIGHT_PROOF_SERVER || 'http://localhost:6300',
  },
};

const envNetwork = (process.env.MIDNIGHT_NETWORK || 'preprod').toLowerCase() as NetworkName;
if (!NETWORKS[envNetwork]) {
  throw new Error(`Invalid MIDNIGHT_NETWORK="${envNetwork}". Must be: preview, preprod, mainnet`);
}

// The active network for this instance — determined at startup
export const ACTIVE_NETWORK: NetworkConfig = NETWORKS[envNetwork];

// Public URL (for Swagger — set via MIDNIGHT_API_URL env)
export const PUBLIC_API_URL: string =
  process.env.MIDNIGHT_API_URL || `https://midnight-api.${envNetwork}.nmkr.io`;
