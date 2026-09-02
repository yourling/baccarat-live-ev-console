import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@baccarat/contracts';
import { PragmaticRuntimeParser, isJoinableNewShoeRoadCount, isRoadWrapToNewShoe, pragmaticGameCountSnapshot } from '../src/pragmatic-runtime.js';
import { pragmaticNetworkObservation } from '../src/server.js';

function snapshot(
  tables: Array<Record<string, unknown>>,
  view: 'single' | 'multi' = 'single',
): string {
  return JSON.stringify({
    version: 1,
    view,
    observedAt: '2026-08-29T01:00:00.000Z',
    tables,
  });
}

describe('PragmaticRuntimeParser', () => {
  it('backfills closesAt when the countdown arrives after the window already opened', () => {
    const parser = new PragmaticRuntimeParser();
    const opened = parser.parse(snapshot([{
      tableId: 'speedbca14gesbc1',
      roundId: '17260177624',
      bettingOpen: true,
    }]));
    expect(opened.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(2);
    expect(opened.find(event => event.type === 'bettingWindowOpened')).not.toHaveProperty('closesAt');

    const timed = parser.parse(JSON.stringify({
      version: 1,
      view: 'single',
      observedAt: '2026-08-29T01:00:03.000Z',
      tables: [{
        tableId: 'speedbca14gesbc1',
        roundId: '17260177624',
        bettingOpen: true,
        countdown: 5,
      }],
    }));
    const eta = timed.filter(event => event.type === 'bettingWindowOpened') as Array<
      Extract<NormalizedEvent, { type: 'bettingWindowOpened' }>
    >;
    expect(eta).toHaveLength(2);
    expect(eta[0]?.closesAt).toBe('2026-08-29T01:00:08.000Z');

    const sameEta = parser.parse(JSON.stringify({
      version: 1,
      view: 'single',
      observedAt: '2026-08-29T01:00:04.000Z',
      tables: [{
        tableId: 'speedbca14gesbc1',
        roundId: '17260177624',
        bettingOpen: true,
        countdown: 4,
      }],
    }));
    expect(sameEta.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(0);

    const laterTick = parser.parse(JSON.stringify({
      version: 1,
      view: 'single',
      observedAt: '2026-08-29T01:00:06.000Z',
      tables: [{
        tableId: 'speedbca14gesbc1',
        roundId: '17260177624',
        bettingOpen: true,
        countdown: 2,
      }],
    }));
    expect(laterTick.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(0);
  });

  it('keeps the first shoeReset token as an unknown attach, not a physical shoe', () => {
    const parser = new PragmaticRuntimeParser();
    const attached = parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387761010',
      bettingOpen: true,
      source: 'protocol',
    }]));
    expect(attached.find(event => event.type === 'newShoeSignal')).toEqual(expect.objectContaining({
      baseline: 'unknown-monitor-session',
    }));

    const firstToken = parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387766710',
      bettingOpen: true,
      source: 'protocol',
      shoeReset: 'protocol:h22z8qhp17sa0vkh:10',
      gameCount: 55,
    }]));
    expect(firstToken.filter(event => event.type === 'newShoeSignal')).toHaveLength(0);

    const sameCycle = parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387766710',
      bettingOpen: true,
      source: 'protocol',
      shoeReset: 'protocol:h22z8qhp17sa0vkh:10',
      gameCount: 55,
    }]));
    expect(sameCycle.filter(event => event.type === 'newShoeSignal')).toHaveLength(0);
  });

  it('promotes to a physical shoe only after a later shoeReset token change', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387761010',
      source: 'protocol',
      shoeReset: 'protocol:h22z8qhp17sa0vkh:10',
      gameCount: 55,
    }]));
    const shuffled = parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387766710',
      bettingOpen: true,
      source: 'protocol',
      shoeReset: 'protocol:h22z8qhp17sa0vkh:20',
    }]));
    expect(shuffled.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        baseline: 'physical-shoe',
        shoeId: 'pragmatic-h22z8qhp17sa0vkh-2',
      }),
    ]);
  });

  it('does not treat a mid-shoe attach with a shoeReset token as a full 8-deck shoe', () => {
    const parser = new PragmaticRuntimeParser();
    const events = parser.parse(snapshot([{
      tableId: 'bc281koreanch281',
      roundId: '16428076310',
      gameCount: 55,
      bettingOpen: true,
      source: 'protocol',
      shoeReset: 'protocol:bc281koreanch281:99',
      playerCards: ['QS', '9H'],
      bankerCards: ['3S', '7D', '2C'],
    }]));
    const shoe = events.find(event => event.type === 'newShoeSignal') as
      | Extract<NormalizedEvent, { type: 'newShoeSignal' }>
      | undefined;
    expect(shoe?.baseline).toBe('unknown-monitor-session');
    expect(events.filter(event => event.type === 'newShoeSignal')).toHaveLength(1);
    expect(parser.shoeEvidence('bc281koreanch281')).toEqual({ reason: 'attach' });
    expect(events.filter(event => event.type === 'newShoeSignal' && event.baseline === 'physical-shoe')).toHaveLength(0);
  });

  it('keeps a first shoeReset on Korean baccarat #55 with nine visible cards as an unknown attach', () => {
    const parser = new PragmaticRuntimeParser();
    const events = parser.parse(snapshot([{
      tableId: 'bc281koreanch281',
      roundId: '16428076310',
      gameCount: 55,
      bettingOpen: true,
      source: 'protocol',
      shoeReset: 'protocol:bc281koreanch281:99',
      playerCards: ['QS', '9H', '4C'],
      bankerCards: ['3S', '7D', '2C', 'AH', '6D', '9S'],
    }]));
    expect(events.find(event => event.type === 'newShoeSignal')).toEqual(expect.objectContaining({
      baseline: 'unknown-monitor-session',
    }));
    expect(parser.shoeEvidence('bc281koreanch281')).toEqual({ reason: 'attach' });
  });

  it('promotes a watched table when the first shoeReset is a live shuffle event', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'tobcspbaccarat92',
      roundId: '16431832310',
      source: 'protocol',
      gameCount: 48,
    }]));
    expect(parser.shoeEvidence('tobcspbaccarat92')?.reason).toBe('attach');

    const shuffled = parser.parse(snapshot([{
      tableId: 'tobcspbaccarat92',
      roundId: '16431832310',
      source: 'protocol',
      shoeReset: 'protocol:tobcspbaccarat92:10',
      shuffleEvent: true,
    }]));
    expect(shuffled.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        baseline: 'physical-shoe',
      }),
    ]);
    expect(parser.shoeEvidence('tobcspbaccarat92')).toEqual({ reason: 'protocol-shuffle' });
  });

  it('promotes after an attach token when the same token later arrives as a shuffle event', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'spto41bctorobc41',
      roundId: '16432040410',
      source: 'protocol',
      shoeReset: 'protocol:spto41bctorobc41:10',
      gameCount: 22,
    }]));
    expect(parser.shoeEvidence('spto41bctorobc41')?.reason).toBe('attach');

    const shuffled = parser.parse(snapshot([{
      tableId: 'spto41bctorobc41',
      roundId: '16432040410',
      source: 'protocol',
      shoeReset: 'protocol:spto41bctorobc41:10',
      shuffleEvent: true,
    }]));
    expect(shuffled.find(event => event.type === 'newShoeSignal')).toEqual(expect.objectContaining({
      baseline: 'physical-shoe',
    }));
    expect(parser.shoeEvidence('spto41bctorobc41')).toEqual({ reason: 'protocol-shuffle' });
  });

  it('opens a new physical shoe when shuffle repeats after the current shoe has dealt', () => {
    const parser = new PragmaticRuntimeParser();
    const first = parser.parse(snapshot([{
      tableId: 'spto41bctorobc41',
      roundId: 'hand-1',
      source: 'protocol',
      shoeReset: 'protocol:spto41bctorobc41:10',
      shuffleEvent: true,
    }]));
    expect(first.filter(event => event.type === 'newShoeSignal' && event.baseline === 'physical-shoe')).toHaveLength(1);
    const firstShoe = parser.currentShoeId('spto41bctorobc41');

    parser.parse(snapshot([{
      tableId: 'spto41bctorobc41',
      roundId: 'hand-2',
      source: 'protocol',
      shoeReset: 'protocol:spto41bctorobc41:10',
    }]));

    const reshuffled = parser.parse(snapshot([{
      tableId: 'spto41bctorobc41',
      roundId: 'hand-3',
      source: 'protocol',
      shoeReset: 'protocol:spto41bctorobc41:10',
      shuffleEvent: true,
    }]));
    expect(reshuffled.filter(event => event.type === 'newShoeSignal')).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        baseline: 'physical-shoe',
      }),
    ]);
    expect(parser.currentShoeId('spto41bctorobc41')).not.toBe(firstShoe);
    expect(parser.shoeEvidence('spto41bctorobc41')).toEqual({ reason: 'protocol-shuffle' });
  });

  it('does not open another shoe for endshuffling on the same unused shuffle token', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'spto41bctorobc41',
      source: 'protocol',
      shoeReset: 'protocol:spto41bctorobc41:10',
      shuffleEvent: true,
    }]));
    const shoe = parser.currentShoeId('spto41bctorobc41');
    const ended = parser.parse(snapshot([{
      tableId: 'spto41bctorobc41',
      source: 'protocol',
      shoeReset: 'protocol:spto41bctorobc41:10',
      shuffleEvent: true,
    }]));
    expect(ended.filter(event => event.type === 'newShoeSignal')).toHaveLength(0);
    expect(parser.currentShoeId('spto41bctorobc41')).toBe(shoe);
  });

  it('records protocol-shuffle evidence when the shoeReset token changes', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387761010',
      source: 'protocol',
      shoeReset: 'protocol:h22z8qhp17sa0vkh:10',
    }]));
    expect(parser.shoeEvidence('h22z8qhp17sa0vkh')?.reason).toBe('attach');
    parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387766710',
      source: 'protocol',
      shoeReset: 'protocol:h22z8qhp17sa0vkh:20',
    }]));
    expect(parser.shoeEvidence('h22z8qhp17sa0vkh')).toEqual({ reason: 'protocol-shuffle' });
  });

  it('does not treat a drop to #0 as a shuffled shoe', () => {
    expect(isRoadWrapToNewShoe(72, 0)).toBe(false);
    expect(isJoinableNewShoeRoadCount(72, 0)).toBe(false);
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-1', gameCount: 72,
    }]));
    const dropped = parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-2', gameCount: 0,
    }]));
    expect(dropped.filter(event => event.type === 'newShoeSignal')).toHaveLength(0);
    expect(parser.shoeEvidence('bc281koreanch281')?.reason).not.toBe('road-wrap');
  });

  it('records road-wrap evidence on a large gameCount drop', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-1', gameCount: 51,
    }]));
    const wrapped = parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-2', gameCount: 1,
    }]));
    expect(wrapped.find(event => event.type === 'newShoeSignal')).toEqual(expect.objectContaining({
      baseline: 'physical-shoe',
    }));
    expect(parser.shoeEvidence('bc281koreanch281')).toEqual({
      reason: 'road-wrap',
      previousGameCount: 51,
      gameCount: 1,
    });
  });

  it('opens a new physical shoe as soon as the road wraps to #5', () => {
    expect(isRoadWrapToNewShoe(78, 5)).toBe(true);
    expect(isRoadWrapToNewShoe(78, 8)).toBe(true);
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'tobcspbaccarat61', roundId: 'hand-78', gameCount: 78,
    }]));
    const wrapped = parser.parse(snapshot([{
      tableId: 'tobcspbaccarat61', roundId: 'hand-5', gameCount: 5,
    }]));
    expect(wrapped.find(event => event.type === 'newShoeSignal')).toEqual(expect.objectContaining({
      baseline: 'physical-shoe',
    }));
    expect(parser.shoeEvidence('tobcspbaccarat61')).toEqual({
      reason: 'road-wrap',
      previousGameCount: 78,
      gameCount: 5,
    });
  });

  it('does not treat a small mid-shoe drop as a shuffled shoe', () => {
    expect(isRoadWrapToNewShoe(51, 45)).toBe(false);
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-1', gameCount: 51,
    }]));
    parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-2', gameCount: 45,
    }]));
    expect(parser.shoeEvidence('bc281koreanch281')?.reason).not.toBe('road-wrap');
  });

  it('opens both pair markets from a live single-table snapshot', () => {
    const parser = new PragmaticRuntimeParser();
    const events = parser.parse(snapshot([{
      tableId: 'bc281koreanch281',
      roundId: '17260230224',
      gameCount: 35,
      bettingOpen: true,
      countdown: 9,
      playerCards: [],
      bankerCards: [],
    }]));

    expect(events.map(event => event.type)).toEqual([
      'newShoeSignal',
      'bettingWindowOpened',
      'bettingWindowOpened',
    ]);
    const shoe = events[0] as Extract<NormalizedEvent, { type: 'newShoeSignal' }>;
    expect(shoe.baseline).toBe('unknown-monitor-session');
    expect(events.filter(event => event.type === 'bettingWindowOpened').map(event => event.market)).toEqual([
      'bankerPair',
      'playerPair',
    ]);
  });

  it('records two same-rank cards that have different shoe copies', () => {
    const parser = new PragmaticRuntimeParser();
    const events = parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387761010',
      bettingOpen: false,
      playerCards: ['5D3', '5D4'],
      bankerCards: ['AS1', '0S3'],
      source: 'protocol',
    }]));
    const cards = events.filter(event => event.type === 'cardObserved');
    expect(cards).toEqual([
      expect.objectContaining({
        position: 'player',
        card: expect.objectContaining({ rank: '5', suit: 'D', raw: '5D3' }),
      }),
      expect.objectContaining({
        position: 'player',
        card: expect.objectContaining({ rank: '5', suit: 'D', raw: '5D4' }),
      }),
      expect.objectContaining({
        position: 'banker',
        card: expect.objectContaining({ rank: 'A', suit: 'S', raw: 'AS1' }),
      }),
      expect.objectContaining({
        position: 'banker',
        card: expect.objectContaining({ rank: '10', suit: 'S', raw: '0S3' }),
      }),
    ]);
  });

  it('settles a completed hand as soon as both sides have two cards', () => {
    const parser = new PragmaticRuntimeParser();
    const events = parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387761010',
      bettingOpen: false,
      playerCards: ['QS', '9H'],
      bankerCards: ['3S', '7D'],
    }]));
    expect(events.find(event => event.type === 'handSettled')).toEqual(expect.objectContaining({
      type: 'handSettled',
      handId: '16387761010',
    }));
  });

  it('records cards once and settles the prior round when the next round appears', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: '17260230224', gameCount: 35,
      bettingOpen: true, countdown: 9,
    }]));

    const dealt = parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: '17260230224', gameCount: 35,
      bettingOpen: false,
      playerCards: ['2C', '2S'],
      bankerCards: ['AH', '6D'],
    }]));
    expect(dealt.filter(event => event.type === 'cardObserved')).toHaveLength(4);
    expect(dealt.filter(event => event.type === 'bettingWindowClosed')).toHaveLength(2);
    expect(dealt.find(event => event.type === 'handSettled')).toBeUndefined();

    const completed = parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: '17260230224', gameCount: 35,
      bettingOpen: false,
      playerCards: ['2C', '2S', '9H'],
      bankerCards: ['AH', '6D'],
      source: 'protocol',
    }]));
    const settled = completed.find(event => event.type === 'handSettled') as
      | Extract<NormalizedEvent, { type: 'handSettled' }>
      | undefined;
    expect(settled).toEqual(expect.objectContaining({
      handId: '17260230224',
      outcomes: { playerPair: true, bankerPair: false },
    }));
    expect(settled?.playerCards.map(card => card.rank)).toEqual(['2', '2', '9']);

    const repeated = parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: '17260230224', gameCount: 35,
      bettingOpen: false,
      playerCards: ['2C', '2S', '9H'],
      bankerCards: ['AH', '6D'],
    }]));
    expect(repeated).toHaveLength(0);

    const next = parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: '17260235024', gameCount: 36,
      bettingOpen: true, countdown: 8,
    }]));
    expect(next.find(event => event.type === 'handSettled')).toBeUndefined();
  });

  it('promotes a decreasing road count to a physical shoe reset', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-1', gameCount: 51,
    }]));
    const events = parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-2', gameCount: 1,
    }]));
    const reset = events.find(event => event.type === 'newShoeSignal') as
      | Extract<NormalizedEvent, { type: 'newShoeSignal' }>
      | undefined;
    expect(reset?.baseline).toBe('physical-shoe');
    expect(reset?.shoeId).toBe('pragmatic-bc281koreanch281-2');
  });

  it('treats a lagged road wrap as joinable even past #2', () => {
    expect(isJoinableNewShoeRoadCount(48, 5)).toBe(true);
    expect(isJoinableNewShoeRoadCount(48, 1)).toBe(true);
    expect(isJoinableNewShoeRoadCount(34, 33)).toBe(false);
    expect(isJoinableNewShoeRoadCount(undefined, 1)).toBe(false);
  });

  it('does not treat a one-step road-count drop as a new shoe', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'spto43bctorobc43', roundId: 'hand-37', gameCount: 37,
    }]));
    const events = parser.parse(snapshot([{
      tableId: 'spto43bctorobc43', roundId: 'hand-36', gameCount: 36,
    }]));
    expect(events.filter(event => event.type === 'newShoeSignal')).toHaveLength(0);
  });

  it('does not open a physical shoe when the road count only lags a few hands', () => {
    const parser = new PragmaticRuntimeParser();
    const tableId = 'spto43bctorobc43';
    for (let index = 0; index < 8; index += 1) {
      parser.parse(snapshot([{
        tableId,
        roundId: `1640732490${index}`,
        bettingOpen: false,
        playerCards: ['QS', '9H'],
        bankerCards: ['3S', '7D'],
        source: 'protocol',
      }]));
    }
    expect(parser.parse(snapshot([{ tableId, gameCount: 5 }]))
      .filter(event => event.type === 'newShoeSignal')).toHaveLength(0);
  });

  it('does not open a physical shoe from tracked-hand lag against a low road count', () => {
    const parser = new PragmaticRuntimeParser();
    const tableId = 'spto21bctorobc21';
    for (let index = 0; index < 24; index += 1) {
      parser.parse(snapshot([{
        tableId,
        roundId: `164073249${String(index).padStart(2, '0')}`,
        bettingOpen: false,
        playerCards: ['QS', '9H'],
        bankerCards: ['3S', '7D'],
        source: 'protocol',
      }]));
    }

    const reset = parser.parse(snapshot([{ tableId, gameCount: 5 }]));
    expect(reset.filter(event => event.type === 'newShoeSignal')).toHaveLength(0);
  });

  it('does not treat a nearby road count as a missed shuffle', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-1', gameCount: 35, bettingOpen: true,
    }]));
    parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-2', gameCount: 36, bettingOpen: true,
    }]));
    const next = parser.parse(snapshot([{
      tableId: 'bc281koreanch281', roundId: 'hand-3', gameCount: 36, bettingOpen: true,
    }]));
    expect(next.filter(event => event.type === 'newShoeSignal')).toHaveLength(0);
  });

  it('can force a physical shoe that later cards attach to', () => {
    const parser = new PragmaticRuntimeParser();
    const tableId = 'spto21bctorobc21';
    parser.parse(snapshot([{
      tableId, roundId: '16407324001', playerCards: ['QS', '9H'], bankerCards: ['3S', '7D'], source: 'protocol',
    }]));
    const forced = parser.openPhysicalShoe(tableId, '2026-08-31T12:00:00.000Z');
    expect(forced).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        baseline: 'physical-shoe',
        shoeId: `pragmatic-${tableId}-2`,
      }),
    ]);
    expect(parser.currentShoeId(tableId)).toBe(`pragmatic-${tableId}-2`);

    const dealt = parser.parse(snapshot([{
      tableId,
      roundId: '16407324910',
      playerCards: ['2C', '2S'],
      bankerCards: ['AH', '6D'],
      source: 'protocol',
    }]));
    expect(dealt.filter(event => event.type === 'cardObserved')
      .every(event => event.shoeId === `pragmatic-${tableId}-2`)).toBe(true);
  });

  it('does not open a shoe from a game-count-only snapshot on a fresh table', () => {
    const parser = new PragmaticRuntimeParser();
    expect(parser.parse(snapshot([{
      tableId: 'spto21bctorobc21',
      gameCount: 5,
    }]))).toEqual([]);
  });

  it('keeps only tableId and gameCount when stripping a DOM snapshot', () => {
    const stripped = pragmaticGameCountSnapshot(snapshot([{
      tableId: 'spto21bctorobc21',
      roundId: '16407324910',
      gameCount: 5,
      bettingOpen: true,
      countdown: 6,
      playerCards: ['QS', '9H'],
      bankerCards: ['3S', '7D'],
      source: 'dom',
    }]));
    expect(JSON.parse(stripped ?? '{}')).toEqual({
      version: 1,
      view: 'single',
      observedAt: '2026-08-29T01:00:00.000Z',
      tables: [{ tableId: 'spto21bctorobc21', gameCount: 5 }],
    });
    expect(pragmaticGameCountSnapshot(snapshot([{
      tableId: 'spto21bctorobc21',
      roundId: '16407324910',
      bettingOpen: true,
    }]))).toBeUndefined();
  });

  it('tracks simultaneous multitable rounds independently', () => {
    const parser = new PragmaticRuntimeParser();
    const events = parser.parse(snapshot([
      { tableId: 'speedbca14gesbc1', roundId: '17260177624', bettingOpen: true, countdown: 7 },
      { tableId: 'tobcbaccaragen92', roundId: '17260176724', bettingOpen: true, countdown: 4 },
      { tableId: 'spijbnsu408vmv73', roundId: '17260175724' },
    ], 'multi'));

    expect(events.filter(event => event.type === 'newShoeSignal')).toHaveLength(3);
    expect(events.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(4);
    expect(new Set(events.map(event => event.tableId))).toEqual(new Set([
      'speedbca14gesbc1',
      'tobcbaccaragen92',
      'spijbnsu408vmv73',
    ]));
  });

  it('does not consume unselected tables before they are added to monitoring', () => {
    const parser = new PragmaticRuntimeParser();
    const raw = snapshot([
      { tableId: 'speedbca14gesbc1', roundId: '17260177624', bettingOpen: true, countdown: 7 },
      { tableId: 'tobcbaccaragen92', roundId: '17260176724', bettingOpen: true, countdown: 4 },
    ], 'multi');

    expect(parser.parse(raw, tableId => tableId === 'speedbca14gesbc1')
      .every(event => event.tableId === 'speedbca14gesbc1')).toBe(true);
    const newlySelected = parser.parse(raw, tableId => tableId === 'tobcbaccaragen92');

    expect(newlySelected.map(event => event.type)).toEqual([
      'newShoeSignal',
      'bettingWindowOpened',
      'bettingWindowOpened',
    ]);
  });

  it('can reset one table without disturbing another table state', () => {
    const parser = new PragmaticRuntimeParser();
    const raw = snapshot([
      { tableId: 'speedbca14gesbc1', roundId: '17260177624', bettingOpen: true, countdown: 7 },
      { tableId: 'tobcbaccaragen92', roundId: '17260176724', bettingOpen: true, countdown: 4 },
    ], 'multi');
    parser.parse(raw);

    parser.resetTable('tobcbaccaragen92');
    const replayed = parser.parse(raw);

    expect(new Set(replayed.map(event => event.tableId))).toEqual(new Set(['tobcbaccaragen92']));
    expect(replayed.map(event => event.type)).toEqual([
      'newShoeSignal',
      'bettingWindowOpened',
      'bettingWindowOpened',
    ]);
  });

  it('accepts protocol cards for a new round without an empty DOM open boundary', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh', roundId: '16387761010', bettingOpen: false,
      playerCards: ['QS', '9H'], bankerCards: ['3S', '7D'], source: 'protocol',
    }]));

    const next = parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh', roundId: '16387766710', bettingOpen: false,
      playerCards: ['KS', '9H'], bankerCards: ['2C', '3D'], source: 'protocol',
    }]));
    expect(next.filter(event => event.type === 'cardObserved')).toHaveLength(4);
    expect(next.find(event => event.type === 'handSettled')).toEqual(expect.objectContaining({
      handId: '16387766710',
    }));
  });

  it('settles a previous hand when its delayed last card arrives after the next window', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'oq808ojps709qqaf', roundId: '16389075410', bettingOpen: true,
      playerCards: [], bankerCards: [], source: 'protocol',
    }]));
    parser.parse(snapshot([{
      tableId: 'oq808ojps709qqaf', roundId: '16389075410', bettingOpen: false,
      playerCards: ['KS', '9H'], bankerCards: ['2C'], source: 'protocol',
    }]));
    parser.parse(snapshot([{
      tableId: 'oq808ojps709qqaf', roundId: '16389079910', bettingOpen: true,
      playerCards: [], bankerCards: [], source: 'protocol',
    }]));
    const delayed = parser.parse(snapshot([{
      tableId: 'oq808ojps709qqaf', roundId: '16389075410', bettingOpen: false,
      playerCards: ['KS', '9H'], bankerCards: ['2C', '3D'], source: 'protocol',
    }]));
    expect(delayed.filter(event => event.type === 'cardObserved')).toHaveLength(1);
    expect(delayed.find(event => event.type === 'handSettled')).toEqual(expect.objectContaining({
      handId: '16389075410',
    }));
  });

  it('does not let a later partial DOM snapshot erase protocol cards', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh', roundId: '16387761010', bettingOpen: true,
      playerCards: [], bankerCards: [], source: 'protocol',
    }]));
    parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh', roundId: '16387761010', bettingOpen: false,
      playerCards: ['QS', '9H'], bankerCards: ['3S'], source: 'protocol',
    }]));

    const partialDom = parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh', roundId: '16387761010', bettingOpen: false,
      playerCards: ['QS'], bankerCards: ['3S'], source: 'dom',
    }]));
    expect(partialDom.filter(event => event.type === 'cardObserved')).toHaveLength(0);

    const completed = parser.parse(snapshot([{
      tableId: 'h22z8qhp17sa0vkh', roundId: '16387761010', bettingOpen: false,
      playerCards: ['QS', '9H'], bankerCards: ['3S', '7D'], source: 'protocol',
    }]));
    expect(completed.filter(event => event.type === 'cardObserved')).toHaveLength(1);
    expect(completed.find(event => event.type === 'handSettled')).toEqual(expect.objectContaining({
      handId: '16387761010',
      bankerCards: expect.arrayContaining([
        expect.objectContaining({ rank: '3', suit: 'S' }),
        expect.objectContaining({ rank: '7', suit: 'D' }),
      ]),
    }));
  });

  it('does not assign stale cards to a new round before an empty open boundary', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'speedbca14gesbc1', roundId: 'round-1', bettingOpen: false,
      playerCards: ['2C', '2S'], bankerCards: ['AH', '6D'],
    }]));

    const staleTransition = parser.parse(snapshot([{
      tableId: 'speedbca14gesbc1', roundId: 'round-2', bettingOpen: false,
      playerCards: ['2C', '2S'], bankerCards: ['AH', '6D'],
    }]));
    expect(staleTransition.filter(event => event.type === 'cardObserved')).toHaveLength(0);

    parser.parse(snapshot([{
      tableId: 'speedbca14gesbc1', roundId: 'round-2', bettingOpen: true,
      playerCards: [], bankerCards: [],
    }]));
    const actualCards = parser.parse(snapshot([{
      tableId: 'speedbca14gesbc1', roundId: 'round-2', bettingOpen: false,
      playerCards: ['7C', '8S'], bankerCards: ['9H', '10D'],
    }]));
    expect(actualCards.filter(event => event.type === 'cardObserved')).toHaveLength(4);
  });

  it('reopens the same-hand betting window after a false closed snapshot', () => {
    const parser = new PragmaticRuntimeParser();
    parser.parse(snapshot([{
      tableId: 'speedbca14gesbc1', roundId: 'round-open', bettingOpen: true, countdown: 8,
    }]));
    const closed = parser.parse(snapshot([{
      tableId: 'speedbca14gesbc1', roundId: 'round-open', bettingOpen: false,
    }]));
    expect(closed.filter(event => event.type === 'bettingWindowClosed')).toHaveLength(2);

    const reopened = parser.parse(snapshot([{
      tableId: 'speedbca14gesbc1', roundId: 'round-open', bettingOpen: true, countdown: 6,
    }]));
    expect(reopened.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(2);
  });

  it('isolates lifecycle state for forty simultaneously monitored tables', () => {
    const parser = new PragmaticRuntimeParser();
    const tables = Array.from({ length: 40 }, (_, index) => ({
      tableId: `pragmatictable${String(index).padStart(2, '0')}`,
      roundId: `round-${index}`,
      bettingOpen: true,
      countdown: 9 - (index % 5),
      playerCards: [],
      bankerCards: [],
    }));
    const events = parser.parse(snapshot(tables, 'multi'));

    expect(events.filter(event => event.type === 'newShoeSignal')).toHaveLength(40);
    expect(events.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(80);
    expect(new Set(events.map(event => event.tableId))).toHaveLength(40);
    expect(new Set(events.map(event => `${event.tableId}:${event.sourceSeq}`)).size).toBe(events.length);
  });
});

