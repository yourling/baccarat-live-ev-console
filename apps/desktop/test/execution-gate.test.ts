import { BrowserBridgeServer } from '@baccarat/browser-bridge';
import { EVENT_SCHEMA_VERSION, defaultProfile, type NormalizedEvent } from '@baccarat/contracts';
import type { OperationalWagerExecutionRequest } from '@baccarat/adapter-contract';
import type { TableExport } from '@baccarat/room-monitor';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DesktopConsoleService } from '../electron-src/service.js';

/**
 * FIX(D-P0-1) / FIX(D-P1-6) 回归：无人值守运行授权与全局 blocked 事故
 * 必须是真金执行路径的门控条件，而不是只影响 UI 的展示字段。
 *
 * 修复前（review 脚本 a1h / a1d / a1b 实证）：
 *  · `keepaliveTableReasons` / `manualLiveTableReasons` 只转调 `liveTableReasons`，
 *    完全不读 `liveAuthorizationSources` —— 多桌时 `failCloseLiveExecution`
 *    因为"别的桌还有授权"直接 return，被撤销授权的那桌 promote 后首个窗口
 *    就发出了真金保活请求；
 *  · `continuity-invalidated` 这类全局 blocked 事故只影响 runtime.status 与横幅，
 *    单桌 reasons 为空、桥"已认证连接数 1"，手动下注照样 ACCEPTED。
 */

const A = 'D055';
const B = 'D066';

function physicalShoe(tableId: string, sourceSeq = 1): Extract<NormalizedEvent, { type: 'newShoeSignal' }> {
  return {
    type: 'newShoeSignal',
    eventId: `shoe-${tableId}-${sourceSeq}`,
    tableId,
    timestamp: new Date().toISOString(),
    sourceSeq,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `shoe-${tableId}`,
    baseline: 'physical-shoe',
    profile: { ...defaultProfile(tableId), autoConfirmNewShoe: true },
  };
}

function openWindow(
  tableId: string,
  handId: string,
  sourceSeq: number,
  remainingMs = 12_000,
): Extract<NormalizedEvent, { type: 'bettingWindowOpened' }> {
  const now = Date.now();
  return {
    type: 'bettingWindowOpened',
    eventId: `open-${tableId}-${handId}-${sourceSeq}`,
    tableId,
    timestamp: new Date(now).toISOString(),
    sourceSeq,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `shoe-${tableId}`,
    handId,
    market: 'bankerPair',
    closesAt: new Date(now + remainingMs).toISOString(),
  };
}

function freshFeed(tableId: string): TableExport {
  return {
    tableId,
    start: async () => undefined,
    stop: async () => undefined,
    flush: async () => undefined,
    keepAlive: async () => ({ ok: true, latencyMs: 10 }),
    health: () => ({
      tableId,
      state: 'CONNECTED',
      lastAckedSeq: 1,
      lastEmittedSeq: 1,
      bufferDepth: 0,
      reconnectCount: 0,
      lastObservationAt: new Date().toISOString(),
      stalenessMs: 10,
    }),
  };
}

type BridgeTrace = {
  requests: OperationalWagerExecutionRequest[];
  gateCalls: boolean[];
};

function makeBridge(trace: BridgeTrace): BrowserBridgeServer {
  const bridge = new BrowserBridgeServer();
  const anyBridge = bridge as unknown as Record<string, unknown>;
  anyBridge.getExtensionStatus = () => ({
    connectionCount: 1,
    authenticated: true,
    lastSeenAt: new Date().toISOString(),
  });
  anyBridge.setLiveBetEnabled = (enabled: boolean) => { trace.gateCalls.push(enabled); };
  anyBridge.requestOperationalWager = async (request: OperationalWagerExecutionRequest) => {
    trace.requests.push(request);
    return {
      receiptId: `receipt-${request.wager.wagerId}`,
      wagerId: request.wager.wagerId,
      tableId: request.wager.tableId,
      shoeId: request.wager.shoeId,
      handId: request.wager.handId,
      market: request.wager.market,
      amount: request.wager.amount,
      source: request.wager.source,
      status: 'ACCEPTED',
      createdAt: new Date().toISOString(),
      raw: {},
    };
  };
  anyBridge.requestBet = async () => null;
  return bridge;
}

function installBridge(service: DesktopConsoleService, trace: BridgeTrace): BrowserBridgeServer {
  const bridge = makeBridge(trace);
  service['browserBridge'] = bridge;
  for (const tableId of [A, B]) service['liveFeeds'].set(tableId, freshFeed(tableId));
  return bridge;
}

