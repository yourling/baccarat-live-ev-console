import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { BetExecutionRequest } from '@baccarat/adapter-contract';

const runtimePath = new URL('../../../apps/browser-extension/mstrom-bet-runtime.js', import.meta.url);
const source = existsSync(runtimePath) ? readFileSync(runtimePath, 'utf8') : '';

type Market = 'bankerPair' | 'playerPair';
type Ack = 'accepted' | 'rejected' | 'unknown' | 'wrong-delta';

class FakePool {
  readonly amounts = new Map<number, number>();
  readonly statuses = new Map<number, { pending: boolean; success: boolean }>();
  pending = false;

  constructor(initial: Readonly<Record<number, number>> = {}) { for (const [playType, amount] of Object.entries(initial)) this.amounts.set(Number(playType), amount); }
  getAmount(playType: number): number { return this.amounts.get(playType) ?? 0; }
  setAmount(playType: number, amount: number): void { this.amounts.set(playType, amount); }
  getAllStakeData(): Array<{ playType: number; amount: number; pending: boolean; success: boolean }> {
    const playTypes = new Set([...this.amounts.keys(), ...this.statuses.keys()]);
    return [...playTypes].map(playType => ({ playType, amount: this.getAmount(playType), ...(this.statuses.get(playType) ?? { pending: false, success: false }) }));
  }

  calculateDiff(donePool: FakePool): { totalAmount: number } {
    let totalAmount = 0;
    for (const playType of new Set([...this.amounts.keys(), ...donePool.amounts.keys()])) totalAmount += this.getAmount(playType) - donePool.getAmount(playType);
    return { totalAmount };
  }
}

function validRequest(overrides: Partial<BetExecutionRequest['intent']> = {}): BetExecutionRequest {
  return {
    intent: { intentId: 'intent-1', tableId: 'D065', shoeId: 'shoe-1', handId: 'GD065-1', market: 'bankerPair', amount: 10, mode: 'live', idempotencyKey: 'idem-1', strategy: { type: 'fixed', market: 'bankerPair' }, decisionSnapshotId: 'decision-1', createdAt: '2026-08-24T12:00:00.000Z', ...overrides },
    mode: 'live', reservationId: 'reservation-1',
  };
}

function makeStore(ack: Ack = 'accepted', overrides: Record<string, unknown> = {}) {
  const stakePool = new FakePool({ 4: 0, 5: 0 });
  const donePool = new FakePool({ 4: 0, 5: 0 });
  const diffPool = new FakePool({ 4: 0, 5: 0 });
  const pendingBetSeqForResp = new Set<string>();
  let nextSequence = 1;
  const addChipByPlayType = vi.fn((playType: number, amount: number) => stakePool.setAmount(playType, stakePool.getAmount(playType) + (ack === 'wrong-delta' ? amount + 1 : amount)));
  const confirmBet = vi.fn(() => {
    const sequence = String(nextSequence++);
    pendingBetSeqForResp.add(sequence);
    if (ack === 'accepted') {
      setTimeout(() => {
        donePool.setAmount(4, stakePool.getAmount(4));
        donePool.setAmount(5, stakePool.getAmount(5));
        diffPool.statuses.set(4, { pending: false, success: true });
        diffPool.statuses.set(5, { pending: false, success: true });
        pendingBetSeqForResp.delete(sequence);
      }, 0);
      return;
    }
    if (ack === 'rejected') {
      diffPool.setAmount(4, 10);
      diffPool.statuses.set(4, { pending: false, success: false });
      setTimeout(() => {
        stakePool.setAmount(4, donePool.getAmount(4));
        pendingBetSeqForResp.delete(sequence);
      }, 0);
    }
  });
  return {
    vid: 'D065', gmcode: 'GD065-1', betEnabled: true, stakePool, donePool, diffPool, pendingBetSeqForResp, addChipByPlayType, confirmBet,
    getDisablePlayTypes: () => [], getBalance: () => 100, getBetLimitByPlayType: () => ({ min: 1, max: 1000 }), ...overrides,
  };
}

