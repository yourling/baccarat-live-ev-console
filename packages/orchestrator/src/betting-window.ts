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
  return Math.abs(now - closesAtMs) > 60_000 ? closesAtMs - 10_000 : now;
}

export function isPairBettingWindowReady(
  closesAt: string | null | undefined,
  now = Date.now(),
): boolean {
  const remainingMs = bettingWindowRemainingMs(closesAt, pairBettingClockMs(closesAt, now));
  return remainingMs !== undefined && remainingMs >= PAIR_BET_MIN_WINDOW_MS;
}
