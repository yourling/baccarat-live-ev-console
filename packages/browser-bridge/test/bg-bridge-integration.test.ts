import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  BUNDLED_BG_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_TOKEN,
  BG_BET_RUNTIME_REVISION,
  BrowserBridgeServer,
  DAFABET_BG_ROOM_ID,
  DAFABET_PRAGMATIC_ROOM_ID,
} from '../src/index.js';

function bgState(tables: ReadonlyArray<Record<string, unknown>>) {
  return {
    kind: 'networkCapture' as const,
    source: 'baccarat-bridge-bg-state',
    url: 'https://cdnx-hwa.jbz029.com/h5V01/pc/index.html?table=B06',
    direction: 'recv',
    encoding: 'text',
    data: JSON.stringify({
      version: 1,
      view: 'multi',
      observedAt: '2026-09-05T01:00:00.000Z',
      tables,
    }),
  };
}

async function connectOutcome(client: WebSocket): Promise<'opened' | 'rejected'> {
  return await new Promise(resolve => {
    client.once('open', () => resolve('opened'));
    client.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve('rejected');
    });
    client.once('error', () => resolve('rejected'));
  });
}

describe('BG bridge integration', () => {
  it('upserts hall baccarat tables without dropping previously seen BG tables', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['B06'] });
    server.ingestClientMessage(bgState([
      { tableId: 'R01', roundId: '9', source: 'protocol' },
      { tableId: 'B06', roundId: '3', source: 'protocol' },
    ]));
    server.ingestClientMessage(bgState([
      { tableId: 'B06', source: 'hall' },
      { tableId: 'C05', source: 'hall' },
    ]));
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId).sort()).toEqual(['B06', 'C05', 'R01']);
    expect(server.getDiscoveredRooms()[0]?.tables.find(table => table.tableId === 'B06')?.roundId).toBe('3');
  });

  it('does not discover junk or non-short BG table ids', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['B06'] });
    server.ingestClientMessage(bgState([
      { tableId: 'RGB255', roundId: '1', source: 'dom' },
      { tableId: 'B100', roundId: '2', source: 'protocol' },
      { tableId: 'B06', roundId: '3', source: 'protocol' },
    ]));
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'dafabet-bg',
        displayName: 'Dafabet BG Live',
        tables: [{ tableId: 'GB2312' }, { tableId: 'B06' }],
      },
    });
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).toEqual(['B06']);
  });

  it('does not drop previously discovered BG tables when a partial lobby snapshot arrives', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['B06'] });
    server.ingestClientMessage(bgState([
      { tableId: 'B01', roundId: '1', source: 'protocol' },
      { tableId: 'B19', roundId: '2', source: 'protocol' },
    ]));
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'dafabet-bg',
        displayName: 'Dafabet BG Live',
        tables: [{ tableId: 'B06' }],
      },
    });
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId).sort()).toEqual(['B01', 'B06', 'B19']);
  });

  it('keeps live round ids on discovered BG tables that are not selected yet', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['B06'] });
    server.ingestClientMessage(bgState([
      { tableId: 'B19', roundId: '4257001', bettingOpen: true, source: 'protocol' },
    ]));
    expect(server.getDiscoveredRooms()[0]?.tables).toEqual([
      expect.objectContaining({ tableId: 'B19', roundId: '4257001' }),
    ]);
  });

  it('accepts BG history snapshots larger than the old 16KB capture cap', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['B06'] });
    const historyHands = Array.from({ length: 80 }, () => ({
      playerCards: ['AS', '2S', '3S'],
      bankerCards: ['AH', '2H', '3H'],
    }));
    const data = JSON.stringify({
      version: 1,
      view: 'single',
      observedAt: '2026-09-05T01:00:00.000Z',
      tables: [{
        tableId: 'A31',
        roundId: '12',
        gameCount: 80,
        source: 'protocol',
        shuffleEvent: true,
        shoeReset: 'seq:12',
        historyHands,
        padding: 'x'.repeat(12_000),
      }],
    });
    expect(data.length).toBeGreaterThan(16_384);
    expect(data.length).toBeLessThan(65_536);
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-bg-state',
      url: 'https://cdnx-hwa.jbz029.com/h5V01/pc/index.html?table=B06',
      direction: 'recv',
      encoding: 'text',
      data,
    });
    expect(server.shoeEvidence('A31')).toEqual({ reason: 'protocol-shuffle' });
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).toEqual(['A31']);
  });

  it('records shuffle evidence for BG tables that are not yet selected', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['B06'] });
    server.ingestClientMessage(bgState([
      { tableId: 'C05', roundId: '1910001', shuffleEvent: true, shoeReset: 'seq:1910001', source: 'protocol' },
    ]));
    expect(server.shoeEvidence('C05')).toEqual({ reason: 'protocol-shuffle' });
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).toEqual(['C05']);
  });

  it('ingests BG snapshots into dafabet-bg without creating a pragmatic room', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['B06', 'B01'] });
    server.ingestClientMessage(bgState([
      { tableId: 'B01', gameCount: 4, roundId: 'R-1', bettingOpen: true },
      { tableId: 'B06', gameCount: 7, roundId: 'R-9', bettingOpen: true },
    ]));
    const discovered = server.getDiscoveredRooms();
    expect(discovered.map(room => room.roomId)).toEqual([DAFABET_BG_ROOM_ID]);
    expect(discovered[0]?.tables.map(table => table.tableId).sort()).toEqual(['B01', 'B06']);
    expect(server.getRooms().find(room => room.roomId === DAFABET_PRAGMATIC_ROOM_ID)).toBeUndefined();
  });

  it('accepts either bundled extension ID when both are allowlisted', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      allowedExtensionIds: [BUNDLED_BROWSER_EXTENSION_ID, BUNDLED_BG_BROWSER_EXTENSION_ID],
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
    });
    const port = await server.start();
    const pragmatic = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`,
      { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
    );
    const unknown = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`,
      { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    );
    try {
      expect(await connectOutcome(pragmatic)).toBe('opened');
      expect(await connectOutcome(unknown)).toBe('rejected');
    } finally {
      pragmatic.close();
      unknown.close();
      await server.close();
    }
  });

  it('accepts the BG extension origin with the shared token', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      allowedExtensionIds: [BUNDLED_BROWSER_EXTENSION_ID, BUNDLED_BG_BROWSER_EXTENSION_ID],
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
    });
    const port = await server.start();
    const bg = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`,
      { origin: `chrome-extension://${BUNDLED_BG_BROWSER_EXTENSION_ID}` },
    );
    try {
      expect(await connectOutcome(bg)).toBe('opened');
    } finally {
      bg.close();
      await server.close();
    }
  });

  it('accepts a BG operational wager from the bg-bet-runtime family', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      allowedExtensionIds: [BUNDLED_BROWSER_EXTENSION_ID, BUNDLED_BG_BROWSER_EXTENSION_ID],
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
    });
    const port = await server.start();
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`,
      { origin: `chrome-extension://${BUNDLED_BG_BROWSER_EXTENSION_ID}` },
    );
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    client.on('message', data => {
      const message = JSON.parse(data.toString()) as { kind?: string; requestId?: string };
      if (message.kind !== 'betRequest' || !message.requestId) return;
      client.send(JSON.stringify({
        kind: 'betResult',
        requestId: message.requestId,
        receipt: {
          receiptId: 'bg-operational-receipt-1',
          wagerId: 'bg-wager-1',
          tableId: 'B06',
          shoeId: 'bg-B06-1',
          handId: '5063048',
          market: 'banker',
          amount: 10,
          source: 'manual',
          status: 'ACCEPTED',
          createdAt: '2026-09-05T03:00:00.000Z',
          raw: { runtimeRevision: BG_BET_RUNTIME_REVISION, commitStarted: true },
        },
      }));
    });
    try {
      await expect(server.requestOperationalWager({
        mode: 'live',
        wager: {
          wagerId: 'bg-wager-1',
          tableId: 'B06',
          shoeId: 'bg-B06-1',
          handId: '5063048',
          market: 'banker',
          amount: 10,
          source: 'manual',
          createdAt: '2026-09-05T03:00:00.000Z',
        },
      })).resolves.toEqual(expect.objectContaining({
        status: 'ACCEPTED',
        tableId: 'B06',
        raw: expect.objectContaining({ runtimeRevision: BG_BET_RUNTIME_REVISION }),
      }));
    } finally {
      client.close();
      await server.close();
    }
  });
});
