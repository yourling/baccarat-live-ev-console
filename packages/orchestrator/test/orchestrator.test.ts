import { describe, expect, it, vi } from 'vitest';
import { Orchestrator, TableActor } from '../src/index.js';
import { SqliteLedger } from '@baccarat/ledger-state';
import { SimulatedAdapter, type BetExecutionRequest, type OperationalWagerExecutionRequest } from '@baccarat/adapter-contract';
import { FixtureBuilder as SimulatorFixtureBuilder } from '@baccarat/simulator-fixtures';
import { RiskManager } from '@baccarat/risk-execution';
import type {
  BetIntent,
  BetReceipt,
  NormalizedEvent,
  RiskLimits,
  TableProfile,
} from '@baccarat/contracts';
import { CARD_RANKS, defaultProfile, defaultRiskLimits, newId } from '@baccarat/contracts';

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

function futureClosesAt(offsetMs = 10_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function withClosesAt(events: NormalizedEvent[], offsetMs = 10_000): NormalizedEvent[] {
  const firstMs = events.length > 0 ? Date.parse(events[0]!.timestamp ?? '') : Number.NaN;
  // 夹具跑在 2025-01-01 这样的固定时间轴上，但窗口校验读的是真实时钟：
  // one-shot 下注直接用 Date.now()，table-actor 也只在事件时钟与真实时钟
  // 偏差 <60s 时才退回事件时钟。所以必须把整条时间轴平移到"现在"，
  // timestamp 与 closesAt 的相对间隔保持不变。
  const shift = Number.isFinite(firstMs) && Math.abs(Date.now() - firstMs) > 60_000
    ? Date.now() - firstMs
    : 0;
  return events.map(event => {
    const eventMs = Date.parse(event.timestamp ?? '');
    const shiftedMs = Number.isFinite(eventMs) ? eventMs + shift : Date.now();
    const next: NormalizedEvent = { ...event, timestamp: new Date(shiftedMs).toISOString() };
    if (next.type !== 'bettingWindowOpened') return next;
    const existing = Date.parse(next.closesAt ?? '');
    const closesAtMs = Number.isFinite(existing) ? existing + shift : shiftedMs + offsetMs;
    return { ...next, closesAt: new Date(closesAtMs).toISOString() };
  });
}

class FixtureBuilder extends SimulatorFixtureBuilder {
  build(): NormalizedEvent[] {
    return withClosesAt(super.build());
  }
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

  it('rejects one-shot manual betting before a physical shoe baseline is known', async () => {
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
      status: 'REJECTED',
      reason: 'physical-shoe-required',
    }));
    expect(requestCount).toBe(0);
    expect(ledger.listReservations('t1')).toEqual([]);
    ledger.close();
  });

  it('rejects one-shot manual betting while disconnected or after the shoe baseline is unknown', async () => {
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
      timestamp: new Date().toISOString(),
      sourceSeq: 5,
      shoeId: 's1',
      handId: 'h2',
      market: 'bankerPair',
      // 真实时钟：本用例要验证的是断连后靴基线降级导致的拒绝，
      // 不能让过期的 closesAt 先在窗口校验处把它挡掉。
      closesAt: futureClosesAt(),
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
    expect(disconnected).toEqual(expect.objectContaining({
      status: 'REJECTED',
      reason: 'connected-required',
    }));

    await orchestrator.enqueue('t1', connectionRestored);
    await orchestrator.enqueue('t1', secondHandWindow);
    await actor.flush();

    const wrongHand = await actor.placeOneShotBet({
      shoeId: 's1',
      handId: 'h-stale-local',
      market: 'bankerPair',
      amount: 20,
    });
    expect(wrongHand).toEqual(expect.objectContaining({
      status: 'REJECTED',
      reason: 'physical-shoe-required',
    }));
    expect(requestCount).toBe(0);
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

  it('retries an uncommitted rejected one-shot on the same hand', async () => {
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
    expect(second.status).toBe('REJECTED');
    expect(second).toEqual(expect.objectContaining({ reason: 'platform-rejected' }));
    expect(requests).toHaveLength(2);
    expect(ledger.listReceipts('t1')).toHaveLength(0);
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

    const blocked = await actor.placeOneShotBet({
      shoeId: 's1',
      handId: 'h1',
      market: 'playerPair',
      amount: 20,
    });
    expect(blocked).toEqual(expect.objectContaining({
      status: 'REJECTED',
      reason: 'unknown-execution-pending',
    }));
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
    expect(orchestrator.getReservations('t1')[0]?.status).toBe('UNKNOWN');
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
      closesAt: futureClosesAt(),
    };
    await orchestrator.enqueue('t1', retryWindow);
    await actor.flush();
    expect(attempts).toBe(2);
    expect(ledger.listReceipts('t1')[0]?.receipt.status).toBe('ACCEPTED');
    ledger.close();
  });

  it('does not retry a committed round-not-current pair rejection', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    let attempts = 0;
    const executor = {
      requestBet: async (request: { readonly intent: BetIntent; readonly reservationId?: string }) => {
        attempts += 1;
        return {
          receiptId: 'window-not-ready-committed',
          intentId: request.intent.intentId,
          reservationId: request.reservationId ?? '',
          status: 'REJECTED' as const,
          amount: request.intent.amount,
          market: request.intent.market,
          mode: request.intent.mode,
          createdAt: new Date().toISOString(),
          raw: { reason: 'round-not-current', commitStarted: true },
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
    expect(attempts).toBe(1);
    expect(actor['placedKeys'].has('t1:s1:h1:bankerPair')).toBe(true);
    expect(actor['placedHandKeys'].has('t1:s1:h1')).toBe(true);
    expect(orchestrator.getReservations('t1')[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      releaseReason: 'window-not-ready-committed',
    }));

    const retryWindow: NormalizedEvent = {
      type: 'bettingWindowOpened',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      closesAt: futureClosesAt(),
    };
    await orchestrator.enqueue('t1', retryWindow);
    await actor.flush();
    expect(attempts).toBe(1);
    expect(actor['placedKeys'].has('t1:s1:h1:bankerPair')).toBe(true);
    expect(ledger.listReceipts('t1')[0]?.receipt.status).toBe('REJECTED');
    ledger.close();
  });

  it('does not auto-bet pairs when closesAt is missing', async () => {
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
    const setup = new SimulatorFixtureBuilder('t1').newShoe('s1', profile).build();
    await Promise.all(setup.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();
    const openWindow: NormalizedEvent = {
      type: 'bettingWindowOpened',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
    };
    await orchestrator.enqueue('t1', openWindow);
    await actor.flush();
    expect(requests).toEqual([]);
    expect(ledger.listReceipts('t1')).toEqual([]);
    ledger.close();
  });

  it('does not auto-bet pairs when the betting window has less than 3s remaining', async () => {
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
    const setup = new SimulatorFixtureBuilder('t1').newShoe('s1', profile).build();
    await Promise.all(setup.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();
    const now = Date.now();
    const shortWindow: NormalizedEvent = {
      type: 'bettingWindowOpened',
      eventId: newId('evt'),
      tableId: 't1',
      timestamp: new Date(now).toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      closesAt: new Date(now + 2_000).toISOString(),
    };
    await orchestrator.enqueue('t1', shortWindow);
    await actor.flush();
    expect(requests).toEqual([]);
    expect(ledger.listReceipts('t1')).toEqual([]);
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

  it('settles a committed unknown pair receipt from the exact hand outcome', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const executor = {
      requestBet: async (request: { readonly intent: BetIntent; readonly reservationId?: string }) => ({
        receiptId: 'committed-unknown-receipt',
        intentId: request.intent.intentId,
        reservationId: request.reservationId ?? '',
        status: 'UNKNOWN' as const,
        amount: request.intent.amount,
        market: request.intent.market,
        mode: request.intent.mode,
        createdAt: new Date().toISOString(),
        raw: { reason: 'round-advanced-before-ack', commitStarted: true },
      }),
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable(profile, 'live', 10);
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();

    await Promise.all(stream.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();
    expect(orchestrator.getReservations('t1')[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      releaseReason: 'platform-acknowledgement-unknown',
    }));

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
      status: 'SETTLED',
      releaseReason: 'committed-hand-settled',
      realizedPnl: 110,
    }));
    expect(orchestrator.getRiskState().reservedExposure).toBe(0);
    expect(orchestrator.getRiskState().pendingExecutions).toBe(0);
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
    expect(ledger.listDecisions('t1').some(decision => String(decision.reason).includes('auto-bet-paused'))).toBe(true);

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
      closesAt: futureClosesAt(),
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

  it('records a paused auto-bet decision without placing a live pair wager', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
      autoConfirmNewShoe: true,
      minEV: -1,
      betStrategy: { type: 'both' },
    };
    const requests: BetExecutionRequest[] = [];
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      executor: {
        requestBet: async (request: BetExecutionRequest) => {
          requests.push(request);
          return liveReceipt(request, 'ACCEPTED', 'should-not-fire');
        },
      },
    });
    const actor = orchestrator.registerTable(profile, 'live', 10);
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build();
    await Promise.all(stream.map(event => orchestrator.enqueue('t1', event)));
    await actor.flush();
    const decisions = ledger.listDecisions('t1');
    expect(decisions.some(decision => String(decision.reason).includes('auto-bet-paused'))).toBe(true);
    expect(ledger.listReceipts('t1')).toEqual([]);
    expect(requests).toEqual([]);
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
    // FIX(B-P1-4): 自动对子现在有 settlement-gap 门 —— 上一手 RESERVED 未结算时
    // 下一手必须 fail-closed。这个用例验证的是轮替语义，所以每手之间补结算。
    const stream = new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')   // 命中 start → 下注,轮替到 playerPair
      .closeWindow('s1', 'h1', 'bankerPair')
      .settle('s1', 'h1', [{ rank: 'A' }, { rank: 'K' }], [{ rank: 'A' }, { rank: 'Q' }], { bankerPair: false, playerPair: false })
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
  it('rejects an operational wager before a physical shoe baseline is known', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = { ...simProfile(), autoBetArmedByDefault: false };
    let requestCount = 0;
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      operationalExecutor: {
        requestOperationalWager: async () => {
          requestCount += 1;
          throw new Error('should-not-execute');
        },
      },
    });
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

    const result = await actor.placeOperationalWager({
      market: 'bankerPair',
      amount: 20,
      source: 'manual',
    });
    expect(result).toEqual(expect.objectContaining({
      status: 'REJECTED',
      reason: 'physical-shoe-required',
    }));
    expect(requestCount).toBe(0);
    expect(actor.getProjection().shoeBaseline).toBe('unknown-monitor-session');
    ledger.close();
  });

  it('does not block another table when one table has UNKNOWN exposure', async () => {
    const { ledger, riskLimits } = makeContext();
    const operationalExecutor = {
      requestOperationalWager: async (request: OperationalWagerExecutionRequest) => ({
        receiptId: `receipt-${request.wager.wagerId}`,
        wagerId: request.wager.wagerId,
        tableId: request.wager.tableId,
        shoeId: request.wager.shoeId,
        handId: request.wager.handId,
        market: request.wager.market,
        amount: request.wager.amount,
        source: request.wager.source,
        status: request.wager.tableId === 't1' ? 'UNKNOWN' as const : 'ACCEPTED' as const,
        createdAt: '2025-01-01T00:00:02.000Z',
        raw: { commitStarted: true, reason: 'bet-state:5:700' },
      }),
    };
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      operationalExecutor,
      operationalWagerTerms: {
        banker: { netWin: 0.95, loss: 1 },
        player: { netWin: 1, loss: 1 },
        tiePolicy: 'push',
      },
    });
    const t1 = orchestrator.registerTable({ ...simProfile('t1'), autoBetArmedByDefault: false }, 'live', 20);
    const t2 = orchestrator.registerTable({ ...simProfile('t2'), autoBetArmedByDefault: false }, 'live', 20);
    for (const [tableId, actor] of [['t1', t1], ['t2', t2]] as const) {
      const events = new FixtureBuilder(tableId)
        .newShoe(`s-${tableId}`, actor.getProfile())
        .openWindow(`s-${tableId}`, `h-${tableId}`, 'bankerPair')
        .build();
      await Promise.all(events.map(event => orchestrator.enqueue(tableId, event)));
      await actor.flush();
    }

    const unknown = await t1.placeOperationalWager({ market: 'bankerPair', amount: 20, source: 'keepalive' });
    expect(unknown.status).toBe('UNKNOWN');
    expect(orchestrator.getReservations('t1').some(reservation => reservation.status === 'UNKNOWN')).toBe(true);

    const accepted = await t2.placeOperationalWager({ market: 'bankerPair', amount: 20, source: 'keepalive' });
    expect(accepted).toEqual(expect.objectContaining({ status: 'ACCEPTED' }));
    expect(orchestrator.getReservations('t2')[0]?.status).toBe('RESERVED');
    ledger.close();
  });

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

