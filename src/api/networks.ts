// =============================================================
// Netzwerk-Konfigurationen fuer Midnight
// =============================================================

export type NetworkName = 'preview' | 'preprod' | 'mainnet';

export interface NetworkConfig {
  networkId: string;
  nodeRpc: string;
  indexerHttp: string;
  indexerWs: string;
  proofServer: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  preview: {
    networkId: 'preview',
    nodeRpc: 'https://rpc.preview.midnight.network',
    indexerHttp: 'https://indexer.preview.midnight.network/api/v3/graphql',
    indexerWs: 'wss://indexer.preview.midnight.network/api/v3/graphql/ws',
    proofServer: 'http://localhost:6300',
  },
  preprod: {
    networkId: 'preprod',
    nodeRpc: 'https://rpc.preprod.midnight.network',
    indexerHttp: 'https://indexer.preprod.midnight.network/api/v3/graphql',
    indexerWs: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
    proofServer: 'http://localhost:6300',
  },
  mainnet: {
    networkId: 'mainnet',
    nodeRpc: 'https://rpc.midnight.network',
    indexerHttp: 'https://indexer.midnight.network/api/v3/graphql',
    indexerWs: 'wss://indexer.midnight.network/api/v3/graphql/ws',
    proofServer: 'http://localhost:6300',
  },
};

export function getNetwork(name?: string): NetworkConfig {
  const n = (name || 'preview') as NetworkName;
  const config = NETWORKS[n];
  if (!config) throw new Error(`Unknown network: ${name}. Use: preview, preprod, mainnet`);
  return config;
}
