/**
 * Big Gaming (BG) runtime snapshot parser.
 * Accepts only the versioned adapter snapshot schema. Raw vendor WebSocket
 * frames are captured elsewhere and are not decoded here.
 */
import {
  EVENT_SCHEMA_VERSION,
  defaultProfile,
  type Card,
  type CardRank,
  type NormalizedEvent,
  type ShoeBaseline,
} from '@baccarat/contracts';

export interface BgTableSnapshot {
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
  readonly shuffleEvent?: boolean;
  readonly source?: 'dom' | 'protocol' | 'hall';
  readonly gameSettled?: boolean;
  readonly historyHands?: readonly {
    readonly playerCards: readonly string[];
    readonly bankerCards: readonly string[];
  }[];
}

export interface BgRuntimeSnapshot {
  readonly version: 1;
  readonly view: 'single' | 'multi';
  readonly observedAt: string;
  readonly tables: readonly BgTableSnapshot[];
}

/**
 * Countdown is not parsed as gameCount. A deep-road drop to an early count
 * is a new shoe; open it on the first observation.
 *
 * AGENTS.md: wrap only when this process saw previous>=10 and the road drops
 * by >=8 to <=8. A 29-row HISTORY packet correcting to felt 局 18 is not a shuffle.
 */
const ROAD_WRAP_MAX = 8;
const EARLY_SHOE_ROAD_MAX = 20;
/** HISTORY 29→18 is a correction; 72→18 after a dealt shoe is a missed shuffle. */
const INFLATED_ROAD_PREVIOUS_MAX = 40;
const DEEP_SHOE_ROAD_MIN = 50;
const ROAD_WRAP_MIN_PREVIOUS = 10;
const ROAD_WRAP_MIN_DROP = 8;
/** First START_BET often lands at 1, then HISTORY dumps the whole bead plate. */
const GAME_COUNT_ATTACH_MAX = 1;
const GAME_COUNT_CATCH_UP_MAX = 5;
/** 8-deck shoe with a cut cannot produce 100+ hands. */
const MAX_BACCARAT_SHOE_HANDS = 80;

function isRoadWrapToNewShoe(
  previous: number | undefined,
  gameCount: number,
): boolean {
  return previous !== undefined
    && previous >= ROAD_WRAP_MIN_PREVIOUS
    && gameCount >= 1
    && gameCount <= ROAD_WRAP_MAX
    && previous - gameCount >= ROAD_WRAP_MIN_DROP;
}

function isJoinableNewShoeRoadCount(
  previous: number | undefined,
  gameCount: number,
): boolean {
  return isRoadWrapToNewShoe(previous, gameCount);
}

function isPhysicalShoeFromRoadCount(
  previous: number | undefined,
  gameCount: number,
): boolean {
  return isRoadWrapToNewShoe(previous, gameCount);
}

function isInflatedRoadCorrection(
  previous: number | undefined,
  gameCount: number,
): boolean {
  return previous !== undefined
    && previous >= ROAD_WRAP_MIN_PREVIOUS
    && previous <= INFLATED_ROAD_PREVIOUS_MAX
    && gameCount > ROAD_WRAP_MAX
    && gameCount < previous
    && previous - gameCount >= ROAD_WRAP_MIN_DROP;
}

/** HISTORY often dumps ~29 rows while the felt is 局 18. Not a missed shuffle. */
function isMidShoeInflatedHistoryMismatch(handNumber: number, road: number): boolean {
  const high = Math.max(handNumber, road);
  const low = Math.min(handNumber, road);
  return high >= ROAD_WRAP_MIN_PREVIOUS
    && high <= INFLATED_ROAD_PREVIOUS_MAX
    && low > ROAD_WRAP_MAX
    && high - low >= ROAD_WRAP_MIN_DROP;
}

export function isCredibleBgEndOfShoeShuffle(
  previousRoad: number | undefined,
  incomingRoad: number | undefined,
  handsThisShoe: number | undefined,
): boolean {
  if (incomingRoad !== undefined) {
    if (isRoadWrapToNewShoe(previousRoad, incomingRoad)) return true;
    if (isExhaustedShoeRoadDrop(previousRoad, incomingRoad, handsThisShoe)) return true;
  }
  return (handsThisShoe ?? 0) >= DEEP_SHOE_ROAD_MIN;
}

