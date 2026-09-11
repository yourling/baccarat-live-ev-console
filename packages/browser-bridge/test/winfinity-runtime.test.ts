import { describe, expect, it } from 'vitest';
import {
  WinfinityRuntimeParser,
  collapseWinfinityDuplicateTableIds,
  normalizeWinfinityTableId,
  parseWinfinityTableLabel,
  publicWinfinityTableId,
  selectWinfinityRoadCount,
  winfinityDisplayNameFromText,
} from '../src/winfinity-runtime.js';

const VENDOR = '638f56dc65729f90d0636fb0';
const SHOE_A = 'a6b0945d-1111-4111-8111-aaaaaaaaaaaa';
const SHOE_B = 'b8d70a5b-2222-4222-8222-bbbbbbbbbbbb';
const HAND_1 = '01a08226-087c-72ff-8e0e-a5cd185abc0e';

function wsFrame(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt-1',
    timestamp: '1788889925756',
    type,
    meta: {
      tableId: VENDOR,
      dealerNickName: 'x',
      round: { id: HAND_1, startedAt: '1788889925756', shoeId: SHOE_A },
    },
    ...extra,
  });
}

describe('Winfinity table ids', () => {
  it('uses lowercase stream id when present', () => {
    expect(publicWinfinityTableId({
      streamId: 'TYN-BAC8',
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).toBe('tyn-bac8');
  });

  it('falls back to wnf- prefix and never emits a bare 24-hex id', () => {
    expect(publicWinfinityTableId({
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).toBe('wnf-638f56dc65729f90d0636fb0');
    expect(publicWinfinityTableId({
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).not.toMatch(/^[a-f0-9]{24}$/i);
  });

  it('rejects pragmatic-shaped and bg-shaped ids', () => {
    expect(publicWinfinityTableId({ streamId: 'pragmatictable01' })).toBeUndefined();
    expect(publicWinfinityTableId({ vendorTableId: 'B06' })).toBeUndefined();
    expect(normalizeWinfinityTableId('tyn-bac8')).toBe('tyn-bac8');
    expect(normalizeWinfinityTableId('wnf-638f56dc65729f90d0636fb0')).toBe('wnf-638f56dc65729f90d0636fb0');
    expect(normalizeWinfinityTableId('638f56dc65729f90d0636fb0')).toBeUndefined();
  });

  it('does not lock the wnf fallback on first resolveTableId', () => {
    const parser = new WinfinityRuntimeParser();
    expect(parser.resolveTableId(VENDOR)).toBe(`wnf-${VENDOR}`);
    expect(parser.hasLockedPublicId(VENDOR)).toBe(false);
    expect(parser.peekPublicId(VENDOR)).toBeUndefined();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    expect(parser.resolveTableId(VENDOR)).toBe('tyn-bac8');
    expect(parser.peekPublicId(VENDOR)).toBe('tyn-bac8');
  });

  it('uses stream id when the alias is registered before first resolve', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'TYN-BAC8');
    expect(parser.resolveTableId(VENDOR)).toBe('tyn-bac8');
    expect(parser.hasLockedPublicId(VENDOR)).toBe(true);
  });

  it('lets registerAlias lock a short id after parseFrame without discovery', () => {
    const parser = new WinfinityRuntimeParser();
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(parser.hasLockedPublicId(VENDOR)).toBe(false);
    expect(parser.shoeEvidence(`wnf-${VENDOR}`)).toEqual({ reason: 'attach' });
    parser.registerAlias(VENDOR, 'tyn-bac8');
    expect(parser.resolveTableId(VENDOR)).toBe('tyn-bac8');
    expect(parser.shoeEvidence('tyn-bac8')).toEqual({ reason: 'attach' });
    expect(parser.shoeEvidence(`wnf-${VENDOR}`)).toBeUndefined();
  });

  it('ignores later aliases after lockPublicId', () => {
    const parser = new WinfinityRuntimeParser();
    parser.lockPublicId(VENDOR, `wnf-${VENDOR}`);
    parser.registerAlias(VENDOR, 'tyn-bac8');
    expect(parser.resolveTableId(VENDOR)).toBe(`wnf-${VENDOR}`);
  });

  it('registers TABLES_LIST aliases and ignores unknown shapes', () => {
    const parser = new WinfinityRuntimeParser();
    expect(parser.parseFrame(JSON.stringify({
      type: 'TABLES_LIST',
      tables: [{ tableId: VENDOR, streamId: 'TYN-BAC8' }],
    }))).toEqual([]);
    expect(parser.peekPublicId(VENDOR)).toBe('tyn-bac8');
    const other = new WinfinityRuntimeParser();
    expect(other.parseFrame(JSON.stringify({
      type: 'TABLES_LIST',
      payload: { tables: [{ objectId: VENDOR, streamId: 'tyn-bac8' }] },
    }))).toEqual([]);
    expect(other.peekPublicId(VENDOR)).toBe('tyn-bac8');
    const ignored = new WinfinityRuntimeParser();
    expect(ignored.parseFrame(JSON.stringify({ type: 'TABLES_LIST', ok: true }))).toEqual([]);
    expect(ignored.hasLockedPublicId(VENDOR)).toBe(false);
  });

  it('parses hall labels and infers sibling stream ids from the launched table', () => {
    expect(parseWinfinityTableLabel('Tao Yuan Baccarat 8: ¥5 #10')).toEqual({
      family: 'tao yuan',
      number: 8,
    });
    expect(winfinityDisplayNameFromText('Tao Yuan Baccarat 3: ¥5 #16 5 10')).toBe('Tao Yuan Baccarat 3');
    const parser = new WinfinityRuntimeParser();
    const vendor3 = '638f55f0716f771a0c510f6d';
    const shangrila = '64f72835c860df661dc2b666';
    parser.noteNamedTablesFromPayload({
      data: {
        gameParams: [
          { tableId: VENDOR, tableName: 'Tao Yuan Baccarat 8' },
          { tableId: vendor3, tableName: 'Tao Yuan Baccarat 3' },
          { tableId: shangrila, tableName: 'Shangrila Baccarat 8' },
        ],
      },
    });
    parser.registerAlias(VENDOR, 'tyn-bac8');
    expect(parser.peekPublicId(VENDOR)).toBe('tyn-bac8');
    expect(parser.peekPublicId(vendor3)).toBe('tyn-bac3');
    expect(parser.inferredPublicId(shangrila)).toBeUndefined();
    expect(parser.resolveTableId(shangrila)).toBe(`wnf-${shangrila}`);
    expect(parser.hasLockedPublicId(shangrila)).toBe(false);
    expect(parser.displayNameForVendor(vendor3)).toBe('Tao Yuan Baccarat 3');
    expect(parser.displayNameForVendor(shangrila)).toBe('Shangrila Baccarat 8');
  });

  it('replays the current attach shoe for a newly selected table', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(parser.peekCurrentShoeId('tyn-bac8')).toBe(SHOE_A);
    expect(parser.emitCurrentShoe('tyn-bac8', '2026-09-09T12:00:00.000Z')).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        tableId: 'tyn-bac8',
        shoeId: SHOE_A,
        baseline: 'unknown-monitor-session',
      }),
    ]);
  });

  it('collapses a persisted wnf fallback onto the inferred stream id', () => {
    const fallback = `wnf-${VENDOR}`;
    expect(collapseWinfinityDuplicateTableIds(
      [fallback, 'tyn-bac8', 'wnf-64f72835c860df661dc2b666'],
      { aliasByVendor: new Map([[VENDOR, 'tyn-bac8']]), introduceAliases: true },
    )).toEqual(['tyn-bac8', 'wnf-64f72835c860df661dc2b666']);
  });

  it('accepts a live Winfinity tile road even after a mid-shoe attach gap', () => {
    expect(selectWinfinityRoadCount(undefined, 16)).toBe(16);
    expect(selectWinfinityRoadCount(16, 22)).toBe(22);
    expect(selectWinfinityRoadCount(55, 1)).toBe(1);
    expect(selectWinfinityRoadCount(40, 12)).toBe(40);
  });

  it('collapses same-name Winfinity rows onto the stream id', () => {
    expect(collapseWinfinityDuplicateTableIds(
      ['wnf-638f484d716f771a0c510f5b', 'tyn-bac1'],
      {
        tables: [
          { tableId: 'wnf-638f484d716f771a0c510f5b', displayName: 'Tao Yuan Baccarat 1', roomId: 'dafabet-winfinity' },
          { tableId: 'tyn-bac1', displayName: 'Tao Yuan Baccarat 1', roomId: 'dafabet-winfinity' },
        ],
      },
    )).toEqual(['tyn-bac1']);
  });
});

