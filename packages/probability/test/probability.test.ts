import { describe, expect, it } from 'vitest';
import {
  cardCountsFromList,
  combinations2,
  defaultInitialCounts,
  evForPair,
  exactPairProbability,
  pairProbabilityMean,
  pairProbabilityWorstCase,
} from '../src/index.js';
import { CARD_RANKS, initialDeckCounts } from '@baccarat/contracts';

describe('probability exact math', () => {
  it('8-deck new shoe ordinary pair probability is approx 7.4699%', () => {
    const counts = defaultInitialCounts(8);
    const p = exactPairProbability(counts);
    expect(p).toBeCloseTo(0.074698, 4);
    expect(p * 100).toBeCloseTo(7.4699, 4);
  });

  it('banker/player symmetry shares same math', () => {
    const counts = defaultInitialCounts(8);
    const p = exactPairProbability(counts);
    const ev = evForPair({ netWin: 11, loss: 1 }, p);
    expect(ev).toBeCloseTo(11 * p - 1 * (1 - p), 12);
  });

  it('known single-card burn has exact conditional probability', () => {
    const counts = { 'A': 2, 'K': 2, '2':0,'3':0,'4':0,'5':0,'6':0,'7':0,'8':0,'9':0,'10':0,'J':0,'Q':0 } as const;
    const p = pairProbabilityMean(
      counts as any,
      { kind: 'fullyKnown', count: 1, knownCards: [{ rank: 'A' }] },
      [],
    );
    // after removing one A: remaining counts A=1,K=2 -> p = C(2,2)/C(3,2)=1/3
    expect(p).toBeCloseTo(1 / 3, 12);
  });

  it('unknown count burn from fresh shoe keeps same predictive pair probability', () => {
    const counts = defaultInitialCounts(8);
    const noBurn = pairProbabilityMean(counts, { kind: 'unknown' }, []);
    const countUnknown = pairProbabilityMean(counts, { kind: 'countKnown', count: 10 }, []);
    expect(noBurn).toBeCloseTo(countUnknown, 12);
  });

  it('brute-force validates hypergeometric marginalization for small deck', () => {
    const initial = { 'A': 2, 'K': 2, '2':0,'3':0,'4':0,'5':0,'6':0,'7':0,'8':0,'9':0,'10':0,'J':0,'Q':0 } as any;
    // Enumerate all 1-card burn subsets, then compute pair probability after burn.
    let sum = 0, n = 0;
    const ranks = ['A','K'];
    for (const burnedRank of ranks) {
      const remaining = { ...initial };
      remaining[burnedRank] -= 1;
      sum += exactPairProbability(remaining);
      n++;
    }
    const brute = sum / n;
    const formula = pairProbabilityMean(initial, { kind: 'countKnown', count: 1 }, []);
    expect(formula).toBeCloseTo(brute, 12);
  });

  it('worst-case lower bound is no greater than mean', () => {
    const counts = defaultInitialCounts(8);
    const mean = pairProbabilityMean(counts, { kind: 'countKnown', count: 8 }, []);
    const worst = pairProbabilityWorstCase(counts, { kind: 'countKnown', count: 8 }, []);
    expect(worst).toBeLessThanOrEqual(mean);
    expect(worst).toBeGreaterThan(0);
  });

  it('10/J/Q/K are distinct ranks for pair count', () => {
    const counts = { '10': 2, 'J': 2, 'Q': 2, 'K': 2, 'A':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0,'8':0,'9':0 } as any;
    // Each rank pair only within rank: 4 pairs out of C(8,2)=28.
    expect(combinations2(2)).toBe(1);
    expect(exactPairProbability(counts)).toBeCloseTo(4 / 28, 12);
  });
});
