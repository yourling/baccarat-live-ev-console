import { describe, expect, it, vi } from 'vitest';
import { BrowserBridgeServer } from '@baccarat/browser-bridge';
import { EVENT_SCHEMA_VERSION, defaultProfile } from '@baccarat/contracts';
import { DesktopConsoleService } from '../electron-src/service';

function bgSettledHand(tableId: string, shoeId: string, handId: string, sourceSeq: number) {
  return {
    type: 'handSettled' as const,
    eventId: `settled-${tableId}-${handId}`,
    tableId,
    timestamp: '2026-09-08T02:00:00.000Z',
    sourceSeq,
    source: 'bg-runtime' as const,
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId,
    handId,
    playerCards: [{ rank: '5' as const }, { rank: 'A' as const }],
    bankerCards: [{ rank: '9' as const }, { rank: '8' as const }],
    outcomes: { bankerPair: false, playerPair: false },
  };
}

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

  it('does not auto-rejoin a missing-card demotion until the next shoe', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const tableId = 'B05';
    const shoeId = 'bg-B05-2';
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      service['ensureMonitorActors']([tableId]);
      service['monitorTableIds'] = [tableId];
      service['tableMetadata'].set(tableId, {
        tableId,
        roomId: 'dafabet-bg',
        updatedAt: '2026-09-08T02:00:00.000Z',
        gameCount: 5,
      });
      vi.spyOn(bridge, 'shoeEvidence').mockReturnValue({ reason: 'protocol-shuffle' });

      await service.injectEvent({
        type: 'newShoeSignal',
        eventId: 'b05-shoe-2',
        tableId,
        timestamp: '2026-09-08T02:00:00.000Z',
        sourceSeq: 1,
        source: 'bg-runtime',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId,
        baseline: 'physical-shoe',
        profile: { ...defaultProfile(tableId), autoConfirmNewShoe: true },
      });
      const actor = service['orchestrator'].getActor(tableId);
      if (!actor) throw new Error('B05 actor missing');
      await actor.setAutoBet(true, shoeId);
      await service.injectEvent(bgSettledHand(tableId, shoeId, '100', 2));
      await service.injectEvent(bgSettledHand(tableId, shoeId, '103', 3));

      expect(service['monitorTableIds']).not.toContain(tableId);
      expect(service['demotedPendingTableIds'].has(tableId)).toBe(true);
      expect(service['demotedPendingShoeIds'].get(tableId)).toBe(shoeId);
      expect(service.snapshot().runtime.incidents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'shoe-count-mismatch',
          tableId,
          active: true,
          message: expect.stringContaining('缺牌 12 张'),
        }),
      ]));
      expect(service['ledger'].listEvents(tableId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'autoDisarmChanged', reason: 'execution-reset' }),
      ]));

      await service.injectEvent({
        type: 'bettingWindowOpened',
        eventId: 'b05-same-shoe-window',
        tableId,
        timestamp: '2026-09-08T02:01:00.000Z',
        sourceSeq: 4,
        source: 'bg-runtime',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId,
        handId: '104',
        market: 'bankerPair',
      });
      service['promotePendingTablesFromRooms']([{
        roomId: 'dafabet-bg',
        tables: [{ tableId, gameCount: 5 }],
      }]);
      expect(service['monitorTableIds']).not.toContain(tableId);

      await service.injectEvent({
        type: 'newShoeSignal',
        eventId: 'b05-shoe-3',
        tableId,
        timestamp: '2026-09-08T02:10:00.000Z',
        sourceSeq: 5,
        source: 'bg-runtime',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId: 'bg-B05-3',
        baseline: 'physical-shoe',
        profile: { ...defaultProfile(tableId), autoConfirmNewShoe: true },
      });
      expect(service['monitorTableIds']).toContain(tableId);
      expect(service['demotedPendingTableIds'].has(tableId)).toBe(false);
    } finally {
      await service.close();
    }
  });
});