describe('table actor dedupe key retention', () => {
  it('retains only current-shoe dedupe keys on new shoe', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = simProfile();
    const actor = new TableActor({
      tableId: 't1',
      profile,
      ledger,
      riskManager: new RiskManager(ledger),
      executor: null,
      executionMode: 'live',
      defaultBetAmount: 10,
      riskLimits,
      requestTimeoutMs: 5,
    });
    try {
      const first = new FixtureBuilder('t1').newShoe('s1', profile).build();
      await Promise.all(first.map(event => actor.enqueue(event)));
      await actor.flush();
      actor['placedKeys'].add('t1:s0:h0:bankerPair');
      actor['placedHandKeys'].add('t1:s0:h0');
      actor['reminderKeys'].add('s0:h0:rev:bankerPair');
      actor['placedKeys'].add('t1:s1:h1:bankerPair');
      const second = new FixtureBuilder('t1').newShoe('s2', profile).build()
        .map(event => ({ ...event, eventId: event.eventId + "-s2", sourceSeq: ledger.allocateSourceSeq("t1") }));
      await Promise.all(second.map(event => actor.enqueue(event)));
      await actor.flush();
      expect(actor.getProjection().shoeId).toBe('s2');
      expect(actor['placedKeys'].has('t1:s0:h0:bankerPair')).toBe(false);
      expect(actor['placedHandKeys'].has('t1:s0:h0')).toBe(false);
      expect(actor['reminderKeys'].has('s0:h0:rev:bankerPair')).toBe(false);
      expect(actor['placedKeys'].has('t1:s1:h1:bankerPair')).toBe(false);
    } finally {
      ledger.close();
    }
  });
});


describe('resetLiveShoeTracking', () => {
  it('forgets live inventory and missing-card counters without deleting ledger rows', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = {
      ...simProfile('t1'),
      autoConfirmNewShoe: true,
      autoBetArmedByDefault: false,
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable(profile, 'live', 10);
    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal',
      eventId: 'shoe-physical',
      tableId: 't1',
      timestamp: '2026-09-08T01:00:00.000Z',
      sourceSeq: 1,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-t1-2',
      baseline: 'physical-shoe',
      profile,
    } as NormalizedEvent);
    await orchestrator.enqueue('t1', {
      type: 'handSettled',
      eventId: 'settled-10',
      tableId: 't1',
      timestamp: '2026-09-08T01:01:00.000Z',
      sourceSeq: 2,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-t1-2',
      handId: '10',
      playerCards: [{ rank: 'A', suit: 'S', raw: 'AS' }, { rank: '8', suit: 'H', raw: '8H' }],
      bankerCards: [{ rank: 'K', suit: 'D', raw: 'KD' }, { rank: '7', suit: 'C', raw: '7C' }],
    } as NormalizedEvent);
    await orchestrator.enqueue('t1', {
      type: 'handSettled',
      eventId: 'settled-12',
      tableId: 't1',
      timestamp: '2026-09-08T01:02:00.000Z',
      sourceSeq: 3,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-t1-2',
      handId: '12',
      playerCards: [{ rank: '2', suit: 'S', raw: '2S' }, { rank: '3', suit: 'H', raw: '3H' }],
      bankerCards: [{ rank: '4', suit: 'D', raw: '4D' }, { rank: '5', suit: 'C', raw: '5C' }],
    } as NormalizedEvent);
    await actor.flush();
    expect(actor.getProjection().shoeId).toBe('bg-t1-2');
    expect(actor.missingUnobservedCardCount()).toBe(6);
    ledger.saveDecision({
      snapshotId: 'd-keep',
      tableId: 't1',
      shoeId: 'bg-t1-2',
      handId: '10',
      market: 'bankerPair',
      eventWatermark: 1,
      profileVersion: 1,
      modelRevision: 'model-1',
      pMean: 0.1,
      pLower: 0.08,
      evMean: 0.2,
      evLower: 0.1,
      eligible: true,
      reason: 'threshold-met',
      conservativePolicy: 'worst-case-burn-composition-v1',
      createdAt: '2026-09-08T01:00:30.000Z',
    });

    orchestrator.resetLiveShoeTracking();

    expect(actor.getProjection().shoeId).toBe('');
    expect(actor.getProjection().shoeBaseline).toBe('unknown-monitor-session');
    expect(actor.getProjection().seenCards).toEqual([]);
    expect(actor.missingUnobservedCardCount()).toBe(0);
    expect(ledger.listEvents('t1')).toHaveLength(3);
    expect(ledger.listDecisions('t1')).toHaveLength(1);
    ledger.close();
  });
});

describe('exhausted unknown new-shoe must replace mixed physical inventory', () => {
  it('accepts an unknown 80-hand-cap shoe and clears the previous physical inventory', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = {
      ...simProfile('t1'),
      autoConfirmNewShoe: true,
      autoBetArmedByDefault: false,
      minEV: 0.05,
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable(profile, 'live', 10);
    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal',
      eventId: 'shoe-physical',
      tableId: 't1',
      timestamp: '2026-09-08T08:00:00.000Z',
      sourceSeq: 1,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-t1-2',
      baseline: 'physical-shoe',
      profile: defaultProfile('t1'),
    } as NormalizedEvent);
    for (let hand = 1; hand <= 80; hand += 1) {
      const rank = CARD_RANKS[(hand - 1) % CARD_RANKS.length]!;
      await orchestrator.enqueue('t1', {
        type: 'handSettled',
        eventId: `settled-${hand}`,
        tableId: 't1',
        timestamp: new Date(Date.parse('2026-09-08T08:00:00.000Z') + hand * 1000).toISOString(),
        sourceSeq: hand + 1,
        source: 'bg-runtime',
        schemaVersion: 1,
        shoeId: 'bg-t1-2',
        handId: String(hand),
        playerCards: [{ rank }, { rank }],
        bankerCards: [{ rank }, { rank }],
      } as NormalizedEvent);
    }
    await actor.flush();
    expect(actor.getProjection().handNumber).toBe(80);
    expect(actor.getProjection().shoeBaseline).toBe('physical-shoe');

    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal',
      eventId: 'cap-unknown',
      tableId: 't1',
      timestamp: '2026-09-08T08:30:00.000Z',
      sourceSeq: 82,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-t1-3',
      baseline: 'unknown-monitor-session',
      profile: defaultProfile('t1'),
    } as NormalizedEvent);
    await actor.flush();
    expect(actor.getProjection().shoeId).toBe('bg-t1-3');
    expect(actor.getProjection().shoeBaseline).toBe('unknown-monitor-session');
    expect(actor.getProjection().seenCards).toEqual([]);
    expect(actor.getProjection().profileSnapshot.minEV).toBe(0.05);
    ledger.close();
  });

  it('auto-confirms a physical shoe even when the table profile waits for confirmation', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = {
      ...simProfile('A26'),
      autoConfirmNewShoe: false,
      autoBetArmedByDefault: false,
      minEV: 0.05,
    };
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable(profile, 'live', 20);
    await orchestrator.enqueue('A26', {
      type: 'newShoeSignal',
      eventId: 'a26-physical',
      tableId: 'A26',
      timestamp: '2026-09-08T13:37:03.447Z',
      sourceSeq: 1,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-A26-11',
      baseline: 'physical-shoe',
      // 真实 runtime（协议洗牌 / 人工确认）开出的实体靴会显式声明自动确认；
      // 桌配置的 autoConfirmNewShoe=false 不能把它压回等待确认。
      profile: { ...defaultProfile('A26'), autoConfirmNewShoe: true },
    } as NormalizedEvent);
    await orchestrator.enqueue('A26', {
      type: 'bettingWindowOpened',
      eventId: 'a26-open',
      tableId: 'A26',
      timestamp: '2026-09-08T13:37:10.000Z',
      sourceSeq: 2,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-A26-11',
      handId: '1685100',
      market: 'bankerPair',
      closesAt: '2026-09-08T13:37:18.000Z',
    } as NormalizedEvent);
    await actor.flush();
    expect(actor.getProjection().shoeBaseline).toBe('physical-shoe');
    expect(actor.getProjection().status).toBe('BETTING_WINDOW');
    expect(actor.getProjection().profileSnapshot.minEV).toBe(0.05);
    expect(actor.getProjection().profileSnapshot.autoConfirmNewShoe).toBe(true);
    ledger.close();
  });
});

