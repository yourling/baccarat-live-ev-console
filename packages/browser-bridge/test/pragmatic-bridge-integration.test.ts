import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@baccarat/contracts';
import { BrowserBridgeServer } from '../src/server.js';

function capture(tables: Array<Record<string, unknown>>, observedAt: string): Record<string, unknown> {
  return {
    kind: 'networkCapture',
    source: 'baccarat-bridge-pragmatic-state',
    url: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/',
    direction: 'recv',
    encoding: 'text',
    data: JSON.stringify({ version: 1, view: 'multi', observedAt, tables }),
  };
}

function protocolCapture(kind: string, value: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'networkCapture',
    source: 'baccarat-bridge-pragmatic-ws',
    url: 'wss://gs24.pragmaticplaylive.net/game',
    direction: 'recv',
    encoding: 'text',
    data: JSON.stringify({ [kind]: value }),
  };
}

describe('Pragmatic bridge integration', () => {
  it('discovers more than forty protocol tables and exports a selected table without rendered tiles', async () => {
    const tableIds = Array.from({ length: 64 }, (_, index) =>
      `pragmatictable${String(index).padStart(2, '0')}`);
    const server = new BrowserBridgeServer({ selectedTableIds: [tableIds[17]!] });
    tableIds.forEach((tableId, index) => {
      server.ingestClientMessage(protocolCapture('game', {
        table: tableId, id: `round-${index}`, seq: index * 10 + 1,
      }));
      server.ingestClientMessage(protocolCapture('timer', {
        table: tableId, id: `round-${index}`, value: '12', seq: index * 10 + 2,
      }));
      server.ingestClientMessage(protocolCapture('betsopen', {
        table: tableId, game: `round-${index}`, seq: index * 10 + 3,
      }));
    });

    expect(server.getDiscoveredRooms().find(room => room.roomId === 'dafabet-pragmatic')?.tables)
      .toHaveLength(64);
    expect(server.getRooms().find(room => room.roomId === 'dafabet-pragmatic')?.tables
      .map(table => table.tableId)).toEqual([tableIds[17]]);

    const feed = server.openTable('dafabet-pragmatic', tableIds[17]!);
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();
    expect(events.map(event => event.type)).toEqual([
      'newShoeSignal', 'bettingWindowOpened', 'bettingWindowOpened',
    ]);
    await server.close();
  });

  it('hydrates a Pragmatic table added after discovery and an earlier unselected snapshot', async () => {
    const tableId = 'tobcbaccaragen92';
    const server = new BrowserBridgeServer({ selectedTableIds: ['D066'] });
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'dafabet-pragmatic',
        displayName: 'Dafabet Pragmatic Play',
        tables: [{
          tableId,
          displayName: '粤语极速百家乐',
          roundId: '17260818724',
          gameCount: 72,
        }],
      },
    });
    expect(server.getDiscoveredRooms()[0]?.tables[0]).toEqual(expect.objectContaining({
      tableId,
      displayName: '粤语极速百家乐',
      roundId: '17260818724',
      gameCount: 72,
    }));
    server.ingestClientMessage(protocolCapture('timer', {
      table: tableId, id: '17260818724', value: '9', seq: 2,
    }));
    server.ingestClientMessage(protocolCapture('betsopen', {
      table: tableId, game: '17260818724', seq: 3,
    }));

    server.setSelectedTableIds([tableId]);
    expect(server.getRooms()[0]?.tables.map(table => table.tableId)).toEqual([tableId]);
    const feed = server.openTable('dafabet-pragmatic', tableId);
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();

    expect(events.map(event => event.type)).toEqual([
      'newShoeSignal',
      'bettingWindowOpened',
      'bettingWindowOpened',
    ]);
    await server.close();
  });

  it('keeps all discovered tables selectable and exports selected-table lifecycle events', async () => {
    const tableId = 'tobcbaccaragen92';
    const server = new BrowserBridgeServer({ selectedTableIds: [tableId] });
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'dafabet-pragmatic',
        displayName: 'Dafabet Pragmatic Play',
        tables: [{ tableId }, { tableId: 'speedbca14gesbc1' }],
      },
    });

    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).toEqual([
      tableId,
      'speedbca14gesbc1',
    ]);
    expect(server.getRooms()[0]?.tables.map(table => table.tableId)).toEqual([tableId]);

    server.ingestClientMessage(protocolCapture('betsopen', {
      table: tableId, game: '17260818724', seq: 10,
    }));
    server.ingestClientMessage(protocolCapture('card', {
      table: tableId, game: '17260818724', sc: '3S0', place: 'player', seq: 11,
    }));
    server.ingestClientMessage(protocolCapture('card', {
      table: tableId, game: '17260818724', sc: '6C1', place: 'player', seq: 12,
    }));
    server.ingestClientMessage(protocolCapture('card', {
      table: tableId, game: '17260818724', sc: '5H2', place: 'banker', seq: 13,
    }));
    server.ingestClientMessage(protocolCapture('card', {
      table: tableId, game: '17260818724', sc: '8D3', place: 'banker', seq: 14,
    }));
    server.ingestClientMessage(protocolCapture('betsclosed', {
      table: tableId, game: '17260818724', seq: 15,
    }));
    server.ingestClientMessage(protocolCapture('gameresult', {
      table: tableId, game: '17260818724', seq: 16,
    }));

    const feed = server.openTable('dafabet-pragmatic', tableId);
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();
    expect(events.map(event => event.type)).toEqual([
      'newShoeSignal',
      'bettingWindowOpened',
      'bettingWindowOpened',
      'cardObserved',
      'cardObserved',
      'cardObserved',
      'cardObserved',
      'bettingWindowClosed',
      'bettingWindowClosed',
      'handSettled',
    ]);

    server.ingestClientMessage(protocolCapture('betsopen', {
      table: tableId, game: '17260821524', seq: 20,
    }));
    server.ingestClientMessage(protocolCapture('timer', {
      table: tableId, id: '17260821524', value: '9', seq: 21,
    }));
    await feed.flush();

    expect(events).toContainEqual(expect.objectContaining({
      type: 'handSettled',
      tableId,
      handId: '17260818724',
      outcomes: { playerPair: false, bankerPair: false },
    }));
    expect(events.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(6);

    server.beginMonitorSession();
    server.ingestClientMessage(protocolCapture('timer', {
      table: tableId, id: '17260821524', value: '8', seq: 2,
    }));
    server.ingestClientMessage(protocolCapture('betsopen', {
      table: tableId, game: '17260821524', seq: 3,
    }));
    const recoveredFeed = server.openTable('dafabet-pragmatic', tableId);
    const recoveredEvents: NormalizedEvent[] = [];
    await recoveredFeed.start({ onBatch: batch => { recoveredEvents.push(...batch.events); } });
    await recoveredFeed.flush();
    expect(recoveredEvents.map(event => event.type)).toEqual([
      'newShoeSignal',
      'bettingWindowOpened',
      'bettingWindowOpened',
    ]);

    await server.close();
  });

  it('settles protocol cards even when a later DOM snapshot is incomplete', async () => {
    const tableId = 'h22z8qhp17sa0vkh';
    const server = new BrowserBridgeServer({ selectedTableIds: [tableId] });
    server.ingestClientMessage(protocolCapture('betsopen', {
      table: tableId, game: '16387761010', seq: 10,
    }));
    server.ingestClientMessage(protocolCapture('card', {
      table: tableId, game: '16387761010', sc: 'QS3', place: 'player', seq: 11,
    }));
    server.ingestClientMessage(protocolCapture('card', {
      table: tableId, game: '16387761010', sc: '9H2', place: 'player', seq: 12,
    }));
    server.ingestClientMessage(protocolCapture('card', {
      table: tableId, game: '16387761010', sc: '3S1', place: 'banker', seq: 13,
    }));
    server.ingestClientMessage(protocolCapture('timer', {
      table: tableId, id: '16387761010', value: '0', seq: 20,
    }));
    server.ingestClientMessage(protocolCapture('betsclosed', {
      table: tableId, game: '16387761010', seq: 21,
    }));
    server.ingestClientMessage(protocolCapture('cardinc', {
      table: tableId, game: '16387761010', sc: '7D0', place: 'banker', seq: 14,
    }));
    server.ingestClientMessage(capture([{
      tableId,
      roundId: '16387761010',
      bettingOpen: false,
      playerCards: ['QS'],
      bankerCards: ['3S'],
      visible: true,
      source: 'dom',
    }], '2026-08-30T09:57:20.000Z'));

    const feed = server.openTable('dafabet-pragmatic', tableId);
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'handSettled',
      tableId,
      handId: '16387761010',
      bankerCards: [
        expect.objectContaining({ rank: '3', suit: 'S' }),
        expect.objectContaining({ rank: '7', suit: 'D' }),
      ],
    }));
    await server.close();
  });

  it('does not turn DOM snapshots into card or window events', async () => {
    const tableId = 'h22z8qhp17sa0vkh';
    const server = new BrowserBridgeServer({ selectedTableIds: [tableId] });
    server.ingestClientMessage(capture([{
      tableId,
      roundId: '16387761010',
      bettingOpen: true,
      countdown: 8,
      playerCards: ['QS', '9H'],
      bankerCards: ['3S', '7D'],
      visible: true,
      source: 'dom',
    }], '2026-08-30T10:00:00.000Z'));
    const feed = server.openTable('dafabet-pragmatic', tableId);
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();
    expect(events).toEqual([]);
    await server.close();
  });

  it('opens a physical shoe from a DOM road count after protocol hands piled up', async () => {
    const tableId = 'spto21bctorobc21';
    const server = new BrowserBridgeServer({ selectedTableIds: [tableId] });
    for (let index = 0; index < 24; index += 1) {
      const round = `164073249${String(index).padStart(2, '0')}`;
      const seq = index * 10;
      server.ingestClientMessage(protocolCapture('game', { table: tableId, id: round, seq: seq + 1 }));
      server.ingestClientMessage(protocolCapture('betsopen', { table: tableId, game: round, seq: seq + 2 }));
      server.ingestClientMessage(protocolCapture('card', {
        table: tableId, game: round, sc: 'QS3', place: 'player', seq: seq + 3,
      }));
      server.ingestClientMessage(protocolCapture('card', {
        table: tableId, game: round, sc: '9H2', place: 'player', seq: seq + 4,
      }));
      server.ingestClientMessage(protocolCapture('card', {
        table: tableId, game: round, sc: '3S1', place: 'banker', seq: seq + 5,
      }));
      server.ingestClientMessage(protocolCapture('card', {
        table: tableId, game: round, sc: '7D0', place: 'banker', seq: seq + 6,
      }));
      server.ingestClientMessage(protocolCapture('gameresult', {
        table: tableId, game: round, seq: seq + 7, player: ['QS3', '9H2'], banker: ['3S1', '7D0'],
      }));
    }

    const feed = server.openTable('dafabet-pragmatic', tableId);
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();
    const shoesBefore = events.filter(event => event.type === 'newShoeSignal').length;
    expect(shoesBefore).toBe(1);

    server.ingestClientMessage(capture([{
      tableId,
      roundId: '16407324910',
      gameCount: 5,
      bettingOpen: true,
      countdown: 6,
      playerCards: ['2C', '2S'],
      bankerCards: ['AH', '6D'],
      visible: true,
      source: 'dom',
    }], '2026-08-31T12:00:00.000Z'));
    await feed.flush();

    const shoes = events.filter(event => event.type === 'newShoeSignal');
    expect(shoes).toHaveLength(2);
    expect(shoes[1]).toEqual(expect.objectContaining({
      type: 'newShoeSignal',
      baseline: 'physical-shoe',
      shoeId: `pragmatic-${tableId}-2`,
    }));
    expect(events.filter(event => event.type === 'cardObserved' && event.shoeId === `pragmatic-${tableId}-2`))
      .toHaveLength(0);

    server.ingestClientMessage(capture([{
      tableId,
      roundId: '16407324910',
      gameCount: 5,
      bettingOpen: true,
      countdown: 5,
      visible: true,
      source: 'dom',
    }], '2026-08-31T12:00:01.000Z'));
    await feed.flush();
    expect(events.filter(event => event.type === 'newShoeSignal')).toHaveLength(2);

    await server.close();
  });
});
