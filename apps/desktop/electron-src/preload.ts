import { contextBridge, ipcRenderer } from 'electron';
import type { ManualCorrection, NormalizedEvent, RiskLimits, TableProfile } from '@baccarat/contracts';

const api = {
  platform: process.platform as string,
  snapshot: () => ipcRenderer.invoke('console:snapshot'),
  runDemo: (seed?: number) => ipcRenderer.invoke('console:run-demo', seed),
  registerTable: (profile: TableProfile, mode: 'shadow' | 'simulated', amount: number) =>
    ipcRenderer.invoke('console:register-table', profile, mode, amount),
  injectEvent: (event: NormalizedEvent) => ipcRenderer.invoke('console:inject-event', event),
  setAutoBet: (tableId: string, armed: boolean, shoeId?: string) =>
    ipcRenderer.invoke('console:set-auto-bet', tableId, armed, shoeId),
  applyManualCorrection: (tableId: string, correction: ManualCorrection, shoeId?: string) =>
    ipcRenderer.invoke('console:manual-correction', tableId, correction, shoeId),
  updateRiskLimits: (limits: RiskLimits) => ipcRenderer.invoke('console:update-risk-limits', limits),
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('desktop', api);
