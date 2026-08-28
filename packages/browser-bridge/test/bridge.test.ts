import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { BetExecutionRequest, OperationalWagerExecutionRequest } from '@baccarat/adapter-contract';
import type { BetReceipt } from '@baccarat/contracts';
import { replayEvents } from '../../ledger-state/src/projection.js';
import { cursorContinuityProof } from '@baccarat/room-monitor';
import {
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_TOKEN,
  BrowserBridgeServer,
  redactBridgeDiagnostic,
  type BrowserBridgeRuntimeEvent,
} from '../src/index.js';
import type { NormalizedEvent } from '@baccarat/contracts';
import fixtures from '../../../.tmp-mstrom/card-research/15-fixtures.json';

function bridgeEvent(tableId = 't1', eventId = 'e1'): NormalizedEvent {
  return {
    type: 'newShoeSignal',
    eventId,
    tableId,
    timestamp: '2025-01-01T00:00:00.000Z',
    sourceSeq: 1,
    shoeId: 's1',
    profile: {
      tableId,
      numberOfDecks: 8,
      pairRule: { kind: 'standard' },
      odds: {
        bankerPair: { netWin: 11, loss: 1 },
        playerPair: { netWin: 11, loss: 1 },
      },
      burnModel: { kind: 'unknown' },
      minEV: 0,
      limits: { minBet: 1, maxBet: 1000 },
      autoConfirmNewShoe: true,
      betStrategy: { type: 'both' },
    },
  };
}

function betRequest(mode: BetExecutionRequest['mode'] = 'simulated'): BetExecutionRequest {
  return {
    intent: {
      intentId: 'i1',
      tableId: 't1',
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 10,
      mode,
      idempotencyKey: 'k1',
      strategy: { type: 'both' },
      decisionSnapshotId: 'd1',
      createdAt: new Date().toISOString(),
    },
    mode,
    reservationId: 'rv1',
  };
}

function operationalWagerRequest(): OperationalWagerExecutionRequest {
  return {
    mode: 'live',
    wager: {
      wagerId: 'operational-1',
      tableId: 'D055',
      shoeId: 'shoe-1',
      handId: 'GD055-1',
      market: 'banker',
      amount: 20,
      source: 'keepalive',
      createdAt: '2026-08-25T00:00:00.000Z',
    },
  };
}

type TestSocket = {
  send(data: string): void;
};

type TestObserverSocket = TestSocket & {
  readonly readyState: number;
};

function isTestSocketSet(value: unknown): value is Set<TestSocket> {
  return value instanceof Set;
}

function isTestObserverSocketSet(value: unknown): value is Set<TestObserverSocket> {
  return value instanceof Set;
}

function bridgeSockets(server: BrowserBridgeServer): Set<TestSocket> {
  const value: unknown = Reflect.get(server, 'sockets');
  if (!isTestSocketSet(value)) throw new Error('bridge socket set unavailable');
  return value;
}

function bridgeObservers(server: BrowserBridgeServer): Set<TestObserverSocket> {
  const value: unknown = Reflect.get(server, 'observers');
  if (!isTestObserverSocketSet(value)) throw new Error('bridge observer set unavailable');
  return value;
}

function bridgePendingBets(server: BrowserBridgeServer): Map<string, unknown> {
  const value: unknown = Reflect.get(server, 'pendingBets');
  if (!(value instanceof Map)) throw new Error('bridge pending bet map unavailable');
  return value;
}

function ingestFromSocket(server: BrowserBridgeServer, message: unknown, socket: TestSocket): void {
  const method: unknown = Reflect.get(server, 'ingestClientMessage');
  if (typeof method !== 'function') throw new Error('bridge message ingestion unavailable');
  Reflect.apply(method, server, [message, socket]);
}

const acceptedLiveReceipt: BetReceipt = {
  receiptId: 'r-sync',
  intentId: 'i1',
  reservationId: 'rv1',
  status: 'ACCEPTED',
  amount: 10,
  market: 'bankerPair',
  mode: 'live',
  createdAt: '2026-08-24T00:00:00.000Z',
};

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const VALID_CONTINUITY_PROOF = cursorContinuityProof({ test: 'bridge-restore' });

function extensionClient(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXTENSION_ORIGIN });
}

function authenticatedExtensionClient(port: number): WebSocket {
  return new WebSocket(
    `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`,
    { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
  );
}

function observerClient(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/observe`, { origin: 'http://localhost' });
}

function commandClient(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/command`, { origin: 'http://localhost' });
}

