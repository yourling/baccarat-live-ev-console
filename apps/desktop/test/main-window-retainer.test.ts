import { describe, expect, it } from 'vitest';
import { MainWindowRetainer, type CloseObservableWindow } from '../electron-src/main-window-retainer';

class FakeWindow implements CloseObservableWindow {
  private readonly closedListeners = new Set<() => void>();

  on(event: 'closed', listener: () => void): void {
    if (event === 'closed') this.closedListeners.add(listener);
  }

  close(): void {
    for (const listener of this.closedListeners) listener();
  }
}

describe('MainWindowRetainer', () => {
  it('holds a BrowserWindow-equivalent strongly until it closes', () => {
    const retainer = new MainWindowRetainer<FakeWindow>();
    const window = new FakeWindow();

    retainer.retain(window);
    expect(retainer.current()).toBe(window);

    window.close();
    expect(retainer.current()).toBeNull();
  });

  it('does not drop a newer retained window when an older window closes', () => {
    const retainer = new MainWindowRetainer<FakeWindow>();
    const first = new FakeWindow();
    const second = new FakeWindow();

    retainer.retain(first);
    retainer.retain(second);
    first.close();

    expect(retainer.current()).toBe(second);
  });
});
