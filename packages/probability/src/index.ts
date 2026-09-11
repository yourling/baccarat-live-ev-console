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

// ---------------------------------------------------------------------------
// 庄/闲/和主市场：从剩余库存精确计算概率（标准第三张牌规则）。
// ---------------------------------------------------------------------------

function rankPoint(rank: CardRank): number {
  if (rank === 'A') return 1;
  if (rank === '10' || rank === 'J' || rank === 'Q' || rank === 'K') return 0;
  return Number(rank);
}

function bankerThirdDraws(bankerTotal: number, playerThirdPoint: number | undefined): boolean {
  if (playerThirdPoint === undefined) return bankerTotal <= 5;
  if (bankerTotal <= 2) return true;
  if (bankerTotal === 3) return playerThirdPoint !== 8;
  if (bankerTotal === 4) return playerThirdPoint >= 2 && playerThirdPoint <= 7;
  if (bankerTotal === 5) return playerThirdPoint >= 4 && playerThirdPoint <= 7;
  if (bankerTotal === 6) return playerThirdPoint === 6 || playerThirdPoint === 7;
  return false;
}

export interface MainMarketProbabilities {
  banker: number;
  player: number;
  tie: number;
}

function addOutcome(
  result: MainMarketProbabilities,
  weight: number,
  playerFinal: number,
  bankerFinal: number,
): void {
  if (bankerFinal > playerFinal) result.banker += weight;
  else if (playerFinal > bankerFinal) result.player += weight;
  else result.tie += weight;
}

/**
 * 精确后验的庄/闲/和概率：枚举双方两张起手牌的无序组合（不放手权重），
 * 再按标准第三张牌规则边缘化第三张牌分布。天然 8/9 即停牌。
 * 剩余不足 4 张时无法成局，返回全 0（调用方按 fail-closed 处理，不渲染 EV）。
 */
