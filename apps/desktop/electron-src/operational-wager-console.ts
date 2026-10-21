/**
 * OperationalWager 控制台切片：从 DesktopConsoleService 拆出的受控下注
 * 生命周期（手动执行 / UNKNOWN 对账 / 勾销 / 待结算确认 / 结算兜底恢复）。
 *
 * 通过 WagerConsoleHost 接口回访宿主，不持有任何自己的持久状态——
 * 这是拆分的第一阶段（代码成簇），后续阶段再逐步收窄宿主接口。
 */
import type { OperationalWagerSource } from '@baccarat/adapter-contract';
import type { SqliteLedger } from '@baccarat/ledger-state';
import type { Orchestrator } from '@baccarat/orchestrator';
import { isCompleteBaccaratHand } from '@baccarat/browser-bridge';
import type { BrowserBridgeServer } from '@baccarat/browser-bridge';
import type {
  OperationalWagerCoordinator,
  OperationalWagerResult,
} from './operational-wager-coordinator.js';
import type { LiveExecutionBlockReason } from './runtime-supervisor.js';
import type { MonitorSummary } from '@baccarat/ledger-state';
import type { DesktopConsoleSnapshot } from './service.js';
import type {
  DesktopRecordCounts,
  DesktopPendingSettlementCommand,
  DesktopSnapshotOptions,
  DesktopUnknownWagerReconciliationCommand,
  DesktopUnknownWagerWriteOffCommand,
} from '../src/api-types.js';

/** OperationalWagerConsole 回访宿主的最小接口；随拆分推进逐步收窄。 */
export interface WagerConsoleHost {
  readonly ledger: SqliteLedger;
  readonly orchestrator: Orchestrator;
  readonly operationalWagers: OperationalWagerCoordinator;
  readonly browserBridge?: BrowserBridgeServer;
  /** 进程启动期的 fail-close 兜底任务；所有执行入口必须先 await 它。 */
  readonly startupFailCloseTask: Promise<void>;
  /** close() 之后的执行一律拒绝（见 operationalWagerRuntimeBlockReason）。 */
  readonly closing: boolean;
  /** 全局 live gate 的持久状态；手动执行会临时开启/恢复。 */
  persistentLiveGateEnabled: boolean;
  /** 快照缓存；受控下注落账后失效。 */
  cachedSummary?: MonitorSummary;
  cachedRecordCounts?: DesktopRecordCounts;
  /** FIX(D-P2-4): 写路径用轻量快照（includeHistory:false），不拉全量历史。 */
  readonly lightWriteSnapshotOptions: DesktopSnapshotOptions;
  snapshot(options?: DesktopSnapshotOptions): DesktopConsoleSnapshot;
  enqueueExecutionStateOperation<T>(operation: () => Promise<T>): Promise<T>;
  refreshAccountingIncidents(force?: boolean): void;
  setOperationalWagerExecutor(enabled: boolean): void;
  /** FIX(D-P1-6): 全局 blocked 事故码（tableId === undefined），参与执行门控。 */
  activeGlobalBlockedIncidentCode(): string | undefined;
  manualLiveTableReasons(tableId: string, approved?: boolean, allowNewAuthorization?: boolean): LiveExecutionBlockReason[];
  keepaliveTableReasons(tableId: string, requireAuthorization?: boolean): LiveExecutionBlockReason[];
  reconcileUnattendedExecution(): Promise<void>;
}

export class OperationalWagerConsole {
  constructor(private readonly host: WagerConsoleHost) {}

  /** coordinator 的运行时阻断回调（构造 Orchestrator 时注入）。 */
  runtimeBlockReason(
    tableId: string,
    source?: OperationalWagerSource,
  ): string | undefined {
    return this.operationalWagerRuntimeBlockReason(tableId, source);
  }

  /** 监控事件路径的结算兜底：结算事件缺失时用手牌重建结果。 */
  trySettleReservedHand(tableId: string, shoeId: string, handId?: string): void {
    this.trySettleReservedOperationalHand(tableId, shoeId, handId);
  }

