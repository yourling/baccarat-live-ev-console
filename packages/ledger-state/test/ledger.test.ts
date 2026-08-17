import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { LedgerConflictError, ProjectionError, SqliteLedger, modelRevisionFor, profileVersionFor, replayEvents } from '../src/index.js';
import type { NormalizedEvent, RiskReservation, ShoeStateProjection } from '@baccarat/contracts';
import { ContractValidationError, defaultProfile, newId } from '@baccarat/contracts';

const baseTime = '2025-01-01T00:00:00.000Z';

function ev(partial: any, index: number): NormalizedEvent {
  return { ...partial, eventId: `e${index}`, tableId: 't1', timestamp: new Date(Date.parse(baseTime)+index*1000).toISOString(), sourceSeq: index };
}

describe('ledger replay', () => {
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
      ev({ type: 'cardObserved', shoeId: 'shoe-1', handId: 'h1', card: { rank: 'A' } }, 2),
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

  it('treats same eventId+payload as idempotent duplicate', () => {
    const led = new SqliteLedger();
    const e = ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...defaultProfile('t1'), autoConfirmNewShoe: true } }, 1);
    expect(led.appendEvent(e)).toBe('appended');
    expect(led.appendEvent(e)).toBe('duplicate');
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

  it('rejects sourceSeq collisions and keeps original event intact', () => {
    const led = new SqliteLedger();
    led.appendEvent(ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...defaultProfile('t1'), autoConfirmNewShoe: true } }, 1));
    const conflicting = ev({ type: 'shoeConfirmation', shoeId: 's1', approved: true }, 1);
    expect(() => led.appendEvent(conflicting)).toThrowError(LedgerConflictError);
    expect(led.listEvents('t1')).toHaveLength(1);
    expect(led.nextSourceSeq('t1')).toBe(2);
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
      ev({ type: 'connectionRestored', continuityProof: 'verified-continuity-token' }, 3),
    ]).get('t1')!;
    expect(withProof.status).toBe('TRACKING');
    expect(withProof.connectionStatus).toBe('CONNECTED');
    expect(withProof.autoBetStatus).toBe('DISARMED');
  });

  it('rejects drawing a rank more times than the shoe inventory allows', () => {
    const profile = defaultProfile('t1');
    const events: NormalizedEvent[] = [
      ev({ type: 'newShoeSignal', shoeId: 's1', profile: { ...profile, autoConfirmNewShoe: true, numberOfDecks: 1 } }, 1),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h1', card: { rank: 'A' } }, 2),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h1', card: { rank: 'A' } }, 3),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h1', card: { rank: 'A' } }, 4),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h1', card: { rank: 'A' } }, 5),
      ev({ type: 'cardObserved', shoeId: 's1', handId: 'h1', card: { rank: 'A' } }, 6),
    ];
    expect(() => replayEvents(events)).toThrowError(ProjectionError);
  });

  it('rejects malformed event envelopes before mutating projection', () => {
    expect(() => replayEvents([{ type: 'newShoeSignal', eventId: '', tableId: 't1', timestamp: 'bad', sourceSeq: -1, shoeId: 's1' } as unknown as NormalizedEvent])).toThrowError(ContractValidationError);
  });
});
