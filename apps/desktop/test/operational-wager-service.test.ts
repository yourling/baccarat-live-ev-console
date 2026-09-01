import { describe, expect, it, vi } from 'vitest';
import type { OperationalWagerExecutionRequest } from '@baccarat/adapter-contract';
import { BrowserBridgeServer, OperationalWagerRuntimeRevisionError } from '@baccarat/browser-bridge';
import { EVENT_SCHEMA_VERSION, defaultProfile, defaultRiskLimits, type NormalizedEvent } from '@baccarat/contracts';
import { SqliteLedger } from '@baccarat/ledger-state';
import { RiskManager } from '@baccarat/risk-execution';
import type { TableExport } from '@baccarat/room-monitor';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDesktopKeepaliveSettings, parseDesktopPendingSettlementCommand } from '../src/api-types.js';
import { DesktopConsoleService } from '../electron-src/service.js';

function physicalShoe(tableId: string): Extract<NormalizedEvent, { type: 'newShoeSignal' }> {
  return {
    type: 'newShoeSignal',
    eventId: `shoe-${tableId}`,
    tableId,
    timestamp: '2026-08-25T00:00:00.000Z',
    sourceSeq: 1,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `shoe-${tableId}`,
    baseline: 'physical-shoe',
    profile: { ...defaultProfile(tableId), autoConfirmNewShoe: true },
  };
}

function openWindow(tableId: string): Extract<NormalizedEvent, { type: 'bettingWindowOpened' }> {
  return {
    type: 'bettingWindowOpened',
    eventId: `open-${tableId}`,
    tableId,
    timestamp: '2026-08-25T00:00:01.000Z',
    sourceSeq: 2,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `shoe-${tableId}`,
    handId: `hand-${tableId}`,
    market: 'bankerPair',
  };
}

function nextOpenWindow(tableId: string): Extract<NormalizedEvent, { type: 'bettingWindowOpened' }> {
  return {
    ...openWindow(tableId),
    eventId: `open-next-${tableId}`,
    timestamp: '2026-08-25T00:00:04.000Z',
    sourceSeq: 3,
    handId: `hand-next-${tableId}`,
  };
}

function bankerWinSettlement(tableId: string): Extract<NormalizedEvent, { type: 'handSettled' }> {
  return {
    type: 'handSettled',
    eventId: `settled-${tableId}`,
    tableId,
    timestamp: '2026-08-25T00:00:03.000Z',
    sourceSeq: 3,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `shoe-${tableId}`,
    handId: `hand-${tableId}`,
    playerCards: [{ rank: '5' }, { rank: 'A' }],
    bankerCards: [{ rank: '9' }, { rank: '9' }],
    outcomes: { bankerPair: false, playerPair: false },
  };
}

