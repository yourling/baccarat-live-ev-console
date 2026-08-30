import {
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

export function activeReservationKey(
  tableId: string,
  shoeId: string,
  handId: string,
  market: string,
  executionSource: ExecutionSource = 'strategy',
): string {
  return `${tableId}:${shoeId}:${handId}:${market}:${executionSource}`;
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
            activeReservationKey(r.tableId, r.shoeId, r.handId, r.market, r.executionSource),
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
      intent.executionSource,
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
      if (reservation.status === 'RESERVED') exposure += reservation.maxLoss;
    }
    return exposure;
  }

  private openReservedExecutions(): number {
    let count = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.status === 'RESERVED') count += 1;
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
    const matches = this.snapshot().filter(
      r => (
        r.status === 'RESERVED'
        || (
          r.status === 'UNKNOWN'
          && r.releaseReason === 'hand-settled-without-authoritative-outcome'
        )
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
        nextState.shoeLosses[shoeLossKey(tableId, shoeId)] = (nextState.shoeLosses[shoeLossKey(tableId, shoeId)] ?? 0) - updated.realizedPnl;
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
        updated.executionSource,
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
        updated.executionSource,
      ));
    }
    this.state = nextState;
    return expired;
  }

  reconcileTable(tableId: string, currentShoeId: string, currentShoeSealed: boolean): void {
    const stale = this.snapshot().filter(
      r => r.status === 'RESERVED' && r.tableId === tableId && (r.shoeId !== currentShoeId || currentShoeSealed),
    );
    for (const r of stale) {
      this.expireOpenForShoe(tableId, r.shoeId, 'reconciled-on-startup');
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
      updated.executionSource,
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
