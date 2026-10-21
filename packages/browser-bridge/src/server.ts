import {
  EVENT_SCHEMA_VERSION,
  defaultProfile,
  isValidContinuityProof,
  newId,
  sha256,
  stableStringify,
  type BetReceipt,
  type NormalizedEvent,
} from '@baccarat/contracts';
import {
  BG_BET_RUNTIME_FAMILY,
  BG_BET_RUNTIME_REVISION,
  BG_PLATFORM_ID,
  PRAGMATIC_BET_RUNTIME_FAMILY,
  PRAGMATIC_BET_RUNTIME_REVISION,
  PRAGMATIC_PLATFORM_ID,
  WINFINITY_PLATFORM_ID,
  isCompatibleRuntimeRevision,
  type PlatformAdapterDescriptor,
} from '@baccarat/adapter-contract';
import type {
  BetExecutionRequest,
  OperationalWagerExecutionRequest,
  OperationalWagerReceipt,
} from '@baccarat/adapter-contract';
import type { IncomingMessage } from 'node:http';
import {
  cursorContinuityProof,
  type MonitorConnectionState,
  type MonitorHealth,
  type MonitorKeepAliveResult,
  type RoomDescriptor,
  type RoomMonitor,
  type TableCursor,
  type TableEventBatch,
  type TableExport,
  type TableExportSink,
} from '@baccarat/room-monitor';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  BridgeClientMessage,
  BridgeExecutionReceipt,
  BridgeExecutionRequest,
  BridgeRoomDescriptor,
  BridgeServerMessage,
} from './protocol.js';
import { inspectPragmaticWsFrame } from './pragmatic-protocol.js';
import type { ParserShoeEvidence } from './runtime-common.js';
import type { BeadHand } from './runtime-common.js';
import { PragmaticPlatformAdapter } from './platform-pragmatic.js';
import { BgPlatformAdapter } from './platform-bg.js';
import { WinfinityPlatformAdapter } from './platform-winfinity.js';
import type {
  BridgePlatformAdapter,
  PlatformAdapterContext,
  PlatformCaptureMessage,
} from './platform-adapter.js';
import { PLATFORM_REGISTRY, isLiveBridgeRoomId } from './identity.js';
import {
  extensionInstallIdFromRequestUrl,
  normalizeExtensionInstallId,
  type BridgeExtensionApprovalStore,
  type BridgeExtensionPendingEntry,
} from './extension-approval.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ExecutorLeaseRegistry, type HostExecutionChannelClaimResult } from './executor-lease.js';
export { WINFINITY_WS_ALIAS_BUFFER_LIMIT } from './platform-winfinity.js';

// 兼容导出：运行时版本常量已上收 platform-catalog（值不变）。
export { PRAGMATIC_BET_RUNTIME_REVISION, BG_BET_RUNTIME_REVISION };

export const OPERATIONAL_WAGER_RUNTIME_FAMILIES = [
  PRAGMATIC_BET_RUNTIME_FAMILY,
  BG_BET_RUNTIME_FAMILY,
] as const;


export class OperationalWagerRuntimeRevisionError extends Error {
  constructor(readonly receipt: OperationalWagerReceipt) {
    super('browser extension bet runtime revision mismatch');
    this.name = 'OperationalWagerRuntimeRevisionError';
  }
}

export interface BrowserBridgeServerOptions {
  port?: number;
  host?: string;
  betTimeoutMs?: number;
  selectedTableIds?: readonly string[];
  tableStaleAfterMs?: number;
  extensionHeartbeatTimeoutMs?: number;
  extensionDisconnectGraceMs?: number;
  requireExtensionSequence?: boolean;
  allowedExtensionId?: string;
  allowedExtensionIds?: readonly string[];
  extensionToken?: string;
  /**
   * FIX(P0-1): 操作员批准名单。传入时进入**严格模式**：只有 store 里 isApproved 的
   * installId 才能拿到 extension 角色；桌面端应注入落盘实现。
   */
  extensionApprovals?: BridgeExtensionApprovalStore;
  /**
   * FIX(P0-1): 未传 `extensionApprovals` 时的兼容开关。
   *
   * - `extensionApprovals` 已传 → 本开关无效（严格模式）。
   * - 未传 store 且本开关为 true（**不传 store 时的默认值**）→ 带 installId 的扩展一律放行，
   *   保持既有单测/demo 脚本的行为（`new BrowserBridgeServer()` 的语义）。
   * - 显式 false → 严格模式但没有 store，等价于「没有任何已批准 installId」。
   *
   * 注意：无论哪种取值，**缺 installId 的旧式连接都只拿 pending 角色**（P0-1 攻击面：
   * 伪造 Origin + 明文 token 的本机进程拿不到 installId，因此无法占住扩展槽）。
   */
  allowUnapprovedExtensions?: boolean;
  onRuntimeEvent?: (event: BrowserBridgeRuntimeEvent) => void;
}

export type BrowserBridgeRuntimeEvent =
  | { readonly kind: 'extension-auth-failed'; readonly reason: string; readonly timestamp: string }
  | { readonly kind: 'extension-connected'; readonly timestamp: string }
  | { readonly kind: 'extension-authenticated'; readonly sessionId: string; readonly timestamp: string }
  // FIX(P0-1): 扩展已连上但本机身份（installId）尚未被操作员批准。
  // 该连接只拿到 pending 角色：无 executor lease、不下发 betRequest、不 ingest 牌桌事件。
  // installId 只用于本地待批准列表，不写日志、不进事故消息。
  | { readonly kind: 'extension-pairing-required'; readonly installId: string; readonly timestamp: string }
  | { readonly kind: 'extension-disconnected'; readonly reason: string; readonly timestamp: string }
  | { readonly kind: 'continuity-invalidated'; readonly reason: string; readonly timestamp: string }
  | { readonly kind: 'execution-gate-revoked'; readonly reason: string; readonly timestamp: string }
  | { readonly kind: 'table-disconnected'; readonly tableId: string; readonly reason: string; readonly timestamp: string }
  | { readonly kind: 'session-recovery-exhausted'; readonly detail?: string; readonly timestamp: string }
  | { readonly kind: 'session-recovered'; readonly timestamp: string }
  | { readonly kind: 'executor-lease-acquired'; readonly leaseId: string; readonly profileId: string; readonly reacquired: boolean; readonly timestamp: string }
  | { readonly kind: 'executor-lease-rejected'; readonly reason: string; readonly profileId: string; readonly activeLeaseId?: string; readonly timestamp: string };

export interface BrowserBridgeExtensionStatus {
  readonly connectionCount: number;
  readonly authenticated: boolean;
  readonly lastSeenAt?: string;
  readonly activeExecutorCount?: number;
  readonly executorLeaseId?: string;
  readonly executorProfileId?: string;
}

export interface BrowserBridgeExecutorStatus {
  readonly active_executor_count: number;
  readonly leaseId?: string;
  readonly profileId?: string;
  readonly hostChannelId?: string;
}

type PendingBet = {
  resolve: (receipt: BridgeExecutionReceipt | null) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  ownerSocket: WebSocket | undefined;
};

type MergeGameCountSelector = (
  tableId: string,
  previous: number | undefined,
  next: number | undefined,
) => number | undefined;

function mergeBridgeTableDescriptor(
  previous: BridgeRoomDescriptor['tables'][number] | undefined,
  next: BridgeRoomDescriptor['tables'][number],
  mergeGameCount: MergeGameCountSelector,
): BridgeRoomDescriptor['tables'][number] {
  const gameCount = next.gameCount === undefined
    ? previous?.gameCount
    : mergeGameCount(next.tableId, previous?.gameCount, next.gameCount);
  return {
    ...(previous ?? { tableId: next.tableId }),
    tableId: next.tableId,
    ...(next.displayName === undefined ? {} : { displayName: next.displayName }),
    ...(next.roundId === undefined ? {} : { roundId: next.roundId }),
    ...(gameCount === undefined ? {} : { gameCount }),
    ...(previous?.profile === undefined && next.profile === undefined
      ? {}
      : { profile: { ...(previous?.profile ?? {}), ...(next.profile ?? {}) } }),
    ...(next.monitorUrl === undefined ? {} : { monitorUrl: next.monitorUrl }),
  };
}

function upsertBridgeRoom(
  rooms: Map<string, BridgeRoomDescriptor>,
  next: BridgeRoomDescriptor,
  mergeGameCount: MergeGameCountSelector,
): BridgeRoomDescriptor {
  const previous = rooms.get(next.roomId);
  if (previous === undefined) {
    const created = {
      ...next,
      tables: next.tables.map(table => mergeBridgeTableDescriptor(undefined, table, mergeGameCount)),
    };
    rooms.set(next.roomId, created);
    return created;
  }
  const tables = new Map(previous.tables.map(table => [table.tableId, table]));
  for (const table of next.tables) {
    tables.set(table.tableId, mergeBridgeTableDescriptor(tables.get(table.tableId), table, mergeGameCount));
  }
  const merged = {
    ...previous,
    ...(next.displayName === undefined ? {} : { displayName: next.displayName }),
    tables: [...tables.values()],
  };
  rooms.set(next.roomId, merged);
  return merged;
}

function replaceBridgeRoom(
  rooms: Map<string, BridgeRoomDescriptor>,
  next: BridgeRoomDescriptor,
  mergeGameCount: MergeGameCountSelector,
): BridgeRoomDescriptor {
  const previous = rooms.get(next.roomId);
  const previousTables = new Map((previous?.tables ?? []).map(table => [table.tableId, table]));
  const replaced = {
    ...(previous ?? next),
    ...(next.displayName === undefined ? {} : { displayName: next.displayName }),
    roomId: next.roomId,
    tables: next.tables.map(table => mergeBridgeTableDescriptor(previousTables.get(table.tableId), table, mergeGameCount)),
  };
  rooms.set(next.roomId, replaced);
  return replaced;
}

function selectedBridgeRoom(
  room: BridgeRoomDescriptor,
  isSelected: (tableId: string) => boolean,
): BridgeRoomDescriptor {
  return {
    ...room,
    tables: room.tables.filter(table => isSelected(table.tableId)),
  };
}

/**
 * 转发给所有已连接观察客户端的消息类型：
 * 桥接服务把扩展发来的会话/保活/诊断事件广播出去，
 * 让 bridge:observe 之类的观察者在桌面控制台已占用端口时仍能实时观测。
 */
const OBSERVABLE_KINDS = new Set(['sessionExpired', 'sessionAction', 'keepalive']);
const NOISY_SESSION_ACTIONS = new Set([
  'pragmatic-outbound-send',
  'native-idle-keepalive-armed',
  'native-idle-continue-cleared',
  'native-idle-continue-click',
]);
const PRAGMATIC_EXECUTION_LANE = 'pragmatic:shared-multitable-ui';

/** 观察广播只透传游戏协议通道，不含视频/资源/页面 IPC。 */
const OBSERVABLE_NETWORK_PATTERN = /pragmaticplaylive\.net\/game|h5V01|jbz029|baccarat-bridge-bg|youngpoisson\.xyz|baccarat-bridge-winfinity/i;

const LIVE_PROTOCOL_CAPTURE_SOURCES = new Set([
  'baccarat-bridge-pragmatic-ws',
  'baccarat-bridge-pragmatic-state',
  'baccarat-bridge-runtime-selection',
  'baccarat-bridge-runtime-state',
  'baccarat-bridge-bg-ws',
  'baccarat-bridge-bg-state',
  'baccarat-bridge-winfinity-ws',
  'baccarat-bridge-winfinity-state',
]);

function isLiveProtocolCapture(
  message: Extract<BridgeClientMessage, { kind: 'networkCapture' }>,
): boolean {
  if (message.encoding === 'base64') return false;
  if (typeof message.data === 'string' && message.data.length > 65_536) return false;
  if (LIVE_PROTOCOL_CAPTURE_SOURCES.has(message.source)) return true;
  return OBSERVABLE_NETWORK_PATTERN.test(message.url);
}

const LIVE_EXTENSION_CONNECTION_ERROR =
  'live bet execution requires exactly one browser extension connection with an authenticated extension sequence';
const LIVE_BET_CONNECTION_LOST_ERROR = 'browser extension disconnected before live bet result';
const OBSERVER_PATH = '/observe';
const COMMAND_PATH = '/command';
const BRIDGE_DEBUG_ENABLED = process.env.BACCARAT_BRIDGE_DEBUG === '1';

const TABLE_STALE_AFTER_MS = 45_000;
const SHUFFLE_HOLD_MS = 10 * 60 * 1000;
/**
 * 单个桌导出的待消费事件上限。暂停（stale / 洗牌 hold）期间如果既无法消费、
 * 又等不到可重放的实体洗牌，pending 会一直堆积；没有上限的话这就是一个
 * 长达 SHUFFLE_HOLD_MS 的 OOM 通道。
 */
const TABLE_EXPORT_PENDING_LIMIT = 4_096;
/**
 * 单条 WebSocket 消息上限。ws 默认 100MB —— 一个畸形/失控的客户端足以把进程撑爆。
 *
 * 取值刻意留了很大余量：超限时 ws 会以 1009 直接**关闭连接**，扩展随后重连，
 * 等于监控中断。桥里已有的最大消息（全量珠盘同步）在设计上远小于此值
 * （`isLiveProtocolCapture` 对 capture 数据的门槛是 64KB），所以 8MB 既能把
 * 100MB 的上限收回来，又不会误伤正常负载。
 */
const MAX_BRIDGE_MESSAGE_BYTES = 8 * 1_048_576;
/**
 * 允许从本机回环转发的扩展命令白名单。
 *
 * FIX(P0-2): `/command` 只校验可伪造的 loopback Origin，本机任意进程都能连上。
 * 因此这里**只保留只读/诊断命令**；会改变扩展安全姿态的命令
 * （liveOn / liveOff / reloadExtension / trustedOn / trustedOff / calibrate /
 * calibrateClear / startPragmaticNetworkCapture / stopPragmaticNetworkCapture）
 * 已从白名单删除 —— 它们只允许由桌面端进程内直接调用（`setLiveBetEnabled()` 等走
 * `broadcastToSockets`，不经过本白名单），扩展侧对应的处理分支保留。
 *
 * 新增命令前先问一句：本机任意进程能下发它吗？能，就别加。
 */
const BRIDGE_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'probeBetReadiness',
  'replayRuntimeState',
  'probeExtensionManifest',
]);
const EXTENSION_HEARTBEAT_TIMEOUT_MS = 15_000;
const EXTENSION_DISCONNECT_GRACE_MS = 8_000;

