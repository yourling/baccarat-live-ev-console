import type {
  DesktopConsoleSnapshot,
  DesktopPerformanceReport,
  DesktopKeepaliveStrategySettings,
  DesktopOperationalWagerCommand,
  DesktopOperationalWagerResult,
  DesktopPendingSettlementCommand,
  DesktopUnknownWagerReconciliationCommand,
  DesktopUnknownWagerWriteOffCommand,
  DesktopRecordPage,
  DesktopRecordQuery,
  DesktopSnapshotOptions,
  OneShotLiveBetCommand,
  OneShotLiveBetResult,
} from './api-types';
import type { BetTier, ManualCorrection, RiskLimits, TableProfile } from '@baccarat/contracts';

declare global {
  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly VITE_DISABLE_REACT_DEVTOOLS?: string;
    readonly VITE_CONSOLE_GIT_SHA?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    desktop?: {
      platform: string;
      snapshot: (options?: DesktopSnapshotOptions) => Promise<DesktopConsoleSnapshot>;
      queryRecords: (query: DesktopRecordQuery) => Promise<DesktopRecordPage>;
      performanceReport: () => Promise<DesktopPerformanceReport>;
      runDemo: (seed?: number) => Promise<DesktopConsoleSnapshot>;
      startDemo: (seed?: number) => Promise<DesktopConsoleSnapshot>;
      stopDemo: () => Promise<DesktopConsoleSnapshot>;
      setDemoSpeed: (speed: number) => Promise<DesktopConsoleSnapshot>;
      registerTable: (profile: TableProfile, mode: 'shadow' | 'simulated' | 'live', amount: number) => Promise<DesktopConsoleSnapshot>;
      setAutoBet: (tableId: string, armed: boolean, shoeId?: string) => Promise<DesktopConsoleSnapshot>;
      setExecutionMode: (tableId: string, mode: 'shadow' | 'live') => Promise<DesktopConsoleSnapshot>;
      executeOneShotLiveBet: (command: OneShotLiveBetCommand) => Promise<OneShotLiveBetResult>;
      executeOperationalWager: (command: DesktopOperationalWagerCommand) => Promise<DesktopOperationalWagerResult>;
      reconcileUnknownOperationalWager: (command: DesktopUnknownWagerReconciliationCommand) => Promise<DesktopConsoleSnapshot>;
      writeOffUnknownOperationalWager: (command: DesktopUnknownWagerWriteOffCommand) => Promise<DesktopConsoleSnapshot>;
      settlePendingOperationalWager: (command: DesktopPendingSettlementCommand) => Promise<DesktopConsoleSnapshot>;
      updateKeepaliveSettings: (settings: DesktopKeepaliveStrategySettings) => Promise<DesktopConsoleSnapshot>;
      setKeepaliveEnabled: (enabled: boolean) => Promise<DesktopConsoleSnapshot>;
      setAutomationEnabled: (enabled: boolean) => Promise<DesktopConsoleSnapshot>;
      acknowledgeRuntimeIncident: (incidentId: string) => Promise<DesktopConsoleSnapshot>;
      acknowledgeAllRuntimeIncidents: () => Promise<DesktopConsoleSnapshot>;
      confirmPhysicalShoe: (tableId: string) => Promise<DesktopConsoleSnapshot>;
      applyManualCorrection: (tableId: string, correction: ManualCorrection, shoeId?: string) => Promise<DesktopConsoleSnapshot>;
      updateRiskLimits: (limits: RiskLimits) => Promise<DesktopConsoleSnapshot>;
      updateTableSettings: (tableId: string, settings: { minEV: number; betTiers: BetTier[]; defaultBetAmount: number; monitorUrl?: string }) => Promise<DesktopConsoleSnapshot>;
      updateAllTableSettings: (settings: { minEV: number; betTiers: BetTier[]; defaultBetAmount: number }) => Promise<DesktopConsoleSnapshot>;
      updateMonitorTableIds: (tableIds: readonly string[]) => Promise<DesktopConsoleSnapshot>;
      clearMonitorData: () => Promise<DesktopConsoleSnapshot>;
    };
  }
}

export {};
