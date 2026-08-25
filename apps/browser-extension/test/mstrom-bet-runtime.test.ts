import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type RuntimeExecutor = (request: unknown) => Promise<unknown>;

function executorFor(playTypeCalls: number[]): RuntimeExecutor {
  const amounts = new Map<number, number>();
  const confirmedAmounts = new Map<number, number>();
  const store = {
    vid: 'D055',
    gmcode: 'GD055-1',
    betEnabled: true,
    stakePool: {
      getAmount(playType: number): number {
        return amounts.get(playType) ?? 0;
      },
      calculateDiff(): { totalAmount: number } {
        return { totalAmount: 0 };
      },
    },
    donePool: {
      getAmount(playType: number): number {
        return confirmedAmounts.get(playType) ?? 0;
      },
    },
    diffPool: {
      pending: false,
      getAllStakeData(): [] {
        return [];
      },
    },
    getDisablePlayTypes(): [] {
      return [];
    },
    getBetLimitByPlayType(): { min: number; max: number } {
      return { min: 1, max: 1000 };
    },
    getBalance(): number {
      return 1000;
    },
    addChipByPlayType(playType: number, amount: number): void {
      playTypeCalls.push(playType);
      amounts.set(playType, (amounts.get(playType) ?? 0) + amount);
    },
    async confirmBet(): Promise<void> {
      for (const [playType, amount] of amounts) confirmedAmounts.set(playType, amount);
    },
  };
  const sandbox: Record<string, unknown> = {
    chrome: { scripting: {} },
    VideoGameCore: {
      LinkStoreFactory: {
        instance: {
          getBetTableStore(tableId: string): unknown {
            return tableId === 'D055' ? store : null;
          },
        },
      },
    },
    setTimeout,
    Date,
    Map,
    Number,
    Promise,
  };
  sandbox.globalThis = sandbox;
  runInNewContext(
    readFileSync(join(process.cwd(), 'apps/browser-extension/mstrom-bet-runtime.js'), 'utf8'),
    sandbox,
  );
  const executor = sandbox.executeMstromBetOneShot;
  if (typeof executor !== 'function') throw new Error('mstrom executor was not installed');
  return executor;
}

function operationalRequest(market: string): unknown {
  return {
    mode: 'live',
    wager: {
      wagerId: `wager-${market}`,
      tableId: 'D055',
      shoeId: 'shoe-1',
      handId: 'GD055-1',
      market,
      amount: 20,
      source: 'manual',
      createdAt: '2026-08-25T00:00:00.000Z',
    },
  };
}

describe('executeMstromBetOneShot', () => {
  it('uses the verified mstrom play type for each operational wager market', async () => {
    // Given: a ready mstrom bet store for the selected table.
    const playTypeCalls: number[] = [];
    const execute = executorFor(playTypeCalls);

    // When: the desktop requests all four supported operational wager markets.
    const receipts = await Promise.all([
      execute(operationalRequest('banker')),
      execute(operationalRequest('player')),
      execute(operationalRequest('bankerPair')),
      execute(operationalRequest('playerPair')),
    ]);

    // Then: each request receives an accepted operational receipt at its verified platform play type.
    expect(playTypeCalls).toEqual([1, 2, 4, 5]);
    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ wagerId: 'wager-banker', status: 'ACCEPTED', market: 'banker' }),
      expect.objectContaining({ wagerId: 'wager-player', status: 'ACCEPTED', market: 'player' }),
      expect.objectContaining({ wagerId: 'wager-bankerPair', status: 'ACCEPTED', market: 'bankerPair' }),
      expect.objectContaining({ wagerId: 'wager-playerPair', status: 'ACCEPTED', market: 'playerPair' }),
    ]));
  });
});
