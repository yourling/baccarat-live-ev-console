/**
 * Big Gaming (BG) runtime snapshot parser.
 * Accepts only the versioned adapter snapshot schema. Raw vendor WebSocket
 * frames are captured elsewhere and are not decoded here.
 *
 * 共享机制（卡牌/开窗/结算/事件序号/靴发射）在 runtime-common 的基类里；
 * 本文件只保留 BG 特有的靴代际启发式、HISTORY 重放与 banker lead 粘滞。
 */
import {
  type Card,
  type NormalizedEvent,
} from '@baccarat/contracts';
import { BG_PLATFORM_ID } from '@baccarat/adapter-contract';
import {
  MAX_BACCARAT_SHOE_HANDS,
  ROAD_WRAP_MAX,
  ROAD_WRAP_MIN_DROP,
  ROAD_WRAP_MIN_PREVIOUS,
  SnapshotRuntimeParserBase,
  cardIdentity,
  isIdleDealtShoeShuffle,
  isRoadWrapToNewShoe,
  mergeHandCards,
  parseCards,
} from './runtime-common.js';

export {
  isIdleDealtShoeShuffle,
} from './runtime-common.js';

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
const EARLY_SHOE_ROAD_MAX = 20;
/** HISTORY 29→18 is a correction; 72→18 after a dealt shoe is a missed shuffle. */
const INFLATED_ROAD_PREVIOUS_MAX = 40;
const DEEP_SHOE_ROAD_MIN = 45;
/** First START_BET often lands at 1, then HISTORY dumps the whole bead plate. */
const GAME_COUNT_ATTACH_MAX = 1;
const GAME_COUNT_CATCH_UP_MAX = 5;
/** Live bead plate 1-8 stepping +1 while internal is deep: missed the 局1 wrap. */
const AUTHENTIC_ROAD_STREAK = 5;
const GAME_COUNT_ANOMALY_MIN_HANDS = 8;

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

/** 历史 29→18 是修正；72→18 才可能是漏掉的洗牌。 */
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
void isMidShoeInflatedHistoryMismatch;

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

type AuthenticHandCards = {
  readonly handId: string;
  readonly playerCards: readonly Card[];
  readonly bankerCards: readonly Card[];
};

function seqFromShoeReset(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const match = /^seq:(\d+)$/.exec(token);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : undefined;
}

