import type { OperationalWagerMarket } from '@baccarat/adapter-contract';
import type { DecisionHandRecord, MonitorSummary, OperationalWagerRecord } from '@baccarat/ledger-state';
import type {
  BetReceipt,
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

export type DesktopUnknownWagerWriteOffCommand = DesktopUnknownWagerReconciliationCommand;

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
  return parseDesktopUnknownWagerReconciliationCommand(value);
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

export interface DesktopRecordQuery extends DesktopSnapshotOptions {
  kind: DesktopRecordKind;
  page: number;
  pageSize: number;
  market?: string;
  eventType?: string;
  search?: string;
  eligible?: boolean;
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

export interface DesktopRecordCounts {
  events: number;
  decisions: number;
  ledger: number;
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
  demoError?: string;
}
