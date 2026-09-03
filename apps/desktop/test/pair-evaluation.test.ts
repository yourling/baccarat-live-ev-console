import { defaultProfile, type Card } from '@baccarat/contracts';
import { evaluatePairMarket } from '@baccarat/probability';
import { describe, expect, it } from 'vitest';
import { evaluateProjectionPairMarket } from '../src/ui/pair-evaluation';

describe('monitor pair evaluation', () => {
  it('uses the same evaluatePairMarket(seenCards) path as table-actor decisions', () => {
    const profile = {
      ...defaultProfile('speedbca14gesbc1'),
      burnModel: { kind: 'countKnown' as const, count: 2, knownCards: [{ rank: 'A' as const }] },
    };
    const seenCards: Card[] = [
      { rank: 'K', suit: 'S' },
      { rank: '5', suit: 'H' },
    ];

    expect(evaluateProjectionPairMarket(profile, 'bankerPair', seenCards)).toEqual(
      evaluatePairMarket(profile, 'bankerPair', seenCards),
    );
    expect(evaluateProjectionPairMarket(profile, 'playerPair', seenCards)).toEqual(
      evaluatePairMarket(profile, 'playerPair', seenCards),
    );
  });

  it('does not re-apply unknown burn on remainingCounts', () => {
    const profile = {
      ...defaultProfile('speedbca14gesbc1'),
      burnModel: { kind: 'countKnown' as const, count: 2, knownCards: [{ rank: 'A' as const }] },
    };
    const seenCards: Card[] = [{ rank: 'K', suit: 'S' }];
    const fromSeen = evaluatePairMarket(profile, 'bankerPair', seenCards);
    const remainingCounts = {
      A: 31, '2': 32, '3': 32, '4': 32, '5': 32, '6': 32, '7': 32,
      '8': 32, '9': 32, '10': 32, J: 32, Q: 32, K: 31,
    };
    const remainingTotal = Object.values(remainingCounts).reduce((sum, count) => sum + count, 0);
    const unknownBurn = Math.max(0, 2 - 1);
    const remainingMean = remainingTotal < 2 ? 0 : (remainingCounts.K * (remainingCounts.K - 1) / 2
      + remainingCounts.A * (remainingCounts.A - 1) / 2
      + (remainingTotal - remainingCounts.K - remainingCounts.A) * 0) / (remainingTotal * (remainingTotal - 1) / 2);

    expect(fromSeen.pMean).not.toBeCloseTo(remainingMean, 6);
    expect(evaluateProjectionPairMarket(profile, 'bankerPair', seenCards).pMean).toBe(fromSeen.pMean);
    expect(unknownBurn).toBe(1);
  });

  it('recovers pair EV from remainingCounts when the actor snapshot strips seenCards', () => {
    const profile = defaultProfile('speedbca14gesbc1');
    const seenCards: Card[] = [
      { rank: 'K', suit: 'S' },
      { rank: 'K', suit: 'H' },
      { rank: 'A', suit: 'D' },
    ];
    const remainingCounts = {
      A: 31, '2': 32, '3': 32, '4': 32, '5': 32, '6': 32, '7': 32,
      '8': 32, '9': 32, '10': 32, J: 32, Q: 32, K: 30,
    };
    const fromSeen = evaluatePairMarket(profile, 'bankerPair', seenCards);
    const fromEmpty = evaluatePairMarket(profile, 'bankerPair', []);

    expect(evaluateProjectionPairMarket(profile, 'bankerPair', [], remainingCounts).pMean).toBe(fromSeen.pMean);
    expect(evaluateProjectionPairMarket(profile, 'bankerPair', [], remainingCounts).evMean).toBe(fromSeen.evMean);
    expect(fromSeen.pMean).not.toBe(fromEmpty.pMean);
  });
});