describe('restart attach must not wipe a rebuilt physical shoe', () => {
  it('ignores an unknown attach shoe and keeps ledger inventory', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = {
      ...simProfile('t1'),
      autoConfirmNewShoe: true,
      autoBetArmedByDefault: false,
    };
    ledger.appendEvent({
      type: 'newShoeSignal',
      eventId: 'shoe-physical',
      tableId: 't1',
      timestamp: '2026-09-05T18:00:00.000Z',
      sourceSeq: 1,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-t1-2',
      baseline: 'physical-shoe',
      profile,
    } as NormalizedEvent);
    ledger.appendEvent({
      type: 'handSettled',
      eventId: 'settled-1',
      tableId: 't1',
      timestamp: '2026-09-05T18:01:00.000Z',
      sourceSeq: 2,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-t1-2',
      handId: '100',
      playerCards: [{ rank: 'A', suit: 'S', raw: 'AS' }, { rank: '8', suit: 'H', raw: '8H' }],
      bankerCards: [{ rank: 'K', suit: 'D', raw: 'KD' }, { rank: '7', suit: 'C', raw: '7C' }],
    } as NormalizedEvent);
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable(profile, 'live', 10);
    expect(actor.getProjection().shoeId).toBe('bg-t1-2');
    expect(actor.getProjection().seenCards.length).toBe(4);
    const remaining = actor.getProjection().remainingTotal;

    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal',
      eventId: 'attach-after-restart',
      tableId: 't1',
      timestamp: '2026-09-05T18:10:00.000Z',
      sourceSeq: 3,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-t1-1',
      baseline: 'unknown-monitor-session',
      profile,
    } as NormalizedEvent);
    await orchestrator.enqueue('t1', {
      type: 'cardObserved',
      eventId: 'live-card',
      tableId: 't1',
      timestamp: '2026-09-05T18:10:01.000Z',
      sourceSeq: 4,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-t1-1',
      handId: '101',
      card: { rank: '2', suit: 'C', raw: '2C' },
      position: 'player',
    } as NormalizedEvent);
    await actor.flush();

    expect(actor.getProjection().shoeId).toBe('bg-t1-2');
    expect(actor.getProjection().shoeBaseline).toBe('physical-shoe');
    expect(actor.getProjection().seenCards.length).toBe(4);
    expect(actor.getProjection().remainingTotal).toBe(remaining);
    ledger.close();
  });

  it('accepts a later physical shoe generation instead of holding the rebuilt shoe', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile = {
      ...simProfile('B01'),
      autoConfirmNewShoe: true,
      autoBetArmedByDefault: false,
    };
    ledger.appendEvent({
      type: 'newShoeSignal',
      eventId: 'shoe-physical-2',
      tableId: 'B01',
      timestamp: '2026-09-05T18:00:00.000Z',
      sourceSeq: 1,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-B01-2',
      baseline: 'physical-shoe',
      profile,
    } as NormalizedEvent);
    ledger.appendEvent({
      type: 'handSettled',
      eventId: 'settled-deep',
      tableId: 'B01',
      timestamp: '2026-09-05T19:00:00.000Z',
      sourceSeq: 2,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-B01-2',
      handId: '100',
      playerCards: [{ rank: 'A', suit: 'S', raw: 'AS' }, { rank: '8', suit: 'H', raw: '8H' }],
      bankerCards: [{ rank: 'K', suit: 'D', raw: 'KD' }, { rank: '7', suit: 'C', raw: '7C' }],
    } as NormalizedEvent);
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable(profile, 'live', 10);
    await orchestrator.enqueue('B01', {
      type: 'newShoeSignal',
      eventId: 'shoe-physical-3',
      tableId: 'B01',
      timestamp: '2026-09-05T20:00:00.000Z',
      sourceSeq: 3,
      source: 'bg-runtime',
      schemaVersion: 1,
      shoeId: 'bg-B01-3',
      baseline: 'physical-shoe',
      profile,
    } as NormalizedEvent);
    await actor.flush();
    expect(actor.getProjection().shoeId).toBe('bg-B01-3');
    expect(actor.getProjection().shoeBaseline).toBe('physical-shoe');
    expect(actor.getProjection().seenCards.length).toBe(0);
    ledger.close();
  });
});

