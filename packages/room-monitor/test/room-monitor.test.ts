import { describe, expect, it } from 'vitest';
import { FixtureBuilder } from '@baccarat/simulator-fixtures';
import { SqliteLedger } from '@baccarat/ledger-state';
import { Orchestrator } from '@baccarat/orchestrator';
import { SimulatedAdapter } from '@baccarat/adapter-contract';
import {
  defaultProfile,
  defaultRiskLimits,
  type NormalizedEvent,
  type RiskLimits,
  type TableProfile,
} from '@baccarat/contracts';
import {
  MonitorGapError,
  ShadowRoomMonitor,
  type TableEventBatch,
} from '../src/index.js';

function tableProfile(tableId: string): TableProfile {
  return {
    ...defaultProfile(tableId),
    autoConfirmNewShoe: true,
    autoBetArmedByDefault: true,
    minEV: 0,
    limits: { minBet: 1, maxBet: 1000 },
  };
}

describe('room monitor', () => {
  it('discovers rooms and table descriptors', async () => {
    const profile = tableProfile('t1');
    const events = new FixtureBuilder('t1').newShoe('s1', profile).build();
    const monitor = new ShadowRoomMonitor({
      rooms: [{
        roomId: 'r1',
        displayName: 'Room 1',
        tables: [{ tableId: 't1', profile, events, monitorUrl: 'win-1' }],
      }],
    });

    const rooms = await monitor.discoverRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ roomId: 'r1', displayName: 'Room 1' });
    expect(rooms[0].tables[0]).toMatchObject({ tableId: 't1', monitorUrl: 'win-1' });
    expect(rooms[0].tables[0].profile.tableId).toBe('t1');
  });

  it('exports events in order and advances the cursor after sink acknowledgement', async () => {
    const profile = tableProfile('t1');
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    const monitor = new ShadowRoomMonitor({
      rooms: [{ roomId: 'r1', tables: [{ tableId: 't1', profile, events }] }],
    });
    const feed = monitor.openTable('r1', 't1');
    const batches: TableEventBatch[] = [];

    await feed.start({ onBatch: batch => { batches.push(batch); } });
    await feed.flush();

    expect(batches.flatMap(batch => batch.events).map(event => event.eventId))
      .toEqual(events.map(event => event.eventId));
    expect(feed.health().lastAckedSeq).toBe(events[events.length - 1].sourceSeq);
    expect(feed.health().bufferDepth).toBe(0);
  });

  it('resumes from a cursor without replaying acknowledged events', async () => {
    const profile = tableProfile('t1');
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .card('s1', 'h1', { rank: 'A' })
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    const monitor = new ShadowRoomMonitor({
      rooms: [{ roomId: 'r1', tables: [{ tableId: 't1', profile, events }] }],
    });
    const feed = monitor.openTable('r1', 't1');
    const seen: string[] = [];
    const cursor = {
      tableId: 't1',
      sourceSeq: events[0].sourceSeq,
      eventId: events[0].eventId,
      payloadHash: 'acknowledged',
    };

    await feed.start({ onBatch: batch => { seen.push(...batch.events.map(event => event.eventId)); } }, cursor);
    await feed.flush();

    expect(seen).not.toContain(events[0].eventId);
    expect(seen).toHaveLength(events.length - 1);
  });

  it('detects sourceSeq gaps and disconnects instead of exporting incomplete data', async () => {
    const profile = tableProfile('t1');
    const events = new FixtureBuilder('t1').newShoe('s1', profile).build();
    const broken: NormalizedEvent[] = [
      events[0],
      {
        ...events[0],
        eventId: 'gap-event',
        sourceSeq: 3,
        type: 'shoeConfirmation',
        shoeId: 's1',
        approved: true,
      },
    ];
    const monitor = new ShadowRoomMonitor({
      rooms: [{ roomId: 'r1', tables: [{ tableId: 't1', profile, events: broken }] }],
    });
    const feed = monitor.openTable('r1', 't1');
    let disconnectReason: string | undefined;

    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => { disconnectReason = reason; },
    });
    await expect(feed.flush()).rejects.toThrow(MonitorGapError);
    expect(disconnectReason).toContain('sourceSeq gap');
    expect(feed.health().state).toBe('DISCONNECTED');
  });

  it('does not advance the cursor until the consumer acknowledges the batch', async () => {
    const profile = tableProfile('t1');
    const events = new FixtureBuilder('t1').newShoe('s1', profile).build();
    const monitor = new ShadowRoomMonitor({
      rooms: [{ roomId: 'r1', tables: [{ tableId: 't1', profile, events }] }],
    });
    const feed = monitor.openTable('r1', 't1');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let received = false;

    await feed.start({
      onBatch: async () => {
        received = true;
        await gate;
      },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(received).toBe(true);
    expect(feed.health().lastAckedSeq).toBe(0);

    release();
    await feed.flush();
    expect(feed.health().lastAckedSeq).toBe(events[0].sourceSeq);
  });

  it('exports a room table end-to-end into orchestrator and ledger', async () => {
    const ledger = new SqliteLedger();
    const riskLimits: RiskLimits = {
      ...defaultRiskLimits,
      defaultExposureCap: 1000,
      perTableLossLimit: 10000,
      perShoeLossLimit: 10000,
      perDayLossLimit: 100000,
      maxConcurrentExecutions: 4,
      insufficientBehavior: 'skip',
    };
    const profile = tableProfile('t1');
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      executor: new SimulatedAdapter({ events: [] }),
    });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);
    const monitor = new ShadowRoomMonitor({
      rooms: [{ roomId: 'r1', tables: [{ tableId: 't1', profile, events }] }],
    });
    const feed = monitor.openTable('r1', 't1');

    await feed.start({
      onBatch: async batch => {
        for (const event of batch.events) {
          await orchestrator.enqueue(event.tableId, event);
        }
      },
    });
    await feed.flush();
    await actor.flush();

    expect(ledger.listEvents('t1')).toHaveLength(events.length);
    expect(ledger.listDecisions('t1')).toHaveLength(1);
    expect(actor.getProjection().status).toBe('BETTING_WINDOW');

    await monitor.close();
    ledger.close();
  });

  it('simulates disconnect and restore with a continuity proof', async () => {
    const profile = tableProfile('t1');
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    const monitor = new ShadowRoomMonitor({
      rooms: [{
        roomId: 'r1',
        tables: [{
          tableId: 't1',
          profile,
          events,
          maxBatchSize: 1,
          faults: {
            disconnectAfterEvent: 1,
            restoreAfterMs: 0,
            continuityProof: `cursor-v1:${'e'.repeat(64)}`,
          },
        }],
      }],
    });
    const feed = monitor.openTable('r1', 't1');
    const disconnects: string[] = [];
    const restores: { tableId: string; proof: string }[] = [];

    await feed.start({
      onBatch: () => {},
      onDisconnect: (tableId, reason) => { disconnects.push(`${tableId}:${reason ?? ''}`); },
      onRestored: (tableId, proof) => { restores.push({ tableId, proof }); },
    });
    await feed.flush();

    expect(disconnects).toEqual(['t1:simulated-disconnect']);
    expect(restores).toEqual([{ tableId: 't1', proof: `cursor-v1:${'e'.repeat(64)}` }]);
    expect(feed.health().state).toBe('CONNECTED');
    expect(feed.health().reconnectCount).toBe(1);
    expect(feed.health().lastAckedSeq).toBe(events[events.length - 1].sourceSeq);
  });
});
