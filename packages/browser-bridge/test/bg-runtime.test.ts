import { describe, expect, it } from 'vitest';
import { BgRuntimeParser, isBgInternalExternalGameCountAnomaly, selectBgRoadCount } from '../src/bg-runtime.js';
import type { NormalizedEvent } from '@baccarat/contracts';

function snapshot(tables: ReadonlyArray<Record<string, unknown>>, observedAt = '2026-09-05T01:00:00.000Z') {
  return JSON.stringify({
    version: 1,
    view: tables.length > 1 ? 'multi' : 'single',
    observedAt,
    tables,
  });
}

describe('selectBgRoadCount', () => {
  it('accepts a HISTORY catch-up from 1 to a deep road', () => {
    expect(selectBgRoadCount(1, 36)).toBe(36);
    expect(selectBgRoadCount(undefined, 36)).toBe(36);
  });

  it('accepts a real shoe wrap from a deep road down to 1', () => {
    expect(selectBgRoadCount(36, 1)).toBe(1);
  });

  it('corrects an inflated HISTORY 29 down to felt 局 18 without treating it as a shuffle', () => {
    expect(selectBgRoadCount(29, 18)).toBe(18);
  });

  it('does not let a lagged HISTORY 29 overwrite a live 局 6', () => {
    expect(selectBgRoadCount(6, 29)).toBe(6);
  });

  it('does not treat a deep-shoe 72→18 drop as a 29→18 correction', () => {
    expect(selectBgRoadCount(72, 18)).toBe(72);
  });
});


describe('isBgInternalExternalGameCountAnomaly', () => {
  it('does not kick a table for inflated HISTORY 29 vs felt 局 18', () => {
    expect(isBgInternalExternalGameCountAnomaly(18, 29)).toBe(false);
    expect(isBgInternalExternalGameCountAnomaly(29, 18)).toBe(false);
  });

  it('does not kick when protocol has more hands than the HISTORY window', () => {
    expect(isBgInternalExternalGameCountAnomaly(50, 21)).toBe(false);
    expect(isBgInternalExternalGameCountAnomaly(41, 52)).toBe(false);
    expect(isBgInternalExternalGameCountAnomaly(12, 13)).toBe(false);
  });
});

