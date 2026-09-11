export const PAIR_BET_MIN_WINDOW_MS = 3_000;

export function bettingWindowRemainingMs(
  closesAt: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (typeof closesAt !== 'string' || closesAt.length === 0) return undefined;
  const closesAtMs = Date.parse(closesAt);
  if (!Number.isFinite(closesAtMs)) return undefined;
  return closesAtMs - now;
}

export function pairBettingClockMs(
  closesAt: string | null | undefined,
  now = Date.now(),
): number {
  if (typeof closesAt !== 'string' || closesAt.length === 0) return now;
  const closesAtMs = Date.parse(closesAt);
  if (!Number.isFinite(closesAtMs)) return now;
  // 本机时钟与平台 closesAt 相差超过 60 秒说明两者中有一个不可信，此时
  // 任何"剩余时间"读数都没有意义。必须让校验保守失败（返回 closesAtMs
  // 使剩余时间为 0），不能伪造一个"还剩 10 秒"的读数——那会让窗口
  // 校验恒真，等于在最需要这道闸的时候把闸拆掉。
  return Math.abs(now - closesAtMs) > 60_000 ? closesAtMs : now;
}

export function isPairBettingWindowReady(
  closesAt: string | null | undefined,
  now = Date.now(),
): boolean {
  const remainingMs = bettingWindowRemainingMs(closesAt, pairBettingClockMs(closesAt, now));
  return remainingMs !== undefined && remainingMs >= PAIR_BET_MIN_WINDOW_MS;
}
