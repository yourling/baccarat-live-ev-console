import { CARD_RANKS, type BettingMarket, type Card, type CardRank, type TableProfile } from '@baccarat/contracts';
import {
  evaluateMainMarketsFromObserved,
  evaluateMainMarketsFromRemaining,
  evaluatePairMarket,
  evaluatePairMarketFromRemaining,
  type MainMarketEvaluation,
} from '@baccarat/probability';

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

export interface MainMarketTerms {
  readonly banker: { readonly netWin: number; readonly loss: number };
  readonly player: { readonly netWin: number; readonly loss: number };
}

/**
 * 庄/闲主市场 EV（受控下注条款，和局 push）。精确枚举较重（每次约几十毫秒），
 * 以剩余库存签名为键做小缓存；UI 每秒轮询同一桌时命中缓存。
 */
const mainMarketCache = new Map<string, MainMarketEvaluation>();
const MAIN_MARKET_CACHE_MAX = 64;

function countsSignature(remainingCounts: Record<CardRank, number>): string {
  return CARD_RANKS.map(rank => remainingCounts[rank] ?? 0).join(',');
}

export function evaluateProjectionMainMarkets(
  profile: TableProfile,
  terms: MainMarketTerms,
  seenCards: readonly Card[],
  remainingCounts?: Record<CardRank, number>,
): MainMarketEvaluation {
  if (remainingCounts) {
    const remainingTotal = Object.values(remainingCounts).reduce((sum, count) => sum + count, 0);
    if (remainingTotal > 0) {
      const key = `${terms.banker.netWin}|${terms.player.netWin}|${countsSignature(remainingCounts)}`;
      const cached = mainMarketCache.get(key);
      if (cached !== undefined) return cached;
      const evaluation = evaluateMainMarketsFromRemaining(terms.banker, terms.player, remainingCounts);
      if (mainMarketCache.size >= MAIN_MARKET_CACHE_MAX) {
        const oldest = mainMarketCache.keys().next().value;
        if (oldest !== undefined) mainMarketCache.delete(oldest);
      }
      mainMarketCache.set(key, evaluation);
      return evaluation;
    }
  }
  return evaluateMainMarketsFromObserved(terms.banker, terms.player, profile.numberOfDecks, [...seenCards]);
}
