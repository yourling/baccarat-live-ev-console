/**
 * Live feed 管线切片：从 DesktopConsoleService 拆出的桌数据流管理——
 * attach/stop 事务、断联分级（flap 统计与移除调度）、事件泵（enqueueMonitorEvent）
 * 与断线恢复（restore / connectionRestored）。
 *
 * 通过 LiveFeedConsoleHost 回访宿主；第一阶段只做代码成簇（方法搬移、
 * 状态仍在宿主），后续阶段再逐步收窄接口、接管状态所有权。
 */
import {
  EVENT_SCHEMA_VERSION,
  newId,
  type ExecutionMode,
  type NormalizedEvent,
} from '@baccarat/contracts';
import { cursorContinuityProof } from '@baccarat/room-monitor';
import { isVerifiedPhysicalShoeEvidence } from '@baccarat/ledger-state';
import type { SqliteLedger } from '@baccarat/ledger-state';
import type { Orchestrator } from '@baccarat/orchestrator';
import { defaultProfile } from '@baccarat/contracts';
import { normalizeBgTableId } from '@baccarat/browser-bridge';
import type { BrowserBridgeServer } from '@baccarat/browser-bridge';
import type { TableExport } from '@baccarat/room-monitor';
import type { RuntimeIncidentCode, RuntimeIncidentSeverity, RuntimeIncidentStore } from './runtime-supervisor.js';
import type { OperationalWagerConsole } from './operational-wager-console.js';
import type { MonitorConsole } from './monitor-console.js';
import {
  DISCONNECTED_MONITOR_REMOVAL_MS,
  SHUFFLE_MONITOR_HOLD_MS,
  type MonitorTableConfig,
  type StoredTableMetadata,
  normalizeOptionalMonitorTableId,
  type UnifiedBetSettings,
} from './monitor-shared.js';
import { MONITOR_TABLE_CONFIG_KEY } from './monitor-shared.js';

/** live feed 管线回访宿主的最小接口；随拆分推进逐步收窄。 */
export interface LiveFeedConsoleHost {
  readonly ledger: SqliteLedger;
  readonly orchestrator: Orchestrator;
  readonly browserBridge?: BrowserBridgeServer;
  readonly runtimeIncidents: RuntimeIncidentStore;
  readonly monitorConsole: MonitorConsole;
  readonly wagerConsole: OperationalWagerConsole;
  readonly liveFeeds: Map<string, TableExport>;
  readonly liveRoomIdsByTable: Map<string, string>;
  readonly disconnectedMonitorRemovalTimers: Map<string, NodeJS.Timeout>;
  readonly lastFeedDisconnectReason: Map<string, string>;
  readonly shuffleHoldUntilByTable: Map<string, number>;
  readonly runtimeObservedTableIds: Set<string>;
  readonly connectedThisProcess: Set<string>;
  readonly tableFlapStats: Map<string, {
    disconnects: number;
    lastDisconnectAt: number;
    lastRecoveredAt?: number;
    recentDisconnectAt: number[];
  }>;
  readonly tableMetadata: Map<string, StoredTableMetadata>;
  /** 断联噪声抑制窗口截止时刻。 */
  recoverySuppressUntil: number;
  transportDownAt?: number;
  liveExecutionMode: ExecutionMode;
  liveMonitorActivated: boolean;
  readonly liveMonitorStartedAt: number;
  monitorTableIds: string[];
  /** 回滚期间抑制发现表自动加入（与 MonitorConsoleHost 共享同一状态）。 */
  suppressDiscoveredMonitorAutoAdd: boolean;
  readonly closing: boolean;
  automationEnabled: boolean;
  cachedLightSnapshot?: { key: string; at: number; value: unknown };
  currentUnifiedTableSettings(): UnifiedBetSettings | undefined;
  detectSettlementGap(event: Extract<NormalizedEvent, { type: 'bettingWindowOpened' }>): boolean;
  resolveSettlementGapIfCleared(tableId: string): void;
  rearmPairAutomation(tableId: string): Promise<void>;
  reconcileUnattendedExecution(): Promise<void>;
  refreshAccountingIncidents(force?: boolean): void;
  failCloseLiveExecution(tableIds: readonly string[]): Promise<void>;
  resetMonitorExecutionState(tableId: string): Promise<void>;
  recordLiveMonitorError(
    error: unknown,
    code?: RuntimeIncidentCode,
    severity?: RuntimeIncidentSeverity,
    tableId?: string,
  ): void;
  ensureRuntimeIncident(input: {
    readonly code: RuntimeIncidentCode;
    readonly severity: RuntimeIncidentSeverity;
    readonly message: string;
    readonly tableId?: string;
  }): void;
  enqueueLiveMonitorOperation<T>(operation: () => Promise<T>): Promise<T>;
  enqueueExecutionStateOperation<T>(operation: () => Promise<T>): Promise<T>;
}

