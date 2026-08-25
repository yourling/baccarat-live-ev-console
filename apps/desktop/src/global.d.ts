import type {
  DesktopConsoleSnapshot,
  DesktopKeepaliveSettings,
  DesktopOperationalWagerCommand,
  DesktopOperationalWagerResult,
  DesktopRecordPage,
  DesktopRecordQuery,
  DesktopSnapshotOptions,
  OneShotLiveBetCommand,
  OneShotLiveBetResult,
} from './api-types';
import type { BetTier, ManualCorrection, NormalizedEvent, RiskLimits, TableProfile } from '@baccarat/contracts';

declare global {
  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly VITE_DISABLE_REACT_DEVTOOLS?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    desktop?: {
      platform: string;
      snapshot: (options?: DesktopSnapshotOptions) => Promise<DesktopConsoleSnapshot>;
      queryRecords: (query: DesktopRecordQuery) => Promise<DesktopRecordPage>;
      runDemo: (seed?: number) => Promise<DesktopConsoleSnapshot>;
      startDemo: (seed?: number) => Promise<DesktopConsoleSnapshot>;
      stopDemo: () => Promise<DesktopConsoleSnapshot>;
      setDemoSpeed: (speed: number) => Promise<DesktopConsoleSnapshot>;
      registerTable: (profile: TableProfile, mode: 'shadow' | 'simulated' | 'live', amount: number) => Promise<DesktopConsoleSnapshot>;
      injectEvent: (event: NormalizedEvent) => Promise<DesktopConsoleSnapshot>;
      setAutoBet: (tableId: string, armed: boolean, shoeId?: string) => Promise<DesktopConsoleSnapshot>;
      setExecutionMode: (tableId: string, mode: 'shadow' | 'live') => Promise<DesktopConsoleSnapshot>;
      executeOneShotLiveBet: (command: OneShotLiveBetCommand) => Promise<OneShotLiveBetResult>;
      executeOperationalWager: (command: DesktopOperationalWagerCommand) => Promise<DesktopOperationalWagerResult>;
      updateKeepaliveSettings: (settings: DesktopKeepaliveSettings) => Promise<DesktopConsoleSnapshot>;
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
