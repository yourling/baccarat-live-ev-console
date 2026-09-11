/**
 * 监控桌生命周期切片：从 DesktopConsoleService 拆出的发现表合并、
 * 待加入晋升（promote）、异常降级（demote）、桌元数据维护与选桌更新事务。
 *
 * 通过 MonitorConsoleHost 接口回访宿主；第一阶段只做代码成簇（方法搬移、
 * 状态仍在宿主），后续阶段再逐步收窄接口、接管状态所有权。
 */
import { defaultProfile, type TableProfile } from '@baccarat/contracts';
import type { RoomDescriptor } from '@baccarat/room-monitor';
import {
  collapseWinfinityDuplicateTableIds,
  type BrowserBridgeServer,
} from '@baccarat/browser-bridge';
import {
  isJoinableNewShoeRoadCount,
  selectBgRoadCount,
  selectObservedGameCount,
  selectStableGameCount,
  selectWinfinityRoadCount,
} from '@baccarat/browser-bridge';
import { isVerifiedPhysicalShoeEvidence, isWrapShapedRoadCount } from '@baccarat/ledger-state';
import type { SqliteLedger } from '@baccarat/ledger-state';
import { normalizeBgTableId, normalizeWinfinityTableId } from '@baccarat/browser-bridge';
import type { Orchestrator } from '@baccarat/orchestrator';
import type { TableExport } from '@baccarat/room-monitor';
import type { MonitorTableCandidate } from '../src/api-types.js';
import type {
  LiveApprovalStore,
  RuntimeIncidentCode,
  RuntimeIncidentSeverity,
  RuntimeIncidentStore,
} from './runtime-supervisor.js';
import type { OperationalWagerCoordinator } from './operational-wager-coordinator.js';
import type { DesktopConsoleSnapshot } from './service.js';
import {
  MAX_LIVE_MONITOR_TABLES,
  MONITOR_TABLE_CONFIG_KEY,
  TABLE_METADATA_CONFIG_KEY,
  isLiveDesktopRoomId,
  isRetiredDefaultMonitorList,
  monitorTableIdsFromConfig,
  normalizeOptionalMonitorTableId,
  samePersistentTableMetadata,
  defaultMonitorTableIds,
  type MonitorFeedTransitionStopResult,
  type MonitorTableConfig,
  type StoredTableMetadata,
  type TableMetadataConfig,
  type UnifiedBetSettings,
} from './monitor-shared.js';

/** MonitorConsole 回访宿主的最小接口；随拆分推进逐步收窄。 */
export interface MonitorConsoleHost {
  readonly ledger: SqliteLedger;
  readonly orchestrator: Orchestrator;
  readonly browserBridge?: BrowserBridgeServer;
  readonly runtimeIncidents: RuntimeIncidentStore;
  readonly liveApprovals: LiveApprovalStore;
  readonly liveFeeds: Map<string, TableExport>;
  /** 操作员维护的持久化选桌列表；promote/demote 会原地改写。 */
  monitorTableIds: string[];
  readonly tableMetadata: Map<string, StoredTableMetadata>;
  readonly demotedPendingTableIds: Set<string>;
  readonly demotedPendingShoeIds: Map<string, string>;
  readonly pendingGameCountByTable: Map<string, number>;
  readonly missedShuffleRequested: Set<string>;
  /** 选桌事务进行中的暂存允许名单。 */
  pendingMonitorTableIds?: readonly string[];
  /** 回滚期间抑制发现表自动加入。 */
  suppressDiscoveredMonitorAutoAdd: boolean;
  liveMonitorActivated: boolean;
  currentUnifiedTableSettings(): UnifiedBetSettings | undefined;
  applyUnifiedBetSettingsToTables(tableIds: readonly string[]): void;
  monitorCandidates(): readonly MonitorTableCandidate[];
  /** pendingMonitorTableIds（事务瞬态）优先于已提交的 monitorTableIds。 */
  currentMonitorTableIds(): readonly string[];
  failCloseLiveExecution(tableIds: readonly string[]): Promise<void>;
  recordLiveMonitorError(
    error: unknown,
    code?: RuntimeIncidentCode,
    severity?: RuntimeIncidentSeverity,
    tableId?: string,
  ): void;
  enqueueLiveMonitorOperation<T>(operation: () => Promise<T>): Promise<T>;
  stopLiveFeed(tableId: string, feed: TableExport): Promise<void>;
  stopLiveFeedForTransition(tableId: string, feed: TableExport): Promise<MonitorFeedTransitionStopResult>;
  attachLiveTablesInner(): Promise<void>;
  ensureRuntimeIncident(input: {
    readonly code: RuntimeIncidentCode;
    readonly severity: RuntimeIncidentSeverity;
    readonly message: string;
    readonly tableId?: string;
  }): void;
  snapshot(): DesktopConsoleSnapshot;
}