describe('shoe handoff hold must fail closed', () => {
  function shoeHoldStream(tableId: string, shoeId: string): NormalizedEvent[] {
    const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
    const events: NormalizedEvent[] = [{
      type: 'newShoeSignal',
      eventId: `shoe-${shoeId}`,
      tableId,
      timestamp: new Date().toISOString(),
      sourceSeq: 1,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId,
      baseline: 'physical-shoe',
      profile: { ...simProfile(tableId), autoConfirmNewShoe: true },
    }];
    // 打到 handNumber = 10、remaining 仍远高于 180 —— 正是 hold 生效的区间
    for (let i = 1; i <= 10; i += 1) {
      const picks = [0, 1, 2, 3, 4, 5].map(o => RANKS[(i * 6 + o) % RANKS.length]);
      events.push({
        type: 'handSettled',
        eventId: `settled-${shoeId}-${i}`,
        tableId,
        timestamp: new Date().toISOString(),
        sourceSeq: i + 1,
        source: 'pragmatic-runtime',
        schemaVersion: 1,
        shoeId,
        handId: String(1000 + i),
        playerCards: picks.slice(0, 3).map(rank => ({ rank })),
        bankerCards: picks.slice(3, 6).map(rank => ({ rank })),
        outcomes: { bankerPair: false, playerPair: false },
      });
    }
    return events;
  }

  it('refuses pair bets while holding the old shoe, then releases once the hold expires', async () => {
    const { ledger, riskLimits } = makeContext();
    const executor = acceptingLiveExecutor();
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'shadow', 20);

    for (const event of shoeHoldStream('t1', 'shoe-1')) {
      await orchestrator.enqueue('t1', event);
    }
    // 旧靴开一个窗口
    await orchestrator.enqueue('t1', {
      type: 'bettingWindowOpened',
      eventId: 'window-1',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 100,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 'shoe-1',
      handId: '1011',
      market: 'bankerPair',
      closesAt: futureClosesAt(20_000),
    });
    await actor.flush();

    const before = await actor.placeOneShotBet({
      shoeId: 'shoe-1', handId: '1011', market: 'bankerPair', amount: 20,
    });
    expect(before.status).toBe('ACCEPTED');

    // 平台换靴：hold 生效
    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal',
      eventId: 'shoe-2-signal',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 200,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 'shoe-2',
      baseline: 'physical-shoe',
      profile: { ...simProfile('t1'), autoConfirmNewShoe: true },
    });
    await actor.flush();

    expect(actor.isShoeHoldPending()).toBe(true);
    // 关键：这段窗口里库存模型可能已与牌桌无关，必须拒绝下注
    // 换一个市场，避免被上面那次 bankerPair 的 duplicate 检查先挡掉
    const held = await actor.placeOneShotBet({
      shoeId: 'shoe-1', handId: '1011', market: 'playerPair', amount: 20,
    });
    expect(held).toMatchObject({ status: 'REJECTED', reason: 'shoe-hold-pending' });

    // 出口：hold 有上界，不会永久卡住
    actor['shoeHold']['holdSince'] = Date.now() - 91_000;
    expect(actor.isShoeHoldPending()).toBe(false);
    const released = await actor.placeOneShotBet({
      shoeId: 'shoe-1', handId: '1011', market: 'playerPair', amount: 20,
    });
    expect(released.status).not.toBe('REJECTED');
    ledger.close();
  });

  it('must flush the deferred new-shoe signal once the hold expires (self-heal)', async () => {
    const { ledger, riskLimits } = makeContext();
    const executor = acceptingLiveExecutor();
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'shadow', 20);

    for (const event of shoeHoldStream('t1', 'shoe-1')) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();

    // 一次性新靴信号：beginNewShoe 触发后会 clearShoeTracking，同一个换靴不会发第二次
    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal',
      eventId: 'shoe-2-signal',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 200,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 'shoe-2',
      baseline: 'physical-shoe',
      profile: { ...simProfile('t1'), autoConfirmNewShoe: true },
    });
    await actor.flush();
    expect(actor.isShoeHoldPending()).toBe(true);
    expect(actor.getProjection().shoeId).toBe('shoe-1');

    // hold 到期后，任何一个后续事件都必须把缓存的新靴信号补投进去 ——
    // 否则系统永远僵在旧靴的冻结库存模型上（且下注已恢复，等于在错误模型上下注）
    actor['shoeHold']['holdSince'] = Date.now() - 91_000;
    await orchestrator.enqueue('t1', {
      type: 'cardObserved',
      eventId: 'card-after-timeout',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 300,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 'shoe-2',
      handId: '2001',
      card: { rank: 'A', suit: 'spade' },
      position: 'player',
    });
    await actor.flush();

    expect(actor.getProjection().shoeId).toBe('shoe-2');
    // 新靴重置为 416 张，已计入的那 1 张要扣掉
    expect(actor.getProjection().remainingTotal).toBe(415);
    expect(actor.getProjection().seenCards).toHaveLength(1);
    ledger.close();
  });

  it('must flush the deferred signal as soon as the road-wrap exit lifts the hold, not only at timeout', async () => {
    const { ledger, riskLimits } = makeContext();
    let roadCount: number | undefined = undefined;
    const executor = acceptingLiveExecutor();
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor, observedGameCount: () => roadCount });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'shadow', 20);

    for (const event of shoeHoldStream('t1', 'shoe-1')) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();

    // 一次性信号被 hold
    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal',
      eventId: 'shoe-2-signal',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 200,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 'shoe-2',
      baseline: 'physical-shoe',
      profile: { ...simProfile('t1'), autoConfirmNewShoe: true },
    });
    await actor.flush();
    expect(actor.isShoeHoldPending()).toBe(true);
    expect(actor['shoeHold']['deferredSignal']?.shoeId).toBe('shoe-2');

    // 真实路子回绕：DOM 路子追到局 1（handNumber=10 → wrap-shaped）。
    // 路子回绕出口解除 hold 的瞬间，branch 2/3 放行事件会 clearShoeHold ——
    // 缓存若不在此前补投就被销毁，而信号是一次性的，桌将永久僵在旧靴。
    roadCount = 1;
    await orchestrator.enqueue('t1', {
      type: 'cardObserved',
      eventId: 'card-after-road-wrap',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 300,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 'shoe-2',
      handId: '2001',
      card: { rank: 'A', suit: 'spade' },
      position: 'player',
    });
    await actor.flush();

    expect(actor.getProjection().shoeId).toBe('shoe-2');
    expect(actor.getProjection().remainingTotal).toBe(415);
    expect(actor.getProjection().seenCards).toHaveLength(1);
    ledger.close();
  });

  it('must replace the deferred signal with a newer one when the platform switches twice during one hold', async () => {
    const { ledger, riskLimits } = makeContext();
    const executor = acceptingLiveExecutor();
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'shadow', 20);

    for (const event of shoeHoldStream('t1', 'shoe-1')) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();
    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal', eventId: 'shoe-2-signal', tableId: 't1',
      timestamp: new Date().toISOString(), sourceSeq: 200, source: 'pragmatic-runtime',
      schemaVersion: 1, shoeId: 'shoe-2', baseline: 'physical-shoe',
      profile: { ...simProfile('t1'), autoConfirmNewShoe: true },
    });
    await actor.flush();
    expect(actor['shoeHold']['deferredSignal']?.shoeId).toBe('shoe-2');

    // 补投 shoe-2 后打到深处，让 shoe-3 的信号也被 hold
    actor['shoeHold']['holdSince'] = Date.now() - 91_000;
    await orchestrator.enqueue('t1', {
      type: 'cardObserved', eventId: 'card-shoe-2', tableId: 't1',
      timestamp: new Date().toISOString(), sourceSeq: 250, source: 'pragmatic-runtime',
      schemaVersion: 1, shoeId: 'shoe-2', handId: '2001',
      card: { rank: 'A', suit: 'spade' }, position: 'player',
    });
    await actor.flush();
    expect(actor.getProjection().shoeId).toBe('shoe-2');
    const RANKS2 = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
    for (let i = 2; i <= 11; i += 1) {
      const picks = [0, 1, 2, 3, 4, 5].map(o => RANKS2[(i * 6 + o) % RANKS2.length]);
      await orchestrator.enqueue('t1', {
        type: 'handSettled',
        eventId: `settled-shoe-2-${i}`,
        tableId: 't1',
        timestamp: new Date().toISOString(),
        sourceSeq: 250 + i,
        source: 'pragmatic-runtime',
        schemaVersion: 1,
        shoeId: 'shoe-2',
        handId: String(2000 + i),
        playerCards: picks.slice(0, 3).map(rank => ({ rank })),
        bankerCards: picks.slice(3, 6).map(rank => ({ rank })),
        outcomes: { bankerPair: false, playerPair: false },
      });
    }
    await actor.flush();

    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal', eventId: 'shoe-3-signal', tableId: 't1',
      timestamp: new Date().toISOString(), sourceSeq: 400, source: 'pragmatic-runtime',
      schemaVersion: 1, shoeId: 'shoe-3', baseline: 'physical-shoe',
      profile: { ...simProfile('t1'), autoConfirmNewShoe: true },
    });
    await actor.flush();
    expect(actor['shoeHold']['deferredSignal']?.shoeId).toBe('shoe-3');

    // 平台又切了一靴：缓存必须替换成最新的 shoe-4，否则补投后僵在 shoe-3
    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal', eventId: 'shoe-4-signal', tableId: 't1',
      timestamp: new Date().toISOString(), sourceSeq: 500, source: 'pragmatic-runtime',
      schemaVersion: 1, shoeId: 'shoe-4', baseline: 'physical-shoe',
      profile: { ...simProfile('t1'), autoConfirmNewShoe: true },
    });
    await actor.flush();
    expect(actor['shoeHold']['deferredSignal']?.shoeId).toBe('shoe-4');

    actor['shoeHold']['holdSince'] = Date.now() - 91_000;
    await orchestrator.enqueue('t1', {
      type: 'cardObserved', eventId: 'card-shoe-4', tableId: 't1',
      timestamp: new Date().toISOString(), sourceSeq: 600, source: 'pragmatic-runtime',
      schemaVersion: 1, shoeId: 'shoe-4', handId: '4001',
      card: { rank: 'K', suit: 'heart' }, position: 'banker',
    });
    await actor.flush();
    expect(actor.getProjection().shoeId).toBe('shoe-4');
    expect(actor.getProjection().remainingTotal).toBe(415);
    ledger.close();
  });

  it('must replay settlements dropped during the hold so their cards leave the new-shoe inventory', async () => {
    const { ledger, riskLimits } = makeContext();
    const executor = acceptingLiveExecutor();
    const orchestrator = new Orchestrator({ ledger, riskLimits, executor });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'shadow', 20);

    for (const event of shoeHoldStream('t1', 'shoe-1')) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();
    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal', eventId: 'shoe-2-signal', tableId: 't1',
      timestamp: new Date().toISOString(), sourceSeq: 200, source: 'pragmatic-runtime',
      schemaVersion: 1, shoeId: 'shoe-2', baseline: 'physical-shoe',
      profile: { ...simProfile('t1'), autoConfirmNewShoe: true },
    });
    await actor.flush();
    expect(actor.isShoeHoldPending()).toBe(true);

    // hold 期间新靴打了 2 手 —— 结算事件被丢弃，且每手只发一次、不会再来了
    const RANKS3 = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
    for (let i = 1; i <= 2; i += 1) {
      const picks = [0, 1, 2, 3, 4, 5].map(o => RANKS3[(i * 6 + o) % RANKS3.length]);
      await orchestrator.enqueue('t1', {
        type: 'handSettled',
        eventId: `dropped-shoe-2-${i}`,
        tableId: 't1',
        timestamp: new Date().toISOString(),
        sourceSeq: 210 + i,
        source: 'pragmatic-runtime',
        schemaVersion: 1,
        shoeId: 'shoe-2',
        handId: String(2000 + i),
        playerCards: picks.slice(0, 3).map(rank => ({ rank })),
        bankerCards: picks.slice(3, 6).map(rank => ({ rank })),
        outcomes: { bankerPair: false, playerPair: false },
      });
    }
    await actor.flush();

    // 超时自愈 + 1 张新牌
    actor['shoeHold']['holdSince'] = Date.now() - 91_000;
    await orchestrator.enqueue('t1', {
      type: 'cardObserved', eventId: 'card-shoe-2', tableId: 't1',
      timestamp: new Date().toISOString(), sourceSeq: 300, source: 'pragmatic-runtime',
      schemaVersion: 1, shoeId: 'shoe-2', handId: '2003',
      card: { rank: 'A', suit: 'spade' }, position: 'player',
    });
    await actor.flush();

    const projection = actor.getProjection();
    expect(projection.shoeId).toBe('shoe-2');
    // 416 − 2 手 × 6 张（回放）− 1 张（新牌）= 403；不回放则是 415，多 12 张
    expect(projection.remainingTotal).toBe(403);
    expect(projection.seenCards).toHaveLength(13);
    ledger.close();
  });
});