describe('browser bridge server', () => {
  it('discovers rooms from extension messages and merges default table profile', async () => {
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'r1',
        displayName: 'Room 1',
        tables: [{ tableId: 't1', monitorUrl: 'win-1' }],
      },
    });

    const rooms = await server.discoverRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].roomId).toBe('r1');
    expect(rooms[0].tables[0].monitorUrl).toBe('win-1');
    expect(rooms[0].tables[0].profile.tableId).toBe('t1');
    expect(rooms[0].tables[0].profile.numberOfDecks).toBe(8);
  });

  it('exports live table events from the extension into ack-driven batches', async () => {
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: { roomId: 'r1', tables: [{ tableId: 't1' }] },
    });
    const feed = server.openTable('r1', 't1');
    const batches: Array<{ tableId: string; events: NormalizedEvent[] }> = [];

    await feed.start({
      onBatch: batch => { batches.push({ tableId: batch.tableId, events: batch.events }); },
    });
    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: bridgeEvent(),
    });
    await feed.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0].events[0].eventId).toBe('e1');
    expect(feed.health().lastAckedSeq).toBe(1);
    expect(feed.health().bufferDepth).toBe(0);
  });

  it('ignores client-supplied restore proofs and restores only from the next continuous event', async () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    const restores: string[] = [];

    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => { disconnects.push(reason ?? ''); },
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });
    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: bridgeEvent(),
    });
    await feed.flush();
    server.ingestClientMessage({ kind: 'tableDisconnected', roomId: 'r1', tableId: 't1', reason: 'page hidden' });
    server.ingestClientMessage({
      kind: 'tableRestored',
      roomId: 'r1',
      tableId: 't1',
      proof: VALID_CONTINUITY_PROOF,
    });

    expect(disconnects).toEqual(['page hidden']);
    expect(restores).toEqual([]);
    expect(feed.health().state).toBe('DISCONNECTED');

    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: { ...bridgeEvent('t1', 'e2'), sourceSeq: 2 },
    });
    await feed.flush();

    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatch(/^cursor-v1:[a-f0-9]{64}$/);
    expect(restores[0]).not.toBe(VALID_CONTINUITY_PROOF);
    expect(feed.health().reconnectCount).toBe(1);
    expect(feed.health().state).toBe('CONNECTED');
  });

  it('fails closed on a table source sequence gap and recovers only from a physical-shoe reset', async () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');
    const batches: NormalizedEvent[] = [];
    const disconnects: string[] = [];
    const restores: string[] = [];

    await feed.start({
      onBatch: batch => { batches.push(...batch.events); },
      onDisconnect: (_tableId, reason) => { disconnects.push(reason ?? ''); },
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });
    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: bridgeEvent(),
    });
    await feed.flush();

    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: { ...bridgeEvent('t1', 'e3'), sourceSeq: 3 },
    });

    await expect(feed.flush()).rejects.toThrow(/continuity gap.*expected 2, got 3/i);
    expect(feed.health()).toMatchObject({
      state: 'DISCONNECTED',
      lastAckedSeq: 1,
    });
    expect(disconnects).toContainEqual(expect.stringMatching(/continuity gap.*expected 2, got 3/i));
    expect(batches.map(event => event.eventId)).toEqual(['e1']);

    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: {
        ...bridgeEvent('t1', 'e4'),
        sourceSeq: 4,
        baseline: 'physical-shoe',
      },
    });
    await feed.flush();

    expect(feed.health()).toMatchObject({
      state: 'CONNECTED',
      lastAckedSeq: 4,
    });
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatch(/^cursor-v1:[a-f0-9]{64}$/);
    expect(batches.map(event => event.eventId)).toEqual(['e1', 'e4']);
  });

  it('round-trips real bet execution requests through a WebSocket extension client', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = extensionClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const resultPromise = server.requestBet(betRequest());
    client.on('message', data => {
      const message = JSON.parse(data.toString()) as { kind: string; requestId?: string };
      if (message.kind === 'betRequest') {
        client.send(JSON.stringify({
          kind: 'betResult',
          requestId: message.requestId!,
          receipt: {
            receiptId: 'r1',
            intentId: 'i1',
            reservationId: 'rv1',
            status: 'SIMULATED',
            amount: 10,
            market: 'bankerPair',
            mode: 'simulated',
            createdAt: new Date().toISOString(),
          },
        }));
      }
    });

    const receipt = await resultPromise;
    expect(receipt).not.toBeNull();
    expect(receipt?.receiptId).toBe('r1');
    expect(receipt?.status).toBe('SIMULATED');

    client.close();
    await server.close();
  });

  it('round-trips a live operational wager through its matching receipt', async () => {
    // Given: exactly one extension client is connected to the local bridge.
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = extensionClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    // When: the desktop requests a banker keepalive wager.
    const resultPromise = server.requestOperationalWager(operationalWagerRequest());
    client.on('message', data => {
      const message = JSON.parse(data.toString()) as { readonly kind?: string; readonly requestId?: string };
      if (message.kind !== 'betRequest' || message.requestId === undefined) return;
      client.send(JSON.stringify({
        kind: 'betResult',
        requestId: message.requestId,
        receipt: {
          receiptId: 'operational-receipt-1',
          wagerId: 'operational-1',
          tableId: 'D055',
          shoeId: 'shoe-1',
          handId: 'GD055-1',
          market: 'banker',
          amount: 20,
          source: 'keepalive',
          status: 'ACCEPTED',
          createdAt: '2026-08-25T00:00:01.000Z',
        },
      }));
    });

    // Then: the bridge preserves the operational receipt without coercing it into a pair-bet receipt.
    await expect(resultPromise).resolves.toEqual(expect.objectContaining({
      receiptId: 'operational-receipt-1',
      wagerId: 'operational-1',
      market: 'banker',
      status: 'ACCEPTED',
    }));

    client.close();
    await server.close();
  });

  it('rejects a web-page origin before it becomes an extension socket', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const attacker = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://attacker.invalid' });
    try {
      // Given: a browser page outside the installed extension.
      const outcome = await new Promise<'opened' | 'rejected'>(resolve => {
        attacker.once('open', () => resolve('opened'));
        attacker.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve('rejected');
        });
        attacker.once('error', () => resolve('rejected'));
      });

      // When: it attempts to connect to the loopback bridge.
      expect(outcome).toBe('rejected');

      // Then: it cannot become the socket that controls extension commands.
    } finally {
      attacker.close();
      await server.close();
    }
  });

  it('accepts only the pinned bundled extension with the shared token', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
    });
    const port = await server.start();
    const wrongId = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`,
      { origin: EXTENSION_ORIGIN },
    );
    const missingToken = new WebSocket(
      `ws://127.0.0.1:${port}/`,
      { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
    );
    const bundled = authenticatedExtensionClient(port);
    try {
      const outcomes = await Promise.all([wrongId, missingToken, bundled].map(client =>
        new Promise<'opened' | 'rejected'>(resolve => {
          client.once('open', () => resolve('opened'));
          client.once('unexpected-response', (_request, response) => {
            response.resume();
            resolve('rejected');
          });
          client.once('error', () => resolve('rejected'));
        })));
      expect(outcomes).toEqual(['rejected', 'rejected', 'opened']);
    } finally {
      wrongId.close();
      missingToken.close();
      bundled.close();
      await server.close();
    }
  });

  it('disconnects the extension and invalidates table continuity on a message sequence gap', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
    });
    const port = await server.start();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => disconnects.push(reason ?? ''),
    });
    const client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      client.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-one',
        bridgeSeq: 1,
      }));
      await new Promise<void>(resolve => setImmediate(resolve));
      client.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-one',
        bridgeSeq: 3,
      }));
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(feed.health().state).toBe('DISCONNECTED');
      expect(disconnects.some(reason => reason.startsWith('extension-message-gap:2:3'))).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('marks a connected table stale and reports real observation age', async () => {
    const server = new BrowserBridgeServer({ tableStaleAfterMs: 1_000 });
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => disconnects.push(reason ?? ''),
    });
    const checkFreshness = Reflect.get(feed, 'checkFreshness');
    if (typeof checkFreshness !== 'function') throw new Error('freshness watchdog unavailable');
    Reflect.apply(checkFreshness, feed, [Date.now() + 2_000]);

    expect(feed.health().state).toBe('DISCONNECTED');
    expect(disconnects).toEqual(['table-feed-stale']);
    await expect(feed.keepAlive()).resolves.toMatchObject({
      ok: false,
      latencyMs: expect.any(Number),
    });
  });

  it('requests a fail-closed game-page reload after feed progress remains stale', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      tableStaleAfterMs: 1_000,
      stalePageReloadAfterMs: 1_000,
    });
    const port = await server.start();
    const extension = extensionClient(port);
    const feed = server.openTable('r1', 't1');
    await feed.start({ onBatch: () => {} });
    try {
      await new Promise<void>((resolve, reject) => {
        extension.once('open', resolve);
        extension.once('error', reject);
      });
      const reload = new Promise<{ readonly name?: string; readonly tableIds?: readonly string[] }>(resolve => {
        extension.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            readonly kind?: string;
            readonly name?: string;
            readonly tableIds?: readonly string[];
          };
          if (message.kind === 'command' && message.name === 'reloadGameTabs') resolve(message);
        });
      });
      const checkFreshness = Reflect.get(feed, 'checkFreshness');
      if (typeof checkFreshness !== 'function') throw new Error('freshness watchdog unavailable');
      Reflect.apply(checkFreshness, feed, [Date.now() + 2_000]);

      await expect(reload).resolves.toEqual(expect.objectContaining({
        name: 'reloadGameTabs',
        tableIds: ['t1'],
      }));
    } finally {
      extension.close();
      await server.close();
    }
  });

  it('cancels a pending stale-page reload when any real table observation resumes', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      tableStaleAfterMs: 1_000,
      stalePageReloadAfterMs: 1_000,
    });
    const port = await server.start();
    const extension = extensionClient(port);
    const feed = server.openTable('r1', 't1');
    await feed.start({ onBatch: () => {} });
    const commands: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        extension.once('open', resolve);
        extension.once('error', reject);
      });
      extension.on('message', data => {
        const message = JSON.parse(data.toString()) as { readonly kind?: string; readonly name?: string };
        if (message.kind === 'command' && message.name !== undefined) commands.push(message.name);
      });
      const checkFreshness = Reflect.get(feed, 'checkFreshness');
      if (typeof checkFreshness !== 'function') throw new Error('freshness watchdog unavailable');
      Reflect.apply(checkFreshness, feed, [Date.now() + 2_000]);
      server.ingestClientMessage({
        kind: 'tableEvent',
        roomId: 'r1',
        tableId: 't1',
        event: bridgeEvent(),
      });
      await new Promise<void>(resolve => setTimeout(resolve, 20));

      expect(commands).not.toContain('reloadGameTabs');
    } finally {
      extension.close();
      await server.close();
    }
  });

  it('keeps observer clients read-only while allowing local command clients', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const extension = extensionClient(port);
    const observer = observerClient(port);
    const command = commandClient(port);
    try {
      await Promise.all([extension, observer, command].map(client => new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      })));

      // Given: an extension, a read-only observer, and a local command client.
      const commands: Array<{ readonly name: string; readonly tableIds?: readonly string[] }> = [];
      const receivedCommand = new Promise<void>(resolve => {
        extension.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            readonly kind?: string;
            readonly name?: string;
            readonly tableIds?: readonly string[];
          };
          if (message.kind !== 'command' || message.name === undefined) return;
          commands.push({
            name: message.name,
            ...(message.tableIds === undefined ? {} : { tableIds: message.tableIds }),
          });
          if (message.name === 'openMultiView') resolve();
        });
      });

      // When: both the observer and the command client send a bridge command.
      observer.send(JSON.stringify({ kind: 'command', name: 'liveOn' }));
      command.send(JSON.stringify({
        kind: 'command',
        name: 'openMultiView',
        tableIds: ['D066', 'D067'],
      }));
      await receivedCommand;
      await new Promise<void>(resolve => setImmediate(resolve));

      // Then: only the dedicated command client reaches the extension.
      expect(commands).toEqual([{
        name: 'openMultiView',
        tableIds: ['D066', 'D067'],
      }]);
    } finally {
      extension.close();
      observer.close();
      command.close();
      await server.close();
    }
  });

  it('fails closed for live bets when no extension socket is connected', async () => {
    const server = new BrowserBridgeServer({ betTimeoutMs: 5 });

    await expect(server.requestBet(betRequest('live'))).rejects.toThrow(/exactly one browser extension connection/i);
  });

  it('fails closed for live bets with multiple extension sockets without sending a bet request', async () => {
    const server = new BrowserBridgeServer({ port: 0, betTimeoutMs: 5 });
    const port = await server.start();
    const clients = [
      extensionClient(port),
      extensionClient(port),
    ];
    const betRequestCount = { value: 0 };
    try {
      await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      })));
      for (const client of clients) {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as { readonly kind?: string };
          if (message.kind === 'betRequest') betRequestCount.value += 1;
        });
      }

      await expect(server.requestBet(betRequest('live'))).rejects.toThrow(/exactly one browser extension connection/i);
      expect(betRequestCount.value).toBe(0);
    } finally {
      for (const client of clients) client.close();
      await server.close();
    }
  });

  it('registers the pending live bet before a synchronous socket result can arrive', async () => {
    const server = new BrowserBridgeServer({ port: 0, betTimeoutMs: 5 });
    const port = await server.start();
    const client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      const socket = [...bridgeSockets(server)][0];
      if (socket === undefined) throw new Error('extension socket missing');
      socket.send = data => {
        const message = JSON.parse(data) as { readonly kind?: string; readonly requestId?: string };
        if (message.kind !== 'betRequest' || typeof message.requestId !== 'string') return;
        ingestFromSocket(server, {
          kind: 'betResult',
          requestId: message.requestId,
          receipt: acceptedLiveReceipt,
        }, socket);
      };

      await expect(server.requestBet(betRequest('live'))).resolves.toEqual(acceptedLiveReceipt);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('rejects a dispatched live bet immediately when its extension socket closes and clears pending state', async () => {
    const server = new BrowserBridgeServer({ port: 0, betTimeoutMs: 1_000 });
    const port = await server.start();
    const client = extensionClient(port);
    let requestId: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });

      const dispatched = new Promise<void>((resolve, reject) => {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            readonly kind?: string;
            readonly requestId?: string;
          };
          if (message.kind !== 'betRequest' || typeof message.requestId !== 'string') return;
          requestId = message.requestId;
          resolve();
          client.close();
        });
        client.once('error', reject);
      });
      const resultPromise = server.requestBet(betRequest('live'));

      await dispatched;
      const outcome = await Promise.race([
        resultPromise.then(
          () => 'resolved',
          error => error instanceof Error ? error.message : String(error),
        ),
        new Promise<string>(resolve => setTimeout(() => resolve('deadline'), 100)),
      ]);

      expect(outcome).toMatch(/disconnected/i);
      if (requestId === undefined) throw new Error('live bet request id missing');
      expect(bridgePendingBets(server).has(requestId)).toBe(false);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('serializes pair and keepalive requests for the same table', async () => {
    const server = new BrowserBridgeServer({ betTimeoutMs: 1_000 });
    const requestIds: string[] = [];
    const socket: TestSocket = {
      send(data: string): void {
        const message: unknown = JSON.parse(data);
        if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
        if (Reflect.get(message, 'kind') !== 'betRequest') return;
        const requestId = Reflect.get(message, 'requestId');
        if (typeof requestId === 'string') requestIds.push(requestId);
      },
    };
    bridgeSockets(server).add(socket);
    const pairRequest: BetExecutionRequest = {
      ...betRequest('live'),
      intent: {
        ...betRequest('live').intent,
        tableId: 'D055',
      },
    };
    const keepaliveRequest = operationalWagerRequest();
    const keepaliveReceipt = {
      receiptId: 'keepalive-receipt',
      wagerId: keepaliveRequest.wager.wagerId,
      tableId: keepaliveRequest.wager.tableId,
      shoeId: keepaliveRequest.wager.shoeId,
      handId: keepaliveRequest.wager.handId,
      market: keepaliveRequest.wager.market,
      amount: keepaliveRequest.wager.amount,
      source: keepaliveRequest.wager.source,
      status: 'ACCEPTED' as const,
      createdAt: '2026-08-25T00:00:00.000Z',
    };

    try {
      const pair = server.requestBet(pairRequest);
      const keepalive = server.requestOperationalWager(keepaliveRequest);

      await Promise.resolve();
      expect(requestIds).toHaveLength(1);
      const pairRequestId = requestIds[0];
      if (pairRequestId === undefined) throw new Error('pair request id missing');
      ingestFromSocket(server, {
        kind: 'betResult',
        requestId: pairRequestId,
        receipt: acceptedLiveReceipt,
      }, socket);
      await expect(pair).resolves.toEqual(acceptedLiveReceipt);

      await Promise.resolve();
      expect(requestIds).toHaveLength(2);
      const keepaliveRequestId = requestIds[1];
      if (keepaliveRequestId === undefined) throw new Error('keepalive request id missing');
      ingestFromSocket(server, {
        kind: 'betResult',
        requestId: keepaliveRequestId,
        receipt: keepaliveReceipt,
      }, socket);
      await expect(keepalive).resolves.toEqual(keepaliveReceipt);
    } finally {
      bridgeSockets(server).delete(socket);
      await server.close();
    }
  });

  it('ignores a live bet result received on a different extension socket', async () => {
    const server = new BrowserBridgeServer({ port: 0, betTimeoutMs: 1_000 });
    const port = await server.start();
    const originalClient = extensionClient(port);
    let newClient: WebSocket | undefined;
    let requestId: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        originalClient.once('open', resolve);
        originalClient.once('error', reject);
      });
      const dispatched = new Promise<void>((resolve, reject) => {
        originalClient.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            readonly kind?: string;
            readonly requestId?: string;
          };
          if (message.kind !== 'betRequest' || typeof message.requestId !== 'string') return;
          requestId = message.requestId;
          resolve();
        });
        originalClient.once('error', reject);
      });
      const resultPromise = server.requestBet(betRequest('live'));
      await dispatched;
      if (requestId === undefined) throw new Error('live bet request id missing');

      const replacementClient = extensionClient(port);
      newClient = replacementClient;
      await new Promise<void>((resolve, reject) => {
        replacementClient.once('open', resolve);
        replacementClient.once('error', reject);
      });
      const serverSockets = [...bridgeSockets(server)];
      const replacementServerSocket = serverSockets[1];
      if (replacementServerSocket === undefined) throw new Error('replacement extension socket missing');
      ingestFromSocket(server, {
        kind: 'betResult',
        requestId,
        receipt: acceptedLiveReceipt,
      }, replacementServerSocket);

      expect(bridgePendingBets(server).has(requestId)).toBe(true);
      originalClient.send(JSON.stringify({
        kind: 'betResult',
        requestId,
        receipt: acceptedLiveReceipt,
      }));
      await expect(resultPromise).resolves.toEqual(acceptedLiveReceipt);
    } finally {
      originalClient.close();
      newClient?.close();
      await server.close();
    }
  });

  it('arms live execution only through a connected extension command channel', async () => {
    // Given: live execution must fail closed when no extension is connected.
    const server = new BrowserBridgeServer({ port: 0 });
    expect(() => server.setLiveBetEnabled(true)).toThrow(/exactly one browser extension connection/i);
    const port = await server.start();
    const client = extensionClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    const command = new Promise<{ readonly kind: string; readonly name?: string }>(resolve => {
      client.on('message', data => {
        const message = JSON.parse(data.toString()) as { readonly kind: string; readonly name?: string };
        if (message.kind === 'command') resolve(message);
      });
    });

    // When: the desktop explicitly enables real execution.
    server.setLiveBetEnabled(true);

    // Then: exactly the extension command channel receives the live-on instruction.
    await expect(command).resolves.toEqual({ kind: 'command', name: 'liveOn' });
    client.close();
    await server.close();
  });

  it('fails closed for live arming with multiple sockets while still broadcasting liveOff', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const clients = [
      extensionClient(port),
      extensionClient(port),
    ];
    const liveOnCount = { value: 0 };
    const liveOffCount = { value: 0 };
    let resolveLiveOff: (() => void) | undefined;
    const liveOffReceived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for liveOff broadcast')), 100);
      resolveLiveOff = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    try {
      await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      })));
      for (const client of clients) {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as { readonly kind?: string; readonly name?: string };
          if (message.kind !== 'command') return;
          if (message.name === 'liveOn') liveOnCount.value += 1;
          if (message.name === 'liveOff') {
            liveOffCount.value += 1;
            if (liveOffCount.value === clients.length) resolveLiveOff?.();
          }
        });
      }

      expect(() => server.setLiveBetEnabled(true)).toThrow(/exactly one browser extension connection/i);
      server.setLiveBetEnabled(false);
      await liveOffReceived;

      expect(liveOnCount.value).toBe(0);
      expect(liveOffCount.value).toBe(2);
    } finally {
      for (const client of clients) client.close();
      await server.close();
    }
  });

  it('keeps exports disconnected when the page only claims session recovery', async () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    const restores: string[] = [];

    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => { disconnects.push(reason ?? ''); },
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });
    expect(feed.health().state).toBe('CONNECTED');

    server.ingestClientMessage({
      kind: 'sessionExpired',
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      textPreview: '会话已过期',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(feed.health().state).toBe('DISCONNECTED');
    expect(disconnects).toEqual(['game-session-expired']);

    server.ingestClientMessage({
      kind: 'sessionAction',
      action: 'recovered',
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      timestamp: '2025-01-01T00:01:00.000Z',
    });
    expect(feed.health().state).toBe('DISCONNECTED');
    expect(restores).toEqual([]);
    expect(feed.health().reconnectCount).toBe(0);
  });

  it('restores an expired export only from a physical-shoe reset', async () => {
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: { roomId: 'r1', tables: [{ tableId: 't1' }] },
    });
    const feed = server.openTable('r1', 't1');
    const batches: Array<{ tableId: string; events: NormalizedEvent[] }> = [];
    const restores: string[] = [];

    await feed.start({
      onBatch: batch => { batches.push({ tableId: batch.tableId, events: batch.events }); },
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });

    server.ingestClientMessage({
      kind: 'sessionExpired',
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      textPreview: '会话已过期',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(feed.health().state).toBe('DISCONNECTED');

    const physicalReset = {
      ...bridgeEvent(),
      baseline: 'physical-shoe' as const,
    };
    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: physicalReset,
    });
    await feed.flush();

    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatch(/^cursor-v1:[a-f0-9]{64}$/);
    expect(feed.health().state).toBe('CONNECTED');
    expect(batches).toHaveLength(1);
    expect(batches[0].events[0].eventId).toBe('e1');
  });

  it('waits for asynchronous restoration before draining the first recovered event', async () => {
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: { roomId: 'r1', tables: [{ tableId: 't1' }] },
    });
    const feed = server.openTable('r1', 't1');
    const batches: NormalizedEvent[] = [];
    let releaseRestoration: () => void = () => undefined;
    const restorationBlocked = new Promise<void>(resolve => {
      releaseRestoration = resolve;
    });

    try {
      await feed.start({
        onBatch: batch => { batches.push(...batch.events); },
        onRestored: async () => await restorationBlocked,
      });
      server.ingestClientMessage({
        kind: 'sessionExpired',
        url: 'https://www.dafabet.net/room',
        frame: 'top',
        textPreview: '会话已过期',
        timestamp: '2025-01-01T00:00:00.000Z',
      });

      server.ingestClientMessage({
        kind: 'tableEvent',
        roomId: 'r1',
        tableId: 't1',
        event: {
          ...bridgeEvent(),
          baseline: 'physical-shoe',
        },
      });
      await Promise.resolve();

      expect(batches).toEqual([]);

      releaseRestoration();
      await feed.flush();
      expect(batches).toEqual([{
        ...bridgeEvent(),
        baseline: 'physical-shoe',
      }]);
    } finally {
      releaseRestoration();
      await server.close();
    }
  });

  it('ignores keepalive and session actions that do not affect exports', () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');

    server.ingestClientMessage({
      kind: 'keepalive',
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      timestamp: '2025-01-01T00:00:00.000Z',
      target: { x: 10, y: 20, width: 30, height: 30 },
    });
    server.ingestClientMessage({
      kind: 'sessionAction',
      action: 'reload-scheduled',
      attempt: 1,
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(feed.health().state).toBe('DISCONNECTED');
    expect(feed.health().reconnectCount).toBe(0);
  });

  it('broadcasts observable session events to connected observer clients', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = observerClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const observed = new Promise<{ kind: string; message: { kind: string } }>(resolve => {
      client.on('message', data => {
        const message = JSON.parse(data.toString()) as { kind: string; message?: { kind: string } };
        if (message.kind === 'observe' && message.message) {
          resolve({ kind: message.kind, message: message.message });
        }
      });
    });

    server.ingestClientMessage({
      kind: 'sessionAction',
      action: 'keepalive-click',
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      detail: 'record button',
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    const seen = await observed;
    expect(seen.message.kind).toBe('sessionAction');

    client.close();
    await server.close();
  });

  it('broadcasts redacted game-channel network captures to observers only', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = observerClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const observed = new Promise<{ kind: string; message: { kind: string; url: string; data: string } }>(resolve => {
      client.on('message', data => {
        const message = JSON.parse(data.toString()) as { kind: string; message?: { kind: string; url: string; data: string } };
        if (message.kind === 'observe' && message.message?.kind === 'networkCapture') {
          resolve({ kind: message.kind, message: message.message });
        }
      });
    });

    const longData = 'x'.repeat(8000);
    // 非游戏域名(视频流)不应广播。
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://seoa-mdp-e05.egcvi.com/websocketstream2',
      direction: 'recv',
      encoding: 'base64',
      data: longData,
    });
    // 游戏通道应广播且截断。
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://evoad.df888evo.com/public/baccarat/player/game/t1/socket',
      direction: 'send',
      encoding: 'text',
      data: longData,
    });

    const seen = await observed;
    expect(seen.message.kind).toBe('networkCapture');
    expect(seen.message.url).toContain('df888evo');
    expect(seen.message.data).toBe('[redacted 8000 bytes]');

    client.close();
    await server.close();
  });

  it('imports non-visual mstrom runtime snapshots into the table export', async () => {
    const server = new BrowserBridgeServer();
    const firstSnapshot = JSON.stringify({
      tableId: 'D065',
      roundId: 'GD065268221A8',
      gmstatus: 0,
      playerScore: 0,
      bankerScore: 4,
      playerCards: [0x38, 0x12],
      bankerCards: [0x39, 0x05],
      capturedAt: '2026-08-22T15:30:18.000Z',
    });

    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: firstSnapshot,
    });

    const rooms = await server.discoverRooms();
    expect(rooms.find(room => room.roomId === 'dafabet-live')?.tables.map(table => table.tableId)).toContain('D065');

    const feed = server.openTable('dafabet-live', 'D065');
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();
    expect(events.map(event => event.type)).toEqual([
      'newShoeSignal',
      'cardObserved',
      'cardObserved',
      'cardObserved',
      'cardObserved',
    ]);

    const completedSnapshot = JSON.stringify({
      tableId: 'D065',
      roundId: 'GD065268221A8',
      gmstatus: 0,
      playerScore: 3,
      bankerScore: 4,
      playerCards: [0x38, 0x12, 0x13],
      bankerCards: [0x39, 0x05, 0x0b],
      capturedAt: '2026-08-22T15:30:20.000Z',
    });
    const capture = {
      kind: 'networkCapture' as const,
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: completedSnapshot,
    };
    server.ingestClientMessage(capture);
    await feed.flush();
    expect(events.slice(5).map(event => event.type)).toEqual([
      'cardObserved',
      'cardObserved',
      'handSettled',
    ]);

    server.ingestClientMessage(capture);
    await feed.flush();
    expect(events).toHaveLength(8);
  });


  it('keeps configured table IDs as a hard ceiling for runtime state and browser selection', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055', 'D056', 'D057', 'D065'] });
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-selection',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({ tableIds: ['D055', 'D069'] }),
    });
    expect(server.getRuntimeSelectedTables()).toEqual(['D055']);

    for (const tableId of ['D069', 'D055']) {
      server.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-runtime-state',
        url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          tableId,
          roundId: `G${tableId}`,
          gmstatus: 0,
          playerScore: 1,
          bankerScore: 2,
          playerCards: [0x01],
          bankerCards: [0x12],
          capturedAt: '2026-08-22T15:30:18.000Z',
        }),
      });
    }

    const rooms = await server.discoverRooms();
    expect(rooms.find(room => room.roomId === 'dafabet-live')?.tables.map(table => table.tableId)).toEqual(['D055']);
  });

  it('parses a replayed runtime snapshot after the table returns from an explicit empty selection', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055'] });
    const reportSelection = (tableIds: readonly string[]) => {
      server.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-runtime-selection',
        url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({ tableIds }),
      });
    };
    const runtimeCapture = {
      kind: 'networkCapture' as const,
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'D055',
        roundId: 'GD055268230E1',
        gmstatus: 0,
        playerScore: 1,
        bankerScore: 2,
        playerCards: [0x01],
        bankerCards: [0x12],
        capturedAt: '2026-08-23T05:00:00.000Z',
      }),
    };

    reportSelection([]);
    server.ingestClientMessage(runtimeCapture);
    reportSelection(['D055']);
    server.ingestClientMessage(runtimeCapture);

    const rooms = await server.discoverRooms();
    expect(rooms.find(room => room.roomId === 'dafabet-live')?.tables.map(table => table.tableId)).toEqual(['D055']);
  });
  it('filters protocol tables outside the runtime-selected multi-table view', async () => {
    const sample = fixtures.find(fixture => fixture.id === 'bcst-phase1-betting-01');
    if (!sample) throw new Error('betting fixture missing');
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-selection',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({ tableIds: ['D055', 'D056', 'D057', 'D065'] }),
    });
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://ty242c.mdvuz.com:5000',
      direction: 'recv',
      encoding: 'base64',
      data: sample.base64,
    });

    const rooms = await server.discoverRooms();
    expect(rooms.find(room => room.roomId === 'dafabet-live')).toBeUndefined();
  });

  it('imports mstrom BAC betting frames into both pair-market windows', async () => {
    const sample = fixtures.find(fixture => fixture.id === 'bcst-phase1-betting-01');
    if (!sample) throw new Error('betting fixture missing');
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-selection',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({ tableIds: ['P020'] }),
    });
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://ty242c.mdvuz.com:5000',
      direction: 'recv',
      encoding: 'base64',
      data: sample.base64,
    });

    const feed = server.openTable('dafabet-live', 'P020');
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();

    expect(events.map(event => event.type)).toEqual([
      'newShoeSignal',
      'bettingWindowOpened',
      'bettingWindowOpened',
    ]);
    expect(events.filter(event => event.type === 'bettingWindowOpened').map(event => event.market)).toEqual([
      'bankerPair',
      'playerPair',
    ]);

    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://ty242c.mdvuz.com:5000',
      direction: 'recv',
      encoding: 'base64',
      data: sample.base64,
    });
    await feed.flush();
    expect(events).toHaveLength(3);
  });

  it('imports verified mstrom frames from rotated websocket hostnames', async () => {
    // Given: a real phase-1 baccarat frame arrives from the provider's current rotating socket host.
    const sample = fixtures.find(fixture => fixture.id === 'bcst-phase1-betting-01');
    if (!sample) throw new Error('betting fixture missing');
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-selection',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({ tableIds: ['P020'] }),
    });

    // When: the bridge receives the frame from a hostname that is not in its historical alias list.
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://ty242c.mmxxpp.com.cn:5000',
      direction: 'recv',
      encoding: 'base64',
      data: sample.base64,
    });
    const feed = server.openTable('dafabet-live', 'P020');
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();

    // Then: strict frame parsing, not the volatile hostname, identifies the betting window.
    expect(events.map(event => event.type)).toEqual([
      'newShoeSignal',
      'bettingWindowOpened',
      'bettingWindowOpened',
    ]);
    expect(replayEvents(events).get('P020')).toMatchObject({
      tableId: 'P020',
      currentHandId: 'GP020268211JD',
      status: 'BETTING_WINDOW',
      connectionStatus: 'CONNECTED',
    });
  });

  it('promotes an explicit raw shuffle snapshot exactly once across protocol and runtime channels', async () => {
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-selection',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({ tableIds: ['N072'] }),
    });
    const protocolCapture = {
      kind: 'networkCapture' as const,
      source: 'baccarat-bridge-ws',
      url: 'wss://ty242c.mdvuz.com:5000',
      direction: 'recv',
      encoding: 'base64',
      data: 'AAIQFgAAADEAAedJAABOMDcyIAQoCAoDQkFDEg1HTjA3MjI2ODIxMTJNGAtAGZABAQ==',
    };
    server.ingestClientMessage(protocolCapture);

    const feed = server.openTable('dafabet-live', 'N072');
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'newShoeSignal',
        baseline: 'physical-shoe',
        tableId: 'N072',
      }),
    ]);

    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'N072',
        roundId: 'GN0722682112M',
        gameType: 'BAC',
        gmstatus: 11,
        playerScore: null,
        bankerScore: null,
        playerCards: [],
        bankerCards: [],
        capturedAt: '2026-08-23T13:05:00.000Z',
      }),
    });
    server.ingestClientMessage(protocolCapture);
    await feed.flush();
    expect(events.filter(event => event.type === 'newShoeSignal')).toHaveLength(1);
  });

  it('clears the stale selection and requests multiview recovery when the page reports only an unconfigured table', async () => {
    const configuredTableIds = ['D055', 'D056', 'D057', 'D065'] as const;
    const server = new BrowserBridgeServer({ port: 0, selectedTableIds: configuredTableIds });
    const port = await server.start();
    const client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      const recovery = new Promise<{ kind: string; name?: string }>(resolve => {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as { kind: string; name?: string };
          if (message.kind === 'command' && message.name === 'openMultiView') resolve(message);
        });
      });

      const reportSelection = (tableIds: readonly string[]) => {
        server.ingestClientMessage({
          kind: 'networkCapture',
          source: 'baccarat-bridge-runtime-selection',
          url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
          direction: 'recv',
          encoding: 'text',
          data: JSON.stringify({ tableIds }),
        });
      };

      reportSelection(['D055']);
      expect(server.getRuntimeSelectedTables()).toEqual(['D055']);
      reportSelection([]);
      expect(server.getRuntimeSelectedTables()).toEqual([]);
      reportSelection(['P001']);
      expect(server.getRuntimeSelectedTables()).toEqual([]);
      await expect(recovery).resolves.toEqual(expect.objectContaining({
        kind: 'command',
        name: 'openMultiView',
      }));
    } finally {
      client.close();
      await server.close();
    }
  });

  it('requests multiview recovery when the configured page reports an explicit empty selection', async () => {
    const configuredTableIds = ['D066', 'D067', 'D056', 'D057'] as const;
    const server = new BrowserBridgeServer({
      port: 0,
      selectedTableIds: configuredTableIds,
    });
    const port = await server.start();
    const client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      const recovery = new Promise<{ kind: string; name?: string; tableIds?: string[] }>(resolve => {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as { kind: string; name?: string; tableIds?: string[] };
          if (message.kind === 'command' && message.name === 'openMultiView') resolve(message);
        });
      });

      server.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-runtime-selection',
        url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({ tableIds: [] }),
      });

      expect(server.getRuntimeSelectedTables()).toEqual([]);
      await expect(recovery).resolves.toEqual({
        kind: 'command',
        name: 'openMultiView',
        tableIds: configuredTableIds,
      });
    } finally {
      client.close();
      await server.close();
    }
  });

  it('retries multiview recovery while the configured selection remains incomplete', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      selectedTableIds: ['D066', 'D067', 'D056', 'D057'],
      multiviewRecoveryCooldownMs: 25,
    });
    const port = await server.start();
    const client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      const recoveryCommands: Array<{ kind: string; name?: string }> = [];
      const twoRecoveries = new Promise<void>(resolve => {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as { kind: string; name?: string };
          if (message.kind !== 'command' || message.name !== 'openMultiView') return;
          recoveryCommands.push(message);
          if (recoveryCommands.length === 2) resolve();
        });
      });

      server.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-runtime-selection',
        url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({ tableIds: [] }),
      });

      await twoRecoveries;
      expect(recoveryCommands).toHaveLength(2);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('allows the multiview page to finish loading after the extension reports that it opened', async () => {
    const openedGraceMs = 80;
    const server = new BrowserBridgeServer({
      port: 0,
      selectedTableIds: ['D066', 'D067', 'D056', 'D057'],
      multiviewRecoveryCooldownMs: 10,
      multiviewOpenedGraceMs: openedGraceMs,
    });
    const port = await server.start();
    const client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      const recoveryTimes: number[] = [];
      const twoRecoveries = new Promise<void>(resolve => {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as { kind: string; name?: string };
          if (message.kind !== 'command' || message.name !== 'openMultiView') return;
          recoveryTimes.push(Date.now());
          if (recoveryTimes.length === 1) {
            server.ingestClientMessage({
              kind: 'sessionAction',
              action: 'command-executed',
              url: '',
              frame: 'allFrames',
              detail: 'openMultiView:opened:1',
              timestamp: new Date().toISOString(),
            });
          }
          if (recoveryTimes.length === 2) resolve();
        });
      });

      server.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-runtime-selection',
        url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({ tableIds: [] }),
      });

      await twoRecoveries;
      expect(recoveryTimes[1] - recoveryTimes[0]).toBeGreaterThanOrEqual(openedGraceMs - 15);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('filters unselected tables from discovered and updated rooms', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055', 'D056'] });
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'r1',
        tables: [{ tableId: 'D055' }, { tableId: 'P001' }, { tableId: 'D099' }],
      },
    });

    let rooms = await server.discoverRooms();
    expect(rooms.find(room => room.roomId === 'r1')?.tables.map(table => table.tableId)).toEqual(['D055']);

    server.ingestClientMessage({
      kind: 'roomUpdated',
      room: {
        roomId: 'r1',
        tables: [{ tableId: 'D056' }, { tableId: 'P001' }],
      },
    });

    rooms = await server.discoverRooms();
    expect(rooms.find(room => room.roomId === 'r1')?.tables.map(table => table.tableId)).toEqual(['D056']);
  });



  it('keeps unselected discovered tables available for the monitor picker', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055'] });
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'picker-room',
        displayName: 'Picker Room',
        tables: [{ tableId: 'D055' }, { tableId: 'P001' }],
      },
    });

    expect(server.getDiscoveredRooms().find(room => room.roomId === 'picker-room')?.tables.map(table => table.tableId))
      .toEqual(['D055', 'P001']);
    expect(server.getRooms().find(room => room.roomId === 'picker-room')?.tables.map(table => table.tableId))
      .toEqual(['D055']);
  });



  it('promotes an explicitly confirmed current table to a physical shoe without visual input', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D065'] });
    const feed = server.openTable('dafabet-live', 'D065');
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });

    server.confirmPhysicalShoe('D065');
    await feed.flush();
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'D065',
        roundId: 'GD065-after-operator-confirm',
        gameType: 'BAC',
        gmstatus: 0,
        playerScore: 1,
        bankerScore: 2,
        playerCards: [0x01],
        bankerCards: [0x12],
        capturedAt: '2026-08-23T13:06:00.000Z',
      }),
    });
    await feed.flush();

    expect(events.filter(event => event.type === 'newShoeSignal')).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'newShoeSignal', tableId: 'D065', baseline: 'physical-shoe' }),
    ]));
  });

  it('rejects openTable for an unselected table', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055'] });

    expect(() => server.openTable('r1', 'P001')).toThrow(/not selected/);
    expect(() => server.openTable('r1', 'D055')).not.toThrow();
  });
});