export class LiveFeedConsole {
  constructor(private readonly host: LiveFeedConsoleHost) {}

  nextMonitorSourceSeq(tableId: string): number {
    return this.host.ledger.allocateSourceSeq(tableId);
  }

  isCurrentLiveFeed(tableId: string, feed: TableExport): boolean {
    return this.host.monitorConsole.isObservedTable(tableId) && this.host.liveFeeds.get(tableId) === feed;
  }

  isLiveTableFeedEvent(event: NormalizedEvent): boolean {
    return event.type === 'newShoeSignal'
      || event.type === 'cardObserved'
      || event.type === 'bettingWindowOpened'
      || event.type === 'bettingWindowClosed'
      || event.type === 'handSettled'
      || event.type === 'redCardSeen'
      || event.type === 'shoeInvalidated';
  }

  async restoreDisconnectedFeed(event: NormalizedEvent): Promise<NormalizedEvent> {
    const disconnectReason = this.host.lastFeedDisconnectReason.get(event.tableId) ?? '';
    const resumable = disconnectReason === 'table-feed-stale'
      || disconnectReason.startsWith('continuity gap');
    if (!resumable) return event;
    const actor = this.host.orchestrator.getActor(event.tableId);
    if (actor?.getProjection().connectionStatus !== 'DISCONNECTED') return event;
    await this.host.orchestrator.enqueue(event.tableId, {
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
    this.host.lastFeedDisconnectReason.delete(event.tableId);
    return { ...event, sourceSeq: this.nextMonitorSourceSeq(event.tableId) };
  }

  async enqueueMonitorEvent(event: NormalizedEvent): Promise<void> {
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
        this.host.shuffleHoldUntilByTable.set(event.tableId, Date.now() + SHUFFLE_MONITOR_HOLD_MS);
      }
      this.host.runtimeObservedTableIds.add(event.tableId);
      this.resolveTransientTableIncidents(event.tableId);
    }
    if (event.type === 'connectionRestored') {
      this.host.connectedThisProcess.add(event.tableId);
      this.cancelDisconnectedMonitorRemoval(event.tableId);
      this.resolveTransientTableIncidents(event.tableId);
    }
    if (event.type === 'bettingWindowOpened') {
      this.host.connectedThisProcess.add(event.tableId);
      this.host.detectSettlementGap(event);
    }
    if (event.type === 'newShoeSignal' && event.baseline === 'physical-shoe') {
      this.host.connectedThisProcess.add(event.tableId);
    }
    if (
      (event.type === 'newShoeSignal' && event.baseline === 'physical-shoe')
      || event.type === 'bettingWindowOpened'
    ) {
      // Shuffle starts the evidence, but the table must still be monitored when
      // the new shoe actually opens. Re-promote on the first post-shuffle window
      // if a mid-shuffle demote/disconnect dropped it back to pending.
      const evidence = this.host.browserBridge?.shoeEvidence(event.tableId);
      if (isVerifiedPhysicalShoeEvidence(evidence)) {
        this.host.monitorConsole.promotePendingTable(event.tableId, event.shoeId);
        if (event.type === 'newShoeSignal' && normalizeBgTableId(event.tableId) === undefined) {
          this.host.monitorConsole.clearStaleRoadCount(event.tableId);
        }
      }
    }
    this.host.cachedLightSnapshot = undefined;
    const liveEvent = this.isLiveTableFeedEvent(event)
      ? await this.restoreDisconnectedFeed(event)
      : event;
    await this.host.orchestrator.enqueue(liveEvent.tableId, liveEvent);
    if (
      event.type === 'handSettled'
      || event.type === 'bettingWindowOpened'
      || event.type === 'cardObserved'
    ) {
      if (this.host.monitorConsole.demoteIfGameCountAnomaly(event.tableId)) {
        await this.host.failCloseLiveExecution([event.tableId]);
      }
    }
    if (
      event.type === 'handSettled'
      || event.type === 'betReceipt'
      || event.type === 'connectionLost'
      || event.type === 'connectionRestored'
    ) {
      this.host.refreshAccountingIncidents(true);
    }
    if (event.type === 'cardObserved' || event.type === 'handSettled') {
      this.host.wagerConsole.trySettleReservedHand(event.tableId, event.shoeId, event.handId);
    }
    if (event.type === 'bettingWindowOpened') {
      this.host.wagerConsole.trySettleReservedHand(event.tableId, event.shoeId);
    }
    if (event.type === 'handSettled') {
      this.host.resolveSettlementGapIfCleared(event.tableId);
    }
    if (
      event.type === 'newShoeSignal'
      || event.type === 'connectionRestored'
      || (event.type === 'shoeConfirmation' && event.approved)
    ) {
      await this.host.rearmPairAutomation(event.tableId);
    }
    if (
      event.type === 'bettingWindowOpened'
      || event.type === 'connectionLost'
      || event.type === 'connectionRestored'
    ) {
      await this.host.reconcileUnattendedExecution();
    }
  }

