import { sha256, stableStringify, type NormalizedEvent, type TableProfile } from '@baccarat/contracts';
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
} from './types.js';

export interface ShadowFaultPlan {
  /** 在成功导出并确认第 N 个事件后模拟断线（按已确认事件数）。 */
  disconnectAfterEvent?: number;
  /** 断线后自动恢复前的等待毫秒；缺省不自动恢复。 */
  restoreAfterMs?: number;
  /** 恢复时使用的 continuity proof；缺省由监控层根据游标生成。 */
  continuityProof?: string;
}

export interface ShadowTableConfig {
  tableId: string;
  profile: TableProfile;
  /** 已归一化的事件流；会按 sourceSeq 排序后导出。 */
  events: NormalizedEvent[];
  monitorUrl?: string;
  maxBatchSize?: number;
  latencyMs?: number;
  /** 默认 false：检测到 sourceSeq 缺口时停止导出并进入 DISCONNECTED。 */
  allowGaps?: boolean;
  /** 可选故障注入：断线、自动恢复与连续性证明。 */
  faults?: ShadowFaultPlan;
}

export interface ShadowRoomConfig {
  roomId: string;
  displayName?: string;
  tables: ShadowTableConfig[];
}

export interface ShadowRoomMonitorOptions {
  rooms: ShadowRoomConfig[];
  maxBatchSize?: number;
  latencyMs?: number;
}

export class MonitorGapError extends Error {
  constructor(
    message: string,
    readonly tableId: string,
    readonly expectedSeq: number,
    readonly actualSeq: number,
  ) {
    super(message);
    this.name = 'MonitorGapError';
  }
}

export class UnknownTableError extends Error {
  constructor(tableId: string) {
    super(`unknown table in room monitor: ${tableId}`);
    this.name = 'UnknownTableError';
  }
}

class ShadowTableExport implements TableExport {
  readonly tableId: string;

  private readonly sourceEvents: NormalizedEvent[];
  private readonly profile: TableProfile;
  private readonly monitorUrl?: string;
  private readonly maxBatchSize: number;
  private readonly latencyMs: number;
  private readonly allowGaps: boolean;
  private readonly faults?: ShadowFaultPlan;

  private sink?: TableExportSink;
  private disconnectFired = false;
  private reconnectCount = 0;
  private started = false;
  private stopped = false;
  private state: MonitorConnectionState = 'DISCONNECTED';
  private cursor: TableCursor;
  private deliveredCount = 0;
  private lastEmittedSeq = 0;
  private error?: Error;
  private runPromise?: Promise<void>;

  constructor(config: ShadowTableConfig, defaults: { maxBatchSize: number; latencyMs: number }) {
    this.tableId = config.tableId;
    this.profile = config.profile;
    this.monitorUrl = config.monitorUrl;
    this.maxBatchSize = config.maxBatchSize ?? defaults.maxBatchSize;
    this.latencyMs = config.latencyMs ?? defaults.latencyMs;
    this.allowGaps = config.allowGaps ?? false;
    this.faults = config.faults;
    this.sourceEvents = config.events
      .slice()
      .sort((a, b) =>
        a.sourceSeq - b.sourceSeq ||
        a.timestamp.localeCompare(b.timestamp) ||
        a.eventId.localeCompare(b.eventId),
      );
    this.cursor = {
      tableId: this.tableId,
      sourceSeq: 0,
      eventId: '',
      payloadHash: '',
    };
  }

  async start(sink: TableExportSink, cursor?: TableCursor): Promise<void> {
    if (this.started) {
      throw new Error(`TableExport ${this.tableId} already started`);
    }
    this.sink = sink;
    this.started = true;
    this.stopped = false;
    this.error = undefined;
    this.state = 'CONNECTED';
    if (cursor) {
      if (cursor.tableId !== this.tableId) {
        throw new Error(`cursor.tableId ${cursor.tableId} does not match export table ${this.tableId}`);
      }
      this.cursor = { ...cursor };
      this.deliveredCount = this.sourceEvents.filter(event => event.sourceSeq <= cursor.sourceSeq).length;
    }
    this.runPromise = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.state = 'DISCONNECTED';
  }

