export interface CloseObservableWindow {
  on(event: 'closed', listener: () => void): unknown;
}

export class MainWindowRetainer<TWindow extends CloseObservableWindow> {
  private retainedWindow: TWindow | null = null;

  retain(window: TWindow): void {
    this.retainedWindow = window;
    window.on('closed', () => {
      if (this.retainedWindow === window) this.retainedWindow = null;
    });
  }

  current(): TWindow | null {
    return this.retainedWindow;
  }
}