  async execute(input: {
    readonly tableId: string;
    readonly market: 'banker' | 'player' | 'bankerPair' | 'playerPair';
    readonly amount: number;
    readonly handId?: string;
  }): Promise<OperationalWagerResult & { readonly snapshot: DesktopConsoleSnapshot }> {
    // 注意：不要在这里再包一层 enqueueExecutionStateOperation —— coordinator 的
    // serialize 已经走同一条队列，重复排队会自死锁。关闭检查放在队列内部的
    // operationalWagerRuntimeBlockReason 里，才能真正挡住排在 close() 之后的下注。
    await this.host.startupFailCloseTask;
    if (this.host.closing) {
      return {
        status: 'REJECTED' as const,
        tableId: input.tableId,
        reason: 'console-closing',
        snapshot: this.host.snapshot(),
      };
    }
    const actor = this.host.orchestrator.getActor(input.tableId);
    const bridge = this.host.browserBridge;
    const gateWasAlreadyEnabled = this.host.persistentLiveGateEnabled;
    if (actor && bridge) {
      this.host.orchestrator.updateTableExecutionMode(input.tableId, 'live');
      this.host.setOperationalWagerExecutor(true);
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
      result = await this.host.operationalWagers.executeManual(input);
    } finally {
      // 重新读取桥：下注是异步的，期间 close() 可能已经把它换掉或拆除，
      // 拿旧引用去关 gate 会作用在已关闭的桥上。
      const currentBridge = this.host.browserBridge;
      if (actor && currentBridge && !gateWasAlreadyEnabled && !this.host.closing) {
        try {
          currentBridge.setLiveBetEnabled(false);
        } catch {
          this.host.persistentLiveGateEnabled = false;
        }
      }
    }
    if (result.status === 'UNKNOWN') {
      this.host.refreshAccountingIncidents(true);
    }
    return { ...result, snapshot: this.host.snapshot() };
  }

  async reconcileUnknown(
    command: DesktopUnknownWagerReconciliationCommand,
  ): Promise<DesktopConsoleSnapshot> {
    return await this.host.enqueueExecutionStateOperation(async () => {
      await this.host.startupFailCloseTask;
      const reservation = this.host.orchestrator.getReservations()
        .find(candidate => candidate.reservationId === command.reservationId);
      if (!reservation) throw new Error(`reservation ${command.reservationId} not found`);

      const record = this.host.ledger.getOperationalWager(command.wagerId);
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

      const settlement = this.host.ledger.getHandSettlement(
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
        return this.host.snapshot(this.host.lightWriteSnapshotOptions);
      }
      const reconciliation = record.reconciliation ?? {
        status: 'ACCEPTED' as const,
        reason: 'operator-confirmed-platform-accepted' as const,
        reconciledAt: new Date().toISOString(),
      };
      this.host.ledger.reconcileOperationalWager(command.wagerId, reconciliation);
      if (record.status === 'UNKNOWN') {
        this.host.orchestrator.settleUnknownReservation(
          command.reservationId,
          settlement,
          reconciliation.reason,
        );
      } else {
        this.host.orchestrator.settleReleasedReservation(
          command.reservationId,
          settlement,
          reconciliation.reason,
        );
      }
      this.host.refreshAccountingIncidents(true);
      this.host.cachedSummary = undefined;
      this.host.cachedRecordCounts = undefined;
      return this.host.snapshot(this.host.lightWriteSnapshotOptions);
    });
  }