describe('monitor session restarts', () => {
  it('gives a restarted monitor session a fresh logical shoe and fresh event IDs', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055'] });
    const selection = {
      kind: 'networkCapture' as const,
      source: 'baccarat-bridge-runtime-selection',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({ tableIds: ['D055'] }),
    };
    const capture = {
      kind: 'networkCapture' as const,
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'D055',
        roundId: 'GD055-replay',
        gmstatus: 0,
        playerScore: 1,
        bankerScore: 2,
        playerCards: [0x01],
        bankerCards: [0x12],
        capturedAt: '2026-08-23T07:00:00.000Z',
      }),
    };
    server.ingestClientMessage(selection);
    server.ingestClientMessage(capture);
    const firstFeed = server.openTable('dafabet-live', 'D055');
    const firstEvents: NormalizedEvent[] = [];
    await firstFeed.start({ onBatch: batch => { firstEvents.push(...batch.events); } });
    await firstFeed.flush();

    server.beginMonitorSession();
    server.ingestClientMessage(capture);
    const secondFeed = server.openTable('dafabet-live', 'D055');
    const secondEvents: NormalizedEvent[] = [];
    await secondFeed.start({ onBatch: batch => { secondEvents.push(...batch.events); } });
    await secondFeed.flush();

    const firstShoe = firstEvents.find(event => event.type === 'newShoeSignal');
    const secondShoe = secondEvents.find(event => event.type === 'newShoeSignal');
    expect(secondShoe?.shoeId).not.toBe(firstShoe?.shoeId);
    expect(secondEvents.map(event => event.eventId)).not.toEqual(firstEvents.map(event => event.eventId));
  });
});

