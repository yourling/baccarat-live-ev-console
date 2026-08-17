import { describe, expect, it } from 'vitest';
import { pairMarketStream } from '../src/index.js';
import { replayEvents } from '@baccarat/ledger-state';
import { defaultProfile } from '@baccarat/contracts';

describe('simulator fixtures', () => {
  it('generates deterministic red-card wind-down stream', () => {
    const profile = { ...defaultProfile('t1'), autoConfirmNewShoe: true };
    const events = pairMarketStream('t1', profile, { shoeCount: 1, handsPerShoe: 2, redCardOnHand: 2 });
    const state = replayEvents(events).get('t1')!;
    expect(state.redCardSeen).toBe(true);
    expect(state.sealed).toBe(true);
    expect(state.status).toBe('WAITING_NEW_SHOE');
    expect(state.seenCards.length).toBe(8);
  });
});