describe('pragmaticNetworkObservation', () => {
  it('exposes protocol shape without exposing unrelated field values', () => {
    const observation = pragmaticNetworkObservation(JSON.stringify({
      eventType: 'tableState',
      tableId: 'speedbca14gesbc1',
      round: { roundId: '17260818724', secret: 'must-not-leak' },
      tables: [{ table_id: 'tobcbaccaragen92', status: 'OPEN' }],
      token: 'private-token',
    }), 'text');

    expect(observation).toEqual(expect.objectContaining({
      format: 'json',
      tableIds: ['speedbca14gesbc1', 'tobcbaccaragen92'],
      roundIds: ['17260818724'],
      eventTypes: ['tableState'],
    }));
    expect(JSON.stringify(observation)).not.toContain('must-not-leak');
    expect(JSON.stringify(observation)).not.toContain('private-token');
  });

  it('exposes only allowlisted game-state values for protocol calibration', () => {
    const observation = pragmaticNetworkObservation(JSON.stringify({
      card: {
        table: 'bc281koreanch281', game: '17260818724', place: 'Player',
        value: '7H', cardCount: '1', sc: '7H', seq: 99,
        token: 'must-not-leak', balance: 12345,
      },
    }), 'text');

    expect(observation.state).toEqual({
      kind: 'card',
      table: 'bc281koreanch281',
      game: '17260818724',
      cardValue: '7H',
      cardCode: '7H',
      place: 'Player',
      cardCount: '1',
      seq: 99,
    });
    expect(JSON.stringify(observation)).not.toContain('must-not-leak');
    expect(JSON.stringify(observation)).not.toContain('12345');
  });
});