describe('configured live-table stability', () => {
  it('continues parsing a configured table after a transient partial runtime selection', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055', 'D056', 'D057', 'D065'] });
    const reportSelection = (tableIds: readonly string[]) => server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-selection',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({ tableIds }),
    });
    const capture = (roundId: string) => server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'D056',
        roundId,
        gmstatus: 0,
        playerScore: 1,
        bankerScore: 2,
        playerCards: [0x01],
        bankerCards: [0x12],
        capturedAt: '2026-08-23T07:00:00.000Z',
      }),
    });

    reportSelection(['D055', 'D056', 'D057', 'D065']);
    capture('GD056-1');
    const feed = server.openTable('dafabet-live', 'D056');
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();

    reportSelection(['D055']);
    capture('GD056-2');
    await feed.flush();

    expect(events.some(event => event.type === 'cardObserved' && event.handId === 'GD056-2')).toBe(true);
  });
});

describe('dynamic configured live-table selection', () => {
  it('replaces the whitelist, stops removed exports, and accepts the new table on runtime and protocol channels', async () => {
    const d065ProtocolFixture = fixtures.find(fixture => fixture.id === 'bcst-phase1-betting-01');
    const d055ProtocolFixture = fixtures.find(fixture => fixture.id === 'shoe-signal-01');
    if (!d065ProtocolFixture || !d055ProtocolFixture) throw new Error('protocol fixtures missing');

    const server = new BrowserBridgeServer({ selectedTableIds: ['D055'] });
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'dafabet-live',
        tables: [{ tableId: 'D055' }, { tableId: 'D065' }],
      },
    });

    const oldFeed = server.openTable('dafabet-live', 'D055');
    const oldEvents: NormalizedEvent[] = [];
    await oldFeed.start({ onBatch: batch => { oldEvents.push(...batch.events); } });
    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'dafabet-live',
      tableId: 'D055',
      event: bridgeEvent('D055', 'd055-before-update'),
    });
    await oldFeed.flush();
    expect(oldEvents).toHaveLength(1);

    server.setSelectedTableIds(['D065']);

    expect(server.hasConfiguredTableSelection()).toBe(true);
    expect(oldFeed.health().state).toBe('DISCONNECTED');
    expect(() => server.openTable('dafabet-live', 'D055')).toThrow(/not selected/);
    expect((await server.discoverRooms()).find(room => room.roomId === 'dafabet-live')?.tables).toEqual([]);

    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'dafabet-live',
      tableId: 'D055',
      event: bridgeEvent('D055', 'd055-after-update'),
    });
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'D055',
        roundId: 'GD055-after-update',
        gmstatus: 0,
        playerScore: 1,
        bankerScore: 2,
        playerCards: [0x01],
        bankerCards: [0x12],
        capturedAt: '2026-08-23T05:00:00.000Z',
      }),
    });
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://ty242c.mdvuz.com:5000',
      direction: 'recv',
      encoding: 'base64',
      data: d055ProtocolFixture.base64,
    });
    await oldFeed.flush();
    expect(oldEvents).toHaveLength(1);

    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'D065',
        roundId: 'GD065-after-update',
        gmstatus: 0,
        playerScore: 3,
        bankerScore: 4,
        playerCards: [0x38, 0x12],
        bankerCards: [0x39, 0x05],
        capturedAt: '2026-08-23T05:00:01.000Z',
      }),
    });
    const d065Feed = server.openTable('dafabet-live', 'D065');
    const d065Events: NormalizedEvent[] = [];
    await d065Feed.start({ onBatch: batch => { d065Events.push(...batch.events); } });
    await d065Feed.flush();

    const d065ProtocolData = Buffer.from(
      Buffer.from(d065ProtocolFixture.base64, 'base64').toString('latin1').replace(/P020/g, 'D065'),
      'latin1',
    ).toString('base64');
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://ty242c.mdvuz.com:5000',
      direction: 'recv',
      encoding: 'base64',
      data: d065ProtocolData,
    });
    await d065Feed.flush();

    expect(d065Events.some(event => event.type === 'cardObserved')).toBe(true);
    expect(d065Events.some(event => event.type === 'bettingWindowOpened')).toBe(true);
    expect((await server.discoverRooms()).find(room => room.roomId === 'dafabet-live')?.tables.map(table => table.tableId)).toEqual(['D065']);
  });

  it('treats an explicitly empty whitelist as no tables instead of all tables', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055'] });

    server.setSelectedTableIds([]);

    expect(server.hasConfiguredTableSelection()).toBe(true);
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'D065',
        roundId: 'GD065-empty-selection',
        gmstatus: 0,
        playerScore: 1,
        bankerScore: 2,
        playerCards: [0x01],
        bankerCards: [0x12],
        capturedAt: '2026-08-23T05:00:00.000Z',
      }),
    });

    expect(await server.discoverRooms()).toEqual([]);
    expect(() => server.openTable('dafabet-live', 'D065')).toThrow(/not selected/);
  });

  it('reveals runtime lifecycle metadata to observers without exposing card bytes or URL parameters', () => {
    const server = new BrowserBridgeServer();
    const messages: string[] = [];
    bridgeObservers(server).add({
      readyState: WebSocket.OPEN,
      send: data => { messages.push(data); },
    });

    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?session=secret',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'D056',
        roundId: 'GD0562682518P',
        gmstatus: 4,
        playerCards: [0x04, 0x13],
        bankerCards: [0x3b, 0x06, 0x0d],
        capturedAt: '2026-08-25T15:04:00.000Z',
      }),
    });

    expect(messages).toHaveLength(1);
    const observed: unknown = JSON.parse(messages[0] ?? '');
    expect(observed).toMatchObject({
      kind: 'observe',
      message: {
        kind: 'networkCapture',
        source: 'baccarat-bridge-runtime-state',
        url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp',
        data: JSON.stringify({
          tableId: 'D056',
          roundId: 'GD0562682518P',
          gmstatus: 4,
          playerCardCount: 2,
          bankerCardCount: 3,
          capturedAt: '2026-08-25T15:04:00.000Z',
        }),
      },
    });
    expect(messages[0]).not.toContain('secret');
    expect(messages[0]).not.toContain('playerCards');
    expect(messages[0]).not.toContain('bankerCards');
  });
});

