/**
 * 桥层的平台适配器抽象。
 *
 * BrowserBridgeServer 只包含平台无关的通用机制（房间表、选择集、导出、
 * 执行通道、租约、序列校验）；每个游戏平台实现一个 BridgePlatformAdapter，
 * 携带自己的运行时解析器与采集入口。新增平台 = 新增一个适配器实现 +
 * 在 platform-catalog 注册描述符，server 零改动。
 */
import type { PlatformAdapterDescriptor } from '@baccarat/adapter-contract';
import { EVENT_SCHEMA_VERSION, defaultProfile, type NormalizedEvent } from '@baccarat/contracts';
import type { BridgeRoomDescriptor } from './protocol.js';
import type { ParserShoeEvidence } from './runtime-common.js';

/** 扩展上报的 networkCapture 消息中平台相关的切片。 */
export interface PlatformCaptureMessage {
  readonly source: string;
  readonly url: string;
  readonly data: string;
  readonly encoding?: string;
  readonly direction?: string;
}

/**
 * operator 合成靴事件的共享形状：人工确认实体靴时，full 平台统一用
 * `${prefix}-session:${shoeId}:new-shoe` 形状发 newShoeSignal（source=operator，
 * sourceSeq=0 由 ingest 层重编）。
 */
export function buildOperatorShoeEvent(
  descriptor: PlatformAdapterDescriptor,
  tableId: string,
  timestamp: string,
): NormalizedEvent {
  const prefix = descriptor.operatorShoeIdPrefix;
  const shoeId = `${prefix}-${tableId}-operator`;
  return {
    type: 'newShoeSignal',
    eventId: `${prefix}-session:${shoeId}:new-shoe`,
    platformId: descriptor.platformId,
    tableId,
    timestamp,
    sourceSeq: 0,
    source: 'operator',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId,
    baseline: 'physical-shoe',
    profile: { ...defaultProfile(tableId), autoConfirmNewShoe: true },
  } as NormalizedEvent;
}

/** 适配器回调宿主的通用服务（由 server 提供，平台实现不得绕过）。 */
export interface PlatformAdapterContext {
  isTableSelected(tableId: string): boolean;
  noteTableObservation(tableId: string): void;
  /** 以本平台 roomId 归账并 ingest 归一化事件（含去重与序号收敛）。 */
  ingestEvents(events: readonly NormalizedEvent[]): void;
  ensureRoomForTable(tableId: string): void;
  upsertDiscoveredRoom(room: BridgeRoomDescriptor): void;
  /** 该桌最近一次 ingest 过的靴 ID（winfinity 重选桌时补发当前靴用）。 */
  lastIngestedShoeId(tableId: string): string | undefined;
  setVisibleTableIds(tableIds: readonly string[]): void;
  addVisibleTableIds(tableIds: readonly string[]): void;
}

export interface BridgePlatformAdapter {
  readonly descriptor: PlatformAdapterDescriptor;

  // -- 桌 ID 归属 -----------------------------------------------------------

  /** 平台规范的桌 ID；无法归一化时返回 undefined。默认平台返回原值。 */
  normalizeTableId(tableId: string): string | undefined;
  /** roomIdForTable 兜底：按桌 ID 形状识别归属平台。 */
  matchesTableIdShape(tableId: string): boolean;

  // -- 大厅房间 -------------------------------------------------------------

  /** 扩展上报房间的净化（如 BG/Winfinity 桌 ID 归一化过滤）。 */
  sanitizeRoom(room: BridgeRoomDescriptor): BridgeRoomDescriptor;
  /** 大厅房间合并策略：true = upsert 增量合并；false = 整体替换。 */
  usesUpsertRoomMerge(): boolean;
  mergeGameCount(previous: number | undefined, next: number | undefined): number | undefined;
  ingestRoomGameCounts(room: BridgeRoomDescriptor, ctx: PlatformAdapterContext): void;
  roomTableDisplayName(tableId: string): string | undefined;
  /** ensureRoomForTable 收编桌 ID 时的平台挂钩（winfinity 锁定 vendor alias）。 */
  onRoomTableAdopted(tableId: string): void;

  // -- 采集入口 --------------------------------------------------------------

  /** 处理 captureSourcePrefix 命中的 networkCapture 消息。 */
  ingestNetworkCapture(message: PlatformCaptureMessage, ctx: PlatformAdapterContext): void;

  // -- 选择集 ----------------------------------------------------------------

  /** 桌被新选入时的平台钩子（补解析缓存快照 / 补发当前靴）。 */
  onTableSelected(tableId: string, ctx: PlatformAdapterContext): void;

  // -- 靴操作 ------------------------------------------------------------------

  recordShoeEvidence(tableId: string, evidence: ParserShoeEvidence): void;
  openPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[];
  /** 人工确认实体靴：返回需要 ingest 的 newShoeSignal 事件。 */
  confirmPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[];
  /** 执行串行 lane：同一 lane 的下注请求串行执行。 */
  executionLaneId(tableId: string): string;
  currentShoeId(tableId: string): string | undefined;
  acceptedGameCount(tableId: string): number | undefined;
  shoeEvidence(tableId: string): ParserShoeEvidence | undefined;

  // -- 生命周期 ------------------------------------------------------------------

  /** beginMonitorSession：重建全部解析状态。 */
  reset(): void;
  resetTable(tableId: string): void;
  /** 跨重启保持靴代际单调（BG 专用能力）。 */
  seedShoeSequences?(entries: ReadonlyArray<{ readonly tableId: string; readonly sequence: number }>): void;
}
