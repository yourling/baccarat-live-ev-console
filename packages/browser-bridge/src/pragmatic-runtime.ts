import {
  EVENT_SCHEMA_VERSION,
  defaultProfile,
  type Card,
  type CardRank,
  type NormalizedEvent,
  type ShoeBaseline,
} from '@baccarat/contracts';

export interface PragmaticTableSnapshot {
  readonly tableId: string;
  readonly displayName?: string;
  readonly roundId?: string;
  readonly gameCount?: number;
  readonly bettingOpen?: boolean;
  readonly countdown?: number;
  readonly playerCards?: readonly string[];
  readonly bankerCards?: readonly string[];
  readonly visible?: boolean;
  readonly minBet?: number;
  readonly shoeReset?: string;
  readonly source?: 'dom' | 'protocol';
  readonly gameSettled?: boolean;
}

export interface PragmaticRuntimeSnapshot {
  readonly version: 1;
  readonly view: 'single' | 'multi';
  readonly observedAt: string;
  readonly tables: readonly PragmaticTableSnapshot[];
}

/** DOM road count may lag several hands; only a large gap means a missed shuffle. */
const GAME_COUNT_SHOE_LAG = 16;
const ROAD_WRAP_MAX = 2;
const ROAD_WRAP_MIN_PREVIOUS = 10;
const ROAD_WRAP_MIN_DROP = 8;

export function isRoadWrapToNewShoe(
  previous: number | undefined,
  gameCount: number,
): boolean {
  return previous !== undefined
    && previous >= ROAD_WRAP_MIN_PREVIOUS
    && gameCount <= ROAD_WRAP_MAX
    && previous - gameCount >= ROAD_WRAP_MIN_DROP;
}

/** DOM often lags past #2 after shuffle; still join if the road clearly wrapped. */
export function isJoinableNewShoeRoadCount(
  previous: number | undefined,
  gameCount: number,
): boolean {
  if (isRoadWrapToNewShoe(previous, gameCount)) return true;
  return previous !== undefined
    && previous >= ROAD_WRAP_MIN_PREVIOUS
    && gameCount <= 8
    && previous - gameCount >= ROAD_WRAP_MIN_DROP;
}

function isPhysicalShoeFromRoadCount(
  previous: number | undefined,
  gameCount: number,
  trackedHands: number,
): boolean {
  if (isRoadWrapToNewShoe(previous, gameCount)) return true;
  return gameCount <= 8 && trackedHands > gameCount + GAME_COUNT_SHOE_LAG;
}

type SnapshotSource = 'dom' | 'protocol';
type HandCards = { playerCards: Card[]; bankerCards: Card[]; source?: SnapshotSource };

function cardIdentity(card: Card): string {
  const raw = typeof card.raw === 'string' ? card.raw.trim().toUpperCase() : '';
  if (raw.length > 0) return raw;
  return `${card.rank}${card.suit ?? ''}`;
}

function mergeCardList(
  existing: readonly Card[] | undefined,
  incoming: readonly Card[],
  incomingSource: SnapshotSource | undefined,
  existingSource: SnapshotSource | undefined,
): Card[] {
  if (incoming.length === 0) return existing ? [...existing] : [];
  if (!existing || existing.length === 0) return [...incoming];
  const overlap = Math.min(existing.length, incoming.length);
  let conflict = false;
  for (let index = 0; index < overlap; index += 1) {
    if (cardIdentity(existing[index]!) !== cardIdentity(incoming[index]!)) {
      conflict = true;
      break;
    }
  }
  if (!conflict) {
    const merged = incoming.length > existing.length ? [...incoming] : [...existing];
    return merged.slice(0, 3);
  }
  if (incomingSource === 'protocol' && existingSource !== 'protocol') {
    return incoming.slice(0, 3);
  }
  return existing.slice(0, 3);
}

function mergeHandCards(
  existing: HandCards | undefined,
  incomingPlayer: readonly Card[],
  incomingBanker: readonly Card[],
  incomingSource: SnapshotSource | undefined,
): HandCards {
  const source = incomingSource === 'protocol' || existing?.source === 'protocol'
    ? 'protocol'
    : incomingSource ?? existing?.source;
  return {
    playerCards: mergeCardList(existing?.playerCards, incomingPlayer, incomingSource, existing?.source),
    bankerCards: mergeCardList(existing?.bankerCards, incomingBanker, incomingSource, existing?.source),
    ...(source === undefined ? {} : { source }),
  };
}

const CARD_PATTERN = /^(10|[2-9AJQK]|[01])([SHDC])([0-8])?$/i;

