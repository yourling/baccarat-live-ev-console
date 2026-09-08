import {
  SimulatedAdapter,
  type BrowserAdapter,
  type OperationalWagerSource,
} from '@baccarat/adapter-contract';
import {
  EVENT_SCHEMA_VERSION,
  defaultProfile,
  defaultRiskLimits,
  newId,
  type ExecutionMode,
  type ManualCorrection,
  type NormalizedEvent,
  type RiskLimits,
  type TableProfile,
} from '@baccarat/contracts';
import {
  SqliteLedger,
  operationalReceiptCommitStarted,
  type MonitorSummary,
  type MonitorSummaryOptions,
  effectiveShoeBaseline,
  explainShoeBaseline,
  isVerifiedPhysicalShoeEvidence,
  isWrapShapedRoadCount,
  shoeBaselineReasonLabel,
} from '@baccarat/ledger-state';
import {
  Orchestrator,
  STANDARD_COMMISSION_BACCARAT_TERMS,
  type OneShotBetCommand,
  type OneShotBetResult,
  type OrchestratorSnapshot,
  type TableSettingsUpdate,
} from '@baccarat/orchestrator';
import {
  BUNDLED_BROWSER_EXTENSION_IDS,
  BUNDLED_BROWSER_EXTENSION_TOKEN,
  BrowserBridgeServer,
  isCompleteBaccaratHand,
  isJoinableNewShoeRoadCount,
  normalizeBgTableId,
  selectBgRoadCount,
  selectObservedGameCount,
  selectStableGameCount,
  type BrowserBridgeRuntimeEvent,
} from '@baccarat/browser-bridge';
import {
  ShadowRoomMonitor,
  cursorContinuityProof,
  type MonitorHealth,
  type RoomDescriptor,
  type TableExport,
} from '@baccarat/room-monitor';
import { buildRandomDemo } from '../src/core-demo.js';
import {
  OperationalWagerCoordinator,
  type KeepaliveSettings,
  type KeepaliveStrategySettings,
  type OperationalWagerResult,
} from './operational-wager-coordinator.js';
import {
  isExactOneShotLiveBetConfirmation,
  type DesktopConsoleSnapshot as ApiDesktopConsoleSnapshot,
  type DesktopRecordCounts,
  type DesktopRecordPage,
  type DesktopRecordQuery,
  type DesktopRuntimeState,
  type DesktopPendingSettlementCommand,
  type DesktopUnknownWagerReconciliationCommand,
  type DesktopUnknownWagerWriteOffCommand,
  type DesktopShoeEvidence,
  type MonitorTableCandidate,
  type OneShotLiveBetCommand,
  type OneShotLiveBetResult,
} from '../src/api-types.js';
import {
  LiveApprovalStore,
  RuntimeIncidentStore,
  evaluateLiveExecutionReadiness,
  type LiveExecutionBlockReason,
  type RuntimeIncidentCode,
  type RuntimeIncidentSeverity,
} from './runtime-supervisor.js';

const RETIRED_DEFAULT_MONITOR_TABLE_IDS = ['bc281koreanch281', 'tobcbaccaragen92', 'speedbca14gesbc1', 'h22z8qhp17sa0vkh'] as const;
const MONITOR_TABLE_CONFIG_KEY = 'desktop:monitor-tables:v1';
const AUTOMATION_CONFIG_KEY = 'desktop:pair-automation:v1';
const TABLE_METADATA_CONFIG_KEY = 'desktop:table-metadata:v1';
const UNIFIED_BET_SETTINGS_CONFIG_KEY = 'desktop:unified-bet-settings:v1';
const LEGACY_MONITOR_TABLE_ID_PATTERN = /^[A-Z]{1,4}\d{2,6}$/i;
const PRAGMATIC_MONITOR_TABLE_ID_PATTERN = /^[a-z0-9]{8,32}$/i;
const WINFINITY_MONITOR_TABLE_ID_PATTERN = /^[a-z0-9]+-bac\d+$/i;
const WINFINITY_FALLBACK_MONITOR_TABLE_ID_PATTERN = /^wnf-[a-f0-9]{24}$/i;
const DISCONNECTED_MONITOR_REMOVAL_MS = 15_000;
const SHUFFLE_MONITOR_HOLD_MS = 10 * 60 * 1000;
const MAX_LIVE_FEED_STALENESS_MS = 120_000;
const LIVE_MONITOR_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
const MAX_LIVE_MONITOR_TABLES = 64;
const EMPTY_RECORD_COUNTS: DesktopRecordCounts = { events: 0, decisions: 0, ledger: 0 };
const EMPTY_MONITOR_SUMMARY: MonitorSummary = { rows: [], incomePoints: [] };
const ACCOUNTING_REFRESH_MIN_MS = 2_000;

type MonitorTableConfig = {
  readonly tableIds: readonly string[];
};

type StoredTableMetadata = {
  readonly tableId: string;
  readonly roomId: string;
  readonly updatedAt: string;
  readonly roomName?: string;
  readonly displayName?: string;
  readonly roundId?: string;
  readonly gameCount?: number;
};

type TableMetadataConfig = {
  readonly tables: readonly StoredTableMetadata[];
};

type UnifiedBetSettings = Pick<TableSettingsUpdate, 'minEV' | 'betTiers' | 'defaultBetAmount'>;

interface OneShotLiveBetActor {
  placeOneShotBet(command: OneShotBetCommand): Promise<OneShotBetResult>;
}

function hasOneShotLiveBetActor(value: unknown): value is OneShotLiveBetActor {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'placeOneShotBet') === 'function';
}

function isLiveDesktopRoomId(roomId: string): boolean {
  return roomId === 'dafabet-pragmatic' || roomId === 'dafabet-bg' || roomId === 'dafabet-winfinity';
}

/**
 * A selection transition must distinguish a feed that stopped, disappeared on
 * its own, and one that may still be delivering events after a failed stop.
 */
type MonitorFeedTransitionStopResult =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'not-current' }
  | { readonly kind: 'failed'; readonly error: unknown };

function normalizeMonitorTableIds(tableIds: readonly string[], allowEmpty = false): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawTableId of tableIds) {
    const trimmed = rawTableId.trim();
    const tableId = LEGACY_MONITOR_TABLE_ID_PATTERN.test(trimmed)
      ? trimmed.toUpperCase()
      : trimmed.toLowerCase();
    if (
      !LEGACY_MONITOR_TABLE_ID_PATTERN.test(tableId)
      && !PRAGMATIC_MONITOR_TABLE_ID_PATTERN.test(tableId)
      && !WINFINITY_MONITOR_TABLE_ID_PATTERN.test(tableId)
      && !WINFINITY_FALLBACK_MONITOR_TABLE_ID_PATTERN.test(tableId)
    ) {
      throw new RangeError(`invalid monitor table id: ${rawTableId}`);
    }
    if (!seen.has(tableId)) {
      seen.add(tableId);
      normalized.push(tableId);
    }
  }
  if (!allowEmpty && normalized.length === 0) {
    throw new RangeError('at least one monitor table id is required');
  }
  return normalized;
}

function monitorTableIdsFromConfig(value: unknown): string[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const tableIds = Reflect.get(value, 'tableIds');
  if (!Array.isArray(tableIds) || !tableIds.every((tableId): tableId is string => typeof tableId === 'string')) {
    return null;
  }
  try {
    return normalizeMonitorTableIds(tableIds, true);
  } catch {
    return null;
  }
}

function normalizeOptionalMonitorTableId(tableId: string): string | undefined {
  try {
    return normalizeMonitorTableIds([tableId], true)[0];
  } catch {
    return undefined;
  }
}

function tableMetadataFromConfig(value: unknown): Map<string, StoredTableMetadata> {
  const result = new Map<string, StoredTableMetadata>();
  if (typeof value !== 'object' || value === null) return result;
  const tables = Reflect.get(value, 'tables');
  if (!Array.isArray(tables)) return result;
  for (const entry of tables) {
    if (typeof entry !== 'object' || entry === null) continue;
    const tableId = Reflect.get(entry, 'tableId');
    const roomId = Reflect.get(entry, 'roomId');
    const updatedAt = Reflect.get(entry, 'updatedAt');
    if (typeof tableId !== 'string' || typeof roomId !== 'string' || typeof updatedAt !== 'string') continue;
    const normalized = normalizeOptionalMonitorTableId(tableId);
    if (normalized === undefined) continue;
    result.set(normalized, {
      tableId: normalized,
      roomId,
      updatedAt,
      ...optionalString(entry, 'roomName'),
      ...optionalString(entry, 'displayName'),
      ...optionalString(entry, 'roundId'),
      ...optionalNumber(entry, 'gameCount'),
    });
  }
  return result;
}

function optionalString(value: object, field: string): Record<string, string> {
  const raw = Reflect.get(value, field);
  return typeof raw === 'string' && raw.trim().length > 0 ? { [field]: raw.trim() } : {};
}

function optionalNumber(value: object, field: string): Record<string, number> {
  const raw = Reflect.get(value, field);
  return typeof raw === 'number' && Number.isFinite(raw) ? { [field]: raw } : {};
}

function samePersistentTableMetadata(
  left: StoredTableMetadata | undefined,
  right: StoredTableMetadata,
): boolean {
  return left !== undefined
    && left.tableId === right.tableId
    && left.roomId === right.roomId
    && left.roomName === right.roomName
    && left.displayName === right.displayName;
}

function discoveredMonitorTableIds(rooms: readonly RoomDescriptor[]): Set<string> {
  const tableIds = new Set<string>();
  for (const room of rooms) {
    for (const table of room.tables) {
      const tableId = normalizeOptionalMonitorTableId(table.tableId);
      if (tableId !== undefined) tableIds.add(tableId);
    }
  }
  return tableIds;
}

function automationEnabledFromConfig(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'enabled') === true;
}

function cloneUnifiedBetSettings(settings: UnifiedBetSettings): UnifiedBetSettings {
  return {
    minEV: settings.minEV,
    defaultBetAmount: settings.defaultBetAmount,
    betTiers: settings.betTiers.map(tier => ({ ...tier })),
  };
}

function isFactoryUnifiedBetSettings(settings: UnifiedBetSettings): boolean {
  return settings.minEV === 0
    && settings.defaultBetAmount === 100
    && settings.betTiers.length === 0;
}

function sameUnifiedBetSettings(left: UnifiedBetSettings, right: UnifiedBetSettings): boolean {
  return left.minEV === right.minEV
    && left.defaultBetAmount === right.defaultBetAmount
    && left.betTiers.length === right.betTiers.length
    && left.betTiers.every((tier, index) =>
      tier.minEV === right.betTiers[index]?.minEV && tier.amount === right.betTiers[index]?.amount);
}

function unifiedBetSettingsFromConfig(value: unknown): UnifiedBetSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const minEV = Reflect.get(value, 'minEV');
  const defaultBetAmount = Reflect.get(value, 'defaultBetAmount');
  const betTiers = Reflect.get(value, 'betTiers');
  if (typeof minEV !== 'number' || !Number.isFinite(minEV) || minEV < 0) return undefined;
  if (typeof defaultBetAmount !== 'number' || !Number.isFinite(defaultBetAmount) || defaultBetAmount <= 0) {
    return undefined;
  }
  if (!Array.isArray(betTiers)) return undefined;
  const tiers: UnifiedBetSettings['betTiers'] = [];
  for (const tier of betTiers) {
    if (typeof tier !== 'object' || tier === null) return undefined;
    const tierMinEV = Reflect.get(tier, 'minEV');
    const amount = Reflect.get(tier, 'amount');
    if (typeof tierMinEV !== 'number' || !Number.isFinite(tierMinEV) || tierMinEV < 0) return undefined;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return undefined;
    tiers.push({ minEV: tierMinEV, amount });
  }
  return { minEV, defaultBetAmount, betTiers: tiers };
}

function defaultMonitorTableIds(): string[] {
  const rawTableIds = String(process.env.BACCARAT_LIVE_TABLES || '')
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0);
  return normalizeMonitorTableIds(rawTableIds, true).slice(0, MAX_LIVE_MONITOR_TABLES);
}

function isRetiredDefaultMonitorList(tableIds: readonly string[]): boolean {
  if (tableIds.length !== RETIRED_DEFAULT_MONITOR_TABLE_IDS.length) return false;
  const expected = new Set<string>(RETIRED_DEFAULT_MONITOR_TABLE_IDS);
  return tableIds.every(tableId => expected.has(tableId));
}

export interface DesktopSnapshotOptions extends MonitorSummaryOptions {
  includeHistory?: boolean;
  includeRecordCounts?: boolean;
  includeSummary?: boolean;
}

export interface DesktopConsoleSnapshot extends Omit<ApiDesktopConsoleSnapshot, 'snapshot' | 'summary' | 'demoError'> {
  dbPath: string;
  isOpen: boolean;
  seed?: number;
  snapshot: OrchestratorSnapshot;
  monitorTableIds: readonly string[];
  monitorCandidates: readonly MonitorTableCandidate[];
  tableMetadata: readonly MonitorTableCandidate[];
  recordCounts: DesktopRecordCounts;
  events: NormalizedEvent[];
  decisions: ReturnType<SqliteLedger['listDecisions']>;
  receipts: ReturnType<SqliteLedger['listReceipts']>;
  reservations: ReturnType<Orchestrator['getReservations']>;
  demoRunning: boolean;
  demoSpeed: number;
  runtime: DesktopRuntimeState;
  summary: MonitorSummary;
  demoError?: string;
}

function defaultConsoleLimits(): RiskLimits {
  return {
    ...defaultRiskLimits,
    defaultExposureCap: 100_000,
    perTableLossLimit: 100_000,
    perShoeLossLimit: 100_000,
    perDayLossLimit: 1_000_000,
    maxConcurrentExecutions: 4,
    insufficientBehavior: 'skip',
  };
}

export class DesktopConsoleService {
  private readonly ledger: SqliteLedger;
  private readonly orchestrator: Orchestrator;
  private readonly operationalWagers: OperationalWagerCoordinator;
  private readonly liveApprovals: LiveApprovalStore;
  private readonly runtimeIncidents: RuntimeIncidentStore;
  private readonly startupFailCloseTask: Promise<void>;
  private currentExecutor: Pick<BrowserAdapter, 'requestBet'> | null;
  private lastSeed?: number;
  private demoRunning = false;
  private demoSpeed = 1;
  private demoStopRequested = false;
  private demoTask: Promise<void> | null = null;
  private demoError?: string;
  private browserBridge?: BrowserBridgeServer;
  private browserBridgePort = 0;
  private liveExecutionMode: ExecutionMode = 'live';
  private readonly liveFeeds = new Map<string, TableExport>();
  private readonly liveRoomIdsByTable = new Map<string, string>();
  private readonly tableMetadata: Map<string, StoredTableMetadata>;
  private readonly disconnectedMonitorRemovalTimers = new Map<string, NodeJS.Timeout>();
  private readonly shuffleHoldUntilByTable = new Map<string, number>();
  private readonly lastFeedDisconnectReason = new Map<string, string>();
  private readonly runtimeObservedTableIds = new Set<string>();
  private readonly liveAuthorizationSources = new Map<string, 'manual' | 'unattended'>();
  private persistentLiveGateEnabled = false;
  private transportDownAt?: number;
  private recoverySuppressUntil = 0;
  private readonly tableFlapStats = new Map<string, {
    disconnects: number;
    lastDisconnectAt: number;
    lastRecoveredAt?: number;
    recentDisconnectAt: number[];
  }>();
  private liveRoomTimer?: NodeJS.Timeout;
  private liveMonitorRetryAttempt = 0;
  private liveMonitorOperation: Promise<void> = Promise.resolve();
  private liveMonitorActivated = false;
  private liveMonitorStartedAt = 0;
  private readonly connectedThisProcess = new Set<string>();
  private readonly missedShuffleRequested = new Set<string>();
  private oneShotLiveBetInFlight: Promise<OneShotLiveBetResult> | null = null;
  private executionStateOperation: Promise<void> = Promise.resolve();
  private cachedRecordCounts?: DesktopRecordCounts;
  private cachedSummary?: MonitorSummary;
  private cachedLightSnapshot?: { key: string; at: number; value: DesktopConsoleSnapshot };
  private lastAccountingRefreshAt = 0;
  private closing = false;
  private suppressDiscoveredMonitorAutoAdd = false;
  private automationEnabled = false;
  private readonly pendingGameCountByTable = new Map<string, number>();
  private readonly demotedPendingTableIds = new Set<string>();
  private readonly demotedPendingShoeIds = new Map<string, string>();
  /** The transient allowlist used only while a serialized live transition is being validated. */
  private pendingMonitorTableIds?: readonly string[];
  /** Operator-managed, persisted ordered selection; mutation is the configuration operation. */
  private monitorTableIds: string[];
  private unifiedBetSettings?: UnifiedBetSettings;

