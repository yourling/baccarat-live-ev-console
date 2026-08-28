export const OPERATIONAL_WAGER_AUDIT_MARKETS = [
  'banker',
  'player',
  'bankerPair',
  'playerPair',
] as const;

export const OPERATIONAL_WAGER_AUDIT_SOURCES = ['manual', 'keepalive'] as const;
export const OPERATIONAL_WAGER_AUDIT_STATUSES = ['ACCEPTED', 'REJECTED', 'UNKNOWN'] as const;

export type OperationalWagerAuditMarket = (typeof OPERATIONAL_WAGER_AUDIT_MARKETS)[number];
export type OperationalWagerAuditSource = (typeof OPERATIONAL_WAGER_AUDIT_SOURCES)[number];
export type OperationalWagerAuditStatus = (typeof OPERATIONAL_WAGER_AUDIT_STATUSES)[number];

export interface OperationalWagerAuditRequest {
  readonly wagerId: string;
  readonly tableId: string;
  readonly shoeId: string;
  readonly handId: string;
  readonly market: OperationalWagerAuditMarket;
  readonly amount: number;
  readonly source: OperationalWagerAuditSource;
  readonly createdAt: string;
}

export interface OperationalWagerAuditReceipt {
  readonly receiptId: string;
  readonly wagerId: string;
  readonly tableId: string;
  readonly shoeId: string;
  readonly handId: string;
  readonly market: OperationalWagerAuditMarket;
  readonly amount: number;
  readonly source: OperationalWagerAuditSource;
  readonly status: OperationalWagerAuditStatus;
  readonly externalRef?: string;
  readonly createdAt: string;
  readonly raw?: unknown;
}

export interface OperationalWagerRecord {
  readonly wager: OperationalWagerAuditRequest;
  readonly status: OperationalWagerAuditStatus;
  readonly reservationId?: string;
  readonly reason?: string;
  readonly receipt?: OperationalWagerAuditReceipt;
  readonly reconciliation?: OperationalWagerReconciliation;
  readonly settlement?: OperationalWagerSettlement;
}

export interface OperationalWagerReconciliation {
  readonly status: 'ACCEPTED';
  readonly reason: 'operator-confirmed-platform-accepted';
  readonly reconciledAt: string;
}

export interface OperationalWagerSettlement {
  readonly outcome: 'WIN' | 'LOSS' | 'PUSH';
  readonly realizedPnl: number;
  readonly reason: 'operator-confirmed-platform-settlement';
  readonly settledAt: string;
}
