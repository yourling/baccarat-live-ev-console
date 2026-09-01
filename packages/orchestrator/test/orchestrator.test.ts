import { describe, expect, it, vi } from 'vitest';
import { Orchestrator, TableActor } from '../src/index.js';
import { SqliteLedger } from '@baccarat/ledger-state';
import { SimulatedAdapter, type BetExecutionRequest } from '@baccarat/adapter-contract';
import { FixtureBuilder } from '@baccarat/simulator-fixtures';
import { RiskManager } from '@baccarat/risk-execution';
import type {
  BetIntent,
  BetReceipt,
  NormalizedEvent,
  RiskLimits,
  TableProfile,
} from '@baccarat/contracts';
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

function liveReceipt(request: BetExecutionRequest, status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN', receiptId: string): BetReceipt {
  return {
    receiptId,
    intentId: request.intent.intentId,
    reservationId: request.reservationId ?? '',
    status,
    amount: request.intent.amount,
    market: request.intent.market,
    mode: 'live',
    createdAt: '2025-01-01T00:00:30.000Z',
    externalRef: `pragmatic-${receiptId}`,
  };
}

function acceptingLiveExecutor() {
  let count = 0;
  return {
    requestBet: async (request: BetExecutionRequest) => {
      count += 1;
      return liveReceipt(request, 'ACCEPTED', `live-accepted-${count}`);
    },
  };
}