  constructor(readonly dbPath: string) {
    this.ledger = new SqliteLedger(dbPath);
    this.ledger.repairPrecommitUnknownOperationalReservations();
    const repairedAcceptedReservations = this.ledger
      .restoreInvalidlyExpiredAcceptedOperationalReservations();
    this.ledger.pruneTransientHistory();
    // Keep audit events/decisions; live actor replay skips previous-process rows.
    this.ledger.abandonPreviousProcessTableFeed();
    this.currentExecutor = null;
    this.orchestrator = new Orchestrator({
      ledger: this.ledger,
      riskLimits: defaultConsoleLimits(),
      executor: null,
      operationalWagerTerms: STANDARD_COMMISSION_BACCARAT_TERMS,
      canExecuteAutomaticBets: tableId => this.canExecuteAutomaticBets(tableId),
      onBettingWindowOpened: (tableId, closesAt) => {
        void this.operationalWagers.tick(new Date(), tableId, closesAt).catch(error => {
          this.recordLiveMonitorError(error, 'scheduler-failure', 'degraded');
        });
      },
      observedGameCount: tableId => this.tableMetadata.get(tableId)?.gameCount,
      observedShoeEvidence: tableId => this.browserBridge?.shoeEvidence(tableId),
    });
    for (const repair of repairedAcceptedReservations) {
      const settlement = this.ledger.getHandSettlement(
        repair.tableId,
        repair.shoeId,
        repair.handId,
      );
      if (settlement) {
        this.orchestrator.recoverAcceptedHandSettlement(
          repair.tableId,
          repair.shoeId,
          repair.handId,
          settlement,
        );
      }
    }
    for (const reservation of this.orchestrator.getReservations()) {
      if (
        reservation.status !== 'UNKNOWN'
        || reservation.releaseReason !== 'hand-settled-without-authoritative-outcome'
      ) continue;
      const settlement = this.ledger.getHandSettlement(
        reservation.tableId,
        reservation.shoeId,
        reservation.handId,
      );
      if (!settlement) continue;
      this.orchestrator.recoverAcceptedHandSettlement(
        reservation.tableId,
        reservation.shoeId,
        reservation.handId,
        settlement,
      );
    }
    this.recoverCommittedUnknownSettlements();
    for (const reservation of this.orchestrator.getReservations()) {
      if (reservation.status !== 'RESERVED' && reservation.status !== 'UNKNOWN') continue;
      const settlement = this.ledger.getHandSettlement(
        reservation.tableId,
        reservation.shoeId,
        reservation.handId,
      );
      if (!settlement) continue;
      this.orchestrator.recoverAcceptedHandSettlement(
        reservation.tableId,
        reservation.shoeId,
        reservation.handId,
        settlement,
      );
    }
    this.orchestrator.resetLiveShoeTracking();
    const persistedLiveTableIds = Object.values(this.orchestrator.listTableConfigs())
      .filter(config => config.executionMode === 'live')
      .map(config => config.profile.tableId);
    this.liveApprovals = new LiveApprovalStore(this.ledger, persistedLiveTableIds);
    this.runtimeIncidents = new RuntimeIncidentStore(this.ledger);
    this.tableMetadata = tableMetadataFromConfig(
      this.ledger.getConfig<unknown>(TABLE_METADATA_CONFIG_KEY),
    );
    this.monitorTableIds = this.loadMonitorTableIds();
    this.syncLiveApprovalsToMonitorTables();
    this.operationalWagers = new OperationalWagerCoordinator({
      ledger: this.ledger,
      actor: tableId => this.orchestrator.getActor(tableId),
      monitorTableIds: () => this.monitorTableIds,
      keepaliveTableIds: () => this.keepaliveEligibleTableIds(),
      serialize: async operation => await this.enqueueExecutionStateOperation(operation),
      runtimeBlockReason: (tableId, source) => this.operationalWagerRuntimeBlockReason(tableId, source),
      onError: error => this.recordLiveMonitorError(error, 'scheduler-failure', 'degraded'),
    });
    this.automationEnabled = automationEnabledFromConfig(
      this.ledger.getConfig<unknown>(AUTOMATION_CONFIG_KEY),
    );
    this.normalizeEvFloor();
    this.unifiedBetSettings = unifiedBetSettingsFromConfig(
      this.ledger.getConfig<unknown>(UNIFIED_BET_SETTINGS_CONFIG_KEY),
    ) ?? this.deriveUnifiedBetSettingsFromMonitoredTables();
    if (this.unifiedBetSettings !== undefined) {
      this.ledger.setConfig(UNIFIED_BET_SETTINGS_CONFIG_KEY, cloneUnifiedBetSettings(this.unifiedBetSettings));
      this.applyUnifiedBetSettingsToTables(this.monitorTableIds);
    }
    this.startupFailCloseTask = this.initializeFailClosedRuntime();
    this.refreshAccountingIncidents();
  }

