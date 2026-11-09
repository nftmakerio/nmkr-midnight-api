// =============================================================
// Network id holder.
//
// Midnight.js 4 kept the network id in a process-global inside
// @midnight-ntwrk/midnight-js-network-id. Midnight.js 5 / wallet-sdk 2 take the
// network id explicitly everywhere, and that package is no longer part of the
// stack. This keeps the old setNetworkId/getNetworkId call sites working with a
// plain module-level value (one API instance = one network).
// =============================================================

let current: string | undefined;

export function setNetworkId(id: string): void {
  if (typeof id === 'string' && id.length > 0) current = id;
}

export function getNetworkId(): string {
  if (current === undefined) throw new Error('network id not set');
  return current;
}
