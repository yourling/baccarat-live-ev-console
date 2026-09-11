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
import { PragmaticPlatformAdapter } from './platform-pragmatic.js';
import { BgPlatformAdapter } from './platform-bg.js';
import { WinfinityPlatformAdapter } from './platform-winfinity.js';
import type {
  BridgePlatformAdapter,
  PlatformAdapterContext,
  PlatformCaptureMessage,
} from './platform-adapter.js';
import { PLATFORM_REGISTRY, isLiveBridgeRoomId } from './identity.js';
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
  onRuntimeEvent?: (event: BrowserBridgeRuntimeEvent) => void;
}

export type BrowserBridgeRuntimeEvent =
  | { readonly kind: 'extension-auth-failed'; readonly reason: string; readonly timestamp: string }
  | { readonly kind: 'extension-connected'; readonly timestamp: string }
  | { readonly kind: 'extension-authenticated'; readonly sessionId: string; readonly timestamp: string }
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
 * 允许从本机回环转发的扩展命令白名单。command 客户端可以提交任意字符串，
 * 不校验的话，本机任意进程都能让扩展执行 liveOn / liveOff / reloadExtension。
 * 集合必须覆盖三个扩展实际处理的所有命令。
 */
const BRIDGE_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'liveOn',
  'liveOff',
  'reloadExtension',
  'probeBetReadiness',
  'replayRuntimeState',
  'probeExtensionManifest',
  'calibrate',
  'calibrateClear',
  'startPragmaticNetworkCapture',
  'stopPragmaticNetworkCapture',
  'trustedOn',
  'trustedOff',
]);
const EXTENSION_HEARTBEAT_TIMEOUT_MS = 15_000;
const EXTENSION_DISCONNECT_GRACE_MS = 8_000;

type BridgeSocketRole = 'extension' | 'observer' | 'command';

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