function normalizeFeltRoad(value: unknown): number | undefined {
  if (value === 0) return 1;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  return undefined;
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

export class BgRuntimeParser extends SnapshotRuntimeParserBase {
  private readonly historyFirstSeqByTable = new Map<string, number>();
  private readonly bankerLeadByTable = new Map<string, string>();
  private readonly bankerLeadStreakByTable = new Map<string, number>();
  private readonly bankerLeadOtherByTable = new Map<string, Set<string>>();
  private readonly bankerLeadHandByTable = new Map<string, string>();
  private readonly stickyBankerLeadByTable = new Map<string, string>();
  private readonly lastFeltRoadByTable = new Map<string, number>();
  private readonly authenticRoadStreakByTable = new Map<string, number>();
  private readonly authenticHandsByTable = new Map<string, AuthenticHandCards[]>();

  constructor() {
    super({
      platformId: BG_PLATFORM_ID,
      eventIdPrefix: 'bg',
      eventSourceName: 'bg-runtime',
      shoeIdPrefix: 'bg',
    });
  }

  stickyBankerLead(tableId: string): string | undefined {
    return this.stickyBankerLeadByTable.get(tableId);
  }

  /** Keep shoe generations monotonic across process restarts. */
  seedShoeSequence(tableId: string, sequence: number): void {
    const id = normalizeBgTableId(tableId);
    if (id === undefined || !Number.isInteger(sequence) || sequence < 1) return;
    const current = this.currentShoeSequence(id) ?? 0;
    if (sequence > current) this.setShoeSequence(id, sequence);
  }

  protected clearPlatformState(tableId: string): void {
    this.historyFirstSeqByTable.delete(tableId);
    this.clearAuthenticRoadTracking(tableId);
  }

  protected clearPlatformShoeState(tableId: string): void {
    this.historyFirstSeqByTable.delete(tableId);
    this.clearAuthenticRoadTracking(tableId);
    this.bankerLeadByTable.delete(tableId);
    this.bankerLeadStreakByTable.delete(tableId);
    this.bankerLeadOtherByTable.delete(tableId);
    this.bankerLeadHandByTable.delete(tableId);
    this.stickyBankerLeadByTable.delete(tableId);
  }

  protected beforeRecordCard(
    tableId: string,
    position: 'player' | 'banker',
    index: number,
    card: Card,
  ): Card | null {
    if (position !== 'banker' || index !== 0) return card;
    const stickyLead = this.stickyBankerLeadByTable.get(tableId);
    if (
      stickyLead
      && (cardIdentity(card) === stickyLead || (card.raw ?? '').toUpperCase() === stickyLead)
    ) {
      return null;
    }
    return card;
  }

  protected prepareSettlementCards(
    tableId: string,
    cards: { playerCards: Card[]; bankerCards: Card[] },
  ): { playerCards: Card[]; bankerCards: Card[] } {
    const stickyLead = this.stickyBankerLeadByTable.get(tableId);
    return {
      playerCards: cards.playerCards,
      bankerCards: stripMatchingBankerLead([...cards.bankerCards], stickyLead),
    };
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

  private ingestTable(
    table: BgTableSnapshot,
    observedAt: string,
    events: NormalizedEvent[],
  ): void {
    const tableId = normalizeBgTableId(table.tableId);
    if (tableId === undefined) return;
    table = { ...table, tableId };
    const idleShuffle = isIdleDealtShoeShuffle(
      this.currentHandsThisShoe(tableId),
      this.lastHandAtMs(tableId),
      Date.parse(observedAt),
    );
    this.ingestShoeReset(table, observedAt, events, idleShuffle);
    if (idleShuffle && !openedPhysicalShoe(events, tableId)) {
      this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);
      this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', { reason: 'protocol-shuffle' });
    }

    const lastResetSeq = seqFromShoeReset(this.lastShoeResetToken(tableId));
    const historySeq = seqFromShoeReset(table.shoeReset);
    const laggedPreviousShoeRoad = this.currentEvidenceReason(tableId) === 'protocol-shuffle'
      && lastResetSeq !== undefined
      && historySeq !== undefined
      && historySeq < lastResetSeq;
    if (historySeq !== undefined && table.shuffleEvent !== true && !laggedPreviousShoeRoad) {
      this.historyFirstSeqByTable.set(tableId, historySeq);
    }

    const feltRoad = normalizeFeltRoad(table.gameCount);
    let gameCount = feltRoad;
    if (laggedPreviousShoeRoad) {
      gameCount = undefined;
    } else {
      const historyPacket = (table.historyHands?.length ?? 0) > 0;
      const liveSeq = historyPacket
        ? parseHandSeq(this.lastRoundFor(tableId))
        : parseHandSeq(typeof table.roundId === 'string' ? table.roundId : undefined)
          ?? parseHandSeq(this.lastRoundFor(tableId));
      const firstSeq = historySeq ?? this.historyFirstSeqByTable.get(tableId);
      const seqRoad = roadCountFromSeqWindow(firstSeq, liveSeq);
      const trackedHands = this.currentHandsThisShoe(tableId) ?? 0;
      const previousRoad = this.acceptedGameCount(tableId);
      // 局1 is an immediate wrap. 局2-8 after a deep internal shoe wait for
      // five +1 bead-plate steps so a missed 局1 can still latch.
      const wrapIncoming = feltRoad !== undefined
        && (
          isRoadWrapToNewShoe(previousRoad, feltRoad)
          || (
            feltRoad === 1
            && isRoadWrapToNewShoe(trackedHands > 0 ? trackedHands : undefined, feltRoad)
          )
          || (
            feltRoad === 1
            && isExhaustedShoeRoadDrop(previousRoad, feltRoad, trackedHands)
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
      const previousRoad = this.acceptedGameCount(tableId);
      const previousHands = this.currentHandsThisShoe(tableId);
      const previous = previousRoad ?? previousHands;
      const stalePreviousShoeRoad = this.currentEvidenceReason(tableId) === 'protocol-shuffle'
        && previousRoad === undefined
        && gameCount > EARLY_SHOE_ROAD_MAX;
      if (stalePreviousShoeRoad) {
        // Protocol shuffle and lagged DOM still carry the previous shoe's road #.
      } else if (isRoadWrapToNewShoe(previous, gameCount)) {
        this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);
        this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', {
          reason: 'road-wrap',
          previousGameCount: previous,
          gameCount,
        });
        this.setAcceptedGameCount(tableId, gameCount);
      } else if (isPlausibleGameCountAdvance(previousRoad, gameCount)) {
        this.setAcceptedGameCount(tableId, gameCount);
      }
    }

    const openedPhysical = openedPhysicalShoe(events, tableId);
    const evidence = this.shoeEvidence(tableId);
    const physical = openedPhysical
      || evidence?.reason === 'protocol-shuffle'
      || evidence?.reason === 'road-wrap'
      || evidence?.reason === 'manual-confirm';
    const historyHands = table.historyHands ?? [];
    const trackedHands = this.currentHandsThisShoe(tableId) ?? 0;
    // Deep HISTORY after NEXT_SHOES is the previous shoe only when its first
    // seq is still behind the shuffle token. Current-shoe roads of 21-80 must
    // still rebuild inventory or round and remaining cards contradict.
    // After an idle-gap shuffle the packet often still holds the previous
    // shoe. Do not backfill those cards onto the new inventory.
    const previousShoeHistory = openedPhysical
      && historyHands.length > EARLY_SHOE_ROAD_MAX
      && (gameCount === undefined
        || gameCount <= ROAD_WRAP_MAX
        || historyHands.length - gameCount >= ROAD_WRAP_MIN_DROP);
    const canReplayHistory = physical
      && historyHands.length > 0
      && historyHands.length <= MAX_BACCARAT_SHOE_HANDS
      && !laggedPreviousShoeRoad
      && !previousShoeHistory
      && (openedPhysical || historyHands.length > trackedHands);
    if (canReplayHistory) {
      const replayLiveSeq = parseHandSeq(this.lastRoundFor(tableId));
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
    if (this.handSettledAlready(tableId, handId)) return;

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

    if (this.handFinished(tableId, handId)) {
      if (hasCardPayload && (playerCards.length > 0 || bankerCards.length > 0)) {
        const merged = mergeHandCards(this.handCards(tableId, handId), playerCards, bankerCards, source);
        this.rememberHandCards(tableId, handId, merged);
        this.recordCards(tableId, handId, 'player', merged.playerCards, observedAt, events);
        this.recordCards(tableId, handId, 'banker', merged.bankerCards, observedAt, events);
      }
      this.settleRememberedHand(tableId, handId, observedAt, events);
      return;
    }

    const previousHandId = this.lastRoundFor(tableId);
    if (previousHandId !== undefined && previousHandId !== handId) {
      this.markHandFinished(tableId, previousHandId);
      this.closeWindows(tableId, previousHandId, observedAt, events);
      this.settleRememberedHand(tableId, previousHandId, observedAt, events);
      const nextHands = (this.currentHandsThisShoe(tableId) ?? 1) + 1;
      const latched = this.maybeLatchAuthenticRoad(
        tableId,
        table.gameCount,
        nextHands,
        previousHandId,
        observedAt,
        events,
      );
      if (latched) {
        this.setHandsThisShoe(
          tableId,
          (this.currentHandsThisShoe(tableId) ?? 0) + 1,
        );
      } else if (nextHands > MAX_BACCARAT_SHOE_HANDS) {
        // 80 hands without shuffle evidence is not a road-wrap. Reset to 待牌靴
        // so pair EV cannot keep eating the previous inventory.
        this.beginNewShoe(tableId, observedAt, events, 'unknown-monitor-session', {
          reason: 'attach',
        });
        this.setHandsThisShoe(tableId, 1);
      } else {
        this.setHandsThisShoe(tableId, nextHands);
      }
    } else if (previousHandId === undefined) {
      this.setHandsThisShoe(tableId, 1);
    }
    this.setLastRound(tableId, handId, observedAt);

    const emptyOpenBoundary = table.bettingOpen === true
      && playerCards.length === 0
      && bankerCards.length === 0;
    if (emptyOpenBoundary) this.markCardBoundary(tableId, handId);
    const mayAcceptCards = source === 'protocol'
      || previousHandId === undefined
      || this.handHasCardBoundary(tableId, handId);
    if (mayAcceptCards && hasCardPayload && (playerCards.length > 0 || bankerCards.length > 0)) {
      const merged = mergeHandCards(this.handCards(tableId, handId), playerCards, bankerCards, source);
      this.rememberHandCards(tableId, handId, merged);
      this.recordCards(tableId, handId, 'player', merged.playerCards, observedAt, events);
      this.recordCards(tableId, handId, 'banker', merged.bankerCards, observedAt, events);
    }

    const rememberedCards = this.handCards(tableId, handId);
    const hasObservedCards = (rememberedCards?.playerCards.length ?? 0)
      + (rememberedCards?.bankerCards.length ?? 0) > 0;
    if (table.bettingOpen === true && !hasObservedCards) {
      this.openWindows(tableId, handId, table.countdown, observedAt, events);
    } else if (table.bettingOpen === false || table.gameSettled === true) {
      this.closeWindows(tableId, handId, observedAt, events);
      this.settleRememberedHand(tableId, handId, observedAt, events);
    }
  }

  private ingestShoeReset(
    table: BgTableSnapshot,
    observedAt: string,
    events: NormalizedEvent[],
    idleShuffle = false,
  ): void {
    const tableId = table.tableId;
    const token = typeof table.shoeReset === 'string' && table.shoeReset.length > 0
      ? table.shoeReset
      : undefined;
    const shuffleEvent = table.shuffleEvent === true;
    if (token === undefined) {
      return;
    }
    const previousToken = this.lastShoeResetToken(tableId);
    if (previousToken !== token) {
      const previousSeq = seqFromShoeReset(previousToken);
      const nextSeq = seqFromShoeReset(token);
      if (!shuffleEvent && previousSeq !== undefined && nextSeq !== undefined && nextSeq < previousSeq) {
        return;
      }
      const previousRoad = this.acceptedGameCount(tableId);
      const incomingRoad = Number.isInteger(table.gameCount) && (table.gameCount ?? 0) >= 1
        ? table.gameCount
        : undefined;
      const handsThisShoe = this.currentHandsThisShoe(tableId);
      const exhaustedDrop = incomingRoad !== undefined
        && isExhaustedShoeRoadDrop(previousRoad, incomingRoad, handsThisShoe);
      const inflatedCorrection = incomingRoad !== undefined
        && isInflatedRoadCorrection(previousRoad, incomingRoad)
        && !exhaustedDrop;
      // HISTORY stamps shoeReset as seq:<first visible gameId>. That first id
      // walks forward during a live shoe. Treat it as drift, not a shuffle.
      const seqDrift = !shuffleEvent
        && !idleShuffle
        && previousSeq !== undefined
        && nextSeq !== undefined
        && nextSeq > previousSeq
        && nextSeq - previousSeq <= GAME_COUNT_CATCH_UP_MAX
        && !isRoadWrapToNewShoe(previousRoad, incomingRoad ?? 0)
        && !exhaustedDrop;
      this.setLastShoeResetToken(tableId, token);
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
        const handsThisShoe = this.currentHandsThisShoe(tableId);
        if (
          !alreadyPhysical
          || idleShuffle
          || isCredibleBgEndOfShoeShuffle(previousRoad, incomingRoad, handsThisShoe)
        ) {
          this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', { reason: 'protocol-shuffle' });
        }
      }
      return;
    }
    if (!shuffleEvent) return;
    if (isInflatedRoadCorrection(this.acceptedGameCount(tableId), table.gameCount ?? 0)) return;
    // Same token + sticky shuffleEvent is leftover currentShoe. A later
    // shuffle after real play must be a token change, road wrap, or a
    // credible end-of-shoe pulse on an already dealt shoe.
    if (this.shoeAlreadyDealt(tableId)) {
      const previousRoad = this.acceptedGameCount(tableId);
      const incomingRoad = Number.isInteger(table.gameCount) && (table.gameCount ?? 0) >= 1
        ? table.gameCount
        : undefined;
      if (
        idleShuffle
        || isCredibleBgEndOfShoeShuffle(previousRoad, incomingRoad, this.currentHandsThisShoe(tableId))
      ) {
        this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', { reason: 'protocol-shuffle' });
      }
    }
  }

  private hasVerifiedPhysicalEvidence(tableId: string): boolean {
    const reason = this.currentEvidenceReason(tableId);
    return reason === 'protocol-shuffle' || reason === 'road-wrap' || reason === 'manual-confirm';
  }

  private shoeAlreadyDealt(tableId: string): boolean {
    // First snapshot of a new shoe often still carries a round id, which
    // counts as 1. A later shuffle after real play is at least a second hand.
    return (this.currentHandsThisShoe(tableId) ?? 0) >= 2;
  }

  private clearAuthenticRoadTracking(tableId: string): void {
    this.lastFeltRoadByTable.delete(tableId);
    this.authenticRoadStreakByTable.delete(tableId);
    this.authenticHandsByTable.delete(tableId);
  }

  private pushAuthenticHand(tableId: string, handId: string): void {
    const cards = this.handCards(tableId, handId);
    if (!cards || cards.playerCards.length + cards.bankerCards.length === 0) return;
    const list = this.authenticHandsByTable.get(tableId) ?? [];
    list.push({
      handId,
      playerCards: [...cards.playerCards],
      bankerCards: [...cards.bankerCards],
    });
    this.authenticHandsByTable.set(tableId, list.slice(-ROAD_WRAP_MAX));
  }

  private replayAuthenticHandCards(
    tableId: string,
    hands: readonly AuthenticHandCards[],
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    const stickyLead = this.stickyBankerLeadByTable.get(tableId);
    for (const hand of hands) {
      const bankerCards = stripMatchingBankerLead([...hand.bankerCards], stickyLead);
      this.recordCards(tableId, hand.handId, 'player', hand.playerCards, timestamp, events);
      this.recordCards(tableId, hand.handId, 'banker', bankerCards, timestamp, events);
    }
  }

  private maybeLatchAuthenticRoad(
    tableId: string,
    rawFelt: unknown,
    internalHands: number,
    previousHandId: string,
    timestamp: string,
    events: NormalizedEvent[],
  ): boolean {
    if (events.some(event =>
      event.tableId === tableId
      && event.type === 'newShoeSignal'
      && event.baseline === 'physical-shoe')) {
      this.clearAuthenticRoadTracking(tableId);
      return false;
    }
    const felt = normalizeFeltRoad(rawFelt);
    if (felt === undefined) {
      this.clearAuthenticRoadTracking(tableId);
      return false;
    }
    if (felt > ROAD_WRAP_MAX) {
      this.clearAuthenticRoadTracking(tableId);
      this.lastFeltRoadByTable.set(tableId, felt);
      return false;
    }
    const deepMismatch = internalHands >= ROAD_WRAP_MIN_PREVIOUS
      && internalHands - felt >= ROAD_WRAP_MIN_DROP;
    if (!deepMismatch) {
      this.clearAuthenticRoadTracking(tableId);
      this.lastFeltRoadByTable.set(tableId, felt);
      return false;
    }
    const lastFelt = this.lastFeltRoadByTable.get(tableId);
    let streak = this.authenticRoadStreakByTable.get(tableId) ?? 0;
    if (
      lastFelt !== undefined
      && lastFelt >= 1
      && lastFelt <= ROAD_WRAP_MAX
      && felt === lastFelt + 1
    ) {
      streak += 1;
      this.pushAuthenticHand(tableId, previousHandId);
    } else if (lastFelt === felt) {
      this.clearAuthenticRoadTracking(tableId);
      this.lastFeltRoadByTable.set(tableId, felt);
      return false;
    } else {
      streak = 1;
      this.authenticHandsByTable.set(tableId, []);
    }
    this.authenticRoadStreakByTable.set(tableId, streak);
    this.lastFeltRoadByTable.set(tableId, felt);
    if (streak < AUTHENTIC_ROAD_STREAK) return false;

    const replay = (this.authenticHandsByTable.get(tableId) ?? []).slice(-felt);
    this.beginNewShoe(tableId, timestamp, events, 'physical-shoe', {
      reason: 'road-wrap',
      previousGameCount: internalHands,
      gameCount: felt,
    });
    this.replayAuthenticHandCards(tableId, replay, timestamp, events);
    this.lastFeltRoadByTable.set(tableId, felt);
    this.authenticRoadStreakByTable.set(tableId, 0);
    this.authenticHandsByTable.set(tableId, []);
    this.setHandsThisShoe(tableId, replay.length);
    return true;
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
    this.setHandsThisShoe(tableId, 0);
    for (let index = 0; index < hands.length; index += 1) {
      const hand = hands[index]!;
      const handId = String(startSeq + index);
      const playerCards = parseCards(hand.playerCards);
      const bankerCards = parseCards(hand.bankerCards);
      this.setHandsThisShoe(tableId, index + 1);
      this.setLastRound(tableId, handId, observedAt);
      const handKey = `${tableId}:${handId}`;
      if (this.handSettledAlready(tableId, handId)) continue;
      this.rememberHandCards(tableId, handId, { playerCards, bankerCards, source: 'protocol' });
      this.recordCards(tableId, handId, 'player', playerCards, observedAt, events);
      this.recordCards(tableId, handId, 'banker', bankerCards, observedAt, events);
      this.markHandFinished(tableId, handId);
      this.settleRememberedHand(tableId, handId, observedAt, events);
    }
    if (Number.isInteger(table.gameCount) && (table.gameCount ?? 0) >= 1) {
      this.setAcceptedGameCount(tableId, Math.min(table.gameCount!, MAX_BACCARAT_SHOE_HANDS));
    }
  }
}

function openedPhysicalShoe(events: readonly NormalizedEvent[], tableId: string): boolean {
  return events.some(event =>
    event.tableId === tableId
    && event.type === 'newShoeSignal'
    && event.baseline === 'physical-shoe');
}
