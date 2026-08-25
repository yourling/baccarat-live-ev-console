import { describe, expect, it, vi } from 'vitest';
import { DesktopConsoleService } from '../electron-src/service.js';

describe('DesktopConsoleService snapshot performance', () => {
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
