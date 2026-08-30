import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replayEvents } from '../../ledger-state/src/projection.js';
import { MstromProtocolEventParser } from '../src/mstrom-protocol-events.js';
import { parseMstromFrame } from '../src/mstrom-protocol.js';
import { MstromRuntimeParser } from '../src/mstrom-runtime.js';
import { MstromShoeSessionRegistry } from '../src/mstrom-shoe-session.js';
import protocolFixtures from '../../../.tmp-mstrom/card-research/15-fixtures.json';

type LiveSnapshot = {
  readonly roundId: string;
  readonly playerCards: readonly number[];
  readonly bankerCards: readonly number[];
  readonly playerScore: number;
  readonly bankerScore: number;
};

function protocolFixture(id: string): Uint8Array {
  const sample = protocolFixtures.find(value => value.id === id);
  if (!sample) throw new Error(`fixture not found: ${id}`);
  return Uint8Array.from(Buffer.from(sample.base64, 'base64'));
}

function readLiveSnapshots(): readonly LiveSnapshot[] {
  return readFileSync(new URL('./fixtures/mstrom-runtime-live.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as LiveSnapshot);
}

describe('captured mstrom runtime snapshots', () => {
  it('uses the same event ids when protocol and runtime both report a betting window', () => {
    const parsed = parseMstromFrame(protocolFixture('bcst-phase1-betting-01'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.kind !== 'type2' || parsed.frame.roundId === undefined) return;

    const tableId = 'D056';
    const roundId = 'GD056268221DEDUP';
    const shoeSessions = new MstromShoeSessionRegistry('runtime-protocol-dedup');
    const protocol = new MstromProtocolEventParser(shoeSessions);
    const runtime = new MstromRuntimeParser(shoeSessions);
    const protocolEvents = protocol.ingest({
      ...parsed.frame,
      tableId,
      roundId,
      gameStatus: 1,
      phase: 1,
    }, '2026-08-25T12:00:00.000Z');
    const runtimeEvents = runtime.parse({
      tableId,
      roundId,
      gameType: 'BAC',
      gmstatus: 1,
      playerScore: null,
      bankerScore: null,
      playerCards: [],
      bankerCards: [],
      capturedAt: '2026-08-25T12:00:00.000Z',
    });

    const protocolWindowIds = protocolEvents
      .filter(event => event.type === 'bettingWindowOpened')
      .map(event => event.eventId);
    const runtimeWindowIds = runtimeEvents
      .filter(event => event.type === 'bettingWindowOpened')
      .map(event => event.eventId);
    expect(runtimeWindowIds).toEqual(protocolWindowIds);
  });

  it('replays real runtime snapshots into cards and settlements', () => {
    const parser = new MstromRuntimeParser();
    for (const snapshot of readLiveSnapshots()) {
      const events = parser.parse(JSON.stringify({
        tableId: 'P001',
        roundId: snapshot.roundId,
        gameType: 'BAC',
        gmstatus: 0,
        playerScore: snapshot.playerScore,
        bankerScore: snapshot.bankerScore,
        playerCards: snapshot.playerCards,
        bankerCards: snapshot.bankerCards,
        capturedAt: '2026-08-22T19:00:00.000Z',
      }));
      const settled = events.find(event => event.type === 'handSettled');
      expect(settled?.type).toBe('handSettled');
      if (settled?.type !== 'handSettled') continue;
      expect(settled.playerCards.map(card => card.raw)).toEqual(snapshot.playerCards.map(value => `0x${value.toString(16).padStart(2, '0')}`));
      expect(settled.bankerCards.map(card => card.raw)).toEqual(snapshot.bankerCards.map(value => `0x${value.toString(16).padStart(2, '0')}`));
      expect(settled.outcomes).toEqual({
        playerPair: snapshot.playerCards[0] !== undefined && snapshot.playerCards[0] % 16 === snapshot.playerCards[1] % 16,
        bankerPair: snapshot.bankerCards[0] !== undefined && snapshot.bankerCards[0] % 16 === snapshot.bankerCards[1] % 16,
      });
    }
  });

  it('replays D056 and D057 protocol-only endings without projection loss, then settles complete runtime cards', () => {
    // Given: D056/D057-style protocol frames can prove the winner but carry no cards.
    const parsed = parseMstromFrame(protocolFixture('bcst-phase1-betting-01'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.kind !== 'type2' || parsed.frame.roundId === undefined) return;

    for (const tableId of ['D056', 'D057']) {
      const roundId = `G${tableId}268221EMPTY`;
      const parser = new MstromProtocolEventParser();
      const betting = {
        ...parsed.frame,
        tableId,
        roundId,
        gameStatus: 1,
        phase: 1,
      };
      const result = {
        ...betting,
        gameStatus: 0,
        phase: 0,
        resultPayload: Uint8Array.from([1, 4, 5]),
      };

      // When: protocol events are replayed through the core projection.
      const protocolEvents = [
        ...parser.ingest(betting, '2026-08-24T02:00:00.000Z'),
        ...parser.ingest(result, '2026-08-24T02:00:10.000Z'),
      ];

      // Then: no illegal empty-card settlement or synthetic connection loss reaches projection.
      expect(protocolEvents.some(event => event.type === 'handSettled')).toBe(false);
      expect(protocolEvents.some(event => event.type === 'connectionLost')).toBe(false);
      const protocolProjection = replayEvents(protocolEvents).get(tableId);
      expect(protocolProjection).toMatchObject({
        tableId,
        currentHandId: roundId,
        status: 'TRACKING',
        connectionStatus: 'CONNECTED',
      });
    }

    const runtime = new MstromRuntimeParser();
    const firstRuntimeSnapshot = {
      tableId: 'D056',
      roundId: 'GD056268221RUNTIME',
      gameType: 'BAC',
      gmstatus: 0,
      playerScore: 0,
      bankerScore: 4,
      playerCards: [0x38, 0x12],
      bankerCards: [0x39, 0x05],
      capturedAt: '2026-08-24T02:01:00.000Z',
    };
    const secondRuntimeSnapshot = {
      ...firstRuntimeSnapshot,
      playerScore: 3,
      playerCards: [0x38, 0x12, 0x13],
      bankerCards: [0x39, 0x05, 0x0b],
      capturedAt: '2026-08-24T02:01:02.000Z',
    };

    // When: complete runtime-state cards arrive for the same kind of round.
    const runtimeEvents = [
      ...runtime.parse(firstRuntimeSnapshot),
      ...runtime.parse(secondRuntimeSnapshot),
    ];

    // Then: the real card-bearing settlement remains valid and projectable.
    expect(runtimeEvents.some(event => event.type === 'handSettled')).toBe(true);
    const runtimeProjection = replayEvents(runtimeEvents).get('D056');
    expect(runtimeProjection).toMatchObject({
      tableId: 'D056',
      currentHandId: 'GD056268221RUNTIME',
      handNumber: 1,
      status: 'TRACKING',
      connectionStatus: 'CONNECTED',
    });
  });
});
