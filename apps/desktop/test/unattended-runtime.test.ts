import { BrowserBridgeServer } from '@baccarat/browser-bridge';
import {
  EVENT_SCHEMA_VERSION,
  defaultProfile,
  type Card,
  type NormalizedEvent,
  type RiskReservation,
} from '@baccarat/contracts';
import type { OperationalWagerExecutionRequest } from '@baccarat/adapter-contract';
import type { TableExport } from '@baccarat/room-monitor';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DesktopConsoleService } from '../electron-src/service.js';

function physicalShoe(tableId: string, sourceSeq = 1): Extract<NormalizedEvent, { type: 'newShoeSignal' }> {
  return {
    type: 'newShoeSignal',
    eventId: `shoe-${tableId}-${sourceSeq}`,
    tableId,
    timestamp: '2026-08-27T01:00:00.000Z',
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
): Extract<NormalizedEvent, { type: 'bettingWindowOpened' }> {
  return {
    type: 'bettingWindowOpened',
    eventId: `open-${tableId}-${handId}`,
    tableId,
    timestamp: new Date(Date.parse('2026-08-27T01:00:00.000Z') + sourceSeq * 1_000).toISOString(),
    sourceSeq,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `shoe-${tableId}`,
    handId,
    market: 'bankerPair',
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

function authenticateBridge(bridge: BrowserBridgeServer): void {
  vi.spyOn(bridge, 'getExtensionStatus').mockReturnValue({
    connectionCount: 1,
    authenticated: true,
    lastSeenAt: '2026-08-27T01:00:00.000Z',
  });
}

describe('DesktopConsoleService unattended runtime', () => {
  it('clears records without marking a live connected feed as disconnected or stale', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      const bridge = new BrowserBridgeServer();
      authenticateBridge(bridge);
      service['browserBridge'] = bridge;
      service['liveFeeds'].set('D055', freshFeed('D055'));
      await service.injectEvent(physicalShoe('D055'));
      service['runtimeObservedTableIds'].clear();
      const cleared = await service.clearMonitorData();
      expect(cleared.runtime.tables.D055?.reasons ?? []).not.toContain('table-feed-disconnected');
      expect(cleared.runtime.tables.D055?.reasons ?? []).not.toContain('table-feed-stale');
    } finally {
      await service.close();
    }
  });

  it('acknowledges an alert without resolving its runtime blocker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-runtime-alert-'));
    const service = new DesktopConsoleService(join(directory, 'console.sqlite'));
    try {
      const incident = service['runtimeIncidents'].record({
        code: 'unknown-execution',
        severity: 'blocked',
        message: 'platform acknowledgement unknown',
      });

      const acknowledged = service.acknowledgeRuntimeIncident(incident.incidentId);
      expect(acknowledged.runtime.status).toBe('blocked');
      expect(acknowledged.runtime.incidents).toContainEqual(expect.objectContaining({
        incidentId: incident.incidentId,
        active: true,
        acknowledgedAt: expect.any(String),
      }));
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps operational keepalive disabled after a browser recovery revokes the execution gate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-runtime-card-stale-'));
    const service = new DesktopConsoleService(join(directory, 'console.sqlite'));
    try {
      await service.setKeepaliveEnabled(true);
      await service.setAutomationEnabled(true);
      service['handleBridgeRuntimeEvent']({
        kind: 'execution-gate-revoked',
        reason: 'game-tabs-reloaded',
        timestamp: new Date().toISOString(),
      });
      await service['executionStateOperation'];

      expect(service.snapshot().keepalive.enabled).toBe(false);
      expect(service['persistentLiveGateEnabled']).toBe(false);
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('restores live approval fail closed, then resumes only after every runtime gate passes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-unattended-restart-'));
    const dbPath = join(directory, 'console.sqlite');
    let firstClosed = false;
    const first = new DesktopConsoleService(dbPath);
    try {
      await first.updateMonitorTableIds(['D055']);
      const bridge = new BrowserBridgeServer();
      vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
      authenticateBridge(bridge);
      first['browserBridge'] = bridge;
      first['liveFeeds'].set('D055', freshFeed('D055'));

      await first.injectEvent(physicalShoe('D055'));
      await first.setExecutionMode('D055', 'live');
      await first.setAutomationEnabled(true);
      expect(first.snapshot().runtime.approvedLiveTableIds).toEqual(['D055']);

      await first.close();
      firstClosed = true;

      const restarted = new DesktopConsoleService(dbPath);
      try {
        expect(restarted.snapshot().snapshot.tables.D055?.executionMode).toBe('live');
        expect(restarted.snapshot().runtime.approvedLiveTableIds).toEqual(['D055']);
        expect(restarted.snapshot().runtime.tables.D055?.reasons).toContain('bridge-not-running');

        const authenticatedBridge = new BrowserBridgeServer();
        vi.spyOn(authenticatedBridge, 'getExtensionStatus').mockReturnValue({
          connectionCount: 1,
          authenticated: true,
          lastSeenAt: '2026-08-27T01:00:00.000Z',
        });
        const liveGate = vi.spyOn(authenticatedBridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
        restarted['browserBridge'] = authenticatedBridge;
        restarted['liveFeeds'].set('D055', freshFeed('D055'));

        const restartedSourceSeq = restarted['ledger'].nextSourceSeq('D055');
        await restarted.injectEvent({
          ...physicalShoe('D055', restartedSourceSeq),
          eventId: 'shoe-D055-restarted',
          shoeId: 'shoe-D055-restarted',
        });
        await restarted['reconcileUnattendedExecution']();

        const ready = restarted.snapshot();
        expect(ready.runtime.executionReady).toBe(true);
        expect(ready.runtime.tables.D055?.reasons).toEqual([]);
        expect(ready.snapshot.tables.D055?.executionMode).toBe('live');
        expect(ready.snapshot.tables.D055?.projection.autoBetStatus).toBe('ARMED');
        expect(liveGate).toHaveBeenCalledWith(true);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!firstClosed) await first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps persisted UNKNOWN exposure blocked across restart and records a durable incident', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-unattended-unknown-'));
    const dbPath = join(directory, 'console.sqlite');
    const first = new DesktopConsoleService(dbPath);
    let firstClosed = false;
    try {
      await first.updateMonitorTableIds(['D055']);
      first['orchestrator'].updateTableExecutionMode('D055', 'live');
      first['ledger'].setConfig('desktop:live-approval:v1', {
        tableIds: ['D055'],
        updatedAt: '2026-08-27T01:00:00.000Z',
      });
      const unknownReservation: RiskReservation = {
        reservationId: 'unknown-restart',
        intentId: 'unknown-restart-intent',
        tableId: 'D055',
        shoeId: 'shoe-D055',
        handId: 'hand-D055',
        market: 'bankerPair',
        executionSource: 'strategy',
        amount: 20,
        maxLoss: 20,
        maxProfit: 220,
        status: 'UNKNOWN',
        createdAt: '2026-08-27T01:00:01.000Z',
      };
      expect(first['ledger'].saveReservation(unknownReservation)).toBe(true);

      await first.close();
      firstClosed = true;

      const restarted = new DesktopConsoleService(dbPath);
      try {
        const snapshot = restarted.snapshot();
        expect(snapshot.snapshot.tables.D055?.executionMode).toBe('live');
        expect(snapshot.runtime.executionReady).toBe(false);
        expect(snapshot.runtime.tables.D055?.reasons).toContain('unknown-execution-pending');
        expect(snapshot.runtime.incidents).toContainEqual(expect.objectContaining({
          code: 'unknown-execution',
          severity: 'degraded',
          tableId: 'D055',
          active: true,
        }));
        expect(snapshot.keepalive.enabled).toBe(false);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!firstClosed) await first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('repairs a persisted UNKNOWN that is proven to have failed before frame execution', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-unattended-precommit-repair-'));
    const dbPath = join(directory, 'console.sqlite');
    const first = new DesktopConsoleService(dbPath);
    let firstClosed = false;
    try {
      await first.updateMonitorTableIds(['D066']);
      const reason = 'bridge-request-error:expected exactly one matching frame for D066, found 0';
      const reservation: RiskReservation = {
        reservationId: 'precommit-unknown-restart',
        intentId: 'precommit-unknown-wager',
        tableId: 'D066',
        shoeId: 'shoe-D066',
        handId: 'GD066268281FN',
        market: 'player',
        executionSource: 'keepalive',
        amount: 20,
        maxLoss: 20,
        maxProfit: 20,
        status: 'UNKNOWN',
        createdAt: '2026-08-28T17:28:32.015Z',
        releaseReason: reason,
      };
      expect(first['ledger'].saveReservation(reservation)).toBe(true);
      expect(first['ledger'].saveOperationalWager({
        wager: {
          wagerId: reservation.intentId,
          tableId: reservation.tableId,
          shoeId: reservation.shoeId,
          handId: reservation.handId,
          market: 'player',
          amount: reservation.amount,
          source: 'keepalive',
          createdAt: reservation.createdAt,
        },
        reservationId: reservation.reservationId,
        status: 'UNKNOWN',
        reason,
      })).toBe(true);

      await first.close();
      firstClosed = true;

      const restarted = new DesktopConsoleService(dbPath);
      try {
        await restarted['startupFailCloseTask'];
        const snapshot = restarted.snapshot();
        expect(snapshot.reservations).toContainEqual(expect.objectContaining({
          reservationId: reservation.reservationId,
          status: 'RELEASED',
          releaseReason: reason,
        }));
        expect(snapshot.snapshot.riskState).toMatchObject({
          reservedExposure: 0,
          pendingExecutions: 0,
        });
        expect(snapshot.runtime.reasons).not.toContain('unknown-execution-pending');
        expect(restarted['ledger'].getOperationalWager(reservation.intentId)).toEqual(
          expect.objectContaining({ status: 'REJECTED', reason }),
        );
        expect(restarted['ledger'].getConfig<{ repairs: unknown[] }>(
          'ledger:precommit-unknown-repairs:v1',
        )?.repairs).toHaveLength(1);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!firstClosed) await first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('restores a legacy-expired ACCEPTED wager as pending exposure on startup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-unattended-accepted-repair-'));
    const dbPath = join(directory, 'console.sqlite');
    const first = new DesktopConsoleService(dbPath);
    let firstClosed = false;
    try {
      await first.updateMonitorTableIds(['D066']);
      await first.injectEvent(physicalShoe('D066'));
      await first.injectEvent({
        ...physicalShoe('D066', 2),
        shoeId: 'shoe-D066-next',
      });
      const reservation: RiskReservation = {
        reservationId: 'legacy-expired-accepted',
        intentId: 'legacy-expired-accepted-wager',
        tableId: 'D066',
        shoeId: 'shoe-D066',
        handId: 'hand-D066',
        market: 'player',
        executionSource: 'keepalive',
        amount: 20,
        maxLoss: 20,
        maxProfit: 20,
        status: 'EXPIRED',
        receiptId: 'legacy-expired-accepted-receipt',
        createdAt: '2026-08-27T01:00:01.000Z',
        releasedAt: '2026-08-27T01:20:00.000Z',
        releaseReason: 'new-shoe-signal-received',
      };
      expect(first['ledger'].saveReservation(reservation)).toBe(true);
      expect(first['ledger'].saveOperationalWager({
        wager: {
          wagerId: reservation.intentId,
          tableId: reservation.tableId,
          shoeId: reservation.shoeId,
          handId: reservation.handId,
          market: 'player',
          amount: reservation.amount,
          source: 'keepalive',
          createdAt: reservation.createdAt,
        },
        reservationId: reservation.reservationId,
        status: 'ACCEPTED',
        receipt: {
          receiptId: reservation.receiptId!,
          wagerId: reservation.intentId,
          tableId: reservation.tableId,
          shoeId: reservation.shoeId,
          handId: reservation.handId,
          market: 'player',
          amount: reservation.amount,
          source: 'keepalive',
          status: 'ACCEPTED',
          createdAt: '2026-08-27T01:00:02.000Z',
        },
      })).toBe(true);

      await first.close();
      firstClosed = true;

      const restarted = new DesktopConsoleService(dbPath);
      try {
        await restarted['startupFailCloseTask'];
        const snapshot = restarted.snapshot();
        expect(snapshot.reservations).toContainEqual(expect.objectContaining({
          reservationId: reservation.reservationId,
          status: 'RESERVED',
          receiptId: reservation.receiptId,
        }));
        expect(snapshot.snapshot.riskState).toMatchObject({
          reservedExposure: 20,
          pendingExecutions: 1,
        });
        expect(snapshot.runtime.incidents).toContainEqual(expect.objectContaining({
          code: 'settlement-gap',
          tableId: 'D066',
          active: true,
        }));
        expect(snapshot.keepalive.enabled).toBe(false);
        expect(restarted['ledger'].getConfig<{ repairs: unknown[] }>(
          'ledger:accepted-reservation-repairs:v1',
        )?.repairs).toHaveLength(1);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!firstClosed) await first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not reuse a prior process physical-shoe connection as current continuity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-unattended-continuity-'));
    const dbPath = join(directory, 'console.sqlite');
    const first = new DesktopConsoleService(dbPath);
    let firstClosed = false;
    try {
      await first.updateMonitorTableIds(['D055']);
      const firstBridge = new BrowserBridgeServer();
      vi.spyOn(firstBridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
      authenticateBridge(firstBridge);
      first['browserBridge'] = firstBridge;
      first['liveFeeds'].set('D055', freshFeed('D055'));
      await first.injectEvent(physicalShoe('D055'));
      await first.setExecutionMode('D055', 'live');
      await first.close();
      firstClosed = true;

      const restarted = new DesktopConsoleService(dbPath);
      try {
        await restarted['startupFailCloseTask'];
        const bridge = new BrowserBridgeServer();
        vi.spyOn(bridge, 'getExtensionStatus').mockReturnValue({
          connectionCount: 1,
          authenticated: true,
          lastSeenAt: '2026-08-27T01:05:00.000Z',
        });
        vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
        restarted['browserBridge'] = bridge;
        restarted['liveFeeds'].set('D055', freshFeed('D055'));

        const card: Card = { rank: 'A', suit: 'S', raw: 'AS' };
        await restarted.injectEvent({
          type: 'cardObserved',
          eventId: 'same-shoe-after-process-restart',
          tableId: 'D055',
          timestamp: '2026-08-27T01:05:00.000Z',
          sourceSeq: restarted['ledger'].nextSourceSeq('D055'),
          source: 'pragmatic-runtime',
          schemaVersion: EVENT_SCHEMA_VERSION,
          shoeId: 'shoe-D055',
          handId: 'hand-after-restart',
          card,
          position: 'player:0',
        });
        await restarted['reconcileUnattendedExecution']();

        expect(restarted.snapshot().runtime.tables.D055?.reasons)
          .toContain('table-connection-not-restored');
        expect(restarted.snapshot().snapshot.tables.D055?.executionMode).toBe('live');

        await restarted.injectEvent({
          ...physicalShoe('D055', restarted['ledger'].nextSourceSeq('D055')),
          eventId: 'new-physical-shoe-after-restart',
          shoeId: 'shoe-D055-next',
        });
        await restarted['reconcileUnattendedExecution']();

        expect(restarted.snapshot().runtime.tables.D055?.reasons).toEqual([]);
        expect(restarted.snapshot().snapshot.tables.D055?.executionMode).toBe('live');
      } finally {
        await restarted.close();
      }
    } finally {
      if (!firstClosed) await first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains exposure without blocking unattended execution when an accepted wager has no settlement', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
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
        createdAt: '2026-08-27T01:00:02.000Z',
      }));
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      service['liveFeeds'].set('D055', freshFeed('D055'));
      await service.injectEvent(physicalShoe('D055'));
      await service.injectEvent(openWindow('D055', 'hand-1', 2));
      await service.setExecutionMode('D055', 'live');
      await service.executeOperationalWager({
        tableId: 'D055',
        market: 'banker',
        amount: 20,
      });
      service['runtimeIncidents'].record({
        code: 'settlement-gap',
        severity: 'blocked',
        tableId: 'D055',
        message: 'legacy settlement gap policy',
      });

      await service.injectEvent(openWindow('D055', 'hand-2', 3));

      const snapshot = service.snapshot();
      expect(snapshot.snapshot.tables.D055?.executionMode).toBe('live');
      expect(snapshot.runtime.tables.D055?.reasons).toContain('settlement-gap');
      expect(snapshot.runtime.incidents).toContainEqual(expect.objectContaining({
        code: 'settlement-gap',
        severity: 'degraded',
        tableId: 'D055',
        active: true,
      }));

      await service.injectEvent({
        ...physicalShoe('D055', 4),
        eventId: 'shoe-D055-next',
        shoeId: 'shoe-D055-next',
      });
      const afterRollover = service.snapshot();
      expect(afterRollover.reservations).toContainEqual(expect.objectContaining({
        tableId: 'D055',
        handId: 'hand-1',
        status: 'RESERVED',
        receiptId: expect.any(String),
      }));
      expect(afterRollover.snapshot.riskState).toMatchObject({
        reservedExposure: 20,
        pendingExecutions: 1,
      });
      expect(afterRollover.runtime.tables.D055?.reasons).toContain('settlement-gap');

      const enabled = await service.setKeepaliveEnabled(true);
      expect(enabled.runtime.executionReady).toBe(false);
      expect(enabled.runtime.tables.D055?.reasons).toContain('settlement-gap');
    } finally {
      await service.close();
    }
  });

  it('uses bounded monitor retry backoff and remains stable through repeated healthy supervision ticks', async () => {
    vi.useFakeTimers();
    const service = new DesktopConsoleService(':memory:');
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms')
      .mockRejectedValueOnce(new Error('discovery failure 1'))
      .mockRejectedValueOnce(new Error('discovery failure 2'))
      .mockRejectedValueOnce(new Error('discovery failure 3'))
      .mockResolvedValue([]);
    try {
      await service.startLiveRoomMonitor(0);
      expect(discoverRooms).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(discoverRooms).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(discoverRooms).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(discoverRooms).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(discoverRooms).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(discoverRooms).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(discoverRooms.mock.calls.length).toBeGreaterThanOrEqual(10);
      expect(service.snapshot().runtime.incidents.filter(incident =>
        incident.active
        && (incident.code === 'scheduler-failure' || incident.code === 'monitor-failure')))
        .toEqual([]);
    } finally {
      discoverRooms.mockRestore();
      await service.close();
      vi.useRealTimers();
    }
  });
});