export class MonitorConsole {
  constructor(private readonly host: MonitorConsoleHost) {}

  syncLiveApprovalsToMonitorTables(): void {
    this.host.liveApprovals.retain(this.host.monitorTableIds);
    for (const tableId of this.host.monitorTableIds) this.host.liveApprovals.approve(tableId);
  }

  observedGameCount(tableId: string, incoming?: number): number | undefined {
    if (normalizeWinfinityTableId(tableId) !== undefined) {
      const previous = this.host.tableMetadata.get(tableId)?.gameCount;
      const reason = this.host.browserBridge?.shoeEvidence(tableId)?.reason;
      if (reason === 'protocol-shuffle' && incoming !== undefined && incoming > 8 && (previous === undefined || previous <= 8)) {
        return previous;
      }
      return selectWinfinityRoadCount(previous, incoming);
    }
    if (normalizeBgTableId(tableId) !== undefined) {
      const accepted = this.host.browserBridge?.acceptedGameCount(tableId);
      const reason = this.host.browserBridge?.shoeEvidence(tableId)?.reason;
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
      this.host.browserBridge?.shoeEvidence(tableId)?.reason,
      this.host.browserBridge?.acceptedGameCount(tableId),
      incoming,
    );
  }

  refreshTableMetadataFromRooms(rooms: readonly RoomDescriptor[]): void {
    let changed = false;
    const updatedAt = new Date().toISOString();
    for (const room of rooms) {
      for (const table of room.tables) {
        const tableId = normalizeOptionalMonitorTableId(table.tableId);
        if (tableId === undefined) continue;
        const existing = this.host.tableMetadata.get(tableId);
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
        this.host.tableMetadata.set(tableId, next);
        if (!samePersistentTableMetadata(existing, next)) changed = true;
        if (this.demoteIfGameCountAnomaly(tableId)) {
          void this.host.failCloseLiveExecution([tableId]).catch(error => {
            this.host.recordLiveMonitorError(error, 'shoe-count-mismatch', 'degraded', tableId);
          });
        }
      }
    }
    this.copyWinfinityAliasMetadata();
    if (changed) this.persistTableMetadata();
    this.recoverMissedShuffles(rooms);
  }

  copyWinfinityAliasMetadata(): void {
    const aliases = this.host.browserBridge?.winfinityLockedAliases();
    if (aliases === undefined) return;
    for (const [vendor, publicId] of aliases) {
      const fallback = `wnf-${vendor}`;
      if (fallback === publicId) continue;
      const from = this.host.tableMetadata.get(fallback);
      const to = this.host.tableMetadata.get(publicId);
      if (from === undefined || to === undefined) continue;
      const gameCount = this.observedGameCount(publicId, from.gameCount ?? to.gameCount);
      const next: StoredTableMetadata = {
        ...to,
        ...(to.displayName === undefined && from.displayName !== undefined ? { displayName: from.displayName } : {}),
        ...(gameCount === undefined ? {} : { gameCount }),
      };
      if (!samePersistentTableMetadata(to, next) || to.gameCount !== next.gameCount) {
        this.host.tableMetadata.set(publicId, next);
      }
    }
  }

  recoverMissedShuffles(_rooms: readonly RoomDescriptor[]): void {
    // Automatic physical shoes come only from protocol token change or road wrap
    // in the parser. Do not invent a full 8-deck shoe from lagged DOM counts.
    this.host.missedShuffleRequested.clear();
  }

  persistTableMetadata(): void {
    this.host.ledger.setConfig<TableMetadataConfig>(TABLE_METADATA_CONFIG_KEY, {
      tables: [...this.host.tableMetadata.values()].map(table => ({
        tableId: table.tableId,
        roomId: table.roomId,
        updatedAt: table.updatedAt,
        ...(table.roomName === undefined ? {} : { roomName: table.roomName }),
        ...(table.displayName === undefined ? {} : { displayName: table.displayName }),
      })),
    });
  }

