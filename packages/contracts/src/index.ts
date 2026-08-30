export type CardRank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

export const CARD_RANKS: CardRank[] = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

export interface Card {
  rank: CardRank;
  suit?: string;
  raw?: string;
}

export type BettingMarket = 'bankerPair' | 'playerPair';
export const BETTING_MARKETS: BettingMarket[] = ['bankerPair', 'playerPair'];

/**
 * Execution markets are broader than EV decision markets. Probability and
 * strategy code must continue to use BettingMarket.
 */
export type ExecutionMarket = BettingMarket | 'banker' | 'player';
export type ExecutionSource = 'strategy' | 'one-shot' | 'manual' | 'keepalive';

export interface OddsConfig {
  netWin: number;
  loss: number;
}

export interface TableLimits {
  minBet: number;
  maxBet: number;
}

export interface PairRuleConfig {
  kind: 'standard';
}

export type BurnModelKind = 'unknown' | 'countKnown' | 'partialKnown' | 'fullyKnown';

export interface BurnModel {
  kind: BurnModelKind;
  count?: number | null;
  knownCards?: Card[];
  evidenceRef?: string;
}

export interface BetTier {
  /** 使用该金额所需的最低 EV，按内部保守判断值匹配。 */
  minEV: number;
  /** 命中该阶梯时的每手下注金额。 */
  amount: number;
}

export interface TableProfile {
  tableId: string;
  numberOfDecks: number;
  pairRule: PairRuleConfig;
  odds: Record<BettingMarket, OddsConfig>;
  burnModel: BurnModel;
  minEV: number;
  limits: TableLimits;
  autoConfirmNewShoe: boolean;
  betStrategy: BetStrategy;
  /** 为空时回退到 Actor 的默认每手金额。 */
  betTiers?: BetTier[];
  /** 预留给后续桌台窗口或链接绑定，不参与概率和下注算法。 */
  monitorUrl?: string;
  autoBetArmedByDefault?: boolean;
}

export type BetStrategy =
  | { type: 'both'; market?: 'bankerPair' | 'playerPair' }
  | { type: 'random' }
  | { type: 'fixed'; market: BettingMarket }
  | { type: 'alternate'; start: BettingMarket };

export type TableStatus =
  | 'WAITING_NEW_SHOE'
  | 'WAITING_CONFIRMATION'
  | 'TRACKING'
  | 'BETTING_WINDOW'
  | 'PENDING_SETTLEMENT'
  | 'RED_CARD_WIND_DOWN'
  | 'RESYNCING'
  | 'INVALIDATED';

/** Whether the logical shoe begins at a verified physical shoe or an unknown mid-shoe monitor attach. */
export type ShoeBaseline = 'physical-shoe' | 'unknown-monitor-session';

export type AutoBetStatus = 'DISARMED' | 'ARMED' | 'NEEDS_MANUAL_RECOVERY';
export type ConnectionStatus = 'CONNECTED' | 'RESYNCING' | 'DISCONNECTED' | 'EXPIRED';

export interface ShoeStateProjection {
  shoeId: string;
  shoeBaseline: ShoeBaseline;
  tableId: string;
  profileSnapshot: TableProfile;
  modelRevision: string;
  status: TableStatus;
  remainingCounts: Record<CardRank, number>;
  remainingTotal: number;
  seenCards: Card[];
  /** Idempotency keys `${handId}:${position}:${rank}${suit}` so replayed cards do not consume inventory twice. */
  cardInventoryKeys: string[];
  currentHandId: string | null;
  /** Hand IDs already counted in this shoe, retained to ignore duplicate and out-of-order events. */
  observedHandIds: string[];
  /** True once the current hand has observed at least one card. */
  currentHandHasCards: boolean;
  bettingWindowClosesAt: string | null;
  handNumber: number;
  redCardSeen: boolean;
  burnModel: BurnModel;
  eventWatermark: number;
  autoBetStatus: AutoBetStatus;
  connectionStatus: ConnectionStatus;
  sealed: boolean;
}

