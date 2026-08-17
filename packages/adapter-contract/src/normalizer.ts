import type { NormalizedEvent, RawObservation } from '@baccarat/contracts';

const EVENT_TYPES = new Set([
  'newShoeSignal',
  'shoeConfirmation',
  'cardObserved',
  'bettingWindowOpened',
  'bettingWindowClosed',
  'handSettled',
  'redCardSeen',
  'burnModelUpdated',
  'connectionLost',
  'connectionRestored',
  'betReceipt',
  'shoeInvalidated',
  'manualCorrection',
  'autoArmChanged',
  'autoDisarmChanged',
]);

/**
 * 归一化降级通道：只接受“已经是归一化形状”的 payload，绝不编造字段。
 * 无法安全归一化时返回 null，由调用方走人工审核。
 */
export function rawToNormalizedFallback(raw: RawObservation): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw.payload as unknown;
  if (!candidate || typeof candidate !== 'object') return null;
  const event = candidate as Record<string, unknown>;
  if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) return null;
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) return null;
  if (typeof event.tableId !== 'string' || event.tableId.length === 0) return null;
  if (!Number.isInteger(event.sourceSeq) || (event.sourceSeq as number) < 0) return null;
  if (typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) return null;
  return event as unknown as NormalizedEvent;
}