/**
 * FIX(P0-1): socket 角色。
 * - `extension`：Origin + token 通过，且 installId 已被操作员批准（或桥处于兼容放行模式）；
 * - `extension-pending`：Origin + token 通过，但 installId 缺失/未批准 —— 只能收 pairingRequired、
 *   回 pairingAck/心跳，拿不到 lease、不 ingest 事件、**不占唯一扩展槽**；
 * - `observer` / `command`：回环观察/命令客户端（本轮不引入认证，P0-2 只收窄命令面）。
 */
type BridgeSocketRole = 'extension' | 'extension-pending' | 'observer' | 'command';

function allowedExtensionIdSet(
  identity: Pick<BrowserBridgeServerOptions, 'allowedExtensionId' | 'allowedExtensionIds'> = {},
): ReadonlySet<string> | undefined {
  const ids = [
    ...(identity.allowedExtensionIds ?? []),
    ...(identity.allowedExtensionId === undefined ? [] : [identity.allowedExtensionId]),
  ].filter(id => /^[a-p]{32}$/.test(id));
  if (ids.length === 0) return undefined;
  return new Set(ids);
}

/**
 * FIX(P0-1): 扩展角色判定。
 *
 * 只判 Origin+token 已经不够（两者都是公开常量），还必须有可被操作员批准的本机身份。
 * 缺 installId 一律 pending —— 这是 b7d 伪造 Origin+token 攻击被拦住的**唯一**理由，
 * 不要在兼容模式下放宽它。
 */
function bridgeSocketRole(
  origin: string,
  requestUrl: string | undefined,
  identity: Pick<
    BrowserBridgeServerOptions,
    'allowedExtensionId' | 'allowedExtensionIds' | 'extensionToken'
  > = {},
  extensionApproved: (installId: string | undefined) => boolean = () => false,
): BridgeSocketRole | null {
  const path = bridgeRequestPath(requestUrl);
  if (isExtensionOrigin(origin, allowedExtensionIdSet(identity))) {
    if (path !== '/' || !hasExtensionToken(requestUrl, identity.extensionToken)) return null;
    return extensionApproved(extensionInstallIdFromRequestUrl(requestUrl))
      ? 'extension'
      : 'extension-pending';
  }
  if (!isLoopbackObserverOrigin(origin)) return null;
  if (path === OBSERVER_PATH) return 'observer';
  if (path === COMMAND_PATH) return 'command';
  return null;
}

function bridgeRequestPath(requestUrl: string | undefined): string {
  try {
    return new URL(requestUrl ?? '/', 'ws://localhost').pathname;
  } catch {
    return '';
  }
}

function isExtensionOrigin(origin: string, allowedIds?: ReadonlySet<string>): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'chrome-extension:'
      && /^[a-p]{32}$/.test(url.hostname)
      && (allowedIds === undefined || allowedIds.has(url.hostname));
  } catch {
    return false;
  }
}

function hasExtensionToken(requestUrl: string | undefined, expectedToken?: string): boolean {
  if (expectedToken === undefined) return true;
  try {
    const url = new URL(requestUrl ?? '/', 'ws://localhost');
    return url.searchParams.get('token') === expectedToken;
  } catch {
    return false;
  }
}

function isLoopbackObserverOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const isLoopbackHost = url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]'
      || url.hostname === '::1';
    return isLoopbackHost && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

function redactedNetworkUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const pathname = url.pathname
      .replace(/;sid=[^/;]+/gi, ';sid=[redacted]')
      .replace(/\/(sessions?|tokens?|auth(?:orization)?)\/[^/]+/gi, '/$1/[redacted]');
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return '';
  }
}

type RuntimeStateObservation = {
  readonly tableId: string;
  readonly roundId: string;
  readonly gmstatus: number | null;
  readonly playerCardCount: number;
  readonly bankerCardCount: number;
  readonly capturedAt: string;
};

function runtimeStateObservation(raw: string): RuntimeStateObservation | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const tableId = Reflect.get(parsed, 'tableId');
    const roundId = Reflect.get(parsed, 'roundId');
    const gmstatus = Reflect.get(parsed, 'gmstatus');
    const playerCards = Reflect.get(parsed, 'playerCards');
    const bankerCards = Reflect.get(parsed, 'bankerCards');
    const capturedAt = Reflect.get(parsed, 'capturedAt');
    if (
      typeof tableId !== 'string'
      || typeof roundId !== 'string'
      || (gmstatus !== null && (typeof gmstatus !== 'number' || !Number.isFinite(gmstatus)))
      || !Array.isArray(playerCards)
      || !Array.isArray(bankerCards)
      || typeof capturedAt !== 'string'
    ) return undefined;
    return {
      tableId,
      roundId,
      gmstatus,
      playerCardCount: playerCards.length,
      bankerCardCount: bankerCards.length,
      capturedAt,
    };
  } catch {
    return undefined;
  }
}

function observableNetworkCapture(
  message: Extract<BridgeClientMessage, { kind: 'networkCapture' }>,
): Extract<BridgeClientMessage, { kind: 'networkCapture' }> {
  const runtimeState = message.source === 'baccarat-bridge-runtime-state'
    ? runtimeStateObservation(message.data)
    : undefined;
  const pragmaticNetwork = message.source.startsWith('baccarat-bridge-pragmatic-')
    ? pragmaticNetworkObservation(message.data, message.encoding)
    : undefined;
  const runtimeProbe = message.source === 'baccarat-bridge-runtime-probe'
    ? runtimeProbeObservation(message.data)
    : undefined;
  return {
    ...message,
    url: redactedNetworkUrl(message.url),
    data: runtimeState !== undefined
      ? JSON.stringify(runtimeState)
      : pragmaticNetwork !== undefined
        ? JSON.stringify(pragmaticNetwork)
        : runtimeProbe !== undefined
          ? JSON.stringify(runtimeProbe)
        : `[redacted ${message.data.length} bytes]`,
  };
}

function runtimeProbeObservation(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const frameUrl = Reflect.get(value, 'frameUrl');
    return {
      tabId: Reflect.get(value, 'tabId'),
      frameId: Reflect.get(value, 'frameId'),
      frameUrl: typeof frameUrl === 'string' ? redactedNetworkUrl(frameUrl) : '',
      host: typeof Reflect.get(value, 'host') === 'string' ? Reflect.get(value, 'host') : '',
      hook: typeof Reflect.get(value, 'hook') === 'string' ? Reflect.get(value, 'hook') : '',
      replay: typeof Reflect.get(value, 'replay') === 'string' ? Reflect.get(value, 'replay') : '',
      pragmaticNetworkHook: Reflect.get(value, 'pragmaticNetworkHook') === true,
      webSocketName: typeof Reflect.get(value, 'webSocketName') === 'string'
        ? Reflect.get(value, 'webSocketName')
        : '',
      hasDiagnostics: Reflect.get(value, 'diagnostics') !== undefined,
      hasError: typeof Reflect.get(value, 'error') === 'string',
    };
  } catch {
    return undefined;
  }
}

export function pragmaticNetworkObservation(
  raw: string,
  encoding: string | undefined,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    encoding: encoding ?? 'unknown',
    dataLength: raw.length,
  };
  if (encoding !== 'text') return summary;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...summary, format: 'non-json-text' };
  }

  const paths = new Set<string>();
  const tableIds = new Set<string>();
  const roundIds = new Set<string>();
  const eventTypes = new Set<string>();
  let visited = 0;
  const visit = (entry: unknown, path: string, depth: number): void => {
    if (visited >= 300 || depth > 5) return;
    visited += 1;
    if (Array.isArray(entry)) {
      paths.add(`${path}[]`);
      for (const item of entry.slice(0, 40)) visit(item, `${path}[]`, depth + 1);
      return;
    }
    if (typeof entry !== 'object' || entry === null) return;
    for (const [key, nested] of Object.entries(entry)) {
      const keyPath = path ? `${path}.${key}` : key;
      paths.add(keyPath);
      if (typeof nested === 'string') {
        if (/^(?:table|gameTable)(?:_|-)?id$/i.test(key)) tableIds.add(nested.slice(0, 64));
        if (/^(?:round|hand)(?:_|-)?id$/i.test(key)) roundIds.add(nested.slice(0, 64));
        if (/^(?:eventType|event|type|action)$/i.test(key)) eventTypes.add(nested.slice(0, 64));
      }
      visit(nested, keyPath, depth + 1);
    }
  };
  visit(value, '', 0);
  const state = pragmaticGameStateObservation(value);
  return {
    ...summary,
    format: 'json',
    topLevel: Array.isArray(value) ? 'array' : typeof value,
    paths: [...paths].slice(0, 160),
    tableIds: [...tableIds].slice(0, 80),
    roundIds: [...roundIds].slice(0, 80),
    eventTypes: [...eventTypes].slice(0, 80),
    visited,
    ...(state === undefined ? {} : { state }),
  };
}

