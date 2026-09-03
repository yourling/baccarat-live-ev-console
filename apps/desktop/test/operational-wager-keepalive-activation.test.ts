import { describe, expect, it, vi } from 'vitest';
import { SqliteLedger } from '@baccarat/ledger-state';
import type { ControlledOperationalWagerCommand } from '@baccarat/orchestrator';
import { OperationalWagerCoordinator } from '../electron-src/operational-wager-coordinator.js';

const BASE_TIME = new Date('2026-08-27T00:00:00.000Z');

function accepted(command: ControlledOperationalWagerCommand) {
  return {
    status: 'ACCEPTED' as const,
    tableId: 'D001',
    wager: {
      wagerId: 'wager-D001',
      tableId: 'D001',
      shoeId: 'shoe-D001',
      handId: 'hand-D001',
      market: command.market,
      amount: command.amount,
      source: command.source,
      createdAt: command.createdAt ?? BASE_TIME.toISOString(),
    },
  };
}

describe('OperationalWagerCoordinator keepalive activation', () => {
  it('excludes native-dialog tables from wager-based keepalive', async () => {
    const ledger = new SqliteLedger(':memory:');
    const placeOperationalWager = vi.fn(async (command: ControlledOperationalWagerCommand) =>
      accepted(command));
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      actor: () => ({ placeOperationalWager }),
      monitorTableIds: () => ['bc281koreanch281', 'D001'],
      keepaliveTableIds: () => ['D001'],
      serialize: async operation => await operation(),
    });

    try {
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 10,
        market: 'banker',
        amount: 20,
      }, BASE_TIME);
      await coordinator.tick(BASE_TIME, 'bc281koreanch281');
      expect(placeOperationalWager).not.toHaveBeenCalled();
      await coordinator.tick(BASE_TIME, 'D001');

      expect(placeOperationalWager).toHaveBeenCalledTimes(1);
      expect(coordinator.getKeepaliveState().lastTableId).toBe('D001');
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('checks immediately and retries when the next betting window becomes eligible', async () => {
    const ledger = new SqliteLedger(':memory:');
    let open = false;
    const placeOperationalWager = vi.fn(async (command: ControlledOperationalWagerCommand) =>
      open
        ? accepted(command)
        : { status: 'REJECTED' as const, tableId: 'D001', reason: 'betting-window-required' });
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      actor: () => ({ placeOperationalWager }),
      monitorTableIds: () => ['D001'],
      serialize: async operation => await operation(),
    });

    try {
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 10,
        market: 'banker',
        amount: 20,
      }, BASE_TIME);
      await coordinator.tick(BASE_TIME, 'D001');
      expect(placeOperationalWager).toHaveBeenCalledTimes(1);
      expect(coordinator.getKeepaliveState().lastAttemptAt).toBeUndefined();

      open = true;
      await coordinator.tick(new Date(BASE_TIME.valueOf() + 15_000), 'D001');

      expect(placeOperationalWager).toHaveBeenCalledTimes(2);
      expect(coordinator.getKeepaliveState()).toMatchObject({
        enabled: true,
        lastStatus: 'ACCEPTED',
        lastTableId: 'D001',
      });
    } finally {
      coordinator.close();
      ledger.close();
    }
  });

  it('starts a fresh cycle immediately after automation is re-enabled', async () => {
    const ledger = new SqliteLedger(':memory:');
    const placeOperationalWager = vi.fn(async (command: ControlledOperationalWagerCommand) =>
      accepted(command));
    const coordinator = new OperationalWagerCoordinator({
      ledger,
      actor: () => ({ placeOperationalWager }),
      monitorTableIds: () => ['D001'],
      serialize: async operation => await operation(),
    });

    try {
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 10,
        market: 'banker',
        amount: 20,
      }, BASE_TIME);
      await coordinator.tick(BASE_TIME, 'D001');
      await coordinator.updateKeepalive({
        enabled: false,
        intervalMinutes: 10,
        market: 'banker',
        amount: 20,
      }, new Date(BASE_TIME.valueOf() + 1_000));
      await coordinator.updateKeepalive({
        enabled: true,
        intervalMinutes: 10,
        market: 'banker',
        amount: 20,
      }, new Date(BASE_TIME.valueOf() + 2_000));
      await coordinator.tick(new Date(BASE_TIME.valueOf() + 2_000), 'D001');

      expect(placeOperationalWager).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.close();
      ledger.close();
    }
  });
});