function isExhaustedShoeRoadDrop(
  previous: number | undefined,
  gameCount: number,
  handsThisShoe?: number,
): boolean {
  if (!Number.isInteger(gameCount) || gameCount < 1 || gameCount > EARLY_SHOE_ROAD_MAX) return false;
  const deepRoad = previous !== undefined && previous >= DEEP_SHOE_ROAD_MIN;
  const deepHands = handsThisShoe !== undefined && handsThisShoe >= DEEP_SHOE_ROAD_MIN;
  if (!deepRoad && !deepHands) return false;
  if (previous === undefined) return deepHands;
  return previous - gameCount >= ROAD_WRAP_MIN_DROP;
}

function isPlausibleGameCountAdvance(
  previous: number | undefined,
  gameCount: number,
): boolean {
  if (!Number.isInteger(gameCount) || gameCount < 1 || gameCount > MAX_BACCARAT_SHOE_HANDS) return false;
  if (previous === undefined) return true;
  if (gameCount === previous) return true;
  if (gameCount > previous) {
    if (previous <= GAME_COUNT_ATTACH_MAX) return true;
    return gameCount - previous <= GAME_COUNT_CATCH_UP_MAX;
  }
  if (previous <= ROAD_WRAP_MAX && gameCount < previous) return true;
  if (isRoadWrapToNewShoe(previous, gameCount)) return true;
  return isInflatedRoadCorrection(previous, gameCount);
}

