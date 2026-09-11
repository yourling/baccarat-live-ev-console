/**
 * 执行门控切片：从 DesktopConsoleService 拆出的真金执行安全闸——
 * fail-close（分级断联）、常驻 live gate、无人值守授权调和、启动期兜底。
 *
 * 通过 ExecutionGateHost 回访宿主；状态（persistentLiveGateEnabled /
 * liveAuthorizationSources / liveExecutionMode）仍在宿主，由快照与
 * runtime-state 展示共享。
 */
import type { ExecutionMode } from '@baccarat/contracts';
import { newId, EVENT_SCHEMA_VERSION } from '@baccarat/contracts';
import { SimulatedAdapter, type BrowserAdapter } from '@baccarat/adapter-contract';
import type { Orchestrator } from '@baccarat/orchestrator';
import type { BrowserBridgeServer } from '@baccarat/browser-bridge';
import type {
  LiveApprovalStore,
  LiveExecutionBlockReason,
  RuntimeIncidentCode,
  RuntimeIncidentSeverity,
  RuntimeIncidentStore,
} from './runtime-supervisor.js';

export interface ExecutionGateHost {
  readonly orchestrator: Orchestrator;
  readonly browserBridge?: BrowserBridgeServer;
  readonly runtimeIncidents: RuntimeIncidentStore;
  readonly liveApprovals: LiveApprovalStore;
  readonly monitorTableIds: string[];
  /** 启动期 fail-close 兜底任务；所有执行入口必须先 await。 */
  readonly startupFailCloseTask: Promise<void>;
  closing: boolean;
  /** 全局常驻 live gate 状态（手动/无人值守共用）。 */
  persistentLiveGateEnabled: boolean;
  liveExecutionMode: ExecutionMode;
  automationEnabled: boolean;
  transportDownAt?: number;
  recoverySuppressUntil: number;
  demoError?: string;
  readonly liveAuthorizationSources: Map<string, 'manual' | 'unattended'>;
  readonly currentExecutor: Pick<BrowserAdapter, 'requestBet'> | null;
  nextMonitorSourceSeq(tableId: string): number;
  setOrchestratorExecutor(executor: Pick<BrowserAdapter, 'requestBet'> | null): void;
  setOperationalWagerExecutor(enabled: boolean): void;
  recordLiveMonitorError(
    error: unknown,
    code?: RuntimeIncidentCode,
    severity?: RuntimeIncidentSeverity,
    tableId?: string,
  ): void;
  refreshAccountingIncidents(force?: boolean): void;
  keepaliveTableReasons(tableId: string): LiveExecutionBlockReason[];
  liveTableReasons(tableId: string, approved?: boolean): LiveExecutionBlockReason[];
  currentMonitorTableIds(): readonly string[];
  rearmPairAutomation(tableId: string): Promise<void>;
  failCloseLiveExecution(tableIds: readonly string[]): Promise<void>;
  bridgeRuntimeStatus(): { authenticated: boolean };
}

export class ExecutionGateConsole {
  constructor(private readonly host: ExecutionGateHost) {}

  /** 启动期兜底：恢复的 feed 一律先按断开处理，等运行期事件重新确认。 */
  async initializeFailClosedRuntime(): Promise<void> {
    for (const actor of this.host.orchestrator.listActors()) {
      if (this.host.monitorTableIds.includes(actor.tableId) && actor.snapshot().executionMode !== 'live') {
        this.host.orchestrator.updateTableExecutionMode(actor.tableId, 'live');
      }
      const projection = actor.getProjection();
      if (this.host.monitorTableIds.includes(actor.tableId) && projection.shoeId && projection.connectionStatus !== 'DISCONNECTED') {
        await this.host.orchestrator.enqueue(actor.tableId, {
          type: 'connectionLost',
          eventId: newId('evt'),
          tableId: actor.tableId,
          timestamp: new Date().toISOString(),
          sourceSeq: this.host.nextMonitorSourceSeq(actor.tableId),
          source: 'console',
          schemaVersion: EVENT_SCHEMA_VERSION,
          reason: 'process-restarted',
        });
      }
    }
    this.host.liveAuthorizationSources.clear();
    this.host.transportDownAt = undefined;
    this.host.recoverySuppressUntil = 0;
    this.host.setOrchestratorExecutor(null);
    this.host.setOperationalWagerExecutor(false);
  }

  canExecuteAutomaticBets(_tableId: string): boolean {
    return this.host.automationEnabled;
  }

  async resetMonitorExecutionState(tableId: string): Promise<void> {
    const actor = this.host.orchestrator.getActor(tableId);
    if (!actor) return;

    const state = actor.snapshot();
    if (state.executionMode !== 'live') {
      actor.setExecutionMode('live');
    }
    this.host.liveAuthorizationSources.delete(tableId);
    if (state.projection.autoBetStatus === 'ARMED') {
      await actor.setAutoBet(false, state.projection.shoeId || undefined, 'execution-reset');
    }
  }

