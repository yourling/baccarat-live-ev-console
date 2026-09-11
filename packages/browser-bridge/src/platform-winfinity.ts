/**
 * Dafabet 桃园 Winfinity 平台适配器（第一期只采集不下注）。
 * 承载 vendor 桌 ID 别名锁定、WS 帧缓冲与大厅快照发现等 Winfinity 专属逻辑。
 */
import type { NormalizedEvent } from '@baccarat/contracts';
import type { PlatformAdapterDescriptor } from '@baccarat/adapter-contract';
import type { BridgeRoomDescriptor } from './protocol.js';
import {
  WinfinityRuntimeParser,
  normalizeWinfinityTableId,
  publicWinfinityTableId,
  selectWinfinityRoadCount,
} from './winfinity-runtime.js';
import type {
  BridgePlatformAdapter,
  PlatformAdapterContext,
  PlatformCaptureMessage,
} from './platform-adapter.js';
import type { ParserShoeEvidence } from './runtime-common.js';
import type { BeadHand } from './runtime-common.js';

export const WINFINITY_WS_ALIAS_BUFFER_LIMIT = 32;

function winfinityCaptureType(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const type = Reflect.get(parsed, 'type');
    return typeof type === 'string' ? type : undefined;
  } catch {
    return undefined;
  }
}

function winfinityVendorTableIdFromCapture(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const meta = Reflect.get(parsed, 'meta');
    if (typeof meta !== 'object' || meta === null) return undefined;
    const tableId = Reflect.get(meta, 'tableId');
    return typeof tableId === 'string' ? tableId : undefined;
  } catch {
    return undefined;
  }
}

function winfinityFallbackVendorId(publicId: string): string | undefined {
  const match = /^wnf-([a-f0-9]{24})$/i.exec(publicId.trim());
  return match?.[1]?.toLowerCase();
}

export class WinfinityPlatformAdapter implements BridgePlatformAdapter {
  readonly descriptor: PlatformAdapterDescriptor;
  private readonly parser = new WinfinityRuntimeParser();
  private readonly wsBuffer = new Map<string, string[]>();

  constructor(descriptor: PlatformAdapterDescriptor) {
    this.descriptor = descriptor;
  }

  lockedAliases(): ReadonlyMap<string, string> {
    return this.parser.lockedAliases();
  }

  normalizeTableId(tableId: string): string | undefined {
    return normalizeWinfinityTableId(tableId);
  }

  matchesTableIdShape(tableId: string): boolean {
    return normalizeWinfinityTableId(tableId) !== undefined;
  }

  sanitizeRoom(room: BridgeRoomDescriptor): BridgeRoomDescriptor {
    return {
      ...room,
      tables: room.tables.flatMap(table => {
        const tableId = normalizeWinfinityTableId(table.tableId);
        if (tableId === undefined) return [];
        return [{ ...table, tableId }];
      }),
    };
  }

  usesUpsertRoomMerge(): boolean {
    return true;
  }

  mergeGameCount(previous: number | undefined, next: number | undefined): number | undefined {
    return selectWinfinityRoadCount(previous, next);
  }

  observeGameCount(
    tableId: string,
    previous: number | undefined,
    incoming: number | undefined,
  ): number | undefined {
    const reason = this.parser.shoeEvidence(tableId)?.reason;
    if (reason === 'protocol-shuffle' && incoming !== undefined && incoming > 8 && (previous === undefined || previous <= 8)) {
      return previous;
    }
    return selectWinfinityRoadCount(previous, incoming);
  }

  ingestRoomGameCounts(room: BridgeRoomDescriptor, ctx: PlatformAdapterContext): void {
    const tables = room.tables.flatMap(table => {
      const tableId = normalizeWinfinityTableId(table.tableId);
      if (tableId === undefined || !Number.isInteger(table.gameCount) || (table.gameCount ?? 0) < 1) {
        return [];
      }
      return [{ tableId, gameCount: table.gameCount! }];
    });
    if (tables.length === 0) return;
    ctx.ingestEvents(this.parser.noteGameCounts(tables, new Date().toISOString()));
  }

  ingestNetworkCapture(message: PlatformCaptureMessage, ctx: PlatformAdapterContext): void {
    if (message.source === 'baccarat-bridge-winfinity-state') {
      this.recordSnapshotTables(message.data, ctx);
      return;
    }
    if (
      message.source === 'baccarat-bridge-winfinity-ws'
      && message.encoding === 'text'
      && message.direction !== 'send'
    ) {
      this.ingestWsFrame(message.data, ctx);
    }
  }

  onTableSelected(tableId: string, ctx: PlatformAdapterContext): void {
    if (normalizeWinfinityTableId(tableId) === undefined) return;
    const shoeId = this.parser.peekCurrentShoeId(tableId);
    if (shoeId === undefined || ctx.lastIngestedShoeId(tableId) === shoeId) return;
    ctx.ingestEvents(this.parser.emitCurrentShoe(tableId, new Date().toISOString()));
  }

