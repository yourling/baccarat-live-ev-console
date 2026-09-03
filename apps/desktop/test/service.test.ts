import { BrowserBridgeServer } from '@baccarat/browser-bridge';
import type { BetExecutionRequest, BrowserAdapter } from '@baccarat/adapter-contract';
import { EVENT_SCHEMA_VERSION, defaultProfile, type NormalizedEvent } from '@baccarat/contracts';
import type { BetReceipt } from '@baccarat/contracts';
import type { OneShotBetCommand, OneShotBetResult } from '@baccarat/orchestrator';
import type { TableExport, TableExportSink } from '@baccarat/room-monitor';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  oneShotConfirmationText,
  parseOneShotLiveBetCommand,
  type OneShotLiveBetCommand,
} from '../src/api-types';
import { DesktopConsoleService } from '../electron-src/service';

function oneShotCommand(overrides: Partial<OneShotLiveBetCommand> = {}): OneShotLiveBetCommand {
  const command = {
    tableId: overrides.tableId ?? 'D055',
    shoeId: overrides.shoeId ?? 'shoe-1',
    handId: overrides.handId ?? 'GD055-1',
    market: overrides.market ?? 'bankerPair',
    amount: overrides.amount ?? 20,
  };
  return {
    ...command,
    confirmation: overrides.confirmation ?? oneShotConfirmationText(command),
  };
}

function liveExecutionRequest(command: OneShotLiveBetCommand): BetExecutionRequest {
  return {
    intent: {
      intentId: 'one-shot-intent',
      tableId: command.tableId,
      shoeId: command.shoeId,
      handId: command.handId,
      market: command.market,
      amount: command.amount,
      mode: 'live',
      idempotencyKey: `one-shot:${command.tableId}:${command.shoeId}:${command.handId}:${command.market}`,
      strategy: { type: 'fixed', market: command.market },
      decisionSnapshotId: 'one-shot-decision',
      createdAt: '2026-08-24T00:00:00.000Z',
    },
    mode: 'live',
    reservationId: 'one-shot-reservation',
  };
}

function oneShotReceipt(
  command: OneShotLiveBetCommand,
  status: BetReceipt['status'] = 'ACCEPTED',
): BetReceipt {
  return {
    receiptId: 'one-shot-receipt',
    intentId: 'one-shot-intent',
    reservationId: 'one-shot-reservation',
    status,
    amount: command.amount,
    market: command.market,
    mode: 'live',
    createdAt: '2026-08-24T00:00:01.000Z',
  };
}

function installOneShotActor(
  service: DesktopConsoleService,
  command: OneShotLiveBetCommand,
  receipt: BetReceipt,
  place?: (request: OneShotBetCommand) => Promise<OneShotBetResult>,
) {
  const actor = service['orchestrator'].registerTable(defaultProfile(command.tableId), 'shadow', command.amount);
  const placeOneShotBet = vi.fn(place ?? (async request => {
    expect(request).toEqual({
      shoeId: command.shoeId,
      handId: command.handId,
      market: command.market,
      amount: command.amount,
    });
    const bridge = service['browserBridge'];
    if (!bridge) throw new Error('test bridge was not installed');
    await bridge.requestBet(liveExecutionRequest(command));
    return {
      status: 'ACCEPTED',
      receipt,
      reservationId: receipt.reservationId,
    };
  }));
  Object.defineProperty(actor, 'placeOneShotBet', {
    configurable: true,
    value: placeOneShotBet,
  });
  return { actor, placeOneShotBet };
}

async function selectMonitorTable(service: DesktopConsoleService, tableId: string): Promise<void> {
  await service.updateMonitorTableIds([tableId]);
}

function freshLiveFeed(tableId: string): TableExport {
  return {
    tableId,
    start: async () => undefined,
    stop: async () => undefined,
    flush: async () => undefined,
    keepAlive: async () => ({ ok: true, latencyMs: 10 }),
    health: () => ({
      tableId,
      state: 'CONNECTED',
      lastAckedSeq: 1,
      lastEmittedSeq: 1,
      bufferDepth: 0,
      reconnectCount: 0,
      lastObservationAt: new Date().toISOString(),
      stalenessMs: 10,
    }),
  };
}

function authenticateLiveBridge(bridge: BrowserBridgeServer): void {
  vi.spyOn(bridge, 'getExtensionStatus').mockReturnValue({
    connectionCount: 1,
    authenticated: true,
    lastSeenAt: '2026-08-27T01:00:00.000Z',
  });
}

function installFakeBridge(service: DesktopConsoleService, receipt: BetReceipt) {
  const bridge = new BrowserBridgeServer();
  const liveGateCalls: boolean[] = [];
  const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(enabled => {
    liveGateCalls.push(enabled);
  });
  const requestBet = vi.spyOn(bridge, 'requestBet').mockResolvedValue(receipt);
  const liveReadiness = vi.spyOn(
    service as unknown as {
      liveTableReasons: (tableId: string, approved?: boolean) => string[];
    },
    'liveTableReasons',
  ).mockReturnValue([]);
  service['browserBridge'] = bridge;
  return { bridge, liveGateCalls, setLiveBetEnabled, requestBet, liveReadiness };
}

function monitorShoeEvent(
  tableId: string,
  eventId: string,
  baseline: 'physical-shoe' | 'unknown-monitor-session' = 'unknown-monitor-session',
): Extract<NormalizedEvent, { type: 'newShoeSignal' }> {
  return {
    type: 'newShoeSignal',
    eventId,
    tableId,
    timestamp: '2026-08-23T11:00:00.000Z',
    sourceSeq: 1,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `monitor-session-${tableId}`,
    baseline,
    profile: { ...defaultProfile(tableId), autoConfirmNewShoe: true },
  };
}

function openedPlatformRound(tableId: string, eventId: string, handId: string): NormalizedEvent {
  return {
    type: 'bettingWindowOpened',
    eventId,
    tableId,
    timestamp: '2026-08-23T11:00:01.000Z',
    sourceSeq: 2,
    source: 'pragmatic-runtime',
    schemaVersion: EVENT_SCHEMA_VERSION,
    shoeId: `monitor-session-${tableId}`,
    handId,
    market: 'bankerPair',
  };
}

