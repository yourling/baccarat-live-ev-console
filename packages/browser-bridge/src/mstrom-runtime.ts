import { EVENT_SCHEMA_VERSION, defaultProfile } from '@baccarat/contracts';
import type {
  BettingMarket,
  Card,
  CardObservedEvent,
  CardRank,
  HandSettledEvent,
  NewShoeSignalEvent,
  NormalizedEvent,
} from '@baccarat/contracts';
import { MstromShoeSessionRegistry, type MstromShoeSession } from './mstrom-shoe-session.js';

export interface MstromRuntimeSnapshot {
  readonly tableId: string;
  readonly roundId: string;
  readonly gameType?: string | null;
  readonly gmstatus: number | null;
  readonly playerScore: number | null;
  readonly bankerScore: number | null;
  readonly playerCards: readonly number[];
  readonly bankerCards: readonly number[];
  readonly capturedAt: string;
}

interface RoundState {
  readonly roundId: string;
  readonly playerBytes: Array<number | undefined>;
  readonly bankerBytes: Array<number | undefined>;
  readonly openedMarkets: Set<BettingMarket>;
  readonly closedMarkets: Set<BettingMarket>;
  settlementScores: { readonly player: number; readonly banker: number } | undefined;
  settled: boolean;
}

interface TableState {
  shoeId: string;
  sourceSeq: number;
  currentRound: RoundState | undefined;
}

const RANKS: readonly CardRank[] = [
  'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K',
];
const PAIR_MARKETS: readonly BettingMarket[] = ['bankerPair', 'playerPair'];

