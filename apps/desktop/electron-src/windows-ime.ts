/**
 * Windows IME/TSF (especially WeType) runs on the Electron UI thread.
 * A stuck TIP turns the whole console into IsHungAppWindow with a dead
 * Node event loop. Swallow IMM/IME window messages so composition never
 * attaches to the main window. Filter boxes still take physical keys.
 */
export interface WindowMessageHooks {
  hookWindowMessage(message: number, callback: () => unknown): void;
}

/** IMM/IME messages that pull TSF onto the BrowserWindow UI thread. */
export const WINDOWS_IME_MESSAGES = [
  0x010D, // WM_IME_STARTCOMPOSITION
  0x010E, // WM_IME_ENDCOMPOSITION
  0x010F, // WM_IME_COMPOSITION
  0x0281, // WM_IME_SETCONTEXT
  0x0282, // WM_IME_NOTIFY
  0x0283, // WM_IME_CONTROL
  0x0284, // WM_IME_COMPOSITIONFULL
  0x0285, // WM_IME_SELECT
  0x0286, // WM_IME_CHAR
  0x0288, // WM_IME_REQUEST
  0x0290, // WM_IME_KEYDOWN
  0x0291, // WM_IME_KEYUP
] as const;

export function detachWindowsIme(win: WindowMessageHooks | null | undefined): number {
  if (process.platform !== 'win32' || win === null || win === undefined) return 0;
  let hooked = 0;
  for (const message of WINDOWS_IME_MESSAGES) {
    try {
      win.hookWindowMessage(message, () => true);
      hooked += 1;
    } catch {
      // Electron builds without hookWindowMessage must still boot.
    }
  }
  return hooked;
}
