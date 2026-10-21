import { describe, expect, it, vi } from 'vitest';
import { defaultProfile } from '@baccarat/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopConsoleService } from '../electron-src/service.js';

/**
 * FIX(D-P2-4): 写路径快照轻量化回归。
 *
 * 修复前 `snapshot()` 默认 `includeHistory !== false`，所有写操作后返回给 UI 的
 * 快照都会全量 `listEvents()/listDecisions()/listReceipts()`：10 万条事件时
 * 单次 610ms / 32.5MB（review 脚本 b8b 实证），而下注/改设置/确认牌靴/勾销/
 * 批准事故全都走这条路。
 */
describe('DesktopConsoleService write-path snapshot weight', () => {
  it('does not load full history for a settings write, but keeps the fields the UI needs', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      // 构造一批历史事件：用 runDemo 写入真实事件（demo 表不进监控列表）。
      await service.runDemo(25);
      const full = service.snapshot();
      expect(full.events.length).toBeGreaterThan(50);

      const ledger = service['ledger'];
      const listEvents = vi.spyOn(ledger, 'listEvents');
      const listDecisions = vi.spyOn(ledger, 'listDecisions');
      const listReceipts = vi.spyOn(ledger, 'listReceipts');

      const written = await service.updateTableSettings('table-1', {
        minEV: 0.05,
        defaultBetAmount: 25,
        betTiers: [],
      });

      // Then: 全量查询根本没被调用。
      expect(listEvents).not.toHaveBeenCalled();
      expect(listDecisions).not.toHaveBeenCalled();
      expect(listReceipts).not.toHaveBeenCalled();
      // And: 历史数组不再随写操作返回（只保留当前显示窗口的显示事件）。
      expect(written.decisions).toHaveLength(0);
      expect(written.receipts).toHaveLength(0);
      expect(written.events.length).toBeLessThan(full.events.length);

      // And: UI 真实需要的字段仍然齐全。
      expect(written.snapshot.tables['table-1']?.profile.minEV).toBe(0.05);
      expect(written.runtime).toBeDefined();
      expect(written.keepalive).toBeDefined();
      expect(written.automation).toBeDefined();
      expect(written.extensionApproval).toBeDefined();
      expect(written.summary).toBeDefined();
      expect(Array.isArray(written.reservations)).toBe(true);
      expect(Array.isArray(written.operationalWagers)).toBe(true);

      listEvents.mockRestore();
      listDecisions.mockRestore();
      listReceipts.mockRestore();
    } finally {
      await service.close();
    }
  });

  it('returns the freshly written state even though the light snapshot cache is warm', async () => {
    // 守着 500ms 轻量缓存与写路径的交互：写操作必须作废缓存，
    // 否则渲染层会拿回写之前的旧配置。
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.registerTable(defaultProfile('table-1'), 'shadow', 100);
      const cached = service.snapshot({ includeHistory: false });
      expect(cached.snapshot.tables['table-1']?.profile.minEV).toBe(0);

      const written = await service.updateTableSettings('table-1', {
        minEV: 0.07,
        defaultBetAmount: 25,
        betTiers: [],
      });

      expect(written.snapshot.tables['table-1']?.profile.minEV).toBe(0.07);
    } finally {
      await service.close();
    }
  });

  it('still exposes reservations to the UI in a light write snapshot', async () => {
    // 预留来自内存（RiskManager），不依赖全量历史查询 —— 这是"轻量快照仍然
    // 能让人工下注/KPI 正常工作"的关键：UNKNOWN 敞口必须出现在 reservations 里。
    const directory = mkdtempSync(join(tmpdir(), 'baccarat-light-snapshot-'));
    const dbPath = join(directory, 'console.sqlite');
    const first = new DesktopConsoleService(dbPath);
    try {
      expect(first['ledger'].saveReservation({
        reservationId: 'light-snapshot-reservation',
        intentId: 'light-snapshot-intent',
        tableId: 'D055',
        shoeId: 'shoe-D055',
        handId: 'hand-D055',
        market: 'banker',
        executionSource: 'manual',
        amount: 20,
        maxLoss: 20,
        maxProfit: 20,
        status: 'UNKNOWN',
        createdAt: '2026-09-07T01:00:01.000Z',
        releaseReason: 'platform-acknowledgement-unknown',
      })).toBe(true);
    } finally {
      await first.close();
    }
    const restarted = new DesktopConsoleService(dbPath);
    try {
      await restarted['startupFailCloseTask'];
      await restarted.updateMonitorTableIds(['D055']);
      const written = await restarted.updateTableSettings('D055', {
        minEV: 0,
        defaultBetAmount: 100,
        betTiers: [],
      });
      expect(written.reservations.map(row => row.reservationId))
        .toContain('light-snapshot-reservation');
    } finally {
      await restarted.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
