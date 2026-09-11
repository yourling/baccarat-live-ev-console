import {
  EVENT_SCHEMA_VERSION,
  defaultProfile,
  type Card,
  type CardRank,
  type NormalizedEvent,
  type ShoeBaseline,
} from '@baccarat/contracts';
import { WINFINITY_PLATFORM_ID } from '@baccarat/adapter-contract';

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

const ROAD_WRAP_MAX = 8;
const ROAD_WRAP_MIN_PREVIOUS = 10;
const ROAD_WRAP_MIN_DROP = 8;
const MAX_BACCARAT_SHOE_HANDS = 80;

type HandCards = { playerCards: Card[]; bankerCards: Card[] };
type ParserShoeReason = 'attach' | 'protocol-shuffle' | 'road-wrap' | 'manual-confirm';
type ShoeEvidence = {
  readonly reason: ParserShoeReason;
  readonly previousGameCount?: number;
  readonly gameCount?: number;
};

function isWinfinityRoadWrap(previous: number | undefined, gameCount: number): boolean {
  return previous !== undefined
    && previous >= ROAD_WRAP_MIN_PREVIOUS
    && gameCount >= 1
    && gameCount <= ROAD_WRAP_MAX
    && previous - gameCount >= ROAD_WRAP_MIN_DROP;
}

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

export function selectWinfinityRoadCount(
  previous: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (incoming === undefined) return previous;
  if (!Number.isInteger(incoming) || incoming < 1 || incoming > 80) return previous;
  if (previous === undefined || incoming === previous) return incoming;
  if (incoming > previous) return incoming;
  if (previous >= 10 && incoming <= 8 && previous - incoming >= 8) return incoming;
  if (previous - incoming <= 2) return incoming;
  return previous;
}

export function parseWinfinityStreamParts(streamId: string): { prefix: string; number: number } | undefined {
  const match = /^([a-z0-9]+)-bac(\d+)$/i.exec(streamId.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { prefix: match[1].toLowerCase(), number: Number(match[2]) };
}

export function parseWinfinityTableLabel(label: string): { family: string; number: number } | undefined {
  const match = /^(.*?)\s+baccarat\s+(\d+)\b/i.exec(label.replace(/\s+/g, ' ').trim());
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  const family = match[1].trim().toLowerCase();
  if (family.length === 0) return undefined;
  return { family, number: Number(match[2]) };
}

export function winfinityVendorFromFallbackTableId(tableId: string): string | undefined {
  const match = /^wnf-([a-f0-9]{24})$/i.exec(tableId.trim());
  return match?.[1]?.toLowerCase();
}

export function collapseWinfinityDuplicateTableIds(
  tableIds: readonly string[],
  options: {
    readonly aliasByVendor?: ReadonlyMap<string, string>;
    readonly tables?: ReadonlyArray<{
      readonly tableId: string;
      readonly displayName?: string;
      readonly roomId?: string;
    }>;
    readonly preferIds?: readonly string[];
    readonly introduceAliases?: boolean;
  } = {},
): string[] {
  const original = new Set(tableIds);
  const prefer = new Set(options.preferIds ?? []);
  const aliasByVendor = options.aliasByVendor ?? new Map<string, string>();
  const metaById = new Map((options.tables ?? []).map(table => [table.tableId, table]));
  const remap = (tableId: string): string => {
    const vendor = winfinityVendorFromFallbackTableId(tableId);
    if (vendor === undefined) return tableId;
    const aliased = aliasByVendor.get(vendor);
    if (aliased === undefined || aliased === tableId) return tableId;
    if (
      options.introduceAliases === true
      || original.has(aliased)
      || prefer.has(aliased)
    ) return aliased;
    return tableId;
  };
  const remapped = tableIds.map(remap);
  const preferredByName = new Map<string, string>();
  for (const tableId of remapped) {
    const key = winfinityDuplicateNameKey(tableId, metaById.get(tableId) ?? metaById.get(remap(tableId)));
    if (key === undefined) continue;
    const current = preferredByName.get(key);
    if (current === undefined || winfinityIdPreference(tableId) > winfinityIdPreference(current)) {
      preferredByName.set(key, tableId);
    }
  }
  const seen = new Set<string>();
  const collapsed: string[] = [];
  for (const tableId of remapped) {
    const key = winfinityDuplicateNameKey(tableId, metaById.get(tableId));
    if (key !== undefined && preferredByName.get(key) !== tableId) continue;
    if (seen.has(tableId)) continue;
    if (options.introduceAliases !== true && !original.has(tableId)) continue;
    seen.add(tableId);
    collapsed.push(tableId);
  }
  return collapsed;
}

function winfinityDuplicateNameKey(
  tableId: string,
  table?: { readonly displayName?: string; readonly roomId?: string },
): string | undefined {
  if (normalizeWinfinityTableId(tableId) === undefined) return undefined;
  const displayName = table?.displayName?.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!displayName) return undefined;
  return `${table?.roomId ?? 'dafabet-winfinity'}::${displayName}`;
}

