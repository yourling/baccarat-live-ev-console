/**
 * P0-1 回归：本机桥的认证边界 = 扩展 installId + 操作员批准。
 *
 * 修复前的攻击面（review/scripts/ledger/b7b、b7d）：
 *   扩展 ID 可由 manifest 公钥推导、token 是三个 background.js 里的明文常量 →
 *   任意本机进程手写 `Origin: chrome-extension://<推导 ID>` + `?token=<明文>` 就能
 *   占住唯一扩展槽、拿 executor lease、收真实 betRequest、回伪造回执。
 *
 * 修复后：Origin+token 只做噪声过滤；缺 installId / installId 未批准 → pending 角色，
 * 不占槽、不拿 lease、不 ingest 任何事件、收不到 betRequest。
 */
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { BetExecutionRequest } from '@baccarat/adapter-contract';
import {
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_TOKEN,
  BrowserBridgeServer,
  MemoryExtensionApprovalStore,
  type BrowserBridgeRuntimeEvent,
} from '../src/index.js';

const EXT_ORIGIN = `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}`;
const APPROVED_INSTALL = 'approved-install-0001';
const UNKNOWN_INSTALL = 'unknown-install-0001';

function extensionUrl(port: number, installId?: string): string {
  const base = `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`;
  return installId === undefined ? base : `${base}&installId=${installId}`;
}