  private loadMonitorTableIds(): string[] {
    const configured = monitorTableIdsFromConfig(this.ledger.getConfig<unknown>(MONITOR_TABLE_CONFIG_KEY));
    if (configured !== null) {
      if (isRetiredDefaultMonitorList(configured)) {
        this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: [] });
        return [];
      }
      if (configured.length <= MAX_LIVE_MONITOR_TABLES) return configured;
      const trimmed = configured.slice(0, MAX_LIVE_MONITOR_TABLES);
      this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: trimmed });
      return trimmed;
    }
    const defaults = defaultMonitorTableIds();
    this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: defaults });
    return defaults;
  }

  private syncLiveApprovalsToMonitorTables(): void {
    this.liveApprovals.retain(this.monitorTableIds);
    for (const tableId of this.monitorTableIds) this.liveApprovals.approve(tableId);
  }

  private observedGameCount(tableId: string, incoming?: number): number | undefined {
    if (normalizeBgTableId(tableId) !== undefined) {
      const accepted = this.browserBridge?.acceptedGameCount(tableId);
      const reason = this.browserBridge?.shoeEvidence(tableId)?.reason;
      if (reason === 'protocol-shuffle' && accepted === undefined && incoming !== undefined && incoming > 20) {
        return undefined;
      }
      if (
        typeof accepted === 'number'
        && typeof incoming === 'number'
        && isWrapShapedRoadCount(accepted, incoming)
      ) {
        return incoming;
      }
      return selectBgRoadCount(accepted, incoming);
    }
    return selectObservedGameCount(
      this.browserBridge?.shoeEvidence(tableId)?.reason,
      this.browserBridge?.acceptedGameCount(tableId),
      incoming,
    );
  }

  private refreshTableMetadataFromRooms(rooms: readonly RoomDescriptor[]): void {
    let changed = false;
    const updatedAt = new Date().toISOString();
    for (const room of rooms) {
      for (const table of room.tables) {
        const tableId = normalizeOptionalMonitorTableId(table.tableId);
        if (tableId === undefined) continue;
        const existing = this.tableMetadata.get(tableId);
        const gameCount = this.observedGameCount(tableId, table.gameCount ?? existing?.gameCount);
        const next: StoredTableMetadata = {
          tableId,
          roomId: room.roomId,
          updatedAt,
          ...(existing?.roomName === undefined ? {} : { roomName: existing.roomName }),
          ...(existing?.displayName === undefined ? {} : { displayName: existing.displayName }),
          ...(existing?.roundId === undefined ? {} : { roundId: existing.roundId }),
          ...(room.displayName === undefined ? {} : { roomName: room.displayName }),
          ...(table.displayName === undefined ? {} : { displayName: table.displayName }),
          ...(table.roundId === undefined ? {} : { roundId: table.roundId }),
          ...(gameCount === undefined ? {} : { gameCount }),
        };
        this.tableMetadata.set(tableId, next);
        if (!samePersistentTableMetadata(existing, next)) changed = true;
        if (this.demoteIfGameCountAnomaly(tableId)) {
          void this.failCloseLiveExecution([tableId]).catch(error => {
            this.recordLiveMonitorError(error, 'shoe-count-mismatch', 'degraded', tableId);
          });
        }
      }
    }
    if (changed) this.persistTableMetadata();
    this.recoverMissedShuffles(rooms);
  }

  private recoverMissedShuffles(_rooms: readonly RoomDescriptor[]): void {
    // Automatic physical shoes come only from protocol token change or road wrap
    // in the parser. Do not invent a full 8-deck shoe from lagged DOM counts.
    this.missedShuffleRequested.clear();
  }

  private persistTableMetadata(): void {
    this.ledger.setConfig<TableMetadataConfig>(TABLE_METADATA_CONFIG_KEY, {
      tables: [...this.tableMetadata.values()].map(table => ({
        tableId: table.tableId,
        roomId: table.roomId,
        updatedAt: table.updatedAt,
        ...(table.roomName === undefined ? {} : { roomName: table.roomName }),
        ...(table.displayName === undefined ? {} : { displayName: table.displayName }),
      })),
    });
  }

  private pendingJoinTableIds(): string[] {
    const monitored = new Set(this.monitorTableIds);
    const pending: string[] = [];
    const add = (tableId: string): void => {
      if (monitored.has(tableId) || pending.includes(tableId)) return;
      pending.push(tableId);
    };
    for (const tableId of this.demotedPendingTableIds) add(tableId);
    for (const candidate of this.monitorCandidates()) {
      if (!isLiveDesktopRoomId(candidate.roomId)) continue;
      const tableId = normalizeOptionalMonitorTableId(candidate.tableId);
      if (tableId === undefined) continue;
      add(tableId);
    }
    return pending;
  }

  private keepaliveEligibleTableIds(): string[] {
    return [...this.monitorTableIds];
  }

  private observedTableIds(): string[] {
    const ids = [...this.currentMonitorTableIds()];
    const seen = new Set(ids);
    for (const tableId of this.pendingJoinTableIds()) {
      if (seen.has(tableId)) continue;
      seen.add(tableId);
      ids.push(tableId);
    }
    return ids;
  }

  private isObservedTable(tableId: string): boolean {
    return this.observedTableIds().includes(tableId);
  }

  private clearStaleRoadCount(tableId: string): void {
    const existing = this.tableMetadata.get(tableId);
    if (existing?.gameCount === undefined) return;
    const { gameCount: _ignored, ...rest } = existing;
    this.tableMetadata.set(tableId, { ...rest, updatedAt: new Date().toISOString() });
    this.persistTableMetadata();
  }

  private holdDemotedPendingTable(tableId: string, shoeId?: string): void {
    this.demotedPendingTableIds.add(tableId);
    this.demotedPendingShoeIds.set(tableId, shoeId ?? '');
  }

  private clearDemotedPendingTable(tableId: string): void {
    this.demotedPendingTableIds.delete(tableId);
    this.demotedPendingShoeIds.delete(tableId);
  }

  private canAutoPromotePendingTable(tableId: string, incomingShoeId?: string): boolean {
    if (!this.demotedPendingTableIds.has(tableId)) return true;
    const heldShoeId = this.demotedPendingShoeIds.get(tableId) ?? '';
    const nextShoeId = incomingShoeId
      ?? this.orchestrator.getActor(tableId)?.getProjection().shoeId
      ?? '';
    return nextShoeId.length > 0 && nextShoeId !== heldShoeId;
  }

  private promotePendingTable(tableId: string, incomingShoeId?: string): void {
    if (this.monitorTableIds.includes(tableId)) return;
    if (this.monitorTableIds.length >= MAX_LIVE_MONITOR_TABLES) return;
    if (!this.canAutoPromotePendingTable(tableId, incomingShoeId)) return;
    const nextTableIds = [...this.monitorTableIds, tableId];
    this.ensureMonitorActors(nextTableIds, this.currentUnifiedTableSettings());
    this.monitorTableIds = nextTableIds;
    this.pendingGameCountByTable.delete(tableId);
    this.clearDemotedPendingTable(tableId);
    this.runtimeIncidents.resolve('shoe-count-mismatch', tableId);
    this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: nextTableIds });
    this.syncLiveApprovalsToMonitorTables();
    this.browserBridge?.setSelectedTableIds(this.observedTableIds());
  }

  private promotePendingTablesFromRooms(rooms: readonly RoomDescriptor[]): void {
    for (const room of rooms) {
      if (!isLiveDesktopRoomId(room.roomId)) continue;
      for (const table of room.tables) {
        const tableId = normalizeOptionalMonitorTableId(table.tableId);
        if (tableId === undefined || this.monitorTableIds.includes(tableId)) continue;
        const evidence = this.browserBridge?.shoeEvidence(tableId);
        if (isVerifiedPhysicalShoeEvidence(evidence)) {
          this.promotePendingTable(tableId);
          if (this.monitorTableIds.includes(tableId)) continue;
        }
        const gameCount = table.gameCount;
        if (!Number.isInteger(gameCount) || (gameCount ?? 0) < 1) continue;
        const previous = this.pendingGameCountByTable.get(tableId);
        const stable = normalizeBgTableId(tableId) !== undefined
          ? selectBgRoadCount(previous, gameCount)
          : selectStableGameCount(previous, gameCount!);
        if (stable === undefined) continue;
        this.pendingGameCountByTable.set(tableId, stable);
        if (isJoinableNewShoeRoadCount(previous, stable)) this.promotePendingTable(tableId);
      }
    }
  }

  private demoteAnomalousMonitorTable(
    tableId: string,
    handNumber: number,
    roadCount: number,
    missingCards: number,
    shoeId?: string,
  ): boolean {
    if (!this.liveMonitorActivated) return false;
    if (!this.monitorTableIds.includes(tableId)) return false;
    this.pendingGameCountByTable.set(tableId, roadCount);
    this.holdDemotedPendingTable(tableId, shoeId);
    const nextTableIds = this.monitorTableIds.filter(candidate => candidate !== tableId);
    this.monitorTableIds = nextTableIds;
    this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: nextTableIds });
    this.syncLiveApprovalsToMonitorTables();
    this.browserBridge?.setSelectedTableIds(this.observedTableIds());
    this.ensureRuntimeIncident({
      code: 'shoe-count-mismatch',
      severity: 'degraded',
      tableId,
      message: `缺牌 ${missingCards} 张（内部 #${handNumber}，路子 #${roadCount}），已移出监控，等待下一靴`,
    });
    return true;
  }

  private demoteIfGameCountAnomaly(tableId: string): boolean {
    if (!this.liveMonitorActivated) return false;
    if (!this.monitorTableIds.includes(tableId)) return false;
    const actor = this.orchestrator.getActor(tableId);
    if (!actor) return false;
    const missingCards = actor.missingUnobservedCardCount();
    if (missingCards > 10) {
      const projection = actor.getProjection();
      const roadCount = this.tableMetadata.get(tableId)?.gameCount
        ?? this.browserBridge?.acceptedGameCount(tableId)
        ?? projection.handNumber;
      return this.demoteAnomalousMonitorTable(
        tableId,
        projection.handNumber,
        roadCount,
        missingCards,
        projection.shoeId || undefined,
      );
    }
    return false;
  }

  private ensureMonitorActors(
    tableIds: readonly string[],
    inheritedSettings?: UnifiedBetSettings,
  ): void {
    const settings = inheritedSettings ?? this.currentUnifiedTableSettings();
    for (const tableId of tableIds) {
      if (!this.orchestrator.getActor(tableId)) {
        const profile = defaultProfile(tableId);
        this.orchestrator.registerTable(
          settings === undefined
            ? profile
            : {
                ...profile,
                minEV: settings.minEV,
                betTiers: settings.betTiers.map(tier => ({ ...tier })),
              },
          'live',
          settings?.defaultBetAmount ?? 100,
        );
      } else {
        if (this.orchestrator.getActor(tableId)?.snapshot().executionMode !== 'live') {
          this.orchestrator.updateTableExecutionMode(tableId, 'live');
        }
        this.applyUnifiedBetSettingsToTables([tableId]);
      }
    }
  }

  private currentUnifiedTableSettings(): UnifiedBetSettings | undefined {
    if (this.unifiedBetSettings !== undefined) return cloneUnifiedBetSettings(this.unifiedBetSettings);
    return this.deriveUnifiedBetSettingsFromMonitoredTables();
  }

  private deriveUnifiedBetSettingsFromMonitoredTables(): UnifiedBetSettings | undefined {
    let fallback: UnifiedBetSettings | undefined;
    for (const tableId of this.monitorTableIds) {
      const table = this.orchestrator.getActor(tableId)?.snapshot();
      if (table === undefined) continue;
      const candidate: UnifiedBetSettings = {
        minEV: table.profile.minEV,
        betTiers: (table.profile.betTiers ?? []).map(tier => ({ ...tier })),
        defaultBetAmount: table.defaultBetAmount,
      };
      if (!isFactoryUnifiedBetSettings(candidate)) return candidate;
      fallback ??= candidate;
    }
    return fallback;
  }

  private persistUnifiedBetSettings(settings: UnifiedBetSettings): void {
    this.unifiedBetSettings = cloneUnifiedBetSettings(settings);
    this.ledger.setConfig(UNIFIED_BET_SETTINGS_CONFIG_KEY, cloneUnifiedBetSettings(settings));
  }

  private applyUnifiedBetSettingsToTables(tableIds: readonly string[]): void {
    const settings = this.currentUnifiedTableSettings();
    if (settings === undefined) return;
    for (const tableId of tableIds) {
      const actor = this.orchestrator.getActor(tableId);
      if (!actor) continue;
      const snapshot = actor.snapshot();
      const current: UnifiedBetSettings = {
        minEV: snapshot.profile.minEV,
        betTiers: (snapshot.profile.betTiers ?? []).map(tier => ({ ...tier })),
        defaultBetAmount: snapshot.defaultBetAmount,
      };
      if (sameUnifiedBetSettings(current, settings)) continue;
      this.orchestrator.updateTableSettings(tableId, cloneUnifiedBetSettings(settings));
    }
  }

  private normalizeEvFloor(): void {
    for (const table of Object.values(this.orchestrator.snapshot().tables)) {
      if (table.profile.minEV < 0) {
        this.orchestrator.registerTable(
          { ...table.profile, minEV: 0 },
          table.executionMode,
          table.defaultBetAmount,
        );
      }
    }
  }

  private async initializeFailClosedRuntime(): Promise<void> {
    for (const actor of this.orchestrator.listActors()) {
      if (this.monitorTableIds.includes(actor.tableId) && actor.snapshot().executionMode !== 'live') {
        this.orchestrator.updateTableExecutionMode(actor.tableId, 'live');
      }
      const projection = actor.getProjection();
      if (this.monitorTableIds.includes(actor.tableId) && projection.shoeId && projection.connectionStatus !== 'DISCONNECTED') {
        await this.orchestrator.enqueue(actor.tableId, {
          type: 'connectionLost',
          eventId: newId('evt'),
          tableId: actor.tableId,
          timestamp: new Date().toISOString(),
          sourceSeq: this.nextMonitorSourceSeq(actor.tableId),
          source: 'console',
          schemaVersion: EVENT_SCHEMA_VERSION,
          reason: 'process-restarted',
        });
      }
    }
    this.liveAuthorizationSources.clear();
    this.transportDownAt = undefined;
    this.recoverySuppressUntil = 0;
    this.setOrchestratorExecutor(null);
    this.setOperationalWagerExecutor(false);
  }

  private canExecuteAutomaticBets(_tableId: string): boolean {
    return this.automationEnabled;
  }

  private hasSettlementGap(tableId: string): boolean {
    return this.runtimeIncidents.hasActive('settlement-gap', tableId);
  }

  private ensureRuntimeIncident(input: {
    readonly code: RuntimeIncidentCode;
    readonly severity: RuntimeIncidentSeverity;
    readonly message: string;
    readonly tableId?: string;
  }): void {
    const active = this.runtimeIncidents.list().find(incident =>
      incident.active
      && incident.code === input.code
      && incident.tableId === input.tableId);
    if (active?.severity === input.severity) return;
    this.runtimeIncidents.record(input);
  }

  private refreshAccountingIncidents(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastAccountingRefreshAt < ACCOUNTING_REFRESH_MIN_MS) return;
    this.lastAccountingRefreshAt = now;
    const reservations = this.orchestrator.getReservations();
    const unknownTableIds = new Set(
      reservations
        .filter(reservation => reservation.status === 'UNKNOWN')
        .map(reservation => reservation.tableId),
    );
    const settlementGapTableIds = new Set(
      reservations
        .filter(reservation => {
          if (reservation.status !== 'RESERVED') return false;
          const projection = this.orchestrator.getActor(reservation.tableId)?.peekProjection();
          if (!projection || projection.shoeId === '') return true;
          return projection.shoeId !== reservation.shoeId
            || (projection.currentHandId !== null && projection.currentHandId !== reservation.handId);
        })
        .map(reservation => reservation.tableId),
    );
    const knownTableIds = new Set([
      ...this.monitorTableIds,
      ...this.liveApprovals.list(),
      ...this.orchestrator.listActors().map(actor => actor.tableId),
      ...reservations.map(reservation => reservation.tableId),
    ]);
    for (const tableId of knownTableIds) {
      if (unknownTableIds.has(tableId)) {
        this.ensureRuntimeIncident({
          code: 'unknown-execution',
          severity: 'degraded',
          tableId,
          message: `Unresolved execution result retains exposure for ${tableId}`,
        });
      } else {
        this.runtimeIncidents.resolve('unknown-execution', tableId);
      }
      if (settlementGapTableIds.has(tableId)) {
        this.ensureRuntimeIncident({
          code: 'settlement-gap',
          severity: 'degraded',
          tableId,
          message: `Unsettled execution for ${tableId} is still awaiting its exact hand settlement`,
        });
      } else if (this.orchestrator.getActor(tableId)) {
        this.runtimeIncidents.resolve('settlement-gap', tableId);
      }
    }
  }

  compactMonitorHistory(): void {
    this.ledger.pruneTransientHistory();
    this.ledger.pruneMonitorHistory();
    this.ledger.checkpoint();
  }

  private trySettleReservedOperationalHand(
    tableId: string,
    _shoeId: string,
    handId?: string,
  ): void {
    const reserved = this.orchestrator.getReservations(tableId).filter(reservation =>
      (
        reservation.status === 'RESERVED'
        || (
          reservation.status === 'UNKNOWN'
          && reservation.releaseReason === 'hand-settled-without-authoritative-outcome'
        )
      )
      && (handId === undefined || reservation.handId === handId));
    if (reserved.length === 0) return;
    const handIds = [...new Set(reserved.map(reservation => reservation.handId))];
    for (const targetHandId of handIds) {
      const { playerCards, bankerCards } = this.ledger.listHandCards(tableId, targetHandId);
      if (!isCompleteBaccaratHand(playerCards, bankerCards)) continue;
      const outcomes = pairOutcomesFromCards(playerCards, bankerCards);
      for (const reservation of reserved.filter(candidate => candidate.handId === targetHandId)) {
        this.orchestrator.recoverAcceptedHandSettlement(
          tableId,
          reservation.shoeId,
          targetHandId,
          {
            playerCards,
            bankerCards,
            ...(outcomes === undefined ? {} : { outcomes }),
          },
        );
      }
    }
  }

  private detectSettlementGap(
    event: Extract<NormalizedEvent, { type: 'bettingWindowOpened' }>,
  ): boolean {
    const unresolved = this.orchestrator.getReservations(event.tableId).filter(reservation =>
      reservation.status === 'RESERVED'
      && reservation.shoeId === event.shoeId
      && reservation.handId !== event.handId);
    if (unresolved.length === 0) return false;
    this.ensureRuntimeIncident({
      code: 'settlement-gap',
      severity: 'degraded',
      tableId: event.tableId,
      message: `New hand ${event.handId} opened with ${unresolved.length} unsettled reservation(s) from a prior hand`,
    });
    return true;
  }

  private resolveSettlementGapIfCleared(tableId: string): void {
    const actor = this.orchestrator.getActor(tableId);
    if (!actor) return;
    const currentHandId = actor.getProjection().currentHandId;
    const stillMissing = this.orchestrator.getReservations(tableId).some(reservation =>
      reservation.status === 'RESERVED'
      && currentHandId !== null
      && reservation.handId !== currentHandId);
    if (!stillMissing) this.runtimeIncidents.resolve('settlement-gap', tableId);
  }

  private bridgeRuntimeStatus(): DesktopRuntimeState['bridge'] {
    if (!this.browserBridge) {
      return {
        running: false,
        connectionCount: 0,
        authenticated: false,
      };
    }
    const status = this.browserBridge.getExtensionStatus();
    return {
      running: true,
      connectionCount: status.connectionCount,
      authenticated: status.authenticated,
      ...(status.lastSeenAt === undefined ? {} : { lastSeenAt: status.lastSeenAt }),
    };
  }

  private liveTableReasons(
    tableId: string,
    approved = true,
  ): LiveExecutionBlockReason[] {
    const actor = this.orchestrator.getActor(tableId);
    if (!actor) return ['table-feed-missing', 'physical-shoe-baseline-unknown', 'table-connection-not-restored'];
    let health: MonitorHealth | undefined;
    try {
      health = this.liveFeeds.get(tableId)?.health();
    } catch {
      health = undefined;
    }
    return evaluateLiveExecutionReadiness({
      approved,
      bridge: this.bridgeRuntimeStatus(),
      ...(health === undefined ? {} : {
        feed: {
          state: health.state,
          stalenessMs: health.stalenessMs,
        },
      }),
      maxFeedStalenessMs: MAX_LIVE_FEED_STALENESS_MS,
      projection: (() => {
        const projection = actor.peekProjection();
        const gameCount = this.tableMetadata.get(tableId)?.gameCount;
        const baseline = effectiveShoeBaseline(
          projection,
          gameCount,
          this.browserBridge?.shoeEvidence(tableId),
        );
        if (baseline === projection.shoeBaseline) return projection;
        return { ...projection, shoeBaseline: baseline };
      })(),
      hasUnknownExecution: this.orchestrator.getReservations(tableId).some(reservation => reservation.status === 'UNKNOWN'),
      hasSettlementGap: this.hasSettlementGap(tableId),
    });
  }

  private recoverCommittedUnknownSettlements(): void {
    const records = this.ledger.listOperationalWagersTail(200);
    for (const reservation of this.orchestrator.getReservations()) {
      if (reservation.status !== 'UNKNOWN') continue;
      const record = records.find(candidate => candidate.reservationId === reservation.reservationId);
      const receipt = this.ledger.getReceipt(
        reservation.tableId,
        reservation.shoeId,
        reservation.handId,
        reservation.market,
      )?.receipt;
      const committedUnknown = (
        record?.status === 'UNKNOWN'
        && record.receipt?.status === 'UNKNOWN'
        && operationalReceiptCommitStarted(record.receipt?.raw)
      ) || (
        receipt?.status === 'UNKNOWN'
        && operationalReceiptCommitStarted(receipt.raw)
      );
      if (!committedUnknown) continue;
      const settlement = this.ledger.getHandSettlement(
        reservation.tableId,
        reservation.shoeId,
        reservation.handId,
      );
      if (!settlement) continue;
      try {
        this.orchestrator.settleUnknownReservation(
          reservation.reservationId,
          {
            outcomes: settlement.outcomes,
            playerCards: settlement.playerCards,
            bankerCards: settlement.bankerCards,
          },
          'committed-hand-settled',
        );
      } catch {
        continue;
      }
      if (record === undefined || record.reconciliation !== undefined) continue;
      this.ledger.reconcileOperationalWager(record.wager.wagerId, {
        status: 'ACCEPTED',
        reason: 'committed-hand-settled',
        reconciledAt: new Date().toISOString(),
      });
    }
  }

  private operationalWagerRuntimeBlockReason(
    tableId: string,
    source?: OperationalWagerSource,
  ): string | undefined {
    const actor = this.orchestrator.getActor(tableId);
    if (actor?.snapshot().executionMode !== 'live') return undefined;
    const reasons = source === 'manual'
      ? this.manualLiveTableReasons(tableId)
      : this.keepaliveTableReasons(tableId);
    return reasons.length === 0
      ? undefined
      : `unattended-runtime-blocked:${reasons.join(',')}`;
  }

  private keepaliveTableReasons(tableId: string): LiveExecutionBlockReason[] {
    // Fail-closed (#16 / AGENTS.md): keepalive is a platform-reaching path and
    // still requires physical-shoe. Do not strip physical-shoe-baseline-unknown.
    return this.liveTableReasons(tableId);
  }

  private manualLiveTableReasons(tableId: string, approved = true): LiveExecutionBlockReason[] {
    return this.liveTableReasons(tableId, approved);
  }

  private runtimeSnapshot(): DesktopRuntimeState {
    const bridge = this.bridgeRuntimeStatus();
    const approvedLiveTableIds = [...this.monitorTableIds];
    const tables: DesktopRuntimeState['tables'] = Object.fromEntries(
      this.monitorTableIds.map(tableId => {
        const feedHealth = this.liveFeeds.get(tableId)?.health();
        const actor = this.orchestrator.getActor(tableId);
        const active = actor !== undefined
          && actor.peekExecutionMode() === 'live'
          && this.liveAuthorizationSources.has(tableId);
        const reasons = this.keepaliveTableReasons(tableId);
        const flap = this.tableFlapStats.get(tableId);
        return [tableId, {
          approved: true,
          active,
          reasons,
          linkState: this.tableLinkState(tableId, active, reasons, feedHealth?.state),
          ...(flap === undefined ? {} : {
            disconnects: flap.disconnects,
            ...(flap.lastDisconnectAt === 0 ? {} : { lastDisconnectAt: new Date(flap.lastDisconnectAt).toISOString() }),
          }),
          ...(feedHealth === undefined ? {} : {
            feedState: feedHealth.state,
            ...(feedHealth.stalenessMs === undefined ? {} : { feedStalenessMs: feedHealth.stalenessMs }),
          }),
        }];
      }),
    );
    const activeLiveTableIds = approvedLiveTableIds.filter(tableId =>
      tables[tableId]?.active === true);
    const readyLiveTableIds = approvedLiveTableIds.filter(tableId =>
      tables[tableId]?.active === true && tables[tableId]?.reasons.length === 0);
    const reasons = [...new Set(
      approvedLiveTableIds.flatMap(tableId => tables[tableId]?.reasons ?? []),
    )];
    const incidents = this.runtimeIncidents.list();
    const activeIncidents = incidents.filter(incident => incident.active);
    const globallyBlocked = activeIncidents.some(incident =>
      incident.severity === 'blocked'
      && incident.tableId === undefined);
    const allApprovedTablesUnavailable = approvedLiveTableIds.length > 0
      && readyLiveTableIds.length === 0
      && (reasons.length > 0 || activeIncidents.some(incident => incident.severity === 'blocked'));
    const blocked = globallyBlocked || allApprovedTablesUnavailable;
    const degraded = activeIncidents.length > 0
      || (readyLiveTableIds.length > 0 && readyLiveTableIds.length < approvedLiveTableIds.length);
    return {
      status: blocked ? 'blocked' : degraded ? 'degraded' : 'healthy',
      executionReady: !globallyBlocked && readyLiveTableIds.length > 0,
      monitorActive: this.liveMonitorActivated,
      approvedLiveTableIds,
      activeLiveTableIds,
      bridge,
      reasons,
      tables,
      incidents,
    };
  }

  private async setPersistentLiveGate(enabled: boolean): Promise<void> {
    if (this.persistentLiveGateEnabled === enabled) return;
    if (enabled && !this.browserBridge) throw new Error('browser bridge is not running');
    this.browserBridge?.setLiveBetEnabled(enabled);
    this.persistentLiveGateEnabled = enabled;
  }

  private async reconcileUnattendedExecution(): Promise<void> {
    await this.startupFailCloseTask;
    this.refreshAccountingIncidents();
    const selectedTableIds = this.currentMonitorTableIds();
    const approvedTableIds = this.monitorTableIds
      .filter(tableId => selectedTableIds.includes(tableId));
    for (const tableId of approvedTableIds) {
      const actor = this.orchestrator.getActor(tableId);
      if (!actor) continue;
      const reasons = this.keepaliveTableReasons(tableId);
      const authorization = this.liveAuthorizationSources.get(tableId);
      if (reasons.length > 0) {
        if (authorization === 'unattended') {
          await this.resetMonitorExecutionState(tableId);
        }
        continue;
      }

      this.runtimeIncidents.resolve('table-feed-stale', tableId);
      if (authorization === undefined) {
        await this.setPersistentLiveGate(true);
        const bridge = this.browserBridge!;
        this.setOrchestratorExecutor({ requestBet: request => bridge.requestBet(request) });
        this.setOperationalWagerExecutor(true);
        actor.setExecutionMode('live');
        this.liveAuthorizationSources.set(tableId, 'unattended');
      }
      await this.rearmPairAutomation(tableId);
    }

    const hasActiveLiveTable = this.orchestrator.listActors().some(actor =>
      actor.snapshot().executionMode === 'live'
      && this.liveAuthorizationSources.has(actor.tableId));
    if (!hasActiveLiveTable) {
      this.setOrchestratorExecutor(null);
      this.setOperationalWagerExecutor(false);
      try {
        await this.setPersistentLiveGate(false);
      } catch (error) {
        this.recordLiveMonitorError(error, 'bridge-disconnected', 'blocked');
      }
    }

    const bridge = this.bridgeRuntimeStatus();
    if (bridge.authenticated) {
      this.runtimeIncidents.resolveAll('bridge-auth-failed');
      this.runtimeIncidents.resolveAll('bridge-disconnected');
    }
    const liveApproved = approvedTableIds.filter(tableId => {
      const reasons = this.liveTableReasons(tableId);
      return !reasons.includes('table-feed-missing')
        && !reasons.includes('table-feed-disconnected')
        && !reasons.includes('table-feed-stale')
        && !reasons.includes('table-connection-not-restored');
    });
    const continuityReady = liveApproved.length > 0 || approvedTableIds.length === 0;
    if (continuityReady) this.runtimeIncidents.resolveAll('continuity-invalidated');
  }

  private handleBridgeRuntimeEvent(event: BrowserBridgeRuntimeEvent): void {
    if (this.closing) return;
    void this.enqueueExecutionStateOperation(async () => {
      switch (event.kind) {
        case 'extension-auth-failed':
          this.ensureRuntimeIncident({
            code: 'bridge-auth-failed',
            severity: 'blocked',
            message: event.reason,
          });
          return;
        case 'extension-connected':
          return;
        case 'extension-authenticated':
          this.runtimeIncidents.resolveAll('bridge-auth-failed');
          this.runtimeIncidents.resolveAll('bridge-disconnected');
          this.transportDownAt = undefined;
          this.beginRecoverySuppression();
          await this.reconcileUnattendedExecution();
          return;
        case 'executor-lease-acquired':
          console.info('[executor-lease-acquired]', JSON.stringify({
            leaseId: event.leaseId,
            profileId: event.profileId,
            reacquired: event.reacquired,
            active_executor_count: this.browserBridge?.getExecutorStatus().active_executor_count ?? 0,
          }));
          return;
        case 'executor-lease-rejected':
          console.warn('[executor-lease-rejected]', JSON.stringify({
            reason: event.reason,
            profileId: event.profileId,
            activeLeaseId: event.activeLeaseId,
            active_executor_count: this.browserBridge?.getExecutorStatus().active_executor_count ?? 0,
          }));
          return;
        case 'extension-disconnected':
          this.operationalWagers.disableKeepaliveImmediately();
          this.transportDownAt = Date.now();
          this.ensureRuntimeIncident({
            code: 'bridge-disconnected',
            severity: 'blocked',
            message: event.reason,
          });
          await this.failCloseExposedTables(this.liveApprovals.list());
          return;
        case 'continuity-invalidated':
          this.operationalWagers.disableKeepaliveImmediately();
          this.transportDownAt = Date.now();
          this.ensureRuntimeIncident({
            code: 'continuity-invalidated',
            severity: 'blocked',
            message: event.reason,
          });
          await this.failCloseExposedTables(this.liveApprovals.list());
          return;
        case 'execution-gate-revoked':
          this.operationalWagers.disableKeepaliveImmediately();
          this.persistentLiveGateEnabled = false;
          await this.failCloseLiveExecution(this.liveApprovals.list());
          return;
        case 'table-disconnected':
          this.runtimeObservedTableIds.delete(event.tableId);
          this.noteTableDisconnect(event.tableId);
          this.ensureRuntimeIncident({
            code: event.reason === 'table-feed-stale' ? 'table-feed-stale' : 'monitor-failure',
            severity: this.suppressTableDisconnectNoise(event.reason) ? 'degraded' : 'blocked',
            tableId: event.tableId,
            message: event.reason,
          });
          await this.failCloseLiveExecution([event.tableId]);
          this.scheduleDisconnectedMonitorRemoval(event.tableId, event.reason);
          return;
        case 'session-recovery-exhausted':
          this.operationalWagers.disableKeepaliveImmediately();
          this.runtimeObservedTableIds.clear();
          this.ensureRuntimeIncident({
            code: 'session-recovery-exhausted',
            severity: 'blocked',
            message: event.detail ?? 'browser session recovery attempts exhausted',
          });
          await this.failCloseLiveExecution(this.liveApprovals.list());
          return;
        case 'session-recovered':
          this.runtimeIncidents.resolveAll('session-recovery-exhausted');
          this.transportDownAt = undefined;
          this.beginRecoverySuppression();
          await this.reconcileUnattendedExecution();
          return;
        default:
          return assertNeverBridgeRuntimeEvent(event);
      }
    }).catch(error => this.recordLiveMonitorError(error, 'scheduler-failure', 'degraded'));
  }

  /** 为监控层导出的源事件与连接事件分配不冲突的账本 sourceSeq。 */
  private nextMonitorSourceSeq(tableId: string): number {
    return this.ledger.allocateSourceSeq(tableId);
  }

  private enqueueLiveMonitorOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.liveMonitorOperation.then(operation, operation);
    this.liveMonitorOperation = run.then(() => undefined, () => undefined);
    return run;
  }

  private enqueueExecutionStateOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.executionStateOperation.then(operation, operation);
    this.executionStateOperation = run.then(() => undefined, () => undefined);
    return run;
  }

  private setOrchestratorExecutor(executor: Pick<BrowserAdapter, 'requestBet'> | null): void {
    this.currentExecutor = executor;
    this.orchestrator.setExecutor(executor);
  }

  private setOperationalWagerExecutor(enabled: boolean): void {
    this.orchestrator.setOperationalExecutor(enabled ? {
      requestOperationalWager: request =>
        this.browserBridge?.requestOperationalWager(request) ?? Promise.resolve(null),
    } : null);
  }

  private currentMonitorTableIds(): readonly string[] {
    return this.pendingMonitorTableIds ?? this.monitorTableIds;
  }

  private isMonitorTableSelected(tableId: string): boolean {
    return this.currentMonitorTableIds().includes(tableId);
  }

  private isCurrentLiveFeed(tableId: string, feed: TableExport): boolean {
    return this.isObservedTable(tableId) && this.liveFeeds.get(tableId) === feed;
  }

  private isLiveTableFeedEvent(event: NormalizedEvent): boolean {
    return event.type === 'newShoeSignal'
      || event.type === 'cardObserved'
      || event.type === 'bettingWindowOpened'
      || event.type === 'bettingWindowClosed'
      || event.type === 'handSettled'
      || event.type === 'redCardSeen'
      || event.type === 'shoeInvalidated';
  }

  private async restoreDisconnectedFeed(event: NormalizedEvent): Promise<NormalizedEvent> {
    const disconnectReason = this.lastFeedDisconnectReason.get(event.tableId) ?? '';
    const resumable = disconnectReason === 'table-feed-stale'
      || disconnectReason.startsWith('continuity gap');
    if (!resumable) return event;
    const actor = this.orchestrator.getActor(event.tableId);
    if (actor?.getProjection().connectionStatus !== 'DISCONNECTED') return event;
    await this.orchestrator.enqueue(event.tableId, {
      type: 'connectionRestored',
      eventId: newId('evt'),
      tableId: event.tableId,
      timestamp: event.timestamp,
      sourceSeq: event.sourceSeq,
      source: 'room-monitor',
      schemaVersion: EVENT_SCHEMA_VERSION,
      continuityProof: cursorContinuityProof({
        tableId: event.tableId,
        reason: 'protocol-resume',
        at: event.timestamp,
      }),
    });
    this.lastFeedDisconnectReason.delete(event.tableId);
    return { ...event, sourceSeq: this.nextMonitorSourceSeq(event.tableId) };
  }

  private async enqueueMonitorEvent(event: NormalizedEvent): Promise<void> {
    if (
      event.type === 'newShoeSignal'
      || event.type === 'cardObserved'
      || event.type === 'bettingWindowOpened'
      || event.type === 'bettingWindowClosed'
      || event.type === 'handSettled'
      || event.type === 'redCardSeen'
      || event.type === 'shoeInvalidated'
    ) {
      this.cancelDisconnectedMonitorRemoval(event.tableId);
      if (event.type === 'newShoeSignal') {
        this.shuffleHoldUntilByTable.set(event.tableId, Date.now() + SHUFFLE_MONITOR_HOLD_MS);
      }
      this.runtimeObservedTableIds.add(event.tableId);
      this.runtimeIncidents.resolve('table-feed-stale', event.tableId);
      this.runtimeIncidents.resolve('monitor-failure', event.tableId);
      this.runtimeIncidents.resolve('bridge-disconnected', event.tableId);
    }
    if (event.type === 'connectionRestored') {
      this.connectedThisProcess.add(event.tableId);
      this.cancelDisconnectedMonitorRemoval(event.tableId);
      this.runtimeIncidents.resolve('table-feed-stale', event.tableId);
      this.runtimeIncidents.resolve('monitor-failure', event.tableId);
      this.runtimeIncidents.resolve('bridge-disconnected', event.tableId);
    }
    if (event.type === 'bettingWindowOpened') {
      this.connectedThisProcess.add(event.tableId);
      this.detectSettlementGap(event);
    }
    if (event.type === 'newShoeSignal' && event.baseline === 'physical-shoe') {
      this.connectedThisProcess.add(event.tableId);
    }
    if (
      (event.type === 'newShoeSignal' && event.baseline === 'physical-shoe')
      || event.type === 'bettingWindowOpened'
    ) {
      // Shuffle starts the evidence, but the table must still be monitored when
      // the new shoe actually opens. Re-promote on the first post-shuffle window
      // if a mid-shuffle demote/disconnect dropped it back to pending.
      const evidence = this.browserBridge?.shoeEvidence(event.tableId);
      if (isVerifiedPhysicalShoeEvidence(evidence)) {
        this.promotePendingTable(event.tableId, event.shoeId);
        if (event.type === 'newShoeSignal' && normalizeBgTableId(event.tableId) === undefined) {
          this.clearStaleRoadCount(event.tableId);
        }
      }
    }
    this.cachedLightSnapshot = undefined;
    const liveEvent = this.isLiveTableFeedEvent(event)
      ? await this.restoreDisconnectedFeed(event)
      : event;
    await this.orchestrator.enqueue(liveEvent.tableId, liveEvent);
    if (
      event.type === 'handSettled'
      || event.type === 'bettingWindowOpened'
      || event.type === 'cardObserved'
    ) {
      if (this.demoteIfGameCountAnomaly(event.tableId)) {
        await this.failCloseLiveExecution([event.tableId]);
      }
    }
    if (
      event.type === 'handSettled'
      || event.type === 'betReceipt'
      || event.type === 'connectionLost'
      || event.type === 'connectionRestored'
    ) {
      this.refreshAccountingIncidents(true);
    }
    if (event.type === 'cardObserved' || event.type === 'handSettled') {
      this.trySettleReservedOperationalHand(event.tableId, event.shoeId, event.handId);
    }
    if (event.type === 'bettingWindowOpened') {
      this.trySettleReservedOperationalHand(event.tableId, event.shoeId);
    }
    if (event.type === 'handSettled') {
      this.resolveSettlementGapIfCleared(event.tableId);
    }
    if (
      event.type === 'newShoeSignal'
      || event.type === 'connectionRestored'
      || (event.type === 'shoeConfirmation' && event.approved)
    ) {
      await this.rearmPairAutomation(event.tableId);
    }
    if (
      event.type === 'bettingWindowOpened'
      || event.type === 'connectionLost'
      || event.type === 'connectionRestored'
    ) {
      await this.reconcileUnattendedExecution();
    }
  }

  private async reconcilePairAutomation(enabled: boolean): Promise<void> {
    for (const tableId of this.monitorTableIds) {
      const actor = this.orchestrator.getActor(tableId);
      if (!actor) continue;
      const projection = actor.getProjection();
      if (!enabled) {
        if (projection.autoBetStatus !== 'DISARMED') {
          await actor.setAutoBet(false, projection.shoeId || undefined, 'auto-bet-paused');
        }
        continue;
      }
      await this.rearmPairAutomation(tableId);
    }
  }

  private async rearmPairAutomation(tableId: string): Promise<void> {
    if (!this.automationEnabled || !this.monitorTableIds.includes(tableId)) return;
    const actor = this.orchestrator.getActor(tableId);
    if (!actor) return;
    const projection = actor.getProjection();
    const gameCount = this.tableMetadata.get(tableId)?.gameCount;
    const canArm = projection.autoBetStatus === 'DISARMED'
      && effectiveShoeBaseline(projection, gameCount, this.browserBridge?.shoeEvidence(tableId)) === 'physical-shoe'
      && projection.connectionStatus === 'CONNECTED'
      && !this.orchestrator.getReservations(tableId).some(reservation => reservation.status === 'UNKNOWN')
      && !projection.sealed
      && (projection.status === 'TRACKING'
        || projection.status === 'BETTING_WINDOW'
        || projection.status === 'PENDING_SETTLEMENT');
    if (canArm) await actor.setAutoBet(true, projection.shoeId || undefined);
  }

  private async applyKeepaliveSettings(settings: KeepaliveSettings): Promise<void> {
    await this.operationalWagers.updateKeepalive(settings);
  }

  private recordLiveMonitorError(
    error: unknown,
    code: RuntimeIncidentCode = 'monitor-failure',
    severity: RuntimeIncidentSeverity = 'degraded',
    tableId?: string,
  ): void {
    this.demoError = error instanceof Error ? error.message : String(error);
    this.ensureRuntimeIncident({
      code,
      severity,
      message: this.demoError,
      ...(tableId === undefined ? {} : { tableId }),
    });
  }

  private async resetMonitorExecutionState(tableId: string): Promise<void> {
    const actor = this.orchestrator.getActor(tableId);
    if (!actor) return;

    const state = actor.snapshot();
    if (state.executionMode !== 'live') {
      actor.setExecutionMode('live');
    }
    this.liveAuthorizationSources.delete(tableId);
    if (state.projection.autoBetStatus === 'ARMED') {
      await actor.setAutoBet(false, state.projection.shoeId || undefined, 'execution-reset');
    }
  }

  /**
   * 分级断联：传输抖动只冻结真正有 live 敞口的桌。
   * 有 live 授权或 RESERVED/UNKNOWN 在途预留的桌才 fail-close；
   * 其余监控桌只进入 DEGRADED（暂停新单），保留观察记录、武装状态与授权。
   */
  private hasLiveExposure(tableId: string): boolean {
    if (this.liveAuthorizationSources.has(tableId)) return true;
    try {
      return this.orchestrator.getReservations(tableId).some(reservation =>
        reservation.status === 'RESERVED' || reservation.status === 'UNKNOWN');
    } catch {
      return false;
    }
  }

  private failCloseExposedTables(tableIds: readonly string[]): Promise<void> {
    return this.failCloseLiveExecution(tableIds.filter(tableId => this.hasLiveExposure(tableId)));
  }

  private noteTableDisconnect(tableId: string, now = Date.now()): void {
    const stats = this.tableFlapStats.get(tableId) ?? {
      disconnects: 0,
      lastDisconnectAt: 0,
      recentDisconnectAt: [],
    };
    const recent = [...(stats.recentDisconnectAt ?? []), now].filter(at => now - at < 300_000);
    stats.recentDisconnectAt = recent;
    stats.disconnects = recent.length;
    stats.lastDisconnectAt = now;
    this.tableFlapStats.set(tableId, stats);
  }

  private noteTableRecovered(tableId: string): void {
    const stats = this.tableFlapStats.get(tableId);
    if (stats !== undefined) stats.lastRecoveredAt = Date.now();
  }

  private flapEscalated(tableId: string, now = Date.now()): boolean {
    const stats = this.tableFlapStats.get(tableId);
    if (stats === undefined) return false;
    const recent = (stats.recentDisconnectAt ?? []).filter(at => now - at < 300_000);
    return recent.length >= 4;
  }

  private beginRecoverySuppression(windowMs = 60_000): void {
    this.recoverySuppressUntil = Math.max(this.recoverySuppressUntil, Date.now() + windowMs);
  }

  private suppressTableDisconnectNoise(reason?: string): boolean {
    if (Date.now() >= this.recoverySuppressUntil) return false;
    return reason === 'table-feed-stale' || reason === 'browser-extension-disconnected';
  }


  /** 按桌链路状态机，供 UI 做恢复清单展示。 */
  private tableLinkState(tableId: string, active: boolean, reasons: readonly string[], feedState?: string): 'live' | 'degraded' | 'resyncing' | 'offline' {
    if (active && reasons.length === 0) return 'live';
    if (feedState === 'DISCONNECTED') return 'offline';
    const actor = this.orchestrator.getActor(tableId);
    if (feedState === undefined) return 'resyncing';
    if (actor?.getProjection().connectionStatus !== 'CONNECTED') return 'resyncing';
    return 'degraded';
  }

  private async failCloseLiveExecution(tableIds: readonly string[]): Promise<void> {
    for (const tableId of tableIds) {
      await this.resetMonitorExecutionState(tableId);
    }

    const hasLiveTable = this.orchestrator.listActors()
      .some(actor => actor.snapshot().executionMode === 'live'
        && this.liveAuthorizationSources.has(actor.tableId));
    if (hasLiveTable) return;

    this.liveExecutionMode = 'live';
    this.setOrchestratorExecutor(null);
    this.setOperationalWagerExecutor(false);
    try {
      await this.setPersistentLiveGate(false);
    } catch (error) {
      this.recordLiveMonitorError(error, 'bridge-disconnected', 'blocked');
    }
  }

  private async stopLiveFeed(tableId: string, feed: TableExport): Promise<void> {
    this.cancelDisconnectedMonitorRemoval(tableId);
    if (this.liveFeeds.get(tableId) === feed) {
      this.liveFeeds.delete(tableId);
      this.liveRoomIdsByTable.delete(tableId);
    }
    this.runtimeObservedTableIds.delete(tableId);
    this.resolveTransientTableIncidents(tableId);
    await this.failCloseLiveExecution([tableId]);
    try {
      await feed.stop();
    } catch (error) {
      this.recordLiveMonitorError(error, 'monitor-failure', 'degraded', tableId);
    }
    await this.resetMonitorExecutionState(tableId);
  }

  /**
   * Strict shutdown used only while changing the selected monitor tables.
   * Retain the old feed until stop succeeds, so a failed transition neither
   * changes the Bridge selection nor creates a duplicate replacement export.
   */
  private async stopLiveFeedForTransition(
    tableId: string,
    feed: TableExport,
  ): Promise<MonitorFeedTransitionStopResult> {
    if (this.liveFeeds.get(tableId) !== feed) return { kind: 'not-current' };
    this.cancelDisconnectedMonitorRemoval(tableId);
    try {
      await this.failCloseLiveExecution([tableId]);
    } catch (error) {
      return { kind: 'failed', error };
    }
    try {
      await feed.stop();
    } catch (error) {
      return { kind: 'failed', error };
    }
    if (this.liveFeeds.get(tableId) === feed) {
      this.liveFeeds.delete(tableId);
      this.liveRoomIdsByTable.delete(tableId);
    }
    this.runtimeObservedTableIds.delete(tableId);
    this.resolveTransientTableIncidents(tableId);
    return { kind: 'stopped' };
  }

  private cancelDisconnectedMonitorRemoval(tableId: string): void {
    const timer = this.disconnectedMonitorRemovalTimers.get(tableId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.disconnectedMonitorRemovalTimers.delete(tableId);
  }

  private scheduleDisconnectedMonitorRemoval(tableId: string, reason?: string): void {
    if (this.closing || !this.monitorTableIds.includes(tableId)) return;
    const startupGap = reason === 'table-not-discovered'
      || reason === 'process-restarted'
      || reason === 'extension-session-restarted'
      || reason === 'browser-extension-disconnected'
      || reason === 'table-feed-stale'
      || reason === undefined
      || reason === '';
    if (startupGap && !this.connectedThisProcess.has(tableId)) return;
    if (this.liveMonitorStartedAt > 0 && Date.now() - this.liveMonitorStartedAt < 60_000) return;
    const shuffleHoldUntil = this.shuffleHoldUntilByTable.get(tableId) ?? 0;
    if (Date.now() < shuffleHoldUntil) return;
    if (reason === 'table-not-discovered') {
      this.noteTableDisconnect(tableId);
      if (!this.browserBridge?.getExtensionStatus().authenticated) return;
    }
    // Multi-table pages reconnect the game socket often. A stale/disconnected
    // feed must stay in the monitor list so the export can resume; dropping
    // the table is what leaves the console stuck on 数据流已断开 / 已过期.
    // Chronic flappers (4+ disconnects in 5 minutes) escalate to OPEN: schedule
    // removal so a permanently dead table does not occupy the monitor list forever.
    if (!this.flapEscalated(tableId) && (
      reason === 'table-feed-stale'
      || reason === 'browser-extension-disconnected'
      || reason === 'process-restarted'
      || reason === 'extension-session-restarted'
    )) return;
    if (this.disconnectedMonitorRemovalTimers.has(tableId)) return;
    const delayMs = DISCONNECTED_MONITOR_REMOVAL_MS;
    const timer = setTimeout(() => {
      this.disconnectedMonitorRemovalTimers.delete(tableId);
      void this.enqueueLiveMonitorOperation(async () => {
        await this.removeDisconnectedMonitorTable(tableId);
      }).catch(error => this.recordLiveMonitorError(error, 'monitor-failure', 'degraded', tableId));
    }, delayMs);
    timer.unref?.();
    this.disconnectedMonitorRemovalTimers.set(tableId, timer);
  }

  private async removeDisconnectedMonitorTable(tableId: string): Promise<void> {
    if (!this.monitorTableIds.includes(tableId)) return;
    const shuffleHoldUntil = this.shuffleHoldUntilByTable.get(tableId) ?? 0;
    if (Date.now() < shuffleHoldUntil) return;
    const feed = this.liveFeeds.get(tableId);
    const health = feed?.health();
    const shouldRemove = feed === undefined
      || health?.state === 'DISCONNECTED'
      || (typeof health?.stalenessMs === 'number' && health.stalenessMs >= DISCONNECTED_MONITOR_REMOVAL_MS);
    if (!shouldRemove) return;

    if (feed !== undefined) await this.stopLiveFeed(tableId, feed);
    await this.failCloseLiveExecution([tableId]);
    const nextTableIds = this.monitorTableIds.filter(candidate => candidate !== tableId);
    this.monitorTableIds = nextTableIds;
    this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: nextTableIds });
    this.syncLiveApprovalsToMonitorTables();
    this.browserBridge?.setSelectedTableIds(this.observedTableIds());
  }

  private resolveTransientTableIncidents(tableId: string): void {
    this.runtimeIncidents.resolve('table-feed-stale', tableId);
    this.runtimeIncidents.resolve('monitor-failure', tableId);
    this.runtimeIncidents.resolve('bridge-disconnected', tableId);
  }


  private seedBgShoeSequencesFromLedger(): void {
    this.browserBridge?.seedBgShoeSequences(this.ledger.listBgShoeGenerations());
  }

  async startBrowserBridge(port = 17890): Promise<{ port: number }> {
    if (!this.browserBridge) {
      const bridge = new BrowserBridgeServer({
        port,
        selectedTableIds: this.monitorTableIds,
        requireExtensionSequence: true,
        allowedExtensionIds: [...BUNDLED_BROWSER_EXTENSION_IDS],
        extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
        onRuntimeEvent: event => this.handleBridgeRuntimeEvent(event),
      });
      const hostClaim = bridge.claimHostExecutionChannel('desktop-primary');
      if (!hostClaim.ok) {
        throw new Error(`parallel Electron execution channel rejected: ${hostClaim.activeChannelId}`);
      }
      this.browserBridgePort = await bridge.start();
      this.browserBridge = bridge;
      this.seedBgShoeSequencesFromLedger();
    }
    return { port: this.browserBridgePort };
  }

  async stopBrowserBridge(): Promise<void> {
    await this.enqueueExecutionStateOperation(() => this.stopBrowserBridgeInner());
  }

  private async stopBrowserBridgeInner(): Promise<void> {
    const bridge = this.browserBridge;
    if (!bridge) return;
    try {
      bridge.setLiveBetEnabled(false);
      this.persistentLiveGateEnabled = false;
    } catch (error) {
      this.recordLiveMonitorError(error, 'bridge-disconnected', 'blocked');
    }
    await bridge.close();
    this.browserBridge = undefined;
    this.browserBridgePort = 0;
    this.liveAuthorizationSources.clear();
    this.transportDownAt = undefined;
    this.recoverySuppressUntil = 0;
    this.setOrchestratorExecutor(null);
    this.setOperationalWagerExecutor(false);
  }

  browserBridgeStatus(): { running: boolean; port: number; rooms: RoomDescriptor[] } {
    if (!this.browserBridge) {
      return { running: false, port: 0, rooms: [] };
    }
    return {
      running: true,
      port: this.browserBridge.getPort(),
      rooms: this.browserBridge.getRooms(),
    };
  }

  async startLiveRoomMonitor(port = 17890, _executionMode: ExecutionMode = 'live'): Promise<{ port: number }> {
    return this.enqueueExecutionStateOperation(() => this.startLiveRoomMonitorInner(port));
  }

  private async startLiveRoomMonitorInner(port: number): Promise<{ port: number }> {
    await this.startupFailCloseTask;
    const startsNewMonitorSession = !this.liveMonitorActivated;
    this.liveMonitorActivated = true;
    if (startsNewMonitorSession) this.liveMonitorStartedAt = Date.now();
    this.liveExecutionMode = 'live';
    this.ensureMonitorActors(this.monitorTableIds);
    this.setOrchestratorExecutor(null);
    this.setOperationalWagerExecutor(false);
    const started = await this.startBrowserBridge(port);
    if (startsNewMonitorSession) {
      this.runtimeObservedTableIds.clear();
      this.browserBridge?.beginMonitorSession();
      this.seedBgShoeSequencesFromLedger();
    }
    this.ensureLiveMonitorTimer();
    try {
      await this.attachLiveTables();
    } catch (error) {
      // Initial discovery is transient while the browser page/extension is reconnecting.
      // Keep the live monitor active and let the established retry timer attach selected tables.
      this.recordLiveMonitorError(error, 'monitor-failure', 'degraded');
    }
    await this.reconcileUnattendedExecution();
    return started;
  }

  private ensureLiveMonitorTimer(): void {
    if (this.liveRoomTimer) return;
    this.scheduleLiveMonitorRetry(LIVE_MONITOR_RETRY_DELAYS_MS[0]);
  }

  private scheduleLiveMonitorRetry(delayMs: number): void {
    if (this.liveRoomTimer || !this.liveMonitorActivated) return;
    this.liveRoomTimer = setTimeout(() => {
      this.liveRoomTimer = undefined;
      void this.runLiveMonitorRetry();
    }, delayMs);
    this.liveRoomTimer.unref?.();
  }

  private async runLiveMonitorRetry(): Promise<void> {
    if (!this.liveMonitorActivated) return;
    try {
      await this.attachLiveTables();
      await this.enqueueExecutionStateOperation(() => this.reconcileUnattendedExecution());
      this.liveMonitorRetryAttempt = 0;
      this.runtimeIncidents.resolveAll('scheduler-failure');
      this.runtimeIncidents.resolveAll('monitor-failure');
    } catch (error) {
      this.liveMonitorRetryAttempt += 1;
      this.recordLiveMonitorError(error, 'scheduler-failure', 'degraded');
    } finally {
      const attached = this.monitorTableIds.length > 0
        && this.monitorTableIds.every(tableId => this.liveFeeds.has(tableId));
      const delay = attached
        ? 15_000
        : LIVE_MONITOR_RETRY_DELAYS_MS[
          Math.min(this.liveMonitorRetryAttempt, LIVE_MONITOR_RETRY_DELAYS_MS.length - 1)
        ];
      this.scheduleLiveMonitorRetry(delay);
    }
  }

  async stopLiveRoomMonitor(): Promise<void> {
    await this.enqueueExecutionStateOperation(() => this.stopLiveRoomMonitorInner());
  }

  private async stopLiveRoomMonitorInner(): Promise<void> {
    if (this.liveRoomTimer) {
      clearTimeout(this.liveRoomTimer);
      this.liveRoomTimer = undefined;
    }
    for (const timer of this.disconnectedMonitorRemovalTimers.values()) clearTimeout(timer);
    this.disconnectedMonitorRemovalTimers.clear();
    this.liveMonitorActivated = false;
    this.liveMonitorRetryAttempt = 0;
    this.transportDownAt = undefined;
    this.recoverySuppressUntil = 0;
    this.runtimeObservedTableIds.clear();
    await this.enqueueLiveMonitorOperation(async () => {
      const feedEntries = [...this.liveFeeds];
      const failClosedTableIds = new Set(feedEntries.map(([tableId]) => tableId));
      for (const actor of this.orchestrator.listActors()) {
        if (actor.snapshot().executionMode === 'live') failClosedTableIds.add(actor.tableId);
      }
      await this.failCloseLiveExecution([...failClosedTableIds]);
      for (const [tableId, feed] of feedEntries) {
        await this.stopLiveFeed(tableId, feed);
      }
      this.liveExecutionMode = 'live';
      this.setOrchestratorExecutor(null);
      this.setOperationalWagerExecutor(false);
    });
  }

  private attachLiveTables(): Promise<void> {
    return this.enqueueLiveMonitorOperation(() => this.attachLiveTablesInner());
  }

  private async attachLiveTablesInner(): Promise<void> {
    const browserBridge = this.browserBridge;
    if (!browserBridge) return;
    const discoveredRooms = browserBridge.getDiscoveredRooms();
    this.refreshTableMetadataFromRooms(discoveredRooms);
    if (this.liveMonitorActivated && !this.suppressDiscoveredMonitorAutoAdd) {
      this.promotePendingTablesFromRooms(discoveredRooms);
    }
    browserBridge.setSelectedTableIds(this.observedTableIds());
    if (
      this.monitorTableIds.length === 0
      && this.pendingJoinTableIds().length === 0
      && !browserBridge.hasRuntimeTableSelection()
      && !browserBridge.hasConfiguredTableSelection()
    ) return;

    const rooms = await browserBridge.discoverRooms();
    this.refreshTableMetadataFromRooms(rooms);
    if (this.liveMonitorActivated && !this.suppressDiscoveredMonitorAutoAdd) {
      this.promotePendingTablesFromRooms(rooms);
    }
    const discoveredTableIds = discoveredMonitorTableIds([...discoveredRooms, ...rooms]);
    const discoveryReliable = browserBridge.getExtensionStatus().authenticated
      && discoveredTableIds.size > 0;
    for (const tableId of this.monitorTableIds) {
      if (discoveredTableIds.has(tableId) || this.liveFeeds.has(tableId)) {
        this.cancelDisconnectedMonitorRemoval(tableId);
      } else if (
        discoveryReliable
        && !isVerifiedPhysicalShoeEvidence(this.browserBridge?.shoeEvidence(tableId))
      ) {
        this.scheduleDisconnectedMonitorRemoval(tableId, 'table-not-discovered');
      } else {
        this.cancelDisconnectedMonitorRemoval(tableId);
      }
    }
    const selectedTableIds = new Set(this.observedTableIds());
    this.browserBridge?.setSelectedTableIds([...selectedTableIds]);
    for (const room of rooms) {
      for (const table of room.tables) {
        // The service is the final allowlist boundary; never rely solely on a bridge cache.
        if (!selectedTableIds.has(table.tableId) || !this.isObservedTable(table.tableId)) continue;
        if (this.liveFeeds.has(table.tableId)) continue;
        if (!this.orchestrator.getActor(table.tableId)) {
          const settings = this.currentUnifiedTableSettings();
          const profile = defaultProfile(table.tableId);
          const merged = table.profile === undefined
            ? profile
            : { ...profile, ...table.profile, tableId: table.tableId };
          this.orchestrator.registerTable(
            settings === undefined
              ? merged
              : {
                  ...merged,
                  minEV: settings.minEV,
                  betTiers: settings.betTiers.map(tier => ({ ...tier })),
                },
            this.liveExecutionMode,
            settings?.defaultBetAmount ?? 100,
          );
        }
        this.cancelDisconnectedMonitorRemoval(table.tableId);
        await this.resetMonitorExecutionState(table.tableId);

        const feed = browserBridge.openTable(room.roomId, table.tableId);
        this.liveRoomIdsByTable.set(table.tableId, room.roomId);
        this.liveFeeds.set(table.tableId, feed);
        try {
          await feed.start({
            onBatch: async batch => {
              if (!this.isCurrentLiveFeed(table.tableId, feed)) return;
              for (const event of batch.events) {
                if (event.tableId !== table.tableId || !this.isCurrentLiveFeed(table.tableId, feed)) continue;
                const sourceSeq = this.nextMonitorSourceSeq(event.tableId);
                if (!this.isCurrentLiveFeed(table.tableId, feed)) continue;
                void this.enqueueMonitorEvent({ ...event, sourceSeq })
                  .catch(error => this.recordLiveMonitorError(error, 'monitor-failure', 'degraded', event.tableId));
              }
            },
            onDisconnect: (tableId, reason) => {
              if (!this.isCurrentLiveFeed(tableId, feed)) return;
              this.lastFeedDisconnectReason.set(tableId, reason ?? '');
              this.runtimeObservedTableIds.delete(tableId);
              // BridgeTableExport performs its own reconnect. Keep the identity
              // registered while it is disconnected: deleting it would make the
              // periodic attach call start() on the same already-started export.
              void this.enqueueExecutionStateOperation(async () => {
                const health = this.liveFeeds.get(tableId)?.health();
                if (health?.state === 'CONNECTED') return;
                if (reason === 'table-feed-stale') {
                  this.ensureRuntimeIncident({
                    code: 'table-feed-stale',
                    severity: 'blocked',
                    tableId,
                    message: reason,
                  });
                }
                await this.failCloseLiveExecution([tableId]);
                this.scheduleDisconnectedMonitorRemoval(tableId, reason);
                const sourceSeq = this.nextMonitorSourceSeq(tableId);
                await this.enqueueMonitorEvent({
                  type: 'connectionLost',
                  eventId: newId('evt'),
                  tableId,
                  timestamp: new Date().toISOString(),
                  sourceSeq,
                  source: 'room-monitor',
                  schemaVersion: EVENT_SCHEMA_VERSION,
                  ...(reason ? { reason } : {}),
                });
              }).catch(error => this.recordLiveMonitorError(error, 'monitor-failure', 'degraded', tableId));
            },
            onRestored: async (tableId, proof) => {
              if (!this.isCurrentLiveFeed(tableId, feed)) return;
              this.cancelDisconnectedMonitorRemoval(tableId);
              this.noteTableRecovered(tableId);
              const sourceSeq = this.nextMonitorSourceSeq(tableId);
              await this.enqueueMonitorEvent({
                type: 'connectionRestored',
                eventId: newId('evt'),
                tableId,
                timestamp: new Date().toISOString(),
                sourceSeq,
                source: 'room-monitor',
                schemaVersion: EVENT_SCHEMA_VERSION,
                continuityProof: proof,
              }).catch(error => this.recordLiveMonitorError(error, 'monitor-failure', 'degraded', tableId));
            },
          });
          if (!this.isCurrentLiveFeed(table.tableId, feed)) {
            await this.stopLiveFeed(table.tableId, feed);
            continue;
          }
        } catch (error) {
          if (this.liveFeeds.get(table.tableId) === feed) {
            this.liveFeeds.delete(table.tableId);
            this.liveRoomIdsByTable.delete(table.tableId);
          }
          this.runtimeObservedTableIds.delete(table.tableId);
          try {
            await feed.stop();
          } catch (stopError) {
            this.recordLiveMonitorError(stopError, 'monitor-failure', 'degraded', table.tableId);
          }
          throw error;
        }
      }
    }
  }

  isOpen(): boolean {
    return this.ledger.isOpen();
  }

  private monitorCandidates(): MonitorTableCandidate[] {
    const discovered = this.browserBridge?.getDiscoveredRooms() ?? [];
    const candidates = new Map<string, MonitorTableCandidate>();
    for (const room of discovered) {
      for (const table of room.tables) {
        const previous = candidates.get(table.tableId);
        candidates.set(table.tableId, {
          roomId: previous?.roomId ?? room.roomId,
          tableId: table.tableId,
          ...(previous?.roomName !== undefined || room.displayName !== undefined
            ? { roomName: room.displayName ?? previous?.roomName ?? '' }
            : {}),
          ...(previous?.displayName !== undefined || table.displayName !== undefined
            ? { displayName: table.displayName ?? previous?.displayName ?? '' }
            : {}),
          ...(previous?.roundId !== undefined || table.roundId !== undefined
            ? { roundId: table.roundId ?? previous?.roundId ?? '' }
            : {}),
          ...(previous?.gameCount !== undefined || table.gameCount !== undefined
            ? { gameCount: table.gameCount ?? previous?.gameCount ?? 0 }
            : {}),
        });
      }
    }
    return [...candidates.values()].sort((left, right) =>
      left.tableId.localeCompare(right.tableId, undefined, { numeric: true }),
    );
  }

  private tableMetadataSnapshot(monitorCandidates: readonly MonitorTableCandidate[]): MonitorTableCandidate[] {
    const metadata = new Map<string, MonitorTableCandidate>(
      monitorCandidates.map(candidate => [candidate.tableId, candidate]),
    );
    for (const table of this.tableMetadata.values()) {
      const previous = metadata.get(table.tableId);
      if (previous !== undefined) {
        metadata.set(table.tableId, {
          roomId: previous.roomId,
          tableId: previous.tableId,
          ...(previous.roomName !== undefined || table.roomName !== undefined
            ? { roomName: previous.roomName ?? table.roomName ?? '' }
            : {}),
          ...(previous.displayName !== undefined || table.displayName !== undefined
            ? { displayName: previous.displayName ?? table.displayName ?? '' }
            : {}),
          ...(previous.roundId !== undefined || table.roundId !== undefined
            ? { roundId: previous.roundId ?? table.roundId ?? '' }
            : {}),
          ...(this.observedGameCount(table.tableId, previous.gameCount ?? table.gameCount) === undefined
            ? {}
            : { gameCount: this.observedGameCount(table.tableId, previous.gameCount ?? table.gameCount) }),
        });
        continue;
      }
      metadata.set(table.tableId, {
        roomId: table.roomId,
        ...(table.roomName === undefined ? {} : { roomName: table.roomName }),
        tableId: table.tableId,
        ...(table.displayName === undefined ? {} : { displayName: table.displayName }),
        ...(table.roundId === undefined ? {} : { roundId: table.roundId }),
        ...(table.gameCount === undefined ? {} : { gameCount: table.gameCount }),
      });
    }
    return [...metadata.values()];
  }

  private recordCounts(tableIds: readonly string[] | undefined): DesktopRecordCounts {
    const scope = tableIds === undefined ? { page: 1, pageSize: 1 } : { page: 1, pageSize: 1, tableIds };
    return {
      events: this.ledger.listEventsPage(scope).total,
      decisions: this.ledger.listDecisionHandsPage(scope).total,
      ledger: this.ledger.listReservationsPage(scope).total,
    };
  }

  private displayedTableIds(fullSnapshot: OrchestratorSnapshot): string[] {
    if (!this.liveMonitorActivated) return Object.keys(fullSnapshot.tables);
    const demoTableIds = this.demoRunning
      ? Object.keys(fullSnapshot.tables)
        .filter(tableId => !this.monitorTableIds.includes(tableId))
      : [];
    return [...this.monitorTableIds, ...demoTableIds];
  }

  snapshot(options: DesktopSnapshotOptions = {}): DesktopConsoleSnapshot {
    const includeHistory = options.includeHistory !== false;
    const lightKey = includeHistory
      ? ''
      : JSON.stringify({
        counts: options.includeRecordCounts !== false,
        summary: options.includeSummary !== false,
        tableId: options.tableId ?? '',
        fromTime: options.fromTime ?? '',
        toTime: options.toTime ?? '',
      });
    if (
      lightKey
      && this.cachedLightSnapshot
      && this.cachedLightSnapshot.key === lightKey
      && Date.now() - this.cachedLightSnapshot.at < 500
    ) {
      return this.cachedLightSnapshot.value;
    }
    if (!lightKey) this.cachedLightSnapshot = undefined;
    const fullSnapshot = this.orchestrator.snapshot();
    const usingLiveMonitor = this.liveMonitorActivated;
    const displayedTableIds = this.displayedTableIds(fullSnapshot);
    const activeTableIds = new Set(displayedTableIds);
    const shoeEvidence: Record<string, DesktopShoeEvidence> = {};
    const tables = Object.fromEntries(
      displayedTableIds.flatMap(tableId => {
        const table = fullSnapshot.tables[tableId];
        if (table === undefined) return [];
        const gameCount = this.tableMetadata.get(tableId)?.gameCount;
        const explained = explainShoeBaseline(
          table.projection,
          gameCount,
          this.browserBridge?.shoeEvidence(tableId),
        );
        shoeEvidence[tableId] = {
          reason: explained.evidence.reason,
          label: shoeBaselineReasonLabel(explained.evidence),
          ...(explained.evidence.previousGameCount === undefined
            ? {}
            : { previousGameCount: explained.evidence.previousGameCount }),
          ...(explained.evidence.gameCount === undefined ? {} : { gameCount: explained.evidence.gameCount }),
        };
        const next = explained.baseline === table.projection.shoeBaseline
          ? table
          : { ...table, projection: { ...table.projection, shoeBaseline: explained.baseline } };
        return [[tableId, next]];
      }),
    );
    const snapshot: OrchestratorSnapshot = { ...fullSnapshot, tables };
    const filterToDisplayedTables = <T extends { tableId: string }>(rows: readonly T[]): T[] =>
      usingLiveMonitor ? rows.filter(row => activeTableIds.has(row.tableId)) : [...rows];
    const keepalive = this.operationalWagers.getKeepaliveState();
    const events = includeHistory
      ? this.ledger.listEvents()
      : this.ledger.listRecentDisplayEventsForTables(displayedTableIds, 24);
    const decisions = includeHistory ? this.ledger.listDecisions() : [];
    const receipts = includeHistory ? this.ledger.listReceipts() : [];
    const reservations = includeHistory ? this.orchestrator.getReservations() : [];
    const monitorCandidates = this.monitorCandidates();
    const tableMetadata = this.tableMetadataSnapshot(monitorCandidates);
    const scopedTableIds = usingLiveMonitor ? displayedTableIds : undefined;
    const now = Date.now();
    const recordCounts = options.includeRecordCounts === false
      ? (this.cachedRecordCounts ?? EMPTY_RECORD_COUNTS)
      : (this.cachedRecordCounts = this.recordCounts(scopedTableIds));
    const summary = options.includeSummary === false
      ? (this.cachedSummary ?? EMPTY_MONITOR_SUMMARY)
      : (this.cachedSummary = this.ledger.getMonitorSummary(usingLiveMonitor ? { ...options, tableIds: displayedTableIds } : options));
    const result: DesktopConsoleSnapshot = {
      dbPath: this.dbPath,
      isOpen: this.ledger.isOpen(),
      seed: this.lastSeed,
      snapshot,
      monitorTableIds: [...this.monitorTableIds],
      monitorCandidates,
      tableMetadata,
      shoeEvidence,
      recordCounts,
      keepalive,
      automation: { enabled: this.automationEnabled },
      runtime: this.runtimeSnapshot(),
      operationalWagers: includeHistory ? this.ledger.listOperationalWagersTail() : [],
      events: filterToDisplayedTables(events),
      decisions: filterToDisplayedTables(decisions),
      receipts: filterToDisplayedTables(receipts),
      reservations: filterToDisplayedTables(reservations),
      demoRunning: this.demoRunning,
      demoSpeed: this.demoSpeed,
      summary: {
        ...summary,
        rows: summary.rows.filter(row => activeTableIds.has(row.tableId)),
      },
      demoError: this.demoError,
    };
    if (lightKey) this.cachedLightSnapshot = { key: lightKey, at: now, value: result };
    return result;
  }

  async runDemo(seed?: number): Promise<DesktopConsoleSnapshot> {
    if (this.demoRunning) throw new Error('demo stream is already running');
    this.demoRunning = true;
    this.demoStopRequested = false;
    this.demoError = undefined;
    try {
      return await this.runDemoInner(seed);
    } finally {
      this.demoRunning = false;
    }
  }

  async startDemo(seed?: number): Promise<DesktopConsoleSnapshot> {
    if (this.demoRunning) return this.snapshot();
    this.demoRunning = true;
    this.demoStopRequested = false;
    this.demoError = undefined;
    this.demoTask = this.runContinuousDemo(seed)
      .catch(error => {
        this.demoError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.demoRunning = false;
        this.demoTask = null;
      });
    return this.snapshot();
  }

  async stopDemo(): Promise<DesktopConsoleSnapshot> {
    this.demoStopRequested = true;
    if (this.demoTask) await this.demoTask;
    return this.snapshot();
  }

  setDemoSpeed(speed: number): DesktopConsoleSnapshot {
    if (!Number.isInteger(speed) || speed < 1 || speed > 10) {
      throw new RangeError('demo speed must be an integer from 1 to 10');
    }
    this.demoSpeed = speed;
    return this.snapshot();
  }

  private async runContinuousDemo(seed?: number): Promise<void> {
    let nextSeed = seed;
    while (!this.demoStopRequested) {
      await this.runDemoInner(nextSeed, true);
      nextSeed = undefined;
      if (!this.demoStopRequested) await wait(DEMO_PAUSE_MS / this.demoSpeed);
    }
  }

  private async runDemoInner(seed?: number, paced = false): Promise<DesktopConsoleSnapshot> {
      const sessionStartedAt = new Date();
      const demo = buildRandomDemo(seed, newId('demo'));
      const shoeIds = buildShoeIdMap(demo, this.ledger, sessionStartedAt);
      this.lastSeed = demo.seed;
      const amounts = { [demo.profiles[0].tableId]: 100, [demo.profiles[1].tableId]: 80 } as const;
      const configuredProfiles = new Map<string, TableProfile>();
      for (const profile of demo.profiles) {
        const existingActor = this.orchestrator.getActor(profile.tableId);
        const existingProfile = existingActor?.getProfile();
        const effectiveProfile: TableProfile = {
          ...profile,
          minEV: existingProfile?.minEV ?? profile.minEV,
          betTiers: existingProfile?.betTiers ?? profile.betTiers,
          monitorUrl: existingProfile?.monitorUrl ?? profile.monitorUrl,
        };
        const defaultBetAmount = existingActor?.snapshot().defaultBetAmount
          ?? amounts[profile.tableId as keyof typeof amounts]
          ?? 100;
        configuredProfiles.set(profile.tableId, effectiveProfile);
        this.orchestrator.registerTable(effectiveProfile, 'simulated', defaultBetAmount);
      }

      // 监控层使用“源内局部序号”做游标/缺口检测；账本 sourceSeq 由消费方在导出时按账本水位分配。
      const streams = new Map<string, NormalizedEvent[]>();
      for (const profile of demo.profiles) {
        const tableId = profile.tableId;
        const effectiveProfile = configuredProfiles.get(tableId)!;
        const stream = demo.streams[tableId].map(event => {
          const remappedEvent = remapDemoEvent(event, tableId, shoeIds, sessionStartedAt);
          return remappedEvent.type === 'newShoeSignal'
            ? { ...remappedEvent, profile: effectiveProfile }
            : remappedEvent;
        });
        streams.set(tableId, stream);
      }

      const room = {
        roomId: 'demo-room',
        displayName: 'Demo Room',
        tables: [...configuredProfiles].map(([tableId, profile]) => ({
          tableId,
          profile,
          events: streams.get(tableId)!,
          monitorUrl: profile.monitorUrl,
          maxBatchSize: paced ? 1 : 20,
          latencyMs: paced ? DEMO_EVENT_INTERVAL_MS / this.demoSpeed : 0,
        })),
      };
      const monitor = new ShadowRoomMonitor({ rooms: [room] });
      const feeds: TableExport[] = [];
      const previousExecutor = this.currentExecutor;
      this.setOrchestratorExecutor(new SimulatedAdapter({ events: [] }));
      try {
        const rooms = await monitor.discoverRooms();
        for (const table of rooms[0].tables) {
          let feed: TableExport;
          feed = monitor.openTable(room.roomId, table.tableId);
          await feed.start({
            onBatch: async batch => {
              if (this.demoStopRequested) {
                feed.stop();
                return;
              }
              for (const event of batch.events) {
                const sourceSeq = this.nextMonitorSourceSeq(event.tableId);
                await this.orchestrator.enqueue(event.tableId, { ...event, sourceSeq });
              }
            },
            onDisconnect: (tableId, reason) => {
              this.lastFeedDisconnectReason.set(tableId, reason ?? '');
              const sourceSeq = this.nextMonitorSourceSeq(tableId);
              void this.orchestrator.enqueue(tableId, {
                type: 'connectionLost',
                eventId: newId('evt'),
                tableId,
                timestamp: new Date().toISOString(),
                sourceSeq,
                source: 'room-monitor',
                schemaVersion: EVENT_SCHEMA_VERSION,
                ...(reason ? { reason } : {}),
              });
            },
            onRestored: async (tableId, proof) => {
              const sourceSeq = this.nextMonitorSourceSeq(tableId);
              await this.orchestrator.enqueue(tableId, {
                type: 'connectionRestored',
                eventId: newId('evt'),
                tableId,
                timestamp: new Date().toISOString(),
                sourceSeq,
                source: 'room-monitor',
                schemaVersion: EVENT_SCHEMA_VERSION,
                continuityProof: proof,
              });
            },
          });
          feeds.push(feed);
        }
        await Promise.all(feeds.map(feed => feed.flush()));
        await this.orchestrator.flush();
      } finally {
        await monitor.close();
        this.setOrchestratorExecutor(previousExecutor);
      }
      return this.snapshot();
    }

  queryRecords(query: DesktopRecordQuery): DesktopRecordPage {
    // Events/decisions stay scoped to the live monitor list so demo tables do not
    // inflate those pages. Ledger is money history: keep rows after a table leaves
    // the monitor list, otherwise real bets vanish from 账本.
    const scopedQuery = this.liveMonitorActivated && query.kind !== 'ledger'
      ? { ...query, tableIds: this.displayedTableIds(this.orchestrator.snapshot()) }
      : query;
    if (query.kind === 'events') {
      const page = this.ledger.listEventsPage(scopedQuery);
      return { kind: 'events', page: page.page, pageSize: page.pageSize, total: page.total, events: page.rows };
    }
    if (query.kind === 'decisions') {
      const page = this.ledger.listDecisionHandsPage(scopedQuery);
      return { kind: 'decisions', page: page.page, pageSize: page.pageSize, total: page.total, decisions: page.rows };
    }
    const page = this.ledger.listReservationsPage(scopedQuery);
    return {
      kind: 'ledger',
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      ledger: page.rows.map(reservation => ({
        reservation,
        decision: this.ledger.getDecision(reservation.tableId, reservation.shoeId, reservation.handId, reservation.market),
        receipt: this.ledger.getReceipt(reservation.tableId, reservation.shoeId, reservation.handId, reservation.market),
        operationalWager: this.ledger.getOperationalWager(reservation.intentId),
        outcome: this.ledger.getSettledOutcome(reservation.tableId, reservation.shoeId, reservation.handId, reservation.market),
      })),
    };
  }

  async updateTableSettings(tableId: string, settings: TableSettingsUpdate): Promise<DesktopConsoleSnapshot> {
    this.orchestrator.updateTableSettings(tableId, { ...settings, minEV: Math.max(0, settings.minEV) });
    return this.snapshot();
  }

  async updateAllTableSettings(settings: TableSettingsUpdate): Promise<DesktopConsoleSnapshot> {
    if (this.monitorTableIds.length === 0) {
      throw new Error('at least one monitored table is required');
    }
    const unified: UnifiedBetSettings = {
      minEV: Math.max(0, settings.minEV),
      betTiers: settings.betTiers.map(tier => ({ ...tier })),
      defaultBetAmount: settings.defaultBetAmount,
    };
    this.persistUnifiedBetSettings(unified);
    this.ensureMonitorActors(this.monitorTableIds, unified);
    this.orchestrator.updateTableSettingsForTables(this.monitorTableIds, unified);
    return this.snapshot();
  }

  async updateMonitorTableIds(tableIds: readonly string[]): Promise<DesktopConsoleSnapshot> {
    const nextTableIds = normalizeMonitorTableIds(tableIds, true).slice(0, MAX_LIVE_MONITOR_TABLES);
    return await this.enqueueLiveMonitorOperation(() => this.updateMonitorTableIdsInner(nextTableIds));
  }

  private async updateMonitorTableIdsInner(nextTableIds: readonly string[]): Promise<DesktopConsoleSnapshot> {
    const previousTableIds = [...this.monitorTableIds];
    const nextTableIdSet = new Set(nextTableIds);
    const inheritedSettings = this.currentUnifiedTableSettings();
    this.pendingMonitorTableIds = [...nextTableIds];
    try {
      this.ensureMonitorActors(nextTableIds, inheritedSettings);
      const keepFeedIds = new Set([...nextTableIds, ...this.pendingJoinTableIds()]);
      const outgoingFeeds = [...this.liveFeeds].filter(([tableId]) => !keepFeedIds.has(tableId));
      await this.failCloseLiveExecution(outgoingFeeds.map(([tableId]) => tableId));

      // Stop outgoing tables before mutating the Bridge allowlist. The Bridge
      // prunes exports as a side effect of selection changes, so doing this in
      // reverse order would make a failed stop ambiguous and could duplicate a
      // still-active export during rollback.
      for (const [tableId, feed] of outgoingFeeds) {
        const stopped = await this.stopLiveFeedForTransition(tableId, feed);
        if (stopped.kind === 'failed') {
          this.recordLiveMonitorError(stopped.error);
          this.pendingMonitorTableIds = undefined;
          return this.snapshot();
        }
      }

      this.browserBridge?.setSelectedTableIds(this.observedTableIds());
      await this.attachLiveTablesInner();
      this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: nextTableIds });
      this.monitorTableIds = [...nextTableIds];
      for (const tableId of nextTableIds) this.clearDemotedPendingTable(tableId);
      this.syncLiveApprovalsToMonitorTables();
      this.pendingMonitorTableIds = undefined;
      return this.snapshot();
    } catch (error) {
      this.pendingMonitorTableIds = undefined;
      try {
        const previousTableIdSet = new Set(previousTableIds);
        // Any feed created for the failed target selection is safe to clean up:
        // it remains outside the restored allowlist and will not be reopened.
        const keepRollbackIds = new Set([...previousTableIds, ...this.pendingJoinTableIds()]);
        for (const [tableId, feed] of [...this.liveFeeds]) {
          if (keepRollbackIds.has(tableId)) continue;
          await this.stopLiveFeed(tableId, feed);
        }
        this.monitorTableIds = previousTableIds;
        this.browserBridge?.setSelectedTableIds(this.observedTableIds());
        this.suppressDiscoveredMonitorAutoAdd = true;
        try {
          await this.attachLiveTablesInner();
        } finally {
          this.suppressDiscoveredMonitorAutoAdd = false;
        }
        this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: previousTableIds });
        this.syncLiveApprovalsToMonitorTables();
      } catch (rollbackError) {
        this.recordLiveMonitorError(rollbackError);
      }
      throw error;
    }
  }

  async registerTable(
    profile: TableProfile,
    _executionMode: 'shadow' | 'simulated' | 'live',
    defaultBetAmount: number,
  ): Promise<DesktopConsoleSnapshot> {
    this.orchestrator.registerTable({ ...profile, minEV: Math.max(0, profile.minEV) }, 'live', defaultBetAmount);
    return this.snapshot();
  }

  async injectEvent(event: NormalizedEvent): Promise<DesktopConsoleSnapshot> {
    await this.enqueueMonitorEvent(event);
    return this.snapshot();
  }

  async confirmPhysicalShoe(tableId: string): Promise<DesktopConsoleSnapshot> {
    if (!this.browserBridge) throw new Error('browser bridge is not running');
    if (!this.monitorTableIds.includes(tableId)) throw new Error(`table ${tableId} is not monitored`);
    this.browserBridge.confirmPhysicalShoe(tableId);
    await this.orchestrator.flush(tableId);
    return this.snapshot();
  }
  async setAutoBet(tableId: string, armed: boolean, shoeId?: string): Promise<DesktopConsoleSnapshot> {
    return this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      const actor = this.orchestrator.getActor(tableId);
      if (!actor) throw new Error(`unknown table ${tableId}`);
      if (armed && !this.automationEnabled) {
        throw new Error('global automation is disabled');
      }
      if (armed) {
        const projection = actor.getProjection();
        const gameCount = this.tableMetadata.get(tableId)?.gameCount;
        if (effectiveShoeBaseline(projection, gameCount, this.browserBridge?.shoeEvidence(tableId)) !== 'physical-shoe') {
          throw new Error('physical shoe baseline is unknown');
        }
      }
      await actor.setAutoBet(armed, shoeId);
      return this.snapshot();
    });
  }

  async setExecutionMode(tableId: string, _mode: 'shadow' | 'live'): Promise<DesktopConsoleSnapshot> {
    return this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      const actor = this.orchestrator.getActor(tableId);
      if (!actor) throw new Error(`unknown table ${tableId}`);
      this.orchestrator.updateTableExecutionMode(tableId, 'live');
      this.liveApprovals.approve(tableId);
      const bridge = this.browserBridge;
      if (!bridge) {
        throw new Error('browser bridge is not running');
      }

      const shoeId = actor.getProjection().shoeId || undefined;
      await actor.setAutoBet(false, shoeId);

      await this.setPersistentLiveGate(true);
      this.setOrchestratorExecutor({
        requestBet: request => bridge.requestBet(request),
      });
      this.setOperationalWagerExecutor(true);
      this.liveAuthorizationSources.set(tableId, 'manual');
      return this.snapshot();
    });
  }

  async executeOperationalWager(input: {
    readonly tableId: string;
    readonly market: 'banker' | 'player' | 'bankerPair' | 'playerPair';
    readonly amount: number;
    readonly handId?: string;
  }): Promise<OperationalWagerResult & { readonly snapshot: DesktopConsoleSnapshot }> {
    await this.startupFailCloseTask;
    const actor = this.orchestrator.getActor(input.tableId);
    const bridge = this.browserBridge;
    const gateWasAlreadyEnabled = this.persistentLiveGateEnabled;
    if (actor && bridge) {
      this.orchestrator.updateTableExecutionMode(input.tableId, 'live');
      this.setOperationalWagerExecutor(true);
      if (!gateWasAlreadyEnabled) {
        try {
          bridge.setLiveBetEnabled(true);
        } catch {
          // Gate is restored in finally; a missing live session still fails closed in the extension.
        }
      }
    }
    let result: OperationalWagerResult;
    try {
      result = await this.operationalWagers.executeManual(input);
    } finally {
      if (actor && bridge && !gateWasAlreadyEnabled) {
        try {
          bridge.setLiveBetEnabled(false);
        } catch {
          this.persistentLiveGateEnabled = false;
        }
      }
    }
    if (result.status === 'UNKNOWN') {
      this.refreshAccountingIncidents(true);
    }
    return { ...result, snapshot: this.snapshot() };
  }

  async reconcileUnknownOperationalWager(
    command: DesktopUnknownWagerReconciliationCommand,
  ): Promise<DesktopConsoleSnapshot> {
    return await this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      const reservation = this.orchestrator.getReservations()
        .find(candidate => candidate.reservationId === command.reservationId);
      if (!reservation) throw new Error(`reservation ${command.reservationId} not found`);

      const record = this.ledger.getOperationalWager(command.wagerId);
      if (!record) throw new Error(`operational wager ${command.wagerId} not found`);
      const matchesReservation = record.reservationId === reservation.reservationId
        && record.wager.wagerId === reservation.intentId
        && record.wager.tableId === reservation.tableId
        && record.wager.shoeId === reservation.shoeId
        && record.wager.handId === reservation.handId
        && record.wager.market === reservation.market
        && record.wager.amount === reservation.amount
        && record.wager.source === reservation.executionSource;
      if (!matchesReservation) {
        throw new Error('operational wager does not match the reservation');
      }

      const receipt = record.receipt;
      if (!receipt) throw new Error(`operational wager ${command.wagerId} has no platform receipt`);
      const receiptRaw = receipt.raw;
      const commitStarted = typeof receiptRaw === 'object'
        && receiptRaw !== null
        && Reflect.get(receiptRaw, 'commitStarted') === true;
      const unknownExecution = record.status === 'UNKNOWN'
        && commitStarted;
      const committedRejectedExecution = record.status === 'REJECTED'
        && receipt.status === 'REJECTED'
        && commitStarted;
      if (!unknownExecution && !committedRejectedExecution) {
        throw new Error(`operational wager ${command.wagerId} is not a reconcilable committed execution`);
      }
      if (
        reservation.status !== 'SETTLED'
        && (record.status === 'UNKNOWN' ? reservation.status !== 'UNKNOWN' : reservation.status !== 'RELEASED')
      ) {
        throw new Error(`reservation ${command.reservationId} does not match the execution receipt state`);
      }
      const receiptMatchesWager = receipt.wagerId === record.wager.wagerId
        && receipt.tableId === record.wager.tableId
        && receipt.shoeId === record.wager.shoeId
        && receipt.handId === record.wager.handId
        && receipt.market === record.wager.market
        && receipt.amount === record.wager.amount
        && receipt.source === record.wager.source;
      if (!receiptMatchesWager) {
        throw new Error('platform receipt does not match the operational wager');
      }
      if (!commitStarted) {
        throw new Error('platform receipt has no proof that the bet was submitted');
      }

      const settlement = this.ledger.getHandSettlement(
        reservation.tableId,
        reservation.shoeId,
        reservation.handId,
      );
      if (!settlement) {
        throw new Error('authoritative hand settlement is not available for this exact wager');
      }
      if (
        (reservation.market === 'bankerPair' || reservation.market === 'playerPair')
        && settlement.outcomes === undefined
      ) {
        throw new Error('authoritative pair outcome is not available for this exact wager');
      }

      if (
        record.reconciliation !== undefined
        && (
          record.reconciliation.status !== 'ACCEPTED'
          || (
            record.reconciliation.reason !== 'operator-confirmed-platform-accepted'
            && record.reconciliation.reason !== 'committed-hand-settled'
          )
        )
      ) {
        throw new Error('operational wager has an invalid reconciliation audit');
      }
      if (reservation.status === 'SETTLED') {
        if (record.reconciliation === undefined) {
          throw new Error('settled reservation has no matching reconciliation audit');
        }
        return this.snapshot();
      }
      const reconciliation = record.reconciliation ?? {
        status: 'ACCEPTED' as const,
        reason: 'operator-confirmed-platform-accepted' as const,
        reconciledAt: new Date().toISOString(),
      };
      this.ledger.reconcileOperationalWager(command.wagerId, reconciliation);
      if (record.status === 'UNKNOWN') {
        this.orchestrator.settleUnknownReservation(
          command.reservationId,
          settlement,
          reconciliation.reason,
        );
      } else {
        this.orchestrator.settleReleasedReservation(
          command.reservationId,
          settlement,
          reconciliation.reason,
        );
      }
      this.refreshAccountingIncidents(true);
      this.cachedSummary = undefined;
      this.cachedRecordCounts = undefined;
      return this.snapshot();
    });
  }

  async writeOffUnknownOperationalWager(
    command: DesktopUnknownWagerWriteOffCommand,
  ): Promise<DesktopConsoleSnapshot> {
    return await this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      const reservation = this.orchestrator.getReservations()
        .find(candidate => candidate.reservationId === command.reservationId);
      if (!reservation) throw new Error(`reservation ${command.reservationId} not found`);
      if (reservation.status !== 'UNKNOWN') {
        throw new Error(`reservation ${command.reservationId} is not an UNKNOWN exposure`);
      }

      const record = command.wagerId ? this.ledger.getOperationalWager(command.wagerId) : undefined;
      if (record) {
        const matchesReservation = record.reservationId === reservation.reservationId
          && record.wager.wagerId === reservation.intentId
          && record.wager.tableId === reservation.tableId
          && record.wager.shoeId === reservation.shoeId
          && record.wager.handId === reservation.handId
          && record.wager.market === reservation.market
          && record.wager.amount === reservation.amount
          && record.wager.source === reservation.executionSource;
        if (!matchesReservation) {
          throw new Error('operational wager does not match the reservation');
        }
        if (record.status !== 'UNKNOWN') {
          throw new Error(`operational wager ${command.wagerId} is not an UNKNOWN exposure`);
        }
        if (record.reconciliation !== undefined) {
          throw new Error('operational wager already has a reconciliation audit');
        }
        const writeOff = record.writeOff ?? {
          reason: 'operator-unconfirmed-write-off' as const,
          writtenOffAt: new Date().toISOString(),
        };
        this.ledger.writeOffOperationalWager(record.wager.wagerId, writeOff);
        this.orchestrator.writeOffUnknownReservation(
          command.reservationId,
          writeOff.reason,
        );
      } else {
        this.orchestrator.writeOffUnknownReservation(
          command.reservationId,
          'operator-unconfirmed-write-off',
        );
      }
      this.refreshAccountingIncidents(true);
      this.cachedSummary = undefined;
      this.cachedRecordCounts = undefined;
      await this.reconcileUnattendedExecution();
      return this.snapshot();
    });
  }

  async settlePendingOperationalWager(
    command: DesktopPendingSettlementCommand,
  ): Promise<DesktopConsoleSnapshot> {
    return await this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      const reservation = this.orchestrator.getReservations()
        .find(candidate => candidate.reservationId === command.reservationId);
      if (!reservation) throw new Error(`reservation ${command.reservationId} not found`);

      const record = this.ledger.getOperationalWager(command.wagerId);
      if (!record) throw new Error(`operational wager ${command.wagerId} not found`);
      const receipt = record.receipt;
      const matchesReservation = record.reservationId === reservation.reservationId
        && record.wager.wagerId === reservation.intentId
        && record.wager.tableId === reservation.tableId
        && record.wager.shoeId === reservation.shoeId
        && record.wager.handId === reservation.handId
        && record.wager.market === reservation.market
        && record.wager.amount === reservation.amount
        && record.wager.source === reservation.executionSource;
      if (!matchesReservation) throw new Error('operational wager does not match the reservation');
      if (record.status !== 'ACCEPTED' || receipt?.status !== 'ACCEPTED') {
        throw new Error(`operational wager ${command.wagerId} is not an accepted pending settlement`);
      }
      const receiptMatchesWager = receipt.wagerId === record.wager.wagerId
        && receipt.tableId === record.wager.tableId
        && receipt.shoeId === record.wager.shoeId
        && receipt.handId === record.wager.handId
        && receipt.market === record.wager.market
        && receipt.amount === record.wager.amount
        && receipt.source === record.wager.source;
      if (!receiptMatchesWager) throw new Error('platform receipt does not match the operational wager');

      if (
        command.outcome === 'PUSH'
        && (reservation.market === 'bankerPair' || reservation.market === 'playerPair')
      ) {
        throw new Error('pair wagers cannot be settled as a push');
      }
      const realizedPnl = command.outcome === 'WIN'
        ? reservation.maxProfit
        : command.outcome === 'LOSS'
          ? -reservation.maxLoss
          : 0;

      if (record.settlement !== undefined) {
        if (
          record.settlement.outcome !== command.outcome
          || record.settlement.realizedPnl !== realizedPnl
          || record.settlement.reason !== 'operator-confirmed-platform-settlement'
        ) {
          throw new Error('operational wager already has a different settlement audit');
        }
        if (reservation.status === 'SETTLED') return this.snapshot();
      }
      if (reservation.status !== 'RESERVED') {
        throw new Error(`reservation ${command.reservationId} is not awaiting settlement`);
      }
      if (this.ledger.getHandSettlement(reservation.tableId, reservation.shoeId, reservation.handId)) {
        throw new Error('authoritative hand settlement is already available for this exact wager');
      }
      const settlement = record.settlement ?? {
        outcome: command.outcome,
        realizedPnl,
        reason: 'operator-confirmed-platform-settlement' as const,
        settledAt: new Date().toISOString(),
      };
      this.ledger.settleOperationalWager(command.wagerId, settlement);
      this.orchestrator.settleReservedReservationManually(
        command.reservationId,
        realizedPnl,
        settlement.reason,
      );
      this.refreshAccountingIncidents(true);
      this.cachedSummary = undefined;
      this.cachedRecordCounts = undefined;
      return this.snapshot();
    });
  }

  async updateKeepaliveSettings(settings: KeepaliveStrategySettings): Promise<DesktopConsoleSnapshot> {
    return await this.enqueueExecutionStateOperation(async () => {
      const current = this.operationalWagers.getKeepaliveState();
      await this.applyKeepaliveSettings({
        enabled: current.enabled,
        intervalMinutes: settings.intervalMinutes,
        market: settings.market,
        amount: settings.amount,
      });
      return this.snapshot();
    });
  }

  async setKeepaliveEnabled(enabled: boolean): Promise<DesktopConsoleSnapshot> {
    if (!enabled) this.operationalWagers.disableKeepaliveImmediately();
    return await this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      const current = this.operationalWagers.getKeepaliveState();
      await this.applyKeepaliveSettings({
        enabled,
        intervalMinutes: current.intervalMinutes,
        market: current.market,
        amount: current.amount,
      });
      await this.reconcileUnattendedExecution();
      return this.snapshot();
    });
  }

  async setAutomationEnabled(enabled: boolean): Promise<DesktopConsoleSnapshot> {
    return await this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      this.automationEnabled = enabled;
      this.ledger.setConfig(AUTOMATION_CONFIG_KEY, { enabled });
      await this.reconcilePairAutomation(enabled);
      await this.reconcileUnattendedExecution();
      return this.snapshot();
    });
  }

  acknowledgeRuntimeIncident(incidentId: string): DesktopConsoleSnapshot {
    const normalized = incidentId.trim();
    if (normalized.length === 0) throw new TypeError('incident id must not be empty');
    this.runtimeIncidents.acknowledge(normalized);
    return this.snapshot();
  }

  acknowledgeAllRuntimeIncidents(): DesktopConsoleSnapshot {
    this.runtimeIncidents.acknowledgeAllActive();
    return this.snapshot();
  }

  async executeOneShotLiveBet(input: OneShotLiveBetCommand): Promise<OneShotLiveBetResult> {
    if (!isExactOneShotLiveBetConfirmation(input)) {
      throw new TypeError('one-shot confirmation must match exactly');
    }
    if (this.oneShotLiveBetInFlight) {
      throw new Error('one-shot live bet is already in flight');
    }

    const operation = this.enqueueExecutionStateOperation(() => this.executeOneShotLiveBetInner(input));
    this.oneShotLiveBetInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.oneShotLiveBetInFlight === operation) this.oneShotLiveBetInFlight = null;
    }
  }

  private async executeOneShotLiveBetInner(command: OneShotLiveBetCommand): Promise<OneShotLiveBetResult> {
    await this.startupFailCloseTask;
    if (!this.isMonitorTableSelected(command.tableId)) {
      throw new Error(`table ${command.tableId} is not monitored`);
    }

    const actor = this.orchestrator.getActor(command.tableId);
    if (!actor) throw new Error(`monitored table ${command.tableId} has no actor`);
    if (!hasOneShotLiveBetActor(actor)) {
      throw new Error('table actor does not support one-shot live bets');
    }
    this.orchestrator.updateTableExecutionMode(command.tableId, 'live');

    const bridge = this.browserBridge;
    if (!bridge) throw new Error('browser bridge is not running');

    const executor: Pick<BrowserAdapter, 'requestBet'> = {
      requestBet: request => bridge.requestBet(request),
    };
    const previousExecutor = this.currentExecutor;
    const gateWasAlreadyEnabled = this.persistentLiveGateEnabled;
    actor.setExecutor(executor);
    let result: OneShotBetResult;
    try {
      result = await (async (): Promise<OneShotBetResult> => {
        try {
          if (!gateWasAlreadyEnabled) bridge.setLiveBetEnabled(true);
          return await actor.placeOneShotBet({
            shoeId: command.shoeId,
            handId: command.handId,
            market: command.market,
            amount: command.amount,
          });
        } finally {
          if (!gateWasAlreadyEnabled) bridge.setLiveBetEnabled(false);
        }
      })();
    } finally {
      actor.setExecutor(previousExecutor);
    }

    if (result.status === 'UNKNOWN') {
      this.refreshAccountingIncidents(true);
    }

    const snapshot = this.snapshot();
    switch (result.status) {
      case 'ACCEPTED':
        return { status: 'ACCEPTED', receipt: result.receipt, snapshot };
      case 'REJECTED':
        if (!result.receipt) {
          throw new Error(`one-shot live bet rejected locally: ${result.reason}`);
        }
        return { status: 'REJECTED', receipt: result.receipt, snapshot, reason: result.reason };
      case 'UNKNOWN':
        return {
          status: 'UNKNOWN',
          ...(result.receipt ? { receipt: result.receipt } : {}),
          snapshot,
          reason: result.reason,
        };
      default:
        return assertNeverOneShotBetResult(result);
    }
  }

  async applyManualCorrection(
    tableId: string,
    correction: ManualCorrection,
    shoeId?: string,
  ): Promise<DesktopConsoleSnapshot> {
    const actor = this.orchestrator.getActor(tableId);
    if (!actor) throw new Error(`unknown table ${tableId}`);
    await actor.applyManualCorrection(correction, shoeId);
    return this.snapshot();
  }

  async updateRiskLimits(limits: RiskLimits): Promise<DesktopConsoleSnapshot> {
    this.orchestrator.updateRiskLimits(limits);
    return this.snapshot();
  }

  async clearMonitorData(): Promise<DesktopConsoleSnapshot> {
    await this.stopDemo();
    await this.orchestrator.clearMonitorData();
    this.cachedRecordCounts = undefined;
    this.cachedSummary = undefined;
    this.runtimeIncidents.resolveAll('table-feed-stale');
    this.runtimeIncidents.resolveAll('monitor-failure');
    this.runtimeIncidents.resolveAll('settlement-gap');
    this.runtimeIncidents.resolveAll('unknown-execution');
    for (const tableId of this.monitorTableIds) {
      this.cancelDisconnectedMonitorRemoval(tableId);
      if (this.liveFeeds.get(tableId)?.health().state === 'CONNECTED') {
        this.runtimeObservedTableIds.add(tableId);
      }
    }
    if (this.liveMonitorActivated) this.ensureMonitorActors(this.monitorTableIds);
    this.lastSeed = undefined;
    this.demoError = undefined;
    return this.snapshot();
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      this.operationalWagers.close();
      await this.stopDemo();
      await this.stopLiveRoomMonitorInner();
      await this.stopBrowserBridgeInner();
      await this.orchestrator.close();
    });
  }
}

