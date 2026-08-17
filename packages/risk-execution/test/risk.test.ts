import { describe, expect, it } from 'vitest';
import { SqliteLedger } from '@baccarat/ledger-state';
import { RiskManager, emptyRiskState } from '../src/index.js';
import type { BetIntent, BettingMarket, RiskExposureState, RiskLimits, TableProfile } from '@baccarat/contracts';
import { defaultProfile, defaultRiskLimits, newId } from '@baccarat/contracts';

const profile: TableProfile = { ...defaultProfile('t1'), limits: { minBet: 10, maxBet: 100 } };
const limits: RiskLimits = {
  ...defaultRiskLimits,
  defaultExposureCap: 1000,
  perTableLossLimit: 500,
  perShoeLossLimit: 200,
  perDayLossLimit: 10000,
  maxConcurrentExecutions: 2,
  insufficientBehavior: 'skip',
};

function intent(shoe = 's1', hand = 'h1', market: BettingMarket = 'bankerPair', amount = 10, table = 't1'): BetIntent {
  return {
    intentId: newId('int'),
    tableId: table,
    shoeId: shoe,
    handId: hand,
    market,
    amount,
    mode: 'simulated',
    idempotencyKey: `${table}:${shoe}:${hand}:${market}:v1`,
    strategy: { type: 'both' },
    decisionSnapshotId: 'd1',
    createdAt: new Date().toISOString(),
  };
}

