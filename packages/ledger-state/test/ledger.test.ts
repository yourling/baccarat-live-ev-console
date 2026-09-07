import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { LedgerConflictError, ProjectionError, SqliteLedger, modelRevisionFor, profileVersionFor, replayEvents, type OperationalWagerRecord } from '../src/index.js';
import type { DecisionSnapshot, NormalizedEvent, RiskReservation, ShoeStateProjection } from '@baccarat/contracts';
import { ContractValidationError, defaultProfile, newId } from '@baccarat/contracts';

const baseTime = '2025-01-01T00:00:00.000Z';

function ev(partial: any, index: number): NormalizedEvent {
  const event = {
    ...partial,
    eventId: `e${index}`,
    tableId: 't1',
    timestamp: new Date(Date.parse(baseTime)+index*1000).toISOString(),
    sourceSeq: index,
  };
  if (
    event.type === 'newShoeSignal'
    && event.baseline === undefined
    && event.source !== 'pragmatic-runtime'
    && event.source !== 'bg-runtime'
  ) {
    event.baseline = 'physical-shoe';
  }
  return event;
}

function decision(
  snapshotId: string,
  handId: string,
  market: DecisionSnapshot['market'],
  eligible: boolean,
  createdAt: string,
  strategyChoice: DecisionSnapshot['strategyChoice'] = [],
): DecisionSnapshot {
  return {
    snapshotId,
    tableId: 't1',
    shoeId: 'shoe-1',
    handId,
    market,
    eventId: `window-${snapshotId}`,
    eventWatermark: 1,
    profileVersion: 1,
    modelRevision: 'model-1',
    pMean: 0.08,
    pLower: 0.07,
    evMean: -0.04,
    evLower: -0.16,
    eligible,
    reason: eligible ? 'threshold-met' : 'threshold-not-met',
    strategyChoice,
    conservativePolicy: 'worst-case-burn-composition-v1',
    createdAt,
  };
}