export type NormalizedEvent =
  | NewShoeSignalEvent
  | ShoeConfirmationEvent
  | CardObservedEvent
  | BettingWindowOpenedEvent
  | BettingWindowClosedEvent
  | HandSettledEvent
  | RedCardSeenEvent
  | BurnModelUpdatedEvent
  | ConnectionLostEvent
  | ConnectionRestoredEvent
  | BetReceiptEvent
  | ShoeInvalidatedEvent
  | ManualCorrectionEvent
  | AutoArmChangedEvent
  | AutoDisarmChangedEvent;

export interface BaseEvent {
  eventId: string;
  tableId: string;
  timestamp: string;
  sourceSeq: number;
  source?: string;
  /** 事件契约版本。当前版本为 1。 */
  schemaVersion?: number;
}

export interface NewShoeSignalEvent extends BaseEvent {
  type: 'newShoeSignal';
  shoeId: string;
  /** Omitted for legacy/physical sources; attach baselines must be explicit. */
  baseline?: ShoeBaseline;
  profile?: Partial<TableProfile>;
}

export interface ShoeConfirmationEvent extends BaseEvent {
  type: 'shoeConfirmation';
  shoeId: string;
  approved: boolean;
}

export interface CardObservedEvent extends BaseEvent {
  type: 'cardObserved';
  shoeId: string;
  handId: string;
  card: Card;
  position?: string;
}

export interface BettingWindowOpenedEvent extends BaseEvent {
  type: 'bettingWindowOpened';
  shoeId: string;
  handId: string;
  market: BettingMarket;
  closesAt?: string;
}

export interface BettingWindowClosedEvent extends BaseEvent {
  type: 'bettingWindowClosed';
  shoeId: string;
  handId: string;
  market: BettingMarket;
  openingObserved?: boolean;
}

/**
 * 结算事件必须携带对子结果，风控才能结算盈亏。
 * outcomes 缺省时按 UNKNOWN 处理：释放风险占用，但不计入输赢。
 */
export interface HandSettledEvent extends BaseEvent {
  type: 'handSettled';
  shoeId: string;
  handId: string;
  playerCards: Card[];
  bankerCards: Card[];
  outcomes?: { bankerPair: boolean; playerPair: boolean };
}

export interface RedCardSeenEvent extends BaseEvent {
  type: 'redCardSeen';
  shoeId: string;
  handId: string | null;
  rawEvidence?: string;
}

export interface BurnModelUpdatedEvent extends BaseEvent {
  type: 'burnModelUpdated';
  shoeId: string;
  burnModel: BurnModel;
  reason?: string;
}

export interface ConnectionLostEvent extends BaseEvent {
  type: 'connectionLost';
  reason?: string;
}

export interface ConnectionRestoredEvent extends BaseEvent {
  type: 'connectionRestored';
  /** Trusted monitor cursor proof in the form cursor-v1:<64 lowercase hex>. */
  continuityProof?: string;
}

export const CONTINUITY_PROOF_PREFIX = 'cursor-v1:';

export function isValidContinuityProof(value: unknown): value is string {
  return typeof value === 'string'
    && /^cursor-v1:[a-f0-9]{64}$/.test(value);
}

export interface BetReceiptEvent extends BaseEvent {
  type: 'betReceipt';
  shoeId: string;
  handId: string;
  market: BettingMarket;
  receipt: BetReceipt;
}

export interface ShoeInvalidatedEvent extends BaseEvent {
  type: 'shoeInvalidated';
  shoeId?: string;
  reason: string;
}

export interface ManualCorrectionEvent extends BaseEvent {
  type: 'manualCorrection';
  shoeId?: string;
  correction: ManualCorrection;
}

export interface AutoArmChangedEvent extends BaseEvent {
  type: 'autoArmChanged';
  shoeId?: string;
  armed: boolean;
}

export interface AutoDisarmChangedEvent extends BaseEvent {
  type: 'autoDisarmChanged';
  shoeId?: string;
  reason: string;
}

export type ManualCorrection =
  | { kind: 'burnModel'; burnModel: BurnModel; requireRearm?: boolean }
  | { kind: 'numberOfDecks'; numberOfDecks: number; requireRearm?: boolean };

