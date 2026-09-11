/**
 * 监控桌配置与桌 ID 的纯工具层：service.ts 与 monitor-console.ts 共用。
 * 无状态、无依赖注入——只做解析/归一化/比较。
 */
import { BUNDLED_PLATFORM_DESCRIPTORS } from '@baccarat/adapter-contract';
import type { TableSettingsUpdate } from '@baccarat/orchestrator';

export const RETIRED_DEFAULT_MONITOR_TABLE_IDS = ['bc281koreanch281', 'tobcbaccaragen92', 'speedbca14gesbc1', 'h22z8qhp17sa0vkh'] as const;
export const MONITOR_TABLE_CONFIG_KEY = 'desktop:monitor-tables:v1';
export const TABLE_METADATA_CONFIG_KEY = 'desktop:table-metadata:v1';
export const LEGACY_MONITOR_TABLE_ID_PATTERN = /^[A-Z]{1,4}\d{2,6}$/i;
const PRAGMATIC_MONITOR_TABLE_ID_PATTERN = /^[a-z0-9]{8,32}$/i;
const WINFINITY_MONITOR_TABLE_ID_PATTERN = /^[a-z0-9]+-bac\d+$/i;
const WINFINITY_FALLBACK_MONITOR_TABLE_ID_PATTERN = /^wnf-[a-f0-9]{24}$/i;
export const MAX_LIVE_MONITOR_TABLES = 64;
export const DISCONNECTED_MONITOR_REMOVAL_MS = 15_000;
export const SHUFFLE_MONITOR_HOLD_MS = 10 * 60 * 1000;

export type MonitorTableConfig = {
  readonly tableIds: readonly string[];
};

export type StoredTableMetadata = {
  readonly tableId: string;
  readonly roomId: string;
  readonly updatedAt: string;
  readonly roomName?: string;
  readonly displayName?: string;
  readonly roundId?: string;
  readonly gameCount?: number;
};

export type TableMetadataConfig = {
  readonly tables: readonly StoredTableMetadata[];
};

export type UnifiedBetSettings = Pick<TableSettingsUpdate, 'minEV' | 'betTiers' | 'defaultBetAmount'>;

/**
 * A selection transition must distinguish a feed that stopped, disappeared on
 * its own, and one that may still be delivering events after a failed stop.
 */
export type MonitorFeedTransitionStopResult =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'not-current' }
  | { readonly kind: 'failed'; readonly error: unknown };

export function isLiveDesktopRoomId(roomId: string): boolean {
  return BUNDLED_PLATFORM_DESCRIPTORS.some(descriptor => descriptor.roomId === roomId);
}

export function normalizeMonitorTableIds(tableIds: readonly string[], allowEmpty = false): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawTableId of tableIds) {
    const trimmed = rawTableId.trim();
    const tableId = LEGACY_MONITOR_TABLE_ID_PATTERN.test(trimmed)
      ? trimmed.toUpperCase()
      : trimmed.toLowerCase();
    if (
      !LEGACY_MONITOR_TABLE_ID_PATTERN.test(tableId)
      && !PRAGMATIC_MONITOR_TABLE_ID_PATTERN.test(tableId)
      && !WINFINITY_MONITOR_TABLE_ID_PATTERN.test(tableId)
      && !WINFINITY_FALLBACK_MONITOR_TABLE_ID_PATTERN.test(tableId)
    ) {
      throw new RangeError(`invalid monitor table id: ${rawTableId}`);
    }
    if (!seen.has(tableId)) {
      seen.add(tableId);
      normalized.push(tableId);
    }
  }
  if (!allowEmpty && normalized.length === 0) {
    throw new RangeError('at least one monitor table id is required');
  }
  return normalized;
}

export function monitorTableIdsFromConfig(value: unknown): string[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const tableIds = Reflect.get(value, 'tableIds');
  if (!Array.isArray(tableIds) || !tableIds.every((tableId): tableId is string => typeof tableId === 'string')) {
    return null;
  }
  try {
    return normalizeMonitorTableIds(tableIds, true);
  } catch {
    return null;
  }
}

export function normalizeOptionalMonitorTableId(tableId: string): string | undefined {
  try {
    return normalizeMonitorTableIds([tableId], true)[0];
  } catch {
    return undefined;
  }
}

export function tableMetadataFromConfig(value: unknown): Map<string, StoredTableMetadata> {
  const result = new Map<string, StoredTableMetadata>();
  if (typeof value !== 'object' || value === null) return result;
  const tables = Reflect.get(value, 'tables');
  if (!Array.isArray(tables)) return result;
  for (const entry of tables) {
    if (typeof entry !== 'object' || entry === null) continue;
    const tableId = Reflect.get(entry, 'tableId');
    const roomId = Reflect.get(entry, 'roomId');
    const updatedAt = Reflect.get(entry, 'updatedAt');
    if (typeof tableId !== 'string' || typeof roomId !== 'string' || typeof updatedAt !== 'string') continue;
    const normalized = normalizeOptionalMonitorTableId(tableId);
    if (normalized === undefined) continue;
    result.set(normalized, {
      tableId: normalized,
      roomId,
      updatedAt,
      ...optionalString(entry, 'roomName'),
      ...optionalString(entry, 'displayName'),
      ...optionalString(entry, 'roundId'),
      ...optionalNumber(entry, 'gameCount'),
    });
  }
  return result;
}

export function optionalString(value: object, field: string): Record<string, string> {
  const raw = Reflect.get(value, field);
  return typeof raw === 'string' && raw.trim().length > 0 ? { [field]: raw.trim() } : {};
}

export function optionalNumber(value: object, field: string): Record<string, number> {
  const raw = Reflect.get(value, field);
  return typeof raw === 'number' && Number.isFinite(raw) ? { [field]: raw } : {};
}

export function samePersistentTableMetadata(
  left: StoredTableMetadata | undefined,
  right: StoredTableMetadata,
): boolean {
  return left !== undefined
    && left.tableId === right.tableId
    && left.roomId === right.roomId
    && left.roomName === right.roomName
    && left.displayName === right.displayName;
}

export function defaultMonitorTableIds(): string[] {
  const rawTableIds = String(process.env.BACCARAT_LIVE_TABLES || '')
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0);
  return normalizeMonitorTableIds(rawTableIds, true).slice(0, MAX_LIVE_MONITOR_TABLES);
}

export function isRetiredDefaultMonitorList(tableIds: readonly string[]): boolean {
  if (tableIds.length !== RETIRED_DEFAULT_MONITOR_TABLE_IDS.length) return false;
  const expected = new Set<string>(RETIRED_DEFAULT_MONITOR_TABLE_IDS);
  return tableIds.every(tableId => expected.has(tableId));
}
