import type { OperationalWagerMarket } from '@baccarat/adapter-contract';
import type { DecisionHandRecord, MonitorSummary, OperationalWagerRecord } from '@baccarat/ledger-state';
import type {
  BetReceipt,
  BetTier,
  BettingMarket,
  DecisionSnapshot,
  NormalizedEvent,
  RiskExposureState,
  RiskLimits,
  RiskReservation,
  ShoeStateProjection,
  TableProfile,
} from '@baccarat/contracts';

export interface TableActorSnapshot {
  tableId: string;
  profile: TableProfile;
  projection: ShoeStateProjection;
  executionMode: 'shadow' | 'simulated' | 'live';
  defaultBetAmount: number;
  pendingEvents: number;
  missingUnobservedCards?: number;
}

export interface OrchestratorSnapshot {
  riskState: RiskExposureState;
  riskLimits: RiskLimits;
  tables: Record<string, TableActorSnapshot>;
}

export interface ReceiptRow {
  receipt: BetReceipt;
  tableId: string;
  shoeId: string;
  handId: string;
  market: string;
}

export interface OneShotLiveBetCommand {
  readonly tableId: string;
  readonly shoeId: string;
  readonly handId: string;
  readonly market: BettingMarket;
  readonly amount: number;
  readonly confirmation: string;
}

export function oneShotConfirmationText(
  command: Pick<OneShotLiveBetCommand, 'tableId' | 'shoeId' | 'handId' | 'market' | 'amount'>,
): string {
  return `ONE_SHOT_LIVE_BET|tableId=${command.tableId}|shoeId=${command.shoeId}|handId=${command.handId}|market=${command.market}|amount=${String(command.amount)}`;
}

export type OneShotLiveBetResult =
  | {
      readonly status: 'ACCEPTED';
      readonly receipt: BetReceipt;
      readonly snapshot: DesktopConsoleSnapshot;
      readonly reason?: string;
    }
  | {
      readonly status: 'REJECTED';
      readonly receipt?: BetReceipt;
      readonly snapshot: DesktopConsoleSnapshot;
      readonly reason?: string;
    }
  | {
      readonly status: 'UNKNOWN';
      readonly receipt?: BetReceipt;
      readonly snapshot: DesktopConsoleSnapshot;
      readonly reason?: string;
    };

export function isExactOneShotLiveBetConfirmation(
  command: Pick<OneShotLiveBetCommand, 'tableId' | 'shoeId' | 'handId' | 'market' | 'amount' | 'confirmation'>,
): boolean {
  return command.confirmation === oneShotConfirmationText(command);
}

export function parseOneShotLiveBetCommand(value: unknown): OneShotLiveBetCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('one-shot live bet command must be an object');
  }

  const tableId = readOneShotString(value, 'tableId');
  const shoeId = readOneShotString(value, 'shoeId');
  const handId = readOneShotString(value, 'handId');
  const market = Reflect.get(value, 'market');
  const amount = Reflect.get(value, 'amount');
  const confirmation = Reflect.get(value, 'confirmation');

  if (market !== 'bankerPair' && market !== 'playerPair') {
    throw new TypeError(`unsupported one-shot market: ${String(market)}`);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new TypeError('one-shot amount must be a positive finite number');
  }
  if (
    typeof confirmation !== 'string'
    || !isExactOneShotLiveBetConfirmation({ tableId, shoeId, handId, market, amount, confirmation })
  ) {
    throw new TypeError('one-shot confirmation must match exactly');
  }

  return { tableId, shoeId, handId, market, amount, confirmation };
}

function readOneShotString(value: object, field: 'tableId' | 'shoeId' | 'handId'): string {
  const raw = Reflect.get(value, field);
  if (typeof raw !== 'string' || raw.length === 0 || raw.trim() !== raw) {
    throw new TypeError(`one-shot ${field} must be a non-empty trimmed string`);
  }
  return raw;
}

export interface DesktopSnapshotOptions {
  includeHistory?: boolean;
  includeRecordCounts?: boolean;
  includeSummary?: boolean;
  tableId?: string;
  fromTime?: string;
  toTime?: string;
}

export interface DesktopOperationalWagerCommand {
  readonly tableId: string;
  readonly market: OperationalWagerMarket;
  readonly amount: number;
  readonly handId?: string;
}

export interface DesktopUnknownWagerReconciliationCommand {
  readonly reservationId: string;
  readonly wagerId: string;
}

export interface DesktopUnknownWagerWriteOffCommand {
  readonly reservationId: string;
  readonly wagerId?: string;
}

export interface DesktopPendingSettlementCommand {
  readonly reservationId: string;
  readonly wagerId: string;
  readonly outcome: 'WIN' | 'LOSS' | 'PUSH';
}