function parseCard(value: string): Card | null {
  const match = CARD_PATTERN.exec(value.trim());
  if (!match) return null;
  const rankToken = match[1]!.toUpperCase();
  const rank = (rankToken === '0' ? '10' : rankToken === '1' ? 'A' : rankToken) as CardRank;
  return {
    rank,
    suit: match[2]!.toUpperCase(),
    raw: value.trim().toUpperCase(),
  };
}

function parseCards(values: readonly string[] | undefined): Card[] {
  return (values ?? []).map(parseCard).filter((card): card is Card => card !== null);
}

function cardPoint(card: { rank: string }): number {
  if (card.rank === 'A') return 1;
  if (card.rank === '10' || card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 0;
  return Number(card.rank);
}

function handScore(cards: readonly { rank: string }[]): number {
  return cards.reduce((score, card) => (score + cardPoint(card)) % 10, 0);
}

function bankerDraws(bankerTotal: number, playerThird: number): boolean {
  if (bankerTotal <= 2) return true;
  if (bankerTotal === 3) return playerThird !== 8;
  if (bankerTotal === 4) return playerThird >= 2 && playerThird <= 7;
  if (bankerTotal === 5) return playerThird >= 4 && playerThird <= 7;
  if (bankerTotal === 6) return playerThird === 6 || playerThird === 7;
  return false;
}

export function isCompleteBaccaratHand(
  playerCards: readonly { rank: string }[],
  bankerCards: readonly { rank: string }[],
): boolean {
  if (playerCards.length < 2 || playerCards.length > 3 || bankerCards.length < 2 || bankerCards.length > 3) {
    return false;
  }
  const playerInitial = handScore(playerCards.slice(0, 2));
  const bankerInitial = handScore(bankerCards.slice(0, 2));
  if (playerInitial >= 8 || bankerInitial >= 8) return playerCards.length === 2 && bankerCards.length === 2;
  if (playerCards.length === 2) {
    if (playerInitial < 6) return false;
    return bankerCards.length === 2 ? bankerInitial >= 6 : bankerInitial <= 5;
  }
  if (playerInitial > 5) return false;
  const playerThird = playerCards[2];
  if (playerThird === undefined) return false;
  const bankerShouldDraw = bankerDraws(bankerInitial, cardPoint(playerThird));
  return bankerCards.length === 3 ? bankerShouldDraw : !bankerShouldDraw;
}

function validSnapshot(value: unknown): value is PragmaticRuntimeSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PragmaticRuntimeSnapshot>;
  return candidate.version === 1
    && (candidate.view === 'single' || candidate.view === 'multi')
    && typeof candidate.observedAt === 'string'
    && Array.isArray(candidate.tables);
}

/**
 * Protocol frames omit gameCount. DOM snapshots carry the road #, but their
 * round/card fields are unsafe to ingest on multibaccarat. Keep only tableId
 * and gameCount so a missed shuffle can still open a physical shoe.
 */
export function pragmaticGameCountSnapshot(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const snapshot = parsed as Partial<PragmaticRuntimeSnapshot>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.tables)) return undefined;
  const tables: Array<{ tableId: string; gameCount: number }> = [];
  for (const table of snapshot.tables) {
    if (!table || typeof table.tableId !== 'string' || table.tableId.length === 0) continue;
    if (!Number.isInteger(table.gameCount) || (table.gameCount ?? -1) < 0) continue;
    tables.push({ tableId: table.tableId, gameCount: table.gameCount! });
  }
  if (tables.length === 0) return undefined;
  return JSON.stringify({
    version: 1,
    view: snapshot.view === 'single' ? 'single' : 'multi',
    observedAt: typeof snapshot.observedAt === 'string' ? snapshot.observedAt : new Date().toISOString(),
    tables,
  });
}

export class PragmaticRuntimeParser {
  private readonly runId = Math.random().toString(36).slice(2, 10);
  private readonly generationByTable = new Map<string, number>();
  private readonly seqByTable = new Map<string, number>();
  private readonly shoeSeqByTable = new Map<string, number>();
  private readonly shoeIdByTable = new Map<string, string>();
  private readonly lastShoeResetByTable = new Map<string, string>();
  private readonly lastGameCountByTable = new Map<string, number>();
  private readonly handsThisShoeByTable = new Map<string, number>();
  private readonly lastRoundByTable = new Map<string, string>();
  private readonly cardBoundaryByHand = new Set<string>();
  private readonly cardsByHand = new Map<string, HandCards>();
  private readonly seenCardsByHand = new Map<string, Set<string>>();
  private readonly openedWindows = new Set<string>();
  private readonly closedWindows = new Set<string>();
  private readonly windowClosesAtMs = new Map<string, number>();
  private readonly lastWindowEmitAtMs = new Map<string, number>();
  private readonly settledHands = new Set<string>();
  private readonly finishedHands = new Set<string>();

