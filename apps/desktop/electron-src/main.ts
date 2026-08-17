import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { DesktopConsoleService } from './service.js';

const devUrl = process.env.VITE_DEV_SERVER_URL;
let service: DesktopConsoleService | null = null;

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle('console:snapshot', () => getService().snapshot());
  ipcMain.handle('console:run-demo', (_event, seed?: number) => getService().runDemo(seed));
  ipcMain.handle('console:register-table', (_event, profile, mode, amount) =>
    getService().registerTable(profile, mode, amount));
  ipcMain.handle('console:inject-event', (_event, event) => getService().injectEvent(event));
  ipcMain.handle('console:set-auto-bet', (_event, tableId: string, armed: boolean, shoeId?: string) =>
    getService().setAutoBet(tableId, armed, shoeId));
  ipcMain.handle('console:manual-correction', (_event, tableId: string, correction, shoeId?: string) =>
    getService().applyManualCorrection(tableId, correction, shoeId));
  ipcMain.handle('console:update-risk-limits', (_event, limits) =>
    getService().updateRiskLimits(limits));
}

registerIpc();

app.whenReady().then(async () => {
  getService();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

let closing = false;
app.on('before-quit', (event) => {
  if (closing || !service) return;
  event.preventDefault();
  closing = true;
  void service.close().finally(() => {
    service = null;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