function loadRuntime(store: unknown, extra: Record<string, unknown> = {}) {
  const getBetTableStore = vi.fn(() => store);
  const extraCore = typeof extra.VideoGameCore === 'object' && extra.VideoGameCore !== null
    ? extra.VideoGameCore as Record<string, unknown>
    : {};
  const context = vm.createContext({
    chrome: { scripting: {} },
    ...extra,
    VideoGameCore: {
      ...extraCore,
      LinkStoreFactory: { instance: { getBetTableStore } },
    },
    location: { href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/', hostname: 'gci.agad.mstrom-uno.com' },
    Date,
    Promise,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'msstrom-bet-runtime.js' });
  const runtimeFunction = (name: string) => {
    const value = Reflect.get(context, name);
    if (typeof value !== 'function') throw new Error(`${name} is not exposed`);
    return value as (...args: unknown[]) => unknown;
  };
  const inject = () => {
    vm.runInContext(source, context, { filename: 'mstrom-bet-runtime.js' });
    return {
      probe: runtimeFunction('probeMstromBetStore'),
      execute: runtimeFunction('executeMstromBetOneShot'),
    };
  };
  return {
    getBetTableStore,
    probe: runtimeFunction('probeMstromBetStore'),
    execute: runtimeFunction('executeMstromBetOneShot'),
    inject,
  };
}

describe('Dafabet mstrom MAIN-world bet runtime', () => {
  it('does not expose a persistent callable betting global when loaded', () => {
    const context = vm.createContext({
      VideoGameCore: { LinkStoreFactory: { instance: { getBetTableStore: vi.fn() } } },
      Date,
      Promise,
      setTimeout,
      clearTimeout,
    });

    vm.runInContext(source, context, { filename: 'msstrom-bet-runtime.js' });

    expect(Reflect.get(context, '__baccaratMstromBetProbe')).toBeUndefined();
    expect(Reflect.get(context, '__baccaratMstromBetExecute')).toBeUndefined();
    expect(Reflect.get(context, '__baccaratMstromBetRuntime')).toBeUndefined();
    expect(Reflect.get(context, 'resultCache')).toBeUndefined();
    expect(Reflect.get(context, 'inFlight')).toBeUndefined();
    expect(Reflect.get(context, 'idempotencyBindings')).toBeUndefined();
  });

  it('exposes a token-free probe with the target store state', () => {
    const store = { ...makeStore(), token: 'must-not-leak', sessionToken: 'must-not-leak' };
    const runtime = loadRuntime(store);
    const probe = runtime.probe('D065');
    expect(probe).toEqual({
      runtimeRevision: 'mstrom-bet-runtime/2026-08-28.1',
      frameUrl: 'https://gci.agad.mstrom-uno.com/pc/pcv1/',
      host: 'gci.agad.mstrom-uno.com',
      tableId: 'D065',
      ownsTargetStore: true,
      gmcode: 'GD065-1',
      betEnabled: true,
      diffPending: false,
      balance: 100,
      disabledPlayTypes: [],
      limits: {
        banker: { min: 1, max: 1000, invalid: false },
        player: { min: 1, max: 1000, invalid: false },
        bankerPair: { min: 1, max: 1000, invalid: false },
        playerPair: { min: 1, max: 1000, invalid: false },
      },
      hasAddChip: true,
      hasConfirm: true,
      hasCalculateDiff: true,
      diagnostics: {
        corePresent: true,
        coreKeys: ['LinkStoreFactory'],
        linkFactoryPresent: true,
        linkFactoryKeys: ['getBetTableStore'],
        gameLinkStorePresent: false,
        gameLinkStoreKeys: [],
      },
    });
    expect(probe).not.toHaveProperty('token');
    expect(probe).not.toHaveProperty('sessionToken');
  });

  it.each([
    ['request mode is not live', validRequest({}), { mode: 'shadow' }],
    ['intent mode is not live', validRequest({ mode: 'shadow' }), {}],
    ['table id is malformed', validRequest({ tableId: 'D65' }), {}],
    ['market is unsupported', validRequest({ market: 'banker' as Market }), {}],
    ['amount is not positive finite', validRequest({ amount: 0 }), {}],
    ['idempotency key is empty', validRequest({ idempotencyKey: ' ' }), {}],
  ])('does not execute when %s', async (_name, request, requestOverrides) => {
    const store = makeStore();
    const runtime = loadRuntime(store);
    const result = await runtime.execute({ ...request, ...requestOverrides });
    expect(result).toBeNull();
    expect(store.confirmBet).not.toHaveBeenCalled();
  });

  it('does not fall back to GameBac when the LinkStoreFactory has no target', async () => {
    const context = vm.createContext({
      VideoGameCore: { LinkStoreFactory: { instance: { getBetTableStore: vi.fn(() => undefined) } } },
      chrome: { scripting: {} },
      GameBac: { BetStore: { instance: makeStore() } },
      Date,
      Promise,
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(source, context, { filename: 'msstrom-bet-runtime.js' });
    const execute = Reflect.get(context, 'executeMstromBetOneShot');
    if (typeof execute !== 'function') throw new Error('execute runtime is not exposed');
    expect(await execute(validRequest())).toBeNull();
  });

  it.each([
    ['store vid mismatches', { vid: 'D066' }],
    ['current hand mismatches', { gmcode: 'GD065-2' }],
    ['betting is closed', { betEnabled: false }],
    ['diff pool is pending', { diffPool: Object.assign(new FakePool(), { pending: true }) }],
    ['play type is disabled', { getDisablePlayTypes: () => [4] }],
    ['balance is insufficient', { getBalance: () => 5 }],
    ['total is below platform minimum', { getBetLimitByPlayType: () => ({ min: 20, max: 1000 }) }],
    ['total is above platform maximum', { getBetLimitByPlayType: () => ({ min: 1, max: 5 }) }],
  ])('returns REJECTED without confirming when %s', async (_name, overrides) => {
    const store = makeStore('accepted', overrides);
    const runtime = loadRuntime(store);
    const result = await runtime.execute(validRequest());
    expect(result).toMatchObject({ status: 'REJECTED', mode: 'live' });
    expect(store.confirmBet).not.toHaveBeenCalled();
  });

  it('rejects a pre-existing unconfirmed stake before touching the target pool', async () => {
    const store = makeStore();
    store.stakePool.setAmount(5, 5);
    const runtime = loadRuntime(store);
    const result = await runtime.execute(validRequest());
    expect(result).toMatchObject({ status: 'REJECTED' });
    expect(store.addChipByPlayType).not.toHaveBeenCalled();
    expect(store.confirmBet).not.toHaveBeenCalled();
  });

  it.each([
    ['bankerPair', 4],
    ['playerPair', 5],
  ] as const)('maps %s to play type %d and accepts an exact platform acknowledgement', async (market, playType) => {
    const store = makeStore();
    const runtime = loadRuntime(store);
    const result = await runtime.execute(validRequest({ market, idempotencyKey: `idem-${market}` }));
    expect(store.addChipByPlayType).toHaveBeenCalledWith(playType, 10);
    expect(store.confirmBet).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'ACCEPTED',
      amount: 10,
      market,
      mode: 'live',
      raw: { commitPoint: 'confirmBet', commitStarted: true },
    });
  });

  it('re-reads getter-backed pcv2 pools after confirmBet', async () => {
    const store = makeStore('unknown');
    const initialDonePool = store.donePool;
    const initialDiffPool = store.diffPool;
    let currentDonePool = initialDonePool;
    let currentDiffPool = initialDiffPool;
    Object.defineProperty(store, 'donePool', { get: () => currentDonePool });
    Object.defineProperty(store, 'diffPool', { get: () => currentDiffPool });
    store.confirmBet.mockImplementation(() => {
      currentDonePool = new FakePool({ 4: 10, 5: 0 });
      currentDiffPool = new FakePool();
    });

    const runtime = loadRuntime(store);
    const result = await runtime.execute(validRequest());

    expect(result).toMatchObject({ status: 'ACCEPTED' });
    expect(store.confirmBet).toHaveBeenCalledOnce();
  });

  it('accepts the matching official bet-history increment when the table done pool stays stale', async () => {
    const store = makeStore('unknown');
    const historyStore = { dataList: [] as Array<Record<string, unknown>> };
    store.confirmBet.mockImplementation(() => {
      historyStore.dataList = [{
        vid: 'D065',
        gmcode: 'GD065-1',
        playType: 4,
        betAmount: 10,
      }];
    });
    const runtime = loadRuntime(store, {
      VideoGameCore: { MultiBetHistoryStore: { instance: historyStore } },
    });

    const result = await runtime.execute(validRequest());

    expect(result).toMatchObject({
      status: 'ACCEPTED',
      raw: { acknowledgement: 'bet-history', commitStarted: true },
    });
    expect(store.donePool.getAmount(4)).toBe(0);
    expect(store.confirmBet).toHaveBeenCalledOnce();
  });

  it('requires an official bet-history amount increase and does not accept a pre-existing row', async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore('unknown');
      const historyStore = {
        dataList: [{ vid: 'D065', gmcode: 'GD065-1', playType: 4, betAmount: 10 }],
      };
      const runtime = loadRuntime(store, {
        VideoGameCore: { MultiBetHistoryStore: { instance: historyStore } },
      });

      const resultPromise = runtime.execute(validRequest());
      await vi.advanceTimersByTimeAsync(5100);

      expect(await resultPromise).toMatchObject({
        status: 'UNKNOWN',
        raw: {
          reason: 'result-timeout',
          beforeHistory: 10,
          observedHistory: 10,
        },
      });
      expect(store.confirmBet).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects and restores the original stake when the add delta is not exact', async () => {
    const store = makeStore('wrong-delta');
    store.stakePool.setAmount(4, 2);
    store.donePool.setAmount(4, 2);
    const runtime = loadRuntime(store);
    const result = await runtime.execute(validRequest());
    expect(result).toMatchObject({ status: 'REJECTED' });
    expect(result).toMatchObject({ raw: { commitStarted: false } });
    expect(store.stakePool.getAmount(4)).toBe(2);
    expect(store.confirmBet).not.toHaveBeenCalled();
  });

  it.each([
    ['betting closes after the exact add', 'betEnabled'],
    ['the diff becomes pending after the exact add', 'diffPending'],
    ['the hand changes after the exact add', 'gmcode'],
  ] as const)('rechecks %s immediately before confirmBet', async (_name, guard) => {
    const store = makeStore();
    let betEnabled = true;
    let gmcode = 'GD065-1';
    Object.defineProperty(store, 'betEnabled', { get: () => betEnabled });
    Object.defineProperty(store, 'gmcode', { get: () => gmcode });
    store.addChipByPlayType.mockImplementation((playType, amount) => {
      store.stakePool.setAmount(playType, store.stakePool.getAmount(playType) + amount);
      if (guard === 'betEnabled') betEnabled = false;
      if (guard === 'diffPending') store.diffPool.pending = true;
      if (guard === 'gmcode') gmcode = 'GD065-2';
    });

    const runtime = loadRuntime(store);
    const result = await runtime.execute(validRequest());
    expect(result).toMatchObject({ status: 'REJECTED' });
    expect(store.stakePool.getAmount(4)).toBe(0);
    expect(store.confirmBet).not.toHaveBeenCalled();
  });

  it('returns UNKNOWN when post-confirm state only suggests a platform failure', async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore('rejected');
      const runtime = loadRuntime(store);
      const resultPromise = runtime.execute(validRequest());

      await vi.advanceTimersByTimeAsync(1);
      expect(store.diffPool.getAllStakeData()).toContainEqual(expect.objectContaining({
        playType: 4,
        pending: false,
        success: false,
      }));
      expect(store.confirmBet).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5100);
      expect(await resultPromise).toMatchObject({
        status: 'UNKNOWN',
        raw: {
          reason: 'result-timeout',
          commitPoint: 'confirmBet',
          commitStarted: true,
          runtimeRevision: 'mstrom-bet-runtime/2026-08-28.1',
        },
      });
      expect(store.stakePool.getAmount(4)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat the initial diffPool success=false row as a rejection', async () => {
    const store = makeStore('accepted');
    store.diffPool.statuses.set(4, { pending: false, success: false });
    const runtime = loadRuntime(store);

    const result = await runtime.execute(validRequest());

    expect(result).toMatchObject({ status: 'ACCEPTED' });
    expect(store.confirmBet).toHaveBeenCalledOnce();
  });

  it('returns UNKNOWN and locks the execution when confirmBet throws without an observable outcome', async () => {
    const store = makeStore();
    store.confirmBet.mockImplementation(() => {
      throw new Error('socket write failed');
    });
    const runtime = loadRuntime(store);
    const result = await runtime.execute(validRequest());
    expect(result).toMatchObject({
      status: 'UNKNOWN',
      mode: 'live',
      raw: { reason: 'confirm-failed-uncertain', commitPoint: 'confirmBet', commitStarted: true },
    });
    expect(store.stakePool.getAmount(4)).toBe(10);
    expect(store.donePool.getAmount(4)).toBe(0);
    const retry = await runtime.execute(validRequest());
    expect(retry).toMatchObject({
      status: 'REJECTED',
      raw: { reason: 'unconfirmed-stake-present', commitStarted: false },
    });
    expect(store.confirmBet).toHaveBeenCalledOnce();
  });

  it('runs each one-shot payload once without a runtime cache', async () => {
    const store = makeStore();
    const runtime = loadRuntime(store);
    const first = runtime.execute(validRequest());
    const firstResult = await first;
    const secondResult = await runtime.execute(validRequest({
      idempotencyKey: 'second-transport-key',
    }));
    expect(firstResult).toMatchObject({ status: 'ACCEPTED' });
    expect(secondResult).toMatchObject({ status: 'ACCEPTED' });
    expect(firstResult).not.toBe(secondResult);
    expect(store.confirmBet).toHaveBeenCalledTimes(2);
  });

  it('does not retry a one-shot payload after reinjection', async () => {
    const store = makeStore();
    const runtime = loadRuntime(store);
    const first = await runtime.execute(validRequest());
    const reinjected = runtime.inject();
    const second = await reinjected.execute(validRequest({
      idempotencyKey: 're-injected-transport-key',
    }));
    expect(first).toMatchObject({ status: 'ACCEPTED' });
    expect(second).toMatchObject({ status: 'ACCEPTED' });
    expect(store.confirmBet).toHaveBeenCalledTimes(2);
  });

  it('re-injects a one-shot payload without publishing runtime state', async () => {
    const store = makeStore();
    const runtime = loadRuntime(store);
    const first = await runtime.execute(validRequest());
    const reinjected = runtime.inject();
    const second = await reinjected.execute(validRequest({
      idempotencyKey: 're-injected-transport-key',
    }));
    expect(first).toMatchObject({ status: 'ACCEPTED' });
    expect(second).toMatchObject({ status: 'ACCEPTED' });
    expect(store.confirmBet).toHaveBeenCalledTimes(2);
    expect(Reflect.get(runtime, 'resultCache')).toBeUndefined();
    expect(Reflect.get(reinjected, 'inFlight')).toBeUndefined();
  });

  it('returns UNKNOWN when neither done nor diff proves the result before timeout', async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore('unknown');
      const runtime = loadRuntime(store);
      const resultPromise = runtime.execute(validRequest());
      await vi.advanceTimersByTimeAsync(5100);
      expect(await resultPromise).toMatchObject({ status: 'UNKNOWN', mode: 'live' });
      expect(store.confirmBet).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
