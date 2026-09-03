import {
  assertValidBurnModel,
  assertValidCard,
  assertValidTableProfile,
  CARD_RANKS,
  type BettingMarket,
  type BurnModel,
  type Card,
  type CardRank,
  type OddsConfig,
  initialDeckCounts,
  type TableProfile,
} from '@baccarat/contracts';

export type Counts = Record<CardRank, number>;

export function emptyCounts(): Counts {
  return {
    'A':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0,'8':0,'9':0,'10':0,'J':0,'Q':0,'K':0
  };
}

export function totalCards(counts: Counts): number {
  return CARD_RANKS.reduce((sum, r) => sum + counts[r], 0);
}

export function combinations2(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`combinations2 expects a non-negative integer, got ${n}`);
  return n < 2 ? 0 : (n * (n - 1)) / 2;
}

function assertCounts(counts: Counts, field = 'counts'): void {
  if (!counts || typeof counts !== 'object') throw new TypeError(`${field} must be an object`);
  for (const r of CARD_RANKS) {
    if (!Number.isInteger(counts[r]) || counts[r] < 0) {
      throw new RangeError(`${field}.${r} must be a non-negative integer`);
    }
  }
}

export function exactPairProbability(counts: Counts): number {
  const total = totalCards(counts);
  if (total < 2) return 0;
  const pairs = CARD_RANKS.reduce((sum, r) => sum + combinations2(counts[r]), 0);
  return pairs / combinations2(total);
}

export function cardCountsFromList(cards: Card[]): Counts {
  const counts = emptyCounts();
  for (const card of cards) counts[card.rank] += 1;
  return counts;
}

export function subtractCounts(base: Counts, removed: Counts): Counts {
  const result = emptyCounts();
  for (const r of CARD_RANKS) result[r] = Math.max(0, base[r] - removed[r]);
  return result;
}

export function computeModelComponents(
  initialCounts: Counts,
  burnModel: BurnModel,
  observedCards: Card[],
): { base: Counts; unknownBurnCount: number; knownBurnCards: Card[] } {
  assertCounts(initialCounts, 'initialCounts');
  assertValidBurnModel(burnModel, 'burnModel');
  if (!Array.isArray(observedCards)) throw new TypeError('observedCards must be an array');
  for (const card of observedCards) assertValidCard(card, 'observedCards');
  const observed = cardCountsFromList(observedCards);
  const knownBurnCards = burnModel.knownCards ?? [];
  let unknownBurnCount = 0;
  switch (burnModel.kind) {
    case 'unknown':
      unknownBurnCount = 0;
      break;
    case 'countKnown':
      unknownBurnCount = burnModel.count ?? 0;
      break;
    case 'partialKnown':
      unknownBurnCount = Math.max(0, (burnModel.count ?? 0) - knownBurnCards.length);
      break;
    case 'fullyKnown':
      unknownBurnCount = 0;
      break;
  }
  const base0 = subtractCounts(initialCounts, observed);
  const base = subtractCounts(base0, cardCountsFromList(knownBurnCards));
  if (unknownBurnCount > totalCards(base)) {
    throw new RangeError(`unknown burn count ${unknownBurnCount} exceeds available cards ${totalCards(base)}`);
  }
  return { base, unknownBurnCount, knownBurnCards };
}

/**
 * 精确后验边际化的普通对子概率。
 * 对未知牌面的烧牌，使用超几何期望公式，而不是机械扣除“估计烧牌数”。
 */
export function unknownBurnCount(burnModel: BurnModel): number {
  assertValidBurnModel(burnModel, 'burnModel');
  switch (burnModel.kind) {
    case 'unknown':
      return 0;
    case 'countKnown':
      return burnModel.count ?? 0;
    case 'partialKnown':
      return Math.max(0, (burnModel.count ?? 0) - (burnModel.knownCards?.length ?? 0));
    case 'fullyKnown':
      return 0;
  }
}

