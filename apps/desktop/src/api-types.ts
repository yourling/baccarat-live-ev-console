import type {
  BetReceipt,
  DecisionSnapshot,
  NormalizedEvent,
  RiskExposureState,
  RiskLimits,
  RiskReservation,
  ShoeStateProjection,
  TableProfile,
} from '@baccarat/contracts';

export interface TableActorSnapshot {
  tableId: string;
  profile: TableProfile;
  projection: ShoeStateProjection;
  executionMode: 'shadow' | 'simulated';
  defaultBetAmount: number;
  pendingEvents: number;
}

export interface OrchestratorSnapshot {
  riskState: RiskExposureState;
  riskLimits: RiskLimits;
  tables: Record<string, TableActorSnapshot>;
}

export interface ReceiptRow {
  receipt: BetReceipt;
  tableId: string;
  shoeId: string;
  handId: string;
  market: string;
}

export interface DesktopConsoleSnapshot {
  dbPath: string;
  isOpen: boolean;
  seed?: number;
  snapshot: OrchestratorSnapshot;
  events: NormalizedEvent[];
  decisions: DecisionSnapshot[];
  receipts: ReceiptRow[];
  reservations: RiskReservation[];
}
