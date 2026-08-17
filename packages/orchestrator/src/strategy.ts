import { randomInt } from 'node:crypto';
import type { BettingMarket, BetStrategy } from '@baccarat/contracts';
import { BETTING_MARKETS } from '@baccarat/contracts';

export interface StrategyContext {
  market: BettingMarket;
  eventId: string;
  alternateNext?: BettingMarket | null;
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
      const choice = BETTING_MARKETS[randomInt(0, BETTING_MARKETS.length)];
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
