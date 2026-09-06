import type { ConnectionStatus, ShoeStateProjection } from '@baccarat/contracts';

/**
 * Ledger connectionStatus is only updated by connectionLost/Restored events.
 * Runtime feed health can already be DISCONNECTED/stale while the actor still
 * says CONNECTED. The monitor column must follow the live feed.
 */
export function monitorDisplayedConnection(
  projection: Pick<ShoeStateProjection, 'connectionStatus'>,
  runtime?: {
    readonly feedState?: string;
    readonly reasons?: readonly string[];
  },
): ConnectionStatus {
  const reasons = runtime?.reasons ?? [];
  if (runtime?.feedState === 'DISCONNECTED' || reasons.includes('table-feed-disconnected')) {
    return 'DISCONNECTED';
  }
  if (reasons.includes('table-feed-missing') || reasons.includes('table-feed-stale')) {
    return projection.connectionStatus === 'DISCONNECTED' ? 'DISCONNECTED' : 'RESYNCING';
  }
  if (runtime?.feedState === 'CONNECTED' && projection.connectionStatus === 'DISCONNECTED') {
    return 'RESYNCING';
  }
  return projection.connectionStatus;
}
