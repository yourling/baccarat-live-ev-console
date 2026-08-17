import { describe, expect, it } from 'vitest';
import {
  ContractValidationError,
  assertValidBurnModel,
  assertValidCard,
  assertValidEventEnvelope,
  assertValidRiskLimits,
  assertValidTableProfile,
  defaultProfile,
  defaultRiskLimits,
  initialDeckCounts,
} from '../src/index.js';
describe('contract validation', () => {
  it('accepts a valid table profile', () => {
    expect(() => assertValidTableProfile(defaultProfile('t1'))).not.toThrow();
  });

  it('rejects invalid decks, negative odds and min>max limits', () => {
    expect(() => assertValidTableProfile({ ...defaultProfile('t1'), numberOfDecks: 0 })).toThrowError(ContractValidationError);
    expect(() => assertValidTableProfile({ ...defaultProfile('t1'), numberOfDecks: 21 })).toThrowError(ContractValidationError);
    expect(() => assertValidTableProfile({ ...defaultProfile('t1'), odds: { ...defaultProfile('t1').odds, bankerPair: { netWin: 11, loss: -1 } } })).toThrowError(ContractValidationError);
    expect(() => assertValidTableProfile({ ...defaultProfile('t1'), limits: { minBet: 50, maxBet: 10 } })).toThrowError(ContractValidationError);
  });

  it('rejects bad cards and bad burn models', () => {
    expect(() => assertValidCard({ rank: 'X' } as never)).toThrowError(ContractValidationError);
    expect(() => assertValidBurnModel({ kind: 'countKnown', count: -1 })).toThrowError(ContractValidationError);
    expect(() => assertValidBurnModel({ kind: 'partialKnown', count: 1, knownCards: [{ rank: 'A' }, { rank: 'K' }] })).toThrowError(ContractValidationError);
  });

  it('validates risk limits', () => {
    expect(() => assertValidRiskLimits(defaultRiskLimits)).not.toThrow();
    expect(() => assertValidRiskLimits({ ...defaultRiskLimits, defaultExposureCap: -1 })).toThrowError(ContractValidationError);
    expect(() => assertValidRiskLimits({ ...defaultRiskLimits, maxConcurrentExecutions: 1.5 })).toThrowError(ContractValidationError);
    expect(() => assertValidRiskLimits({ ...defaultRiskLimits, insufficientBehavior: 'explode' as never })).toThrowError(ContractValidationError);
  });

  it('validates event envelopes and schema version', () => {
    const base = { eventId: 'e1', tableId: 't1', timestamp: new Date().toISOString(), sourceSeq: 0 };
    expect(() => assertValidEventEnvelope({ type: 'connectionLost', ...base } as never)).not.toThrow();
    expect(() => assertValidEventEnvelope({ type: 'connectionLost', ...base, eventId: '' } as never)).toThrowError(ContractValidationError);
    expect(() => assertValidEventEnvelope({ type: 'connectionLost', ...base, sourceSeq: -1 } as never)).toThrowError(ContractValidationError);
    expect(() => assertValidEventEnvelope({ type: 'connectionLost', ...base, schemaVersion: 2 } as never)).toThrowError(ContractValidationError);
  });

  it('initialDeckCounts rejects non-positive decks', () => {
    expect(initialDeckCounts(8)['A']).toBe(32);
    expect(() => initialDeckCounts(0)).toThrowError(RangeError);
    expect(() => initialDeckCounts(1.5)).toThrowError(RangeError);
  });

});
