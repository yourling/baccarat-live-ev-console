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
  BUNDLED_PLATFORM_DESCRIPTORS,
  BrowserBridgeServer,
  MemoryExtensionApprovalStore,
  collapseWinfinityDuplicateTableIds,
  isCompleteBaccaratHand,
  isJoinableNewShoeRoadCount,
  normalizeBgTableId,
  normalizeWinfinityTableId,
  selectBgRoadCount,
  selectObservedGameCount,
  selectStableGameCount,
  selectWinfinityRoadCount,
  type BridgeExtensionPendingEntry,
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
  shortExtensionInstallId,
  type DesktopConsoleSnapshot as ApiDesktopConsoleSnapshot,
  type DesktopRecordCounts,
  type DesktopRecordPage,
  type DesktopRecordQuery,
  type DesktopRuntimeState,
  type DesktopPendingSettlementCommand,
  type DesktopPerformanceReport,
  type DesktopExtensionApprovalState,
  type DesktopUnknownWagerReconciliationCommand,
  type DesktopUnknownWagerWriteOffCommand,
  type DesktopShoeEvidence,
  type DesktopBeadHand,
  type MonitorTableCandidate,
  type OneShotLiveBetCommand,
  type OneShotLiveBetResult,
} from '../src/api-types.js';
import {
  OperationalWagerConsole,
  type WagerConsoleHost,
} from './operational-wager-console.js';
import {
  MonitorConsole,
  type MonitorConsoleHost,
} from './monitor-console.js';
import {
  LiveFeedConsole,
  type LiveFeedConsoleHost,
} from './live-feed-console.js';
import { DemoConsole, type DemoConsoleHost } from './demo-console.js';
import {
  ExecutionGateConsole,
  type ExecutionGateHost,
} from './execution-gate-console.js';
import {
  MAX_LIVE_MONITOR_TABLES,
  MONITOR_TABLE_CONFIG_KEY,
  TABLE_METADATA_CONFIG_KEY,
  defaultMonitorTableIds,
  isLiveDesktopRoomId,
  isRetiredDefaultMonitorList,
  monitorTableIdsFromConfig,
  normalizeMonitorTableIds,
  normalizeOptionalMonitorTableId,
  samePersistentTableMetadata,
  tableMetadataFromConfig,
  type MonitorFeedTransitionStopResult,
  type MonitorTableConfig,
  type StoredTableMetadata,
  type TableMetadataConfig,
  type UnifiedBetSettings,
} from './monitor-shared.js';
import {
  LiveApprovalStore,
  RuntimeIncidentStore,
  evaluateLiveExecutionReadiness,
  type LiveExecutionBlockReason,
  type RuntimeIncidentCode,
  type RuntimeIncidentSeverity,
} from './runtime-supervisor.js';

const AUTOMATION_CONFIG_KEY = 'desktop:pair-automation:v1';
const UNIFIED_BET_SETTINGS_CONFIG_KEY = 'desktop:unified-bet-settings:v1';
const DISCONNECTED_MONITOR_REMOVAL_MS = 15_000;
const SHUFFLE_MONITOR_HOLD_MS = 10 * 60 * 1000;
const MAX_LIVE_FEED_STALENESS_MS = 120_000;
const LIVE_MONITOR_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
const EMPTY_RECORD_COUNTS: DesktopRecordCounts = { events: 0, decisions: 0, ledger: 0 };
const EMPTY_MONITOR_SUMMARY: MonitorSummary = { rows: [], incomePoints: [] };
const ACCOUNTING_REFRESH_MIN_MS = 2_000;
/** FIX(P2-5): 监控历史定期裁剪间隔（10 分钟，单次裁剪量小、不阻塞事件泵）。 */
const MONITOR_HISTORY_COMPACT_INTERVAL_MS = 10 * 60_000;

/**
 * 已提交的预留超过这个时长仍未收到结算，就升级为 UNKNOWN。
 * 一手牌的结算通常在数秒内到达，10 分钟足以排除正常延迟。
 */
const SETTLEMENT_OVERDUE_MS = 10 * 60_000;


interface OneShotLiveBetActor {
  placeOneShotBet(command: OneShotBetCommand): Promise<OneShotBetResult>;
}

function hasOneShotLiveBetActor(value: unknown): value is OneShotLiveBetActor {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'placeOneShotBet') === 'function';
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

export interface DesktopSnapshotOptions extends MonitorSummaryOptions {
  includeHistory?: boolean;
  includeRecordCounts?: boolean;
  includeSummary?: boolean;
}

/**
 * FIX(D-P2-4): 写路径的轻量快照选项。
 *
 * 修复前每个写操作后返回给 UI 的 snapshot 都用默认 `includeHistory !== false`，
 * 会全量 `listEvents()/listDecisions()/listReceipts()`：10 万条事件时单次 610ms /
 * 32.5MB（review 脚本 b8b 实证），而下注/改设置/确认牌靴/勾销/批准事故全都走这条路。
 *
 * 只改**调用点**与各 console 切片，不动 `snapshot()` 默认值（首次加载与
 * 账本/事件视图仍要全量）。
 */
const LIGHT_WRITE_SNAPSHOT: DesktopSnapshotOptions = { includeHistory: false };
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

