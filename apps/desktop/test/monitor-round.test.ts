import { describe, expect, it } from 'vitest';
import { isDisplayedPhysicalShoe, monitorDisplayedRoundLabel } from '../src/ui/monitor-round';
import type { ShoeStateProjection } from '@baccarat/contracts';

function physicalProjection(overrides: {
  readonly tableId?: string;
  readonly handNumber: number;
  readonly remainingTotal: number;
  readonly seenCards?: number;
}): Pick<
  ShoeStateProjection,
  'handNumber' | 'seenCards' | 'remainingTotal' | 'shoeId' | 'shoeBaseline' | 'profileSnapshot'
> {
  const seen = overrides.seenCards ?? Math.max(overrides.handNumber * 4, 0);
  return {
    shoeId: 'shoe-1',
    shoeBaseline: 'physical-shoe',
    handNumber: overrides.handNumber,
    remainingTotal: overrides.remainingTotal,
    seenCards: Array.from({ length: seen }, () => ({ rank: 'A' as const })),
    profileSnapshot: { numberOfDecks: 8 } as ShoeStateProjection['profileSnapshot'],
  };
}

describe('monitorDisplayedRoundLabel', () => {
  it('shows the BG HISTORY road even when internal hand tracking is still at 1', () => {
    expect(monitorDisplayedRoundLabel(
      'A30',
      { currentHandId: '1386500', handNumber: 1 },
      { roundId: '1386500', gameCount: 36 },
    )).toEqual({
      label: '36',
      title: '本靴第 36 局 · 协议 1386500',
      pageRound: 36,
    });
  });

  it('shows the BG shoe road instead of the vendor seqNo', () => {
    expect(monitorDisplayedRoundLabel(
      'B06',
      { currentHandId: '5064039', handNumber: 24 },
      { roundId: '5064039', gameCount: 24 },
    )).toEqual({
      label: '24',
      title: '本靴第 24 局 · 协议 5064039',
      pageRound: 24,
    });
  });

  it('does not show a lagged BG road 29 on a 0-hand shuffled shoe', () => {
    expect(monitorDisplayedRoundLabel(
      'B01',
      { currentHandId: '3822968', handNumber: 0 },
      { roundId: '3822968', gameCount: 29 },
    )).toEqual({
      label: '等待局号',
      title: '等待局号 · 协议 3822968',
      pageRound: undefined,
    });
  });

  it('still shows a live BG bead count of 18 before internal cards catch up', () => {
    expect(monitorDisplayedRoundLabel(
      'B01',
      { currentHandId: '3822968', handNumber: 0 },
      { roundId: '3822968', gameCount: 18 },
    )).toEqual({
      label: '18',
      title: '本靴第 18 局 · 协议 3822968',
      pageRound: 18,
    });
  });

  it('does not display inflated HISTORY 29 when the felt/internal shoe is 局 18', () => {
    expect(monitorDisplayedRoundLabel(
      'B01',
      { currentHandId: '3822968', handNumber: 18 },
      { roundId: '3822968', gameCount: 29 },
    )).toEqual({
      label: '18',
      title: '本靴第 18 局 · 协议 3822968',
      pageRound: 18,
    });
  });

  it('does not display internal 29 when the BG bead plate has already corrected to 18', () => {
    expect(monitorDisplayedRoundLabel(
      'B01',
      { currentHandId: '3822968', handNumber: 29 },
      { roundId: '3822968', gameCount: 18 },
    )).toEqual({
      label: '18',
      title: '本靴第 18 局 · 协议 3822968',
      pageRound: 18,
    });
  });

  it('does not display a stuck wrap-shaped road 3 over a tracked 52-hand shoe', () => {
    expect(monitorDisplayedRoundLabel(
      'C07',
      { currentHandId: '2032112', handNumber: 52 },
      { roundId: '2032112', gameCount: 3 },
    )).toEqual({
      label: '52',
      title: '本靴第 52 局 · 协议 2032112',
      pageRound: 52,
    });
  });


  it('uses protocol hand count when HISTORY window stays at 21 on a deep shoe', () => {
    expect(monitorDisplayedRoundLabel(
      'B01',
      { currentHandId: '3823600', handNumber: 50 },
      { roundId: '3823600', gameCount: 21 },
    )).toEqual({
      label: '50',
      title: '本靴第 50 局 · 协议 3823600',
      pageRound: 50,
    });
  });

  it('shows 洗牌 / 新靴 instead of a lagged road after shuffle', () => {
    expect(monitorDisplayedRoundLabel(
      'C02',
      { currentHandId: '', handNumber: 0, status: 'WAITING_NEW_SHOE' },
      { gameCount: 21 },
      'protocol-shuffle',
    )).toEqual({
      label: '新靴',
      title: '洗牌 / 新靴',
      pageRound: undefined,
    });
  });

  it('keeps pragmatic platform round ids', () => {
    expect(monitorDisplayedRoundLabel(
      'bc281koreanch281',
      { currentHandId: 'GD065268230WF', handNumber: 12 },
      { roundId: 'GD065268230WF', gameCount: 12 },
    )).toMatchObject({
      label: 'GD065268230WF',
    });
  });

  it('shows the Winfinity tile road instead of the round uuid while remaining is unknown', () => {
    expect(monitorDisplayedRoundLabel(
      'tyn-bac2',
      { currentHandId: '01a0865c-d85c-7724-91e5-1c2c9df89c43', handNumber: 6 },
      { gameCount: 55 },
    )).toEqual({
      label: '55',
      title: '本靴第 55 局 · 已跟 6 · 协议 01a0865c-d85c-7724-91e5-1c2c9df89c43',
      pageRound: 55,
      trackedLabel: '已跟 6',
    });
  });

  it('keeps the Winfinity tile as 局号 once remaining matches that shoe', () => {
    expect(monitorDisplayedRoundLabel(
      'tyn-bac2',
      { currentHandId: '01a0865c-d85c-7724-91e5-1c2c9df89c43', handNumber: 8 },
      { gameCount: 8 },
      'protocol-shuffle',
      true,
    )).toEqual({
      label: '8',
      title: '本靴第 8 局 · 协议 01a0865c-d85c-7724-91e5-1c2c9df89c43',
      pageRound: 8,
    });
  });

  it('keeps platform #8 and 已跟 when remaining still belongs to the previous shoe', () => {
    expect(monitorDisplayedRoundLabel(
      'tyn-bac2',
      { currentHandId: '01a0865c-d85c-7724-91e5-1c2c9df89c43', handNumber: 55 },
      { gameCount: 8 },
    )).toEqual({
      label: '8',
      title: '本靴第 8 局 · 已跟 55 · 协议 01a0865c-d85c-7724-91e5-1c2c9df89c43',
      pageRound: 8,
      trackedLabel: '已跟 55',
    });
  });

  it('does not advertise a lagged Winfinity tile after a real shuffle', () => {
    expect(monitorDisplayedRoundLabel(
      'tyn-bac2',
      { currentHandId: '01a0865c-d85c-7724-91e5-1c2c9df89c43', handNumber: 8 },
      { gameCount: 55 },
      'protocol-shuffle',
      true,
    )).toEqual({
      label: '8',
      title: '本靴第 8 局 · 协议 01a0865c-d85c-7724-91e5-1c2c9df89c43',
      pageRound: 8,
    });
  });

  it('omits 已跟 when Winfinity road and internal hands already agree', () => {
    expect(monitorDisplayedRoundLabel(
      'tyn-bac8',
      { currentHandId: 'hand-8', handNumber: 12 },
      { gameCount: 12 },
    )).toEqual({
      label: '12',
      title: '本靴第 12 局 · 协议 hand-8',
      pageRound: 12,
    });
  });

  it('does not let a mid-shoe attach overwrite the Winfinity felt count', () => {
    expect(monitorDisplayedRoundLabel(
      'wnf-64f72a1bc860df661dc2b668',
      { currentHandId: 'hand-1', handNumber: 4 },
      { gameCount: 41 },
    )).toEqual({
      label: '41',
      title: '本靴第 41 局 · 已跟 4 · 协议 hand-1',
      pageRound: 41,
      trackedLabel: '已跟 4',
    });
  });
});

describe('isDisplayedPhysicalShoe', () => {
  it('hides Winfinity remaining when the tile is #8 but inventory is still the previous shoe', () => {
    expect(isDisplayedPhysicalShoe(
      'tyn-bac2',
      physicalProjection({ handNumber: 55, remainingTotal: 131, seenCards: 220 }),
      { reason: 'protocol-shuffle' },
      8,
    )).toBe(false);
  });

  it('shows Winfinity remaining when #8 and inventory both belong to the new shoe', () => {
    expect(isDisplayedPhysicalShoe(
      'tyn-bac2',
      physicalProjection({ handNumber: 8, remainingTotal: 376, seenCards: 40 }),
      { reason: 'protocol-shuffle' },
      8,
    )).toBe(true);
  });

  it('does not hide a live BG shoe when HISTORY is stuck at 局 1-8', () => {
    expect(isDisplayedPhysicalShoe(
      'C07',
      physicalProjection({ handNumber: 52, remainingTotal: 150, seenCards: 210 }),
      { reason: 'protocol-shuffle' },
      3,
    )).toBe(true);
  });
});
