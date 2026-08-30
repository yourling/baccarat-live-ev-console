import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@baccarat/contracts';
import { MstromProtocolEventParser } from '../src/mstrom-protocol-events.js';
import { parseMstromFrame } from '../src/mstrom-protocol.js';
import { MstromRuntimeParser } from '../src/mstrom-runtime.js';
import { MstromShoeSessionRegistry } from '../src/mstrom-shoe-session.js';
import { BrowserBridgeServer } from '../src/server.js';
import d067Shuffle from './fixtures/mstrom-d067-shuffle.json';

const EXPLICIT_SHUFFLE_SNAPSHOT_BASE64 = d067Shuffle.base64;

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

describe('mstrom physical-shoe episodes', () => {
  it('rotates once for different verified evidence within one shuffle episode', () => {
    // Given: one table receives RESET first for a physical shuffle.
    const registry = new MstromShoeSessionRegistry('episode-test');
    const reset = registry.confirmVerifiedPhysicalShoe('D067', 'reset-shoecode:42');

    // When: raw and runtime status11 evidence arrive with different identifiers.
    const protocol = registry.confirmVerifiedPhysicalShoe('D067', 'game-snapshot:GD067-shuffle');
    const runtime = registry.confirmVerifiedPhysicalShoe('D067', 'game-snapshot:GD067-runtime-alias');

    // Then: all evidence belongs to the same physical-shoe episode.
    expect(reset.rotated).toBe(true);
    expect(protocol.rotated).toBe(false);
    expect(runtime.rotated).toBe(false);
    expect(runtime.shoe.version).toBe(1);
  });

  it('allows the next physical shoe after ordinary game activity resumes', () => {
    // Given: one verified shuffle episode has already rotated the shoe.
    const registry = new MstromShoeSessionRegistry('episode-resume-test');
    registry.confirmVerifiedPhysicalShoe('D067', 'game-snapshot:GD067-first-shuffle');

    // When: a normal game resumes and a later shuffle is verified.
    registry.observeOrdinaryShoeActivity('D067');
    const next = registry.confirmVerifiedPhysicalShoe('D067', 'game-snapshot:GD067-next-shuffle');
    const delayedDuplicate = registry.confirmVerifiedPhysicalShoe('D067', 'game-snapshot:GD067-first-shuffle');

    // Then: the later physical shoe rotates exactly once and stale evidence stays deduplicated.
    expect(next.rotated).toBe(true);
    expect(next.shoe.version).toBe(2);
    expect(delayedDuplicate.rotated).toBe(false);
    expect(delayedDuplicate.shoe.version).toBe(2);
  });

  it('shares the same episode latch with operator confirmation', () => {
    // Given: the operator confirms the visible shuffle before status11 arrives.
    const registry = new MstromShoeSessionRegistry('operator-episode-test');
    const operator = registry.confirmOperatorPhysicalShoe('D067');

    // When: the protocol reports that same shuffle and the operator clicks again.
    const protocol = registry.confirmVerifiedPhysicalShoe('D067', 'game-snapshot:GD067-shuffle');
    const repeatedOperator = registry.confirmOperatorPhysicalShoe('D067');

    // Then: all three observations retain one physical shoe.
    expect(operator.rotated).toBe(true);
    expect(protocol.rotated).toBe(false);
    expect(repeatedOperator.rotated).toBe(false);
    expect(repeatedOperator.shoe.version).toBe(1);
  });

  it('deduplicates RESET, raw status11, and runtime status11 through shared parsers', () => {
    // Given: all non-visual sources share one table shoe registry.
    const registry = new MstromShoeSessionRegistry('shared-parser-test');
    const protocol = new MstromProtocolEventParser(registry);
    const runtime = new MstromRuntimeParser(registry);
    const reset = parseMstromFrame(resetShoeCodeFrame('D067'));
    const shuffle = parseMstromFrame(
      Uint8Array.from(Buffer.from(EXPLICIT_SHUFFLE_SNAPSHOT_BASE64, 'base64')),
    );
    expect(reset.ok && shuffle.ok).toBe(true);
    if (!reset.ok || !shuffle.ok || shuffle.frame.kind !== 'type2') return;

    // When: three channels describe the same physical shuffle with different evidence IDs.
    const resetEvents = protocol.ingest(reset.frame, '2026-08-24T02:00:00.000Z');
    const protocolEvents = protocol.ingest(shuffle.frame, '2026-08-24T02:00:01.000Z');
    const runtimeEvents = runtime.parse({
      tableId: 'D067',
      roundId: 'GD067-runtime-alias',
      gameType: 'BAC',
      gmstatus: 11,
      playerScore: null,
      bankerScore: null,
      playerCards: [],
      bankerCards: [],
      capturedAt: '2026-08-24T02:00:02.000Z',
    });

    // Then: only the first verified source rotates the physical shoe.
    expect(resetEvents.filter(event => event.type === 'newShoeSignal')).toHaveLength(1);
    expect(protocolEvents).toEqual([]);
    expect(runtimeEvents).toEqual([]);
    expect(registry.current('D067').version).toBe(1);
  });

  it('deduplicates real D067 protocol status11 followed by runtime status11', async () => {
    const events = await captureD067ShuffleEpisode(['protocol', 'runtime']);

    expect(events.filter(event => event.type === 'newShoeSignal')).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'newShoeSignal',
      tableId: d067Shuffle.tableId,
      baseline: 'physical-shoe',
    }));
  });

  it('deduplicates runtime status11 followed by the real D067 protocol frame', async () => {
    const events = await captureD067ShuffleEpisode(['runtime', 'protocol']);

    expect(events.filter(event => event.type === 'newShoeSignal')).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'newShoeSignal',
      tableId: d067Shuffle.tableId,
      baseline: 'physical-shoe',
    }));
  });

  it('parses the real D067 status11 frame when relayed from the current 673ing host alias', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: [d067Shuffle.tableId] });
    const feed = server.openTable('dafabet-live', d067Shuffle.tableId);
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });

    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://live2.673ing.com/game',
      direction: 'recv',
      encoding: 'base64',
      data: d067Shuffle.base64,
    });
    await feed.flush();

    expect(events).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        tableId: d067Shuffle.tableId,
        baseline: 'physical-shoe',
      }),
    ]);
  });

  it('does not emit another shoe when operator confirmation is followed by status11', async () => {
    // Given: a selected table is monitored through the real bridge export.
    const server = new BrowserBridgeServer({ selectedTableIds: ['D067'] });
    const feed = server.openTable('dafabet-live', 'D067');
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });

    // When: the operator confirms once, repeats the click, then runtime status11 arrives.
    server.confirmPhysicalShoe('D067');
    server.confirmPhysicalShoe('D067');
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'D067',
        roundId: 'GD067-operator-shuffle',
        gameType: 'BAC',
        gmstatus: 11,
        playerScore: null,
        bankerScore: null,
        playerCards: [],
        bankerCards: [],
        capturedAt: '2026-08-24T02:01:00.000Z',
      }),
    });
    await feed.flush();

    // Then: downstream receives one semantic new-shoe event.
    expect(events.filter(event => event.type === 'newShoeSignal')).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'newShoeSignal',
      tableId: 'D067',
      baseline: 'physical-shoe',
    }));
  });
});

async function captureD067ShuffleEpisode(
  order: readonly ['protocol', 'runtime'] | readonly ['runtime', 'protocol'],
): Promise<readonly NormalizedEvent[]> {
  const server = new BrowserBridgeServer({ selectedTableIds: [d067Shuffle.tableId] });
  const feed = server.openTable('dafabet-live', d067Shuffle.tableId);
  const events: NormalizedEvent[] = [];
  await feed.start({ onBatch: batch => { events.push(...batch.events); } });

  for (const source of order) {
    if (source === 'protocol') {
      server.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-ws',
        url: 'wss://ty242c.mdvuz.com:5000',
        direction: 'recv',
        encoding: 'base64',
        data: d067Shuffle.base64,
      });
      continue;
    }
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: d067Shuffle.tableId,
        roundId: 'GD067-runtime-alias',
        gameType: 'BAC',
        gmstatus: 11,
        playerScore: null,
        bankerScore: null,
        playerCards: [],
        bankerCards: [],
        capturedAt: d067Shuffle.capturedAt,
      }),
    });
  }
  await feed.flush();
  return events;
}
