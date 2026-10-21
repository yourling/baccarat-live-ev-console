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
  it('default risk limits allow both pair markets on one hand', () => {
    const m = new RiskManager();
    const first = m.tryReserve(intent('s-default', 'h-default', 'bankerPair'), profile, {
      ...defaultRiskLimits,
      defaultExposureCap: 1000,
      perTableLossLimit: 1000,
      perShoeLossLimit: 1000,
      perDayLossLimit: 1000,
    });
    const second = m.tryReserve(intent('s-default', 'h-default', 'playerPair'), profile, {
      ...defaultRiskLimits,
      defaultExposureCap: 1000,
      perTableLossLimit: 1000,
      perShoeLossLimit: 1000,
      perDayLossLimit: 1000,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
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

  it('UNKNOWN does consume exposure/concurrency', () => {
    const m = new RiskManager();
    const tightLimits = { ...limits, defaultExposureCap: 10, maxConcurrentExecutions: 1 };
    const first = m.tryReserve(intent('s1', 'h1', 'bankerPair', 10), profile, tightLimits);
    expect(first.ok).toBe(true);
    expect(m.markUnknown(first.reservation!.reservationId, 'platform-acknowledgement-unknown')).toBe(true);

    const duplicate = m.tryReserve(intent('s1', 'h1', 'bankerPair', 10), profile, tightLimits);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.reason).toContain('duplicate');

    const nextHand = m.tryReserve(intent('s1', 'h2', 'bankerPair', 10), profile, tightLimits);
    expect(nextHand.ok).toBe(false);
    expect(nextHand.reason).toMatch(/max-concurrent-executions|global-exposure-cap/);
  });

  it('writes off UNKNOWN without inventing pnl and frees exposure', () => {
    const m = new RiskManager();
    const reserved = m.tryReserve(intent('s1', 'h1', 'bankerPair', 10), profile, limits);
    expect(reserved.ok).toBe(true);
    expect(m.markUnknown(reserved.reservation!.reservationId, 'committed-rejection-uncertain')).toBe(true);
    expect(m.getState()).toMatchObject({ reservedExposure: 10, pendingExecutions: 1 });

    const writtenOff = m.writeOffUnknown(reserved.reservation!.reservationId, 'operator-unconfirmed-write-off');
    expect(writtenOff).toEqual(expect.objectContaining({
      status: 'RELEASED',
      releaseReason: 'operator-unconfirmed-write-off',
    }));
    expect(writtenOff.realizedPnl).toBeUndefined();
    expect(m.getState()).toMatchObject({
      reservedExposure: 0,
      pendingExecutions: 0,
      executedToday: 0,
      dayLoss: 0,
    });
    expect(m.hasUnknownReservations()).toBe(false);
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

  it('settles banker/player reservations from cards using explicit payout terms', () => {
    const bankerManager = new RiskManager();
    const banker = bankerManager.tryReserveExecution({
      intentId: 'banker-live',
      tableId: 't1',
      shoeId: 's-main',
      handId: 'h-banker',
      market: 'banker',
      executionSource: 'keepalive',
      amount: 20,
    }, profile.limits, { netWin: 0.95, loss: 1 }, limits);
    expect(banker.ok).toBe(true);

    const bankerSettled = bankerManager.settleHand('t1', 's-main', 'h-banker', {
      playerCards: [{ rank: '2' }, { rank: '3' }],
      bankerCards: [{ rank: '4' }, { rank: '3' }],
    });
    expect(bankerSettled[0]).toEqual(expect.objectContaining({
      market: 'banker',
      status: 'SETTLED',
      realizedPnl: 19,
    }));

    const playerManager = new RiskManager();
    const player = playerManager.tryReserveExecution({
      intentId: 'player-live',
      tableId: 't1',
      shoeId: 's-main',
      handId: 'h-tie',
      market: 'player',
      executionSource: 'manual',
      amount: 20,
    }, profile.limits, { netWin: 1, loss: 1 }, limits);
    expect(player.ok).toBe(true);
    const tieSettled = playerManager.settleHand('t1', 's-main', 'h-tie', {
      playerCards: [{ rank: '4' }, { rank: '3' }],
      bankerCards: [{ rank: '2' }, { rank: '5' }],
    });
    expect(tieSettled[0]).toEqual(expect.objectContaining({
      market: 'player',
      status: 'SETTLED',
      realizedPnl: 0,
    }));
  });

  it('settles a committed UNKNOWN banker exposure from authoritative cards', () => {
    const manager = new RiskManager();
    const reserved = manager.tryReserveExecution({
      intentId: 'unknown-banker-live',
      tableId: 'D066',
      shoeId: 'shoe-11',
      handId: 'hand-268280',
      market: 'banker',
      executionSource: 'manual',
      amount: 20,
    }, profile.limits, { netWin: 0.95, loss: 1 }, limits);
    expect(reserved.reservation).toBeDefined();
    manager.markUnknown(reserved.reservation!.reservationId, 'result-timeout', 'receipt-unknown');

    const settled = manager.settleUnknown(reserved.reservation!.reservationId, {
      playerCards: [{ rank: '5' }, { rank: 'A' }],
      bankerCards: [{ rank: '9' }, { rank: '9' }],
    }, 'operator-confirmed-platform-accepted');

    expect(settled).toEqual(expect.objectContaining({
      status: 'SETTLED',
      realizedPnl: 19,
      releaseReason: 'operator-confirmed-platform-accepted',
    }));
    expect(manager.getState()).toEqual(expect.objectContaining({
      reservedExposure: 0,
      pendingExecutions: 0,
      executedToday: 20,
      dayLoss: -19,
    }));
  });

  it('reconciles a released platform rejection as executed without releasing exposure twice', () => {
    const manager = new RiskManager();
    const reserved = manager.tryReserveExecution({
      intentId: 'misclassified-rejection',
      tableId: 'D066',
      shoeId: 'shoe-11',
      handId: 'hand-26828174',
      market: 'player',
      executionSource: 'keepalive',
      amount: 20,
    }, profile.limits, { netWin: 1, loss: 1 }, limits);
    expect(reserved.reservation).toBeDefined();
    expect(manager.release(
      reserved.reservation!.reservationId,
      false,
      'receipt-rejected',
      'receipt-misclassified',
    )).toBe(true);
    expect(manager.getState()).toMatchObject({ reservedExposure: 0, pendingExecutions: 0 });

    const settled = manager.settleReleased(reserved.reservation!.reservationId, {
      playerCards: [{ rank: '4' }, { rank: '4' }],
      bankerCards: [{ rank: '2' }, { rank: '3' }],
    }, 'operator-confirmed-platform-accepted');

    expect(settled).toEqual(expect.objectContaining({
      status: 'SETTLED',
      realizedPnl: 20,
      releaseReason: 'operator-confirmed-platform-accepted',
      receiptId: 'receipt-misclassified',
    }));
    expect(manager.getState()).toEqual(expect.objectContaining({
      reservedExposure: 0,
      pendingExecutions: 0,
      executedToday: 20,
      dayLoss: -20,
    }));
  });

  it('does not let execution source bypass operational reservation idempotency', () => {
    // FIX(B-P1-1) 回归：修复前唯一性键带 executionSource，于是保活 + 手动可以在
    // 同一手同一市场各下一注（review/scripts/risk/a5-duplicate-source.ts 实证）。
    // source 只是审计字段，不参与唯一性。
    const m = new RiskManager();
    const reserve = (executionSource: 'manual' | 'keepalive') => m.tryReserveExecution({
      intentId: newId('opw'),
      tableId: 't1',
      shoeId: 's-source',
      handId: 'h-source',
      market: 'banker',
      executionSource,
      amount: 10,
    }, profile.limits, { netWin: 0.95, loss: 1 }, limits);

    expect(reserve('manual').ok).toBe(true);
    expect(reserve('manual').reason).toBe('duplicate:already-reserved');
    // 修复前这里 ok=true（跨来源双下）。
    expect(reserve('keepalive')).toEqual(expect.objectContaining({
      ok: false,
      reason: 'duplicate:already-reserved',
    }));
    // 不同市场仍然各自可下（不能过度收紧）。
    expect(m.tryReserveExecution({
      intentId: newId('opw'),
      tableId: 't1',
      shoeId: 's-source',
      handId: 'h-source',
      market: 'playerPair',
      executionSource: 'manual',
      amount: 10,
    }, profile.limits, { netWin: 11, loss: 1 }, limits).ok).toBe(true);
    // 结算上一手后，下一手可以正常下注（不会过度收紧到跨手阻塞）。
    m.settleHand('t1', 's-source', 'h-source', {
      outcomes: { bankerPair: false, playerPair: false },
      playerCards: [{ rank: '5' }, { rank: '2' }],
      bankerCards: [{ rank: '9' }, { rank: '7' }],
    }, profile);
    expect(m.getState().pendingExecutions).toBe(0);
    expect(m.tryReserveExecution({
      intentId: newId('opw'),
      tableId: 't1',
      shoeId: 's-source',
      handId: 'h-next',
      market: 'banker',
      executionSource: 'keepalive',
      amount: 10,
    }, profile.limits, { netWin: 0.95, loss: 1 }, limits).ok).toBe(true);
  });

  it('keeps an ambiguous acknowledgement active even after the hand settles', () => {
    const m = new RiskManager();
    const r = m.tryReserve(intent(), profile, limits);
    expect(r.ok).toBe(true);
    expect(m.markUnknown(r.reservation!.reservationId, 'platform-acknowledgement-unknown', 'receipt-unknown')).toBe(true);

    expect(m.snapshot()[0]?.status).toBe('UNKNOWN');
    expect(m.getState().reservedExposure).toBe(10);
    expect(m.getState().pendingExecutions).toBe(1);
    expect(m.tryReserve(intent(), profile, limits).reason).toBe('duplicate:already-reserved');

    const settled = m.settleHand('t1', 's1', 'h1', { bankerPair: false, playerPair: false }, profile);
    expect(settled).toEqual([]);
    expect(m.snapshot()[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      receiptId: 'receipt-unknown',
    }));
    expect(m.snapshot()[0]?.realizedPnl).toBeUndefined();
    expect(m.getState().reservedExposure).toBe(10);
    expect(m.getState().pendingExecutions).toBe(1);
    expect(m.tryReserve(intent(), profile, limits).reason).toBe('duplicate:already-reserved');
  });

  it('persists an ambiguous platform acknowledgement as active exposure through restart', () => {
    // Given: a live execution was submitted but the platform acknowledgement is ambiguous.
    const ledger = new SqliteLedger();
    const firstManager = new RiskManager(ledger);
    const reserved = firstManager.tryReserve(intent(), profile, limits);
    expect(reserved.ok).toBe(true);

    // When: the executor reports an unknown acknowledgement and the process restarts.
    expect(firstManager.markUnknown(
      reserved.reservation!.reservationId,
      'platform-acknowledgement-unknown',
      'receipt-unknown',
    )).toBe(true);
    const restartedManager = new RiskManager(ledger);

    // Then: the audit row, exposure, pending count, and active identity all survive.
    expect(restartedManager.snapshot()[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      receiptId: 'receipt-unknown',
      releaseReason: 'platform-acknowledgement-unknown',
    }));
    expect(restartedManager.getState().reservedExposure).toBe(10);
    expect(restartedManager.getState().pendingExecutions).toBe(1);
    expect(restartedManager.tryReserve(intent(), profile, limits).reason).toBe('duplicate:already-reserved');
    ledger.close();
  });

  it('settles a pair reservation after cards-only settlement left it unknown', () => {
    const m = new RiskManager();
    const reserved = m.tryReserve(intent(), profile, limits);
    expect(reserved.ok).toBe(true);
    const first = m.settleHand('t1', 's1', 'h1', {
      playerCards: [{ rank: '4' }, { rank: '4' }],
      bankerCards: [{ rank: '8' }, { rank: '6' }],
    });
    expect(first[0]?.status).toBe('UNKNOWN');
    expect(first[0]?.releaseReason).toBe('hand-settled-without-authoritative-outcome');

    const second = m.settleHand('t1', 's1', 'h1', {
      outcomes: { bankerPair: false, playerPair: true },
      playerCards: [{ rank: '4' }, { rank: '4' }],
      bankerCards: [{ rank: '8' }, { rank: '6' }],
    });
    expect(second[0]).toMatchObject({ status: 'SETTLED', realizedPnl: -10 });
    expect(m.getState()).toMatchObject({
      reservedExposure: 0,
      pendingExecutions: 0,
      executedToday: 10,
    });
  });

  it('does not invent pnl for an ambiguous hand settlement', () => {
    const m = new RiskManager();
    const reserved = m.tryReserve(intent(), profile, limits);
    expect(reserved.ok).toBe(true);

    // When: the hand settles without an authoritative outcome.
    const changed = m.settleHand('t1', 's1', 'h1', undefined, profile);

    // Then: the reservation remains UNKNOWN and the counters stay reserved.
    expect(changed[0]?.status).toBe('UNKNOWN');
    expect(changed[0]?.realizedPnl).toBeUndefined();
    expect(m.getState().reservedExposure).toBe(10);
    expect(m.getState().pendingExecutions).toBe(1);
    expect(m.tryReserve(intent(), profile, limits).reason).toBe('duplicate:already-reserved');
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

  it('escalates an accepted but long-unsettled reservation to UNKNOWN instead of leaving it RESERVED forever', () => {
    const m = new RiskManager();
    const reserved = m.tryReserve(intent('s1', 'h1'), profile, limits);
    expect(reserved.ok).toBe(true);
    m.attachReceipt(reserved.reservation!.reservationId, 'accepted-receipt');
    const createdAt = Date.parse(reserved.reservation!.createdAt);

    // 未到阈值：保持 RESERVED，正常结算仍有时间到达。
    expect(m.escalateOverdueSettlements(10 * 60_000, createdAt + 60_000)).toEqual([]);
    expect(m.snapshot()[0]?.status).toBe('RESERVED');

    // 超过阈值：升级为 UNKNOWN，但敞口继续占用 —— 未知的钱不能当成没发生。
    const escalated = m.escalateOverdueSettlements(10 * 60_000, createdAt + 11 * 60_000);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({
      status: 'UNKNOWN',
      receiptId: 'accepted-receipt',
      releaseReason: 'unsettled-past-timeout',
    });
    expect(m.getState()).toMatchObject({ reservedExposure: 10, pendingExecutions: 1 });

    // 幂等：已经升级过的不会再升级一次。
    expect(m.escalateOverdueSettlements(10 * 60_000, createdAt + 20 * 60_000)).toEqual([]);
  });

  it('does not escalate uncommitted reservations, which shoe rollover already expires', () => {
    const m = new RiskManager();
    const reserved = m.tryReserve(intent('s1', 'h1'), profile, limits);
    expect(reserved.ok).toBe(true);
    const createdAt = Date.parse(reserved.reservation!.createdAt);

    expect(m.escalateOverdueSettlements(0, createdAt + 1000)).toEqual([]);
    expect(m.snapshot()[0]?.status).toBe('RESERVED');
  });

  it('settles an escalated reservation once the authoritative hand settlement finally arrives', () => {
    const m = new RiskManager();
    const reserved = m.tryReserve(intent('s1', 'h1'), profile, limits);
    expect(reserved.ok).toBe(true);
    m.attachReceipt(reserved.reservation!.reservationId, 'accepted-receipt');
    const createdAt = Date.parse(reserved.reservation!.createdAt);

    const escalated = m.escalateOverdueSettlements(10 * 60_000, createdAt + 11 * 60_000);
    expect(escalated[0]).toMatchObject({ status: 'UNKNOWN', releaseReason: 'unsettled-past-timeout' });

    // 迟到的权威结算必须能自动把它收敛掉，而不是永远卡在 UNKNOWN 等人工勾销。
    const settled = m.settleHand('t1', 's1', 'h1', {
      bankerPair: true,
      playerPair: false,
    });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ status: 'SETTLED' });
    expect(settled[0]?.realizedPnl).toBe(settled[0]?.maxProfit);
    expect(m.getState()).toMatchObject({ reservedExposure: 0, pendingExecutions: 0 });
    expect(m.hasUnknownReservations('t1')).toBe(false);
  });

  it('converges both settleable UNKNOWN reasons from a late authoritative settlement', () => {
    // FIX(B-P1-2/B-P1-3) 回归：`unsettled-past-timeout` 与
    // `restored-unsettled-exposure` 两个可收敛 reason 都必须被同靴迟到结算收敛。
    for (const reason of ['unsettled-past-timeout', 'restored-unsettled-exposure'] as const) {
      const m = new RiskManager();
      const reserved = m.tryReserve(intent('s1', 'h1'), profile, limits);
      expect(reserved.ok).toBe(true);
      m.markUnknown(reserved.reservation!.reservationId, reason, 'receipt-x');
      const settled = m.settleHand('t1', 's1', 'h1', {
        bankerPair: false,
        playerPair: false,
      });
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ status: 'SETTLED', releaseReason: reason });
      expect(m.getState()).toMatchObject({ reservedExposure: 0, pendingExecutions: 0 });
    }
  });

  it('never settles an UNKNOWN from a different shoe even when handId matches', () => {
    // FIX(B-P1-2) 回归：修复前 UNKNOWN 分支 `r.shoeId === shoeId || r.status === 'UNKNOWN'`
    // 让换靴后同 handId 的结算清掉上一靴的未知敞口（review a6b 实证 realizedPnl 记错靴）。
    const m = new RiskManager();
    const reserved = m.tryReserve(intent('shoe-old', 'h1'), profile, limits);
    expect(reserved.ok).toBe(true);
    m.markUnknown(reserved.reservation!.reservationId, 'unsettled-past-timeout', 'receipt-old');

    const settled = m.settleHand('t1', 'shoe-new', 'h1', {
      bankerPair: true,
      playerPair: false,
    });
    expect(settled).toEqual([]);
    expect(m.snapshot()[0]).toMatchObject({
      status: 'UNKNOWN',
      shoeId: 'shoe-old',
    });
    expect(m.snapshot()[0]?.realizedPnl).toBeUndefined();
    // 亏损没有记到新靴桶。
    expect(m.getState().shoeLosses['t1:shoe-new']).toBeUndefined();
    expect(m.getState()).toMatchObject({ reservedExposure: 10, pendingExecutions: 1 });
  });

  it('escalates every restored RESERVED exposure regardless of age or receipt', () => {
    // FIX(B-P1-3) 回归：修复前 notBefore=runtimeStartedAt + "必须有 receiptId"
    // 让上一进程的敞口永远停在 RESERVED，既不能升级也不能勾销。
    const m = new RiskManager();
    const withReceipt = m.tryReserve(intent('s1', 'h1'), profile, limits);
    const withoutReceipt = m.tryReserve(intent('s1', 'h2'), profile, limits);
    expect(withReceipt.ok && withoutReceipt.ok).toBe(true);
    m.attachReceipt(withReceipt.reservation!.reservationId, 'receipt-old');

    const escalated = m.escalateRestoredExposures();
    expect(escalated).toHaveLength(2);
    expect(escalated.every(reservation => (
      reservation.status === 'UNKNOWN'
      && reservation.releaseReason === 'restored-unsettled-exposure'
    ))).toBe(true);
    // 敞口继续占用（未知的钱不能当没发生）。
    expect(m.getState()).toMatchObject({ reservedExposure: 20, pendingExecutions: 2 });
    // 操作员可以勾销（修复前抛 "is not an UNKNOWN exposure"）。
    expect(m.writeOffUnknown(withoutReceipt.reservation!.reservationId, 'operator-unconfirmed-write-off'))
      .toMatchObject({ status: 'RELEASED', releaseReason: 'operator-unconfirmed-write-off' });
  });

  it('still refuses to auto-settle an UNKNOWN whose execution result itself is untrustworthy', () => {
    const m = new RiskManager();
    const reserved = m.tryReserve(intent('s1', 'h1'), profile, limits);
    expect(reserved.ok).toBe(true);
    m.markUnknown(reserved.reservation!.reservationId, 'receipt-mismatch', 'mismatched-receipt');

    // 回执不匹配说明"到底下没下"不可信，不能用结算反推。
    expect(m.settleHand('t1', 's1', 'h1', { bankerPair: true, playerPair: false })).toEqual([]);
    expect(m.snapshot()[0]?.status).toBe('UNKNOWN');
  });

  it('leaves startup-recovered historical exposure under the recovery path, not the timeout path', () => {
    const m = new RiskManager();
    const reserved = m.tryReserve(intent('s1', 'h1'), profile, limits);
    expect(reserved.ok).toBe(true);
    m.attachReceipt(reserved.reservation!.reservationId, 'accepted-receipt');
    const createdAt = Date.parse(reserved.reservation!.createdAt);

    // notBefore 晚于该预留的创建时间 = 它是启动时从账本恢复的历史敞口。
    const escalated = m.escalateOverdueSettlements(
      10 * 60_000,
      createdAt + 60 * 60_000,
      'unsettled-past-timeout',
      createdAt + 1000,
    );
    expect(escalated).toEqual([]);
    expect(m.snapshot()[0]?.status).toBe('RESERVED');
  });

  it('keeps an accepted reservation exposed across shoe rollover and restart until exact settlement', () => {
    const ledger = new SqliteLedger();
    const first = new RiskManager(ledger);
    const reserved = first.tryReserve(intent('s1', 'h1'), profile, limits);
    expect(reserved.ok).toBe(true);
    first.attachReceipt(reserved.reservation!.reservationId, 'accepted-receipt');

    // 换靴信号到达时，有回执的 RESERVED 不再被静默清理（FIX(B-P1-3)：不能当没发生）。
    expect(first.expireOpenForShoe('t1', 's1', 'new-shoe-signal')).toEqual([]);
    expect(first.snapshot()[0]).toMatchObject({
      status: 'RESERVED',
      receiptId: 'accepted-receipt',
    });
    expect(first.getState()).toMatchObject({ reservedExposure: 10, pendingExecutions: 1 });

    const restarted = new RiskManager(ledger);
    // 带回执的跨靴预留不在这里改状态：它确实提交过（回执是平台证据），
    // 由启动序列的 escalateRestoredExposures() 统一升级为 UNKNOWN。
    restarted.reconcileTable('t1', 's2', false);
    expect(restarted.snapshot()[0]).toMatchObject({
      status: 'RESERVED',
      receiptId: 'accepted-receipt',
    });
    expect(restarted.getState()).toMatchObject({ reservedExposure: 10, pendingExecutions: 1 });

    const settled = restarted.settleHand('t1', 's1', 'h1', {
      bankerPair: false,
      playerPair: false,
    });
    expect(settled[0]).toMatchObject({ status: 'SETTLED', realizedPnl: -10 });
    expect(restarted.getState()).toMatchObject({
      reservedExposure: 0,
      pendingExecutions: 0,
      executedToday: 10,
      dayLoss: 10,
    });
    ledger.close();
  });

  it('reconciles a cross-shoe reserved reservation to UNKNOWN instead of silently expiring it', () => {
    // FIX(B-P1-3/D-P1-1) 回归：预提交后进程被杀 = 结果未知，必须进 UNKNOWN 让操作员
    // 核对；修复前 reconcileTable 直接 EXPIRED（若那笔其实成交 = 漏记真金亏损）。
    const ledger = new SqliteLedger();
    const first = new RiskManager(ledger);
    const reserved = first.tryReserve(intent('s1', 'h1'), profile, limits);
    expect(reserved.ok).toBe(true);

    const restarted = new RiskManager(ledger);
    restarted.reconcileTable('t1', 's2', false);
    expect(restarted.snapshot()[0]).toMatchObject({
      status: 'UNKNOWN',
      releaseReason: 'reconciled-on-startup',
    });
    // 敞口继续占用，且迟到权威结算仍能收敛（同一靴）。
    expect(restarted.getState()).toMatchObject({ reservedExposure: 10, pendingExecutions: 1 });
    const settled = restarted.settleHand('t1', 's1', 'h1', {
      bankerPair: true,
      playerPair: false,
    });
    expect(settled[0]).toMatchObject({ status: 'SETTLED' });
    ledger.close();
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
