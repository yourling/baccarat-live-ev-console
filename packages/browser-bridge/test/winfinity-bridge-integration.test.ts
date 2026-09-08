import { describe, expect, it } from 'vitest';
import {
  BrowserBridgeServer,
  DAFABET_BG_ROOM_ID,
  DAFABET_PRAGMATIC_ROOM_ID,
  DAFABET_WINFINITY_ROOM_ID,
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
