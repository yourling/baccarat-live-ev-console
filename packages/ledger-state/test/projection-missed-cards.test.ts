import { describe, expect, it } from 'vitest';
import { applyEvent, countMissingHandCards, emptyProjection, replayEvents } from '../src/projection.js';
import { defaultProfile, type Card, type NormalizedEvent } from '@baccarat/contracts';

/**
 * FIX(C-P1-4): `applySettledHandCards` 的"整手跳过"。
 *
 * 修复前行为（HEAD 225d030，`review/scripts/ledger/a4-a5-projection-inventory.ts` A4-4）：
 *   handSettled 只要该手有任意一张牌进过库存就整手 return，
 *   漏采的张永不扣减 → 4 张的手只采到 1 张时 remainingTotal 停在 415（真值 412），
 *   逐 rank 偏差全为正，封靴线/停注线被整体推迟。
 *
 * 修复后按 position 差集逐张补齐。注意 FIX(P2-4)：**不要**在这里断言对子 EV 的
 * 变化方向 —— 审查用 30 seed 实测（`review/scripts/math/14-missed-card-direction.ts`，
 * 15 正 15 负）证明"漏采 → EV 偏高"不成立，量级 < 0.35pp。
 * 本文件只断言确定成立的量：remainingTotal、seenCards 数量、逐 rank 计数、幂等。
 */

const baseTime = '2026-09-06T15:00:00.000Z';

function ev(partial: object, index: number): NormalizedEvent {
  return {
    ...partial,
    eventId: `e${index}`,
    tableId: 't1',
    timestamp: new Date(Date.parse(baseTime) + index * 1000).toISOString(),
    sourceSeq: index,
    source: 'pragmatic-runtime',
    schemaVersion: 1,
  } as NormalizedEvent;
}

function physicalShoe(index = 1): NormalizedEvent {
  return ev({
    type: 'newShoeSignal',
    shoeId: 'shoe-1',
    baseline: 'physical-shoe',
    profile: { ...defaultProfile('t1'), autoConfirmNewShoe: true },
  }, index);
}

function card(rank: Card['rank'], suit: string, raw: string): Card {
  return { rank, suit, raw };
}

/** 4 张牌的一手：player A♠ K♥ / banker Q♦ J♣。 */
const HAND = {
  playerCards: [card('A', 'S', 'AS'), card('K', 'H', 'KH')],
  bankerCards: [card('Q', 'D', 'QD'), card('J', 'C', 'JC')],
};

function handSettled(index: number, handId = 'h1'): NormalizedEvent {
  return ev({
    type: 'handSettled',
    shoeId: 'shoe-1',
    handId,
    playerCards: HAND.playerCards,
    bankerCards: HAND.bankerCards,
    outcomes: { bankerPair: false, playerPair: false },
  }, index);
}

function observed(index: number, position: string, played: Card, handId = 'h1'): NormalizedEvent {
  return ev({
    type: 'cardObserved',
    shoeId: 'shoe-1',
    handId,
    card: played,
    position,
  }, index);
}