function winfinityIdPreference(tableId: string): number {
  if (WINFINITY_STREAM_ID_PATTERN.test(tableId)) return 2;
  if (WINFINITY_FALLBACK_TABLE_ID_PATTERN.test(tableId)) return 1;
  return 0;
}

export function winfinityDisplayNameFromText(text: string): string | undefined {
  const match = /^(.*?)\s+(baccarat)\s+(\d+)\b/i.exec(text.replace(/\s+/g, ' ').trim());
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return undefined;
  }
  const family = match[1].trim();
  if (family.length === 0) return undefined;
  return `${family} ${match[2][0]?.toUpperCase() ?? 'B'}${match[2].slice(1).toLowerCase()} ${match[3]}`;
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
  private readonly lastGameCountByTable = new Map<string, number>();
  private readonly handsThisShoeByTable = new Map<string, number>();
  private readonly handOrderByTable = new Map<string, string[]>();
  private readonly lastHandIdByTable = new Map<string, string>();
  private readonly wrapSeqByTable = new Map<string, number>();
  private readonly settledHands = new Set<string>();
  private readonly tableNameByVendor = new Map<string, string>();
  private readonly familyPrefix = new Map<string, string>();

  registerAlias(vendorTableId: string, streamId: string): void {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return;
    if (this.lockedByVendor.has(vendor)) return;
    const stream = streamId.trim().toLowerCase();
    if (!WINFINITY_STREAM_ID_PATTERN.test(stream)) return;
    this.applyLock(vendor, stream);
    this.applyNameInferences();
  }

  lockPublicId(vendorTableId: string, publicId: string): void {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return;
    if (this.lockedByVendor.has(vendor)) return;
    const normalized = normalizeWinfinityTableId(publicId);
    if (normalized === undefined) return;
    this.applyLock(vendor, normalized);
    this.applyNameInferences();
  }

  peekPublicId(vendorTableId: string): string | undefined {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return undefined;
    return this.lockedByVendor.get(vendor);
  }

  hasLockedPublicId(vendorTableId: string): boolean {
    return this.peekPublicId(vendorTableId) !== undefined;
  }

  resolveTableId(vendorTableId: string): string | undefined {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return undefined;
    return this.lockedByVendor.get(vendor) ?? publicWinfinityTableId({ vendorTableId: vendor });
  }

  registerAliasesFromPayload(payload: unknown): Array<{ vendorTableId: string; publicId: string }> {
    const found = new Map<string, string>();
    this.walkNamedTables(payload, 0);
    this.walkAliasPayload(payload, found, 0);
    this.applyNameInferences();
    for (const [vendorTableId, publicId] of this.lockedByVendor) {
      if (!found.has(vendorTableId) && this.tableNameByVendor.has(vendorTableId)) {
        found.set(vendorTableId, publicId);
      }
    }
    return [...found.entries()].map(([vendorTableId, publicId]) => ({ vendorTableId, publicId }));
  }

  noteNamedTablesFromPayload(payload: unknown): void {
    this.walkNamedTables(payload, 0);
    this.applyNameInferences();
  }

  displayNameForVendor(vendorTableId: string): string | undefined {
    const vendor = vendorTableId.trim().toLowerCase();
    return this.tableNameByVendor.get(vendor);
  }

  displayNameForTable(tableId: string): string | undefined {
    const normalized = normalizeWinfinityTableId(tableId);
    if (normalized === undefined) return undefined;
    for (const [vendor, publicId] of this.lockedByVendor) {
      if (publicId !== normalized) continue;
      const name = this.tableNameByVendor.get(vendor);
      if (name !== undefined) return name;
    }
    return undefined;
  }

  namedVendorTableIds(): string[] {
    return [...this.tableNameByVendor.keys()];
  }

  hasLearnedStreamFamily(): boolean {
    return this.familyPrefix.size > 0;
  }

  lockedAliases(): ReadonlyMap<string, string> {
    return new Map(this.lockedByVendor);
  }

  inferredPublicId(vendorTableId: string): string | undefined {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return undefined;
    const locked = this.lockedByVendor.get(vendor);
    if (locked !== undefined) return locked;
    return this.inferStreamId(vendor);
  }

  peekCurrentShoeId(tableId: string): string | undefined {
    return this.currentShoeId.get(tableId);
  }

  emitCurrentShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    const shoeId = this.currentShoeId.get(tableId);
    if (shoeId === undefined) return [];
    const reason = this.evidenceByTable.get(tableId)?.reason;
    const baseline: ShoeBaseline = reason === 'protocol-shuffle'
      || reason === 'manual-confirm'
      || reason === 'road-wrap'
      ? 'physical-shoe'
      : 'unknown-monitor-session';
    const events: NormalizedEvent[] = [];
    this.emitNewShoe(tableId, shoeId, baseline, timestamp, events);
    return events;
  }

  shoeEvidence(tableId: string): ShoeEvidence | undefined {
    const evidence = this.evidenceByTable.get(tableId);
    return evidence === undefined ? undefined : { ...evidence };
  }

  acceptedGameCount(tableId: string): number | undefined {
    return this.lastGameCountByTable.get(tableId);
  }

  recordShoeEvidence(tableId: string, evidence: ShoeEvidence): void {
    this.evidenceByTable.set(tableId, {
      reason: evidence.reason,
      ...(evidence.previousGameCount === undefined ? {} : { previousGameCount: evidence.previousGameCount }),
      ...(evidence.gameCount === undefined ? {} : { gameCount: evidence.gameCount }),
    });
  }

  noteGameCounts(
    tables: ReadonlyArray<{ readonly tableId: string; readonly gameCount: number }>,
    timestamp: string,
  ): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    for (const table of tables) {
      const tableId = normalizeWinfinityTableId(table.tableId);
      if (tableId === undefined) continue;
      this.noteGameCount(tableId, table.gameCount, timestamp, events);
    }
    return events;
  }

  openPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const shoeId = `wnf-${tableId}-operator`;
    this.clearShoeTracking(tableId);
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
      frame.type === 'TABLES_LIST'
      || frame.type === 'CURRENT_STATE'
      || frame.type === 'TABLE_SETTINGS_CHANGED'
    ) {
      this.registerAliasesFromPayload(frame);
      return [];
    }
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
    this.trackHand(tableId, handId);
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

  private applyLock(vendor: string, publicId: string): void {
    this.lockedByVendor.set(vendor, publicId);
    const fallback = publicWinfinityTableId({ vendorTableId: vendor });
    if (fallback !== undefined && fallback !== publicId) this.rekeyTable(fallback, publicId);
    this.learnFamilyFromVendor(vendor);
  }

  private inferStreamId(vendor: string): string | undefined {
    const name = this.tableNameByVendor.get(vendor);
    if (name === undefined) return undefined;
    const label = parseWinfinityTableLabel(name);
    if (label === undefined) return undefined;
    const prefix = this.familyPrefix.get(label.family);
    if (prefix === undefined) return undefined;
    return `${prefix}-bac${label.number}`;
  }

  private learnFamilyFromVendor(vendor: string): void {
    const publicId = this.lockedByVendor.get(vendor);
    const name = this.tableNameByVendor.get(vendor);
    if (publicId === undefined || name === undefined) return;
    const stream = parseWinfinityStreamParts(publicId);
    const label = parseWinfinityTableLabel(name);
    if (stream === undefined || label === undefined) return;
    if (stream.number !== label.number) return;
    if (this.familyPrefix.has(label.family)) return;
    this.familyPrefix.set(label.family, stream.prefix);
  }

  private applyNameInferences(): Array<{ vendorTableId: string; publicId: string }> {
    const found: Array<{ vendorTableId: string; publicId: string }> = [];
    for (const vendor of this.tableNameByVendor.keys()) {
      if (this.lockedByVendor.has(vendor)) continue;
      const inferred = this.inferStreamId(vendor);
      if (inferred === undefined) continue;
      this.applyLock(vendor, inferred);
      found.push({ vendorTableId: vendor, publicId: inferred });
    }
    return found;
  }

  private walkNamedTables(value: unknown, depth: number): void {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) this.walkNamedTables(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    let vendor: string | undefined;
    let tableName: string | undefined;
    const tableId = record.tableId;
    if (typeof tableId === 'string' && WINFINITY_VENDOR_TABLE_ID_PATTERN.test(tableId.trim().toLowerCase())) {
      vendor = tableId.trim().toLowerCase();
    }
    for (const field of ['tableName', 'name', 'displayName']) {
      const raw = record[field];
      if (typeof raw !== 'string') continue;
      const displayName = winfinityDisplayNameFromText(raw);
      if (displayName === undefined) continue;
      tableName = displayName;
      break;
    }
    if (vendor !== undefined && tableName !== undefined && !this.tableNameByVendor.has(vendor)) {
      this.tableNameByVendor.set(vendor, tableName);
      this.learnFamilyFromVendor(vendor);
    }
    for (const field of Object.values(record)) {
      if (field !== null && typeof field === 'object') this.walkNamedTables(field, depth + 1);
    }
  }

  private rekeyTable(fromId: string, toId: string): void {
    if (fromId === toId) return;
    moveMapKey(this.seqByTable, fromId, toId);
    moveMapKey(this.lastShoeToken, fromId, toId);
    moveMapKey(this.currentShoeId, fromId, toId);
    moveMapKey(this.evidenceByTable, fromId, toId);
    moveMapKey(this.lastGameCountByTable, fromId, toId);
    moveMapKey(this.handsThisShoeByTable, fromId, toId);
    moveMapKey(this.handOrderByTable, fromId, toId);
    moveMapKey(this.lastHandIdByTable, fromId, toId);
    moveMapKey(this.wrapSeqByTable, fromId, toId);
    rekeyPrefixedMap(this.cardsByHand, fromId, toId);
    rekeyPrefixedSet(this.seenCardIds, fromId, toId);
    rekeyPrefixedSet(this.openedWindows, fromId, toId);
    rekeyPrefixedSet(this.closedWindows, fromId, toId);
    rekeyPrefixedSet(this.settledHands, fromId, toId);
  }

  private walkAliasPayload(
    value: unknown,
    found: Map<string, string>,
    depth: number,
  ): void {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) this.walkAliasPayload(item, found, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    let streamId: string | undefined;
    let vendor: string | undefined;
    for (const field of Object.values(record)) {
      if (typeof field !== 'string') continue;
      const trimmed = field.trim().toLowerCase();
      if (streamId === undefined && WINFINITY_STREAM_ID_PATTERN.test(trimmed)) streamId = trimmed;
      if (vendor === undefined && WINFINITY_VENDOR_TABLE_ID_PATTERN.test(trimmed)) vendor = trimmed;
    }
    if (streamId !== undefined && vendor !== undefined) {
      this.registerAlias(vendor, streamId);
      const publicId = this.peekPublicId(vendor);
      if (publicId !== undefined) found.set(vendor, publicId);
    }
    for (const field of Object.values(record)) {
      if (field !== null && typeof field === 'object') this.walkAliasPayload(field, found, depth + 1);
    }
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
    if (payload === undefined) return;
    const incremental = Array.isArray(payload.cards) ? payload.cards : [];
    const allCards = Array.isArray(payload.allCards) ? payload.allCards : [];
    this.ingestCardEntries(tableId, shoeId, handId, timestamp, incremental, events);
    this.ingestCardEntries(tableId, shoeId, handId, timestamp, allCards, events);
  }

  private ingestCardEntries(
    tableId: string,
    shoeId: string,
    handId: string,
    timestamp: string,
    entries: readonly unknown[],
    events: NormalizedEvent[],
  ): void {
    const handKey = `${tableId}:${handId}`;
    for (const entry of entries) {
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
    const remembered = this.cardsByHand.get(`${tableId}:${settledHandId}`)
      ?? { playerCards: [], bankerCards: [] };
    if (remembered.playerCards.length < 2 || remembered.bankerCards.length < 2) return;
    this.settledHands.add(key);
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
    const reason = this.evidenceByTable.get(tableId)?.reason;
    if (previous === undefined) {
      if (reason === 'manual-confirm' || reason === 'road-wrap') return;
      this.evidenceByTable.set(tableId, { reason: 'attach' });
      this.currentShoeId.set(tableId, shoeId);
      this.emitNewShoe(tableId, shoeId, 'unknown-monitor-session', timestamp, events);
      return;
    }
    if (reason === 'road-wrap' && (this.handsThisShoeByTable.get(tableId) ?? 0) <= ROAD_WRAP_MAX) {
      return;
    }
    this.evidenceByTable.set(tableId, { reason: 'protocol-shuffle' });
    this.currentShoeId.set(tableId, shoeId);
    this.clearShoeTracking(tableId);
    this.emitNewShoe(tableId, shoeId, 'physical-shoe', timestamp, events);
  }

  private noteGameCount(
    tableId: string,
    gameCount: number,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    if (!Number.isInteger(gameCount) || gameCount < 1 || gameCount > MAX_BACCARAT_SHOE_HANDS) return;
    const tracked = this.handsThisShoeByTable.get(tableId) ?? 0;
    const lastRoad = this.lastGameCountByTable.get(tableId);
    const evidence = this.evidenceByTable.get(tableId);
    const laggedPreviousShoe = evidence?.reason === 'protocol-shuffle'
      && tracked < ROAD_WRAP_MAX
      && gameCount > ROAD_WRAP_MAX
      && (lastRoad === undefined || lastRoad <= ROAD_WRAP_MAX);
    if (laggedPreviousShoe) return;
    if (tracked >= ROAD_WRAP_MIN_PREVIOUS) {
      const previous = lastRoad ?? tracked;
      if (
        isWinfinityRoadWrap(previous, gameCount)
        || isWinfinityRoadWrap(tracked, gameCount)
      ) {
        this.beginRoadWrap(tableId, previous, gameCount, timestamp, events);
        return;
      }
    }
    this.lastGameCountByTable.set(tableId, gameCount);
  }

  private beginRoadWrap(
    tableId: string,
    previous: number,
    gameCount: number,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    const order = this.handOrderByTable.get(tableId) ?? [];
    const replayIds = order.slice(-gameCount);
    const replayed: Array<{ handId: string; cards: HandCards }> = [];
    for (const handId of replayIds) {
      const cards = this.cardsByHand.get(`${tableId}:${handId}`);
      if (cards === undefined) continue;
      replayed.push({
        handId,
        cards: {
          playerCards: [...cards.playerCards],
          bankerCards: [...cards.bankerCards],
        },
      });
    }
    const sequence = (this.wrapSeqByTable.get(tableId) ?? 0) + 1;
    this.wrapSeqByTable.set(tableId, sequence);
    const shoeId = `wnf-${tableId}-wrap-${sequence}`;
    this.evidenceByTable.set(tableId, {
      reason: 'road-wrap',
      previousGameCount: previous,
      gameCount,
    });
    this.currentShoeId.set(tableId, shoeId);
    this.clearTableHandState(tableId);
    this.lastGameCountByTable.set(tableId, gameCount);
    this.handOrderByTable.set(tableId, replayed.map(hand => hand.handId));
    this.handsThisShoeByTable.set(tableId, replayed.length);
    const lastReplayed = replayed[replayed.length - 1]?.handId;
    if (lastReplayed !== undefined) this.lastHandIdByTable.set(tableId, lastReplayed);
    else this.lastHandIdByTable.delete(tableId);
    this.emitNewShoe(tableId, shoeId, 'physical-shoe', timestamp, events);
    for (const hand of replayed) {
      this.replayHandCards(tableId, shoeId, hand.handId, timestamp, hand.cards, events);
    }
  }

  private replayHandCards(
    tableId: string,
    shoeId: string,
    handId: string,
    timestamp: string,
    cards: HandCards,
    events: NormalizedEvent[],
  ): void {
    const handKey = `${tableId}:${handId}`;
    this.cardsByHand.set(handKey, {
      playerCards: [...cards.playerCards],
      bankerCards: [...cards.bankerCards],
    });
    const emit = (area: 'player' | 'banker', card: Card, index: number): void => {
      const seenKey = `${tableId}:wrap:${handId}:${area}:${index}`;
      this.seenCardIds.add(seenKey);
      events.push(this.makeWindowEvent(
        tableId,
        'cardObserved',
        `card:${handId}:wrap:${area}:${index}`,
        timestamp,
        { shoeId, handId, card, position: `${area}:${index === 2 ? 'extra' : index === 1 ? 'right' : 'left'}` },
      ));
    };
    cards.playerCards.forEach((card, index) => emit('player', card, index));
    cards.bankerCards.forEach((card, index) => emit('banker', card, index));
  }

  private trackHand(tableId: string, handId: string): void {
    if (this.lastHandIdByTable.get(tableId) === handId) return;
    this.lastHandIdByTable.set(tableId, handId);
    const order = this.handOrderByTable.get(tableId) ?? [];
    if (!order.includes(handId)) {
      order.push(handId);
      this.handOrderByTable.set(tableId, order);
    }
    this.handsThisShoeByTable.set(tableId, order.length);
  }

  private clearShoeTracking(tableId: string): void {
    this.clearTableHandState(tableId);
    this.lastGameCountByTable.delete(tableId);
    this.handsThisShoeByTable.delete(tableId);
    this.handOrderByTable.delete(tableId);
    this.lastHandIdByTable.delete(tableId);
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
      platformId: WINFINITY_PLATFORM_ID,
      tableId,
      timestamp,
      sourceSeq,
      source: 'winfinity-runtime',
      schemaVersion: EVENT_SCHEMA_VERSION,
      ...extra,
    } as NormalizedEvent;
  }
}

function moveMapKey<T>(map: Map<string, T>, fromId: string, toId: string): void {
  if (!map.has(fromId)) return;
  if (!map.has(toId)) map.set(toId, map.get(fromId) as T);
  map.delete(fromId);
}

function rekeyPrefixedMap<T>(map: Map<string, T>, fromId: string, toId: string): void {
  const prefix = `${fromId}:`;
  const moved: Array<[string, T]> = [];
  for (const [key, value] of map) {
    if (!key.startsWith(prefix)) continue;
    moved.push([`${toId}:${key.slice(prefix.length)}`, value]);
    map.delete(key);
  }
  for (const [key, value] of moved) {
    if (!map.has(key)) map.set(key, value);
  }
}

function rekeyPrefixedSet(set: Set<string>, fromId: string, toId: string): void {
  const prefix = `${fromId}:`;
  const moved: string[] = [];
  for (const key of set) {
    if (!key.startsWith(prefix)) continue;
    moved.push(`${toId}:${key.slice(prefix.length)}`);
    set.delete(key);
  }
  for (const key of moved) set.add(key);
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