describe('Winfinity betting windows', () => {
  it('opens pair windows without closesAt when bettingTime is 0', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    const events = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const opened = events.filter(event => event.type === 'bettingWindowOpened');
    expect(opened).toHaveLength(2);
    expect(opened.map(event => event.market).sort()).toEqual(['bankerPair', 'playerPair']);
    expect(opened.every(event => event.tableId === 'tyn-bac8')).toBe(true);
    expect(opened.every(event => event.handId === HAND_1)).toBe(true);
    expect(opened.every(event => event.shoeId === SHOE_A)).toBe(true);
    expect(opened.every(event => !('closesAt' in event) || event.closesAt === undefined)).toBe(true);
  });

  it('updates closesAt on BETS_CLOSING without treating it as a new hand', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const events = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: {
        state: 'BETS_CLOSING',
        bettingTime: '1788889930756',
        bettingTimeDuration: '5000',
        allowedSideBets: [],
      },
    }));
    const opened = events.filter(event => event.type === 'bettingWindowOpened');
    expect(opened).toHaveLength(2);
    expect(opened.every(event => event.closesAt === new Date(1788889930756).toISOString())).toBe(true);
    expect(opened.every(event => event.handId === HAND_1)).toBe(true);
  });

  it('closes windows on GAME_STARTED and does not open a new pair window', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const events = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: {
        state: 'GAME_STARTED',
        bettingTime: '0',
        bettingTimeDuration: '0',
        allowedSideBets: ['PPAIR', 'BPAIR', 'SMALL', 'BIG', 'LUCKY6'],
      },
    }));
    expect(events.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(0);
    expect(events.filter(event => event.type === 'bettingWindowClosed')).toHaveLength(2);
  });
});

