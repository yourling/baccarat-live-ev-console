import { describe, expect, it } from 'vitest';
import type { NormalizedEvent, ShoeStateProjection } from '@baccarat/contracts';
import { emptyProjection } from '@baccarat/ledger-state';
import { ShoeHoldPolicy, shoeGenerationOf } from '../src/shoe-hold.js';

function projection(overrides: Partial<ShoeStateProjection> = {}): ShoeStateProjection {
  const base = emptyProjection('t1');
  const current: ShoeStateProjection = {
    ...base,
    shoeId: 'shoe-1',
    shoeBaseline: 'physical-shoe',
    seenCards: [{ rank: 'A' }, { rank: '2' }],
    handNumber: 20,
    remainingTotal: 300,
    ...overrides,
  };
  return current;
}

function newShoeSignal(shoeId: string, overrides: Record<string, unknown> = {}): NormalizedEvent {
  return {
    type: 'newShoeSignal',
    eventId: `evt-${shoeId}`,
    tableId: 't1',
    timestamp: new Date().toISOString(),
    sourceSeq: 1,
    shoeId,
    baseline: 'physical-shoe',
    ...overrides,
  } as NormalizedEvent;
}

function handSettled(shoeId: string, handId: string): NormalizedEvent {
  return {
    type: 'handSettled',
    eventId: `settled-${shoeId}-${handId}`,
    tableId: 't1',
    timestamp: new Date().toISOString(),
    sourceSeq: 2,
    shoeId,
    handId,
    playerCards: [{ rank: 'A' }, { rank: 'K' }],
    bankerCards: [{ rank: '9' }, { rank: '3' }],
    outcomes: { playerPair: false, bankerPair: false },
  } as NormalizedEvent;
}

describe('ShoeHoldPolicy', () => {
  it('holds a premature physical reset and caches the one-shot signal', () => {
    const policy = new ShoeHoldPolicy('t1', () => undefined);
    const current = projection();
    expect(policy.bind(newShoeSignal('shoe-2'), current)).toBeNull();
    expect(policy.isPending()).toBe(true);
    // 信号只缓存最新一份，且 hold 未解除时 drain 不得释放
    expect(policy.deferredSignal?.shoeId).toBe('shoe-2');
    expect(policy.drain(current).signal).toBeUndefined();
  });

  it('does not hold when the road confirms a wrap', () => {
    // handNumber=20 且路子=4：回绕形状确认，hold 出口之一
    const policy = new ShoeHoldPolicy('t1', () => 4);
    const current = projection({ handNumber: 20 });
    expect(policy.shouldHold(current)).toBe(false);
    const released = policy.bind(newShoeSignal('shoe-2'), current);
    expect(released && 'shoeId' in released ? released.shoeId : undefined).toBe('shoe-2');
  });

  it('releases the hold after the 90s timeout as the only fallback when road capture is dead', () => {
    const policy = new ShoeHoldPolicy('t1', () => undefined);
    const current = projection();
    expect(policy.bind(newShoeSignal('shoe-2'), current)).toBeNull();
    // 未超时：仍 hold
    expect(policy.shouldHold(current)).toBe(true);
    // 超时后：shouldHold 为 false，drain 释放缓存信号
    policy.holdSince = Date.now() - 91_000;
    expect(policy.shouldHold(current)).toBe(false);
    const drained = policy.drain(current);
    expect(drained.signal?.shoeId).toBe('shoe-2');
    // drain 后信号不再重复释放
    expect(policy.drain(current).signal).toBeUndefined();
  });

  it('keeps handNumber/remainingTotal frozen hold semantics: exhausted shoes fail closed instead of holding', () => {
    const policy = new ShoeHoldPolicy('t1', () => undefined);
    // 靴已打尽（remaining < 26）：unknown attach 不允许把 live 物理靴抹掉，
    // 但 exhausted 靴必须允许 fail closed —— 不 hold，直接放行
    const exhausted = projection({ remainingTotal: 20 });
    const bound = policy.bind(newShoeSignal('shoe-2', { baseline: 'unknown-monitor-session' }), exhausted);
    expect(bound && 'shoeId' in bound ? bound.shoeId : undefined).toBe('shoe-2');
  });

  it('stashes and replays settlements dropped during the hold, grouped by shoe', () => {
    const policy = new ShoeHoldPolicy('t1', () => undefined);
    const current = projection();
    expect(policy.bind(newShoeSignal('shoe-2'), current)).toBeNull();
    // 同一靴的滞后事件：代际解析失败（无 platformId）→ 走 physical-shoe hold 分支
    const settled = handSettled('shoe-2', 'h1');
    expect(policy.bind(settled, current)).toBeNull();
    expect(policy.bind(handSettled('shoe-2', 'h2'), current)).toBeNull();
    // 超时解除后，drain 释放信号与该靴全部暂存结算
    policy.holdSince = Date.now() - 91_000;
    const drained = policy.drain(current);
    expect(drained.signal?.shoeId).toBe('shoe-2');
    expect(drained.settlements.map(event => (event as { handId: string }).handId)).toEqual(['h1', 'h2']);
    // 暂存只回放一次
    expect(policy.drain(current).settlements).toEqual([]);
  });

  it('reset clears the hold, the cached signal and all stashed settlements', () => {
    const policy = new ShoeHoldPolicy('t1', () => undefined);
    const current = projection();
    policy.bind(newShoeSignal('shoe-2'), current);
    policy.bind(handSettled('shoe-2', 'h1'), current);
    policy.reset();
    expect(policy.isPending()).toBe(false);
    expect(policy.deferredSignal).toBeUndefined();
    expect(policy.heldSettlements.size).toBe(0);
  });

  it('deferring a second signal keeps only the newest shoe (platform switched again)', () => {
    const policy = new ShoeHoldPolicy('t1', () => undefined);
    const current = projection();
    policy.bind(newShoeSignal('shoe-2'), current);
    policy.bind(newShoeSignal('shoe-3'), current);
    policy.holdSince = Date.now() - 91_000;
    expect(policy.drain(current).signal?.shoeId).toBe('shoe-3');
  });

  describe('shoeGenerationOf', () => {
    it('parses generations only for platforms declaring shoeGenerationContinuity', () => {
      const bgEvent = { platformId: 'bg', type: 'handSettled', shoeId: 'bg-B06-12' } as const;
      expect(shoeGenerationOf(bgEvent)).toBe(12);
      // pragmatic / winfinity 不参与代际门控
      expect(shoeGenerationOf({ platformId: 'pragmatic', type: 'handSettled', shoeId: 'pragmatic-abc12345-7' })).toBeUndefined();
      expect(shoeGenerationOf({ platformId: 'winfinity', type: 'handSettled', shoeId: 'wnf-tyn-bac8-wrap-3' })).toBeUndefined();
      // 无平台戳的旧事件：undefined（fail-closed 走 defer）
      expect(shoeGenerationOf({ type: 'handSettled', shoeId: 'bg-B06-12' })).toBeUndefined();
    });
  });
});