async function connect(url: string, origin = EXT_ORIGIN): Promise<{
  client: WebSocket;
  received: Array<Record<string, unknown>>;
}> {
  const client = new WebSocket(url, { origin });
  const received: Array<Record<string, unknown>> = [];
  client.on('message', data => {
    try { received.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  return { client, received };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

function liveBetRequest(): BetExecutionRequest {
  return {
    mode: 'live',
    reservationId: 'rv-p01',
    intent: {
      intentId: 'intent-p01',
      tableId: 'bc281koreanch281',
      shoeId: 'shoe-p01',
      handId: 'hand-p01',
      market: 'bankerPair',
      amount: 10,
      mode: 'live',
      idempotencyKey: 'k-p01',
      strategy: { type: 'fixed', market: 'bankerPair' },
      decisionSnapshotId: 'decision-p01',
      createdAt: '2026-09-04T00:00:00.000Z',
    },
  };
}

function tableEvent(seq = 1) {
  return {
    type: 'newShoeSignal' as const,
    eventId: `pending-forged-${seq}`,
    tableId: 't1',
    timestamp: '2025-01-01T00:00:00.000Z',
    sourceSeq: seq,
    shoeId: 's1',
    baseline: 'physical-shoe' as const,
    profile: {
      tableId: 't1',
      numberOfDecks: 8,
      pairRule: { kind: 'standard' as const },
      odds: {
        bankerPair: { netWin: 11, loss: 1 },
        playerPair: { netWin: 11, loss: 1 },
      },
      burnModel: { kind: 'unknown' as const },
      minEV: 0,
      limits: { minBet: 1, maxBet: 1000 },
      autoConfirmNewShoe: true,
      betStrategy: { type: 'both' as const },
    },
  };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 40));
}

describe('P0-1 extension install approval boundary', () => {
  it('rejects an extension socket without installId into pending (no lease, no events, no bets)', async () => {
    // 严格模式：传 store，但 store 里没有任何已批准项。
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
      extensionApprovals: new MemoryExtensionApprovalStore(),
    });
    const port = await server.start();
    const feed = server.openTable('dafabet-pragmatic', 't1');
    const batches: unknown[] = [];
    await feed.start({ onBatch: batch => { batches.push(batch); } });
    const { client, received } = await connect(extensionUrl(port));
    try {
      // 1) 收到明确的配对信号。
      await waitFor(() => received.some(message => message.kind === 'pairingRequired'));
      const pairing = received.find(message => message.kind === 'pairingRequired')!;
      expect(pairing).toMatchObject({ kind: 'pairingRequired', serverVersion: expect.any(String) });
      expect(pairing.installId).toBeUndefined();

      // 2) 桥视角：没有扩展连接、未认证、没有 executor lease。
      expect(server.getExtensionStatus()).toMatchObject({
        connectionCount: 0,
        authenticated: false,
      });
      expect(server.getExecutorStatus().active_executor_count).toBe(0);

      // 3) pending 连接发 tableEvent：不产生任何交付、不发现桌台。
      client.send(JSON.stringify({
        kind: 'tableEvent',
        roomId: 'dafabet-pragmatic',
        tableId: 't1',
        event: tableEvent(),
        bridgeSessionId: 'pending-session-1',
        bridgeSeq: 1,
      }));
      await settle();
      expect(batches).toEqual([]);
      expect(feed.health().state).toBe('CONNECTED');
      expect(feed.health().lastAckedSeq).toBe(0);
      expect(server.getDiscoveredRooms()).toEqual([]);

      // 4) 也不能靠 hello 拿 lease。
      client.send(JSON.stringify({
        kind: 'hello',
        extensionVersion: '0.1.0',
        browser: 'attacker',
        timestamp: new Date().toISOString(),
        executorProfileId: 'attacker-profile-1',
        bridgeSessionId: 'pending-session-1',
        bridgeSeq: 2,
      }));
      await settle();
      expect(server.getExecutorStatus().active_executor_count).toBe(0);

      // 5) 下注请求必须失败（fail-closed），且 pending socket 收不到 betRequest。
      await expect(server.requestBet(liveBetRequest())).rejects.toThrow();
      expect(received.some(message => message.kind === 'betRequest')).toBe(false);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('rejects an unapproved installId while an approved install keeps the extension role', async () => {
    const approvals = new MemoryExtensionApprovalStore([APPROVED_INSTALL]);
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
      extensionApprovals: approvals,
      betTimeoutMs: 100,
    });
    const port = await server.start();
    const unapproved = await connect(extensionUrl(port, UNKNOWN_INSTALL));
    const approved = await connect(extensionUrl(port, APPROVED_INSTALL));
    try {
      await waitFor(() => unapproved.received.some(message => message.kind === 'pairingRequired'));
      // 未批准的那条拿到 pairingRequired + 它的 installId（便于操作员批准），但不占槽。
      expect(unapproved.received.find(message => message.kind === 'pairingRequired')?.installId)
        .toBe(UNKNOWN_INSTALL);
      await waitFor(() => server.getExtensionStatus().connectionCount === 1);
      expect(server.getExtensionStatus().authenticated).toBe(false); // 还没交 hello 拿 lease
      expect(server.getExtensionPendingInstallIds()).toContain(UNKNOWN_INSTALL);

      // 已批准的连接仍然是唯一的 extension socket；未批准的那条收不到任何下行 betRequest。
      approved.client.send(JSON.stringify({
        kind: 'hello',
        extensionVersion: '0.1.0',
        browser: 'Chrome',
        timestamp: new Date().toISOString(),
        executorProfileId: 'profile-approved-1',
        bridgeSessionId: 'approved-session-1',
        bridgeSeq: 1,
      }));
      await waitFor(() => server.getExtensionStatus().authenticated === true);
      expect(server.getExecutorStatus().active_executor_count).toBe(1);

      await expect(server.requestBet(liveBetRequest())).rejects.toThrow(/timed out|no receipt/i);
      expect(unapproved.received.some(message => message.kind === 'betRequest')).toBe(false);
      expect(approved.received.some(message => message.kind === 'betRequest')).toBe(true);
    } finally {
      unapproved.client.close();
      approved.client.close();
      await server.close();
    }
  });

  it('keeps a forged Origin + plaintext token connection in pending (b7d attack path)', async () => {
    // 完全复刻 b7d：伪造已打包扩展的 Origin、带上源码里的明文 token、不带 installId。
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
      allowedExtensionIds: [BUNDLED_BROWSER_EXTENSION_ID],
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
      extensionApprovals: new MemoryExtensionApprovalStore(),
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const attacker = await connect(extensionUrl(port), EXT_ORIGIN);
    try {
      await waitFor(() => attacker.received.some(message => message.kind === 'pairingRequired'));
      // 事故事件可见，但不带 installId（缺省 → ''），不会把本机标识写进日志/事故。
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'extension-pairing-required',
        installId: '',
      }));
      expect(attacker.received.some(message => message.kind === 'welcome')).toBe(true);

      // 攻击者试图抢唯一扩展槽：占不到。
      expect(server.getExtensionStatus().connectionCount).toBe(0);
      expect(server.getExecutorStatus().active_executor_count).toBe(0);

      // 真正的（已批准）扩展仍然可以连上并拿到 lease —— 攻击面不占槽。
      const realApprovals = new MemoryExtensionApprovalStore([APPROVED_INSTALL]);
      const realServer = new BrowserBridgeServer({
        port: 0,
        requireExtensionSequence: true,
        extensionApprovals: realApprovals,
      });
      const realPort = await realServer.start();
      const real = await connect(extensionUrl(realPort, APPROVED_INSTALL));
      try {
        await waitFor(() => realServer.getExtensionStatus().connectionCount === 1);
        expect(realServer.getExtensionStatus().connectionCount).toBe(1);
        real.client.send(JSON.stringify({
          kind: 'hello',
          extensionVersion: '0.1.0',
          browser: 'Chrome',
          timestamp: new Date().toISOString(),
          executorProfileId: 'real-profile-1',
          bridgeSessionId: 'real-session-1',
          bridgeSeq: 1,
        }));
        await waitFor(() => realServer.getExtensionStatus().authenticated === true);
      } finally {
        real.client.close();
        await realServer.close();
      }
    } finally {
      attacker.client.close();
      await server.close();
    }
  });

  it('does not let a pending connection occupy the single extension slot', async () => {
    const approvals = new MemoryExtensionApprovalStore([APPROVED_INSTALL]);
    const server = new BrowserBridgeServer({ port: 0, extensionApprovals: approvals });
    const port = await server.start();
    // 先让未批准的连接占住（以前这会挤掉真扩展）。
    const pending = await connect(extensionUrl(port, UNKNOWN_INSTALL));
    try {
      await waitFor(() => pending.received.some(message => message.kind === 'pairingRequired'));
      // 已批准的扩展仍然能连上（socket 不 close，直接 opened）。
      const approved = await connect(extensionUrl(port, APPROVED_INSTALL));
      try {
        await waitFor(() => server.getExtensionStatus().connectionCount === 1);
        expect(server.getExtensionStatus().connectionCount).toBe(1);
        expect(pending.client.readyState).toBe(WebSocket.OPEN);
        expect(approved.client.readyState).toBe(WebSocket.OPEN);
      } finally {
        approved.client.close();
      }
    } finally {
      pending.client.close();
      await server.close();
    }
  });

  it('promotes the pending socket when the operator approves its installId', async () => {
    const approvals = new MemoryExtensionApprovalStore();
    const server = new BrowserBridgeServer({ port: 0, extensionApprovals: approvals });
    const port = await server.start();
    const { client, received } = await connect(extensionUrl(port, UNKNOWN_INSTALL));
    try {
      await waitFor(() => received.some(message => message.kind === 'pairingRequired'));
      expect(server.getExtensionStatus().connectionCount).toBe(0);
      expect(server.listPendingExtensions().map(entry => entry.installId)).toContain(UNKNOWN_INSTALL);

      server.approveExtension(UNKNOWN_INSTALL);
      // approve 默认写回 store（桌面端注入的落盘实现才需要持久化）。
      expect(approvals.isApproved(UNKNOWN_INSTALL)).toBe(true);
      await waitFor(() => received.some(message => message.kind === 'pairingApproved'));
      expect(received.find(message => message.kind === 'pairingApproved')?.installId).toBe(UNKNOWN_INSTALL);
      expect(server.getExtensionStatus().connectionCount).toBe(1);
      expect(server.getExtensionPendingInstallIds()).toEqual([]);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('replaces an existing extension socket when a different approved install is promoted', async () => {
    // 批准优先：同一时刻只能有一个 extension socket，提升新的必须踢掉旧的并留事故。
    const approvals = new MemoryExtensionApprovalStore([APPROVED_INSTALL]);
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      extensionApprovals: approvals,
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const older = await connect(extensionUrl(port, APPROVED_INSTALL));
    const newer = await connect(extensionUrl(port, UNKNOWN_INSTALL));
    try {
      await waitFor(() => server.getExtensionStatus().connectionCount === 1);
      await waitFor(() => newer.received.some(message => message.kind === 'pairingRequired'));
      const olderClosed = new Promise<number>(resolve => older.client.once('close', code => resolve(code)));

      server.approveExtension(UNKNOWN_INSTALL);
      await expect(olderClosed).resolves.toBe(1008);
      await waitFor(() => newer.received.some(message => message.kind === 'pairingApproved'));
      await waitFor(() => server.getExtensionStatus().connectionCount === 1);
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'extension-disconnected',
        reason: expect.stringContaining('extension-replaced-by-approved-install'),
      }));
    } finally {
      older.client.close();
      newer.client.close();
      await server.close();
    }
  });

  it('revokes an approved install and disconnects its live extension socket', async () => {
    const approvals = new MemoryExtensionApprovalStore([APPROVED_INSTALL]);
    const server = new BrowserBridgeServer({ port: 0, extensionApprovals: approvals });
    const port = await server.start();
    const { client } = await connect(extensionUrl(port, APPROVED_INSTALL));
    try {
      await waitFor(() => server.getExtensionStatus().connectionCount === 1);
      const closed = new Promise<number>(resolve => client.once('close', code => resolve(code)));
      server.revokeExtension(APPROVED_INSTALL);
      await expect(closed).resolves.toBe(1008);
      expect(approvals.isApproved(APPROVED_INSTALL)).toBe(false);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('reports approval state including unidentified pending connections', async () => {
    const approvals = new MemoryExtensionApprovalStore([APPROVED_INSTALL]);
    const server = new BrowserBridgeServer({ port: 0, extensionApprovals: approvals });
    const port = await server.start();
    const identified = await connect(extensionUrl(port, UNKNOWN_INSTALL));
    const unidentified = await connect(extensionUrl(port));
    try {
      await waitFor(() => server.getExtensionPendingInstallIds().length === 1);
      await settle();
      const state = server.getExtensionApprovalState();
      expect(state).toMatchObject({
        strict: true,
        approved: [APPROVED_INSTALL],
        pendingConnections: 2,
        unidentifiedPendingConnections: 1,
      });
      expect(state.pending.map(entry => entry.installId)).toContain(UNKNOWN_INSTALL);
      expect(state.pending[0]).toMatchObject({
        installId: UNKNOWN_INSTALL,
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
      });
      // installId 不出现在任何 runtime 事件之外的地方：这里只断言状态面字段。
      expect(JSON.stringify(state.pending)).not.toContain('token');
    } finally {
      identified.client.close();
      unidentified.client.close();
      await server.close();
    }
  });

  it('stays permissive for install-id-bearing clients when no store is provided', async () => {
    // 不传 store：旧单测/demo 的兼容语义（allowUnapprovedExtensions 默认 true）。
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const { client } = await connect(extensionUrl(port, 'permissive-install-1'));
    try {
      await waitFor(() => server.getExtensionStatus().connectionCount === 1);
      expect(server.getExtensionApprovalState()).toMatchObject({
        strict: false,
        allowUnapprovedExtensions: true,
        approved: [],
      });
    } finally {
      client.close();
      await server.close();
    }
  });

  it('still fails closed for install-id-bearing clients when explicitly strict without a store', async () => {
    const server = new BrowserBridgeServer({ port: 0, allowUnapprovedExtensions: false });
    const port = await server.start();
    const { client, received } = await connect(extensionUrl(port, 'strict-install-1'));
    try {
      await waitFor(() => received.some(message => message.kind === 'pairingRequired'));
      expect(server.getExtensionStatus().connectionCount).toBe(0);
      expect(server.getExtensionApprovalState().strict).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });
});
