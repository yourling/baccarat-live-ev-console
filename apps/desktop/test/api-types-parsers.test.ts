import { describe, expect, it } from 'vitest';
import {
  isDesktopExtensionInstallId,
  parseDesktopExtensionInstallId,
  parseDesktopMonitorTableIds,
  parseDesktopTableSettings,
  parseDesktopUnifiedTableSettings,
  shortExtensionInstallId,
} from '../src/api-types.js';

/**
 * FIX(D-P2-13): IPC 入参解析器。
 *
 * 修复前 `console:update-table-settings` / `update-all-table-settings` /
 * `update-monitor-table-ids` 直接透传到服务层深处，结构错误在那里才炸；
 * 这三个解析器把校验前移到 IPC 边界（与 parseDesktopKeepaliveSettings 同级）。
 */
describe('desktop IPC argument parsers', () => {
  it('accepts a well-formed table settings payload', () => {
    expect(parseDesktopTableSettings({
      minEV: 0.05,
      betTiers: [{ minEV: 0.1, amount: 25 }],
      defaultBetAmount: 20,
      monitorUrl: '窗口-1',
    })).toEqual({
      minEV: 0.05,
      betTiers: [{ minEV: 0.1, amount: 25 }],
      defaultBetAmount: 20,
      monitorUrl: '窗口-1',
    });
  });

  it('treats a missing betTiers as an empty tier list', () => {
    expect(parseDesktopTableSettings({ minEV: 0, defaultBetAmount: 20 })).toEqual({
      minEV: 0,
      betTiers: [],
      defaultBetAmount: 20,
    });
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['array', []],
    ['missing minEV', { defaultBetAmount: 20 }],
    ['NaN minEV', { minEV: Number.NaN, defaultBetAmount: 20 }],
    ['negative defaultBetAmount', { minEV: 0, defaultBetAmount: -1 }],
    ['string defaultBetAmount', { minEV: 0, defaultBetAmount: '20' }],
    ['non-array betTiers', { minEV: 0, defaultBetAmount: 20, betTiers: 'x' }],
    ['bad tier amount', { minEV: 0, defaultBetAmount: 20, betTiers: [{ minEV: 0, amount: 0 }] }],
    ['bad tier minEV', { minEV: 0, defaultBetAmount: 20, betTiers: [{ minEV: -1, amount: 5 }] }],
    ['non-string monitorUrl', { minEV: 0, defaultBetAmount: 20, monitorUrl: 5 }],
  ])('rejects table settings: %s', (_label, value) => {
    expect(() => parseDesktopTableSettings(value)).toThrow();
  });

  it('drops monitorUrl from the unified (all-table) payload', () => {
    expect(parseDesktopUnifiedTableSettings({
      minEV: 0.02,
      betTiers: [],
      defaultBetAmount: 30,
      monitorUrl: 'ignored',
    })).toEqual({ minEV: 0.02, betTiers: [], defaultBetAmount: 30 });
  });

  it('normalizes, dedupes and trims monitor table ids', () => {
    expect(parseDesktopMonitorTableIds([' D055 ', 'D066', 'D055', ''])).toEqual(['D055', 'D066']);
  });

  it.each([
    ['not an array', 'D055'],
    ['non-string entry', ['D055', 5]],
    ['over 64 tables', Array.from({ length: 65 }, (_, index) => `T${index}`)],
  ])('rejects monitor table ids: %s', (_label, value) => {
    expect(() => parseDesktopMonitorTableIds(value)).toThrow();
  });

  it('only accepts 32-hex or UUID extension install ids', () => {
    const hex = 'a'.repeat(32);
    const uuid = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
    expect(isDesktopExtensionInstallId(hex)).toBe(true);
    expect(isDesktopExtensionInstallId(uuid)).toBe(true);
    expect(isDesktopExtensionInstallId('a'.repeat(31))).toBe(false);
    expect(isDesktopExtensionInstallId('not-an-install-id')).toBe(false);
    expect(isDesktopExtensionInstallId(undefined)).toBe(false);
    expect(parseDesktopExtensionInstallId(hex)).toBe(hex);
    expect(() => parseDesktopExtensionInstallId('short')).toThrow(TypeError);
    // UI 只拿前 8 位，完整 installId 不进 snapshot。
    expect(shortExtensionInstallId(hex)).toBe('aaaaaaaa');
  });
});