  async flush(): Promise<void> {
    if (this.runPromise) {
      await this.runPromise;
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
      bufferDepth: Math.max(0, this.sourceEvents.length - this.deliveredCount),
      reconnectCount: this.reconnectCount,
      ...(this.error ? { lastError: this.error.message } : {}),
    };
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopped && this.started) {
        const pending = this.sourceEvents.slice(this.deliveredCount);
        if (pending.length === 0) break;

        const batchEvents = pending.slice(0, this.maxBatchSize);
        this.assertNoGaps(batchEvents);

        const last = batchEvents[batchEvents.length - 1];
        const batch: TableEventBatch = {
          tableId: this.tableId,
          events: batchEvents,
          cursor: {
            tableId: this.tableId,
            sourceSeq: last.sourceSeq,
            eventId: last.eventId,
            payloadHash: sha256(stableStringify(last)),
          },
          kind: this.cursor.sourceSeq > 0 ? 'replay' : 'live',
        };

        await this.sink!.onBatch(batch);

        this.cursor = batch.cursor;
        this.deliveredCount += batchEvents.length;
        this.lastEmittedSeq = last.sourceSeq;

        if (this.faults) {
          await this.maybeTriggerDisconnect();
          if (this.stopped) break;
        }

        if (this.latencyMs > 0) {
          await delay(this.latencyMs);
        }
      }
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.state = 'DISCONNECTED';
      this.sink?.onDisconnect?.(this.tableId, this.error.message);
    }
  }

  private async maybeTriggerDisconnect(): Promise<void> {
    const faults = this.faults;
    if (!faults || this.disconnectFired) return;
    const threshold = faults.disconnectAfterEvent ?? Number.POSITIVE_INFINITY;
    if (this.deliveredCount < threshold) return;

    this.disconnectFired = true;
    this.state = 'DISCONNECTED';
    this.sink?.onDisconnect?.(this.tableId, 'simulated-disconnect');

    if (faults.restoreAfterMs === undefined) {
      this.stopped = true;
      return;
    }

    this.state = 'RESYNCING';
    await delay(faults.restoreAfterMs);
    if (this.stopped) return;

    const proof = faults.continuityProof ?? this.buildContinuityProof();
    const restored = this.sink?.onRestored?.(this.tableId, proof);
    if (restored !== undefined) await restored;
    this.state = 'CONNECTED';
    this.reconnectCount += 1;
  }

  private buildContinuityProof(): string {
    return cursorContinuityProof({
      tableId: this.tableId,
      sourceSeq: this.cursor.sourceSeq,
      eventId: this.cursor.eventId,
      payloadHash: this.cursor.payloadHash,
    });
  }

  private assertNoGaps(batchEvents: NormalizedEvent[]): void {
    if (this.allowGaps) return;
    for (let index = 0; index < batchEvents.length; index += 1) {
      const expected = this.cursor.sourceSeq + 1 + index;
      const actual = batchEvents[index].sourceSeq;
      if (actual !== expected) {
        throw new MonitorGapError(
          `sourceSeq gap for table ${this.tableId}: expected ${expected}, got ${actual}`,
          this.tableId,
          expected,
          actual,
        );
      }
    }
  }
}

export class ShadowRoomMonitor implements RoomMonitor {
  private readonly rooms: ShadowRoomConfig[];
  private readonly defaultMaxBatchSize: number;
  private readonly defaultLatencyMs: number;
  private readonly exports = new Map<string, ShadowTableExport>();

  constructor(options: ShadowRoomMonitorOptions) {
    this.rooms = options.rooms;
    this.defaultMaxBatchSize = options.maxBatchSize ?? 20;
    this.defaultLatencyMs = options.latencyMs ?? 0;
  }

  async discoverRooms(): Promise<RoomDescriptor[]> {
    return this.rooms.map(room => ({
      roomId: room.roomId,
      ...(room.displayName === undefined ? {} : { displayName: room.displayName }),
      tables: room.tables.map(table => ({
        tableId: table.tableId,
        profile: structuredClone(table.profile),
        ...(table.monitorUrl === undefined ? {} : { monitorUrl: table.monitorUrl }),
      })),
    }));
  }

  openTable(roomId: string, tableId: string): TableExport {
    const room = this.rooms.find(candidate => candidate.roomId === roomId);
    const table = room?.tables.find(candidate => candidate.tableId === tableId);
    if (!table) {
      throw new UnknownTableError(tableId);
    }
    const key = `${roomId}::${tableId}`;
    const existing = this.exports.get(key);
    if (existing) return existing;
    const exportInstance = new ShadowTableExport(table, {
      maxBatchSize: this.defaultMaxBatchSize,
      latencyMs: this.defaultLatencyMs,
    });
    this.exports.set(key, exportInstance);
    return exportInstance;
  }

  async close(): Promise<void> {
    await Promise.all([...this.exports.values()].map(exportInstance => exportInstance.stop()));
    this.exports.clear();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
