import { describe, expect, it } from 'vitest';
import { BrowserBridgeServer } from '@baccarat/browser-bridge';
import { DesktopConsoleService } from '../electron-src/service';

describe('desktop Winfinity monitor room', () => {
  it('treats dafabet-winfinity tyn-bac8 as a live pending-join candidate', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-winfinity',
          displayName: 'Dafabet Winfinity',
          tables: [{ tableId: 'tyn-bac8', gameCount: 12 }],
        },
      });
      const pending = service['pendingJoinTableIds']() as string[];
      expect(pending).toContain('tyn-bac8');
    } finally {
      await service.close();
    }
  });

  it('does not auto-monitor a Winfinity table until protocol-shuffle evidence', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-winfinity-state',
        url: 'https://lobby.youngpoisson.xyz/',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          observedAt: '2026-09-09T12:00:00.000Z',
          tables: [{
            tableId: 'tyn-bac8',
            vendorTableId: '638f56dc65729f90d0636fb0',
            streamId: 'tyn-bac8',
            source: 'hall',
          }],
        }),
      });
      service['promotePendingTablesFromRooms'](bridge.getDiscoveredRooms());
      expect(service['monitorTableIds']).not.toContain('tyn-bac8');
      expect(service['pendingJoinTableIds']()).toContain('tyn-bac8');
    } finally {
      await service.close();
    }
  });

  it('accepts hyphenated Winfinity table ids', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['tyn-bac8', 'wnf-64f72835c860df661dc2b666']);
      expect(service['monitorTableIds']).toEqual(['tyn-bac8', 'wnf-64f72835c860df661dc2b666']);
    } finally {
      await service.close();
    }
  });

  it('replaces a persisted wnf fallback with the inferred stream id', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const vendor = '638f56dc65729f90d0636fb0';
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      await service.updateMonitorTableIds([`wnf-${vendor}`]);
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-winfinity-state',
        url: 'https://baccarat-multitable.youngpoisson.xyz/?streamId=tyn-bac8&tableId=638f56dc65729f90d0636fb0',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          observedAt: '2026-09-09T12:00:00.000Z',
          tables: [{
            tableId: 'tyn-bac8',
            vendorTableId: vendor,
            streamId: 'tyn-bac8',
            displayName: 'Tao Yuan Baccarat 8',
            source: 'hall',
          }],
        }),
      });
      await service['applyCollapsedWinfinityMonitorTables']();
      expect(service['monitorTableIds']).toEqual(['tyn-bac8']);
    } finally {
      await service.close();
    }
  });
});
