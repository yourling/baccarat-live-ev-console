import { describe, expect, it, vi } from 'vitest';
import type {
  OperationalWagerExecutionRequest,
  OperationalWagerReceipt,
} from '@baccarat/adapter-contract';
import { SqliteLedger } from '@baccarat/ledger-state';
import {
  OperationalWagerCoordinator,
  type OperationalWagerTableState,
} from '../electron-src/operational-wager-coordinator.js';

const BASE_TIME = new Date('2026-08-25T00:00:00.000Z');

function liveTable(
  tableId: string,
  projectionOverrides: Partial<OperationalWagerTableState['projection']> = {},
): OperationalWagerTableState {
  return {
    tableId,
    executionMode: 'live',
    projection: {
      shoeId: `shoe-${tableId}`,
      shoeBaseline: 'physical-shoe',
      status: 'BETTING_WINDOW',
      currentHandId: `hand-${tableId}`,
      autoBetStatus: 'DISARMED',
      connectionStatus: 'CONNECTED',
      sealed: false,
      ...projectionOverrides,
    },
  };
}

function receipt(
  request: OperationalWagerExecutionRequest,
  status: OperationalWagerReceipt['status'],
): OperationalWagerReceipt {
  return {
    receiptId: `receipt-${request.wager.wagerId}`,
    wagerId: request.wager.wagerId,
    tableId: request.wager.tableId,
    shoeId: request.wager.shoeId,
    handId: request.wager.handId,
    market: request.wager.market,
    amount: request.wager.amount,
    source: request.wager.source,
    status,
    createdAt: BASE_TIME.toISOString(),
  };
}

