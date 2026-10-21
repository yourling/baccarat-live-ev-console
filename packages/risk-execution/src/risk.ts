import {
  RISK_RELEASE_REASONS,
  SETTLEABLE_UNKNOWN_RELEASE_REASONS,
  assertValidRiskLimits,
  assertValidTableProfile,
  type BetIntent,
  type ExecutionMarket,
  type ExecutionSource,
  type OddsConfig,
  type RiskExposureState,
  type RiskLimits,
  type RiskReservation,
  type TableLimits,
  type TableProfile,
  newId,
} from '@baccarat/contracts';

export interface ReserveResult {
  ok: boolean;
  reservation?: RiskReservation;
  amount?: number;
  reason?: string;
  reminder?: string;
}

export interface RiskReservationStore {
  saveReservation(reservation: RiskReservation): boolean;
  updateReservation(reservation: RiskReservation): void;
  listReservations(tableId?: string): RiskReservation[];
  getRiskState(): RiskExposureState | null;
  saveRiskState(state: RiskExposureState): void;
  transaction<T>(fn: () => T): T;
}

export interface ExecutionRiskIntent {
  intentId: string;
  tableId: string;
  shoeId: string;
  handId: string;
  market: ExecutionMarket;
  executionSource: ExecutionSource;
  amount: number;
}

function finitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${field} must be a finite positive number`);
}

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}

function holdsRiskExposure(status: RiskReservation['status']): boolean {
  return status === 'RESERVED' || status === 'UNKNOWN';
}

/**
 * 启动恢复时把"上一进程遗留的 RESERVED 敞口"升级为 UNKNOWN 的审计原因。
 * 与 `RISK_RELEASE_REASONS.restoredUnsettledExposure` 同值（contracts 是事实来源），
 * 这里重新导出保持 risk-execution 的既有导入路径可用。
 */
export const RESTORED_UNSETTLED_EXPOSURE_REASON = RISK_RELEASE_REASONS.restoredUnsettledExposure;

/**
 * 这些 UNKNOWN 只是"下注已提交、但等不到权威结算"的暂态，一旦该手的结算
 * 到达就应当自动收敛。其它 UNKNOWN（回执不匹配、窗口不对等）表示执行结果
 * 本身就不可信，不能用后来的结算去反推，必须走操作员确认流程。
 *
 * FIX(B-P1-3): 词表下沉到 contracts（`SETTLEABLE_UNKNOWN_RELEASE_REASONS`），
 * 含 `restored-unsettled-exposure`（启动恢复的上一进程敞口）与
 * `reconciled-on-startup`（无回执的跨靴 RESERVED 改判未知）：两者都代表
 * "下注早已交给桥、只是本地没等到结算"，迟到权威结算必须能自动收敛。
 * `settleHand` 现在严格按 shoeId 匹配，不会跨靴张冠李戴。
 */
function isSettleableUnknown(reason: string | undefined): boolean {
  return reason !== undefined && SETTLEABLE_UNKNOWN_RELEASE_REASONS.includes(reason);
}

/**
 * 活跃预留的**唯一性键**：同桌、同靴、同手、同市场只允许一笔下注。
 *
 * FIX(B-P1-1): 唯一性键刻意**不含 executionSource** —— 保活 / 手动 / 自动对子 /
 * one-shot 只是审计来源，不能因为来源不同就在同一手同一市场真实下两注。
 * 需要区分来源的审计查询请用 `activeReservationAuditKey()`。
 */
export function activeReservationKey(
  tableId: string,
  shoeId: string,
  handId: string,
  market: string,
): string {
  return `${tableId}:${shoeId}:${handId}:${market}`;
}

/** 审计用键：唯一键 + 执行来源，仅用于报表/排查，不参与判重。 */
export function activeReservationAuditKey(
  tableId: string,
  shoeId: string,
  handId: string,
  market: string,
  executionSource: ExecutionSource = 'strategy',
): string {
  return `${activeReservationKey(tableId, shoeId, handId, market)}:${executionSource}`;
}

export function shoeLossKey(tableId: string, shoeId: string): string {
  return `${tableId}:${shoeId}`;
}

export function emptyRiskState(asOfDate?: string): RiskExposureState {
  return {
    reservedExposure: 0,
    pendingExecutions: 0,
    executedToday: 0,
    dayLoss: 0,
    tableLosses: {},
    shoeLosses: {},
    asOfDate: asOfDate ?? new Date().toISOString().slice(0, 10),
  };
}

export class RiskManager {
  private reservations = new Map<string, RiskReservation>();
  private activeByKey = new Map<string, string>();
  private state: RiskExposureState;

  constructor(
    private readonly store?: RiskReservationStore,
    initialState?: RiskExposureState,
  ) {
    this.state = this.loadState(initialState);
  }

  private loadState(initialState?: RiskExposureState): RiskExposureState {
    const persisted = this.store?.getRiskState() ?? null;
    const state = persisted ? this.normalizeState(persisted) : (initialState ? this.normalizeState(initialState) : emptyRiskState());
    if (this.store) {
      let recomputedExposure = 0;
      let recomputedPending = 0;
      for (const r of this.store.listReservations()) {
        this.reservations.set(r.reservationId, r);
        if (holdsRiskExposure(r.status)) {
          this.activeByKey.set(
            activeReservationKey(r.tableId, r.shoeId, r.handId, r.market),
            r.reservationId,
          );
          recomputedExposure += r.maxLoss;
          recomputedPending += 1;
        }
      }
      if (state.reservedExposure !== recomputedExposure || state.pendingExecutions !== recomputedPending) {
        state.reservedExposure = recomputedExposure;
        state.pendingExecutions = recomputedPending;
        this.store.saveRiskState(state);
      }
    }
    return state;
  }

  private normalizeState(state: RiskExposureState): RiskExposureState {
    return {
      ...emptyRiskState(state.asOfDate),
      ...state,
      tableLosses: { ...(state.tableLosses ?? {}) },
      shoeLosses: { ...(state.shoeLosses ?? {}) },
    };
  }

  private rollDayIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.asOfDate !== today) {
      this.state.asOfDate = today;
      this.state.executedToday = 0;
      this.state.dayLoss = 0;
      this.persistState();
    }
  }

  getState(): RiskExposureState {
    return structuredClone(this.state);
  }

  reset(asOfDate?: string): void {
    this.reservations.clear();
    this.activeByKey.clear();
    this.state = emptyRiskState(asOfDate);
    this.persistState();
  }

  /**
   * FIX(D-P2-2): "清除监控记录"只丢弃预留（审计行由 ledger 删除），
   * **保留**当日/每桌/每靴亏损与当日成交额 —— 清记录不是清账，
   * 不能成为绕过 `perDayLossLimit` / `perTableLossLimit` / `perShoeLossLimit` 的入口。
   * 只把敞口与并发归零（对应未结算预留已不存在）。
   */
  dropReservationsKeepingAccounting(): void {
    this.reservations.clear();
    this.activeByKey.clear();
    this.state.reservedExposure = 0;
    this.state.pendingExecutions = 0;
    this.persistState();
  }

  snapshot(tableId?: string): RiskReservation[] {
    const all = [...this.reservations.values()].map(r => structuredClone(r));
    return tableId ? all.filter(r => r.tableId === tableId) : all;
  }

  hasUnknownReservations(tableId?: string): boolean {
    return this.snapshot(tableId).some(reservation => reservation.status === 'UNKNOWN');
  }

  private persistState(): void {
    if (this.store) this.store.saveRiskState(this.state);
  }


  tryReserve(intent: BetIntent, profile: TableProfile, limits: RiskLimits): ReserveResult {
    assertValidTableProfile(profile);
    return this.tryReserveExecution({
      intentId: intent.intentId,
      tableId: intent.tableId,
      shoeId: intent.shoeId,
      handId: intent.handId,
      market: intent.market,
      executionSource: 'strategy',
      amount: intent.amount,
    }, profile.limits, profile.odds[intent.market], limits);
  }

  tryReserveExecution(
    intent: ExecutionRiskIntent,
    tableLimits: TableLimits,
    odds: OddsConfig,
    limits: RiskLimits,
  ): ReserveResult {
    assertValidRiskLimits(limits);
    this.rollDayIfNeeded();
    if (!intent || typeof intent !== 'object') return { ok: false, reason: 'invalid-intent' };
    finitePositive(intent.amount, 'intent.amount');
    if (!intent.tableId || !intent.shoeId || !intent.handId) return { ok: false, reason: 'invalid-intent-keys' };

    const key = activeReservationKey(
      intent.tableId,
      intent.shoeId,
      intent.handId,
      intent.market,
    );
    if (this.activeByKey.has(key)) {
      return { ok: false, reason: 'duplicate:already-reserved' };
    }

    if (!odds) return { ok: false, reason: 'missing-odds' };
    const lossMultiplier = odds.loss;
    const netWin = odds.netWin;
    let amount = intent.amount;
    const minBet = tableLimits.minBet;
    const maxBet = tableLimits.maxBet;
    const shrink = limits.insufficientBehavior === 'shrink';
    const needs = (stake: number) => stake * lossMultiplier;
    const capAmount = (allowedLoss: number): number => {
      if (lossMultiplier <= 0) return allowedLoss;
      return Math.floor((allowedLoss / lossMultiplier) * 100) / 100;
    };

    const tableLoss = this.state.tableLosses[intent.tableId] ?? 0;
    const shoeKey = shoeLossKey(intent.tableId, intent.shoeId);
    const shoeLoss = this.state.shoeLosses[shoeKey] ?? 0;
    const reservedExposureForLimits = this.openReservedExposure();
    const pendingExecutionsForLimits = this.openReservedExecutions();

    if (limits.perTableLossLimit > 0 && tableLoss + needs(amount) > limits.perTableLossLimit) {
      if (!shrink) return { ok: false, reason: 'per-table-loss-limit', reminder: 'risk-limits-unconfigured-or-insufficient' };
      amount = Math.min(amount, capAmount(Math.max(0, limits.perTableLossLimit - tableLoss)));
    }
    if (limits.perShoeLossLimit > 0 && shoeLoss + needs(amount) > limits.perShoeLossLimit) {
      if (!shrink) return { ok: false, reason: 'per-shoe-loss-limit', reminder: 'risk-limits-unconfigured-or-insufficient' };
      amount = Math.min(amount, capAmount(Math.max(0, limits.perShoeLossLimit - shoeLoss)));
    }
    if (limits.perDayLossLimit > 0 && this.state.dayLoss + needs(amount) > limits.perDayLossLimit) {
      if (!shrink) return { ok: false, reason: 'per-day-loss-limit', reminder: 'risk-limits-unconfigured-or-insufficient' };
      amount = Math.min(amount, capAmount(Math.max(0, limits.perDayLossLimit - this.state.dayLoss)));
    }
    if (limits.defaultExposureCap > 0 && reservedExposureForLimits + needs(amount) > limits.defaultExposureCap) {
      if (!shrink) return { ok: false, reason: 'global-exposure-cap', reminder: 'risk-limits-unconfigured-or-insufficient' };
      amount = Math.min(amount, capAmount(Math.max(0, limits.defaultExposureCap - reservedExposureForLimits)));
    }
    if (limits.maxConcurrentExecutions > 0 && pendingExecutionsForLimits + 1 > limits.maxConcurrentExecutions) {
      return { ok: false, reason: 'max-concurrent-executions', reminder: 'risk-limits-unconfigured-or-insufficient' };
    }
    if (amount > maxBet) {
      if (!shrink) return { ok: false, reason: 'above-table-max' };
      amount = maxBet;
    }
    if (amount < minBet) {
      return { ok: false, reason: 'below-table-min', reminder: 'risk-limits-unconfigured-or-insufficient' };
    }
    if (amount <= 0 || !Number.isFinite(amount)) {
      return { ok: false, reason: 'amount-zero-or-negative' };
    }

    const reservation: RiskReservation = {
      reservationId: newId('rsv'),
      intentId: intent.intentId,
      tableId: intent.tableId,
      shoeId: intent.shoeId,
      handId: intent.handId,
      market: intent.market,
      executionSource: intent.executionSource,
      amount,
      maxLoss: amount * lossMultiplier,
      maxProfit: amount * netWin,
      status: 'RESERVED',
      createdAt: new Date().toISOString(),
    };

    const nextState = structuredClone(this.state);
    nextState.reservedExposure += reservation.maxLoss;
    nextState.pendingExecutions += 1;

    if (this.store) {
      try {
        this.store.transaction(() => {
          if (!this.store!.saveReservation(reservation)) {
            throw new Error(`could not persist reservation ${reservation.reservationId}`);
          }
          this.store!.saveRiskState(nextState);
        });
      } catch (error) {
        // 同键活跃预留仍存在(如重启后 placedKeys 未覆盖到的残留):降级为可观测的跳过,而非异常中断整桌事件流。
        if (error instanceof Error && error.name === 'LedgerConflictError') {
          return { ok: false, reason: 'reservation-key-conflict' };
        }
        throw error;
      }
    }
    this.reservations.set(reservation.reservationId, reservation);
    this.activeByKey.set(key, reservation.reservationId);
    this.state = nextState;
    return { ok: true, reservation, amount };
  }


  release(reservationId: string, asSettled = false, reason?: string, receiptId?: string): boolean {
    const r = this.reservations.get(reservationId);
    if (!r || r.status !== 'RESERVED') return false;
    const updated = structuredClone(r);
    updated.status = asSettled ? 'SETTLED' : 'RELEASED';
    updated.releasedAt = new Date().toISOString();
    updated.releaseReason = reason;
    if (receiptId) updated.receiptId = receiptId;
    const nextState = structuredClone(this.state);
    nextState.reservedExposure = clampNonNegative(nextState.reservedExposure - updated.maxLoss);
    nextState.pendingExecutions = clampNonNegative(nextState.pendingExecutions - 1);
    this.commitReservationUpdate(updated, nextState);
    return true;
  }

  private openReservedExposure(): number {
    let exposure = 0;
    for (const reservation of this.reservations.values()) {
      if (holdsRiskExposure(reservation.status)) exposure += reservation.maxLoss;
    }
    return exposure;
  }

  private openReservedExecutions(): number {
    let count = 0;
    for (const reservation of this.reservations.values()) {
      if (holdsRiskExposure(reservation.status)) count += 1;
    }
    return count;
  }

  markUnknown(reservationId: string, reason: string, receiptId?: string): boolean {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== 'RESERVED') return false;
    const updated = structuredClone(reservation);
    updated.status = 'UNKNOWN';
    updated.releaseReason = reason;
    if (receiptId) updated.receiptId = receiptId;
    this.commitReservationUpdate(updated, structuredClone(this.state));
    return true;
  }

  /**
   * 把"已提交（有回执）但仍未结算、且已超过 maxAgeMs"的预留升级为 UNKNOWN。
   *
   * `expireOpenForShoe` 刻意跳过有回执的预留 —— 那笔钱确实下出去了，不能当没发生。
   * 但结果是：一旦成交事件丢失，该预留会永远停在 RESERVED，静默占满
   * `reservedExposure` 与 `pendingExecutions`（进而打满全局敞口与并发额度），
   * 却没有任何可处置的状态。
   *
   * 这里不释放敞口（未知的钱仍要占额度），只把它变成显式的 UNKNOWN，
   * 让它进入既有的 unknown-execution 告警与操作员勾销流程。
   */
  escalateOverdueSettlements(
    maxAgeMs: number,
    now = Date.now(),
    reason = 'unsettled-past-timeout',
    notBefore?: number,
  ): RiskReservation[] {
    // 这里只读字段，直接遍历内部 Map —— 这个方法跑在 UI 轮询路径上（约 2 秒一次），
    // 用 snapshot() 会白白做一次全量 structuredClone。
    const overdue: RiskReservation[] = [];
    for (const reservation of this.reservations.values()) {
      if (reservation.status !== 'RESERVED') continue;
      if (reservation.receiptId === undefined) continue;
      const createdAt = Date.parse(reservation.createdAt);
      if (!Number.isFinite(createdAt) || now - createdAt < maxAgeMs) continue;
      // 启动时从账本恢复的历史敞口由专门的重恢复流程处理，不在这里升级 ——
      // 它们绝大多数早已超出任何时间阈值，一升级就会把该桌直接阻断。
      if (notBefore !== undefined && createdAt < notBefore) continue;
      overdue.push(reservation);
    }
    const escalated: RiskReservation[] = [];
    for (const reservation of overdue) {
      if (!this.markUnknown(reservation.reservationId, reason, reservation.receiptId)) continue;
      const updated = this.reservations.get(reservation.reservationId);
      if (updated) escalated.push(structuredClone(updated));
    }
    return escalated;
  }

  /**
   * 启动恢复：把上一进程遗留的**所有** RESERVED 敞口升级为 UNKNOWN。
   *
   * FIX(B-P1-3 / D-P1-1): `escalateOverdueSettlements` 用 `notBefore=runtimeStartedAt`
   * 跳过重启前的敞口、`expireOpenForShoe` 又跳过有回执的预留，结果是上一进程
   * "已提交未结算"的那笔既不会升级、也不会被清理，更不能被操作员勾销 ——
   * 永久占用 `reservedExposure` / `pendingExecutions`（全局额度黑洞）。
   *
   * 这里不再看 `createdAt` 与 `receiptId`：本进程启动时仍为 RESERVED 的预留，
   * 一律代表"上一进程留下的、结果未知的敞口"。升级为 UNKNOWN 后：
   * - 敞口继续占用（未知的钱不能当没发生）；
   * - 进入 unknown-execution 告警与操作员勾销流程；
   * - `isSettleableUnknown(RESTORED_UNSETTLED_EXPOSURE_REASON)` 为真，
   *   迟到的权威结算仍能自动收敛。
   *
   * 注意：调用点在生产 side（service.ts 启动序列），本包只负责实现与导出。
   */
  escalateRestoredExposures(reason: string = RESTORED_UNSETTLED_EXPOSURE_REASON): RiskReservation[] {
    this.rollDayIfNeeded();
    const restored: RiskReservation[] = [];
    for (const reservation of this.snapshot()) {
      if (reservation.status !== 'RESERVED') continue;
      if (!this.markUnknown(reservation.reservationId, reason, reservation.receiptId)) continue;
      const updated = this.reservations.get(reservation.reservationId);
      if (updated) restored.push(structuredClone(updated));
    }
    return restored;
  }

  settleUnknown(
    reservationId: string,
    settlement: {
      outcomes?: { bankerPair: boolean; playerPair: boolean };
      playerCards?: readonly { rank: string }[];
      bankerCards?: readonly { rank: string }[];
    },
    reason: string,
  ): RiskReservation {
    this.rollDayIfNeeded();
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== 'UNKNOWN') {
      throw new Error(`reservation ${reservationId} is not an UNKNOWN exposure`);
    }
    const realizedPnl = realizedPnlForReservation(
      reservation,
      normalizeSettlement(settlement),
    );
    if (realizedPnl === undefined) {
      throw new Error(`reservation ${reservationId} has no authoritative settlement outcome`);
    }

    const updated = structuredClone(reservation);
    updated.status = 'SETTLED';
    updated.settledAt = new Date().toISOString();
    updated.realizedPnl = realizedPnl;
    updated.releaseReason = reason;
    const nextState = structuredClone(this.state);
    nextState.reservedExposure = clampNonNegative(nextState.reservedExposure - updated.maxLoss);
    nextState.pendingExecutions = clampNonNegative(nextState.pendingExecutions - 1);
    nextState.executedToday += updated.amount;
    nextState.dayLoss -= realizedPnl;
    nextState.tableLosses[updated.tableId] = (nextState.tableLosses[updated.tableId] ?? 0) - realizedPnl;
    nextState.shoeLosses[shoeLossKey(updated.tableId, updated.shoeId)] =
      (nextState.shoeLosses[shoeLossKey(updated.tableId, updated.shoeId)] ?? 0) - realizedPnl;
    this.commitReservationUpdate(updated, nextState);
    return structuredClone(updated);
  }

  writeOffUnknown(reservationId: string, reason: string): RiskReservation {
    this.rollDayIfNeeded();
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== 'UNKNOWN') {
      throw new Error(`reservation ${reservationId} is not an UNKNOWN exposure`);
    }
    const updated = structuredClone(reservation);
    updated.status = 'RELEASED';
    updated.releasedAt = new Date().toISOString();
    updated.releaseReason = reason;
    const nextState = structuredClone(this.state);
    nextState.reservedExposure = clampNonNegative(nextState.reservedExposure - updated.maxLoss);
    nextState.pendingExecutions = clampNonNegative(nextState.pendingExecutions - 1);
    this.commitReservationUpdate(updated, nextState);
    return structuredClone(updated);
  }

  settleReservedManually(
    reservationId: string,
    realizedPnl: number,
    reason: string,
  ): RiskReservation {
    this.rollDayIfNeeded();
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== 'RESERVED') {
      throw new Error(`reservation ${reservationId} is not a RESERVED exposure`);
    }
    const allowedPnl = reservation.market === 'bankerPair' || reservation.market === 'playerPair'
      ? [reservation.maxProfit, -reservation.maxLoss]
      : [reservation.maxProfit, -reservation.maxLoss, 0];
    if (!allowedPnl.includes(realizedPnl)) {
      throw new Error(`reservation ${reservationId} has an invalid manual settlement outcome`);
    }

    const updated = structuredClone(reservation);
    updated.status = 'SETTLED';
    updated.settledAt = new Date().toISOString();
    updated.realizedPnl = realizedPnl;
    updated.releaseReason = reason;
    const nextState = structuredClone(this.state);
    nextState.reservedExposure = clampNonNegative(nextState.reservedExposure - updated.maxLoss);
    nextState.pendingExecutions = clampNonNegative(nextState.pendingExecutions - 1);
    nextState.executedToday += updated.amount;
    nextState.dayLoss -= realizedPnl;
    nextState.tableLosses[updated.tableId] = (nextState.tableLosses[updated.tableId] ?? 0) - realizedPnl;
    nextState.shoeLosses[shoeLossKey(updated.tableId, updated.shoeId)] =
      (nextState.shoeLosses[shoeLossKey(updated.tableId, updated.shoeId)] ?? 0) - realizedPnl;
    this.commitReservationUpdate(updated, nextState);
    return structuredClone(updated);
  }

  settleReleased(
    reservationId: string,
    settlement: {
      outcomes?: { bankerPair: boolean; playerPair: boolean };
      playerCards?: readonly { rank: string }[];
      bankerCards?: readonly { rank: string }[];
    },
    reason: string,
  ): RiskReservation {
    this.rollDayIfNeeded();
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== 'RELEASED') {
      throw new Error(`reservation ${reservationId} is not a RELEASED execution`);
    }
    const realizedPnl = realizedPnlForReservation(
      reservation,
      normalizeSettlement(settlement),
    );
    if (realizedPnl === undefined) {
      throw new Error(`reservation ${reservationId} has no authoritative settlement outcome`);
    }

    const updated = structuredClone(reservation);
    updated.status = 'SETTLED';
    updated.settledAt = new Date().toISOString();
    updated.realizedPnl = realizedPnl;
    updated.releaseReason = reason;
    const nextState = structuredClone(this.state);
    // RELEASED already removed pending exposure. Reconciliation only adds execution accounting.
    nextState.executedToday += updated.amount;
    nextState.dayLoss -= realizedPnl;
    nextState.tableLosses[updated.tableId] = (nextState.tableLosses[updated.tableId] ?? 0) - realizedPnl;
    nextState.shoeLosses[shoeLossKey(updated.tableId, updated.shoeId)] =
      (nextState.shoeLosses[shoeLossKey(updated.tableId, updated.shoeId)] ?? 0) - realizedPnl;
    this.commitReservationUpdate(updated, nextState);
    return structuredClone(updated);
  }


  attachReceipt(reservationId: string, receiptId: string): void {
    const r = this.reservations.get(reservationId);
    if (!r || r.status !== 'RESERVED') return;
    const updated = structuredClone(r);
    updated.receiptId = receiptId;
    if (this.store) this.store.updateReservation(updated);
    this.reservations.set(reservationId, updated);
  }

  settleHand(
    tableId: string,
    shoeId: string,
    handId: string,
    settlement: {
      outcomes?: { bankerPair: boolean; playerPair: boolean };
      playerCards?: readonly { rank: string }[];
      bankerCards?: readonly { rank: string }[];
    } | { bankerPair: boolean; playerPair: boolean } | undefined,
    _profile?: TableProfile,
  ): RiskReservation[] {
    this.rollDayIfNeeded();
    // FIX(B-P1-2): UNKNOWN 也必须校验 shoeId。跨靴同 handId 的结算（换靴后 roundId
    // 复位的平台、BG 换靴 replay 都会造出这种事件）不能拿去"确权"上一靴的未知敞口：
    // 那样会把输记成赢、把亏损记到错误靴桶，还会错误释放仍然真实的敞口。
    // 跨靴 UNKNOWN 保持 UNKNOWN，留给操作员核对。
    const matches = this.snapshot().filter(
      r => (
        r.status === 'RESERVED'
        || (r.status === 'UNKNOWN' && isSettleableUnknown(r.releaseReason))
      )
      && r.tableId === tableId
      && r.shoeId === shoeId
      && r.handId === handId,
    );
    if (matches.length === 0) return [];

    const normalizedSettlement = normalizeSettlement(settlement);
    const nextState = structuredClone(this.state);
    const settled: RiskReservation[] = [];
    for (const r of matches) {
      const updated = structuredClone(r);
      const realizedPnl = realizedPnlForReservation(r, normalizedSettlement);
      if (realizedPnl === undefined) {
        updated.status = 'UNKNOWN';
        updated.releaseReason = 'hand-settled-without-authoritative-outcome';
      } else {
        updated.status = 'SETTLED';
        updated.settledAt = new Date().toISOString();
        updated.realizedPnl = realizedPnl;
        nextState.reservedExposure = clampNonNegative(nextState.reservedExposure - updated.maxLoss);
        nextState.pendingExecutions = clampNonNegative(nextState.pendingExecutions - 1);
        nextState.executedToday += updated.amount;
        nextState.dayLoss -= updated.realizedPnl;
        nextState.tableLosses[tableId] = (nextState.tableLosses[tableId] ?? 0) - updated.realizedPnl;
        nextState.shoeLosses[shoeLossKey(updated.tableId, updated.shoeId)] =
          (nextState.shoeLosses[shoeLossKey(updated.tableId, updated.shoeId)] ?? 0) - updated.realizedPnl;
      }
      settled.push(updated);
    }

    if (this.store) {
      this.store.transaction(() => {
        for (const updated of settled) this.store!.updateReservation(updated);
        this.store!.saveRiskState(nextState);
      });
    }
    for (const updated of settled) {
      this.reservations.set(updated.reservationId, updated);
      const key = activeReservationKey(
        updated.tableId,
        updated.shoeId,
        updated.handId,
        updated.market,
      );
      if (holdsRiskExposure(updated.status)) this.activeByKey.set(key, updated.reservationId);
      else this.activeByKey.delete(key);
    }
    this.state = nextState;
    return settled;
  }


  expireOpenForShoe(tableId: string, shoeId: string, reason: string): RiskReservation[] {
    const matches = this.snapshot().filter(
      r => r.status === 'RESERVED'
        && r.tableId === tableId
        && r.shoeId === shoeId
        && r.receiptId === undefined,
    );
    if (matches.length === 0) return [];
    const nextState = structuredClone(this.state);
    const expired: RiskReservation[] = [];
    for (const r of matches) {
      const updated = structuredClone(r);
      updated.status = 'EXPIRED';
      updated.releasedAt = new Date().toISOString();
      updated.releaseReason = reason;
      nextState.reservedExposure = clampNonNegative(nextState.reservedExposure - updated.maxLoss);
      nextState.pendingExecutions = clampNonNegative(nextState.pendingExecutions - 1);
      expired.push(updated);
    }
    if (this.store) {
      this.store.transaction(() => {
        for (const updated of expired) this.store!.updateReservation(updated);
        this.store!.saveRiskState(nextState);
      });
    }
    for (const updated of expired) {
      this.reservations.set(updated.reservationId, updated);
      this.activeByKey.delete(activeReservationKey(
        updated.tableId,
        updated.shoeId,
        updated.handId,
        updated.market,
      ));
    }
    this.state = nextState;
    return expired;
  }

  /**
   * 启动对账：该桌存在"与当前投影不同靴 / 已封靴"的**未提交** RESERVED 时收口。
   *
   * FIX(B-P1-3 / D-P1-1): 修复前这里直接 `expireOpenForShoe(..., 'reconciled-on-startup')`
   * —— 把上一进程"预提交后被杀"的预留当成"没发生"释放掉。如果那笔其实已经成交，
   * 本地账本就会漏记一笔真金亏损（dayLoss/tableLosses 低计），且不留 UNKNOWN 线索。
   * 预提交后进程被杀 = 结果未知，必须进 UNKNOWN 让操作员核对，不能当没发生。
   * 因此本方法对"没有回执"的跨靴 RESERVED 不再产生 EXPIRED，改为 `markUnknown`；
   * `reconciled-on-startup` 已加入可自动收敛的 UNKNOWN reason，迟到的同靴权威结算
   * 仍能正常确权。
   *
   * 带回执的不动：它确实提交过（回执是平台证据），一律交给启动序列的
   * `escalateRestoredExposures()` 用 `restored-unsettled-exposure` 统一升级，
   * 避免这里在 TableActor 构造期就把"已确认成交"的行判成未知。
   */
  reconcileTable(tableId: string, currentShoeId: string, currentShoeSealed: boolean): void {
    const stale = this.snapshot().filter(
      r => r.status === 'RESERVED'
        && r.receiptId === undefined
        && r.tableId === tableId
        && (r.shoeId !== currentShoeId || currentShoeSealed),
    );
    for (const r of stale) {
      this.markUnknown(r.reservationId, 'reconciled-on-startup');
    }
  }

  private commitReservationUpdate(updated: RiskReservation, nextState: RiskExposureState): void {
    if (this.store) {
      this.store.transaction(() => {
        this.store!.updateReservation(updated);
        this.store!.saveRiskState(nextState);
      });
    }
    this.reservations.set(updated.reservationId, updated);
    const key = activeReservationKey(
      updated.tableId,
      updated.shoeId,
      updated.handId,
      updated.market,
    );
    if (holdsRiskExposure(updated.status)) this.activeByKey.set(key, updated.reservationId);
    else this.activeByKey.delete(key);
    this.state = nextState;
  }
}

type NormalizedSettlement = {
  readonly outcomes?: { bankerPair: boolean; playerPair: boolean };
  readonly winner?: 'banker' | 'player' | 'tie';
};

function normalizeSettlement(
  settlement: {
    outcomes?: { bankerPair: boolean; playerPair: boolean };
    playerCards?: readonly { rank: string }[];
    bankerCards?: readonly { rank: string }[];
  } | { bankerPair: boolean; playerPair: boolean } | undefined,
): NormalizedSettlement {
  if (settlement === undefined) return {};
  if ('bankerPair' in settlement && 'playerPair' in settlement) {
    return { outcomes: settlement };
  }
  return {
    ...(settlement.outcomes === undefined ? {} : { outcomes: settlement.outcomes }),
    ...(
      settlement.playerCards === undefined || settlement.bankerCards === undefined
        ? {}
        : { winner: baccaratWinner(settlement.playerCards, settlement.bankerCards) }
    ),
  };
}

function realizedPnlForReservation(
  reservation: RiskReservation,
  settlement: NormalizedSettlement,
): number | undefined {
  if (reservation.market === 'bankerPair' || reservation.market === 'playerPair') {
    const won = settlement.outcomes?.[reservation.market];
    return won === undefined ? undefined : won ? reservation.maxProfit : -reservation.maxLoss;
  }
  if (settlement.winner === undefined) return undefined;
  if (settlement.winner === 'tie') return 0;
  return settlement.winner === reservation.market ? reservation.maxProfit : -reservation.maxLoss;
}

function baccaratWinner(
  playerCards: readonly { rank: string }[],
  bankerCards: readonly { rank: string }[],
): 'banker' | 'player' | 'tie' {
  const player = baccaratScore(playerCards);
  const banker = baccaratScore(bankerCards);
  if (player === banker) return 'tie';
  return banker > player ? 'banker' : 'player';
}

function baccaratScore(cards: readonly { rank: string }[]): number {
  return cards.reduce((sum, card) => sum + baccaratCardValue(card.rank), 0) % 10;
}

function baccaratCardValue(rank: string): number {
  if (rank === 'A') return 1;
  if (rank === '10' || rank === 'J' || rank === 'Q' || rank === 'K') return 0;
  const value = Number(rank);
  return Number.isInteger(value) && value >= 2 && value <= 9 ? value : 0;
}
