export interface RestorableMainWindow {
  isMinimized(): boolean;
  restore(): void;
  isVisible(): boolean;
  show(): void;
  focus(): void;
}

export function shouldHideMainWindowOnClose(appQuitting: boolean): boolean {
  return !appQuitting;
}

export async function restoreOrCreateMainWindow(
  window: RestorableMainWindow | null,
  createWindow: () => Promise<void>,
): Promise<void> {
  if (window === null) {
    await createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}
