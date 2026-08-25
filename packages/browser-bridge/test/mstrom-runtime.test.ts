import { describe, expect, it } from 'vitest';
import { MstromRuntimeParser, decodeMstromCardByte } from '../src/mstrom-runtime.js';

function snapshot(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    tableId: 'D065',
    roundId: 'GD065268221A8',
    gameType: 'BAC',
    gmstatus: 0,
    playerScore: 0,
    bankerScore: 4,
    playerCards: [0x38, 0x12],
    bankerCards: [0x39, 0x05],
    capturedAt: '2026-08-22T15:30:18.000Z',
    ...overrides,
  });
}

describe('mstrom runtime parser', () => {
  it('decodes the runtime card byte format', () => {
    expect(decodeMstromCardByte(0x01)).toEqual({ rank: 'A', suit: 'C', raw: '0x01' });
    expect(decodeMstromCardByte(0x1d)).toEqual({ rank: 'K', suit: 'D', raw: '0x1d' });
    expect(decodeMstromCardByte(0x2c)).toEqual({ rank: 'Q', suit: 'S', raw: '0x2c' });
    expect(decodeMstromCardByte(0x3b)).toEqual({ rank: 'J', suit: 'H', raw: '0x3b' });
    expect(decodeMstromCardByte(0x00)).toBeNull();
    expect(decodeMstromCardByte(0x1e)).toBeNull();
  });

  it('emits deduplicated pair windows from cardless runtime phase changes', () => {
    // Given: the runtime exposes an opening phase before either side has visible cards.
    const parser = new MstromRuntimeParser();
    const opening = snapshot({
      gmstatus: 1,
      playerScore: null,
      bankerScore: null,
      playerCards: [],
      bankerCards: [],
    });

    // When: the opening phase repeats and later advances to the closed phase.
    const firstOpen = parser.parse(opening);
    const duplicateOpen = parser.parse(opening);
    const closed = parser.parse(snapshot({
      gmstatus: 2,
      playerScore: null,
      bankerScore: null,
      playerCards: [],
      bankerCards: [],
      capturedAt: '2026-08-22T15:30:19.000Z',
    }));

    // Then: both pair markets receive exactly one open and one close event.
    expect(firstOpen.map(event => event.type)).toEqual([
      'newShoeSignal',
      'bettingWindowOpened',
      'bettingWindowOpened',
    ]);
    expect(firstOpen.filter(event => event.type === 'bettingWindowOpened').map(event => event.market))
      .toEqual(['bankerPair', 'playerPair']);
    expect(duplicateOpen).toEqual([]);
    expect(closed.map(event => event.type)).toEqual([
      'bettingWindowClosed',
      'bettingWindowClosed',
    ]);
    expect(closed.filter(event => event.type === 'bettingWindowClosed').map(event => event.market))
      .toEqual(['bankerPair', 'playerPair']);
  });

  it('marks a window unobservable when the first live snapshot arrives after cards appear', () => {
    // Given: the first observable state for a round is already the post-window deal phase.
    const parser = new MstromRuntimeParser();

    // When: the runtime reports gmstatus=2 before any gmstatus=1 snapshot was observed.
    const events = parser.parse(snapshot({ gmstatus: 2 }));
    const closes = events.filter(event => event.type === 'bettingWindowClosed');

    // Then: each pair market receives a close event explicitly marked as unobservable.
    expect(closes).toEqual([
      expect.objectContaining({ market: 'bankerPair', openingObserved: false }),
      expect.objectContaining({ market: 'playerPair', openingObserved: false }),
    ]);
    expect(events.some(event => event.type === 'bettingWindowOpened')).toBe(false);
  });

  it('emits cards incrementally and waits for a complete baccarat hand before settlement', () => {
    const parser = new MstromRuntimeParser();
    const first = parser.parse(snapshot());
    expect(first.map(event => event.type)).toEqual([
      'newShoeSignal',
      'cardObserved',
      'cardObserved',
      'cardObserved',
      'cardObserved',
    ]);
    const newShoe = first[0];
    if (newShoe === undefined || newShoe.type !== 'newShoeSignal') {
      throw new Error('runtime parser did not emit a new-shoe signal first');
    }
    expect(newShoe.profile?.autoConfirmNewShoe).toBe(true);
    expect(first.some(event => event.type === 'handSettled')).toBe(false);

    const second = parser.parse(snapshot({
      playerScore: 3,
      playerCards: [0x38, 0x12, 0x13],
      bankerCards: [0x39, 0x05, 0x0b],
      capturedAt: '2026-08-22T15:30:20.000Z',
    }));
    expect(second.map(event => event.type)).toEqual([
      'cardObserved',
      'cardObserved',
      'handSettled',
    ]);
    const positions = [...first, ...second]
      .filter(event => event.type === 'cardObserved')
      .map(event => event.position);
    expect(positions).toEqual([
      'player:0', 'player:1', 'banker:0', 'banker:1', 'player:2', 'banker:2',
    ]);
  });

  it('deduplicates repeated snapshots while allowing identical cards in different slots', () => {
    const parser = new MstromRuntimeParser();
    const raw = snapshot({
      roundId: 'GD065268221PAIR',
      playerScore: 3,
      bankerScore: 6,
      playerCards: [0x11, 0x11, 0x21],
      bankerCards: [0x23, 0x23],
    });
    const first = parser.parse(raw);
    const cards = first.filter(event => event.type === 'cardObserved');
    expect(cards).toHaveLength(5);
    expect(cards[0]?.card).toEqual(cards[1]?.card);
    expect(cards[0]?.position).not.toBe(cards[1]?.position);
    expect(parser.parse(raw)).toEqual([]);
  });

  it('rejects conflicting slot rewrites without partially observing later cards', () => {
    const parser = new MstromRuntimeParser();
    parser.parse(snapshot());

    expect(parser.parse(snapshot({
      playerScore: 2,
      playerCards: [0x37, 0x12, 0x13],
      bankerCards: [0x39, 0x05, 0x0b],
    }))).toEqual([]);

    const valid = parser.parse(snapshot({
      playerScore: 3,
      playerCards: [0x38, 0x12, 0x13],
      bankerCards: [0x39, 0x05, 0x0b],
    }));
    expect(valid.map(event => event.type)).toEqual([
      'cardObserved',
      'cardObserved',
      'handSettled',
    ]);
  });

  it('resets slot tracking when the round id changes', () => {
    const parser = new MstromRuntimeParser();
    parser.parse(snapshot());
    const next = parser.parse(snapshot({ roundId: 'GD065268221A9' }));
    expect(next.filter(event => event.type === 'cardObserved')).toHaveLength(4);
  });

  it('does not settle impossible third-card combinations', () => {
    const parser = new MstromRuntimeParser();
    const events = parser.parse(snapshot({
      roundId: 'GD065268221INVALID',
      playerScore: 3,
      bankerScore: 7,
      playerCards: [0x02, 0x03, 0x08],
      bankerCards: [0x01, 0x02, 0x04],
    }));

    expect(events.some(event => event.type === 'handSettled')).toBe(false);
  });

  it('confirms a physical shoe from runtime game status 11 without exposing hidden cards', () => {
    const parser = new MstromRuntimeParser();
    const hidden = snapshot({
      gmstatus: 11,
      playerCards: [],
      bankerCards: [],
    });

    const first = parser.parse(hidden);
    expect(first).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        baseline: 'physical-shoe',
        tableId: 'D065',
      }),
    ]);
    expect(first.some(event => event.type === 'cardObserved')).toBe(false);
    expect(parser.parse(hidden)).toEqual([]);
  });

  it('rejects malformed or hidden-state observations', () => {
    const parser = new MstromRuntimeParser();
    expect(parser.parse('{')).toEqual([]);
    expect(parser.parse(snapshot({ gameType: 'ROU' }))).toEqual([]);
    expect(parser.parse(snapshot({ gmstatus: -1 }))).toEqual([]);
    expect(parser.parse(snapshot({ playerCards: [0] }))).toEqual([]);
    expect(parser.parse(snapshot({ playerCards: [0x01, 0x02, 0x03, 0x04] }))).toEqual([]);
  });
});






describe('mstrom runtime monitor sessions', () => {
  it('starts every parser attach with an isolated unknown-baseline shoe', () => {
    const firstEvents = new MstromRuntimeParser().parse(snapshot({ roundId: 'GD065268221SESSION1' }));
    const secondEvents = new MstromRuntimeParser().parse(snapshot({ roundId: 'GD065268221SESSION2' }));
    const firstShoe = firstEvents.find(event => event.type === 'newShoeSignal');
    const secondShoe = secondEvents.find(event => event.type === 'newShoeSignal');

    expect(firstShoe).toMatchObject({ baseline: 'unknown-monitor-session' });
    expect(secondShoe).toMatchObject({ baseline: 'unknown-monitor-session' });
    expect(firstShoe?.shoeId).not.toBe(secondShoe?.shoeId);
    expect(secondEvents.map(event => event.eventId)).not.toEqual(firstEvents.map(event => event.eventId));
  });
});
