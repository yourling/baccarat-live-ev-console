import type { TableProfile, RiskLimits } from './index.js';

export const defaultRiskLimits: RiskLimits = {
  defaultExposureCap: 0,
  perTableLossLimit: 0,
  perShoeLossLimit: 0,
  perDayLossLimit: 0,
  // 一手最多同时承载庄对与闲对两种独立市场。
  maxConcurrentExecutions: 2,
  insufficientBehavior: 'skip',
  betSizing: { mode: 'fixed' },
};

/**
 * 默认桌台配置。
 *
 * `burnModel: { kind: 'unknown' }` 是**无信息先验**，不是"假设没烧牌"的错误：
 * `pairProbabilityOnBase` 会对未知烧牌做精确后验边际化，所以 `pMean` 与烧牌数无关
 * （实测 u=0/1/3/7/13/26/52 的 pMean 全部 = 7.4698795181%）。
 * 它只让保守下界 `pLower` 偏乐观（u=13 时 pLower 从 7.4699% 降到 7.4627%）。
 *
 * 真人厅洗完必烧 1-13 张，但三个采集 runtime 目前都**不发送** `burnModelUpdated`，
 * 所以只能停留在"未知"。修法是在采集侧补烧牌张数，**不是**把这里改成
 * `countKnown(13)` —— 实测那样会让策略基本停摆（开火 1.27 手/靴 → 0.001 手/靴）。
 * 详见 review/fix-lead-decisions.md 与 review/scripts/lead/burn-*.ts。
 */
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
  betTiers: [],
  autoBetArmedByDefault: false,
});
