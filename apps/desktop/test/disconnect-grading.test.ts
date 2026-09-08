import { describe, expect, it } from 'vitest';
import { DesktopConsoleService } from '../electron-src/service';

function timestamp(): string {
  return new Date().toISOString();
}

describe('graded disconnect handling', () => {
  it('keeps observed tables on extension flap and only fail-closes exposed tables', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055', 'D065']);
      service['liveAuthorizationSources'].set('D065', 'unattended');
      service['runtimeObservedTableIds'].add('D055');
      service['runtimeObservedTableIds'].add('D065');

      service['handleBridgeRuntimeEvent']({
        kind: 'extension-disconnected',
        reason: 'websocket-close-1006',
        timestamp: timestamp(),
      });
      await service['executionStateOperation'];

      expect(service['runtimeObservedTableIds'].has('D055')).toBe(true);
      expect(service['liveAuthorizationSources'].has('D065')).toBe(false);
      expect(service['transportDownAt']).toBeDefined();
      expect(service.snapshot().runtime.incidents.some(incident =>
        incident.active && incident.code === 'bridge-disconnected')).toBe(true);
    } finally {
      await service.close();
    }
  });

  it('exposes per-table link state and flap counts in the runtime snapshot', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      service['noteTableDisconnect']('D055');
      service['noteTableDisconnect']('D055');
      const snapshot = service.snapshot();
      expect(snapshot.runtime.tables.D055?.disconnects).toBe(2);
      expect(snapshot.runtime.tables.D055?.linkState).toBeDefined();
      expect(snapshot.runtime.tables.D055?.lastDisconnectAt).toEqual(expect.any(String));
    } finally {
      await service.close();
    }
  });

  it('downgrades flap noise to degraded during the recovery window', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      service['beginRecoverySuppression'](60_000);
      service['handleBridgeRuntimeEvent']({
        kind: 'table-disconnected',
        tableId: 'D055',
        reason: 'table-feed-stale',
        timestamp: timestamp(),
      });
      await service['executionStateOperation'];
      const incident = service.snapshot().runtime.incidents.find(incident =>
        incident.active && incident.code === 'table-feed-stale' && incident.tableId === 'D055');
      expect(incident?.severity).toBe('degraded');
    } finally {
      await service.close();
    }
  });

  it('escalates chronic flappers out of the stale exemption', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      service['noteTableDisconnect']('D055');
      service['noteTableDisconnect']('D055');
      service['noteTableDisconnect']('D055');
      service['noteTableDisconnect']('D055');
      expect(service['flapEscalated']('D055')).toBe(true);
      expect(service['flapEscalated']('D065')).toBe(false);
      const aged = new DesktopConsoleService(':memory:');
      try {
        await aged.updateMonitorTableIds(['D055']);
        const now = Date.now();
        aged['noteTableDisconnect']('D055', now - 6 * 60_000);
        aged['noteTableDisconnect']('D055', now - 5 * 60_000);
        aged['noteTableDisconnect']('D055', now - 4 * 60_000);
        aged['noteTableDisconnect']('D055', now);
        expect(aged['flapEscalated']('D055', now)).toBe(false);
      } finally {
        await aged.close();
      }
    } finally {
      await service.close();
    }
  });
});
