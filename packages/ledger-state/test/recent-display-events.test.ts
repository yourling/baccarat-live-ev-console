import { describe, expect, it, vi } from 'vitest';
import { SqliteLedger } from '../src/ledger.js';
import type { NormalizedEvent } from '@baccarat/contracts';

const baseTime = '2026-09-06T15:00:00.000Z';

function ev(partial: object, index: number): NormalizedEvent {
  return {
    ...partial,
    eventId: `e${index}`,
    tableId: 't1',
    timestamp: new Date(Date.parse(baseTime) + index * 1000).toISOString(),
    sourceSeq: index,
  } as NormalizedEvent;
}

describe('recent display events', () => {
  it('returns only the latest settlements without scanning the full table via listEvents', () => {
    const ledger = new SqliteLedger();
    try {
      const listEvents = vi.spyOn(ledger, 'listEvents');
      for (let index = 0; index < 40; index += 1) {
        ledger.appendEvent(ev({
          type: 'handSettled',
          shoeId: 'shoe-1',
          handId: `h${index}`,
          playerCards: [{ rank: 'A', suit: 'S' }, { rank: '2', suit: 'H' }],
          bankerCards: [{ rank: '3', suit: 'C' }, { rank: '4', suit: 'D' }],
          outcomes: { playerPair: false, bankerPair: false },
        }, index + 1));
      }
      const recent = ledger.listRecentDisplayEvents('t1', 8);
      expect(listEvents).not.toHaveBeenCalled();
      expect(recent).toHaveLength(8);
      expect(recent.map(event => event.eventId)).toEqual([
        'e33', 'e34', 'e35', 'e36', 'e37', 'e38', 'e39', 'e40',
      ]);
      expect(ledger.listRecentDisplayEventsForTables(['t1', 'missing'], 3).map(event => event.eventId)).toEqual([
        'e38', 'e39', 'e40',
      ]);
    } finally {
      ledger.close();
    }
  });
});