describe('ledger replay', () => {
  it('restores only exactly matched ACCEPTED operational reservations expired by legacy shoe rollover', () => {
    const ledger = new SqliteLedger();
    const reservation: RiskReservation = {
      reservationId: 'rsv-accepted-expired',
      intentId: 'opw-accepted-expired',
      tableId: 'D066',
      shoeId: 'shoe-1',
      handId: 'hand-1',
      market: 'player',
      executionSource: 'keepalive',
      amount: 20,
      maxLoss: 20,
      maxProfit: 20,
      status: 'EXPIRED',
      receiptId: 'receipt-accepted-expired',
      createdAt: '2026-08-28T16:14:10.458Z',
      releasedAt: '2026-08-28T16:34:35.590Z',
      releaseReason: 'new-shoe-signal-received',
    };
    const wager: OperationalWagerRecord = {
      wager: {
        wagerId: reservation.intentId,
        tableId: reservation.tableId,
        shoeId: reservation.shoeId,
        handId: reservation.handId,
        market: 'player',
        amount: reservation.amount,
        source: 'keepalive',
        createdAt: '2026-08-28T16:14:10.457Z',
      },
      reservationId: reservation.reservationId,
      status: 'ACCEPTED',
      receipt: {
        receiptId: reservation.receiptId!,
        wagerId: reservation.intentId,
        tableId: reservation.tableId,
        shoeId: reservation.shoeId,
        handId: reservation.handId,
        market: 'player',
        amount: reservation.amount,
        source: 'keepalive',
        status: 'ACCEPTED',
        createdAt: '2026-08-28T16:14:11.330Z',
      },
    };
    expect(ledger.saveReservation(reservation)).toBe(true);
    expect(ledger.saveOperationalWager(wager)).toBe(true);

    const repairs = ledger.restoreInvalidlyExpiredAcceptedOperationalReservations(
      '2026-08-29T00:00:00.000Z',
    );
    expect(repairs).toEqual([expect.objectContaining({
      reservationId: reservation.reservationId,
      wagerId: wager.wager.wagerId,
      previousStatus: 'EXPIRED',
      previousReason: 'new-shoe-signal-received',
    })]);
    expect(ledger.listReservations('D066')[0]).toEqual(expect.objectContaining({
      status: 'RESERVED',
      receiptId: reservation.receiptId,
    }));
    expect(ledger.listReservations('D066')[0]?.releasedAt).toBeUndefined();
    expect(ledger.listReservations('D066')[0]?.releaseReason).toBeUndefined();
    expect(ledger.getConfig<{ repairs: unknown[] }>('ledger:accepted-reservation-repairs:v1')?.repairs)
      .toHaveLength(1);
    expect(ledger.restoreInvalidlyExpiredAcceptedOperationalReservations()).toEqual([]);
    ledger.close();
  });

  it('reclassifies only proven precommit frame-routing UNKNOWN wagers as rejected', () => {
    const ledger = new SqliteLedger();
    const reason = 'bridge-request-error:expected exactly one matching frame for D066, found 0';
    const reservation: RiskReservation = {
      reservationId: 'rsv-precommit-unknown',
      intentId: 'opw-precommit-unknown',
      tableId: 'D066',
      shoeId: 'shoe-1',
      handId: 'GD066268281FN',
      market: 'player',
      executionSource: 'keepalive',
      amount: 20,
      maxLoss: 20,
      maxProfit: 20,
      status: 'UNKNOWN',
      createdAt: '2026-08-28T17:28:32.015Z',
      releaseReason: reason,
    };
    const wager: OperationalWagerRecord = {
      wager: {
        wagerId: reservation.intentId,
        tableId: reservation.tableId,
        shoeId: reservation.shoeId,
        handId: reservation.handId,
        market: 'player',
        amount: reservation.amount,
        source: 'keepalive',
        createdAt: reservation.createdAt,
      },
      reservationId: reservation.reservationId,
      status: 'UNKNOWN',
      reason,
    };
    expect(ledger.saveReservation(reservation)).toBe(true);
    expect(ledger.saveOperationalWager(wager)).toBe(true);

    const repairs = ledger.repairPrecommitUnknownOperationalReservations(
      '2026-08-29T01:30:00.000Z',
    );

    expect(repairs).toEqual([expect.objectContaining({
      reservationId: reservation.reservationId,
      wagerId: wager.wager.wagerId,
      previousStatus: 'UNKNOWN',
      previousReason: reason,
    })]);
    expect(ledger.listReservations('D066')[0]).toEqual(expect.objectContaining({
      status: 'RELEASED',
      releasedAt: '2026-08-29T01:30:00.000Z',
      releaseReason: reason,
    }));
    expect(ledger.getOperationalWager(wager.wager.wagerId)).toEqual(expect.objectContaining({
      status: 'REJECTED',
      reason,
    }));
    expect(ledger.getConfig<{ repairs: unknown[] }>('ledger:precommit-unknown-repairs:v1')?.repairs)
      .toHaveLength(1);
    expect(ledger.repairPrecommitUnknownOperationalReservations()).toEqual([]);
    ledger.close();
  });

  it('records an operator write-off for an unconfirmable UNKNOWN wager', () => {
    const ledger = new SqliteLedger();
    const wager: OperationalWagerRecord = {
      wager: {
        wagerId: 'opw-write-off',
        tableId: 'A30',
        shoeId: 'bg-A30-27',
        handId: '1095107',
        market: 'player',
        amount: 20,
        source: 'keepalive',
        createdAt: '2026-09-06T18:14:30.493Z',
      },
      reservationId: 'rsv-write-off',
      status: 'UNKNOWN',
      reason: 'committed-rejection-uncertain',
    };
    expect(ledger.saveOperationalWager(wager)).toBe(true);
    const written = ledger.writeOffOperationalWager('opw-write-off', {
      reason: 'operator-unconfirmed-write-off',
      writtenOffAt: '2026-09-07T03:20:00.000Z',
    });
    expect(written.writeOff).toEqual({
      reason: 'operator-unconfirmed-write-off',
      writtenOffAt: '2026-09-07T03:20:00.000Z',
    });
    expect(ledger.writeOffOperationalWager('opw-write-off', written.writeOff!)).toEqual(written);
    expect(() => ledger.writeOffOperationalWager('opw-write-off', {
      reason: 'operator-unconfirmed-write-off',
      writtenOffAt: '2026-09-07T03:21:00.000Z',
    })).toThrow(LedgerConflictError);
    ledger.close();
  });

  it('does not restore an expired reservation when ACCEPTED receipt evidence mismatches', () => {
    const ledger = new SqliteLedger();
    const reservation: RiskReservation = {
      reservationId: 'rsv-mismatch',
      intentId: 'opw-mismatch',
      tableId: 'D066',
      shoeId: 'shoe-1',
      handId: 'hand-1',
      market: 'player',
      executionSource: 'keepalive',
      amount: 20,
      maxLoss: 20,
      maxProfit: 20,
      status: 'EXPIRED',
      receiptId: 'receipt-mismatch',
      createdAt: baseTime,
      releasedAt: baseTime,
      releaseReason: 'new-shoe-signal-received',
    };
    expect(ledger.saveReservation(reservation)).toBe(true);
    expect(ledger.saveOperationalWager({
      wager: {
        wagerId: reservation.intentId,
        tableId: reservation.tableId,
        shoeId: reservation.shoeId,
        handId: reservation.handId,
        market: 'player',
        amount: 20,
        source: 'keepalive',
        createdAt: baseTime,
      },
      reservationId: reservation.reservationId,
      status: 'ACCEPTED',
      receipt: {
        receiptId: reservation.receiptId!,
        wagerId: reservation.intentId,
        tableId: reservation.tableId,
        shoeId: reservation.shoeId,
        handId: reservation.handId,
        market: 'player',
        amount: 21,
        source: 'keepalive',
        status: 'ACCEPTED',
        createdAt: baseTime,
      },
    })).toBe(true);

    expect(ledger.restoreInvalidlyExpiredAcceptedOperationalReservations()).toEqual([]);
    expect(ledger.listReservations('D066')[0]?.status).toBe('EXPIRED');
    ledger.close();
  });

  it('replays same stream deterministically and gives same hash', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'A' } }, 2),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'K' } }, 3),
      ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 4),
      ev({ type: 'bettingWindowClosed', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 5),
      ev({ type: 'handSettled', shoeId: 'shoe-1', handId: 'h1', playerCards: [{rank:'A'},{rank:'K'}], bankerCards: [{rank:'Q'},{rank:'Q'}] }, 6),
    ];
    const led = new SqliteLedger();
    for (const e of events) led.appendEvent(e);
    const r1 = led.replay('t1');
    const r2 = led.replay('t1');
    expect(r1.hash).toBe(r2.hash);
    const p1 = r1.state.get('t1')!;
    expect(p1.status).toBe('TRACKING');
    expect(p1.remainingTotal).toBe(414);
    expect(p1.seenCards.length).toBe(2);
    led.close();
  });

  it('rebuilds physical-shoe inventory from persisted handSettled when cardObserved was memory-only', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'bg-t1-2', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({
        type: 'handSettled',
        shoeId: 'bg-t1-2',
        handId: '3823000',
        playerCards: [{ rank: 'A', suit: 'S', raw: 'AS' }, { rank: '8', suit: 'H', raw: '8H' }],
        bankerCards: [{ rank: 'K', suit: 'D', raw: 'KD' }, { rank: '7', suit: 'C', raw: '7C' }],
      }, 2),
      ev({
        type: 'handSettled',
        shoeId: 'bg-t1-2',
        handId: '3823001',
        playerCards: [{ rank: '2', suit: 'S', raw: '2S' }, { rank: '3', suit: 'H', raw: '3H' }, { rank: '4', suit: 'D', raw: '4D' }],
        bankerCards: [{ rank: '5', suit: 'C', raw: '5C' }, { rank: '6', suit: 'S', raw: '6S' }],
      }, 3),
    ];
    const led = new SqliteLedger();
    for (const event of events) led.appendEvent(event);
    const projection = led.replay('t1', { latestShoeOnly: true }).state.get('t1')!;
    expect(projection.shoeBaseline).toBe('physical-shoe');
    expect(projection.handNumber).toBe(2);
    expect(projection.seenCards).toHaveLength(9);
    expect(projection.remainingTotal).toBe(416 - 9);
    led.close();
  });

  it('replays from the last physical shoe even if a later attach token was recorded', () => {
    const profile = defaultProfile('t1');
    const led = new SqliteLedger();
    led.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'bg-t1-2', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1));
    led.appendEvent(ev({
      type: 'handSettled',
      shoeId: 'bg-t1-2',
      handId: '3823000',
      playerCards: [{ rank: 'A', suit: 'S', raw: 'AS' }, { rank: '8', suit: 'H', raw: '8H' }],
      bankerCards: [{ rank: 'K', suit: 'D', raw: 'KD' }, { rank: '7', suit: 'C', raw: '7C' }],
    }, 2));
    led.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'bg-t1-1', baseline: 'unknown-monitor-session', profile: { ...profile, autoConfirmNewShoe: true } }, 3));
    const projection = led.replay('t1', { latestShoeOnly: true }).state.get('t1')!;
    expect(projection.shoeId).toBe('bg-t1-2');
    expect(projection.shoeBaseline).toBe('physical-shoe');
    expect(projection.seenCards).toHaveLength(4);
    expect(projection.remainingTotal).toBe(412);
    led.close();
  });

  it('ignores a same-id physical newShoe that arrives seconds after recorded hands', () => {
    const profile = defaultProfile('t1');
    const led = new SqliteLedger();
    led.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'bg-t1-2', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1));
    led.appendEvent(ev({
      type: 'handSettled',
      shoeId: 'bg-t1-2',
      handId: '100',
      playerCards: [{ rank: 'A', suit: 'S', raw: 'AS' }, { rank: '8', suit: 'H', raw: '8H' }],
      bankerCards: [{ rank: 'K', suit: 'D', raw: 'KD' }, { rank: '7', suit: 'C', raw: '7C' }],
    }, 2));
    led.appendEvent({
      ...ev({ type: 'newShoeSignal', shoeId: 'bg-t1-2', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 3),
      timestamp: '2025-01-01T00:00:43.000Z',
    });
    const projection = led.replay('t1', { latestShoeOnly: true }).state.get('t1')!;
    expect(projection.shoeId).toBe('bg-t1-2');
    expect(projection.seenCards).toHaveLength(4);
    expect(projection.remainingTotal).toBe(412);
    led.close();
  });

  it('does not consume inventory twice for a replayed card on the same hand', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'Q', suit: 'S' }, position: 'player' }, 2),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: '9', suit: 'H' }, position: 'player' }, 3),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'Q', suit: 'S' }, position: 'player' }, 4),
    ];
    const state = replayEvents(events).get('t1');
    expect(state?.seenCards).toEqual([
      { rank: 'Q', suit: 'S' },
      { rank: '9', suit: 'H' },
    ]);
    expect(state?.remainingTotal).toBe(414);
  });

  it('disarms a physical shoe once remaining cards fall behind the unobserved cut', () => {
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
    const profile = {
      ...defaultProfile('t1'),
      numberOfDecks: 1,
      autoConfirmNewShoe: true,
      autoBetArmedByDefault: true,
    };
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile }, 1),
    ];
    for (let index = 0; index < 27; index += 1) {
      events.push(ev({
        type: 'cardObserved',
        shoeId: 'shoe-1',
        handId: `h${Math.floor(index / 4) + 1}`,
        card: { rank: ranks[index % ranks.length] },
        position: index,
      }, index + 2));
    }
    const state = replayEvents(events).get('t1');
    expect(state?.remainingTotal).toBe(25);
    expect(state?.autoBetStatus).toBe('DISARMED');
    expect(state?.sealed).toBe(false);
    expect(state?.status).toBe('TRACKING');
  });

  it('keeps a physical shoe after a table-feed-stale gap', () => {
    const profile = { ...defaultProfile('t1'), autoConfirmNewShoe: true };
    const state = replayEvents([
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile }, 1),
      ev({ type: 'connectionLost', reason: 'table-feed-stale' }, 2),
    ]).get('t1');
    expect(state?.shoeBaseline).toBe('physical-shoe');
    expect(state?.connectionStatus).toBe('DISCONNECTED');
    expect(state?.autoBetStatus).toBe('DISARMED');
    const restored = replayEvents([
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile }, 1),
      ev({ type: 'connectionLost', reason: 'table-feed-stale' }, 2),
      ev({
        type: 'connectionRestored',
        continuityProof: `cursor-v1:${'a'.repeat(64)}`,
      }, 3),
    ]).get('t1');
    expect(restored?.shoeBaseline).toBe('physical-shoe');
    expect(restored?.connectionStatus).toBe('CONNECTED');
  });

  it('demotes a physical shoe after a non-transient connectionLost', () => {
    const profile = { ...defaultProfile('t1'), autoConfirmNewShoe: true };
    const state = replayEvents([
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile }, 1),
      ev({ type: 'connectionLost', reason: 'process-restart' }, 2),
    ]).get('t1');
    expect(state?.shoeBaseline).toBe('unknown-monitor-session');
  });

  it('keeps a physical shoe after an extension-bridge flash disconnect', () => {
    const profile = { ...defaultProfile('t1'), autoConfirmNewShoe: true, autoBetArmedByDefault: true };
    const state = replayEvents([
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile }, 1),
      ev({ type: 'connectionLost', reason: 'browser-extension-disconnected' }, 2),
    ]).get('t1');
    expect(state?.shoeBaseline).toBe('physical-shoe');
    expect(state?.connectionStatus).toBe('DISCONNECTED');
    expect(state?.autoBetStatus).toBe('DISARMED');
    const restored = replayEvents([
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile }, 1),
      ev({ type: 'connectionLost', reason: 'browser-extension-disconnected' }, 2),
      ev({
        type: 'connectionRestored',
        continuityProof: `cursor-v1:${'a'.repeat(64)}`,
      }, 3),
    ]).get('t1');
    expect(restored?.shoeBaseline).toBe('physical-shoe');
    expect(restored?.connectionStatus).toBe('CONNECTED');
    expect(restored?.autoBetStatus).toBe('DISARMED');
  });

  it('seals a physical shoe that can no longer deal a hand', () => {
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
    const profile = {
      ...defaultProfile('t1'),
      numberOfDecks: 1,
      autoConfirmNewShoe: true,
      autoBetArmedByDefault: true,
    };
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile }, 1),
    ];
    for (let index = 0; index < 47; index += 1) {
      events.push(ev({
        type: 'cardObserved',
        shoeId: 'shoe-1',
        handId: `h${Math.floor(index / 4) + 1}`,
        card: { rank: ranks[index % ranks.length] },
        position: index,
      }, index + 2));
    }
    const state = replayEvents(events).get('t1');
    expect(state?.remainingTotal).toBe(5);
    expect(state?.sealed).toBe(true);
    expect(state?.status).toBe('WAITING_NEW_SHOE');
    expect(state?.autoBetStatus).toBe('DISARMED');
  });

  it('counts two same-rank copies with different raw shoe ids', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: '5', suit: 'D', raw: '5D3' }, position: 'player' }, 2),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: '5', suit: 'D', raw: '5D4' }, position: 'player' }, 3),
    ];
    const state = replayEvents(events).get('t1');
    expect(state?.seenCards).toEqual([
      { rank: '5', suit: 'D', raw: '5D3' },
      { rank: '5', suit: 'D', raw: '5D4' },
    ]);
    expect(state?.remainingTotal).toBe(414);
  });

  it('counts the first physical-shoe hand when the betting window opens before cards arrive', () => {
    // Given: the live protocol opens the betting window before reporting the first card.
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 2),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'A' } }, 3),
    ];

    // When: the event stream is projected.
    const state = replayEvents(events).get('t1');

    // Then: the first observed physical-shoe hand has sequence number one.
    expect(state?.handNumber).toBe(1);
  });

  it('does not double-count two pair-market openings for one hand', () => {
    // Given: both pair markets open for the same platform hand.
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 2),
      ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'playerPair' }, 3),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'A' } }, 4),
    ];

    // When: the event stream is projected.
    const state = replayEvents(events).get('t1');

    // Then: the platform hand contributes exactly one to the sequence.
    expect(state?.handNumber).toBe(1);
  });

  it('counts an unknown-monitor-session hand and honors auto-bet arming', () => {
    // Given: monitoring attaches mid-shoe and receives a live betting window.
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'monitor-session-1', source: 'pragmatic-runtime', profile: { ...profile, autoConfirmNewShoe: true, autoBetArmedByDefault: true } }, 1),
      ev({ type: 'bettingWindowOpened', shoeId: 'monitor-session-1', handId: 'h1', market: 'bankerPair' }, 2),
    ];

    // When: the attach stream is projected.
    const state = replayEvents(events).get('t1');

    // Then: the session-local sequence advances and automatic real betting can remain armed.
    expect(state).toMatchObject({
      handNumber: 1,
      shoeBaseline: 'unknown-monitor-session',
      autoBetStatus: 'ARMED',
    });
  });

  it('ignores a late betting-window event from an already observed hand', () => {
    // Given: two hands have already supplied cards before a stale window event is replayed.
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'A' } }, 2),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h2', card: { rank: 'K' } }, 3),
      ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 4),
    ];

    // When: the out-of-order event stream is projected.
    const state = replayEvents(events).get('t1');

    // Then: the stale hand neither increments nor replaces the current hand.
    expect(state).toMatchObject({ handNumber: 2, currentHandId: 'h2', status: 'TRACKING' });
  });

  it('records betting-window close time from the opened event', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({
        type: 'bettingWindowOpened',
        shoeId: 'shoe-1',
        handId: 'h1',
        market: 'bankerPair',
        closesAt: '2026-08-30T06:58:18.000Z',
      }, 2),
    ];

    const state = replayEvents(events).get('t1');

    expect(state).toMatchObject({
      status: 'BETTING_WINDOW',
      currentHandId: 'h1',
      bettingWindowClosesAt: '2026-08-30T06:58:18.000Z',
    });
  });

  it('reopens the current betting window after a close if no cards have been seen', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 2),
      ev({ type: 'bettingWindowClosed', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 3),
      ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 4),
    ];

    const state = replayEvents(events).get('t1');

    expect(state).toMatchObject({
      currentHandId: 'h1',
      status: 'BETTING_WINDOW',
      currentHandHasCards: false,
    });
  });

  it('does not reopen a betting window after the current hand has cards', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 2),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'A' } }, 3),
      ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 4),
    ];

    const state = replayEvents(events).get('t1');

    expect(state).toMatchObject({
      currentHandId: 'h1',
      status: 'TRACKING',
      currentHandHasCards: true,
    });
  });

  it('red card seals shoe only after current hand settled', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'redCardSeen', shoeId: 'shoe-1', handId: 'h1' }, 2),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'A' } }, 3),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'K' } }, 4),
      ev({ type: 'handSettled', shoeId: 'shoe-1', handId: 'h1', playerCards: [{rank:'A'},{rank:'K'}], bankerCards: [{rank:'10'},{rank:'J'}] }, 5),
    ];
    const state = replayEvents(events).get('t1')!;
    expect(state.redCardSeen).toBe(true);
    expect(state.sealed).toBe(true);
    expect(state.status).toBe('WAITING_NEW_SHOE');
    expect(state.seenCards.length).toBe(2);
  });

  it('new shoe signal seals previous shoe and never mixes counts', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'A' } }, 2),
      ev({ type: 'newShoeSignal', shoeId: 'shoe-2', profile: { ...profile, autoConfirmNewShoe: true } }, 3),
    ];
    const state = replayEvents(events).get('t1')!;
    expect(state.shoeId).toBe('shoe-2');
    expect(state.remainingTotal).toBe(416);
    expect(state.seenCards.length).toBe(0);
    expect(state.sealed).toBe(false);
  });
});
describe('ledger persistence and append safety', () => {
  it('persists events and replay hash across close/reopen of a file database', () => {
    const dir = tmpdir();
    const dbPath = join(dir, `baccarat-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 'shoe-1', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({
        type: 'handSettled',
        shoeId: 'shoe-1',
        handId: 'h1',
        playerCards: [{ rank: 'A' }, { rank: 'K' }],
        bankerCards: [{ rank: 'Q' }, { rank: 'Q' }],
      }, 2),
    ];
    const first = new SqliteLedger(dbPath);
    for (const e of events) first.appendEvent(e);
    const expectedHash = first.replay('t1').hash;
    first.close();

    const second = new SqliteLedger(dbPath);
    expect(second.countEvents('t1')).toBe(2);
    expect(second.replay('t1').hash).toBe(expectedHash);
    second.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('replays legacy invalid continuity proofs fail-closed without rewriting the ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-legacy-continuity-'));
    const dbPath = join(dir, 'legacy.sqlite');
    const profile = defaultProfile('t1');
    const first = new SqliteLedger(dbPath);
    first.appendEvent(ev({
      type: 'newShoeSignal',
      shoeId: 'shoe-1',
      baseline: 'physical-shoe',
      profile: { ...profile, autoConfirmNewShoe: true },
    }, 1));
    first.appendEvent(ev({ type: 'connectionLost' }, 2));
    first.close();

    const legacyEvent = ev({
      type: 'connectionRestored',
      continuityProof: 'synthetic continuity proof',
    }, 3);
    const raw = new Database(dbPath);
    raw.prepare(`
      INSERT INTO events (event_id, table_id, seq, type, payload, payload_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyEvent.eventId,
      legacyEvent.tableId,
      legacyEvent.sourceSeq,
      legacyEvent.type,
      JSON.stringify(legacyEvent),
      'legacy-test-hash',
      legacyEvent.timestamp,
    );
    raw.close();

    const reopened = new SqliteLedger(dbPath);
    const replay = reopened.replay('t1');
    expect(replay.state.get('t1')).toMatchObject({
      status: 'RESYNCING',
      connectionStatus: 'RESYNCING',
      autoBetStatus: 'DISARMED',
    });
    expect(
      (reopened.listEvents('t1')[2] as Extract<NormalizedEvent, { type: 'connectionRestored' }>).continuityProof,
    ).toBe('synthetic continuity proof');
    expect(() => reopened.appendEvent(ev({
      type: 'connectionRestored',
      continuityProof: 'still-invalid',
    }, 4))).toThrowError(ContractValidationError);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats same eventId+payload as idempotent duplicate', () => {
    const led = new SqliteLedger();
    const e = ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...defaultProfile('t1'), autoConfirmNewShoe: true } }, 1);
    expect(led.appendEvent(e)).toBe('appended');
    expect(led.appendEvent(e)).toBe('duplicate');
    expect(led.countEvents('t1')).toBe(1);
    led.close();
  });

  it('treats transport-only replays as idempotent duplicates', () => {
    const led = new SqliteLedger();
    const first = ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...defaultProfile('t1'), autoConfirmNewShoe: true } }, 1);
    const replay = {
      ...first,
      timestamp: '2025-01-01T00:05:00.000Z',
      sourceSeq: 999,
    };
    expect(led.appendEvent(first)).toBe('appended');
    expect(led.appendEvent(replay)).toBe('duplicate');
    expect(led.countEvents('t1')).toBe(1);
    led.close();
  });

  it('rejects same eventId with different payload instead of silently rewriting history', () => {
    const led = new SqliteLedger();
    const first = ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...defaultProfile('t1'), autoConfirmNewShoe: true } }, 1);
    const second = { ...first, shoeId: 's2' };
    led.appendEvent(first);
    expect(() => led.appendEvent(second)).toThrowError(LedgerConflictError);
    led.close();
  });

  it('rejects a same-id handSettled correction on the same shoe', () => {
    const led = new SqliteLedger();
    const first = ev({
      type: 'handSettled',
      shoeId: 'shoe-1',
      handId: 'h1',
      playerCards: [{ rank: 'J' }, { rank: '8' }],
      bankerCards: [{ rank: '9' }, { rank: '4' }],
    }, 2);
    const correction = {
      ...first,
      playerCards: [{ rank: 'A' as const }, { rank: 'A' as const }],
      bankerCards: [{ rank: 'K' as const }, { rank: 'K' as const }],
      sourceSeq: 3,
      timestamp: '2025-01-01T00:05:00.000Z',
    };
    led.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'shoe-1', profile: { ...defaultProfile('t1'), autoConfirmNewShoe: true } }, 1));
    expect(led.appendEvent(first)).toBe('appended');
    expect(() => led.appendEvent(correction)).toThrowError(LedgerConflictError);
    led.close();
  });

  it('keeps the first handSettled when the same id later arrives on a new shoe', () => {
    const led = new SqliteLedger();
    const first = ev({
      type: 'handSettled',
      shoeId: 'bg-C01-1',
      handId: '2098609',
      playerCards: [{ rank: 'J' }, { rank: '8' }],
      bankerCards: [{ rank: '9' }, { rank: '4' }],
    }, 2);
    const replay = {
      ...first,
      shoeId: 'bg-C01-2',
      sourceSeq: 85,
      timestamp: '2025-01-01T00:05:00.000Z',
    };
    expect(led.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'bg-C01-1', profile: { ...defaultProfile('t1'), autoConfirmNewShoe: true } }, 1))).toBe('appended');
    expect(led.appendEvent(first)).toBe('appended');
    expect(led.appendEvent(replay)).toBe('duplicate');
    expect(led.listEvents('t1').filter(event => event.type === 'handSettled')).toEqual([
      expect.objectContaining({ shoeId: 'bg-C01-1', handId: '2098609' }),
    ]);
    led.close();
  });

  it('rejects sourceSeq collisions and keeps original event intact', () => {
    const led = new SqliteLedger();
    led.appendEvent(ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...defaultProfile('t1'), autoConfirmNewShoe: true } }, 1));
    const conflicting = ev({ type: 'shoeConfirmation', shoeId: 's1', approved: true }, 1);
    expect(() => led.appendEvent(conflicting)).toThrowError(LedgerConflictError);
    expect(led.listEvents('t1')).toHaveLength(1);
    expect(led.nextSourceSeq('t1')).toBe(2);
    led.close();
  });

  it('atomically allocates unique sourceSeq values across event producers', () => {
    const led = new SqliteLedger();
    expect(led.allocateSourceSeq('t1')).toBe(1);
    expect(led.allocateSourceSeq('t1', 1_000_000_000)).toBe(1_000_000_000);
    expect(led.allocateSourceSeq('t1')).toBe(1_000_000_001);
    expect(led.allocateSourceSeq('t2')).toBe(1);
    led.close();
  });

  it('allows identical shoe/hand/market receipts and reservations on different tables', () => {
    const led = new SqliteLedger();
    const now = new Date().toISOString();
    const receipt = (tableId: string) => ({
      receiptId: `r-${tableId}`, intentId: `i-${tableId}`, reservationId: `rv-${tableId}`,
      status: 'SIMULATED' as const, amount: 10, market: 'bankerPair' as const, mode: 'simulated' as const,
      createdAt: now,
    });
    expect(led.saveReceipt(receipt('t1'), 't1', 's1', 'h1', 'bankerPair')).toBe(true);
    expect(led.saveReceipt(receipt('t2'), 't2', 's1', 'h1', 'bankerPair')).toBe(true);

    const reservation: RiskReservation = {
      reservationId: 'rv-t1', intentId: 'i-t1', tableId: 't1', shoeId: 's1', handId: 'h1',
      market: 'bankerPair', amount: 10, maxLoss: 10, maxProfit: 110, status: 'RESERVED', createdAt: now,
    };
    expect(led.saveReservation(reservation)).toBe(true);
    expect(led.saveReservation({ ...reservation, reservationId: 'rv-t2', intentId: 'i-t2', tableId: 't2' })).toBe(true);
    led.close();
  });
});
describe('projection state machine hardening', () => {
  it('modelRevision and profileVersion fingerprints include risk-relevant profile fields', () => {
    const base = defaultProfile('t1');
    const a = modelRevisionFor(base);
    expect(modelRevisionFor({ ...base, minEV: 0.01 })).not.toBe(a);
    expect(modelRevisionFor({ ...base, betStrategy: { type: 'fixed', market: 'playerPair' } })).not.toBe(a);
    expect(profileVersionFor(base)).toBeGreaterThan(0);
    expect(profileVersionFor({ ...base, odds: { ...base.odds, bankerPair: { netWin: 12, loss: 1 } } })).not.toBe(profileVersionFor(base));
  });


  it('red card blocks betting windows and disarms auto bet', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...profile, autoConfirmNewShoe: true, autoBetArmedByDefault: true } }, 1),
      ev({ type: 'redCardSeen', shoeId: 's1', handId: 'h1' }, 2),
      ev({ type: 'bettingWindowOpened', shoeId: 's1', handId: 'h1', market: 'bankerPair' }, 3),
    ];
    const state = replayEvents(events).get('t1')!;
    expect(state.status).toBe('RED_CARD_WIND_DOWN');
    expect(state.autoBetStatus).toBe('DISARMED');
    expect(state.redCardSeen).toBe(true);
  });

  it('new shoe subtracts known burn cards from remaining inventory', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({
        type: 'newShoeSignal',
        shoeId: 's1',
        profile: { ...profile, autoConfirmNewShoe: true, burnModel: { kind: 'fullyKnown', count: 1, knownCards: [{ rank: 'A' }] } },
      }, 1),
    ];
    const state = replayEvents(events).get('t1')!;
    expect(state.remainingTotal).toBe(415);
    expect(state.remainingCounts['A']).toBe(31);
    expect(state.seenCards).toHaveLength(0);
  });

  it('manual deck correction preserves seen-card deductions and requires rearm', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h1', card: { rank: 'A' } }, 2),
      ev({ type: 'manualCorrection', shoeId: 's1', correction: { kind: 'numberOfDecks', numberOfDecks: 1 } }, 3),
    ];
    const state = replayEvents(events).get('t1')!;
    expect(state.remainingTotal).toBe(51);
    expect(state.seenCards.length).toBe(1);
    expect(state.profileSnapshot.numberOfDecks).toBe(1);
    expect(state.autoBetStatus).toBe('NEEDS_MANUAL_RECOVERY');
  });

  it('manual correction with requireRearm false keeps current arm status', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...profile, autoConfirmNewShoe: true, autoBetArmedByDefault: true } }, 1),
      ev({ type: 'manualCorrection', shoeId: 's1', correction: { kind: 'numberOfDecks', numberOfDecks: 1, requireRearm: false } }, 2),
    ];
    const state = replayEvents(events).get('t1')!;
    expect(state.autoBetStatus).toBe('ARMED');
  });

  it('refuses to re-arm after red card', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...profile, autoConfirmNewShoe: true, autoBetArmedByDefault: true } }, 1),
      ev({ type: 'redCardSeen', shoeId: 's1', handId: 'h1' }, 2),
      ev({ type: 'autoArmChanged', shoeId: 's1', armed: true }, 3),
    ];
    const state = replayEvents(events).get('t1')!;
    expect(state.autoBetStatus).toBe('DISARMED');
  });

  it('connection loss disarms and requires a proof to leave RESYNCING', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...profile, autoConfirmNewShoe: true, autoBetArmedByDefault: true } }, 1),
      ev({ type: 'connectionLost' }, 2),
      ev({ type: 'connectionRestored' }, 3),
    ];
    const noProof = replayEvents(events).get('t1')!;
    expect(noProof.status).toBe('RESYNCING');
    expect(noProof.connectionStatus).toBe('RESYNCING');
    expect(noProof.autoBetStatus).toBe('DISARMED');

    const withProof = replayEvents([
      ...events.slice(0, 2),
      ev({ type: 'connectionRestored', continuityProof: `cursor-v1:${'a'.repeat(64)}` }, 3),
    ]).get('t1')!;
    expect(withProof.status).toBe('TRACKING');
    expect(withProof.connectionStatus).toBe('CONNECTED');
    expect(withProof.autoBetStatus).toBe('DISARMED');
  });

  it('leaves RESYNCING when the current shoe keeps dealing after a feed gap', () => {
    const profile = defaultProfile('t1');
    const state = replayEvents([
      ev({ type: 'newShoeSignal', shoeId: 's1', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true } }, 1),
      ev({ type: 'connectionLost', reason: 'table-feed-stale' }, 2),
      ev({ type: 'bettingWindowOpened', shoeId: 's1', handId: 'h2', market: 'bankerPair' }, 3),
    ]).get('t1')!;
    expect(state.status).toBe('BETTING_WINDOW');
    expect(state.connectionStatus).toBe('CONNECTED');
    expect(state.shoeBaseline).toBe('physical-shoe');
  });

  it('ignores an extra exhausted-rank card without killing a still-dealable physical shoe', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 's1', baseline: 'physical-shoe', profile: { ...profile, autoConfirmNewShoe: true, numberOfDecks: 1 } }, 1),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h1', card: { rank: 'A' } }, 2),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h2', card: { rank: 'A' } }, 3),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h3', card: { rank: 'A' } }, 4),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h4', card: { rank: 'A' } }, 5),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h5', card: { rank: 'A' } }, 6),
    ];
    const state = replayEvents(events).get('t1');
    expect(state?.shoeBaseline).toBe('physical-shoe');
    expect(state?.seenCards).toHaveLength(4);
    expect(state?.remainingTotal).toBe(48);
  });

  it('rejects malformed event envelopes before mutating projection', () => {
    expect(() => replayEvents([{ type: 'newShoeSignal', eventId: '', tableId: 't1', timestamp: 'bad', sourceSeq: -1, shoeId: 's1' } as unknown as NormalizedEvent])).toThrowError(ContractValidationError);
  });
});

