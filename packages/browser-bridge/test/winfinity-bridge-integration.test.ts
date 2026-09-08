import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@baccarat/contracts';
import {
  BrowserBridgeServer,
  DAFABET_BG_ROOM_ID,
  DAFABET_PRAGMATIC_ROOM_ID,
  DAFABET_WINFINITY_ROOM_ID,
  WINFINITY_WS_ALIAS_BUFFER_LIMIT,
} from '../src/index.js';

const VENDOR = '638f56dc65729f90d0636fb0';

function wnfState() {
  return {
    kind: 'networkCapture' as const,
    source: 'baccarat-bridge-winfinity-state',
    url: 'https://lobby.youngpoisson.xyz/',
    direction: 'recv' as const,
    encoding: 'text' as const,
    data: JSON.stringify({
      version: 1,
      observedAt: '2026-09-09T12:00:00.000Z',
      tables: [{
        tableId: 'tyn-bac8',
        vendorTableId: VENDOR,
        streamId: 'tyn-bac8',
        displayName: 'Tao Yuan Baccarat 8',
        gameCount: 12,
        source: 'hall',
      }],
    }),
  };
}

function wnfWs(type: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 'networkCapture' as const,
    source: 'baccarat-bridge-winfinity-ws',
    url: 'https://baccarat-multitable.youngpoisson.xyz/',
    direction: 'recv' as const,
    encoding: 'text' as const,
    data: JSON.stringify({
      id: 'e1',
      timestamp: '1788889925756',
      type,
      meta: {
        tableId: VENDOR,
        round: { id: 'hand-1', startedAt: '1788889925756', shoeId: 'shoe-a' },
      },
      ...extra,
    }),
  };
}

function wnfTablesList(extra: Record<string, unknown> = {}) {
  return {
    kind: 'networkCapture' as const,
    source: 'baccarat-bridge-winfinity-ws',
    url: 'https://baccarat-multitable.youngpoisson.xyz/',
    direction: 'recv' as const,
    encoding: 'text' as const,
    data: JSON.stringify({
      type: 'TABLES_LIST',
      ...extra,
    }),
  };
}

function queenCard() {
  return {
    cards: {
      cards: [{
        id: 'card-1',
        card: { rank: 'QUEEN', suit: 'DIAMOND' },
        position: { area: 'PLAYER', order: 'ORDER_LEFT' },
      }],
      allCards: [],
    },
  };
}

