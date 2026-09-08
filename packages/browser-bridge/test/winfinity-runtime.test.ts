import { describe, expect, it } from 'vitest';
import {
  WinfinityRuntimeParser,
  normalizeWinfinityTableId,
  publicWinfinityTableId,
} from '../src/winfinity-runtime.js';

const VENDOR = '638f56dc65729f90d0636fb0';
const SHOE_A = 'a6b0945d-1111-4111-8111-aaaaaaaaaaaa';
const SHOE_B = 'b8d70a5b-2222-4222-8222-bbbbbbbbbbbb';
const HAND_1 = '01a08226-087c-72ff-8e0e-a5cd185abc0e';

function wsFrame(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt-1',
    timestamp: '1788889925756',
    type,
    meta: {
      tableId: VENDOR,
      dealerNickName: 'x',
      round: { id: HAND_1, startedAt: '1788889925756', shoeId: SHOE_A },
    },
    ...extra,
  });
}

describe('Winfinity table ids', () => {
  it('uses lowercase stream id when present', () => {
    expect(publicWinfinityTableId({
      streamId: 'TYN-BAC8',
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).toBe('tyn-bac8');
  });

  it('falls back to wnf- prefix and never emits a bare 24-hex id', () => {
    expect(publicWinfinityTableId({
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).toBe('wnf-638f56dc65729f90d0636fb0');
    expect(publicWinfinityTableId({
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).not.toMatch(/^[a-f0-9]{24}$/i);
  });

  it('rejects pragmatic-shaped and bg-shaped ids', () => {
    expect(publicWinfinityTableId({ streamId: 'pragmatictable01' })).toBeUndefined();
    expect(publicWinfinityTableId({ vendorTableId: 'B06' })).toBeUndefined();
    expect(normalizeWinfinityTableId('tyn-bac8')).toBe('tyn-bac8');
    expect(normalizeWinfinityTableId('wnf-638f56dc65729f90d0636fb0')).toBe('wnf-638f56dc65729f90d0636fb0');
    expect(normalizeWinfinityTableId('638f56dc65729f90d0636fb0')).toBeUndefined();
  });

  it('locks the first public id for a vendor table and ignores later aliases', () => {
    const parser = new WinfinityRuntimeParser();
    expect(parser.resolveTableId('638f56dc65729f90d0636fb0')).toBe('wnf-638f56dc65729f90d0636fb0');
    parser.registerAlias('638f56dc65729f90d0636fb0', 'tyn-bac8');
    expect(parser.resolveTableId('638f56dc65729f90d0636fb0')).toBe('wnf-638f56dc65729f90d0636fb0');
  });

  it('uses stream id when the alias is registered before first resolve', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias('638f56dc65729f90d0636fb0', 'TYN-BAC8');
    expect(parser.resolveTableId('638f56dc65729f90d0636fb0')).toBe('tyn-bac8');
  });
});

describe('Winfinity betting windows', () => {
  it('opens pair windows without closesAt when bettingTime is 0', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    const events = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const opened = events.filter(event => event.type === 'bettingWindowOpened');
    expect(opened).toHaveLength(2);
    expect(opened.map(event => event.market).sort()).toEqual(['bankerPair', 'playerPair']);
    expect(opened.every(event => event.tableId === 'tyn-bac8')).toBe(true);
    expect(opened.every(event => event.handId === HAND_1)).toBe(true);
    expect(opened.every(event => event.shoeId === SHOE_A)).toBe(true);
    expect(opened.every(event => !('closesAt' in event) || event.closesAt === undefined)).toBe(true);
  });

  it('updates closesAt on BETS_CLOSING without treating it as a new hand', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const events = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: {
        state: 'BETS_CLOSING',
        bettingTime: '1788889930756',
        bettingTimeDuration: '5000',
        allowedSideBets: [],
      },
    }));
    const opened = events.filter(event => event.type === 'bettingWindowOpened');
    expect(opened).toHaveLength(2);
    expect(opened.every(event => event.closesAt === new Date(1788889930756).toISOString())).toBe(true);
    expect(opened.every(event => event.handId === HAND_1)).toBe(true);
  });

  it('closes windows on GAME_STARTED and does not open a new pair window', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const events = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: {
        state: 'GAME_STARTED',
        bettingTime: '0',
        bettingTimeDuration: '0',
        allowedSideBets: ['PPAIR', 'BPAIR', 'SMALL', 'BIG', 'LUCKY6'],
      },
    }));
    expect(events.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(0);
    expect(events.filter(event => event.type === 'bettingWindowClosed')).toHaveLength(2);
  });
});
