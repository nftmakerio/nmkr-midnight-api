// =============================================================
// Blockfrost Authentication Helpers
//
// When BLOCKFROST_PROJECT_ID is set, wraps globalThis.fetch and
// WebSocket to inject the `project_id` header into all requests
// to Blockfrost endpoints.
// =============================================================

import { WebSocket as WsWebSocket } from 'ws';
import { ACTIVE_NETWORK } from './networks.js';

// Wrap globalThis.fetch to inject project_id header for Blockfrost requests
export function setupBlockfrostAuth() {
  const projectId = ACTIVE_NETWORK.blockfrostProjectId;
  if (!projectId) return; // No Blockfrost — nothing to do

  console.log(`[Blockfrost] Auth enabled for ${ACTIVE_NETWORK.networkId} (project_id: ${projectId.substring(0, 8)}...)`);

  // Wrap fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('blockfrost.io')) {
      init = init || {};
      init.headers = {
        ...(init.headers || {}),
        'project_id': projectId,
      };
    }

    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  // Wrap WebSocket — the SDK uses globalThis.WebSocket for GraphQL subscriptions.
  // We need to inject the project_id as a subprotocol or connection param since
  // WebSocket doesn't support custom headers in browsers. However in Node.js,
  // the 'ws' library supports headers via the constructor options.
  const OrigWebSocket = globalThis.WebSocket as any;
  const AuthWebSocket = function (url: string | URL, protocols?: string | string[]) {
    const urlStr = typeof url === 'string' ? url : url.toString();

    if (urlStr.includes('blockfrost.io')) {
      // Node.js ws library supports headers in the 3rd argument
      return new WsWebSocket(urlStr, protocols as any, {
        headers: { 'project_id': projectId },
      });
    }

    return new OrigWebSocket(url, protocols);
  } as any;

  // Copy static properties
  AuthWebSocket.CONNECTING = WsWebSocket.CONNECTING;
  AuthWebSocket.OPEN = WsWebSocket.OPEN;
  AuthWebSocket.CLOSING = WsWebSocket.CLOSING;
  AuthWebSocket.CLOSED = WsWebSocket.CLOSED;

  globalThis.WebSocket = AuthWebSocket;
}
