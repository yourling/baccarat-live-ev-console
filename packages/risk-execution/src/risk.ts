import {
  assertValidRiskLimits,
  assertValidTableProfile,
  type BetIntent,
  type RiskExposureState,
  type RiskLimits,
  type RiskReservation,
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

function finitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${field} must be a finite positive number`);
}

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}

export function activeReservationKey(tableId: string, shoeId: string, handId: string, market: string): string {
  return `${tableId}:${shoeId}:${handId}:${market}`;
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
        if (r.status === 'RESERVED') {
          this.activeByKey.set(activeReservationKey(r.tableId, r.shoeId, r.handId, r.market), r.reservationId);
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

  snapshot(tableId?: string): RiskReservation[] {
    const all = [...this.reservations.values()].map(r => structuredClone(r));
    return tableId ? all.filter(r => r.tableId === tableId) : all;
  }

  private persistState(): void {
    if (this.store) this.store.saveRiskState(this.state);
  }


  tryReserve(intent: BetIntent, profile: TableProfile, limits: RiskLimits): ReserveResult {
    assertValidTableProfile(profile);
    assertValidRiskLimits(limits);
    this.rollDayIfNeeded();
    if (!intent || typeof intent !== 'object') return { ok: false, reason: 'invalid-intent' };
    finitePositive(intent.amount, 'intent.amount');
    if (!intent.tableId || !intent.shoeId || !intent.handId) return { ok: false, reason: 'invalid-intent-keys' };

    const key = activeReservationKey(intent.tableId, intent.shoeId, intent.handId, intent.market);
    if (this.activeByKey.has(key)) {
      return { ok: false, reason: 'duplicate:already-reserved' };
    }

    const odds = profile.odds[intent.market];
    if (!odds) return { ok: false, reason: 'missing-odds' };
    const lossMultiplier = odds.loss;
    const netWin = odds.netWin;
    let amount = intent.amount;
    const minBet = profile.limits.minBet;
    const maxBet = profile.limits.maxBet;
    const shrink = limits.insufficientBehavior === 'shrink';
    const needs = (stake: number) => stake * lossMultiplier;
    const capAmount = (allowedLoss: number): number => {
      if (lossMultiplier <= 0) return allowedLoss;
      return Math.floor((allowedLoss / lossMultiplier) * 100) / 100;
    };

    const tableLoss = this.state.tableLosses[intent.tableId] ?? 0;
    const shoeKey = shoeLossKey(intent.tableId, intent.shoeId);
    const shoeLoss = this.state.shoeLosses[shoeKey] ?? 0;

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
    if (limits.defaultExposureCap > 0 && this.state.reservedExposure + needs(amount) > limits.defaultExposureCap) {
      if (!shrink) return { ok: false, reason: 'global-exposure-cap', reminder: 'risk-limits-unconfigured-or-insufficient' };
      amount = Math.min(amount, capAmount(Math.max(0, limits.defaultExposureCap - this.state.reservedExposure)));
    }
    if (limits.maxConcurrentExecutions > 0 && this.state.pendingExecutions + 1 > limits.maxConcurrentExecutions) {
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
      this.store.transaction(() => {
        if (!this.store!.saveReservation(reservation)) {
          throw new Error(`could not persist reservation ${reservation.reservationId}`);
        }
        this.store!.saveRiskState(nextState);
      });
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
    outcomes: { bankerPair: boolean; playerPair: boolean } | undefined,
    profile: TableProfile,
  ): RiskReservation[] {
    this.rollDayIfNeeded();
    const matches = this.snapshot().filter(
      r => r.status === 'RESERVED' && r.tableId === tableId && r.shoeId === shoeId && r.handId === handId,
    );
    if (matches.length === 0) return [];

    const nextState = structuredClone(this.state);
    const settled: RiskReservation[] = [];
    for (const r of matches) {
      const updated = structuredClone(r);
      const won = outcomes?.[r.market];
      if (won === undefined) {
        updated.status = 'UNKNOWN';
        updated.releaseReason = 'hand-settled-without-outcome';
      } else {
        updated.status = 'SETTLED';
        updated.settledAt = new Date().toISOString();
        updated.realizedPnl = won
          ? updated.amount * profile.odds[r.market].netWin
          : -updated.amount * profile.odds[r.market].loss;
      }
      nextState.reservedExposure = clampNonNegative(nextState.reservedExposure - updated.maxLoss);
      nextState.pendingExecutions = clampNonNegative(nextState.pendingExecutions - 1);
      nextState.executedToday += updated.amount;
      if (updated.realizedPnl !== undefined) {
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
      this.activeByKey.delete(activeReservationKey(updated.tableId, updated.shoeId, updated.handId, updated.market));
    }
    this.state = nextState;
    return settled;
  }


  expireOpenForShoe(tableId: string, shoeId: string, reason: string): RiskReservation[] {
    const matches = this.snapshot().filter(
      r => r.status === 'RESERVED' && r.tableId === tableId && r.shoeId === shoeId,
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
      this.activeByKey.delete(activeReservationKey(updated.tableId, updated.shoeId, updated.handId, updated.market));
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
    this.activeByKey.delete(activeReservationKey(updated.tableId, updated.shoeId, updated.handId, updated.market));
    this.state = nextState;
  }
}
