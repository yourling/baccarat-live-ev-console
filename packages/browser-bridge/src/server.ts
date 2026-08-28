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
import { EvolutionBaccaratParser } from './evolution.js';
import { MstromProtocolEventParser } from './mstrom-protocol-events.js';
import { parseMstromFrame } from './mstrom-protocol.js';
import { MstromRuntimeParser } from './mstrom-runtime.js';
import { MstromShoeSessionRegistry } from './mstrom-shoe-session.js';

export const MSTROM_BET_RUNTIME_REVISION = 'mstrom-bet-runtime/2026-08-28.1';

export class OperationalWagerRuntimeRevisionError extends Error {
  constructor(readonly receipt: OperationalWagerReceipt) {
    super('browser extension mstrom bet runtime revision mismatch');
    this.name = 'OperationalWagerRuntimeRevisionError';
  }
}

export interface BrowserBridgeServerOptions {
  port?: number;
  host?: string;
  betTimeoutMs?: number;
  multiviewRecoveryCooldownMs?: number;
  multiviewOpenedGraceMs?: number;
  selectedTableIds?: readonly string[];
  tableStaleAfterMs?: number;
  stalePageReloadAfterMs?: number;
  extensionHeartbeatTimeoutMs?: number;
  requireExtensionSequence?: boolean;
  allowedExtensionId?: string;
  extensionToken?: string;
  onRuntimeEvent?: (event: BrowserBridgeRuntimeEvent) => void;
}

export type BrowserBridgeRuntimeEvent =
  | { readonly kind: 'extension-auth-failed'; readonly reason: string; readonly timestamp: string }
  | { readonly kind: 'extension-connected'; readonly timestamp: string }
  | { readonly kind: 'extension-authenticated'; readonly sessionId: string; readonly timestamp: string }
  | { readonly kind: 'extension-disconnected'; readonly reason: string; readonly timestamp: string }
  | { readonly kind: 'continuity-invalidated'; readonly reason: string; readonly timestamp: string }
  | { readonly kind: 'table-disconnected'; readonly tableId: string; readonly reason: string; readonly timestamp: string }
  | { readonly kind: 'session-recovery-exhausted'; readonly detail?: string; readonly timestamp: string }
  | { readonly kind: 'session-recovered'; readonly timestamp: string };

export interface BrowserBridgeExtensionStatus {
  readonly connectionCount: number;
  readonly authenticated: boolean;
  readonly lastSeenAt?: string;
}

type PendingBet = {
  resolve: (receipt: BridgeExecutionReceipt | null) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  ownerSocket: WebSocket | undefined;
};

/**
 * 转发给所有已连接观察客户端的消息类型：
 * 桥接服务把扩展发来的会话/保活/诊断事件广播出去，
 * 让 bridge:observe 之类的观察者在桌面控制台已占用端口时仍能实时观测。
 */
const OBSERVABLE_KINDS = new Set(['sessionExpired', 'sessionAction', 'keepalive']);

/** 观察广播允许透传的网络捕获域名(游戏/聊天/会话通道,不含视频流)。 */
const OBSERVABLE_NETWORK_PATTERN = /df888evo|evolution|evo|mstrom-uno|673ing|mdvuz|e9p1/i;

const LIVE_EXTENSION_CONNECTION_ERROR =
  'live bet execution requires exactly one browser extension connection with an authenticated extension sequence';
const LIVE_BET_CONNECTION_LOST_ERROR = 'browser extension disconnected before live bet result';
const OBSERVER_PATH = '/observe';
const COMMAND_PATH = '/command';
const BRIDGE_DEBUG_ENABLED = process.env.BACCARAT_BRIDGE_DEBUG === '1';

/** 已配置多桌在单桌回退时请求页面恢复的最短间隔。 */
const MULTIVIEW_RECOVERY_COOLDOWN_MS = 10_000;