export type DesktopOperationalWagerResult = {
  readonly status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
  readonly tableId: string;
  readonly reason?: string;
  readonly wager?: OperationalWagerRecord['wager'];
  readonly receipt?: OperationalWagerRecord['receipt'];
  readonly snapshot: DesktopConsoleSnapshot;
};

export interface DesktopKeepaliveStrategySettings {
  readonly intervalMinutes: number;
  readonly market: 'banker' | 'player';
  readonly amount: number;
}

export interface DesktopKeepaliveSettings extends DesktopKeepaliveStrategySettings {
  readonly enabled: boolean;
}

export interface DesktopKeepaliveState extends DesktopKeepaliveSettings {
  readonly lastAttemptAt?: string;
  readonly lastSuccessAt?: string;
  readonly lastStatus?: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
  readonly lastTableId?: string;
  readonly lastReason?: string;
  readonly running: boolean;
}

export interface DesktopAutomationState {
  readonly enabled: boolean;
}

export type DesktopRuntimeIncidentCode =
  | 'bridge-auth-failed'
  | 'bridge-disconnected'
  // FIX(P0-1): 有扩展连上但本机身份未被操作员批准。
  | 'bridge-extension-pairing-required'
  | 'continuity-invalidated'
  | 'table-feed-stale'
  | 'session-recovery-exhausted'
  | 'unknown-execution'
  | 'settlement-gap'
  | 'scheduler-failure'
  | 'monitor-failure'
  | 'shoe-count-mismatch';

export interface DesktopRuntimeIncident {
  readonly incidentId: string;
  readonly code: DesktopRuntimeIncidentCode;
  readonly severity: 'degraded' | 'blocked';
  readonly message: string;
  readonly tableId?: string;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
  readonly occurrences: number;
  readonly active: boolean;
  readonly acknowledgedAt?: string;
  readonly resolvedAt?: string;
}

export interface DesktopRuntimeTableState {
  readonly approved: boolean;
  readonly active: boolean;
  readonly reasons: readonly string[];
  readonly feedState?: 'CONNECTED' | 'RESYNCING' | 'DISCONNECTED';
  readonly feedStalenessMs?: number;
  readonly linkState?: 'live' | 'degraded' | 'resyncing' | 'offline';
  readonly disconnects?: number;
  readonly lastDisconnectAt?: string;
}

export interface DesktopRuntimeState {
  readonly status: 'healthy' | 'degraded' | 'blocked';
  readonly executionReady: boolean;
  readonly monitorActive: boolean;
  readonly approvedLiveTableIds: readonly string[];
  readonly activeLiveTableIds: readonly string[];
  readonly bridge: {
    readonly running: boolean;
    readonly connectionCount: number;
    readonly authenticated: boolean;
    readonly lastSeenAt?: string;
  };
  readonly reasons: readonly string[];
  readonly tables: Readonly<Record<string, DesktopRuntimeTableState>>;
  readonly incidents: readonly DesktopRuntimeIncident[];
  /** 本机 executor 租约（一 Chrome profile 一 lease，理论上恒 1/1）。 */
  readonly executor?: {
    readonly activeExecutorCount: number;
    readonly leaseId?: string;
    readonly profileId?: string;
  };
}

export function parseDesktopOperationalWagerCommand(value: unknown): DesktopOperationalWagerCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('operational wager command must be an object');
  }
  const tableId = readOneShotString(value, 'tableId');
  const market = Reflect.get(value, 'market');
  const amount = Reflect.get(value, 'amount');
  if (market !== 'banker' && market !== 'player' && market !== 'bankerPair' && market !== 'playerPair') {
    throw new TypeError(`unsupported operational wager market: ${String(market)}`);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new TypeError('operational wager amount must be a positive finite number');
  }
  const handId = Reflect.get(value, 'handId');
  if (handId !== undefined && (typeof handId !== 'string' || handId.trim() !== handId || handId.length === 0)) {
    throw new TypeError('handId must be a non-empty trimmed string when provided');
  }
  return { tableId, market, amount, ...(handId === undefined ? {} : { handId }) };
}

export function parseDesktopUnknownWagerWriteOffCommand(
  value: unknown,
): DesktopUnknownWagerWriteOffCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('unknown wager write-off command must be an object');
  }
  const wagerId = Reflect.get(value, 'wagerId');
  return {
    reservationId: readRequiredTrimmedString(value, 'reservationId'),
    ...(typeof wagerId === 'string' && wagerId.trim().length > 0
      ? { wagerId: wagerId.trim() }
      : {}),
  };
}

export function parseDesktopUnknownWagerReconciliationCommand(
  value: unknown,
): DesktopUnknownWagerReconciliationCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('unknown wager reconciliation command must be an object');
  }
  return {
    reservationId: readRequiredTrimmedString(value, 'reservationId'),
    wagerId: readRequiredTrimmedString(value, 'wagerId'),
  };
}

