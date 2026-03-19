// =============================================================
// Wallet-Setup für Midnight Preview-Netzwerk
// =============================================================

import { WebSocket } from 'ws';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { ENDPOINTS, NETWORK } from './config.js';

// WebSocket global verfügbar machen (Node.js hat kein natives WebSocket)
(globalThis as any).WebSocket = WebSocket;

/**
 * Initialisiert das Netzwerk und gibt die Provider zurück,
 * die für Contract-Deployment und -Interaktion benötigt werden.
 */
export function initializeNetwork() {
  console.log(`🌐 Netzwerk: ${NETWORK}`);
  console.log(`📡 Indexer:  ${ENDPOINTS.indexerHttp}`);
  console.log(`🔐 Proof:    ${ENDPOINTS.proofServer}`);
  console.log('');

  // Netzwerk-ID setzen (beeinflusst Adressformat, Ledger, ZSwap)
  setNetworkId(NETWORK);
}

/**
 * Erstellt alle Provider die für Contract-Operationen benötigt werden.
 * @param zkConfigPath - Pfad zu den kompilierten ZK-Artifacts
 * @param stateStoreName - Name des LevelDB-Stores für Private State
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