describe('risk manager', () => {
  it('reserves and releases atomically against internal state', () => {
    const m = new RiskManager();
    const r = m.tryReserve(intent(), profile, limits);
    expect(r.ok).toBe(true);
    expect(m.getState().reservedExposure).toBe(10);
    expect(m.getState().pendingExecutions).toBe(1);
    expect(m.release(r.reservation!.reservationId, true)).toBe(true);
    expect(m.getState().reservedExposure).toBe(0);
    expect(m.getState().pendingExecutions).toBe(0);
    expect(m.snapshot()[0]?.status).toBe('SETTLED');
  });

  it('rejects duplicate same table+shoe+hand+market', () => {
    const m = new RiskManager();
    const r1 = m.tryReserve(intent(), profile, limits);
    const r2 = m.tryReserve(intent(), profile, limits);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('duplicate');
  });

  it('allows same shoe+hand+market on different tables (table-scoped uniqueness)', () => {
    const m = new RiskManager();
    const t1 = m.tryReserve(intent(), profile, limits);
    const t2 = m.tryReserve(intent('s1', 'h1', 'bankerPair', 10, 't2'), { ...profile, tableId: 't2' }, limits);
    expect(t1.ok).toBe(true);
    expect(t2.ok).toBe(true);
  });

  it('can reserve same market next hand after release', () => {
    const m = new RiskManager();
    const r1 = m.tryReserve(intent(), profile, limits);
    expect(m.release(r1.reservation!.reservationId, true)).toBe(true);
    const r2 = m.tryReserve(intent('s1', 'h2'), profile, limits);
    expect(r2.ok).toBe(true);
  });

  it('skips when exposure cap insufficient and policy is skip', () => {
    const m = new RiskManager();
    const capLimits = { ...limits, defaultExposureCap: 5 };
    const r = m.tryReserve(intent('s1', 'h1', 'bankerPair', 10), profile, capLimits);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('global-exposure-cap');
  });

  it('shrinks when policy is shrink, but skips below table min', () => {
    const m = new RiskManager();
    const capLimits = { ...limits, defaultExposureCap: 15, insufficientBehavior: 'shrink' as const };
    const r = m.tryReserve(intent('s1', 'h1', 'bankerPair', 100), profile, capLimits);
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(15);
    expect(m.getState().reservedExposure).toBe(15);

    const m2 = new RiskManager();
    const capLimits2 = { ...limits, defaultExposureCap: 5, insufficientBehavior: 'shrink' as const };
    const r2 = m2.tryReserve(intent('s9', 'h9', 'bankerPair', 100), profile, capLimits2);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('below-table-min');
  });

  it('settles a winning and losing hand and updates day/table/shoe loss', () => {
    const m = new RiskManager();
    const w = m.tryReserve(intent('s1', 'h1', 'bankerPair', 10), profile, limits);
    const l = m.tryReserve(intent('s1', 'h1', 'playerPair', 10), profile, limits);
    expect(w.ok && l.ok).toBe(true);

    const settled = m.settleHand('t1', 's1', 'h1', { bankerPair: true, playerPair: false }, profile);
    expect(settled).toHaveLength(2);
    expect(settled.find(r => r.market === 'bankerPair')?.realizedPnl).toBeCloseTo(110, 6);
    expect(settled.find(r => r.market === 'playerPair')?.realizedPnl).toBeCloseTo(-10, 6);

    const state = m.getState();
    expect(state.reservedExposure).toBe(0);
    expect(state.pendingExecutions).toBe(0);
    expect(state.executedToday).toBe(20);
    expect(state.dayLoss).toBeCloseTo(-100, 6);
    expect(state.tableLosses['t1']).toBeCloseTo(-100, 6);
    expect(state.shoeLosses['t1:s1']).toBeCloseTo(-100, 6);
  });

  it('marks unknown outcome and releases exposure instead of inventing a result', () => {
    const m = new RiskManager();
    const r = m.tryReserve(intent(), profile, limits);
    expect(r.ok).toBe(true);
    const settled = m.settleHand('t1', 's1', 'h1', undefined, profile);
    expect(settled[0]?.status).toBe('UNKNOWN');
    expect(m.getState().reservedExposure).toBe(0);
    expect(m.getState().pendingExecutions).toBe(0);
  });

  it('expires reservations when a shoe is replaced', () => {
    const m = new RiskManager();
    const r = m.tryReserve(intent('s1', 'h1'), profile, limits);
    expect(r.ok).toBe(true);
    const expired = m.expireOpenForShoe('t1', 's1', 'new-shoe-signal');
    expect(expired).toHaveLength(1);
    expect(expired[0]?.status).toBe('EXPIRED');
    expect(m.getState().reservedExposure).toBe(0);
    expect(m.getState().pendingExecutions).toBe(0);
  });

  it('persists reservations and risk state through restart', () => {
    const ledger = new SqliteLedger();
    const m1 = new RiskManager(ledger);
    const r = m1.tryReserve(intent(), profile, limits);
    expect(r.ok).toBe(true);

    const m2 = new RiskManager(ledger);
    expect(m2.getState().reservedExposure).toBe(10);
    expect(m2.getState().pendingExecutions).toBe(1);
    expect(m2.snapshot()).toHaveLength(1);

    expect(m2.release(r.reservation!.reservationId, true)).toBe(true);
    const m3 = new RiskManager(ledger);
    expect(m3.getState().reservedExposure).toBe(0);
    expect(m3.getState().pendingExecutions).toBe(0);
    expect(m3.snapshot()[0]?.status).toBe('SETTLED');
    ledger.close();
  });

  it('rolls daily counters when persisted state is from a previous UTC day', () => {
    const oldState = {
      ...emptyRiskState('2000-01-01'),
      reservedExposure: 0,
      pendingExecutions: 0,
      executedToday: 12345,
      dayLoss: 678,
    };
    const m = new RiskManager(undefined, oldState);
    m.tryReserve(intent(), profile, limits);
    const state = m.getState();
    expect(state.asOfDate).toBe(new Date().toISOString().slice(0, 10));
    expect(state.executedToday).toBe(0);
    expect(state.dayLoss).toBe(0);
    expect(state.reservedExposure).toBe(10);
  });

  it('normalizes legacy state without crashing', () => {
    const m = new RiskManager(undefined, { reservedExposure: 0, pendingExecutions: 0, executedToday: 0, dayLoss: 0 } as unknown as RiskExposureState);
    expect(m.getState().tableLosses).toEqual({});
    expect(m.getState().shoeLosses).toEqual({});
    expect(emptyRiskState().dayLoss).toBe(0);
  });
});
