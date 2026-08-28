import { SimulatedAdapter, type BrowserAdapter } from '@baccarat/adapter-contract';
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
import { SqliteLedger, type MonitorSummary, type MonitorSummaryOptions } from '@baccarat/ledger-state';
import {
  Orchestrator,
  STANDARD_COMMISSION_BACCARAT_TERMS,
  type OneShotBetCommand,
  type OneShotBetResult,
  type OrchestratorSnapshot,
  type TableSettingsUpdate,
} from '@baccarat/orchestrator';
import {
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_TOKEN,
  BrowserBridgeServer,
  type BrowserBridgeRuntimeEvent,
} from '@baccarat/browser-bridge';
import {
  ShadowRoomMonitor,
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
  type DesktopUnknownWagerReconciliationCommand,
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

const DEFAULT_APPROVED_LIVE_TABLE_IDS = ['D066', 'D067', 'D056', 'D057'] as const;
const MONITOR_TABLE_CONFIG_KEY = 'desktop:monitor-tables:v1';
const MONITOR_TABLE_ID_PATTERN = /^[A-Z]{1,4}\d{2,6}$/;
const MAX_LIVE_FEED_STALENESS_MS = 45_000;
const LIVE_MONITOR_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;

type MonitorTableConfig = {
  readonly tableIds: readonly string[];
};

interface OneShotLiveBetActor {
  placeOneShotBet(command: OneShotBetCommand): Promise<OneShotBetResult>;
}

function hasOneShotLiveBetActor(value: unknown): value is OneShotLiveBetActor {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'placeOneShotBet') === 'function';
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
    const tableId = rawTableId.trim().toUpperCase();
    if (!MONITOR_TABLE_ID_PATTERN.test(tableId)) {
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

function defaultMonitorTableIds(): string[] {
  const rawTableIds = String(process.env.BACCARAT_LIVE_TABLES || DEFAULT_APPROVED_LIVE_TABLE_IDS.join(','))
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0);
  return normalizeMonitorTableIds(rawTableIds);
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
  private readonly monitorSourceSeq = new Map<string, number>();
  private browserBridge?: BrowserBridgeServer;
  private browserBridgePort = 0;
  private liveExecutionMode: ExecutionMode = 'shadow';
  private readonly liveFeeds = new Map<string, TableExport>();
  private readonly runtimeObservedTableIds = new Set<string>();
  private readonly liveAuthorizationSources = new Map<string, 'manual' | 'unattended'>();
  private persistentLiveGateEnabled = false;
  private liveRoomTimer?: NodeJS.Timeout;
  private liveMonitorRetryAttempt = 0;
  private liveMonitorOperation: Promise<void> = Promise.resolve();
  private liveMonitorActivated = false;
  private oneShotLiveBetInFlight: Promise<OneShotLiveBetResult> | null = null;
  private executionStateOperation: Promise<void> = Promise.resolve();
  private cachedRecordCounts?: DesktopRecordCounts;
  private cachedSummary?: MonitorSummary;
  private closing = false;
  /** The transient allowlist used only while a serialized live transition is being validated. */
  private pendingMonitorTableIds?: readonly string[];
  /** Operator-managed, persisted ordered selection; mutation is the configuration operation. */
  private monitorTableIds: string[];

  constructor(readonly dbPath: string) {
    this.ledger = new SqliteLedger(dbPath);
    const defaultExecutor = new SimulatedAdapter({ events: [] });
    this.currentExecutor = defaultExecutor;
    this.orchestrator = new Orchestrator({
      ledger: this.ledger,
      riskLimits: defaultConsoleLimits(),
      executor: defaultExecutor,
      operationalWagerTerms: STANDARD_COMMISSION_BACCARAT_TERMS,
      canExecuteAutomaticBets: tableId => this.canExecuteAutomaticBets(tableId),
      onBettingWindowOpened: () => {
        void this.operationalWagers.tick().catch(error => {
          this.recordLiveMonitorError(error, 'scheduler-failure', 'degraded');
        });
      },
    });
    const persistedLiveTableIds = Object.values(this.orchestrator.listTableConfigs())
      .filter(config => config.executionMode === 'live')
      .map(config => config.profile.tableId);
    this.liveApprovals = new LiveApprovalStore(this.ledger, persistedLiveTableIds);
    this.runtimeIncidents = new RuntimeIncidentStore(this.ledger);
    this.monitorTableIds = this.loadMonitorTableIds();
    this.liveApprovals.retain(this.monitorTableIds);
    this.operationalWagers = new OperationalWagerCoordinator({
      ledger: this.ledger,
      actor: tableId => this.orchestrator.getActor(tableId),
      monitorTableIds: () => this.monitorTableIds,
      serialize: async operation => await this.enqueueExecutionStateOperation(operation),
      runtimeBlockReason: tableId => this.operationalWagerRuntimeBlockReason(tableId),
      onError: error => this.recordLiveMonitorError(error, 'scheduler-failure', 'degraded'),
    });
    this.normalizeEvFloor();
    this.startupFailCloseTask = this.initializeFailClosedRuntime();
    this.refreshAccountingIncidents();
  }

  private loadMonitorTableIds(): string[] {
    const configured = monitorTableIdsFromConfig(this.ledger.getConfig<unknown>(MONITOR_TABLE_CONFIG_KEY));
    if (configured !== null) return configured;
    const defaults = defaultMonitorTableIds();
    this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: defaults });
    return defaults;
  }

  private ensureMonitorActors(tableIds: readonly string[]): void {
    for (const tableId of tableIds) {
      if (!this.orchestrator.getActor(tableId)) {
        this.orchestrator.registerTable(defaultProfile(tableId), 'shadow', 100);
      }
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
      const approved = this.liveApprovals.has(actor.tableId);
      if (actor.snapshot().executionMode === 'live' || approved) {
        actor.setExecutionMode('shadow');
      }
      const projection = actor.getProjection();
      if (projection.autoBetStatus === 'ARMED' && approved) {
        await actor.setAutoBet(false, projection.shoeId || undefined);
      }
      if (approved && projection.shoeId && projection.connectionStatus !== 'DISCONNECTED') {
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
    this.setOrchestratorExecutor(new SimulatedAdapter({ events: [] }));
    this.setOperationalWagerExecutor(false);
  }

  private canExecuteAutomaticBets(tableId: string): boolean {
    if (!this.operationalWagers.getKeepaliveState().enabled) return false;
    if (this.liveApprovals.has(tableId) && !this.liveAuthorizationSources.has(tableId)) return false;
    const actor = this.orchestrator.getActor(tableId);
    if (actor?.snapshot().executionMode !== 'live') return true;
    return this.liveAuthorizationSources.has(tableId)
      && !this.hasUnknownExecution()
      && !this.hasSettlementGap(tableId);
  }

  private hasUnknownExecution(tableId?: string): boolean {
    return this.orchestrator.getReservations(tableId)
      .some(reservation => reservation.status === 'UNKNOWN');
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
    if (this.runtimeIncidents.hasActive(input.code, input.tableId)) return;
    this.runtimeIncidents.record(input);
  }

  private refreshAccountingIncidents(): void {
    const unknownTableIds = new Set(
      this.orchestrator.getReservations()
        .filter(reservation => reservation.status === 'UNKNOWN')
        .map(reservation => reservation.tableId),
    );
    if (unknownTableIds.size > 0) this.operationalWagers.disableKeepaliveImmediately();
    const knownTableIds = new Set([
      ...this.monitorTableIds,
      ...this.liveApprovals.list(),
      ...this.orchestrator.listActors().map(actor => actor.tableId),
    ]);
    for (const tableId of knownTableIds) {
      if (unknownTableIds.has(tableId)) {
        this.ensureRuntimeIncident({
          code: 'unknown-execution',
          severity: 'blocked',
          tableId,
          message: `Unresolved execution result retains exposure for ${tableId}`,
        });
      } else {
        this.runtimeIncidents.resolve('unknown-execution', tableId);
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
      severity: 'blocked',
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
    approved = this.liveApprovals.has(tableId),
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
          stalenessMs: this.runtimeObservedTableIds.has(tableId)
            ? health.stalenessMs
            : undefined,
        },
      }),
      maxFeedStalenessMs: MAX_LIVE_FEED_STALENESS_MS,
      projection: actor.getProjection(),
      hasUnknownExecution: this.hasUnknownExecution(),
      hasSettlementGap: this.hasSettlementGap(tableId),
    });
  }

  private operationalWagerRuntimeBlockReason(tableId: string): string | undefined {
    const actor = this.orchestrator.getActor(tableId);
    if (actor?.snapshot().executionMode !== 'live') return undefined;
    if (!this.liveApprovals.has(tableId) || !this.liveAuthorizationSources.has(tableId)) {
      return 'unattended-runtime-blocked:live-authorization-missing';
    }
    const reasons = this.liveTableReasons(tableId);
    return reasons.length === 0
      ? undefined
      : `unattended-runtime-blocked:${reasons.join(',')}`;
  }

  private runtimeSnapshot(): DesktopRuntimeState {
    this.refreshAccountingIncidents();
    const bridge = this.bridgeRuntimeStatus();
    const approvedLiveTableIds = this.liveApprovals.list();
    const tables: DesktopRuntimeState['tables'] = Object.fromEntries(
      this.monitorTableIds.map(tableId => {
        const feedHealth = this.liveFeeds.get(tableId)?.health();
        const actor = this.orchestrator.getActor(tableId);
        return [tableId, {
          approved: this.liveApprovals.has(tableId),
          active: actor?.snapshot().executionMode === 'live'
            && this.liveAuthorizationSources.has(tableId),
          reasons: this.liveApprovals.has(tableId) ? this.liveTableReasons(tableId) : [],
          ...(feedHealth === undefined ? {} : {
            feedState: feedHealth.state,
            ...(feedHealth.stalenessMs === undefined ? {} : { feedStalenessMs: feedHealth.stalenessMs }),
          }),
        }];
      }),
    );
    const activeLiveTableIds = approvedLiveTableIds.filter(tableId =>
      tables[tableId]?.active === true);
    const reasons = [...new Set(
      approvedLiveTableIds.flatMap(tableId => tables[tableId]?.reasons ?? []),
    )];
    const incidents = this.runtimeIncidents.list();
    const activeIncidents = incidents.filter(incident => incident.active);
    const blocked = reasons.length > 0
      || activeIncidents.some(incident => incident.severity === 'blocked');
    const degraded = activeIncidents.some(incident => incident.severity === 'degraded');
    return {
      status: blocked ? 'blocked' : degraded ? 'degraded' : 'healthy',
      executionReady: approvedLiveTableIds.length > 0
        && activeLiveTableIds.length === approvedLiveTableIds.length
        && reasons.length === 0,
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
    const approvedTableIds = this.liveApprovals.list()
      .filter(tableId => selectedTableIds.includes(tableId));
    for (const tableId of approvedTableIds) {
      const actor = this.orchestrator.getActor(tableId);
      if (!actor) continue;
      const reasons = this.liveTableReasons(tableId);
      const authorization = this.liveAuthorizationSources.get(tableId);
      const accountingBlocked = reasons.includes('unknown-execution-pending')
        || reasons.includes('settlement-gap');
      if (reasons.length > 0) {
        if (authorization === 'unattended' || accountingBlocked) {
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
      this.setOrchestratorExecutor(new SimulatedAdapter({ events: [] }));
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
    const continuityReady = approvedTableIds.every(tableId => {
      const reasons = this.liveTableReasons(tableId);
      return !reasons.includes('table-feed-missing')
        && !reasons.includes('table-feed-disconnected')
        && !reasons.includes('table-feed-stale')
        && !reasons.includes('table-connection-not-restored');
    });
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
          await this.reconcileUnattendedExecution();
          return;
        case 'extension-disconnected':
          this.runtimeObservedTableIds.clear();
          this.ensureRuntimeIncident({
            code: 'bridge-disconnected',
            severity: 'blocked',
            message: event.reason,
          });
          await this.failCloseLiveExecution(this.liveApprovals.list());
          return;
        case 'continuity-invalidated':
          this.runtimeObservedTableIds.clear();
          this.ensureRuntimeIncident({
            code: 'continuity-invalidated',
            severity: 'blocked',
            message: event.reason,
          });
          await this.failCloseLiveExecution(this.liveApprovals.list());
          return;
        case 'table-disconnected':
          this.runtimeObservedTableIds.delete(event.tableId);
          this.ensureRuntimeIncident({
            code: event.reason === 'table-feed-stale' ? 'table-feed-stale' : 'bridge-disconnected',
            severity: 'blocked',
            tableId: event.tableId,
            message: event.reason,
          });
          await this.failCloseLiveExecution([event.tableId]);
          return;
        case 'session-recovery-exhausted':
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
          await this.reconcileUnattendedExecution();
          return;
        default:
          return assertNeverBridgeRuntimeEvent(event);
      }
    }).catch(error => this.recordLiveMonitorError(error, 'scheduler-failure', 'degraded'));
  }

  /** 为监控层导出的源事件与连接事件分配不冲突的账本 sourceSeq。 */
  private nextMonitorSourceSeq(tableId: string): number {
    const base = this.ledger.nextSourceSeq(tableId);
    const reserved = this.monitorSourceSeq.get(tableId) ?? base;
    const next = Math.max(base, reserved);
    this.monitorSourceSeq.set(tableId, next + 1);
    return next;
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
    return this.isMonitorTableSelected(tableId) && this.liveFeeds.get(tableId) === feed;
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
      this.runtimeObservedTableIds.add(event.tableId);
    }
    if (event.type === 'bettingWindowOpened' && this.detectSettlementGap(event)) {
      await this.failCloseLiveExecution([event.tableId]);
    }
    await this.orchestrator.enqueue(event.tableId, event);
    this.refreshAccountingIncidents();
    if (event.type === 'handSettled') this.resolveSettlementGapIfCleared(event.tableId);
    if (
      event.type === 'newShoeSignal'
      || event.type === 'connectionRestored'
      || (event.type === 'shoeConfirmation' && event.approved)
    ) {
      await this.rearmPairAutomation(event.tableId);
    }
    await this.reconcileUnattendedExecution();
  }

  private async reconcilePairAutomation(enabled: boolean): Promise<void> {
    for (const tableId of this.monitorTableIds) {
      const actor = this.orchestrator.getActor(tableId);
      if (!actor) continue;
      const projection = actor.getProjection();
      if (!enabled) {
        if (projection.autoBetStatus !== 'DISARMED') {
          await actor.setAutoBet(false, projection.shoeId || undefined);
        }
        continue;
      }
      await this.rearmPairAutomation(tableId);
    }
  }

  private async rearmPairAutomation(tableId: string): Promise<void> {
    if (!this.operationalWagers.getKeepaliveState().enabled || !this.monitorTableIds.includes(tableId)) return;
    if (this.liveApprovals.has(tableId) && !this.liveAuthorizationSources.has(tableId)) return;
    const actor = this.orchestrator.getActor(tableId);
    if (!actor) return;
    const projection = actor.getProjection();
    const canArm = projection.autoBetStatus === 'DISARMED'
      && projection.shoeBaseline === 'physical-shoe'
      && projection.connectionStatus === 'CONNECTED'
      && !projection.sealed
      && (projection.status === 'TRACKING'
        || projection.status === 'BETTING_WINDOW'
        || projection.status === 'PENDING_SETTLEMENT');
    if (canArm) await actor.setAutoBet(true, projection.shoeId || undefined);
  }

  private async applyKeepaliveSettings(settings: KeepaliveSettings): Promise<void> {
    await this.operationalWagers.updateKeepalive(settings);
    await this.reconcilePairAutomation(settings.enabled);
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
    if (state.executionMode !== 'shadow') {
      actor.setExecutionMode('shadow');
    }
    this.liveAuthorizationSources.delete(tableId);
    if (state.projection.autoBetStatus === 'ARMED') {
      await actor.setAutoBet(false, state.projection.shoeId || undefined);
    }
  }

  private async failCloseLiveExecution(tableIds: readonly string[]): Promise<void> {
    for (const tableId of tableIds) {
      await this.resetMonitorExecutionState(tableId);
    }

    const hasLiveTable = this.orchestrator.listActors()
      .some(actor => actor.snapshot().executionMode === 'live'
        && this.liveAuthorizationSources.has(actor.tableId));
    if (hasLiveTable) return;

    this.liveExecutionMode = 'shadow';
    this.setOrchestratorExecutor(new SimulatedAdapter({ events: [] }));
    this.setOperationalWagerExecutor(false);
    try {
      await this.setPersistentLiveGate(false);
    } catch (error) {
      this.recordLiveMonitorError(error, 'bridge-disconnected', 'blocked');
    }
  }

  private async stopLiveFeed(tableId: string, feed: TableExport): Promise<void> {
    if (this.liveFeeds.get(tableId) === feed) this.liveFeeds.delete(tableId);
    this.runtimeObservedTableIds.delete(tableId);
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
    if (this.liveFeeds.get(tableId) === feed) this.liveFeeds.delete(tableId);
    this.runtimeObservedTableIds.delete(tableId);
    return { kind: 'stopped' };
  }

  async startBrowserBridge(port = 17890): Promise<{ port: number }> {
    if (!this.browserBridge) {
      const bridge = new BrowserBridgeServer({
        port,
        selectedTableIds: this.monitorTableIds,
        requireExtensionSequence: true,
        allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
        extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
        onRuntimeEvent: event => this.handleBridgeRuntimeEvent(event),
      });
      this.browserBridgePort = await bridge.start();
      this.browserBridge = bridge;
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

  async startLiveRoomMonitor(port = 17890, executionMode: ExecutionMode = 'shadow'): Promise<{ port: number }> {
    return this.enqueueExecutionStateOperation(() => this.startLiveRoomMonitorInner(port, executionMode));
  }

  private async startLiveRoomMonitorInner(port: number, executionMode: ExecutionMode): Promise<{ port: number }> {
    if (executionMode === 'live') {
      throw new Error('live monitor startup requires persisted per-table approval');
    }
    await this.startupFailCloseTask;
    const startsNewMonitorSession = !this.liveMonitorActivated;
    this.liveMonitorActivated = true;
    this.liveExecutionMode = executionMode === 'simulated' ? 'simulated' : 'shadow';
    this.ensureMonitorActors(this.monitorTableIds);
    this.setOrchestratorExecutor(new SimulatedAdapter({ events: [] }));
    this.setOperationalWagerExecutor(false);
    const started = await this.startBrowserBridge(port);
    if (startsNewMonitorSession) {
      this.runtimeObservedTableIds.clear();
      this.browserBridge?.beginMonitorSession();
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
      const delay = LIVE_MONITOR_RETRY_DELAYS_MS[
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
    this.liveMonitorActivated = false;
    this.liveMonitorRetryAttempt = 0;
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
      this.liveExecutionMode = 'shadow';
      this.setOrchestratorExecutor(new SimulatedAdapter({ events: [] }));
      this.setOperationalWagerExecutor(false);
    });
  }

  private attachLiveTables(): Promise<void> {
    return this.enqueueLiveMonitorOperation(() => this.attachLiveTablesInner());
  }

  private async attachLiveTablesInner(): Promise<void> {
    const browserBridge = this.browserBridge;
    if (!browserBridge) return;
    // A bridge with neither a configured whitelist nor an explicit page selection
    // must not turn every discovered lobby room into a monitored actor.
    if (
      !browserBridge.hasRuntimeTableSelection()
      && !browserBridge.hasConfiguredTableSelection()
    ) return;

    const selectedTableIds = new Set(this.currentMonitorTableIds());
    const rooms = await browserBridge.discoverRooms();
    for (const room of rooms) {
      for (const table of room.tables) {
        // The service is the final allowlist boundary; never rely solely on a bridge cache.
        if (!selectedTableIds.has(table.tableId) || !this.isMonitorTableSelected(table.tableId)) continue;
        if (this.liveFeeds.has(table.tableId)) continue;
        if (!this.orchestrator.getActor(table.tableId)) {
          this.orchestrator.registerTable(table.profile, this.liveExecutionMode, 100);
        }
        await this.resetMonitorExecutionState(table.tableId);

        const feed = browserBridge.openTable(room.roomId, table.tableId);
        this.liveFeeds.set(table.tableId, feed);
        try {
          await feed.start({
            onBatch: async batch => {
              if (!this.isCurrentLiveFeed(table.tableId, feed)) return;
              for (const event of batch.events) {
                if (event.tableId !== table.tableId || !this.isCurrentLiveFeed(table.tableId, feed)) continue;
                const sourceSeq = this.nextMonitorSourceSeq(event.tableId);
                if (!this.isCurrentLiveFeed(table.tableId, feed)) continue;
                await this.enqueueMonitorEvent({ ...event, sourceSeq });
              }
            },
            onDisconnect: (tableId, reason) => {
              if (!this.isCurrentLiveFeed(tableId, feed)) return;
              this.runtimeObservedTableIds.delete(tableId);
              // BridgeTableExport performs its own reconnect. Keep the identity
              // registered while it is disconnected: deleting it would make the
              // periodic attach call start() on the same already-started export.
              const sourceSeq = this.nextMonitorSourceSeq(tableId);
              void this.enqueueExecutionStateOperation(async () => {
                if (reason === 'table-feed-stale') {
                  this.ensureRuntimeIncident({
                    code: 'table-feed-stale',
                    severity: 'blocked',
                    tableId,
                    message: reason,
                  });
                }
                await this.failCloseLiveExecution([tableId]);
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
          if (this.liveFeeds.get(table.tableId) === feed) this.liveFeeds.delete(table.tableId);
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
        if (!candidates.has(table.tableId)) {
          candidates.set(table.tableId, {
            roomId: room.roomId,
            ...(room.displayName === undefined ? {} : { roomName: room.displayName }),
            tableId: table.tableId,
          });
        }
      }
    }
    return [...candidates.values()];
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
    const simulatedTableIds = this.demoRunning
      ? Object.values(fullSnapshot.tables)
        .filter(table => table.executionMode === 'simulated')
        .map(table => table.tableId)
      : [];
    return [...this.monitorTableIds, ...simulatedTableIds.filter(tableId => !this.monitorTableIds.includes(tableId))];
  }

  snapshot(options: DesktopSnapshotOptions = {}): DesktopConsoleSnapshot {
    const includeHistory = options.includeHistory !== false;
    const fullSnapshot = this.orchestrator.snapshot();
    const usingLiveMonitor = this.liveMonitorActivated;
    const displayedTableIds = this.displayedTableIds(fullSnapshot);
    const activeTableIds = new Set(displayedTableIds);
    const tables = Object.fromEntries(
      displayedTableIds.flatMap(tableId => {
        const table = fullSnapshot.tables[tableId];
        return table === undefined ? [] : [[tableId, table]];
      }),
    );
    const snapshot: OrchestratorSnapshot = { ...fullSnapshot, tables };
    const filterToDisplayedTables = <T extends { tableId: string }>(rows: readonly T[]): T[] =>
      usingLiveMonitor ? rows.filter(row => activeTableIds.has(row.tableId)) : [...rows];
    const keepalive = this.operationalWagers.getKeepaliveState();
    const events = includeHistory ? this.ledger.listEvents() : this.ledger.listEventsTail();
    const decisions = includeHistory ? this.ledger.listDecisions() : this.ledger.listDecisionsTail();
    const receipts = includeHistory ? this.ledger.listReceipts() : this.ledger.listReceiptsTail();
    const reservations = includeHistory ? this.orchestrator.getReservations() : this.orchestrator.getReservations().slice(-200);
    const monitorCandidates = this.monitorCandidates();
    const scopedTableIds = usingLiveMonitor ? displayedTableIds : undefined;
    const recordCounts = options.includeRecordCounts === false && this.cachedRecordCounts !== undefined
      ? this.cachedRecordCounts
      : this.recordCounts(scopedTableIds);
    if (options.includeRecordCounts !== false) this.cachedRecordCounts = recordCounts;
    const summary = options.includeSummary === false && this.cachedSummary !== undefined
      ? this.cachedSummary
      : this.ledger.getMonitorSummary(usingLiveMonitor ? { ...options, tableIds: displayedTableIds } : options);
    if (options.includeSummary !== false) this.cachedSummary = summary;
    return {
      dbPath: this.dbPath,
      isOpen: this.ledger.isOpen(),
      seed: this.lastSeed,
      snapshot,
      monitorTableIds: [...this.monitorTableIds],
      monitorCandidates,
      recordCounts,
      keepalive,
      automation: { enabled: keepalive.enabled },
      runtime: this.runtimeSnapshot(),
      operationalWagers: this.ledger.listOperationalWagersTail(),
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
      }
      return this.snapshot();
    }

  queryRecords(query: DesktopRecordQuery): DesktopRecordPage {
    // Record pages are part of the live dashboard surface. Apply the same monitor-table
    // scope before pagination so unrelated historical tables cannot inflate totals or rows.
    const scopedQuery = this.liveMonitorActivated
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
    this.ensureMonitorActors(this.monitorTableIds);
    this.orchestrator.updateTableSettingsForTables(this.monitorTableIds, {
      minEV: Math.max(0, settings.minEV),
      betTiers: settings.betTiers,
      defaultBetAmount: settings.defaultBetAmount,
    });
    return this.snapshot();
  }

  async updateMonitorTableIds(tableIds: readonly string[]): Promise<DesktopConsoleSnapshot> {
    const nextTableIds = normalizeMonitorTableIds(tableIds, true);
    return await this.enqueueLiveMonitorOperation(() => this.updateMonitorTableIdsInner(nextTableIds));
  }

  private async updateMonitorTableIdsInner(nextTableIds: readonly string[]): Promise<DesktopConsoleSnapshot> {
    const previousTableIds = [...this.monitorTableIds];
    const nextTableIdSet = new Set(nextTableIds);
    this.pendingMonitorTableIds = [...nextTableIds];
    try {
      this.ensureMonitorActors(nextTableIds);
      const outgoingFeeds = [...this.liveFeeds].filter(([tableId]) => !nextTableIdSet.has(tableId));
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

      this.browserBridge?.setSelectedTableIds(nextTableIds);
      await this.attachLiveTablesInner();
      this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: nextTableIds });
      this.monitorTableIds = [...nextTableIds];
      this.liveApprovals.retain(nextTableIds);
      this.pendingMonitorTableIds = undefined;
      return this.snapshot();
    } catch (error) {
      this.pendingMonitorTableIds = undefined;
      try {
        const previousTableIdSet = new Set(previousTableIds);
        // Any feed created for the failed target selection is safe to clean up:
        // it remains outside the restored allowlist and will not be reopened.
        for (const [tableId, feed] of [...this.liveFeeds]) {
          if (previousTableIdSet.has(tableId)) continue;
          await this.stopLiveFeed(tableId, feed);
        }
        this.browserBridge?.setSelectedTableIds(previousTableIds);
        await this.attachLiveTablesInner();
        this.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: previousTableIds });
      } catch (rollbackError) {
        this.recordLiveMonitorError(rollbackError);
      }
      throw error;
    }
  }

  async registerTable(
    profile: TableProfile,
    executionMode: 'shadow' | 'simulated' | 'live',
    defaultBetAmount: number,
  ): Promise<DesktopConsoleSnapshot> {
    this.orchestrator.registerTable({ ...profile, minEV: Math.max(0, profile.minEV) }, executionMode, defaultBetAmount);
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
      if (armed && !this.operationalWagers.getKeepaliveState().enabled) {
        throw new Error('global automation is disabled');
      }
      if (armed && this.liveApprovals.has(tableId) && !this.liveAuthorizationSources.has(tableId)) {
        throw new Error(`live execution is blocked for ${tableId}: ${this.liveTableReasons(tableId).join(', ')}`);
      }
      if (armed && this.hasUnknownExecution()) {
        throw new Error('unresolved UNKNOWN execution blocks automatic betting');
      }
      if (armed && this.hasSettlementGap(tableId)) {
        throw new Error(`unresolved settlement gap blocks automatic betting for ${tableId}`);
      }
      await actor.setAutoBet(armed, shoeId);
      return this.snapshot();
    });
  }

  async setExecutionMode(tableId: string, mode: 'shadow' | 'live'): Promise<DesktopConsoleSnapshot> {
    return this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      const actor = this.orchestrator.getActor(tableId);
      if (!actor) throw new Error(`unknown table ${tableId}`);
      const bridge = this.browserBridge;
      if (mode === 'live' && !bridge) {
        throw new Error('browser bridge is not running');
      }
      if (mode === 'live') {
        const reasons = this.liveTableReasons(tableId, true);
        if (reasons.length > 0) {
          throw new Error(`live execution is blocked for ${tableId}: ${reasons.join(', ')}`);
        }
      }

      const shoeId = actor.getProjection().shoeId || undefined;
      await actor.setAutoBet(false, shoeId);

      if (mode === 'live') {
        await this.setPersistentLiveGate(true);
        this.setOrchestratorExecutor({
          requestBet: request => bridge!.requestBet(request),
        });
        this.setOperationalWagerExecutor(true);
        this.orchestrator.updateTableExecutionMode(tableId, 'live');
        this.liveApprovals.approve(tableId);
        this.liveAuthorizationSources.set(tableId, 'manual');
        return this.snapshot();
      }

      this.liveApprovals.revoke(tableId);
      this.liveAuthorizationSources.delete(tableId);
      this.orchestrator.updateTableExecutionMode(tableId, 'shadow');
      const hasLiveTable = this.orchestrator.listActors()
        .some(candidate => candidate.snapshot().executionMode === 'live'
          && this.liveAuthorizationSources.has(candidate.tableId));
      if (!hasLiveTable) {
        await this.setPersistentLiveGate(false);
        this.setOrchestratorExecutor(new SimulatedAdapter({ events: [] }));
        this.setOperationalWagerExecutor(false);
      }
      return this.snapshot();
    });
  }

  async executeOperationalWager(input: {
    readonly tableId: string;
    readonly market: 'banker' | 'player' | 'bankerPair' | 'playerPair';
    readonly amount: number;
  }): Promise<OperationalWagerResult & { readonly snapshot: DesktopConsoleSnapshot }> {
    const result = await this.operationalWagers.executeManual(input);
    if (result.status === 'UNKNOWN') {
      this.refreshAccountingIncidents();
      await this.enqueueExecutionStateOperation(() => this.failCloseLiveExecution(this.liveApprovals.list()));
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
        && Reflect.get(receiptRaw, 'commitStarted') === true
        && Reflect.get(receiptRaw, 'commitPoint') === 'confirmBet';
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
        throw new Error('platform receipt has no proof that confirmBet started');
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
          || record.reconciliation.reason !== 'operator-confirmed-platform-accepted'
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
      this.refreshAccountingIncidents();
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

  async setAutomationEnabled(enabled: boolean): Promise<DesktopConsoleSnapshot> {
    if (!enabled) this.operationalWagers.disableKeepaliveImmediately();
    return await this.enqueueExecutionStateOperation(async () => {
      await this.startupFailCloseTask;
      if (enabled && this.hasUnknownExecution()) {
        throw new Error('unresolved UNKNOWN execution blocks automation');
      }
      const settlementGapTable = this.monitorTableIds.find(tableId => this.hasSettlementGap(tableId));
      if (enabled && settlementGapTable !== undefined) {
        throw new Error(`unresolved settlement gap blocks automation for ${settlementGapTable}`);
      }
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

    const bridge = this.browserBridge;
    if (!bridge) throw new Error('browser bridge is not running');
    const readinessReasons = this.liveTableReasons(command.tableId, true);
    if (readinessReasons.length > 0) {
      throw new Error(`one-shot live bet is blocked for ${command.tableId}: ${readinessReasons.join(', ')}`);
    }

    const persistentLiveTableId = this.liveApprovals.list()[0]
      ?? this.orchestrator.listActors()
        .find(candidate => candidate.snapshot().executionMode === 'live')?.tableId;
    if (persistentLiveTableId) {
      throw new Error(`persistent live execution mode is active for table ${persistentLiveTableId}`);
    }

    const armedTable = this.orchestrator.listActors()
      .find(candidate => candidate.getProjection().autoBetStatus === 'ARMED');
    if (armedTable) {
      throw new Error(`automatic betting is armed for table ${armedTable.tableId}`);
    }

    const executor: Pick<BrowserAdapter, 'requestBet'> = {
      requestBet: request => bridge.requestBet(request),
    };
    const previousExecutor = this.currentExecutor;
    actor.setExecutor(executor);
    let result: OneShotBetResult;
    try {
      result = await (async (): Promise<OneShotBetResult> => {
        try {
          bridge.setLiveBetEnabled(true);
          return await actor.placeOneShotBet({
            shoeId: command.shoeId,
            handId: command.handId,
            market: command.market,
            amount: command.amount,
          });
        } finally {
          bridge.setLiveBetEnabled(false);
        }
      })();
    } finally {
      actor.setExecutor(previousExecutor);
    }

    if (result.status === 'UNKNOWN') {
      this.refreshAccountingIncidents();
      await this.failCloseLiveExecution(this.liveApprovals.list());
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
