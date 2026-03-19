// =============================================================
// Wallet Setup for Midnight Preview Network
// =============================================================

import { WebSocket } from 'ws';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { ENDPOINTS, NETWORK } from './config.js';

// Make WebSocket globally available (Node.js has no native WebSocket)
(globalThis as any).WebSocket = WebSocket;

/**
 * Initializes the network and returns the providers
 * required for contract deployment and interaction.
 */
export function initializeNetwork() {
  console.log(`🌐 Network: ${NETWORK}`);
  console.log(`📡 Indexer:  ${ENDPOINTS.indexerHttp}`);
  console.log(`🔐 Proof:    ${ENDPOINTS.proofServer}`);
  console.log('');

  // Set network ID (affects address format, ledger, ZSwap)
  setNetworkId(NETWORK);
}

/**
 * Creates all providers required for contract operations.
 * @param zkConfigPath - Path to the compiled ZK artifacts
 * @param stateStoreName - Name of the LevelDB store for private state
 */
export function createProviders(zkConfigPath: string, stateStoreName: string) {
  return {
    publicDataProvider: indexerPublicDataProvider(
      ENDPOINTS.indexerHttp,
      ENDPOINTS.indexerWs
    ),
    proofProvider: httpClientProofProvider(ENDPOINTS.proofServer),
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: stateStoreName,
    }),
    zkConfigProvider: new NodeZkConfigProvider(zkConfigPath),
  };
}
