import { describe, expect, it, vi } from 'vitest';
import { acquireSingleInstance } from '../electron-src/single-instance';

describe('acquireSingleInstance', () => {
  it('continues without quitting when this process owns the Electron instance lock', () => {
    const quit = vi.fn();
    const app = {
      requestSingleInstanceLock: () => true,
      quit,
    };

    expect(acquireSingleInstance(app)).toBe(true);
    expect(quit).not.toHaveBeenCalled();
  });

  it('quits the second process before it can open a competing bridge', () => {
    const quit = vi.fn();
    const app = {
      requestSingleInstanceLock: () => false,
      quit,
    };

    expect(acquireSingleInstance(app)).toBe(false);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
