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
  keepaliveTableReasons(tableId: string, requireAuthorization?: boolean): LiveExecutionBlockReason[];
  liveTableReasons(tableId: string, approved?: boolean): LiveExecutionBlockReason[];
  currentMonitorTableIds(): readonly string[];
  rearmPairAutomation(tableId: string): Promise<void>;
  failCloseLiveExecution(tableIds: readonly string[]): Promise<void>;
  bridgeRuntimeStatus(): { authenticated: boolean };
}

export class ExecutionGateConsole {
  constructor(private readonly host: ExecutionGateHost) {}

  /**
   * 启动期兜底：恢复的 feed 一律先按断开处理，等运行期事件重新确认。
   *
   * FIX(D-P1-4): 修复前这里靠 `actor.getProjection()` 判断"上一进程是否 live"，
   * 但 `service.ts` 构造里更早的 `resetLiveShoeTracking()` 已经把投影清空
   * （shoeId='' / connectionStatus='CONNECTED' / WAITING_NEW_SHOE），条件
   * `projection.shoeId && ...` 恒为假 → `connectionLost(process-restarted)` 是死分支，
   * 重启后 UI 仍显示"已连接"（review 脚本 a2b/a2c 实证 connectionLost 数=0）。
   *
   * 现在判据改从**持久化**状态读：监控表 + liveApprovals（上次批准过 live 的桌）。
   * 这些数据不依赖运行时投影，所以 reset 顺序不再影响它。写事件之后再清投影，
   * 保证重启后是 DISCONNECTED / RESYNCING 而不是"CONNECTED 但无数据"。
   */
  async initializeFailClosedRuntime(): Promise<void> {
    // ① 先清掉 replay 出来的上一进程投影（TableActor 构造里 replay(latestShoeOnly)
    //    会让投影"半恢复"：seenCards 只补回 handSettled 的牌，cardObserved 已丢）。
    //    这一步必须在写断线事件**之前** —— 否则 reset 会把刚写出来的 DISCONNECTED 覆盖
    //    回 emptyProjection 的 CONNECTED，正是审查里"重启后仍显示已连接"的根因。
    this.host.orchestrator.resetLiveShoeTracking();

    // ② 再按**持久化**状态补写 process-restarted 断线事件。
    //    判据不依赖运行时投影：监控列表（持久化）+ live 批准（持久化）。
    const persistedLiveTableIds = new Set(this.host.liveApprovals.list());
    const restartTableIds = this.host.monitorTableIds
      .filter(tableId => persistedLiveTableIds.has(tableId));
    for (const tableId of restartTableIds) {
      const actor = this.host.orchestrator.getActor(tableId);
      if (!actor) continue;
      if (actor.snapshot().executionMode !== 'live') {
        this.host.orchestrator.updateTableExecutionMode(tableId, 'live');
      }
      await this.host.orchestrator.enqueue(tableId, {
        type: 'connectionLost',
        eventId: newId('evt'),
        tableId,
        timestamp: new Date().toISOString(),
        sourceSeq: this.host.nextMonitorSourceSeq(tableId),
        source: 'console',
        schemaVersion: EVENT_SCHEMA_VERSION,
        reason: 'process-restarted',
      });
    }
    // 未监控但注册过 actor 的桌（demo 表等）也要恢复成 live 模式；投影已在 ① 清空。
    for (const actor of this.host.orchestrator.listActors()) {
      if (this.host.monitorTableIds.includes(actor.tableId)) continue;
      if (actor.snapshot().executionMode === 'live') continue;
      this.host.orchestrator.updateTableExecutionMode(actor.tableId, 'live');
    }

    this.host.liveAuthorizationSources.clear();
    this.host.transportDownAt = undefined;
    this.host.recoverySuppressUntil = 0;
    this.host.setOrchestratorExecutor(null);
    this.host.setOperationalWagerExecutor(false);
  }

  /**
   * 自动对子是否允许执行。
   *
   * FIX(D-P1-5): 修复前是 `_tableId => automationEnabled`，完全不分桌 —— demo 期间
   * `demo-console` 把全局 executor 换成 SimulatedAdapter 后，真实监控桌的自动策略
   * 会拿到 null 回执并记 UNKNOWN 假敞口（review 脚本 b9b 实证）。
   * 现在只有"已选监控桌"才允许自动执行：demo 表不在 monitorTableIds 里，天然被排除。
   */
  canExecuteAutomaticBets(tableId: string): boolean {
    if (!this.host.automationEnabled) return false;
    return this.host.currentMonitorTableIds().includes(tableId);
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
      // FIX(D-P0-1): reconcile 的语义是"要不要**建立**授权"，所以这里必须排除
      // `table-not-authorized` —— 否则每张未授权桌都算阻断原因，授权永远建不起来。
      const reasons = this.host.keepaliveTableReasons(tableId, false);
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