describe('Winfinity cards', () => {
  it('emits only incremental cards and maps rank/position', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    const first = parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [{
          id: 'card-1',
          card: { rank: 'QUEEN', suit: 'DIAMOND' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }],
        allCards: [{
          id: 'card-1',
          card: { rank: 'QUEEN', suit: 'DIAMOND' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }],
      },
    }));
    expect(first.filter(event => event.type === 'cardObserved')).toEqual([
      expect.objectContaining({
        type: 'cardObserved',
        tableId: 'tyn-bac8',
        shoeId: SHOE_A,
        handId: HAND_1,
        card: expect.objectContaining({ rank: 'Q', suit: 'DIAMOND' }),
        position: 'player:left',
      }),
    ]);
    const second = parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [{
          id: 'card-1',
          card: { rank: 'QUEEN', suit: 'DIAMOND' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }],
        allCards: [{
          id: 'card-1',
          card: { rank: 'QUEEN', suit: 'DIAMOND' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }, {
          id: 'card-2',
          card: { rank: 'ACE', suit: 'SPADE' },
          position: { area: 'BANKER', order: 'ORDER_EXTRA' },
        }],
      },
    }));
    expect(second.filter(event => event.type === 'cardObserved')).toEqual([
      expect.objectContaining({
        card: expect.objectContaining({ rank: 'A', suit: 'SPADE' }),
        position: 'banker:extra',
      }),
    ]);
  });

  it('fills a missed incremental deal from allCards so settlement has 2+2', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [],
        allCards: [
          { id: 'p1', card: { rank: 'FIVE', suit: 'SPADE' }, position: { area: 'PLAYER', order: 'ORDER_LEFT' } },
          { id: 'p2', card: { rank: 'ACE', suit: 'HEART' }, position: { area: 'PLAYER', order: 'ORDER_RIGHT' } },
          { id: 'b1', card: { rank: 'NINE', suit: 'CLUB' }, position: { area: 'BANKER', order: 'ORDER_LEFT' } },
          { id: 'b2', card: { rank: 'EIGHT', suit: 'DIAMOND' }, position: { area: 'BANKER', order: 'ORDER_RIGHT' } },
        ],
      },
    }));
    const settled = parser.parseFrame(wsFrame('GAME_RESULTS', {
      gameResults: { roundResult: { roundId: HAND_1, won: 'PLAYER', pPair: false, bPair: false } },
    }));
    expect(settled.filter(event => event.type === 'handSettled')).toEqual([
      expect.objectContaining({
        playerCards: [expect.objectContaining({ rank: '5' }), expect.objectContaining({ rank: 'A' })],
        bankerCards: [expect.objectContaining({ rank: '9' }), expect.objectContaining({ rank: '8' })],
      }),
    ]);
  });

  it('drops unknown ranks instead of inventing cards', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    const events = parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [{
          id: 'card-x',
          card: { rank: 'JOKER', suit: 'SPADE' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }],
        allCards: [],
      },
    }));
    expect(events.filter(event => event.type === 'cardObserved')).toHaveLength(0);
  });
});

