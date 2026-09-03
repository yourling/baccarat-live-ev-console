import { describe, expect, it } from 'vitest';
import { selectMarkets } from '../src/strategy.js';

describe('random strategy determinism', () => {
  it('returns the same choice for repeated evaluations of the same hand', () => {
    const strategy = { type: 'random' } as const;
    const first = selectMarkets(strategy, { market: 'bankerPair', eventId: 'e1', handKey: 's1:h1' });
    const second = selectMarkets(strategy, { market: 'bankerPair', eventId: 'e2', handKey: 's1:h1' });
    const third = selectMarkets(strategy, { market: 'playerPair', eventId: 'e3', handKey: 's1:h1' });
    expect(second).toEqual(first);
    // Same handKey must imply the same underlying choice for both markets.
    expect(first.auditNote).toBe(third.auditNote);
  });

  it('keeps working without a hand key', () => {
    const strategy = { type: 'random' } as const;
    const result = selectMarkets(strategy, { market: 'bankerPair', eventId: 'e1' });
    expect(['bankerPair', 'playerPair']).toContain(result.choice?.[0] ?? result.auditNote?.split(':')[1]);
  });
});
