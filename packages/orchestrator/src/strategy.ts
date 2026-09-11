import { randomInt } from 'node:crypto';
import type { BettingMarket, BetStrategy } from '@baccarat/contracts';
import { BETTING_MARKETS, sha256 } from '@baccarat/contracts';

export interface StrategyContext {
  market: BettingMarket;
  eventId: string;
  alternateNext?: BettingMarket | null;
  handKey?: string;
}

export interface StrategyResult {
  selected: boolean;
  choice?: BettingMarket[];
  auditNote?: string;
  alternateNext?: BettingMarket | null;
}

export function selectMarkets(strategy: BetStrategy, ctx: StrategyContext): StrategyResult {
  switch (strategy.type) {
    case 'both':
      return { selected: true, choice: [...BETTING_MARKETS], auditNote: 'both' };
    case 'fixed':
      if (ctx.market !== strategy.market) return { selected: false, auditNote: 'fixed-wait-other-market' };
      return { selected: true, choice: [strategy.market], auditNote: `fixed:${strategy.market}` };
    case 'random': {
      const choice = pickRandomMarket(ctx.handKey);
      const selected = ctx.market === choice;
      return { selected, choice: selected ? [choice] : [], auditNote: `random:${choice}` };
    }
    case 'alternate': {
      const next = ctx.alternateNext ?? strategy.start;
      if (ctx.market !== next) return { selected: false, auditNote: `alternate:not-now:${next}` };
      return { selected: true, choice: [ctx.market], auditNote: `alternate:${next}`, alternateNext: next };
    }
  }
}

/**
 * random 策略同一手内必须稳定：同一局多次评估（无 closesAt + 有 closesAt）
 * 若每次重 roll，决策审计会出现自相矛盾的 strategyChoice。
 * 有 handKey 时用哈希确定选择，保证同手一致、不同手分散；
 * 不传 handKey 时保持旧的真随机行为。
 */
function pickRandomMarket(handKey?: string): BettingMarket {
  if (handKey === undefined || handKey.length === 0) {
    return BETTING_MARKETS[randomInt(0, BETTING_MARKETS.length)];
  }
  const digest = sha256(`random-strategy:${handKey}`);
  return BETTING_MARKETS[Number.parseInt(digest.slice(0, 8), 16) % BETTING_MARKETS.length];
}

/** both 策略的评估摘要（取自 probability 层的下置信界 EV）。 */
export interface PairEvaluationSummary {
  evLower: number;
}

/**
 * both 策略一手只押一个市场：EV 下界更低（更看好）的一侧。
 * 同手两次评估（无 closesAt + 有 closesAt）必须给出同一偏好，
 * 否则决策审计会出现自相矛盾 —— 因此这里是纯函数，输入只依赖评估值。
 */
export function preferredMarketForBoth(
  banker: PairEvaluationSummary,
  player: PairEvaluationSummary,
): 'bankerPair' | 'playerPair' {
  return player.evLower > banker.evLower ? 'playerPair' : 'bankerPair';
}

/**
 * 注额选择：capitalPercent 模式按资金比例（可选上限封顶）；
 * EV 阶梯模式取最后一个 minEV ≤ 当前 EV 的档位金额（阶梯必须按 minEV 升序）。
 */
export function selectBetAmount(
  profile: { betTiers?: Array<{ minEV: number; amount: number }> },
  ev: number,
  defaultBetAmount: number,
  sizing?: { mode: string; bankroll?: number; percent?: number; maxPerBet?: number },
): number {
  if (sizing?.mode === 'capitalPercent') {
    const amount = (sizing.bankroll ?? 0) * (sizing.percent ?? 0);
    return sizing.maxPerBet === undefined ? amount : Math.min(amount, sizing.maxPerBet);
  }
  let amount = defaultBetAmount;
  for (const tier of profile.betTiers ?? []) {
    if (ev >= tier.minEV) amount = tier.amount;
    else break;
  }
  return amount;
}