describe('BgRuntimeParser', () => {
  it('starts a new process past the highest persisted shoe generation', () => {
    const parser = new BgRuntimeParser();
    parser.seedShoeSequence('A05', 4);
    const events = parser.parse(snapshot([{
      tableId: 'A05',
      roundId: '4963300',
      bettingOpen: true,
      source: 'protocol',
    }]));
    expect(events.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ shoeId: 'bg-A05-5', baseline: 'unknown-monitor-session' }),
    ]);
  });

  it('discovers uppercase BG table ids from a lobby snapshot', () => {
    const parser = new BgRuntimeParser();
    const raw = snapshot([
      { tableId: 'b01', gameCount: 12 },
      { tableId: 'B06', gameCount: 3 },
      { tableId: 'bc281koreanch281', gameCount: 9 },
    ]);
    expect(parser.observedTableIds(raw)).toEqual(['B01', 'B06']);
  });

  it('records the first shoeReset token without promoting a physical shoe', () => {
    const parser = new BgRuntimeParser();
    const events = parser.parse(snapshot([{
      tableId: 'B06',
      roundId: 'R-100',
      gameCount: 22,
      bettingOpen: true,
      shoeReset: 'bg-shoe-1',
      source: 'protocol',
    }]));
    expect(events.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ baseline: 'unknown-monitor-session', tableId: 'B06' }),
    ]);
    expect(parser.shoeEvidence('B06')).toEqual({ reason: 'attach' });
  });

  it('records the first NEXT_SHOES shuffle pulse without promoting a physical shoe', () => {
    const parser = new BgRuntimeParser();
    const events = parser.parse(snapshot([{
      tableId: 'A31',
      shuffleEvent: true,
      shoeReset: 'seq:99',
      source: 'protocol',
    }]));
    expect(events.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ baseline: 'unknown-monitor-session', tableId: 'A31' }),
    ]);
    expect(parser.shoeEvidence('A31')).toEqual({ reason: 'attach' });
    expect(parser.currentShoeId('A31')).toBe('bg-A31-1');

    const promoted = parser.parse(snapshot([{
      tableId: 'A31',
      shuffleEvent: true,
      shoeReset: 'seq:100',
      source: 'protocol',
    }]));
    expect(promoted.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ baseline: 'physical-shoe', tableId: 'A31' }),
    ]);
    expect(parser.shoeEvidence('A31')).toEqual({ reason: 'protocol-shuffle' });
    expect(parser.currentShoeId('A31')).toBe('bg-A31-2');
  });

  it('does not open a new shoe when HISTORY first-seq walks forward', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'C06',
      roundId: '1940038',
      gameCount: 1,
      shoeReset: 'seq:1940038',
      source: 'protocol',
    }]));
    const next = parser.parse(snapshot([{
      tableId: 'C06',
      roundId: '1940039',
      gameCount: 2,
      shoeReset: 'seq:1940039',
      bettingOpen: true,
      source: 'protocol',
    }]));
    expect(next.filter(event => event.type === 'newShoeSignal')).toEqual([]);
    expect(parser.shoeEvidence('C06')).toEqual({ reason: 'attach' });
    expect(parser.currentShoeId('C06')).toBe('bg-C06-1');
  });

  it('promotes a physical shoe when the shuffle token changes', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'B06',
      roundId: 'R-100',
      shoeReset: 'bg-shoe-1',
      source: 'protocol',
    }]));
    const promoted = parser.parse(snapshot([{
      tableId: 'B06',
      roundId: 'R-101',
      shoeReset: 'bg-shoe-2',
      source: 'protocol',
    }]));
    expect(promoted.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ baseline: 'physical-shoe', tableId: 'B06' }),
    ]);
    expect(parser.shoeEvidence('B06')).toEqual({ reason: 'protocol-shuffle' });
  });


  it('strips a glued banker lead after it repeats across changing hands', () => {
    const parser = new BgRuntimeParser();
    const dealt = [
      { playerCards: ['AS', '2S'], bankerCards: ['8S', '3H', '5D'] },
      { playerCards: ['KD', '9C'], bankerCards: ['8S', '7H', '2C'] },
      { playerCards: ['4D', 'QH'], bankerCards: ['8S', 'JC', '6S'] },
      { playerCards: ['3S', '4C'], bankerCards: ['8S', '7D', '9S'] },
    ];
    const settledCards: string[][] = [];
    for (let index = 0; index < dealt.length; index += 1) {
      const roundId = String(190090 + index);
      parser.parse(snapshot([{
        tableId: 'B28',
        roundId,
        bettingOpen: true,
        playerCards: [],
        bankerCards: [],
        source: 'protocol',
      }]));
      const events = parser.parse(snapshot([{
        tableId: 'B28',
        roundId,
        bettingOpen: false,
        gameSettled: true,
        playerCards: dealt[index]!.playerCards,
        bankerCards: dealt[index]!.bankerCards,
        source: 'protocol',
      }]));
      const bankerObserved = events.filter(event => event.type === 'cardObserved' && event.position === 'banker') as Extract<NormalizedEvent, { type: 'cardObserved' }>[];
      settledCards.push(bankerObserved.map(event => event.card.raw ?? `${event.card.rank}${event.card.suit ?? ''}`));
    }
    expect(settledCards[0]?.[0]).toBe('8S');
    expect(settledCards[1]?.[0]).toBe('8S');
    expect(settledCards[2]).not.toContain('8S');
    expect(settledCards[3]).toEqual(['7D', '9S']);
    expect(parser.stickyBankerLead('B28')).toBe('8S');
  });

  it('strips a glued banker lead from a HISTORY road when only that slot is frozen', () => {
    const parser = new BgRuntimeParser();
    const historyHands = Array.from({ length: 12 }, (_, index) => ({
      playerCards: [index % 2 === 0 ? 'AS' : '2D', index % 3 === 0 ? 'KH' : 'QC'],
      bankerCards: ['8S', index % 2 === 0 ? '5C' : '7H', index % 3 === 0 ? '9D' : '2S'],
    }));
    parser.parse(snapshot([{
      tableId: 'B28',
      shoeReset: 'bg-shoe-1',
      source: 'protocol',
    }]));
    const events = parser.parse(snapshot([{
      tableId: 'B28',
      shuffleEvent: true,
      shoeReset: 'bg-shoe-2',
      roundId: '190004',
      gameCount: 12,
      source: 'protocol',
      historyHands,
    }]));
    const bankerObserved = events.filter(event => event.type === 'cardObserved' && event.position === 'banker') as Extract<NormalizedEvent, { type: 'cardObserved' }>[];
    expect(bankerObserved.length).toBe(24);
    expect(bankerObserved.every(event => event.card.raw !== '8S')).toBe(true);
  });

  it('replays history road cards onto a newly opened physical shoe', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'A31',
      shoeReset: 'bg-shoe-1',
      source: 'protocol',
    }]));
    const events = parser.parse(snapshot([{
      tableId: 'A31',
      shuffleEvent: true,
      shoeReset: 'bg-shoe-2',
      roundId: '12',
      gameCount: 2,
      source: 'protocol',
      historyHands: [
        { playerCards: ['AS', '2S'], bankerCards: ['AH', '3H'] },
        { playerCards: ['KS', 'QS'], bankerCards: ['KH', 'QH'] },
      ],
    }]));
    expect(events.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ baseline: 'physical-shoe' }),
    ]);
    const cards = events.filter(event => event.type === 'cardObserved');
    expect(cards).toHaveLength(8);
    expect(parser.shoeEvidence('A31')).toEqual({ reason: 'protocol-shuffle' });
  });

  it('records the first HISTORY seq token without promoting, then promotes when it changes', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'C07',
      roundId: '2030721',
      gameCount: 40,
      shoeReset: 'seq:2030682',
      source: 'protocol',
    }]));
    expect(parser.shoeEvidence('C07')).toEqual({ reason: 'attach' });
    const promoted = parser.parse(snapshot([{
      tableId: 'C07',
      roundId: '2030723',
      gameCount: 2,
      shoeReset: 'seq:2030722',
      source: 'protocol',
      historyHands: [
        { playerCards: ['AS', '8S'], bankerCards: ['AH', '7H'] },
        { playerCards: ['KS', '9S'], bankerCards: ['KH', '8H'] },
      ],
    }]));
    expect(promoted.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ baseline: 'physical-shoe', tableId: 'C07' }),
    ]);
    expect(parser.shoeEvidence('C07')).toEqual({ reason: 'protocol-shuffle' });
    expect(promoted.filter(event => event.type === 'cardObserved')).toHaveLength(8);
  });

  it('replays a current-shoe HISTORY of more than 20 hands after NEXT_SHOES', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'B01',
      shoeReset: 'bg-shoe-1',
      source: 'protocol',
    }]));
    const hands = Array.from({ length: 24 }, () => ({
      playerCards: ['AS', '8S'],
      bankerCards: ['AH', '7H'],
    }));
    const events = parser.parse(snapshot([{
      tableId: 'B01',
      roundId: '224',
      gameCount: 24,
      shoeReset: 'bg-shoe-2',
      source: 'protocol',
      historyHands: hands,
    }]));
    expect(events.filter(event => event.type === 'cardObserved').length).toBe(96);
    expect(parser.acceptedGameCount('B01')).toBe(24);
  });

  it('does not replay a lagged deep HISTORY onto a freshly shuffled shoe', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'A30',
      shoeReset: 'seq:200',
      source: 'protocol',
    }]));
    parser.parse(snapshot([{
      tableId: 'A30',
      shuffleEvent: true,
      shoeReset: 'seq:300',
      source: 'protocol',
    }]));
    const hands = Array.from({ length: 36 }, () => ({
      playerCards: ['AS', '8S'],
      bankerCards: ['AH', '7H'],
    }));
    const events = parser.parse(snapshot([{
      tableId: 'A30',
      roundId: '235',
      gameCount: 36,
      shoeReset: 'seq:100',
      source: 'protocol',
      historyHands: hands,
    }]));
    expect(events.filter(event => event.type === 'cardObserved')).toHaveLength(0);
  });

  it('replays HISTORY onto a shoe that was opened by a previous NEXT_SHOES pulse', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'C07',
      shoeReset: 'seq:2030681',
      source: 'protocol',
    }]));
    parser.parse(snapshot([{
      tableId: 'C07',
      shuffleEvent: true,
      shoeReset: 'seq:2030682',
      source: 'protocol',
    }]));
    const events = parser.parse(snapshot([{
      tableId: 'C07',
      roundId: '2030683',
      gameCount: 2,
      source: 'protocol',
      historyHands: [
        { playerCards: ['AS', '8S'], bankerCards: ['AH', '7H'] },
        { playerCards: ['KS', '9S'], bankerCards: ['KH', '8H'] },
      ],
    }]));
    expect(parser.shoeEvidence('C07')).toEqual({ reason: 'protocol-shuffle' });
    expect(events.filter(event => event.type === 'cardObserved')).toHaveLength(8);
    expect(events.filter(event => event.type === 'handSettled')).toHaveLength(2);
  });

  it('wraps a physical shoe when history road is short after many tracked hands', () => {
    const parser = new BgRuntimeParser();
    for (let i = 1; i <= 12; i += 1) {
      parser.parse(snapshot([{
        tableId: 'A31',
        roundId: `R-${i}`,
        bettingOpen: true,
        source: 'protocol',
      }]));
    }
    const wrapped = parser.parse(snapshot([{
      tableId: 'A31',
      gameCount: 1,
      source: 'protocol',
    }]));
    expect(wrapped.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ baseline: 'physical-shoe', tableId: 'A31' }),
    ]);
    expect(parser.shoeEvidence('A31')).toEqual({
      reason: 'road-wrap',
      previousGameCount: 12,
      gameCount: 1,
    });
  });

  it('caps a 29-row HISTORY packet to 局 18 using the live START_BET seq', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'B01',
      roundId: '1017',
      bettingOpen: true,
      source: 'protocol',
    }]));
    const events = parser.parse(snapshot([{
      tableId: 'B01',
      roundId: '1028',
      gameCount: 29,
      shoeReset: 'seq:1000',
      source: 'protocol',
      historyHands: Array.from({ length: 29 }, () => ({
        playerCards: ['AS', '8S'],
        bankerCards: ['AH', '7H'],
      })),
    }]));
    expect(events.filter(event => event.type === 'newShoeSignal')).toEqual([]);
    expect(parser.acceptedGameCount('B01')).toBe(18);
  });

  it('does not open a new shoe when inflated road 29 later matches felt 18', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'B01',
      roundId: '3822968',
      gameCount: 29,
      source: 'protocol',
    }]));
    const corrected = parser.parse(snapshot([{
      tableId: 'B01',
      roundId: '3822968',
      gameCount: 18,
      source: 'protocol',
    }]));
    expect(corrected.filter(event => event.type === 'newShoeSignal')).toEqual([]);
    expect(parser.acceptedGameCount('B01')).toBe(18);
  });

  it('does not treat a dealt road 72 collapsing to 18 as a protocol-shuffle', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'A05',
      roundId: '4963300',
      gameCount: 72,
      source: 'protocol',
    }]));
    const shuffled = parser.parse(snapshot([{
      tableId: 'A05',
      roundId: '4963372',
      gameCount: 18,
      shoeReset: 'seq:4963355',
      source: 'protocol',
    }]));
    expect(shuffled.filter(event => event.type === 'newShoeSignal' && event.baseline === 'physical-shoe')).toHaveLength(0);
    expect(parser.shoeEvidence('A05')?.reason).not.toBe('protocol-shuffle');
    expect(parser.acceptedGameCount('A05')).toBe(72);
  });

  it('does not promote HISTORY shuffleEvent on a 29→18 correction', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'B01',
      roundId: '3822968',
      gameCount: 29,
      shoeReset: 'seq:3822940',
      source: 'protocol',
    }]));
    const corrected = parser.parse(snapshot([{
      tableId: 'B01',
      roundId: '3822968',
      gameCount: 18,
      shoeReset: 'seq:3822951',
      shuffleEvent: true,
      source: 'protocol',
    }]));
    expect(corrected.filter(event => event.type === 'newShoeSignal')).toEqual([]);
    expect(parser.acceptedGameCount('B01')).toBe(18);
  });

  it('opens a physical shoe on a road wrap from 48 to 5', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'B01',
      roundId: 'R-1',
      gameCount: 48,
      source: 'dom',
    }]));
    const wrapped = parser.parse(snapshot([{
      tableId: 'B01',
      roundId: 'R-2',
      gameCount: 5,
      source: 'dom',
    }]));
    expect(wrapped.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({
        baseline: 'physical-shoe',
      }),
    ]);
    expect(parser.shoeEvidence('B01')).toEqual({
      reason: 'road-wrap',
      previousGameCount: 48,
      gameCount: 5,
    });
  });

  it('opens pair betting windows while the table is open with no cards', () => {
    const parser = new BgRuntimeParser();
    const events = parser.parse(snapshot([{
      tableId: 'B06',
      roundId: 'R-200',
      bettingOpen: true,
      countdown: 8,
      playerCards: [],
      bankerCards: [],
      source: 'protocol',
    }]));
    const opened = events.filter(event => event.type === 'bettingWindowOpened') as Extract<NormalizedEvent, { type: 'bettingWindowOpened' }>[];
    expect(opened.map(event => event.market).sort()).toEqual(['bankerPair', 'playerPair']);
  });

  it('emits cards and closes windows when the hand settles', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'B06',
      roundId: 'R-200',
      bettingOpen: true,
      playerCards: [],
      bankerCards: [],
      source: 'protocol',
    }]));
    const settled = parser.parse(snapshot([{
      tableId: 'B06',
      roundId: 'R-200',
      bettingOpen: false,
      gameSettled: true,
      playerCards: ['AS', '7D'],
      bankerCards: ['KH', '5C'],
      source: 'protocol',
    }]));
    expect(settled.some(event => event.type === 'cardObserved')).toBe(true);
    expect(settled.filter(event => event.type === 'bettingWindowClosed')).toHaveLength(2);
    expect(settled.some(event => event.type === 'handSettled')).toBe(true);
  });

  it('does not re-settle a leftover round after the shoe shuffles', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'C01',
      roundId: '2098609',
      bettingOpen: true,
      playerCards: [],
      bankerCards: [],
      shoeReset: 'seq:1',
      source: 'protocol',
    }]));
    const settled = parser.parse(snapshot([{
      tableId: 'C01',
      roundId: '2098609',
      bettingOpen: false,
      gameSettled: true,
      playerCards: ['JS', '8C'],
      bankerCards: ['9S', '4D'],
      shoeReset: 'seq:1',
      source: 'protocol',
    }]));
    expect(settled.filter(event => event.type === 'handSettled')).toEqual([
      expect.objectContaining({ type: 'handSettled', handId: '2098609', shoeId: 'bg-C01-1' }),
    ]);

    const shuffled = parser.parse(snapshot([{
      tableId: 'C01',
      roundId: '2098609',
      bettingOpen: false,
      gameSettled: true,
      playerCards: ['JS', '8C'],
      bankerCards: ['9S', '4D'],
      shuffleEvent: true,
      shoeReset: 'seq:2',
      source: 'protocol',
    }]));
    expect(shuffled.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ baseline: 'physical-shoe', shoeId: 'bg-C01-2' }),
    ]);
    expect(shuffled.filter(event => event.type === 'handSettled')).toEqual([]);
    expect(shuffled.filter(event => event.type === 'cardObserved')).toEqual([]);
  });

  it('ignores impossible shoe game counts above 80', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'B06',
      roundId: 'R-1',
      gameCount: 128,
      source: 'protocol',
    }]));
    expect(parser.acceptedGameCount('B06')).toBeUndefined();
  });

  it('opens a new shoe when tracked hands exceed a real 8-deck shoe', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{ tableId: 'B06', roundId: 'R-1', bettingOpen: true, source: 'protocol' }]));
    let last: ReturnType<BgRuntimeParser['parse']> = [];
    for (let hand = 2; hand <= 81; hand += 1) {
      last = parser.parse(snapshot([{
        tableId: 'B06',
        roundId: 'R-' + String(hand),
        bettingOpen: true,
        source: 'protocol',
      }]));
    }
    expect(last.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ baseline: 'physical-shoe', tableId: 'B06' }),
    ]);
  });

  it('does not open a new shoe on consecutive protocol rounds without shoeReset', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'B06',
      roundId: '5063070',
      bettingOpen: true,
      playerCards: [],
      bankerCards: [],
      source: 'protocol',
    }]));
    const nextHand = parser.parse(snapshot([{
      tableId: 'B06',
      roundId: '5063071',
      bettingOpen: true,
      playerCards: [],
      bankerCards: [],
      source: 'protocol',
    }]));
    expect(nextHand.filter(event => event.type === 'newShoeSignal')).toEqual([]);
    expect(parser.shoeEvidence('B06')).toEqual({ reason: 'attach' });
  });

  it('rejects junk and oversized BG table ids', () => {
    const parser = new BgRuntimeParser();
    const raw = snapshot([
      { tableId: 'RGB255', gameCount: 12 },
      { tableId: 'GB2312', gameCount: 4 },
      { tableId: 'B100', gameCount: 9 },
      { tableId: 'B06', gameCount: 3 },
    ]);
    expect(parser.observedTableIds(raw)).toEqual(['B06']);
  });

  it('ignores pragmatic-shaped payloads', () => {
    const parser = new BgRuntimeParser();
    expect(parser.parse('<gameresult table="bc281koreanch281"/>')).toEqual([]);
    expect(parser.parse(JSON.stringify({ table: 'bc281koreanch281', betsopen: {} }))).toEqual([]);
  });


  it('does not open a new physical shoe on a mid-shoe shuffle pulse', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'C02',
      shoeReset: 'seq:100',
      source: 'protocol',
    }]));
    parser.parse(snapshot([{
      tableId: 'C02',
      shuffleEvent: true,
      shoeReset: 'seq:200',
      gameCount: 1,
      source: 'protocol',
    }]));
    const shoeId = parser.currentShoeId('C02');
    for (let i = 1; i <= 12; i += 1) {
      parser.parse(snapshot([{
        tableId: 'C02',
        roundId: `R-${i}`,
        bettingOpen: true,
        shoeReset: 'seq:200',
        gameCount: i,
        source: 'protocol',
      }]));
    }
    const pulsed = parser.parse(snapshot([{
      tableId: 'C02',
      shuffleEvent: true,
      shoeReset: 'seq:200',
      gameCount: 12,
      source: 'protocol',
    }]));
    expect(pulsed.filter(event => event.type === 'newShoeSignal')).toEqual([]);
    expect(parser.currentShoeId('C02')).toBe(shoeId);

    const jumped = parser.parse(snapshot([{
      tableId: 'C02',
      shuffleEvent: true,
      shoeReset: 'seq:300',
      gameCount: 13,
      source: 'protocol',
    }]));
    expect(jumped.filter(event => event.type === 'newShoeSignal')).toEqual([]);
    expect(parser.currentShoeId('C02')).toBe(shoeId);
  });

  it('still opens a physical shoe when a deep tracked road wraps', () => {
    const parser = new BgRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'C01',
      shoeReset: 'seq:100',
      source: 'protocol',
    }]));
    parser.parse(snapshot([{
      tableId: 'C01',
      shuffleEvent: true,
      shoeReset: 'seq:200',
      gameCount: 1,
      source: 'protocol',
    }]));
    for (let i = 1; i <= 55; i += 1) {
      parser.parse(snapshot([{
        tableId: 'C01',
        roundId: `R-${i}`,
        bettingOpen: true,
        shoeReset: 'seq:200',
        gameCount: i,
        source: 'protocol',
      }]));
    }
    const wrapped = parser.parse(snapshot([{
      tableId: 'C01',
      shuffleEvent: true,
      shoeReset: 'seq:400',
      gameCount: 1,
      source: 'protocol',
    }]));
    expect(wrapped.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({ baseline: 'physical-shoe', tableId: 'C01' }),
    ]);
  });
});
