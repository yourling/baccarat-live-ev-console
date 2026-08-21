import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@baccarat/contracts';
import { EvolutionBaccaratParser } from '../src/evolution.js';

describe('evolution baccarat parser', () => {
  it('maps cardDealt into newShoeSignal + cardObserved', () => {
    const parser = new EvolutionBaccaratParser();
    const events = parser.parse(JSON.stringify({
      id: 'msg-1',
      type: 'baccarat.cardDealt',
      args: {
        gameId: 'g1',
        card: '2S',
        spot: 'Banker',
        gameData: {
          playerHand: { cards: ['7D'], score: 7 },
          bankerHand: { cards: ['2S'], score: 2 },
        },
        version: 1,
        tableId: 't1',
      },
    }));

    expect(events.map(event => event.type)).toEqual(['newShoeSignal', 'cardObserved']);
    const card = events[1] as Extract<typeof events[1], { type: 'cardObserved' }>;
    expect(card.tableId).toBe('t1');
    expect(card.handId).toBe('g1');
    expect(card.card).toEqual({ rank: '2', suit: 'S' });
    expect(card.position).toBe('banker');
    expect(card.sourceSeq).toBe(2);
  });

  it('maps gameState result into handSettled with pair outcomes', () => {
    const parser = new EvolutionBaccaratParser();
    const events = parser.parse(JSON.stringify({
      id: 'msg-2',
      type: 'baccarat.gameState',
      args: {
        gameId: 'g1',
        gameNumber: '13:14:21',
        betting: 'BetsClosed',
        dealing: 'Finished',
        gameData: {
          playerHand: { cards: ['7D', '8D'], score: 5 },
          bankerHand: { cards: ['2S', '7H'], score: 9 },
          result: {
            winner: 'Banker',
            playerScore: 5,
            bankerScore: 9,
            playerPair: false,
            bankerPair: true,
            natural: true,
          },
        },
        version: 2,
        tableId: 't1',
      },
    }));

    expect(events.map(event => event.type)).toEqual([
      'newShoeSignal',
      'cardObserved',
      'cardObserved',
      'cardObserved',
      'cardObserved',
      'bettingWindowClosed',
      'bettingWindowClosed',
      'handSettled',
    ]);
    const settled = events[7] as Extract<typeof events[7], { type: 'handSettled' }>;
    expect(settled.playerCards).toEqual([{ rank: '7', suit: 'D' }, { rank: '8', suit: 'D' }]);
    expect(settled.bankerCards).toEqual([{ rank: '2', suit: 'S' }, { rank: '7', suit: 'H' }]);
    expect(settled.outcomes).toEqual({ bankerPair: true, playerPair: false });
  });

  it('detects shoe reset and emits a new shoe signal', () => {
    const parser = new EvolutionBaccaratParser();
    const first = parser.parse(JSON.stringify({
      id: 'shoe-1',
      type: 'baccarat.shoeState',
      args: { stats: { gameCount: 5 }, tableId: 't1' },
    }));
    const second = parser.parse(JSON.stringify({
      id: 'shoe-2',
      type: 'baccarat.shoeState',
      args: { stats: { gameCount: 2 }, tableId: 't1' },
    }));

    expect(first.filter(event => event.type === 'newShoeSignal')).toHaveLength(1);
    const secondShoe = second.filter(event => event.type === 'newShoeSignal');
    expect(secondShoe).toHaveLength(1);
    expect((secondShoe[0] as Extract<typeof secondShoe[0], { type: 'newShoeSignal' }>).shoeId).toBe('evo-t1-2');
  });

  it('assigns contiguous per-table sourceSeq across messages', () => {
    const parser = new EvolutionBaccaratParser();
    const events = [
      ...parser.parse(JSON.stringify({
        id: 'a',
        type: 'baccarat.cardDealt',
        args: { gameId: 'g1', card: 'AS', spot: 'Player', gameData: { playerHand: { cards: ['AS'] }, bankerHand: { cards: [] } }, tableId: 't1' },
      })),
      ...parser.parse(JSON.stringify({
        id: 'b',
        type: 'baccarat.gameState',
        args: { gameId: 'g1', betting: 'BetsClosed', gameData: { playerHand: { cards: ['AS', 'KH'] }, bankerHand: { cards: ['2C', '3D'] }, result: { playerPair: false, bankerPair: false } }, version: 1, tableId: 't1' },
      })),
    ];
    // AS 已在 cardDealt 上报;快照补发 KH/2C/3D 三张,再加两次投注窗口关闭。
    expect(events.map(event => event.sourceSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('emits redCardSeen when cuttingCard/isBurning appears', () => {
    const parser = new EvolutionBaccaratParser();
    const events = parser.parse(JSON.stringify({
      id: 'red-1',
      type: 'baccarat.gameState',
      args: {
        gameId: 'g1',
        cuttingCard: true,
        gameData: { playerHand: { cards: [] }, bankerHand: { cards: [] } },
        tableId: 't1',
      },
    }));
    const red = events.filter(event => event.type === 'redCardSeen');
    expect(red).toHaveLength(1);
    expect((red[0] as Extract<typeof red[0], { type: 'redCardSeen' }>).shoeId).toBe('evo-t1-1');
  });

  it('detects new shoe from shoeCardsOut decrease as a fallback', () => {
    const parser = new EvolutionBaccaratParser();
    const first = parser.parse(JSON.stringify({
      id: 'table-1',
      type: 'baccarat.tableState',
      args: {
        tableId: 't1',
        shoeCardsOut: 100,
        currentGame: { gameId: 'g1', gameData: { playerHand: { cards: [] }, bankerHand: { cards: [] } } },
      },
    }));
    const second = parser.parse(JSON.stringify({
      id: 'table-2',
      type: 'baccarat.tableState',
      args: {
        tableId: 't1',
        shoeCardsOut: 50,
        currentGame: { gameId: 'g2', gameData: { playerHand: { cards: [] }, bankerHand: { cards: [] } } },
      },
    }));
    expect(first.filter(event => event.type === 'newShoeSignal')).toHaveLength(1);
    const secondShoe = second.filter(event => event.type === 'newShoeSignal');
    expect(secondShoe).toHaveLength(1);
    expect((secondShoe[0] as Extract<typeof secondShoe[0], { type: 'newShoeSignal' }>).shoeId).toBe('evo-t1-2');
  });

  it('recovers a missing third card from later snapshots and suppresses duplicates', () => {
    const parser = new EvolutionBaccaratParser();
    const first = parser.parse(JSON.stringify({
      type: 'baccarat.cardDealt',
      args: { tableId: 't1', gameId: 'g1', card: 'AS', spot: 'Player' },
    }));
    const second = parser.parse(JSON.stringify({
      type: 'baccarat.cardDealt',
      args: { tableId: 't1', gameId: 'g1', card: 'KH', spot: 'Player' },
    }));

    // 模拟第三张牌的 cardDealt 消息丢失,只有携带完整牌面的快照到达。
    const snapshot = parser.parse(JSON.stringify({
      type: 'baccarat.tableState',
      args: {
        tableId: 't1',
        currentGame: {
          gameId: 'g1',
          gameData: {
            playerHand: { cards: ['AS', 'KH', '9D'] },
            bankerHand: { cards: ['2C', '3S'] },
          },
        },
      },
    }));

    const cards = [...first, ...second, ...snapshot].filter(
      event => event.type === 'cardObserved'
    ) as Array<Extract<NormalizedEvent, { type: 'cardObserved' }>>;
    expect(cards.map(card => card.card.rank + card.card.suit + ':' + (card.position ?? ''))).toEqual([
      'AS:player',
      'KH:player',
      '9D:player',
      '2C:banker',
      '3S:banker',
    ]);

    // 同一快照重复到达不再补发。
    const repeat = parser.parse(JSON.stringify({
      type: 'baccarat.tableState',
      args: {
        tableId: 't1',
        currentGame: {
          gameId: 'g1',
          gameData: {
            playerHand: { cards: ['AS', 'KH', '9D'] },
            bankerHand: { cards: ['2C', '3S'] },
          },
        },
      },
    }));
    expect(repeat.filter(event => event.type === 'cardObserved')).toHaveLength(0);
  });

  it('does not re-report the same card when cardDealt and snapshot overlap', () => {
    const parser = new EvolutionBaccaratParser();
    const dealt = parser.parse(JSON.stringify({
      type: 'baccarat.cardDealt',
      args: {
        tableId: 't1',
        gameId: 'g1',
        card: '7D',
        spot: 'Banker',
        gameData: { playerHand: { cards: [] }, bankerHand: { cards: ['7D'] } },
      },
    }));
    const snapshot = parser.parse(JSON.stringify({
      type: 'baccarat.gameState',
      args: {
        tableId: 't1',
        gameId: 'g1',
        gameData: { playerHand: { cards: [] }, bankerHand: { cards: ['7D'] } },
      },
    }));
    expect(dealt.filter(event => event.type === 'cardObserved')).toHaveLength(1);
    expect(snapshot.filter(event => event.type === 'cardObserved')).toHaveLength(0);
  });

  it('settles a hand when the result arrives before complete cards', () => {
    const parser = new EvolutionBaccaratParser();
    // 结果先到,但牌面只有一张(EVO 的 result 往往只发一次)。
    const first = parser.parse(JSON.stringify({
      type: 'baccarat.gameState',
      args: {
        tableId: 't1',
        gameId: 'g9',
        gameData: { playerHand: { cards: ['AS'] }, bankerHand: { cards: ['2C'] }, result: { playerPair: false, bankerPair: true } },
        version: 3,
      },
    }));
    expect(first.filter(event => event.type === 'handSettled')).toHaveLength(0);

    // 后续快照补齐牌面,应当用挂起的结果完成结算。
    const second = parser.parse(JSON.stringify({
      type: 'baccarat.tableState',
      args: {
        tableId: 't1',
        currentGame: {
          gameId: 'g9',
          version: 3,
          gameData: { playerHand: { cards: ['AS', '5H', 'JD'] }, bankerHand: { cards: ['2C', '3S'] } },
        },
      },
    }));
    const settled = second.filter(event => event.type === 'handSettled');
    expect(settled).toHaveLength(1);
    const hand = settled[0] as Extract<NormalizedEvent, { type: 'handSettled' }>;
    expect(hand.playerCards).toHaveLength(3);
    expect(hand.bankerCards).toHaveLength(2);
    expect(hand.outcomes).toEqual({ bankerPair: true, playerPair: false });
  });
});
