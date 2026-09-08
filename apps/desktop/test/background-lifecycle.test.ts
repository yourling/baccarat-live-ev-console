import { describe, expect, it, vi } from 'vitest';
import {
  canOpenLiveDealerVideoPage,
  restoreOrCreateMainWindow,
  shouldHideMainWindowOnClose,
} from '../electron-src/background-lifecycle.js';

describe('desktop background lifecycle', () => {
  it('lets closing the main window quit the app', () => {
    expect(shouldHideMainWindowOnClose(false)).toBe(false);
    expect(shouldHideMainWindowOnClose(true)).toBe(false);
  });

  it('does not open live-dealer GPU video pages off Windows', () => {
    expect(canOpenLiveDealerVideoPage('win32')).toBe(true);
    expect(canOpenLiveDealerVideoPage('linux')).toBe(false);
    expect(canOpenLiveDealerVideoPage('darwin')).toBe(false);
  });

  it('restores a hidden window for a second app launch and creates one only when missing', async () => {
    const hiddenWindow = {
      isMinimized: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      isVisible: vi.fn().mockReturnValue(false),
      show: vi.fn(),
      focus: vi.fn(),
    };
    const create = vi.fn().mockResolvedValue(undefined);

    await restoreOrCreateMainWindow(hiddenWindow, create);

    expect(hiddenWindow.show).toHaveBeenCalledOnce();
    expect(hiddenWindow.focus).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();

    await restoreOrCreateMainWindow(null, create);
    expect(create).toHaveBeenCalledOnce();
  });
});