describe('orchestrator table actor', () => {
  it('places one exact live bet without changing persistent mode or arming auto bet', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
      betStrategy: { type: 'fixed', market: 'bankerPair' },
    };
    const requests: BetExecutionRequest[] = [];
    const executor = {
      requestBet: async (request: BetExecutionRequest) => {
        requests.push(request);
        return liveReceipt(request, 'ACCEPTED', 'live-accepted-1');
      },
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    await Promise.all(stream.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();

    const result = await actor.placeOneShotBet({
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 20.50,
    });

    expect(result.status).toBe('ACCEPTED');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(expect.objectContaining({
      mode: 'live',
      reservationId: expect.any(String),
    }));
    expect(requests[0]?.intent.amount).toBe(20.50);
    expect(requests[0]?.intent.idempotencyKey).toBe('t1:s1:h1:bankerPair:20.5:one-shot');
    expect(requests[0]?.intent.decisionSnapshotId).toBe('one-shot:t1:s1:h1:bankerPair:20.5');
    expect(actor.snapshot().executionMode).toBe('live');
    expect(actor.getProjection().autoBetStatus).toBe('DISARMED');
    expect(ledger.listReceipts('t1')).toEqual([
      expect.objectContaining({
        shoeId: 's1',
        handId: 'h1',
        market: 'bankerPair',
        receipt: expect.objectContaining({
          receiptId: 'live-accepted-1',
          status: 'ACCEPTED',
          amount: 20.50,
          mode: 'live',
        }),
      }),
    ]);
    expect(orchestrator.getReservations('t1')).toEqual([
      expect.objectContaining({
        status: 'RESERVED',
        amount: 20.50,
        receiptId: 'live-accepted-1',
      }),
    ]);
    ledger.close();
  });

  it('allows one-shot manual betting before a physical shoe baseline is known', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = { ...simProfile(), autoBetArmedByDefault: false };
    let requestCount = 0;
    const executor = {
      requestBet: async (request: BetExecutionRequest) => {
        requestCount += 1;
        return liveReceipt(request, 'ACCEPTED', 'live-unknown-baseline');
      },
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    const monitorStart: NormalizedEvent = {
      type: 'newShoeSignal',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: '2025-01-01T00:00:01.000Z',
      sourceSeq: 1,
      shoeId: 's1',
      baseline: 'unknown-monitor-session',
      profile,
    };

    await orchestrator.enqueue('t1', monitorStart);
    await orchestrator.enqueue('t1', events[1]!);
    await actor.flush();

    const result = await actor.placeOneShotBet({
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 20,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'ACCEPTED',
      receipt: expect.objectContaining({
        receiptId: 'live-unknown-baseline',
        status: 'ACCEPTED',
      }),
    }));
    expect(requestCount).toBe(1);
    expect(ledger.listReservations('t1')).toContainEqual(expect.objectContaining({
      tableId: 't1',
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      status: 'RESERVED',
    }));
    ledger.close();
  });

  it('allows one-shot manual betting through stale local connection and hand state', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
    };
    let requestCount = 0;
    const executor = {
      requestBet: async (request: BetExecutionRequest) => {
        requestCount += 1;
        return liveReceipt(request, 'ACCEPTED', `manual-stale-${requestCount}`);
      },
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    const connectionLost: NormalizedEvent = {
      type: 'connectionLost',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: '2025-01-01T00:00:03.000Z',
      sourceSeq: 3,
      reason: 'test',
    };
    const connectionRestored: NormalizedEvent = {
      type: 'connectionRestored',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: '2025-01-01T00:00:04.000Z',
      sourceSeq: 4,
      continuityProof: `cursor-v1:${'b'.repeat(64)}`,
    };
    const secondHandWindow: NormalizedEvent = {
      type: 'bettingWindowOpened',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: '2025-01-01T00:00:05.000Z',
      sourceSeq: 5,
      shoeId: 's1',
      handId: 'h2',
      market: 'bankerPair',
    };

    await Promise.all(events.map(event => orchestrator.enqueue('t1', event)));
    await orchestrator.enqueue('t1', connectionLost);
    await actor.flush();

    const disconnected = await actor.placeOneShotBet({
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 20,
    });
    expect(disconnected).toEqual(expect.objectContaining({ status: 'ACCEPTED' }));

    await orchestrator.enqueue('t1', connectionRestored);
    await orchestrator.enqueue('t1', secondHandWindow);
    await actor.flush();

    const wrongHand = await actor.placeOneShotBet({
      shoeId: 's1',
      handId: 'h-stale-local',
      market: 'bankerPair',
      amount: 20,
    });
    expect(wrongHand).toEqual(expect.objectContaining({ status: 'ACCEPTED' }));
    expect(requestCount).toBe(2);
    ledger.close();
  });

  it('allows one-shot manual betting while automatic betting is armed', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
    };
    const executor = {
      requestBet: async (request: BetExecutionRequest) => liveReceipt(request, 'ACCEPTED', 'manual-while-armed'),
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    await Promise.all(events.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();
    await actor.setAutoBet(true, 's1');

    const result = await actor.placeOneShotBet({
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 20,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'ACCEPTED',
      receipt: expect.objectContaining({
        receiptId: 'manual-while-armed',
        status: 'ACCEPTED',
      }),
    }));
    expect(actor.snapshot().executionMode).toBe('live');
    expect(ledger.listReservations('t1')).toContainEqual(expect.objectContaining({
      tableId: 't1',
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      status: 'RESERVED',
      receiptId: 'manual-while-armed',
    }));
    ledger.close();
  });

  it('does not shrink a one-shot amount when risk limits are configured to shrink', async () => {
    const { ledger, riskLimits } = makeContext();
    const constrainedLimits: RiskLimits = {
      ...riskLimits,
      defaultExposureCap: 10,
      insufficientBehavior: 'shrink',
    };
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
    };
    let requestCount = 0;
    const executor = {
      requestBet: async (request: BetExecutionRequest) => {
        requestCount += 1;
        return liveReceipt(request, 'ACCEPTED', 'should-not-execute');
      },
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits: constrainedLimits, executor });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    await Promise.all(events.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();

    const result = await actor.placeOneShotBet({
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 20,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'REJECTED',
      reason: 'risk-rejected',
      riskReason: 'global-exposure-cap',
    }));
    expect(requestCount).toBe(0);
    expect(ledger.listReservations('t1')).toHaveLength(0);
    ledger.close();
  });

  it('keeps a terminal rejected one-shot reservation as a duplicate tombstone', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
    };
    const requests: BetExecutionRequest[] = [];
    const executor = {
      requestBet: async (request: BetExecutionRequest) => {
        requests.push(request);
        return liveReceipt(request, 'REJECTED', 'live-rejected-1');
      },
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    await Promise.all(events.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();

    const command = {
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair' as const,
      amount: 20,
    };
    const first = await actor.placeOneShotBet(command);
    const second = await actor.placeOneShotBet(command);

    expect(first.status).toBe('REJECTED');
    expect(second).toEqual({
      status: 'REJECTED',
      reason: 'duplicate',
    });
    expect(requests).toHaveLength(1);
    expect(ledger.listReceipts('t1')[0]?.receipt.status).toBe('REJECTED');
    expect(ledger.listReservations('t1')[0]?.status).toBe('RELEASED');
    ledger.close();
  });

  it('persists an unknown one-shot receipt without inventing pnl or arming auto bet', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
    };
    const executor = {
      requestBet: async (request: BetExecutionRequest) => liveReceipt(request, 'UNKNOWN', 'live-unknown-1'),
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    await Promise.all(events.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();

    const result = await actor.placeOneShotBet({
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 20,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      reason: 'platform-unknown',
      receipt: expect.objectContaining({ receiptId: 'live-unknown-1' }),
    }));
    expect(ledger.listReceipts('t1')[0]?.receipt.status).toBe('UNKNOWN');
    expect(orchestrator.getReservations('t1')[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      receiptId: 'live-unknown-1',
    }));
    expect(orchestrator.getReservations('t1')[0]).not.toHaveProperty('realizedPnl');
    expect(actor.getProjection().autoBetStatus).toBe('DISARMED');
    expect(orchestrator.getRiskState().reservedExposure).toBe(20);
    expect(orchestrator.getRiskState().pendingExecutions).toBe(1);
    ledger.close();
  });

  it('waits past five seconds for the MAIN-world UNKNOWN receipt', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
    };
    const executor = {
      requestBet: (request: BetExecutionRequest) => new Promise<BetReceipt>(resolve => {
        setTimeout(() => resolve(liveReceipt(request, 'UNKNOWN', 'live-unknown-after-5100ms')), 5_100);
      }),
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    await Promise.all(events.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();

    vi.useFakeTimers();
    try {
      const resultPromise = actor.placeOneShotBet({
        shoeId: 's1',
        handId: 'h1',
        market: 'bankerPair',
        amount: 20,
      });

      await vi.advanceTimersByTimeAsync(5_100);
      const result = await resultPromise;

      expect(result).toEqual(expect.objectContaining({
        status: 'UNKNOWN',
        reason: 'platform-unknown',
        receipt: expect.objectContaining({ receiptId: 'live-unknown-after-5100ms' }),
      }));
    } finally {
      vi.useRealTimers();
      ledger.close();
    }
  });

  it('shadow mode records decisions but does not call executor or create receipts', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...defaultProfile('t1'),
      autoConfirmNewShoe: true,
      autoBetArmedByDefault: true,
      minEV: 0,
      limits: { minBet: 1, maxBet: 1000 },
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: acceptingLiveExecutor() });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);

    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    await Promise.all(events.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    expect(ledger.listReceipts('t1').length).toBe(0);
    expect(ledger.listDecisions('t1').length).toBe(1);
    expect(ledger.listDecisions('t1')[0]?.createdAt).toBe(events[1]?.timestamp);
    expect(actor.getProjection().status).toBe('BETTING_WINDOW');
    ledger.close();
  });

  it('derives event watermarks without counting persisted events', async () => {
    // Given: the actor receives a normal new-shoe and betting-window event sequence.
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable(profile, 'shadow', 10);
    const countEvents = vi.spyOn(ledger, 'countEvents').mockImplementation(() => {
      throw new Error('high-frequency event handling must not count persisted events');
    });
    const events = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    try {
      // When: the actor serializes the sequence.
      await Promise.all(events.map(event => orchestrator.enqueue('t1', event)));
      await actor.flush();

      // Then: it advances the local watermark and never issues the count query.
      expect(actor.getProjection().eventWatermark).toBe(2);
      expect(countEvents).not.toHaveBeenCalled();
    } finally {
      ledger.close();
    }
  });

  it('records an unobservable window as ineligible without executing while auto betting is armed', async () => {
    // Given: a physical shoe with automatic betting armed in live execution mode.
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const requests: BetExecutionRequest[] = [];
    const executor = {
      requestBet: async (request: BetExecutionRequest) => {
        requests.push(request);
        return liveReceipt(request, 'ACCEPTED', 'should-not-execute');
      },
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'live', 10);
    const setup = new FixtureBuilder('t1').newShoe('s1', profile).build();
    await Promise.all(setup.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();
    expect(actor.getProjection().autoBetStatus).toBe('ARMED');
    const missedWindow: NormalizedEvent = {
      type: 'bettingWindowClosed',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: '2025-01-01T00:00:02.000Z',
      sourceSeq: ledger.nextSourceSeq('t1'),
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      openingObserved: false,
    };

    // When: the only observed state is a close after the actual wagering window passed.
    await orchestrator.enqueue('t1', missedWindow);
    await actor.flush();

    // Then: the decision is audited as forbidden, with no live request, receipt, or reservation.
    expect(ledger.listDecisions('t1')).toEqual([
      expect.objectContaining({
        eventId: missedWindow.eventId,
        eligible: false,
        reason: expect.stringContaining('betting-window-not-observable; execution-forbidden'),
      }),
    ]);
    expect(requests).toEqual([]);
    expect(ledger.listReceipts('t1')).toEqual([]);
    expect(orchestrator.getReservations('t1')).toEqual([]);
    ledger.close();
  });

  it('live mode calls executor, persists receipt and keeps reservation until settlement', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .closeWindow('s1', 'h1', 'bankerPair')
      .settle('s1', 'h1', [{ rank: 'A' }, { rank: 'A' }], [{ rank: 'K' }, { rank: 'Q' }], { bankerPair: true, playerPair: false })
      .build();
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: acceptingLiveExecutor() });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);

    await Promise.all(stream.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    const receipts = ledger.listReceipts('t1');
    expect(receipts.length).toBe(1);
    expect(receipts[0].receipt.status).toBe('ACCEPTED');
    const reservations = orchestrator.getReservations('t1');
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe('SETTLED');
    expect(orchestrator.getRiskState().reservedExposure).toBe(0);
    expect(orchestrator.getRiskState().executedToday).toBe(10);
    ledger.close();
  });

  it('audits both pair windows but executes at most one automatic wager per hand', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .openWindow('s1', 'h1', 'playerPair')
      .closeWindow('s1', 'h1', 'bankerPair')
      .closeWindow('s1', 'h1', 'playerPair')
      .settle('s1', 'h1', [{ rank: 'A' }, { rank: 'A' }], [{ rank: 'K' }, { rank: 'Q' }], { bankerPair: false, playerPair: true })
      .build();
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: acceptingLiveExecutor() });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);

    await Promise.all(stream.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();

    expect(ledger.listReceipts('t1').map(row => row.receipt.market)).toEqual(['bankerPair']);
    expect(ledger.listDecisions('t1').map(row => row.market)).toEqual(['bankerPair', 'playerPair']);
    expect(orchestrator.getReservations('t1')).toHaveLength(1);
    expect(orchestrator.getReservations('t1').map(row => row.status)).toEqual(['SETTLED']);
    expect(orchestrator.getRiskState().reservedExposure).toBe(0);
    ledger.close();
  });

  it('rejects a receipt that does not match the reserved pair intent', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const executor = {
      requestBet: async () => ({
        receiptId: 'wrong-receipt',
        intentId: 'wrong-intent',
        reservationId: 'wrong-reservation',
        status: 'ACCEPTED' as const,
        amount: 10,
        market: 'playerPair' as const,
        mode: 'simulated' as const,
        createdAt: new Date().toISOString(),
      }),
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    await Promise.all(stream.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();

    expect(ledger.listReceipts('t1')).toHaveLength(0);
    expect(orchestrator.getReservations('t1')[0]?.status).toBe('RELEASED');
    expect(orchestrator.getReservations('t1')[0]?.releaseReason).toBe('receipt-mismatch');
    ledger.close();
  });

  it('releases a matching rejected receipt instead of leaving a live reservation active', async () => {
    // Given: the platform returns a correlated rejection such as insufficient funds.
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const executor = {
      requestBet: async (request: { readonly intent: BetIntent; readonly reservationId?: string }) => ({
        receiptId: 'rejected-receipt',
        intentId: request.intent.intentId,
        reservationId: request.reservationId ?? '',
        status: 'REJECTED' as const,
        amount: request.intent.amount,
        market: request.intent.market,
        mode: request.intent.mode,
        createdAt: new Date().toISOString(),
      }),
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    // When: the eligible betting window is evaluated.
    await Promise.all(stream.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();

    // Then: the rejection is audited and its reservation is released immediately.
    expect(ledger.listReceipts('t1')[0]?.receipt.status).toBe('REJECTED');
    expect(orchestrator.getReservations('t1')[0]).toEqual(expect.objectContaining({
      status: 'RELEASED',
      releaseReason: 'receipt-rejected',
      receiptId: 'rejected-receipt',
    }));
    expect(orchestrator.getRiskState().pendingExecutions).toBe(0);
    ledger.close();
  });

  it('does not persist a precommit window rejection so the same hand can retry', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    let attempts = 0;
    const executor = {
      requestBet: async (request: { readonly intent: BetIntent; readonly reservationId?: string }) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            receiptId: 'window-not-ready',
            intentId: request.intent.intentId,
            reservationId: request.reservationId ?? '',
            status: 'REJECTED' as const,
            amount: request.intent.amount,
            market: request.intent.market,
            mode: request.intent.mode,
            createdAt: new Date().toISOString(),
            raw: { reason: 'request-unavailable:round-not-current', commitStarted: false },
          };
        }
        return {
          receiptId: 'retry-accepted',
          intentId: request.intent.intentId,
          reservationId: request.reservationId ?? '',
          status: 'ACCEPTED' as const,
          amount: request.intent.amount,
          market: request.intent.market,
          mode: request.intent.mode,
          createdAt: new Date().toISOString(),
        };
      },
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    const first = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    await Promise.all(first.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();
    expect(ledger.listReceipts('t1')).toEqual([]);
    expect(orchestrator.getReservations('t1')[0]?.status).toBe('RELEASED');

    const retryWindow: NormalizedEvent = {
      type: 'bettingWindowOpened',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
    };
    await orchestrator.enqueue('t1', retryWindow);
    await actor.flush();
    expect(attempts).toBe(2);
    expect(ledger.listReceipts('t1')[0]?.receipt.status).toBe('ACCEPTED');
    ledger.close();
  });

  it('keeps an unknown acknowledgement active and disarms automatic betting', async () => {
    // Given: the platform may have received the bet but no authoritative acknowledgement arrives.
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const executor = {
      requestBet: async (request: { readonly intent: BetIntent; readonly reservationId?: string }) => ({
        receiptId: 'unknown-receipt',
        intentId: request.intent.intentId,
        reservationId: request.reservationId ?? '',
        status: 'UNKNOWN' as const,
        amount: request.intent.amount,
        market: request.intent.market,
        mode: request.intent.mode,
        createdAt: new Date().toISOString(),
      }),
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    // When: the unknown receipt is processed.
    await Promise.all(stream.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();

    // Then: no outcome is invented and automatic betting stays armed for the next eligible window.
    expect(orchestrator.getReservations('t1')[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      releaseReason: 'platform-acknowledgement-unknown',
      receiptId: 'unknown-receipt',
    }));
    expect(actor.getProjection().autoBetStatus).toBe('ARMED');
    expect(orchestrator.getRiskState().reservedExposure).toBe(10);
    expect(orchestrator.getRiskState().pendingExecutions).toBe(1);

    const authoritativeSettlement: NormalizedEvent = {
      type: 'handSettled',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: '2025-01-01T00:00:31.000Z',
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 's1',
      handId: 'h1',
      playerCards: [{ rank: 'K' }, { rank: 'Q' }],
      bankerCards: [{ rank: 'A' }, { rank: 'A' }],
      outcomes: { bankerPair: true, playerPair: false },
    };
    await actor.enqueue(authoritativeSettlement);
    await actor.flush();

    expect(orchestrator.getReservations('t1')[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      receiptId: 'unknown-receipt',
    }));
    expect(orchestrator.getReservations('t1')[0]?.realizedPnl).toBeUndefined();
    expect(orchestrator.getRiskState().reservedExposure).toBe(10);
    expect(orchestrator.getRiskState().pendingExecutions).toBe(1);
    ledger.close();
  });

  it('treats an executor timeout as unknown without disarming automatic betting', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const actor = new TableActor({
      tableId: 't1',
      profile,
      ledger,
      riskManager: new RiskManager(ledger),
      executor: { requestBet: () => new Promise<null>(() => undefined) },
      executionMode: 'live',
      defaultBetAmount: 10,
      riskLimits,
      requestTimeoutMs: 5,
    });
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    await Promise.all(stream.map(event => actor.enqueue(event)));
    await actor.flush();

    expect(ledger.listReceipts('t1')[0]?.receipt.status).toBe('UNKNOWN');
    expect(actor.getProjection().autoBetStatus).toBe('ARMED');
    expect(actor.snapshot().executionMode).toBe('live');
    expect(actor.getProjection().connectionStatus).toBe('CONNECTED');
    ledger.close();
  });

  it('updates a registered table execution mode without replacing its actor', () => {
    // Given: a monitored table starts fail-closed in shadow mode.
    const { ledger, riskLimits } = makeContext();
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable(simProfile(), 'shadow', 10);

    // When: the operator explicitly enables live execution for the table.
    orchestrator.updateTableExecutionMode('t1', 'live');

    // Then: the same actor and persisted table config both reflect live mode.
    expect(orchestrator.getActor('t1')).toBe(actor);
    expect(actor.snapshot().executionMode).toBe('live');
    expect(orchestrator.listTableConfigs().t1?.executionMode).toBe('live');
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
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: acceptingLiveExecutor() });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    await Promise.all(stream.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    expect(ledger.listReceipts('t1').length).toBe(1);
    expect(ledger.listDecisions('t1').length).toBe(1);
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
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: acceptingLiveExecutor() });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    await Promise.all(stream.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    expect(ledger.listReceipts('t1').length).toBe(0);
    expect(ledger.listDecisions('t1').length).toBe(0);

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
    const orch1 = new Orchestrator({ ledger, riskLimits, executor: acceptingLiveExecutor() });
    orch1.registerTable(profile, 'simulated', 10);
    await Promise.all(stream.map(e => orch1.enqueue('t1', e)));
    await orch1.flush();
    expect(ledger.listReceipts('t1').length).toBe(1);

    const orch2 = new Orchestrator({ ledger, riskLimits, executor: acceptingLiveExecutor() });
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

  it('uses the highest matching EV tier for the bet amount', async () => {
    const { ledger, riskLimits } = makeContext();
    const base = defaultProfile('t1');
    const profile: TableProfile = {
      ...base,
      autoConfirmNewShoe: true,
      autoBetArmedByDefault: true,
      minEV: 0,
      limits: { minBet: 1, maxBet: 1000 },
      odds: { ...base.odds, bankerPair: { netWin: 20, loss: 1 } },
      betTiers: [{ minEV: 0, amount: 10 }, { minEV: 0.5, amount: 50 }],
      betStrategy: { type: 'fixed', market: 'bankerPair' },
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: acceptingLiveExecutor() });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    const stream = new FixtureBuilder('t1').newShoe('s1', profile).openWindow('s1', 'h1', 'bankerPair').build();
    await Promise.all(stream.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();
    expect(ledger.listReceipts('t1')[0]?.receipt.amount).toBe(50);
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

  it('fixed strategy gates non-target markets: decision audited, no bet placed', async () => {
    const { ledger, riskLimits } = makeContext();
    const base = simProfile();
    const profile: TableProfile = { ...base, betStrategy: { type: 'fixed', market: 'playerPair' } };
    // 修复前:bankerPair 窗口照样下单(strategyResult.selected 从未被读取)
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: acceptingLiveExecutor() });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    await Promise.all(stream.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    expect(ledger.listReceipts('t1').length).toBe(0);
    const decisions = ledger.listDecisions('t1');
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.reason).toContain('fixed-wait-other-market');
    ledger.close();
  });

  it('alternate strategy rotates markets and skips the non-active one', async () => {
    const { ledger, riskLimits } = makeContext();
    const base = simProfile();
    const profile: TableProfile = { ...base, betStrategy: { type: 'alternate', start: 'bankerPair' } };
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')   // 命中 start → 下注,轮替到 playerPair
      .openWindow('s1', 'h2', 'bankerPair')   // 非当前轮替市场 → 跳过
      .openWindow('s1', 'h2', 'playerPair')   // 命中轮替 → 下注,轮替回 bankerPair
      .build();
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor: acceptingLiveExecutor() });
    const actor = orchestrator.registerTable(profile, 'simulated', 10);
    await Promise.all(stream.map(e => orchestrator.enqueue('t1', e)));
    await actor.flush();
    const receipts = ledger.listReceipts('t1');
    expect(receipts.length).toBe(2);
    expect(receipts.map(r => r.market).sort()).toEqual(['bankerPair', 'playerPair']);
    expect(ledger.listDecisions('t1').length).toBe(3); // 每个窗口都有决策审计
    ledger.close();
  });

  it('re-reserving the same key after a released reservation survives restart (no tombstone conflict)', () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();

    const intent = (id: string): BetIntent => ({
      intentId: id,
      tableId: 't1',
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 10,
      mode: 'shadow',
      idempotencyKey: `k-${id}`,
      strategy: { type: 'both' },
      decisionSnapshotId: `dec-${id}`,
      createdAt: '2025-01-01T00:00:00.000Z',
    });

    // 第一次运行:预留后执行器失败 → release(false),行留在 DB 成为终态墓碑
    const rm1 = new RiskManager(ledger);
    const first = rm1.tryReserve(intent('i1'), profile, riskLimits);
    expect(first.ok).toBe(true);
    rm1.release(first.reservation!.reservationId, false, 'executor-timeout-or-rejected');

    // 重启:新 RiskManager 从同一 store 加载(内存 activeByKey 只含活跃行)
    const rm2 = new RiskManager(ledger);
    let second: ReturnType<RiskManager['tryReserve']> | undefined;
    // 修复前:saveReservation 撞全历史唯一约束,抛 LedgerConflictError 使整个事件流中断
    expect(() => { second = rm2.tryReserve(intent('i2'), profile, riskLimits); }).not.toThrow();
    expect(second?.ok).toBe(true);
    expect(rm2.snapshot().map(r => r.status).sort()).toEqual(['RELEASED', 'RESERVED']);
    ledger.close();
  });
});