export function pairProbabilityOnBase(base: Counts, unknownBurn: number): number {
  assertCounts(base, 'base');
  if (!Number.isInteger(unknownBurn) || unknownBurn < 0) {
    throw new RangeError(`unknownBurn must be a non-negative integer, got ${unknownBurn}`);
  }
  const u = unknownBurn;
  const baseTotal = totalCards(base);
  if (u === 0) return exactPairProbability(base);
  const remainingTotal = baseTotal - u;
  if (remainingTotal < 2) return 0;
  const s = baseTotal;
  let expectedPairs = 0;
  for (const r of CARD_RANKS) {
    const a = base[r];
    expectedPairs += expectedComplementPairs(a, s, u);
  }
  return expectedPairs / combinations2(remainingTotal);
}

export function pairProbabilityWorstOnBase(base: Counts, unknownBurn: number): number {
  assertCounts(base, 'base');
  if (!Number.isInteger(unknownBurn) || unknownBurn < 0) {
    throw new RangeError(`unknownBurn must be a non-negative integer, got ${unknownBurn}`);
  }
  const counts = { ...base } as Counts;
  for (let i = 0; i < unknownBurn; i++) {
    let worst: CardRank = 'A';
    for (const r of CARD_RANKS) if (counts[r] > counts[worst]) worst = r;
    counts[worst] = Math.max(0, counts[worst] - 1);
  }
  return exactPairProbability(counts);
}

export function pairProbabilityMean(
  initialCounts: Counts,
  burnModel: BurnModel,
  observedCards: Card[] = [],
): number {
  const { base, unknownBurnCount: u } = computeModelComponents(initialCounts, burnModel, observedCards);
  return pairProbabilityOnBase(base, u);
}

function expectedComplementPairs(a: number, s: number, u: number): number {
  if (a < 2) return 0;
  if (u === 0) return combinations2(a);
  const p = a / s;
  const ex = u * p;
  const variance = u * p * (1 - p) * ((s - u) / (s - 1));
  const ex2 = variance + ex * ex;
  return combinations2(a) - (a - 0.5) * ex + 0.5 * ex2;
}

/**
 * 保守下界：在已知牌面固定的前提下，把未知烧牌按“最不利于对子出现”的方式从最大牌面集中移除。
 * 这是确定性最坏情况策略，策略名版本化，方便审计。
 */
export function pairProbabilityWorstCase(
  initialCounts: Counts,
  burnModel: BurnModel,
  observedCards: Card[] = [],
): number {
  const { base, unknownBurnCount: u } = computeModelComponents(initialCounts, burnModel, observedCards);
  return pairProbabilityWorstOnBase(base, u);
}

export function evForPair(odds: OddsConfig, p: number): number {
  return odds.netWin * p - odds.loss * (1 - p);
}

export function evaluatePairMarket(
  profile: TableProfile,
  market: BettingMarket,
  observedCards: Card[],
): { pMean: number; pLower: number; evMean: number; evLower: number } {
  assertValidTableProfile(profile);
  if (market !== 'bankerPair' && market !== 'playerPair') throw new RangeError(`unknown market: ${market}`);
  if (!Array.isArray(observedCards)) throw new TypeError('observedCards must be an array');
  for (const card of observedCards) assertValidCard(card, 'observedCards');
  const initial = initialDeckCounts(profile.numberOfDecks);
  const pMean = pairProbabilityMean(initial, profile.burnModel, observedCards);
  const pLower = pairProbabilityWorstCase(initial, profile.burnModel, observedCards);
  const odds = profile.odds[market];
  return {
    pMean,
    pLower,
    evMean: evForPair(odds, pMean),
    evLower: evForPair(odds, pLower),
  };
}

export function evaluatePairMarketFromRemaining(
  profile: TableProfile,
  market: BettingMarket,
  remainingCounts: Counts,
): { pMean: number; pLower: number; evMean: number; evLower: number } {
  assertValidTableProfile(profile);
  if (market !== 'bankerPair' && market !== 'playerPair') throw new RangeError(`unknown market: ${market}`);
  assertCounts(remainingCounts, 'remainingCounts');
  const unknownBurn = unknownBurnCount(profile.burnModel);
  const pMean = pairProbabilityOnBase(remainingCounts, unknownBurn);
  const pLower = pairProbabilityWorstOnBase(remainingCounts, unknownBurn);
  const odds = profile.odds[market];
  return {
    pMean,
    pLower,
    evMean: evForPair(odds, pMean),
    evLower: evForPair(odds, pLower),
  };
}

export function defaultInitialCounts(decks: number): Counts {
  return initialDeckCounts(decks) as unknown as Counts;
}
