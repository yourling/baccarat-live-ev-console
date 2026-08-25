import { EVENT_SCHEMA_VERSION, sha256, stableStringify, defaultProfile, newId, type BetReceipt, type NormalizedEvent } from '@baccarat/contracts';
import type {
  BetExecutionRequest,
  OperationalWagerExecutionRequest,
  OperationalWagerReceipt,
} from '@baccarat/adapter-contract';
import type { IncomingMessage } from 'node:http';
import type {
  MonitorConnectionState,
  MonitorHealth,
  MonitorKeepAliveResult,
  RoomDescriptor,
  RoomMonitor,
  TableCursor,
  TableEventBatch,
  TableExport,
  TableExportSink,
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

export interface BrowserBridgeServerOptions {
  port?: number;
  host?: string;
  betTimeoutMs?: number;
  multiviewRecoveryCooldownMs?: number;
  multiviewOpenedGraceMs?: number;
  selectedTableIds?: readonly string[];
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

const LIVE_EXTENSION_CONNECTION_ERROR = 'live bet execution requires exactly one browser extension connection';
const LIVE_BET_CONNECTION_LOST_ERROR = 'browser extension disconnected before live bet result';
const OBSERVER_PATH = '/observe';
const COMMAND_PATH = '/command';
const BRIDGE_DEBUG_ENABLED = process.env.BACCARAT_BRIDGE_DEBUG === '1';

/** 已配置多桌在单桌回退时请求页面恢复的最短间隔。 */
const MULTIVIEW_RECOVERY_COOLDOWN_MS = 10_000;

/** 页面确认已打开多台后，留给真实页面完成加载的宽限时间。 */
const MULTIVIEW_OPENED_GRACE_MS = 60_000;

type BridgeSocketRole = 'extension' | 'observer' | 'command';

function bridgeSocketRole(origin: string, requestUrl: string | undefined): BridgeSocketRole | null {
  const path = bridgeRequestPath(requestUrl);
  if (isExtensionOrigin(origin)) return path === '/' ? 'extension' : null;
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

function isExtensionOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'chrome-extension:' && /^[a-p]{32}$/.test(url.hostname);
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

function isBridgeCommand(value: unknown): value is Extract<BridgeClientMessage, { kind: 'command' }> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Reflect.get(value, 'kind') === 'command'
    && typeof Reflect.get(value, 'name') === 'string';
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
  private autoRestoreTimer?: NodeJS.Timeout;

  constructor(roomId: string, tableId: string) {
    this.roomId = roomId;
    this.tableId = tableId;
    this.cursor = { tableId, sourceSeq: 0, eventId: '', payloadHash: '' };
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
    if (this.autoRestoreTimer) {
      clearTimeout(this.autoRestoreTimer);
      this.autoRestoreTimer = undefined;
    }
  }

  async flush(): Promise<void> {
    while (this.processing) {
      await new Promise<void>(resolve => this.flushWaiters.push(resolve));
    }
    if (this.error) {
      throw this.error;
    }
  }

  async keepAlive(): Promise<MonitorKeepAliveResult> {
    const ok = this.started && !this.stopped && this.state === 'CONNECTED';
    return {
      ok,
      latencyMs: 1,
      ...(ok ? {} : { error: this.error?.message ?? 'not connected' }),
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
      ...(this.error ? { lastError: this.error.message } : {}),
    };
  }

  ingestEvent(event: NormalizedEvent): void {
    if (this.stopped) return;
    this.pending.push(event);
    if (this.started && !this.paused) {
      void this.drain();
    }
  }

  handleDisconnect(reason?: string): void {
    if (this.stopped) return;
    console.error('[bridge-table-disconnect]', this.tableId, reason ?? '');
    this.paused = true;
    this.state = 'DISCONNECTED';
    this.sink?.onDisconnect?.(this.tableId, reason);
  }

  handleRestored(proof: string): void {
    if (this.stopped) return;
    if (this.state === 'CONNECTED' && !this.paused) return;
    if (this.autoRestoreTimer) {
      clearTimeout(this.autoRestoreTimer);
      this.autoRestoreTimer = undefined;
    }
    this.error = undefined;
    this.paused = false;
    this.state = 'CONNECTED';
    this.reconnectCount += 1;
    this.sink?.onRestored?.(this.tableId, proof);
    void this.drain();
  }

  private scheduleAutoRestore(error: Error): void {
    if (this.autoRestoreTimer) return;
    console.error('[bridge-export-error]', this.tableId, error.message);
    this.autoRestoreTimer = setTimeout(() => {
      this.autoRestoreTimer = undefined;
      if (this.stopped) return;
      this.error = undefined;
      this.paused = false;
      this.state = 'CONNECTED';
      this.reconnectCount += 1;
      this.sink?.onRestored?.(this.tableId, `auto-recover:${Date.now()}`);
      void this.drain();
    }, 2000);
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (!this.stopped && this.started && !this.paused && this.pending.length > 0) {
        const event = this.pending.shift()!;
        if (event.sourceSeq <= this.cursor.sourceSeq) continue;
        // 实时桥允许源序号缺口：解析层可能漏掉个别中间消息，
        // 后续 gameState/shoeState 会提供完整快照，不应因缺口永久停摆。
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
        this.cursor = batch.cursor;
        this.lastEmittedSeq = event.sourceSeq;
      }
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.state = 'DISCONNECTED';
      this.paused = true;
      this.sink?.onDisconnect?.(this.tableId, this.error.message);
      this.scheduleAutoRestore(this.error);
    } finally {
      this.processing = false;
      const waiters = this.flushWaiters.splice(0);
      for (const waiter of waiters) waiter();
    }
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
      verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) =>
        bridgeSocketRole(info.origin, info.req.url) !== null,
    });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    this.wss = wss;
    const address = wss.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    wss.on('connection', (socket, request) => {
      const role = bridgeSocketRole(String(request.headers.origin ?? ''), request.url);
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
        if (!this.extensionConnected) {
          this.extensionConnected = true;
          this.handleBridgeRestored('browser-extension-connected');
        }
      }
      socket.on('message', data => {
        if (role === 'observer') return;
        try {
          const message: unknown = JSON.parse(data.toString());
          if (role === 'command' && !isBridgeCommand(message)) return;
          this.ingestClientMessage(message, socket);
        } catch {
          // ignore malformed messages from untrusted extensions
        }
      });
      socket.on('error', () => {
        if (role !== 'extension') return;
        this.rejectPendingBets(new Error(LIVE_BET_CONNECTION_LOST_ERROR), socket);
      });
      socket.on('close', () => {
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
    return this.port;
  }

  async close(): Promise<void> {
    this.clearMultiviewRecoveryTimer();
    for (const socket of [...this.sockets, ...this.observers, ...this.commandClients]) socket.close();
    this.sockets.clear();
    this.observers.clear();
    this.commandClients.clear();
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

  /** Starts an independent logical monitor session without claiming a physical shoe reset. */
  beginMonitorSession(): void {
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
    if (receipt === null || isOperationalWagerReceipt(receipt)) return receipt;
    throw new Error('browser extension returned a pair-bet receipt for an operational wager request');
  }

  private async requestExecution(request: BridgeExecutionRequest): Promise<BridgeExecutionReceipt | null> {
    const sockets = [...this.sockets];
    if (request.mode === 'live' && sockets.length !== 1) {
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
    if (enabled && this.sockets.size !== 1) {
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
        // 收到实时数据即视为连接恢复：过期恢复/断线后第一帧数据会重新点亮导出。
        const exportInstance = this.getOrCreateExport(message.roomId, message.tableId);
        exportInstance.handleRestored('data-received');
        exportInstance.ingestEvent(message.event);
        break;
      }
      case 'tableDisconnected':
        if (!this.isTableSelected(message.tableId)) break;
        this.exports.get(exportKey(message.roomId, message.tableId))?.handleDisconnect(message.reason);
        break;
      case 'tableRestored':
        if (!this.isTableSelected(message.tableId)) break;
        this.exports.get(exportKey(message.roomId, message.tableId))?.handleRestored(message.proof);
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
        console.log('[bridge-diagnostic]', JSON.stringify(message));
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
            this.ingestParsedEvents(this.getMstromRuntimeParser(tableId).parse(message.data));
          }
        } else if (
          message.source === 'baccarat-bridge-ws'
          && message.encoding === 'base64'
          && message.direction !== 'send'
          && /mstrom-uno|673ing|mdvuz|e9p1/i.test(message.url)
        ) {
          const bytes = Uint8Array.from(Buffer.from(message.data, 'base64'));
          const parsed = parseMstromFrame(bytes);
          if (parsed.ok && this.isTableSelected(parsed.frame.tableId)) {
            this.ingestParsedEvents(
              this.getMstromProtocolParser(parsed.frame.tableId).ingest(parsed.frame, new Date().toISOString()),
            );
          }
        }
        break;
      case 'sessionExpired':
        console.error('[session-expired]', JSON.stringify(message));
        this.handleBridgeDisconnect('game-session-expired');
        break;
      case 'sessionAction':
        console.log('[session-action]', JSON.stringify(message));
        if (message.detail?.startsWith('openMultiView:opened:') && this.isConfiguredMultiviewIncomplete()) {
          this.clearMultiviewRecoveryTimer();
          this.scheduleMultiviewRecovery(this.multiviewOpenedGraceMs);
        }
        if (message.action === 'recovered') {
          this.handleBridgeRestored('session-recovered');
        }
        break;
      case 'command':
        console.log('[bridge-command]', JSON.stringify(message));
        this.broadcastToSockets({ kind: 'command', name: message.name });
        break;
      case 'hello':
      case 'heartbeat':
      case 'keepalive':
        break;
    }
    if (OBSERVABLE_KINDS.has(message.kind)) {
      this.broadcastToObservers({ kind: 'observe', message });
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
      exportInstance.handleRestored('data-received');
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

  private handleBridgeRestored(proof: string): void {
    for (const exportInstance of this.exports.values()) {
      exportInstance.handleRestored(proof);
    }
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
    const created = new BridgeTableExport(roomId, tableId);
    this.exports.set(key, created);
    return created;
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
