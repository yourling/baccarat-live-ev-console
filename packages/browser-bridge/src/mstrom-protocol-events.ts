import {
  EVENT_SCHEMA_VERSION,
  defaultProfile,
  type BettingMarket,
  type NormalizedEvent,
} from '@baccarat/contracts';
import type { MstromFrame as ParsedMstromFrame, MstromType2Frame } from './mstrom-protocol.js';
import { MstromShoeSessionRegistry, type MstromShoeSession } from './mstrom-shoe-session.js';

interface ProtocolTableState {
  sourceSeq: number;
  handId: string | undefined;
  readonly openedMarkets: Set<BettingMarket>;
  readonly closedMarkets: Set<BettingMarket>;
}

const PAIR_MARKETS: readonly BettingMarket[] = ['bankerPair', 'playerPair'];
const BACCARAT_GAME_TYPES = new Set(['BAC', 'LBAC', 'LBA', 'SHB']);
const GAME_SNAPSHOT_X16 = 0x1016;
const RESET_SHOECODE_X16 = 0x001c;
const SHUFFLE_GAME_STATUS = 11;

/** Converts verified mstrom protocol messages into normalized table events. */
export class MstromProtocolEventParser {
  private readonly tables = new Map<string, ProtocolTableState>();

  constructor(private readonly shoeSessions = new MstromShoeSessionRegistry()) {}

  ingest(frame: ParsedMstromFrame, capturedAt: string): NormalizedEvent[] {
    const state = this.tableState(frame.tableId);
    const events: NormalizedEvent[] = [];

    if (frame.kind === 'type2' && frame.x16 === RESET_SHOECODE_X16) {
      this.confirmPhysicalShoe(frame, state, `reset-shoecode:${frame.seq}`, capturedAt, events);
      return events;
    }
    if (!this.isBaccaratFrame(frame) || frame.kind === 'type3') return events;
    if (frame.x16 !== GAME_SNAPSHOT_X16 || frame.roundId === undefined) return events;

    const gameStatus = frame.gameStatus ?? frame.phase;
    if (gameStatus === SHUFFLE_GAME_STATUS) {
      this.confirmPhysicalShoe(
        frame,
        state,
        `game-snapshot:${frame.roundId}`,
        capturedAt,
        events,
      );
      return events;
    }
    if (gameStatus === 0 || gameStatus === 1 || gameStatus === 2) {
      this.shoeSessions.observeOrdinaryShoeActivity(frame.tableId);
    }

    if (state.handId !== frame.roundId) {
      state.handId = frame.roundId;
      state.openedMarkets.clear();
      state.closedMarkets.clear();
    }

    if (gameStatus === 1) {
      this.emitOpenEvents(frame, state, capturedAt, events);
    } else if (gameStatus === 2 || gameStatus === 0) {
      this.emitCloseEvents(frame, state, capturedAt, events);
    }
    return events;
  }

  private isBaccaratFrame(frame: ParsedMstromFrame): boolean {
    return frame.gameType !== undefined && BACCARAT_GAME_TYPES.has(frame.gameType);
  }

  private tableState(tableId: string): ProtocolTableState {
    const existing = this.tables.get(tableId);
    if (existing) return existing;
    const created: ProtocolTableState = {
      sourceSeq: 0,
      handId: undefined,
      openedMarkets: new Set(),
      closedMarkets: new Set(),
    };
    this.tables.set(tableId, created);
    return created;
  }

  private confirmPhysicalShoe(
    frame: MstromType2Frame,
    state: ProtocolTableState,
    boundaryId: string,
    capturedAt: string,
    events: NormalizedEvent[],
  ): void {
    const confirmation = this.shoeSessions.confirmVerifiedPhysicalShoe(frame.tableId, boundaryId);
    if (!confirmation.rotated) return;
    state.handId = undefined;
    state.openedMarkets.clear();
    state.closedMarkets.clear();
    events.push(this.newShoe(frame.tableId, state, confirmation.shoe, capturedAt));
  }

  private emitOpenEvents(
    frame: MstromType2Frame,
    state: ProtocolTableState,
    capturedAt: string,
    events: NormalizedEvent[],
  ): void {
    if (state.sourceSeq === 0) {
      events.push(this.newShoe(frame.tableId, state, this.shoeSessions.current(frame.tableId), capturedAt));
    }
    for (const market of PAIR_MARKETS) {
      if (state.openedMarkets.has(market)) continue;
      state.openedMarkets.add(market);
      events.push(this.marketEvent(frame, state, capturedAt, 'bettingWindowOpened', market));
    }
  }

  private emitCloseEvents(
    frame: MstromType2Frame,
    state: ProtocolTableState,
    capturedAt: string,
    events: NormalizedEvent[],
  ): void {
    for (const market of PAIR_MARKETS) {
      if (!state.openedMarkets.has(market) || state.closedMarkets.has(market)) continue;
      state.closedMarkets.add(market);
      events.push(this.marketEvent(frame, state, capturedAt, 'bettingWindowClosed', market));
    }
  }

  private newShoe(
    tableId: string,
    state: ProtocolTableState,
    shoe: MstromShoeSession,
    capturedAt: string,
  ): NormalizedEvent {
    return {
      type: 'newShoeSignal',
      eventId: `mstrom-session:${shoe.shoeId}:new-shoe`,
      tableId,
      timestamp: capturedAt,
      sourceSeq: this.nextSeq(state),
      source: 'mstrom-protocol',
      schemaVersion: EVENT_SCHEMA_VERSION,
      shoeId: shoe.shoeId,
      baseline: shoe.baseline,
      profile: { ...defaultProfile(tableId), autoConfirmNewShoe: true },
    };
  }

  private marketEvent(
    frame: MstromType2Frame,
    state: ProtocolTableState,
    capturedAt: string,
    type: 'bettingWindowOpened' | 'bettingWindowClosed',
    market: BettingMarket,
  ): NormalizedEvent {
    const shoe = this.shoeSessions.current(frame.tableId);
    return {
      type,
      eventId: `mstrom-window:${shoe.shoeId}:${type}:${state.handId}:${market}`,
      tableId: frame.tableId,
      timestamp: capturedAt,
      sourceSeq: this.nextSeq(state),
      source: 'mstrom-protocol',
      schemaVersion: EVENT_SCHEMA_VERSION,
      shoeId: shoe.shoeId,
      handId: state.handId ?? frame.roundId ?? '',
      market,
    };
  }

  private nextSeq(state: ProtocolTableState): number {
    state.sourceSeq += 1;
    return state.sourceSeq;
  }
}