describe('Winfinity settlement and shoes', () => {
  it('settles pairs from roundResult and ignores duplicates and winners lists', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [
          { id: 'p1', card: { rank: 'FIVE', suit: 'SPADE' }, position: { area: 'PLAYER', order: 'ORDER_LEFT' } },
          { id: 'p2', card: { rank: 'ACE', suit: 'HEART' }, position: { area: 'PLAYER', order: 'ORDER_RIGHT' } },
          { id: 'b1', card: { rank: 'NINE', suit: 'CLUB' }, position: { area: 'BANKER', order: 'ORDER_LEFT' } },
          { id: 'b2', card: { rank: 'EIGHT', suit: 'DIAMOND' }, position: { area: 'BANKER', order: 'ORDER_RIGHT' } },
        ],
        allCards: [],
      },
    }));
    const settled = parser.parseFrame(wsFrame('GAME_RESULTS', {
      gameResults: {
        roundResult: {
          roundId: HAND_1,
          won: 'PLAYER',
          pPair: false,
          bPair: true,
          score: 6,
        },
      },
    }));
    expect(settled.filter(event => event.type === 'handSettled')).toEqual([
      expect.objectContaining({
        tableId: 'tyn-bac8',
        shoeId: SHOE_A,
        handId: HAND_1,
        outcomes: { playerPair: false, bankerPair: true },
        playerCards: [expect.objectContaining({ rank: '5' }), expect.objectContaining({ rank: 'A' })],
        bankerCards: [expect.objectContaining({ rank: '9' }), expect.objectContaining({ rank: '8' })],
      }),
    ]);
    const dup = parser.parseFrame(wsFrame('GAME_RESULTS', {
      gameResults: { roundResult: { roundId: HAND_1, won: 'PLAYER', pPair: true, bPair: true } },
    }));
    expect(dup.filter(event => event.type === 'handSettled')).toHaveLength(0);
    expect(parser.parseFrame(wsFrame('WINNERS_LIST', { winners: [{ name: 'secret' }] }))).toEqual([]);
    expect(parser.parseFrame('not-json')).toEqual([]);
  });

  it('does not emit a short handSettled when cards were not observed', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    const settled = parser.parseFrame(wsFrame('GAME_RESULTS', {
      gameResults: { roundResult: { roundId: HAND_1, won: 'BANKER', pPair: false, bPair: false } },
    }));
    expect(settled.filter(event => event.type === 'handSettled')).toEqual([]);
    parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [
          { id: 'p1', card: { rank: 'FIVE', suit: 'SPADE' }, position: { area: 'PLAYER', order: 'ORDER_LEFT' } },
          { id: 'p2', card: { rank: 'ACE', suit: 'HEART' }, position: { area: 'PLAYER', order: 'ORDER_RIGHT' } },
          { id: 'b1', card: { rank: 'NINE', suit: 'CLUB' }, position: { area: 'BANKER', order: 'ORDER_LEFT' } },
          { id: 'b2', card: { rank: 'EIGHT', suit: 'DIAMOND' }, position: { area: 'BANKER', order: 'ORDER_RIGHT' } },
        ],
        allCards: [],
      },
    }));
    const late = parser.parseFrame(wsFrame('GAME_RESULTS', {
      gameResults: { roundResult: { roundId: HAND_1, won: 'BANKER', pPair: false, bPair: false } },
    }));
    expect(late.filter(event => event.type === 'handSettled')).toHaveLength(1);
  });

  it('records the first shoe token as attach and the second as protocol-shuffle', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    const first = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(parser.shoeEvidence('tyn-bac8')).toEqual({ reason: 'attach' });
    expect(first.some(event => event.type === 'newShoeSignal' && event.baseline === 'physical-shoe')).toBe(false);
    const second = parser.parseFrame(JSON.stringify({
      id: 'evt-2',
      timestamp: '1788889999999',
      type: 'GAME_STATE_CHANGED',
      meta: {
        tableId: VENDOR,
        round: { id: 'hand-2', startedAt: '1788889999999', shoeId: SHOE_B },
      },
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(parser.shoeEvidence('tyn-bac8')).toEqual({ reason: 'protocol-shuffle' });
    expect(second).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'newShoeSignal',
        shoeId: SHOE_B,
        baseline: 'physical-shoe',
        tableId: 'tyn-bac8',
      }),
    ]));
  });

  it('binds operator shoe id after manual confirm until the protocol uuid changes', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    parser.openPhysicalShoe('tyn-bac8', '2026-09-09T00:00:00.000Z');
    const cards = parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [{
          id: 'card-1',
          card: { rank: 'QUEEN', suit: 'DIAMOND' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }],
        allCards: [],
      },
    }));
    expect(cards.filter(event => event.type === 'cardObserved')).toEqual([
      expect.objectContaining({
        shoeId: 'wnf-tyn-bac8-operator',
      }),
    ]);
    expect(parser.shoeEvidence('tyn-bac8')).toEqual({ reason: 'manual-confirm' });
    const shuffled = parser.parseFrame(JSON.stringify({
      id: 'evt-2',
      timestamp: '1788889999999',
      type: 'GAME_STATE_CHANGED',
      meta: {
        tableId: VENDOR,
        round: { id: 'hand-2', startedAt: '1788889999999', shoeId: SHOE_B },
      },
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(parser.shoeEvidence('tyn-bac8')).toEqual({ reason: 'protocol-shuffle' });
    expect(shuffled).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'newShoeSignal',
        shoeId: SHOE_B,
        baseline: 'physical-shoe',
        tableId: 'tyn-bac8',
      }),
    ]));
  });
});