export function parseDesktopPendingSettlementCommand(value: unknown): DesktopPendingSettlementCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('pending settlement command must be an object');
  }
  const outcome = Reflect.get(value, 'outcome');
  if (outcome !== 'WIN' && outcome !== 'LOSS' && outcome !== 'PUSH') {
    throw new TypeError(`unsupported pending settlement outcome: ${String(outcome)}`);
  }
  return {
    reservationId: readRequiredTrimmedString(value, 'reservationId'),
    wagerId: readRequiredTrimmedString(value, 'wagerId'),
    outcome,
  };
}

function readRequiredTrimmedString(value: object, field: string): string {
  const raw = Reflect.get(value, field);
  if (typeof raw !== 'string' || raw.length === 0 || raw.trim() !== raw) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return raw;
}

export function parseDesktopKeepaliveSettings(value: unknown): DesktopKeepaliveStrategySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('keepalive settings must be an object');
  }
  const intervalMinutes = Reflect.get(value, 'intervalMinutes');
  const market = Reflect.get(value, 'market');
  const amount = Reflect.get(value, 'amount');
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1_440) {
    throw new RangeError('keepalive interval must be an integer from 1 to 1440 minutes');
  }
  if (market !== 'banker' && market !== 'player') {
    throw new TypeError(`unsupported keepalive market: ${String(market)}`);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new TypeError('keepalive amount must be a positive finite number');
  }
  return { intervalMinutes, market, amount };
}

export type DesktopRecordKind = 'events' | 'decisions' | 'ledger';

/** IPC 写入面的入参解析器（FIX(D-P2-13)，与 parseDesktopKeepaliveSettings 同级）。 */

export interface DesktopTableSettingsPayload {
  readonly minEV: number;
  readonly betTiers: BetTier[];
  readonly defaultBetAmount: number;
  readonly monitorUrl?: string;
}

function readBetTiers(value: unknown): BetTier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('betTiers must be an array');
  return value.map((tier, index) => {
    if (typeof tier !== 'object' || tier === null || Array.isArray(tier)) {
      throw new TypeError(`betTiers[${index}] must be an object`);
    }
    const minEV = Reflect.get(tier, 'minEV');
    const amount = Reflect.get(tier, 'amount');
    if (typeof minEV !== 'number' || !Number.isFinite(minEV) || minEV < 0) {
      throw new TypeError(`betTiers[${index}].minEV must be a non-negative finite number`);
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new TypeError(`betTiers[${index}].amount must be a positive finite number`);
    }
    return { minEV, amount };
  });
}

function readSettingsFields(value: unknown): {
  minEV: number;
  betTiers: BetTier[];
  defaultBetAmount: number;
  monitorUrl?: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('table settings must be an object');
  }
  const minEV = Reflect.get(value, 'minEV');
  const defaultBetAmount = Reflect.get(value, 'defaultBetAmount');
  if (typeof minEV !== 'number' || !Number.isFinite(minEV)) {
    throw new TypeError('minEV must be a finite number');
  }
  if (typeof defaultBetAmount !== 'number' || !Number.isFinite(defaultBetAmount) || defaultBetAmount <= 0) {
    throw new TypeError('defaultBetAmount must be a positive finite number');
  }
  const monitorUrl = Reflect.get(value, 'monitorUrl');
  if (monitorUrl !== undefined && typeof monitorUrl !== 'string') {
    throw new TypeError('monitorUrl must be a string when provided');
  }
  return {
    minEV,
    betTiers: readBetTiers(Reflect.get(value, 'betTiers')),
    defaultBetAmount,
    ...(monitorUrl === undefined ? {} : { monitorUrl }),
  };
}

export function parseDesktopTableSettings(value: unknown): DesktopTableSettingsPayload {
  return readSettingsFields(value);
}

export function parseDesktopUnifiedTableSettings(
  value: unknown,
): Omit<DesktopTableSettingsPayload, 'monitorUrl'> {
  const { monitorUrl: _ignored, ...rest } = readSettingsFields(value);
  return rest;
}

/** 监控桌 ID 列表：必须是字符串数组，逐项 trim 后非空，去重后不超过 64 张。 */
export function parseDesktopMonitorTableIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('monitor table ids must be an array');
  const normalized: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') throw new TypeError('monitor table id must be a string');
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
  }
  if (normalized.length > 64) throw new RangeError('at most 64 monitor tables are supported');
  return normalized;
}

export interface DesktopRecordQuery extends DesktopSnapshotOptions {
  kind: DesktopRecordKind;
  page: number;
  pageSize: number;
  market?: string;
  eventType?: string;
  search?: string;
  eligible?: boolean;
  /** 审计按结算状态筛选（仅 decisions；与 DecisionHandOutcomeFilter 同口径）。 */
  outcome?: 'settled' | 'unknown' | 'pending' | 'unsettled';
}