describe('FIX(C-P1-4) settled-hand backfill must not skip a partially observed hand', () => {
  it('backfills 3 of 4 cards when only 1 was observed live (416 → 412, not 415)', () => {
    const state = replayEvents([
      physicalShoe(1),
      observed(2, 'player', HAND.playerCards[0]!),
      handSettled(3),
    ]).get('t1')!;
    // 修复前这里是 415（只扣了 live 采到的那 1 张）。
    expect(state.remainingTotal).toBe(412);
    expect(state.seenCards).toHaveLength(4);
  });

  it('backfills the banker side when both player cards were observed live', () => {
    const state = replayEvents([
      physicalShoe(1),
      observed(2, 'player', HAND.playerCards[0]!),
      observed(3, 'player', HAND.playerCards[1]!),
      handSettled(4),
    ]).get('t1')!;
    expect(state.remainingTotal).toBe(412);
    expect(state.seenCards).toHaveLength(4);
  });

  it('backfills the whole hand when nothing was observed (restart replay path unchanged)', () => {
    const state = replayEvents([
      physicalShoe(1),
      handSettled(2),
    ]).get('t1')!;
    expect(state.remainingTotal).toBe(412);
    expect(state.seenCards).toHaveLength(4);
  });

  it('does not double-deduct when all 4 cards were observed live', () => {
    const state = replayEvents([
      physicalShoe(1),
      observed(2, 'player', HAND.playerCards[0]!),
      observed(3, 'player', HAND.playerCards[1]!),
      observed(4, 'banker', HAND.bankerCards[0]!),
      observed(5, 'banker', HAND.bankerCards[1]!),
      handSettled(6),
    ]).get('t1')!;
    expect(state.remainingTotal).toBe(412);
    expect(state.seenCards).toHaveLength(4);
  });

  it('is idempotent when the same handSettled is delivered twice', () => {
    // 同 eventId 重投（ledger 层会去重，这里直接投给投影，验证投影自身幂等）。
    const first = replayEvents([
      physicalShoe(1),
      observed(2, 'player', HAND.playerCards[0]!),
      handSettled(3),
    ]);
    let state = first;
    state = applyEvent(state, handSettled(4), 4);
    const projection = state.get('t1')!;
    expect(projection.remainingTotal).toBe(412);
    expect(projection.seenCards).toHaveLength(4);
  });

  it('normalizes a winfinity-style position (`player:left`) without double counting', () => {
    const state = replayEvents([
      physicalShoe(1),
      observed(2, 'player:left', HAND.playerCards[0]!),
      handSettled(3),
    ]).get('t1')!;
    // 'player:left' 归一化到 player → 只补 player 的第 2 张 + banker 的 2 张 = 4 张。
    expect(state.remainingTotal).toBe(412);
    expect(state.seenCards).toHaveLength(4);
  });

  it('does not double-deduct a winfinity position that was already counted', () => {
    const state = replayEvents([
      physicalShoe(1),
      observed(2, 'player:left', HAND.playerCards[0]!),
      observed(3, 'player:right', HAND.playerCards[1]!),
      observed(4, 'banker:left', HAND.bankerCards[0]!),
      observed(5, 'banker:right', HAND.bankerCards[1]!),
      handSettled(6),
    ]).get('t1')!;
    expect(state.remainingTotal).toBe(412);
    expect(state.seenCards).toHaveLength(4);
  });

  it('keeps per-rank counts exact after a partial backfill', () => {
    const state = replayEvents([
      physicalShoe(1),
      observed(2, 'player', HAND.playerCards[0]!),
      handSettled(3),
    ]).get('t1')!;
    const [init] = [416];
    expect(init - state.remainingTotal).toBe(4);
    expect(state.remainingCounts.A).toBe(32 - 1);
    expect(state.remainingCounts.K).toBe(32 - 1);
    expect(state.remainingCounts.Q).toBe(32 - 1);
    expect(state.remainingCounts.J).toBe(32 - 1);
  });

  it('reports zero remaining gap once the hand is fully accounted for', () => {
    let state = new Map([['t1', emptyProjection('t1')]]);
    state = applyEvent(state, physicalShoe(1), 1);
    state = applyEvent(state, observed(2, 'player', HAND.playerCards[0]!), 2);
    const before = state.get('t1')!;
    // 补录前：player 缺 1、banker 缺 2 → 3 张。
    expect(countMissingHandCards(before, 'h1', HAND.playerCards, HAND.bankerCards)).toBe(3);
    state = applyEvent(state, handSettled(3), 3);
    const after = state.get('t1')!;
    expect(countMissingHandCards(after, 'h1', HAND.playerCards, HAND.bankerCards)).toBe(0);
  });

  it('does not double-deduct repeated handSettled calls on the same projection state', () => {
    let state = new Map([['t1', emptyProjection('t1')]]);
    state = applyEvent(state, physicalShoe(1), 1);
    state = applyEvent(state, observed(2, 'player', HAND.playerCards[0]!), 2);
    state = applyEvent(state, handSettled(3), 3);
    const once = state.get('t1')!;
    expect(once.remainingTotal).toBe(412);
    // 重复投递同一手的结算：beginHand 会判 stale 直接 break，库存不再变动。
    state = applyEvent(state, handSettled(4), 4);
    const twice = state.get('t1')!;
    expect(twice.remainingTotal).toBe(412);
    expect(twice.seenCards).toHaveLength(4);
  });

  it('never over-consumes when a card is re-reported under a different copyId', () => {
    // 同一位置、不同 copyId 的两张牌（上游 raw 不稳定），差集补齐后该手 key 数
    // 不能超过牌数 —— 否则会把 next-hand 的牌也提前扣掉。
    const state = replayEvents([
      physicalShoe(1),
      observed(2, 'player', card('A', 'S', 'AS-1')),
      observed(3, 'player', card('A', 'S', 'AS-2')),
      handSettled(4),
    ]).get('t1')!;
    expect(state.remainingTotal).toBe(412);
    expect(state.seenCards).toHaveLength(4);
  });
});
