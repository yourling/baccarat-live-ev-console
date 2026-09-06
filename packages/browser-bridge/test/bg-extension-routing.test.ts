import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FakeWebSocket,
  flushAsyncWork,
  sentMessages,
  withExecutorSignature,
} from './extension-bet-harness.js';

const backgroundSource = readFileSync(
  new URL('../../../apps/browser-extension-bg/background.js', import.meta.url),
  'utf8',
);
const betRuntimeSource = readFileSync(
  new URL('../../../apps/browser-extension-bg/bg-bet-runtime.js', import.meta.url),
  'utf8',
);
const networkHookSource = readFileSync(
  new URL('../../../apps/browser-extension-bg/bg-network-hook.js', import.meta.url),
  'utf8',
);
const manifest = JSON.parse(readFileSync(
  new URL('../../../apps/browser-extension-bg/manifest.json', import.meta.url),
  'utf8',
)) as { content_scripts?: Array<{ js?: string[] }> };

function bgOperationalRequest(requestId = 'bg-operational-1') {
  return {
    kind: 'betRequest',
    requestId,
    request: {
      mode: 'live',
      wager: {
        wagerId: 'bg-wager-1',
        tableId: 'B06',
        shoeId: 'bg-B06-1',
        handId: 'R-200',
        market: 'banker',
        amount: 10,
        source: 'manual',
        createdAt: '2026-09-05T01:00:00.000Z',
      },
    },
  };
}