export interface LedgerPageRow {
  reservation: RiskReservation;
  decision?: DecisionSnapshot;
  receipt?: ReceiptRow;
  operationalWager?: OperationalWagerRecord;
  outcome?: boolean;
}

export interface DesktopRecordPage {
  kind: DesktopRecordKind;
  page: number;
  pageSize: number;
  total: number;
  events?: NormalizedEvent[];
  decisions?: DecisionHandRecord[];
  ledger?: LedgerPageRow[];
}

export interface MonitorTableCandidate {
  roomId: string;
  roomName?: string;
  tableId: string;
  displayName?: string;
  roundId?: string;
  gameCount?: number;
}

export interface DesktopShoeEvidence {
  readonly reason: string;
  readonly label: string;
  readonly previousGameCount?: number;
  readonly gameCount?: number;
}

/** 珠盘路子单局（当前靴，桥解析器投影）。 */
export interface DesktopBeadHand {
  readonly handId: string;
  readonly result: 'banker' | 'player' | 'tie';
  readonly bankerPair: boolean;
  readonly playerPair: boolean;
}

export interface DesktopRecordCounts {
  events: number;
  decisions: number;
  ledger: number;
}

/**
 * FIX(D-P0-1): 扩展身份批准面。
 *
 * installId 是扩展首次运行时生成的随机身份（32 hex / UUID 形状）。它**不是密钥**，
 * 但"哪个 installId 可以接管真金下注通道"必须由操作员显式批准 —— 桥侧只把批准的
 * installId 提升为 extension 角色。渲染层只拿得到前 8 位（`installIdShort`），
 * 完整 installId 只在 IPC 请求里往返，不落 snapshot。
 */
export interface DesktopExtensionApprovalEntry {
  readonly installIdShort: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface DesktopExtensionApprovalState {
  /** 严格模式：未批准的扩展只能停在 pending（拿不到 lease、收不到 betRequest）。 */
  readonly strict: boolean;
  readonly pendingCount: number;
  readonly unidentifiedPendingConnections: number;
  readonly pending: readonly DesktopExtensionApprovalEntry[];
  readonly approved: readonly DesktopExtensionApprovalEntry[];
}

/** 32 hex（扩展默认）或 UUID；其它形状一律拒绝，避免 UI 把垃圾传给桥。 */
const EXTENSION_INSTALL_ID_SHAPE = /^(?:[0-9a-f]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function isDesktopExtensionInstallId(value: unknown): value is string {
  return typeof value === 'string' && EXTENSION_INSTALL_ID_SHAPE.test(value);
}

export function parseDesktopExtensionInstallId(value: unknown): string {
  if (!isDesktopExtensionInstallId(value)) {
    throw new TypeError('extension install id must be 32 hex characters or a UUID');
  }
  return value;
}

/** 只把前 8 位暴露给渲染层；完整 installId 不进 snapshot。 */
export function shortExtensionInstallId(installId: string): string {
  return installId.slice(0, 8);
}

export interface DesktopConsoleSnapshot {
  dbPath: string;
  isOpen: boolean;
  seed?: number;
  snapshot: OrchestratorSnapshot;
  monitorTableIds: readonly string[];
  monitorCandidates: readonly MonitorTableCandidate[];
  tableMetadata: readonly MonitorTableCandidate[];
  shoeEvidence: Readonly<Record<string, DesktopShoeEvidence>>;
  tableBeads: Readonly<Record<string, readonly DesktopBeadHand[]>>;
  recordCounts: DesktopRecordCounts;
  keepalive: DesktopKeepaliveState;
  automation: DesktopAutomationState;
  runtime: DesktopRuntimeState;
  operationalWagers: readonly OperationalWagerRecord[];
  events: NormalizedEvent[];
  decisions: DecisionSnapshot[];
  receipts: ReceiptRow[];
  reservations: RiskReservation[];
  demoRunning: boolean;
  demoSpeed: number;
  summary: MonitorSummary;
  /** FIX(D-P0-1): 扩展身份批准状态（只含 installId 前 8 位，完整值不进 snapshot）。 */
  extensionApproval: DesktopExtensionApprovalState;
  demoError?: string;
}

/** 聚合复盘报表（只读）：按靴汇总的结算/盈亏、UNKNOWN 敞口、断连排行。 */
export interface DesktopPerformanceReport {
  generatedAt: string;
  totals: {
    reservations: number;
    realizedPnl: number;
    unknownCount: number;
    unknownExposure: number;
  };
  byShoe: Array<{
    tableId: string;
    shoeId: string;
    hands: number;
    stake: number;
    realizedPnl: number;
  }>;
  reservationsByStatus: Record<string, number>;
  disconnectRanking: Array<{
    tableId: string;
    disconnects: number;
    lastDisconnectAt: number;
  }>;
}
