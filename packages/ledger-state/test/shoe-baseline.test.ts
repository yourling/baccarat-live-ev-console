import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@baccarat/contracts';
import { emptyProjection } from '../src/projection.js';
import { effectiveShoeBaseline, explainShoeBaseline, initialShoeTotal, shoeBaselineReasonLabel } from '../src/shoe-baseline.js';

describe('effectiveShoeBaseline', () => {
  it('keeps unknown attach unknown', () => {
    const projection = emptyProjection('bc281koreanch281');
    expect(effectiveShoeBaseline(projection, 55)).toBe('unknown-monitor-session');
    expect(explainShoeBaseline(projection, 55).evidence.reason).toBe('attach');
  });

  it('rejects a physical label with almost-full inventory on a deep road after restart', () => {
    const projection = emptyProjection('bc281koreanch281');
    projection.shoeBaseline = 'physical-shoe';
    projection.profileSnapshot = defaultProfile('bc281koreanch281');
    projection.remainingTotal = initialShoeTotal(8);
    projection.seenCards = [];
    projection.handNumber = 0;
    expect(effectiveShoeBaseline(projection, 55)).toBe('unknown-monitor-session');
    expect(explainShoeBaseline(projection, 55).evidence.reason).toBe('restart-empty-inventory');
    expect(shoeBaselineReasonLabel(explainShoeBaseline(projection, 55).evidence)).toBe('路子已深但未见牌面');
  });

  it('keeps a just-shuffled physical shoe even if the DOM road has not wrapped yet', () => {
    const projection = emptyProjection('bc281koreanch281');
    projection.shoeBaseline = 'physical-shoe';
    projection.profileSnapshot = defaultProfile('bc281koreanch281');
    projection.remainingTotal = initialShoeTotal(8) - 9;
    projection.seenCards = Array.from({ length: 9 }, () => ({ rank: 'A' as const }));
    projection.handNumber = 1;
    expect(effectiveShoeBaseline(projection, 55)).toBe('physical-shoe');
  });

  it('rejects physical inventory that did not decrease across tracked hands', () => {
    const projection = emptyProjection('bc281koreanch281');
    projection.shoeBaseline = 'physical-shoe';
    projection.profileSnapshot = defaultProfile('bc281koreanch281');
    projection.remainingTotal = initialShoeTotal(8) - 2;
    projection.seenCards = [{ rank: 'A' }, { rank: 'K' }];
    projection.handNumber = 10;
    expect(effectiveShoeBaseline(projection)).toBe('unknown-monitor-session');
  });
});
