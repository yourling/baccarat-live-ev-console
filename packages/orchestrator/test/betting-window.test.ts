import { describe, expect, it } from 'vitest';
import {
  PAIR_BET_MIN_WINDOW_MS,
  bettingWindowRemainingMs,
  isPairBettingWindowReady,
  pairBettingClockMs,
} from '../src/betting-window.js';

describe('bettingWindowRemainingMs', () => {
  it('returns the gap between now and closesAt', () => {
    expect(bettingWindowRemainingMs('2026-09-10T00:00:10.000Z', Date.parse('2026-09-10T00:00:00.000Z'))).toBe(10_000);
  });

  it('returns undefined without a usable closesAt so callers fail closed', () => {
    expect(bettingWindowRemainingMs(undefined)).toBeUndefined();
    expect(bettingWindowRemainingMs(null)).toBeUndefined();
    expect(bettingWindowRemainingMs('')).toBeUndefined();
    expect(bettingWindowRemainingMs('not-a-date')).toBeUndefined();
  });
});

describe('isPairBettingWindowReady', () => {
  const now = Date.parse('2026-09-10T00:00:00.000Z');

  it('accepts a window with at least the minimum remaining time', () => {
    expect(isPairBettingWindowReady('2026-09-10T00:00:03.000Z', now)).toBe(true);
    expect(isPairBettingWindowReady('2026-09-10T00:00:20.000Z', now)).toBe(true);
  });

  it('rejects a window closing sooner than the minimum', () => {
    expect(isPairBettingWindowReady('2026-09-10T00:00:02.999Z', now)).toBe(false);
  });

  it('rejects an already closed window', () => {
    expect(isPairBettingWindowReady('2026-09-09T23:59:59.000Z', now)).toBe(false);
  });

  it('rejects a missing or unparsable closesAt', () => {
    expect(isPairBettingWindowReady(undefined, now)).toBe(false);
    expect(isPairBettingWindowReady('', now)).toBe(false);
    expect(isPairBettingWindowReady('garbage', now)).toBe(false);
  });
});

describe('pairBettingClockMs under clock skew', () => {
  // 回归：旧实现在 |now - closesAt| > 60s 时返回 closesAtMs - 10_000，
  // 使剩余时间恒为 10s，于是窗口校验永远通过 —— 恰好在时钟不可信、
  // 最需要这道校验的时候把校验关掉了。
  it('fails closed when the local clock runs ahead of the platform', () => {
    const now = Date.parse('2026-09-10T00:05:00.000Z');
    const closesAt = '2026-09-10T00:00:00.000Z';
    expect(pairBettingClockMs(closesAt, now)).toBe(Date.parse(closesAt));
    expect(isPairBettingWindowReady(closesAt, now)).toBe(false);
  });

  it('fails closed when the local clock lags behind the platform', () => {
    const now = Date.parse('2026-09-10T00:00:00.000Z');
    const closesAt = '2026-09-10T00:05:00.000Z';
    expect(pairBettingClockMs(closesAt, now)).toBe(Date.parse(closesAt));
    expect(isPairBettingWindowReady(closesAt, now)).toBe(false);
  });

  it('still trusts a clock within the skew tolerance', () => {
    const now = Date.parse('2026-09-10T00:00:00.000Z');
    const closesAt = '2026-09-10T00:00:30.000Z';
    expect(pairBettingClockMs(closesAt, now)).toBe(now);
    expect(isPairBettingWindowReady(closesAt, now)).toBe(true);
  });

  it('never reports a remaining time above the minimum when skewed', () => {
    const skewedPairs: readonly [number, string][] = [
      [Date.parse('2026-09-10T00:10:00.000Z'), '2026-09-10T00:00:00.000Z'],
      [Date.parse('2026-09-10T00:00:00.000Z'), '2026-09-10T00:10:00.000Z'],
      [Date.parse('2026-09-10T00:00:00.000Z'), '2026-09-10T01:00:00.000Z'],
    ];
    for (const [now, closesAt] of skewedPairs) {
      const remaining = bettingWindowRemainingMs(closesAt, pairBettingClockMs(closesAt, now));
      expect(remaining ?? -1).toBeLessThan(PAIR_BET_MIN_WINDOW_MS);
    }
  });
});