  pendingJoinTableIds(): string[] {
    const monitored = new Set(this.host.monitorTableIds);
    const pending: string[] = [];
    const add = (tableId: string): void => {
      if (monitored.has(tableId) || pending.includes(tableId)) return;
      pending.push(tableId);
    };
    for (const tableId of this.host.demotedPendingTableIds) add(tableId);
    for (const candidate of this.host.monitorCandidates()) {
      if (!isLiveDesktopRoomId(candidate.roomId)) continue;
      const tableId = normalizeOptionalMonitorTableId(candidate.tableId);
      if (tableId === undefined) continue;
      add(tableId);
    }
    return pending;
  }

  keepaliveEligibleTableIds(): string[] {
    return [...this.host.monitorTableIds];
  }

  observedTableIds(): string[] {
    // 必须走 currentMonitorTableIds：选桌事务期间瞬态允许名单优先于已提交列表。
    const ids = [...this.host.currentMonitorTableIds()];
    const seen = new Set(ids);
    for (const tableId of this.pendingJoinTableIds()) {
      if (seen.has(tableId)) continue;
      seen.add(tableId);
      ids.push(tableId);
    }
    return ids;
  }

  isObservedTable(tableId: string): boolean {
    return this.observedTableIds().includes(tableId);
  }

  clearStaleRoadCount(tableId: string): void {
    const existing = this.host.tableMetadata.get(tableId);
    if (existing?.gameCount === undefined) return;
    const { gameCount: _ignored, ...rest } = existing;
    this.host.tableMetadata.set(tableId, { ...rest, updatedAt: new Date().toISOString() });
    this.persistTableMetadata();
  }

  holdDemotedPendingTable(tableId: string, shoeId?: string): void {
    this.host.demotedPendingTableIds.add(tableId);
    this.host.demotedPendingShoeIds.set(tableId, shoeId ?? '');
  }

  clearDemotedPendingTable(tableId: string): void {
    this.host.demotedPendingTableIds.delete(tableId);
    this.host.demotedPendingShoeIds.delete(tableId);
  }

  canAutoPromotePendingTable(tableId: string, incomingShoeId?: string): boolean {
    if (!this.host.demotedPendingTableIds.has(tableId)) return true;
    const heldShoeId = this.host.demotedPendingShoeIds.get(tableId) ?? '';
    const nextShoeId = incomingShoeId
      ?? this.host.orchestrator.getActor(tableId)?.getProjection().shoeId
      ?? '';
    return nextShoeId.length > 0 && nextShoeId !== heldShoeId;
  }

  collapsedWinfinityTableIds(
    tableIds: readonly string[],
    introduceAliases = true,
  ): string[] {
    return collapseWinfinityDuplicateTableIds(tableIds, {
      aliasByVendor: this.host.browserBridge?.winfinityLockedAliases(),
      tables: [...this.host.tableMetadata.values()],
      preferIds: this.host.monitorTableIds,
      introduceAliases,
    });
  }