  parse(raw: string, isSelected: (tableId: string) => boolean = () => true): NormalizedEvent[] {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!validSnapshot(snapshot)) return [];

    const events: NormalizedEvent[] = [];
    for (const table of snapshot.tables) {
      if (!table || typeof table.tableId !== 'string' || table.tableId.length === 0) continue;
      if (!isSelected(table.tableId)) continue;
      this.ingestTable(table, snapshot.observedAt, events);
    }
    return events;
  }

  observedTableIds(raw: string): string[] {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!validSnapshot(snapshot)) return [];
    return snapshot.tables
      .map(table => table && typeof table.tableId === 'string' ? table.tableId : '')
      .filter(tableId => tableId.length > 0);
  }

  currentShoeId(tableId: string): string | undefined {
    return this.shoeIdByTable.get(tableId);
  }

  openPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    this.beginNewShoe(tableId, timestamp, events);
    return events;
  }

  resetTable(tableId: string): void {
    this.generationByTable.set(tableId, (this.generationByTable.get(tableId) ?? 0) + 1);
    this.seqByTable.delete(tableId);
    this.shoeSeqByTable.delete(tableId);
    this.shoeIdByTable.delete(tableId);
    this.lastShoeResetByTable.delete(tableId);
    this.lastGameCountByTable.delete(tableId);
    this.handsThisShoeByTable.delete(tableId);
    this.lastRoundByTable.delete(tableId);
    this.clearHandState(tableId);
  }

  private ingestTable(
    table: PragmaticTableSnapshot,
    observedAt: string,
    events: NormalizedEvent[],
  ): void {
    const tableId = table.tableId;

    if (typeof table.shoeReset === 'string'
      && table.shoeReset.length > 0
      && this.lastShoeResetByTable.get(tableId) !== table.shoeReset) {
      this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);
      this.lastShoeResetByTable.set(tableId, table.shoeReset);
      this.beginNewShoe(tableId, observedAt, events);
    }

    if (Number.isInteger(table.gameCount) && (table.gameCount ?? -1) >= 0) {
      const previous = this.lastGameCountByTable.get(tableId);
      const tracked = this.handsThisShoeByTable.get(tableId) ?? 0;
      const gameCount = table.gameCount!;
      if (isPhysicalShoeFromRoadCount(previous, gameCount, tracked)) {
        this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);
        this.beginNewShoe(tableId, observedAt, events);
      }
      this.lastGameCountByTable.set(tableId, gameCount);
    }

    const handId = typeof table.roundId === 'string' ? table.roundId.trim() : '';
    if (!handId || handId === '—') return;

    this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);

    const source = table.source === 'protocol' || table.source === 'dom' ? table.source : undefined;
    const playerCards = parseCards(table.playerCards);
    const bankerCards = parseCards(table.bankerCards);
    const handKey = `${tableId}:${handId}`;
    const hasCardPayload = table.playerCards !== undefined || table.bankerCards !== undefined;

    if (this.finishedHands.has(handKey)) {
      if (hasCardPayload && (playerCards.length > 0 || bankerCards.length > 0)) {
        const merged = mergeHandCards(this.cardsByHand.get(handKey), playerCards, bankerCards, source);
        this.cardsByHand.set(handKey, merged);
        this.recordCards(tableId, handId, 'player', merged.playerCards, observedAt, events);
        this.recordCards(tableId, handId, 'banker', merged.bankerCards, observedAt, events);
      }
      this.settleRememberedHand(tableId, handId, observedAt, events);
      return;
    }

    const previousHandId = this.lastRoundByTable.get(tableId);
    if (previousHandId !== undefined && previousHandId !== handId) {
      this.finishedHands.add(`${tableId}:${previousHandId}`);
      this.closeWindows(tableId, previousHandId, observedAt, events);
      this.settleRememberedHand(tableId, previousHandId, observedAt, events);
      this.handsThisShoeByTable.set(tableId, (this.handsThisShoeByTable.get(tableId) ?? 1) + 1);
    } else if (previousHandId === undefined) {
      this.handsThisShoeByTable.set(tableId, 1);
    }
    this.lastRoundByTable.set(tableId, handId);

    const emptyOpenBoundary = table.bettingOpen === true
      && playerCards.length === 0
      && bankerCards.length === 0;
    if (emptyOpenBoundary) this.cardBoundaryByHand.add(handKey);
    const mayAcceptCards = source === 'protocol'
      || previousHandId === undefined
      || this.cardBoundaryByHand.has(handKey);
    if (mayAcceptCards && hasCardPayload && (playerCards.length > 0 || bankerCards.length > 0)) {
      const merged = mergeHandCards(this.cardsByHand.get(handKey), playerCards, bankerCards, source);
      this.cardsByHand.set(handKey, merged);
      this.recordCards(tableId, handId, 'player', merged.playerCards, observedAt, events);
      this.recordCards(tableId, handId, 'banker', merged.bankerCards, observedAt, events);
    }

    const rememberedCards = this.cardsByHand.get(handKey);
    const hasObservedCards = (rememberedCards?.playerCards.length ?? 0)
      + (rememberedCards?.bankerCards.length ?? 0) > 0;
    if (table.bettingOpen === true && !hasObservedCards) {
      this.openWindows(tableId, handId, table.countdown, observedAt, events);
    } else if (table.bettingOpen === false || table.gameSettled === true) {
      this.closeWindows(tableId, handId, observedAt, events);
      this.settleRememberedHand(tableId, handId, observedAt, events);
    }
  }

  private nextSeq(tableId: string): number {
    const next = (this.seqByTable.get(tableId) ?? 0) + 1;
    this.seqByTable.set(tableId, next);
    return next;
  }

  private makeEvent(
    tableId: string,
    type: NormalizedEvent['type'],
    stableKey: string,
    timestamp: string,
    extra: Record<string, unknown>,
  ): NormalizedEvent {
    return {
      type,
      eventId: `pragmatic:${this.runId}:${this.generationByTable.get(tableId) ?? 0}:${tableId}:${type}:${stableKey}`,
      tableId,
      timestamp,
      sourceSeq: this.nextSeq(tableId),
      source: 'pragmatic-runtime',
      schemaVersion: EVENT_SCHEMA_VERSION,
      ...extra,
    } as NormalizedEvent;
  }

  private ensureShoe(
    tableId: string,
    baseline: ShoeBaseline,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    if (this.shoeIdByTable.has(tableId)) return;
    this.shoeSeqByTable.set(tableId, 1);
    this.emitShoe(tableId, 1, baseline, timestamp, events);
  }

  private beginNewShoe(tableId: string, timestamp: string, events: NormalizedEvent[]): void {
    this.clearShoeTracking(tableId);
    const sequence = (this.shoeSeqByTable.get(tableId) ?? 1) + 1;
    this.shoeSeqByTable.set(tableId, sequence);
    this.emitShoe(tableId, sequence, 'physical-shoe', timestamp, events);
  }

  private clearShoeTracking(tableId: string): void {
    this.lastGameCountByTable.delete(tableId);
    this.handsThisShoeByTable.delete(tableId);
    this.lastRoundByTable.delete(tableId);
    this.clearHandState(tableId);
  }

  private clearHandState(tableId: string): void {
    const prefix = `${tableId}:`;
    for (const key of this.cardsByHand.keys()) if (key.startsWith(prefix)) this.cardsByHand.delete(key);
    for (const key of this.seenCardsByHand.keys()) if (key.startsWith(prefix)) this.seenCardsByHand.delete(key);
    for (const key of this.cardBoundaryByHand) if (key.startsWith(prefix)) this.cardBoundaryByHand.delete(key);
    for (const key of this.openedWindows) if (key.startsWith(prefix)) this.openedWindows.delete(key);
    for (const key of this.closedWindows) if (key.startsWith(prefix)) this.closedWindows.delete(key);
    for (const key of this.windowClosesAtMs.keys()) if (key.startsWith(prefix)) this.windowClosesAtMs.delete(key);
    for (const key of this.lastWindowEmitAtMs.keys()) if (key.startsWith(prefix)) this.lastWindowEmitAtMs.delete(key);
    for (const key of this.settledHands) if (key.startsWith(prefix)) this.settledHands.delete(key);
    for (const key of this.finishedHands) if (key.startsWith(prefix)) this.finishedHands.delete(key);
  }

  private emitShoe(
    tableId: string,
    sequence: number,
    baseline: ShoeBaseline,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    const shoeId = `pragmatic-${tableId}-${sequence}`;
    this.shoeIdByTable.set(tableId, shoeId);
    events.push(this.makeEvent(tableId, 'newShoeSignal', `shoe:${shoeId}`, timestamp, {
      shoeId,
      baseline,
      profile: {
        ...defaultProfile(tableId),
        autoConfirmNewShoe: true,
      },
    }));
  }

  private recordCards(
    tableId: string,
    handId: string,
    position: 'player' | 'banker',
    cards: readonly Card[],
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    const handKey = `${tableId}:${handId}`;
    const seen = this.seenCardsByHand.get(handKey) ?? new Set<string>();
    this.seenCardsByHand.set(handKey, seen);
    cards.slice(0, 3).forEach((card, index) => {
      const identity = cardIdentity(card);
      if ([...seen].some(key => {
        const parts = key.split(':');
        return parts[0] === position && parts.slice(2).join(':') === identity;
      })) return;
      const cardKey = `${position}:${index}:${identity}`;
      if (seen.has(cardKey)) return;
      seen.add(cardKey);
      events.push(this.makeEvent(tableId, 'cardObserved', `card:${handId}:${cardKey}`, timestamp, {
        shoeId: this.shoeIdByTable.get(tableId) ?? '',
        handId,
        card,
        position,
      }));
    });
  }

  private openWindows(
    tableId: string,
    handId: string,
    countdown: number | undefined,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    const observedAtMs = Date.parse(timestamp);
    const closesAtMs = Number.isFinite(countdown) && Number.isFinite(observedAtMs)
      ? observedAtMs + Math.max(0, countdown!) * 1000
      : undefined;
    for (const market of ['bankerPair', 'playerPair'] as const) {
      const key = `${tableId}:${handId}:${market}`;
      const alreadyOpen = this.openedWindows.has(key) && !this.closedWindows.has(key);
      if (alreadyOpen) {
        const hadClosesAt = this.windowClosesAtMs.get(key) !== undefined;
        if (!Number.isFinite(closesAtMs) && !hadClosesAt) continue;
        if (hadClosesAt) {
          this.windowClosesAtMs.set(key, closesAtMs!);
          continue;
        }
      }
      this.openedWindows.add(key);
      this.closedWindows.delete(key);
      if (Number.isFinite(closesAtMs)) this.windowClosesAtMs.set(key, closesAtMs!);
      if (Number.isFinite(observedAtMs)) this.lastWindowEmitAtMs.set(key, observedAtMs);
      const closesAt = Number.isFinite(closesAtMs) ? new Date(closesAtMs!).toISOString() : undefined;
      const stableKey = alreadyOpen
        ? `open:${handId}:${market}:eta`
        : `open:${handId}:${market}`;
      events.push(this.makeEvent(tableId, 'bettingWindowOpened', stableKey, timestamp, {
        shoeId: this.shoeIdByTable.get(tableId) ?? '',
        handId,
        market,
        ...(closesAt === undefined ? {} : { closesAt }),
      }));
    }
  }

  private closeWindows(
    tableId: string,
    handId: string,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    for (const market of ['bankerPair', 'playerPair'] as const) {
      const key = `${tableId}:${handId}:${market}`;
      if (this.closedWindows.has(key)) continue;
      this.closedWindows.add(key);
      this.windowClosesAtMs.delete(key);
      events.push(this.makeEvent(tableId, 'bettingWindowClosed', `close:${handId}:${market}`, timestamp, {
        shoeId: this.shoeIdByTable.get(tableId) ?? '',
        handId,
        market,
        openingObserved: this.openedWindows.has(key),
      }));
    }
  }

  private settleRememberedHand(
    tableId: string,
    handId: string,
    timestamp: string,
    events: NormalizedEvent[],
    force = false,
  ): void {
    const handKey = `${tableId}:${handId}`;
    if (this.settledHands.has(handKey)) return;
    const cards = this.cardsByHand.get(handKey);
    if (!cards || cards.playerCards.length < 2 || cards.bankerCards.length < 2) return;
    if (!force && !isCompleteBaccaratHand(cards.playerCards, cards.bankerCards)) return;
    this.settledHands.add(handKey);
    events.push(this.makeEvent(tableId, 'handSettled', `settled:${handId}`, timestamp, {
      shoeId: this.shoeIdByTable.get(tableId) ?? '',
      handId,
      playerCards: cards.playerCards,
      bankerCards: cards.bankerCards,
      outcomes: {
        playerPair: cards.playerCards[0]!.rank === cards.playerCards[1]!.rank,
        bankerPair: cards.bankerCards[0]!.rank === cards.bankerCards[1]!.rank,
      },
    }));
  }
}
