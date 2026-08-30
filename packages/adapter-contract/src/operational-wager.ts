export const OPERATIONAL_WAGER_MARKETS = ['banker', 'player', 'bankerPair', 'playerPair'] as const;

export type OperationalWagerMarket = (typeof OPERATIONAL_WAGER_MARKETS)[number];
export type OperationalWagerSource = 'manual' | 'keepalive';
export type OperationalWagerStatus = 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';

export interface OperationalWagerRequest {
  readonly wagerId: string;
  readonly tableId: string;
  readonly shoeId: string;
  readonly handId: string;
  readonly market: OperationalWagerMarket;
  readonly amount: number;
  readonly source: OperationalWagerSource;
  readonly createdAt: string;
}

export interface OperationalWagerExecutionRequest {
  readonly mode: 'live';
  readonly wager: OperationalWagerRequest;
}

export interface OperationalWagerReceipt {
  readonly receiptId: string;
  readonly wagerId: string;
  readonly tableId: string;
  readonly shoeId: string;
  readonly handId: string;
  readonly market: OperationalWagerMarket;
  readonly amount: number;
  readonly source: OperationalWagerSource;
  readonly status: OperationalWagerStatus;
  readonly externalRef?: string;
  readonly createdAt: string;
  readonly raw?: unknown;
}

export function isOperationalWagerMarket(value: unknown): value is OperationalWagerMarket {
  return value === 'banker'
    || value === 'player'
    || value === 'bankerPair'
    || value === 'playerPair';
}