function pairOutcomesFromCards(
  playerCards: readonly { rank: string }[],
  bankerCards: readonly { rank: string }[],
): { bankerPair: boolean; playerPair: boolean } | undefined {
  if (playerCards.length < 2 || bankerCards.length < 2) return undefined;
  return {
    playerPair: playerCards[0]!.rank === playerCards[1]!.rank,
    bankerPair: bankerCards[0]!.rank === bankerCards[1]!.rank,
  };
}

function assertNeverOneShotBetResult(value: never): never {
  throw new Error(`unexpected one-shot bet result: ${String(value)}`);
}

function assertNeverBridgeRuntimeEvent(value: never): never {
  throw new Error(`unexpected browser bridge runtime event: ${String(value)}`);
}

function buildShoeIdMap(
  demo: ReturnType<typeof buildRandomDemo>,
  ledger: SqliteLedger,
  startedAt: Date,
): Map<string, string> {
  const minute = formatShoeMinute(startedAt);
  const result = new Map<string, string>();
  for (const profile of demo.profiles) {
    let nextSequence = 1;
    const existing = ledger.listEvents(profile.tableId);
    for (const event of existing) {
      if (event.type !== 'newShoeSignal') continue;
      const match = event.shoeId.match(new RegExp('^' + minute + '-([0-9]{3})$'));
      if (match) nextSequence = Math.max(nextSequence, Number(match[1]) + 1);
    }
    for (const event of demo.streams[profile.tableId]) {
      if (event.type !== 'newShoeSignal') continue;
      const key = profile.tableId + '|' + event.shoeId;
      result.set(key, minute + '-' + String(nextSequence).padStart(3, '0'));
      nextSequence += 1;
    }
  }
  return result;
}

