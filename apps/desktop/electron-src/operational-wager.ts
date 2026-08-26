import type { OperationalWagerMarket, OperationalWagerStatus } from '@baccarat/adapter-contract';

export type KeepaliveWagerMarket = Extract<OperationalWagerMarket, 'banker' | 'player'>;

export type KeepaliveWagerResponse = {
  readonly status: OperationalWagerStatus;
  readonly reason?: string;
  readonly attempted?: boolean;
};

export type KeepaliveAttemptResult =
  | { readonly status: 'ACCEPTED'; readonly tableId: string; readonly reason?: string }
  | { readonly status: 'REJECTED'; readonly tableId: null; readonly attempted: boolean; readonly reason?: string }
  | { readonly status: 'UNKNOWN'; readonly tableId: string; readonly reason?: string };

export interface KeepaliveAttemptInput {
  readonly tableIds: readonly string[];
  readonly amount: number;
  readonly market: KeepaliveWagerMarket;
  readonly requestWager: (
    tableId: string,
    market: KeepaliveWagerMarket,
    amount: number,
  ) => Promise<KeepaliveWagerResponse>;
}

export async function tryKeepaliveInOrder(input: KeepaliveAttemptInput): Promise<KeepaliveAttemptResult> {
  let attempted = false;
  let lastReason: string | undefined;
  for (const tableId of input.tableIds) {
    const response = await input.requestWager(tableId, input.market, input.amount);
    switch (response.status) {
      case 'ACCEPTED':
        return { status: 'ACCEPTED', tableId, ...(response.reason === undefined ? {} : { reason: response.reason }) };
      case 'UNKNOWN':
        return { status: 'UNKNOWN', tableId, ...(response.reason === undefined ? {} : { reason: response.reason }) };
      case 'REJECTED':
        attempted ||= response.attempted === true;
        lastReason = response.reason;
        break;
      default:
        return assertNeverOperationalWagerStatus(response.status);
    }
  }
  return {
    status: 'REJECTED',
    tableId: null,
    attempted,
    ...(lastReason === undefined ? {} : { reason: lastReason }),
  };
}

function assertNeverOperationalWagerStatus(value: never): never {
  throw new Error(`unsupported operational wager status: ${String(value)}`);
}