  recordShoeEvidence(tableId: string, evidence: ParserShoeEvidence): void {
    if (
      evidence.reason === 'attach'
      || evidence.reason === 'protocol-shuffle'
      || evidence.reason === 'manual-confirm'
      || evidence.reason === 'road-wrap'
    ) {
      this.parser.recordShoeEvidence(tableId, {
        reason: evidence.reason,
        ...(evidence.previousGameCount === undefined ? {} : { previousGameCount: evidence.previousGameCount }),
        ...(evidence.gameCount === undefined ? {} : { gameCount: evidence.gameCount }),
      });
    }
  }

  openPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    return this.parser.openPhysicalShoe(tableId, timestamp);
  }

  executionLaneId(tableId: string): string {
    return tableId;
  }

  confirmPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    return this.parser.openPhysicalShoe(tableId, timestamp);
  }

  currentShoeId(tableId: string): string | undefined {
    return this.parser.peekCurrentShoeId(tableId);
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

  roomTableDisplayName(tableId: string): string | undefined {
    return this.parser.displayNameForTable(tableId);
  }

  onRoomTableAdopted(tableId: string): void {
    const fallbackVendor = winfinityFallbackVendorId(tableId);
    if (fallbackVendor !== undefined) this.parser.lockPublicId(fallbackVendor, tableId);
  }

  reset(): void {
    this.wsBuffer.clear();
    Object.assign(this, { parser: new WinfinityRuntimeParser() });
  }

  resetTable(tableId: string): void {
    // Winfinity 桌状态由靴信号驱动，无需按桌重置。
    void tableId;
  }

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
    const observedAt = typeof (parsed as { observedAt?: unknown }).observedAt === 'string'
      ? (parsed as { observedAt: string }).observedAt
      : new Date().toISOString();
    const records: Array<{
      vendorTableId?: string;
      streamId?: string;
      displayName?: string;
      gameCount?: number;
      roundId?: string;
      tableId?: string;
    }> = [];
    for (const table of tables) {
      if (!table || typeof table !== 'object') continue;
      const record = table as {
        tableId?: unknown;
        vendorTableId?: unknown;
        streamId?: unknown;
        displayName?: unknown;
        gameCount?: unknown;
        roundId?: unknown;
      };
      records.push({
        ...(typeof record.vendorTableId === 'string' ? { vendorTableId: record.vendorTableId } : {}),
        ...(typeof record.streamId === 'string' ? { streamId: record.streamId } : {}),
        ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
        ...(typeof record.gameCount === 'number' ? { gameCount: record.gameCount } : {}),
        ...(typeof record.roundId === 'string' ? { roundId: record.roundId } : {}),
        ...(typeof record.tableId === 'string' ? { tableId: record.tableId } : {}),
      });
    }
    for (const record of records) {
      if (record.vendorTableId === undefined || record.displayName === undefined) continue;
      this.parser.noteNamedTablesFromPayload({
        tableId: record.vendorTableId,
        tableName: record.displayName,
      });
    }
    for (const record of records) {
      if (record.vendorTableId === undefined || record.streamId === undefined) continue;
      this.parser.registerAlias(record.vendorTableId, record.streamId);
    }
    const counted: Array<{ tableId: string; gameCount: number }> = [];
    for (const record of records) {
      const publicId = record.vendorTableId !== undefined
        ? this.parser.inferredPublicId(record.vendorTableId)
          ?? this.parser.resolveTableId(record.vendorTableId)
        : publicWinfinityTableId({
          ...(record.streamId === undefined ? {} : { streamId: record.streamId }),
        }) ?? (record.tableId === undefined ? undefined : normalizeWinfinityTableId(record.tableId));
      if (publicId === undefined) continue;
      const displayName = record.displayName
        ?? (record.vendorTableId === undefined
          ? undefined
          : this.parser.displayNameForVendor(record.vendorTableId))
        ?? this.parser.displayNameForTable(publicId);
      const roundId = record.roundId;
      const gameCount = record.gameCount;
      ctx.upsertDiscoveredRoom({
        roomId: this.descriptor.roomId,
        displayName: this.descriptor.roomDisplayName,
        platformId: this.descriptor.platformId,
        tables: [{
          tableId: publicId,
          ...(displayName === undefined ? {} : { displayName }),
          ...(roundId === undefined ? {} : { roundId }),
          ...(gameCount === undefined ? {} : { gameCount }),
        }],
      });
      this.discoverTable(publicId, record.vendorTableId, displayName, ctx);
      if (typeof gameCount === 'number' && Number.isInteger(gameCount) && gameCount >= 1) {
        counted.push({ tableId: publicId, gameCount });
      }
    }
    if (counted.length > 0) {
      ctx.ingestEvents(this.parser.noteGameCounts(counted, observedAt));
    }
  }

  private ingestWsFrame(raw: string, ctx: PlatformAdapterContext): void {
    const captureType = winfinityCaptureType(raw);
    if (
      captureType === 'TABLES_LIST'
      || captureType === 'CURRENT_STATE'
      || captureType === 'TABLE_SETTINGS_CHANGED'
    ) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      for (const alias of this.parser.registerAliasesFromPayload(parsed)) {
        this.discoverTable(
          alias.publicId,
          alias.vendorTableId,
          this.parser.displayNameForVendor(alias.vendorTableId),
          ctx,
        );
      }
      if (this.parser.hasLearnedStreamFamily()) {
        for (const vendorTableId of this.parser.namedVendorTableIds()) {
          if (this.parser.hasLockedPublicId(vendorTableId)) continue;
          const publicId = this.parser.resolveTableId(vendorTableId);
          if (publicId === undefined) continue;
          this.discoverTable(
            publicId,
            vendorTableId,
            this.parser.displayNameForVendor(vendorTableId),
            ctx,
          );
        }
      }
      if (captureType !== 'CURRENT_STATE') return;
    }
    const vendorTableId = winfinityVendorTableIdFromCapture(raw);
    if (vendorTableId === undefined) return;
    if (this.parser.hasLockedPublicId(vendorTableId)) {
      this.flushWsBuffer(vendorTableId, ctx);
      this.ingestLockedWsFrame(vendorTableId, raw, ctx);
      return;
    }
    this.bufferWsFrame(vendorTableId, raw, ctx);
  }

  private bufferWsFrame(vendorTableId: string, raw: string, ctx: PlatformAdapterContext): void {
    const vendor = vendorTableId.trim().toLowerCase();
    const frames = this.wsBuffer.get(vendor) ?? [];
    frames.push(raw);
    // 无论能否推断出公开 id，缓冲都必须有界：锁定不出 id 时旧实现直接 return，
    // 已缓冲的帧永不释放，这个 vendor 的每一帧都会继续堆进来。
    if (frames.length > WINFINITY_WS_ALIAS_BUFFER_LIMIT) {
      frames.splice(0, frames.length - WINFINITY_WS_ALIAS_BUFFER_LIMIT);
    }
    if (frames.length >= WINFINITY_WS_ALIAS_BUFFER_LIMIT) {
      const publicId = this.parser.inferredPublicId(vendor)
        ?? publicWinfinityTableId({ vendorTableId: vendor });
      if (publicId !== undefined) {
        this.parser.lockPublicId(vendor, publicId);
        this.wsBuffer.set(vendor, frames);
        this.flushWsBuffer(vendor, ctx);
        return;
      }
    }
    this.wsBuffer.set(vendor, frames);
  }

  private flushWsBuffer(vendorTableId: string, ctx: PlatformAdapterContext): void {
    const vendor = vendorTableId.trim().toLowerCase();
    const frames = this.wsBuffer.get(vendor);
    this.wsBuffer.delete(vendor);
    if (frames === undefined || frames.length === 0) return;
    const publicId = this.parser.peekPublicId(vendor)
      ?? this.parser.resolveTableId(vendor);
    if (publicId === undefined) return;
    this.parser.lockPublicId(vendor, publicId);
    ctx.ensureRoomForTable(publicId);
    for (const frame of frames) {
      this.ingestLockedWsFrame(vendor, frame, ctx);
    }
  }

  private ingestLockedWsFrame(vendorTableId: string, raw: string, ctx: PlatformAdapterContext): void {
    const publicId = this.parser.peekPublicId(vendorTableId)
      ?? this.parser.resolveTableId(vendorTableId);
    if (publicId === undefined) return;
    ctx.ensureRoomForTable(publicId);
    if (ctx.isTableSelected(publicId)) ctx.noteTableObservation(publicId);
    ctx.ingestEvents(this.parser.parseFrame(raw));
  }

  private discoverTable(
    publicId: string,
    vendorTableId: string | undefined,
    displayName: string | undefined,
    ctx: PlatformAdapterContext,
  ): void {
    if (vendorTableId !== undefined) {
      this.parser.lockPublicId(vendorTableId, publicId);
    } else {
      const fallbackVendor = winfinityFallbackVendorId(publicId);
      if (fallbackVendor !== undefined) this.parser.lockPublicId(fallbackVendor, publicId);
    }
    const name = displayName
      ?? (vendorTableId === undefined ? undefined : this.parser.displayNameForVendor(vendorTableId))
      ?? this.parser.displayNameForTable(publicId);
    ctx.upsertDiscoveredRoom({
      roomId: this.descriptor.roomId,
      displayName: this.descriptor.roomDisplayName,
      platformId: this.descriptor.platformId,
      tables: [{
        tableId: publicId,
        ...(name === undefined ? {} : { displayName: name }),
      }],
    });
    ctx.ensureRoomForTable(publicId);
    if (vendorTableId !== undefined) this.flushWsBuffer(vendorTableId, ctx);
  }
}