  sameTableIdList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((tableId, index) => tableId === right[index]);
  }

  promotePendingTable(tableId: string, incomingShoeId?: string): void {
    if (this.host.monitorTableIds.includes(tableId)) return;
    if (!this.canAutoPromotePendingTable(tableId, incomingShoeId)) return;
    const nextTableIds = this.collapsedWinfinityTableIds([...this.host.monitorTableIds, tableId]);
    if (this.sameTableIdList(nextTableIds, this.host.monitorTableIds)) return;
    if (nextTableIds.length > MAX_LIVE_MONITOR_TABLES) return;
    this.ensureMonitorActors(nextTableIds, this.host.currentUnifiedTableSettings());
    this.host.monitorTableIds = nextTableIds;
    this.host.pendingGameCountByTable.delete(tableId);
    this.clearDemotedPendingTable(tableId);
    this.host.runtimeIncidents.resolve('shoe-count-mismatch', tableId);
    this.host.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: nextTableIds });
    this.syncLiveApprovalsToMonitorTables();
    this.host.browserBridge?.setSelectedTableIds(this.observedTableIds());
  }

  promotePendingTablesFromRooms(rooms: readonly RoomDescriptor[]): void {
    for (const room of rooms) {
      if (!isLiveDesktopRoomId(room.roomId)) continue;
      for (const table of room.tables) {
        const tableId = normalizeOptionalMonitorTableId(table.tableId);
        if (tableId === undefined || this.host.monitorTableIds.includes(tableId)) continue;
        const evidence = this.host.browserBridge?.shoeEvidence(tableId);
        if (isVerifiedPhysicalShoeEvidence(evidence)) {
          this.promotePendingTable(tableId);
          if (this.host.monitorTableIds.includes(tableId)) continue;
        }
        const gameCount = table.gameCount;
        if (!Number.isInteger(gameCount) || (gameCount ?? 0) < 1) continue;
        const previous = this.host.pendingGameCountByTable.get(tableId);
        const stable = normalizeBgTableId(tableId) !== undefined
          ? selectBgRoadCount(previous, gameCount)
          : normalizeWinfinityTableId(tableId) !== undefined
            ? selectWinfinityRoadCount(previous, gameCount)
            : selectStableGameCount(previous, gameCount!);
        if (stable === undefined) continue;
        this.host.pendingGameCountByTable.set(tableId, stable);
        if (isJoinableNewShoeRoadCount(previous, stable)) this.promotePendingTable(tableId);
      }
    }
  }

  demoteAnomalousMonitorTable(
    tableId: string,
    handNumber: number,
    roadCount: number,
    missingCards: number,
    shoeId?: string,
  ): boolean {
    if (!this.host.liveMonitorActivated) return false;
    if (!this.host.monitorTableIds.includes(tableId)) return false;
    this.host.pendingGameCountByTable.set(tableId, roadCount);
    this.holdDemotedPendingTable(tableId, shoeId);
    const nextTableIds = this.host.monitorTableIds.filter(candidate => candidate !== tableId);
    this.host.monitorTableIds = nextTableIds;
    this.host.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: nextTableIds });
    this.syncLiveApprovalsToMonitorTables();
    this.host.browserBridge?.setSelectedTableIds(this.observedTableIds());
    this.host.ensureRuntimeIncident({
      code: 'shoe-count-mismatch',
      severity: 'degraded',
      tableId,
      message: `缺牌 ${missingCards} 张（内部 #${handNumber}，路子 #${roadCount}），已移出监控，等待下一靴`,
    });
    this.scheduleDemotedTableFeedStop(tableId);
    return true;
  }

  /**
   * 降级桌只从监控列表里移出是不够的：采集连接（WebSocket / 导出）还开着，
   * 会一直占用桥资源直到进程退出 —— 因为断开清理逻辑只处理仍在
   * monitorTableIds 里的桌。这里显式把它的 feed 关掉。
   */
  scheduleDemotedTableFeedStop(tableId: string): void {
    // 排队前先捕获 feed 引用：这个方法是同步调用的（可能已经在监控队列内部），
    // 真正停止要排到队列尾。期间该桌完全可能被重新晋升并挂上**新的** feed，
    // 那时不能把新连接关掉 —— 与 stopLiveFeedForTransition 的 not-current 约定一致。
    const demotedFeed = this.host.liveFeeds.get(tableId);
    if (demotedFeed === undefined) return;
    void this.host.enqueueLiveMonitorOperation(async () => {
      if (this.host.liveFeeds.get(tableId) !== demotedFeed) return;
      await this.host.stopLiveFeed(tableId, demotedFeed);
    }).catch(error => {
      this.host.recordLiveMonitorError(error, 'shoe-count-mismatch', 'degraded', tableId);
    });
  }

  demoteIfGameCountAnomaly(tableId: string): boolean {
    if (!this.host.liveMonitorActivated) return false;
    if (!this.host.monitorTableIds.includes(tableId)) return false;
    const actor = this.host.orchestrator.getActor(tableId);
    if (!actor) return false;
    const missingCards = actor.missingUnobservedCardCount();
    if (missingCards > 10) {
      const projection = actor.getProjection();
      const roadCount = this.host.tableMetadata.get(tableId)?.gameCount
        ?? this.host.browserBridge?.acceptedGameCount(tableId)
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

  ensureMonitorActors(
    tableIds: readonly string[],
    inheritedSettings?: UnifiedBetSettings,
  ): void {
    const settings = inheritedSettings ?? this.host.currentUnifiedTableSettings();
    for (const tableId of tableIds) {
      if (!this.host.orchestrator.getActor(tableId)) {
        const profile: TableProfile = defaultProfile(tableId);
        this.host.orchestrator.registerTable(
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
        if (this.host.orchestrator.getActor(tableId)?.snapshot().executionMode !== 'live') {
          this.host.orchestrator.updateTableExecutionMode(tableId, 'live');
        }
        this.host.applyUnifiedBetSettingsToTables([tableId]);
      }
    }
  }

  async applyCollapsedWinfinityMonitorTables(): Promise<void> {
    const nextTableIds = this.collapsedWinfinityTableIds(this.host.monitorTableIds);
    if (!this.sameTableIdList(nextTableIds, this.host.monitorTableIds)) {
      const removed = this.host.monitorTableIds.filter(tableId => !nextTableIds.includes(tableId));
      this.ensureMonitorActors(nextTableIds, this.host.currentUnifiedTableSettings());
      this.host.monitorTableIds = nextTableIds;
      this.host.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: nextTableIds });
      this.syncLiveApprovalsToMonitorTables();
      for (const tableId of removed) this.host.pendingGameCountByTable.delete(tableId);
    }
    const keepFeedIds = new Set(this.observedTableIds());
    for (const [tableId, feed] of [...this.host.liveFeeds]) {
      if (keepFeedIds.has(tableId)) continue;
      await this.host.stopLiveFeed(tableId, feed);
    }
  }

  async updateMonitorTableIdsInner(nextTableIds: readonly string[]): Promise<DesktopConsoleSnapshot> {
    const previousTableIds = [...this.host.monitorTableIds];
    const collapsedTableIds = this.collapsedWinfinityTableIds(nextTableIds);
    const inheritedSettings = this.host.currentUnifiedTableSettings();
    this.host.pendingMonitorTableIds = [...collapsedTableIds];
    try {
      this.ensureMonitorActors(collapsedTableIds, inheritedSettings);
      const keepFeedIds = new Set([...collapsedTableIds, ...this.pendingJoinTableIds()]);
      const outgoingFeeds = [...this.host.liveFeeds].filter(([tableId]) => !keepFeedIds.has(tableId));
      await this.host.failCloseLiveExecution(outgoingFeeds.map(([tableId]) => tableId));

      // Stop outgoing tables before mutating the Bridge allowlist. The Bridge
      // prunes exports as a side effect of selection changes, so doing this in
      // reverse order would make a failed stop ambiguous and could duplicate a
      // still-active export during rollback.
      for (const [tableId, feed] of outgoingFeeds) {
        const stopped = await this.host.stopLiveFeedForTransition(tableId, feed);
        if (stopped.kind === 'failed') {
          this.host.recordLiveMonitorError(stopped.error);
          this.host.pendingMonitorTableIds = undefined;
          return this.host.snapshot();
        }
      }

      this.host.browserBridge?.setSelectedTableIds(this.observedTableIds());
      await this.host.attachLiveTablesInner();
      this.host.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: collapsedTableIds });
      this.host.monitorTableIds = [...collapsedTableIds];
      for (const tableId of collapsedTableIds) this.clearDemotedPendingTable(tableId);
      this.syncLiveApprovalsToMonitorTables();
      this.host.pendingMonitorTableIds = undefined;
      return this.host.snapshot();
    } catch (error) {
      this.host.pendingMonitorTableIds = undefined;
      try {
        // Any feed created for the failed target selection is safe to clean up:
        // it remains outside the restored allowlist and will not be reopened.
        const keepRollbackIds = new Set([...previousTableIds, ...this.pendingJoinTableIds()]);
        for (const [tableId, feed] of [...this.host.liveFeeds]) {
          if (keepRollbackIds.has(tableId)) continue;
          await this.host.stopLiveFeed(tableId, feed);
        }
        this.host.monitorTableIds = previousTableIds;
        this.host.browserBridge?.setSelectedTableIds(this.observedTableIds());
        this.host.suppressDiscoveredMonitorAutoAdd = true;
        try {
          await this.host.attachLiveTablesInner();
        } finally {
          this.host.suppressDiscoveredMonitorAutoAdd = false;
        }
        this.host.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: previousTableIds });
        this.syncLiveApprovalsToMonitorTables();
      } catch (rollbackError) {
        this.host.recordLiveMonitorError(rollbackError);
      }
      throw error;
    }
  }
}
