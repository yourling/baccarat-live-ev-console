import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@baccarat/contracts';
import { buildRandomTable, demoProfiles } from '../src/core-demo';

describe('baccarat demo dealing', () => {
  it('emits third-card observations and matching settlement cards', () => {
    const profile = demoProfiles()[0];
    const streams = Array.from({ length: 10 }, (_, index) => buildRandomTable('table-1', profile, index + 1, 'test-' + index));
    const settlements = streams.flatMap(events => events.filter((event): event is Extract<NormalizedEvent, { type: 'handSettled' }> => event.type === 'handSettled'));

    expect(settlements.some(event => event.playerCards.length === 3 || event.bankerCards.length === 3)).toBe(true);
    for (const settlement of settlements) {
      const observed = streams.flatMap(events => events.filter(event => event.type === 'cardObserved' && event.handId === settlement.handId));
      expect(observed.filter(event => event.type === 'cardObserved' && event.position?.startsWith('player')).length).toBe(settlement.playerCards.length);
      expect(observed.filter(event => event.type === 'cardObserved' && event.position?.startsWith('banker')).length).toBe(settlement.bankerCards.length);
    }
  });

  it('places red-card signals after most of the shoe is consumed', () => {
    const profile = demoProfiles()[0];
    const events = buildRandomTable('table-1', profile, 42, 'red-position');
    const redCards = events.filter((event): event is Extract<NormalizedEvent, { type: 'redCardSeen' }> => event.type === 'redCardSeen');

    expect(redCards.length).toBeGreaterThan(0);
    for (const redCard of redCards) {
      const shoeEvents = events.filter(event => 'shoeId' in event && event.shoeId === redCard.shoeId);
      const redIndex = shoeEvents.indexOf(redCard);
      const cardsBeforeRed = shoeEvents.slice(0, redIndex).filter(event => event.type === 'cardObserved').length;
      expect(cardsBeforeRed).toBeGreaterThanOrEqual(Math.floor(profile.numberOfDecks * 52 * 0.8));
    }
  });
});
