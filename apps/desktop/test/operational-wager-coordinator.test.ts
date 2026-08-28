import { describe, expect, it, vi } from 'vitest';
import { SqliteLedger } from '@baccarat/ledger-state';
import type {
  ControlledOperationalWagerCommand,
  ControlledOperationalWagerResult,
} from '@baccarat/orchestrator';
import { OperationalWagerCoordinator } from '../electron-src/operational-wager-coordinator.js';

const BASE_TIME = new Date('2026-08-27T00:00:00.000Z');

function accepted(
  tableId: string,
  command: ControlledOperationalWagerCommand,
): ControlledOperationalWagerResult {
  return {
    status: 'ACCEPTED',
    tableId,
    reservationId: `reservation-${tableId}`,
    wager: {
      wagerId: `wager-${tableId}`,
      tableId,
      shoeId: `shoe-${tableId}`,
      handId: `hand-${tableId}`,
      market: command.market,
      amount: command.amount,
      source: command.source,
      createdAt: command.createdAt ?? BASE_TIME.toISOString(),
    },
  };
}

describe('OperationalWagerCoordinator', () => {
  it('delegates manual execution to the monitored table actor', async () => {
    const ledger = new SqliteLedger(':memory:');
    const placeOperationalWager = vi.fn(async (command: ControlledOperationalWagerCommand) =>
      accepted('D001', command));
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      actor: tableId => tableId === 'D001' ? { placeOperationalWager } : undefined,
      monitorTableIds: () => ['D001'],
      serialize: async operation => await operation(),
    });

    try {
      const result = await coordinator.executeManual({
        tableId: 'D001',
        market: 'player',
        amount: 20,
      });

      expect(result).toMatchObject({
        status: 'ACCEPTED',
        tableId: 'D001',
        reservationId: 'reservation-D001',
      });
      expect(placeOperationalWager).toHaveBeenCalledWith({
        market: 'player',
        amount: 20,
        source: 'manual',
        createdAt: expect.any(String),
      });
      expect(ledger.listOperationalWagersTail()).toEqual([]);
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('rejects unmonitored and unavailable tables before actor execution', async () => {
    const ledger = new SqliteLedger(':memory:');
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      actor: () => undefined,
      monitorTableIds: () => ['D001'],
      serialize: async operation => await operation(),
    });

    try {
      await expect(coordinator.executeManual({
        tableId: 'D002',
        market: 'banker',
        amount: 20,
      })).resolves.toMatchObject({ status: 'REJECTED', reason: 'table-not-monitored' });
      await expect(coordinator.executeManual({
        tableId: 'D001',
        market: 'banker',
        amount: 20,
      })).resolves.toMatchObject({ status: 'REJECTED', reason: 'table-unavailable' });
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('tries keepalive tables in order and stops after an unknown result', async () => {
    const ledger = new SqliteLedger(':memory:');
    const calls: string[] = [];
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      actor: tableId => ({
        placeOperationalWager: async command => {
          calls.push(tableId);
          if (tableId === 'D001') {
            return { status: 'REJECTED', tableId, reason: 'betting-window-required' };
          }
          if (tableId === 'D002') {
            return {
              ...accepted(tableId, command),
              status: 'UNKNOWN',
              reason: 'platform-acknowledgement-unknown',
            };
          }
          return accepted(tableId, command);
        },
      }),
      monitorTableIds: () => ['D001', 'D002', 'D003'],
      serialize: async operation => await operation(),
    });

    try {
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 5,
        market: 'player',
        amount: 20,
      }, BASE_TIME);

      expect(calls).toEqual(['D001', 'D002']);
      expect(coordinator.getKeepaliveState()).toMatchObject({
        enabled: false,
        lastStatus: 'UNKNOWN',
        lastTableId: 'D002',
        lastReason: 'platform-acknowledgement-unknown',
      });

      const replacement = new OperationalWagerCoordinator({
        ledger,
        actor: () => undefined,
        monitorTableIds: () => ['D001', 'D002', 'D003'],
        serialize: async operation => await operation(),
      });
      expect(replacement.getKeepaliveState()).toMatchObject({
        enabled: false,
        lastStatus: 'UNKNOWN',
        lastTableId: 'D002',
      });
      replacement.close();
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('does not fall through to another table after a committed platform rejection', async () => {
    const ledger = new SqliteLedger(':memory:');
    const calls: string[] = [];
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      actor: tableId => ({
        placeOperationalWager: async command => {
          calls.push(tableId);
          const acceptedResult = accepted(tableId, command);
          if (tableId !== 'D001') return acceptedResult;
          const wager = acceptedResult.wager;
          if (wager === undefined) throw new Error('test wager was not created');
          return {
            status: 'REJECTED',
            tableId,
            reason: 'platform-rejected',
            wager,
            receipt: {
              receiptId: 'receipt-D001',
              wagerId: wager.wagerId,
              tableId: wager.tableId,
              shoeId: wager.shoeId,
              handId: wager.handId,
              market: wager.market,
              amount: wager.amount,
              source: wager.source,
              status: 'REJECTED',
              createdAt: wager.createdAt,
              raw: { commitPoint: 'confirmBet', commitStarted: true },
            },
          };
        },
      }),
      monitorTableIds: () => ['D001', 'D002'],
      serialize: async operation => await operation(),
    });

    try {
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 5,
        market: 'player',
        amount: 20,
      }, BASE_TIME);

      expect(calls).toEqual(['D001']);
      expect(coordinator.getKeepaliveState()).toMatchObject({
        enabled: true,
        lastAttemptAt: BASE_TIME.toISOString(),
        lastStatus: 'REJECTED',
        lastTableId: 'D001',
        lastReason: 'platform-rejected',
      });
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('does not dispatch a queued keepalive after immediate disable', async () => {
    const ledger = new SqliteLedger(':memory:');
    let ready = false;
    const placeOperationalWager = vi.fn(async (command: ControlledOperationalWagerCommand) =>
      ready
        ? accepted('D001', command)
        : { status: 'REJECTED' as const, tableId: 'D001', reason: 'betting-window-required' });
    let releaseSerialization: () => void = () => undefined;
    let signalSerializationStarted: () => void = () => undefined;
    const serializationBlocked = new Promise<void>(resolve => {
      releaseSerialization = resolve;
    });
    const serializationStarted = new Promise<void>(resolve => {
      signalSerializationStarted = resolve;
    });
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      actor: () => ({ placeOperationalWager }),
      monitorTableIds: () => ['D001'],
      serialize: async operation => {
        signalSerializationStarted();
        await serializationBlocked;
        return await operation();
      },
    });

    try {
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 1,
        market: 'banker',
        amount: 20,
      }, BASE_TIME);
      expect(placeOperationalWager).toHaveBeenCalledTimes(1);
      placeOperationalWager.mockClear();
      ready = true;
      const queuedTick = coordinator.tick(BASE_TIME);
      await serializationStarted;
      coordinator.disableKeepaliveImmediately();
      releaseSerialization();
      await queuedTick;

      expect(placeOperationalWager).not.toHaveBeenCalled();
      expect(coordinator.getKeepaliveState().enabled).toBe(false);
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('reports periodic scheduler failures without crashing the timer', async () => {
    vi.useFakeTimers();
    const ledger = new SqliteLedger(':memory:');
    const expectedError = new Error('synthetic scheduler failure');
    const onError = vi.fn();
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      actor: () => undefined,
      monitorTableIds: () => ['D001'],
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
});