export function mainMarketProbabilities(remaining: Counts): MainMarketProbabilities {
  assertCounts(remaining, 'remaining');
  const result: MainMarketProbabilities = { banker: 0, player: 0, tie: 0 };
  const total = totalCards(remaining);
  if (total < 4) return result;
  const initialTotal2 = (total * (total - 1)) / 2;

  // 双方起手牌的无序组合 {a, b}（a ≤ b，按牌面点数序不重要，直接按 rank 枚举）。
  const hands: Array<{ a: CardRank; b: CardRank }> = [];
  for (let i = 0; i < CARD_RANKS.length; i++) {
    for (let j = i; j < CARD_RANKS.length; j++) {
      hands.push({ a: CARD_RANKS[i]!, b: CARD_RANKS[j]! });
    }
  }

  const handWeight = (counts: Counts, a: CardRank, b: CardRank, denomTotal: number): number => {
    if (a === b) {
      const n = counts[a]!;
      return n >= 2 ? ((n * (n - 1)) / 2) / ((denomTotal * (denomTotal - 1)) / 2) : 0;
    }
    return (counts[a]! * counts[b]!) / ((denomTotal * (denomTotal - 1)) / 2);
  };

  for (const playerHand of hands) {
    const wPlayerHand = handWeight(remaining, playerHand.a, playerHand.b, total);
    if (wPlayerHand === 0) continue;
    const afterPlayer = { ...remaining };
    afterPlayer[playerHand.a]! -= 1;
    afterPlayer[playerHand.b]! -= 1;
    const totalAfterPlayer = total - 2;

    for (const bankerHand of hands) {
      const wBankerHand = handWeight(afterPlayer, bankerHand.a, bankerHand.b, totalAfterPlayer);
      if (wBankerHand === 0) continue;
      const weight = wPlayerHand * wBankerHand;
      const afterInitial = { ...afterPlayer };
      afterInitial[bankerHand.a]! -= 1;
      afterInitial[bankerHand.b]! -= 1;
      const totalAfterInitial = total - 4;

      const playerInitial = (rankPoint(playerHand.a) + rankPoint(playerHand.b)) % 10;
      const bankerInitial = (rankPoint(bankerHand.a) + rankPoint(bankerHand.b)) % 10;

      // 天然 8/9：双方停牌，直接比较。
      if (playerInitial >= 8 || bankerInitial >= 8) {
        addOutcome(result, weight, playerInitial, bankerInitial);
        continue;
      }

      const playerDraws = playerInitial <= 5;
      if (!playerDraws || totalAfterInitial === 0) {
        // 闲家停牌（或无牌可补）：庄家按 0-5 补牌规则处理。
        const bankerDraws = bankerThirdDraws(bankerInitial, undefined) && totalAfterInitial > 0;
        if (!bankerDraws) {
          addOutcome(result, weight, playerInitial, bankerInitial);
          continue;
        }
        for (const u of CARD_RANKS) {
          const n = afterInitial[u]!;
          if (n === 0) continue;
          const bankerFinal = (bankerInitial + rankPoint(u)) % 10;
          addOutcome(result, weight * (n / totalAfterInitial), playerInitial, bankerFinal);
        }
        continue;
      }

      // 闲家补第三张；庄家按标准规则依据闲家第三张牌面决定是否补牌。
      for (const t of CARD_RANKS) {
        const nt = afterInitial[t]!;
        if (nt === 0) continue;
        const wPlayerThird = weight * (nt / totalAfterInitial);
        const playerFinal = (playerInitial + rankPoint(t)) % 10;
        const afterPlayerThird = { ...afterInitial };
        afterPlayerThird[t]! -= 1;
        const totalAfterPlayerThird = totalAfterInitial - 1;

        if (!bankerThirdDraws(bankerInitial, rankPoint(t)) || totalAfterPlayerThird === 0) {
          addOutcome(result, wPlayerThird, playerFinal, bankerInitial);
          continue;
        }
        for (const u of CARD_RANKS) {
          const n = afterPlayerThird[u]!;
          if (n === 0) continue;
          const bankerFinal = (bankerInitial + rankPoint(u)) % 10;
          addOutcome(result, wPlayerThird * (n / totalAfterPlayerThird), playerFinal, bankerFinal);
        }
      }
    }
  }

  const sum = result.banker + result.player + result.tie;
  if (sum > 0) {
    result.banker /= sum;
    result.player /= sum;
    result.tie /= sum;
  }
  return result;
}

export interface MainMarketEvaluation {
  pBanker: number;
  pPlayer: number;
  pTie: number;
  evBanker: number;
  evPlayer: number;
}

/**
 * 庄/闲主市场 EV（和局 push：庄只在闲赢时输，反之亦然）。
 * 赔率来自受控下注条款（如 STANDARD_COMMISSION_BACCARAT_TERMS）。
 */
export function evaluateMainMarketsFromRemaining(
  bankerOdds: OddsConfig,
  playerOdds: OddsConfig,
  remainingCounts: Counts,
): MainMarketEvaluation {
  assertCounts(remainingCounts, 'remainingCounts');
  const p = mainMarketProbabilities(remainingCounts);
  return {
    pBanker: p.banker,
    pPlayer: p.player,
    pTie: p.tie,
    evBanker: bankerOdds.netWin * p.banker - bankerOdds.loss * p.player,
    evPlayer: playerOdds.netWin * p.player - playerOdds.loss * p.banker,
  };
}

export function evaluateMainMarketsFromObserved(
  bankerOdds: OddsConfig,
  playerOdds: OddsConfig,
  numberOfDecks: number,
  observedCards: Card[],
): MainMarketEvaluation {
  if (!Array.isArray(observedCards)) throw new TypeError('observedCards must be an array');
  for (const card of observedCards) assertValidCard(card, 'observedCards');
  const initial = initialDeckCounts(numberOfDecks);
  const remaining = subtractCounts(initial as unknown as Counts, cardCountsFromList(observedCards));
  return evaluateMainMarketsFromRemaining(bankerOdds, playerOdds, remaining);
}
