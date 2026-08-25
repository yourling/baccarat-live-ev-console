import type { BettingWindowOpenedEvent, CardObservedEvent, HandSettledEvent, NormalizedEvent } from '@baccarat/contracts';
import { describe, expect, it } from 'vitest';
import { resolveVisibleHandCards } from '../src/ui/hand-cards';

const tableId = 'D055';
const shoeId = 'shoe-D055';
const settledHandId = 'hand-settled';
const nextHandId = 'hand-next';
const timestamp = '2026-08-23T04:39:42.000Z';

const settled: HandSettledEvent = {
  eventId: 'settled-1',
  tableId,
  timestamp,
  sourceSeq: 1,
  type: 'handSettled',
  shoeId,
  handId: settledHandId,
  playerCards: [{ rank: '4', suit: 'D' }, { rank: 'J', suit: 'H' }],
  bankerCards: [{ rank: '10', suit: 'S' }, { rank: '8', suit: 'S' }],
};

const nextBettingWindow: BettingWindowOpenedEvent = {
  eventId: 'opened-2',
  tableId,
  timestamp,
  sourceSeq: 2,
  type: 'bettingWindowOpened',
  shoeId,
  handId: nextHandId,
  market: 'bankerPair',
};

describe('resolveVisibleHandCards', () => {
  it('keeps the previous settled hand visible and explicitly labelled while the next betting window has no cards', () => {
    const display = resolveVisibleHandCards([settled, nextBettingWindow], tableId, shoeId, nextHandId);

    expect(display).toEqual({
      source: 'previous-settled',
      handId: settledHandId,
      player: settled.playerCards,
      banker: settled.bankerCards,
    });
  });

  it('prefers observed cards from the current hand over a prior settled hand', () => {
    const currentPlayerCard: CardObservedEvent = {
      eventId: 'card-3',
      tableId,
      timestamp,
      sourceSeq: 3,
      type: 'cardObserved',
      shoeId,
      handId: nextHandId,
      position: 'player:0',
      card: { rank: 'A', suit: 'S' },
    };
    const events: NormalizedEvent[] = [settled, nextBettingWindow, currentPlayerCard];

    const display = resolveVisibleHandCards(events, tableId, shoeId, nextHandId);

    expect(display).toEqual({
      source: 'current',
      handId: nextHandId,
      player: [currentPlayerCard.card],
      banker: [],
    });
  });
});