function bridgeSocketRole(
  origin: string,
  requestUrl: string | undefined,
  identity: Pick<BrowserBridgeServerOptions, 'allowedExtensionId' | 'allowedExtensionIds' | 'extensionToken'> = {},
): BridgeSocketRole | null {
  const path = bridgeRequestPath(requestUrl);
  if (isExtensionOrigin(origin, allowedExtensionIdSet(identity))) {
    return path === '/' && hasExtensionToken(requestUrl, identity.extensionToken)
      ? 'extension'
      : null;
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

  constructor(
    roomId: string,
    tableId: string,
    private readonly staleAfterMs: number,
    private readonly onDisconnected?: (tableId: string, reason: string) => void,
    private readonly onObserved?: (tableId: string) => void,
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
    if (this.stopped || this.pendingOverflowed) return;
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
   */
  private overflowPendingBuffer(): void {
    this.pending = this.pending.slice(-TABLE_EXPORT_PENDING_LIMIT);
    this.pendingOverflowed = true;
    const reason = `table-export-buffer-overflow:${this.tableId}`;
    this.error = new Error(
      `pending buffer for ${this.tableId} exceeded ${TABLE_EXPORT_PENDING_LIMIT} events`,
    );
    this.handleDisconnect(reason);
  }

  noteObservation(): void {
    this.lastObservationAt = Date.now();
    this.onObserved?.(this.tableId);
    if (
      this.started
      && !this.stopped
      && this.state === 'DISCONNECTED'
      && this.disconnectReason === 'table-feed-stale'
    ) {
      void this.handleRestored(cursorContinuityProof({
        tableId: this.tableId,
        reason: 'table-feed-stale-resume',
        observedAt: this.lastObservationAt,
      }));
    }
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
    if (this.state === 'CONNECTED' && !this.paused) return;
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
        const batch: TableEventBatch = {
          tableId: this.tableId,
          events: [event],
          cursor: {
            tableId: this.tableId,
            sourceSeq: event.sourceSeq,
            eventId: event.eventId,
            payloadHash: event.eventId,
          },
          kind: this.cursor.sourceSeq > 0 ? 'replay' : 'live',
        };
        await this.sink!.onBatch(batch);
        this.pending.shift();
        this.cursor = batch.cursor;
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
    const proof = cursorContinuityProof({
      tableId: this.tableId,
      previousCursor: this.cursor,
      nextEvent: {
        sourceSeq: nextEvent.sourceSeq,
        eventId: nextEvent.eventId,
        payloadHash: sha256(stableStringify(nextEvent)),
      },
      physicalReset: isPhysicalReset,
    });
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
    this.configuredSelectedTables = options.selectedTableIds === undefined
      ? undefined
      : new Set(
        options.selectedTableIds
          .map(tableId => tableId.trim())
          .filter(tableId => tableId.length > 0),
      );
    this.refreshEffectiveSelectedTables();
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
        const role = bridgeSocketRole(info.origin, info.req.url, this.options);
        if (role === null && info.origin.startsWith('chrome-extension://')) {
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
      const role = bridgeSocketRole(String(request.headers.origin ?? ''), request.url, this.options);
      if (role === null) {
        socket.close(1008, 'unauthorized bridge client');
        return;
      }
      if (role === 'observer') {
        this.observers.add(socket);
      } else if (role === 'command') {
        this.commandClients.add(socket);
      } else {
        if (this.sockets.size > 0) {
          socket.close(1008, 'extension already connected');
          return;
        }
        this.clearExtensionDisconnectGrace();
        this.sockets.add(socket);
        this.socketLastSeenAt.set(socket, Date.now());
        this.extensionConnected = true;
        this.emitRuntimeEvent({
          kind: 'extension-connected',
          timestamp: new Date().toISOString(),
        });
        this.maybeGrantLegacyExecutorLease(socket);
      }
      socket.on('message', data => {
        if (role === 'observer') return;
        try {
          const message: unknown = JSON.parse(data.toString());
          if (role === 'command' && !isBridgeCommand(message)) return;
          if (role === 'extension') {
            this.socketLastSeenAt.set(socket, Date.now());
            if (!this.acceptExtensionSequence(message, socket)) return;
          }
          this.ingestClientMessage(message, socket);
        } catch {
          // ignore malformed messages from untrusted extensions
        }
      });
      socket.on('error', () => {
        if (role !== 'extension') return;
        this.rejectPendingBets(new Error(LIVE_BET_CONNECTION_LOST_ERROR), socket);
      });
      socket.on('close', (code, rawReason) => {
        if (role === 'observer') {
          this.observers.delete(socket);
          return;
        }
        if (role === 'command') {
          this.commandClients.delete(socket);
          return;
        }
        this.rejectPendingBets(new Error(LIVE_BET_CONNECTION_LOST_ERROR), socket);
        const claimantId = this.socketExecutorClaimant.get(socket);
        if (claimantId) this.executorLeases.release(claimantId);
        this.sockets.delete(socket);
        this.socketLastSeenAt.delete(socket);
        this.socketHeartbeatStrikes.delete(socket);
        this.socketBridgeSession.delete(socket);
        this.socketExecutorProfile.delete(socket);
        this.socketExecutorClaimant.delete(socket);
        if (this.sockets.size === 0 && this.extensionConnected) {
          this.scheduleExtensionDisconnect(rawReason.toString() || `websocket-close-${code}`);
        }
      });
      socket.send(JSON.stringify({
        kind: 'welcome',
        serverVersion: '0.1.0',
        timestamp: new Date().toISOString(),
      } satisfies BridgeServerMessage));
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
    for (const socket of [...this.sockets, ...this.observers, ...this.commandClients]) socket.close();
    this.sockets.clear();
    this.observers.clear();
    this.commandClients.clear();
    this.socketLastSeenAt.clear();
    this.socketHeartbeatStrikes.clear();
    this.socketBridgeSession.clear();
    this.socketExecutorProfile.clear();
    this.socketExecutorClaimant.clear();
    this.executorLeases.clear();
    if (this.wss) {
      const wss = this.wss;
      this.wss = undefined;
      await new Promise<void>(resolve => wss.close(() => resolve()));
    }
    this.rejectPendingBets(new Error('browser bridge stopped before bet result'));
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
