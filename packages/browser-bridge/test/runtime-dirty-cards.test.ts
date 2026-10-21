import { describe, expect, it } from 'vitest';
import { BgRuntimeParser } from '../src/bg-runtime.js';
import { PragmaticRuntimeParser } from '../src/pragmatic-runtime.js';
import { parseCard, parseCards, parseCardsWithDiagnostics } from '../src/runtime-common.js';
import type { NormalizedEvent } from '@baccarat/contracts';

/**
 * FIX(C-P2-5): 一张坏牌毁掉整帧多桌快照。
 *
 * 修复前（`b10c-dirty-card-poisoning.ts` 实证）：
 *   - `parseCard` 直接 `value.trim()`，`null`/数字会抛 TypeError；
 *   - `pragmatic-runtime` / `bg-runtime` 的 `parse()` 逐桌**没有 try/catch**；
 *   - 于是第 2 桌一张 null 牌 → 整帧 3 桌数据全部丢失，且静默无日志。
 *
 * 修复后：parseCard 对非字符串返回 null、脏牌只丢自己；`parse()` 逐桌隔离；
 * 被拒数量进 `parserDiagnostics()`（可观测，不再静默）。
 */

function pragmaticSnapshot(tables: ReadonlyArray<Record<string, unknown>>) {
  return JSON.stringify({
    version: 1,
    view: tables.length > 1 ? 'multi' : 'single',
    observedAt: '2026-09-05T01:00:00.000Z',
    tables,
  });
}

function bgSnapshot(tables: ReadonlyArray<Record<string, unknown>>) {
  return JSON.stringify({
    version: 1,
    view: tables.length > 1 ? 'multi' : 'single',
    observedAt: '2026-09-05T01:00:00.000Z',
    tables,
  });
}