export class DesktopConsoleService implements WagerConsoleHost, MonitorConsoleHost, LiveFeedConsoleHost, DemoConsoleHost, ExecutionGateHost {
  readonly ledger: SqliteLedger;
  readonly orchestrator: Orchestrator;
  readonly operationalWagers: OperationalWagerCoordinator;
  readonly liveApprovals: LiveApprovalStore;
  readonly runtimeIncidents: RuntimeIncidentStore;
  readonly startupFailCloseTask: Promise<void>;
  currentExecutor: Pick<BrowserAdapter, 'requestBet'> | null;
  /** demo 演示流切片（runDemo/start/stop/speed + 靴 ID 重映射）。 */
  readonly demoConsole = new DemoConsole(this);
  /** 执行门控切片（fail-close / 常驻 gate / 无人值守调和）。 */
  readonly executionGateConsole = new ExecutionGateConsole(this);
  demoError?: string;
  browserBridge?: BrowserBridgeServer;
  private browserBridgePort = 0;
  liveExecutionMode: ExecutionMode = 'live';
  readonly liveFeeds = new Map<string, TableExport>();
  readonly liveRoomIdsByTable = new Map<string, string>();
  readonly tableMetadata: Map<string, StoredTableMetadata>;
  readonly disconnectedMonitorRemovalTimers = new Map<string, NodeJS.Timeout>();
  readonly shuffleHoldUntilByTable = new Map<string, number>();
  readonly lastFeedDisconnectReason = new Map<string, string>();
  readonly runtimeObservedTableIds = new Set<string>();
  readonly liveAuthorizationSources = new Map<string, 'manual' | 'unattended'>();
  persistentLiveGateEnabled = false;
  transportDownAt?: number;
  recoverySuppressUntil = 0;
  readonly tableFlapStats = new Map<string, {
    disconnects: number;
    lastDisconnectAt: number;
    lastRecoveredAt?: number;
    recentDisconnectAt: number[];
  }>();
  private liveRoomTimer?: NodeJS.Timeout;
  private liveMonitorRetryAttempt = 0;
  private liveMonitorOperation: Promise<void> = Promise.resolve();
  liveMonitorActivated = false;
  liveMonitorStartedAt = 0;
  readonly connectedThisProcess = new Set<string>();
  readonly missedShuffleRequested = new Set<string>();
  private oneShotLiveBetInFlight: Promise<OneShotLiveBetResult> | null = null;
  private executionStateOperation: Promise<void> = Promise.resolve();
  cachedRecordCounts?: DesktopRecordCounts;
  cachedSummary?: MonitorSummary;
  cachedLightSnapshot?: { key: string; at: number; value: DesktopConsoleSnapshot };
  /** FIX(D-P2-4): 各 console 切片（下注/对账/勾销）的写路径快照选项。 */
  readonly lightWriteSnapshotOptions: DesktopSnapshotOptions = LIGHT_WRITE_SNAPSHOT;
  private lastAccountingRefreshAt = 0;
  /** 本进程启动时刻。用于区分"运行期新产生的敞口"与"启动时从账本恢复的历史敞口"。 */
  private readonly runtimeStartedAt = Date.now();
  closing = false;
  /**
   * FIX(P2-5): 定期裁剪监控历史，防止账本无界增长。
   *
   * 修复前 `compactMonitorHistory()` / `pruneMonitorHistory()` **没有任何调用方**
   * （审查实测 64 桌一个月约 417 万条事件 / 3.7GB，且全量 snapshot 会随之线性变慢）。
   * `pruneMonitorHistory` 本身实现是安全的（每桌保留最近 N 手，且**永不裁剪**
   * 仍有 RESERVED/UNKNOWN 敞口的手），缺的只是一个触发点。
   */
  private monitorHistoryPruneTimer?: NodeJS.Timeout;
  suppressDiscoveredMonitorAutoAdd = false;
  automationEnabled = false;
  readonly pendingGameCountByTable = new Map<string, number>();
  readonly demotedPendingTableIds = new Set<string>();
  readonly demotedPendingShoeIds = new Map<string, string>();
  /** The transient allowlist used only while a serialized live transition is being validated. */
  pendingMonitorTableIds?: readonly string[];
  /** Operator-managed, persisted ordered selection; mutation is the configuration operation. */
  monitorTableIds: string[];
  private unifiedBetSettings?: UnifiedBetSettings;
  /** 受控下注生命周期切片（execute / reconcile / writeOff / settle）。 */
  readonly wagerConsole = new OperationalWagerConsole(this);
  /** 监控桌生命周期切片（发现表 / promote / demote / 选桌事务）。 */
  readonly monitorConsole = new MonitorConsole(this);
  /** live feed 管线切片（attach/stop/断联分级/事件泵）。 */
  readonly liveFeedConsole = new LiveFeedConsole(this);

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
      runtimeBlockReason: (tableId, source) => this.wagerConsole.runtimeBlockReason(tableId, source),
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
    // FIX(D-P1-1 wiring): 启动恢复必须把"上一进程遗留的 RESERVED 敞口"统一升级为
    // UNKNOWN(restored-unsettled-exposure)。修复前 refreshAccountingIncidents 里的
    // escalateOverdueReservations 用 notBefore=runtimeStartedAt 永久跳过重启前敞口，
    // 而 expireOpenForShoe 又跳过有回执的预留 —— 结果那笔既不会升级、也不会被清理、
    // 操作员还不能 writeOffUnknown（review 脚本 a7 / a2g 实证：永久占坑）。
    // 这里不走 notBefore（那是运行期语义，保留不动），启动恢复专管跨进程收口。
    this.orchestrator.escalateRestoredExposures();
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
    this.monitorConsole.syncLiveApprovalsToMonitorTables();
  }

  private observedGameCount(tableId: string, incoming?: number): number | undefined {
    return this.monitorConsole.observedGameCount(tableId, incoming);
  }

  private refreshTableMetadataFromRooms(rooms: readonly RoomDescriptor[]): void {
    this.monitorConsole.refreshTableMetadataFromRooms(rooms);
  }

  private copyWinfinityAliasMetadata(): void {
    this.monitorConsole.copyWinfinityAliasMetadata();
  }

  private recoverMissedShuffles(rooms: readonly RoomDescriptor[]): void {
    this.monitorConsole.recoverMissedShuffles(rooms);
  }

  private persistTableMetadata(): void {
    this.monitorConsole.persistTableMetadata();
  }

  private pendingJoinTableIds(): string[] {
    return this.monitorConsole.pendingJoinTableIds();
  }

  private keepaliveEligibleTableIds(): string[] {
    return this.monitorConsole.keepaliveEligibleTableIds();
  }

  private observedTableIds(): string[] {
    return this.monitorConsole.observedTableIds();
  }

  private isObservedTable(tableId: string): boolean {
    return this.monitorConsole.isObservedTable(tableId);
  }

  private clearStaleRoadCount(tableId: string): void {
    this.monitorConsole.clearStaleRoadCount(tableId);
  }

  private holdDemotedPendingTable(tableId: string, shoeId?: string): void {
    this.monitorConsole.holdDemotedPendingTable(tableId, shoeId);
  }

  private clearDemotedPendingTable(tableId: string): void {
    this.monitorConsole.clearDemotedPendingTable(tableId);
  }

  private canAutoPromotePendingTable(tableId: string, incomingShoeId?: string): boolean {
    return this.monitorConsole.canAutoPromotePendingTable(tableId, incomingShoeId);
  }

  private collapsedWinfinityTableIds(tableIds: readonly string[], introduceAliases = true): string[] {
    return this.monitorConsole.collapsedWinfinityTableIds(tableIds, introduceAliases);
  }

  private sameTableIdList(left: readonly string[], right: readonly string[]): boolean {
    return this.monitorConsole.sameTableIdList(left, right);
  }

  private promotePendingTable(tableId: string, incomingShoeId?: string): void {
    this.monitorConsole.promotePendingTable(tableId, incomingShoeId);
  }

  private promotePendingTablesFromRooms(rooms: readonly RoomDescriptor[]): void {
    this.monitorConsole.promotePendingTablesFromRooms(rooms);
  }

  private demoteAnomalousMonitorTable(
    tableId: string,
    handNumber: number,
    roadCount: number,
    missingCards: number,
    shoeId?: string,
  ): boolean {
    return this.monitorConsole.demoteAnomalousMonitorTable(tableId, handNumber, roadCount, missingCards, shoeId);
  }

  private scheduleDemotedTableFeedStop(tableId: string): void {
    this.monitorConsole.scheduleDemotedTableFeedStop(tableId);
  }

  private demoteIfGameCountAnomaly(tableId: string): boolean {
    return this.monitorConsole.demoteIfGameCountAnomaly(tableId);
  }

  private ensureMonitorActors(
    tableIds: readonly string[],
    inheritedSettings?: UnifiedBetSettings,
  ): void {
    this.monitorConsole.ensureMonitorActors(tableIds, inheritedSettings);
  }

  currentUnifiedTableSettings(): UnifiedBetSettings | undefined {
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

  applyUnifiedBetSettingsToTables(tableIds: readonly string[]): void {
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

  private initializeFailClosedRuntime(): Promise<void> {
    return this.executionGateConsole.initializeFailClosedRuntime();
  }

  private canExecuteAutomaticBets(tableId: string): boolean {
    return this.executionGateConsole.canExecuteAutomaticBets(tableId);
  }

  private hasSettlementGap(tableId: string): boolean {
    return this.runtimeIncidents.hasActive('settlement-gap', tableId);
  }

  ensureRuntimeIncident(input: {
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

  refreshAccountingIncidents(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastAccountingRefreshAt < ACCOUNTING_REFRESH_MIN_MS) return;
    this.lastAccountingRefreshAt = now;
    // 已提交（有回执）却长期等不到结算的预留，永远停在 RESERVED 会静默占满
    // 全局敞口与并发额度。这里把它升级成 UNKNOWN：敞口照旧占用（未知的钱
    // 不能当没发生），但状态变成显式可勾销，操作员不会再面对一个不可见、
    // 也无法处置的额度黑洞。
    this.orchestrator.escalateOverdueReservations(
      SETTLEMENT_OVERDUE_MS,
      now,
      'unsettled-past-timeout',
      this.runtimeStartedAt,
    );
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

  /**
   * FIX(P2-5): 启动定期裁剪。每 10 分钟一次，只裁剪"每桌最近 N 手"以外的历史，
   * 且永不触碰仍有 RESERVED/UNKNOWN 敞口的手（见 `pruneMonitorHistory` 实现）。
   *
   * 为什么是 10 分钟：一靴约 45-80 分钟，10 分钟粒度既能让单次裁剪量很小（不是一次性
   * 大事务卡住事件泵），也远快于 3.7GB/月 的增长速度。定时器 `unref()` 掉，不阻止进程退出。
   */
  startMonitorHistoryCompaction(intervalMs = MONITOR_HISTORY_COMPACT_INTERVAL_MS): void {
    if (this.monitorHistoryPruneTimer !== undefined) return;
    this.monitorHistoryPruneTimer = setInterval(() => {
      if (this.closing) return;
      try {
        this.compactMonitorHistory();
      } catch (error) {
        // 裁剪失败不能影响下注/监控：记一条 degraded 事故即可。
        this.recordLiveMonitorError(error, 'scheduler-failure', 'degraded');
      }
    }, Math.max(60_000, intervalMs));
    this.monitorHistoryPruneTimer.unref?.();
  }

  stopMonitorHistoryCompaction(): void {
    if (this.monitorHistoryPruneTimer === undefined) return;
    clearInterval(this.monitorHistoryPruneTimer);
    this.monitorHistoryPruneTimer = undefined;
  }

  /** 聚合复盘报表（只读）：按靴汇总的结算/盈亏、UNKNOWN 敞口、断连排行。 */
  performanceReport(): DesktopPerformanceReport {
    const reservations = this.orchestrator.getReservations();
    const reservationsByStatus: Record<string, number> = {};
    let realizedPnl = 0;
    let unknownCount = 0;
    let unknownExposure = 0;
    const byShoe = new Map<string, DesktopPerformanceReport['byShoe'][number]>();
    for (const reservation of reservations) {
      reservationsByStatus[reservation.status] = (reservationsByStatus[reservation.status] ?? 0) + 1;
      if (reservation.status === 'UNKNOWN') {
        unknownCount += 1;
        unknownExposure += reservation.maxLoss;
      }
      if (reservation.status === 'SETTLED' && typeof reservation.realizedPnl === 'number') {
        realizedPnl += reservation.realizedPnl;
        const key = `${reservation.tableId}|${reservation.shoeId}`;
        const entry = byShoe.get(key)
          ?? { tableId: reservation.tableId, shoeId: reservation.shoeId, hands: 0, stake: 0, realizedPnl: 0 };
        entry.hands += 1;
        entry.stake += reservation.amount;
        entry.realizedPnl += reservation.realizedPnl;
        byShoe.set(key, entry);
      }
    }
    const disconnectRanking = [...this.tableFlapStats.entries()]
      .map(([tableId, stats]) => ({ tableId, disconnects: stats.disconnects, lastDisconnectAt: stats.lastDisconnectAt }))
      .sort((left, right) => right.disconnects - left.disconnects || left.tableId.localeCompare(right.tableId))
      .slice(0, 10);
    return {
      generatedAt: new Date().toISOString(),
      totals: { reservations: reservations.length, realizedPnl, unknownCount, unknownExposure },
      byShoe: [...byShoe.values()].sort((left, right) => right.realizedPnl - left.realizedPnl),
      reservationsByStatus,
      disconnectRanking,
    };
  }

  detectSettlementGap(
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

  resolveSettlementGapIfCleared(tableId: string): void {
    const actor = this.orchestrator.getActor(tableId);
    if (!actor) return;
    const currentHandId = actor.getProjection().currentHandId;
    const stillMissing = this.orchestrator.getReservations(tableId).some(reservation =>
      reservation.status === 'RESERVED'
      && currentHandId !== null
      && reservation.handId !== currentHandId);
    if (!stillMissing) this.runtimeIncidents.resolve('settlement-gap', tableId);
  }

  bridgeRuntimeStatus(): DesktopRuntimeState['bridge'] {
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

  liveTableReasons(
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

  /** FIX(D-P0-1): 保活/无人值守执行路径的阻断原因；授权是硬门控。 */
  keepaliveTableReasons(
    tableId: string,
    requireAuthorization = true,
  ): LiveExecutionBlockReason[] {
    // Fail-closed (#16 / AGENTS.md): keepalive is a platform-reaching path and
    // still requires physical-shoe. Do not strip physical-shoe-baseline-unknown.
    const reasons = this.liveTableReasons(tableId);
    // FIX(D-P0-1): 无人值守运行授权是保活路径的硬门控。
    //
    // 修复前这里只转调 liveTableReasons（桥/feed/牌靴/缺口/UNKNOWN），完全不看
    // liveAuthorizationSources：多桌时 failCloseLiveExecution 因"别的桌还有授权"
    // 直接 return，被撤销授权的那桌 promote 后首个窗口就能发真金保活
    // （review 脚本 a1h / a1d 实证桥收到 source=keepalive 的请求）。
    //
    // requireAuthorization=false 只给 reconcileUnattendedExecution 用：那里的语义是
    // "要不要**建立**授权"，如果把"尚未授权"也算成阻断原因，就永远建立不了授权
    // （死锁）。执行路径（保活 tick / 手动受控下注）一律默认严格。
    if (requireAuthorization && !this.liveAuthorizationSources.has(tableId)) {
      reasons.push('table-not-authorized');
    }
    return reasons;
  }

  manualLiveTableReasons(
    tableId: string,
    approved = true,
    allowNewAuthorization = true,
  ): LiveExecutionBlockReason[] {
    const reasons = this.liveTableReasons(tableId, approved);
    // FIX(D-P0-1): 手动下注是操作员显式动作，**允许本次调用建立**运行授权
    // （修复前 execute() 就是临时打开 live gate + operational executor，不要求
    // 既有 liveAuthorizationSources；把未授权当成手动阻断会把首次手动下注锁死）。
    // 只有调用方显式声明"本次不得新建授权"（只读预检 / UI 展示）时才追加该原因。
    if (!allowNewAuthorization && !this.liveAuthorizationSources.has(tableId)) {
      reasons.push('table-not-authorized');
    }
    return reasons;
  }

  /**
   * FIX(D-P1-6): 当前是否存在**全局级**（tableId === undefined）blocked 事故。
   *
   * 修复前这类事故只影响 `runtimeSnapshot().status` 与 UI 横幅：桥在
   * continuity-invalidated / session-recovery-exhausted 之后仍可能"已认证、连接数 1"，
   * 单桌 liveTableReasons 为空，于是操作员看到"无人值守执行已阻断"却仍能手动下注
   * （review 脚本 a1b 实证 ACCEPTED + 桥收到请求）。
   */
  activeGlobalBlockedIncidentCode(): RuntimeIncidentCode | undefined {
    return this.runtimeIncidents.list().find(incident =>
      incident.active
      && incident.severity === 'blocked'
      && incident.tableId === undefined)?.code;
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
    const executorStatus = this.browserBridge?.getExecutorStatus();
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
      ...(executorStatus === undefined ? {} : {
        executor: {
          activeExecutorCount: executorStatus.active_executor_count,
          ...(executorStatus.leaseId === undefined ? {} : { leaseId: executorStatus.leaseId }),
          ...(executorStatus.profileId === undefined ? {} : { profileId: executorStatus.profileId }),
        },
      }),
    };
  }

  private async setPersistentLiveGate(enabled: boolean): Promise<void> {
    return this.executionGateConsole.setPersistentLiveGate(enabled);
  }

  async reconcileUnattendedExecution(): Promise<void> {
    return this.executionGateConsole.reconcileUnattendedExecution();
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
          // FIX(P0-1): 该 installId 已被批准并升级为 extension 角色，待批准事故自动收敛。
          this.runtimeIncidents.resolveAll('bridge-extension-pairing-required');
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
        case 'extension-pairing-required':
          // FIX(P0-1): 未批准的扩展只能拿到 pending 角色（拿不到 lease、收不到 betRequest）。
          // 这里只记一条 degraded 事故，**不阻断**真实执行路径——真正的阻断在桥层：
          // pending socket 不属于 extension 角色，requestBet 会因"无已认证扩展"而失败关闭。
          // installId 不写入事故消息（避免把本机标识留在持久化日志里），只进 pending 列表。
          this.ensureRuntimeIncident({
            code: 'bridge-extension-pairing-required',
            severity: 'degraded',
            message: 'browser extension awaiting operator approval',
          });
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
  nextMonitorSourceSeq(tableId: string): number {
    return this.liveFeedConsole.nextMonitorSourceSeq(tableId);
  }

  enqueueLiveMonitorOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.liveMonitorOperation.then(operation, operation);
    this.liveMonitorOperation = run.then(() => undefined, () => undefined);
    return run;
  }

  enqueueExecutionStateOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.executionStateOperation.then(operation, operation);
    this.executionStateOperation = run.then(() => undefined, () => undefined);
    return run;
  }

  setOrchestratorExecutor(executor: Pick<BrowserAdapter, 'requestBet'> | null): void {
    this.currentExecutor = executor;
    this.orchestrator.setExecutor(executor);
  }

  setOperationalWagerExecutor(enabled: boolean): void {
    this.orchestrator.setOperationalExecutor(enabled ? {
      requestOperationalWager: request =>
        this.browserBridge?.requestOperationalWager(request) ?? Promise.resolve(null),
    } : null);
  }

  currentMonitorTableIds(): readonly string[] {
    return this.pendingMonitorTableIds ?? this.monitorTableIds;
  }

  private isMonitorTableSelected(tableId: string): boolean {
    return this.currentMonitorTableIds().includes(tableId);
  }

  private isCurrentLiveFeed(tableId: string, feed: TableExport): boolean {
    return this.liveFeedConsole.isCurrentLiveFeed(tableId, feed);
  }

  private isLiveTableFeedEvent(event: NormalizedEvent): boolean {
    return this.liveFeedConsole.isLiveTableFeedEvent(event);
  }

  private async restoreDisconnectedFeed(event: NormalizedEvent): Promise<NormalizedEvent> {
    return this.liveFeedConsole.restoreDisconnectedFeed(event);
  }

  private async enqueueMonitorEvent(event: NormalizedEvent): Promise<void> {
    return this.liveFeedConsole.enqueueMonitorEvent(event);
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

  async rearmPairAutomation(tableId: string): Promise<void> {
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

  recordLiveMonitorError(
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

  async resetMonitorExecutionState(tableId: string): Promise<void> {
    return this.executionGateConsole.resetMonitorExecutionState(tableId);
  }

  private hasLiveExposure(tableId: string): boolean {
    return this.executionGateConsole.hasLiveExposure(tableId);
  }

  private failCloseExposedTables(tableIds: readonly string[]): Promise<void> {
    return this.executionGateConsole.failCloseExposedTables(tableIds);
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

  async failCloseLiveExecution(tableIds: readonly string[]): Promise<void> {
    return this.executionGateConsole.failCloseLiveExecution(tableIds);
  }

  async stopLiveFeed(tableId: string, feed: TableExport): Promise<void> {
    return this.liveFeedConsole.stopLiveFeed(tableId, feed);
  }

  async stopLiveFeedForTransition(
    tableId: string,
    feed: TableExport,
  ): Promise<MonitorFeedTransitionStopResult> {
    return this.liveFeedConsole.stopLiveFeedForTransition(tableId, feed);
  }

  private cancelDisconnectedMonitorRemoval(tableId: string): void {
    this.liveFeedConsole.cancelDisconnectedMonitorRemoval(tableId);
  }

  private scheduleDisconnectedMonitorRemoval(tableId: string, reason?: string): void {
    this.liveFeedConsole.scheduleDisconnectedMonitorRemoval(tableId, reason);
  }

  private async removeDisconnectedMonitorTable(tableId: string): Promise<void> {
    return this.liveFeedConsole.removeDisconnectedMonitorTable(tableId);
  }

  private resolveTransientTableIncidents(tableId: string): void {
    this.liveFeedConsole.resolveTransientTableIncidents(tableId);
  }


  private seedBgShoeSequencesFromLedger(): void {
    this.browserBridge?.seedBgShoeSequences(this.ledger.listBgShoeGenerations());
  }

  /**
   * FIX(D-P0-1): 操作员批准名单。
   *
   * 内存版是**有意的**：批准关系必须随进程重启重新确认（fail-closed），
   * 否则一次误批准会永久留在磁盘上。启动桥时把它传给 `BrowserBridgeServer`
   * 即进入严格模式 —— 未批准的 installId 只能停在 pending，拿不到 executor
   * lease、收不到 betRequest，伪造 Origin+token 的本机进程（b7d）因此无法接管。
   */
  readonly extensionApprovals = new MemoryExtensionApprovalStore();

  async startBrowserBridge(port = 17890): Promise<{ port: number }> {
    if (!this.browserBridge) {
      const bridge = new BrowserBridgeServer({
        port,
        selectedTableIds: this.monitorTableIds,
        requireExtensionSequence: true,
        allowedExtensionIds: [...BUNDLED_BROWSER_EXTENSION_IDS],
        extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
        onRuntimeEvent: event => this.handleBridgeRuntimeEvent(event),
        extensionApprovals: this.extensionApprovals,
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

  /** FIX(D-P0-1): 待批准的扩展身份（完整 installId 只在这里返回，供 IPC 使用）。 */
  listPendingExtensions(): BridgeExtensionPendingEntry[] {
    return this.browserBridge?.listPendingExtensions() ?? [];
  }

  /** FIX(D-P0-1): 批准某个扩展身份，立即把它的 pending 连接提升为 extension 角色。 */
  approveExtension(installId: string): void {
    const bridge = this.browserBridge;
    if (!bridge) throw new Error('browser bridge is not running');
    bridge.approveExtension(installId);
    this.runtimeIncidents.resolveAll('bridge-extension-pairing-required');
    this.cachedLightSnapshot = undefined;
  }

  /** FIX(D-P0-1): 撤销批准；正在使用该身份的扩展连接会被桥以 1008 关闭。 */
  revokeExtension(installId: string): void {
    const bridge = this.browserBridge;
    if (!bridge) throw new Error('browser bridge is not running');
    bridge.revokeExtension(installId);
    this.cachedLightSnapshot = undefined;
  }

  /** FIX(D-P0-1): 批准状态（含 pending socket 计数），供 UI 渲染安全闸。 */
  extensionApprovalState(): DesktopExtensionApprovalState {
    const bridge = this.browserBridge;
    if (!bridge) {
      return {
        strict: true,
        pendingCount: 0,
        unidentifiedPendingConnections: 0,
        pending: [],
        approved: [],
      };
    }
    const state = bridge.getExtensionApprovalState();
    return {
      strict: state.strict,
      pendingCount: state.pending.length,
      unidentifiedPendingConnections: state.unidentifiedPendingConnections,
      pending: state.pending.map(entry => ({
        installIdShort: shortExtensionInstallId(entry.installId),
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
      })),
      approved: state.approved.map(installId => ({
        installIdShort: shortExtensionInstallId(installId),
        firstSeenAt: '',
        lastSeenAt: '',
      })),
    };
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
    return this.liveFeedConsole.attachLiveTables();
  }

  async attachLiveTablesInner(): Promise<void> {
    return this.liveFeedConsole.attachLiveTablesInner();
  }

  isOpen(): boolean {
    return this.ledger.isOpen();
  }

  monitorCandidates(): MonitorTableCandidate[] {
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
    const aliases = this.browserBridge?.winfinityLockedAliases();
    if (aliases !== undefined) {
      for (const [vendor, publicId] of aliases) {
        const fallback = `wnf-${vendor}`;
        if (fallback === publicId) continue;
        const from = candidates.get(fallback);
        const to = candidates.get(publicId);
        if (from === undefined || to === undefined) continue;
        candidates.set(publicId, {
          ...to,
          ...(to.displayName === undefined && from.displayName !== undefined ? { displayName: from.displayName } : {}),
          ...(to.gameCount === undefined && from.gameCount !== undefined ? { gameCount: from.gameCount } : {}),
          ...(to.roundId === undefined && from.roundId !== undefined ? { roundId: from.roundId } : {}),
        });
      }
    }
    const collapsedIds = collapseWinfinityDuplicateTableIds([...candidates.keys()], {
      aliasByVendor: aliases,
      tables: [...candidates.values()],
      preferIds: this.monitorTableIds,
      introduceAliases: false,
    });
    return collapsedIds.flatMap(tableId => {
      const candidate = candidates.get(tableId);
      return candidate === undefined ? [] : [candidate];
    }).sort((left, right) =>
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
    const demoTableIds = this.demoConsole.demoRunning
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
    const tableBeads: Record<string, readonly DesktopBeadHand[]> = {};
    if (this.browserBridge) {
      for (const tableId of displayedTableIds) {
        const beads = this.browserBridge.tableBeads(tableId);
        if (beads !== undefined && beads.length > 0) tableBeads[tableId] = beads;
      }
    }
    const filterToDisplayedTables = <T extends { tableId: string }>(rows: readonly T[]): T[] =>
      usingLiveMonitor ? rows.filter(row => activeTableIds.has(row.tableId)) : [...rows];
    const keepalive = this.operationalWagers.getKeepaliveState();
    const events = includeHistory
      ? this.ledger.listEvents()
      : this.ledger.listRecentDisplayEventsForTables(displayedTableIds, 24);
    // FIX(D-P2-4): 轻量快照不再全量返回历史 events/decisions/receipts —— 10 万条事件时
    // 单次 610ms / 32.5MB（review 脚本 b8b 实证），而所有写操作后都走这条路。
    // 但**保留** UI 与操作员真实需要的运营态：
    //  · reservations：内存里的预留（含刚结算的那笔），KPI/账本/勾销入口依赖；
    //  · operationalWagers：受控下注审计尾巴（≤100 条，本来就是 tail 查询）。
    // 历史复盘仍走 `queryRecords(...)` 分页与账本/事件视图的全量快照。
    const decisions: ReturnType<SqliteLedger['listDecisions']> = includeHistory ? this.ledger.listDecisions() : [];
    const receipts: ReturnType<SqliteLedger['listReceipts']> = includeHistory ? this.ledger.listReceipts() : [];
    const reservations = this.orchestrator.getReservations();
    const operationalWagers = this.ledger.listOperationalWagersTail();
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
      seed: this.demoConsole.lastSeed,
      snapshot,
      monitorTableIds: [...this.monitorTableIds],
      monitorCandidates,
      tableMetadata,
      shoeEvidence,
      tableBeads,
      recordCounts,
      keepalive,
      automation: { enabled: this.automationEnabled },
      runtime: this.runtimeSnapshot(),
      // FIX(D-P2-4): 受控下注审计记录按记录内的 wager.tableId 过滤（记录本身没有 tableId 字段）。
      operationalWagers: usingLiveMonitor
        ? operationalWagers.filter(record => activeTableIds.has(record.wager.tableId))
        : operationalWagers,
      events: filterToDisplayedTables(events),
      decisions: filterToDisplayedTables(decisions),
      receipts: filterToDisplayedTables(receipts),
      reservations: filterToDisplayedTables(reservations),
      demoRunning: this.demoConsole.demoRunning,
      demoSpeed: this.demoConsole.demoSpeed,
      summary: {
        ...summary,
        rows: summary.rows.filter(row => activeTableIds.has(row.tableId)),
      },
      // FIX(D-P0-1): 批准状态进快照，UI 才能轮询到"有扩展等待批准"的安全闸。
      // 只含 installId 前 8 位；完整值不进 snapshot。
      extensionApproval: this.extensionApprovalState(),
      demoError: this.demoError,
    };
    if (lightKey) this.cachedLightSnapshot = { key: lightKey, at: now, value: result };
    return result;
  }

  async runDemo(seed?: number): Promise<DesktopConsoleSnapshot> {
    this.demoError = undefined;
    return this.demoConsole.runDemo(seed);
  }

  async startDemo(seed?: number): Promise<DesktopConsoleSnapshot> {
    this.demoError = undefined;
    return this.demoConsole.startDemo(seed);
  }

  async stopDemo(): Promise<DesktopConsoleSnapshot> {
    return this.demoConsole.stopDemo();
  }

  setDemoSpeed(speed: number): DesktopConsoleSnapshot {
    return this.demoConsole.setDemoSpeed(speed);
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

  /**
   * FIX(D-P2-4): 写操作后的轻量快照。
   *
   * 先作废 500ms 轻量快照缓存，再取新快照 —— 否则"改设置/确认牌靴/勾销之后紧接着
   * 返回给渲染层的快照"可能命中写操作之前的缓存，UI 会显示旧配置（测试
   * `snapshot-cache.test.ts` 正是守着这个坑）。
   */
  private lightWriteSnapshot(): DesktopConsoleSnapshot {
    this.cachedLightSnapshot = undefined;
    return this.snapshot(LIGHT_WRITE_SNAPSHOT);
  }

  async updateTableSettings(tableId: string, settings: TableSettingsUpdate): Promise<DesktopConsoleSnapshot> {
    this.orchestrator.updateTableSettings(tableId, { ...settings, minEV: Math.max(0, settings.minEV) });
    // FIX(D-P2-4): 写路径只回轻量快照。
    return this.lightWriteSnapshot();
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
    // FIX(D-P2-4): 写路径只回轻量快照。
    return this.lightWriteSnapshot();
  }

  async updateMonitorTableIds(tableIds: readonly string[]): Promise<DesktopConsoleSnapshot> {
    const nextTableIds = normalizeMonitorTableIds(tableIds, true).slice(0, MAX_LIVE_MONITOR_TABLES);
    return await this.enqueueLiveMonitorOperation(() => this.updateMonitorTableIdsInner(nextTableIds));
  }

  private async applyCollapsedWinfinityMonitorTables(): Promise<void> {
    await this.monitorConsole.applyCollapsedWinfinityMonitorTables();
  }

  private async updateMonitorTableIdsInner(nextTableIds: readonly string[]): Promise<DesktopConsoleSnapshot> {
    return this.monitorConsole.updateMonitorTableIdsInner(nextTableIds);
  }

  async registerTable(
    profile: TableProfile,
    _executionMode: 'shadow' | 'simulated' | 'live',
    defaultBetAmount: number,
  ): Promise<DesktopConsoleSnapshot> {
    this.orchestrator.registerTable({ ...profile, minEV: Math.max(0, profile.minEV) }, 'live', defaultBetAmount);
    // FIX(D-P2-4): 写路径只回轻量快照。
    return this.lightWriteSnapshot();
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
    // FIX(D-P2-4): 写路径只回轻量快照。
    return this.lightWriteSnapshot();
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
      // FIX(D-P2-4): 写路径只回轻量快照。
      return this.lightWriteSnapshot();
    });
  }

  /**
   * 切换执行模式。
   *
   * FIX(D-P0-4): 修复前签名里的 `_mode` 被直接丢弃，函数体**无条件**执行
   * liveApprovals.approve + setPersistentLiveGate(true) + 装真金 executor +
   * liveAuthorizationSources.set('manual')。于是"切到影子模式"实际上是在 arm
   * 真金执行器：操作员以为在演练，下一笔手动下注就 ACCEPTED 并发出真金请求
   * （review 脚本 a1e 实证）。preload/IPC 都还暴露着这条路径。
   *
   * 本构建不支持 shadow/simulated 运行时（orchestrator 的 TableActor 也强制 live），
   * 所以直接拒绝 —— fail-closed：宁可报错，也不能假装降级却打开真金通道。
   */
  async setExecutionMode(tableId: string, mode: 'shadow' | 'simulated' | 'live'): Promise<DesktopConsoleSnapshot> {
    if (mode === 'shadow' || mode === 'simulated') {
      throw new Error('execution mode cannot be downgraded from live; shadow simulation is not supported in this build');
    }
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
    return this.wagerConsole.execute(input);
  }

    async reconcileUnknownOperationalWager(
    command: DesktopUnknownWagerReconciliationCommand,
  ): Promise<DesktopConsoleSnapshot> {
    return this.wagerConsole.reconcileUnknown(command);
  }

    async writeOffUnknownOperationalWager(
    command: DesktopUnknownWagerWriteOffCommand,
  ): Promise<DesktopConsoleSnapshot> {
    return this.wagerConsole.writeOffUnknown(command);
  }

    async settlePendingOperationalWager(
    command: DesktopPendingSettlementCommand,
  ): Promise<DesktopConsoleSnapshot> {
    return this.wagerConsole.settlePending(command);
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
      // FIX(D-P2-4): 写路径只回轻量快照。
      return this.lightWriteSnapshot();
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
      // FIX(D-P2-4): 写路径只回轻量快照。
      return this.lightWriteSnapshot();
    });
  }

  async setAutomationEnabled(enabled: boolean): Promise<DesktopConsoleSnapshot> {
    return await this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      this.automationEnabled = enabled;
      this.ledger.setConfig(AUTOMATION_CONFIG_KEY, { enabled });
      await this.reconcilePairAutomation(enabled);
      await this.reconcileUnattendedExecution();
      // FIX(D-P2-4): 写路径只回轻量快照。
      return this.lightWriteSnapshot();
    });
  }

  acknowledgeRuntimeIncident(incidentId: string): DesktopConsoleSnapshot {
    const normalized = incidentId.trim();
    if (normalized.length === 0) throw new TypeError('incident id must not be empty');
    this.runtimeIncidents.acknowledge(normalized);
    // FIX(D-P2-4): 写路径只回轻量快照。
    return this.lightWriteSnapshot();
  }

  acknowledgeAllRuntimeIncidents(): DesktopConsoleSnapshot {
    this.runtimeIncidents.acknowledgeAllActive();
    // FIX(D-P2-4): 写路径只回轻量快照。
    return this.lightWriteSnapshot();
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
    // FIX(D-P2-4): 写路径只回轻量快照。
    return this.lightWriteSnapshot();
  }

  async updateRiskLimits(limits: RiskLimits): Promise<DesktopConsoleSnapshot> {
    this.orchestrator.updateRiskLimits(limits);
    // FIX(D-P2-4): 写路径只回轻量快照。
    return this.lightWriteSnapshot();
  }

  /**
   * 清除监控记录。
   *
   * FIX(D-P2-2): 风控计数（dayLoss / tableLosses / shoeLosses）由
   * `SqliteLedger.clearMonitorData()` 保留、`RiskManager` 自己也持有同一份状态，
   * 所以"清账"不会把止损额度归零。这里加一道**兜底断言式保护**：万一上游
   * 语义再被改回去，就在 service 层拒绝并报错，而不是静默把风控清零。
   */
  async clearMonitorData(): Promise<DesktopConsoleSnapshot> {
    await this.stopDemo();
    const riskBefore = this.orchestrator.getRiskState();
    await this.orchestrator.clearMonitorData();
    const riskAfter = this.orchestrator.getRiskState();
    const riskCountersPreserved = riskAfter.dayLoss === riskBefore.dayLoss
      && JSON.stringify(riskAfter.tableLosses) === JSON.stringify(riskBefore.tableLosses)
      && JSON.stringify(riskAfter.shoeLosses) === JSON.stringify(riskBefore.shoeLosses);
    if (!riskCountersPreserved) {
      throw new Error(
        'clearMonitorData reset risk counters (dayLoss/tableLosses/shoeLosses); refusing to continue — '
        + 'clearing records must not reset stop-loss accounting',
      );
    }
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
    this.demoConsole.lastSeed = undefined;
    this.demoError = undefined;
    // 清除记录后 UI 需要重新拿全量（账本/事件视图），这里保留全量快照。
    return this.snapshot();
  }

  async close(): Promise<void> {
    this.closing = true;
    // FIX(P2-5): 先停裁剪定时器，避免关闭过程中还在动账本。
    this.stopMonitorHistoryCompaction();
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

function assertNeverOneShotBetResult(value: never): never {
  throw new Error(`unexpected one-shot bet result: ${String(value)}`);
}

function assertNeverBridgeRuntimeEvent(value: never): never {
  throw new Error(`unexpected browser bridge runtime event: ${String(value)}`);
}