export function decodeMstromCardByte(value: number): Card | null {
  if (!Number.isInteger(value) || value < 0 || value > 0xff || (value & 0xc0) !== 0) return null;
  const rank = RANKS[(value & 0x0f) - 1];
  if (rank === undefined) return null;
  const raw = `0x${value.toString(16).padStart(2, '0')}`;
  switch (value & 0x30) {
    case 0x00: return { rank, suit: 'C', raw };
    case 0x10: return { rank, suit: 'D', raw };
    case 0x20: return { rank, suit: 'S', raw };
    case 0x30: return { rank, suit: 'H', raw };
    default: return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cardList(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length > 3) return undefined;
  const cards: number[] = [];
  for (const card of value) {
    if (typeof card !== 'number' || decodeMstromCardByte(card) === null) return undefined;
    cards.push(card);
  }
  return cards;
}

function readSnapshot(input: unknown): MstromRuntimeSnapshot | undefined {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
  if (!isRecord(value)) return undefined;
  const gameType = typeof value.gameType === 'string' ? value.gameType : null;
  if (gameType !== null && gameType !== 'BAC' && gameType !== 'LBAC') return undefined;
  const playerCards = cardList(value.playerCards);
  const bankerCards = cardList(value.bankerCards);
  if (
    typeof value.tableId !== 'string' || !value.tableId ||
    typeof value.roundId !== 'string' || !value.roundId ||
    typeof value.capturedAt !== 'string' || !value.capturedAt ||
    playerCards === undefined || bankerCards === undefined
  ) return undefined;
  return {
    tableId: value.tableId,
    roundId: value.roundId,
    gameType,
    gmstatus: numberOrNull(value.gmstatus),
    playerScore: numberOrNull(value.playerScore),
    bankerScore: numberOrNull(value.bankerScore),
    playerCards,
    bankerCards,
    capturedAt: value.capturedAt,
  };
}

function baccaratScore(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 0 && value <= 9;
}

function slotsCompatible(values: readonly number[], observed: readonly (number | undefined)[]): boolean {
  return values.every((value, index) => observed[index] === undefined || observed[index] === value);
}

function decodeSlots(slots: readonly (number | undefined)[]): Card[] | undefined {
  if (slots.length < 2 || slots.some((slot) => slot === undefined)) return undefined;
  const cards: Card[] = [];
  for (const slot of slots) {
    if (slot === undefined) return undefined;
    const card = decodeMstromCardByte(slot);
    if (card === null) return undefined;
    cards.push(card);
  }
  return cards;
}

function cardPoint(card: Card): number {
  if (card.rank === 'A') return 1;
  if (card.rank === '10' || card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 0;
  return Number(card.rank);
}

function handScore(cards: readonly Card[]): number {
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

function isCompleteBaccaratHand(playerCards: readonly Card[], bankerCards: readonly Card[]): boolean {
  if (playerCards.length < 2 || playerCards.length > 3 || bankerCards.length < 2 || bankerCards.length > 3) return false;
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

function windowEventType(gmstatus: number | null): 'bettingWindowOpened' | 'bettingWindowClosed' | undefined {
  if (gmstatus === 1) return 'bettingWindowOpened';
  if (gmstatus === 0 || gmstatus === 2) return 'bettingWindowClosed';
  return undefined;
}

export class MstromRuntimeParser {
  private readonly tables = new Map<string, TableState>();

  constructor(private readonly shoeSessions = new MstromShoeSessionRegistry()) {}

  parse(input: unknown): NormalizedEvent[] {
    const snapshot = readSnapshot(input);
    if (snapshot === undefined || snapshot.gmstatus === -1) return [];
    if (snapshot.gmstatus === 11) return this.confirmPhysicalShoe(snapshot);
    if (snapshot.gmstatus === 0 || snapshot.gmstatus === 1 || snapshot.gmstatus === 2) {
      this.shoeSessions.observeOrdinaryShoeActivity(snapshot.tableId);
    }

    const events: NormalizedEvent[] = [];
    const table = this.tables.get(snapshot.tableId) ?? this.createTable(snapshot, events);
    const shoe = this.shoeSessions.current(snapshot.tableId);
    if (table.shoeId !== shoe.shoeId) {
      table.shoeId = shoe.shoeId;
      table.currentRound = undefined;
      events.push(this.newShoe(snapshot, table, shoe));
    }
    let round = table.currentRound;
    if (round?.roundId !== snapshot.roundId) {
      round = {
        roundId: snapshot.roundId,
        playerBytes: [],
        bankerBytes: [],
        openedMarkets: new Set(),
        closedMarkets: new Set(),
        settlementScores: undefined,
        settled: false,
      };
      table.currentRound = round;
    }

    if (
      !slotsCompatible(snapshot.playerCards, round.playerBytes)
      || !slotsCompatible(snapshot.bankerCards, round.bankerBytes)
    ) return events;

    this.emitWindowEvents(snapshot, table, events);
    this.observe(snapshot, table, round, 'player', snapshot.playerCards, round.playerBytes, events);
    this.observe(snapshot, table, round, 'banker', snapshot.bankerCards, round.bankerBytes, events);

    if (snapshot.gmstatus === 0 && baccaratScore(snapshot.playerScore) && baccaratScore(snapshot.bankerScore)) {
      round.settlementScores = { player: snapshot.playerScore, banker: snapshot.bankerScore };
    }
    if (!round.settled && round.settlementScores !== undefined) {
      const playerCards = decodeSlots(round.playerBytes);
      const bankerCards = decodeSlots(round.bankerBytes);
      if (
        playerCards !== undefined
        && bankerCards !== undefined
        && isCompleteBaccaratHand(playerCards, bankerCards)
        && handScore(playerCards) === round.settlementScores.player
        && handScore(bankerCards) === round.settlementScores.banker
      ) {
        round.settled = true;
        events.push(this.settlement(snapshot, table, round, playerCards, bankerCards));
      }
    }
    return events;
  }

  private emitWindowEvents(
    snapshot: MstromRuntimeSnapshot,
    table: TableState,
    events: NormalizedEvent[],
  ): void {
    const type = windowEventType(snapshot.gmstatus);
    const round = table.currentRound;
    if (type === undefined || round === undefined) return;
    for (const market of PAIR_MARKETS) {
      if (type === 'bettingWindowOpened') {
        if (round.openedMarkets.has(market) || round.closedMarkets.has(market)) continue;
        round.openedMarkets.add(market);
        events.push({
          type,
          eventId: `mstrom-window:${table.shoeId}:${type}:${round.roundId}:${market}`,
          tableId: snapshot.tableId,
          timestamp: snapshot.capturedAt,
          sourceSeq: this.nextSourceSeq(table),
          source: 'mstrom-runtime',
          schemaVersion: EVENT_SCHEMA_VERSION,
          shoeId: table.shoeId,
          handId: round.roundId,
          market,
        });
        continue;
      }
      const openingObserved = round.openedMarkets.has(market);
      if (!openingObserved && snapshot.gmstatus !== 2) continue;
      if (round.closedMarkets.has(market)) continue;
      round.closedMarkets.add(market);
      events.push({
        type,
        eventId: `mstrom-window:${table.shoeId}:${type}:${round.roundId}:${market}`,
        tableId: snapshot.tableId,
        timestamp: snapshot.capturedAt,
        sourceSeq: this.nextSourceSeq(table),
        source: 'mstrom-runtime',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId: table.shoeId,
        handId: round.roundId,
        market,
        openingObserved,
      });
    }
  }

  ingest(input: unknown): NormalizedEvent[] {
    return this.parse(input);
  }

  private confirmPhysicalShoe(snapshot: MstromRuntimeSnapshot): NormalizedEvent[] {
    const confirmation = this.shoeSessions.confirmVerifiedPhysicalShoe(
      snapshot.tableId,
      `game-snapshot:${snapshot.roundId}`,
    );
    const existing = this.tables.get(snapshot.tableId);
    const table = existing ?? {
      shoeId: confirmation.shoe.shoeId,
      sourceSeq: 0,
      currentRound: undefined,
    };
    table.shoeId = confirmation.shoe.shoeId;
    table.currentRound = undefined;
    if (existing === undefined) this.tables.set(snapshot.tableId, table);
    return confirmation.rotated ? [this.newShoe(snapshot, table, confirmation.shoe)] : [];
  }

  private createTable(snapshot: MstromRuntimeSnapshot, events: NormalizedEvent[]): TableState {
    const shoe = this.shoeSessions.current(snapshot.tableId);
    const table: TableState = { shoeId: shoe.shoeId, sourceSeq: 0, currentRound: undefined };
    this.tables.set(snapshot.tableId, table);
    events.push(this.newShoe(snapshot, table, shoe));
    return table;
  }

  private observe(
    snapshot: MstromRuntimeSnapshot,
    table: TableState,
    round: RoundState,
    side: 'player' | 'banker',
    values: readonly number[],
    observed: Array<number | undefined>,
    events: NormalizedEvent[],
  ): void {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value === undefined || observed[index] !== undefined) continue;
      const card = decodeMstromCardByte(value);
      if (card === null) continue;
      observed[index] = value;
      const event: CardObservedEvent = {
        type: 'cardObserved',
        eventId: `mstrom-runtime:${table.shoeId}:card:${round.roundId}:${side}:${index}:${value.toString(16)}`,
        tableId: snapshot.tableId,
        timestamp: snapshot.capturedAt,
        sourceSeq: this.nextSourceSeq(table),
        source: 'mstrom-runtime',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId: table.shoeId,
        handId: round.roundId,
        card,
        position: `${side}:${index}`,
      };
      events.push(event);
    }
  }

  private newShoe(
    snapshot: MstromRuntimeSnapshot,
    table: TableState,
    shoe: MstromShoeSession,
  ): NewShoeSignalEvent {
    return {
      type: 'newShoeSignal',
      eventId: `mstrom-session:${shoe.shoeId}:new-shoe`,
      tableId: snapshot.tableId,
      timestamp: snapshot.capturedAt,
      sourceSeq: this.nextSourceSeq(table),
      source: 'mstrom-runtime',
      schemaVersion: EVENT_SCHEMA_VERSION,
      shoeId: shoe.shoeId,
      baseline: shoe.baseline,
      profile: { ...defaultProfile(snapshot.tableId), autoConfirmNewShoe: true },
    };
  }

  private settlement(
    snapshot: MstromRuntimeSnapshot,
    table: TableState,
    round: RoundState,
    playerCards: Card[],
    bankerCards: Card[],
  ): HandSettledEvent {
    return {
      type: 'handSettled',
      eventId: `mstrom-runtime:${table.shoeId}:settled:${round.roundId}`,
      tableId: snapshot.tableId,
      timestamp: snapshot.capturedAt,
      sourceSeq: this.nextSourceSeq(table),
      source: 'mstrom-runtime',
      schemaVersion: EVENT_SCHEMA_VERSION,
      shoeId: table.shoeId,
      handId: round.roundId,
      playerCards,
      bankerCards,
      outcomes: {
        playerPair: playerCards[0]?.rank === playerCards[1]?.rank,
        bankerPair: bankerCards[0]?.rank === bankerCards[1]?.rank,
      },
    };
  }

  private nextSourceSeq(table: TableState): number {
    table.sourceSeq += 1;
    return table.sourceSeq;
  }
}
