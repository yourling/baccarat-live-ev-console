import type { NormalizedEvent, TableProfile } from '@baccarat/contracts';

export interface TableDescriptor {
  tableId: string;
  profile: TableProfile;
  monitorUrl?: string;
}

export interface RoomDescriptor {
  roomId: string;
  displayName?: string;
  tables: TableDescriptor[];
}

export type MonitorConnectionState =
  | 'CONNECTED'
  | 'RESYNCING'
  | 'DISCONNECTED';

export interface MonitorKeepAliveResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface TableCursor {
  tableId: string;
  sourceSeq: number;
  eventId: string;
  payloadHash: string;
}

export interface TableEventBatch {
  tableId: string;
  events: NormalizedEvent[];
  cursor: TableCursor;
  kind: 'live' | 'replay';
}

export interface TableExportSink {
  /**
   * 处理一批导出事件。返回 Promise 表示消费方已经完成落账/确认；
   * 监控层只有在该 Promise resolve 后才推进游标，从而提供背压与断点续传语义。
   */
  onBatch(batch: TableEventBatch): Promise<void> | void;
  onDisconnect?(tableId: string, reason?: string): void;
  onRestored?(tableId: string, proof: string): void;
}

export interface MonitorHealth {
  tableId: string;
  state: MonitorConnectionState;
  lastAckedSeq: number;
  lastEmittedSeq: number;
  bufferDepth: number;
  reconnectCount: number;
  lastError?: string;
}

export interface TableExport {
  readonly tableId: string;
  start(sink: TableExportSink, cursor?: TableCursor): Promise<void>;
  stop(): Promise<void>;
  /** 等待当前已启动的导出任务完成（包括消费方 ack）。 */
  flush(): Promise<void>;
  keepAlive(): Promise<MonitorKeepAliveResult>;
  health(): MonitorHealth;
}

export interface RoomMonitor {
  discoverRooms(): Promise<RoomDescriptor[]>;
  openTable(roomId: string, tableId: string): TableExport;
  close(): Promise<void>;
}
