import { describe, expect, it } from 'vitest';
import { SimulatedAdapter, rawToNormalizedFallback } from '../src/index.js';
import type { NormalizedEvent, RawObservation } from '@baccarat/contracts';

function raw(payload: unknown): RawObservation {
  return {
    rawEventId: 'r1',
    sourceSeq: 1,
    timestamp: '2025-01-01T00:00:00.000Z',
    windowId: 'w1',
    tableId: 't1',
    evidenceLevel: 'raw',
    payload,
  };
}

describe('adapter normalization fallback', () => {
  it('accepts an already-normalized payload', () => {
    const event: NormalizedEvent = {
      type: 'connectionLost',
      eventId: 'e1',
      tableId: 't1',
      timestamp: '2025-01-01T00:00:00.000Z',
      sourceSeq: 1,
    };
    expect(rawToNormalizedFallback(raw(event))).toEqual(event);
  });

  it('returns null instead of inventing fields for unstructured raw payloads', () => {
    expect(rawToNormalizedFallback(raw({ foo: 'bar' }))).toBeNull();
    expect(rawToNormalizedFallback(raw({ type: 'connectionLost', eventId: 'e1' }))).toBeNull();
    expect(rawToNormalizedFallback(raw({ type: 'notAnEvent', eventId: 'e1', tableId: 't1', timestamp: '2025-01-01T00:00:00.000Z', sourceSeq: 1 }))).toBeNull();
  });

  it('uses simulated latency and echoes the reservationId on receipts', async () => {
    const adapter = new SimulatedAdapter({ events: [], simulateLatencyMs: 1 });
    const seen: string[] = [];
    await adapter.start(event => seen.push(event.eventId));
    expect(seen).toEqual([]);
    const receipt = await adapter.requestBet({
      intent: {
        intentId: 'i1', tableId: 't1', shoeId: 's1', handId: 'h1', market: 'bankerPair',
        amount: 10, mode: 'simulated', idempotencyKey: 'k1', strategy: { type: 'both' },
        decisionSnapshotId: 'd1', createdAt: new Date().toISOString(),
      },
      mode: 'simulated',
      reservationId: 'rv-1',
    });
    expect(receipt?.reservationId).toBe('rv-1');
    expect(receipt?.status).toBe('SIMULATED');
  });
});
