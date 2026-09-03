import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  new URL('../../../apps/browser-extension/pragmatic-bet-runtime.js', import.meta.url),
  'utf8',
);

type FakeElement = {
  children: FakeElement[];
  textContent: string;
  disabled?: boolean;
  tagName?: string;
  parentElement?: FakeElement | null;
  click: ReturnType<typeof vi.fn>;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number; left?: number; top?: number; x?: number; y?: number };
  contains?(node: FakeElement | null): boolean;
  closest?(selector: string): FakeElement | null;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
};

function element(textContent = ''): FakeElement {
  return {
    children: [],
    textContent,
    click: vi.fn(),
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function page(open = true, headerText = 'ID: 17260230224') {
  const header = element(headerText);
  const timer = open ? element('9') : null;
  const chip = element('10');
  const playerPair = element('闲家对子');
  const bankerPair = element('庄家对子');
  const player = element('闲家');
  const banker = element('庄家');
  const wallet = element('总投注 ¥ 0.00');
  let selectedChip = 0;
  let totalBet = 0;
  chip.click.mockImplementation(() => { selectedChip = 10; });
  playerPair.click.mockImplementation(() => {
    totalBet += selectedChip || 10;
    wallet.textContent = `总投注 ¥ ${totalBet.toFixed(2)}`;
  });

  const byId = new Map([
    ['leftBetTextRoot', player],
    ['rightBetTextRoot', banker],
  ]);
  const document = {
    referrer: 'https://client.pragmaticplaylive.net/desktop/launcher/?table_id=bc281koreanch281',
    querySelector(selector: string): FakeElement | null {
      if (selector.includes('[data-testid="game-header-game-id"]')) return header;
      if (selector.includes('round-timer')) return timer;
      if (selector === '[data-testid="wallet-mobile-total-bet"]') return wallet;
      return null;
    },
    querySelectorAll(selector: string): FakeElement[] {
      if (selector === '[data-testid="chip-stack-value-10"]') return [chip];
      if (selector.startsWith('[data-testid="chip-stack-value-')) return [];
      if (selector === '*') return [playerPair, bankerPair, player, banker];
      return [];
    },
    getElementById(id: string): FakeElement | null {
      return byId.get(id) ?? null;
    },
  };
  return { document, chip, playerPair, wallet, timer };
}

function exportedRuntime() {
  const sandbox: Record<string, unknown> = {
    chrome: { scripting: {} },
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox);
  return {
    probe: sandbox.probePragmaticBetTable as (tableId: string) => unknown,
    execute: sandbox.executePragmaticBetOneShot as (
      request: unknown,
      command: unknown,
    ) => Promise<Record<string, unknown>>,
  };
}

function pageContext(open = true, headerText?: string) {
  const dom = page(open, headerText);
  return {
    ...dom,
    context: {
      document: dom.document,
      location: {
        pathname: '/desktop/baccarat/',
        hostname: 'client.pragmaticplaylive.net',
      },
      URL,
      Date,
      Number,
      Object,
      Array,
      String,
      Promise,
      setTimeout,
      innerWidth: 1280,
      innerHeight: 720,
      __baccaratPragmaticBetChannel: undefined as { placeBet: () => { ok: boolean } } | undefined,
    },
  };
}

function multitablePageContext(
  remainingSeconds: number | null = 8,
  preparedTableId = 'tobcbaccaragen92',
  preparedAt = Date.now(),
) {
  const unrelatedHeader = element('ID: 99999999999');
  const sharedTimer = remainingSeconds === null ? null : element(String(remainingSeconds));
  const unrelatedTileTimer = element('0');
  const chip = element('10');
  const wallet = element('总投注 ¥ 0.00');
  const markets = new Map([
    ['0', element('闲家')],
    ['1', element('庄家')],
    ['3', element('闲对')],
    ['4', element('庄对')],
  ]);
  const unrelatedMarkets = new Map([
    ['0', element('其他桌闲家')],
    ['1', element('其他桌庄家')],
    ['3', element('其他桌闲对')],
    ['4', element('其他桌庄对')],
  ]);
  let selectedChip = 0;
  let totalBet = 0;
  chip.click.mockImplementation(() => { selectedChip = 10; });
  markets.get('0')?.click.mockImplementation(() => {
    totalBet += selectedChip || 10;
    wallet.textContent = `总投注 ¥ ${totalBet.toFixed(2)}`;
  });
  const root = element('粤语极速百家乐¥\u00a010ID: 17260578524');
  root.querySelector = (selector: string): FakeElement | null => {
    if (selector === '[data-testid="game-header-game-id"]') return null;
    if (selector === '[data-testid^="timer-countdown-"]') return unrelatedTileTimer;
    return null;
  };
  const document = {
    referrer: '',
    textContent: '',
    querySelector(selector: string): FakeElement | null {
      if (selector.includes('[data-testid="game-header-game-id"]')) return unrelatedHeader;
      if (selector === '[data-testid="round-timer"] [data-testid^="timer-countdown-"]') return sharedTimer;
      if (selector === '[data-testid^="timer-countdown-"]') return unrelatedTileTimer;
      if (selector === '[data-testid="wallet-mobile-total-bet"]') return wallet;
      if (selector === '[data-betcode="0"], [data-betcode="1"]') return unrelatedMarkets.get('0') ?? null;
      const code = selector.match(/^\[data-betcode="([0-4])"\]$/)?.[1];
      return code ? unrelatedMarkets.get(code) ?? null : null;
    },
    querySelectorAll(selector: string): FakeElement[] {
      if (selector === '[data-testid="chip-stack-value-10"]') return [chip];
      if (selector === '[data-betcode]') return [...unrelatedMarkets.values(), ...markets.values()];
      const code = selector.match(/^\[data-betcode="([0-4])"\]$/)?.[1];
      if (code) return [unrelatedMarkets.get(code)!, markets.get(code)!].filter(Boolean);
      return [];
    },
    getElementById(id: string): FakeElement | null {
      return id === 'TileHeight-tobcbaccaragen92' ? root : null;
    },
  };
  return {
    context: {
      document,
      location: {
        pathname: '/desktop/multibaccarat/',
        hostname: 'client.pragmaticplaylive.net',
      },
      URL,
      Date,
      Number,
      Object,
      Array,
      String,
      Promise,
      setTimeout,
      innerWidth: 1280,
      innerHeight: 720,
      __baccaratPragmaticPreparedTable: {
        tableId: preparedTableId,
        roundId: '17260578524',
        countdown: remainingSeconds ?? 0,
        countdownAt: preparedAt,
        preparedAt,
        marketControls: Object.fromEntries([
          ['player', markets.get('0')],
          ['banker', markets.get('1')],
          ['playerPair', markets.get('3')],
          ['bankerPair', markets.get('4')],
        ]),
      },
    },
    chip,
    markets,
    unrelatedMarkets,
  };
}

function operationalRequest(amount = 10) {
  return {
    mode: 'live',
    wager: {
      wagerId: 'wager-pragmatic-1',
      tableId: 'bc281koreanch281',
      shoeId: 'pragmatic-bc281koreanch281-1',
      handId: '17260230224',
      market: 'playerPair',
      amount,
      source: 'manual',
    },
  };
}

describe('Pragmatic bet runtime', () => {
  it('serializes the readiness probe without closure dependencies', () => {
    const runtime = exportedRuntime();
    const page = pageContext(true);
    const result = runInNewContext(
      `(${String(runtime.probe)})('bc281koreanch281')`,
      page.context,
    ) as Record<string, unknown>;

    expect(result).toEqual(expect.objectContaining({
      status: 'ready',
      tableId: 'bc281koreanch281',
      roundId: '17260230224',
      runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
      routingAuthority: 'dedicated-referrer',
    }));
    expect(result.supportedChips).toEqual([10]);
  });

  it('recognizes a Chinese round label before declaring the frame ready', () => {
    const runtime = exportedRuntime();
    const page = pageContext(true, '局号：17260230224');
    const result = runInNewContext(
      `(${String(runtime.probe)})('bc281koreanch281')`,
      page.context,
    ) as Record<string, unknown>;

    expect(result).toEqual(expect.objectContaining({
      status: 'ready',
      roundId: '17260230224',
    }));
  });

  it('binds the target tile round to its prepared countdown lease', () => {
    const runtime = exportedRuntime();
    const openPage = multitablePageContext(8);
    const closingPage = multitablePageContext(2);
    const closedPage = multitablePageContext(null);
    const probe = `(${String(runtime.probe)})('tobcbaccaragen92')`;

    const open = runInNewContext(probe, openPage.context) as Record<string, unknown>;
    const closing = runInNewContext(probe, closingPage.context) as Record<string, unknown>;
    const closed = runInNewContext(probe, closedPage.context) as Record<string, unknown>;

    expect(open).toEqual(expect.objectContaining({
      status: 'ready',
      roundId: '17260578524',
      routingAuthority: 'prepared-multitable',
      markets: ['player', 'banker', 'playerPair', 'bankerPair'],
    }));
    expect(Number(open.countdown)).toBeGreaterThanOrEqual(7);
    expect(closed).toEqual(expect.objectContaining({
      status: 'closed',
      roundId: '17260578524',
    }));
    expect(closing).toEqual(expect.objectContaining({
      status: 'ready',
    }));
    expect(Number(closing.countdown)).toBeGreaterThanOrEqual(1);
    expect(Number(closing.countdown)).toBeLessThanOrEqual(2);
  });

  it('treats a multi-table tile with its own bet buttons as ready without sitting', () => {
    const runtime = exportedRuntime();
    const timer = element('8');
    const header = element('ID: 17260578524');
    const player = element('闲家');
    const banker = element('庄家');
    const root = element('粤语极速百家乐¥ 10ID: 17260578524');
    root.querySelector = (selector: string): FakeElement | null => {
      if (selector.includes('game-header-game-id')) return header;
      if (selector.includes('timer-countdown')) return timer;
      if (selector === '[data-betcode="0"]') return player;
      if (selector === '[data-betcode="1"]') return banker;
      return null;
    };
    root.querySelectorAll = (selector: string): FakeElement[] => {
      if (selector === '[data-betcode="0"]') return [player];
      if (selector === '[data-betcode="1"]') return [banker];
      if (selector.includes('data-betcode="0"') && selector.includes('data-betcode="1"')) return [player, banker];
      return [];
    };
    const result = runInNewContext(
      `(${String(runtime.probe)})('tobcbaccaragen92')`,
      {
        document: {
          referrer: '',
          querySelector: () => null,
          querySelectorAll: () => [],
          getElementById: (id: string) => id === 'TileHeight-tobcbaccaragen92' ? root : null,
        },
        location: {
          pathname: '/desktop/multibaccarat/',
          hostname: 'client.pragmaticplaylive.net',
        },
        URL,
        Date,
        Number,
        Object,
        Array,
        String,
        Promise,
        setTimeout,
        innerWidth: 1280,
        innerHeight: 720,
      },
    ) as Record<string, unknown>;

    expect(result).toEqual(expect.objectContaining({
      status: 'ready',
      tableId: 'tobcbaccaragen92',
      routingAuthority: 'table-root',
      roundId: '17260578524',
    }));
  });

  it('requires a fresh prepared-table lease for the shared multitable betting panel', () => {
    const runtime = exportedRuntime();
    const wrongTable = multitablePageContext(8, 'otherpragmatictable');
    const expired = multitablePageContext(8, 'tobcbaccaragen92', Date.now() - 6_000);
    const probe = `(${String(runtime.probe)})('tobcbaccaragen92')`;

    expect(runInNewContext(probe, wrongTable.context)).toEqual(expect.objectContaining({
      status: 'closed',
      tableId: 'tobcbaccaragen92',
    }));
    expect(runInNewContext(probe, expired.context)).toEqual(expect.objectContaining({
      status: 'closed',
      tableId: 'tobcbaccaragen92',
    }));
  });

  it('prepares a multitable wager even when the readable panel round differs', async () => {
    const runtime = exportedRuntime();
    const page = multitablePageContext(8);
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;

    const request = {
      mode: 'live',
      wager: {
        wagerId: 'wager-pragmatic-multitable-1',
        tableId: 'tobcbaccaragen92',
        shoeId: 'pragmatic-tobcbaccaragen92-1',
        handId: 'different-round',
        market: 'player',
        amount: 10,
        source: 'manual',
      },
    };
    const prepared = await execute(request, { phase: 'prepare' });
    const marketTarget = await execute(request, {
      phase: 'target',
      action: 'market',
      denomination: 10,
      expectedRoundId: '17260578524',
    });

    expect(prepared).toEqual(expect.objectContaining({
      phase: 'prepared',
      currentRoundId: '17260578524',
      skipChipSelection: true,
      denominations: [],
    }));
    expect(marketTarget).toEqual(expect.objectContaining({
      phase: 'target',
      action: 'market',
      currentRoundId: '17260578524',
      point: expect.objectContaining({ viewportWidth: 1280, viewportHeight: 720 }),
    }));
    expect(page.chip.click).not.toHaveBeenCalled();
    expect(page.markets.get('0')?.click).not.toHaveBeenCalled();
  });

  it('observes acceptance only after the trusted caller changes the platform total', async () => {
    const runtime = exportedRuntime();
    const page = multitablePageContext(8);
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;

    const request = {
      mode: 'live',
      wager: {
        wagerId: 'wager-pragmatic-multitable-2',
        tableId: 'tobcbaccaragen92',
        shoeId: 'pragmatic-tobcbaccaragen92-1',
        handId: '17260578524',
        market: 'player',
        amount: 10,
        source: 'manual',
      },
    };
    const prepared = await execute(request, { phase: 'prepare' });
    page.markets.get('0')?.click();
    const receipt = await execute(request, {
      phase: 'observe',
      beforeTotal: prepared.beforeTotal,
      beforeTotalObserved: prepared.beforeTotalObserved,
      expectedTotal: 10,
      expectedRoundId: '17260578524',
      selectedChips: ['default'],
      final: true,
    });

    expect(page.chip.click).not.toHaveBeenCalled();
    expect(page.markets.get('0')?.click).toHaveBeenCalledOnce();
    expect(page.unrelatedMarkets.get('0')?.click).not.toHaveBeenCalled();
    expect(receipt).toEqual(expect.objectContaining({
      status: 'ACCEPTED',
      tableId: 'tobcbaccaragen92',
      handId: '17260578524',
      raw: expect.objectContaining({
        runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
        commitStarted: true,
        trustedInput: true,
      }),
    }));
  });

  it('returns click coordinates without dispatching synthetic DOM clicks', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true);
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;

    const chipTarget = await execute(operationalRequest(), {
      phase: 'target',
      action: 'chip',
      denomination: 10,
      expectedRoundId: '17260230224',
    });
    const marketTarget = await execute(operationalRequest(), {
      phase: 'target',
      action: 'market',
      expectedRoundId: '17260230224',
    });

    expect(chipTarget).toEqual(expect.objectContaining({
      status: 'REJECTED',
      raw: expect.objectContaining({ reason: 'chip-selection-disabled' }),
    }));
    expect(marketTarget).toEqual(expect.objectContaining({
      phase: 'target',
      action: 'market',
    }));
    expect(page.chip.click).not.toHaveBeenCalled();
    expect(page.playerPair.click).not.toHaveBeenCalled();
  });

  it('accepts a market click through a covering sibling graphic', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true);
    const overlay = element('');
    const spot = element('');
    overlay.tagName = 'SVG';
    spot.tagName = 'DIV';
    page.playerPair.parentElement = spot;
    overlay.parentElement = spot;
    spot.contains = node => node === spot || node === overlay || node === page.playerPair;
    page.playerPair.contains = node => node === page.playerPair;
    overlay.contains = node => node === overlay;
    page.playerPair.getBoundingClientRect = () => ({
      left: 100, top: 200, x: 100, y: 200, width: 40, height: 16,
    });
    overlay.getBoundingClientRect = () => ({
      left: 80, top: 160, x: 80, y: 160, width: 120, height: 80,
    });
    spot.getBoundingClientRect = () => ({
      left: 80, top: 160, x: 80, y: 160, width: 120, height: 80,
    });
    (page.context.document as { elementsFromPoint?: (x: number, y: number) => FakeElement[] })
      .elementsFromPoint = () => [overlay, page.playerPair, spot];

    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const marketTarget = await execute(operationalRequest(), {
      phase: 'target',
      action: 'market',
      expectedRoundId: '17260230224',
    });

    expect(marketTarget).toEqual(expect.objectContaining({
      phase: 'target',
      action: 'market',
      point: expect.objectContaining({
        hitTag: 'SVG',
        viewportWidth: 1280,
        viewportHeight: 720,
      }),
    }));
    expect(page.playerPair.click).not.toHaveBeenCalled();
  });

  it('does not select chips and uses the page default chip instead', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true);
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const prepared = await execute(operationalRequest(), { phase: 'prepare' });
    const chipTarget = await execute(operationalRequest(), {
      phase: 'target',
      action: 'chip',
      expectedRoundId: '17260230224',
    });

    expect(prepared).toEqual(expect.objectContaining({
      skipChipSelection: true,
      denominations: [],
    }));
    expect(chipTarget).toEqual(expect.objectContaining({
      status: 'REJECTED',
      raw: expect.objectContaining({ reason: 'chip-selection-disabled' }),
    }));
    expect(page.chip.click).not.toHaveBeenCalled();
  });

  it('rejects a click-path target when the page round does not match', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true, 'ID: 17260230224');
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const receipt = await execute({
      ...operationalRequest(),
      wager: { ...operationalRequest().wager, handId: '17260239999' },
    }, {
      phase: 'target',
      action: 'market',
      expectedRoundId: '17260239999',
    });
    expect(receipt).toEqual(expect.objectContaining({
      status: 'REJECTED',
      raw: expect.objectContaining({ reason: 'round-not-current' }),
    }));
  });

  it('rechecks the betting window before returning a market click target', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true);
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;

    const prepared = await execute(operationalRequest(), { phase: 'prepare' });
    expect(prepared).toEqual(expect.objectContaining({ phase: 'prepared' }));
    if (page.timer) page.timer.textContent = '0';
    const receipt = await execute(operationalRequest(), {
      phase: 'target',
      action: 'market',
      denomination: 10,
      expectedRoundId: '17260230224',
    });

    expect(page.chip.click).not.toHaveBeenCalled();
    expect(page.playerPair.click).not.toHaveBeenCalled();
    expect(receipt).toEqual(expect.objectContaining({
      status: 'REJECTED',
      raw: expect.objectContaining({
        runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
        reason: 'betting-window-closed',
        commitStarted: false,
      }),
    }));
  });

  it('still sends a request-path wager when the tile round id cannot be scraped', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true, 'no-round-header');
    const placeBet = vi.fn(() => ({ ok: true }));
    page.context.__baccaratPragmaticBetChannel = { placeBet };
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const requested = await execute(operationalRequest(), {
      phase: 'request',
      expectedRoundId: '17260230224',
    });
    expect(placeBet).toHaveBeenCalled();
    expect(requested).toEqual(expect.objectContaining({
      phase: 'requested',
      requestSent: true,
    }));
  });

  it('does not send a request-path wager before the page shows the same round', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true, 'ID: 17260230224');
    const placeBet = vi.fn(() => ({ ok: true }));
    page.context.__baccaratPragmaticBetChannel = { placeBet };
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const requested = await execute({
      ...operationalRequest(),
      wager: { ...operationalRequest().wager, handId: '17260239999' },
    }, {
      phase: 'request',
      expectedRoundId: '17260239999',
    });
    expect(placeBet).not.toHaveBeenCalled();
    expect(requested).toEqual(expect.objectContaining({
      phase: 'request-unavailable',
      reason: 'round-not-current',
      currentRoundId: '17260230224',
      expectedRoundId: '17260239999',
    }));
  });

  it('still sends a multiplay request-path wager when the tile round label differs from the protocol hand', async () => {
    const runtime = exportedRuntime();
    const page = multitablePageContext(8, 'tobcbaccaragen92', Date.now() - 6_000);
    const placeBet = vi.fn(() => ({ ok: true }));
    page.context.__baccaratPragmaticBetChannel = { placeBet };
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const requested = await execute({
      mode: 'live',
      wager: {
        wagerId: 'wager-multitable-round-label',
        tableId: 'tobcbaccaragen92',
        shoeId: 'pragmatic-tobcbaccaragen92-1',
        handId: '16418031910',
        market: 'player',
        amount: 10,
        source: 'manual',
      },
    }, {
      phase: 'request',
      expectedRoundId: '16418031910',
    });
    expect(placeBet).toHaveBeenCalledWith(expect.objectContaining({
      tableId: 'tobcbaccaragen92',
      roundId: '16418031910',
    }));
    expect(requested).toEqual(expect.objectContaining({
      phase: 'requested',
      requestSent: true,
    }));
  });

  it('still sends a multiplay request-path wager when the target tile timer is stale', async () => {
    const runtime = exportedRuntime();
    const page = multitablePageContext(8, 'tobcbaccaragen92', Date.now() - 6_000);
    const placeBet = vi.fn(() => ({ ok: true }));
    page.context.__baccaratPragmaticBetChannel = { placeBet };
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const requested = await execute({
      mode: 'live',
      wager: {
        wagerId: 'wager-multitable-stale-timer',
        tableId: 'tobcbaccaragen92',
        shoeId: 'pragmatic-tobcbaccaragen92-1',
        handId: '17260578524',
        market: 'player',
        amount: 10,
        source: 'manual',
      },
    }, {
      phase: 'request',
      expectedRoundId: '17260578524',
    });
    expect(placeBet).toHaveBeenCalledWith(expect.objectContaining({
      tableId: 'tobcbaccaragen92',
      roundId: '17260578524',
    }));
    expect(requested).toEqual(expect.objectContaining({
      phase: 'requested',
      requestSent: true,
    }));
  });

  it('does not send a request-path wager after the betting window has closed', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(false);
    const placeBet = vi.fn(() => ({ ok: true }));
    page.context.__baccaratPragmaticBetChannel = { placeBet };
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const requested = await execute(operationalRequest(), {
      phase: 'request',
      expectedRoundId: '17260230224',
    });
    expect(placeBet).not.toHaveBeenCalled();
    expect(requested).toEqual(expect.objectContaining({
      phase: 'request-unavailable',
      reason: 'betting-window-closed',
    }));
  });

  it('does not accept a request-path wager until the platform acknowledges it', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true);
    page.context.__baccaratPragmaticBetChannel = {
      placeBet: () => ({ ok: true }),
    };
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const receipt = await execute(operationalRequest(), {
      phase: 'request',
      expectedRoundId: '17260230224',
    });
    expect(receipt).toEqual(expect.objectContaining({
      phase: 'requested',
      requestSent: true,
      currentRoundId: '17260230224',
    }));
    expect(receipt).not.toHaveProperty('status', 'ACCEPTED');
    expect(page.playerPair.click).not.toHaveBeenCalled();
  });

  it('does not send lpbet from a dedicated frame bound to a different table', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true);
    const placeBet = vi.fn(() => ({ ok: true }));
    page.context.__baccaratPragmaticBetChannel = { placeBet };
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const requested = await execute({
      mode: 'live',
      wager: {
        wagerId: 'wager-wrong-dedicated',
        tableId: 'bcpirpmfpeobc198',
        shoeId: 'pragmatic-bcpirpmfpeobc198-1',
        handId: '16413832010',
        market: 'player',
        amount: 10,
        source: 'keepalive',
      },
    }, {
      phase: 'request',
      expectedRoundId: '16413832010',
    });

    expect(placeBet).not.toHaveBeenCalled();
    expect(requested).toEqual(expect.objectContaining({
      phase: 'request-unavailable',
      reason: 'table-not-in-current-session',
    }));
  });

  it('targets the prepared tile market instead of a unique shared panel from another table', async () => {
    const runtime = exportedRuntime();
    const page = multitablePageContext(8);
    const tile = page.context.document.getElementById('TileHeight-tobcbaccaragen92');
    const sharedMarkets = new Map([
      ['0', element('共享闲家')],
      ['1', element('共享庄家')],
      ['3', element('共享闲对')],
      ['4', element('共享庄对')],
    ]);
    for (const shared of sharedMarkets.values()) {
      shared.closest = () => null;
      shared.getBoundingClientRect = () => ({ x: 20, y: 20, width: 80, height: 40, left: 20, top: 20 });
    }
    for (const [code, tileMarket] of page.markets) {
      tileMarket.closest = () => tile;
      if (code === '0') {
        tileMarket.getBoundingClientRect = () => ({ x: 400, y: 300, width: 80, height: 40, left: 400, top: 300 });
      }
    }
    const document = page.context.document as {
      querySelectorAll(selector: string): FakeElement[];
    };
    const originalQuery = document.querySelectorAll.bind(document);
    document.querySelectorAll = (selector: string) => {
      const code = selector.match(/^\[data-betcode="([0-4])"\]$/)?.[1];
      if (code) {
        return [sharedMarkets.get(code), page.markets.get(code)].filter(
          (entry): entry is FakeElement => Boolean(entry),
        );
      }
      return originalQuery(selector);
    };
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const request = {
      mode: 'live',
      wager: {
        wagerId: 'wager-tile-not-shared',
        tableId: 'tobcbaccaragen92',
        shoeId: 'pragmatic-tobcbaccaragen92-1',
        handId: '17260578524',
        market: 'player',
        amount: 10,
        source: 'keepalive',
      },
    };
    const marketTarget = await execute(request, {
      phase: 'target',
      action: 'market',
      expectedRoundId: '17260578524',
    });

    expect(marketTarget).toEqual(expect.objectContaining({
      phase: 'target',
      action: 'market',
      point: expect.objectContaining({ x: 440, y: 320 }),
    }));
    expect(sharedMarkets.get('0')?.click).not.toHaveBeenCalled();
  });

  it('reports that request betting is unavailable until a real send template exists', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true);
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;
    const requested = await execute(operationalRequest(), {
      phase: 'request',
      expectedRoundId: '17260230224',
    });
    expect(requested).toEqual(expect.objectContaining({
      phase: 'request-unavailable',
      reason: 'bet-request-channel-unavailable',
    }));
    expect(page.playerPair.click).not.toHaveBeenCalled();
  });

  it('prepares a default-chip wager without clicking either control', async () => {
    const runtime = exportedRuntime();
    const page = pageContext(true);
    const execute = runInNewContext(`(${String(runtime.execute)})`, page.context) as
      (request: unknown, command: unknown) => Promise<Record<string, unknown>>;

    const prepared = await execute(operationalRequest(20), { phase: 'prepare' });

    expect(page.chip.click).not.toHaveBeenCalled();
    expect(page.playerPair.click).not.toHaveBeenCalled();
    expect(prepared).toEqual(expect.objectContaining({
      phase: 'prepared',
      amount: 20,
      skipChipSelection: true,
      denominations: [],
    }));
  });
});
