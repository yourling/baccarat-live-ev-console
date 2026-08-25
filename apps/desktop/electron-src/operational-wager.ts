import type { OperationalWagerMarket, OperationalWagerStatus } from '@baccarat/adapter-contract';

export type KeepaliveWagerMarket = Extract<OperationalWagerMarket, 'banker' | 'player'>;

export type KeepaliveWagerResponse = {
  readonly status: OperationalWagerStatus;
  readonly reason?: string;
};

export type KeepaliveAttemptResult =
  | { readonly status: 'ACCEPTED'; readonly tableId: string; readonly reason?: string }
  | { readonly status: 'REJECTED'; readonly tableId: string | null; readonly reason?: string }
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
  for (const tableId of input.tableIds) {
    const response = await input.requestWager(tableId, input.market, input.amount);
    switch (response.status) {
      case 'ACCEPTED':
        return { status: 'ACCEPTED', tableId, ...(response.reason === undefined ? {} : { reason: response.reason }) };
      case 'UNKNOWN':
        return { status: 'UNKNOWN', tableId, ...(response.reason === undefined ? {} : { reason: response.reason }) };
      case 'REJECTED':
        break;
      default:
        return assertNeverOperationalWagerStatus(response.status);
    }
  }
  return { status: 'REJECTED', tableId: null };
}

function assertNeverOperationalWagerStatus(value: never): never {
  throw new Error(`unsupported operational wager status: ${String(value)}`);
}