/** 页面确认已打开多台后，留给真实页面完成加载的宽限时间。 */
const MULTIVIEW_OPENED_GRACE_MS = 60_000;
const TABLE_STALE_AFTER_MS = 45_000;
const STALE_PAGE_RELOAD_AFTER_MS = 8 * 60_000;
const STALE_PAGE_RELOAD_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const EXTENSION_HEARTBEAT_TIMEOUT_MS = 15_000;

type BridgeSocketRole = 'extension' | 'observer' | 'command';

function bridgeSocketRole(
  origin: string,
  requestUrl: string | undefined,
  identity: Pick<BrowserBridgeServerOptions, 'allowedExtensionId' | 'extensionToken'> = {},
): BridgeSocketRole | null {
  const path = bridgeRequestPath(requestUrl);
  if (isExtensionOrigin(origin, identity.allowedExtensionId)) {
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

function isExtensionOrigin(origin: string, allowedExtensionId?: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'chrome-extension:'
      && /^[a-p]{32}$/.test(url.hostname)
      && (allowedExtensionId === undefined || url.hostname === allowedExtensionId);
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
    return `${url.protocol}//${url.host}${url.pathname}`;
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
  return {
    ...message,
    url: redactedNetworkUrl(message.url),
    data: runtimeState === undefined
      ? `[redacted ${message.data.length} bytes]`
      : JSON.stringify(runtimeState),
  };
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
  private error?: Error;
  private lastEmittedSeq = 0;
  private reconnectCount = 0;
  private flushWaiters: Array<() => void> = [];
  private restoreInFlight?: Promise<void>;
  private lastObservationAt: number;
  private transportContinuous = true;

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
    if (this.stopped) return;
    this.noteObservation();
    this.pending.push(event);
    if (this.started) {
      void this.drain();
    }
  }

  noteObservation(): void {
    this.lastObservationAt = Date.now();
    this.onObserved?.(this.tableId);
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
    if (now - this.lastObservationAt <= this.staleAfterMs) return;
    this.handleDisconnect('table-feed-stale');
  }

  handleDisconnect(reason?: string): void {
    if (this.stopped) return;
    const changed = this.state !== 'DISCONNECTED' || !this.paused;
    console.error('[bridge-table-disconnect]', this.tableId, reason ?? '');
    this.paused = true;
    this.state = 'DISCONNECTED';
    this.sink?.onDisconnect?.(this.tableId, reason);
    if (changed) this.onDisconnected?.(this.tableId, reason ?? 'table-disconnected');
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
    this.reconnectCount += 1;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
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
            payloadHash: sha256(stableStringify(event)),
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
      this.state = 'DISCONNECTED';
      this.paused = true;
      this.sink?.onDisconnect?.(this.tableId, this.error.message);
    } finally {
      this.processing = false;
      this.resolveFlushWaiters();
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
  private readonly evolutionParser = new EvolutionBaccaratParser();
  private readonly mstromShoeSessions = new Map<string, MstromShoeSessionRegistry>();
  private readonly mstromProtocolParsers = new Map<string, MstromProtocolEventParser>();
  private readonly mstromRuntimeParsers = new Map<string, MstromRuntimeParser>();
  private readonly parsedSourceSeqByTable = new Map<string, number>();
  private readonly parsedEventIds = new Set<string>();
  private configuredSelectedTables: ReadonlySet<string> | undefined;
  private runtimeSelectedTables: ReadonlySet<string> | undefined;
  private effectiveSelectedTables: ReadonlySet<string> | undefined;
  private lastMultiviewRecoveryAt = 0;
  private multiviewRecoveryTimer?: NodeJS.Timeout;
  private readonly multiviewRecoveryCooldownMs: number;
  private readonly multiviewOpenedGraceMs: number;
  private readonly tableStaleAfterMs: number;
  private readonly stalePageReloadAfterMs: number;
  private readonly extensionHeartbeatTimeoutMs: number;
  private readonly requireExtensionSequence: boolean;
  private freshnessTimer?: NodeJS.Timeout;
  private stalePageReloadTimer?: NodeJS.Timeout;
  private stalePageReloadAttempts = 0;
  private readonly staleTableIds = new Set<string>();
  private readonly socketLastSeenAt = new Map<WebSocket, number>();
  private readonly socketBridgeSession = new Map<WebSocket, string>();
  private readonly lastBridgeSeqBySession = new Map<string, number>();
  private activeBridgeSessionId?: string;
  private extensionConnected = false;
  private port = 0;

  constructor(options: BrowserBridgeServerOptions = {}) {
    this.options = options;
    this.betTimeoutMs = options.betTimeoutMs ?? 10_000;
    this.multiviewRecoveryCooldownMs = Math.max(
      1,
      options.multiviewRecoveryCooldownMs ?? MULTIVIEW_RECOVERY_COOLDOWN_MS,
    );
    this.multiviewOpenedGraceMs = Math.max(
      this.multiviewRecoveryCooldownMs,
      options.multiviewOpenedGraceMs ?? MULTIVIEW_OPENED_GRACE_MS,
    );
    this.tableStaleAfterMs = Math.max(1_000, options.tableStaleAfterMs ?? TABLE_STALE_AFTER_MS);
    this.stalePageReloadAfterMs = Math.max(
      this.tableStaleAfterMs,
      options.stalePageReloadAfterMs ?? STALE_PAGE_RELOAD_AFTER_MS,
    );
    this.extensionHeartbeatTimeoutMs = Math.max(
      1_000,
      options.extensionHeartbeatTimeoutMs ?? EXTENSION_HEARTBEAT_TIMEOUT_MS,
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
        this.sockets.add(socket);
        this.socketLastSeenAt.set(socket, Date.now());
        if (!this.extensionConnected) {
          this.extensionConnected = true;
        }
        this.emitRuntimeEvent({
          kind: 'extension-connected',
          timestamp: new Date().toISOString(),
        });
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
        this.sockets.delete(socket);
        this.socketLastSeenAt.delete(socket);
        this.socketBridgeSession.delete(socket);
        this.emitRuntimeEvent({
          kind: 'extension-disconnected',
          reason: rawReason.toString() || `websocket-close-${code}`,
          timestamp: new Date().toISOString(),
        });
        if (this.sockets.size === 0 && this.extensionConnected) {
          this.extensionConnected = false;
          this.handleBridgeDisconnect('browser-extension-disconnected');
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
    this.clearMultiviewRecoveryTimer();
    this.clearStalePageReloadTimer();
    this.staleTableIds.clear();
    if (this.freshnessTimer) {
      clearInterval(this.freshnessTimer);
      this.freshnessTimer = undefined;
    }
    for (const socket of [...this.sockets, ...this.observers, ...this.commandClients]) socket.close();
    this.sockets.clear();
    this.observers.clear();
    this.commandClients.clear();
    this.socketLastSeenAt.clear();
    this.socketBridgeSession.clear();
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
    const authenticated = sockets.length === 1
      && (!this.requireExtensionSequence || this.socketBridgeSession.has(sockets[0]!));
    return {
      connectionCount: sockets.length,
      authenticated,
      ...(lastSeenAt === undefined ? {} : { lastSeenAt: new Date(lastSeenAt).toISOString() }),
    };
  }

  /** Starts an independent logical monitor session without claiming a physical shoe reset. */
  beginMonitorSession(): void {
    this.clearStalePageReloadTimer();
    this.staleTableIds.clear();
    this.stalePageReloadAttempts = 0;
    this.mstromShoeSessions.clear();
    this.mstromProtocolParsers.clear();
    this.mstromRuntimeParsers.clear();
    this.parsedSourceSeqByTable.clear();
    this.parsedEventIds.clear();
    for (const [key, exportInstance] of this.exports) {
      if (!key.startsWith('dafabet-live::')) continue;
      void exportInstance.stop();
      this.exports.delete(key);
    }
    this.rooms.delete('dafabet-live');
    this.discoveredRooms.delete('dafabet-live');
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
    const confirmation = this.getMstromShoeSession(tableId).confirmOperatorPhysicalShoe(tableId);
    if (!confirmation.rotated) return;
    const shoe = confirmation.shoe;
    this.mstromProtocolParsers.delete(tableId);
    this.mstromRuntimeParsers.delete(tableId);
    this.ingestParsedEvents([{
      type: 'newShoeSignal',
      eventId: `mstrom-session:${shoe.shoeId}:new-shoe`,
      tableId,
      timestamp: new Date().toISOString(),
      sourceSeq: 0,
      source: 'operator',
      schemaVersion: EVENT_SCHEMA_VERSION,
      shoeId: shoe.shoeId,
      baseline: 'physical-shoe',
      profile: { ...defaultProfile(tableId), autoConfirmNewShoe: true },
    }]);
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
      const revision = typeof receipt.raw === 'object' && receipt.raw !== null
        ? Reflect.get(receipt.raw, 'runtimeRevision')
        : undefined;
      if (revision !== MSTROM_BET_RUNTIME_REVISION) {
        throw new OperationalWagerRuntimeRevisionError(receipt);
      }
      return receipt;
    }
    throw new Error('browser extension returned a pair-bet receipt for an operational wager request');
  }

  private async requestExecution(request: BridgeExecutionRequest): Promise<BridgeExecutionReceipt | null> {
    const tableId = 'intent' in request ? request.intent.tableId : request.wager.tableId;
    return await this.serializeTableExecution(tableId, async () => await this.dispatchExecution(request));
  }

  private async serializeTableExecution<T>(tableId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tableExecutionTails.get(tableId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(() => undefined, () => undefined);
    this.tableExecutionTails.set(tableId, tail);
    void tail.then(() => {
      if (this.tableExecutionTails.get(tableId) === tail) this.tableExecutionTails.delete(tableId);
    });
    return await current;
  }

  private async dispatchExecution(request: BridgeExecutionRequest): Promise<BridgeExecutionReceipt | null> {
    const sockets = [...this.sockets];
    if (request.mode === 'live' && !this.getExtensionStatus().authenticated) {
      throw new Error(LIVE_EXTENSION_CONNECTION_ERROR);
    }
    if (sockets.length === 0) {
      throw new Error('no browser extension connected to execute bets');
    }
    const requestId = newId('bet');
    const message: BridgeServerMessage = { kind: 'betRequest', requestId, request };
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
        ownerSocket: request.mode === 'live' ? sockets[0] : undefined,
      });
    });
    for (const socket of sockets) socket.send(raw);
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
      ...this.mstromShoeSessions.keys(),
      ...this.mstromProtocolParsers.keys(),
      ...this.mstromRuntimeParsers.keys(),
      ...this.parsedSourceSeqByTable.keys(),
    ]);

    this.configuredSelectedTables = nextSelectedTables;
    this.refreshEffectiveSelectedTables();
    this.pruneUnselectedTables();
    for (const staleTableId of this.staleTableIds) {
      if (!nextSelectedTables.has(staleTableId)) this.clearStaleTable(staleTableId);
    }
    for (const tableId of trackedTableIds) {
      if (!nextSelectedTables.has(tableId) || !wasPreviouslySelected(tableId)) {
        this.resetMstromTableState(tableId);
      }
    }

    const runtimeHasNoConfiguredOverlap = this.runtimeSelectedTables !== undefined
      && this.runtimeSelectedTables.size > 0
      && ![...this.runtimeSelectedTables].some(tableId => nextSelectedTables.has(tableId));
    if (this.isConfiguredMultiviewIncomplete() || runtimeHasNoConfiguredOverlap) {
      this.requestMultiviewRecovery();
    } else {
      this.clearMultiviewRecoveryTimer();
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

  getDiscoveredRooms(): RoomDescriptor[] {
    return [...this.discoveredRooms.values()].map(room => ({
      roomId: room.roomId,
      ...(room.displayName === undefined ? {} : { displayName: room.displayName }),
      tables: room.tables.map(table => ({
        tableId: table.tableId,
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
      tables: room.tables.map(table => ({
        tableId: table.tableId,
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
      case 'roomUpdated':
        this.discoveredRooms.set(message.room.roomId, {
          ...message.room,
          tables: message.room.tables,
        });
        this.rooms.set(message.room.roomId, {
          ...message.room,
          tables: message.room.tables.filter(table => this.isTableSelected(table.tableId)),
        });
        break;
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
        logNetworkCapture(message);
        if (message.source === 'baccarat-bridge-jsonparse') {
          this.ingestParsedEvents(this.evolutionParser.parse(message.data));
        } else if (message.source === 'baccarat-bridge-runtime-selection') {
          this.applyRuntimeSelection(message.data);
        } else if (message.source === 'baccarat-bridge-runtime-state') {
          const tableId = runtimeStateTableId(message.data);
          if (tableId !== null && this.isTableSelected(tableId)) {
            this.noteTableObservation(tableId);
            this.ingestParsedEvents(this.getMstromRuntimeParser(tableId).parse(message.data));
          }
        } else if (
          message.source === 'baccarat-bridge-ws'
          && message.encoding === 'base64'
          && message.direction !== 'send'
        ) {
          const bytes = Uint8Array.from(Buffer.from(message.data, 'base64'));
          const parsed = parseMstromFrame(bytes);
          if (parsed.ok && this.isTableSelected(parsed.frame.tableId)) {
            this.noteTableObservation(parsed.frame.tableId);
            this.ingestParsedEvents(
              this.getMstromProtocolParser(parsed.frame.tableId).ingest(parsed.frame, new Date().toISOString()),
            );
          }
        }
        break;
      case 'sessionExpired':
        console.error('[session-expired]', JSON.stringify(redactedLifecycleMessage(message)));
        this.invalidateBridgeContinuity('game-session-expired');
        break;
      case 'sessionAction':
        console.log('[session-action]', JSON.stringify(redactedLifecycleMessage(message)));
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
        if (message.detail?.startsWith('openMultiView:opened:') && this.isConfiguredMultiviewIncomplete()) {
          this.clearMultiviewRecoveryTimer();
          this.scheduleMultiviewRecovery(this.multiviewOpenedGraceMs);
        }
        break;
      case 'command':
        console.log('[bridge-command]', JSON.stringify(message));
        this.broadcastToSockets({
          kind: 'command',
          name: message.name,
          ...(message.tableIds === undefined ? {} : { tableIds: message.tableIds }),
        });
        break;
      case 'hello':
      case 'heartbeat':
      case 'keepalive':
        break;
    }
    if (OBSERVABLE_KINDS.has(message.kind)) {
      this.broadcastToObservers({
        kind: 'observe',
        message: redactedLifecycleMessage(message as Extract<
          BridgeClientMessage,
          { kind: 'sessionExpired' | 'sessionAction' | 'keepalive' }
        >),
      });
    } else if (message.kind === 'networkCapture' && OBSERVABLE_NETWORK_PATTERN.test(message.url)) {
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
      const configuredMultiviewIsIncomplete = configuredSelectedTables !== undefined
        && configuredSelectedTables.size > 1
        && [...configuredSelectedTables].some(tableId => !selected.has(tableId));
      this.runtimeSelectedTables = hasConfiguredOverlap ? selected : new Set();
      this.refreshEffectiveSelectedTables();
      if (this.configuredSelectedTables === undefined) this.pruneUnselectedTables();

      if (configuredMultiviewIsIncomplete || (selected.size > 0 && !hasConfiguredOverlap)) {
        this.requestMultiviewRecovery();
      } else {
        this.clearMultiviewRecoveryTimer();
      }
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

  private resetMstromTableState(tableId: string): void {
    this.mstromShoeSessions.delete(tableId);
    this.mstromProtocolParsers.delete(tableId);
    this.mstromRuntimeParsers.delete(tableId);
    this.parsedSourceSeqByTable.delete(tableId);
  }

  private getMstromShoeSession(tableId: string): MstromShoeSessionRegistry {
    const existing = this.mstromShoeSessions.get(tableId);
    if (existing) return existing;
    const created = new MstromShoeSessionRegistry();
    this.mstromShoeSessions.set(tableId, created);
    return created;
  }

  private getMstromProtocolParser(tableId: string): MstromProtocolEventParser {
    const existing = this.mstromProtocolParsers.get(tableId);
    if (existing) return existing;
    const created = new MstromProtocolEventParser(this.getMstromShoeSession(tableId));
    this.mstromProtocolParsers.set(tableId, created);
    return created;
  }

  private getMstromRuntimeParser(tableId: string): MstromRuntimeParser {
    const existing = this.mstromRuntimeParsers.get(tableId);
    if (existing) return existing;
    const created = new MstromRuntimeParser(this.getMstromShoeSession(tableId));
    this.mstromRuntimeParsers.set(tableId, created);
    return created;
  }

  private requestMultiviewRecovery(): void {
    if (this.configuredSelectedTables === undefined) return;
    const now = Date.now();
    const elapsed = now - this.lastMultiviewRecoveryAt;
    if (elapsed < this.multiviewRecoveryCooldownMs) {
      this.scheduleMultiviewRecovery(this.multiviewRecoveryCooldownMs - elapsed);
      return;
    }
    this.lastMultiviewRecoveryAt = now;
    this.broadcastToSockets({
      kind: 'command',
      name: 'openMultiView',
      tableIds: [...this.configuredSelectedTables],
    });
    if (this.isConfiguredMultiviewIncomplete()) {
      this.scheduleMultiviewRecovery(this.multiviewRecoveryCooldownMs);
    }
  }

  private isConfiguredMultiviewIncomplete(): boolean {
    return this.configuredSelectedTables !== undefined
      && this.configuredSelectedTables.size > 1
      && this.runtimeSelectedTables !== undefined
      && [...this.configuredSelectedTables].some(tableId => !this.runtimeSelectedTables?.has(tableId));
  }

  private scheduleMultiviewRecovery(delayMs: number): void {
    if (!this.isConfiguredMultiviewIncomplete() || this.multiviewRecoveryTimer !== undefined) return;
    this.multiviewRecoveryTimer = setTimeout(() => {
      this.multiviewRecoveryTimer = undefined;
      if (this.isConfiguredMultiviewIncomplete()) this.requestMultiviewRecovery();
    }, delayMs);
    this.multiviewRecoveryTimer.unref();
  }

  private clearMultiviewRecoveryTimer(): void {
    if (this.multiviewRecoveryTimer === undefined) return;
    clearTimeout(this.multiviewRecoveryTimer);
    this.multiviewRecoveryTimer = undefined;
  }

  private ingestParsedEvents(events: readonly NormalizedEvent[]): void {
    for (const event of events) {
      if (!this.isTableSelected(event.tableId)) continue;
      if (this.parsedEventIds.has(event.eventId)) continue;
      this.parsedEventIds.add(event.eventId);
      const sourceSeq = (this.parsedSourceSeqByTable.get(event.tableId) ?? 0) + 1;
      this.parsedSourceSeqByTable.set(event.tableId, sourceSeq);
      const normalizedEvent: NormalizedEvent = event.sourceSeq === sourceSeq
        ? event
        : { ...event, sourceSeq };
      console.log('[bridge-event]', JSON.stringify(normalizedEvent));
      this.ensureRoomForTable(normalizedEvent.tableId);
      const exportInstance = this.getOrCreateExport('dafabet-live', normalizedEvent.tableId);
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

  private ensureRoomForTable(tableId: string): void {
    if (!this.isTableSelected(tableId)) return;
    const roomId = 'dafabet-live';
    const discovered = this.discoveredRooms.get(roomId);
    if (!discovered) {
      this.discoveredRooms.set(roomId, {
        roomId,
        displayName: 'Dafabet Live Dealer',
        tables: [{ tableId }],
      });
    } else if (!discovered.tables.some(table => table.tableId === tableId)) {
      discovered.tables.push({ tableId });
    }
    const selected = this.rooms.get(roomId);
    if (!selected) {
      this.rooms.set(roomId, {
        roomId,
        displayName: 'Dafabet Live Dealer',
        tables: [{ tableId }],
      });
    } else if (!selected.tables.some(table => table.tableId === tableId)) {
      selected.tables.push({ tableId });
    }
  }

  private handleBridgeDisconnect(reason: string): void {
    for (const exportInstance of this.exports.values()) {
      exportInstance.handleDisconnect(reason);
    }
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

  private clearStaleTable(tableId: string): void {
    if (!this.staleTableIds.delete(tableId) || this.staleTableIds.size > 0) return;
    this.clearStalePageReloadTimer();
    this.stalePageReloadAttempts = 0;
  }

  private noteStaleTable(tableId: string): void {
    const wasEmpty = this.staleTableIds.size === 0;
    this.staleTableIds.add(tableId);
    if (!wasEmpty || this.stalePageReloadTimer !== undefined) return;
    this.stalePageReloadAttempts = 0;
    this.scheduleStalePageReload(
      Math.max(0, this.stalePageReloadAfterMs - this.tableStaleAfterMs),
    );
  }

  private scheduleStalePageReload(delayMs: number): void {
    if (this.stalePageReloadTimer !== undefined || this.staleTableIds.size === 0) return;
    this.stalePageReloadTimer = setTimeout(() => {
      this.stalePageReloadTimer = undefined;
      if (this.staleTableIds.size === 0) return;
      this.broadcastToSockets({
        kind: 'command',
        name: 'reloadGameTabs',
        tableIds: [...this.staleTableIds].sort(),
      });
      const retryDelay = STALE_PAGE_RELOAD_RETRY_DELAYS_MS[
        Math.min(this.stalePageReloadAttempts, STALE_PAGE_RELOAD_RETRY_DELAYS_MS.length - 1)
      ];
      this.stalePageReloadAttempts += 1;
      this.scheduleStalePageReload(retryDelay);
    }, delayMs);
    this.stalePageReloadTimer.unref();
  }

  private clearStalePageReloadTimer(): void {
    if (this.stalePageReloadTimer === undefined) return;
    clearTimeout(this.stalePageReloadTimer);
    this.stalePageReloadTimer = undefined;
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
        if (now - lastSeenAt <= this.extensionHeartbeatTimeoutMs) continue;
        socket.close(4001, 'extension heartbeat stale');
      }
      for (const exportInstance of this.exports.values()) {
        exportInstance.checkFreshness(now);
      }
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
    const created = new BridgeTableExport(
      roomId,
      tableId,
      this.tableStaleAfterMs,
      (disconnectedTableId, reason) => {
        if (reason === 'table-feed-stale') this.noteStaleTable(disconnectedTableId);
        this.emitRuntimeEvent({
          kind: 'table-disconnected',
          tableId: disconnectedTableId,
          reason,
          timestamp: new Date().toISOString(),
        });
      },
      observedTableId => this.clearStaleTable(observedTableId),
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

function runtimeStateTableId(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const tableId = Reflect.get(parsed, 'tableId');
    return typeof tableId === 'string' && tableId.length > 0 ? tableId : null;
  } catch {
    return null;
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
