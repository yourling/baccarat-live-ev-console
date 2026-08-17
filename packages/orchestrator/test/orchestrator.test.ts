import { describe, expect, it } from 'vitest';
import { Orchestrator, TableActor } from '../src/index.js';
import { SqliteLedger } from '@baccarat/ledger-state';
import { SimulatedAdapter } from '@baccarat/adapter-contract';
import { FixtureBuilder } from '@baccarat/simulator-fixtures';
import type { NormalizedEvent, RiskLimits, TableProfile } from '@baccarat/contracts';
import { defaultProfile, defaultRiskLimits, newId } from '@baccarat/contracts';

function makeContext() {
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
  return { ledger, riskLimits };
}

function simProfile(tableId = 't1'): TableProfile {
  return {
    ...defaultProfile(tableId),
    autoConfirmNewShoe: true,
    autoBetArmedByDefault: true,
    minEV: -10,
    limits: { minBet: 1, maxBet: 1000 },
  };
}

describe('orchestrator table actor', () => {
  it('shadow mode records decisions but does not call executor or create receipts', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = { ...defaultProfile('t1'), autoConfirmNewShoe: true, minEV: 0, limits: { minBet: 1, maxBet: 1000 } };
    const adapter = new SimulatedAdapter({ events: [] });
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: adapter });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);

    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    await Promise.all(events.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    expect(ledger.listReceipts('t1').length).toBe(0);
    expect(ledger.listDecisions('t1').length).toBe(1);
    expect(actor.getProjection().status).toBe('BETTING_WINDOW');
    ledger.close();
  });

  it('simulated mode calls executor, persists receipt and keeps reservation until settlement', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .closeWindow('s1', 'h1', 'bankerPair')
      .settle('s1', 'h1', [{ rank: 'A' }, { rank: 'A' }], [{ rank: 'K' }, { rank: 'Q' }], { bankerPair: true, playerPair: false })
      .build();
    const adapter = new SimulatedAdapter({ events: stream });
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: adapter });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);

    await Promise.all(stream.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    const receipts = ledger.listReceipts('t1');
    expect(receipts.length).toBe(1);
    expect(receipts[0].receipt.status).toBe('SIMULATED');
    const reservations = orchestrator.getReservations('t1');
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe('SETTLED');
    expect(orchestrator.getRiskState().reservedExposure).toBe(0);
    expect(orchestrator.getRiskState().executedToday).toBe(10);
    ledger.close();
  });

  it('same shoe+hand+market is not double bet when window events replay', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    const adapter = new SimulatedAdapter({ events: stream });
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: adapter });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    await Promise.all(stream.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    expect(ledger.listReceipts('t1').length).toBe(1);
    expect(ledger.listDecisions('t1').length).toBe(2);
    ledger.close();
  });

  it('does not auto bet until armed; manual arm works and manual correction disarms', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
      betStrategy: { type: 'fixed', market: 'bankerPair' },
    };
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    const adapter = new SimulatedAdapter({ events: [] });
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: adapter });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    await Promise.all(stream.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    expect(ledger.listReceipts('t1').length).toBe(0);
    expect(ledger.listDecisions('t1').length).toBe(1);

    await actor.setAutoBet(true, 's1');
    const window: NormalizedEvent = {
      type: 'bettingWindowOpened',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
    };
    await orchestrator.enqueue('t1', window);
    expect(ledger.listReceipts('t1').length).toBe(1);

    await actor.applyManualCorrection({ kind: 'burnModel', burnModel: { kind: 'unknown' } }, 's1');
    expect(actor.getProjection().autoBetStatus).toBe('NEEDS_MANUAL_RECOVERY');
    ledger.close();
  });

  it('red card disarms and blocks betting windows until the shoe is sealed', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .redCard('s1', 'h1')
      .openWindow('s1', 'h1', 'bankerPair')
      .settle('s1', 'h1', [{ rank: 'A' }, { rank: 'A' }], [{ rank: 'K' }, { rank: 'Q' }], { bankerPair: true, playerPair: false })
      .openWindow('s1', 'h2', 'bankerPair')
      .build();
    const adapter = new SimulatedAdapter({ events: stream });
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: adapter });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    await Promise.all(stream.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    expect(actor.getProjection().redCardSeen).toBe(true);
    expect(actor.getProjection().sealed).toBe(true);
    expect(ledger.listReceipts('t1').length).toBe(0);
    expect(ledger.listDecisions('t1').length).toBe(0);
    ledger.close();
  });

  it('restores registered tables, receipts and risk state after restart', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .closeWindow('s1', 'h1', 'bankerPair')
      .settle('s1', 'h1', [{ rank: 'A' }, { rank: 'A' }], [{ rank: 'K' }, { rank: 'Q' }], { bankerPair: true, playerPair: false })
      .build();
    const adapter = new SimulatedAdapter({ events: stream });
    const orch1 = new Orchestrator({ ledger, riskLimits, executor: adapter });
    orch1.registerTable(profile, 'simulated', 10);
    await Promise.all(stream.map(e => orch1.enqueue('t1', e)));
    await orch1.flush();
    expect(ledger.listReceipts('t1').length).toBe(1);

    const orch2 = new Orchestrator({ ledger, riskLimits, executor: new SimulatedAdapter({ events: [] }) });
    const restored = orch2.getActor('t1');
    expect(restored).toBeInstanceOf(TableActor);
    expect(orch2.getRiskState().executedToday).toBe(10);
    expect(orch2.getReservations('t1')[0]?.status).toBe('SETTLED');

    await Promise.all(stream.map(e => orch2.enqueue('t1', e)));
    await restored!.flush();
    expect(ledger.listReceipts('t1').length).toBe(1);
    expect(ledger.listDecisions('t1').length).toBe(1);
    ledger.close();
  });

  it('rejects an event with duplicate eventId but different payload', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    orchestrator.registerTable(profile, 'shadow', 10);
    const first: NormalizedEvent = {
      type: 'newShoeSignal', eventId: 'same-id', tableId: 't1',
      timestamp: '2025-01-01T00:00:00.000Z', sourceSeq: 1, shoeId: 's1', profile,
    };
    const second: NormalizedEvent = { ...first, shoeId: 's2' };
    await orchestrator.enqueue('t1', first);
    await expect(orchestrator.enqueue('t1', second)).rejects.toThrow(/already exists with a different payload/);
    ledger.close();
  });
});
