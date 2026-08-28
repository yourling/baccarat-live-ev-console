import { describe, expect, it, vi } from 'vitest';
import type { OperationalWagerExecutionRequest } from '@baccarat/adapter-contract';
import { BrowserBridgeServer, OperationalWagerRuntimeRevisionError } from '@baccarat/browser-bridge';
import { EVENT_SCHEMA_VERSION, defaultProfile, type NormalizedEvent } from '@baccarat/contracts';
import type { TableExport } from '@baccarat/room-monitor';
import { parseDesktopKeepaliveSettings } from '../src/api-types.js';
import { DesktopConsoleService } from '../electron-src/service.js';

function physicalShoe(tableId: string): Extract<NormalizedEvent, { type: 'newShoeSignal' }> {
  return {
    type: 'newShoeSignal',
    eventId: `shoe-${tableId}`,
    tableId,
    timestamp: '2026-08-25T00:00:00.000Z',
    sourceSeq: 1,
    source: 'mstrom-protocol',
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
    source: 'mstrom-protocol',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `shoe-${tableId}`,
    handId: `hand-${tableId}`,
    market: 'bankerPair',
  };
}

function bankerWinSettlement(tableId: string): Extract<NormalizedEvent, { type: 'handSettled' }> {
  return {
    type: 'handSettled',
    eventId: `settled-${tableId}`,
    tableId,
    timestamp: '2026-08-25T00:00:03.000Z',
    sourceSeq: 3,
    source: 'mstrom-protocol',
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

  it('returns an audited manual wager and persists keepalive settings', async () => {
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
      await service.injectEvent(physicalShoe('D001'));
      await service.injectEvent(openWindow('D001'));
      await service.setExecutionMode('D001', 'live');

      const wager = await service.executeOperationalWager({
        tableId: 'D001',
        market: 'player',
        amount: 20,
      });
      await service.setAutomationEnabled(true);
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

  it('blocks a manual live wager when current table readiness is lost', async () => {
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
        status: 'REJECTED',
        reason: expect.stringContaining('table-feed-disconnected'),
      });
      expect(requestOperationalWager).not.toHaveBeenCalled();
      expect(result.snapshot.reservations).toEqual([]);
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
      }));
      expect(unknown.snapshot.snapshot.tables.D066?.executionMode).toBe('shadow');
      expect(setLiveBetEnabled).toHaveBeenLastCalledWith(false);

      await expect(service.reconcileUnknownOperationalWager({
        reservationId: reservation!.reservationId,
        wagerId: unknown.wager!.wagerId,
      })).rejects.toThrow('authoritative hand settlement is not available');

      await service.injectEvent(bankerWinSettlement('D066'));
      const reconciled = await service.reconcileUnknownOperationalWager({
        reservationId: reservation!.reservationId,
        wagerId: unknown.wager!.wagerId,
      });
      const settled = reconciled.reservations.find(candidate =>
        candidate.reservationId === reservation!.reservationId);
      expect(settled).toMatchObject({
        status: 'SETTLED',
        realizedPnl: 19,
        releaseReason: 'operator-confirmed-platform-accepted',
      });
      expect(reconciled.snapshot.riskState).toMatchObject({
        pendingExecutions: 0,
        reservedExposure: 0,
        executedToday: 20,
        dayLoss: -19,
      });
      expect(reconciled.operationalWagers).toContainEqual(expect.objectContaining({
        status: 'UNKNOWN',
        receipt: expect.objectContaining({ status: 'UNKNOWN' }),
        reconciliation: expect.objectContaining({ status: 'ACCEPTED' }),
      }));
      expect(reconciled.runtime.incidents).toContainEqual(expect.objectContaining({
        code: 'unknown-execution',
        tableId: 'D066',
        active: false,
      }));
      expect(reconciled.snapshot.tables.D066?.executionMode).toBe('shadow');
      expect(reconciled.automation.enabled).toBe(false);
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
      expect(unknown.snapshot.snapshot.tables.D056?.executionMode).toBe('shadow');

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

      await service.setAutomationEnabled(true);
      expect(requestOperationalWager).not.toHaveBeenCalled();

      // When: a protocol-backed window opens before a physical-shoe confirmation.
      await service.injectEvent(openWindow('D001'));
      await waitFor(() => requestOperationalWager.mock.calls.length > 0);

      // Then: fixed keepalive uses the controlled live path, while EV pair automation stays disarmed.
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
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('condition was not met before timeout');
}
