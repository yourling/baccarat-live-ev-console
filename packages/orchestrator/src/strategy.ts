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