  async writeOffUnknown(
    command: DesktopUnknownWagerWriteOffCommand,
  ): Promise<DesktopConsoleSnapshot> {
    return await this.host.enqueueExecutionStateOperation(async () => {
      await this.host.startupFailCloseTask;
      const reservation = this.host.orchestrator.getReservations()
        .find(candidate => candidate.reservationId === command.reservationId);
      if (!reservation) throw new Error(`reservation ${command.reservationId} not found`);
      if (reservation.status !== 'UNKNOWN') {
        throw new Error(`reservation ${command.reservationId} is not an UNKNOWN exposure`);
      }

      const record = command.wagerId ? this.host.ledger.getOperationalWager(command.wagerId) : undefined;
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
        this.host.ledger.writeOffOperationalWager(record.wager.wagerId, writeOff);
        this.host.orchestrator.writeOffUnknownReservation(
          command.reservationId,
          writeOff.reason,
        );
      } else {
        this.host.orchestrator.writeOffUnknownReservation(
          command.reservationId,
          'operator-unconfirmed-write-off',
        );
      }
      this.host.refreshAccountingIncidents(true);
      this.host.cachedSummary = undefined;
      this.host.cachedRecordCounts = undefined;
      await this.host.reconcileUnattendedExecution();
      return this.host.snapshot(this.host.lightWriteSnapshotOptions);
    });
  }

  async settlePending(
    command: DesktopPendingSettlementCommand,
  ): Promise<DesktopConsoleSnapshot> {
    return await this.host.enqueueExecutionStateOperation(async () => {
      await this.host.startupFailCloseTask;
      const reservation = this.host.orchestrator.getReservations()
        .find(candidate => candidate.reservationId === command.reservationId);
      if (!reservation) throw new Error(`reservation ${command.reservationId} not found`);

      const record = this.host.ledger.getOperationalWager(command.wagerId);
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
        if (reservation.status === 'SETTLED') return this.host.snapshot(this.host.lightWriteSnapshotOptions);
      }
      if (reservation.status !== 'RESERVED') {
        throw new Error(`reservation ${command.reservationId} is not awaiting settlement`);
      }
      if (this.host.ledger.getHandSettlement(reservation.tableId, reservation.shoeId, reservation.handId)) {
        throw new Error('authoritative hand settlement is already available for this exact wager');
      }
      const settlement = record.settlement ?? {
        outcome: command.outcome,
        realizedPnl,
        reason: 'operator-confirmed-platform-settlement' as const,
        settledAt: new Date().toISOString(),
      };
      this.host.ledger.settleOperationalWager(command.wagerId, settlement);
      this.host.orchestrator.settleReservedReservationManually(
        command.reservationId,
        realizedPnl,
        settlement.reason,
      );
      this.host.refreshAccountingIncidents(true);
      this.host.cachedSummary = undefined;
      this.host.cachedRecordCounts = undefined;
      return this.host.snapshot(this.host.lightWriteSnapshotOptions);
    });
  }

  private trySettleReservedOperationalHand(
    tableId: string,
    _shoeId: string,
    handId?: string,
  ): void {
    const reserved = this.host.orchestrator.getReservations(tableId).filter(reservation =>
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
      const { playerCards, bankerCards } = this.host.ledger.listHandCards(tableId, targetHandId);
      if (!isCompleteBaccaratHand(playerCards, bankerCards)) continue;
      const outcomes = pairOutcomesFromCards(playerCards, bankerCards);
      for (const reservation of reserved.filter(candidate => candidate.handId === targetHandId)) {
        this.host.orchestrator.recoverAcceptedHandSettlement(
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

  private operationalWagerRuntimeBlockReason(
    tableId: string,
    source?: OperationalWagerSource,
  ): string | undefined {
    // 关窗期间一律拒绝受控下注。这个检查发生在执行队列内部（coordinator 的
    // serialize 走的就是 enqueueExecutionStateOperation），因此能挡住"排在
    // close() 之后才被调度"的下注 —— 那时桥已经开始拆除。
    if (this.host.closing) return 'console-closing';
    // FIX(D-P1-6): 全局 blocked 事故（桥认证失败 / 断联 / 连续性失效 /
    // 会话恢复耗尽，且 tableId === undefined）必须参与执行门控。
    // 修复前它们只影响 runtime.status 与 UI 横幅：桥仍可能"已认证、连接数 1"，
    // 单桌 reasons 为空，于是操作员看到"已阻断"却仍能手写下真金（a1b 实证）。
    // 放在 actor/executionMode 检查**之前**，避免"该桌刚好没 actor 就直接放行"。
    const globalBlock = this.host.activeGlobalBlockedIncidentCode();
    if (globalBlock !== undefined) return `runtime-blocked:${globalBlock}`;
    const actor = this.host.orchestrator.getActor(tableId);
    if (actor?.snapshot().executionMode !== 'live') return undefined;
    // FIX(D-P0-1): 门控按来源分流 ——
    //  · keepalive（无人值守）必须有**既有**授权（liveAuthorizationSources 命中）；
    //  · manual 允许**本次调用建立**授权（execute() 会临时打开 live gate 并执行，
    //    授权由 setExecutionMode / reconcileUnattendedExecution 之外的手动入口补写，
    //    因此不能把"尚未授权"当成手动阻断，否则首次手动下注会被锁死）。
    // 修复前两条路径都只查 liveTableReasons，完全不看授权：多桌时被撤销授权的桌
    // 在 promote 后首个窗口仍能发真金（a1h/a1d 实证）。
    const reasons = source === 'manual'
      ? this.host.manualLiveTableReasons(tableId, true)
      : this.host.keepaliveTableReasons(tableId);
    return reasons.length === 0
      ? undefined
      : `unattended-runtime-blocked:${reasons.join(',')}`;
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
