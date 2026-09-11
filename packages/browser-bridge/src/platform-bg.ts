/**
 * Big Gaming (BG) 平台适配器：BG 运行时解析器 + BG 快照采集入口。
 */
import type { NormalizedEvent } from '@baccarat/contracts';
import type { PlatformAdapterDescriptor } from '@baccarat/adapter-contract';
import type { BridgeRoomDescriptor } from './protocol.js';
import { isWrapShapedRoadCount } from '@baccarat/ledger-state';
import { BgRuntimeParser, normalizeBgTableId, selectBgRoadCount } from './bg-runtime.js';
import {
  buildOperatorShoeEvent,
  type BridgePlatformAdapter,
  type PlatformAdapterContext,
  type PlatformCaptureMessage,
} from './platform-adapter.js';
import type { ParserShoeEvidence } from './runtime-common.js';
import type { BeadHand } from './runtime-common.js';

function visibleTableIdsFromSnapshot(raw: string): string[] | undefined {
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

export class BgPlatformAdapter implements BridgePlatformAdapter {
  readonly descriptor: PlatformAdapterDescriptor;
  private parser = new BgRuntimeParser();

  constructor(descriptor: PlatformAdapterDescriptor) {
    this.descriptor = descriptor;
  }

  normalizeTableId(tableId: string): string | undefined {
    return normalizeBgTableId(tableId);
  }

  matchesTableIdShape(tableId: string): boolean {
    return normalizeBgTableId(tableId) !== undefined;
  }

  sanitizeRoom(room: BridgeRoomDescriptor): BridgeRoomDescriptor {
    return {
      ...room,
      tables: room.tables.flatMap(table => {
        const tableId = normalizeBgTableId(table.tableId);
        if (tableId === undefined) return [];
        return [{ ...table, tableId }];
      }),
    };
  }

  usesUpsertRoomMerge(): boolean {
    return true;
  }

  mergeGameCount(previous: number | undefined, next: number | undefined): number | undefined {
    return selectBgRoadCount(previous, next);
  }

  observeGameCount(
    tableId: string,
    _previous: number | undefined,
    incoming: number | undefined,
  ): number | undefined {
    const accepted = this.parser.acceptedGameCount(tableId);
    const reason = this.parser.shoeEvidence(tableId)?.reason;
    if (reason === 'protocol-shuffle' && accepted === undefined && incoming !== undefined && incoming > 20) {
      return undefined;
    }
    if (
      typeof accepted === 'number'
      && typeof incoming === 'number'
      && isWrapShapedRoadCount(accepted, incoming)
    ) {
      return incoming;
    }
    return selectBgRoadCount(accepted, incoming);
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
      () => true,
    ));
  }

  ingestNetworkCapture(message: PlatformCaptureMessage, ctx: PlatformAdapterContext): void {
    if (message.source !== 'baccarat-bridge-bg-state') return;
    const visibleTableIds = visibleTableIdsFromSnapshot(message.data);
    if (visibleTableIds !== undefined) {
      ctx.addVisibleTableIds(visibleTableIds);
    }
    this.recordSnapshotTables(message.data, ctx);
    for (const tableId of this.parser.observedTableIds(message.data)) {
      ctx.ensureRoomForTable(tableId);
      if (ctx.isTableSelected(tableId)) ctx.noteTableObservation(tableId);
    }
    ctx.ingestEvents(this.parser.parse(message.data, () => true));
  }

  /** BG 大厅/游戏快照里的桌都进发现表：hall 来源在前，游戏内来源在后。 */
  private recordSnapshotTables(raw: string, ctx: PlatformAdapterContext): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const tables = (parsed as { tables?: unknown }).tables;
    if (!Array.isArray(tables)) return;
    const hall: BridgeRoomDescriptor['tables'] = [];
    const rest: BridgeRoomDescriptor['tables'] = [];
    for (const table of tables) {
      if (!table || typeof table !== 'object') continue;
      const rawTableId = typeof (table as { tableId?: unknown }).tableId === 'string'
        ? (table as { tableId: string }).tableId
        : '';
      const tableId = normalizeBgTableId(rawTableId);
      if (tableId === undefined) continue;
      const roundId = typeof (table as { roundId?: unknown }).roundId === 'string'
        ? (table as { roundId: string }).roundId
        : undefined;
      const gameCount = typeof (table as { gameCount?: unknown }).gameCount === 'number'
        ? (table as { gameCount: number }).gameCount
        : undefined;
      const source = (table as { source?: unknown }).source;
      const descriptor = {
        tableId,
        ...(roundId ? { roundId } : {}),
        ...(gameCount !== undefined ? { gameCount } : {}),
      };
      if (source === 'hall') hall.push(descriptor);
      else rest.push(descriptor);
    }
    const known = [...hall, ...rest];
    for (const table of known) {
      ctx.upsertDiscoveredRoom({
        roomId: this.descriptor.roomId,
        displayName: this.descriptor.roomDisplayName,
        platformId: this.descriptor.platformId,
        tables: [table],
      });
      if (ctx.isTableSelected(table.tableId)) ctx.noteTableObservation(table.tableId);
    }
  }

  onTableSelected(_tableId: string, _ctx: PlatformAdapterContext): void {
    // BG 快照是全量推送，重选桌无需补发。
  }

  recordShoeEvidence(tableId: string, evidence: ParserShoeEvidence): void {
    this.parser.recordShoeEvidence(tableId, evidence);
  }

  openPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    return this.parser.openPhysicalShoe(tableId, timestamp);
  }

  executionLaneId(tableId: string): string {
    return tableId;
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

  beadSequence(tableId: string): readonly BeadHand[] | undefined {
    if (!this.parser.hasShoeState(tableId)) return undefined;
    return this.parser.beadSequence(tableId);
  }

  seedShoeSequences(entries: ReadonlyArray<{ readonly tableId: string; readonly sequence: number }>): void {
    for (const { tableId, sequence } of entries) {
      this.parser.seedShoeSequence(tableId, sequence);
    }
  }

  roomTableDisplayName(_tableId: string): string | undefined {
    return undefined;
  }

  onRoomTableAdopted(_tableId: string): void {
    // BG 无需锁定别名。
  }

  reset(): void {
    this.parser = new BgRuntimeParser();
  }

  resetTable(tableId: string): void {
    this.parser.resetTable(tableId);
  }
}