describe('duplicate hand settlement must not double-count missing unobserved cards', () => {
  function settledHand(
    eventId: string,
    handId: string,
    overrides: Partial<Record<string, unknown>> = {},
  ): NormalizedEvent {
    const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
    const picks = [0, 1, 2, 3, 4, 5].map(o => RANKS[(6 * 6 + o) % RANKS.length]);
    return {
      type: 'handSettled',
      eventId,
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 100,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 'shoe-1',
      handId,
      playerCards: picks.slice(0, 3).map(rank => ({ rank })),
      bankerCards: picks.slice(3, 6).map(rank => ({ rank })),
      outcomes: { bankerPair: false, playerPair: false },
      ...overrides,
    } as NormalizedEvent;
  }

  it('ignores re-delivered settlements across parser identity changes and ledger dedup', async () => {
    const { ledger, riskLimits } = makeContext();
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'shadow', 20);

    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal',
      eventId: 'pragmatic:runA:0:t1:newShoeSignal:s1',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 1,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 'shoe-1',
      baseline: 'physical-shoe',
      profile: { ...simProfile('t1'), autoConfirmNewShoe: true },
    } as NormalizedEvent);
    for (let i = 1; i <= 5; i += 1) {
      await orchestrator.enqueue('t1', settledHand(`pragmatic:runA:0:t1:handSettled:h${i}`, String(1000 + i), {
        sourceSeq: 1 + i,
      }));
    }
    await actor.flush();
    const baseline = actor.getProjection();
    expect(baseline.remainingTotal).toBe(386);

    // 手 1006：只 live 采到 2 张，结算带 6 张 → 缺 4 张（真实漏采，计一次）
    const observedRanks = ['A', '2'];
    for (let c = 0; c < 2; c += 1) {
      await orchestrator.enqueue('t1', {
        type: 'cardObserved',
        eventId: `pragmatic:runA:0:t1:cardObserved:h6:c${c}`,
        tableId: 't1',
        timestamp: new Date().toISOString(),
        sourceSeq: 20 + c,
        source: 'pragmatic-runtime',
        schemaVersion: 1,
        shoeId: 'shoe-1',
        handId: '1006',
        card: { rank: observedRanks[c], suit: 'spade' },
        position: 'player',
      } as NormalizedEvent);
    }
    await orchestrator.enqueue('t1', settledHand('pragmatic:runA:0:t1:handSettled:h6', '1006', {
      sourceSeq: 30,
    }));
    await actor.flush();
    expect(actor.missingUnobservedCardCount()).toBe(4);
    // 首次结算后的库存/牌面快照：后续重复投递必须完全不改变它们（幂等）。
    // 这里不断言绝对张数 —— 手内漏采的补齐语义由 projection 决定（C-P1-4 范围内），
    // 本用例只锁定"重复投递不改变结果"这一不变量。
    const afterFirstSettlement = actor.getProjection();
    expect(afterFirstSettlement.remainingTotal).toBeLessThan(baseline.remainingTotal);

    // 路径 1：解析器身份变化（gen 1 / 新 runId）重新上报同一手 —— 新 eventId
    // 绕过 parsedEventIds 与 ledger 的 event_id 去重，但缺牌计数不得再累加
    await orchestrator.enqueue('t1', {
      type: 'cardObserved',
      eventId: 'pragmatic:runB:1:t1:cardObserved:h6:c0',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 40,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 'shoe-1',
      handId: '1006',
      card: { rank: 'A', suit: 'spade' },
      position: 'player',
    } as NormalizedEvent);
    await orchestrator.enqueue('t1', settledHand('pragmatic:runB:1:t1:handSettled:h6', '1006', {
      sourceSeq: 41,
    }));
    await actor.flush();
    expect(actor.missingUnobservedCardCount()).toBe(4);

    // 路径 2：同 eventId 再投递 —— ledger 去重命中后走 recoverSideEffects，
    // 同样不得再累加
    await orchestrator.enqueue('t1', settledHand('pragmatic:runA:0:t1:handSettled:h6', '1006', {
      sourceSeq: 30,
    }));
    await actor.flush();
    expect(actor.missingUnobservedCardCount()).toBe(4);

    // 库存与 seenCards 全程不受重复投递影响（cardInventoryKeys 去重）
    const projection = actor.getProjection();
    expect(projection.remainingTotal).toBe(afterFirstSettlement.remainingTotal);
    expect(projection.seenCards).toHaveLength(afterFirstSettlement.seenCards.length);
    ledger.close();
  });
});

describe('resetLiveShoeTracking must discard held shoe state', () => {
  function shoeHoldStreamLocal(tableId: string, shoeId: string): NormalizedEvent[] {
    const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
    const events: NormalizedEvent[] = [{
      type: 'newShoeSignal',
      eventId: `shoe-${shoeId}`,
      tableId,
      timestamp: new Date().toISOString(),
      sourceSeq: 1,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId,
      baseline: 'physical-shoe',
      profile: { ...simProfile(tableId), autoConfirmNewShoe: true },
    }];
    for (let i = 1; i <= 10; i += 1) {
      const picks = [0, 1, 2, 3, 4, 5].map(o => RANKS[(i * 6 + o) % RANKS.length]);
      events.push({
        type: 'handSettled',
        eventId: `settled-${shoeId}-${i}`,
        tableId,
        timestamp: new Date().toISOString(),
        sourceSeq: i + 1,
        source: 'pragmatic-runtime',
        schemaVersion: 1,
        shoeId,
        handId: String(1000 + i),
        playerCards: picks.slice(0, 3).map(rank => ({ rank })),
        bankerCards: picks.slice(3, 6).map(rank => ({ rank })),
        outcomes: { bankerPair: false, playerPair: false },
      } as NormalizedEvent);
    }
    return events;
  }

  it('must not flush a stale deferred signal onto the freshly reset projection', async () => {
    const { ledger, riskLimits } = makeContext();
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'shadow', 20);

    for (const event of shoeHoldStreamLocal('t1', 'shoe-1')) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();
    // 换靴信号被 hold + 缓存；期间新靴 1 手结算被丢弃入缓
    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal', eventId: 'shoe-2-signal', tableId: 't1',
      timestamp: new Date().toISOString(), sourceSeq: 200, source: 'pragmatic-runtime',
      schemaVersion: 1, shoeId: 'shoe-2', baseline: 'physical-shoe',
      profile: { ...simProfile('t1'), autoConfirmNewShoe: true },
    } as NormalizedEvent);
    await orchestrator.enqueue('t1', {
      type: 'handSettled', eventId: 'dropped-shoe-2', tableId: 't1',
      timestamp: new Date().toISOString(), sourceSeq: 210, source: 'pragmatic-runtime',
      schemaVersion: 1, shoeId: 'shoe-2', handId: '2001',
      playerCards: [{ rank: 'A' }, { rank: '2' }],
      bankerCards: [{ rank: 'K' }, { rank: '7' }],
      outcomes: { bankerPair: false, playerPair: false },
    } as NormalizedEvent);
    await actor.flush();
    expect(actor['shoeHold']['deferredSignal']?.shoeId).toBe('shoe-2');
    expect(actor.isShoeHoldPending()).toBe(true);

    // 操作员重置：意图是干净重来、等下一条洗牌证据
    orchestrator.resetLiveShoeTracking();
    expect(actor['shoeHold']['deferredSignal']).toBeUndefined();
    expect(actor.isShoeHoldPending()).toBe(false);
    expect(actor['shoeHold']['heldSettlements'].size).toBe(0);

    // 空投影下 shouldHold 恒为 false：若缓存未清，陈旧 shoe-2 信号会在此刻
    // 被补投，把重置后的状态劫持成"全新 416 张的 shoe-2"（fail-open）
    await orchestrator.enqueue('t1', {
      type: 'newShoeSignal', eventId: 'reattach-signal', tableId: 't1',
      timestamp: new Date().toISOString(), sourceSeq: 300, source: 'pragmatic-runtime',
      schemaVersion: 1, shoeId: 'shoe-att', baseline: 'unknown-monitor-session',
    } as NormalizedEvent);
    await actor.flush();

    const projection = actor.getProjection();
    expect(projection.shoeId).toBe('shoe-att');
    expect(projection.shoeBaseline).toBe('unknown-monitor-session');
    expect(projection.remainingTotal).toBe(416);
    ledger.close();
  });
});

/**
 * FIX(B-P1-1) 回归：跨来源重复下注。
 * 修复前 `risk.ts#activeReservationKey` 与 `ledger.hasOperationalWager` 都带
 * executionSource，保活 + 手动 / 自动对子 + 手动对子能在同一手同一市场真实下两注
 * （review/scripts/risk/a5-duplicate-source.ts 实证桥收到 2 条 wager）。
 */
describe('cross-source duplicate wagers must be rejected', () => {
  function acceptingOperationalExecutor(calls: { market: string; amount: number; source: string }[]) {
    return {
      requestOperationalWager: async (request: OperationalWagerExecutionRequest) => {
        const wager = request.wager;
        calls.push({ market: wager.market, amount: wager.amount, source: wager.source });
        return {
          receiptId: `receipt-${wager.wagerId}`,
          wagerId: wager.wagerId,
          tableId: wager.tableId,
          shoeId: wager.shoeId,
          handId: wager.handId,
          market: wager.market,
          amount: wager.amount,
          source: wager.source,
          status: 'ACCEPTED' as const,
          createdAt: '2025-01-01T00:00:02.000Z',
          raw: { commitStarted: true },
        };
      },
    };
  }

  const terms = {
    banker: { netWin: 0.95, loss: 1 },
    player: { netWin: 1, loss: 1 },
    tiePolicy: 'push' as const,
  };

  it('rejects a manual banker when keepalive already reserved the same hand and market', async () => {
    const { ledger, riskLimits } = makeContext();
    const operationalCalls: { market: string; amount: number; source: string }[] = [];
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      operationalWagerTerms: terms,
      operationalExecutor: acceptingOperationalExecutor(operationalCalls),
    });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'live', 20);
    for (const event of new FixtureBuilder('t1')
      .newShoe('s1', actor.getProfile())
      .openWindow('s1', 'h1', 'bankerPair')
      .build()) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();

    const keepalive = await actor.placeOperationalWager({ market: 'banker', amount: 20, source: 'keepalive' });
    expect(keepalive).toEqual(expect.objectContaining({ status: 'ACCEPTED' }));
    const manual = await actor.placeOperationalWager({ market: 'banker', amount: 20, source: 'manual' });

    // 修复前 manual 也是 ACCEPTED，桥收到 2 条 wager。
    expect(manual).toEqual(expect.objectContaining({ status: 'REJECTED', reason: 'duplicate' }));
    expect(operationalCalls).toHaveLength(1);
    expect(orchestrator.getReservations('t1').filter(r => r.status === 'RESERVED')).toHaveLength(1);
    ledger.close();
  });

  it('rejects a manual pair when the automatic strategy already reserved the same hand and market', async () => {
    const { ledger, riskLimits } = makeContext();
    const automaticRequests: BetExecutionRequest[] = [];
    const operationalCalls: { market: string; amount: number; source: string }[] = [];
    const profile: TableProfile = {
      ...simProfile(),
      betStrategy: { type: 'fixed', market: 'bankerPair' },
    };
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      operationalWagerTerms: terms,
      executor: {
        requestBet: async (request: BetExecutionRequest) => {
          automaticRequests.push(request);
          return liveReceipt(request, 'ACCEPTED', 'auto-accepted');
        },
      },
      operationalExecutor: acceptingOperationalExecutor(operationalCalls),
    });
    const actor = orchestrator.registerTable(profile, 'live', 20);
    for (const event of new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build()) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();
    expect(automaticRequests).toHaveLength(1);

    const manualPair = await actor.placeOperationalWager({ market: 'bankerPair', amount: 20, source: 'manual' });
    // 修复前这里是 ACCEPTED：同一手同一市场自动+手动两注真金。
    expect(manualPair).toEqual(expect.objectContaining({ status: 'REJECTED', reason: 'duplicate' }));
    expect(operationalCalls).toEqual([]);
    ledger.close();
  });

  it('still allows different markets on the same hand and the same market on the next hand', async () => {
    const { ledger, riskLimits } = makeContext();
    const operationalCalls: { market: string; amount: number; source: string }[] = [];
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      operationalWagerTerms: terms,
      operationalExecutor: acceptingOperationalExecutor(operationalCalls),
    });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'live', 20);
    for (const event of new FixtureBuilder('t1')
      .newShoe('s1', actor.getProfile())
      .openWindow('s1', 'h1', 'bankerPair')
      .build()) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();

    expect(await actor.placeOperationalWager({ market: 'banker', amount: 20, source: 'keepalive' }))
      .toEqual(expect.objectContaining({ status: 'ACCEPTED' }));
    // 不同市场（banker vs bankerPair）：允许（不能过度收紧）。
    expect(await actor.placeOperationalWager({ market: 'bankerPair', amount: 20, source: 'manual' }))
      .toEqual(expect.objectContaining({ status: 'ACCEPTED' }));
    expect(operationalCalls).toHaveLength(2);

    // 结算 h1 后，下一手同市场必须恢复可下注。
    await orchestrator.enqueue('t1', {
      type: 'handSettled',
      eventId: 'settle-h1',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 's1',
      handId: 'h1',
      playerCards: [{ rank: '5' }, { rank: '2' }],
      bankerCards: [{ rank: '9' }, { rank: '7' }],
      outcomes: { bankerPair: false, playerPair: false },
    } as NormalizedEvent);
    await orchestrator.enqueue('t1', {
      type: 'bettingWindowOpened',
      eventId: 'open-h2',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 's1',
      handId: 'h2',
      market: 'bankerPair',
      closesAt: futureClosesAt(20_000),
    } as NormalizedEvent);
    await actor.flush();
    expect(await actor.placeOperationalWager({ market: 'banker', amount: 20, source: 'keepalive' }))
      .toEqual(expect.objectContaining({ status: 'ACCEPTED' }));
    ledger.close();
  });
});

