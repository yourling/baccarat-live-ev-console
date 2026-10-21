import { describe, expect, it, vi } from 'vitest';
import type { OperationalWagerExecutionRequest } from '@baccarat/adapter-contract';
import { BrowserBridgeServer } from '@baccarat/browser-bridge';
import { EVENT_SCHEMA_VERSION, defaultProfile, type NormalizedEvent } from '@baccarat/contracts';
import type { TableExport } from '@baccarat/room-monitor';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopConsoleService } from '../electron-src/service.js';

/**
 * FIX(D-P2-2): 清除监控记录不能清零风控计数。
 *
 * 修复前 `SqliteLedger.clearMonitorData()` 会 `DELETE FROM risk_state` ——
 * 操作员点一次"清除记录"就把当日/每桌/每靴亏损归零，等于绕过止损额度
 * （`perDayLossLimit` / `perTableLossLimit` / `perShoeLossLimit`）。
 * fix-b 已在 ledger 层删掉那条 DELETE（`RiskManager.dropReservationsKeepingAccounting()`
 * 只丢弃预留、保留全部计数）；本文件在 **service 层**用真实执行链路加行为断言，
 * 防止这条语义再被改回去。
 *
 * 注意：必须走真实执行链路（手动下注 → 平台回执 → 结算），
 * 直接往账本塞 RESERVED 行只会绕过 RiskManager，dayLoss 永远是 0。
 */

function physicalShoe(tableId: string): Extract<NormalizedEvent, { type: 'newShoeSignal' }> {
  return {
    type: 'newShoeSignal',
    eventId: `shoe-${tableId}`,
    tableId,
    timestamp: new Date().toISOString(),
    sourceSeq: 1,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `shoe-${tableId}`,
    baseline: 'physical-shoe',
    profile: { ...defaultProfile(tableId), autoConfirmNewShoe: true },
  };
}

function openWindow(tableId: string): Extract<NormalizedEvent, { type: 'bettingWindowOpened' }> {
  // timestamp 与 closesAt 必须同轴（都用 Date.now()）：table-actor 在事件时钟与
  // 真实时钟偏差 <60s 时用真实时钟评估窗口，否则退回事件时钟。
  const nowMs = Date.now();
  return {
    type: 'bettingWindowOpened',
    eventId: `open-${tableId}`,
    tableId,
    timestamp: new Date(nowMs).toISOString(),
    sourceSeq: 2,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `shoe-${tableId}`,
    handId: `hand-${tableId}`,
    market: 'bankerPair',
    closesAt: new Date(nowMs + 12_000).toISOString(),
  };
}

function settleHand(tableId: string): Extract<NormalizedEvent, { type: 'handSettled' }> {
  return {
    type: 'handSettled',
    eventId: `settled-${tableId}`,
    tableId,
    timestamp: new Date(Date.now() + 60_000).toISOString(),
    sourceSeq: 3,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `shoe-${tableId}`,
    handId: `hand-${tableId}`,
    // 闲 6 点、庄 8 点 => 庄赢（押庄则盈利，dayLoss 变负；本用例只要求非零）。
    playerCards: [{ rank: '5' }, { rank: 'A' }],
    bankerCards: [{ rank: '9' }, { rank: '9' }],
    outcomes: { bankerPair: false, playerPair: false },
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
      lastAckedSeq: 2,
      lastEmittedSeq: 2,
      bufferDepth: 0,
      reconnectCount: 0,
      lastObservationAt: new Date().toISOString(),
      stalenessMs: 10,
    }),
  };
}

function authenticateBridge(bridge: BrowserBridgeServer): void {
  vi.spyOn(bridge, 'getExtensionStatus').mockReturnValue({
    connectionCount: 1,
    authenticated: true,
    lastSeenAt: new Date().toISOString(),
  });
}

async function placeAcceptedManualWager(
  service: DesktopConsoleService,
  bridge: BrowserBridgeServer,
): Promise<void> {
  const requestOperationalWager = vi.spyOn(bridge, 'requestOperationalWager')
    .mockImplementation(async (request: OperationalWagerExecutionRequest) => ({
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
    }));
  authenticateBridge(bridge);
  service['browserBridge'] = bridge;
  await service.updateMonitorTableIds(['D055']);
  service['liveFeeds'].set('D055', freshFeed('D055'));
  await service.injectEvent(physicalShoe('D055'));
  await service.injectEvent(openWindow('D055'));

  const result = await service.executeOperationalWager({
    tableId: 'D055',
    market: 'banker',
    amount: 20,
  });
  expect(result.status, `manual wager rejected: ${String(result.reason)}`).toBe('ACCEPTED');
  expect(requestOperationalWager).toHaveBeenCalledTimes(1);
}

describe('DesktopConsoleService clearMonitorData risk accounting', () => {
  it('preserves dayLoss / tableLosses / shoeLosses across clearMonitorData', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixd-clear-risk-'));
    const dbPath = join(directory, 'console.sqlite');
    const first = new DesktopConsoleService(dbPath);
    try {
      const bridge = new BrowserBridgeServer();
      vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
      await placeAcceptedManualWager(first, bridge);
      await first.injectEvent(settleHand('D055'));

      const before = first.snapshot().snapshot.riskState;
      // 走真实链路：押庄 20 且庄赢 => realizedPnl 为正 => dayLoss 变负、tableLosses/shoeLosses 同理。
      expect(before.dayLoss).not.toBe(0);
      expect(before.tableLosses.D055).toBeDefined();
      expect(before.tableLosses.D055).not.toBe(0);
      expect(before.shoeLosses['D055:shoe-D055']).toBeDefined();
      expect(before.shoeLosses['D055:shoe-D055']).not.toBe(0);

      const cleared = await first.clearMonitorData();

      // 记录被清空……
      expect(cleared.events).toHaveLength(0);
      expect(cleared.decisions).toHaveLength(0);
      expect(cleared.receipts).toHaveLength(0);
      expect(cleared.reservations).toHaveLength(0);
      // ……但风控计数原样保留（清记录不是清账）。
      expect(cleared.snapshot.riskState.dayLoss).toBe(before.dayLoss);
      expect(cleared.snapshot.riskState.tableLosses).toEqual(before.tableLosses);
      expect(cleared.snapshot.riskState.shoeLosses).toEqual(before.shoeLosses);
    } finally {
      await first.close();
    }

    // 重启后仍然保留（落盘的是 risk_state，不是内存态）。
    const restarted = new DesktopConsoleService(dbPath);
    try {
      await restarted['startupFailCloseTask'];
      const risk = restarted.snapshot().snapshot.riskState;
      expect(risk.dayLoss).not.toBe(0);
      expect(risk.tableLosses.D055).not.toBe(0);
    } finally {
      await restarted.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('is idempotent when cleared repeatedly', async () => {
    // service.clearMonitorData 里有一道 fail-closed 保护：清除前后对比
    // dayLoss/tableLosses/shoeLosses，一旦发现被清零就抛错。这条用例守两件事：
    //  1) 正常情况下（计数全 0）对比不会误报；
    //  2) 连续清除是幂等的。
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      const first = await service.clearMonitorData();
      expect(first.events).toHaveLength(0);
      const second = await service.clearMonitorData();
      expect(second.snapshot.riskState).toMatchObject({
        dayLoss: 0,
        reservedExposure: 0,
        pendingExecutions: 0,
        tableLosses: {},
        shoeLosses: {},
      });
      const third = await service.clearMonitorData();
      expect(third.snapshot.riskState.dayLoss).toBe(0);
      expect(third.snapshot.riskState.tableLosses).toEqual({});
    } finally {
      await service.close();
    }
  });
});
