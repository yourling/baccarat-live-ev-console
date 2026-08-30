import { describe, expect, it } from 'vitest';
import {
  selectPragmaticMonitorTableIds,
} from '../src/ui/monitor-table-selection';

describe('Pragmatic monitor table selection', () => {
  it('selects every unique Pragmatic table in discovery order', () => {
    const candidates = [
      { roomId: 'dafabet-live', tableId: 'D055' },
      ...Array.from({ length: 48 }, (_, index) => ({
        roomId: 'dafabet-pragmatic',
        tableId: `pragmatictable${String(index + 1).padStart(2, '0')}`,
      })),
      { roomId: 'dafabet-pragmatic', tableId: 'pragmatictable01' },
    ];

    const selected = selectPragmaticMonitorTableIds(candidates);

    expect(selected).toHaveLength(48);
    expect(selected[0]).toBe('pragmatictable01');
    expect(selected.at(-1)).toBe('pragmatictable48');
  });
});
