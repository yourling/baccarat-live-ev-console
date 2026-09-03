import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@baccarat/contracts';
import { DesktopConsoleService } from '../electron-src/service';

describe('snapshot light cache invalidation', () => {
  it('does not serve a stale light snapshot after table settings change', async () => {
    const service = new DesktopConsoleService(':memory:');
    try {
      await service.registerTable(defaultProfile('table-1'), 'shadow', 100);
      const cached = service.snapshot({ includeHistory: false });
      expect(cached.snapshot.tables['table-1']?.profile.minEV).toBe(0);

      await service.updateTableSettings('table-1', {
        minEV: 0.05,
        defaultBetAmount: 25,
        betTiers: [{ minEV: 0, amount: 25 }],
      });

      const fresh = service.snapshot({ includeHistory: false });
      expect(fresh.snapshot.tables['table-1']?.profile.minEV).toBe(0.05);
    } finally {
      await service.close();
    }
  });
});
