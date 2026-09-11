import { describe, expect, it } from 'vitest';
import {
  cardCountsFromList,
  combinations2,
  defaultInitialCounts,
  evaluateMainMarketsFromObserved,
  evaluateMainMarketsFromRemaining,
  evForPair,
  exactPairProbability,
  mainMarketProbabilities,
  pairProbabilityMean,
  pairProbabilityWorstCase,
  subtractCounts,
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

describe('main market probabilities (banker/player/tie)', () => {
  const fullCounts = (overrides: Partial<Record<string, number>> = {}) => ({
    'A':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0,'8':0,'9':0,'10':0,'J':0,'Q':0,'K':0,
    ...overrides,
  }) as any;

  it('8-deck fresh shoe matches known baccarat probabilities', () => {
    const p = mainMarketProbabilities(defaultInitialCounts(8) as any);
    // 已知 8 副牌标准规则：庄 45.86% / 闲 44.62% / 和 9.52%（push 口径）。
    expect(p.banker).toBeCloseTo(0.4586, 3);
    expect(p.player).toBeCloseTo(0.4462, 3);
    expect(p.tie).toBeCloseTo(0.0952, 3);
  });

  it('tiny shoe {2:2, 3:2} has exact closed-form outcome', () => {
    // 闲 {2,2}=4 庄 {3,3}=6（庄胜 1/6）；闲 {2,3}=5 庄 {2,3}=5（和 2/3）；
    // 闲 {3,3}=6 庄 {2,2}=4（闲胜 1/6）。无第三张（牌已尽）。
    const p = mainMarketProbabilities(fullCounts({ '2': 2, '3': 2 }));
    expect(p.banker).toBeCloseTo(1 / 6, 12);
    expect(p.player).toBeCloseTo(1 / 6, 12);
    expect(p.tie).toBeCloseTo(2 / 3, 12);
  });

  it('outcomes always sum to 1 when a hand is possible', () => {
    const counts = fullCounts({ 'A': 5, '2': 3, '3': 8, '4': 1, '9': 12, 'K': 7 });
    const p = mainMarketProbabilities(counts);
    expect(p.banker + p.player + p.tie).toBeCloseTo(1, 12);
  });

  it('fewer than 4 remaining cards fails closed with zero probabilities', () => {
    const p = mainMarketProbabilities(fullCounts({ 'A': 3 }));
    expect(p.banker).toBe(0);
    expect(p.player).toBe(0);
    expect(p.tie).toBe(0);
  });

  it('push-on-tie EV semantics for banker and player', () => {
    const counts = fullCounts({ 'A': 5, '2': 3, '3': 8, '9': 12, 'K': 7 });
    const ev = evaluateMainMarketsFromRemaining({ netWin: 0.95, loss: 1 }, { netWin: 1, loss: 1 }, counts);
    expect(ev.evBanker).toBeCloseTo(0.95 * ev.pBanker - ev.pPlayer, 12);
    expect(ev.evPlayer).toBeCloseTo(ev.pPlayer - ev.pBanker, 12);
  });

  it('observed-cards variant subtracts seen cards from the initial shoe', () => {
    const ev = evaluateMainMarketsFromObserved(
      { netWin: 0.95, loss: 1 },
      { netWin: 1, loss: 1 },
      8,
      [{ rank: 'A', suit: 'S' }, { rank: 'A', suit: 'H' }] as any,
    );
    const expected = evaluateMainMarketsFromRemaining(
      { netWin: 0.95, loss: 1 },
      { netWin: 1, loss: 1 },
      subtractCounts(defaultInitialCounts(8) as any, cardCountsFromList([{ rank: 'A', suit: 'S' }, { rank: 'A', suit: 'H' }] as any)),
    );
    expect(ev.pBanker).toBeCloseTo(expected.pBanker, 12);
    expect(ev.pTie).toBeCloseTo(expected.pTie, 12);
  });
});
