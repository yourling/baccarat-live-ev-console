/**
 * Pragmatic Play 平台适配器：运行时解析器 + Pragmatic 协议状态机。
 * 仅承载 Pragmatic 特定逻辑；共享机制在 runtime-common 与 server。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NormalizedEvent } from '@baccarat/contracts';
import type { PlatformAdapterDescriptor } from '@baccarat/adapter-contract';
import type { BridgeRoomDescriptor } from './protocol.js';
import {
  PragmaticProtocolState,
  inspectPragmaticGameresult,
  pragmaticProtocolTableId,
} from './pragmatic-protocol.js';
import {
  PragmaticRuntimeParser,
  pragmaticGameCountSnapshot,
  selectStableGameCount,
} from './pragmatic-runtime.js';
import {
  buildOperatorShoeEvent,
  type BridgePlatformAdapter,
  type PlatformAdapterContext,
  type PlatformCaptureMessage,
} from './platform-adapter.js';
import type { ParserShoeEvidence } from './runtime-common.js';

const PRAGMATIC_TABLE_ID_PATTERN = /^[a-z0-9]{8,32}$/i;

function visibleTableIdsFromPragmaticState(raw: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const tables = Reflect.get(parsed, 'tables');
    if (!Array.isArray(tables)) return undefined;
    const tableIds: string[] = [];
    for (const table of tables) {
      if (typeof table !== 'object' || table === null) continue;
      const tableId = Reflect.get(table, 'tableId');
      if (typeof tableId !== 'string' || tableId.length === 0) continue;
      if (Reflect.get(table, 'visible') === true) tableIds.push(tableId);
    }
    return tableIds;
  } catch {
    return undefined;
  }
}

function pragmaticGameresultCapturePath(): string {
  const cwd = process.cwd().endsWith('desktop')
    ? join(process.cwd(), '..', '..', '.tmp-pragmatic')
    : join(process.cwd(), '.tmp-pragmatic');
  return join(cwd, 'gameresult-capture.jsonl');
}

function capturePragmaticGameresult(raw: string): void {
  if (process.env.PRAGMATIC_WS_CAPTURE !== '1') return;
  const inspection = inspectPragmaticGameresult(raw);
  if (inspection === undefined) return;
  const line = JSON.stringify({
    observedAt: new Date().toISOString(),
    ...inspection,
  });
  try {
    const target = pragmaticGameresultCapturePath();
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${line}\n`);
  } catch {
    // Capture is diagnostic only; a filesystem miss must not break the table feed.
  }
}

export class PragmaticPlatformAdapter implements BridgePlatformAdapter {
  readonly descriptor: PlatformAdapterDescriptor;
  private parser = new PragmaticRuntimeParser();
  private readonly protocol = new PragmaticProtocolState();

  constructor(descriptor: PlatformAdapterDescriptor) {
    this.descriptor = descriptor;
  }

  /** 供中控查看当前逻辑靴（不含物理洗牌语义）。 */
  currentPragmaticShoeId(tableId: string): string | undefined {
    return this.parser.currentShoeId(tableId);
  }

  normalizeTableId(tableId: string): string | undefined {
    // Pragmatic 是默认平台：接受任意桌 ID 形状。
    return tableId;
  }

  matchesTableIdShape(tableId: string): boolean {
    return PRAGMATIC_TABLE_ID_PATTERN.test(tableId);
  }

  sanitizeRoom(room: BridgeRoomDescriptor): BridgeRoomDescriptor {
    return room;
  }

  usesUpsertRoomMerge(): boolean {
    return false;
  }

  mergeGameCount(previous: number | undefined, next: number | undefined): number | undefined {
    return next === undefined ? previous : selectStableGameCount(previous, next);
  }

  ingestRoomGameCounts(room: BridgeRoomDescriptor, ctx: PlatformAdapterContext): void {
    const tables = room.tables.filter(table => Number.isInteger(table.gameCount) && (table.gameCount ?? 0) >= 1);
    if (tables.length === 0) return;
    ctx.ingestEvents(this.parser.parse(
      JSON.stringify({
        version: 1,
        view: 'multi',
        observedAt: new Date().toISOString(),
        tables: tables.map(table => ({ tableId: table.tableId, gameCount: table.gameCount })),
      }),
      tableId => ctx.isTableSelected(tableId),
    ));
  }

  ingestNetworkCapture(message: PlatformCaptureMessage, ctx: PlatformAdapterContext): void {
    if (message.source === 'baccarat-bridge-pragmatic-state') {
      const visibleTableIds = visibleTableIdsFromPragmaticState(message.data);
      if (visibleTableIds !== undefined) ctx.setVisibleTableIds(visibleTableIds);
      for (const tableId of this.parser.observedTableIds(message.data)) {
        if (ctx.isTableSelected(tableId)) ctx.noteTableObservation(tableId);
      }
      const gameCountSnapshot = pragmaticGameCountSnapshot(message.data);
      if (gameCountSnapshot !== undefined) {
        ctx.ingestEvents(this.parser.parse(
          gameCountSnapshot,
          tableId => ctx.isTableSelected(tableId),
        ));
      }
      return;
    }
    if (
      message.source === 'baccarat-bridge-pragmatic-ws'
      && message.encoding === 'text'
      && message.direction !== 'send'
    ) {
      capturePragmaticGameresult(message.data);
      const snapshot = this.protocol.ingest(message.data);
      if (snapshot !== undefined) {
        for (const table of snapshot.tables) {
          ctx.ensureRoomForTable(table.tableId);
          if (ctx.isTableSelected(table.tableId)) ctx.noteTableObservation(table.tableId);
        }
        ctx.ingestEvents(this.parser.parse(
          JSON.stringify(snapshot),
          tableId => ctx.isTableSelected(tableId),
        ));
      } else {
        const tableId = pragmaticProtocolTableId(message.data);
        if (tableId !== undefined && ctx.isTableSelected(tableId)) ctx.noteTableObservation(tableId);
      }
    }
  }

  onTableSelected(tableId: string, ctx: PlatformAdapterContext): void {
    this.parser.resetTable(tableId);
    const snapshot = this.protocol.snapshot(tableId);
    if (snapshot === undefined) return;
    ctx.ingestEvents(this.parser.parse(
      JSON.stringify(snapshot),
      selectedTableId => ctx.isTableSelected(selectedTableId),
    ));
  }

  recordShoeEvidence(tableId: string, evidence: ParserShoeEvidence): void {
    this.parser.recordShoeEvidence(tableId, evidence);
  }

  openPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    return this.parser.openPhysicalShoe(tableId, timestamp);
  }

  executionLaneId(tableId: string): string {
    // Pragmatic 多桌共用一个弹窗 UI，同 lane 串行防自竞。
    return this.matchesTableIdShape(tableId) ? 'pragmatic:shared-multitable-ui' : tableId;
  }

  confirmPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    this.parser.recordShoeEvidence(tableId, { reason: 'manual-confirm' });
    return [buildOperatorShoeEvent(this.descriptor, tableId, timestamp)];
  }

  currentShoeId(tableId: string): string | undefined {
    return this.parser.currentShoeId(tableId);
  }

  acceptedGameCount(tableId: string): number | undefined {
    return this.parser.acceptedGameCount(tableId);
  }

  shoeEvidence(tableId: string): ParserShoeEvidence | undefined {
    return this.parser.shoeEvidence(tableId);
  }

  roomTableDisplayName(_tableId: string): string | undefined {
    return undefined;
  }

  onRoomTableAdopted(_tableId: string): void {
    // Pragmatic 无需锁定别名。
  }

  reset(): void {
    this.protocol.reset();
    this.parser = new PragmaticRuntimeParser();
  }

  resetTable(tableId: string): void {
    this.parser.resetTable(tableId);
  }
}
