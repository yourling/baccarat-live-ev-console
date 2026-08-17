import type { DesktopConsoleSnapshot } from './api-types';
import type { ManualCorrection, NormalizedEvent, RiskLimits, TableProfile } from '@baccarat/contracts';

declare global {
  interface Window {
    desktop?: {
      platform: string;
      snapshot: () => Promise<DesktopConsoleSnapshot>;
      runDemo: (seed?: number) => Promise<DesktopConsoleSnapshot>;
      registerTable: (profile: TableProfile, mode: 'shadow' | 'simulated', amount: number) => Promise<DesktopConsoleSnapshot>;
      injectEvent: (event: NormalizedEvent) => Promise<DesktopConsoleSnapshot>;
      setAutoBet: (tableId: string, armed: boolean, shoeId?: string) => Promise<DesktopConsoleSnapshot>;
      applyManualCorrection: (tableId: string, correction: ManualCorrection, shoeId?: string) => Promise<DesktopConsoleSnapshot>;
      updateRiskLimits: (limits: RiskLimits) => Promise<DesktopConsoleSnapshot>;
    };
  }
}

export {};