function remapDemoEvent(
  event: NormalizedEvent,
  tableId: string,
  shoeIds: Map<string, string>,
  startedAt: Date,
): NormalizedEvent {
  const timestamp = new Date(startedAt.getTime() + Math.max(0, event.sourceSeq - 1) * 1000).toISOString();
  const next = { ...event, timestamp } as NormalizedEvent;
  if ('closesAt' in event && typeof event.closesAt === 'string') {
    const originalTs = Date.parse(event.timestamp);
    const remappedTs = Date.parse(timestamp);
    const originalClose = Date.parse(event.closesAt);
    if (Number.isFinite(originalTs) && Number.isFinite(remappedTs) && Number.isFinite(originalClose)) {
      (next as { closesAt: string }).closesAt = new Date(remappedTs + (originalClose - originalTs)).toISOString();
    }
  }
  const oldShoeId = 'shoeId' in event && typeof event.shoeId === 'string' ? event.shoeId : undefined;
  const newShoeId = oldShoeId ? shoeIds.get(tableId + '|' + oldShoeId) : undefined;
  if (newShoeId && 'shoeId' in next && typeof next.shoeId === 'string') {
    (next as { shoeId: string }).shoeId = newShoeId;
  }
  if (oldShoeId && newShoeId && 'handId' in next && typeof next.handId === 'string' && next.handId.startsWith(oldShoeId)) {
    (next as { handId: string }).handId = newShoeId + next.handId.slice(oldShoeId.length);
  }
  return next;
}

function formatShoeMinute(value: Date): string {
  const pad2 = (number: number) => String(number).padStart(2, '0');
  return String(value.getFullYear()) + pad2(value.getMonth() + 1) + pad2(value.getDate())
    + pad2(value.getHours()) + pad2(value.getMinutes());
}

const DEMO_EVENT_INTERVAL_MS = 300;
const DEMO_PAUSE_MS = 800;

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