describe('unknown monitor-session baseline execution', () => {
  it('does not automatically execute pair bets before a physical shoe baseline is known', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const requests: BetExecutionRequest[] = [];
    const executor = {
      requestBet: async (request: BetExecutionRequest) => {
        requests.push(request);
        return liveReceipt(request, 'ACCEPTED', 'live-unknown-baseline-auto');
      },
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'live', 10);
    const fixture = new FixtureBuilder('t1')
      .newShoe('monitor-session-t1', profile)
      .openWindow('monitor-session-t1', 'h1', 'bankerPair')
      .build();
    const monitorStart = {
      ...fixture[0],
      baseline: 'unknown-monitor-session',
    } as unknown as NormalizedEvent;

    await orchestrator.enqueue('t1', monitorStart);
    await orchestrator.enqueue('t1', fixture[1]!);
    await actor.flush();

    expect(requests).toEqual([]);
    expect(ledger.listReceipts('t1')).toEqual([]);
    expect(ledger.listDecisions('t1')).toEqual([]);
    expect(actor.getProjection().shoeBaseline).toBe('unknown-monitor-session');
    ledger.close();
  });

  it('does not auto-bet pairs when a physical label still has empty inventory on a deep road', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const requests: BetExecutionRequest[] = [];
    const executor = {
      requestBet: async (request: BetExecutionRequest) => {
        requests.push(request);
        return liveReceipt(request, 'ACCEPTED', 'live-false-physical-auto');
      },
    };
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      executor,
      observedGameCount: () => 55,
    });
    const actor = orchestrator.registerTable(profile, 'live', 10);
    const fixture = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    const physicalStart = {
      ...fixture[0],
      baseline: 'physical-shoe',
    } as unknown as NormalizedEvent;

    await orchestrator.enqueue('t1', physicalStart);
    await orchestrator.enqueue('t1', fixture[1]!);
    await actor.flush();

    expect(requests).toEqual([]);
    expect(ledger.listReceipts('t1')).toEqual([]);
    expect(ledger.listDecisions('t1')).toEqual([]);
    expect(actor.getProjection().shoeBaseline).toBe('physical-shoe');
    ledger.close();
  });
});