function parseHandSeq(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function roadCountFromSeqWindow(
  firstSeq: number | undefined,
  liveSeq: number | undefined,
): number | undefined {
  if (firstSeq === undefined || liveSeq === undefined || liveSeq < firstSeq) return undefined;
  const count = liveSeq - firstSeq + 1;
  if (count < 1 || count > MAX_BACCARAT_SHOE_HANDS) return undefined;
  return count;
}

export function selectBgRoadCount(
  previous: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (incoming === undefined) return previous;
  if (!Number.isInteger(incoming) || incoming < 1) return previous;
  return isPlausibleGameCountAdvance(previous, incoming) ? incoming : previous;
}

function selectStableGameCount(
  previous: number | undefined,
  incoming: number,
): number | undefined {
  return selectBgRoadCount(previous, incoming);
}

function selectObservedGameCount(
  evidenceReason: string | undefined,
  accepted: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (incoming === undefined) return accepted;
  if (evidenceReason === 'protocol-shuffle' && accepted === undefined && incoming > EARLY_SHOE_ROAD_MAX) {
    return undefined;
  }
  return selectStableGameCount(accepted, incoming);
}

const GAME_COUNT_ANOMALY_MIN_HANDS = 8;

/**
 * Internal handNumber is how many hands this shoeId has seen.
 * DOM road is what the table shows. A wrap is a new shoe, not an anomaly.
 * A lagged high road right after protocol-shuffle is also not an anomaly.
 * Once we have tracked a real shoe, a large mismatch means inventory/identity
 * cannot be trusted: drop the table and wait for the next physical shoe.
 */
export function isBgInternalExternalGameCountAnomaly(
  handNumber: number,
  roadCount: number | undefined,
  _evidenceReason?: string,
): boolean {
  // HISTORY is a sliding 18-29 row window. Protocol handNumber is often 40-60
  // while that window stays ~21. That is not missing cards and must not kick.
  if (!Number.isInteger(handNumber) || handNumber < GAME_COUNT_ANOMALY_MIN_HANDS) return false;
  if (!Number.isInteger(roadCount) || (roadCount ?? 0) < 1) return false;
  if (handNumber >= roadCount!) return false;
  return false;
}

const BG_TABLE_ID_PATTERN = /^[A-Z]\d{2}$/i;

export function normalizeBgTableId(tableId: string): string | undefined {
  const trimmed = tableId.trim();
  if (!BG_TABLE_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed.toUpperCase();
}

type ParserShoeReason = 'attach' | 'protocol-shuffle' | 'road-wrap' | 'manual-confirm';

interface ParserShoeEvidence {
  readonly reason: ParserShoeReason;
  readonly previousGameCount?: number;
  readonly gameCount?: number;
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

function historyStickyBankerLead(
  hands: readonly { playerCards: readonly string[]; bankerCards: readonly string[] }[],
): string | undefined {
  if (hands.length < 8) return undefined;
  const lead = hands[0]?.bankerCards[0];
  if (!lead) return undefined;
  if (!hands.every(hand => hand.bankerCards[0] === lead)) return undefined;
  const unique = new Set(
    hands.map(hand => `${hand.playerCards.join(',')}|${hand.bankerCards.slice(1).join(',')}`),
  );
  return unique.size >= 4 ? lead : undefined;
}

function stripMatchingBankerLead(cards: Card[], lead: string | undefined): Card[] {
  if (!lead || cards.length === 0) return cards;
  const first = cards[0]!;
  const identity = cardIdentity(first);
  const raw = typeof first.raw === 'string' ? first.raw.trim().toUpperCase() : '';
  if (identity === lead.toUpperCase() || raw === lead.toUpperCase()) return cards.slice(1);
  return cards;
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

function isCompleteBaccaratHand(
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

function validSnapshot(value: unknown): value is BgRuntimeSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BgRuntimeSnapshot>;
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
export function bgGameCountSnapshot(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const snapshot = parsed as Partial<BgRuntimeSnapshot>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.tables)) return undefined;
  const tables: Array<{ tableId: string; gameCount: number }> = [];
  for (const table of snapshot.tables) {
    if (!table || typeof table.tableId !== 'string') continue;
    const tableId = normalizeBgTableId(table.tableId);
    if (tableId === undefined) continue;
    if (!Number.isInteger(table.gameCount) || (table.gameCount ?? 0) < 1) continue;
    tables.push({ tableId, gameCount: table.gameCount! });
  }
  if (tables.length === 0) return undefined;
  return JSON.stringify({
    version: 1,
    view: snapshot.view === 'single' ? 'single' : 'multi',
    observedAt: typeof snapshot.observedAt === 'string' ? snapshot.observedAt : new Date().toISOString(),
    tables,
  });
}

function seqFromShoeReset(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const match = /^seq:(\d+)$/.exec(token);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : undefined;
}

export class BgRuntimeParser {
  private readonly runId = Math.random().toString(36).slice(2, 10);
  private readonly generationByTable = new Map<string, number>();
  private readonly seqByTable = new Map<string, number>();
  private readonly shoeSeqByTable = new Map<string, number>();
  private readonly shoeIdByTable = new Map<string, string>();
  private readonly lastShoeResetByTable = new Map<string, string>();
  private readonly historyFirstSeqByTable = new Map<string, number>();
  private readonly lastGameCountByTable = new Map<string, number>();
  private readonly handsThisShoeByTable = new Map<string, number>();
  private readonly lastRoundByTable = new Map<string, string>();
  private readonly cardBoundaryByHand = new Set<string>();
  private readonly cardsByHand = new Map<string, HandCards>();
  private readonly seenCardsByHand = new Map<string, Set<string>>();
  private readonly openedWindows = new Set<string>();
  private readonly closedWindows = new Set<string>();
  private readonly windowOpenCount = new Map<string, number>();
  private readonly windowClosesAtMs = new Map<string, number>();
  private readonly lastWindowEmitAtMs = new Map<string, number>();
  private readonly settledHands = new Set<string>();
  private readonly finishedHands = new Set<string>();
  private readonly evidenceByTable = new Map<string, ParserShoeEvidence>();
  private readonly bankerLeadByTable = new Map<string, string>();
  private readonly bankerLeadStreakByTable = new Map<string, number>();
  private readonly bankerLeadOtherByTable = new Map<string, Set<string>>();
  private readonly bankerLeadHandByTable = new Map<string, string>();
  private readonly stickyBankerLeadByTable = new Map<string, string>();

  stickyBankerLead(tableId: string): string | undefined {
    return this.stickyBankerLeadByTable.get(tableId);
  }

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
      if (!table || typeof table.tableId !== 'string') continue;
      const tableId = normalizeBgTableId(table.tableId);
      if (tableId === undefined) continue;
      if (!isSelected(tableId)) continue;
      this.ingestTable({ ...table, tableId }, snapshot.observedAt, events);
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
      .map(table => table && typeof table.tableId === 'string' ? normalizeBgTableId(table.tableId) : undefined)
      .filter((tableId): tableId is string => tableId !== undefined);
  }

  currentShoeId(tableId: string): string | undefined {
    return this.shoeIdByTable.get(tableId);
  }

  acceptedGameCount(tableId: string): number | undefined {
    return this.lastGameCountByTable.get(tableId);
  }

  /** Keep shoe generations monotonic across process restarts. */
  seedShoeSequence(tableId: string, sequence: number): void {
    const id = normalizeBgTableId(tableId);
    if (id === undefined || !Number.isInteger(sequence) || sequence < 1) return;
    const current = this.shoeSeqByTable.get(id) ?? 0;
    if (sequence > current) this.shoeSeqByTable.set(id, sequence);
  }

  currentShoeSequence(tableId: string): number | undefined {
    return this.shoeSeqByTable.get(tableId);
  }

  shoeEvidence(tableId: string): ParserShoeEvidence | undefined {
    const evidence = this.evidenceByTable.get(tableId);
    return evidence === undefined ? undefined : { ...evidence };
  }

  recordShoeEvidence(tableId: string, evidence: ParserShoeEvidence): void {
    this.evidenceByTable.set(tableId, evidence);
  }

  openPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    this.beginNewShoe(tableId, timestamp, events, 'physical-shoe', { reason: 'manual-confirm' });
    return events;
  }

  resetTable(tableId: string): void {
    this.generationByTable.set(tableId, (this.generationByTable.get(tableId) ?? 0) + 1);
    this.seqByTable.delete(tableId);
    this.shoeSeqByTable.delete(tableId);
    this.shoeIdByTable.delete(tableId);
    this.lastShoeResetByTable.delete(tableId);
    this.historyFirstSeqByTable.delete(tableId);
    this.lastGameCountByTable.delete(tableId);
    this.handsThisShoeByTable.delete(tableId);
    this.lastRoundByTable.delete(tableId);
    this.evidenceByTable.delete(tableId);
    this.clearHandState(tableId);
  }

  private ingestTable(
    table: BgTableSnapshot,
    observedAt: string,
    events: NormalizedEvent[],
  ): void {
    const tableId = normalizeBgTableId(table.tableId);
    if (tableId === undefined) return;
    table = { ...table, tableId };
    this.ingestShoeReset(table, observedAt, events);

    const lastResetSeq = seqFromShoeReset(this.lastShoeResetByTable.get(tableId));
    const historySeq = seqFromShoeReset(table.shoeReset);
    const laggedPreviousShoeRoad = this.evidenceByTable.get(tableId)?.reason === 'protocol-shuffle'
      && lastResetSeq !== undefined
      && historySeq !== undefined
      && historySeq < lastResetSeq;
    if (historySeq !== undefined && table.shuffleEvent !== true && !laggedPreviousShoeRoad) {
      this.historyFirstSeqByTable.set(tableId, historySeq);
    }

    const feltRoad = Number.isInteger(table.gameCount) && (table.gameCount ?? 0) >= 1
      ? table.gameCount
      : undefined;
    let gameCount = feltRoad;
    if (laggedPreviousShoeRoad) {
      gameCount = undefined;
    } else {
      const historyPacket = (table.historyHands?.length ?? 0) > 0;
      const liveSeq = historyPacket
        ? parseHandSeq(this.lastRoundByTable.get(tableId))
        : parseHandSeq(typeof table.roundId === 'string' ? table.roundId : undefined)
          ?? parseHandSeq(this.lastRoundByTable.get(tableId));
      const firstSeq = historySeq ?? this.historyFirstSeqByTable.get(tableId);
      const seqRoad = roadCountFromSeqWindow(firstSeq, liveSeq);
      const trackedHands = this.handsThisShoeByTable.get(tableId) ?? 0;
      const previousRoad = this.lastGameCountByTable.get(tableId);
      const wrapIncoming = feltRoad !== undefined
        && (
          isRoadWrapToNewShoe(trackedHands > 0 ? trackedHands : undefined, feltRoad)
          || isRoadWrapToNewShoe(previousRoad, feltRoad)
          || (
            isExhaustedShoeRoadDrop(previousRoad, feltRoad, trackedHands)
            && feltRoad <= ROAD_WRAP_MAX
          )
        );
      if (wrapIncoming) {
        gameCount = feltRoad;
      } else if (trackedHands >= INFLATED_ROAD_PREVIOUS_MAX) {
        // Prefer tracked hands over a lagged HISTORY 21, but keep 29→18 corrections
        // and never cover a wrap-shaped felt 局 1-8.
        if (feltRoad !== undefined && isInflatedRoadCorrection(previousRoad ?? trackedHands, feltRoad)) {
          gameCount = feltRoad;
        } else {
          gameCount = Math.max(feltRoad ?? 0, trackedHands);
        }
      } else if (seqRoad !== undefined && (gameCount === undefined || gameCount > seqRoad)) {
        gameCount = seqRoad;
      }
    }

    if (gameCount !== undefined) {
      const previousRoad = this.lastGameCountByTable.get(tableId);
      const previousHands = this.handsThisShoeByTable.get(tableId);
      const previous = previousRoad ?? previousHands;
      const stalePreviousShoeRoad = this.evidenceByTable.get(tableId)?.reason === 'protocol-shuffle'
        && previousRoad === undefined
        && gameCount > EARLY_SHOE_ROAD_MAX;
      if (stalePreviousShoeRoad) {
        // Protocol shuffle and lagged DOM still carry the previous shoe's road #.
      } else if (isPhysicalShoeFromRoadCount(previous, gameCount)) {
        this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);
        this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', {
          reason: 'road-wrap',
          previousGameCount: previous,
          gameCount,
        });
        this.lastGameCountByTable.set(tableId, gameCount);
      } else if (isPlausibleGameCountAdvance(previousRoad, gameCount)) {
        this.lastGameCountByTable.set(tableId, gameCount);
      }
    }

    const openedPhysical = events.some(event =>
      event.tableId === tableId
      && event.type === 'newShoeSignal'
      && event.baseline === 'physical-shoe');
    const evidence = this.evidenceByTable.get(tableId);
    const physical = openedPhysical
      || evidence?.reason === 'protocol-shuffle'
      || evidence?.reason === 'road-wrap'
      || evidence?.reason === 'manual-confirm';
    const historyHands = table.historyHands ?? [];
    const trackedHands = this.handsThisShoeByTable.get(tableId) ?? 0;
    // Deep HISTORY after NEXT_SHOES is the previous shoe only when its first
    // seq is still behind the shuffle token. Current-shoe roads of 21-80 must
    // still rebuild inventory or round and remaining cards contradict.
    const canReplayHistory = physical
      && historyHands.length > 0
      && historyHands.length <= MAX_BACCARAT_SHOE_HANDS
      && !laggedPreviousShoeRoad
      && (openedPhysical || historyHands.length > trackedHands);
    if (canReplayHistory) {
      const replayLiveSeq = parseHandSeq(this.lastRoundByTable.get(tableId));
      const replayFirstSeq = historySeq ?? this.historyFirstSeqByTable.get(tableId);
      const replayRoad = roadCountFromSeqWindow(replayFirstSeq, replayLiveSeq) ?? gameCount;
      const replayTable = replayRoad !== undefined && historyHands.length > replayRoad
        ? { ...table, historyHands: historyHands.slice(0, replayRoad), gameCount: replayRoad }
        : { ...table, ...(gameCount === undefined ? {} : { gameCount }) };
      this.replayHistoryRoad(tableId, replayTable, observedAt, events);
      if (table.bettingOpen !== true) return;
    }

    const handId = typeof table.roundId === 'string' ? table.roundId.trim() : '';
    if (!handId || handId === '—') return;
    // BG round ids are process-global. A leftover snapshot after shuffle must
    // not re-emit the same handSettled id onto the new shoe.
    if (this.settledHands.has(`${tableId}:${handId}`)) return;

    this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);

    const source = table.source === 'protocol' || table.source === 'dom' ? table.source : undefined;
    const playerCards = parseCards(table.playerCards);
    const bankerCards = parseCards(table.bankerCards);
    const lead = bankerCards[0] ? cardIdentity(bankerCards[0]) : undefined;
    if (lead && playerCards.length > 0 && handId) {
      const leadHandKey = `${tableId}:${handId}`;
      if (this.bankerLeadHandByTable.get(tableId) !== leadHandKey) {
        this.bankerLeadHandByTable.set(tableId, leadHandKey);
        const previousLead = this.bankerLeadByTable.get(tableId);
        const otherSig = `${playerCards.map(cardIdentity).join(',')}|${bankerCards.slice(1).map(cardIdentity).join(',')}`;
        if (previousLead === lead) {
          const streak = (this.bankerLeadStreakByTable.get(tableId) ?? 1) + 1;
          this.bankerLeadStreakByTable.set(tableId, streak);
          const others = this.bankerLeadOtherByTable.get(tableId) ?? new Set<string>();
          others.add(otherSig);
          this.bankerLeadOtherByTable.set(tableId, others);
          if (streak >= 3 && others.size >= 2) this.stickyBankerLeadByTable.set(tableId, lead);
        } else {
          this.bankerLeadByTable.set(tableId, lead);
          this.bankerLeadStreakByTable.set(tableId, 1);
          this.bankerLeadOtherByTable.set(tableId, new Set([otherSig]));
        }
      }
    }
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
      const nextHands = (this.handsThisShoeByTable.get(tableId) ?? 1) + 1;
      if (nextHands > MAX_BACCARAT_SHOE_HANDS) {
        // 80 hands without shuffle evidence is not a road-wrap. Reset to 待牌靴
        // so pair EV cannot keep eating the previous inventory.
        this.beginNewShoe(tableId, observedAt, events, 'unknown-monitor-session', {
          reason: 'attach',
        });
        this.handsThisShoeByTable.set(tableId, 1);
      } else {
        this.handsThisShoeByTable.set(tableId, nextHands);
      }
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
      eventId: `bg:${this.runId}:${this.generationByTable.get(tableId) ?? 0}:${tableId}:${type}:${stableKey}`,
      tableId,
      timestamp,
      sourceSeq: this.nextSeq(tableId),
      source: 'bg-runtime',
      schemaVersion: EVENT_SCHEMA_VERSION,
      ...extra,
    } as NormalizedEvent;
  }

  private ingestShoeReset(
    table: BgTableSnapshot,
    observedAt: string,
    events: NormalizedEvent[],
  ): void {
    const tableId = table.tableId;
    const token = typeof table.shoeReset === 'string' && table.shoeReset.length > 0
      ? table.shoeReset
      : undefined;
    const shuffleEvent = table.shuffleEvent === true;
    if (token === undefined) {
      if (shuffleEvent && this.lastShoeResetByTable.has(tableId)) {
        this.promoteProtocolShuffle(tableId, observedAt, events);
      }
      return;
    }
    const previousToken = this.lastShoeResetByTable.get(tableId);
    if (previousToken !== token) {
      const previousSeq = seqFromShoeReset(previousToken);
      const nextSeq = seqFromShoeReset(token);
      if (!shuffleEvent && previousSeq !== undefined && nextSeq !== undefined && nextSeq < previousSeq) {
        return;
      }
      const previousRoad = this.lastGameCountByTable.get(tableId);
      const incomingRoad = Number.isInteger(table.gameCount) && (table.gameCount ?? 0) >= 1
        ? table.gameCount
        : undefined;
      const handsThisShoe = this.handsThisShoeByTable.get(tableId);
      const exhaustedDrop = incomingRoad !== undefined
        && isExhaustedShoeRoadDrop(previousRoad, incomingRoad, handsThisShoe);
      const inflatedCorrection = incomingRoad !== undefined
        && isInflatedRoadCorrection(previousRoad, incomingRoad)
        && !exhaustedDrop;
      // HISTORY stamps shoeReset as seq:<first visible gameId>. That first id
      // walks forward during a live shoe. Treat it as drift, not a shuffle.
      const seqDrift = !shuffleEvent
        && previousSeq !== undefined
        && nextSeq !== undefined
        && nextSeq > previousSeq
        && !isRoadWrapToNewShoe(previousRoad, incomingRoad ?? 0)
        && !exhaustedDrop;
      this.lastShoeResetByTable.set(tableId, token);
      this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);
      if (seqDrift) return;
      // Protocol HISTORY wrap used to fire at road<=20, so 29→18 arrived as
      // shuffleEvent. That is a correction, not a new shoe.
      if (shuffleEvent && inflatedCorrection) return;
      // A leftover currentShoe token on first attach is not a shuffle.
      // startshuffling/endshuffling may set shuffleEvent on that first token;
      // only a later token change is protocol-shuffle.
      if (previousToken !== undefined) {
        const alreadyPhysical = this.hasVerifiedPhysicalEvidence(tableId);
        const handsThisShoe = this.handsThisShoeByTable.get(tableId);
        if (
          !alreadyPhysical
          || isCredibleBgEndOfShoeShuffle(previousRoad, incomingRoad, handsThisShoe)
        ) {
          this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', { reason: 'protocol-shuffle' });
        }
      }
      return;
    }
    if (!shuffleEvent) return;
    if (isInflatedRoadCorrection(this.lastGameCountByTable.get(tableId), table.gameCount ?? 0)) return;
    // Same token is reused when startshuffling is missed or endshuffling
    // copies lastFinishedShuffle. Only a deep/wrapped shoe is the next shuffle;
    // a 2-20 hand pulse is the current shoe's leftover shuffle flag.
    if (this.shoeAlreadyDealt(tableId)) {
      const previousRoad = this.lastGameCountByTable.get(tableId);
      const incomingRoad = Number.isInteger(table.gameCount) && (table.gameCount ?? 0) >= 1
        ? table.gameCount
        : undefined;
      if (isCredibleBgEndOfShoeShuffle(previousRoad, incomingRoad, this.handsThisShoeByTable.get(tableId))) {
        this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', { reason: 'protocol-shuffle' });
      }
      return;
    }
    this.promoteProtocolShuffle(tableId, observedAt, events);
  }

  private hasVerifiedPhysicalEvidence(tableId: string): boolean {
    const reason = this.evidenceByTable.get(tableId)?.reason;
    return reason === 'protocol-shuffle' || reason === 'road-wrap' || reason === 'manual-confirm';
  }

  private shoeAlreadyDealt(tableId: string): boolean {
    // First snapshot of a new shoe often still carries a round id, which
    // counts as 1. A later shuffle after real play is at least a second hand.
    return (this.handsThisShoeByTable.get(tableId) ?? 0) >= 2;
  }

  private promoteProtocolShuffle(
    tableId: string,
    observedAt: string,
    events: NormalizedEvent[],
  ): void {
    if (!this.lastShoeResetByTable.has(tableId)) return;
    if (this.evidenceByTable.get(tableId)?.reason === 'protocol-shuffle') return;
    this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);
    this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', { reason: 'protocol-shuffle' });
  }

  private ensureShoe(
    tableId: string,
    baseline: ShoeBaseline,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    if (this.shoeIdByTable.has(tableId)) return;
    const sequence = (this.shoeSeqByTable.get(tableId) ?? 0) + 1;
    this.shoeSeqByTable.set(tableId, sequence);
    if (!this.evidenceByTable.has(tableId)) this.evidenceByTable.set(tableId, { reason: 'attach' });
    this.emitShoe(tableId, sequence, baseline, timestamp, events);
  }

  private beginNewShoe(
    tableId: string,
    timestamp: string,
    events: NormalizedEvent[],
    baseline: ShoeBaseline,
    evidence?: ParserShoeEvidence,
  ): void {
    this.clearShoeTracking(tableId);
    const sequence = (this.shoeSeqByTable.get(tableId) ?? 1) + 1;
    this.shoeSeqByTable.set(tableId, sequence);
    if (evidence !== undefined) this.evidenceByTable.set(tableId, evidence);
    this.emitShoe(tableId, sequence, baseline, timestamp, events);
  }

  private clearShoeTracking(tableId: string): void {
    this.lastGameCountByTable.delete(tableId);
    this.historyFirstSeqByTable.delete(tableId);
    this.handsThisShoeByTable.delete(tableId);
    this.lastRoundByTable.delete(tableId);
    this.evidenceByTable.delete(tableId);
    this.bankerLeadByTable.delete(tableId);
    this.bankerLeadStreakByTable.delete(tableId);
    this.bankerLeadOtherByTable.delete(tableId);
    this.bankerLeadHandByTable.delete(tableId);
    this.stickyBankerLeadByTable.delete(tableId);
    this.clearHandState(tableId, { keepSettledHands: true });
  }

  private clearHandState(tableId: string, options: { readonly keepSettledHands?: boolean } = {}): void {
    const prefix = `${tableId}:`;
    for (const key of this.cardsByHand.keys()) if (key.startsWith(prefix)) this.cardsByHand.delete(key);
    for (const key of this.seenCardsByHand.keys()) if (key.startsWith(prefix)) this.seenCardsByHand.delete(key);
    for (const key of this.cardBoundaryByHand) if (key.startsWith(prefix)) this.cardBoundaryByHand.delete(key);
    for (const key of this.openedWindows) if (key.startsWith(prefix)) this.openedWindows.delete(key);
    for (const key of this.closedWindows) if (key.startsWith(prefix)) this.closedWindows.delete(key);
    for (const key of this.windowOpenCount.keys()) if (key.startsWith(prefix)) this.windowOpenCount.delete(key);
    for (const key of this.windowClosesAtMs.keys()) if (key.startsWith(prefix)) this.windowClosesAtMs.delete(key);
    for (const key of this.lastWindowEmitAtMs.keys()) if (key.startsWith(prefix)) this.lastWindowEmitAtMs.delete(key);
    for (const key of this.finishedHands) if (key.startsWith(prefix)) this.finishedHands.delete(key);
    if (options.keepSettledHands === true) return;
    for (const key of this.settledHands) if (key.startsWith(prefix)) this.settledHands.delete(key);
  }

  private emitShoe(
    tableId: string,
    sequence: number,
    baseline: ShoeBaseline,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    const shoeId = `bg-${tableId}-${sequence}`;
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

  private replayHistoryRoad(
    tableId: string,
    table: BgTableSnapshot,
    observedAt: string,
    events: NormalizedEvent[],
  ): void {
    const hands = table.historyHands ?? [];
    const stickyLead = historyStickyBankerLead(hands);
    if (stickyLead) this.stickyBankerLeadByTable.set(tableId, stickyLead);
    const lastRound = typeof table.roundId === 'string' ? Number(table.roundId) : NaN;
    const startSeq = Number.isFinite(lastRound) ? lastRound - hands.length + 1 : 1;
    this.handsThisShoeByTable.set(tableId, 0);
    for (let index = 0; index < hands.length; index += 1) {
      const hand = hands[index]!;
      const handId = String(startSeq + index);
      const playerCards = parseCards(hand.playerCards);
      const bankerCards = parseCards(hand.bankerCards);
      this.handsThisShoeByTable.set(tableId, index + 1);
      this.lastRoundByTable.set(tableId, handId);
      const handKey = `${tableId}:${handId}`;
      if (this.settledHands.has(handKey)) continue;
      this.cardsByHand.set(handKey, { playerCards, bankerCards, source: 'protocol' });
      this.recordCards(tableId, handId, 'player', playerCards, observedAt, events);
      this.recordCards(tableId, handId, 'banker', bankerCards, observedAt, events);
      this.finishedHands.add(handKey);
      this.settleRememberedHand(tableId, handId, observedAt, events);
    }
    if (Number.isInteger(table.gameCount) && (table.gameCount ?? 0) >= 1) {
      this.lastGameCountByTable.set(tableId, Math.min(table.gameCount!, MAX_BACCARAT_SHOE_HANDS));
    }
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
    const stickyLead = position === 'banker' ? this.stickyBankerLeadByTable.get(tableId) : undefined;
    cards.slice(0, 3).forEach((card, index) => {
      if (stickyLead && index === 0 && (cardIdentity(card) === stickyLead || (card.raw ?? '').toUpperCase() === stickyLead)) {
        return;
      }
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
    const shoeId = this.shoeIdByTable.get(tableId) ?? '';
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
      let openCount = this.windowOpenCount.get(key) ?? 0;
      if (!alreadyOpen) {
        openCount += 1;
        this.windowOpenCount.set(key, openCount);
      }
      const base = `open:${shoeId}:${handId}:${market}`;
      const reopen = openCount > 1 ? `:reopen:${openCount - 1}` : '';
      const stableKey = alreadyOpen ? `${base}${reopen}:eta` : `${base}${reopen}`;
      events.push(this.makeEvent(tableId, 'bettingWindowOpened', stableKey, timestamp, {
        shoeId,
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
    const shoeId = this.shoeIdByTable.get(tableId) ?? '';
    for (const market of ['bankerPair', 'playerPair'] as const) {
      const key = `${tableId}:${handId}:${market}`;
      if (this.closedWindows.has(key)) continue;
      this.closedWindows.add(key);
      this.windowClosesAtMs.delete(key);
      const openCount = this.windowOpenCount.get(key) ?? 0;
      const reopen = openCount > 1 ? `:reopen:${openCount - 1}` : '';
      const unopened = openCount === 0 ? ':unopened' : '';
      events.push(this.makeEvent(tableId, 'bettingWindowClosed', `close:${shoeId}:${handId}:${market}${reopen}${unopened}`, timestamp, {
        shoeId,
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
    if (!cards) return;
    const stickyLead = this.stickyBankerLeadByTable.get(tableId);
    const bankerCards = stripMatchingBankerLead([...cards.bankerCards], stickyLead);
    const playerCards = cards.playerCards;
    if (playerCards.length < 2 || bankerCards.length < 2) return;
    if (!force && !isCompleteBaccaratHand(playerCards, bankerCards)) return;
    this.settledHands.add(handKey);
    events.push(this.makeEvent(tableId, 'handSettled', `settled:${handId}`, timestamp, {
      shoeId: this.shoeIdByTable.get(tableId) ?? '',
      handId,
      playerCards,
      bankerCards,
      outcomes: {
        playerPair: playerCards[0]!.rank === playerCards[1]!.rank,
        bankerPair: bankerCards[0]!.rank === bankerCards[1]!.rank,
      },
    }));
  }
}
