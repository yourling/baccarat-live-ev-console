import { sha256, stableStringify, defaultProfile, newId, type BetReceipt, type NormalizedEvent } from '@baccarat/contracts';
import type { BetExecutionRequest } from '@baccarat/adapter-contract';
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
import type { BridgeClientMessage, BridgeRoomDescriptor, BridgeServerMessage } from './protocol.js';
import { EvolutionBaccaratParser } from './evolution.js';

export interface BrowserBridgeServerOptions {
  port?: number;
  host?: string;
  betTimeoutMs?: number;
}

type PendingBet = {
  resolve: (receipt: BetReceipt | null) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * 转发给所有已连接观察客户端的消息类型：
 * 桥接服务把扩展发来的会话/保活/诊断事件广播出去，
 * 让 bridge:observe 之类的观察者在桌面控制台已占用端口时仍能实时观测。
 */
const OBSERVABLE_KINDS = new Set(['sessionExpired', 'sessionAction', 'keepalive']);

/** 观察广播允许透传的网络捕获域名(游戏/聊天/会话通道,不含视频流)。 */
const OBSERVABLE_NETWORK_PATTERN = /df888evo|evolution|evo/i;

/** 观察广播中 networkCapture 的 data 截断长度(视频流等大帧只传头部)。 */
const OBSERVABLE_NETWORK_DATA_LIMIT = 800;

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
  private rooms = new Map<string, BridgeRoomDescriptor>();
  private exports = new Map<string, BridgeTableExport>();
  private pendingBets = new Map<string, PendingBet>();
  private readonly evolutionParser = new EvolutionBaccaratParser();
  private extensionConnected = false;
  private port = 0;

  constructor(options: BrowserBridgeServerOptions = {}) {
    this.options = options;
    this.betTimeoutMs = options.betTimeoutMs ?? 10_000;
  }

  async start(): Promise<number> {
    if (this.wss) return this.port;
    const wss = new WebSocketServer({
      port: this.options.port ?? 0,
      host: this.options.host ?? '127.0.0.1',
    });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    this.wss = wss;
    const address = wss.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    wss.on('connection', socket => {
      this.sockets.add(socket);
      if (!this.extensionConnected) {
        this.extensionConnected = true;
        this.handleBridgeRestored('browser-extension-connected');
      }
      socket.on('message', data => {
        try {
          this.ingestClientMessage(JSON.parse(data.toString()));
        } catch {
          // ignore malformed messages from untrusted extensions
        }
      });
      socket.on('close', () => {
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
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    if (this.wss) {
      const wss = this.wss;
      this.wss = undefined;
      await new Promise<void>(resolve => wss.close(() => resolve()));
    }
    for (const [requestId, pending] of this.pendingBets) {
      clearTimeout(pending.timer);
      pending.reject(new Error('browser bridge stopped before bet result'));
      this.pendingBets.delete(requestId);
    }
  }

  getPort(): number {
    return this.port;
  }

  async discoverRooms(): Promise<RoomDescriptor[]> {
    return this.getRooms();
  }

  openTable(roomId: string, tableId: string): TableExport {
    return this.getOrCreateExport(roomId, tableId);
  }

  async requestBet(request: BetExecutionRequest): Promise<BetReceipt | null> {
    if (this.sockets.size === 0) {
      throw new Error('no browser extension connected to execute bets');
    }
    const requestId = newId('bet');
    const message: BridgeServerMessage = { kind: 'betRequest', requestId, request };
    const raw = JSON.stringify(message);
    for (const socket of this.sockets) socket.send(raw);
    return await new Promise<BetReceipt | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBets.delete(requestId);
        reject(new Error(`bet request timed out: ${requestId}`));
      }, this.betTimeoutMs);
      this.pendingBets.set(requestId, { resolve, reject, timer });
    });
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

  ingestClientMessage(raw: unknown): void {
    const message = raw as BridgeClientMessage;
    switch (message.kind) {
      case 'roomDiscovered':
      case 'roomUpdated':
        this.rooms.set(message.room.roomId, message.room);
        break;
      case 'tableEvent': {
        // 收到实时数据即视为连接恢复：过期恢复/断线后第一帧数据会重新点亮导出。
        const exportInstance = this.getOrCreateExport(message.roomId, message.tableId);
        exportInstance.handleRestored('data-received');
        exportInstance.ingestEvent(message.event);
        break;
      }
      case 'tableDisconnected':
        this.exports.get(exportKey(message.roomId, message.tableId))?.handleDisconnect(message.reason);
        break;
      case 'tableRestored':
        this.exports.get(exportKey(message.roomId, message.tableId))?.handleRestored(message.proof);
        break;
      case 'betResult': {
        const pending = this.pendingBets.get(message.requestId);
        if (!pending) break;
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
        console.log('[bridge-network]', JSON.stringify(message));
        if (message.source === 'baccarat-bridge-jsonparse' && typeof message.data === 'string') {
          const events = this.evolutionParser.parse(message.data);
          for (const event of events) {
            console.log('[bridge-event]', JSON.stringify(event));
            this.ensureRoomForTable(event.tableId);
            const exportInstance = this.getOrCreateExport('dafabet-live', event.tableId);
            exportInstance.handleRestored('data-received');
            exportInstance.ingestEvent(event);
          }
        }
        break;
      case 'sessionExpired':
        console.error('[session-expired]', JSON.stringify(message));
        this.handleBridgeDisconnect('game-session-expired');
        break;
      case 'sessionAction':
        console.log('[session-action]', JSON.stringify(message));
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
      this.broadcastToSockets({ kind: 'observe', message });
    } else if (message.kind === 'networkCapture' && OBSERVABLE_NETWORK_PATTERN.test(message.url)) {
      const observable: BridgeClientMessage = {
        ...message,
        data: message.data.slice(0, OBSERVABLE_NETWORK_DATA_LIMIT),
      };
      this.broadcastToSockets({ kind: 'observe', message: observable });
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

  private ensureRoomForTable(tableId: string): void {
    const roomId = 'dafabet-live';
    const existing = this.rooms.get(roomId);
    if (!existing) {
      this.rooms.set(roomId, {
        roomId,
        displayName: 'Dafabet Live Dealer',
        tables: [{ tableId }],
      });
      return;
    }
    if (!existing.tables.some(table => table.tableId === tableId)) {
      existing.tables.push({ tableId });
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

  private getOrCreateExport(roomId: string, tableId: string): BridgeTableExport {
    const key = exportKey(roomId, tableId);
    const existing = this.exports.get(key);
    if (existing) return existing;
    const created = new BridgeTableExport(roomId, tableId);
    this.exports.set(key, created);
    return created;
  }
}

function exportKey(roomId: string, tableId: string): string {
  return `${roomId}::${tableId}`;
}