describe('FIX(C-P2-5) dirty cards must not poison a whole multi-table snapshot', () => {
  it('parseCards drops null/number/object/boolean entries instead of throwing', () => {
    expect(parseCards(['AS', null as unknown as string])).toEqual([
      { rank: 'A', suit: 'S', raw: 'AS' },
    ]);
    expect(parseCards(['AS', undefined as unknown as string])).toEqual([
      { rank: 'A', suit: 'S', raw: 'AS' },
    ]);
    expect(parseCards(['AS', 5 as unknown as string])).toEqual([
      { rank: 'A', suit: 'S', raw: 'AS' },
    ]);
    expect(parseCards(['AS', {} as unknown as string])).toEqual([
      { rank: 'A', suit: 'S', raw: 'AS' },
    ]);
    expect(parseCards(['AS', true as unknown as string])).toEqual([
      { rank: 'A', suit: 'S', raw: 'AS' },
    ]);
  });

  it('parseCard returns null for non-strings and unparsable strings', () => {
    expect(parseCard(null)).toBeNull();
    expect(parseCard(undefined)).toBeNull();
    expect(parseCard(5)).toBeNull();
    expect(parseCard({})).toBeNull();
    expect(parseCard('')).toBeNull();
    expect(parseCard('   ')).toBeNull();
    expect(parseCard('not-a-card')).toBeNull();
    expect(parseCard('AS')).toEqual({ rank: 'A', suit: 'S', raw: 'AS' });
  });

  it('parseCardsWithDiagnostics reports how many cards were rejected', () => {
    expect(parseCardsWithDiagnostics(['AS', null, 5, 'KH'])).toEqual({
      cards: [
        { rank: 'A', suit: 'S', raw: 'AS' },
        { rank: 'K', suit: 'H', raw: 'KH' },
      ],
      rejected: 2,
    });
    expect(parseCardsWithDiagnostics(undefined)).toEqual({ cards: [], rejected: 0 });
  });

  it('keeps processing the other two tables when the middle pragmatic table carries a null card', () => {
    const parser = new PragmaticRuntimeParser();
    const events = parser.parse(pragmaticSnapshot([
      {
        tableId: 'goodtable01',
        roundId: 'r-1',
        bettingOpen: false,
        gameSettled: true,
        playerCards: ['AS', '8S'],
        bankerCards: ['AH', '7H'],
        source: 'protocol',
      },
      {
        tableId: 'badtable002',
        roundId: 'r-2',
        bettingOpen: false,
        gameSettled: true,
        // 第 2 桌带一张 null 牌 —— 修复前这里抛 TypeError，整帧 3 桌全丢。
        playerCards: ['AS', null],
        bankerCards: ['AH', '7H'],
        source: 'protocol',
      },
      {
        tableId: 'goodtable03',
        roundId: 'r-3',
        bettingOpen: false,
        gameSettled: true,
        playerCards: ['KS', '9S'],
        bankerCards: ['KH', '8H'],
        source: 'protocol',
      },
    ]));

    const tableIds = new Set(events.map(event => event.tableId));
    expect(tableIds.has('goodtable01')).toBe(true);
    expect(tableIds.has('goodtable03')).toBe(true);
    // 坏牌桌自己的数据仍被处理（只是少了那张空牌），不拖累别桌。
    expect(tableIds.has('badtable002')).toBe(true);
    // 前两张牌：goodtable01 完整 4 张，badtable002 只剩 3 张。
    const goodCards = events.filter(event =>
      event.type === 'cardObserved' && event.tableId === 'goodtable01');
    expect(goodCards).toHaveLength(4);
    // 脏牌被计数（可观测，不再静默）。
    expect(parser.parserDiagnostics('badtable002').rejectedCards).toBe(1);
    expect(parser.parserDiagnostics('goodtable01').rejectedCards).toBe(0);
  });

  it('keeps processing the other two tables when the middle BG table carries a null card', () => {
    const parser = new BgRuntimeParser();
    const events = parser.parse(bgSnapshot([
      {
        tableId: 'B06',
        roundId: 'r-1',
        bettingOpen: false,
        gameSettled: true,
        playerCards: ['AS', '8S'],
        bankerCards: ['AH', '7H'],
        source: 'protocol',
      },
      {
        tableId: 'B07',
        roundId: 'r-2',
        bettingOpen: false,
        gameSettled: true,
        playerCards: ['AS', null],
        bankerCards: ['AH', '7H'],
        source: 'protocol',
      },
      {
        tableId: 'B08',
        roundId: 'r-3',
        bettingOpen: false,
        gameSettled: true,
        playerCards: ['KS', '9S'],
        bankerCards: ['KH', '8H'],
        source: 'protocol',
      },
    ]));

    const tableIds = new Set(events.map(event => event.tableId));
    expect(tableIds.has('B06')).toBe(true);
    expect(tableIds.has('B08')).toBe(true);
    expect(parser.parserDiagnostics('B07').rejectedCards).toBe(1);
  });

  it('drops only the throwing table and keeps the rest when a table payload is structurally broken', () => {
    const parser = new BgRuntimeParser();
    // 先让解析器认识这桌，随后坏帧进来。
    parser.parse(bgSnapshot([{ tableId: 'badtable002', roundId: 'r-0', bettingOpen: true, source: 'protocol' }]));
    // 用会被 JSON.parse 还原成普通对象的坏形状：historyHands 是对象而非数组，
    // 且其中一手的 playerCards 是数字 —— `parse()` 走到 replayHistoryRoad /
    // recordCards 时必然抛错，验证"单桌异常不拖累别桌"。
    const broken = {
      tableId: 'badtable002',
      roundId: 'r-2',
      shuffleEvent: true,
      shoeReset: 'seq:bad',
      gameCount: 5,
      source: 'protocol',
      historyHands: [{ playerCards: 42, bankerCards: ['AH', '7H'] }],
    };
    const events = parser.parse(bgSnapshot([
      { tableId: 'B06', roundId: 'r-1', bettingOpen: true, source: 'protocol' },
      broken,
      { tableId: 'B08', roundId: 'r-3', bettingOpen: true, source: 'protocol' },
    ]));
    // 关键断言：别桌的事件照常产出（修复前整帧丢失）。
    const tableIds = new Set(events.map(event => event.tableId));
    expect(tableIds.has('B06')).toBe(true);
    expect(tableIds.has('B08')).toBe(true);
  });

  it('never throws from parse() on a completely dirty card list', () => {
    const parser = new PragmaticRuntimeParser();
    expect(() => parser.parse(pragmaticSnapshot([{
      tableId: 'dirty001',
      roundId: 'r-1',
      bettingOpen: false,
      gameSettled: true,
      playerCards: [null, 5, {}, true, 'not-a-card'],
      bankerCards: [null, 5],
      source: 'protocol',
    }]))).not.toThrow();
  });
});
