import { contextBridge, ipcRenderer } from 'electron';
import type { BetTier, ManualCorrection, RiskLimits, TableProfile } from '@baccarat/contracts';
import type {
  DesktopRecordPage,
  DesktopRecordQuery,
  DesktopKeepaliveStrategySettings,
  DesktopOperationalWagerCommand,
  DesktopOperationalWagerResult,
  DesktopUnknownWagerReconciliationCommand,
  DesktopSnapshotOptions,
  OneShotLiveBetCommand,
  OneShotLiveBetResult,
} from '../src/api-types.js';

const api = {
  platform: process.platform as string,
  snapshot: (options?: DesktopSnapshotOptions) => ipcRenderer.invoke('console:snapshot', options),
  queryRecords: (query: DesktopRecordQuery) => ipcRenderer.invoke('console:query-records', query),
  runDemo: (seed?: number) => ipcRenderer.invoke('console:run-demo', seed),
  startDemo: (seed?: number) => ipcRenderer.invoke('console:start-demo', seed),
  stopDemo: () => ipcRenderer.invoke('console:stop-demo'),
  setDemoSpeed: (speed: number) => ipcRenderer.invoke('console:set-demo-speed', speed),
  registerTable: (profile: TableProfile, mode: 'shadow' | 'simulated' | 'live', amount: number) =>
    ipcRenderer.invoke('console:register-table', profile, mode, amount),
  setAutoBet: (tableId: string, armed: boolean, shoeId?: string) =>
    ipcRenderer.invoke('console:set-auto-bet', tableId, armed, shoeId),
  setExecutionMode: (tableId: string, mode: 'shadow' | 'live') =>
    ipcRenderer.invoke('console:set-execution-mode', tableId, mode),
  executeOneShotLiveBet: (command: OneShotLiveBetCommand): Promise<OneShotLiveBetResult> =>
    ipcRenderer.invoke('console:execute-one-shot-live-bet', command),
  executeOperationalWager: (command: DesktopOperationalWagerCommand): Promise<DesktopOperationalWagerResult> =>
    ipcRenderer.invoke('console:execute-operational-wager', command),
  reconcileUnknownOperationalWager: (command: DesktopUnknownWagerReconciliationCommand) =>
    ipcRenderer.invoke('console:reconcile-unknown-operational-wager', command),
  updateKeepaliveSettings: (settings: DesktopKeepaliveStrategySettings) =>
    ipcRenderer.invoke('console:update-keepalive-settings', settings),
  setAutomationEnabled: (enabled: boolean) => ipcRenderer.invoke('console:set-automation-enabled', enabled),
  confirmPhysicalShoe: (tableId: string) => ipcRenderer.invoke('console:confirm-physical-shoe', tableId),
  applyManualCorrection: (tableId: string, correction: ManualCorrection, shoeId?: string) =>
    ipcRenderer.invoke('console:manual-correction', tableId, correction, shoeId),
  updateRiskLimits: (limits: RiskLimits) => ipcRenderer.invoke('console:update-risk-limits', limits),
  updateTableSettings: (tableId: string, settings: { minEV: number; betTiers: BetTier[]; defaultBetAmount: number; monitorUrl?: string }) =>
    ipcRenderer.invoke('console:update-table-settings', tableId, settings),
  updateAllTableSettings: (settings: { minEV: number; betTiers: BetTier[]; defaultBetAmount: number }) =>
    ipcRenderer.invoke('console:update-all-table-settings', settings),
  updateMonitorTableIds: (tableIds: readonly string[]) =>
    ipcRenderer.invoke('console:update-monitor-table-ids', tableIds),
  clearMonitorData: () => ipcRenderer.invoke('console:clear-monitor-data'),
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('desktop', api);