/**
 * FIX(B-P1-4) 回归：自动对子缺 settlement-gap 门。
 * 修复前 `evaluateWindow` 只查 `hasUnknownReservations`，于是上一手还是 RESERVED
 * （结算帧丢失）时下一手照常下注（review/scripts/risk/b11c 实证 h1/h2/h3 全下）。
 */
describe('automatic pair bets must fail closed on a settlement gap', () => {
  it('does not place h2/h3 while h1 is still RESERVED, and resumes after h1 settles', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      betStrategy: { type: 'fixed', market: 'bankerPair' },
    };
    const requests: BetExecutionRequest[] = [];
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      executor: {
        requestBet: async (request: BetExecutionRequest) => {
          requests.push(request);
          return liveReceipt(request, 'ACCEPTED', `accepted-${requests.length}`);
        },
      },
    });
    const actor = orchestrator.registerTable(profile, 'live', 20);
    const builder = new FixtureBuilder('t1').newShoe('s1', profile);
    for (const handId of ['h1', 'h2', 'h3']) builder.openWindow('s1', handId, 'bankerPair');
    for (const event of builder.build()) await orchestrator.enqueue('t1', event);
    await actor.flush();

    // 修复前 requests 会有 h1/h2/h3 三笔。
    expect(requests.map(request => request.intent.handId)).toEqual(['h1']);
    expect(orchestrator.getReservations('t1').filter(r => r.status === 'RESERVED')).toHaveLength(1);

    const gapDecisions = ledger.listDecisions('t1')
      .filter(decision => decision.handId !== 'h1' && decision.reason.includes('settlement-gap'));
    expect(gapDecisions.map(decision => decision.handId).sort()).toEqual(['h2', 'h3']);
    expect(gapDecisions.every(decision => decision.eligible === false)).toBe(true);

    // 补上 h1 的权威结算 → 恢复自动下注。
    await orchestrator.enqueue('t1', {
      type: 'handSettled',
      eventId: 'settle-h1',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 's1',
      handId: 'h1',
      playerCards: [{ rank: '5' }, { rank: '2' }],
      bankerCards: [{ rank: '9' }, { rank: '7' }],
      outcomes: { bankerPair: false, playerPair: false },
    } as NormalizedEvent);
    await orchestrator.enqueue('t1', {
      type: 'bettingWindowOpened',
      eventId: 'open-h4',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 's1',
      handId: 'h4',
      market: 'bankerPair',
      closesAt: futureClosesAt(20_000),
    } as NormalizedEvent);
    await actor.flush();
    expect(requests.map(request => request.intent.handId)).toEqual(['h1', 'h4']);
    ledger.close();
  });
});

/**
 * FIX(B-P1-5) 回归：shrink 后实下金额 ≠ 预留金额。
 * 修复前 `evaluateWindow` 用缩小前的 `intent.amount` 发桥，风控只按缩额记账
 * （review/scripts/risk/a4b：实下 100 / 风控记 10）。
 */
describe('automatic pair execution must not exceed the reserved amount', () => {
  it('fails closed instead of sending the un-shrunk amount to the bridge', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      betStrategy: { type: 'fixed', market: 'bankerPair' },
    };
    const requests: BetExecutionRequest[] = [];
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits: { ...riskLimits, defaultExposureCap: 10, insufficientBehavior: 'shrink' },
      executor: {
        requestBet: async (request: BetExecutionRequest) => {
          requests.push(request);
          return liveReceipt(request, 'ACCEPTED', 'should-never-happen');
        },
      },
    });
    const actor = orchestrator.registerTable(profile, 'live', 100);
    for (const event of new FixtureBuilder('t1')
      .newShoe('s1', profile)
      .openWindow('s1', 'h1', 'bankerPair')
      .build()) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();

    // 修复前这里会发出 amount=100 的请求，而 reservation.amount=10。
    expect(requests).toEqual([]);
    expect(orchestrator.getReservations('t1')).toEqual([
      expect.objectContaining({ status: 'RELEASED', releaseReason: 'reserved-amount-mismatch' }),
    ]);
    expect(orchestrator.getRiskState()).toMatchObject({
      reservedExposure: 0,
      pendingExecutions: 0,
    });
    ledger.close();
  });
});

/**
 * FIX(B-P1-2) 回归：UNKNOWN 收敛路径不校验 shoeId。
 * 修复前 `settleHand` 对 UNKNOWN 跳过 shoe 校验、actor 的两条
 * `settleCommittedUnknown*` 只比 handId，于是换靴后同 handId 的结算会确权上一靴的
 * 未知敞口并把盈亏记到新靴桶（review/scripts/risk/a6b、a6d 实证）。
 */
describe('cross-shoe UNKNOWN exposure must never be auto-settled', () => {
  function settleEvent(eventId: string, shoeId: string, handId: string): NormalizedEvent {
    return {
      type: 'handSettled',
      eventId,
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 900,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId,
      handId,
      playerCards: [{ rank: 'K' }, { rank: 'Q' }],
      bankerCards: [{ rank: 'A' }, { rank: 'A' }],
      outcomes: { bankerPair: true, playerPair: false },
    } as NormalizedEvent;
  }

  it('keeps a prior-shoe hand-settled UNKNOWN unknown when the next shoe reuses its handId', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
      betStrategy: { type: 'fixed', market: 'bankerPair' },
    };
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      executor: acceptingLiveExecutor(),
    });
    const actor = orchestrator.registerTable(profile, 'live', 20);

    for (const event of new FixtureBuilder('t1')
      .newShoe('shoe-1', profile)
      .openWindow('shoe-1', '5', 'bankerPair')
      .build()) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();
    // 上一靴那手：cards-only 结算 → UNKNOWN(hand-settled-without-authoritative-outcome)
    const first = await actor.placeOneShotBet({ shoeId: 'shoe-1', handId: '5', market: 'bankerPair', amount: 20 });
    expect(first.status).toBe('ACCEPTED');
    await orchestrator.enqueue('t1', {
      type: 'handSettled',
      eventId: 'settle-previous-shoe',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 'shoe-1',
      handId: '5',
      playerCards: [{ rank: '5' }, { rank: '2' }],
      bankerCards: [{ rank: '9' }, { rank: '7' }],
    } as NormalizedEvent);
    await actor.flush();
    expect(orchestrator.getReservations('t1')[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      shoeId: 'shoe-1',
    }));

    // 下一靴复用同一 handId，且带权威 outcomes —— 修复前会被确权成 SETTLED。
    await orchestrator.enqueue('t1', { ...settleEvent('settle-next-shoe', 'shoe-2', '5'), sourceSeq: 901 } as NormalizedEvent);
    await actor.flush();
    expect(orchestrator.getReservations('t1')[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      shoeId: 'shoe-1',
    }));
    expect(orchestrator.getReservations('t1')[0]?.realizedPnl).toBeUndefined();
    expect(orchestrator.getRiskState()).toMatchObject({
      reservedExposure: 20,
      pendingExecutions: 1,
    });
    // 亏损没有记到新靴桶。
    expect(orchestrator.getRiskState().shoeLosses['t1:shoe-2']).toBeUndefined();
    ledger.close();
  });

  it('still converges a same-shoe UNKNOWN when the authoritative settlement finally arrives', async () => {
    const { ledger, riskLimits } = makeContext();
    const profile: TableProfile = {
      ...simProfile(),
      autoBetArmedByDefault: false,
      betStrategy: { type: 'fixed', market: 'bankerPair' },
    };
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      executor: acceptingLiveExecutor(),
    });
    const actor = orchestrator.registerTable(profile, 'live', 20);
    for (const event of new FixtureBuilder('t1')
      .newShoe('shoe-1', profile)
      .openWindow('shoe-1', '5', 'bankerPair')
      .build()) {
      await orchestrator.enqueue('t1', event);
    }
    await actor.flush();
    expect((await actor.placeOneShotBet({
      shoeId: 'shoe-1', handId: '5', market: 'bankerPair', amount: 20,
    })).status).toBe('ACCEPTED');
    // cards-only 结算 → UNKNOWN
    await orchestrator.enqueue('t1', {
      type: 'handSettled',
      eventId: 'settle-cards-only',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: ledger.nextSourceSeq('t1'),
      shoeId: 'shoe-1',
      handId: '5',
      playerCards: [{ rank: '5' }, { rank: '2' }],
      bankerCards: [{ rank: '9' }, { rank: '7' }],
    } as NormalizedEvent);
    await actor.flush();
    expect(orchestrator.getReservations('t1')[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      releaseReason: 'hand-settled-without-authoritative-outcome',
    }));

    // 同靴迟到权威结算 → 正常收敛（不能误伤）。
    await orchestrator.enqueue('t1', { ...settleEvent('settle-authoritative', 'shoe-1', '5'), sourceSeq: 3 } as NormalizedEvent);
    await actor.flush();
    expect(orchestrator.getReservations('t1')[0]).toEqual(expect.objectContaining({
      status: 'SETTLED',
      realizedPnl: 220,
    }));
    expect(orchestrator.getRiskState()).toMatchObject({
      reservedExposure: 0,
      pendingExecutions: 0,
    });
    ledger.close();
  });
});