describe('desktop console demo sessions', () => {
  it('parses a one-shot live bet command and requires the exact confirmation text', () => {
    const command = oneShotCommand();

    expect(oneShotConfirmationText(command)).toBe(
      'ONE_SHOT_LIVE_BET|tableId=D055|shoeId=shoe-1|handId=GD055-1|market=bankerPair|amount=20',
    );
    expect(parseOneShotLiveBetCommand(command)).toEqual(command);
    expect(() => parseOneShotLiveBetCommand({
      ...command,
      confirmation: `${oneShotConfirmationText(command)} `,
    })).toThrow(/confirmation/i);
    expect(() => parseOneShotLiveBetCommand({
      ...command,
      amount: 0,
    })).toThrow(/amount/i);

    const changedCommands: OneShotLiveBetCommand[] = [
      { ...command, tableId: 'D056' },
      { ...command, shoeId: 'shoe-2' },
      { ...command, handId: 'GD055-2' },
      { ...command, market: 'playerPair' },
      { ...command, amount: 25 },
    ];
    for (const changed of changedCommands) {
      expect(() => parseOneShotLiveBetCommand({
        ...changed,
        confirmation: command.confirmation,
      })).toThrow(/confirmation/i);
    }
  });

  // Contract: trim and uppercase IDs, keep first occurrence, reject blanks, and preserve order.
  it('starts a fresh monitor session with no tables', async () => {
    const previous = process.env.BACCARAT_LIVE_TABLES;
    delete process.env.BACCARAT_LIVE_TABLES;
    const service = new DesktopConsoleService(':memory:');
    try {
      expect(service.snapshot().monitorTableIds).toEqual([]);
    } finally {
      await service.close();
      if (previous === undefined) {
        delete process.env.BACCARAT_LIVE_TABLES;
      } else {
        process.env.BACCARAT_LIVE_TABLES = previous;
      }
    }
  });

  it('clears a persisted copy of the retired four-table default list', async () => {
    const previous = process.env.BACCARAT_LIVE_TABLES;
    delete process.env.BACCARAT_LIVE_TABLES;
    const service = new DesktopConsoleService(':memory:');
    try {
      service['ledger'].setConfig('desktop:monitor-tables:v1', {
        tableIds: ['bc281koreanch281', 'tobcbaccaragen92', 'speedbca14gesbc1', 'h22z8qhp17sa0vkh'],
      });
      expect(service['loadMonitorTableIds']()).toEqual([]);
      expect(service['ledger'].getConfig('desktop:monitor-tables:v1')).toEqual({ tableIds: [] });
    } finally {
      await service.close();
      if (previous === undefined) delete process.env.BACCARAT_LIVE_TABLES;
      else process.env.BACCARAT_LIVE_TABLES = previous;
    }
  });

  it('updates the live monitor table list and exposes only the requested order', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      const updated = await service.updateMonitorTableIds(['D065', 'D055']);

      expect(updated.monitorTableIds).toEqual(['D065', 'D055']);
      expect(updated.monitorTableIds).not.toContain('D056');
      expect(updated.monitorTableIds).not.toContain('D057');
    } finally {
      await service.close();
    }
  });

  it('persists the ordered live monitor table list across services using the same database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-monitor-tables-'));
    const dbPath = join(directory, 'console.sqlite');
    try {
      const first = new DesktopConsoleService(dbPath);
      try {
        await first.updateMonitorTableIds(['D065', 'D055']);
      } finally {
        await first.close();
      }

      const second = new DesktopConsoleService(dbPath);
      try {
        expect(second.snapshot().monitorTableIds).toEqual(['D065', 'D055']);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('normalizes duplicate IDs while rejecting blank IDs', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      const normalized = await service.updateMonitorTableIds([' d065 ', 'D065', ' D055 ']);

      expect(normalized.monitorTableIds).toEqual(['D065', 'D055']);
      await expect(service.updateMonitorTableIds(['D055', '   '])).rejects.toThrow(/table id/i);
    } finally {
      await service.close();
    }
  });

  it('filters the live dashboard snapshot to the configured monitor tables in persisted order', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.startLiveRoomMonitor(0);
      await service.registerTable(defaultProfile('P001'), 'shadow', 100);

      const updated = await service.updateMonitorTableIds(['D065', 'D055']);

      expect(updated.monitorTableIds).toEqual(['D065', 'D055']);
      expect(Object.keys(updated.snapshot.tables)).toEqual(['D065', 'D055']);
      expect(updated.snapshot.tables.P001).toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it('enables keepalive without arming pair automation', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.injectEvent(monitorShoeEvent('D055', 'd055-keepalive-only', 'physical-shoe'));

      const started = await service.setKeepaliveEnabled(true);

      expect(started.keepalive.enabled).toBe(true);
      expect(started.automation.enabled).toBe(false);
      expect(started.snapshot.tables.D055?.projection.autoBetStatus).toBe('DISARMED');
    } finally {
      await service.close();
    }
  });

  it('enables pair automation without enabling keepalive', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.injectEvent(monitorShoeEvent('D055', 'd055-pair-only', 'physical-shoe'));

      const started = await service.setAutomationEnabled(true);

      expect(started.automation.enabled).toBe(true);
      expect(started.keepalive.enabled).toBe(false);
      expect(started.snapshot.tables.D055?.projection.autoBetStatus).toBe('ARMED');
    } finally {
      await service.close();
    }
  });

  it('keeps mid-shoe discoveries pending until a physical new shoe starts', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      await service.updateMonitorTableIds([]);
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'speedbca14gesbc1', displayName: '极速百家乐', gameCount: 42 }],
        },
      });

      await service['attachLiveTables']();
      const pending = service.snapshot();
      expect(pending.monitorTableIds).not.toContain('speedbca14gesbc1');
      expect(pending.monitorCandidates.map(candidate => candidate.tableId)).toContain('speedbca14gesbc1');
      expect(pending.snapshot.tables.speedbca14gesbc1).toBeUndefined();

      bridge.ingestClientMessage({
        kind: 'roomUpdated',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'speedbca14gesbc1', displayName: '极速百家乐', gameCount: 1 }],
        },
      });
      await service['attachLiveTables']();

      const joined = service.snapshot();
      expect(joined.monitorTableIds).toContain('speedbca14gesbc1');
    } finally {
      await service.close();
    }
  });

  it('joins a pending table when a physical new shoe starts even if the road count is still high', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      await service.updateMonitorTableIds([]);
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'speedbca14gesbc1', displayName: '极速百家乐', gameCount: 42 }],
        },
      });
      await service['attachLiveTables']();
      expect(service.snapshot().monitorTableIds).not.toContain('speedbca14gesbc1');

      bridge.recordShoeEvidence('speedbca14gesbc1', { reason: 'protocol-shuffle' });
      await service.injectEvent(monitorShoeEvent('speedbca14gesbc1', 'speed-physical-shoe', 'physical-shoe'));
      expect(service.snapshot().monitorTableIds).toContain('speedbca14gesbc1');
    } finally {
      await service.close();
    }
  });

  it('does not join a pending table from a physical label without shuffle evidence', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      await service.updateMonitorTableIds([]);
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          tables: [{ tableId: 'bc281koreanch281', gameCount: 55 }],
        },
      });
      await service['attachLiveTables']();
      bridge.recordShoeEvidence('bc281koreanch281', { reason: 'attach' });
      await service.injectEvent(monitorShoeEvent('bc281koreanch281', 'korean-false-physical-join', 'physical-shoe'));
      expect(service.snapshot().monitorTableIds).not.toContain('bc281koreanch281');
    } finally {
      await service.close();
    }
  });

  it('does not join a pending table from an unknown mid-shoe attach', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      await service.updateMonitorTableIds([]);
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          tables: [{ tableId: 'bc281koreanch281', gameCount: 55 }],
        },
      });
      await service['attachLiveTables']();
      await service.injectEvent(monitorShoeEvent('bc281koreanch281', 'korean-attach', 'unknown-monitor-session'));
      expect(service.snapshot().monitorTableIds).not.toContain('bc281koreanch281');
    } finally {
      await service.close();
    }
  });

  it('does not present Korean baccarat #55 remaining 407 as a trusted physical shoe', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['bc281koreanch281']);
      service['tableMetadata'].set('bc281koreanch281', {
        tableId: 'bc281koreanch281',
        roomId: 'dafabet-pragmatic',
        updatedAt: '2026-09-01T00:00:00.000Z',
        gameCount: 55,
      });
      await service.injectEvent(monitorShoeEvent('bc281koreanch281', 'korean-attach-55', 'unknown-monitor-session'));
      const snapshot = service.snapshot();
      const projection = snapshot.snapshot.tables.bc281koreanch281?.projection;
      expect(projection?.shoeBaseline).toBe('unknown-monitor-session');
      expect(snapshot.shoeEvidence.bc281koreanch281).toEqual(expect.objectContaining({
        reason: 'attach',
        label: '入桌，未见洗牌',
      }));
    } finally {
      await service.close();
    }
  });

  it('hides full-shoe inventory when a physical label contradicts a deep road after restart', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['bc281koreanch281']);
      service['tableMetadata'].set('bc281koreanch281', {
        tableId: 'bc281koreanch281',
        roomId: 'dafabet-pragmatic',
        updatedAt: '2026-09-01T00:00:00.000Z',
        gameCount: 55,
      });
      await service.injectEvent(monitorShoeEvent('bc281koreanch281', 'korean-false-physical', 'physical-shoe'));
      const projection = service.snapshot().snapshot.tables.bc281koreanch281?.projection;
      expect(projection?.shoeBaseline).toBe('unknown-monitor-session');
    } finally {
      await service.close();
    }
  });

  it('joins a pending table when the road wraps to an early count after shuffle lag', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      await service.updateMonitorTableIds([]);
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'tobcbaccaragen92', displayName: '粤语极速百家乐', gameCount: 48 }],
        },
      });
      await service['attachLiveTables']();
      expect(service.snapshot().monitorTableIds).not.toContain('tobcbaccaragen92');

      bridge.ingestClientMessage({
        kind: 'roomUpdated',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'tobcbaccaragen92', displayName: '粤语极速百家乐', gameCount: 5 }],
        },
      });
      await service['attachLiveTables']();
      expect(service.snapshot().monitorTableIds).toContain('tobcbaccaragen92');
    } finally {
      await service.close();
    }
  });

  it('drops a monitored table when internal hands and DOM road disagree, then rejoins on wrap', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const tableId = 'spto12bctorobc12';
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      await service.updateMonitorTableIds([tableId]);
      await service.injectEvent({
        ...monitorShoeEvent(tableId, 'spto12-physical', 'physical-shoe'),
        shoeId: 'pragmatic-spto12bctorobc12-2',
        sourceSeq: 1,
      });
      for (let hand = 1; hand <= 8; hand += 1) {
        await service.injectEvent({
          type: 'bettingWindowOpened',
          eventId: `spto12-open-${hand}`,
          tableId,
          timestamp: '2026-09-02T15:00:00.000Z',
          sourceSeq: hand + 1,
          source: 'pragmatic-runtime',
          schemaVersion: EVENT_SCHEMA_VERSION,
          shoeId: 'pragmatic-spto12bctorobc12-2',
          handId: `hand-${hand}`,
          market: 'bankerPair',
        });
      }
      expect(service.snapshot().snapshot.tables[tableId]?.projection.handNumber).toBe(8);
      service['tableMetadata'].set(tableId, {
        tableId,
        roomId: 'dafabet-pragmatic',
        updatedAt: new Date().toISOString(),
        gameCount: 40,
      });
      await service.injectEvent({
        type: 'bettingWindowOpened',
        eventId: 'spto12-open-9',
        tableId,
        timestamp: '2026-09-02T15:00:01.000Z',
        sourceSeq: 10,
        source: 'pragmatic-runtime',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId: 'pragmatic-spto12bctorobc12-2',
        handId: 'hand-9',
        market: 'bankerPair',
      });
      expect(service.snapshot().monitorTableIds).not.toContain(tableId);
      expect(service['demotedPendingTableIds'].has(tableId)).toBe(true);

      bridge.ingestClientMessage({
        kind: 'roomUpdated',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId, displayName: '极速百家乐12', gameCount: 5 }],
        },
      });
      await service['attachLiveTables']();
      expect(service.snapshot().monitorTableIds).toContain(tableId);
    } finally {
      await service.close();
    }
  });

  it('does not auto-join a mid-shoe table when the road count only drops one hand', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      await service.updateMonitorTableIds([]);
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'spto11bctorobc11', displayName: '越南语极速百家乐1', gameCount: 34 }],
        },
      });
      await service['attachLiveTables']();
      expect(service.snapshot().monitorTableIds).not.toContain('spto11bctorobc11');

      bridge.ingestClientMessage({
        kind: 'roomUpdated',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'spto11bctorobc11', displayName: '越南语极速百家乐1', gameCount: 33 }],
        },
      });
      await service['attachLiveTables']();
      expect(service.snapshot().monitorTableIds).not.toContain('spto11bctorobc11');
    } finally {
      await service.close();
    }
  });

  it('does not forget the previous road count when shuffle briefly reports #0', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      await service.updateMonitorTableIds([]);
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'tobcspbaccarat92', displayName: '韩语百家乐2', gameCount: 48 }],
        },
      });
      await service['attachLiveTables']();
      expect(service.snapshot().monitorTableIds).not.toContain('tobcspbaccarat92');

      bridge.ingestClientMessage({
        kind: 'roomUpdated',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'tobcspbaccarat92', displayName: '韩语百家乐2', gameCount: 0 }],
        },
      });
      await service['attachLiveTables']();
      expect(service.snapshot().monitorTableIds).not.toContain('tobcspbaccarat92');

      bridge.ingestClientMessage({
        kind: 'roomUpdated',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'tobcspbaccarat92', displayName: '韩语百家乐2', gameCount: 1 }],
        },
      });
      await service['attachLiveTables']();
      expect(service.snapshot().monitorTableIds).toContain('tobcspbaccarat92');
    } finally {
      await service.close();
    }
  });

  it('lets keepalive target a pending table without arming pair bets', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      await service.updateMonitorTableIds([]);
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          tables: [{ tableId: 'speedbca14gesbc1', gameCount: 18 }],
        },
      });
      await service['attachLiveTables']();
      await service.setKeepaliveEnabled(true);
      await service.setAutomationEnabled(true);

      expect(service.snapshot().monitorTableIds).not.toContain('speedbca14gesbc1');
      expect(service['operationalWagers']['options'].keepaliveTableIds?.() ?? []).toContain('speedbca14gesbc1');
      expect(service.snapshot().snapshot.tables.speedbca14gesbc1).toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it('keeps global automation active when one table disconnects and rearms it after recovery', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055', 'D066']);
      await service.injectEvent(monitorShoeEvent('D055', 'd055-attached', 'unknown-monitor-session'));
      await service.injectEvent(monitorShoeEvent('D066', 'd066-attached', 'unknown-monitor-session'));

      await service.setKeepaliveEnabled(true);
      const started = await service.setAutomationEnabled(true);

      expect(started.automation).toEqual({ enabled: true });
      expect(started.keepalive.enabled).toBe(true);
      expect(started.snapshot.tables.D055?.projection.autoBetStatus).toBe('DISARMED');
      expect(started.snapshot.tables.D066?.projection.autoBetStatus).toBe('DISARMED');

      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-verified', 'physical-shoe'),
        shoeId: 'd055-verified-shoe',
        sourceSeq: 2,
      });
      await service.injectEvent({
        ...monitorShoeEvent('D066', 'd066-verified', 'physical-shoe'),
        shoeId: 'd066-verified-shoe',
        sourceSeq: 2,
      });

      expect(service.snapshot().snapshot.tables.D055?.projection.autoBetStatus).toBe('ARMED');
      expect(service.snapshot().snapshot.tables.D066?.projection.autoBetStatus).toBe('ARMED');

      await service.injectEvent({
        type: 'connectionLost',
        eventId: 'd055-lost',
        tableId: 'D055',
        timestamp: '2026-08-23T11:00:02.000Z',
        sourceSeq: 3,
        source: 'room-monitor',
        schemaVersion: EVENT_SCHEMA_VERSION,
      });
      const isolated = service.snapshot();
      expect(isolated.keepalive.enabled).toBe(true);
      expect(isolated.snapshot.tables.D066?.projection.autoBetStatus).toBe('ARMED');

      await service.injectEvent({
        type: 'connectionRestored',
        eventId: 'd055-restored',
        tableId: 'D055',
        timestamp: '2026-08-23T11:00:03.000Z',
        sourceSeq: 4,
        source: 'room-monitor',
        schemaVersion: EVENT_SCHEMA_VERSION,
        continuityProof: `cursor-v1:${'c'.repeat(64)}`,
      });

      const recovered = service.snapshot();
      expect(recovered.keepalive.enabled).toBe(true);
      expect(recovered.snapshot.tables.D055?.projection.shoeBaseline).toBe('unknown-monitor-session');
      expect(recovered.snapshot.tables.D055?.projection.autoBetStatus).toBe('DISARMED');
      expect(recovered.snapshot.tables.D066?.projection.autoBetStatus).toBe('ARMED');

      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-reshuffled', 'physical-shoe'),
        shoeId: 'd055-reshuffled-shoe',
        sourceSeq: 5,
      });
      expect(service.snapshot().snapshot.tables.D055?.projection.autoBetStatus).toBe('ARMED');

      const stopped = await service.setAutomationEnabled(false);

      expect(stopped.automation).toEqual({ enabled: false });
      expect(stopped.keepalive.enabled).toBe(true);
      expect(stopped.snapshot.tables.D055?.projection.autoBetStatus).toBe('DISARMED');
    } finally {
      await service.close();
    }
  });

  it('arms pair EV after an approved physical shoe confirmation', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      // Given: automation is active while a verified physical shoe awaits confirmation.
      await service.updateMonitorTableIds(['D055']);
      await service.setAutomationEnabled(true);
      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-awaiting-confirmation', 'physical-shoe'),
        profile: { ...defaultProfile('D055'), autoConfirmNewShoe: false },
      });
      expect(service.snapshot().snapshot.tables.D055?.projection).toMatchObject({
        status: 'WAITING_CONFIRMATION',
        autoBetStatus: 'DISARMED',
      });

      // When: the physical shoe confirmation is approved.
      await service.injectEvent({
        type: 'shoeConfirmation',
        eventId: 'd055-confirmed',
        tableId: 'D055',
        timestamp: '2026-08-23T11:00:01.000Z',
        sourceSeq: 2,
        source: 'operator',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId: 'monitor-session-D055',
        approved: true,
      });

      // Then: the newly confirmed shoe is tracked and pair EV is armed.
      expect(service.snapshot().snapshot.tables.D055?.projection).toMatchObject({
        status: 'TRACKING',
        autoBetStatus: 'ARMED',
      });
    } finally {
      await service.close();
    }
  });

  it('keeps automation stopped when strategy settings are saved after a global stop', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.setAutomationEnabled(true);
      await service.setAutomationEnabled(false);

      const updated = await service.updateKeepaliveSettings({
        intervalMinutes: 5,
        market: 'player',
        amount: 30,
      });

      expect(updated.automation).toEqual({ enabled: false });
      expect(updated.keepalive).toMatchObject({
        enabled: false,
        intervalMinutes: 5,
        market: 'player',
        amount: 30,
      });
    } finally {
      await service.close();
    }
  });

  it('does not allow manual pair recovery to bypass a global stop', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.injectEvent(monitorShoeEvent('D055', 'd055-global-stop-shoe', 'physical-shoe'));
      await service.setAutomationEnabled(true);
      await service.setAutomationEnabled(false);

      await expect(service.setAutoBet('D055', true, 'monitor-session-D055'))
        .rejects.toThrow('global automation is disabled');
      expect(service.snapshot().snapshot.tables.D055?.projection.autoBetStatus).toBe('DISARMED');
    } finally {
      await service.close();
    }
  });

  it('blocks automatic pair execution after global stop even when a later event rearms the table', async () => {
    // Given: a live, eligible physical shoe has been globally stopped.
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const requestBet = vi.spyOn(bridge, 'requestBet').mockResolvedValue(null);
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    authenticateLiveBridge(bridge);
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      service['orchestrator'].registerTable(defaultProfile('D055'), 'shadow', 20);
      service['liveFeeds'].set('D055', freshLiveFeed('D055'));
      await service.injectEvent(monitorShoeEvent('D055', 'd055-global-stop-execution-shoe', 'physical-shoe'));
      await service.setExecutionMode('D055', 'live');
      const actor = service['orchestrator'].getActor('D055');
      if (!actor) throw new Error('global-stop execution test actor was not registered');
      actor.updateConfiguration({ ...actor.getProfile(), minEV: -10 }, 20);
      await service.setAutomationEnabled(true);
      await service.setAutomationEnabled(false);

      // When: an event re-arms the table after the global stop and a live window opens.
      await service.injectEvent({
        type: 'autoArmChanged',
        eventId: 'd055-rearmed-after-global-stop',
        tableId: 'D055',
        timestamp: '2026-08-23T11:00:01.000Z',
        sourceSeq: 2,
        source: 'operator',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId: 'monitor-session-D055',
        armed: true,
      });
      await service.injectEvent({
        ...openedPlatformRound('D055', 'd055-window-after-global-stop', 'GD055-global-stop'),
        sourceSeq: 3,
      });

      // Then: the automatic event is audited but cannot reach the live browser bridge.
      expect(requestBet).not.toHaveBeenCalled();
      expect(service.snapshot().decisions).toContainEqual(expect.objectContaining({
        tableId: 'D055',
        reason: expect.stringContaining('global-automation-disabled'),
      }));
    } finally {
      await service.close();
    }
  });

  it.each(['shadow', 'simulated'] as const)(
    'blocks automatic pair execution after a global stop in %s mode',
    async executionMode => {
      const service = new DesktopConsoleService(':memory:');
      try {
        await service.updateMonitorTableIds(['D055']);
        service['orchestrator'].registerTable(defaultProfile('D055'), executionMode, 20);
        await service.injectEvent(monitorShoeEvent('D055', `d055-${executionMode}-stop-shoe`, 'physical-shoe'));
        const actor = service['orchestrator'].getActor('D055');
        if (!actor) throw new Error(`${executionMode} global-stop test actor was not registered`);
        actor.updateConfiguration({ ...actor.getProfile(), minEV: -10 }, 20);
        await service.setAutomationEnabled(true);
        await service.setAutomationEnabled(false);

        await service.injectEvent({
          type: 'autoArmChanged',
          eventId: `d055-${executionMode}-rearmed-after-global-stop`,
          tableId: 'D055',
          timestamp: '2026-08-23T11:00:01.000Z',
          sourceSeq: 2,
          source: 'operator',
          schemaVersion: EVENT_SCHEMA_VERSION,
          shoeId: 'monitor-session-D055',
          armed: true,
        });
        await service.injectEvent({
          ...openedPlatformRound('D055', `d055-${executionMode}-window-after-global-stop`, `GD055-${executionMode}-global-stop`),
          sourceSeq: 3,
        });

        expect(service.snapshot().reservations).toEqual([]);
        expect(service.snapshot().receipts).toEqual([]);
        expect(service.snapshot().decisions).toContainEqual(expect.objectContaining({
          tableId: 'D055',
          reason: expect.stringContaining('global-automation-disabled'),
        }));
      } finally {
        await service.close();
      }
    },
  );

  it('does not overlap an automatic pair execution with a keepalive wager', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    let releasePair: () => void = () => undefined;
    let signalPairStarted: () => void = () => undefined;
    const pairBlocked = new Promise<void>(resolve => {
      releasePair = resolve;
    });
    const pairStarted = new Promise<void>(resolve => {
      signalPairStarted = resolve;
    });
    const requestBet = vi.spyOn(bridge, 'requestBet').mockImplementation(async () => {
      signalPairStarted();
      await pairBlocked;
      return null;
    });
    const requestOperationalWager = vi.spyOn(bridge, 'requestOperationalWager')
      .mockImplementation(async request => ({
        receiptId: `keepalive-${request.wager.wagerId}`,
        wagerId: request.wager.wagerId,
        tableId: request.wager.tableId,
        shoeId: request.wager.shoeId,
        handId: request.wager.handId,
        market: request.wager.market,
        amount: request.wager.amount,
        source: request.wager.source,
        status: 'ACCEPTED',
        createdAt: '2026-08-23T11:00:02.000Z',
      }));
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    authenticateLiveBridge(bridge);
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      service['orchestrator'].registerTable(defaultProfile('D055'), 'shadow', 20);
      service['liveFeeds'].set('D055', freshLiveFeed('D055'));
      await service.injectEvent(monitorShoeEvent('D055', 'd055-overlap-shoe', 'physical-shoe'));
      await service.setExecutionMode('D055', 'live');
      const actor = service['orchestrator'].getActor('D055');
      if (!actor) throw new Error('overlap test actor was not registered');
      actor.updateConfiguration({ ...actor.getProfile(), minEV: -10 }, 20);
      await service.setAutomationEnabled(true);

      const opening = service.injectEvent({
        ...openedPlatformRound('D055', 'd055-overlap-window', 'GD055-overlap'),
        sourceSeq: 2,
      });
      await pairStarted;

      releasePair();
      await opening;

      expect(requestOperationalWager).not.toHaveBeenCalled();
      expect(requestBet).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
    }
  });

  it('keeps simulated demo records visible while live monitoring is active', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      // Given: the desktop startup flow has activated live monitoring.
      await service.startLiveRoomMonitor(0);

      // When: a simulated demo session writes events to its own tables.
      const snapshot = await service.runDemo(42);

      // Then: the demo tables and their records remain visible to the operator.
      expect(snapshot.snapshot.tables['table-1']).toBeDefined();
      expect(snapshot.snapshot.tables['table-2']).toBeDefined();
      expect(snapshot.events.some(event => event.tableId === 'table-1')).toBe(true);
      expect(snapshot.recordCounts.events).toBeGreaterThan(0);
    } finally {
      await service.close();
    }
  });



  it('allows the operator to stop all live table monitoring without deleting history', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.startLiveRoomMonitor(0);
      const stopped = await service.updateMonitorTableIds([]);

      expect(stopped.monitorTableIds).toEqual([]);
      expect(stopped.snapshot.tables).toEqual({});
    } finally {
      await service.close();
    }
  });

  it('disarms and demotes a removed live actor before allowing the same actor to rejoin', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const feed = {
      tableId: 'D055',
      start: async () => undefined,
      stop: async () => undefined,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D055',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'disarm-remove-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    const actor = service['orchestrator'].registerTable(defaultProfile('D055'), 'shadow', 20);
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      service['orchestrator'].updateTableExecutionMode('D055', 'live');
      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-physical-shoe', 'physical-shoe'),
        sourceSeq: 2,
      });
      await actor.setAutoBet(true, 'monitor-session-D055');

      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('ARMED');

      await service.updateMonitorTableIds([]);

      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('DISARMED');

      await service.updateMonitorTableIds(['D055']);

      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('DISARMED');
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
    }
  });

  it('disarms and demotes every actor when live table monitoring stops', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const feed = {
      tableId: 'D055',
      start: async () => undefined,
      stop: async () => undefined,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D055',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'disarm-stop-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    const actor = service['orchestrator'].registerTable(defaultProfile('D055'), 'shadow', 20);
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      service['orchestrator'].updateTableExecutionMode('D055', 'live');
      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-physical-shoe', 'physical-shoe'),
        sourceSeq: 2,
      });
      await actor.setAutoBet(true, 'monitor-session-D055');

      await service.stopLiveRoomMonitor();

      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('DISARMED');
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
    }
  });

  it('fails closed before a removed feed can fail after delivering a stale betting window', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    let sink: TableExportSink | undefined;
    const requestBet = vi.spyOn(bridge, 'requestBet').mockImplementation(async request => ({
      receiptId: 'stale-feed-receipt',
      intentId: request.intent.intentId,
      reservationId: request.reservationId ?? '',
      status: 'ACCEPTED',
      amount: request.intent.amount,
      market: request.intent.market,
      mode: request.intent.mode,
      createdAt: '2026-08-23T11:00:02.000Z',
    }));
    const stop = vi.fn(async () => {
      if (!sink) throw new Error('table export sink was not registered');
      await sink.onBatch({
        tableId: 'D055',
        events: [openedPlatformRound('D055', 'stale-feed-window', 'stale-feed-hand')],
        cursor: {
          tableId: 'D055',
          sourceSeq: 2,
          eventId: 'stale-feed-window',
          payloadHash: 'stale-feed-window',
        },
        kind: 'live',
      });
      throw new Error('synthetic stop failure after stale callback');
    });
    const feed = {
      tableId: 'D055',
      start: async (nextSink: TableExportSink) => {
        sink = nextSink;
      },
      stop,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D055',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
        lastObservationAt: new Date().toISOString(),
        stalenessMs: 10,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'fail-closed-stale-feed-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    authenticateLiveBridge(bridge);
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      const actor = service['orchestrator'].getActor('D055');
      if (!actor) throw new Error('fail-closed test actor was not registered');

      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-fail-closed-shoe', 'physical-shoe'),
        sourceSeq: 2,
      });
      await service.setExecutionMode('D055', 'live');
      await service.setAutomationEnabled(true);
      await service.setAutoBet('D055', true, 'monitor-session-D055');

      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('ARMED');

      const updated = await service.updateMonitorTableIds(['D065']);

      expect(updated.demoError).toBe('synthetic stop failure after stale callback');
      expect(updated.monitorTableIds).toEqual(['D055']);
      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('DISARMED');
      expect(requestBet).not.toHaveBeenCalled();
      expect(setLiveBetEnabled).toHaveBeenLastCalledWith(false);
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      setLiveBetEnabled.mockRestore();
      await service.close();
    }
  });

  it('fails closed before awaiting a removed feed that hangs during stop', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    let markStopStarted: () => void = () => {
      throw new Error('stop barrier was not initialized');
    };
    let releaseStop: () => void = () => {
      throw new Error('stop release was not initialized');
    };
    const stopStarted = new Promise<void>(resolve => {
      markStopStarted = resolve;
    });
    const stop = vi.fn(() => new Promise<void>(resolve => {
      markStopStarted();
      releaseStop = resolve;
    }));
    const feed = {
      tableId: 'D055',
      start: async () => undefined,
      stop,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D055',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
        lastObservationAt: new Date().toISOString(),
        stalenessMs: 10,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'fail-closed-hanging-feed-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    authenticateLiveBridge(bridge);
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      const actor = service['orchestrator'].getActor('D055');
      if (!actor) throw new Error('hanging-feed test actor was not registered');

      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-hanging-feed-shoe', 'physical-shoe'),
        sourceSeq: 2,
      });
      await service.setExecutionMode('D055', 'live');
      await service.setAutomationEnabled(true);
      await service.setAutoBet('D055', true, 'monitor-session-D055');

      const transition = service.updateMonitorTableIds([]);
      await stopStarted;

      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('DISARMED');
      expect(setLiveBetEnabled).toHaveBeenLastCalledWith(false);

      releaseStop();
      const stopped = await transition;
      expect(stopped.monitorTableIds).toEqual([]);
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      setLiveBetEnabled.mockRestore();
      releaseStop();
      await service.close();
    }
  });

  it('fails closed for every actor before awaiting stopLiveRoomMonitor feed shutdown', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    let markStopStarted: () => void = () => {
      throw new Error('stop barrier was not initialized');
    };
    let releaseStop: () => void = () => {
      throw new Error('stop release was not initialized');
    };
    const stopStarted = new Promise<void>(resolve => {
      markStopStarted = resolve;
    });
    const stop = vi.fn(() => new Promise<void>(resolve => {
      markStopStarted();
      releaseStop = resolve;
    }));
    const feed = {
      tableId: 'D055',
      start: async () => undefined,
      stop,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D055',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
        lastObservationAt: new Date().toISOString(),
        stalenessMs: 10,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'fail-closed-stop-monitor-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    authenticateLiveBridge(bridge);
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      const actor = service['orchestrator'].getActor('D055');
      if (!actor) throw new Error('stop monitor test actor was not registered');

      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-stop-monitor-shoe', 'physical-shoe'),
        sourceSeq: 2,
      });
      await service.setExecutionMode('D055', 'live');
      await service.setAutomationEnabled(true);
      await service.setAutoBet('D055', true, 'monitor-session-D055');

      const stopping = service.stopLiveRoomMonitor();
      await stopStarted;

      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('DISARMED');
      expect(setLiveBetEnabled).toHaveBeenLastCalledWith(false);

      releaseStop();
      await stopping;
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      setLiveBetEnabled.mockRestore();
      releaseStop();
      await service.close();
    }
  });

  it('resets a reused live actor before attaching its monitor feed again', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const feed = {
      tableId: 'D055',
      start: async () => undefined,
      stop: async () => undefined,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D055',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'disarm-reattach-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    const actor = service['orchestrator'].registerTable(defaultProfile('D055'), 'shadow', 20);
    service['browserBridge'] = bridge;

    try {
      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-physical-shoe', 'physical-shoe'),
      });
      service['orchestrator'].updateTableExecutionMode('D055', 'live');
      await actor.setAutoBet(true, 'monitor-session-D055');

      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('ARMED');

      await service.updateMonitorTableIds(['D055']);

      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('DISARMED');
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
    }
  });

  it('reports total record counts independently of the currently loaded record page', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      await service.injectEvent(monitorShoeEvent('D055', 'd055-counted'));

      const current = service.snapshot({ includeHistory: false });

      expect(current.recordCounts.events).toBe(1);
      expect(current.recordCounts.decisions).toBe(0);
      expect(current.recordCounts.ledger).toBe(0);
    } finally {
      await service.close();
    }
  });

  it('can inject two demo sessions into the same ledger', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.setAutomationEnabled(true);
      const first = await service.runDemo(42);
      expect(first.receipts.length).toBeGreaterThan(0);
      const light = service.snapshot({ includeHistory: false });
      expect(light.events.length).toBeLessThan(first.events.length);
      expect(light.summary.rows.length).toBeGreaterThan(0);
      const eventPage = service.queryRecords({ kind: 'events', page: 1, pageSize: 20 });
      const decisionPage = service.queryRecords({ kind: 'decisions', page: 1, pageSize: 20 });
      const ledgerPage = service.queryRecords({ kind: 'ledger', page: 1, pageSize: 20 });
      expect(eventPage.events?.length).toBeLessThanOrEqual(20);
      expect(decisionPage.decisions?.length).toBeLessThanOrEqual(20);
      expect(ledgerPage.ledger?.length).toBeLessThanOrEqual(20);
      expect(eventPage.total).toBeGreaterThan(20);
      const second = await service.runDemo(43);

      expect(second.events.length).toBeGreaterThan(first.events.length);
      expect(second.decisions.length).toBeGreaterThan(first.decisions.length);
      expect(second.decisions.some(decision => decision.eligible && decision.evLower < 0)).toBe(false);
      expect(Object.values(second.snapshot.tables).every(table => /^\d{12}-\d{3}$/.test(table.projection.shoeId))).toBe(true);
    } finally {
      await service.close();
    }
  });

  it('returns one decision row per hand, applies the eligibility filter, and exposes actual results', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      const snapshot = await service.runDemo(42);
      const eligiblePage = service.queryRecords({
        kind: 'decisions',
        page: 1,
        pageSize: 100,
        eligible: true,
      });
      const ineligiblePage = service.queryRecords({
        kind: 'decisions',
        page: 1,
        pageSize: 100,
        eligible: false,
      });

      expect(eligiblePage.total).toBeGreaterThan(0);
      expect(ineligiblePage.total).toBeGreaterThan(0);
      const uniqueDecisionHands = new Set(
        snapshot.decisions.map(decision => `${decision.tableId}|${decision.shoeId}|${decision.handId}`),
      );
      expect(eligiblePage.total + ineligiblePage.total).toBe(uniqueDecisionHands.size);
      expect(eligiblePage.decisions?.every(decision => decision.eligible)).toBe(true);
      expect(ineligiblePage.decisions?.every(decision => !decision.eligible)).toBe(true);
      expect(new Set(eligiblePage.decisions?.map(decision => `${decision.tableId}|${decision.shoeId}|${decision.handId}`)).size)
        .toBe(eligiblePage.decisions?.length);
      expect(eligiblePage.decisions?.every(decision => decision.actualResult.status !== 'PENDING')).toBe(true);
    } finally {
      await service.close();
    }
  });

  it('updates minimum EV, default amount, and EV tiers', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.runDemo(42);
      const updated = await service.updateTableSettings('table-1', {
        minEV: 0.05,
        defaultBetAmount: 25,
        betTiers: [{ minEV: 0, amount: 25 }, { minEV: 0.5, amount: 100 }],
        monitorUrl: '窗口-1',
      });
      const table = updated.snapshot.tables['table-1'];
      expect(table.profile.minEV).toBe(0.05);
      expect(table.profile.betTiers).toEqual([{ minEV: 0, amount: 25 }, { minEV: 0.5, amount: 100 }]);
      expect(table.defaultBetAmount).toBe(25);
      expect(table.profile.monitorUrl).toBe('窗口-1');
    } finally {
      await service.close();
    }
  });

  it('applies one EV strategy to every monitored table while preserving table-specific monitor links', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055', 'D065']);
      await service.updateTableSettings('D055', {
        minEV: 0.01,
        defaultBetAmount: 10,
        betTiers: [],
        monitorUrl: '窗口-D055',
      });
      await service.updateTableSettings('D065', {
        minEV: 0.02,
        defaultBetAmount: 20,
        betTiers: [],
        monitorUrl: '窗口-D065',
      });

      const updated = await service.updateAllTableSettings({
        minEV: 0.05,
        defaultBetAmount: 50,
        betTiers: [{ minEV: 0.05, amount: 50 }, { minEV: 0.1, amount: 100 }],
      });

      for (const tableId of ['D055', 'D065']) {
        const table = updated.snapshot.tables[tableId];
        expect(table?.profile.minEV).toBe(0.05);
        expect(table?.profile.betTiers).toEqual([{ minEV: 0.05, amount: 50 }, { minEV: 0.1, amount: 100 }]);
        expect(table?.defaultBetAmount).toBe(50);
      }
      expect(updated.snapshot.tables.D055?.profile.monitorUrl).toBe('窗口-D055');
      expect(updated.snapshot.tables.D065?.profile.monitorUrl).toBe('窗口-D065');
    } finally {
      await service.close();
    }
  });

  it('requires an explicit extension gate before enabling live execution for one table', async () => {
    // Given: the table is monitored in shadow mode and the extension command channel is available.
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    authenticateLiveBridge(bridge);
    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D055']);
      service['liveFeeds'].set('D055', freshLiveFeed('D055'));
      await service.injectEvent(monitorShoeEvent('D055', 'd055-live-gate-shoe', 'physical-shoe'));

      // When: the operator switches this table to live and then back to shadow.
      const live = await service.setExecutionMode('D055', 'live');
      const shadow = await service.setExecutionMode('D055', 'shadow');

      // Then: the extension gate and actor mode move together, while auto bet remains stopped.
      expect(setLiveBetEnabled.mock.calls).toEqual([[true]]);
      expect(live.snapshot.tables.D055?.executionMode).toBe('live');
      expect(live.snapshot.tables.D055?.projection.autoBetStatus).toBe('DISARMED');
      expect(shadow.snapshot.tables.D055?.executionMode).toBe('live');
    } finally {
      setLiveBetEnabled.mockRestore();
      await service.close();
    }
  });

  it('fails closed when live execution is requested without a browser bridge', async () => {
    // Given: a monitored table exists but no browser extension bridge is running.
    const service = new DesktopConsoleService(':memory:');
    try {
      service['orchestrator'].registerTable(defaultProfile('D055'), 'shadow', 100);

      // When / Then: live mode is rejected and the table remains shadow.
      await expect(service.setExecutionMode('D055', 'live')).rejects.toThrow(/bridge/i);
      expect(service.snapshot().snapshot.tables.D055?.executionMode).toBe('live');
    } finally {
      await service.close();
    }
  });

  it('executes exactly one one-shot live bet and always closes the live gate', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command);
    const originalExecutor: Pick<BrowserAdapter, 'requestBet'> = {
      requestBet: async () => null,
    };
    service['currentExecutor'] = originalExecutor;
    service['orchestrator'].setExecutor(originalExecutor);
    const { placeOneShotBet } = installOneShotActor(service, command, receipt);
    const actor = service['orchestrator'].getActor(command.tableId);
    if (!actor) throw new Error('one-shot test actor was not registered');
    const setExecutor = vi.spyOn(actor, 'setExecutor');
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      const result = await service.executeOneShotLiveBet(command);

      expect(placeOneShotBet).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('ACCEPTED');
      expect(requestBet).toHaveBeenCalledTimes(1);
      expect(requestBet).toHaveBeenCalledWith(expect.objectContaining({ mode: 'live' }));
      expect(liveGateCalls).toEqual([true, false]);
      expect(result.receipt).toEqual(receipt);
      expect(result.snapshot.snapshot.tables.D055?.executionMode).toBe('live');
      expect(setExecutor.mock.calls).toHaveLength(2);
      expect(setExecutor.mock.calls[1]?.[0]).toBe(originalExecutor);
    } finally {
      await service.close();
    }
  });

  it('allows a one-shot live bet before a physical shoe baseline is known', async () => {
    const service = new DesktopConsoleService(':memory:');
    const tableId = 'D055';
    const handId = 'GD055-midshoe-1';
    const command = oneShotCommand({
      tableId,
      shoeId: `monitor-session-${tableId}`,
      handId,
    });
    const bridge = new BrowserBridgeServer();
    const liveGateCalls: boolean[] = [];
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(enabled => {
      liveGateCalls.push(enabled);
    });
    authenticateLiveBridge(bridge);
    const requestBet = vi.spyOn(bridge, 'requestBet')
      .mockImplementation(async request => ({
        receiptId: 'one-shot-midshoe-receipt',
        intentId: request.intent.intentId,
        reservationId: request.reservationId ?? '',
        status: 'ACCEPTED',
        amount: request.intent.amount,
        market: request.intent.market,
        mode: 'live',
        createdAt: '2026-08-24T00:00:01.000Z',
      }));

    try {
      service['browserBridge'] = bridge;
      await selectMonitorTable(service, tableId);
      service['liveFeeds'].set(tableId, freshLiveFeed(tableId));
      await service.injectEvent(monitorShoeEvent(tableId, 'monitor-session-start'));
      await service.injectEvent(openedPlatformRound(tableId, 'open-midshoe', handId));

      const result = await service.executeOneShotLiveBet(command);

      expect(result.status).toBe('ACCEPTED');
      expect(requestBet).toHaveBeenCalledTimes(1);
      expect(requestBet).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'live',
        intent: expect.objectContaining({
          tableId,
          shoeId: `monitor-session-${tableId}`,
          handId,
        }),
      }));
      expect(liveGateCalls).toContain(true);
      expect(result.snapshot.snapshot.tables[tableId]?.projection.shoeBaseline)
        .toBe('unknown-monitor-session');
    } finally {
      await service.close();
    }
  });

  it('returns a platform rejected result and still closes the live gate', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command, 'REJECTED');
    installOneShotActor(service, command, receipt, async _request => {
      const bridge = service['browserBridge'];
      if (!bridge) throw new Error('test bridge was not installed');
      await bridge.requestBet(liveExecutionRequest(command));
      return {
        status: 'REJECTED',
        reason: 'platform-rejected',
        receipt,
        reservationId: receipt.reservationId,
      };
    });
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      const result = await service.executeOneShotLiveBet(command);
      expect(result).toEqual(expect.objectContaining({
        status: 'REJECTED',
        receipt,
        reason: 'platform-rejected',
        snapshot: expect.any(Object),
      }));
      expect(requestBet).toHaveBeenCalledTimes(1);
      expect(liveGateCalls).toEqual([true, false]);
    } finally {
      await service.close();
    }
  });

  it('returns an unknown platform result and still closes the live gate', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command, 'UNKNOWN');
    installOneShotActor(service, command, receipt, async _request => {
      const bridge = service['browserBridge'];
      if (!bridge) throw new Error('test bridge was not installed');
      await bridge.requestBet(liveExecutionRequest(command));
      return {
        status: 'UNKNOWN',
        reason: 'platform-unknown',
        receipt,
        reservationId: receipt.reservationId,
      };
    });
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      const result = await service.executeOneShotLiveBet(command);
      expect(result).toEqual(expect.objectContaining({
        status: 'UNKNOWN',
        receipt,
        reason: 'platform-unknown',
        snapshot: expect.any(Object),
      }));
      expect(requestBet).toHaveBeenCalledTimes(1);
      expect(liveGateCalls).toEqual([true, false]);
    } finally {
      await service.close();
    }
  });

  it('throws only for a local rejected result without a platform receipt', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command);
    installOneShotActor(service, command, receipt, async _request => ({
      status: 'REJECTED',
      reason: 'executor-required',
    }));
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      await expect(service.executeOneShotLiveBet(command))
        .rejects.toThrow('one-shot live bet rejected locally: executor-required');
      expect(requestBet).not.toHaveBeenCalled();
      expect(liveGateCalls).toEqual([true, false]);
    } finally {
      await service.close();
    }
  });

  it('rejects a one-shot command whose confirmation is not an exact match before touching the bridge', async () => {
    const service = new DesktopConsoleService(':memory:');
    const baseCommand = oneShotCommand();
    const command = oneShotCommand({ confirmation: `${oneShotConfirmationText(baseCommand)} ` });
    const receipt = oneShotReceipt(command);
    installOneShotActor(service, command, receipt);
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      await expect(service.executeOneShotLiveBet(command)).rejects.toThrow(/confirmation/i);
      expect(liveGateCalls).toEqual([]);
      expect(requestBet).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it('allows one-shot live bets only for a currently monitored table', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    const receipt = oneShotReceipt(command);
    installOneShotActor(service, command, receipt);
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      await service.updateMonitorTableIds(['D056']);

      await expect(service.executeOneShotLiveBet(command)).rejects.toThrow(/not monitored/i);
      expect(liveGateCalls).toEqual([]);
      expect(requestBet).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it('allows one-shot live bets when local runtime readiness is stale', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command);
    installOneShotActor(service, command, receipt);
    const { liveGateCalls, requestBet, liveReadiness } = installFakeBridge(service, receipt);
    liveReadiness.mockReturnValue(['table-feed-stale']);

    try {
      const result = await service.executeOneShotLiveBet(command);
      expect(result.status).toBe('ACCEPTED');
      expect(liveGateCalls).toEqual([true, false]);
      expect(requestBet).toHaveBeenCalledTimes(1);
    } finally {
      liveReadiness.mockRestore();
      await service.close();
    }
  });

  it('allows one-shot live bets while another table has persistent live mode', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command);
    installOneShotActor(service, command, receipt);
    service['orchestrator'].registerTable(defaultProfile('D056'), 'live', 20);
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      const result = await service.executeOneShotLiveBet(command);
      expect(result.status).toBe('ACCEPTED');
      expect(liveGateCalls).toEqual([true, false]);
      expect(requestBet).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
    }
  });

  it('allows one-shot live bets while any registered table remains auto-bet armed', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command);
    installOneShotActor(service, command, receipt);
    const armedActor = service['orchestrator'].registerTable(defaultProfile('D056'), 'shadow', 20);
    await service.injectEvent({
      ...monitorShoeEvent('D056', 'd056-one-shot-shoe', 'physical-shoe'),
    });
    await armedActor.setAutoBet(true, 'monitor-session-D056');
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      const result = await service.executeOneShotLiveBet(command);
      expect(result.status).toBe('ACCEPTED');
      expect(liveGateCalls).toEqual([true, false]);
      expect(requestBet).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
    }
  });

  it('allows only one one-shot live bet in flight globally', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command);
    let release: () => void = () => {
      throw new Error('one-shot release was not initialized');
    };
    let markStarted: () => void = () => {
      throw new Error('one-shot start was not initialized');
    };
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    installOneShotActor(service, command, receipt, async _request => {
      const bridge = service['browserBridge'];
      if (!bridge) throw new Error('test bridge was not installed');
      const acceptedReceipt = await bridge.requestBet(liveExecutionRequest(command));
      markStarted();
      await blocked;
      if (acceptedReceipt === null) {
        return {
          status: 'UNKNOWN',
          reason: 'executor-no-receipt',
          reservationId: receipt.reservationId,
        };
      }
      return {
        status: 'ACCEPTED',
        receipt: acceptedReceipt,
        reservationId: acceptedReceipt.reservationId,
      };
    });
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      const first = service.executeOneShotLiveBet(command);
      await started;

      await expect(service.executeOneShotLiveBet(command)).rejects.toThrow(/in flight/i);
      release();
      await expect(first).resolves.toEqual(expect.objectContaining({ receipt }));
      expect(requestBet).toHaveBeenCalledTimes(1);
      expect(liveGateCalls).toEqual([true, false]);
    } finally {
      await service.close();
    }
  });

  it('serializes execution-state changes behind an in-flight one-shot', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command);
    let release: () => void = () => {
      throw new Error('one-shot release was not initialized');
    };
    let markStarted: () => void = () => {
      throw new Error('one-shot start was not initialized');
    };
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    installOneShotActor(service, command, receipt, async _request => {
      const bridge = service['browserBridge'];
      if (!bridge) throw new Error('test bridge was not installed');
      const acceptedReceipt = await bridge.requestBet(liveExecutionRequest(command));
      markStarted();
      await blocked;
      if (acceptedReceipt === null) {
        return {
          status: 'UNKNOWN',
          reason: 'executor-no-receipt',
          reservationId: receipt.reservationId,
        };
      }
      return {
        status: 'ACCEPTED',
        receipt: acceptedReceipt,
        reservationId: acceptedReceipt.reservationId,
      };
    });
    const { liveGateCalls, liveReadiness } = installFakeBridge(service, receipt);
    const actor = service['orchestrator'].getActor(command.tableId);
    if (!actor) throw new Error('one-shot test actor was not registered');
    const updateExecutionMode = vi.spyOn(service['orchestrator'], 'updateTableExecutionMode');

    try {
      const oneShot = service.executeOneShotLiveBet(command);
      await started;

      const mode = service.setExecutionMode(command.tableId, 'live');

      expect(updateExecutionMode).toHaveBeenCalledTimes(1);
      expect(liveGateCalls).toEqual([true]);

      release();
      await oneShot;
      await mode;

      expect(liveGateCalls).toEqual([true, false, true]);
      expect(updateExecutionMode).toHaveBeenCalledTimes(2);
      expect(service.snapshot().snapshot.tables.D055?.executionMode).toBe('live');
    } finally {
      liveReadiness.mockRestore();
      await service.close();
    }
  });

  it('closes the live gate when the one-shot actor fails', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command);
    installOneShotActor(service, command, receipt, async _request => {
      const bridge = service['browserBridge'];
      if (!bridge) throw new Error('test bridge was not installed');
      await bridge.requestBet(liveExecutionRequest(command));
      throw new Error('synthetic one-shot failure');
    });
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      await expect(service.executeOneShotLiveBet(command)).rejects.toThrow('synthetic one-shot failure');
      expect(requestBet).toHaveBeenCalledTimes(1);
      expect(liveGateCalls).toEqual([true, false]);
    } finally {
      await service.close();
    }
  });

  it('best-effort sends liveOff before closing a connected browser bridge', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const callOrder: string[] = [];
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(enabled => {
      if (!enabled) callOrder.push('liveOff');
    });
    vi.spyOn(bridge, 'close').mockImplementation(async () => {
      callOrder.push('close');
    });
    service['browserBridge'] = bridge;

    try {
      await service.close();
      expect(callOrder).toEqual(['liveOff', 'close']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('closes the browser bridge even when the best-effort liveOff fails', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const close = vi.spyOn(bridge, 'close').mockResolvedValue(undefined);
    vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => {
      throw new Error('synthetic liveOff failure');
    });
    service['browserBridge'] = bridge;

    try {
      await expect(service.close()).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps historical events but excludes unregistered tables from the live overview summary', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.runDemo(42);
      const before = service.snapshot();
      expect(before.summary.rows.some(row => row.tableId === 'table-2')).toBe(true);

      service['orchestrator'].unregisterTable('table-2');
      const after = service.snapshot();
      expect(after.events.some(event => event.tableId === 'table-2')).toBe(true);
      expect(after.summary.rows.some(row => row.tableId === 'table-2')).toBe(false);
      expect(after.snapshot.tables['table-2']).toBeUndefined();
    } finally {
      await service.close();
    }
  });
  it('waits for an explicit runtime table selection before attaching discovered bridge rooms', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'r1',
          tables: [{ tableId: 'D055' }, { tableId: 'P001' }],
        },
      });

      await service['attachLiveTables']();

      expect(Object.keys(service.snapshot().snapshot.tables)).toEqual([]);
    } finally {
      await service.close();
    }
  });
  it('attaches forty discovered Pragmatic tables as independent feeds and actors', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const tableIds = Array.from({ length: 40 }, (_, index) =>
      `pragmatictable${String(index + 1).padStart(2, '0')}`);
    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D066']);
      await service.updateAllTableSettings({
        minEV: 0.1,
        defaultBetAmount: 20,
        betTiers: [
          { minEV: 0.2, amount: 40 },
          { minEV: 0.3, amount: 60 },
        ],
      });
      service['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: tableIds.map(tableId => ({ tableId })),
        },
      });

      const snapshot = await service.updateMonitorTableIds(tableIds);

      expect(snapshot.monitorTableIds).toEqual(tableIds);
      expect(Object.keys(snapshot.snapshot.tables)).toEqual(tableIds);
      expect(service['liveFeeds'].size).toBe(40);
      expect(new Set(service['liveRoomIdsByTable'].values())).toEqual(new Set(['dafabet-pragmatic']));
      expect(Object.values(snapshot.snapshot.tables)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          defaultBetAmount: 20,
          profile: expect.objectContaining({
            minEV: 0.1,
            betTiers: [
              { minEV: 0.2, amount: 40 },
              { minEV: 0.3, amount: 60 },
            ],
          }),
        }),
      ]));
      expect(Object.values(snapshot.snapshot.tables).every(table =>
        table.defaultBetAmount === 20
        && table.profile.minEV === 0.1
        && table.profile.betTiers?.length === 2)).toBe(true);
    } finally {
      await service.close();
    }
  });
  it('retains approved live actors while the page transiently reports no visible table', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer({ selectedTableIds: ['D055'] });
    try {
      service['browserBridge'] = bridge;
      service['orchestrator'].registerTable(defaultProfile('D055'), 'shadow', 100);
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-runtime-selection',
        url: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({ tableIds: [] }),
      });

      await service['attachLiveTables']();

      expect(service.snapshot().snapshot.tables['D055']).toBeDefined();
    } finally {
      await service.close();
    }
  });

  it('clears monitor records while preserving table settings', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.runDemo(42);
      await service.updateTableSettings('table-1', { minEV: 0.05, defaultBetAmount: 25, betTiers: [], monitorUrl: '窗口-1' });
      service['runtimeIncidents'].record({
        code: 'table-feed-stale',
        severity: 'blocked',
        tableId: 'table-1',
        message: 'table-feed-stale',
      });
      const cleared = await service.clearMonitorData();
      expect(cleared.events).toHaveLength(0);
      expect(cleared.decisions).toHaveLength(0);
      expect(cleared.receipts).toHaveLength(0);
      expect(cleared.reservations).toHaveLength(0);
      expect(cleared.snapshot.tables['table-1']?.profile.minEV).toBe(0.05);
      expect(cleared.snapshot.tables['table-1']?.profile.monitorUrl).toBe('窗口-1');
      expect(cleared.runtime.incidents.some(incident =>
        incident.active && incident.code === 'table-feed-stale')).toBe(false);
    } finally {
      await service.close();
    }
  });

  it('preserves and refreshes discovered table display names after records are cleared', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-table-metadata-'));
    const dbPath = join(directory, 'console.sqlite');
    const service = new DesktopConsoleService(dbPath);
    let closed = false;
    try {
      const bridge = new BrowserBridgeServer();
      service['browserBridge'] = bridge;
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'tobcbaccaragen92', displayName: 'Speed Baccarat 92' }],
        },
      });

      await service['attachLiveTables']();
      const beforeClear = service.snapshot();
      expect(beforeClear.tableMetadata).toEqual(expect.arrayContaining([
        expect.objectContaining({ tableId: 'tobcbaccaragen92', displayName: 'Speed Baccarat 92' }),
      ]));

      const cleared = await service.clearMonitorData();
      expect(cleared.tableMetadata).toEqual(expect.arrayContaining([
        expect.objectContaining({ tableId: 'tobcbaccaragen92', displayName: 'Speed Baccarat 92' }),
      ]));

      bridge.ingestClientMessage({
        kind: 'roomUpdated',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{ tableId: 'tobcbaccaragen92', displayName: 'Speed Baccarat 92 VIP' }],
        },
      });
      await service['attachLiveTables']();
      expect(service.snapshot().tableMetadata).toEqual(expect.arrayContaining([
        expect.objectContaining({ tableId: 'tobcbaccaragen92', displayName: 'Speed Baccarat 92 VIP' }),
      ]));

      await service.close();
      closed = true;
      const restarted = new DesktopConsoleService(dbPath);
      try {
        expect(restarted.snapshot().tableMetadata).toEqual(expect.arrayContaining([
          expect.objectContaining({ tableId: 'tobcbaccaragen92', displayName: 'Speed Baccarat 92 VIP' }),
        ]));
      } finally {
        await restarted.close();
      }
    } finally {
      if (!closed) await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not persist live roundId or gameCount into table metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-table-metadata-hot-'));
    const dbPath = join(directory, 'console.sqlite');
    const service = new DesktopConsoleService(dbPath);
    let closed = false;
    try {
      const bridge = new BrowserBridgeServer();
      service['browserBridge'] = bridge;
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{
            tableId: 'tobcbaccaragen92',
            displayName: '粤语极速百家乐',
            roundId: '17260818724',
            gameCount: 72,
          }],
        },
      });
      await service['attachLiveTables']();
      const setConfig = vi.spyOn(service['ledger'], 'setConfig');
      const metadataWrites = (): number => setConfig.mock.calls
        .filter(([key]) => key === 'desktop:table-metadata:v1').length;

      bridge.ingestClientMessage({
        kind: 'roomUpdated',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [{
            tableId: 'tobcbaccaragen92',
            displayName: '粤语极速百家乐',
            roundId: '17260821524',
            gameCount: 73,
          }],
        },
      });
      await service['attachLiveTables']();
      expect(metadataWrites()).toBe(0);
      expect(service.snapshot().tableMetadata).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tableId: 'tobcbaccaragen92',
          roundId: '17260821524',
          gameCount: 73,
        }),
      ]));

      await service.close();
      closed = true;
      const restarted = new DesktopConsoleService(dbPath);
      try {
        expect(restarted.snapshot().tableMetadata).toEqual(expect.arrayContaining([
          expect.objectContaining({
            tableId: 'tobcbaccaragen92',
            displayName: '粤语极速百家乐',
          }),
        ]));
        expect(restarted.snapshot().tableMetadata.find(table => table.tableId === 'tobcbaccaragen92'))
          .not.toEqual(expect.objectContaining({ roundId: '17260821524' }));
      } finally {
        await restarted.close();
      }
    } finally {
      if (!closed) await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs continuously until stopped', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      const speed = service.setDemoSpeed(10);
      expect(speed.demoSpeed).toBe(10);
      const started = await service.startDemo(9);
      expect(started.demoRunning).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 40));
      const stopped = await service.stopDemo();
      expect(stopped.demoRunning).toBe(false);
      expect(stopped.events.length).toBeGreaterThan(0);
    } finally {
      await service.close();
    }
  });

  it('does not seed monitor tables when no bridge environment override is set', async () => {
    const previousSelection = process.env.BACCARAT_LIVE_TABLES;
    delete process.env.BACCARAT_LIVE_TABLES;
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.startBrowserBridge(0);
      const bridge = service['browserBridge'];
      if (!bridge) throw new Error('bridge did not start');
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'r1',
          tables: [{ tableId: 'D066' }, { tableId: 'P001' }],
        },
      });

      const rooms = await bridge.discoverRooms();
      expect(rooms.find(room => room.roomId === 'r1')?.tables.map(table => table.tableId) ?? []).toEqual([]);
      expect(service.snapshot().monitorTableIds).toEqual([]);
    } finally {
      await service.close();
      if (previousSelection === undefined) delete process.env.BACCARAT_LIVE_TABLES;
      else process.env.BACCARAT_LIVE_TABLES = previousSelection;
    }
  });
  it('starts and stops the browser bridge', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      const started = await service.startBrowserBridge(0);
      expect(started.port).toBeGreaterThan(0);
      expect(service.browserBridgeStatus().running).toBe(true);
      expect(service.browserBridgeStatus().port).toBe(started.port);
      await service.stopBrowserBridge();
      expect(service.browserBridgeStatus().running).toBe(false);
      expect(service.browserBridgeStatus().rooms).toEqual([]);
    } finally {
      await service.close();
    }
  });

  it('keeps a failed-bridge dashboard scoped to configured monitor tables despite historical actors', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    const address = blocker.address();
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve, reject) => blocker.close(error => (error ? reject(error) : resolve())));
      throw new Error('failed to reserve a TCP port for the bridge failure test');
    }

    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.registerTable(defaultProfile('P001'), 'shadow', 100);

      await expect(service.startLiveRoomMonitor(address.port)).rejects.toThrow();

      const current = service.snapshot();
      expect(current.monitorTableIds).toEqual(['D055']);
      expect(current.snapshot.tables.D055).toBeDefined();
      expect(current.snapshot.tables.P001).toBeUndefined();
      expect(current.summary.rows.some(row => row.tableId === 'P001')).toBe(false);
    } finally {
      await service.close();
      await new Promise<void>((resolve, reject) => blocker.close(error => (error ? reject(error) : resolve())));
    }
  });

  it('caps persisted monitor tables to sixty-four live feeds', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-monitor-cap-'));
    const dbPath = join(directory, 'console.sqlite');
    const first = new DesktopConsoleService(dbPath);
    let closed = false;
    try {
      const tableIds = Array.from({ length: 70 }, (_, index) => `P${String(index).padStart(3, '0')}`);
      await first.updateMonitorTableIds(tableIds);
      expect(first.snapshot().monitorTableIds).toHaveLength(64);
      await first.close();
      closed = true;
      const restarted = new DesktopConsoleService(dbPath);
      try {
        expect(restarted.snapshot().monitorTableIds).toEqual(tableIds.slice(0, 64));
      } finally {
        await restarted.close();
      }
    } finally {
      if (!closed) await first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a newly discovered table pending until a physical new shoe', async () => {
    const service = new DesktopConsoleService(':memory:');
    const feed = {
      tableId: 'P001',
      start: async () => undefined,
      stop: async () => undefined,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'P001',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'room-with-unselected-table',
      tables: [{ tableId: 'P001', profile: defaultProfile('P001') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    try {
      await service.updateMonitorTableIds(['D055']);

      await expect(service.startLiveRoomMonitor(0)).resolves.toEqual(expect.objectContaining({ port: expect.any(Number) }));

      const current = service.snapshot();
      expect(current.monitorTableIds).toEqual(['D055']);
      expect(current.snapshot.tables.P001).toBeUndefined();
      expect(current.snapshot.tables.D055).toBeDefined();
      expect(current.monitorCandidates.map(candidate => candidate.tableId)).not.toContain('P001');
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
    }
  });

  it('does not auto-monitor a whole lobby of newly discovered tables', async () => {
    const service = new DesktopConsoleService(':memory:');
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'lobby',
      tables: Array.from({ length: 20 }, (_, index) => {
        const tableId = `P${String(index).padStart(3, '0')}`;
        return { tableId, profile: defaultProfile(tableId) };
      }),
    }]);
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      expect(service.snapshot().monitorTableIds).toEqual(['D055']);
    } finally {
      discoverRooms.mockRestore();
      await service.close();
    }
  });

  it('auto-monitors visible page tables without ingesting the whole lobby', async () => {
    const service = new DesktopConsoleService(':memory:');
    const feed = {
      tableId: 'P001',
      start: async () => undefined,
      stop: async () => undefined,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'P001',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'lobby',
      tables: Array.from({ length: 20 }, (_, index) => {
        const tableId = `P${String(index).padStart(3, '0')}`;
        return { tableId, profile: defaultProfile(tableId) };
      }),
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      expect(service.snapshot().monitorTableIds).toEqual(['D055']);

      service['browserBridge']?.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-pragmatic-state',
        url: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          view: 'multi',
          observedAt: '2026-08-31T14:00:00.000Z',
          tables: [
            { tableId: 'P001', visible: true },
            { tableId: 'P002', visible: false },
            { tableId: 'P003', visible: false },
          ],
        }),
      });
      await service['attachLiveTables']();

      expect(service.snapshot().monitorTableIds).toEqual(['D055']);
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
    }
  });

  it('does not start duplicate feeds when concurrent public monitor starts race on one table', async () => {
    const service = new DesktopConsoleService(':memory:');
    let releaseFeedStart: () => void = () => {
      throw new Error('feed start barrier was not initialized');
    };
    const feedStartBarrier = new Promise<void>(resolve => {
      releaseFeedStart = resolve;
    });
    let resolveFirstStart: () => void = () => {
      throw new Error('first feed start was not initialized');
    };
    const firstStart = new Promise<void>(resolve => {
      resolveFirstStart = resolve;
    });
    let startCalls = 0;
    const feed = {
      tableId: 'D055',
      start: async () => {
        startCalls += 1;
        if (startCalls === 1) resolveFirstStart();
        await feedStartBarrier;
      },
      stop: async () => undefined,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D055',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'concurrent-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startBrowserBridge(0);

      const concurrentStarts = Promise.all([
        service.startLiveRoomMonitor(0),
        service.startLiveRoomMonitor(0),
      ]);
      await firstStart;
      await new Promise<void>(resolve => setImmediate(resolve));
      releaseFeedStart();
      await concurrentStarts;

      expect(openTable).toHaveBeenCalledTimes(1);
      expect(startCalls).toBe(1);
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
    }
  });

  it('keeps a disconnected bridge export registered until its own recovery callback', async () => {
    const service = new DesktopConsoleService(':memory:');
    let sink: TableExportSink | undefined;
    const start = vi.fn(async (nextSink: TableExportSink) => {
      sink = nextSink;
    });
    const feed = {
      tableId: 'D055',
      start,
      stop: async () => undefined,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D055',
        state: 'DISCONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 1,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'disconnect-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      if (!sink?.onDisconnect || !sink.onRestored) throw new Error('table export sink was not registered');
      await service.injectEvent(monitorShoeEvent('D055', 'disconnect-race-shoe', 'physical-shoe'));

      const actor = service['orchestrator'].getActor('D055');
      if (!actor) throw new Error('table actor was not registered');
      await actor.setAutoBet(true);

      sink.onDisconnect('D055', 'synthetic disconnect');
      await service['executionStateOperation'];
      await service.startLiveRoomMonitor(0);
      expect(start).toHaveBeenCalledTimes(1);
      expect(openTable).toHaveBeenCalledTimes(1);
      expect(service['ledger'].listEvents('D055')).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'autoDisarmChanged' }),
        expect.objectContaining({ type: 'connectionLost' }),
      ]));
      expect(service.snapshot().runtime.incidents).not.toContainEqual(expect.objectContaining({
        code: 'monitor-failure',
        active: true,
      }));

      await sink.onRestored('D055', `cursor-v1:${'d'.repeat(64)}`);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(service.snapshot().snapshot.tables.D055?.projection.connectionStatus).toBe('CONNECTED');
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
    }
  });

  it('removes a monitored table after it remains disconnected for fifteen seconds', async () => {
    vi.useFakeTimers();
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const stop = vi.fn(async () => undefined);
    const feed = {
      tableId: 'D055',
      start: async () => undefined,
      stop,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: false, error: 'disconnected' }),
      health: () => ({
        tableId: 'D055',
        state: 'DISCONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 1,
        stalenessMs: 15_000,
      }),
    } satisfies TableExport;
    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D055']);
      service['liveFeeds'].set('D055', feed);

      service['scheduleDisconnectedMonitorRemoval']('D055', 'synthetic disconnect');
      await vi.advanceTimersByTimeAsync(14_999);
      expect(service.snapshot().monitorTableIds).toEqual(['D055']);
      expect(stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await service['liveMonitorOperation'];

      expect(service.snapshot().monitorTableIds).toEqual([]);
      expect(service['liveFeeds'].has('D055')).toBe(false);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it('keeps a monitored table when its live feed is only stale', async () => {
    vi.useFakeTimers();
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const stop = vi.fn(async () => undefined);
    const feed = {
      tableId: 'D055',
      start: async () => undefined,
      stop,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: false, error: 'table-feed-stale' }),
      health: () => ({
        tableId: 'D055',
        state: 'DISCONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 1,
        stalenessMs: 45_000,
      }),
    } satisfies TableExport;
    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D055']);
      service['liveFeeds'].set('D055', feed);

      service['scheduleDisconnectedMonitorRemoval']('D055', 'table-feed-stale');
      await vi.advanceTimersByTimeAsync(15_000);
      await service['liveMonitorOperation'];

      expect(service.snapshot().monitorTableIds).toEqual(['D055']);
      expect(service['liveFeeds'].has('D055')).toBe(true);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it('keeps a monitored table when the browser extension bridge flashes', async () => {
    vi.useFakeTimers();
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const stop = vi.fn(async () => undefined);
    const feed = {
      tableId: 'D055',
      start: async () => undefined,
      stop,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: false, error: 'browser-extension-disconnected' }),
      health: () => ({
        tableId: 'D055',
        state: 'DISCONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 1,
        stalenessMs: 8_000,
      }),
    } satisfies TableExport;
    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D055']);
      service['liveFeeds'].set('D055', feed);

      service['scheduleDisconnectedMonitorRemoval']('D055', 'browser-extension-disconnected');
      await vi.advanceTimersByTimeAsync(15_000);
      await service['liveMonitorOperation'];

      expect(service.snapshot().monitorTableIds).toEqual(['D055']);
      expect(service['liveFeeds'].has('D055')).toBe(true);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it('keeps monitoring after a table-feed-stale runtime event', async () => {
    vi.useFakeTimers();
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    const stop = vi.fn(async () => undefined);
    const feed = {
      tableId: 'speedbca14gesbc1',
      start: async () => undefined,
      stop,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: false, error: 'table-feed-stale' }),
      health: () => ({
        tableId: 'speedbca14gesbc1',
        state: 'DISCONNECTED' as const,
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 1,
        stalenessMs: 45_000,
      }),
    };
    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['speedbca14gesbc1']);
      service['liveFeeds'].set('speedbca14gesbc1', feed);
      service['handleBridgeRuntimeEvent']({
        kind: 'table-disconnected',
        tableId: 'speedbca14gesbc1',
        reason: 'table-feed-stale',
        timestamp: new Date().toISOString(),
      });
      await service['executionStateOperation'];
      await vi.advanceTimersByTimeAsync(15_000);
      await service['liveMonitorOperation'];

      expect(service.snapshot().monitorTableIds).toEqual(['speedbca14gesbc1']);
      expect(service['liveFeeds'].has('speedbca14gesbc1')).toBe(true);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it('keeps configured monitor tables while live discovery is still empty', async () => {
    vi.useFakeTimers();
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      await service.updateMonitorTableIds(['D055']);
      service['liveMonitorActivated'] = true;

      await service['attachLiveTables']();
      await vi.advanceTimersByTimeAsync(15_000);
      await service['liveMonitorOperation'];

      expect(service.snapshot().monitorTableIds).toEqual(['D055']);
      expect(service['disconnectedMonitorRemovalTimers'].size).toBe(0);
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it('keeps an emptied monitor list empty after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-monitor-restore-'));
    const dbPath = join(directory, 'console.sqlite');
    const first = new DesktopConsoleService(dbPath);
    let closed = false;
    try {
      const bridge = new BrowserBridgeServer();
      first['browserBridge'] = bridge;
      first['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-pragmatic',
          displayName: 'Dafabet Pragmatic Play',
          tables: [
            { tableId: 'tobcbaccaragen92', displayName: '粤语极速百家乐' },
            { tableId: 'speedbca14gesbc1', displayName: 'PATTAYA 泰语极速百家乐' },
          ],
        },
      });
      await first['attachLiveTables']();
      await first.updateMonitorTableIds([]);
      expect(first.snapshot().monitorTableIds).toEqual([]);
      expect(first.snapshot().tableMetadata.map(table => table.tableId)).toEqual([
        'tobcbaccaragen92',
        'speedbca14gesbc1',
      ]);

      await first.close();
      closed = true;

      const restarted = new DesktopConsoleService(dbPath);
      try {
        expect(restarted.snapshot().monitorTableIds).toEqual([]);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!closed) await first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps monitor configuration and persisted order unchanged when an attach fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-monitor-rollback-'));
    const dbPath = join(directory, 'console.sqlite');
    const service = new DesktopConsoleService(dbPath);
    let serviceClosed = false;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockImplementation(() => {
      throw new Error('synthetic attach failure');
    });
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      discoverRooms.mockResolvedValue([{
        roomId: 'attach-failure-room',
        tables: [{ tableId: 'D065', profile: defaultProfile('D065') }],
      }]);

      await expect(service.updateMonitorTableIds(['D065'])).rejects.toThrow('synthetic attach failure');

      const failed = service.snapshot();
      expect(failed.monitorTableIds).toEqual(['D055']);
      expect(failed.snapshot.tables.D055).toBeDefined();
      expect(failed.snapshot.tables.D065).toBeUndefined();

      await service.close();
      serviceClosed = true;

      const restarted = new DesktopConsoleService(dbPath);
      try {
        expect(restarted.snapshot().monitorTableIds).toEqual(['D055']);
      } finally {
        await restarted.close();
      }
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      if (!serviceClosed) await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });


  it('keeps monitor configuration unchanged when stopping a removed feed fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-monitor-stop-rollback-'));
    const dbPath = join(directory, 'console.sqlite');
    const service = new DesktopConsoleService(dbPath);
    let serviceClosed = false;
    const feed = {
      tableId: 'D055',
      start: async () => undefined,
      stop: async () => {
        throw new Error('synthetic stop failure');
      },
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D055',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'stop-failure-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    const setSelectedTableIds = vi.spyOn(BrowserBridgeServer.prototype, 'setSelectedTableIds');
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      discoverRooms.mockResolvedValue([]);

      const updated = await service.updateMonitorTableIds(['D065']);

      expect(updated.demoError).toBe('synthetic stop failure');
      expect(updated.monitorTableIds).toEqual(['D055']);
      expect(updated.snapshot.tables.D055).toBeDefined();
      expect(updated.snapshot.tables.D065).toBeUndefined();
      expect(setSelectedTableIds).not.toHaveBeenCalledWith(['D065']);

      await service.close();
      serviceClosed = true;

      const restarted = new DesktopConsoleService(dbPath);
      try {
        expect(restarted.snapshot().monitorTableIds).toEqual(['D055']);
      } finally {
        await restarted.close();
      }
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      setSelectedTableIds.mockRestore();
      if (!serviceClosed) await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retries a retained outgoing feed after a failed monitor-table transition', async () => {
    const service = new DesktopConsoleService(':memory:');
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic stop failure'))
      .mockResolvedValueOnce(undefined);
    const feed = {
      tableId: 'D055',
      start: async () => undefined,
      stop,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D055',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'retry-stop-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      discoverRooms.mockResolvedValue([]);

      const failed = await service.updateMonitorTableIds(['D065']);
      expect(failed.monitorTableIds).toEqual(['D055']);
      expect(stop).toHaveBeenCalledTimes(1);

      const switched = await service.updateMonitorTableIds(['D065']);
      expect(stop).toHaveBeenCalledTimes(2);
      expect(switched.monitorTableIds).toEqual(['D065']);
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
    }
  });

  it('does not mix non-monitor historical receipts into cumulative income points', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.setAutomationEnabled(true);
      const historical = await service.runDemo(42);
      expect(historical.receipts.some(receipt => receipt.tableId !== 'D055')).toBe(true);

      await service.startLiveRoomMonitor(0);
      const filtered = await service.updateMonitorTableIds(['D055']);

      expect(filtered.summary.rows).toEqual([]);
      expect(filtered.summary.incomePoints).toEqual([]);
    } finally {
      await service.close();
    }
  });

  it('attaches D065 and exposes its platform round ID from a live table feed', async () => {
    const service = new DesktopConsoleService(':memory:');
    const platformRoundId = 'GD065268230WF';
    const feed = {
      tableId: 'D065',
      start: async (sink: TableExportSink) => {
        await sink.onBatch({
          tableId: 'D065',
          events: [
            monitorShoeEvent('D065', 'd065-shoe'),
            openedPlatformRound('D065', 'd065-round', platformRoundId),
          ],
          cursor: {
            tableId: 'D065',
            sourceSeq: 2,
            eventId: 'd065-round',
            payloadHash: 'd065-live-round',
          },
          kind: 'live',
        });
      },
      stop: async () => undefined,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D065',
        state: 'CONNECTED',
        lastAckedSeq: 2,
        lastEmittedSeq: 2,
        bufferDepth: 0,
        reconnectCount: 0,
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'd065-live-room',
      tables: [{ tableId: 'D065', profile: defaultProfile('D065') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    try {
      await service.updateMonitorTableIds(['D065']);
      await service.startLiveRoomMonitor(0);

      expect(openTable).toHaveBeenCalledWith('d065-live-room', 'D065');
      expect(service.snapshot().snapshot.tables.D065?.projection.currentHandId).toBe(platformRoundId);
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
    }
  });

  it('keeps retrying D065 discovery when the first live discovery attempt fails', async () => {
    vi.useFakeTimers();
    const service = new DesktopConsoleService(':memory:');
    const feed = {
      tableId: 'D065',
      start: async () => undefined,
      stop: async () => undefined,
      flush: async () => undefined,
      keepAlive: async () => ({ ok: true }),
      health: () => ({
        tableId: 'D065',
        state: 'CONNECTED',
        lastAckedSeq: 0,
        lastEmittedSeq: 0,
        bufferDepth: 0,
        reconnectCount: 0,
      }),
    } satisfies TableExport;
    const discoveryError = new Error('initial discovery unavailable');
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms')
      .mockRejectedValueOnce(discoveryError)
      .mockResolvedValue([{ roomId: 'd065-retry-room', tables: [{ tableId: 'D065', profile: defaultProfile('D065') }] }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    try {
      await service.updateMonitorTableIds(['D065']);
      await expect(service.startLiveRoomMonitor(0)).resolves.toEqual(expect.objectContaining({ port: expect.any(Number) }));
      expect(service.snapshot().demoError).toBe('initial discovery unavailable');

      await vi.advanceTimersByTimeAsync(2_000);

      expect(discoverRooms).toHaveBeenCalledTimes(2);
      expect(openTable).toHaveBeenCalledWith('d065-retry-room', 'D065');
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
      vi.useRealTimers();
    }
  });

  it('keeps ledger bets after a table leaves the live monitor list', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      expect(service['ledger'].saveReservation({
        reservationId: 'rv-keep-ledger',
        intentId: 'i-keep-ledger',
        tableId: 'P001',
        shoeId: 's1',
        handId: 'h1',
        market: 'player',
        amount: 10,
        maxLoss: 10,
        maxProfit: 10,
        status: 'SETTLED',
        createdAt: '2026-09-01T18:00:00.000Z',
      })).toBe(true);
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      const page = service.queryRecords({ kind: 'ledger', page: 1, pageSize: 20 });
      expect(page.ledger?.map(row => row.reservation.tableId)).toContain('P001');
    } finally {
      await service.close();
    }
  });

  it('filters record pagination to the configured monitor tables', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      await service.registerTable(defaultProfile('P001'), 'shadow', 100);
      await service.injectEvent(monitorShoeEvent('D055', 'd055-record'));
      await service.injectEvent(monitorShoeEvent('P001', 'p001-record'));

      const page = service.queryRecords({ kind: 'events', page: 1, pageSize: 20 });

      expect(page.total).toBe(1);
      expect(page.events?.map(event => event.tableId)).toEqual(['D055']);
    } finally {
      await service.close();
    }
  });

  it('includes non-monitor demo record pages only while a live-monitor demo is running', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      // Given: live monitoring and a demo table with persisted data.
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      await service.registerTable(defaultProfile('P001'), 'simulated', 100);
      await service.injectEvent(monitorShoeEvent('P001', 'p001-demo-record'));

      // When: the continuous demo is active.
      service['demoRunning'] = true;
      const running = service.queryRecords({ kind: 'events', page: 1, pageSize: 20 });

      // Then: demo-running snapshots include the demo table without depending on execution mode.
      expect(running.total).toBe(1);
      expect(running.events?.map(event => event.tableId)).toEqual(['P001']);

      // When / Then: stopping the demo restores the real-monitor-only scope.
      service['demoRunning'] = false;
      const stopped = service.queryRecords({ kind: 'events', page: 1, pageSize: 20 });
      expect(stopped.total).toBe(0);
    } finally {
      await service.close();
    }
  });

});
