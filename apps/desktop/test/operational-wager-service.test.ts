import { describe, expect, it, vi } from 'vitest';
import type { OperationalWagerExecutionRequest } from '@baccarat/adapter-contract';
import { BrowserBridgeServer } from '@baccarat/browser-bridge';
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

  it('keeps live keepalive blocked until a physical-shoe baseline is observed', async () => {
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

      // When: a window opens before a physical-shoe confirmation.
      await service.injectEvent(openWindow('D001'));

      // Then: no live request is allowed from the unknown monitor baseline.
      expect(requestOperationalWager).not.toHaveBeenCalled();

      // When: a new physical shoe and its first window are observed.
      await service.injectEvent({
        ...physicalShoe('D001'),
        eventId: 'physical-shoe-D001',
        shoeId: 'physical-shoe-D001',
        sourceSeq: 3,
      });
      await service.injectEvent({
        ...openWindow('D001'),
        eventId: 'physical-open-D001',
        shoeId: 'physical-shoe-D001',
        handId: 'physical-hand-D001',
        sourceSeq: 4,
      });
      await waitFor(() => requestOperationalWager.mock.calls.length > 0);

      // Then: keepalive may use the controlled live path.
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
