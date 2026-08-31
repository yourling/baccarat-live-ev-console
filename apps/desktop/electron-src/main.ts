import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { DesktopConsoleService } from './service.js';
import { MainWindowRetainer } from './main-window-retainer.js';
import { acquireSingleInstance } from './single-instance.js';
import {
  restoreOrCreateMainWindow,
  shouldHideMainWindowOnClose,
} from './background-lifecycle.js';
import {
  parseDesktopKeepaliveSettings,
  parseDesktopOperationalWagerCommand,
  parseDesktopPendingSettlementCommand,
  parseDesktopUnknownWagerReconciliationCommand,
  parseOneShotLiveBetCommand,
} from '../src/api-types.js';

app.commandLine.appendSwitch('disk-cache-size', '1');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const devUrl = process.env.VITE_DEV_SERVER_URL;
let service: DesktopConsoleService | null = null;
const mainWindowRetainer = new MainWindowRetainer<BrowserWindow>();
type DesktopExecutionMode = 'shadow' | 'live';
let appQuitting = false;

function isDesktopExecutionMode(value: unknown): value is DesktopExecutionMode {
  return value === 'shadow' || value === 'live';
}

function getService(): DesktopConsoleService {
  if (!service) {
    service = new DesktopConsoleService(path.join(app.getPath('userData'), 'console.sqlite'));
  }
  return service;
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    title: '百家乐实时 EV 中控台',
    backgroundColor: '#0b1118',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('desktop window failed to load', { code, description, url });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><html><body style="font-family:sans-serif;background:#0b1118;color:#e6edf3;padding:24px">
       <h1>中控页面加载失败</h1><p>${description} (${code})</p><p>${url}</p></body></html>`,
    )}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('desktop renderer gone', details);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('desktop preload error', preloadPath, error);
  });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });
  win.on('close', event => {
    if (!shouldHideMainWindowOnClose(appQuitting)) return;
    event.preventDefault();
    win.hide();
  });
  mainWindowRetainer.retain(win);
  try {
    if (devUrl) {
      await win.loadURL(devUrl);
    } else {
      await win.loadFile(path.join(__dirname, '../dist/index.html'));
    }
  } catch (error) {
    console.error('desktop window load threw', error);
    if (!win.isDestroyed()) win.show();
    throw error;
  }
  if (!win.isVisible() && !win.isDestroyed()) {
    win.show();
    win.focus();
  }
}

function registerIpc(): void {
  ipcMain.handle('console:snapshot', (_event, options) => getService().snapshot(options));
  ipcMain.handle('console:query-records', (_event, query) => getService().queryRecords(query));
  ipcMain.handle('console:run-demo', (_event, seed?: number) => getService().runDemo(seed));
  ipcMain.handle('console:start-demo', (_event, seed?: number) => getService().startDemo(seed));
  ipcMain.handle('console:stop-demo', () => getService().stopDemo());
  ipcMain.handle('console:set-demo-speed', (_event, speed: number) => getService().setDemoSpeed(speed));
  ipcMain.handle('console:register-table', (_event, profile, mode, amount) =>
    getService().registerTable(profile, mode, amount));
  ipcMain.handle('console:set-auto-bet', (_event, tableId: string, armed: boolean, shoeId?: string) =>
    getService().setAutoBet(tableId, armed, shoeId));
  ipcMain.handle('console:set-execution-mode', async (_event, tableId: string, mode: unknown) => {
    if (!isDesktopExecutionMode(mode)) {
      throw new TypeError(`unsupported execution mode: ${String(mode)}`);
    }
    return getService().setExecutionMode(tableId, mode);
  });
  ipcMain.handle('console:execute-one-shot-live-bet', (_event, command: unknown) =>
    getService().executeOneShotLiveBet(parseOneShotLiveBetCommand(command)));
  ipcMain.handle('console:execute-operational-wager', (_event, command: unknown) =>
    getService().executeOperationalWager(parseDesktopOperationalWagerCommand(command)));
  ipcMain.handle('console:reconcile-unknown-operational-wager', (_event, command: unknown) =>
    getService().reconcileUnknownOperationalWager(
      parseDesktopUnknownWagerReconciliationCommand(command),
    ));
  ipcMain.handle('console:settle-pending-operational-wager', (_event, command: unknown) =>
    getService().settlePendingOperationalWager(
      parseDesktopPendingSettlementCommand(command),
    ));
  ipcMain.handle('console:update-keepalive-settings', (_event, settings: unknown) =>
    getService().updateKeepaliveSettings(parseDesktopKeepaliveSettings(settings)));
  ipcMain.handle('console:set-automation-enabled', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new TypeError('automation enabled must be boolean');
    return getService().setAutomationEnabled(enabled);
  });
  ipcMain.handle('console:acknowledge-runtime-incident', (_event, incidentId: unknown) => {
    if (typeof incidentId !== 'string') throw new TypeError('incident id must be a string');
    return getService().acknowledgeRuntimeIncident(incidentId);
  });
  ipcMain.handle('console:acknowledge-all-runtime-incidents', () =>
    getService().acknowledgeAllRuntimeIncidents());
  ipcMain.handle('console:confirm-physical-shoe', (_event, tableId: string) =>
    getService().confirmPhysicalShoe(tableId));
  ipcMain.handle('console:manual-correction', (_event, tableId: string, correction, shoeId?: string) =>
    getService().applyManualCorrection(tableId, correction, shoeId));
  ipcMain.handle('console:update-risk-limits', (_event, limits) =>
    getService().updateRiskLimits(limits));
  ipcMain.handle('console:update-table-settings', (_event, tableId: string, settings) =>
    getService().updateTableSettings(tableId, settings));
  ipcMain.handle('console:update-all-table-settings', (_event, settings) =>
    getService().updateAllTableSettings(settings));
  ipcMain.handle('console:update-monitor-table-ids', (_event, tableIds: readonly string[]) =>
    getService().updateMonitorTableIds(tableIds));
  ipcMain.handle('console:clear-monitor-data', () => getService().clearMonitorData());
  ipcMain.handle('console:start-live-monitor', (_event, port?: number, executionMode?: 'shadow' | 'simulated' | 'live') =>
    getService().startLiveRoomMonitor(port ?? 17890, executionMode ?? 'live'));
  ipcMain.handle('console:stop-live-monitor', () => getService().stopLiveRoomMonitor());
  ipcMain.handle('console:browser-bridge-status', () => getService().browserBridgeStatus());
}

async function focusExistingMainWindow(): Promise<void> {
  await restoreOrCreateMainWindow(mainWindowRetainer.current(), createWindow);
}

if (acquireSingleInstance(app)) {
  registerIpc();

  app.on('second-instance', () => {
    void focusExistingMainWindow();
  });

  app.whenReady().then(async () => {
    getService();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
    void getService().startLiveRoomMonitor(17890).catch(error => {
      console.error('failed to start live room bridge', error);
    });
  });

  let closing = false;
  app.on('before-quit', (event) => {
    appQuitting = true;
    if (closing || !service) return;
    event.preventDefault();
    closing = true;
    void service.close().finally(() => {
      service = null;
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    // The monitor, bridge, keepalive scheduler, and ledger remain active in the
    // background. Launching the app again restores the retained hidden window.
  });
}
