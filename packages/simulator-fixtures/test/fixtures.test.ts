import { describe, expect, it } from 'vitest';
import { pairMarketStream } from '../src/index.js';
import { replayEvents } from '@baccarat/ledger-state';
import { defaultProfile, type Card, type HandSettledEvent, type NormalizedEvent } from '@baccarat/contracts';

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

  it('handSettled outcomes always agree with the dealt cards (no pseudo ground truth)', () => {
    const profile = { ...defaultProfile('t1'), autoConfirmNewShoe: true };
    const events = pairMarketStream('t1', profile, { shoeCount: 2, handsPerShoe: 2 });
    const settlements = events.filter((e): e is NormalizedEvent & HandSettledEvent => e.type === 'handSettled');
    expect(settlements.length).toBe(4);
    const hasPair = (cards: Card[]): boolean => cards.length >= 2 && cards[0].rank === cards[1].rank;
    for (const e of settlements) {
      const outcomes = e.outcomes!;
      // 修复前:8/8 结算与牌面矛盾(如 [10,J] 无对子却 claim bankerPair=true)
      expect(outcomes.playerPair).toBe(hasPair(e.playerCards));
      expect(outcomes.bankerPair).toBe(hasPair(e.bankerCards));
    }
    // 抽样断言已知牌型:[K,Q]v[A,K] 双无对;[A,A]v[10,J] 仅闲对
    expect(settlements[0]?.outcomes).toEqual({ bankerPair: false, playerPair: false });
    expect(settlements[1]?.outcomes).toEqual({ bankerPair: false, playerPair: true });
  });
});