describe('OperationalWagerCoordinator', () => {
  it('audits an accepted manual wager without writing an EV reservation', async () => {
    const ledger = new SqliteLedger(':memory:');
    const bridge = {
      requestOperationalWager: vi.fn(async (request: OperationalWagerExecutionRequest) => receipt(request, 'ACCEPTED')),
    };
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      bridge: () => bridge,
      monitorTableIds: () => ['D001'],
      tableState: tableId => tableId === 'D001' ? liveTable(tableId) : undefined,
      serialize: async operation => await operation(),
    });

    try {
      const result = await coordinator.executeManual({
        tableId: 'D001',
        market: 'banker',
        amount: 20,
      });

      expect(result).toMatchObject({ status: 'ACCEPTED', tableId: 'D001' });
      expect(bridge.requestOperationalWager).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'live',
        wager: expect.objectContaining({
          tableId: 'D001',
          market: 'banker',
          amount: 20,
          source: 'manual',
        }),
      }));
      expect(ledger.listOperationalWagersTail()).toMatchObject([{
        wager: expect.objectContaining({ tableId: 'D001', market: 'banker', source: 'manual' }),
        status: 'ACCEPTED',
      }]);
      expect(ledger.listReservations()).toEqual([]);
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('does not report a keepalive result before any wager attempt', async () => {
    // Given: automation starts before its browser bridge is available.
    const ledger = new SqliteLedger(':memory:');
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      bridge: () => undefined,
      monitorTableIds: () => ['D001'],
      tableState: tableId => tableId === 'D001' ? liveTable(tableId) : undefined,
      serialize: async operation => await operation(),
    });

    try {
      // When: global automation enables the keepalive strategy.
      const state = await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 1,
        market: 'banker',
        amount: 20,
      }, BASE_TIME);

      // Then: the UI retains a neutral preflight state until a wager is actually attempted.
      expect(state.lastAttemptAt).toBeUndefined();
      expect(state.lastStatus).toBeUndefined();
      expect(state.lastReason).toBeUndefined();
      expect(ledger.listOperationalWagersTail()).toEqual([]);
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('clears the previous keepalive result when a new cycle has not attempted a wager', async () => {
    // Given: the previous cycle completed successfully, then its browser bridge becomes unavailable.
    const ledger = new SqliteLedger(':memory:');
    let bridgeAvailable = true;
    const bridge = {
      requestOperationalWager: vi.fn(async (request: OperationalWagerExecutionRequest) => receipt(request, 'ACCEPTED')),
    };
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      bridge: () => bridgeAvailable ? bridge : undefined,
      monitorTableIds: () => ['D001'],
      tableState: tableId => tableId === 'D001' ? liveTable(tableId) : undefined,
      serialize: async operation => await operation(),
    });

    try {
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 1,
        market: 'banker',
        amount: 20,
      }, BASE_TIME);
      await coordinator.updateKeepalive({
        enabled: false,
        intervalMinutes: 1,
        market: 'banker',
        amount: 20,
      }, new Date(BASE_TIME.valueOf() + 1_000));
      bridgeAvailable = false;

      // When: the operator starts a fresh cycle before any new wager can be attempted.
      const state = await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 1,
        market: 'banker',
        amount: 20,
      }, new Date(BASE_TIME.valueOf() + 2_000));

      // Then: no result from the prior cycle is displayed as this cycle's preflight state.
      expect(state.lastAttemptAt).toBeUndefined();
      expect(state.lastSuccessAt).toBeUndefined();
      expect(state.lastStatus).toBeUndefined();
      expect(state.lastTableId).toBeUndefined();
      expect(state.lastReason).toBeUndefined();
      expect(bridge.requestOperationalWager).toHaveBeenCalledTimes(1);
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('reports a periodic keepalive failure through its error handler', async () => {
    vi.useFakeTimers();
    const ledger = new SqliteLedger(':memory:');
    const expectedError = new Error('synthetic scheduler failure');
    const onError = vi.fn();
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      bridge: () => undefined,
      monitorTableIds: () => ['D001'],
      tableState: tableId => tableId === 'D001' ? liveTable(tableId) : undefined,
      serialize: async () => {
        throw expectedError;
      },
      onError,
    });

    try {
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 1,
        market: 'banker',
        amount: 20,
      }, BASE_TIME);

      await vi.advanceTimersByTimeAsync(15_000);

      expect(onError).toHaveBeenCalledWith(expectedError);
    } finally {
      coordinator.close();
      ledger.close();
      vi.useRealTimers();
    }
  });

  it('allows manual wagers and keepalive from an unconfirmed monitor session', async () => {
    // Given: a live, connected betting window attached mid-shoe without a physical-shoe baseline.
    const ledger = new SqliteLedger(':memory:');
    const bridge = {
      requestOperationalWager: vi.fn(async (request: OperationalWagerExecutionRequest) => receipt(request, 'ACCEPTED')),
    };
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      bridge: () => bridge,
      monitorTableIds: () => ['D001'],
      tableState: tableId => tableId === 'D001'
        ? liveTable(tableId, { shoeBaseline: 'unknown-monitor-session' })
        : undefined,
      serialize: async operation => await operation(),
    });

    try {
      // When: the operator places one manual wager and enables automatic keepalive.
      const manual = await coordinator.executeManual({
        tableId: 'D001',
        market: 'banker',
        amount: 20,
      });
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 1,
        market: 'banker',
        amount: 20,
      }, BASE_TIME);

      // Then: both paths reach the bridge; keepalive starts without a physical-shoe baseline.
      expect(manual).toMatchObject({ status: 'ACCEPTED', tableId: 'D001' });
      expect(bridge.requestOperationalWager).toHaveBeenCalledTimes(2);
      expect(coordinator.getKeepaliveState()).toMatchObject({
        lastStatus: 'ACCEPTED',
        lastTableId: 'D001',
      });
      expect(ledger.listOperationalWagersTail()).toHaveLength(2);
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('keeps a table alive while pair automation is armed', async () => {
    // Given: a live table in a valid window with the pair-EV strategy armed.
    const ledger = new SqliteLedger(':memory:');
    const bridge = {
      requestOperationalWager: vi.fn(async (request: OperationalWagerExecutionRequest) => receipt(request, 'ACCEPTED')),
    };
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      bridge: () => bridge,
      monitorTableIds: () => ['D001'],
      tableState: tableId => tableId === 'D001'
        ? liveTable(tableId, { autoBetStatus: 'ARMED' })
        : undefined,
      serialize: async operation => await operation(),
    });

    try {
      // When: automatic keepalive is enabled.
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 1,
        market: 'player',
        amount: 20,
      }, BASE_TIME);

      // Then: the independent banker/player keepalive path remains available.
      expect(bridge.requestOperationalWager).toHaveBeenCalledWith(expect.objectContaining({
        wager: expect.objectContaining({
          tableId: 'D001',
          market: 'player',
          source: 'keepalive',
        }),
      }));
      expect(coordinator.getKeepaliveState()).toMatchObject({
        lastStatus: 'ACCEPTED',
        lastTableId: 'D001',
      });
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it.each(['shadow', 'simulated'] as const)(
    'records a %s manual test without a current hand or an open live table gate',
    async executionMode => {
      const ledger = new SqliteLedger(':memory:');
      const bridge = {
        requestOperationalWager: vi.fn(async (request: OperationalWagerExecutionRequest) => receipt(request, 'ACCEPTED')),
      };
      const coordinator = new OperationalWagerCoordinator({
        ledger,
        bridge: () => bridge,
        monitorTableIds: () => ['D001'],
        tableState: tableId => tableId === 'D001'
          ? {
            ...liveTable(tableId, {
              shoeBaseline: 'unknown-monitor-session',
              status: 'TRACKING',
              autoBetStatus: 'ARMED',
              connectionStatus: 'DISCONNECTED',
              currentHandId: null,
              sealed: true,
            }),
            executionMode,
          }
          : undefined,
        serialize: async operation => await operation(),
      });

      try {
        const result = await coordinator.executeManual({
          tableId: 'D001',
          market: 'banker',
          amount: 20,
        });

        expect(result).toMatchObject({
          status: 'ACCEPTED',
          tableId: 'D001',
          reason: `${executionMode}-simulated`,
        });
        expect(bridge.requestOperationalWager).not.toHaveBeenCalled();
        expect(ledger.listOperationalWagersTail()).toMatchObject([{
          wager: expect.objectContaining({
            tableId: 'D001',
            handId: expect.stringMatching(/^manual-test-/),
            market: 'banker',
            source: 'manual',
          }),
          status: 'ACCEPTED',
          reason: `${executionMode}-simulated`,
        }]);
      } finally {
        coordinator.close();
        ledger.close();
      }
    },
  );

  it('persists keepalive configuration and stops fallback after an unknown receipt', async () => {
    const ledger = new SqliteLedger(':memory:');
    const tableStates = new Map([
      ['D001', liveTable('D001')],
      ['D002', liveTable('D002')],
      ['D003', liveTable('D003')],
    ]);
    const bridge = {
      requestOperationalWager: vi.fn(async (request: OperationalWagerExecutionRequest) => {
        const status = request.wager.tableId === 'D001' ? 'REJECTED' : 'UNKNOWN';
        return receipt(request, status);
      }),
    };
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      bridge: () => bridge,
      monitorTableIds: () => ['D001', 'D002', 'D003'],
      tableState: tableId => tableStates.get(tableId),
      serialize: async operation => await operation(),
    });

    try {
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 5,
        market: 'player',
        amount: 20,
      }, BASE_TIME);

      expect(bridge.requestOperationalWager.mock.calls.map(([request]) => request.wager.tableId))
        .toEqual(['D001', 'D002']);
      expect(coordinator.getKeepaliveState()).toMatchObject({
        enabled: true,
        lastStatus: 'UNKNOWN',
        lastTableId: 'D002',
      });
      expect(ledger.listOperationalWagersTail().map(row => row.status)).toEqual(['REJECTED', 'UNKNOWN']);

      const replacement = new OperationalWagerCoordinator({
        ledger,
        bridge: () => bridge,
        monitorTableIds: () => ['D001', 'D002', 'D003'],
        tableState: tableId => tableStates.get(tableId),
        serialize: async operation => await operation(),
      });
      expect(replacement.getKeepaliveState()).toMatchObject({
        enabled: true,
        intervalMinutes: 5,
        market: 'player',
        amount: 20,
        lastStatus: 'UNKNOWN',
        lastTableId: 'D002',
      });
      replacement.close();
    } finally {
      coordinator.close();
      ledger.close();
    }
  });
});