/**
 * FIX(B-P1-3) 回归：上一进程遗留的 RESERVED 敞口无法收口。
 * 跨进程（两个 RiskManager 实例 + 同一 SQLite）：旧 RESERVED（有回执/无回执各一）
 * 在新实例 escalate 后都变 UNKNOWN，可 writeOff；迟到权威结算也能收敛。
 */
describe('restored prior-process exposure must be closable', () => {  const profile: TableProfile = { ...defaultProfile('t1'), limits: { minBet: 1, maxBet: 1000 } };
  const limits: RiskLimits = {
    ...defaultRiskLimits,
    defaultExposureCap: 10_000,
    perTableLossLimit: 10_000,
    perShoeLossLimit: 10_000,
    perDayLossLimit: 10_000,
    maxConcurrentExecutions: 8,
    insufficientBehavior: 'skip',
  };

  it('escalates every prior-process RESERVED exposure and lets the operator write it off', () => {
    const ledger = new SqliteLedger();
    const first = new RiskManager(ledger);
    const withReceipt = first.tryReserveExecution({
      intentId: 'intent-receipt',
      tableId: 't1',
      shoeId: 's1',
      handId: 'h1',
      market: 'banker',
      executionSource: 'keepalive',
      amount: 20,
    }, profile.limits, { netWin: 0.95, loss: 1 }, limits);
    expect(withReceipt.ok).toBe(true);
    first.attachReceipt(withReceipt.reservation!.reservationId, 'rcpt-old');

    const withoutReceipt = first.tryReserveExecution({
      intentId: 'intent-no-receipt',
      tableId: 't1',
      shoeId: 's1',
      handId: 'h2',
      market: 'player',
      executionSource: 'manual',
      amount: 20,
    }, profile.limits, { netWin: 1, loss: 1 }, limits);
    expect(withoutReceipt.ok).toBe(true);

    // 模拟重启：新 manager 从同一 SQLite 恢复。
    const restarted = new RiskManager(ledger);
    // 修复前 `escalateOverdueSettlements(..., notBefore=runtimeStartedAt)` 会跳过这两笔。
    const escalated = restarted.escalateRestoredExposures();
    expect(escalated.map(reservation => reservation.status)).toEqual(['UNKNOWN', 'UNKNOWN']);
    expect(escalated.map(reservation => reservation.releaseReason))
      .toEqual(['restored-unsettled-exposure', 'restored-unsettled-exposure']);
    // 有回执的那笔保留回执（审计需要），无回执的那笔仍是 undefined。
    expect(escalated.map(reservation => reservation.receiptId).sort())
      .toEqual(['rcpt-old', undefined].sort());
    expect(restarted.getState()).toMatchObject({ reservedExposure: 40, pendingExecutions: 2 });

    // 操作员勾销可用（修复前这里抛 "is not an UNKNOWN exposure"）。
    const writtenOff = restarted.writeOffUnknown(
      withReceipt.reservation!.reservationId,
      'operator-unconfirmed-write-off',
    );
    expect(writtenOff).toMatchObject({
      status: 'RELEASED',
      releaseReason: 'operator-unconfirmed-write-off',
    });
    // 审计 reason 能区分"操作员勾销"与"启动恢复"。
    expect(writtenOff.releaseReason).not.toBe('restored-unsettled-exposure');
    restarted.writeOffUnknown(withoutReceipt.reservation!.reservationId, 'operator-unconfirmed-write-off');
    expect(restarted.getState()).toMatchObject({ reservedExposure: 0, pendingExecutions: 0 });
    ledger.close();
  });

  it('converges restored UNKNOWN exposures when the authoritative settlement arrives late', () => {
    const ledger = new SqliteLedger();
    const first = new RiskManager(ledger);
    const withReceipt = first.tryReserveExecution({
      intentId: 'intent-late',
      tableId: 't1',
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      executionSource: 'strategy',
      amount: 20,
    }, profile.limits, { netWin: 11, loss: 1 }, limits);
    first.attachReceipt(withReceipt.reservation!.reservationId, 'rcpt-late');
    const restarted = new RiskManager(ledger);
    restarted.escalateRestoredExposures();

    // 无 outcomes 的结算先把 UNKNOWN 保持为
    // hand-settled-without-authoritative-outcome（可收敛的唯一路径之一）。
    const cardsOnly = restarted.settleHand('t1', 's1', 'h1', {
      playerCards: [{ rank: '5' }, { rank: '2' }],
      bankerCards: [{ rank: '9' }, { rank: '7' }],
    });
    expect(cardsOnly[0]).toMatchObject({
      status: 'UNKNOWN',
      releaseReason: 'hand-settled-without-authoritative-outcome',
    });
    const converged = restarted.settleHand('t1', 's1', 'h1', {
      outcomes: { bankerPair: true, playerPair: false },
      playerCards: [{ rank: '5' }, { rank: '2' }],
      bankerCards: [{ rank: '9' }, { rank: '7' }],
    });
    expect(converged[0]).toMatchObject({ status: 'SETTLED', realizedPnl: 220 });
    expect(restarted.getState()).toMatchObject({ reservedExposure: 0, pendingExecutions: 0 });
    ledger.close();
  });

  it('reconciles a stale-shoe reserved reservation to UNKNOWN instead of silently expiring it', () => {
    const ledger = new SqliteLedger();
    const first = new RiskManager(ledger);
    const precommit = first.tryReserveExecution({
      intentId: 'intent-precommit',
      tableId: 't1',
      shoeId: 's1',
      handId: 'h1',
      market: 'banker',
      executionSource: 'keepalive',
      amount: 20,
    }, profile.limits, { netWin: 0.95, loss: 1 }, limits);
    expect(precommit.ok).toBe(true);

    const restarted = new RiskManager(ledger);
    // 修复前 reconcileTable 会 EXPIRED 这笔"预提交后进程被杀"的敞口 → 漏记潜在亏损。
    restarted.reconcileTable('t1', 's2', false);
    expect(restarted.snapshot()[0]).toEqual(expect.objectContaining({
      status: 'UNKNOWN',
      releaseReason: 'reconciled-on-startup',
    }));
    // UNKNOWN 仍占敞口，且可被操作员勾销。
    expect(restarted.getState()).toMatchObject({ reservedExposure: 20, pendingExecutions: 1 });
    expect(restarted.writeOffUnknown(precommit.reservation!.reservationId, 'operator-unconfirmed-write-off'))
      .toMatchObject({ status: 'RELEASED' });
    ledger.close();
  });
});

/**
 * FIX(D-P2-2) 回归：`clearMonitorData` 不能清零风控计数。
 * 修复前 ledger 里 `DELETE FROM risk_state`，等于"清记录 = 清账"，
 * 日/桌/靴亏损限额从 0 重新起算（review/scripts/desktop/a4c 实测）。
 */
describe('clearing monitor data must preserve risk accounting', () => {
  it('keeps dayLoss / tableLosses / shoeLosses while dropping reservations', async () => {
    const { ledger, riskLimits } = makeContext();
    const manager = new RiskManager(ledger);
    const intent = (handId: string): BetIntent => ({
      intentId: `intent-${handId}`,
      tableId: 't1',
      shoeId: 's1',
      handId,
      market: 'bankerPair',
      amount: 20,
      mode: 'live',
      idempotencyKey: `k-${handId}`,
      strategy: { type: 'both' },
      decisionSnapshotId: `dec-${handId}`,
      createdAt: new Date().toISOString(),
    });
    expect(manager.tryReserve(intent('h1'), simProfile(), riskLimits).ok).toBe(true);
    manager.settleHand('t1', 's1', 'h1', { bankerPair: false, playerPair: true });
    const before = manager.getState();
    expect(before.dayLoss).toBeGreaterThan(0);
    expect(before.tableLosses['t1']).toBeGreaterThan(0);
    expect(before.shoeLosses['t1:s1']).toBeGreaterThan(0);
    // 一笔仍在途的预留：清除记录后它的审计行会消失，但亏损计数必须保留。
    expect(manager.tryReserve(intent('h2'), simProfile(), riskLimits).ok).toBe(true);

    const orchestrator = new Orchestrator({ ledger, riskLimits });
    await orchestrator.clearMonitorData();

    // 清除后：预留审计行没了、敞口归零，但风控计数（落盘在 risk_state）原样保留。
    expect(orchestrator.getReservations()).toEqual([]);
    expect(orchestrator.getRiskState()).toMatchObject({
      reservedExposure: 0,
      pendingExecutions: 0,
    });
    // 重启（新 RiskManager 从 SQLite 恢复）后仍然保留 —— 修复前这里全是 0。
    const reloaded = new RiskManager(ledger);
    expect(reloaded.getState().dayLoss).toBe(before.dayLoss);
    expect(reloaded.getState().tableLosses['t1']).toBe(before.tableLosses['t1']);
    expect(reloaded.getState().shoeLosses['t1:s1']).toBe(before.shoeLosses['t1:s1']);
    expect(reloaded.getState().executedToday).toBe(before.executedToday);
    // 内存活跃键同步清空：清除后同键可以重新预留（不会撞到"已迁走"的旧键）。
    expect(reloaded.tryReserve(intent('h2'), simProfile(), riskLimits).ok).toBe(true);
    ledger.close();
  });
});

