import type { MonitorTableCandidate } from '../api-types';
import {
  BUNDLED_PLATFORM_DESCRIPTORS,
  PRAGMATIC_PLATFORM_ID,
} from '@baccarat/adapter-contract';

/**
 * 实时监控厅台集合来自平台注册表（platform-catalog），
 * 中控 UI 不硬编码任何具体平台的 roomId。
 */
const LIVE_MONITOR_ROOM_IDS = new Set(
  BUNDLED_PLATFORM_DESCRIPTORS.map(descriptor => descriptor.roomId),
);

/** 具备真金执行能力的平台 roomId（Pragmatic / BG）。 */
const PAIR_EXECUTION_ROOM_IDS = new Set(
  BUNDLED_PLATFORM_DESCRIPTORS
    .filter(descriptor => descriptor.executionCapability === 'full')
    .map(descriptor => descriptor.roomId),
);

/** 兼容旧入口：仅 Pragmatic 平台 roomId。 */
const PRAGMATIC_ROOM_IDS = new Set(
  BUNDLED_PLATFORM_DESCRIPTORS
    .filter(descriptor => descriptor.platformId === PRAGMATIC_PLATFORM_ID)
    .map(descriptor => descriptor.roomId),
);

export function isLiveMonitorRoomId(roomId: string): boolean {
  return LIVE_MONITOR_ROOM_IDS.has(roomId);
}

export function selectPragmaticMonitorTableIds(
  candidates: readonly MonitorTableCandidate[],
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!PRAGMATIC_ROOM_IDS.has(candidate.roomId) || seen.has(candidate.tableId)) continue;
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
