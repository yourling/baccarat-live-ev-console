import {
  EVENT_SCHEMA_VERSION,
  type NormalizedEvent,
} from '@baccarat/contracts';

const PAIR_MARKETS = ['bankerPair', 'playerPair'] as const;

export const WINFINITY_STREAM_ID_PATTERN = /^[a-z0-9]+-bac\d+$/i;
export const WINFINITY_FALLBACK_TABLE_ID_PATTERN = /^wnf-[a-f0-9]{24}$/i;
export const WINFINITY_VENDOR_TABLE_ID_PATTERN = /^[a-f0-9]{24}$/i;

export function publicWinfinityTableId(input: {
  readonly streamId?: string;
  readonly vendorTableId?: string;
}): string | undefined {
  const streamId = input.streamId?.trim().toLowerCase();
  if (streamId && WINFINITY_STREAM_ID_PATTERN.test(streamId)) return streamId;
  const vendor = input.vendorTableId?.trim().toLowerCase();
  if (vendor && WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return `wnf-${vendor}`;
  return undefined;
}

export function normalizeWinfinityTableId(tableId: string): string | undefined {
  const trimmed = tableId.trim().toLowerCase();
  if (WINFINITY_STREAM_ID_PATTERN.test(trimmed)) return trimmed;
  if (WINFINITY_FALLBACK_TABLE_ID_PATTERN.test(trimmed)) return trimmed;
  return undefined;
}

export class WinfinityRuntimeParser {
  private readonly lockedByVendor = new Map<string, string>();
  private readonly openedWindows = new Set<string>();
  private readonly closedWindows = new Set<string>();
  private readonly seqByTable = new Map<string, number>();

  registerAlias(vendorTableId: string, streamId: string): void {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return;
    if (this.lockedByVendor.has(vendor)) return;
    const publicId = publicWinfinityTableId({ streamId, vendorTableId: vendor });
    if (publicId === undefined) return;
    this.lockedByVendor.set(vendor, publicId);
  }

  resolveTableId(vendorTableId: string): string | undefined {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return undefined;
    const locked = this.lockedByVendor.get(vendor);
    if (locked !== undefined) return locked;
    const publicId = publicWinfinityTableId({ vendorTableId: vendor });
    if (publicId === undefined) return undefined;
    this.lockedByVendor.set(vendor, publicId);
    return publicId;
  }

  parseFrame(raw: string): NormalizedEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const frame = parsed as Record<string, unknown>;
    if (frame.type !== 'GAME_STATE_CHANGED') return [];
    const meta = asRecord(frame.meta);
    const round = asRecord(meta?.round);
    const state = asRecord(frame.state);
    if (meta === undefined || round === undefined || state === undefined) return [];
    if (typeof meta.tableId !== 'string') return [];
    const tableId = this.resolveTableId(meta.tableId);
    if (tableId === undefined) return [];
    if (typeof round.id !== 'string' || typeof round.shoeId !== 'string') return [];
    const handId = round.id;
    const shoeId = round.shoeId;
    const gameState = typeof state.state === 'string' ? state.state : undefined;
    if (gameState === undefined) return [];
    const timestamp = isoFromUnixMs(frame.timestamp) ?? new Date(0).toISOString();
    const events: NormalizedEvent[] = [];
    if (gameState === 'BETS_OPEN') {
      this.emitOpened(tableId, shoeId, handId, timestamp, isoFromUnixMs(state.bettingTime), events, false);
    } else if (gameState === 'BETS_CLOSING') {
      const closesAt = isoFromUnixMs(state.bettingTime);
      if (closesAt !== undefined) {
        this.emitOpened(tableId, shoeId, handId, timestamp, closesAt, events, true);
      }
    } else if (gameState === 'BETS_CLOSED' || gameState === 'GAME_STARTED') {
      this.emitClosed(tableId, shoeId, handId, timestamp, events);
    }
    return events;
  }

  private emitOpened(
    tableId: string,
    shoeId: string,
    handId: string,
    timestamp: string,
    closesAt: string | undefined,
    events: NormalizedEvent[],
    closingUpdate: boolean,
  ): void {
    for (const market of PAIR_MARKETS) {
      const key = `${tableId}:${handId}:${market}`;
      if (this.closedWindows.has(key)) continue;
      if (closingUpdate) {
        this.openedWindows.add(key);
        events.push(this.makeWindowEvent(
          tableId,
          'bettingWindowOpened',
          `open:${shoeId}:${handId}:${market}:eta`,
          timestamp,
          { shoeId, handId, market, closesAt },
        ));
        continue;
      }
      if (this.openedWindows.has(key)) continue;
      this.openedWindows.add(key);
      events.push(this.makeWindowEvent(
        tableId,
        'bettingWindowOpened',
        `open:${shoeId}:${handId}:${market}`,
        timestamp,
        closesAt === undefined
          ? { shoeId, handId, market }
          : { shoeId, handId, market, closesAt },
      ));
    }
  }

  private emitClosed(
    tableId: string,
    shoeId: string,
    handId: string,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    for (const market of PAIR_MARKETS) {
      const key = `${tableId}:${handId}:${market}`;
      if (!this.openedWindows.has(key) || this.closedWindows.has(key)) continue;
      this.closedWindows.add(key);
      events.push(this.makeWindowEvent(
        tableId,
        'bettingWindowClosed',
        `close:${shoeId}:${handId}:${market}`,
        timestamp,
        { shoeId, handId, market },
      ));
    }
  }

  private nextSeq(tableId: string): number {
    const next = (this.seqByTable.get(tableId) ?? 0) + 1;
    this.seqByTable.set(tableId, next);
    return next;
  }

  private makeWindowEvent(
    tableId: string,
    type: 'bettingWindowOpened' | 'bettingWindowClosed',
    stableKey: string,
    timestamp: string,
    extra: Record<string, unknown>,
  ): NormalizedEvent {
    const sourceSeq = this.nextSeq(tableId);
    return {
      type,
      eventId: `wnf:${tableId}:${type}:${stableKey}:${sourceSeq}`,
      tableId,
      timestamp,
      sourceSeq,
      source: 'winfinity-runtime',
      schemaVersion: EVENT_SCHEMA_VERSION,
      ...extra,
    } as NormalizedEvent;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isoFromUnixMs(value: unknown): string | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 1e12) return undefined;
  return new Date(n).toISOString();
}
