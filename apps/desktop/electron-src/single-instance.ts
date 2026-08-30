export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
}

/**
 * Acquire Electron's application-wide lock before constructing a bridge or opening SQLite.
 * Returning false means this process has already asked Electron to quit and must do no work.
 */
export function acquireSingleInstance(app: SingleInstanceApp): boolean {
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) app.quit();
  return acquired;
}