  /**
   * 分级断联：传输抖动只冻结真正有 live 敞口的桌。
   * 有 live 授权或 RESERVED/UNKNOWN 在途预留的桌才 fail-close；
   * 其余监控桌只进入 DEGRADED（暂停新单），保留观察记录、武装状态与授权。
   */
  hasLiveExposure(tableId: string): boolean {
    if (this.host.liveAuthorizationSources.has(tableId)) return true;
    try {
      return this.host.orchestrator.getReservations(tableId).some(reservation =>
        reservation.status === 'RESERVED' || reservation.status === 'UNKNOWN');
    } catch {
      return false;
    }
  }

  failCloseExposedTables(tableIds: readonly string[]): Promise<void> {
    return this.host.failCloseLiveExecution(tableIds.filter(tableId => this.hasLiveExposure(tableId)));
  }

  async failCloseLiveExecution(tableIds: readonly string[]): Promise<void> {
    for (const tableId of tableIds) {
      await this.resetMonitorExecutionState(tableId);
    }

    const hasLiveTable = this.host.orchestrator.listActors()
      .some(actor => actor.snapshot().executionMode === 'live'
        && this.host.liveAuthorizationSources.has(actor.tableId));
    if (hasLiveTable) return;

    this.host.liveExecutionMode = 'live';
    this.host.setOrchestratorExecutor(null);
    this.host.setOperationalWagerExecutor(false);
    try {
      await this.setPersistentLiveGate(false);
    } catch (error) {
      this.host.recordLiveMonitorError(error, 'bridge-disconnected', 'blocked');
    }
  }

  async setPersistentLiveGate(enabled: boolean): Promise<void> {
    if (this.host.persistentLiveGateEnabled === enabled) return;
    if (enabled && !this.host.browserBridge) throw new Error('browser bridge is not running');
    this.host.browserBridge?.setLiveBetEnabled(enabled);
    this.host.persistentLiveGateEnabled = enabled;
  }

  /** 无人值守授权调和：门全开的桌补授权，门变化的桌撤销授权并 fail-close。 */
  async reconcileUnattendedExecution(): Promise<void> {
    await this.host.startupFailCloseTask;
    this.host.refreshAccountingIncidents();
    const selectedTableIds = this.host.currentMonitorTableIds();
    const approvedTableIds = this.host.monitorTableIds
      .filter(tableId => selectedTableIds.includes(tableId));
    for (const tableId of approvedTableIds) {
      const actor = this.host.orchestrator.getActor(tableId);
      if (!actor) continue;
      const reasons = this.host.keepaliveTableReasons(tableId);
      const authorization = this.host.liveAuthorizationSources.get(tableId);
      if (reasons.length > 0) {
        if (authorization === 'unattended') {
          await this.resetMonitorExecutionState(tableId);
        }
        continue;
      }

      this.host.runtimeIncidents.resolve('table-feed-stale', tableId);
      if (authorization === undefined) {
        await this.setPersistentLiveGate(true);
        const bridge = this.host.browserBridge!;
        this.host.setOrchestratorExecutor({ requestBet: request => bridge.requestBet(request) });
        this.host.setOperationalWagerExecutor(true);
        actor.setExecutionMode('live');
        this.host.liveAuthorizationSources.set(tableId, 'unattended');
      }
      await this.host.rearmPairAutomation(tableId);
    }

    const hasActiveLiveTable = this.host.orchestrator.listActors().some(actor =>
      actor.snapshot().executionMode === 'live'
      && this.host.liveAuthorizationSources.has(actor.tableId));
    if (!hasActiveLiveTable) {
      this.host.setOrchestratorExecutor(null);
      this.host.setOperationalWagerExecutor(false);
      try {
        await this.setPersistentLiveGate(false);
      } catch (error) {
        this.host.recordLiveMonitorError(error, 'bridge-disconnected', 'blocked');
      }
    }

    const bridge = this.host.bridgeRuntimeStatus();
    if (bridge.authenticated) {
      this.host.runtimeIncidents.resolveAll('bridge-auth-failed');
      this.host.runtimeIncidents.resolveAll('bridge-disconnected');
    }
    const liveApproved = approvedTableIds.filter(tableId => {
      const reasons = this.host.liveTableReasons(tableId);
      return !reasons.includes('table-feed-missing')
        && !reasons.includes('table-feed-disconnected')
        && !reasons.includes('table-feed-stale')
        && !reasons.includes('table-connection-not-restored');
    });
    const continuityReady = liveApproved.length > 0 || approvedTableIds.length === 0;
    if (continuityReady) this.host.runtimeIncidents.resolveAll('continuity-invalidated');
  }
}
