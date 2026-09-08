import type { BettingMarket, Card, CardRank, TableProfile } from '@baccarat/contracts';
import { evaluatePairMarket, evaluatePairMarketFromRemaining } from '@baccarat/probability';

export function evaluateProjectionPairMarket(
  profile: TableProfile,
  market: BettingMarket,
  seenCards: readonly Card[],
  remainingCounts?: Record<CardRank, number>,
) {
  if (remainingCounts) {
    const remainingTotal = Object.values(remainingCounts).reduce((sum, count) => sum + count, 0);
    if (remainingTotal > 0) {
      return evaluatePairMarketFromRemaining(profile, market, remainingCounts);
    }
  }
  return evaluatePairMarket(profile, market, [...seenCards]);
}
