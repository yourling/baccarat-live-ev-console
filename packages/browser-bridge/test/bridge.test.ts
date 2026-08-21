import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { BetExecutionRequest } from '@baccarat/adapter-contract';
import { BrowserBridgeServer } from '../src/index.js';
import type { NormalizedEvent } from '@baccarat/contracts';

function bridgeEvent(): NormalizedEvent {
  return {
    type: 'newShoeSignal',
    eventId: 'e1',
    tableId: 't1',
    timestamp: '2025-01-01T00:00:00.000Z',
    sourceSeq: 1,
    shoeId: 's1',
    profile: {
      tableId: 't1',
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

function betRequest(): BetExecutionRequest {
  return {
    intent: {
      intentId: 'i1',
      tableId: 't1',
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 10,
      mode: 'simulated',
      idempotencyKey: 'k1',
      strategy: { type: 'both' },
      decisionSnapshotId: 'd1',
      createdAt: new Date().toISOString(),
    },
    mode: 'simulated',
    reservationId: 'rv1',
  };
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

  it('forwards disconnect and restore lifecycle to the sink', async () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    const restores: string[] = [];

    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => { disconnects.push(reason ?? ''); },
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });
    server.ingestClientMessage({ kind: 'tableDisconnected', roomId: 'r1', tableId: 't1', reason: 'page hidden' });
    server.ingestClientMessage({ kind: 'tableRestored', roomId: 'r1', tableId: 't1', proof: 'proof-1' });

    expect(disconnects).toEqual(['page hidden']);
    expect(restores).toEqual(['proof-1']);
    expect(feed.health().reconnectCount).toBe(1);
    expect(feed.health().state).toBe('CONNECTED');
  });

  it('round-trips real bet execution requests through a WebSocket extension client', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
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

  it('marks exports disconnected on game session expiry and restores on recovery action', async () => {
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
    expect(feed.health().state).toBe('CONNECTED');
    expect(restores).toEqual(['session-recovered']);
    expect(feed.health().reconnectCount).toBe(1);
  });

  it('restores an expired export and delivers the next live table event', async () => {
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

    // 页面自动恢复后第一帧实时数据应当重新点亮导出并正常投递。
    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: bridgeEvent(),
    });
    await feed.flush();

    expect(restores).toEqual(['data-received']);
    expect(feed.health().state).toBe('CONNECTED');
    expect(batches).toHaveLength(1);
    expect(batches[0].events[0].eventId).toBe('e1');
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
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
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

  it('broadcasts truncated game-channel network captures to observers only', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
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
    expect(seen.message.data.length).toBeLessThan(longData.length);

    client.close();
    await server.close();
  });
});