  noteTableDisconnect(tableId: string, now = Date.now()): void {
    const stats = this.host.tableFlapStats.get(tableId) ?? {
      disconnects: 0,
      lastDisconnectAt: 0,
      recentDisconnectAt: [],
    };
    const recent = [...(stats.recentDisconnectAt ?? []), now].filter(at => now - at < 300_000);
    stats.recentDisconnectAt = recent;
    stats.disconnects = recent.length;
    stats.lastDisconnectAt = now;
    this.host.tableFlapStats.set(tableId, stats);
  }

  noteTableRecovered(tableId: string): void {
    const stats = this.host.tableFlapStats.get(tableId);
    if (stats !== undefined) stats.lastRecoveredAt = Date.now();
  }

  flapEscalated(tableId: string, now = Date.now()): boolean {
    const stats = this.host.tableFlapStats.get(tableId);
    if (stats === undefined) return false;
    const recent = (stats.recentDisconnectAt ?? []).filter(at => now - at < 300_000);
    return recent.length >= 4;
  }

  beginRecoverySuppression(windowMs = 60_000): void {
    this.host.recoverySuppressUntil = Math.max(this.host.recoverySuppressUntil, Date.now() + windowMs);
  }

  suppressTableDisconnectNoise(reason?: string): boolean {
    if (Date.now() >= this.host.recoverySuppressUntil) return false;
    return reason === 'table-feed-stale' || reason === 'browser-extension-disconnected';
  }

  /** 按桌链路状态机，供 UI 做恢复清单展示。 */
  tableLinkState(tableId: string, active: boolean, reasons: readonly string[], feedState?: string): 'live' | 'degraded' | 'resyncing' | 'offline' {
    if (active && reasons.length === 0) return 'live';
    if (feedState === 'DISCONNECTED') return 'offline';
    const actor = this.host.orchestrator.getActor(tableId);
    if (feedState === undefined) return 'resyncing';
    if (actor?.getProjection().connectionStatus !== 'CONNECTED') return 'resyncing';
    return 'degraded';
  }