describe('browser bridge runtime supervision', () => {
  it('blocks live arming and dispatch until the extension sequence is authenticated', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      betTimeoutMs: 5,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
    });
    const port = await server.start();
    const client = authenticatedExtensionClient(port);
    let betRequestCount = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      client.on('message', data => {
        const message = JSON.parse(data.toString()) as { readonly kind?: string };
        if (message.kind === 'betRequest') betRequestCount += 1;
      });

      expect(server.getExtensionStatus()).toMatchObject({
        connectionCount: 1,
        authenticated: false,
      });
      expect(() => server.setLiveBetEnabled(true)).toThrow(/authenticated extension sequence/i);
      await expect(server.requestBet(betRequest('live'))).rejects.toThrow(/authenticated extension sequence/i);
      expect(betRequestCount).toBe(0);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('reports rejected extension identity and requires a sequenced authenticated session', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const rejected = new WebSocket(
      `ws://127.0.0.1:${port}/`,
      { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
    );
    const client = authenticatedExtensionClient(port);
    try {
      await Promise.all([
        new Promise<void>(resolve => {
          rejected.once('unexpected-response', (_request, response) => {
            response.resume();
            resolve();
          });
          rejected.once('error', () => resolve());
        }),
        new Promise<void>((resolve, reject) => {
          client.once('open', resolve);
          client.once('error', reject);
        }),
      ]);

      expect(server.getExtensionStatus()).toMatchObject({
        connectionCount: 1,
        authenticated: false,
      });
      expect(events).toContainEqual(expect.objectContaining({ kind: 'extension-auth-failed' }));

      client.send(JSON.stringify({
        kind: 'hello',
        extensionVersion: '0.1.0',
        browser: 'Chrome',
        timestamp: '2026-08-27T01:00:00.000Z',
        bridgeSessionId: 'bridge-session-20260827',
        bridgeSeq: 1,
      }));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (events.some(event => event.kind === 'extension-authenticated')) break;
        await new Promise(resolve => setTimeout(resolve, 1));
      }

      expect(server.getExtensionStatus()).toMatchObject({
        connectionCount: 1,
        authenticated: true,
      });
      expect(events).toContainEqual(expect.objectContaining({ kind: 'extension-authenticated' }));
    } finally {
      rejected.close();
      client.close();
      await server.close();
    }
  });

  it('emits recovery exhaustion and recovery completion without claiming table continuity', () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      onRuntimeEvent: event => events.push(event),
    });

    server.ingestClientMessage({
      kind: 'sessionAction',
      action: 'recovery-failed',
      url: 'https://www.dafabet.net/room?token=secret',
      frame: 'iframe',
      detail: 'still expired after 3 reload attempts',
      timestamp: '2026-08-27T01:00:00.000Z',
    });
    server.ingestClientMessage({
      kind: 'sessionAction',
      action: 'recovered',
      url: 'https://www.dafabet.net/room?token=secret',
      frame: 'iframe',
      timestamp: '2026-08-27T01:01:00.000Z',
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'session-recovery-exhausted' }),
      expect.objectContaining({ kind: 'session-recovered' }),
    ]));
  });

  it('redacts diagnostic URLs and never retains title, body, or HTML previews', () => {
    expect(redactBridgeDiagnostic({
      kind: 'diagnostic',
      url: 'https://www.dafabet.net/room?token=secret&account=alice',
      frame: 'iframe',
      readyState: 'complete',
      title: 'private title',
      bodyTextPreview: 'private body',
      htmlPreview: '<div>private html</div>',
      candidateCount: 1,
      canvasCount: 2,
      videoCount: 3,
      iframeCount: 4,
    })).toEqual({
      kind: 'diagnostic',
      url: 'https://www.dafabet.net/room',
      frame: 'iframe',
      readyState: 'complete',
      titleLength: 13,
      bodyTextLength: 12,
      htmlLength: 23,
      candidateCount: 1,
      canvasCount: 2,
      videoCount: 3,
      iframeCount: 4,
    });
  });
});