export interface DecisionSnapshot {
  snapshotId: string;
  tableId: string;
  shoeId: string;
  handId: string;
  market: BettingMarket;
  eventId?: string;
  eventWatermark: number;
  profileVersion: number;
  modelRevision: string;
  pMean: number;
  pLower: number;
  evMean: number;
  evLower: number;
  eligible: boolean;
  reason: string;
  strategyChoice?: BettingMarket[];
  conservativePolicy: string;
  createdAt: string;
}

export type ExecutionMode = 'shadow' | 'simulated' | 'live';
export type BetStatus = 'SIMULATED' | 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';

export interface BetIntent {
  intentId: string;
  tableId: string;
  shoeId: string;
  handId: string;
  market: BettingMarket;
  amount: number;
  mode: ExecutionMode;
  idempotencyKey: string;
  strategy: BetStrategy;
  decisionSnapshotId: string;
  createdAt: string;
}

export type RiskReservationStatus = 'RESERVED' | 'RELEASED' | 'SETTLED' | 'EXPIRED' | 'UNKNOWN';

export interface RiskReservation {
  reservationId: string;
  intentId: string;
  tableId: string;
  shoeId: string;
  handId: string;
  market: ExecutionMarket;
  /** Missing on legacy rows and interpreted as "strategy". */
  executionSource?: ExecutionSource;
  amount: number;
  maxLoss: number;
  /** 命中的最大盈利，用于结算审计。 */
  maxProfit: number;
  status: RiskReservationStatus;
  createdAt: string;
  releasedAt?: string;
  settledAt?: string;
  realizedPnl?: number;
  receiptId?: string;
  releaseReason?: string;
}

export interface BetReceipt {
  receiptId: string;
  intentId: string;
  reservationId: string;
  status: BetStatus;
  amount: number;
  market: BettingMarket;
  mode: ExecutionMode;
  externalRef?: string;
  createdAt: string;
  raw?: unknown;
}

export interface BetSizingConfig {
  mode: 'fixed' | 'capitalPercent';
  /** capitalPercent 模式下的当前总资金。 */
  bankroll?: number;
  /** capitalPercent 模式下的每手比例，0.0025 表示 0.25%。 */
  percent?: number;
  /** 可选的单手金额硬上限。 */
  maxPerBet?: number;
}

export interface RiskLimits {
  defaultExposureCap: number;
  perTableLossLimit: number;
  perShoeLossLimit: number;
  perDayLossLimit: number;
  maxConcurrentExecutions: number;
  insufficientBehavior: 'skip' | 'shrink';
  betSizing?: BetSizingConfig;
}

export interface RiskExposureState {
  reservedExposure: number;
  pendingExecutions: number;
  executedToday: number;
  dayLoss: number;
  /** 每个牌桌的累计净亏损（正数表示亏）。 */
  tableLosses: Record<string, number>;
  /** 每靴的累计净亏损，key 为 tableId:shoeId。 */
  shoeLosses: Record<string, number>;
  /** 用于跨天重置统计。 */
  asOfDate?: string;
}

export interface ReplayResult {
  events: NormalizedEvent[];
  slate: Map<string, ShoeStateProjection>;
  deterministicHash: string;
}

export const EVENT_SCHEMA_VERSION = 1;

export const EMPTY_REMAINING = (): Record<CardRank, number> => ({
  'A': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0, '9': 0, '10': 0, 'J': 0, 'Q': 0, 'K': 0
});

export function initialDeckCounts(numberOfDecks: number): Record<CardRank, number> {
  if (!Number.isInteger(numberOfDecks) || numberOfDecks <= 0) {
    throw new RangeError(`numberOfDecks must be a positive integer, got ${numberOfDecks}`);
  }
  const counts = EMPTY_REMAINING();
  for (const rank of CARD_RANKS) counts[rank] = 4 * numberOfDecks;
  return counts;
}

export { defaultProfile, defaultRiskLimits } from './defaults.js';
export { sha256, stableStringify } from './hash.js';
export { newId } from './uuid.js';
export * from './validation.js';

export type EvidenceLevel = 'raw' | 'normalized' | 'confirmed' | 'manual';

export interface RawObservation {
  rawEventId: string;
  sourceSeq: number;
  timestamp: string;
  windowId: string;
  tableId: string;
  evidenceLevel: EvidenceLevel;
  payload: unknown;
  rawEvidenceRef?: string;
}

