import { describe, expect, it, vi } from 'vitest';
import { DesktopConsoleService } from '../electron-src/service.js';

describe('DesktopConsoleService snapshot performance', () => {
  it('skips summary and record-count queries on a monitor poll', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      const ledger = service['ledger'];
      const listDecisionHandsPage = vi.spyOn(ledger, 'listDecisionHandsPage');
      const listEventsPage = vi.spyOn(ledger, 'listEventsPage');
      const getMonitorSummary = vi.spyOn(ledger, 'getMonitorSummary');

      const snapshot = service.snapshot({
        includeHistory: false,
        includeRecordCounts: false,
        includeSummary: false,
      });

      expect(listDecisionHandsPage).not.toHaveBeenCalled();
      expect(listEventsPage).not.toHaveBeenCalled();
      expect(getMonitorSummary).not.toHaveBeenCalled();
      expect(snapshot.recordCounts).toEqual({ events: 0, decisions: 0, ledger: 0 });
      expect(snapshot.summary).toEqual({ rows: [], incomePoints: [] });
    } finally {
      await service.close();
    }
  });

  it('reuses warmed record counts and summary when the renderer does not need them', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.runDemo(17);
      const warmed = service.snapshot({ includeHistory: false });
      const ledger = service['ledger'];
      const listDecisionHandsPage = vi.spyOn(ledger, 'listDecisionHandsPage');
      const getMonitorSummary = vi.spyOn(ledger, 'getMonitorSummary');

      const snapshot = service.snapshot({
        includeHistory: false,
        includeRecordCounts: false,
        includeSummary: false,
      });

      expect(listDecisionHandsPage).not.toHaveBeenCalled();
      expect(getMonitorSummary).not.toHaveBeenCalled();
      expect(snapshot.recordCounts).toEqual(warmed.recordCounts);
      expect(snapshot.summary).toEqual(warmed.summary);
    } finally {
      await service.close();
    }
  });
});