function dealWinfinityHand(
  parser: WinfinityRuntimeParser,
  handId: string,
  shoeId = SHOE_A,
): void {
  parser.parseFrame(JSON.stringify({
    id: `evt-${handId}`,
    timestamp: '1788889925756',
    type: 'GAME_STATE_CHANGED',
    meta: { tableId: VENDOR, round: { id: handId, startedAt: '1788889925756', shoeId } },
    state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
  }));
  parser.parseFrame(JSON.stringify({
    id: `cards-${handId}`,
    timestamp: '1788889925756',
    type: 'CARDS_TAKEN',
    meta: { tableId: VENDOR, round: { id: handId, startedAt: '1788889925756', shoeId } },
    cards: {
      cards: [
        { id: `${handId}-p1`, card: { rank: 'FIVE', suit: 'SPADE' }, position: { area: 'PLAYER', order: 'ORDER_LEFT' } },
        { id: `${handId}-p2`, card: { rank: 'ACE', suit: 'HEART' }, position: { area: 'PLAYER', order: 'ORDER_RIGHT' } },
        { id: `${handId}-b1`, card: { rank: 'NINE', suit: 'CLUB' }, position: { area: 'BANKER', order: 'ORDER_LEFT' } },
        { id: `${handId}-b2`, card: { rank: 'EIGHT', suit: 'DIAMOND' }, position: { area: 'BANKER', order: 'ORDER_RIGHT' } },
      ],
      allCards: [],
    },
  }));
  parser.parseFrame(JSON.stringify({
    id: `result-${handId}`,
    timestamp: '1788889925756',
    type: 'GAME_RESULTS',
    meta: { tableId: VENDOR, round: { id: handId, startedAt: '1788889925756', shoeId } },
    gameResults: { roundResult: { roundId: handId, won: 'PLAYER', pPair: false, bPair: false } },
  }));
}

