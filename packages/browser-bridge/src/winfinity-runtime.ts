import {
  EVENT_SCHEMA_VERSION,
  defaultProfile,
  type Card,
  type CardRank,
  type NormalizedEvent,
  type ShoeBaseline,
} from '@baccarat/contracts';

const PAIR_MARKETS = ['bankerPair', 'playerPair'] as const;

const RANK: Record<string, CardRank> = {
  ACE: 'A', TWO: '2', THREE: '3', FOUR: '4', FIVE: '5', SIX: '6', SEVEN: '7',
  EIGHT: '8', NINE: '9', TEN: '10', JACK: 'J', QUEEN: 'Q', KING: 'K',
};

const AREA: Record<string, 'player' | 'banker'> = {
  PLAYER: 'player',
  BANKER: 'banker',
};

const ORDER: Record<string, 'left' | 'right' | 'extra'> = {
  ORDER_LEFT: 'left',
  ORDER_RIGHT: 'right',
  ORDER_EXTRA: 'extra',
};

type HandCards = { playerCards: Card[]; bankerCards: Card[] };
type ShoeEvidence = { readonly reason: 'attach' | 'protocol-shuffle' | 'manual-confirm' };

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
  private readonly seenCardIds = new Set<string>();
  private readonly cardsByHand = new Map<string, HandCards>();
  private readonly lastShoeToken = new Map<string, string>();
  private readonly currentShoeId = new Map<string, string>();
  private readonly evidenceByTable = new Map<string, ShoeEvidence>();
  private readonly settledHands = new Set<string>();

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

  shoeEvidence(tableId: string): ShoeEvidence | undefined {
    const evidence = this.evidenceByTable.get(tableId);
    return evidence === undefined ? undefined : { ...evidence };
  }

  openPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const shoeId = `wnf-${tableId}-operator`;
    this.evidenceByTable.set(tableId, { reason: 'manual-confirm' });
    this.currentShoeId.set(tableId, shoeId);
    this.emitNewShoe(tableId, shoeId, 'physical-shoe', timestamp, events);
    return events;
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
    if (
      frame.type !== 'GAME_STATE_CHANGED'
      && frame.type !== 'CARDS_TAKEN'
      && frame.type !== 'GAME_RESULTS'
    ) return [];
    const meta = asRecord(frame.meta);
    const round = asRecord(meta?.round);
    if (meta === undefined || round === undefined) return [];
    if (typeof meta.tableId !== 'string') return [];
    const tableId = this.resolveTableId(meta.tableId);
    if (tableId === undefined) return [];
    if (typeof round.id !== 'string' || typeof round.shoeId !== 'string') return [];
    const handId = round.id;
    const protocolShoeId = round.shoeId;
    const timestamp = isoFromUnixMs(frame.timestamp) ?? new Date(0).toISOString();
    const events: NormalizedEvent[] = [];
    this.noteShoe(tableId, protocolShoeId, timestamp, events);
    const shoeId = this.currentShoeId.get(tableId) ?? protocolShoeId;
    if (frame.type === 'GAME_STATE_CHANGED') {
      const state = asRecord(frame.state);
      if (state === undefined) return events;
      const gameState = typeof state.state === 'string' ? state.state : undefined;
      if (gameState === undefined) return events;
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
    } else if (frame.type === 'CARDS_TAKEN') {
      this.emitCards(tableId, shoeId, handId, timestamp, frame, events);
    } else {
      this.emitSettled(tableId, shoeId, handId, timestamp, frame, events);
    }
    return events;
  }

  private emitCards(
    tableId: string,
    shoeId: string,
    handId: string,
    timestamp: string,
    frame: Record<string, unknown>,
    events: NormalizedEvent[],
  ): void {
    const payload = asRecord(frame.cards);
    if (payload === undefined || !Array.isArray(payload.cards)) return;
    const handKey = `${tableId}:${handId}`;
    for (const entry of payload.cards) {
      const item = asRecord(entry);
      if (item === undefined || typeof item.id !== 'string' || item.id.length === 0) continue;
      const seenKey = `${tableId}:${item.id}`;
      if (this.seenCardIds.has(seenKey)) continue;
      const rawCard = asRecord(item.card);
      if (rawCard === undefined || typeof rawCard.rank !== 'string') continue;
      const rank = RANK[rawCard.rank];
      if (rank === undefined) continue;
      const card: Card = typeof rawCard.suit === 'string'
        ? { rank, suit: rawCard.suit }
        : { rank };
      const rawPos = asRecord(item.position);
      const area = rawPos !== undefined && typeof rawPos.area === 'string'
        ? AREA[rawPos.area]
        : undefined;
      const order = rawPos !== undefined && typeof rawPos.order === 'string'
        ? ORDER[rawPos.order]
        : undefined;
      const position = area !== undefined && order !== undefined ? `${area}:${order}` : undefined;
      this.seenCardIds.add(seenKey);
      if (area === 'player' || area === 'banker') {
        const remembered = this.cardsByHand.get(handKey) ?? { playerCards: [], bankerCards: [] };
        if (area === 'player') remembered.playerCards.push(card);
        else remembered.bankerCards.push(card);
        this.cardsByHand.set(handKey, remembered);
      }
      events.push(this.makeWindowEvent(
        tableId,
        'cardObserved',
        `card:${handId}:${item.id}`,
        timestamp,
        position === undefined
          ? { shoeId, handId, card }
          : { shoeId, handId, card, position },
      ));
    }
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

  private emitSettled(
    tableId: string,
    shoeId: string,
    handId: string,
    timestamp: string,
    frame: Record<string, unknown>,
    events: NormalizedEvent[],
  ): void {
    const payload = asRecord(frame.gameResults);
    const roundResult = asRecord(payload?.roundResult);
    if (roundResult === undefined) return;
    const settledHandId = typeof roundResult.roundId === 'string' && roundResult.roundId.length > 0
      ? roundResult.roundId
      : handId;
    const key = `${tableId}:${shoeId}:${settledHandId}`;
    if (this.settledHands.has(key)) return;
    this.settledHands.add(key);
    const remembered = this.cardsByHand.get(`${tableId}:${settledHandId}`)
      ?? { playerCards: [], bankerCards: [] };
    events.push(this.makeWindowEvent(
      tableId,
      'handSettled',
      `settled:${shoeId}:${settledHandId}`,
      timestamp,
      {
        shoeId,
        handId: settledHandId,
        playerCards: [...remembered.playerCards],
        bankerCards: [...remembered.bankerCards],
        outcomes: {
          playerPair: roundResult.pPair === true,
          bankerPair: roundResult.bPair === true,
        },
      },
    ));
  }

  private noteShoe(
    tableId: string,
    shoeId: string,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    if (shoeId.length === 0) return;
    const previous = this.lastShoeToken.get(tableId);
    if (previous === shoeId) return;
    this.lastShoeToken.set(tableId, shoeId);
    if (previous === undefined) {
      if (this.evidenceByTable.get(tableId)?.reason === 'manual-confirm') return;
      this.evidenceByTable.set(tableId, { reason: 'attach' });
      this.currentShoeId.set(tableId, shoeId);
      this.emitNewShoe(tableId, shoeId, 'unknown-monitor-session', timestamp, events);
      return;
    }
    this.evidenceByTable.set(tableId, { reason: 'protocol-shuffle' });
    this.currentShoeId.set(tableId, shoeId);
    this.clearTableHandState(tableId);
    this.emitNewShoe(tableId, shoeId, 'physical-shoe', timestamp, events);
  }

  private emitNewShoe(
    tableId: string,
    shoeId: string,
    baseline: ShoeBaseline,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    events.push(this.makeWindowEvent(
      tableId,
      'newShoeSignal',
      `shoe:${shoeId}`,
      timestamp,
      {
        shoeId,
        baseline,
        profile: {
          ...defaultProfile(tableId),
          numberOfDecks: 8,
          autoConfirmNewShoe: true,
        },
      },
    ));
  }

  // Keep settled-hand keys so an old roundId cannot replay after shuffle.
  private clearTableHandState(tableId: string): void {
    const prefix = `${tableId}:`;
    for (const key of this.cardsByHand.keys()) {
      if (key.startsWith(prefix)) this.cardsByHand.delete(key);
    }
    for (const key of this.seenCardIds) {
      if (key.startsWith(prefix)) this.seenCardIds.delete(key);
    }
    for (const key of this.openedWindows) {
      if (key.startsWith(prefix)) this.openedWindows.delete(key);
    }
    for (const key of this.closedWindows) {
      if (key.startsWith(prefix)) this.closedWindows.delete(key);
    }
  }

  private nextSeq(tableId: string): number {
    const next = (this.seqByTable.get(tableId) ?? 0) + 1;
    this.seqByTable.set(tableId, next);
    return next;
  }

  private makeWindowEvent(
    tableId: string,
    type: 'bettingWindowOpened' | 'bettingWindowClosed' | 'cardObserved' | 'handSettled' | 'newShoeSignal',
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
