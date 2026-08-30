import { describe, expect, it } from 'vitest';
import { MstromProtocolEventParser } from '../src/mstrom-protocol-events.js';
import { parseMstromFrame } from '../src/mstrom-protocol.js';
import fixtures from '../../../.tmp-mstrom/card-research/15-fixtures.json';

const EXPLICIT_SHUFFLE_SNAPSHOT_BASE64 = 'AAIQFgAAADEAAedJAABOMDcyIAQoCAoDQkFDEg1HTjA3MjI2ODIxMTJNGAtAGZABAQ==';

function fixture(id: string): Uint8Array {
  const sample = fixtures.find(value => value.id === id);
  if (!sample) throw new Error(`fixture not found: ${id}`);
  return Uint8Array.from(Buffer.from(sample.base64, 'base64'));
}

function resetShoeCodeFrame(tableId: string, seq = 42): Uint8Array {
  const table = new TextEncoder().encode(tableId);
  const bytes = new Uint8Array(12 + table.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 2, false);
  view.setUint16(2, 0x001c, false);
  view.setUint32(4, bytes.length, false);
  view.setUint32(8, seq, false);
  bytes.set(table, 12);
  return bytes;
}

describe('mstrom protocol event parser', () => {
  it('opens both pair markets during BAC betting status and deduplicates repeats', () => {
    const parsed = parseMstromFrame(fixture('bcst-phase1-betting-01'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.frame.kind !== 'type2' || parsed.frame.roundId === undefined) {
      throw new Error('bcst betting fixture must contain a platform round ID');
    }

    const parser = new MstromProtocolEventParser();
    const first = parser.ingest(parsed.frame, '2026-08-22T18:00:00.000Z');
    expect(first.map(event => event.type)).toEqual([
      'newShoeSignal',
      'bettingWindowOpened',
      'bettingWindowOpened',
    ]);
    const opened = first.filter(event => event.type === 'bettingWindowOpened');
    expect(opened.map(event => event.market)).toEqual(['bankerPair', 'playerPair']);
    expect(opened.map(event => event.handId)).toEqual([parsed.frame.roundId, parsed.frame.roundId]);
    expect(first[0]).toEqual(expect.objectContaining({
      type: 'newShoeSignal',
      baseline: 'unknown-monitor-session',
      shoeId: expect.stringContaining(`-${parsed.frame.tableId}-attach`),
    }));
    expect(parser.ingest(parsed.frame, '2026-08-22T18:00:01.000Z')).toEqual([]);
  });

  it('closes both pair markets at game status 2 for the active hand', () => {
    const betting = parseMstromFrame(fixture('bcst-phase1-betting-01'));
    const closed = parseMstromFrame(fixture('bcst-phase2-closed-02'));
    expect(betting.ok && closed.ok).toBe(true);
    if (!betting.ok || !closed.ok || betting.frame.kind !== 'type2' || closed.frame.kind !== 'type2') return;

    const parser = new MstromProtocolEventParser();
    parser.ingest(betting.frame, '2026-08-22T18:00:00.000Z');
    const matchingClosed = { ...closed.frame, tableId: betting.frame.tableId, roundId: betting.frame.roundId };
    const events = parser.ingest(matchingClosed, '2026-08-22T18:00:05.000Z');
    expect(events.map(event => event.type)).toEqual(['bettingWindowClosed', 'bettingWindowClosed']);
  });

  it('does not emit a settlement when protocol winning-playtype data has no runtime cards', () => {
    // Given: a live BAC round opened normally, then the protocol published its winning markets without cards.
    const betting = parseMstromFrame(fixture('bcst-phase1-betting-01'));
    expect(betting.ok).toBe(true);
    if (!betting.ok || betting.frame.kind !== 'type2' || betting.frame.roundId === undefined) return;

    const parser = new MstromProtocolEventParser();
    parser.ingest(betting.frame, '2026-08-22T18:00:00.000Z');
    const result = {
      ...betting.frame,
      gameStatus: 0,
      phase: 0,
      bankerScore: 7,
      playerScore: 3,
      resultCode: 1,
      resultPayload: Uint8Array.from([1, 4, 5, 15, 6]),
    };

    // When: the result frame is ingested without any runtime-state card snapshot.
    const events = parser.ingest(result, '2026-08-22T18:00:10.000Z');

    // Then: only the betting windows close; settlement waits for the runtime card snapshot.
    expect(events.map(event => event.type)).toEqual([
      'bettingWindowClosed',
      'bettingWindowClosed',
    ]);
    expect(events.some(event => event.type === 'handSettled')).toBe(false);
    expect(parser.ingest(result, '2026-08-22T18:00:11.000Z')).toEqual([]);
  });

  it('confirms a physical shoe from the explicit GAME_SNAPSHOT_PROTO shuffle status and deduplicates replays', () => {
    const parsed = parseMstromFrame(Uint8Array.from(Buffer.from(EXPLICIT_SHUFFLE_SNAPSHOT_BASE64, 'base64')));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.kind !== 'type2' || parsed.frame.roundId === undefined) return;
    expect(parsed.frame.x16).toBe(0x1016);
    expect(parsed.frame.gameStatus).toBe(11);

    const parser = new MstromProtocolEventParser();
    const first = parser.ingest(parsed.frame, '2026-08-23T13:05:00.000Z');
    expect(first).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        baseline: 'physical-shoe',
        tableId: 'N072',
      }),
    ]);
    expect(parser.ingest(parsed.frame, '2026-08-23T13:05:01.000Z')).toEqual([]);

    const resumed = {
      ...parsed.frame,
      gameStatus: 1,
      phase: 1,
      roundId: 'GN0722682112N',
    };
    expect(parser.ingest(resumed, '2026-08-23T13:05:02.000Z').map(event => event.type)).toEqual([
      'bettingWindowOpened',
      'bettingWindowOpened',
    ]);
    expect(parser.ingest(parsed.frame, '2026-08-23T13:05:03.000Z')).toEqual([]);
  });

  it('confirms a physical shoe from the explicit RESET_SHOECODE_R response', () => {
    const parsed = parseMstromFrame(resetShoeCodeFrame('D067'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const parser = new MstromProtocolEventParser();
    const first = parser.ingest(parsed.frame, '2026-08-23T13:05:00.000Z');
    expect(first).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        baseline: 'physical-shoe',
        tableId: 'D067',
      }),
    ]);
    expect(parser.ingest(parsed.frame, '2026-08-23T13:05:01.000Z')).toEqual([]);
  });

  it('does not rotate on ordinary inter-round empty type3 states even after a large counter drop', () => {
    const longStatus = parseMstromFrame(fixture('status-multimarket-02'));
    const shortStatus = parseMstromFrame(fixture('status-empty-len20-01'));
    expect(longStatus.ok && shortStatus.ok).toBe(true);
    if (!longStatus.ok || !shortStatus.ok || longStatus.frame.kind !== 'type3' || shortStatus.frame.kind !== 'type3') return;

    const parser = new MstromProtocolEventParser();
    const long = {
      ...longStatus.frame,
      tableId: 'D065',
      gameType: 'BAC',
      status: { ...longStatus.frame.status, statusLength: 104, counterA: 165 },
    };
    const empty = {
      ...shortStatus.frame,
      tableId: 'D065',
      gameType: 'BAC',
      status: { ...shortStatus.frame.status, statusLength: 20, counterA: 109 },
    };

    expect(parser.ingest(long, '2026-08-23T13:00:00.000Z')).toEqual([]);
    for (const [index, counterA] of [109, 109, 110, 111].entries()) {
      expect(parser.ingest(
        { ...empty, status: { ...empty.status, counterA } },
        `2026-08-23T13:00:0${index + 1}.000Z`,
      )).toEqual([]);
    }
  });

  it('does not promote the D067 type3-only empty-state pattern without an explicit shuffle message', () => {
    const longStatus = parseMstromFrame(fixture('status-multimarket-02'));
    const shortStatus = parseMstromFrame(fixture('status-empty-len20-01'));
    expect(longStatus.ok && shortStatus.ok).toBe(true);
    if (!longStatus.ok || !shortStatus.ok || longStatus.frame.kind !== 'type3' || shortStatus.frame.kind !== 'type3') return;

    const parser = new MstromProtocolEventParser();
    const long = {
      ...longStatus.frame,
      tableId: 'D067',
      gameType: 'BAC',
      status: { ...longStatus.frame.status, statusLength: 56, counterA: 36 },
    };
    const empty = {
      ...shortStatus.frame,
      tableId: 'D067',
      gameType: 'BAC',
      status: { ...shortStatus.frame.status, statusLength: 20, counterA: 36 },
    };

    expect(parser.ingest(long, '2026-08-23T13:00:00.000Z')).toEqual([]);
    expect(parser.ingest(empty, '2026-08-23T13:00:01.000Z')).toEqual([]);
    expect(parser.ingest(empty, '2026-08-23T13:00:02.000Z')).toEqual([]);
    expect(parser.ingest(
      { ...empty, status: { ...empty.status, counterA: 16 } },
      '2026-08-23T13:00:03.000Z',
    )).toEqual([]);
  });

  it('does not reuse monitor-session event IDs across parser instances', () => {
    const parsed = parseMstromFrame(fixture('bcst-phase1-betting-01'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const first = new MstromProtocolEventParser().ingest(parsed.frame, '2026-08-22T18:00:00.000Z');
    const second = new MstromProtocolEventParser().ingest(parsed.frame, '2026-08-22T18:00:00.000Z');
    expect(second.map(event => event.eventId)).not.toEqual(first.map(event => event.eventId));
  });

  it('does not manufacture pair windows from roads, non-BAC games, or unsupported statuses', () => {
    const parser = new MstromProtocolEventParser();
    const road = parseMstromFrame(fixture('road-snapshot-01'));
    const roulette = parseMstromFrame(fixture('game-rou-03'));
    const betting = parseMstromFrame(fixture('bcst-phase1-betting-01'));
    expect(road.ok && roulette.ok && betting.ok).toBe(true);
    if (!road.ok || !roulette.ok || !betting.ok || betting.frame.kind !== 'type2') return;

    expect(parser.ingest(road.frame, '2026-08-22T18:00:00.000Z')).toEqual([]);
    expect(parser.ingest(roulette.frame, '2026-08-22T18:00:00.000Z')).toEqual([]);
    expect(parser.ingest(
      { ...betting.frame, gameStatus: 99, phase: 99 },
      '2026-08-22T18:00:00.000Z',
    )).toEqual([]);
  });
});