describe('Winfinity road-wrap', () => {
  it('opens a physical shoe when the tile returns to #8 after a deep tracked shoe', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    for (let hand = 0; hand < 55; hand += 1) {
      dealWinfinityHand(parser, `hand-${hand}`);
    }
    const wrapped = parser.noteGameCounts(
      [{ tableId: 'tyn-bac8', gameCount: 8 }],
      '2026-09-09T12:00:00.000Z',
    );
    expect(wrapped.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        tableId: 'tyn-bac8',
        shoeId: 'wnf-tyn-bac8-wrap-1',
        baseline: 'physical-shoe',
      }),
    ]);
    expect(parser.shoeEvidence('tyn-bac8')).toEqual({
      reason: 'road-wrap',
      previousGameCount: 55,
      gameCount: 8,
    });
    const replayed = wrapped.filter(event => event.type === 'cardObserved');
    expect(replayed).toHaveLength(32);
    expect(replayed.every(event => event.shoeId === 'wnf-tyn-bac8-wrap-1')).toBe(true);
  });

  it('does not wrap a just-shuffled shoe when the tile is already #8', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    parser.parseFrame(JSON.stringify({
      id: 'evt-2',
      timestamp: '1788889999999',
      type: 'GAME_STATE_CHANGED',
      meta: {
        tableId: VENDOR,
        round: { id: 'hand-2', startedAt: '1788889999999', shoeId: SHOE_B },
      },
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    dealWinfinityHand(parser, 'hand-new-1', SHOE_B);
    dealWinfinityHand(parser, 'hand-new-2', SHOE_B);
    expect(parser.noteGameCounts(
      [{ tableId: 'tyn-bac8', gameCount: 8 }],
      '2026-09-09T12:00:00.000Z',
    )).toEqual([]);
    expect(parser.shoeEvidence('tyn-bac8')?.reason).toBe('protocol-shuffle');
  });

  it('does not treat a lagged high tile as a wrap after protocol-shuffle', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    parser.parseFrame(JSON.stringify({
      id: 'evt-2',
      timestamp: '1788889999999',
      type: 'GAME_STATE_CHANGED',
      meta: {
        tableId: VENDOR,
        round: { id: 'hand-2', startedAt: '1788889999999', shoeId: SHOE_B },
      },
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(parser.noteGameCounts(
      [{ tableId: 'tyn-bac8', gameCount: 55 }],
      '2026-09-09T12:00:00.000Z',
    )).toEqual([]);
    expect(parser.acceptedGameCount('tyn-bac8')).toBeUndefined();
  });

  it('keeps the wrap shoe when the protocol uuid changes on the same new shoe', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    for (let hand = 0; hand < 16; hand += 1) {
      dealWinfinityHand(parser, `hand-${hand}`);
    }
    parser.noteGameCounts(
      [{ tableId: 'tyn-bac8', gameCount: 1 }],
      '2026-09-09T12:00:00.000Z',
    );
    const later = parser.parseFrame(JSON.stringify({
      id: 'evt-new',
      timestamp: '1788889999999',
      type: 'GAME_STATE_CHANGED',
      meta: {
        tableId: VENDOR,
        round: { id: 'hand-wrap-1', startedAt: '1788889999999', shoeId: SHOE_B },
      },
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(later.filter(event => event.type === 'newShoeSignal')).toEqual([]);
    expect(later.filter(event => event.type === 'bettingWindowOpened')[0]?.shoeId).toBe('wnf-tyn-bac8-wrap-1');
    expect(parser.shoeEvidence('tyn-bac8')?.reason).toBe('road-wrap');
  });
});
