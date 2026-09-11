import { describe, expect, it } from 'vitest';
import { PragmaticPlatformAdapter } from '../src/platform-pragmatic.js';
import { PragmaticRuntimeParser } from '../src/pragmatic-runtime.js';
import { beadSequenceFromHands } from '../src/runtime-common.js';
import { PLATFORM_REGISTRY } from '../src/identity.js';

function snapshot(
  tables: Array<Record<string, unknown>>,
  observedAt = '2026-09-11T01:00:00.000Z',
): string {
  return JSON.stringify({ version: 1, view: 'single', observedAt, tables });
}

describe('beadSequenceFromHands', () => {
  it('keeps only complete hands, sorts by hand id, and derives result + pair marks', () => {
    const beads = beadSequenceFromHands([
      {
        handId: '102',
        // 闲 9 庄 9：和局，无对子。
        playerCards: [{ rank: '5' }, { rank: '4' }],
        bankerCards: [{ rank: '8' }, { rank: 'A' }],
      },
      {
        handId: '101',
        // 闲 8（庄对无、闲对真）庄 7：闲胜，天然停牌，完整。
        playerCards: [{ rank: '9' }, { rank: '9' }],
        bankerCards: [{ rank: '5' }, { rank: '2' }],
      },
      {
        // 闲 5 还需补第三张：不完整，不进珠盘。
        handId: '103',
        playerCards: [{ rank: '2' }, { rank: '3' }],
        bankerCards: [{ rank: '3' }, { rank: '4' }],
      },
    ]);
    expect(beads.map(bead => bead.handId)).toEqual(['101', '102']);
    expect(beads[0]).toEqual({ handId: '101', result: 'player', bankerPair: false, playerPair: true });
    expect(beads[1]).toEqual({ handId: '102', result: 'tie', bankerPair: false, playerPair: false });
  });

  it('supports 通对 (both pairs) and numeric ordering across string hand ids', () => {
    const beads = beadSequenceFromHands([
      {
        handId: '20',
        // 闲 K K（0 点）庄 9 9（8 点天然）：双方停牌完整，双对=通对。
        playerCards: [{ rank: 'K' }, { rank: 'K' }],
        bankerCards: [{ rank: '9' }, { rank: '9' }],
      },
      {
        handId: '3',
        // 闲 8 8（6 点）庄 9 8（7 点）：双方均 6-7 停牌，完整。
        playerCards: [{ rank: '8' }, { rank: '8' }],
        bankerCards: [{ rank: '9' }, { rank: '8' }],
      },
    ]);
    expect(beads.map(bead => bead.handId)).toEqual(['3', '20']);
    expect(beads[0]?.result).toBe('banker');
    expect(beads[0]?.playerPair).toBe(true);
    expect(beads[1]?.bankerPair).toBe(true);
    expect(beads[1]?.playerPair).toBe(true);
  });
});

describe('PragmaticRuntimeParser.beadSequence', () => {
  it('mirrors settled hands of the current shoe and stays empty for unknown tables', () => {
    const parser = new PragmaticRuntimeParser();
    expect(parser.beadSequence('bc281koreanch281')).toEqual([]);

    // 局 1：闲 8 庄 7（闲胜、闲对）。
    parser.parse(snapshot([
      { tableId: 'bc281koreanch281', roundId: '101', gameCount: 35, bettingOpen: false, playerCards: ['9C', '9D'], bankerCards: ['5H', '2D'] },
    ]));
    // 局 2：先开窗建立牌边界，再带牌快照（闲 9 庄 9 = 和局）。
    parser.parse(snapshot([
      { tableId: 'bc281koreanch281', roundId: '102', gameCount: 36, bettingOpen: true, countdown: 9 },
    ], '2026-09-11T01:01:00.000Z'));
    parser.parse(snapshot([
      { tableId: 'bc281koreanch281', roundId: '102', gameCount: 36, bettingOpen: false, playerCards: ['5C', '4D'], bankerCards: ['8H', 'AD'] },
    ], '2026-09-11T01:01:05.000Z'));

    const beads = parser.beadSequence('bc281koreanch281');
    expect(beads.map(bead => bead.handId)).toEqual(['101', '102']);
    expect(beads[0]).toEqual({ handId: '101', result: 'player', bankerPair: false, playerPair: true });
    expect(beads[1]).toEqual({ handId: '102', result: 'tie', bankerPair: false, playerPair: false });

    expect(parser.beadSequence('unknown-table')).toEqual([]);
  });

  it('adapter claims only tables with parser shoe state', () => {
    const adapter = new PragmaticPlatformAdapter(PLATFORM_REGISTRY.get('dafabet-pragmatic')!);
    // 未经过解析器的桌必须返回 undefined（认领语义），不得用空数组抢占其他平台。
    expect(adapter.beadSequence?.('bc281koreanch281')).toBeUndefined();
  });
});