async function createBgHarness(tabs: ReadonlyArray<{ id: number; url: string }>) {
  FakeWebSocket.instances.length = 0;
  const executeScript = vi.fn().mockImplementation(async (injection: {
    files?: string[];
    func?: unknown;
    args?: unknown[];
    target?: { frameIds?: number[]; allFrames?: boolean };
  }) => {
    if (injection.files?.includes('bg-bet-runtime.js')) return [];
    if (String(injection.func).includes('probeBgBetTable')) {
      return [{
        frameId: 11,
        result: {
          status: 'ready',
          runtimeRevision: 'bg-bet-runtime/2026-09-05.1',
          host: 'cdnx-hwa.jbz029.com',
          tableId: 'B06',
          diagnostics: { hasSocket: true, tableIds: ['B06'] },
        },
      }];
    }
    if (String(injection.func).includes('executeBgBetOneShot')) {
      const request = injection.args?.[0] as { wager?: Record<string, unknown> };
      const wager = request?.wager ?? {};
      return [{
        frameId: 11,
        result: {
          receiptId: 'bg-receipt-1',
          wagerId: wager.wagerId,
          tableId: wager.tableId,
          shoeId: wager.shoeId,
          handId: wager.handId,
          market: wager.market,
          amount: wager.amount,
          source: wager.source,
          status: 'ACCEPTED',
          externalRef: `bg:${String(wager.tableId)}:${String(wager.handId)}:playType:1`,
          createdAt: '2026-09-05T01:00:01.000Z',
          raw: { runtimeRevision: 'bg-bet-runtime/2026-09-05.1', commitStarted: true },
        },
      }];
    }
    return [];
  });
  const eventTarget = { addListener: vi.fn() };
  const chrome = {
    storage: {
      local: {
        get: vi.fn().mockImplementation(async (defaults: Record<string, unknown>) => ({
          ...defaults,
          liveBetEnabled: true,
          executorProfileId: 'profile-bg-test',
        })),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: eventTarget,
    },
    alarms: { create: vi.fn(), onAlarm: eventTarget },
    runtime: {
      getManifest: () => ({ version: 'test' }),
      onInstalled: eventTarget,
      onStartup: eventTarget,
      onMessage: eventTarget,
      onConnect: eventTarget,
    },
    tabs: {
      query: vi.fn().mockResolvedValue(tabs),
      onUpdated: eventTarget,
      onRemoved: eventTarget,
    },
    scripting: { executeScript },
  };
  const context = vm.createContext({
    chrome,
    WebSocket: FakeWebSocket,
    navigator: { userAgent: 'test-browser' },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    Date,
    JSON,
    Math,
    console,
    URL,
    URLSearchParams,
  });
  vm.runInContext(backgroundSource, context);
  Reflect.set(context, '__signExecutorPayload', (secret: string, payload: string) =>
    createHmac('sha256', String(secret || '')).update(String(payload || '')).digest('hex'));
  vm.runInContext(
    'hmacSha256Hex = async (secret, payload) => __signExecutorPayload(secret, payload);',
    context,
  );
  await flushAsyncWork();
  const socket = FakeWebSocket.instances[0];
  if (!socket) throw new Error('BG background did not open a bridge socket');
  socket.emit('message', {
    data: JSON.stringify({
      kind: 'executorLeaseGranted',
      leaseId: 'lease-bg-1',
      profileId: 'profile-bg-test',
      secret: 'secret-bg-1',
      reacquired: false,
      timestamp: '2026-09-05T01:00:00.000Z',
    }),
  });
  return { socket, executeScript };
}

describe('BG extension routing', () => {
  it('matches only the BG popup and does not install a bet runtime content script', () => {
    const scripts = (manifest.content_scripts ?? []).flatMap(entry => entry.js ?? []);
    expect(scripts).toContain('bg-network-hook.js');
    expect(scripts).not.toContain('bg-bet-runtime.js');
    expect(scripts).not.toContain('pragmatic-bet-runtime.js');
    expect(backgroundSource).toContain('/live-dealer/popup-launch/live-baccarat-bg');
    expect(backgroundSource).not.toContain('jeju-speed-baccarat');
    expect(backgroundSource).not.toContain('autoBet');
    expect(backgroundSource).toContain("name === 'reloadExtension'");
    expect(backgroundSource).toContain('scheduleExtensionReload');
    expect(backgroundSource).toContain('chrome.action.onClicked');
    expect(backgroundSource).toContain('chrome.commands.onCommand');
    expect(backgroundSource).toContain('pendingBgPopupReloadIds');
    expect(networkHookSource).not.toContain('autoBet');
    expect(JSON.stringify(manifest)).toContain('reload-extension');
    expect(betRuntimeSource).toContain('bg-adapter-missing');
  });

  it('rejects a wager when the open tab is not the BG popup', async () => {
    const harness = await createBgHarness([{
      id: 42,
      url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
    }]);
    const lease = { leaseId: 'lease-bg-1', secret: 'secret-bg-1' };
    harness.socket.emit('message', {
      data: JSON.stringify(withExecutorSignature(bgOperationalRequest(), lease)),
    });
    for (let tick = 0; tick < 6; tick += 1) await flushAsyncWork();
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        raw: expect.objectContaining({
          commitStarted: false,
          reason: expect.stringContaining('expected exactly one Dafabet BG popup tab, found 0'),
        }),
      }),
    }));
  });

  it('rejects a live-baccarat-pa popup', async () => {
    const harness = await createBgHarness([{
      id: 42,
      url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-pa',
    }]);
    const lease = { leaseId: 'lease-bg-1', secret: 'secret-bg-1' };
    harness.socket.emit('message', {
      data: JSON.stringify(withExecutorSignature(bgOperationalRequest(), lease)),
    });
    for (let tick = 0; tick < 6; tick += 1) await flushAsyncWork();
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        raw: expect.objectContaining({ commitStarted: false }),
      }),
    }));
  });

  it('rejects two BG popups', async () => {
    const harness = await createBgHarness([
      { id: 42, url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-bg' },
      { id: 43, url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-bg' },
    ]);
    const lease = { leaseId: 'lease-bg-1', secret: 'secret-bg-1' };
    harness.socket.emit('message', {
      data: JSON.stringify(withExecutorSignature(bgOperationalRequest(), lease)),
    });
    for (let tick = 0; tick < 6; tick += 1) await flushAsyncWork();
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        raw: expect.objectContaining({
          reason: expect.stringContaining('found 2'),
        }),
      }),
    }));
  });

  it('accepts a unique BG popup and returns an accepted four-market receipt', async () => {
    const harness = await createBgHarness([{
      id: 42,
      url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-bg',
    }]);
    const lease = { leaseId: 'lease-bg-1', secret: 'secret-bg-1' };
    harness.socket.emit('message', {
      data: JSON.stringify(withExecutorSignature(bgOperationalRequest(), lease)),
    });
    for (let tick = 0; tick < 8; tick += 1) await flushAsyncWork();
    expect(harness.executeScript.mock.calls.some(
      ([injection]) => Array.isArray(injection.files) && injection.files.includes('bg-bet-runtime.js'),
    )).toBe(true);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'ACCEPTED',
        tableId: 'B06',
        market: 'banker',
        raw: expect.objectContaining({ runtimeRevision: 'bg-bet-runtime/2026-09-05.1' }),
      }),
    }));
  });
});
