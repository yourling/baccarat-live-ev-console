import { describe, expect, it, vi } from 'vitest';
import { WINDOWS_IME_MESSAGES, detachWindowsIme } from '../electron-src/windows-ime.js';

describe('detachWindowsIme', () => {
  it('hooks IME messages on Windows and swallows them', () => {
    const hooked: number[] = [];
    const win = {
      hookWindowMessage: vi.fn((message: number, callback: () => unknown) => {
        hooked.push(message);
        expect(callback()).toBe(true);
      }),
    };

    const count = detachWindowsIme(win);

    if (process.platform === 'win32') {
      expect(count).toBe(WINDOWS_IME_MESSAGES.length);
      expect(hooked).toEqual([...WINDOWS_IME_MESSAGES]);
    } else {
      expect(count).toBe(0);
      expect(win.hookWindowMessage).not.toHaveBeenCalled();
    }
  });

  it('is a no-op without a window', () => {
    expect(detachWindowsIme(undefined)).toBe(0);
    expect(detachWindowsIme(null)).toBe(0);
  });
});