describe('DesktopConsoleService execution authorization gate', () => {
  it('sends zero keepalive requests to a table that has no unattended authorization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixd-auth-gate-'));
    const service = new DesktopConsoleService(join(directory, 'console.sqlite'));
    const trace: BridgeTrace = { requests: [], gateCalls: [] };
    try {
      installBridge(service, trace);
      const ledger = service['ledger'];
      await service.updateMonitorTableIds([A]);
      await service.injectEvent(physicalShoe(A, ledger.allocateSourceSeq(A)));
      await service.injectEvent(openWindow(A, 'hand-A-1', ledger.allocateSourceSeq(A)));
      // 建立 A 的无人值守授权 + 打开保活。
      await service['reconcileUnattendedExecution']();
      await service.setKeepaliveEnabled(true);
      expect([...service['liveAuthorizationSources'].keys()]).toEqual([A]);

      // B 接入后 resetMonitorExecutionState 会删掉 B 的授权，且事件路径里
      // 保活 tick 先于 reconcileUnattendedExecution 入队。
      await service.updateMonitorTableIds([A, B]);
      service['liveFeeds'].set(B, freshFeed(B));
      await service['resetMonitorExecutionState'](B);
      expect(service['liveAuthorizationSources'].has(B)).toBe(false);

      // 该桌此刻没有任何无人值守授权 —— 门控原因必须能解释为什么不能发（供 UI/运维定位）。
      // 注意要在注入窗口之前断言：事件泵末尾的 reconcileUnattendedExecution 会补回授权，
      // 那正是修复前"先发请求、后补授权"的时序漏洞。
      expect(service['keepaliveTableReasons'](B, true)).toContain('table-not-authorized');
      expect(service['wagerConsole'].runtimeBlockReason(B, 'keepalive'))
        .toContain('table-not-authorized');

      await service.injectEvent(physicalShoe(B, ledger.allocateSourceSeq(B)));
      const before = trace.requests.length;
      await service.injectEvent(openWindow(B, 'hand-B-1', ledger.allocateSourceSeq(B)));
      // 给保活 tick 与 reconcile 留出执行时间。
      await new Promise(resolve => setTimeout(resolve, 250));

      const sent = trace.requests.slice(before);
      expect(sent.map(request => request.wager.tableId)).not.toContain(B);
      // reconcile 之后授权会被补回（这是正常路径），请求依然不能发生在授权之前。
      expect(service['liveAuthorizationSources'].has(B)).toBe(true);
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('still keeps an authorized healthy table alive (no false kill)', async () => {
    const service = new DesktopConsoleService(':memory:');
    const trace: BridgeTrace = { requests: [], gateCalls: [] };
    try {
      installBridge(service, trace);
      const ledger = service['ledger'];
      await service.updateMonitorTableIds([A]);
      await service.injectEvent(physicalShoe(A, ledger.allocateSourceSeq(A)));
      await service.injectEvent(openWindow(A, 'hand-A-1', ledger.allocateSourceSeq(A)));
      await service['reconcileUnattendedExecution']();
      await service.setKeepaliveEnabled(true);

      expect([...service['liveAuthorizationSources'].keys()]).toEqual([A]);
      expect(service['keepaliveTableReasons'](A, true)).not.toContain('table-not-authorized');

      // 保活用的第一个窗口已经被基线用掉；再开一个新窗口让 tick 有东西可打。
      await service.injectEvent(openWindow(A, 'hand-A-2', ledger.allocateSourceSeq(A), 20_000));
      await service['operationalWagers'].tick();
      await new Promise(resolve => setTimeout(resolve, 200));

      const keepalives = trace.requests.filter(request => request.wager.source === 'keepalive');
      expect(keepalives.map(request => request.wager.tableId)).toContain(A);
    } finally {
      await service.close();
    }
  });

  it('blocks a manual wager when a global blocked incident is active, and recovers after it resolves', async () => {
    const service = new DesktopConsoleService(':memory:');
    const trace: BridgeTrace = { requests: [], gateCalls: [] };
    try {
      installBridge(service, trace);
      const ledger = service['ledger'];
      await service.updateMonitorTableIds([A]);
      await service.injectEvent(physicalShoe(A, ledger.allocateSourceSeq(A)));
      await service.injectEvent(openWindow(A, 'hand-A-1', ledger.allocateSourceSeq(A)));
      await service.setExecutionMode(A, 'live');

      // 无事故时手动下注可执行。
      const ok = await service.executeOperationalWager({ tableId: A, market: 'banker', amount: 20 });
      expect(ok.status).toBe('ACCEPTED');

      // FIX(D-P1-6): 注入全局 blocked 事故后必须拒绝，并给出具体 code。
      const incident = service['runtimeIncidents'].record({
        code: 'continuity-invalidated',
        severity: 'blocked',
        message: 'table continuity invalidated',
      });
      const blocked = await service.executeOperationalWager({ tableId: A, market: 'player', amount: 20 });
      expect(blocked.status).toBe('REJECTED');
      expect(String(blocked.reason)).toContain('runtime-blocked:continuity-invalidated');
      const requestsWhileBlocked = trace.requests.length;

      // 保活路径同样被拒。
      expect(service['keepaliveTableReasons'](A, true)).toBeDefined();
      expect(service['wagerConsole'].runtimeBlockReason(A, 'keepalive'))
        .toContain('runtime-blocked:continuity-invalidated');

      // 事故恢复后可以继续下注（换一手 + 新窗口）。先把第一手结算掉，
      // 否则 settlement-gap 门控会挡住下一手（那是另一条正确的 fail-closed 规则）。
      service['runtimeIncidents'].resolve(incident.code);
      await service.injectEvent({
        type: 'handSettled',
        eventId: 'settle-hand-A-1',
        tableId: A,
        timestamp: new Date().toISOString(),
        sourceSeq: ledger.allocateSourceSeq(A),
        source: 'pragmatic-runtime',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId: `shoe-${A}`,
        handId: 'hand-A-1',
        playerCards: [{ rank: '5' }, { rank: 'A' }],
        bankerCards: [{ rank: '9' }, { rank: '9' }],
        outcomes: { bankerPair: false, playerPair: false },
      });
      await service.injectEvent(openWindow(A, 'hand-A-3', ledger.allocateSourceSeq(A), 30_000));
      const recovered = await service.executeOperationalWager({
        tableId: A,
        market: 'player',
        amount: 20,
        handId: 'hand-A-3',
      });
      expect(recovered.status, `reason=${String(recovered.reason)}`).toBe('ACCEPTED');
      expect(trace.requests.length).toBeGreaterThan(requestsWhileBlocked);
    } finally {
      await service.close();
    }
  });

  it('allows a manual wager to establish its own authorization (first manual bet is not deadlocked)', async () => {
    const service = new DesktopConsoleService(':memory:');
    const trace: BridgeTrace = { requests: [], gateCalls: [] };
    try {
      installBridge(service, trace);
      const ledger = service['ledger'];
      await service.updateMonitorTableIds([A]);
      await service.injectEvent(physicalShoe(A, ledger.allocateSourceSeq(A)));
      await service.injectEvent(openWindow(A, 'hand-A-1', ledger.allocateSourceSeq(A)));
      // 先批准 live（写 liveApprovals），但**不**经 setExecutionMode 建立 manual 授权。
      await service.setExecutionMode(A, 'live');
      service['liveAuthorizationSources'].clear();

      // 手动下注不因"尚无授权"被拒 —— 它自己就是授权来源。
      const result = await service.executeOperationalWager({ tableId: A, market: 'banker', amount: 20 });
      expect(result.status).toBe('ACCEPTED');
      expect(trace.requests.some(request => request.wager.source === 'manual')).toBe(true);

      // 但保活路径在授权缺失时仍然被门控挡住。
      expect(service['keepaliveTableReasons'](A, true)).toContain('table-not-authorized');
      expect(service['keepaliveTableReasons'](A, false)).not.toContain('table-not-authorized');
    } finally {
      await service.close();
    }
  });

  it('records process-restarted connection loss and leaves the projection disconnected after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixd-restart-'));
    const dbPath = join(directory, 'console.sqlite');
    const first = new DesktopConsoleService(dbPath);
    try {
      const trace: BridgeTrace = { requests: [], gateCalls: [] };
      const bridge = installBridge(first, trace);
      vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
      const ledger = first['ledger'];
      await first.updateMonitorTableIds([A]);
      await first.injectEvent(physicalShoe(A, ledger.allocateSourceSeq(A)));
      await first.injectEvent(openWindow(A, 'hand-A-1', ledger.allocateSourceSeq(A)));
      // 走真实批准路径：写 liveApprovals（持久化），这是重启后判断"上一进程 live"的依据。
      await first.setExecutionMode(A, 'live');
      await first.close();

      const restarted = new DesktopConsoleService(dbPath);
      try {
        await restarted['startupFailCloseTask'];
        const restartEvents = restarted['ledger'].listEvents(A)
          .filter(event => event.type === 'connectionLost'
            && (event as Extract<NormalizedEvent, { type: 'connectionLost' }>).reason === 'process-restarted');
        expect(restartEvents).toHaveLength(1);

        const projection = restarted.snapshot().snapshot.tables[A]?.projection;
        // 重启后绝不能显示为"已连接"（修复前死分支导致这里仍是 CONNECTED）。
        expect(projection?.connectionStatus).not.toBe('CONNECTED');
        expect(projection?.shoeId).toBe('');
        // 重启后无人值守授权为空、executor 为 null、保活关闭。
        expect([...restarted['liveAuthorizationSources'].keys()]).toEqual([]);
        expect(restarted['currentExecutor']).toBeNull();
        expect(restarted.snapshot().keepalive.enabled).toBe(false);
        expect(restarted.snapshot().runtime.executionReady).toBe(false);
      } finally {
        await restarted.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
