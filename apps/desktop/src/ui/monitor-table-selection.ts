import type { MonitorTableCandidate } from '../api-types';

export function isLiveMonitorRoomId(roomId: string): boolean {
  return roomId === 'dafabet-pragmatic' || roomId === 'dafabet-bg' || roomId === 'dafabet-winfinity';
}

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

export function selectLiveMonitorTableIds(
  candidates: readonly MonitorTableCandidate[],
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isLiveMonitorRoomId(candidate.roomId) || seen.has(candidate.tableId)) continue;
    seen.add(candidate.tableId);
    selected.push(candidate.tableId);
  }
  return selected;
}
