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

  it('allows manual wagers from an unconfirmed monitor session while keepalive remains gated', async () => {
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
      // When: the operator places one manual wager and the automatic keepalive interval elapses.
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
      await coordinator.tick(new Date(BASE_TIME.valueOf() + 60_000));

      // Then: the manual wager reaches the bridge, while keepalive remains blocked by the physical-shoe rule.
      expect(manual).toMatchObject({ status: 'ACCEPTED', tableId: 'D001' });
      expect(bridge.requestOperationalWager).toHaveBeenCalledTimes(1);
      expect(coordinator.getKeepaliveState()).toMatchObject({
        lastStatus: 'REJECTED',
      });
      expect(ledger.listOperationalWagersTail()).toHaveLength(1);
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
      await coordinator.tick(new Date(BASE_TIME.valueOf() + 5 * 60_000));

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