function pragmaticGameStateObservation(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const kind = ['game', 'timer', 'betsopen', 'card', 'cardinc', 'gameresult']
    .find(candidate => typeof root[candidate] === 'object' && root[candidate] !== null);
  if (kind === undefined) return undefined;
  const record = root[kind] as Record<string, unknown>;
  const safeString = (key: string, pattern: RegExp, maxLength = 64): string | undefined => {
    const candidate = record[key];
    if ((typeof candidate !== 'string' && typeof candidate !== 'number') || !pattern.test(String(candidate))) {
      return undefined;
    }
    return String(candidate).slice(0, maxLength);
  };
  const safeNumber = (key: string): number | undefined => {
    const candidate = record[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
  };
  const safeScalar = (key: string, pattern: RegExp, maxLength = 32): string | number | undefined => {
    const candidate = record[key];
    if (typeof candidate !== 'string' && typeof candidate !== 'number') return undefined;
    const text = String(candidate);
    if (!pattern.test(text)) return undefined;
    return typeof candidate === 'number' ? candidate : text.slice(0, maxLength);
  };
  const table = safeString('table', /^[a-z0-9]{4,32}$/i);
  const game = safeString('game', /^[a-z0-9-]{1,64}$/i) ?? safeString('id', /^[a-z0-9-]{1,64}$/i);
  const gameId = safeString('gameId', /^[a-z0-9-]{1,64}$/i);
  const cardValue = kind === 'card' || kind === 'cardinc'
    ? safeString('value', /^[a-z0-9_-]{1,24}$/i, 24)
    : undefined;
  const place = kind === 'card' || kind === 'cardinc'
    ? safeString('place', /^[a-z0-9_-]{1,24}$/i, 24)
    : undefined;
  const stateValue = kind === 'card' || kind === 'cardinc'
    ? undefined
    : safeScalar('value', /^-?[a-z0-9_.:-]{1,32}$/i);
  const cardCode = kind === 'card'
    ? safeScalar('sc', /^[a-z0-9_-]{1,24}$/i, 24)
    : undefined;
  const cardCount = kind === 'card' ? safeScalar('cardCount', /^\d{1,3}$/) : undefined;
  return {
    kind,
    ...(table === undefined ? {} : { table }),
    ...(game === undefined ? {} : { game }),
    ...(gameId === undefined ? {} : { gameId }),
    ...(stateValue === undefined ? {} : { value: stateValue }),
    ...(cardValue === undefined ? {} : { cardValue }),
    ...(cardCode === undefined ? {} : { cardCode }),
    ...(place === undefined ? {} : { place }),
    ...(cardCount === undefined ? {} : { cardCount }),
    ...(safeNumber('seq') === undefined ? {} : { seq: safeNumber('seq') }),
  };
}

function pragmaticWsFrameCapturePath(): string {
  const cwd = process.cwd().endsWith('desktop')
    ? join(process.cwd(), '..', '..', '.tmp-pragmatic')
    : join(process.cwd(), '.tmp-pragmatic');
  return join(cwd, 'ws-frame-capture.jsonl');
}

function inspectPragmaticBinaryFrame(base64: string): Record<string, unknown> {
  try {
    const bytes = Buffer.from(base64, 'base64');
    const asText = bytes.toString('utf8');
    if (asText.startsWith('<') || asText.startsWith('{') || asText.startsWith('[')) {
      return inspectPragmaticWsFrame(asText);
    }
    return {
      format: 'binary',
      byteLength: bytes.length,
      hex: bytes.subarray(0, 48).toString('hex'),
    };
  } catch {
    return { format: 'binary', note: 'base64-decode-failed', dataLength: base64.length };
  }
}

const PRAGMATIC_CAPTURE_SOURCES = new Set([
  'baccarat-bridge-pragmatic-ws',
  'baccarat-bridge-pragmatic-http',
  'baccarat-bridge-pragmatic-worker',
]);

function capturePragmaticNetworkFrame(
  message: Extract<BridgeClientMessage, { kind: 'networkCapture' }>,
): void {
  if (process.env.PRAGMATIC_WS_CAPTURE !== '1') return;
  if (!PRAGMATIC_CAPTURE_SOURCES.has(message.source)) return;
  const inspection = message.encoding === 'base64'
    ? inspectPragmaticBinaryFrame(message.data)
    : inspectPragmaticWsFrame(message.data);
  const line = JSON.stringify({
    observedAt: new Date().toISOString(),
    source: message.source,
    direction: message.direction,
    encoding: message.encoding,
    dataLength: message.data.length,
    url: redactedNetworkUrl(message.url),
    ...inspection,
  });
  try {
    const target = pragmaticWsFrameCapturePath();
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${line}\n`);
  } catch {
    // Capture is diagnostic only; a filesystem miss must not break the table feed.
  }
}

function logNetworkCapture(message: Extract<BridgeClientMessage, { kind: 'networkCapture' }>): void {
  if (!BRIDGE_DEBUG_ENABLED) return;
  console.log('[bridge-network]', JSON.stringify({
    source: message.source,
    url: redactedNetworkUrl(message.url),
    direction: message.direction,
    encoding: message.encoding,
    dataLength: message.data.length,
  }));
}

function redactedLifecycleMessage(
  message: Extract<BridgeClientMessage, { kind: 'sessionExpired' | 'sessionAction' | 'keepalive' }>,
): BridgeClientMessage {
  if (message.kind === 'sessionExpired') {
    return {
      ...message,
      url: redactedNetworkUrl(message.url),
      textLength: message.textLength ?? message.textPreview?.length ?? 0,
      textPreview: undefined,
    };
  }
  return {
    ...message,
    url: redactedNetworkUrl(message.url),
  };
}

export function redactBridgeDiagnostic(
  message: Extract<BridgeClientMessage, { kind: 'diagnostic' }>,
): Record<string, unknown> {
  return {
    kind: message.kind,
    url: redactedNetworkUrl(message.url),
    frame: message.frame,
    readyState: message.readyState,
    titleLength: message.titleLength ?? message.title?.length ?? 0,
    bodyTextLength: message.bodyTextLength ?? message.bodyTextPreview?.length ?? 0,
    htmlLength: message.htmlLength ?? message.htmlPreview?.length ?? 0,
    candidateCount: message.candidateCount,
    canvasCount: message.canvasCount,
    videoCount: message.videoCount,
    iframeCount: message.iframeCount,
  };
}

function isBridgeCommand(value: unknown): value is Extract<BridgeClientMessage, { kind: 'command' }> {
  const tableIds = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Reflect.get(value, 'tableIds')
    : undefined;
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Reflect.get(value, 'kind') === 'command'
    && typeof Reflect.get(value, 'name') === 'string'
    && (
      tableIds === undefined
      || (Array.isArray(tableIds) && tableIds.every(tableId => typeof tableId === 'string'))
    );
}

class BridgeTableExport implements TableExport {
  readonly tableId: string;
  private readonly roomId: string;

  private sink?: TableExportSink;
  private started = false;
  private stopped = false;
  private paused = false;
  private state: MonitorConnectionState = 'DISCONNECTED';
  private cursor: TableCursor;
  private pending: NormalizedEvent[] = [];
  private processing = false;
  private drainRequested = false;
  private error?: Error;
  private lastEmittedSeq = 0;
  private reconnectCount = 0;
  private flushWaiters: Array<() => void> = [];
  private restoreInFlight?: Promise<void>;
  private lastObservationAt: number;
  private shuffleHoldUntil = 0;
  private transportContinuous = true;
  private disconnectReason?: string;
  private pendingOverflowed = false;
  /**
   * FIX(P1-11): 桥独立记录"上一事件的真实 payload hash"。
   *
   * 以前 cursor.payloadHash 写的是 event.eventId（不是 hash），且没有任何代码校验它，
   * 所谓 cursor-v1 continuity proof 完全由桥自己用"自己的 cursor + 自己刚收到的事件"生成
   * （自证）。现在：
   *  - cursor.payloadHash 改为真实的 sha256(stableStringify(event))；
   *  - restoreFromPending 生成 proof 前，先校验 pending 里下一条候选事件确实与本对象
   *    独立记录的 hash 一致（`verifiedPayloadHash`），否则不恢复、保持 DISCONNECTED。
   * 攻击者仍可伪造事件进入 pending，但**必须**先让桥 ingest 到一条真实事件，
   * 才能在游标里留下可被后续恢复校验的 hash —— 这拦住了"新 session 任意一条消息就恢复"。
   */
  private lastVerifiedPayloadHash = '';
  /** 与 cursor.sourceSeq 对应的、桥独立计算的 payload hash（恢复校验基准）。 */
  private lastVerifiedSeq = 0;
  /**
   * FIX(P1-11): 仅由 `restoreFromPending()` 在校验通过后写入，`handleRestored()` 消费一次。
   * 任何其它路径（未来的新入口/测试直调）都拿不到匹配的 proof，恢复请求会被拒绝。
   */
  private pendingRestoreProof?: string;

  constructor(
    roomId: string,
    tableId: string,
    private readonly staleAfterMs: number,
    private readonly onDisconnected?: (tableId: string, reason: string) => void,
    private readonly onObserved?: (tableId: string) => void,
    private readonly onContinuityRejected?: (tableId: string, reason: string) => void,
  ) {
    this.roomId = roomId;
    this.tableId = tableId;
    this.cursor = { tableId, sourceSeq: 0, eventId: '', payloadHash: '' };
    this.lastObservationAt = Date.now();
  }

  async start(sink: TableExportSink, cursor?: TableCursor): Promise<void> {
    if (this.started) {
      throw new Error(`BridgeTableExport ${this.tableId} already started`);
    }
    this.sink = sink;
    this.started = true;
    this.stopped = false;
    this.paused = false;
    this.error = undefined;
    this.pendingOverflowed = false;
    this.state = 'CONNECTED';
    if (cursor) {
      if (cursor.tableId !== this.tableId) {
        throw new Error(`cursor.tableId ${cursor.tableId} does not match export table ${this.tableId}`);
      }
      this.cursor = { ...cursor };
      this.pending = this.pending.filter(event => event.sourceSeq > cursor.sourceSeq);
    }
    void this.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.paused = true;
    this.state = 'DISCONNECTED';
  }

  async flush(): Promise<void> {
    while (this.processing || this.restoreInFlight !== undefined) {
      await new Promise<void>(resolve => this.flushWaiters.push(resolve));
    }
    if (this.error) {
      throw this.error;
    }
  }

  async keepAlive(): Promise<MonitorKeepAliveResult> {
    const stalenessMs = Math.max(0, Date.now() - this.lastObservationAt);
    const ok = this.started
      && !this.stopped
      && this.state === 'CONNECTED'
      && stalenessMs <= this.staleAfterMs;
    return {
      ok,
      latencyMs: stalenessMs,
      ...(ok ? {} : { error: this.error?.message ?? (stalenessMs > this.staleAfterMs ? 'table-feed-stale' : 'not connected') }),
    };
  }

  health(): MonitorHealth {
    return {
      tableId: this.tableId,
      state: this.state,
      lastAckedSeq: this.cursor.sourceSeq,
      lastEmittedSeq: this.lastEmittedSeq,
      bufferDepth: this.pending.length,
      reconnectCount: this.reconnectCount,
      lastObservationAt: new Date(this.lastObservationAt).toISOString(),
      stalenessMs: Math.max(0, Date.now() - this.lastObservationAt),
      ...(this.error ? { lastError: this.error.message } : {}),
    };
  }

  ingestEvent(event: NormalizedEvent): void {
    // FIX(C-P1-3): 溢出后不能无条件吞掉一切事件 —— 那会让本对象永久静默。
    //
    // 溢出时 pending 被裁剪、中间一段 sourceSeq 永久丢失，`transportContinuous`
    // 也因此失效；此时唯一合法的出口是"实体新靴重置"（它允许跳号重建库存）。
    // 但修复前这里在 `pendingOverflowed` 时对**所有**事件 return，连那条唯一的
    // 实体洗牌信号也被吞掉，`drain()`/`restoreFromPending()` 再也不会被调用，
    // 于是该桌永久不可恢复（b9b 实证 5 条 handSettled 全丢）。
    //
    // 现在：溢出后仍放行 `newShoeSignal(baseline='physical-shoe')`，它是协议层
    // 给出的"可以跳号重建"的权威信号，放行后 drain → restoreFromPending 会
    // 走 physicalReset 分支把 export 救回 CONNECTED 并复位 pendingOverflowed。
    // 其它事件继续丢弃（它们已无法与丢掉的 seq 对齐，留着只会污染）。
    if (this.stopped) return;
    if (this.pendingOverflowed) {
      const isPhysicalReset = event.type === 'newShoeSignal'
        && event.baseline === 'physical-shoe';
      if (!isPhysicalReset) return;
    }
    this.noteObservation();
    if (event.type === 'newShoeSignal') this.shuffleHoldUntil = Date.now() + SHUFFLE_HOLD_MS;
    this.pending.push(event);
    if (this.pending.length > TABLE_EXPORT_PENDING_LIMIT) {
      this.overflowPendingBuffer();
      return;
    }
    if (this.started) {
      void this.drain();
    }
  }

  /**
   * 缓冲已经涨到上限，说明我们既不消费、也无法恢复（典型是 paused 且等不到
   * 可重放的实体洗牌）。继续堆积只会把进程 OOM 掉，所以保留最近一段用于
   * 诊断、其余丢弃，并主动承认连接已断开，交回上层做重连/移除。
   *
   * FIX(C-P1-3): 修复前这里只置 `pendingOverflowed = true` 就返回，而
   * `ingestEvent()` 在 `pendingOverflowed` 时直接 return —— `drain()` 再也不会被调用，
   * `handleRestored()` 唯一的两条触发路径（`drain()` / `noteObservation()`）全断，
   * 于是该桌此后所有事件静默丢失、永久不可恢复（b9b 实证 5 条 handSettled 全丢）。
   * 现在裁剪后立刻尝试 drain 一次：只要消费者已经恢复（慢消费者结束、shuffle hold
   * 到期），`restoreFromPending()` 就能在这条调用里把 pending 排空并把该桌救回
   * CONNECTED。drain 内部有 `processing` 单飞保护，不会递归。
   */
  private overflowPendingBuffer(): void {
    this.pending = this.pending.slice(-TABLE_EXPORT_PENDING_LIMIT);
    this.pendingOverflowed = true;
    const reason = `table-export-buffer-overflow:${this.tableId}`;
    this.error = new Error(
      `pending buffer for ${this.tableId} exceeded ${TABLE_EXPORT_PENDING_LIMIT} events`,
    );
    this.handleDisconnect(reason);
    // FIX(C-P1-3): 立即尝试自愈。此刻若消费者仍卡住，drain 会安全地失败返回，
    // 状态保持 DISCONNECTED（由 noteObservation 的恢复分支兜底）；若消费者已恢复，
    // 则在这一条调用里直接恢复，不必等下一次事件（下一次事件本来也会被丢）。
    if (this.started && !this.stopped) {
      void this.drain();
    }
  }

  noteObservation(): void {
    this.lastObservationAt = Date.now();
    this.onObserved?.(this.tableId);
    // FIX(C-P1-3): 恢复分支从"只认 table-feed-stale"扩展为"也认导出缓冲溢出"。
    // 溢出后该桌仍可能有观测活动（DOM 心跳、其它 frame 的 noteObservation），
    // 只要还有观测就说明链路活着、值得尝试恢复 —— 否则 pendingOverflowed
    // 只能靠 ingestEvent 复位，而 ingestEvent 在 pendingOverflowed 时直接 return，
    // 形成死锁。两条改动互为保险：drain 覆盖"消费者恢复"场景，本分支覆盖
    // "后续观测到达"场景。
    const recoverableDisconnect = this.disconnectReason === 'table-feed-stale'
      || (this.disconnectReason?.startsWith('table-export-buffer-overflow:') ?? false);
    if (
      this.started
      && !this.stopped
      && this.state === 'DISCONNECTED'
      && recoverableDisconnect
    ) {
      // FIX(P1-11): stale 恢复也必须过"上一游标与桥独立记录一致"的校验，
      // proof 由 verifiedRestoreProof() 统一生成（不再是任意 shaped 字符串）。
      void this.restoreFromObservation();
    }
  }

  private async restoreFromObservation(): Promise<void> {
    const proof = this.verifiedRestoreProof({
      tableId: this.tableId,
      // FIX(C-P1-3): 溢出恢复与 stale 恢复共用这条路径，reason 要能区分二者，
      // 否则排障时会把"缓冲溢出"误读成"数据流变陈旧"。
      reason: this.disconnectReason?.startsWith('table-export-buffer-overflow:') === true
        ? 'table-export-buffer-overflow-resume'
        : 'table-feed-stale-resume',
      observedAt: this.lastObservationAt,
    });
    if (proof === undefined) {
      this.rejectContinuity(
        `restore-cursor-mismatch:${this.tableId}`,
        'previous cursor payload hash does not match the bridge payload hash',
      );
      return;
    }
    await this.handleRestored(proof);
  }

  /**
   * FIX(P1-11): 生成"可被 handleRestored 接受"的 proof。
   *
   * 前置条件（唯一授权来源）：
   *  - 游标自洽：`cursor.sourceSeq` 与桥独立记录的 `lastVerifiedSeq` 一致，
   *    且 `cursor.payloadHash` 与 `lastVerifiedPayloadHash` 一致；
   *  - 调用方提供的证据（observation 或"上一游标 + 下一条真实事件 hash"）。
   *
   * 不满足时返回 undefined，调用方必须放弃恢复。
   */
  private verifiedRestoreProof(evidence: Record<string, unknown>): string | undefined {
    if (this.cursor.sourceSeq > 0) {
      if (this.lastVerifiedSeq !== this.cursor.sourceSeq) return undefined;
      if (this.cursor.payloadHash !== this.lastVerifiedPayloadHash) return undefined;
    }
    const proof = cursorContinuityProof(evidence);
    this.pendingRestoreProof = proof;
    return proof;
  }

  markTransportContinuous(): void {
    this.transportContinuous = true;
  }

  invalidateTransportContinuity(reason: string): void {
    this.transportContinuous = false;
    this.handleDisconnect(reason);
  }

  checkFreshness(now = Date.now()): void {
    if (!this.started || this.stopped || this.state !== 'CONNECTED') return;
    if (now < this.shuffleHoldUntil) return;
    if (now - this.lastObservationAt <= this.staleAfterMs) return;
    this.handleDisconnect('table-feed-stale');
  }

  handleDisconnect(reason?: string): void {
    if (this.stopped) return;
    const changed = this.state !== 'DISCONNECTED' || !this.paused;
    console.error('[bridge-table-disconnect]', this.tableId, reason ?? '');
    this.paused = true;
    this.state = 'DISCONNECTED';
    this.disconnectReason = reason ?? 'table-disconnected';
    if (!changed) return;
    this.sink?.onDisconnect?.(this.tableId, reason);
    this.onDisconnected?.(this.tableId, reason ?? 'table-disconnected');
  }

  async handleRestored(proof: string): Promise<void> {
    if (this.stopped) return;
    if (!isValidContinuityProof(proof)) return;
    if (this.state === 'CONNECTED' && !this.paused) {
      this.pendingRestoreProof = undefined;
      return;
    }
    // FIX(P1-11): 只接受桥自己用**已校验游标**生成的 proof。
    //
    // 以前这里只校验 proof 的字符串形状，任何调用方给一个 `cursor-v1:<64hex>` 就能把导出
    // 恢复成 CONNECTED —— 连续性证明是自证的。现在 proof 必须与本对象刚刚记下的
    // `pendingRestoreProof` 完全一致，而那一份是在校验过
    // "上一游标 payloadHash === 桥独立记录的上一事件 hash" 之后才生成的。
    // 不匹配 → 保持 DISCONNECTED，并交给上层记 continuity-invalidated 事故。
    const expectedProof = this.pendingRestoreProof;
    this.pendingRestoreProof = undefined;
    if (expectedProof === undefined || expectedProof !== proof) {
      this.rejectContinuity(
        `restore-proof-rejected:${this.tableId}`,
        'unverified restore proof',
      );
      return;
    }
    if (this.restoreInFlight !== undefined) {
      await this.restoreInFlight;
      return;
    }
    this.error = undefined;
    // 恢复流程会重新消费 pending；允许再次接收事件，否则溢出后会永久静默。
    this.pendingOverflowed = false;
    try {
      const restored = this.sink?.onRestored?.(this.tableId, proof);
      if (restored !== undefined) {
        this.restoreInFlight = restored;
        await restored;
      }
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.state = 'DISCONNECTED';
      this.paused = true;
      this.resolveFlushWaiters();
      return;
    } finally {
      this.restoreInFlight = undefined;
    }
    if (this.stopped) return;
    this.paused = false;
    this.state = 'CONNECTED';
    this.disconnectReason = undefined;
    this.reconnectCount += 1;
    void this.drain();
  }

  /** 连续性证明被拒绝：保持 DISCONNECTED，并把原因交给上层记 incident。 */
  private rejectContinuity(reason: string, detail: string): void {
    this.transportContinuous = false;
    this.error = new Error(`${reason}: ${detail}`);
    console.error('[bridge-continuity-rejected]', this.tableId, reason, detail);
    this.handleDisconnect(reason);
    this.onContinuityRejected?.(this.tableId, reason);
  }

  /**
   * FIX(P1-11): 上一游标自洽校验 + 下一条事件的真实 payload hash。
   *
   * 返回 undefined 表示"当前游标与桥独立记录不一致"，调用方必须放弃恢复。
   */
  private verifiedNextEventHash(nextEvent: NormalizedEvent): string | undefined {
    if (this.cursor.sourceSeq > 0) {
      if (this.lastVerifiedSeq !== this.cursor.sourceSeq) return undefined;
      if (this.cursor.payloadHash !== this.lastVerifiedPayloadHash) return undefined;
    }
    return sha256(stableStringify(nextEvent));
  }
  private async drain(): Promise<void> {
    if (this.processing) {
      this.drainRequested = true;
      return;
    }
    this.processing = true;
    try {
      if (this.paused && !(await this.restoreFromPending())) return;
      while (!this.stopped && this.started && !this.paused && this.pending.length > 0) {
        const event = this.pending[0]!;
        if (event.sourceSeq <= this.cursor.sourceSeq) {
          this.pending.shift();
          continue;
        }
        const isPhysicalReset = event.type === 'newShoeSignal'
          && event.baseline === 'physical-shoe';
        if (!isPhysicalReset && event.sourceSeq !== this.cursor.sourceSeq + 1) {
          const reason =
            `continuity gap for ${this.tableId}: expected ${this.cursor.sourceSeq + 1}, got ${event.sourceSeq}`;
          this.transportContinuous = false;
          this.error = new Error(reason);
          this.handleDisconnect(reason);
          return;
        }
        const payloadHash = sha256(stableStringify(event));
        const batch: TableEventBatch = {
          tableId: this.tableId,
          events: [event],
          cursor: {
            tableId: this.tableId,
            sourceSeq: event.sourceSeq,
            eventId: event.eventId,
            // FIX(P1-11): 真实 payload hash，不再是 eventId（两者语义完全不同）。
            payloadHash,
          },
          kind: this.cursor.sourceSeq > 0 ? 'replay' : 'live',
        };
        await this.sink!.onBatch(batch);
        this.pending.shift();
        this.cursor = batch.cursor;
        this.lastVerifiedPayloadHash = payloadHash;
        this.lastVerifiedSeq = event.sourceSeq;
        this.lastEmittedSeq = event.sourceSeq;
      }
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.handleDisconnect(this.error.message);
    } finally {
      this.processing = false;
      this.resolveFlushWaiters();
      if (this.drainRequested) {
        this.drainRequested = false;
        void this.drain();
      }
    }
  }

  private async restoreFromPending(): Promise<boolean> {
    while (this.pending[0] && this.pending[0].sourceSeq <= this.cursor.sourceSeq) {
      this.pending.shift();
    }
    if (!this.transportContinuous) {
      const physicalResetIndex = this.pending.findIndex(event =>
        event.type === 'newShoeSignal' && event.baseline === 'physical-shoe');
      if (physicalResetIndex < 0) return false;
      this.pending.splice(0, physicalResetIndex);
    }
    const nextEvent = this.pending[0];
    if (nextEvent === undefined) return false;
    const isPhysicalReset = nextEvent.type === 'newShoeSignal'
      && nextEvent.baseline === 'physical-shoe';
    if (!isPhysicalReset && !this.transportContinuous) return false;
    if (!isPhysicalReset && nextEvent.sourceSeq !== this.cursor.sourceSeq + 1) {
      this.transportContinuous = false;
      this.error = new Error(
        `continuity gap for ${this.tableId}: expected ${this.cursor.sourceSeq + 1}, got ${nextEvent.sourceSeq}`,
      );
      return false;
    }
    // FIX(P1-11): 先校验上一游标与桥独立记录真实的 payload hash 一致，再生成 proof。
    // 不一致（游标被外部改写 / 事件被识别为伪造）→ 放弃恢复，保持 DISCONNECTED。
    const nextPayloadHash = this.verifiedNextEventHash(nextEvent);
    if (nextPayloadHash === undefined) {
      this.rejectContinuity(
        `restore-cursor-mismatch:${this.tableId}`,
        'previous cursor payload hash does not match the bridge payload hash',
      );
      return false;
    }
    const proof = cursorContinuityProof({
      tableId: this.tableId,
      previousCursor: this.cursor,
      nextEvent: {
        sourceSeq: nextEvent.sourceSeq,
        eventId: nextEvent.eventId,
        payloadHash: nextPayloadHash,
      },
      physicalReset: isPhysicalReset,
    });
    // 只把这份刚生成的 proof 授权给紧随其后的 handleRestored()，一次性消费。
    this.pendingRestoreProof = proof;
    await this.handleRestored(proof);
    if (this.state === 'CONNECTED' && !this.paused) this.transportContinuous = true;
    return this.state === 'CONNECTED' && !this.paused;
  }

  private resolveFlushWaiters(): void {
    const waiters = this.flushWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

export class BrowserBridgeServer implements RoomMonitor {
  private readonly options: BrowserBridgeServerOptions;
  private readonly betTimeoutMs: number;
  private wss?: WebSocketServer;
  private sockets = new Set<WebSocket>();
  private observers = new Set<WebSocket>();
  private commandClients = new Set<WebSocket>();
  private rooms = new Map<string, BridgeRoomDescriptor>();
  private discoveredRooms = new Map<string, BridgeRoomDescriptor>();
  private exports = new Map<string, BridgeTableExport>();
  private pendingBets = new Map<string, PendingBet>();
  private readonly tableExecutionTails = new Map<string, Promise<void>>();
  /**
   * 平台适配器：注册表顺序 [pragmatic, bg, winfinity]。
   * 第一个为默认平台（roomIdForTable 兜底），其余按倒序参与归属判定。
   */
  private readonly platformAdapters: readonly BridgePlatformAdapter[];
  private readonly defaultAdapter: BridgePlatformAdapter;
  private readonly adaptersByRoomId = new Map<string, BridgePlatformAdapter>();
  private readonly lastIngestedShoeByTable = new Map<string, string>();
  private readonly bgShoeSequenceSeed = new Map<string, number>();
  private readonly parsedSourceSeqByTable = new Map<string, number>();
  private readonly parsedEventIds = new Set<string>();
  private readonly protocolObservationStartedAt = new Map<string, number>();
  private readonly protocolLastObservedAt = new Map<string, number>();
  private readonly runtimeStateLastObservedAt = new Map<string, number>();
  private readonly runtimeStateStaleTableIds = new Set<string>();
  private visibleTableIds = new Set<string>();
  private configuredSelectedTables: ReadonlySet<string> | undefined;
  private runtimeSelectedTables: ReadonlySet<string> | undefined;
  private effectiveSelectedTables: ReadonlySet<string> | undefined;
  private readonly tableStaleAfterMs: number;
  private readonly extensionHeartbeatTimeoutMs: number;
  private readonly extensionDisconnectGraceMs: number;
  private readonly requireExtensionSequence: boolean;
  private extensionDisconnectTimer?: NodeJS.Timeout;
  private freshnessTimer?: NodeJS.Timeout;
  private readonly socketLastSeenAt = new Map<WebSocket, number>();
  private readonly socketHeartbeatStrikes = new Map<WebSocket, number>();
  private readonly socketBridgeSession = new Map<WebSocket, string>();
  private readonly lastBridgeSeqBySession = new Map<string, number>();
  private activeBridgeSessionId?: string;
  private extensionConnected = false;
  private port = 0;
  private readonly executorLeases = new ExecutorLeaseRegistry();
  private readonly socketExecutorProfile = new Map<WebSocket, string>();
  private readonly socketExecutorClaimant = new Map<WebSocket, string>();

  /**
   * FIX(P0-1): 待批准扩展连接。
   *
   * 与 `sockets`（唯一扩展槽）完全分开：pending 连接不占槽、不进 `getExtensionStatus()`、
   * 不拿 lease、不 ingest 任何事件。installId 缺失的连接也会进来（installId 为 undefined），
   * 它们在 `listPendingExtensions()` 里以 `unidentified-*` 形式暴露给操作员。
   */
  private readonly pendingExtensionSockets = new Map<WebSocket, string | undefined>();
  /** 每个 socket 的角色快照：批准后需要把 pending socket 就地提升为 extension。 */
  private readonly socketRole = new Map<WebSocket, BridgeSocketRole>();
  /**
   * pending 连接的桥侧首次/最后出现时间（store 不实现 notePending 时的兜底，
   * 也是 `listPendingExtensions()` 的即时视图）。
   */
  private readonly pendingExtensionSeenAt = new Map<string, { firstSeenAt: string; lastSeenAt: string }>();
  /** 每个 extension 角色 socket 绑定的 installId（撤销/审计用，不对外暴露）。 */
  private readonly socketInstallId = new Map<WebSocket, string>();
  private readonly extensionApprovals?: BridgeExtensionApprovalStore;
  private readonly allowUnapprovedExtensions: boolean;

  constructor(options: BrowserBridgeServerOptions = {}) {
    this.options = options;
    this.platformAdapters = PLATFORM_REGISTRY.getAll().map(descriptor => {
      switch (descriptor.platformId) {
        case PRAGMATIC_PLATFORM_ID: return new PragmaticPlatformAdapter(descriptor);
        case BG_PLATFORM_ID: return new BgPlatformAdapter(descriptor);
        case WINFINITY_PLATFORM_ID: return new WinfinityPlatformAdapter(descriptor);
        default: throw new Error(`no bridge platform adapter registered for '${descriptor.platformId}'`);
      }
    });
    this.defaultAdapter = this.platformAdapters[0]!;
    for (const adapter of this.platformAdapters) {
      this.adaptersByRoomId.set(adapter.descriptor.roomId, adapter);
    }
    this.betTimeoutMs = options.betTimeoutMs ?? 10_000;
    this.tableStaleAfterMs = Math.max(1_000, options.tableStaleAfterMs ?? TABLE_STALE_AFTER_MS);
    this.extensionHeartbeatTimeoutMs = Math.max(
      1_000,
      options.extensionHeartbeatTimeoutMs ?? EXTENSION_HEARTBEAT_TIMEOUT_MS,
    );
    this.extensionDisconnectGraceMs = Math.max(
      0,
      options.extensionDisconnectGraceMs ?? EXTENSION_DISCONNECT_GRACE_MS,
    );
    this.requireExtensionSequence = options.requireExtensionSequence ?? false;
    // FIX(P0-1): 传 store = 严格模式；不传 store 时默认兼容放行（旧单测/demo 语义）。
    // 显式 allowUnapprovedExtensions: false 在无 store 时等于「没有任何已批准 installId」。
    this.extensionApprovals = options.extensionApprovals;
    this.allowUnapprovedExtensions = options.extensionApprovals !== undefined
      ? false
      : (options.allowUnapprovedExtensions ?? true);
    this.configuredSelectedTables = options.selectedTableIds === undefined
      ? undefined
      : new Set(
        options.selectedTableIds
          .map(tableId => tableId.trim())
          .filter(tableId => tableId.length > 0),
      );
    this.refreshEffectiveSelectedTables();
  }

  /**
   * FIX(P0-1): 扩展 installId 是否放行。
   *
   * 缺 installId 一律不放行（返回 false → pending）。兼容模式只放宽「带 installId 但未批准」，
   * 否则伪造 Origin+token 的本机进程（b7d 攻击面）仍能接管扩展槽。
   */
  private isExtensionInstallApproved(installId: string | undefined): boolean {
    const normalized = normalizeExtensionInstallId(installId);
    if (normalized === undefined) return false;
    if (this.extensionApprovals?.isApproved(normalized) === true) return true;
    return this.allowUnapprovedExtensions;
  }

  // -- 操作员批准面（桌面端接线用） ------------------------------------------

  /** 当前待批准的扩展身份（含桥侧即时观测，未落盘）。installId 仅本地可见。 */
  listPendingExtensions(): BridgeExtensionPendingEntry[] {
    return [...this.pendingExtensionSeenAt.entries()]
      .map(([installId, seen]) => ({ installId, ...seen }))
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  /** 便捷视图：当前待批准连接的 installId 列表（不含 store 里历史 pending）。 */
  getExtensionPendingInstallIds(): string[] {
    return [...new Set(
      [...this.pendingExtensionSockets.values()].filter((value): value is string => value !== undefined),
    )];
  }

  /** 操作员批准某个 installId：立即把该 installId 的 pending socket 提升为 extension 角色。 */
  approveExtension(installId: string): void {
    const normalized = normalizeExtensionInstallId(installId);
    if (normalized === undefined) throw new Error('invalid extension install id');
    this.extensionApprovals?.approve(normalized);
    this.pendingExtensionSeenAt.delete(normalized);
    this.extensionApprovals?.forgetPending(normalized);
    for (const [socket, pendingInstallId] of [...this.pendingExtensionSockets]) {
      if (pendingInstallId !== normalized) continue;
      this.promotePendingExtension(socket, normalized);
    }
  }

  /** 撤销批准：断开正在使用该 installId 的扩展连接（若有）。 */
  revokeExtension(installId: string): void {
    const normalized = normalizeExtensionInstallId(installId);
    if (normalized === undefined) return;
    this.extensionApprovals?.revoke(normalized);
    this.pendingExtensionSeenAt.delete(normalized);
    for (const [socket, role] of [...this.socketRole]) {
      if (role !== 'extension') continue;
      if (this.socketInstallId.get(socket) !== normalized) continue;
      socket.close(1008, 'extension approval revoked');
    }
  }

  /** 批准状态快照（桌面端用于渲染「待批准 / 已批准」列表）。 */
  getExtensionApprovalState(): {
    readonly strict: boolean;
    readonly allowUnapprovedExtensions: boolean;
    readonly approved: string[];
    readonly pending: BridgeExtensionPendingEntry[];
    readonly pendingConnections: number;
    readonly unidentifiedPendingConnections: number;
  } {
    const pending = this.listPendingExtensions();
    let unidentifiedPendingConnections = 0;
    for (const installId of this.pendingExtensionSockets.values()) {
      if (installId === undefined) unidentifiedPendingConnections += 1;
    }
    return {
      strict: this.extensionApprovals !== undefined || !this.allowUnapprovedExtensions,
      allowUnapprovedExtensions: this.allowUnapprovedExtensions,
      approved: this.extensionApprovals?.listApproved() ?? [],
      pending,
      pendingConnections: this.pendingExtensionSockets.size,
      unidentifiedPendingConnections,
    };
  }

  async start(): Promise<number> {
    if (this.wss) return this.port;
    const wss = new WebSocketServer({
      port: this.options.port ?? 0,
      host: this.options.host ?? '127.0.0.1',
      // ws 默认 maxPayload 是 100MB。桥只跑在本机回环上，但没有上限就意味着
      // 一个畸形/失控的客户端（扩展或本机进程）能把进程直接撑爆。
      maxPayload: MAX_BRIDGE_MESSAGE_BYTES,
      verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) => {
        // 注意：ws 对不带 Origin 头的客户端会传 undefined（类型声明是 string）。
        // 这里必须按 unknown 处理，否则本地进程只要不发 Origin 就能让 verifyClient 抛错。
        const origin = typeof info.origin === 'string' ? info.origin : '';
        const role = bridgeSocketRole(
          origin,
          info.req.url,
          this.options,
          installId => this.isExtensionInstallApproved(installId),
        );
        if (role === null && origin.startsWith('chrome-extension://')) {
          this.emitRuntimeEvent({
            kind: 'extension-auth-failed',
            reason: 'extension identity or token rejected',
            timestamp: new Date().toISOString(),
          });
        }
        return role !== null;
      },
    });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    this.wss = wss;
    const address = wss.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    wss.on('connection', (socket, request) => {
      const role = bridgeSocketRole(
        String(request.headers.origin ?? ''),
        request.url,
        this.options,
        installId => this.isExtensionInstallApproved(installId),
      );
      if (role === null) {
        socket.close(1008, 'unauthorized bridge client');
        return;
      }
      this.socketRole.set(socket, role);
      if (role === 'observer') {
        this.observers.add(socket);
      } else if (role === 'command') {
        this.commandClients.add(socket);
      } else if (role === 'extension-pending') {
        // FIX(P0-1): 未批准的扩展身份只能停在 pending：不占唯一扩展槽、不拿 lease、
        // 不 ingest 任何事件。批准后由 approveExtension() 就地提升。
        this.registerPendingExtension(socket, extensionInstallIdFromRequestUrl(request.url));
      } else {
        this.admitExtensionSocket(socket, extensionInstallIdFromRequestUrl(request.url));
      }
      socket.on('message', data => {
        if (role === 'observer') return;
        try {
          const message: unknown = JSON.parse(data.toString());
          const currentRole = this.socketRole.get(socket) ?? role;
          if (currentRole === 'command' && !isBridgeCommand(message)) return;
          if (currentRole === 'extension-pending') {
            // pending 连接只接受"我在等批准"的回执与心跳，其它一律丢弃。
            if (!this.isPendingExtensionControlMessage(message)) return;
            this.touchPendingExtension(socket);
            return;
          }
          if (currentRole === 'extension') {
            this.socketLastSeenAt.set(socket, Date.now());
            if (!this.acceptExtensionSequence(message, socket)) return;
          }
          this.ingestClientMessage(message, socket);
        } catch {
          // ignore malformed messages from untrusted extensions
        }
      });
      socket.on('error', () => {
        if ((this.socketRole.get(socket) ?? role) !== 'extension') return;
        this.rejectPendingBets(new Error(LIVE_BET_CONNECTION_LOST_ERROR), socket);
      });
      socket.on('close', (code, rawReason) => {
        const currentRole = this.socketRole.get(socket) ?? role;
        this.socketRole.delete(socket);
        this.pendingExtensionSockets.delete(socket);
        if (currentRole === 'observer') {
          this.observers.delete(socket);
          return;
        }
        if (currentRole === 'command') {
          this.commandClients.delete(socket);
          return;
        }
        if (currentRole === 'extension-pending') return;
        this.rejectPendingBets(new Error(LIVE_BET_CONNECTION_LOST_ERROR), socket);
        const claimantId = this.socketExecutorClaimant.get(socket);
        if (claimantId) this.executorLeases.release(claimantId);
        this.sockets.delete(socket);
        this.socketLastSeenAt.delete(socket);
        this.socketHeartbeatStrikes.delete(socket);
        this.socketBridgeSession.delete(socket);
        this.socketExecutorProfile.delete(socket);
        this.socketExecutorClaimant.delete(socket);
        this.socketInstallId.delete(socket);
        if (this.sockets.size === 0 && this.extensionConnected) {
          this.scheduleExtensionDisconnect(rawReason.toString() || `websocket-close-${code}`);
        }
      });
      socket.send(JSON.stringify({
        kind: 'welcome',
        serverVersion: '0.1.0',
        timestamp: new Date().toISOString(),
      } satisfies BridgeServerMessage));
      if (role === 'extension-pending') {
        // 明确的配对信号：客户端据此提示操作员"去桌面端点批准"。
        this.sendPairingRequired(socket, extensionInstallIdFromRequestUrl(request.url));
      }
    });
    this.ensureFreshnessTimer();
    return this.port;
  }

  async close(): Promise<void> {
    this.clearExtensionDisconnectGrace();
    if (this.freshnessTimer) {
      clearInterval(this.freshnessTimer);
      this.freshnessTimer = undefined;
    }
    if (this.extensionConnected) {
      this.finalizeExtensionDisconnect('browser-bridge-stopped');
    }
    for (const socket of [...this.sockets, ...this.observers, ...this.commandClients, ...this.pendingExtensionSockets.keys()]) {
      socket.close();
    }
    this.sockets.clear();
    this.observers.clear();
    this.commandClients.clear();
    this.pendingExtensionSockets.clear();
    this.socketRole.clear();
    this.pendingExtensionSeenAt.clear();
    this.socketLastSeenAt.clear();
    this.socketHeartbeatStrikes.clear();
    this.socketBridgeSession.clear();
    this.socketExecutorProfile.clear();
    this.socketExecutorClaimant.clear();
    this.socketInstallId.clear();
    this.executorLeases.clear();
    if (this.wss) {
      const wss = this.wss;
      this.wss = undefined;
      await new Promise<void>(resolve => wss.close(() => resolve()));
    }
    this.rejectPendingBets(new Error('browser bridge stopped before bet result'));
  }

  // -- FIX(P0-1): pending / approval 生命周期 --------------------------------

  /**
   * 登记一条待批准的扩展连接。
   *
   * 关键：**不加入 `this.sockets`**，因此 `getExtensionStatus().connectionCount` 不含它、
   * `setLiveBetEnabled()`/`requestBet()` 也看不到它；它也不会挤掉真扩展。
   */
  private registerPendingExtension(socket: WebSocket, rawInstallId: string | undefined): void {
    const installId = normalizeExtensionInstallId(rawInstallId);
    this.pendingExtensionSockets.set(socket, installId);
    this.socketRole.set(socket, 'extension-pending');
    this.socketLastSeenAt.set(socket, Date.now());
    const now = new Date().toISOString();
    if (installId !== undefined) {
      const previous = this.pendingExtensionSeenAt.get(installId);
      this.pendingExtensionSeenAt.set(installId, {
        firstSeenAt: previous?.firstSeenAt ?? now,
        lastSeenAt: now,
      });
      // store 若实现了 recordPending（落盘实现通常需要），同步一份。
      const store = this.extensionApprovals as
        | (BridgeExtensionApprovalStore & { recordPending?: (id: string) => void })
        | undefined;
      try {
        store?.recordPending?.(installId);
      } catch {
        // 落盘失败不能拖垮连接：桥侧内存视图仍然有效。
      }
    }
    this.emitRuntimeEvent({
      kind: 'extension-pairing-required',
      installId: installId ?? '',
      timestamp: now,
    });
  }

  private touchPendingExtension(socket: WebSocket): void {
    const installId = this.pendingExtensionSockets.get(socket);
    this.socketLastSeenAt.set(socket, Date.now());
    if (installId === undefined) return;
    const now = new Date().toISOString();
    const previous = this.pendingExtensionSeenAt.get(installId);
    this.pendingExtensionSeenAt.set(installId, {
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
    });
  }

  /** pending socket 只允许这两类消息；其它消息（tableEvent/betResult/hello/…）一律丢弃。 */
  private isPendingExtensionControlMessage(message: unknown): boolean {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
    const kind = Reflect.get(message, 'kind');
    return kind === 'pairingAck' || kind === 'heartbeat' || kind === 'keepalive';
  }

  private sendPairingRequired(socket: WebSocket, rawInstallId: string | undefined): void {
    const installId = normalizeExtensionInstallId(rawInstallId);
    const payload: BridgeServerMessage = {
      kind: 'pairingRequired',
      ...(installId === undefined ? {} : { installId }),
      serverVersion: '0.1.0',
      timestamp: new Date().toISOString(),
    };
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    } catch {
      // 单个连接发送失败不影响批准流程。
    }
  }

  /**
   * 把 socket 提升为 extension 角色。
   *
   * 唯一扩展槽约束：提升前若已有别的 extension socket，**按"批准优先"**关掉旧的并
   * emit `extension-disconnected`（reason 明确写清原因），不静默踢掉。
   */
  private promotePendingExtension(socket: WebSocket, installId: string): void {
    if (socket.readyState !== WebSocket.OPEN) {
      this.pendingExtensionSockets.delete(socket);
      this.socketRole.delete(socket);
      return;
    }
    const previous = [...this.sockets];
    if (previous.length > 0) {
      const previousInstallIds = previous.map(candidate => this.socketInstallId.get(candidate) ?? 'unknown');
      for (const candidate of previous) {
        this.socketRole.set(candidate, 'extension');
        candidate.close(1008, 'extension replaced by approved install');
      }
      this.emitRuntimeEvent({
        kind: 'extension-disconnected',
        reason: `extension-replaced-by-approved-install:${previousInstallIds.length}`,
        timestamp: new Date().toISOString(),
      });
      for (const candidate of previous) {
        this.sockets.delete(candidate);
        this.socketLastSeenAt.delete(candidate);
        this.socketHeartbeatStrikes.delete(candidate);
        this.socketBridgeSession.delete(candidate);
        this.socketInstallId.delete(candidate);
        const claimantId = this.socketExecutorClaimant.get(candidate);
        if (claimantId) this.executorLeases.release(claimantId);
        this.socketExecutorClaimant.delete(candidate);
        this.socketExecutorProfile.delete(candidate);
        this.socketRole.delete(candidate);
      }
    }
    this.pendingExtensionSockets.delete(socket);
    this.admitExtensionSocket(socket, installId);
    try {
      socket.send(JSON.stringify({
        kind: 'pairingApproved',
        installId,
        timestamp: new Date().toISOString(),
      } satisfies BridgeServerMessage));
    } catch {
      // ignore
    }
  }

  /**
   * 把已验证身份（installId 已批准）的 socket 纳入唯一扩展槽。
   *
   * FIX(P1-1/P0-1)：唯一槽只约束**仍然活着**的扩展 socket。
   *
   * 旧实现在 `this.sockets.size > 0` 时无条件 1008 —— 但扩展 SW 重启时，旧 socket
   * 往往已经进入 CLOSING/CLOSED（服务端的 'close' 事件还没跑），新连接就会被永久挤掉
   * （正是 d-desktop P1-1 的"第二扩展永久 1008"现象，也是 executor-lease 重绑用例的竞态源）。
   * 现在先回收已死 socket，只有"旧的确实还是 OPEN"才拒绝。
   */
  private admitExtensionSocket(socket: WebSocket, rawInstallId: string | undefined): void {
    const installId = normalizeExtensionInstallId(rawInstallId);
    this.evictClosedExtensionSockets();
    if (this.sockets.size > 0) {
      socket.close(1008, 'extension already connected');
      return;
    }
    this.clearExtensionDisconnectGrace();
    this.sockets.add(socket);
    this.socketRole.set(socket, 'extension');
    if (installId !== undefined) this.socketInstallId.set(socket, installId);
    this.socketLastSeenAt.set(socket, Date.now());
    this.extensionConnected = true;
    this.emitRuntimeEvent({
      kind: 'extension-connected',
      timestamp: new Date().toISOString(),
    });
    this.maybeGrantLegacyExecutorLease(socket);
  }

  /**
   * 回收已经不可写的扩展 socket（SW 重启/半关闭连接）。
   *
   * 只清理 `sockets` 集合与 per-socket 映射，**不**在这里 emit extension-disconnected ——
   * 断线事件仍然由 'close' 处理器按 grace 语义统一发。'close' 处理器随后会因
   * `sockets` 里已有新的活 socket（或已被清空）而幂等跳过重复清理。
   */
  private evictClosedExtensionSockets(): void {
    for (const existing of [...this.sockets]) {
      if (existing.readyState === WebSocket.OPEN) continue;
      this.sockets.delete(existing);
      this.rejectPendingBets(new Error(LIVE_BET_CONNECTION_LOST_ERROR), existing);
      // 旧连接可能还占着 lease claimant：park 掉（保留 leaseId/secret），
      // 让新连接能 rebind 同一个 leaseId —— 这正是 SW 重启的语义。
      const claimantId = this.socketExecutorClaimant.get(existing);
      if (claimantId) this.executorLeases.release(claimantId);
      this.socketLastSeenAt.delete(existing);
      this.socketHeartbeatStrikes.delete(existing);
      this.socketBridgeSession.delete(existing);
      this.socketExecutorProfile.delete(existing);
      this.socketExecutorClaimant.delete(existing);
      this.socketInstallId.delete(existing);
      try { existing.close(); } catch { /* already closed */ }
    }
  }

  getPort(): number {
    return this.port;
  }

  getExtensionStatus(): BrowserBridgeExtensionStatus {
    const sockets = [...this.sockets];
    const lastSeenAt = sockets
      .map(socket => this.socketLastSeenAt.get(socket))
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => right - left)[0];
    const lease = this.executorLeases.getActiveLease();
    const leasedSocket = this.ownerSocketForActiveLease();
    const authenticated = sockets.length === 1 && (
      this.requireExtensionSequence
        ? (
          lease !== null
          && !!lease.claimantId
          && leasedSocket !== undefined
          && this.socketBridgeSession.has(leasedSocket)
        )
        : true
    );
    return {
      connectionCount: sockets.length,
      authenticated,
      activeExecutorCount: this.executorLeases.activeExecutorCount(),
      ...(lease ? { executorLeaseId: lease.leaseId, executorProfileId: lease.profileId } : {}),
      ...(lastSeenAt === undefined ? {} : { lastSeenAt: new Date(lastSeenAt).toISOString() }),
    };
  }

  getExecutorStatus(): BrowserBridgeExecutorStatus {
    const lease = this.executorLeases.getActiveLease();
    const hostChannelId = this.executorLeases.getHostExecutionChannelId();
    return {
      active_executor_count: this.executorLeases.activeExecutorCount(),
      ...(lease ? { leaseId: lease.leaseId, profileId: lease.profileId } : {}),
      ...(hostChannelId ? { hostChannelId } : {}),
    };
  }

  claimHostExecutionChannel(channelId = 'desktop-primary'): HostExecutionChannelClaimResult {
    return this.executorLeases.claimHostExecutionChannel(channelId);
  }

  // -- 平台适配器解析与上下文 ------------------------------------------------

  /** 非默认平台适配器（注册序 [bg, winfinity]，倒序用于归属判定优先级）。 */
  private get nonDefaultAdapters(): BridgePlatformAdapter[] {
    return this.platformAdapters.slice(1).reverse();
  }

  /** 兜底归属判定：无法由发现表确认时按桌 ID 形状识别（winfinity 优先于 bg）。 */
  private adapterForTableIdShape(tableId: string): BridgePlatformAdapter {
    for (const adapter of this.nonDefaultAdapters) {
      if (adapter.matchesTableIdShape(tableId)) return adapter;
    }
    return this.defaultAdapter;
  }

  private adapterForRoomId(roomId: string): BridgePlatformAdapter | undefined {
    return this.adaptersByRoomId.get(roomId);
  }

  private contextFor(adapter: BridgePlatformAdapter): PlatformAdapterContext {
    return {
      isTableSelected: tableId => this.isTableSelected(tableId),
      noteTableObservation: tableId => this.noteTableObservation(tableId),
      ingestEvents: events => this.ingestParsedEvents(events, adapter.descriptor.roomId),
      ensureRoomForTable: tableId => this.ensureRoomForTable(tableId, adapter.descriptor.roomId),
      upsertDiscoveredRoom: room => {
        upsertBridgeRoom(this.discoveredRooms, room, this.mergeGameCountSelector());
        const selected = this.discoveredRooms.get(room.roomId);
        if (selected !== undefined) {
          this.rooms.set(room.roomId, selectedBridgeRoom(selected, candidate => this.isTableSelected(candidate)));
        }
      },
      lastIngestedShoeId: tableId => this.lastIngestedShoeByTable.get(tableId),
      setVisibleTableIds: tableIds => {
        this.visibleTableIds = new Set(tableIds);
      },
      addVisibleTableIds: tableIds => {
        for (const tableId of tableIds) this.visibleTableIds.add(tableId);
      },
    };
  }

  /** 原合并逻辑：按桌 ID 形状选择 road-count 平滑器（bg → winfinity → pragmatic）。 */
  private mergeGameCountSelector(): MergeGameCountSelector {
    return (tableId, previous, next) => {
      const adapter = this.gameCountAdapterForTableId(tableId);
      return adapter.mergeGameCount(previous, next);
    };
  }

  /** merge 顺序保持原行为：bg 形状优先，其次 winfinity，默认 pragmatic。 */
  private gameCountAdapterForTableId(tableId: string): BridgePlatformAdapter {
    for (const adapter of this.platformAdapters) {
      if (adapter === this.defaultAdapter) continue;
      if (adapter.descriptor.platformId === BG_PLATFORM_ID && adapter.matchesTableIdShape(tableId)) return adapter;
    }
    for (const adapter of this.platformAdapters) {
      if (adapter === this.defaultAdapter) continue;
      if (adapter.matchesTableIdShape(tableId)) return adapter;
    }
    return this.defaultAdapter;
  }

  /**
   * 中控读侧路子计数：按桌归属路由到平台适配器的守卫 + 平滑规则。
   * previous 是中控元数据缓存的路子数（winfinity 的 protocol-shuffle 守卫依赖它）。
   */
  observedGameCountForTable(
    tableId: string,
    previous: number | undefined,
    incoming: number | undefined,
  ): number | undefined {
    const adapter = this.adapterForRoomId(this.roomIdForTable(tableId)) ?? this.defaultAdapter;
    return adapter.observeGameCount(tableId, previous, incoming);
  }

  /** 大厅晋升路径的路子数平滑：按桌 ID 形状路由（bg → winfinity → pragmatic）。 */
  smoothRoadCountForTable(
    tableId: string,
    previous: number | undefined,
    incoming: number | undefined,
  ): number | undefined {
    return this.gameCountAdapterForTableId(tableId).mergeGameCount(previous, incoming);
  }

  /** Starts an independent logical monitor session without claiming a physical shoe reset. */
  currentPragmaticShoeId(tableId: string): string | undefined {
    const pragmatic = this.adaptersByRoomId.get(
      PLATFORM_REGISTRY.get(PRAGMATIC_PLATFORM_ID)!.roomId,
    );
    return pragmatic instanceof PragmaticPlatformAdapter
      ? pragmatic.currentPragmaticShoeId(tableId)
      : this.defaultAdapter.currentShoeId(tableId);
  }

  winfinityLockedAliases(): ReadonlyMap<string, string> {
    for (const adapter of this.platformAdapters) {
      if (adapter instanceof WinfinityPlatformAdapter) return adapter.lockedAliases();
    }
    return new Map();
  }

  shoeEvidence(tableId: string) {
    for (const adapter of [...this.platformAdapters].reverse()) {
      const evidence = adapter.shoeEvidence(tableId);
      if (evidence !== undefined) return evidence;
    }
    return undefined;
  }

  /** 当前靴珠盘序列（结果 + 对子标记）；无认领平台或无数据时返回 undefined。 */
  tableBeads(tableId: string): readonly BeadHand[] | undefined {
    for (const adapter of [...this.platformAdapters].reverse()) {
      const beads = adapter.beadSequence?.(tableId);
      if (beads !== undefined) return beads;
    }
    return undefined;
  }

  acceptedGameCount(tableId: string): number | undefined {
    for (const adapter of [...this.platformAdapters].reverse()) {
      const gameCount = adapter.acceptedGameCount(tableId);
      if (gameCount !== undefined) return gameCount;
    }
    return undefined;
  }

  seedBgShoeSequences(sequences: ReadonlyArray<{ tableId: string; sequence: number }>): void {
    const bg = this.adaptersByRoomId.get(PLATFORM_REGISTRY.get(BG_PLATFORM_ID)!.roomId);
    for (const { tableId, sequence } of sequences) {
      bg?.seedShoeSequences?.([{ tableId, sequence }]);
      const current = this.bgShoeSequenceSeed.get(tableId) ?? 0;
      if (sequence > current) this.bgShoeSequenceSeed.set(tableId, sequence);
    }
  }

  recordShoeEvidence(tableId: string, evidence: ParserShoeEvidence): void {
    const adapter = this.adapterForRoomId(this.roomIdForTable(tableId)) ?? this.defaultAdapter;
    adapter.recordShoeEvidence(tableId, evidence);
  }

  openPhysicalShoe(tableId: string): void {
    if (!this.isTableSelected(tableId)) return;
    const timestamp = new Date().toISOString();
    const adapter = this.adapterForRoomId(this.roomIdForTable(tableId)) ?? this.defaultAdapter;
    this.ingestParsedEvents(adapter.openPhysicalShoe(tableId, timestamp), adapter.descriptor.roomId);
  }

  beginMonitorSession(): void {
    for (const adapter of this.platformAdapters) adapter.reset();
    for (const [tableId, sequence] of this.bgShoeSequenceSeed) {
      this.seedBgShoeSequences([{ tableId, sequence }]);
    }
    this.lastIngestedShoeByTable.clear();
    this.parsedSourceSeqByTable.clear();
    this.parsedEventIds.clear();
    this.protocolObservationStartedAt.clear();
    this.protocolLastObservedAt.clear();
    this.runtimeStateLastObservedAt.clear();
    this.runtimeStateStaleTableIds.clear();
    const liveRoomIds = new Set(PLATFORM_REGISTRY.roomIds);
    for (const [key, exportInstance] of this.exports) {
      const separator = key.indexOf('::');
      if (separator < 0 || !liveRoomIds.has(key.slice(0, separator))) continue;
      void exportInstance.stop();
      this.exports.delete(key);
    }
    for (const roomId of liveRoomIds) {
      this.rooms.delete(roomId);
      this.discoveredRooms.delete(roomId);
    }
  }

  async discoverRooms(): Promise<RoomDescriptor[]> {
    return this.getRooms();
  }

  openTable(roomId: string, tableId: string): TableExport {
    if (!this.isTableSelected(tableId)) {
      throw new Error(`table ${tableId} is not selected`);
    }
    return this.getOrCreateExport(roomId, tableId);
  }

  confirmPhysicalShoe(tableId: string): void {
    if (!this.isTableSelected(tableId)) throw new Error(`table ${tableId} is not selected`);
    const adapter = this.adapterForRoomId(this.roomIdForTable(tableId)) ?? this.defaultAdapter;
    this.ingestParsedEvents(
      adapter.confirmPhysicalShoe(tableId, new Date().toISOString()),
      adapter.descriptor.roomId,
    );
  }
  async requestBet(request: BetExecutionRequest): Promise<BetReceipt | null> {
    const receipt = await this.requestExecution(request);
    if (receipt === null || isBetReceipt(receipt)) return receipt;
    throw new Error('browser extension returned an operational wager receipt for a pair-bet request');
  }

  async requestOperationalWager(request: OperationalWagerExecutionRequest): Promise<OperationalWagerReceipt | null> {
    const receipt = await this.requestExecution(request);
    if (receipt === null) return null;
    if (isOperationalWagerReceipt(receipt)) {
      const reason = typeof receipt.raw === 'object' && receipt.raw !== null
        ? Reflect.get(receipt.raw, 'reason')
        : undefined;
      if (
        reason !== undefined
        && this.platformAdapters.some(adapter => adapter.descriptor.monitorOnlyReason === reason)
      ) {
        return receipt;
      }
      const revision = typeof receipt.raw === 'object' && receipt.raw !== null
        ? Reflect.get(receipt.raw, 'runtimeRevision')
        : undefined;
      if (!isCompatibleRuntimeRevision(revision, OPERATIONAL_WAGER_RUNTIME_FAMILIES)) {
        throw new OperationalWagerRuntimeRevisionError(receipt);
      }
      return receipt;
    }
    throw new Error('browser extension returned a pair-bet receipt for an operational wager request');
  }

  private async requestExecution(request: BridgeExecutionRequest): Promise<BridgeExecutionReceipt | null> {
    const tableId = 'intent' in request ? request.intent.tableId : request.wager.tableId;
    const adapter = this.adapterForRoomId(this.roomIdForTable(tableId)) ?? this.defaultAdapter;
    return await this.serializeExecutionLane(adapter.executionLaneId(tableId), async () =>
      await this.dispatchExecution(request));
  }

  private async serializeExecutionLane<T>(laneId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tableExecutionTails.get(laneId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(() => undefined, () => undefined);
    this.tableExecutionTails.set(laneId, tail);
    void tail.then(() => {
      if (this.tableExecutionTails.get(laneId) === tail) this.tableExecutionTails.delete(laneId);
    });
    return await current;
  }

  private async dispatchExecution(request: BridgeExecutionRequest): Promise<BridgeExecutionReceipt | null> {
    const tableId = 'wager' in request ? request.wager.tableId : request.intent.tableId;
    const adapter = this.adapterForRoomId(this.roomIdForTable(tableId)) ?? this.defaultAdapter;
    const descriptor: PlatformAdapterDescriptor = adapter.descriptor;
    if (descriptor.executionCapability === 'monitor-only') {
      const reason = descriptor.monitorOnlyReason ?? 'platform-monitor-only';
      const prefix = descriptor.monitorOnlyReceiptPrefix ?? descriptor.platformId;
      const now = new Date().toISOString();
      if ('wager' in request) {
        return {
          receiptId: `${prefix}-rejected-${now}`,
          wagerId: request.wager.wagerId,
          tableId,
          shoeId: request.wager.shoeId,
          handId: request.wager.handId,
          market: request.wager.market,
          amount: request.wager.amount,
          source: request.wager.source,
          status: 'REJECTED',
          createdAt: now,
          raw: { commitStarted: false, reason },
        };
      }
      return {
        receiptId: `${prefix}-rejected-${now}`,
        intentId: request.intent.intentId,
        // 监控-only 桌不会先预留敞口；回执仍需携带稳定的 reservationId 供审计串联。
        reservationId: request.reservationId ?? `${prefix}-unreserved-${request.intent.intentId}`,
        status: 'REJECTED',
        amount: request.intent.amount,
        market: request.intent.market,
        mode: request.mode,
        createdAt: now,
        raw: { commitStarted: false, reason },
      };
    }
    const hostClaim = this.executorLeases.claimHostExecutionChannel('desktop-primary');
    if (!hostClaim.ok) {
      throw new Error(`parallel Electron execution channel rejected: ${hostClaim.activeChannelId}`);
    }
    if (request.mode === 'live' && !this.getExtensionStatus().authenticated) {
      throw new Error(LIVE_EXTENSION_CONNECTION_ERROR);
    }
    const sockets = [...this.sockets];
    if (sockets.length === 0) {
      throw new Error('no browser extension connected to execute bets');
    }
    if (sockets.length === 1) {
      this.maybeGrantLegacyExecutorLease(sockets[0]!);
    }
    const lease = this.executorLeases.getActiveLease();
    if (!lease || !lease.claimantId) {
      throw new Error(
        request.mode === 'live'
          ? LIVE_EXTENSION_CONNECTION_ERROR
          : 'no executor lease acquired to execute bets',
      );
    }
    const ownerSocket = this.ownerSocketForActiveLease();
    if (!ownerSocket) {
      throw new Error('no browser extension connected to execute bets');
    }
    const requestId = newId('bet');
    const signed = this.executorLeases.signBetRequest(requestId);
    if (!signed) {
      throw new Error('executor lease could not sign bet request');
    }
    const message: BridgeServerMessage = {
      kind: 'betRequest',
      requestId,
      request,
      leaseId: signed.leaseId,
      signature: signed.signature,
    };
    const raw = JSON.stringify(message);
    const resultPromise = new Promise<BridgeExecutionReceipt | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBets.delete(requestId);
        reject(new Error(`bet request timed out: ${requestId}`));
      }, this.betTimeoutMs);
      this.pendingBets.set(requestId, {
        resolve,
        reject,
        timer,
        ownerSocket: request.mode === 'live' ? ownerSocket : undefined,
      });
    });
    ownerSocket.send(raw);
    return await resultPromise;
  }

  setLiveBetEnabled(enabled: boolean): void {
    if (enabled && !this.getExtensionStatus().authenticated) {
      throw new Error(LIVE_EXTENSION_CONNECTION_ERROR);
    }
    if (this.sockets.size === 0) return;
    this.broadcastToSockets({
      kind: 'command',
      name: enabled ? 'liveOn' : 'liveOff',
    });
  }

  getRuntimeSelectedTables(): readonly string[] {
    return this.effectiveSelectedTables ? [...this.effectiveSelectedTables] : [];
  }

  setSelectedTableIds(tableIds: readonly string[]): void {
    const nextSelectedTables = new Set(
      tableIds
        .map(tableId => tableId.trim())
        .filter(tableId => tableId.length > 0),
    );
    const previousConfiguredSelectedTables = this.configuredSelectedTables;
    const previousRuntimeSelectedTables = this.runtimeSelectedTables;
    const wasPreviouslySelected = (tableId: string): boolean => {
      if (previousConfiguredSelectedTables !== undefined) return previousConfiguredSelectedTables.has(tableId);
      return previousRuntimeSelectedTables?.has(tableId) ?? false;
    };
    const trackedTableIds = new Set([
      ...this.parsedSourceSeqByTable.keys(),
    ]);
    const newlySelectedTableIds = [...nextSelectedTables].filter(tableId => !wasPreviouslySelected(tableId));

    this.configuredSelectedTables = nextSelectedTables;
    this.refreshEffectiveSelectedTables();
    this.pruneUnselectedTables();
    this.refreshSelectedRoomsFromDiscovery();
    for (const tableId of trackedTableIds) {
      if (!nextSelectedTables.has(tableId) || !wasPreviouslySelected(tableId)) {
        this.resetTableState(tableId);
      }
    }
    for (const adapter of this.platformAdapters) {
      const ctx = this.contextFor(adapter);
      for (const tableId of newlySelectedTableIds) {
        adapter.onTableSelected(tableId, ctx);
      }
    }

    if (newlySelectedTableIds.length > 0) {
      this.broadcastToSockets({ kind: 'command', name: 'replayRuntimeState' });
    }
  }

  hasConfiguredTableSelection(): boolean {
    return this.configuredSelectedTables !== undefined;
  }

  private refreshEffectiveSelectedTables(): void {
    if (this.configuredSelectedTables === undefined) {
      this.effectiveSelectedTables = this.runtimeSelectedTables;
      return;
    }
    if (this.runtimeSelectedTables === undefined) {
      this.effectiveSelectedTables = this.configuredSelectedTables;
      return;
    }
    const selected = new Set(
      [...this.runtimeSelectedTables].filter(tableId => this.configuredSelectedTables?.has(tableId)),
    );
    this.effectiveSelectedTables = selected;
  }

  hasRuntimeTableSelection(): boolean {
    return this.runtimeSelectedTables !== undefined;
  }

  private isTableSelected(tableId: string): boolean {
    if (this.configuredSelectedTables !== undefined) return this.configuredSelectedTables.has(tableId);
    return this.runtimeSelectedTables === undefined || this.runtimeSelectedTables.has(tableId);
  }

  getVisibleTableIds(): readonly string[] {
    return [...this.visibleTableIds];
  }

  getDiscoveredRooms(): RoomDescriptor[] {
    return [...this.discoveredRooms.values()].map(room => ({
      roomId: room.roomId,
      ...(room.displayName === undefined ? {} : { displayName: room.displayName }),
      ...(room.platformId === undefined ? {} : { platformId: room.platformId }),
      tables: room.tables.map(table => ({
        tableId: table.tableId,
        ...(table.displayName === undefined ? {} : { displayName: table.displayName }),
        ...(table.roundId === undefined ? {} : { roundId: table.roundId }),
        ...(table.gameCount === undefined ? {} : { gameCount: table.gameCount }),
        profile: table.profile
          ? { ...defaultProfile(table.tableId), ...table.profile }
          : defaultProfile(table.tableId),
        ...(table.monitorUrl === undefined ? {} : { monitorUrl: table.monitorUrl }),
      })),
    }));
  }

  getRooms(): RoomDescriptor[] {
    return [...this.rooms.values()].map(room => ({
      roomId: room.roomId,
      ...(room.displayName === undefined ? {} : { displayName: room.displayName }),
      ...(room.platformId === undefined ? {} : { platformId: room.platformId }),
      tables: room.tables.map(table => ({
        tableId: table.tableId,
        ...(table.displayName === undefined ? {} : { displayName: table.displayName }),
        ...(table.roundId === undefined ? {} : { roundId: table.roundId }),
        ...(table.gameCount === undefined ? {} : { gameCount: table.gameCount }),
        profile: table.profile
          ? { ...defaultProfile(table.tableId), ...table.profile }
          : defaultProfile(table.tableId),
        ...(table.monitorUrl === undefined ? {} : { monitorUrl: table.monitorUrl }),
      })),
    }));
  }

  ingestClientMessage(raw: unknown, sourceSocket?: WebSocket): void {
    const message = raw as BridgeClientMessage;
    switch (message.kind) {
      case 'roomDiscovered':
      case 'roomUpdated': {
        const adapter = this.adapterForRoomId(message.room.roomId);
        const room = adapter ? adapter.sanitizeRoom(message.room) : message.room;
        const merged = adapter && adapter.usesUpsertRoomMerge()
          ? upsertBridgeRoom(this.discoveredRooms, room, this.mergeGameCountSelector())
          : replaceBridgeRoom(this.discoveredRooms, room, this.mergeGameCountSelector());
        this.rooms.set(
          room.roomId,
          selectedBridgeRoom(merged, tableId => this.isTableSelected(tableId)),
        );
        adapter?.ingestRoomGameCounts(room, this.contextFor(adapter));
        break;
      }
      case 'tableEvent': {
        if (!this.isTableSelected(message.tableId)) break;
        const exportInstance = this.getOrCreateExport(message.roomId, message.tableId);
        exportInstance.ingestEvent(message.event);
        break;
      }
      case 'tableDisconnected':
        if (!this.isTableSelected(message.tableId)) break;
        this.exports.get(exportKey(message.roomId, message.tableId))?.handleDisconnect(message.reason);
        break;
      case 'tableRestored':
        // Recovery proofs are bridge-owned. A client claim cannot establish
        // cursor continuity without the next event that the bridge can verify.
        break;
      case 'betResult': {
        const pending = this.pendingBets.get(message.requestId);
        if (!pending) break;
        if (pending.ownerSocket !== undefined && pending.ownerSocket !== sourceSocket) break;
        clearTimeout(pending.timer);
        this.pendingBets.delete(message.requestId);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.receipt);
        }
        break;
      }
      case 'diagnostic':
        if (BRIDGE_DEBUG_ENABLED) {
          console.log('[bridge-diagnostic]', JSON.stringify(redactBridgeDiagnostic(message)));
        }
        break;
      case 'networkCapture':
        if (!isLiveProtocolCapture(message)) break;
        logNetworkCapture(message);
        capturePragmaticNetworkFrame(message);
        if (message.source === 'baccarat-bridge-runtime-selection') {
          this.applyRuntimeSelection(message.data);
          break;
        }
        {
          const adapter = this.adapterForCaptureSource(message.source);
          adapter?.ingestNetworkCapture(message, this.contextFor(adapter));
        }
        break;
      case 'sessionExpired':
        console.error('[session-expired]', JSON.stringify(redactedLifecycleMessage(message)));
        this.invalidateBridgeContinuity('game-session-expired');
        break;
      case 'sessionAction':
        if (BRIDGE_DEBUG_ENABLED && !NOISY_SESSION_ACTIONS.has(message.action)) {
          console.log('[session-action]', JSON.stringify(redactedLifecycleMessage(message)));
        }
        if (message.action === 'recovery-failed') {
          this.emitRuntimeEvent({
            kind: 'session-recovery-exhausted',
            ...(message.detail === undefined ? {} : { detail: message.detail }),
            timestamp: message.timestamp,
          });
        } else if (message.action === 'recovered') {
          this.emitRuntimeEvent({
            kind: 'session-recovered',
            timestamp: message.timestamp,
          });
        }
        break;
      case 'command':
        if (BRIDGE_DEBUG_ENABLED) {
          console.log('[bridge-command]', JSON.stringify(message));
        }
        // 回环 command 客户端可以提交任意 name；只放行扩展认识的命令。
        if (!BRIDGE_COMMAND_NAMES.has(message.name)) {
          console.error('[bridge-command-rejected]', message.name);
          break;
        }
        this.broadcastToSockets({
          kind: 'command',
          name: message.name,
          ...(message.tableIds === undefined ? {} : { tableIds: message.tableIds }),
        });
        break;
      case 'hello':
        this.handleExecutorHello(message, sourceSocket);
        break;
      case 'heartbeat':
      case 'keepalive':
        break;
    }
    if (
      OBSERVABLE_KINDS.has(message.kind)
      && (message.kind !== 'sessionAction' || !NOISY_SESSION_ACTIONS.has(message.action))
    ) {
      this.broadcastToObservers({
        kind: 'observe',
        message: redactedLifecycleMessage(message as Extract<
          BridgeClientMessage,
          { kind: 'sessionExpired' | 'sessionAction' | 'keepalive' }
        >),
      });
    } else if (
      message.kind === 'networkCapture'
      && isLiveProtocolCapture(message)
      && (
        OBSERVABLE_NETWORK_PATTERN.test(message.url)
        || String(message.source || '').startsWith('baccarat-bridge-bg-')
        || String(message.source || '').startsWith('baccarat-bridge-winfinity-')
      )
    ) {
      this.broadcastToObservers({ kind: 'observe', message: observableNetworkCapture(message) });
    }
  }

  private applyRuntimeSelection(raw: string): void {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const tableIds = (parsed as { tableIds?: unknown }).tableIds;
      if (!Array.isArray(tableIds)) return;
      const selected = new Set(tableIds.filter((value): value is string => typeof value === 'string' && value.length > 0));
      const configuredSelectedTables = this.configuredSelectedTables;
      const hasConfiguredOverlap = configuredSelectedTables === undefined
        || [...selected].some(tableId => configuredSelectedTables.has(tableId));
      this.runtimeSelectedTables = hasConfiguredOverlap ? selected : new Set();
      this.refreshEffectiveSelectedTables();
      if (this.configuredSelectedTables === undefined) this.pruneUnselectedTables();
    } catch {
      // malformed selection notifications are ignored at the bridge boundary.
    }
  }

  private pruneUnselectedTables(): void {
    for (const room of this.rooms.values()) {
      room.tables = room.tables.filter(table => this.isTableSelected(table.tableId));
    }
    for (const [key, exportInstance] of this.exports) {
      const separator = key.indexOf('::');
      const tableId = separator >= 0 ? key.slice(separator + 2) : '';
      if (tableId.length > 0 && !this.isTableSelected(tableId)) {
        void exportInstance.stop();
        this.exports.delete(key);
      }
    }
  }

  private resetTableState(tableId: string): void {
    this.parsedSourceSeqByTable.delete(tableId);
    this.protocolObservationStartedAt.delete(tableId);
    this.protocolLastObservedAt.delete(tableId);
    this.runtimeStateLastObservedAt.delete(tableId);
    this.runtimeStateStaleTableIds.delete(tableId);
    this.lastIngestedShoeByTable.delete(tableId);
  }

  private refreshSelectedRoomsFromDiscovery(): void {
    for (const [roomId, discovered] of this.discoveredRooms) {
      if (!isLiveBridgeRoomId(roomId)) continue;
      this.rooms.set(roomId, {
        ...discovered,
        tables: discovered.tables.filter(table => this.isTableSelected(table.tableId)),
      });
    }
  }

  private ingestParsedEvents(events: readonly NormalizedEvent[], roomId: string): void {
    for (const event of events) {
      if (!this.isTableSelected(event.tableId)) continue;
      if (this.parsedEventIds.has(event.eventId)) continue;
      if (event.type === 'newShoeSignal') {
        for (const eventId of this.parsedEventIds) {
          if (eventId.includes(`:${event.tableId}:`)) this.parsedEventIds.delete(eventId);
        }
      } else if (this.parsedEventIds.size >= 20_000) {
        this.parsedEventIds.clear();
      }
      this.parsedEventIds.add(event.eventId);
      if (event.type === 'newShoeSignal' && typeof event.shoeId === 'string' && event.shoeId.length > 0) {
        this.lastIngestedShoeByTable.set(event.tableId, event.shoeId);
      }
      const sourceSeq = (this.parsedSourceSeqByTable.get(event.tableId) ?? 0) + 1;
      this.parsedSourceSeqByTable.set(event.tableId, sourceSeq);
      const normalizedEvent: NormalizedEvent = event.sourceSeq === sourceSeq
        ? event
        : { ...event, sourceSeq };
      if (BRIDGE_DEBUG_ENABLED) {
        console.log('[bridge-event]', JSON.stringify(normalizedEvent));
      }
      this.ensureRoomForTable(normalizedEvent.tableId, roomId);
      const exportInstance = this.getOrCreateExport(roomId, normalizedEvent.tableId);
      exportInstance.ingestEvent(normalizedEvent);
    }
  }

  private broadcastToSockets(payload: BridgeServerMessage): void {
    const raw = JSON.stringify(payload);
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(raw);
        } catch {
          // 单个连接发送失败不影响其他客户端。
        }
      }
    }
  }

  private broadcastToObservers(payload: BridgeServerMessage): void {
    const raw = JSON.stringify(payload);
    for (const socket of this.observers) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(raw);
      } catch {
        continue;
      }
    }
  }

  private roomIdForTable(tableId: string): string {
    // 保持原优先级：winfinity 发现表 → bg 发现表 → winfinity 形状 → bg 形状 → pragmatic。
    for (const adapter of this.nonDefaultAdapters) {
      const room = this.discoveredRooms.get(adapter.descriptor.roomId);
      if (room?.tables.some(table => table.tableId === tableId)) return adapter.descriptor.roomId;
    }
    for (const adapter of this.nonDefaultAdapters) {
      if (adapter.matchesTableIdShape(tableId)) return adapter.descriptor.roomId;
    }
    return this.defaultAdapter.descriptor.roomId;
  }

  private adapterForCaptureSource(source: string): BridgePlatformAdapter | undefined {
    for (const adapter of this.platformAdapters) {
      if (source.startsWith(adapter.descriptor.captureSourcePrefix)) return adapter;
    }
    return undefined;
  }

  private ensureRoomForTable(tableId: string, roomId = this.defaultAdapter.descriptor.roomId): void {
    const adapter = this.adapterForRoomId(roomId) ?? this.defaultAdapter;
    if (adapter.normalizeTableId(tableId) === undefined) return;
    adapter.onRoomTableAdopted(tableId);
    upsertBridgeRoom(this.discoveredRooms, {
      roomId,
      displayName: adapter.descriptor.roomDisplayName,
      platformId: adapter.descriptor.platformId,
      tables: [{
        tableId,
        ...(adapter.roomTableDisplayName(tableId) === undefined
          ? {}
          : { displayName: adapter.roomTableDisplayName(tableId) }),
      }],
    }, this.mergeGameCountSelector());
    if (!this.isTableSelected(tableId)) return;
    const discovered = this.discoveredRooms.get(roomId);
    if (discovered !== undefined) {
      this.rooms.set(roomId, selectedBridgeRoom(discovered, candidate => this.isTableSelected(candidate)));
    }
  }

  private handleBridgeDisconnect(reason: string): void {
    for (const exportInstance of this.exports.values()) {
      exportInstance.handleDisconnect(reason);
    }
  }

  private scheduleExtensionDisconnect(reason: string): void {
    if (this.extensionDisconnectTimer !== undefined) return;
    if (this.extensionDisconnectGraceMs <= 0) {
      this.finalizeExtensionDisconnect(reason);
      return;
    }
    this.extensionDisconnectTimer = setTimeout(() => {
      this.extensionDisconnectTimer = undefined;
      if (this.sockets.size > 0) return;
      this.finalizeExtensionDisconnect(reason);
    }, this.extensionDisconnectGraceMs);
    this.extensionDisconnectTimer.unref();
  }

  private clearExtensionDisconnectGrace(): void {
    if (this.extensionDisconnectTimer === undefined) return;
    clearTimeout(this.extensionDisconnectTimer);
    this.extensionDisconnectTimer = undefined;
  }

  private finalizeExtensionDisconnect(reason: string): void {
    this.clearExtensionDisconnectGrace();
    if (!this.extensionConnected) return;
    this.extensionConnected = false;
    this.emitRuntimeEvent({
      kind: 'extension-disconnected',
      reason,
      timestamp: new Date().toISOString(),
    });
    this.handleBridgeDisconnect('browser-extension-disconnected');
  }

  private invalidateBridgeContinuity(reason: string): void {
    this.emitRuntimeEvent({
      kind: 'continuity-invalidated',
      reason,
      timestamp: new Date().toISOString(),
    });
    for (const exportInstance of this.exports.values()) {
      exportInstance.invalidateTransportContinuity(reason);
    }
  }

  private markBridgeTransportContinuous(): void {
    for (const exportInstance of this.exports.values()) {
      exportInstance.markTransportContinuous();
    }
  }

  private noteTableObservation(tableId: string): void {
    for (const [key, exportInstance] of this.exports) {
      if (key.endsWith(`::${tableId}`)) exportInstance.noteObservation();
    }
  }

  private noteProtocolObservation(tableId: string, observedAt = Date.now()): void {
    if (!this.protocolObservationStartedAt.has(tableId)) {
      this.protocolObservationStartedAt.set(tableId, observedAt);
    }
    this.protocolLastObservedAt.set(tableId, observedAt);
  }

  private noteRuntimeStateObservation(tableId: string, observedAt = Date.now()): void {
    this.runtimeStateLastObservedAt.set(tableId, observedAt);
    this.runtimeStateStaleTableIds.delete(tableId);
  }

  private checkRuntimeStateFreshness(now = Date.now()): void {
    for (const [tableId, protocolLastObservedAt] of this.protocolLastObservedAt) {
      if (!this.isTableSelected(tableId)) continue;
      if (now - protocolLastObservedAt > this.tableStaleAfterMs) continue;
      const runtimeLastObservedAt = this.runtimeStateLastObservedAt.get(tableId);
      const runtimeObservationAge = runtimeLastObservedAt === undefined
        ? now - (this.protocolObservationStartedAt.get(tableId) ?? now)
        : now - runtimeLastObservedAt;
      if (runtimeObservationAge <= this.tableStaleAfterMs) continue;
      this.markRuntimeStateStale(tableId);
    }
  }

  private markRuntimeStateStale(tableId: string): void {
    if (this.runtimeStateStaleTableIds.has(tableId)) return;
    this.runtimeStateStaleTableIds.add(tableId);
    let exportFound = false;
    for (const [key, exportInstance] of this.exports) {
      if (!key.endsWith(`::${tableId}`)) continue;
      exportFound = true;
      exportInstance.handleDisconnect('table-feed-stale');
    }
    if (exportFound) return;
    this.emitRuntimeEvent({
      kind: 'table-disconnected',
      tableId,
      reason: 'table-feed-stale',
      timestamp: new Date().toISOString(),
    });
  }

  private ownerSocketForActiveLease(): WebSocket | undefined {
    const lease = this.executorLeases.getActiveLease();
    if (!lease?.claimantId) return undefined;
    for (const socket of this.sockets) {
      if (this.socketExecutorClaimant.get(socket) === lease.claimantId) return socket;
    }
    return undefined;
  }

  private maybeGrantLegacyExecutorLease(socket: WebSocket): void {
    if (this.requireExtensionSequence) return;
    if (this.executorLeases.getActiveLease()?.claimantId) return;
    if (this.sockets.size !== 1 || !this.sockets.has(socket)) return;
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const claimantId = `legacy-${nonce}`.slice(0, 128);
    const profileId = `legacy-profile-${nonce}`.slice(0, 128);
    const result = this.executorLeases.tryAcquire(profileId, claimantId);
    if (result.status !== 'acquired') return;
    this.socketExecutorProfile.set(socket, profileId);
    this.socketExecutorClaimant.set(socket, claimantId);
    this.emitRuntimeEvent({
      kind: 'executor-lease-acquired',
      leaseId: result.lease.leaseId,
      profileId: result.lease.profileId,
      reacquired: result.reacquired,
      timestamp: new Date().toISOString(),
    });
  }

  private handleExecutorHello(
    message: Extract<BridgeClientMessage, { kind: 'hello' }>,
    sourceSocket: WebSocket | undefined,
  ): void {
    if (!sourceSocket) return;
    const sessionId = this.socketBridgeSession.get(sourceSocket)
      || (typeof message.bridgeSessionId === 'string' ? message.bridgeSessionId : '');
    const profileId = typeof message.executorProfileId === 'string' && message.executorProfileId.trim()
      ? message.executorProfileId.trim()
      : (sessionId ? `profile-${sessionId}` : '');
    if (!profileId || !sessionId) return;

    const result = this.executorLeases.tryAcquire(profileId, sessionId);
    if (result.status === 'rejected') {
      this.emitRuntimeEvent({
        kind: 'executor-lease-rejected',
        reason: result.reason,
        profileId,
        ...(result.activeLeaseId ? { activeLeaseId: result.activeLeaseId } : {}),
        timestamp: new Date().toISOString(),
      });
      sourceSocket.send(JSON.stringify({
        kind: 'executorLeaseRejected',
        reason: result.reason,
        ...(result.activeLeaseId ? { activeLeaseId: result.activeLeaseId } : {}),
        timestamp: new Date().toISOString(),
      } satisfies BridgeServerMessage));
      return;
    }

    this.socketExecutorProfile.set(sourceSocket, profileId);
    this.socketExecutorClaimant.set(sourceSocket, sessionId);
    this.emitRuntimeEvent({
      kind: 'executor-lease-acquired',
      leaseId: result.lease.leaseId,
      profileId: result.lease.profileId,
      reacquired: result.reacquired,
      timestamp: new Date().toISOString(),
    });
    sourceSocket.send(JSON.stringify({
      kind: 'executorLeaseGranted',
      leaseId: result.lease.leaseId,
      profileId: result.lease.profileId,
      secret: result.lease.secret,
      reacquired: result.reacquired,
      timestamp: new Date().toISOString(),
    } satisfies BridgeServerMessage));
  }

  private acceptExtensionSequence(raw: unknown, socket: WebSocket): boolean {
    if (!this.requireExtensionSequence) return true;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      socket.close(1008, 'missing bridge sequence');
      return false;
    }
    const sessionId = Reflect.get(raw, 'bridgeSessionId');
    const sequence = Reflect.get(raw, 'bridgeSeq');
    if (
      typeof sessionId !== 'string'
      || !/^[a-zA-Z0-9._-]{8,128}$/.test(sessionId)
      || !Number.isSafeInteger(sequence)
      || sequence < 1
    ) {
      socket.close(1008, 'invalid bridge sequence');
      return false;
    }
    const socketSession = this.socketBridgeSession.get(socket);
    if (socketSession !== undefined && socketSession !== sessionId) {
      this.invalidateBridgeContinuity('extension-session-changed-on-socket');
      socket.close(1008, 'bridge session changed on socket');
      return false;
    }

    const previousSequence = this.lastBridgeSeqBySession.get(sessionId);
    if (previousSequence !== undefined && sequence !== previousSequence + 1) {
      this.invalidateBridgeContinuity(
        `extension-message-gap:${previousSequence + 1}:${sequence}`,
      );
      socket.close(1008, 'bridge message sequence gap');
      return false;
    }

    const previousActiveSession = this.activeBridgeSessionId;
    const wasAuthenticated = this.socketBridgeSession.has(socket);
    this.socketBridgeSession.set(socket, sessionId);
    this.lastBridgeSeqBySession.set(sessionId, sequence);
    this.activeBridgeSessionId = sessionId;
    if (previousActiveSession !== undefined && previousActiveSession !== sessionId) {
      this.invalidateBridgeContinuity('extension-session-restarted');
    } else {
      this.markBridgeTransportContinuous();
    }
    if (!wasAuthenticated) {
      this.emitRuntimeEvent({
        kind: 'extension-authenticated',
        sessionId,
        timestamp: new Date().toISOString(),
      });
    }
    return true;
  }

  private ensureFreshnessTimer(): void {
    if (this.freshnessTimer) return;
    const intervalMs = Math.max(
      1_000,
      Math.min(this.tableStaleAfterMs, this.extensionHeartbeatTimeoutMs) / 3,
    );
    this.freshnessTimer = setInterval(() => {
      const now = Date.now();
      for (const socket of this.sockets) {
        const lastSeenAt = this.socketLastSeenAt.get(socket) ?? 0;
        if (now - lastSeenAt <= this.extensionHeartbeatTimeoutMs) {
          this.socketHeartbeatStrikes.delete(socket);
          continue;
        }
        const strikes = (this.socketHeartbeatStrikes.get(socket) ?? 0) + 1;
        this.socketHeartbeatStrikes.set(socket, strikes);
        if (strikes < 2) continue;
        this.socketHeartbeatStrikes.delete(socket);
        socket.close(4001, 'extension heartbeat stale');
      }
      // FIX(P0-1): 待批准连接也不能无限期占着内存/句柄，超时未再出现即回收。
      for (const socket of [...this.pendingExtensionSockets.keys()]) {
        const lastSeenAt = this.socketLastSeenAt.get(socket) ?? 0;
        if (now - lastSeenAt <= this.extensionHeartbeatTimeoutMs) continue;
        socket.close(4001, 'extension pairing stale');
      }
      for (const exportInstance of this.exports.values()) {
        exportInstance.checkFreshness(now);
      }
      this.checkRuntimeStateFreshness(now);
    }, intervalMs);
    this.freshnessTimer.unref();
  }

  private rejectPendingBets(error: Error, sourceSocket?: WebSocket): void {
    for (const [requestId, pending] of this.pendingBets) {
      if (sourceSocket !== undefined && pending.ownerSocket !== sourceSocket) continue;
      clearTimeout(pending.timer);
      this.pendingBets.delete(requestId);
      pending.reject(error);
    }
  }

  private getOrCreateExport(roomId: string, tableId: string): BridgeTableExport {
    const key = exportKey(roomId, tableId);
    const existing = this.exports.get(key);
    if (existing) return existing;
    const descriptor = this.adapterForRoomId(roomId)?.descriptor;
    const staleAfterMs = descriptor?.tableStaleAfterMs !== undefined
      ? Math.max(this.tableStaleAfterMs, descriptor.tableStaleAfterMs)
      : this.tableStaleAfterMs;
    const created = new BridgeTableExport(
      roomId,
      tableId,
      staleAfterMs,
      (disconnectedTableId, reason) => {
        this.emitRuntimeEvent({
          kind: 'table-disconnected',
          tableId: disconnectedTableId,
          reason,
          timestamp: new Date().toISOString(),
        });
      },
      undefined,
      // FIX(P1-11): 伪造/缺失 payload hash 的恢复请求必须留下可见事故。
      (_rejectedTableId, reason) => {
        this.emitRuntimeEvent({
          kind: 'continuity-invalidated',
          reason,
          timestamp: new Date().toISOString(),
        });
      },
    );
    this.exports.set(key, created);
    return created;
  }

  private emitRuntimeEvent(event: BrowserBridgeRuntimeEvent): void {
    try {
      this.options.onRuntimeEvent?.(event);
    } catch (error) {
      console.error('browser bridge runtime observer failed', error);
    }
  }
}

function isBetReceipt(value: BridgeExecutionReceipt): value is BetReceipt {
  return 'intentId' in value;
}

function isOperationalWagerReceipt(value: BridgeExecutionReceipt): value is OperationalWagerReceipt {
  return 'wagerId' in value;
}

function exportKey(roomId: string, tableId: string): string {
  return `${roomId}::${tableId}`;
}