describe('Winfinity bridge integration', () => {
  it('ingests Winfinity frames into dafabet-winfinity without creating pragmatic or bg rooms', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfState());
    server.ingestClientMessage(wnfWs('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const rooms = server.getDiscoveredRooms();
    expect(rooms.map(room => room.roomId)).toEqual([DAFABET_WINFINITY_ROOM_ID]);
    expect(rooms[0]?.tables.map(table => table.tableId)).toEqual(['tyn-bac8']);
    expect(server.getRooms().find(room => room.roomId === DAFABET_PRAGMATIC_ROOM_ID)).toBeUndefined();
    expect(server.getRooms().find(room => room.roomId === DAFABET_BG_ROOM_ID)).toBeUndefined();
    expect(server.shoeEvidence('tyn-bac8')).toEqual({ reason: 'attach' });
  });

  it('does not treat a bare vendor hex as a pragmatic table when aliased', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfState());
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).not.toContain(VENDOR);
  });

  it('uses the stream id when WS frames are buffered until lobby alias arrives', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfWs('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(server.getDiscoveredRooms()).toEqual([]);
    expect(server.shoeEvidence('tyn-bac8')).toBeUndefined();
    server.ingestClientMessage(wnfState());
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).toEqual(['tyn-bac8']);
    expect(server.shoeEvidence('tyn-bac8')).toEqual({ reason: 'attach' });
  });

  it('uses the stream id when lobby state locks the alias before WS', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfState());
    server.ingestClientMessage(wnfWs('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).toEqual(['tyn-bac8']);
  });

  it('discovers wnf fallback after WS buffer fills without an alias', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: [`wnf-${VENDOR}`] });
    for (let index = 0; index < WINFINITY_WS_ALIAS_BUFFER_LIMIT; index += 1) {
      server.ingestClientMessage(wnfWs('GAME_STATE_CHANGED', {
        state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
      }));
    }
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId))
      .toEqual([`wnf-${VENDOR}`]);
    expect(server.shoeEvidence(`wnf-${VENDOR}`)).toEqual({ reason: 'attach' });
  });

  it('does not rename a table after WS-only discovery locked the fallback', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: [`wnf-${VENDOR}`] });
    for (let index = 0; index < WINFINITY_WS_ALIAS_BUFFER_LIMIT; index += 1) {
      server.ingestClientMessage(wnfWs('GAME_STATE_CHANGED', {
        state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
      }));
    }
    server.ingestClientMessage(wnfState());
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId))
      .toEqual([`wnf-${VENDOR}`]);
  });

  it('uses the stream id when TABLES_LIST arrives before WS game frames', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfTablesList({
      tables: [{ tableId: VENDOR, streamId: 'tyn-bac8' }],
    }));
    server.ingestClientMessage(wnfWs('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).toEqual(['tyn-bac8']);
    expect(server.shoeEvidence('tyn-bac8')).toEqual({ reason: 'attach' });
  });

  it('flushes buffered WS onto tyn-bac8 after TABLES_LIST', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfWs('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(server.getDiscoveredRooms()).toEqual([]);
    server.ingestClientMessage(wnfTablesList({
      payload: { tables: [{ objectId: VENDOR, streamId: 'TYN-BAC8' }] },
    }));
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).toEqual(['tyn-bac8']);
    expect(server.shoeEvidence('tyn-bac8')).toEqual({ reason: 'attach' });
  });

  it('binds operator shoe id after confirmPhysicalShoe', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfState());
    server.ingestClientMessage(wnfWs('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    server.confirmPhysicalShoe('tyn-bac8');
    server.ingestClientMessage(wnfWs('CARDS_TAKEN', queenCard()));
    const feed = server.openTable(DAFABET_WINFINITY_ROOM_ID, 'tyn-bac8');
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();
    expect(events.filter(event => event.type === 'cardObserved')).toEqual([
      expect.objectContaining({
        type: 'cardObserved',
        tableId: 'tyn-bac8',
        shoeId: 'wnf-tyn-bac8-operator',
      }),
    ]);
    await server.close();
  });

  it('does not refresh table observation from lobby state snapshots', async () => {
    const server = new BrowserBridgeServer({
      selectedTableIds: ['tyn-bac8'],
      tableStaleAfterMs: 1_000,
    });
    server.ingestClientMessage(wnfState());
    const feed = server.openTable(DAFABET_WINFINITY_ROOM_ID, 'tyn-bac8');
    await feed.start({ onBatch: () => {} });
    const observedAt = feed.health().lastObservationAt;
    await new Promise(resolve => setTimeout(resolve, 20));
    server.ingestClientMessage(wnfState());
    expect(feed.health().lastObservationAt).toBe(observedAt);
    const checkFreshness = Reflect.get(feed, 'checkFreshness');
    if (typeof checkFreshness !== 'function') throw new Error('freshness watchdog unavailable');
    Reflect.apply(checkFreshness, feed, [Date.now() + 2_000]);
    expect(feed.health().state).toBe('DISCONNECTED');
    server.ingestClientMessage(wnfState());
    expect(feed.health().state).toBe('DISCONNECTED');
    server.ingestClientMessage(wnfWs('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(feed.health().state).toBe('CONNECTED');
    await server.close();
  });

  it('rejects Winfinity operational wagers before sending them to the page', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfState());
    const receipt = await server.requestOperationalWager({
      mode: 'live',
      wager: {
        wagerId: 'w1',
        tableId: 'tyn-bac8',
        shoeId: 'shoe-a',
        handId: 'hand-1',
        market: 'banker',
        amount: 20,
        source: 'manual',
        createdAt: '2026-09-09T12:00:00.000Z',
      },
    });
    expect(receipt).toEqual(expect.objectContaining({
      status: 'REJECTED',
      tableId: 'tyn-bac8',
      raw: expect.objectContaining({ commitStarted: false, reason: 'winfinity-monitor-only' }),
    }));
  });
});
