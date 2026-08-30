import type { MonitorTableCandidate } from '../api-types';

export function selectPragmaticMonitorTableIds(
  candidates: readonly MonitorTableCandidate[],
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.roomId !== 'dafabet-pragmatic' || seen.has(candidate.tableId)) continue;
    seen.add(candidate.tableId);
    selected.push(candidate.tableId);
  }
  return selected;
}