describe('reservations active-key semantics (tombstone regression)', () => {
  const baseTime = '2025-01-01T00:00:00.000Z';
  function rsv(id: string): RiskReservation {
    return {
      reservationId: id,
      intentId: `in-${id}`,
      tableId: 't1',
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 10,
      maxLoss: 20,
      maxProfit: 220,
      status: 'RESERVED',
      createdAt: baseTime,
    };
  }

  it('allows re-reserving a key after release; still rejects a second active reservation', () => {
    const ledger = new SqliteLedger();
    expect(ledger.saveReservation(rsv('r1'))).toBe(true);
    ledger.updateReservation({ ...rsv('r1'), status: 'RELEASED', releasedAt: baseTime, releaseReason: 'executor-timeout' });

    // 修复前:此处抛 LedgerConflictError(RELEASED 墓碑永久占用唯一键)
    expect(ledger.saveReservation(rsv('r2'))).toBe(true);

    // 活跃键互斥语义保持不变
    expect(() => ledger.saveReservation(rsv('r3'))).toThrow(LedgerConflictError);
    expect(ledger.saveReservation(rsv('r2'))).toBe(false); // 同一活跃预留重复保存 → duplicate

    const ids = ledger.listReservations().map(r => r.reservationId).sort();
    expect(ids).toEqual(['r1', 'r2']); // 终态行保留作审计历史
    ledger.close();
  });

  it('migrates a legacy v1 reservations table (global unique key) to the partial active index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-mig-'));
    const dbPath = join(dir, 'legacy.sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO ledger_meta (key, value) VALUES ('schema_version', '1');
      CREATE TABLE reservations (
        reservation_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
        shoe_id TEXT NOT NULL,
        hand_id TEXT NOT NULL,
        market TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(table_id, shoe_id, hand_id, market)
      );
    `);
    const tombstone = JSON.stringify({ ...rsv('legacy-1'), status: 'RELEASED' });
    raw.prepare(
      "INSERT INTO reservations VALUES ('legacy-1','in-legacy-1','t1','s1','h1','bankerPair','RELEASED',?,?)"
    ).run(tombstone, baseTime);
    raw.close();

    // 打开旧库触发 v1→v2 迁移;修复前:墓碑占用键位,新预留必然冲突
    const ledger = new SqliteLedger(dbPath);
    expect(ledger.saveReservation(rsv('fresh-1'))).toBe(true);
    const rows = ledger.listReservations();
    expect(rows.map(r => r.reservationId).sort()).toEqual(['fresh-1', 'legacy-1']);
    expect(rows.find(r => r.reservationId === 'legacy-1')?.status).toBe('RELEASED');
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a hand-window index for reservation summary joins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-index-'));
    const dbPath = join(dir, 'ledger.sqlite');
    try {
      // Given: a newly initialized ledger database.
      const ledger = new SqliteLedger(dbPath);
      ledger.close();

      // When: the reservation indexes are inspected outside the ledger connection.
      const raw = new Database(dbPath, { readonly: true });
      try {
        const indexNames = raw.prepare("SELECT name FROM pragma_index_list('reservations')").pluck().all();

        // Then: income-summary joins can look up one reservation by its full hand key.
        expect(indexNames).toContain('idx_reservations_window');
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps UNKNOWN active per execution source across restart-safe persistence', () => {
    const ledger = new SqliteLedger();
    const unknown: RiskReservation = {
      ...rsv('unknown-keepalive'),
      market: 'banker',
      executionSource: 'keepalive',
      status: 'UNKNOWN',
    };
    expect(ledger.saveReservation(unknown)).toBe(true);
    expect(() => ledger.saveReservation({
      ...unknown,
      reservationId: 'unknown-keepalive-duplicate',
      intentId: 'intent-duplicate',
    })).toThrow(LedgerConflictError);
    expect(ledger.saveReservation({
      ...unknown,
      reservationId: 'manual-same-window',
      intentId: 'intent-manual',
      executionSource: 'manual',
    })).toBe(true);
    ledger.close();
  });
});

describe('operational wager income summary', () => {
  it('includes accepted live operational wagers and their realized pnl', () => {
    const ledger = new SqliteLedger();
    const createdAt = '2026-08-27T01:00:00.000Z';
    const reservation: RiskReservation = {
      reservationId: 'rsv-operational-banker',
      intentId: 'opw-banker',
      tableId: 'D001',
      shoeId: 'shoe-D001',
      handId: 'hand-D001',
      market: 'banker',
      executionSource: 'keepalive',
      amount: 20,
      maxLoss: 20,
      maxProfit: 19,
      status: 'SETTLED',
      createdAt,
      settledAt: '2026-08-27T01:00:30.000Z',
      realizedPnl: 19,
      receiptId: 'receipt-opw-banker',
    };
    ledger.saveReservation(reservation);
    ledger.saveOperationalWager({
      reservationId: reservation.reservationId,
      status: 'ACCEPTED',
      wager: {
        wagerId: reservation.intentId,
        tableId: reservation.tableId,
        shoeId: reservation.shoeId,
        handId: reservation.handId,
        market: 'banker',
        amount: reservation.amount,
        source: 'keepalive',
        createdAt,
      },
      receipt: {
        receiptId: 'receipt-opw-banker',
        wagerId: reservation.intentId,
        tableId: reservation.tableId,
        shoeId: reservation.shoeId,
        handId: reservation.handId,
        market: 'banker',
        amount: reservation.amount,
        source: 'keepalive',
        status: 'ACCEPTED',
        createdAt: '2026-08-27T01:00:02.000Z',
      },
    });

    const summary = ledger.getMonitorSummary();
    expect(summary.rows).toEqual([{
      tableId: 'D001',
      hands: 0,
      bets: 1,
      amount: 20,
      expectedPnl: 0,
      actualPnl: 19,
    }]);
    expect(summary.incomePoints).toEqual([{
      createdAt,
      expectedPnl: 0,
      actualPnl: 19,
    }]);
    ledger.close();
  });

  it('keeps the original UNKNOWN receipt and counts an accepted reconciliation once', () => {
    const ledger = new SqliteLedger();
    const createdAt = '2026-08-28T01:00:00.000Z';
    const record = {
      reservationId: 'rsv-reconciled-banker',
      status: 'UNKNOWN' as const,
      reason: 'platform-acknowledgement-unknown',
      wager: {
        wagerId: 'opw-reconciled-banker',
        tableId: 'D066',
        shoeId: 'shoe-D066',
        handId: 'hand-D066',
        market: 'banker' as const,
        amount: 20,
        source: 'manual' as const,
        createdAt,
      },
      receipt: {
        receiptId: 'receipt-reconciled-banker',
        wagerId: 'opw-reconciled-banker',
        tableId: 'D066',
        shoeId: 'shoe-D066',
        handId: 'hand-D066',
        market: 'banker' as const,
        amount: 20,
        source: 'manual' as const,
        status: 'UNKNOWN' as const,
        createdAt,
        raw: { commitStarted: true, reason: 'result-timeout' },
      },
    };
    ledger.saveOperationalWager(record);
    ledger.saveReservation({
      reservationId: record.reservationId,
      intentId: record.wager.wagerId,
      tableId: record.wager.tableId,
      shoeId: record.wager.shoeId,
      handId: record.wager.handId,
      market: record.wager.market,
      executionSource: record.wager.source,
      amount: 20,
      maxLoss: 20,
      maxProfit: 19,
      status: 'SETTLED',
      createdAt,
      settledAt: '2026-08-28T01:01:00.000Z',
      realizedPnl: 19,
    });
    const reconciliation = {
      status: 'ACCEPTED' as const,
      reason: 'operator-confirmed-platform-accepted' as const,
      reconciledAt: '2026-08-28T01:02:00.000Z',
    };

    const first = ledger.reconcileOperationalWager(record.wager.wagerId, reconciliation);
    const second = ledger.reconcileOperationalWager(record.wager.wagerId, reconciliation);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      status: 'UNKNOWN',
      receipt: { status: 'UNKNOWN', raw: { commitStarted: true } },
      reconciliation,
    });
    expect(ledger.getMonitorSummary()).toMatchObject({
      rows: [{ tableId: 'D066', bets: 1, amount: 20, actualPnl: 19 }],
      incomePoints: [{ createdAt, actualPnl: 19 }],
    });
    expect(() => ledger.reconcileOperationalWager(record.wager.wagerId, {
      ...reconciliation,
      reconciledAt: '2026-08-28T01:03:00.000Z',
    })).toThrow(LedgerConflictError);
    ledger.close();
  });

  it('keeps a committed REJECTED receipt while an accepted reconciliation corrects execution totals', () => {
    const ledger = new SqliteLedger();
    const createdAt = '2026-08-28T02:00:00.000Z';
    const record = {
      reservationId: 'rsv-misclassified-rejection',
      status: 'REJECTED' as const,
      wager: {
        wagerId: 'opw-misclassified-rejection',
        tableId: 'D056',
        shoeId: 'shoe-D056',
        handId: 'GD0562682819B',
        market: 'player' as const,
        amount: 20,
        source: 'keepalive' as const,
        createdAt,
      },
      receipt: {
        receiptId: 'receipt-misclassified-rejection',
        wagerId: 'opw-misclassified-rejection',
        tableId: 'D056',
        shoeId: 'shoe-D056',
        handId: 'GD0562682819B',
        market: 'player' as const,
        amount: 20,
        source: 'keepalive' as const,
        status: 'REJECTED' as const,
        createdAt,
        raw: { commitStarted: true, commitPoint: 'confirmBet', reason: 'platform-rejected' },
      },
    };
    ledger.saveOperationalWager(record);
    ledger.saveReservation({
      reservationId: record.reservationId,
      intentId: record.wager.wagerId,
      tableId: record.wager.tableId,
      shoeId: record.wager.shoeId,
      handId: record.wager.handId,
      market: record.wager.market,
      executionSource: record.wager.source,
      amount: 20,
      maxLoss: 20,
      maxProfit: 20,
      status: 'SETTLED',
      createdAt,
      settledAt: '2026-08-28T02:01:00.000Z',
      realizedPnl: 20,
    });
    const reconciliation = {
      status: 'ACCEPTED' as const,
      reason: 'operator-confirmed-platform-accepted' as const,
      reconciledAt: '2026-08-28T02:02:00.000Z',
    };

    const reconciled = ledger.reconcileOperationalWager(record.wager.wagerId, reconciliation);

    expect(reconciled).toMatchObject({
      status: 'REJECTED',
      receipt: { status: 'REJECTED', raw: { reason: 'platform-rejected' } },
      reconciliation,
    });
    expect(ledger.getMonitorSummary()).toMatchObject({
      rows: [{ tableId: 'D056', bets: 1, amount: 20, actualPnl: 20 }],
    });
    ledger.close();
  });
});


describe('monitor-session baselines', () => {
  it('keeps consuming cards when a mid-shoe attach has no physical inventory baseline', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({
        type: 'newShoeSignal',
        shoeId: 'monitor-session-t1',
        baseline: 'unknown-monitor-session',
        profile: { ...profile, autoConfirmNewShoe: true },
      }, 1),
      ...Array.from({ length: 33 }, (_, index) => ev({
        type: 'cardObserved',
        shoeId: 'monitor-session-t1',
        handId: `h${index + 1}`,
        card: { rank: 'A' },
      }, index + 2)),
    ];

    const projection = replayEvents(events).get('t1');
    expect(projection).toMatchObject({ shoeBaseline: 'unknown-monitor-session' });
    expect(projection?.seenCards).toHaveLength(33);
  });
});

describe('event tail ordering', () => {
  it('returns the newest cross-table event even when another table has a higher local sequence', () => {
    const ledger = new SqliteLedger();
    ledger.appendEvent({
      type: 'connectionRestored',
      eventId: 'd055-high-local-seq',
      tableId: 'D055',
      timestamp: '2026-08-23T07:00:00.000Z',
      sourceSeq: 1_000_000,
    });
    ledger.appendEvent({
      type: 'connectionRestored',
      eventId: 'd056-latest',
      tableId: 'D056',
      timestamp: '2026-08-23T07:00:01.000Z',
      sourceSeq: 1,
    });

    expect(ledger.listEventsTail(1).map(event => event.eventId)).toEqual(['d056-latest']);
    expect(ledger.listEventsPage({ page: 1, pageSize: 1 }).rows.map(event => event.eventId)).toEqual(['d056-latest']);
    ledger.close();
  });

  it('caps connection and arm events to the latest handful', () => {
    const ledger = new SqliteLedger();
    const profile = { ...defaultProfile('t1'), autoConfirmNewShoe: true };
    ledger.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'shoe-1', profile }, 1));
    for (let index = 0; index < 20; index += 1) {
      ledger.appendEvent(ev({ type: 'connectionLost', reason: 'table-feed-stale' }, index * 2 + 2));
      ledger.appendEvent(ev({ type: 'connectionRestored' }, index * 2 + 3));
    }
    const transients = ledger.listEvents('t1').filter(event =>
      event.type === 'connectionLost' || event.type === 'connectionRestored');
    expect(transients).toHaveLength(8);
    ledger.close();
  });

  it('returns only recent cards and settlements for the monitor display', () => {
    const ledger = new SqliteLedger();
    ledger.appendEvent(ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 1));
    ledger.appendEvent(ev({
      type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', position: 'player',
      card: { rank: 'A', suit: 'S' },
    }, 2));
    ledger.appendEvent(ev({
      type: 'handSettled', shoeId: 'shoe-1', handId: 'h1',
      playerCards: [{ rank: 'A', suit: 'S' }, { rank: '2', suit: 'H' }],
      bankerCards: [{ rank: '3', suit: 'C' }, { rank: '4', suit: 'D' }],
      outcomes: { playerPair: false, bankerPair: false },
    }, 3));
    ledger.appendEvent(ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h2', market: 'playerPair' }, 4));

    expect(ledger.listRecentDisplayEvents('t1', 8).map(event => event.type)).toEqual([
      'cardObserved',
      'handSettled',
    ]);
    expect(ledger.listRecentDisplayEventsForTables(['t1'], 8).map(event => event.type)).toEqual([
      'cardObserved',
      'handSettled',
    ]);
    ledger.close();
  });

  it('filters event pages by the market stored in the event payload', () => {
    // Given: events with banker, player, and no market payload.
    const ledger = new SqliteLedger();
    ledger.appendEvent(ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'bankerPair' }, 1));
    ledger.appendEvent(ev({ type: 'bettingWindowOpened', shoeId: 'shoe-1', handId: 'h1', market: 'playerPair' }, 2));
    ledger.appendEvent(ev({ type: 'connectionRestored' }, 3));

    // When: the event page is filtered to banker pair.
    const page = ledger.listEventsPage({ page: 1, pageSize: 20, market: 'bankerPair' });

    // Then: SQLite reads the payload market instead of a nonexistent events.market column.
    expect(page.total).toBe(1);
    expect(page.rows.map(event => event.eventId)).toEqual(['e1']);
    ledger.close();
  });
});

describe('decision hand records', () => {
  it('groups both pair markets into one hand, filters by stored eligibility, and attaches the actual settlement', () => {
    const ledger = new SqliteLedger();
    ledger.saveDecision(decision('d-h1-banker', 'h1', 'bankerPair', true, '2026-08-24T01:00:00.000Z', ['bankerPair']));
    ledger.saveDecision(decision('d-h1-player', 'h1', 'playerPair', true, '2026-08-24T01:00:00.100Z', []));
    ledger.saveDecision(decision('d-h2-banker', 'h2', 'bankerPair', false, '2026-08-24T01:01:00.000Z'));
    ledger.saveDecision(decision('d-h2-player', 'h2', 'playerPair', false, '2026-08-24T01:01:00.100Z'));
    ledger.appendEvent({
      type: 'handSettled',
      eventId: 'settled-h1',
      tableId: 't1',
      timestamp: '2026-08-24T01:00:30.000Z',
      sourceSeq: 1,
      shoeId: 'shoe-1',
      handId: 'h1',
      playerCards: [{ rank: 'A' }, { rank: 'K' }],
      bankerCards: [{ rank: 'Q' }, { rank: 'Q' }],
      outcomes: { bankerPair: true, playerPair: false },
    });

    const eligible = ledger.listDecisionHandsPage({ page: 1, pageSize: 20, eligible: true });
    const ineligible = ledger.listDecisionHandsPage({ page: 1, pageSize: 20, eligible: false });

    expect(eligible.total).toBe(1);
    expect(eligible.rows).toEqual([
      expect.objectContaining({
        tableId: 't1',
        shoeId: 'shoe-1',
        handId: 'h1',
        markets: ['bankerPair', 'playerPair'],
        selectedMarkets: ['bankerPair'],
        eligible: true,
        actualResult: {
          status: 'SETTLED',
          outcomes: { bankerPair: true, playerPair: false },
        },
      }),
    ]);
    expect(ineligible.total).toBe(1);
    expect(ineligible.rows).toEqual([
      expect.objectContaining({
        handId: 'h2',
        eligible: false,
        actualResult: { status: 'PENDING' },
      }),
    ]);
    ledger.close();
  });

  it('distinguishes a settled hand with missing outcomes from a hand that has not settled', () => {
    const ledger = new SqliteLedger();
    ledger.saveDecision(decision('d-h1-banker', 'h1', 'bankerPair', true, '2026-08-24T01:00:00.000Z'));
    ledger.saveDecision(decision('d-h1-player', 'h1', 'playerPair', true, '2026-08-24T01:00:00.100Z'));
    ledger.appendEvent({
      type: 'handSettled',
      eventId: 'settled-h1-without-outcomes',
      tableId: 't1',
      timestamp: '2026-08-24T01:00:30.000Z',
      sourceSeq: 1,
      shoeId: 'shoe-1',
      handId: 'h1',
      playerCards: [{ rank: 'A' }, { rank: 'K' }],
      bankerCards: [{ rank: 'Q' }, { rank: 'J' }],
    });

    expect(ledger.listDecisionHandsPage({ page: 1, pageSize: 20 }).rows[0]?.actualResult).toEqual({ status: 'UNKNOWN' });
    ledger.close();
  });

  it('marks an older unclosed decision as unknown once the next hand has already started', () => {
    // Given: one hand has no settlement event, but a later hand on the same table has a decision.
    const ledger = new SqliteLedger();
    ledger.saveDecision(decision('d-h1-banker', 'h1', 'bankerPair', false, '2026-08-24T01:00:00.000Z'));
    ledger.saveDecision(decision('d-h1-player', 'h1', 'playerPair', false, '2026-08-24T01:00:00.100Z'));
    ledger.saveDecision(decision('d-h2-banker', 'h2', 'bankerPair', false, '2026-08-24T01:01:00.000Z'));
    ledger.saveDecision(decision('d-h2-player', 'h2', 'playerPair', false, '2026-08-24T01:01:00.100Z'));

    // When: the grouped decision history is projected.
    const records = new Map(
      ledger.listDecisionHandsPage({ page: 1, pageSize: 20 }).rows.map(record => [record.handId, record.actualResult]),
    );

    // Then: only the latest active hand is pending; the older missing result is explicitly unknown.
    expect(records.get('h1')).toEqual({ status: 'UNKNOWN' });
    expect(records.get('h2')).toEqual({ status: 'PENDING' });
    ledger.close();
  });

  it('treats partially populated settlement outcomes as unknown on every read path', () => {
    // Given: malformed historical data contains only one of the two pair outcomes.
    const ledger = new SqliteLedger();
    ledger.saveDecision(decision('d-h1-banker', 'h1', 'bankerPair', true, '2026-08-24T01:00:00.000Z'));
    const incompleteSettlement = {
      type: 'handSettled',
      eventId: 'settled-h1-partial-outcomes',
      tableId: 't1',
      timestamp: '2026-08-24T01:00:30.000Z',
      sourceSeq: 1,
      shoeId: 'shoe-1',
      handId: 'h1',
      playerCards: [{ rank: 'A' }, { rank: 'K' }],
      bankerCards: [{ rank: 'Q' }, { rank: 'Q' }],
      outcomes: { bankerPair: true },
    } as unknown as NormalizedEvent;
    ledger.appendEvent(incompleteSettlement);

    // When: decision and ledger settlement projections read that event.
    const decisionResult = ledger.listDecisionHandsPage({ page: 1, pageSize: 20 }).rows[0]?.actualResult;
    const ledgerOutcome = ledger.getSettledOutcome('t1', 'shoe-1', 'h1', 'bankerPair');

    // Then: neither path guesses a hit from an incomplete result.
    expect(decisionResult).toEqual({ status: 'UNKNOWN' });
    expect(ledgerOutcome).toBeUndefined();
    ledger.close();
  });

  it('applies market and hand search filters before grouped pagination', () => {
    const ledger = new SqliteLedger();
    ledger.saveDecision(decision('d-h1-banker', 'h1', 'bankerPair', true, '2026-08-24T01:00:00.000Z'));
    ledger.saveDecision(decision('d-h2-player', 'h2', 'playerPair', false, '2026-08-24T01:01:00.000Z'));

    expect(ledger.listDecisionHandsPage({ page: 1, pageSize: 20, market: 'bankerPair' }).rows.map(row => row.handId)).toEqual(['h1']);
    expect(ledger.listDecisionHandsPage({ page: 1, pageSize: 20, search: 'h2' }).rows.map(row => row.handId)).toEqual(['h2']);
    ledger.close();
  });

  it('counts and paginates complete decision hands instead of raw market rows', () => {
    // Given: three hands, each represented by both pair-market decisions.
    const ledger = new SqliteLedger();
    for (const [index, handId] of ['h1', 'h2', 'h3'].entries()) {
      const createdAt = `2026-08-24T01:0${index}:00.000Z`;
      ledger.saveDecision(decision(`d-${handId}-banker`, handId, 'bankerPair', true, createdAt));
      ledger.saveDecision(decision(`d-${handId}-player`, handId, 'playerPair', true, createdAt));
    }

    // When: each grouped hand is requested on its own page.
    const pages = [1, 2, 3].map(page => ledger.listDecisionHandsPage({ page, pageSize: 1 }));

    // Then: total and pagination operate on three complete hands, never six market rows.
    expect(pages.map(page => page.total)).toEqual([3, 3, 3]);
    expect(pages.flatMap(page => page.rows.map(row => row.handId))).toEqual(['h3', 'h2', 'h1']);
    expect(pages.every(page => page.rows[0]?.markets.length === 2)).toBe(true);
    ledger.close();
  });

  it('keeps identical hand ids isolated across tables and shoes when attaching settlements', () => {
    // Given: the same platform hand id appears in three distinct table/shoe scopes.
    const ledger = new SqliteLedger();
    const scopes = [
      { tableId: 't1', shoeId: 'shoe-1', createdAt: '2026-08-24T01:00:00.000Z' },
      { tableId: 't2', shoeId: 'shoe-1', createdAt: '2026-08-24T01:01:00.000Z' },
      { tableId: 't1', shoeId: 'shoe-2', createdAt: '2026-08-24T01:02:00.000Z' },
    ];
    for (const scope of scopes) {
      for (const market of ['bankerPair', 'playerPair'] as const) {
        ledger.saveDecision({
          ...decision(`d-${scope.tableId}-${scope.shoeId}-${market}`, 'shared-hand', market, true, scope.createdAt),
          tableId: scope.tableId,
          shoeId: scope.shoeId,
        });
      }
    }
    ledger.appendEvent({
      type: 'handSettled',
      eventId: 'settled-t1-shoe-1',
      tableId: 't1',
      timestamp: '2026-08-24T01:00:30.000Z',
      sourceSeq: 1,
      shoeId: 'shoe-1',
      handId: 'shared-hand',
      playerCards: [{ rank: 'A' }, { rank: 'K' }],
      bankerCards: [{ rank: 'Q' }, { rank: 'Q' }],
      outcomes: { bankerPair: true, playerPair: false },
    });
    ledger.appendEvent({
      type: 'handSettled',
      eventId: 'settled-t2-shoe-1',
      tableId: 't2',
      timestamp: '2026-08-24T01:01:30.000Z',
      sourceSeq: 1,
      shoeId: 'shoe-1',
      handId: 'shared-hand',
      playerCards: [{ rank: 'A' }, { rank: 'A' }],
      bankerCards: [{ rank: 'Q' }, { rank: 'J' }],
      outcomes: { bankerPair: false, playerPair: true },
    });

    // When: all grouped decisions are queried.
    const page = ledger.listDecisionHandsPage({ page: 1, pageSize: 20 });
    const results = new Map(page.rows.map(row => [`${row.tableId}|${row.shoeId}`, row.actualResult]));

    // Then: each scope remains a separate row and receives only its own settlement.
    expect(page.total).toBe(3);
    expect(results.get('t1|shoe-1')).toEqual({
      status: 'SETTLED',
      outcomes: { bankerPair: true, playerPair: false },
    });
    expect(results.get('t2|shoe-1')).toEqual({
      status: 'SETTLED',
      outcomes: { bankerPair: false, playerPair: true },
    });
    expect(results.get('t1|shoe-2')).toEqual({ status: 'PENDING' });
    ledger.close();
  });

  it('treats a hand as eligible when either pair market reaches its threshold', () => {
    // Given: one pair market is eligible and the other is not for the same hand.
    const ledger = new SqliteLedger();
    ledger.saveDecision(decision('d-h1-banker', 'h1', 'bankerPair', true, '2026-08-24T01:00:00.000Z'));
    ledger.saveDecision(decision('d-h1-player', 'h1', 'playerPair', false, '2026-08-24T01:00:00.100Z'));

    // When: the grouped decision is queried through both eligibility filters.
    const eligible = ledger.listDecisionHandsPage({ page: 1, pageSize: 20, eligible: true });
    const ineligible = ledger.listDecisionHandsPage({ page: 1, pageSize: 20, eligible: false });
    const bankerOnly = ledger.listDecisionHandsPage({
      page: 1,
      pageSize: 20,
      market: 'bankerPair',
      eligible: true,
    });
    const playerOnly = ledger.listDecisionHandsPage({
      page: 1,
      pageSize: 20,
      market: 'playerPair',
      eligible: false,
    });

    // Then: a bettable market makes the hand eligible exactly once.
    expect(eligible.rows.map(row => row.handId)).toEqual(['h1']);
    expect(ineligible.total).toBe(0);
    expect(bankerOnly.rows[0]).toMatchObject({
      markets: ['bankerPair'],
      eligible: true,
    });
    expect(playerOnly.rows[0]).toMatchObject({
      markets: ['playerPair'],
      eligible: false,
    });
    ledger.close();
  });

  it('attaches a replayed settlement even when its event timestamp predates decision persistence', () => {
    // Given: historical replay persisted its decision after the already-settled event timestamp.
    const ledger = new SqliteLedger();
    ledger.saveDecision(decision('d-replayed', 'replayed-hand', 'bankerPair', true, '2026-08-24T02:00:00.000Z'));
    ledger.appendEvent({
      type: 'handSettled',
      eventId: 'settled-before-persistence',
      tableId: 't1',
      timestamp: '2026-08-24T01:00:00.000Z',
      sourceSeq: 1,
      shoeId: 'shoe-1',
      handId: 'replayed-hand',
      playerCards: [{ rank: 'A' }, { rank: 'K' }],
      bankerCards: [{ rank: 'Q' }, { rank: 'Q' }],
      outcomes: { bankerPair: true, playerPair: false },
    });

    // When: the replayed decision hand is queried.
    const record = ledger.listDecisionHandsPage({ page: 1, pageSize: 20 }).rows[0];

    // Then: exact hand identity wins over wall-clock ordering.
    expect(record?.actualResult).toEqual({
      status: 'SETTLED',
      outcomes: { bankerPair: true, playerPair: false },
    });
    ledger.close();
  });

  it('uses the last appended settlement consistently for decision and ledger lookups', () => {
    // Given: a later correction is appended with an older timestamp and lower source sequence.
    const ledger = new SqliteLedger();
    ledger.saveDecision(decision('d-corrected', 'corrected-hand', 'bankerPair', true, '2026-08-24T00:30:00.000Z'));
    ledger.appendEvent({
      type: 'handSettled',
      eventId: 'settled-original',
      tableId: 't1',
      timestamp: '2026-08-24T02:00:00.000Z',
      sourceSeq: 100,
      shoeId: 'shoe-1',
      handId: 'corrected-hand',
      playerCards: [{ rank: 'A' }, { rank: 'K' }],
      bankerCards: [{ rank: 'Q' }, { rank: 'Q' }],
      outcomes: { bankerPair: true, playerPair: false },
    });
    ledger.appendEvent({
      type: 'handSettled',
      eventId: 'settled-correction',
      tableId: 't1',
      timestamp: '2026-08-24T01:00:00.000Z',
      sourceSeq: 1,
      shoeId: 'shoe-1',
      handId: 'corrected-hand',
      playerCards: [{ rank: 'A' }, { rank: 'K' }],
      bankerCards: [{ rank: 'Q' }, { rank: 'J' }],
      outcomes: { bankerPair: false, playerPair: false },
    });

    // When: both public settlement projections are read.
    const decisionResult = ledger.listDecisionHandsPage({ page: 1, pageSize: 20 }).rows[0]?.actualResult;
    const ledgerOutcome = ledger.getSettledOutcome('t1', 'shoe-1', 'corrected-hand', 'bankerPair');

    // Then: both use the last ledger append as the authoritative correction.
    expect(decisionResult).toEqual({
      status: 'SETTLED',
      outcomes: { bankerPair: false, playerPair: false },
    });
    expect(ledgerOutcome).toBe(false);
    ledger.close();
  });
});

describe('monitor history retention', () => {
  it('keeps recent and reserved hands then drops older monitor events', () => {
    const ledger = new SqliteLedger();
    const profile = { ...defaultProfile('t1'), autoConfirmNewShoe: true };
    ledger.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'shoe-1', profile }, 1));
    let seq = 2;
    for (const handId of ['h1', 'h2', 'h3', 'h4']) {
      ledger.appendEvent(ev({
        type: 'bettingWindowOpened', shoeId: 'shoe-1', handId, market: 'bankerPair',
      }, seq++));
      ledger.appendEvent(ev({
        type: 'cardObserved', shoeId: 'shoe-1', handId, card: { rank: 'A' }, position: 'player',
      }, seq++));
      ledger.appendEvent(ev({
        type: 'cardObserved', shoeId: 'shoe-1', handId, card: { rank: 'K' }, position: 'banker',
      }, seq++));
      ledger.appendEvent(ev({
        type: 'handSettled',
        shoeId: 'shoe-1',
        handId,
        playerCards: [{ rank: 'A' }, { rank: 'K' }],
        bankerCards: [{ rank: 'Q' }, { rank: 'Q' }],
      }, seq++));
      ledger.saveDecision(decision(`d-${handId}`, handId, 'bankerPair', false, `2026-08-24T01:00:0${seq}.000Z`));
    }
    ledger.saveReservation({
      reservationId: 'rsv-h1',
      intentId: 'int-h1',
      tableId: 't1',
      shoeId: 'shoe-1',
      handId: 'h1',
      market: 'player',
      executionSource: 'manual',
      amount: 10,
      maxLoss: 10,
      maxProfit: 9.5,
      status: 'RESERVED',
      createdAt: baseTime,
    });

    ledger.pruneMonitorHistory(2);

    const events = ledger.listEvents('t1');
    const cardHands = [...new Set(events.flatMap(event =>
      event.type === 'cardObserved' && typeof event.handId === 'string' ? [event.handId] : []))];
    const windowHands = [...new Set(events.flatMap(event =>
      event.type === 'bettingWindowOpened' && typeof event.handId === 'string' ? [event.handId] : []))];
    expect(cardHands.sort()).toEqual(['h1', 'h2', 'h3', 'h4']);
    expect(windowHands.sort()).toEqual(['h1', 'h3', 'h4']);
    expect(ledger.listDecisions('t1').map(row => row.handId).sort()).toEqual(['h1', 'h3', 'h4']);
    expect(ledger.listHandCards('t1', 'h2')).toEqual({
      playerCards: [expect.objectContaining({ rank: 'A' })],
      bankerCards: [expect.objectContaining({ rank: 'K' })],
    });
    expect(ledger.listHandCards('t1', 'h4')).toEqual({
      playerCards: [expect.objectContaining({ rank: 'A' })],
      bankerCards: [expect.objectContaining({ rank: 'K' })],
    });
    ledger.close();
  });

  it('keeps previous-shoe settlements for recent decision hands', () => {
    const ledger = new SqliteLedger();
    const profile = { ...defaultProfile('t1'), autoConfirmNewShoe: true };
    ledger.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'shoe-old', profile }, 1));
    ledger.saveDecision(decision('d-old', 'old-h', 'bankerPair', true, '2026-08-24T01:00:00.000Z'));
    ledger.appendEvent(ev({
      type: 'handSettled',
      shoeId: 'shoe-old',
      handId: 'old-h',
      playerCards: [{ rank: 'A' }, { rank: 'K' }],
      bankerCards: [{ rank: 'Q' }, { rank: 'Q' }],
      outcomes: { bankerPair: true, playerPair: false },
    }, 2));
    ledger.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'shoe-new', profile }, 3));
    ledger.appendEvent(ev({
      type: 'cardObserved', shoeId: 'shoe-new', handId: 'new-h', card: { rank: 'A' }, position: 'player',
    }, 4));
    ledger.saveDecision({
      ...decision('d-new', 'new-h', 'bankerPair', false, '2026-08-24T01:02:00.000Z'),
      shoeId: 'shoe-new',
    });

    ledger.pruneMonitorHistory(2);

    expect(ledger.listDecisionHandsPage({ page: 1, pageSize: 20 }).rows).toEqual([
      expect.objectContaining({
        handId: 'new-h',
        actualResult: { status: 'PENDING' },
      }),
      expect.objectContaining({
        handId: 'old-h',
        actualResult: {
          status: 'SETTLED',
          outcomes: { bankerPair: true, playerPair: false },
        },
      }),
    ]);
    expect(ledger.listHandCards('t1', 'old-h').playerCards).toEqual([]);
    ledger.close();
  });

  it('attaches a settlement to the only decision hand even when shoe ids drifted', () => {
    const ledger = new SqliteLedger();
    ledger.saveDecision({
      ...decision('d-drifted', 'same-hand', 'bankerPair', true, '2026-08-24T01:00:00.000Z'),
      shoeId: 'shoe-6',
    });
    ledger.appendEvent({
      type: 'handSettled',
      eventId: 'settled-drifted',
      tableId: 't1',
      timestamp: '2026-08-24T01:00:30.000Z',
      sourceSeq: 1,
      shoeId: 'shoe-2',
      handId: 'same-hand',
      playerCards: [{ rank: 'A' }, { rank: 'K' }],
      bankerCards: [{ rank: 'Q' }, { rank: 'Q' }],
      outcomes: { bankerPair: true, playerPair: false },
    });

    expect(ledger.listDecisionHandsPage({ page: 1, pageSize: 20 }).rows[0]?.actualResult).toEqual({
      status: 'SETTLED',
      outcomes: { bankerPair: true, playerPair: false },
    });
    expect(ledger.getHandSettlement('t1', 'shoe-6', 'same-hand')?.shoeId).toBe('shoe-2');
    ledger.close();
  });

  it('drops previous-shoe cards while keeping the current shoe inventory', () => {
    const ledger = new SqliteLedger();
    const profile = { ...defaultProfile('t1'), autoConfirmNewShoe: true };
    ledger.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'shoe-old', profile }, 1));
    ledger.appendEvent(ev({
      type: 'cardObserved', shoeId: 'shoe-old', handId: 'old-h', card: { rank: '2' }, position: 'player',
    }, 2));
    ledger.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'shoe-new', profile }, 3));
    ledger.appendEvent(ev({
      type: 'cardObserved', shoeId: 'shoe-new', handId: 'new-h', card: { rank: 'A' }, position: 'player',
    }, 4));

    ledger.pruneMonitorHistory(2);

    const events = ledger.listEvents('t1');
    expect(events).toEqual([
      expect.objectContaining({ type: 'newShoeSignal', shoeId: 'shoe-new' }),
      expect.objectContaining({ type: 'cardObserved', handId: 'new-h' }),
    ]);
    expect(ledger.listHandCards('t1', 'new-h').playerCards).toEqual([
      expect.objectContaining({ rank: 'A' }),
    ]);
    expect(ledger.listHandCards('t1', 'old-h').playerCards).toEqual([]);
    ledger.close();
  });

  it('caps hot card and window events per table after settlement', () => {
    const ledger = new SqliteLedger();
    const profile = { ...defaultProfile('t1'), autoConfirmNewShoe: true };
    ledger.appendEvent(ev({ type: 'newShoeSignal', shoeId: 'shoe-1', profile }, 1));
    let seq = 2;
    for (let hand = 0; hand < 20; hand += 1) {
      const handId = `h${hand}`;
      ledger.appendEvent(ev({
        type: 'bettingWindowOpened', shoeId: 'shoe-1', handId, market: 'bankerPair',
      }, seq++));
      ledger.appendEvent(ev({
        type: 'bettingWindowOpened', shoeId: 'shoe-1', handId, market: 'playerPair',
      }, seq++));
      ledger.appendEvent(ev({
        type: 'cardObserved', shoeId: 'shoe-1', handId, card: { rank: 'A' }, position: 'player',
      }, seq++));
      ledger.appendEvent(ev({
        type: 'cardObserved', shoeId: 'shoe-1', handId, card: { rank: 'K' }, position: 'banker',
      }, seq++));
      ledger.appendEvent(ev({
        type: 'bettingWindowClosed', shoeId: 'shoe-1', handId, market: 'bankerPair',
      }, seq++));
      ledger.appendEvent(ev({
        type: 'bettingWindowClosed', shoeId: 'shoe-1', handId, market: 'playerPair',
      }, seq++));
      ledger.appendEvent(ev({
        type: 'handSettled',
        shoeId: 'shoe-1',
        handId,
        playerCards: [{ rank: 'A' }, { rank: '2' }],
        bankerCards: [{ rank: 'K' }, { rank: '3' }],
      }, seq++));
    }
    const events = ledger.listEvents('t1');
    expect(events.filter(event => event.type === 'cardObserved')).toHaveLength(40);
    expect(events.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(8);
    expect(events.filter(event => event.type === 'bettingWindowClosed')).toHaveLength(8);
    ledger.close();
  });

  it('replaces the previous decision for the same hand market', () => {
    const ledger = new SqliteLedger();
    expect(ledger.saveDecision(decision('d1', 'h1', 'bankerPair', false, '2026-08-24T01:00:00.000Z'))).toBe(true);
    expect(ledger.saveDecision(decision('d2', 'h1', 'bankerPair', true, '2026-08-24T01:00:01.000Z'))).toBe(true);
    expect(ledger.listDecisions('t1')).toEqual([
      expect.objectContaining({ snapshotId: 'd2', eligible: true }),
    ]);
    ledger.close();
  });

  it('drops previous-process table feed but keeps money rows', () => {
    const ledger = new SqliteLedger();
    ledger.appendEvent(ev({
      type: 'handSettled',
      shoeId: 'shoe-1',
      handId: 'h1',
      playerCards: [{ rank: 'A', suit: 'S' }, { rank: '2', suit: 'H' }],
      bankerCards: [{ rank: '3', suit: 'C' }, { rank: '4', suit: 'D' }],
      outcomes: { playerPair: false, bankerPair: false },
    }, 1));
    ledger.saveDecision(decision('d1', 'h1', 'bankerPair', false, '2026-09-07T01:00:00.000Z'));
    expect(ledger.countEvents()).toBeGreaterThan(0);
    expect(ledger.listDecisions('t1')).toHaveLength(1);
    ledger.abandonPreviousProcessTableFeed();
    expect(ledger.countEvents()).toBe(0);
    expect(ledger.listDecisions('t1')).toHaveLength(0);
    ledger.close();
  });
});