/**
 * FIX(C-P1-3): 漏采数量必须能阻断下注。
 *
 * 修复前：`missingUnobservedCards` 只用于 service 侧 `> 10` 移出监控，
 * 单张/少量漏采既不告警也不阻断 —— 投影的 remainingTotal 偏高会一直用到下一靴。
 * 修复后：任何一张漏采立即把该桌 autoBetStatus 置 NEEDS_MANUAL_RECOVERY。
 *
 * 注意 C-P1-4 修好"整手跳过"后，漏采本身在投影层已经被补齐（remainingTotal 正确），
 * 所以这里的缺牌计数来自 `countMissingHandCards`（补不回来的部分），
 * 而**整手都没采到**的路径必须仍然算 0 —— 那是重启后正常重建库存，不是漏采。
 */
describe('FIX(C-P1-3) missing cards must block automatic betting', () => {
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;

  function physicalShoeEvent(tableId = 't1', shoeId = 's1'): NormalizedEvent {
    return {
      type: 'newShoeSignal',
      eventId: `shoe-${shoeId}`,
      tableId,
      timestamp: new Date().toISOString(),
      sourceSeq: 1,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId,
      baseline: 'physical-shoe',
      profile: { ...simProfile(tableId), autoConfirmNewShoe: true },
    } as NormalizedEvent;
  }

  /** 4 张牌的一手：player A♠ 2♥ / banker 3♦ 4♣。 */
  const SETTLED_PLAYER = [
    { rank: RANKS[0], suit: 'S', raw: 'AS' },
    { rank: RANKS[1], suit: 'H', raw: '2H' },
  ];
  const SETTLED_BANKER = [
    { rank: RANKS[2], suit: 'D', raw: '3D' },
    { rank: RANKS[3], suit: 'C', raw: '4C' },
  ];

  /** 采到 SETTLED_PLAYER/SETTLED_BANKER 中该 position 的第 `index` 张。 */
  function cardObservedEvent(
    tableId: string,
    handId: string,
    position: 'player' | 'banker',
    index: number,
    sourceSeq: number,
  ): NormalizedEvent {
    const card = position === 'player' ? SETTLED_PLAYER[index]! : SETTLED_BANKER[index]!;
    return {
      type: 'cardObserved',
      eventId: `card-${handId}-${position}-${index}`,
      tableId,
      timestamp: new Date().toISOString(),
      sourceSeq,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 's1',
      handId,
      card,
      position,
    } as NormalizedEvent;
  }

  /** 结算 4 张牌的一手。 */
  function settledEvent(tableId: string, handId: string, sourceSeq = 100): NormalizedEvent {
    return {
      type: 'handSettled',
      eventId: `settled-${handId}-${sourceSeq}`,
      tableId,
      timestamp: new Date().toISOString(),
      sourceSeq,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 's1',
      handId,
      playerCards: SETTLED_PLAYER.map(card => ({ ...card })),
      bankerCards: SETTLED_BANKER.map(card => ({ ...card })),
      outcomes: { bankerPair: false, playerPair: false },
    } as NormalizedEvent;
  }

  it('sets NEEDS_MANUAL_RECOVERY and places no new bet after a single missing card', async () => {
    const { ledger, riskLimits } = makeContext();
    const requests: BetExecutionRequest[] = [];
    const orchestrator = new Orchestrator({
      ledger,
      riskLimits,
      executor: {
        requestBet: async (request: BetExecutionRequest) => {
          requests.push(request);
          return liveReceipt(request, 'ACCEPTED', `accepted-${requests.length}`);
        },
      },
    });
    const actor = orchestrator.registerTable(
      { ...simProfile(), betStrategy: { type: 'fixed', market: 'bankerPair' } },
      'live',
      20,
    );
    await orchestrator.enqueue('t1', physicalShoeEvent());
    // 4 张的 handSettled，live 只采到 3 张 → 缺 1 张（banker 第 2 张）。
    await orchestrator.enqueue('t1', cardObservedEvent('t1', 'h1', 'player', 0, 2));
    await orchestrator.enqueue('t1', cardObservedEvent('t1', 'h1', 'player', 1, 3));
    await orchestrator.enqueue('t1', cardObservedEvent('t1', 'h1', 'banker', 0, 4));
    await orchestrator.enqueue('t1', settledEvent('t1', 'h1'));
    await actor.flush();

    expect(actor.missingUnobservedCardCount()).toBe(1);
    expect(actor.getProjection().autoBetStatus).toBe('NEEDS_MANUAL_RECOVERY');

    // 下一手开窗：不得再下发任何自动下注。
    await orchestrator.enqueue('t1', {
      type: 'bettingWindowOpened',
      eventId: 'open-h2',
      tableId: 't1',
      timestamp: new Date().toISOString(),
      sourceSeq: 200,
      source: 'pragmatic-runtime',
      schemaVersion: 1,
      shoeId: 's1',
      handId: 'h2',
      market: 'bankerPair',
      closesAt: futureClosesAt(20_000),
    } as NormalizedEvent);
    await actor.flush();
    expect(requests).toEqual([]);
    ledger.close();
  });

  it('does not count a hand that was never observed live (restart replay path)', async () => {
    const { ledger, riskLimits } = makeContext();
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'shadow', 20);
    await orchestrator.enqueue('t1', physicalShoeEvent());
    // 一张 cardObserved 都没有，直接 handSettled：这是重启后重建库存的正常路径。
    await orchestrator.enqueue('t1', settledEvent('t1', 'h1'));
    await actor.flush();
    expect(actor.missingUnobservedCardCount()).toBe(0);
    expect(actor.getProjection().autoBetStatus).not.toBe('NEEDS_MANUAL_RECOVERY');
    ledger.close();
  });

  it('still triggers the existing >10 demotion threshold when 10 cards are missing', async () => {
    const { ledger, riskLimits } = makeContext();
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'shadow', 20);
    await orchestrator.enqueue('t1', physicalShoeEvent());
    // h1（数值局号 1）→ h3（数值局号 3）：跳号 h2 = 漏 1 整手 × 6 张 = 6；
    // h3 自身 live 只采到 2 张、结算 6 张 → 手内漏 4 张；合计 10。
    await orchestrator.enqueue('t1', settledEvent('t1', '1'));
    await orchestrator.enqueue('t1', cardObservedEvent('t1', '3', 'player', 0, 200));
    await orchestrator.enqueue('t1', cardObservedEvent('t1', '3', 'player', 1, 201));
    await orchestrator.enqueue('t1', {
      ...settledEvent('t1', '3', 202),
      playerCards: [0, 1, 2].map(index => ({ rank: RANKS[index], suit: 'S', raw: `${RANKS[index]}S` })),
      bankerCards: [3, 4, 5].map(index => ({ rank: RANKS[index], suit: 'H', raw: `${RANKS[index]}H` })),
    } as NormalizedEvent);
    await actor.flush();
    // 6（h2 整手丢失）+ 4（h3 手内漏采）= 10：service 的 >10 移出监控阈值不受影响。
    expect(actor.missingUnobservedCardCount()).toBe(10);
    ledger.close();
  });

  it('does not double-count missing cards when the same handSettled is redelivered', async () => {
    const { ledger, riskLimits } = makeContext();
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: false }, 'shadow', 20);
    await orchestrator.enqueue('t1', physicalShoeEvent());
    await orchestrator.enqueue('t1', cardObservedEvent('t1', 'h1', 'player', 0, 2));
    await orchestrator.enqueue('t1', cardObservedEvent('t1', 'h1', 'player', 1, 3));
    await orchestrator.enqueue('t1', cardObservedEvent('t1', 'h1', 'banker', 0, 4));
    await orchestrator.enqueue('t1', settledEvent('t1', 'h1'));
    await actor.flush();
    const once = actor.missingUnobservedCardCount();
    expect(once).toBe(1);

    // 同 eventId 重投（ledger 去重 → recoverSideEffects 再进一次 applyHandSettlement）
    await orchestrator.enqueue('t1', settledEvent('t1', 'h1'));
    // 换 eventId 重投（解析器 runId/generation bump 的真实形态）
    await orchestrator.enqueue('t1', settledEvent('t1', 'h1', 101));
    await actor.flush();
    expect(actor.missingUnobservedCardCount()).toBe(once);
    // 投影也不会被重复扣减。
    expect(actor.getProjection().remainingTotal).toBe(412);
    ledger.close();
  });

  it('keeps auto-bet ARMED when the hand is fully observed', async () => {
    const { ledger, riskLimits } = makeContext();
    const orchestrator = new Orchestrator({ ledger, riskLimits });
    const actor = orchestrator.registerTable({ ...simProfile(), autoBetArmedByDefault: true }, 'shadow', 20);
    await orchestrator.enqueue('t1', physicalShoeEvent());
    await orchestrator.enqueue('t1', cardObservedEvent('t1', 'h1', 'player', 0, 2));
    await orchestrator.enqueue('t1', cardObservedEvent('t1', 'h1', 'player', 1, 3));
    await orchestrator.enqueue('t1', cardObservedEvent('t1', 'h1', 'banker', 0, 4));
    await orchestrator.enqueue('t1', cardObservedEvent('t1', 'h1', 'banker', 1, 5));
    await orchestrator.enqueue('t1', settledEvent('t1', 'h1'));
    await actor.flush();
    expect(actor.missingUnobservedCardCount()).toBe(0);
    expect(actor.getProjection().autoBetStatus).toBe('ARMED');
    expect(actor.getProjection().remainingTotal).toBe(412);
    ledger.close();
  });
});
