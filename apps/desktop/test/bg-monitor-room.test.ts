import { describe, expect, it } from 'vitest';
import { BrowserBridgeServer } from '@baccarat/browser-bridge';
import { EVENT_SCHEMA_VERSION } from '@baccarat/contracts';
import { DesktopConsoleService } from '../electron-src/service';

describe('desktop BG monitor room', () => {
  it('treats dafabet-bg B06 as a live pending-join candidate', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-bg',
          displayName: 'Dafabet BG Live',
          tables: [{ tableId: 'B06', gameCount: 12 }],
        },
      });
      const pending = service['pendingJoinTableIds']() as string[];
      expect(pending).toContain('B06');
    } finally {
      await service.close();
    }
  });

  it('does not auto-monitor a BG table just because it has a live roundId', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-bg-state',
        url: 'https://cdnx-hwa.jbz029.com/h5V01/pc/index.html?table=B06',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          view: 'single',
          observedAt: '2026-09-05T01:00:00.000Z',
          tables: [{ tableId: 'A31', roundId: '4257001', bettingOpen: true, source: 'protocol' }],
        }),
      });
      service['promotePendingTablesFromRooms'](bridge.getDiscoveredRooms());
      expect(service['monitorTableIds']).not.toContain('A31');
      expect(service['pendingJoinTableIds']()).toContain('A31');
    } finally {
      await service.close();
    }
  });

  it('auto-monitors a BG table after NEXT_SHOES shuffle evidence', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-bg-state',
        url: 'https://cdnx-hwa.jbz029.com/h5V01/pc/index.html?table=B06',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          view: 'single',
          observedAt: '2026-09-05T01:00:00.000Z',
          tables: [{
            tableId: 'C07',
            shuffleEvent: true,
            shoeReset: 'seq:2030682',
            source: 'protocol',
          }],
        }),
      });
      service['promotePendingTablesFromRooms'](bridge.getDiscoveredRooms());
      expect(service['monitorTableIds']).not.toContain('C07');
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-bg-state',
        url: 'https://cdnx-hwa.jbz029.com/h5V01/pc/index.html?table=B06',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          view: 'single',
          observedAt: '2026-09-05T01:00:01.000Z',
          tables: [{
            tableId: 'C07',
            shuffleEvent: true,
            shoeReset: 'seq:2030683',
            source: 'protocol',
          }],
        }),
      });
      service['promotePendingTablesFromRooms'](bridge.getDiscoveredRooms());
      expect(service['monitorTableIds']).toContain('C07');
    } finally {
      await service.close();
    }
  });

  it('does not kick a just-shuffled BG table out when the road is still 1', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-bg-state',
        url: 'https://cdnx-hwa.jbz029.com/h5V01/pc/index.html?table=B06',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          view: 'single',
          observedAt: '2026-09-05T01:00:00.000Z',
          tables: [{
            tableId: 'A30',
            shuffleEvent: true,
            shoeReset: 'seq:10',
            gameCount: 1,
            source: 'protocol',
          }],
        }),
      });
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-bg-state',
        url: 'https://cdnx-hwa.jbz029.com/h5V01/pc/index.html?table=B06',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          view: 'single',
          observedAt: '2026-09-05T01:00:01.000Z',
          tables: [{
            tableId: 'A30',
            shuffleEvent: true,
            shoeReset: 'seq:11',
            gameCount: 1,
            source: 'protocol',
          }],
        }),
      });
      service['promotePendingTablesFromRooms'](bridge.getDiscoveredRooms());
      expect(service['monitorTableIds']).toContain('A30');
      service['tableMetadata'].set('A30', {
        tableId: 'A30',
        roomId: 'dafabet-bg',
        updatedAt: '2026-09-05T01:00:00.000Z',
        gameCount: 1,
      });
      expect(service['demoteIfGameCountAnomaly']('A30')).toBe(false);
      expect(service['monitorTableIds']).toContain('A30');
    } finally {
      await service.close();
    }
  });

  it('re-joins a shuffled BG table when the first post-shuffle betting window opens', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-bg-state',
        url: 'https://cdnx-hwa.jbz029.com/h5V01/pc/index.html?table=B06',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          view: 'single',
          observedAt: '2026-09-05T01:00:00.000Z',
          tables: [{
            tableId: 'A30',
            shuffleEvent: true,
            shoeReset: 'seq:10',
            source: 'protocol',
          }],
        }),
      });
      expect(bridge.shoeEvidence('A30')?.reason).toBe('attach');
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-bg-state',
        url: 'https://cdnx-hwa.jbz029.com/h5V01/pc/index.html?table=B06',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          view: 'single',
          observedAt: '2026-09-05T01:00:01.000Z',
          tables: [{
            tableId: 'A30',
            shuffleEvent: true,
            shoeReset: 'seq:11',
            source: 'protocol',
          }],
        }),
      });
      expect(bridge.shoeEvidence('A30')?.reason).toBe('protocol-shuffle');
      service['monitorTableIds'] = [];
      await service.injectEvent({
        type: 'bettingWindowOpened',
        eventId: 'a30-open',
        tableId: 'A30',
        timestamp: '2026-09-05T01:02:00.000Z',
        sourceSeq: 2,
        source: 'bg-runtime',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId: 'bg-A30-2',
        handId: '11',
        market: 'bankerPair',
      });
      expect(service['monitorTableIds']).toContain('A30');
    } finally {
      await service.close();
    }
  });
});