function freshFeed(tableId: string, state: 'CONNECTED' | 'DISCONNECTED' = 'CONNECTED'): TableExport {
  return {
    tableId,
    start: async () => undefined,
    stop: async () => undefined,
    flush: async () => undefined,
    keepAlive: async () => ({ ok: state === 'CONNECTED', latencyMs: 10 }),
    health: () => ({
      tableId,
      state,
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
    lastSeenAt: '2026-08-27T01:00:00.000Z',
  });
}

describe('DesktopConsoleService operational wagers', () => {
  it('does not let a keepalive strategy payload set global automation state', () => {
    expect(parseDesktopKeepaliveSettings({
      enabled: true,
      intervalMinutes: 5,
      market: 'banker',
      amount: 20,
    })).toEqual({
      intervalMinutes: 5,
      market: 'banker',
      amount: 20,
    });
  });

  it('validates manual pending-settlement outcomes', () => {
    expect(parseDesktopPendingSettlementCommand({
      reservationId: 'rsv-1',
      wagerId: 'opw-1',
      outcome: 'LOSS',
    })).toEqual({ reservationId: 'rsv-1', wagerId: 'opw-1', outcome: 'LOSS' });
    expect(() => parseDesktopPendingSettlementCommand({
      reservationId: 'rsv-1',
      wagerId: 'opw-1',
      outcome: 'VOID',
    })).toThrow('unsupported pending settlement outcome');
  });

  it('opens the live gate for a manual wager without requiring a prior live-mode activation', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
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
        createdAt: '2026-08-25T00:00:02.000Z',
      }));
    authenticateBridge(bridge);

    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D001']);
      await service.injectEvent(physicalShoe('D001'));
      await service.injectEvent(openWindow('D001'));

      const result = await service.executeOperationalWager({
        tableId: 'D001',
        market: 'banker',
        amount: 20,
      });

      expect(result.status).toBe('ACCEPTED');
      expect(setLiveBetEnabled).toHaveBeenCalledWith(true);
      expect(requestOperationalWager).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'live',
        wager: expect.objectContaining({
          tableId: 'D001',
          market: 'banker',
          source: 'manual',
        }),
      }));
      expect(result.snapshot.snapshot.tables.D001?.executionMode).toBe('live');
      expect(result.snapshot.runtime.tables.D001?.active).toBe(true);
    } finally {
      await service.close();
    }
  });

  it('manually settles an accepted historical wager without changing unattended execution', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    authenticateBridge(bridge);
    vi.spyOn(bridge, 'requestOperationalWager')
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
        createdAt: '2026-08-25T00:00:02.000Z',
      }));

    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D001']);
      service['liveFeeds'].set('D001', freshFeed('D001'));
      await service.injectEvent(physicalShoe('D001'));
      await service.injectEvent(openWindow('D001'));
      await service.setExecutionMode('D001', 'live');
      const accepted = await service.executeOperationalWager({
        tableId: 'D001',
        market: 'player',
        amount: 20,
      });
      const reservation = accepted.snapshot.reservations.find(candidate =>
        candidate.intentId === accepted.wager?.wagerId);
      if (!reservation || !accepted.wager) throw new Error('accepted reservation missing');
      await service.injectEvent(nextOpenWindow('D001'));
      await service.setAutomationEnabled(true);

      const before = service.snapshot();
      const gateCallsBefore = setLiveBetEnabled.mock.calls.length;
      expect(before.runtime.incidents).toContainEqual(expect.objectContaining({
        code: 'settlement-gap',
        tableId: 'D001',
        active: true,
      }));
      expect(before.snapshot.tables.D001?.executionMode).toBe('live');
      expect(before.automation.enabled).toBe(true);

      const settled = await service.settlePendingOperationalWager({
        reservationId: reservation.reservationId,
        wagerId: accepted.wager.wagerId,
        outcome: 'LOSS',
      });

      expect(settled.reservations).toContainEqual(expect.objectContaining({
        reservationId: reservation.reservationId,
        status: 'SETTLED',
        realizedPnl: -20,
        releaseReason: 'operator-confirmed-platform-settlement',
      }));
      expect(settled.snapshot.riskState.pendingExecutions)
        .toBe(before.snapshot.riskState.pendingExecutions - 1);
      expect(settled.snapshot.riskState.reservedExposure)
        .toBe(before.snapshot.riskState.reservedExposure - reservation.maxLoss);
      expect(settled.operationalWagers).toContainEqual(expect.objectContaining({
        settlement: expect.objectContaining({ outcome: 'LOSS', realizedPnl: -20 }),
      }));
      expect(settled.runtime.incidents).toContainEqual(expect.objectContaining({
        code: 'settlement-gap',
        tableId: 'D001',
        active: false,
      }));
      expect(settled.snapshot.tables.D001?.executionMode).toBe('live');
      expect(settled.automation.enabled).toBe(true);
      expect(setLiveBetEnabled).toHaveBeenCalledTimes(gateCallsBefore);

      const idempotent = await service.settlePendingOperationalWager({
        reservationId: reservation.reservationId,
        wagerId: accepted.wager.wagerId,
        outcome: 'LOSS',
      });
      expect(idempotent.reservations.find(candidate =>
        candidate.reservationId === reservation.reservationId)?.realizedPnl).toBe(-20);
      await expect(service.settlePendingOperationalWager({
        reservationId: reservation.reservationId,
        wagerId: accepted.wager.wagerId,
        outcome: 'WIN',
      })).rejects.toThrow('different settlement audit');
    } finally {
      await service.close();
    }
  });

  it('returns an audited manual wager before a physical shoe baseline is known', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    let reservationSeenBeforeDispatch = false;
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    const requestOperationalWager = vi.spyOn(bridge, 'requestOperationalWager')
      .mockImplementation(async (request: OperationalWagerExecutionRequest) => {
        reservationSeenBeforeDispatch = service.snapshot().reservations.some(reservation =>
          reservation.intentId === request.wager.wagerId
          && reservation.status === 'RESERVED'
          && reservation.executionSource === request.wager.source);
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
          createdAt: '2026-08-25T00:00:02.000Z',
        };
      });

    try {
      service['browserBridge'] = bridge;
      authenticateBridge(bridge);
      await service.updateMonitorTableIds(['D001']);
      service['liveFeeds'].set('D001', freshFeed('D001'));
      await service.injectEvent({
        ...physicalShoe('D001'),
        baseline: 'unknown-monitor-session',
      });
      await service.injectEvent(openWindow('D001'));
      await service.setExecutionMode('D001', 'live');

      const wager = await service.executeOperationalWager({
        tableId: 'D001',
        market: 'player',
        amount: 20,
      });
      await service.setKeepaliveEnabled(true);
      const settings = await service.updateKeepaliveSettings({
        intervalMinutes: 5,
        market: 'banker',
        amount: 20,
      });

      expect(setLiveBetEnabled).toHaveBeenCalledWith(true);
      expect(requestOperationalWager).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'live',
        wager: expect.objectContaining({
          tableId: 'D001',
          market: 'player',
          source: 'manual',
        }),
      }));
      expect(wager).toMatchObject({
        status: 'ACCEPTED',
        snapshot: {
          operationalWagers: [expect.objectContaining({ status: 'ACCEPTED' })],
        },
      });
      expect(wager.snapshot.snapshot.tables.D001?.projection.shoeBaseline)
        .toBe('unknown-monitor-session');
      expect(reservationSeenBeforeDispatch).toBe(true);
      expect(wager.snapshot.reservations).toContainEqual(expect.objectContaining({
        market: 'player',
        executionSource: 'manual',
        status: 'RESERVED',
      }));
      expect(settings.keepalive).toMatchObject({
        enabled: true,
        intervalMinutes: 5,
        market: 'banker',
        amount: 20,
      });
    } finally {
      await service.close();
    }
  });

  it('rejects a manual wager when the actor projection has not opened the betting window', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
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
        createdAt: '2026-08-25T00:00:02.000Z',
      }));

    try {
      service['browserBridge'] = bridge;
      authenticateBridge(bridge);
      vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
      await service.updateMonitorTableIds(['D001']);
      service['liveFeeds'].set('D001', freshFeed('D001'));
      await service.injectEvent(physicalShoe('D001'));
      await service.setExecutionMode('D001', 'live');

      const result = await service.executeOperationalWager({
        tableId: 'D001',
        market: 'player',
        amount: 20,
        handId: 'visible-page-hand',
      });

      expect(result).toMatchObject({
        status: 'REJECTED',
        reason: 'betting-window-required',
      });
      expect(requestOperationalWager).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it('routes a manual live wager through the bridge when current table readiness is stale', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    let feedState: 'CONNECTED' | 'DISCONNECTED' = 'CONNECTED';
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    authenticateBridge(bridge);
    const requestOperationalWager = vi.spyOn(bridge, 'requestOperationalWager');

    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D001']);
      service['liveFeeds'].set('D001', {
        ...freshFeed('D001'),
        health: () => freshFeed('D001', feedState).health(),
      });
      await service.injectEvent(physicalShoe('D001'));
      await service.injectEvent(openWindow('D001'));
      await service.setExecutionMode('D001', 'live');

      feedState = 'DISCONNECTED';
      const result = await service.executeOperationalWager({
        tableId: 'D001',
        market: 'player',
        amount: 20,
      });

      expect(result).toMatchObject({
        status: 'UNKNOWN',
        reason: expect.stringContaining('no browser extension connected'),
      });
      expect(requestOperationalWager).toHaveBeenCalledTimes(1);
      expect(result.snapshot.reservations).toEqual([
        expect.objectContaining({ status: 'UNKNOWN' }),
      ]);
    } finally {
      await service.close();
    }
  });

  it('reconciles only a committed UNKNOWN against the exact settled hand without reopening execution', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    authenticateBridge(bridge);
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
        status: 'UNKNOWN',
        createdAt: '2026-08-25T00:00:02.000Z',
        raw: { reason: 'result-timeout', commitPoint: 'confirmBet', commitStarted: true },
      }));

    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D066']);
      service['liveFeeds'].set('D066', freshFeed('D066'));
      await service.injectEvent(physicalShoe('D066'));
      await service.injectEvent(openWindow('D066'));
      await service.setExecutionMode('D066', 'live');

      const unknown = await service.executeOperationalWager({
        tableId: 'D066',
        market: 'banker',
        amount: 20,
      });
      expect(unknown.status).toBe('UNKNOWN');
      expect(unknown.wager).toBeDefined();
      const reservation = unknown.snapshot.reservations.find(candidate =>
        candidate.intentId === unknown.wager!.wagerId);
      expect(reservation).toMatchObject({ status: 'UNKNOWN', maxProfit: 19 });
      expect(unknown.snapshot.runtime.incidents).toContainEqual(expect.objectContaining({
        code: 'unknown-execution',
        tableId: 'D066',
        active: true,
        severity: 'degraded',
      }));
      expect(unknown.snapshot.snapshot.tables.D066?.executionMode).toBe('live');
      expect(setLiveBetEnabled).toHaveBeenLastCalledWith(true);

      await expect(service.reconcileUnknownOperationalWager({
        reservationId: reservation!.reservationId,
        wagerId: unknown.wager!.wagerId,
      })).rejects.toThrow('authoritative hand settlement is not available');

      const settledSnapshot = await service.injectEvent(bankerWinSettlement('D066'));
      const settled = settledSnapshot.reservations.find(candidate =>
        candidate.reservationId === reservation!.reservationId);
      expect(settled).toMatchObject({
        status: 'SETTLED',
        realizedPnl: 19,
        releaseReason: 'committed-hand-settled',
      });
      expect(settledSnapshot.snapshot.riskState).toMatchObject({
        pendingExecutions: 0,
        reservedExposure: 0,
        executedToday: 20,
        dayLoss: -19,
      });
      expect(settledSnapshot.operationalWagers).toContainEqual(expect.objectContaining({
        status: 'UNKNOWN',
        receipt: expect.objectContaining({ status: 'UNKNOWN' }),
        reconciliation: expect.objectContaining({
          status: 'ACCEPTED',
          reason: 'committed-hand-settled',
        }),
      }));
      expect(settledSnapshot.runtime.incidents).toContainEqual(expect.objectContaining({
        code: 'unknown-execution',
        tableId: 'D066',
        active: false,
      }));
      expect(settledSnapshot.snapshot.tables.D066?.executionMode).toBe('live');
      expect(settledSnapshot.automation.enabled).toBe(false);
      expect(requestOperationalWager).toHaveBeenCalledTimes(1);

      const idempotent = await service.reconcileUnknownOperationalWager({
        reservationId: reservation!.reservationId,
        wagerId: unknown.wager!.wagerId,
      });
      expect(idempotent.reservations.find(candidate =>
        candidate.reservationId === reservation!.reservationId)?.realizedPnl).toBe(19);
      expect(requestOperationalWager).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
    }
  });

  it('settles a Pragmatic market-click UNKNOWN once the exact hand has cards', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    authenticateBridge(bridge);
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    vi.spyOn(bridge, 'requestOperationalWager')
      .mockImplementation(async (request: OperationalWagerExecutionRequest) => ({
        receiptId: `receipt-${request.wager.wagerId}`,
        wagerId: request.wager.wagerId,
        tableId: request.wager.tableId,
        shoeId: request.wager.shoeId,
        handId: request.wager.handId,
        market: request.wager.market,
        amount: request.wager.amount,
        source: request.wager.source,
        status: 'UNKNOWN',
        createdAt: '2026-08-25T00:00:02.000Z',
        raw: {
          reason: 'platform-ack-not-observed',
          commitPoint: 'market-click',
          commitStarted: true,
        },
      }));

    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['spijbnsu408vmv73']);
      service['liveFeeds'].set('spijbnsu408vmv73', freshFeed('spijbnsu408vmv73'));
      await service.injectEvent(physicalShoe('spijbnsu408vmv73'));
      await service.injectEvent(openWindow('spijbnsu408vmv73'));
      await service.setExecutionMode('spijbnsu408vmv73', 'live');

      const unknown = await service.executeOperationalWager({
        tableId: 'spijbnsu408vmv73',
        market: 'banker',
        amount: 10,
      });
      expect(unknown.status).toBe('UNKNOWN');
      const reservation = unknown.snapshot.reservations.find(candidate =>
        candidate.intentId === unknown.wager!.wagerId);
      expect(reservation?.status).toBe('UNKNOWN');

      const settledSnapshot = await service.injectEvent(bankerWinSettlement('spijbnsu408vmv73'));
      expect(settledSnapshot.reservations.find(candidate =>
        candidate.reservationId === reservation!.reservationId)).toMatchObject({
        status: 'SETTLED',
        realizedPnl: 9.5,
        releaseReason: 'committed-hand-settled',
      });
      expect(settledSnapshot.operationalWagers).toContainEqual(expect.objectContaining({
        reservationId: reservation!.reservationId,
        reconciliation: expect.objectContaining({
          status: 'ACCEPTED',
          reason: 'committed-hand-settled',
        }),
      }));
    } finally {
      await service.close();
    }
  });

  it('fail-closes a committed REJECTED receipt and reconciles it only from exact platform history', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    authenticateBridge(bridge);
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
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
        status: 'REJECTED',
        createdAt: '2026-08-25T00:00:02.000Z',
        raw: { reason: 'platform-rejected', commitPoint: 'confirmBet', commitStarted: true },
      }));

    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D056']);
      service['liveFeeds'].set('D056', freshFeed('D056'));
      await service.injectEvent(physicalShoe('D056'));
      await service.injectEvent(openWindow('D056'));
      await service.setExecutionMode('D056', 'live');

      const unknown = await service.executeOperationalWager({
        tableId: 'D056',
        market: 'player',
        amount: 20,
      });
      expect(unknown.status).toBe('UNKNOWN');
      expect(unknown.receipt?.status).toBe('REJECTED');
      const reservation = unknown.snapshot.reservations.find(candidate =>
        candidate.intentId === unknown.wager!.wagerId);
      expect(reservation).toMatchObject({
        status: 'UNKNOWN',
        releaseReason: 'committed-rejection-uncertain',
      });
      expect(unknown.snapshot.snapshot.riskState).toMatchObject({
        reservedExposure: 20,
        pendingExecutions: 1,
        executedToday: 0,
      });
      expect(unknown.snapshot.automation.enabled).toBe(false);
      expect(unknown.snapshot.snapshot.tables.D056?.executionMode).toBe('live');

      await service.injectEvent(bankerWinSettlement('D056'));
      const reconciled = await service.reconcileUnknownOperationalWager({
        reservationId: reservation!.reservationId,
        wagerId: unknown.wager!.wagerId,
      });

      expect(reconciled.reservations.find(candidate =>
        candidate.reservationId === reservation!.reservationId)).toMatchObject({
        status: 'SETTLED',
        realizedPnl: -20,
        releaseReason: 'operator-confirmed-platform-accepted',
      });
      expect(reconciled.snapshot.riskState).toMatchObject({
        reservedExposure: 0,
        pendingExecutions: 0,
        executedToday: 20,
        dayLoss: 20,
      });
      expect(reconciled.operationalWagers).toContainEqual(expect.objectContaining({
        status: 'UNKNOWN',
        receipt: expect.objectContaining({ status: 'REJECTED' }),
        reconciliation: expect.objectContaining({ status: 'ACCEPTED' }),
      }));
      expect(requestOperationalWager).toHaveBeenCalledTimes(1);

      const idempotent = await service.reconcileUnknownOperationalWager({
        reservationId: reservation!.reservationId,
        wagerId: unknown.wager!.wagerId,
      });
      expect(idempotent.snapshot.riskState.executedToday).toBe(20);
      expect(requestOperationalWager).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
    }
  });

  it('preserves an obsolete runtime receipt while fail-closing the reservation', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    authenticateBridge(bridge);
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    vi.spyOn(bridge, 'requestOperationalWager')
      .mockImplementation(async (request: OperationalWagerExecutionRequest) => {
        throw new OperationalWagerRuntimeRevisionError({
          receiptId: `receipt-${request.wager.wagerId}`,
          wagerId: request.wager.wagerId,
          tableId: request.wager.tableId,
          shoeId: request.wager.shoeId,
          handId: request.wager.handId,
          market: request.wager.market,
          amount: request.wager.amount,
          source: request.wager.source,
          status: 'ACCEPTED',
          createdAt: '2026-08-25T00:00:02.000Z',
          raw: { runtimeRevision: 'obsolete-runtime', commitStarted: true, commitPoint: 'confirmBet' },
        });
      });

    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D055']);
      service['liveFeeds'].set('D055', freshFeed('D055'));
      await service.injectEvent(physicalShoe('D055'));
      await service.injectEvent(openWindow('D055'));
      await service.setExecutionMode('D055', 'live');

      const result = await service.executeOperationalWager({
        tableId: 'D055',
        market: 'banker',
        amount: 20,
      });

      expect(result).toMatchObject({
        status: 'UNKNOWN',
        reason: 'browser-extension-bet-runtime-outdated',
        receipt: { status: 'ACCEPTED', raw: { runtimeRevision: 'obsolete-runtime' } },
        snapshot: {
          automation: { enabled: false },
          reservations: [expect.objectContaining({ status: 'UNKNOWN', receiptId: expect.any(String) })],
          operationalWagers: [expect.objectContaining({
            status: 'UNKNOWN',
            receipt: expect.objectContaining({ status: 'ACCEPTED' }),
          })],
        },
      });
      const reservation = result.snapshot.reservations.find(candidate =>
        candidate.intentId === result.wager?.wagerId);
      await service.injectEvent(bankerWinSettlement('D055'));
      const reconciled = await service.reconcileUnknownOperationalWager({
        reservationId: reservation!.reservationId,
        wagerId: result.wager!.wagerId,
      });
      expect(reconciled.reservations.find(candidate =>
        candidate.reservationId === reservation!.reservationId)).toMatchObject({
        status: 'SETTLED',
        realizedPnl: 19,
      });
    } finally {
      await service.close();
    }
  });

  it('allows fixed keepalive on an observed window before the physical-shoe baseline is known', async () => {
    // Given: global automation is enabled while a live table is attached mid-shoe.
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
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
        createdAt: '2026-08-25T00:00:02.000Z',
      }));

    try {
      service['browserBridge'] = bridge;
      authenticateBridge(bridge);
      await service.updateMonitorTableIds(['D001']);
      service['liveFeeds'].set('D001', freshFeed('D001'));
      service['liveApprovals'].approve('D001');
      await service.injectEvent({
        ...physicalShoe('D001'),
        baseline: 'unknown-monitor-session',
      });

      await service.setKeepaliveEnabled(true);
      expect(requestOperationalWager).not.toHaveBeenCalled();

      // When: a protocol-backed window opens before a physical-shoe confirmation.
      await service.injectEvent(openWindow('D001'));
      await waitFor(() => requestOperationalWager.mock.calls.length > 0);

      // Then: fixed keepalive uses the controlled live path; pair EV stays disarmed until the physical shoe is known.
      expect(requestOperationalWager).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'live',
        wager: expect.objectContaining({
          tableId: 'D001',
          market: 'banker',
          source: 'keepalive',
        }),
      }));
      expect(service.snapshot().operationalWagers).toContainEqual(expect.objectContaining({
        status: 'ACCEPTED',
        wager: expect.objectContaining({
          tableId: 'D001',
          source: 'keepalive',
        }),
      }));
      expect(service.snapshot().snapshot.tables.D001?.projection.autoBetStatus).toBe('DISARMED');
      expect(service.snapshot().runtime.reasons).not.toContain('physical-shoe-baseline-unknown');
    } finally {
      await service.close();
    }
  });

  it('sends keepalive on Pragmatic tables through the same request path as manual bets', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
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
        createdAt: '2026-08-25T00:00:02.000Z',
      }));

    try {
      service['browserBridge'] = bridge;
      authenticateBridge(bridge);
      await service.updateMonitorTableIds(['bc281koreanch281']);
      service['liveFeeds'].set('bc281koreanch281', freshFeed('bc281koreanch281'));
      service['liveApprovals'].approve('bc281koreanch281');
      service['liveRoomIdsByTable'].set('bc281koreanch281', 'dafabet-pragmatic');
      await service.injectEvent({
        ...physicalShoe('bc281koreanch281'),
        baseline: 'unknown-monitor-session',
      });
      await service.setKeepaliveEnabled(true);
      await service.injectEvent(openWindow('bc281koreanch281'));
      await waitFor(() => requestOperationalWager.mock.calls.length > 0);

      expect(requestOperationalWager).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'live',
        wager: expect.objectContaining({
          tableId: 'bc281koreanch281',
          source: 'keepalive',
        }),
      }));
      expect(service.snapshot().operationalWagers).toContainEqual(expect.objectContaining({
        status: 'ACCEPTED',
        wager: expect.objectContaining({
          tableId: 'bc281koreanch281',
          source: 'keepalive',
        }),
      }));
    } finally {
      await service.close();
    }
  });

  it('recovers committed unknown pair receipts against the stored hand settlement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'baccarat-unknown-ledger-'));
    const dbPath = join(dir, 'console.sqlite');
    const tableId = 'tobcspbaccarat92';
    const shoeId = 'shoe-recover';
    const handId = '16431851710';
    const ledger = new SqliteLedger(dbPath);
    const risk = new RiskManager(ledger);
    const profile = { ...defaultProfile(tableId), limits: { minBet: 1, maxBet: 1000 } };
    const reserved = risk.tryReserve({
      intentId: 'int-recover',
      tableId,
      shoeId,
      handId,
      market: 'bankerPair',
      amount: 20,
      mode: 'live',
      idempotencyKey: `${tableId}:${shoeId}:${handId}:bankerPair:recover`,
      strategy: { type: 'fixed', market: 'bankerPair' },
      decisionSnapshotId: 'dec-recover',
      createdAt: '2026-09-01T18:30:00.000Z',
    }, profile, {
      ...defaultRiskLimits,
      defaultExposureCap: 100_000,
      perTableLossLimit: 100_000,
      perShoeLossLimit: 100_000,
      perDayLossLimit: 1_000_000,
      maxConcurrentExecutions: 4,
      insufficientBehavior: 'skip',
    });
    expect(reserved.ok).toBe(true);
    const reservationId = reserved.reservation!.reservationId;
    expect(risk.markUnknown(reservationId, 'platform-acknowledgement-unknown', 'receipt-recover')).toBe(true);
    ledger.saveReceipt({
      receiptId: 'receipt-recover',
      intentId: 'int-recover',
      reservationId,
      status: 'UNKNOWN',
      amount: 20,
      market: 'bankerPair',
      mode: 'live',
      createdAt: '2026-09-01T18:30:00.886Z',
      raw: { commitStarted: true, reason: 'round-advanced-before-ack' },
    }, tableId, shoeId, handId, 'bankerPair');
    expect(ledger.appendEvent({
      type: 'handSettled',
      eventId: 'evt-recover-settled',
      tableId,
      timestamp: '2026-09-01T18:30:20.000Z',
      sourceSeq: 1,
      source: 'pragmatic-runtime',
      schemaVersion: EVENT_SCHEMA_VERSION,
      shoeId,
      handId,
      playerCards: [{ rank: 'K' }, { rank: 'Q' }],
      bankerCards: [{ rank: 'A' }, { rank: 'A' }],
      outcomes: { bankerPair: true, playerPair: false },
    })).toBe('appended');
    ledger.close();

    const service = new DesktopConsoleService(dbPath);
    try {
      expect(service.snapshot().reservations.find(row => row.reservationId === reservationId)).toEqual(expect.objectContaining({
        status: 'SETTLED',
        releaseReason: 'committed-hand-settled',
        realizedPnl: 220,
      }));
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('condition was not met before timeout');
}