  resolveTransientTableIncidents(tableId: string): void {
    this.host.runtimeIncidents.resolve('table-feed-stale', tableId);
    this.host.runtimeIncidents.resolve('monitor-failure', tableId);
    this.host.runtimeIncidents.resolve('bridge-disconnected', tableId);
  }

  async stopLiveFeed(tableId: string, feed: TableExport): Promise<void> {
    this.cancelDisconnectedMonitorRemoval(tableId);
    if (this.host.liveFeeds.get(tableId) === feed) {
      this.host.liveFeeds.delete(tableId);
      this.host.liveRoomIdsByTable.delete(tableId);
    }
    this.host.runtimeObservedTableIds.delete(tableId);
    this.resolveTransientTableIncidents(tableId);
    await this.host.failCloseLiveExecution([tableId]);
    try {
      await feed.stop();
    } catch (error) {
      this.host.recordLiveMonitorError(error, 'monitor-failure', 'degraded', tableId);
    }
    await this.host.resetMonitorExecutionState(tableId);
  }

  /**
   * Strict shutdown used only while changing the selected monitor tables.
   * Retain the old feed until stop succeeds, so a failed transition neither
   * changes the Bridge selection nor creates a duplicate replacement export.
   */
  async stopLiveFeedForTransition(
    tableId: string,
    feed: TableExport,
  ): Promise<{ kind: 'stopped' } | { kind: 'not-current' } | { kind: 'failed'; readonly error: unknown }> {
    if (this.host.liveFeeds.get(tableId) !== feed) return { kind: 'not-current' };
    this.cancelDisconnectedMonitorRemoval(tableId);
    try {
      await this.host.failCloseLiveExecution([tableId]);
    } catch (error) {
      return { kind: 'failed', error };
    }
    try {
      await feed.stop();
    } catch (error) {
      return { kind: 'failed', error };
    }
    if (this.host.liveFeeds.get(tableId) === feed) {
      this.host.liveFeeds.delete(tableId);
      this.host.liveRoomIdsByTable.delete(tableId);
    }
    this.host.runtimeObservedTableIds.delete(tableId);
    this.resolveTransientTableIncidents(tableId);
    return { kind: 'stopped' };
  }

