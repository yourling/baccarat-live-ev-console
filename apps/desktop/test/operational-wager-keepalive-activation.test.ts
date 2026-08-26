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

const BASE_TIME = new Date('2026-08-26T00:00:00.000Z');

function liveTable(
  tableId: string,
  projectionOverrides: Partial<OperationalWagerTableState['projection']> = {},
): OperationalWagerTableState {
  return {
    tableId,
    executionMode: 'live',
    projection: {
      shoeId: `shoe-${tableId}`,
      shoeBaseline: 'unknown-monitor-session',
      status: 'BETTING_WINDOW',
      currentHandId: `hand-${tableId}`,
      autoBetStatus: 'DISARMED',
      connectionStatus: 'CONNECTED',
      sealed: false,
      ...projectionOverrides,
    },
  };
}

function receipt(request: OperationalWagerExecutionRequest): OperationalWagerReceipt {
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
    createdAt: BASE_TIME.toISOString(),
  };
}

describe('OperationalWagerCoordinator keepalive activation', () => {
  it('checks immediately and retries on the next scheduler tick when a monitored table opens', async () => {
    // Given: a live monitor session begins between betting windows without a confirmed physical shoe.
    const ledger = new SqliteLedger(':memory:');
    let table = liveTable('D001', {
      status: 'TRACKING',
      currentHandId: null,
    });
    const bridge = {
      requestOperationalWager: vi.fn(async (request: OperationalWagerExecutionRequest) => receipt(request)),
    };
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      bridge: () => bridge,
      monitorTableIds: () => ['D001'],
      tableState: tableId => tableId === 'D001' ? table : undefined,
      serialize: async operation => await operation(),
    });

    try {
      // When: global automation is enabled and the table opens before the configured interval has elapsed.
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 10,
        market: 'banker',
        amount: 20,
      }, BASE_TIME);
      table = liveTable('D001');
      await coordinator.tick(new Date(BASE_TIME.valueOf() + 15_000));

      // Then: activation checks immediately, and the first eligible window submits the banker keepalive wager.
      expect(coordinator.getKeepaliveState()).toMatchObject({
        enabled: true,
        lastStatus: 'ACCEPTED',
        lastTableId: 'D001',
      });
      expect(bridge.requestOperationalWager).toHaveBeenCalledWith(expect.objectContaining({
        wager: expect.objectContaining({
          tableId: 'D001',
          market: 'banker',
          source: 'keepalive',
        }),
      }));
      expect(bridge.requestOperationalWager).toHaveBeenCalledTimes(1);
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('starts a fresh keepalive cycle immediately when automation is re-enabled', async () => {
    // Given: a successful keepalive remains inside its configured interval.
    const ledger = new SqliteLedger(':memory:');
    const bridge = {
      requestOperationalWager: vi.fn(async (request: OperationalWagerExecutionRequest) => receipt(request)),
    };
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      bridge: () => bridge,
      monitorTableIds: () => ['D001'],
      tableState: tableId => tableId === 'D001' ? liveTable('D001') : undefined,
      serialize: async operation => await operation(),
    });

    try {
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 10,
        market: 'banker',
        amount: 20,
      }, BASE_TIME);
      await coordinator.updateKeepalive({
        enabled: false,
        intervalMinutes: 10,
        market: 'banker',
        amount: 20,
      }, new Date(BASE_TIME.valueOf() + 1_000));

      // When: the operator starts automatic betting again before the old interval expires.
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 10,
        market: 'banker',
        amount: 20,
      }, new Date(BASE_TIME.valueOf() + 2_000));

      // Then: the newly enabled cycle immediately submits another keeper wager.
      expect(bridge.requestOperationalWager).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.close();
      ledger.close();
    }
  });
});