describe('dynamic selection session boundaries', () => {
  it('starts a newly selected table with a fresh logical monitor session after background protocol traffic', async () => {
    const fixture = fixtures.find(value => value.id === 'bcst-phase1-betting-01');
    if (!fixture) throw new Error('protocol fixture missing');
    const d065ProtocolData = Buffer.from(
      Buffer.from(fixture.base64, 'base64').toString('latin1').replace(/P020/g, 'D065'),
      'latin1',
    ).toString('base64');
    const capture = {
      kind: 'networkCapture' as const,
      source: 'baccarat-bridge-ws',
      url: 'wss://ty242c.mdvuz.com:5000',
      direction: 'recv' as const,
      encoding: 'base64' as const,
      data: d065ProtocolData,
    };
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055'] });

    server.ingestClientMessage(capture);
    server.setSelectedTableIds(['D065']);
    server.ingestClientMessage(capture);

    const feed = server.openTable('dafabet-live', 'D065');
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();

    expect(events[0]).toEqual(expect.objectContaining({
      type: 'newShoeSignal',
      baseline: 'unknown-monitor-session',
    }));
    expect(events.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(2);
  });

  it('preserves parser state for tables that remain selected during a whitelist update', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055', 'D065'] });
    const capture = {
      kind: 'networkCapture' as const,
      source: 'baccarat-bridge-runtime-state',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      direction: 'recv' as const,
      encoding: 'text' as const,
      data: JSON.stringify({
        tableId: 'D055',
        roundId: 'GD055-stable',
        gmstatus: 0,
        playerScore: 1,
        bankerScore: 2,
        playerCards: [0x01],
        bankerCards: [0x12],
        capturedAt: '2026-08-23T05:01:00.000Z',
      }),
    };

    server.ingestClientMessage(capture);
    const feed = server.openTable('dafabet-live', 'D055');
    const events: NormalizedEvent[] = [];
    await feed.start({ onBatch: batch => { events.push(...batch.events); } });
    await feed.flush();
    const beforeUpdate = events.length;

    server.setSelectedTableIds(['D065', 'D055']);
    server.ingestClientMessage(capture);
    await feed.flush();

    expect(events).toHaveLength(beforeUpdate);
  });
});

describe('runtime-selection recovery after configuration changes', () => {
  it('requests multiview recovery when the new whitelist has no runtime-selection overlap', async () => {
    const server = new BrowserBridgeServer({ port: 0, selectedTableIds: ['D055', 'D065'] });
    const port = await server.start();
    const client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      server.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-runtime-selection',
        url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({ tableIds: ['D055'] }),
      });
      const recovery = new Promise<{ kind: string; name?: string }>(resolve => {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as { kind: string; name?: string };
          if (message.kind === 'command' && message.name === 'openMultiView') resolve(message);
        });
      });

      server.setSelectedTableIds(['D065']);

      await expect(recovery).resolves.toEqual(expect.objectContaining({
        kind: 'command',
        name: 'openMultiView',
      }));
    } finally {
      client.close();
      await server.close();
    }
  });
});