  cancelDisconnectedMonitorRemoval(tableId: string): void {
    const timer = this.host.disconnectedMonitorRemovalTimers.get(tableId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.host.disconnectedMonitorRemovalTimers.delete(tableId);
  }

  scheduleDisconnectedMonitorRemoval(tableId: string, reason?: string): void {
    if (this.host.closing || !this.host.monitorTableIds.includes(tableId)) return;
    const startupGap = reason === 'table-not-discovered'
      || reason === 'process-restarted'
      || reason === 'extension-session-restarted'
      || reason === 'browser-extension-disconnected'
      || reason === 'table-feed-stale'
      || reason === undefined
      || reason === '';
    if (startupGap && !this.host.connectedThisProcess.has(tableId)) return;
    if (this.host.liveMonitorStartedAt > 0 && Date.now() - this.host.liveMonitorStartedAt < 60_000) return;
    const shuffleHoldUntil = this.host.shuffleHoldUntilByTable.get(tableId) ?? 0;
    if (Date.now() < shuffleHoldUntil) return;
    if (reason === 'table-not-discovered') {
      this.noteTableDisconnect(tableId);
      if (!this.host.browserBridge?.getExtensionStatus().authenticated) return;
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
    if (this.host.disconnectedMonitorRemovalTimers.has(tableId)) return;
    const delayMs = DISCONNECTED_MONITOR_REMOVAL_MS;
    const timer = setTimeout(() => {
      this.host.disconnectedMonitorRemovalTimers.delete(tableId);
      void this.host.enqueueLiveMonitorOperation(async () => {
        await this.removeDisconnectedMonitorTable(tableId);
      }).catch(error => this.host.recordLiveMonitorError(error, 'monitor-failure', 'degraded', tableId));
    }, delayMs);
    timer.unref?.();
    this.host.disconnectedMonitorRemovalTimers.set(tableId, timer);
  }

  async removeDisconnectedMonitorTable(tableId: string): Promise<void> {
    if (!this.host.monitorTableIds.includes(tableId)) return;
    const shuffleHoldUntil = this.host.shuffleHoldUntilByTable.get(tableId) ?? 0;
    if (Date.now() < shuffleHoldUntil) return;
    const feed = this.host.liveFeeds.get(tableId);
    const health = feed?.health();
    const shouldRemove = feed === undefined
      || health?.state === 'DISCONNECTED'
      || (typeof health?.stalenessMs === 'number' && health.stalenessMs >= DISCONNECTED_MONITOR_REMOVAL_MS);
    if (!shouldRemove) return;

    if (feed !== undefined) await this.stopLiveFeed(tableId, feed);
    await this.host.failCloseLiveExecution([tableId]);
    const nextTableIds = this.host.monitorTableIds.filter(candidate => candidate !== tableId);
    this.host.monitorTableIds = nextTableIds;
    this.host.ledger.setConfig<MonitorTableConfig>(MONITOR_TABLE_CONFIG_KEY, { tableIds: nextTableIds });
    this.host.monitorConsole.syncLiveApprovalsToMonitorTables();
    this.host.browserBridge?.setSelectedTableIds(this.host.monitorConsole.observedTableIds());
  }

  attachLiveTables(): Promise<void> {
    return this.host.enqueueLiveMonitorOperation(() => this.attachLiveTablesInner());
  }

  async attachLiveTablesInner(): Promise<void> {
    const browserBridge = this.host.browserBridge;
    if (!browserBridge) return;
    const discoveredRooms = browserBridge.getDiscoveredRooms();
    this.host.monitorConsole.refreshTableMetadataFromRooms(discoveredRooms);
    if (this.host.liveMonitorActivated && !this.host.suppressDiscoveredMonitorAutoAdd) {
      this.host.monitorConsole.promotePendingTablesFromRooms(discoveredRooms);
    }
    await this.host.monitorConsole.applyCollapsedWinfinityMonitorTables();
    browserBridge.setSelectedTableIds(this.host.monitorConsole.observedTableIds());
    if (
      this.host.monitorTableIds.length === 0
      && this.host.monitorConsole.pendingJoinTableIds().length === 0
      && !browserBridge.hasRuntimeTableSelection()
      && !browserBridge.hasConfiguredTableSelection()
    ) return;

    const rooms = await browserBridge.discoverRooms();
    this.host.monitorConsole.refreshTableMetadataFromRooms(rooms);
    if (this.host.liveMonitorActivated && !this.host.suppressDiscoveredMonitorAutoAdd) {
      this.host.monitorConsole.promotePendingTablesFromRooms(rooms);
    }
    await this.host.monitorConsole.applyCollapsedWinfinityMonitorTables();
    const discoveredTableIds = discoveredMonitorTableIds([...discoveredRooms, ...rooms]);
    const discoveryReliable = browserBridge.getExtensionStatus().authenticated
      && discoveredTableIds.size > 0;
    for (const tableId of this.host.monitorTableIds) {
      if (discoveredTableIds.has(tableId) || this.host.liveFeeds.has(tableId)) {
        this.cancelDisconnectedMonitorRemoval(tableId);
      } else if (
        discoveryReliable
        && !isVerifiedPhysicalShoeEvidence(this.host.browserBridge?.shoeEvidence(tableId))
      ) {
        this.scheduleDisconnectedMonitorRemoval(tableId, 'table-not-discovered');
      } else {
        this.cancelDisconnectedMonitorRemoval(tableId);
      }
    }
    const selectedTableIds = new Set(this.host.monitorConsole.observedTableIds());
    this.host.browserBridge?.setSelectedTableIds([...selectedTableIds]);
    for (const room of rooms) {
      for (const table of room.tables) {
        // The service is the final allowlist boundary; never rely solely on a bridge cache.
        if (!selectedTableIds.has(table.tableId) || !this.host.monitorConsole.isObservedTable(table.tableId)) continue;
        if (this.host.liveFeeds.has(table.tableId)) continue;
        if (!this.host.orchestrator.getActor(table.tableId)) {
          const settings = this.host.currentUnifiedTableSettings();
          const profile = defaultProfile(table.tableId);
          const merged = table.profile === undefined
            ? profile
            : { ...profile, ...table.profile, tableId: table.tableId };
          this.host.orchestrator.registerTable(
            settings === undefined
              ? merged
              : {
                  ...merged,
                  minEV: settings.minEV,
                  betTiers: settings.betTiers.map(tier => ({ ...tier })),
                },
            this.host.liveExecutionMode,
            settings?.defaultBetAmount ?? 100,
          );
        }
        this.cancelDisconnectedMonitorRemoval(table.tableId);
        await this.host.resetMonitorExecutionState(table.tableId);

        const feed = browserBridge.openTable(room.roomId, table.tableId);
        this.host.liveRoomIdsByTable.set(table.tableId, room.roomId);
        this.host.liveFeeds.set(table.tableId, feed);
        try {
          await feed.start({
            onBatch: async batch => {
              if (!this.isCurrentLiveFeed(table.tableId, feed)) return;
              for (const event of batch.events) {
                if (event.tableId !== table.tableId || !this.isCurrentLiveFeed(table.tableId, feed)) continue;
                const sourceSeq = this.nextMonitorSourceSeq(event.tableId);
                if (!this.isCurrentLiveFeed(table.tableId, feed)) continue;
                void this.enqueueMonitorEvent({ ...event, sourceSeq })
                  .catch(error => this.host.recordLiveMonitorError(error, 'monitor-failure', 'degraded', event.tableId));
              }
            },
            onDisconnect: (tableId, reason) => {
              if (!this.isCurrentLiveFeed(tableId, feed)) return;
              this.host.lastFeedDisconnectReason.set(tableId, reason ?? '');
              this.host.runtimeObservedTableIds.delete(tableId);
              // BridgeTableExport performs its own reconnect. Keep the identity
              // registered while it is disconnected: deleting it would make the
              // periodic attach call start() on the same already-started export.
              void this.host.enqueueExecutionStateOperation(async () => {
                const health = this.host.liveFeeds.get(tableId)?.health();
                if (health?.state === 'CONNECTED') return;
                if (reason === 'table-feed-stale') {
                  this.host.ensureRuntimeIncident({
                    code: 'table-feed-stale',
                    severity: 'blocked',
                    tableId,
                    message: reason,
                  });
                }
                await this.host.failCloseLiveExecution([tableId]);
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
              }).catch(error => this.host.recordLiveMonitorError(error, 'monitor-failure', 'degraded', tableId));
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
              }).catch(error => this.host.recordLiveMonitorError(error, 'monitor-failure', 'degraded', tableId));
            },
          });
          if (!this.isCurrentLiveFeed(table.tableId, feed)) {
            await this.stopLiveFeed(table.tableId, feed);
            continue;
          }
        } catch (error) {
          if (this.host.liveFeeds.get(table.tableId) === feed) {
            this.host.liveFeeds.delete(table.tableId);
            this.host.liveRoomIdsByTable.delete(table.tableId);
          }
          this.host.runtimeObservedTableIds.delete(table.tableId);
          try {
            await feed.stop();
          } catch (stopError) {
            this.host.recordLiveMonitorError(stopError, 'monitor-failure', 'degraded', table.tableId);
          }
          throw error;
        }
      }
    }
  }
}

function discoveredMonitorTableIds(rooms: readonly { tables: readonly { tableId: string }[] }[]): Set<string> {
  const tableIds = new Set<string>();
  for (const room of rooms) {
    for (const table of room.tables) {
      const tableId = normalizeOptionalMonitorTableId(table.tableId);
      if (tableId !== undefined) tableIds.add(tableId);
    }
  }
  return tableIds;
}
