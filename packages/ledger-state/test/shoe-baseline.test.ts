import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@baccarat/contracts';
import { emptyProjection } from '../src/projection.js';
import { effectiveShoeBaseline, explainShoeBaseline, initialShoeTotal, isMissedShuffleRoadCount, isPrematurePhysicalShoeReset, isVerifiedPhysicalShoeEvidence, isVerifiedPhysicalShoeReason, isWrapShapedRoadCount, shoeBaselineReasonLabel } from '../src/shoe-baseline.js';

describe('effectiveShoeBaseline', () => {
  it('keeps unknown attach unknown', () => {
    const projection = emptyProjection('bc281koreanch281');
    expect(effectiveShoeBaseline(projection, 55)).toBe('unknown-monitor-session');
    expect(explainShoeBaseline(projection, 55).evidence.reason).toBe('attach');
  });

  it('treats remaining 407 on road #55 with no tracked cards as unknown, not an 8-deck shoe', () => {
    const projection = emptyProjection('bc281koreanch281');
    projection.shoeBaseline = 'physical-shoe';
    projection.profileSnapshot = defaultProfile('bc281koreanch281');
    projection.remainingTotal = 407;
    projection.seenCards = [];
    projection.handNumber = 0;
    expect(effectiveShoeBaseline(projection, 55)).toBe('unknown-monitor-session');
    expect(explainShoeBaseline(projection, 55).evidence.reason).toBe('restart-empty-inventory');
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

  it('does not let a new-process attach token hide a ledger-rebuilt physical shoe', () => {
    const projection = emptyProjection('B01');
    projection.shoeBaseline = 'physical-shoe';
    projection.profileSnapshot = defaultProfile('B01');
    projection.remainingTotal = initialShoeTotal(8) - 80;
    projection.seenCards = Array.from({ length: 80 }, () => ({ rank: 'A' as const }));
    projection.handNumber = 16;
    const explained = explainShoeBaseline(projection, 16, { reason: 'attach', gameCount: 16 });
    expect(explained.baseline).toBe('physical-shoe');
    expect(explained.evidence.reason).toBe('protocol-shuffle');
    expect(effectiveShoeBaseline(projection, 16, { reason: 'attach', gameCount: 16 })).toBe('physical-shoe');
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

  it('redisplays a protocol-shuffled shoe after a feed-gap demotion once the road is still short', () => {
    const projection = emptyProjection('B06');
    projection.shoeBaseline = 'unknown-monitor-session';
    projection.profileSnapshot = defaultProfile('B06');
    projection.remainingTotal = initialShoeTotal(8);
    expect(effectiveShoeBaseline(projection, 2, { reason: 'protocol-shuffle' })).toBe('physical-shoe');
  });

  it('treats a protocol-shuffled shoe with lagged deep road and no cards as 待牌靴', () => {
    const projection = emptyProjection('B01');
    projection.shoeBaseline = 'physical-shoe';
    projection.profileSnapshot = defaultProfile('B01');
    projection.remainingTotal = initialShoeTotal(8);
    projection.seenCards = [];
    projection.handNumber = 0;
    expect(effectiveShoeBaseline(projection, 34, { reason: 'protocol-shuffle' })).toBe('unknown-monitor-session');
    expect(explainShoeBaseline(projection, 34, { reason: 'protocol-shuffle' }).evidence.reason).toBe('restart-empty-inventory');
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

  it('only treats protocol-shuffle, road-wrap, and manual-confirm as verified physical evidence', () => {
    expect(isVerifiedPhysicalShoeReason('protocol-shuffle')).toBe(true);
    expect(isVerifiedPhysicalShoeReason('road-wrap')).toBe(true);
    expect(isVerifiedPhysicalShoeReason('manual-confirm')).toBe(true);
    expect(isVerifiedPhysicalShoeReason('attach')).toBe(false);
    expect(isVerifiedPhysicalShoeReason(undefined)).toBe(false);
    expect(isVerifiedPhysicalShoeEvidence({ reason: 'road-wrap', gameCount: 1 })).toBe(true);
    expect(isVerifiedPhysicalShoeEvidence({ reason: 'road-wrap', gameCount: 8 })).toBe(true);
    expect(isVerifiedPhysicalShoeEvidence({ reason: 'road-wrap', gameCount: 9 })).toBe(false);
    expect(isVerifiedPhysicalShoeEvidence({ reason: 'road-wrap', gameCount: 12 })).toBe(false);
    expect(isVerifiedPhysicalShoeEvidence({ reason: 'road-wrap', gameCount: 20 })).toBe(false);
    expect(isVerifiedPhysicalShoeEvidence({ reason: 'road-wrap', gameCount: 0 })).toBe(false);
    expect(isVerifiedPhysicalShoeEvidence({ reason: 'road-wrap', gameCount: 21 })).toBe(false);
  });


  it('does not let a stuck early HISTORY road hide a tracked deep physical shoe', () => {
    const projection = emptyProjection('C07');
    projection.shoeBaseline = 'physical-shoe';
    projection.profileSnapshot = defaultProfile('C07');
    projection.remainingTotal = 165;
    projection.seenCards = Array.from({ length: 251 }, () => ({ rank: 'A' as const }));
    projection.handNumber = 52;
    expect(isWrapShapedRoadCount(52, 3)).toBe(true);
    expect(isMissedShuffleRoadCount(52, 3)).toBe(false);
    expect(effectiveShoeBaseline(projection, 3, { reason: 'protocol-shuffle' })).toBe('physical-shoe');
    expect(explainShoeBaseline(projection, 3, { reason: 'protocol-shuffle' }).evidence.reason).toBe('protocol-shuffle');
  });

  it('hides exhausted inventory when the live bead plate is still early 局 18', () => {
    const projection = emptyProjection('A05');
    projection.shoeBaseline = 'physical-shoe';
    projection.profileSnapshot = defaultProfile('A05');
    projection.remainingTotal = 90;
    projection.seenCards = Array.from({ length: 326 }, () => ({ rank: 'A' as const }));
    projection.handNumber = 60;
    expect(isMissedShuffleRoadCount(60, 18)).toBe(true);
    expect(effectiveShoeBaseline(projection, 18, { reason: 'protocol-shuffle' })).toBe('unknown-monitor-session');
    expect(explainShoeBaseline(projection, 18, { reason: 'protocol-shuffle' }).evidence.reason).toBe('inventory-contradiction');
  });

  it('hides mixed leftover inventory when a deep shoe still shows 局 1-8', () => {
    const projection = emptyProjection('B17');
    projection.shoeBaseline = 'physical-shoe';
    projection.profileSnapshot = defaultProfile('B17');
    projection.remainingTotal = 30;
    projection.seenCards = Array.from({ length: 386 }, () => ({ rank: 'A' as const }));
    projection.handNumber = 55;
    expect(isWrapShapedRoadCount(55, 1)).toBe(true);
    expect(effectiveShoeBaseline(projection, 1, { reason: 'protocol-shuffle' })).toBe('unknown-monitor-session');
    expect(explainShoeBaseline(projection, 1, { reason: 'protocol-shuffle' }).evidence.reason).toBe('inventory-contradiction');
  });

  it('rejects remaining 22 on road #51 as an impossible physical shoe', () => {
    const projection = emptyProjection('bc281koreanch281');
    projection.shoeBaseline = 'physical-shoe';
    projection.profileSnapshot = defaultProfile('bc281koreanch281');
    projection.remainingTotal = 22;
    projection.handNumber = 51;
    projection.seenCards = Array.from({ length: 20 }, () => ({ rank: 'A' as const }));
    expect(effectiveShoeBaseline(
      projection,
      51,
      { reason: 'road-wrap', previousGameCount: 72, gameCount: 0 },
    )).toBe('unknown-monitor-session');
    expect(explainShoeBaseline(
      projection,
      51,
      { reason: 'road-wrap', previousGameCount: 72, gameCount: 0 },
    ).evidence.reason).toBe('inventory-contradiction');
  });
});

describe('isPrematurePhysicalShoeReset', () => {
  it('holds a mid-shoe physical inventory against a shuffle pulse', () => {
    const projection = emptyProjection('C02');
    projection.shoeBaseline = 'physical-shoe';
    projection.remainingTotal = 307;
    projection.handNumber = 22;
    projection.seenCards = Array.from({ length: 20 }, () => ({ rank: 'A' as const }));
    expect(isPrematurePhysicalShoeReset(projection)).toBe(true);
  });

  it('allows a new shoe near the typical cut or after a deep shoe', () => {
    const nearCut = emptyProjection('C01');
    nearCut.shoeBaseline = 'physical-shoe';
    nearCut.remainingTotal = 149;
    nearCut.handNumber = 54;
    nearCut.seenCards = Array.from({ length: 20 }, () => ({ rank: 'A' as const }));
    expect(isPrematurePhysicalShoeReset(nearCut)).toBe(false);

    const deep = emptyProjection('C01');
    deep.shoeBaseline = 'physical-shoe';
    deep.remainingTotal = 200;
    deep.handNumber = 50;
    deep.seenCards = Array.from({ length: 20 }, () => ({ rank: 'A' as const }));
    expect(isPrematurePhysicalShoeReset(deep)).toBe(false);
  });
});

