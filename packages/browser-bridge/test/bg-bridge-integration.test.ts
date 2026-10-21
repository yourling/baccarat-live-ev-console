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
  MemoryExtensionApprovalStore,
} from '../src/index.js';

/** P0-1: 兼容放行模式（不传 extensionApprovals）下也必须带 installId 才能拿 extension 角色。 */
const TEST_INSTALL_ID = 'bg-test-install-01';

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

async function waitForMessage(
  messages: ReadonlyArray<{ kind?: string }>,
  kind: string,
  timeoutMs = 1_000,
): Promise<void> {
  await waitFor(() => messages.some(message => message.kind === kind), timeoutMs);
}

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

/**
 * FIX(flaky): 原实现在两次 `await connectOutcome(...)` 之间才有监听器挂到第二个 socket 上，
 * 而 `ws` 对 401 的 'error' 事件可能在任何 await 期间就 emit —— 没有监听器的 'error'
 * 在 Node 里会抛 `Unhandled error`，导致用例 5s 超时（实测单文件连跑 12 次失败 3~4 次）。
 *
 * 现在的约束（调用方必须遵守）：
 *   1. socket 构造后**立刻**调用本函数（同 tick 挂监听，不要先 await 别的）；
 *   2. 全部 outcome promise 先同步建好，再逐个 await。
 * 监听器在 settle 后**保留**（靠 `settled` 短路），避免迟到的 'error' 变成未捕获异常。
 */
function connectOutcome(client: WebSocket): Promise<'opened' | 'rejected'> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (outcome: 'opened' | 'rejected', response?: import('node:http').IncomingMessage): void => {
      if (settled) return;
      settled = true;
      if (response) response.resume();
      // 已 settle 后 socket 仍可能报错/关闭，这里的监听器会短路成 no-op，
      // 但仍然必须存在，否则 ws 会把 'error' 抛成 Unhandled error。
      resolve(outcome);
    };
    client.on('open', () => settle('opened'));
    client.on('unexpected-response', (_request, response) => settle('rejected', response));
    client.on('error', () => settle('rejected'));
    client.on('close', () => settle('rejected'));
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
    expect(server.shoeEvidence('A31')).toEqual({ reason: 'attach' });
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).toEqual(['A31']);
  });

  it('records shuffle evidence for BG tables that are not yet selected', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['B06'] });
    server.ingestClientMessage(bgState([
      { tableId: 'C05', roundId: '1910001', shuffleEvent: true, shoeReset: 'seq:1910001', source: 'protocol' },
    ]));
    expect(server.shoeEvidence('C05')).toEqual({ reason: 'attach' });
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
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}&installId=${TEST_INSTALL_ID}`,
      { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
    );
    // FIX(flaky): 必须在构造后同 tick 挂监听，否则 401 的 'error' 会在 await 期间变成未捕获异常。
    const pragmaticOutcome = connectOutcome(pragmatic);
    const unknown = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}&installId=${TEST_INSTALL_ID}`,
      { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    );
    const unknownOutcome = connectOutcome(unknown);
    try {
      expect(await pragmaticOutcome).toBe('opened');
      expect(await unknownOutcome).toBe('rejected');
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
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}&installId=${TEST_INSTALL_ID}`,
      { origin: `chrome-extension://${BUNDLED_BG_BROWSER_EXTENSION_ID}` },
    );
    try {
      expect(await connectOutcome(bg)).toBe('opened');
    } finally {
      bg.close();
      await server.close();
    }
  });

  /**
   * FIX(P0-1) 安全收紧：旧式连接（只带 Origin + token、没有 installId）不再获得
   * extension 角色。以前这正是 b7d 的攻击方式：扩展 ID 可从 manifest 公钥推导、
   * token 是明文常量 → 本机任意进程都能冒充扩展。现在它只能拿到 pairingRequired。
   */
  it('rejects the legacy Origin+token connection into a pending pairing role (P0-1)', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      allowedExtensionIds: [BUNDLED_BROWSER_EXTENSION_ID, BUNDLED_BG_BROWSER_EXTENSION_ID],
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
    });
    const port = await server.start();
    // 不带 installId —— 与 b7d 的伪造 Origin + 明文 token 完全一致。
    const legacy = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`,
      { origin: `chrome-extension://${BUNDLED_BG_BROWSER_EXTENSION_ID}` },
    );
    const messages: Array<{ kind?: string }> = [];
    legacy.on('message', data => {
      try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    try {
      expect(await connectOutcome(legacy)).toBe('opened');
      // 连接本身能建立（才能收到配对提示），但只拿到 pending 角色。
      await waitForMessage(messages, 'pairingRequired');
      const status = server.getExtensionStatus();
      expect(status.connectionCount).toBe(0);
      expect(status.authenticated).toBe(false);
      expect(server.getExecutorStatus().active_executor_count).toBe(0);
    } finally {
      legacy.close();
      await server.close();
    }
  });

  /**
   * FIX(P0-1)：操作员批准 installId 之后，同一扩展能正常连接并执行下注。
   */
  it('grants the extension role and accepts bets after the operator approves the installId', async () => {
    const approvals = new MemoryExtensionApprovalStore();
    const server = new BrowserBridgeServer({
      port: 0,
      allowedExtensionIds: [BUNDLED_BROWSER_EXTENSION_ID, BUNDLED_BG_BROWSER_EXTENSION_ID],
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
      extensionApprovals: approvals,
    });
    const port = await server.start();
    const installId = 'bg-approved-install-1';
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}&installId=${installId}`,
      { origin: `chrome-extension://${BUNDLED_BG_BROWSER_EXTENSION_ID}` },
    );
    const messages: Array<{ kind?: string }> = [];
    client.on('message', data => {
      try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    try {
      expect(await connectOutcome(client)).toBe('opened');
      // 未批准：pending 角色，只收到 pairingRequired。
      await waitForMessage(messages, 'pairingRequired');
      expect(server.getExtensionStatus().authenticated).toBe(false);
      expect(server.getExtensionPendingInstallIds()).toContain(installId);

      // 操作员批准 → 桥把 pending socket 就地提升为 extension 角色。
      server.approveExtension(installId);
      await waitForMessage(messages, 'pairingApproved');
      await waitFor(() => server.getExtensionStatus().connectionCount === 1);
      expect(server.getExtensionStatus().authenticated).toBe(true);

      client.on('message', data => {
        const message = JSON.parse(data.toString()) as { kind?: string; requestId?: string };
        if (message.kind !== 'betRequest' || !message.requestId) return;
        client.send(JSON.stringify({
          kind: 'betResult',
          requestId: message.requestId,
          receipt: {
            receiptId: 'bg-operational-receipt-approved-1',
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
      }));
    } finally {
      client.close();
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
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}&installId=${TEST_INSTALL_ID}`,
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
