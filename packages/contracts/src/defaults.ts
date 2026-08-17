import type { TableProfile, RiskLimits } from './index.js';

export const defaultRiskLimits: RiskLimits = {
  defaultExposureCap: 0,
  perTableLossLimit: 0,
  perShoeLossLimit: 0,
  perDayLossLimit: 0,
  maxConcurrentExecutions: 1,
  insufficientBehavior: 'skip',
};

export const defaultProfile = (tableId: string): TableProfile => ({
  tableId,
  numberOfDecks: 8,
  pairRule: { kind: 'standard' },
  odds: {
    bankerPair: { netWin: 11, loss: 1 },
    playerPair: { netWin: 11, loss: 1 },
  },
  burnModel: { kind: 'unknown' },
  minEV: 0,
  limits: { minBet: 0, maxBet: 1000 },
  autoConfirmNewShoe: false,
  betStrategy: { type: 'both' },
  autoBetArmedByDefault: false,
});
