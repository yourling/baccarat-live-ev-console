import { describe, expect, it } from 'vitest';
import { monitorDisplayedRoundLabel } from '../src/ui/monitor-round';

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
});
