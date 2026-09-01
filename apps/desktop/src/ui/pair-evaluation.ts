import type { BettingMarket, Card, CardRank, TableProfile } from '@baccarat/contracts';
import { evaluatePairMarket, evaluatePairMarketFromRemaining } from '@baccarat/probability';

export function evaluateProjectionPairMarket(
  profile: TableProfile,
  market: BettingMarket,
  seenCards: readonly Card[],
  remainingCounts?: Record<CardRank, number>,
) {
  if (seenCards.length > 0) {
    return evaluatePairMarket(profile, market, [...seenCards]);
  }
  if (remainingCounts) {
    return evaluatePairMarketFromRemaining(profile, market, remainingCounts);
  }
  return evaluatePairMarket(profile, market, []);
}
