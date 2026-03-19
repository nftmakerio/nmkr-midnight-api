// =============================================================
// Midnight Preview Network Configuration
// =============================================================

export const NETWORK = 'preview' as const;

export const ENDPOINTS = {
  // Preview network
  nodeRpc: 'https://rpc.preview.midnight.network',
  indexerHttp: 'https://indexer.preview.midnight.network/api/v3/graphql',
  indexerWs: 'wss://indexer.preview.midnight.network/api/v3/graphql/ws',

  // Proof server (local via Docker: docker run -p 6300:6300 midnightntwrk/proof-server:7.0.0 midnight-proof-server -v)
  proofServer: 'http://localhost:6300',
} as const;

// NFT collection metadata
export const NFT_COLLECTION = {
  name: 'MidnightNFT',
  symbol: 'MNFT',
} as const;
