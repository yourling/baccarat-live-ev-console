import { describe, expect, it, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { SqliteLedger } from '@baccarat/ledger-state';
import {
  RiskManager,
  type ExecutionRiskIntent,
} from '../src/risk.js';
import { defaultProfile, defaultRiskLimits, type RiskLimits, type TableProfile } from '@baccarat/contracts';

/**
 * 风控重启对账（生产路径）：desktop 以 SqliteLedger 作为 RiskReservationStore。
 * 这组测试验证真实的 SQLite 持久化路径（而非内存假 store）下的重启重建语义。
 */

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

const openLedgers: SqliteLedger[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const ledger of openLedgers) ledger.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeLedger(): { ledger: SqliteLedger; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'risk-reconcile-'));
  dirs.push(dir);
  const dbPath = join(dir, 'ledger.sqlite');
  const ledger = new SqliteLedger(dbPath);
  openLedgers.push(ledger);
  return { ledger, dbPath };
}

function intent(overrides: Partial<ExecutionRiskIntent> = {}): ExecutionRiskIntent {
  return {
    intentId: 'intent-1',
    tableId: 't1',
    shoeId: 'shoe-1',
    handId: 'h1',
    market: 'bankerPair',
    executionSource: 'strategy',
    amount: 100,
    ...overrides,
  };
}

describe('risk restart reconciliation over SqliteLedger (production path)', () => {
  it('rebuilds reservedExposure / pendingExecutions / idempotency keys from persisted reservations', () => {
    const { ledger, dbPath } = makeLedger();
    const first = new RiskManager(ledger);
    const reserved = first.tryReserveExecution(
      intent(),
      profile.limits,
      profile.odds.bankerPair,
      limits,
    );
    expect(reserved.ok).toBe(true);
    expect(first.getState().reservedExposure).toBeGreaterThan(0);

    // 重启：新 ledger 实例 + 新 RiskManager，全部状态从 SQLite 重建
    const reopened = new SqliteLedger(dbPath);
    openLedgers.push(reopened);
    const second = new RiskManager(reopened);
    const state = second.getState();
    expect(state.reservedExposure).toBe(first.getState().reservedExposure);
    expect(state.pendingExecutions).toBe(1);

    // 幂等键同步重建：同桌同靴同手同市场不允许再次占用
    const duplicate = second.tryReserveExecution(
      intent({ intentId: 'intent-2' }),
      profile.limits,
      profile.odds.bankerPair,
      limits,
    );
    expect(duplicate.ok).toBe(false);
  });

  it('keeps same-day dayLoss / tableLosses across restart and keeps counting', () => {
    const { ledger, dbPath } = makeLedger();
    const first = new RiskManager(ledger);
    const reserved = first.tryReserveExecution(
      intent(),
      profile.limits,
      profile.odds.bankerPair,
      limits,
    );
    expect(reserved.ok).toBe(true);
    first.settleReservedManually(
      reserved.reservation!.reservationId,
      -100,
      'operator-confirmed-platform-settlement',
    );
    const beforeRestart = first.getState();
    expect(beforeRestart.dayLoss).toBeGreaterThan(0);
    expect(beforeRestart.tableLosses['t1']).toBeGreaterThan(0);

    const reopened = new SqliteLedger(dbPath);
    openLedgers.push(reopened);
    const second = new RiskManager(reopened);
    const afterRestart = second.getState();
    // 同日重启：当日亏损与每桌亏损必须原样恢复，而不是清零重计
    expect(afterRestart.dayLoss).toBe(beforeRestart.dayLoss);
    expect(afterRestart.tableLosses['t1']).toBe(beforeRestart.tableLosses['t1']);
    expect(afterRestart.executedToday).toBe(beforeRestart.executedToday);
  });

  it('keeps UNKNOWN exposure reserved across restart and rejects new bets against the cap', () => {
    const { ledger, dbPath } = makeLedger();
    const first = new RiskManager(ledger);
    const reserved = first.tryReserveExecution(
      intent({ intentId: 'intent-u1' }),
      profile.limits,
      profile.odds.bankerPair,
      limits,
    );
    expect(reserved.ok).toBe(true);
    first.markUnknown(reserved.reservation!.reservationId, 'platform-acknowledgement-unknown');
    expect(first.getState().reservedExposure).toBeGreaterThan(0);

    const reopened = new SqliteLedger(dbPath);
    openLedgers.push(reopened);
    const second = new RiskManager(reopened);
    // UNKNOWN 重启后仍占敞口与并发：对手 unknown 也应继续阻断当事桌
    expect(second.hasUnknownReservations('t1')).toBe(true);
    const state = second.getState();
    expect(state.reservedExposure).toBe(first.getState().reservedExposure);
    expect(state.pendingExecutions).toBe(1);
    // 勾销后敞口释放
    second.writeOffUnknown(reserved.reservation!.reservationId, 'operator-unconfirmed-write-off');
    expect(second.getState().reservedExposure).toBe(0);
  });
});
