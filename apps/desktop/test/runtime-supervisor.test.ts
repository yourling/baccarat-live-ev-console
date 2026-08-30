import { describe, expect, it } from 'vitest';
import {
  RuntimeIncidentStore,
  evaluateLiveExecutionReadiness,
} from '../electron-src/runtime-supervisor.js';

class MemoryConfigStore {
  private readonly values = new Map<string, unknown>();

  getConfig<T>(key: string): T | null {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  setConfig<T>(key: string, value: T): void {
    this.values.set(key, structuredClone(value));
  }
}

describe('unattended runtime supervisor', () => {
  it('persists deduplicated incidents with bounded history and redacted messages', () => {
    const storage = new MemoryConfigStore();
    let now = new Date('2026-08-27T01:00:00.000Z');
    const incidents = new RuntimeIncidentStore(storage, {
      maxIncidents: 2,
      now: () => now,
    });

    incidents.record({
      code: 'bridge-auth-failed',
      severity: 'blocked',
      message: 'Rejected https://localhost/bridge?token=super-secret token=super-secret',
    });
    now = new Date('2026-08-27T01:01:00.000Z');
    incidents.record({
      code: 'bridge-auth-failed',
      severity: 'blocked',
      message: 'Rejected https://localhost/bridge?token=changed token=changed',
    });
    incidents.resolveAll('bridge-auth-failed');
    now = new Date('2026-08-27T01:02:00.000Z');
    incidents.record({
      code: 'table-feed-stale',
      severity: 'blocked',
      tableId: 'D055',
      message: 'table feed stale',
    });
    now = new Date('2026-08-27T01:03:00.000Z');
    incidents.record({
      code: 'scheduler-failure',
      severity: 'degraded',
      message: 'monitor retry failed',
    });

    const restarted = new RuntimeIncidentStore(storage, {
      maxIncidents: 2,
      now: () => now,
    });
    const rows = restarted.list();

    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.code)).toEqual(['scheduler-failure', 'table-feed-stale']);
    expect(JSON.stringify(storage.getConfig('desktop:runtime-incidents:v1'))).not.toContain('super-secret');
  });

  it('never evicts an active blocker while trimming resolved incident history', () => {
    const storage = new MemoryConfigStore();
    let now = new Date('2026-08-27T01:00:00.000Z');
    const incidents = new RuntimeIncidentStore(storage, {
      maxIncidents: 2,
      now: () => now,
    });

    incidents.record({
      code: 'settlement-gap',
      severity: 'blocked',
      tableId: 'D055',
      message: 'unsettled reservation remains',
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      now = new Date(`2026-08-27T01:0${attempt}:00.000Z`);
      incidents.record({
        code: 'scheduler-failure',
        severity: 'degraded',
        message: `retry ${attempt}`,
      });
      incidents.resolveAll('scheduler-failure');
    }

    const restarted = new RuntimeIncidentStore(storage, {
      maxIncidents: 2,
      now: () => now,
    });
    expect(restarted.hasActive('settlement-gap', 'D055')).toBe(true);
    expect(restarted.list()).toContainEqual(expect.objectContaining({
      code: 'settlement-gap',
      tableId: 'D055',
      active: true,
    }));
  });

  it('acknowledges alert presentation without resolving the blocker and reopens it on recurrence', () => {
    const storage = new MemoryConfigStore();
    let now = new Date('2026-08-27T01:00:00.000Z');
    const incidents = new RuntimeIncidentStore(storage, { now: () => now });
    const created = incidents.record({
      code: 'unknown-execution',
      severity: 'blocked',
      tableId: 'D055',
      message: 'platform acknowledgement unknown',
    });

    now = new Date('2026-08-27T01:01:00.000Z');
    expect(incidents.acknowledge(created.incidentId)).toBe(true);
    expect(incidents.hasActive('unknown-execution', 'D055')).toBe(true);
    expect(incidents.list()[0]).toEqual(expect.objectContaining({
      active: true,
      acknowledgedAt: '2026-08-27T01:01:00.000Z',
    }));

    now = new Date('2026-08-27T01:02:00.000Z');
    incidents.record({
      code: 'unknown-execution',
      severity: 'blocked',
      tableId: 'D055',
      message: 'platform acknowledgement still unknown',
    });
    const recurrent = incidents.list()[0]!;
    expect(recurrent.active).toBe(true);
    expect(recurrent.occurrences).toBe(2);
    expect(recurrent).not.toHaveProperty('acknowledgedAt');
  });

  it('requires bridge identity, a fresh connected feed, a physical shoe, and complete accounting', () => {
    const reasons = evaluateLiveExecutionReadiness({
      approved: true,
      bridge: {
        running: true,
        authenticated: false,
        connectionCount: 1,
      },
      feed: {
        state: 'DISCONNECTED',
        stalenessMs: 60_000,
      },
      maxFeedStalenessMs: 45_000,
      projection: {
        shoeBaseline: 'unknown-monitor-session',
        connectionStatus: 'DISCONNECTED',
        sealed: false,
      },
      hasUnknownExecution: true,
      hasSettlementGap: true,
    });

    expect(reasons).toEqual([
      'bridge-not-authenticated',
      'table-feed-disconnected',
      'table-feed-stale',
      'physical-shoe-baseline-unknown',
      'table-connection-not-restored',
      'settlement-gap',
    ]);
  });

  it('returns no blockers only when every unattended execution prerequisite is current', () => {
    expect(evaluateLiveExecutionReadiness({
      approved: true,
      bridge: {
        running: true,
        authenticated: true,
        connectionCount: 1,
      },
      feed: {
        state: 'CONNECTED',
        stalenessMs: 250,
      },
      maxFeedStalenessMs: 45_000,
      projection: {
        shoeBaseline: 'physical-shoe',
        connectionStatus: 'CONNECTED',
        sealed: false,
      },
      hasUnknownExecution: false,
      hasSettlementGap: false,
    })).toEqual([]);
  });
});
