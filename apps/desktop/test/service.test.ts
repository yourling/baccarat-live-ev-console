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

function installFakeBridge(service: DesktopConsoleService, receipt: BetReceipt) {
  const bridge = new BrowserBridgeServer();
  const liveGateCalls: boolean[] = [];
  const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(enabled => {
    liveGateCalls.push(enabled);
  });
  const requestBet = vi.spyOn(bridge, 'requestBet').mockResolvedValue(receipt);
  service['browserBridge'] = bridge;
  return { bridge, liveGateCalls, setLiveBetEnabled, requestBet };
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
    source: 'mstrom-protocol',
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
    source: 'mstrom-protocol',
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
  it('exposes the current ordered Dafabet multiview fallback tables', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      expect(service.snapshot().monitorTableIds).toEqual(['D066', 'D067', 'D056', 'D057']);
    } finally {
      await service.close();
    }
  });

  it('uses the Dafabet multiview fallback for a fresh monitor session', async () => {
    const previous = process.env.BACCARAT_LIVE_TABLES;
    delete process.env.BACCARAT_LIVE_TABLES;
    const service = new DesktopConsoleService(':memory:');
    try {
      expect(service.snapshot().monitorTableIds).toEqual(['D066', 'D067', 'D056', 'D057']);
    } finally {
      await service.close();
      if (previous === undefined) {
        delete process.env.BACCARAT_LIVE_TABLES;
      } else {
        process.env.BACCARAT_LIVE_TABLES = previous;
      }
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

      expect(actor.snapshot().executionMode).toBe('shadow');
      expect(actor.getProjection().autoBetStatus).toBe('DISARMED');

      await service.updateMonitorTableIds(['D055']);

      expect(actor.snapshot().executionMode).toBe('shadow');
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

      expect(actor.snapshot().executionMode).toBe('shadow');
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
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'fail-closed-stale-feed-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      const actor = service['orchestrator'].getActor('D055');
      if (!actor) throw new Error('fail-closed test actor was not registered');

      await service.setExecutionMode('D055', 'live');
      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-fail-closed-shoe', 'physical-shoe'),
        sourceSeq: 2,
      });
      await service.setAutoBet('D055', true, 'monitor-session-D055');

      expect(actor.snapshot().executionMode).toBe('live');
      expect(actor.getProjection().autoBetStatus).toBe('ARMED');

      const updated = await service.updateMonitorTableIds(['D065']);

      expect(updated.demoError).toBe('synthetic stop failure after stale callback');
      expect(updated.monitorTableIds).toEqual(['D055']);
      expect(actor.snapshot().executionMode).toBe('shadow');
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
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'fail-closed-hanging-feed-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      const actor = service['orchestrator'].getActor('D055');
      if (!actor) throw new Error('hanging-feed test actor was not registered');

      await service.setExecutionMode('D055', 'live');
      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-hanging-feed-shoe', 'physical-shoe'),
        sourceSeq: 2,
      });
      await service.setAutoBet('D055', true, 'monitor-session-D055');

      const transition = service.updateMonitorTableIds([]);
      await stopStarted;

      expect(actor.snapshot().executionMode).toBe('shadow');
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
      }),
    } satisfies TableExport;
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'fail-closed-stop-monitor-room',
      tables: [{ tableId: 'D055', profile: defaultProfile('D055') }],
    }]);
    const openTable = vi.spyOn(BrowserBridgeServer.prototype, 'openTable').mockReturnValue(feed);
    const setLiveBetEnabled = vi.spyOn(bridge, 'setLiveBetEnabled').mockImplementation(() => undefined);
    service['browserBridge'] = bridge;

    try {
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      const actor = service['orchestrator'].getActor('D055');
      if (!actor) throw new Error('stop monitor test actor was not registered');

      await service.setExecutionMode('D055', 'live');
      await service.injectEvent({
        ...monitorShoeEvent('D055', 'd055-stop-monitor-shoe', 'physical-shoe'),
        sourceSeq: 2,
      });
      await service.setAutoBet('D055', true, 'monitor-session-D055');

      const stopping = service.stopLiveRoomMonitor();
      await stopStarted;

      expect(actor.snapshot().executionMode).toBe('shadow');
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

      expect(actor.snapshot().executionMode).toBe('shadow');
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
    try {
      service['browserBridge'] = bridge;
      service['orchestrator'].registerTable(defaultProfile('D055'), 'shadow', 100);

      // When: the operator switches this table to live and then back to shadow.
      const live = await service.setExecutionMode('D055', 'live');
      const shadow = await service.setExecutionMode('D055', 'shadow');

      // Then: the extension gate and actor mode move together, while auto bet remains stopped.
      expect(setLiveBetEnabled.mock.calls).toEqual([[true], [false]]);
      expect(live.snapshot.tables.D055?.executionMode).toBe('live');
      expect(live.snapshot.tables.D055?.projection.autoBetStatus).toBe('DISARMED');
      expect(shadow.snapshot.tables.D055?.executionMode).toBe('shadow');
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
      expect(service.snapshot().snapshot.tables.D055?.executionMode).toBe('shadow');
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
      expect(result.snapshot.snapshot.tables.D055?.executionMode).toBe('shadow');
      expect(setExecutor.mock.calls).toHaveLength(2);
      expect(setExecutor.mock.calls[1]?.[0]).toBe(originalExecutor);
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
      reason: 'physical-shoe-required',
    }));
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      await expect(service.executeOneShotLiveBet(command))
        .rejects.toThrow('one-shot live bet rejected locally: physical-shoe-required');
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

  it('rejects one-shot live bets while any registered table has persistent live mode', async () => {
    const service = new DesktopConsoleService(':memory:');
    const command = oneShotCommand();
    await selectMonitorTable(service, command.tableId);
    const receipt = oneShotReceipt(command);
    installOneShotActor(service, command, receipt);
    service['orchestrator'].registerTable(defaultProfile('D056'), 'live', 20);
    const { liveGateCalls, requestBet } = installFakeBridge(service, receipt);

    try {
      await expect(service.executeOneShotLiveBet(command)).rejects.toThrow(/persistent live/i);
      expect(liveGateCalls).toEqual([]);
      expect(requestBet).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it('rejects one-shot live bets while any registered table remains auto-bet armed', async () => {
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
      await expect(service.executeOneShotLiveBet(command)).rejects.toThrow(/armed/i);
      expect(liveGateCalls).toEqual([]);
      expect(requestBet).not.toHaveBeenCalled();
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
    const { liveGateCalls } = installFakeBridge(service, receipt);
    const actor = service['orchestrator'].getActor(command.tableId);
    if (!actor) throw new Error('one-shot test actor was not registered');
    const setAutoBetCall = vi.spyOn(actor, 'setAutoBet');
    const updateExecutionMode = vi.spyOn(service['orchestrator'], 'updateTableExecutionMode');

    try {
      const oneShot = service.executeOneShotLiveBet(command);
      await started;

      const autoBet = service.setAutoBet(command.tableId, true, command.shoeId);
      const mode = service.setExecutionMode(command.tableId, 'live');

      expect(setAutoBetCall).not.toHaveBeenCalled();
      expect(updateExecutionMode).not.toHaveBeenCalled();
      expect(liveGateCalls).toEqual([true]);

      release();
      await oneShot;
      await autoBet;
      await mode;

      expect(liveGateCalls).toEqual([true, false, true]);
      expect(service.snapshot().snapshot.tables.D055?.executionMode).toBe('live');
    } finally {
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
  it('retains approved live actors while the page transiently reports no visible table', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer({ selectedTableIds: ['D055'] });
    try {
      service['browserBridge'] = bridge;
      service['orchestrator'].registerTable(defaultProfile('D055'), 'shadow', 100);
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-runtime-selection',
        url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
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
      const cleared = await service.clearMonitorData();
      expect(cleared.events).toHaveLength(0);
      expect(cleared.decisions).toHaveLength(0);
      expect(cleared.receipts).toHaveLength(0);
      expect(cleared.reservations).toHaveLength(0);
      expect(cleared.snapshot.tables['table-1']?.profile.minEV).toBe(0.05);
      expect(cleared.snapshot.tables['table-1']?.profile.monitorUrl).toBe('窗口-1');
    } finally {
      await service.close();
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

  it('uses the approved four-table whitelist when no bridge environment override is set', async () => {
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
      expect(rooms.find(room => room.roomId === 'r1')?.tables.map(table => table.tableId)).toEqual(['D066']);
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

  it('does not attach a discovered table outside the configured monitorTableIds', async () => {
    const service = new DesktopConsoleService(':memory:');
    const discoverRooms = vi.spyOn(BrowserBridgeServer.prototype, 'discoverRooms').mockResolvedValue([{
      roomId: 'room-with-unselected-table',
      tables: [{ tableId: 'P001', profile: defaultProfile('P001') }],
    }]);
    try {
      await service.updateMonitorTableIds(['D055']);

      await expect(service.startLiveRoomMonitor(0)).resolves.toEqual(expect.objectContaining({ port: expect.any(Number) }));

      const current = service.snapshot();
      expect(current.snapshot.tables.P001).toBeUndefined();
      expect(current.snapshot.tables.D055).toBeDefined();
    } finally {
      discoverRooms.mockRestore();
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

      sink.onDisconnect('D055', 'synthetic disconnect');
      await new Promise<void>(resolve => setImmediate(resolve));
      await service.startLiveRoomMonitor(0);
      expect(start).toHaveBeenCalledTimes(1);
      expect(openTable).toHaveBeenCalledTimes(1);

      sink.onRestored('D055', 'synthetic continuity proof');
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(service.snapshot().snapshot.tables.D055?.projection.connectionStatus).toBe('CONNECTED');
    } finally {
      discoverRooms.mockRestore();
      openTable.mockRestore();
      await service.close();
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

  it('includes simulated record pages only while a live-monitor demo is running', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      // Given: live monitoring and a simulated demo table with persisted data.
      await service.updateMonitorTableIds(['D055']);
      await service.startLiveRoomMonitor(0);
      await service.registerTable(defaultProfile('P001'), 'simulated', 100);
      await service.injectEvent(monitorShoeEvent('P001', 'p001-demo-record'));

      // When: the continuous demo is active.
      service['demoRunning'] = true;
      const running = service.queryRecords({ kind: 'events', page: 1, pageSize: 20 });

      // Then: its simulated records appear in the paginated live-console view.
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
