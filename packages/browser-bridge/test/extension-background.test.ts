import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  createHarness,
  FakeWebSocket as BetHarnessWebSocket,
  flushAsyncWork as flushBetHarnessAsyncWork,
  liveRequest,
  sentMessages,
} from './extension-bet-harness.js';

const backgroundSource = readFileSync(
  new URL('../../../apps/browser-extension/background.js', import.meta.url),
  'utf8',
);

type SocketEvent = { readonly data?: string };
type SocketListener = (event: SocketEvent) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly listeners = new Map<string, SocketListener[]>();
  readyState = FakeWebSocket.OPEN;

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name: string, listener: SocketListener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  emit(name: string, event: SocketEvent = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

function flushAsyncWork(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function isMstromProbeInjection(value: unknown): boolean {
  const source = String(value);
  return source.includes('__baccaratMstromBetProbe') || source.includes('probeMstromBetStore');
}

function isMstromFinalInjection(value: unknown): boolean {
  const source = String(value);
  return source.includes('__baccaratMstromBetExecute')
    || source.includes('executeMstromBetOneShot');
}

describe('extension background multitable command', () => {
  it('revokes the live gate before reloading a frozen baccarat popup', async () => {
    const harness = await createHarness();

    harness.socket.emit('message', {
      data: JSON.stringify({
        kind: 'command',
        name: 'reloadGameTabs',
        tableIds: ['D066', 'D067'],
      }),
    });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.chrome.storage.local.set).toHaveBeenCalledWith({ liveBetEnabled: false });
    expect(harness.chrome.tabs.reload).toHaveBeenCalledOnce();
    expect(harness.chrome.tabs.reload).toHaveBeenCalledWith(42, { bypassCache: true });
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'sessionAction',
      action: 'command-executed',
      detail: 'reloadGameTabs:reloaded=1:tables=2',
    }));

    harness.socket.emit('message', { data: JSON.stringify(liveRequest('blocked-after-reload')) });
    await flushBetHarnessAsyncWork();
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'blocked-after-reload',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        raw: expect.objectContaining({
          commitStarted: false,
          reason: expect.stringContaining('live betting is disabled'),
        }),
      }),
    }));
  });

  it('opens the casino multitable view only in every frame of the active game tab', async () => {
    FakeWebSocket.instances.length = 0;
    const executeScript = vi.fn().mockResolvedValue([
      { result: { status: 'opened', frameUrl: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' } },
    ]);
    const tabQuery = vi.fn().mockResolvedValue([
      { id: 42, url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-pa' },
    ]);
    const storageSet = vi.fn().mockResolvedValue(undefined);
    const socketListeners: Array<(message: { readonly data: string }) => void> = [];

    const eventTarget = { addListener: vi.fn() };
    const chrome = {
      storage: {
        local: {
          get: vi.fn().mockImplementation(async (defaults: Record<string, unknown>) => defaults),
          set: storageSet,
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: eventTarget,
      },
      runtime: {
        getManifest: () => ({ version: 'test' }),
        lastError: undefined,
        onInstalled: eventTarget,
        onStartup: eventTarget,
        onMessage: {
          addListener(listener: (message: { readonly data: string }) => void): void {
            socketListeners.push(listener);
          },
        },
      },
      tabs: {
        query: tabQuery,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        onUpdated: eventTarget,
        onRemoved: eventTarget,
      },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue(undefined),
      },
      scripting: { executeScript },
    };

    const context = vm.createContext({
      chrome,
      WebSocket: FakeWebSocket,
      navigator: { userAgent: 'test-browser' },
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      Date,
      JSON,
      Math,
      Number,
      String,
      Promise,
    });
    vm.runInContext(backgroundSource, context, { filename: 'background.js' });
    await flushAsyncWork();

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.emit('open');
    socket.emit('message', { data: JSON.stringify({ kind: 'command', name: 'openMultiView' }) });

    await flushAsyncWork();
    await flushAsyncWork();

    const multiViewCall = executeScript.mock.calls.find(([options]) => String(options.func).includes('openMultiplayPage'));
    expect(multiViewCall).toBeDefined();
    const [options] = multiViewCall ?? [];
    expect(options.target).toEqual({ tabId: 42, allFrames: true });
    expect(options.world).toBe('MAIN');
    expect(String(options.func)).toContain('openMultiplayPage');
    const openMultiplayPage = vi.fn();
    const aliasResult = vm.runInNewContext(`(${String(options.func)})()`, {
      location: {
        hostname: 'live2.673ing.com',
        href: 'https://live2.673ing.com/ogplus/',
      },
      MicroSDK: {
        Utils: { createInstance: () => ({ openMultiplayPage }) },
        Plaza: { MultiplayStore: {} },
      },
    });
    expect(aliasResult).toEqual(expect.objectContaining({ status: 'opened', state: 'store' }));
    expect(openMultiplayPage).toHaveBeenCalledWith({ fromEntry: 'MultiTab' });
    expect(storageSet).not.toHaveBeenCalledWith({ liveBetEnabled: true });
    expect(storageSet).not.toHaveBeenCalledWith({ liveBetEnabled: false });
    expect(socket.sent.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({
      kind: 'sessionAction',
      action: 'command-executed',
      detail: 'openMultiView:opened:1',
    }));
    expect(socketListeners).toHaveLength(1);
  });

  it('restores configured tables through the page GameLink store before opening multiview', async () => {
    FakeWebSocket.instances.length = 0;
    const executeScript = vi.fn().mockResolvedValue([]);
    const eventTarget = { addListener: vi.fn() };
    const chrome = {
      storage: {
        local: {
          get: vi.fn().mockImplementation(async (defaults: Record<string, unknown>) => defaults),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: eventTarget,
      },
      runtime: {
        getManifest: () => ({ version: 'test' }),
        lastError: undefined,
        onInstalled: eventTarget,
        onStartup: eventTarget,
        onMessage: eventTarget,
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{
          id: 42,
          url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-pa',
        }]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        onUpdated: eventTarget,
        onRemoved: eventTarget,
      },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue(undefined),
      },
      scripting: { executeScript },
    };

    const context = vm.createContext({
      chrome,
      WebSocket: FakeWebSocket,
      navigator: { userAgent: 'test-browser' },
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      Date,
      JSON,
      Math,
      Number,
      String,
      Promise,
    });
    vm.runInContext(backgroundSource, context, { filename: 'background.js' });
    await flushAsyncWork();

    const configuredTableIds = ['D066', 'D067', 'D056', 'D057'];
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({ kind: 'command', name: 'openMultiView', tableIds: configuredTableIds }),
    });

    await flushAsyncWork();
    await flushAsyncWork();

    const multiViewCall = executeScript.mock.calls.find(([options]) => String(options.func).includes('openMultiplayPage'));
    expect(multiViewCall).toBeDefined();
    const [options] = multiViewCall ?? [];
    expect(options.args).toEqual([configuredTableIds]);
    const changeTable = vi.fn();
    const connectSocket = vi.fn();
    const changeGame = vi.fn();
    const result = vm.runInNewContext(`(${String(options.func)})(${JSON.stringify(configuredTableIds)})`, {
      location: {
        hostname: 'gci.agad.mstrom-uno.com',
        href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
      },
      MicroSDK: {
        Plaza: {
          getRootPageStore: () => ({ changeGame }),
        },
      },
      VideoGameCore: {
        GAME_LINK: 'LINK',
        GameLinkStore: {
          instance: {
            changeTable,
            connectSocket,
          },
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'opened',
      state: 'configured-game-link',
    }));
    expect(changeTable.mock.calls).toEqual(configuredTableIds.map((tableId, index) => [tableId, index]));
    expect(connectSocket).toHaveBeenCalledOnce();
    expect(changeGame).toHaveBeenCalledWith('LINK');
  });

  it('replays and reports MAIN-world runtime probe diagnostics for an allowed game tab', async () => {
    FakeWebSocket.instances.length = 0;
    const executeScript = vi.fn().mockImplementation(async (options: { readonly files?: readonly string[]; readonly func?: unknown }) => {
      if (options.files?.includes('runtime-state-hook.js')) return [];
      if (String(options.func).includes('__baccaratRuntimeStateHookReplay')) {
        return [{
          frameId: 7,
          result: {
            frameUrl: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
            host: 'gci.agad.mstrom-uno.com',
            hook: 'present',
            replay: 'called',
          },
        }];
      }
      return [];
    });
    const eventTarget = { addListener: vi.fn() };
    const chrome = {
      storage: {
        local: {
          get: vi.fn().mockImplementation(async (defaults: Record<string, unknown>) => defaults),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: eventTarget,
      },
      runtime: {
        getManifest: () => ({ version: 'test' }),
        lastError: undefined,
        onInstalled: eventTarget,
        onStartup: eventTarget,
        onMessage: eventTarget,
      },
      tabs: {
        query: vi.fn().mockResolvedValue([
          { id: 42, url: 'https://evoad.df888evo.com/live/baccarat' },
        ]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        onUpdated: eventTarget,
        onRemoved: eventTarget,
      },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue(undefined),
      },
      scripting: { executeScript },
    };
    const context = vm.createContext({
      chrome,
      WebSocket: FakeWebSocket,
      navigator: { userAgent: 'test-browser' },
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      Date,
      JSON,
      Math,
      Number,
      String,
      Promise,
    });

    vm.runInContext(backgroundSource, context, { filename: 'background.js' });
    await flushAsyncWork();
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket.emit('open');
    await flushAsyncWork();
    await flushAsyncWork();

    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 42, allFrames: true },
      files: ['runtime-state-hook.js'],
      world: 'MAIN',
    }));
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 42, allFrames: true },
      world: 'MAIN',
      func: expect.any(Function),
    }));
    expect(executeScript.mock.calls.some(([options]) => String(options.func).includes('__baccaratRuntimeStateHookReplay'))).toBe(true);
    expect(socket.sent.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({
      kind: 'networkCapture',
      source: 'baccarat-bridge-runtime-probe',
      url: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?',
    }));
  });

  it('does not inject or expose the bet runtime during gate-off replay', async () => {
    const harness = await createHarness({ armCurrentSession: false });

    harness.socket.emit('open');
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => injection.files?.includes('mstrom-bet-runtime.js'),
    )).toBe(false);
    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isMstromProbeInjection(injection.func),
    )).toBe(false);
    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isMstromFinalInjection(injection.func),
    )).toBe(false);
  });

  it('replays the current runtime state after a supported game tab completes loading', async () => {
    FakeWebSocket.instances.length = 0;
    const executeScript = vi.fn().mockResolvedValue([]);
    const eventTarget = { addListener: vi.fn() };
    const tabUpdatedListeners: Array<(tabId: number, changeInfo: { readonly status?: string }, tab: { readonly url?: string }) => void> = [];
    const chrome = {
      storage: {
        local: {
          get: vi.fn().mockImplementation(async (defaults: Record<string, unknown>) => defaults),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: eventTarget,
      },
      runtime: {
        getManifest: () => ({ version: 'test' }),
        lastError: undefined,
        onInstalled: eventTarget,
        onStartup: eventTarget,
        onMessage: eventTarget,
      },
      tabs: {
        query: vi.fn().mockResolvedValue([
          { id: 42, url: 'https://evoad.df888evo.com/live/baccarat' },
        ]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        onUpdated: {
          addListener(listener: (tabId: number, changeInfo: { readonly status?: string }, tab: { readonly url?: string }) => void): void {
            tabUpdatedListeners.push(listener);
          },
        },
        onRemoved: eventTarget,
      },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue(undefined),
      },
      scripting: { executeScript },
    };
    const context = vm.createContext({
      chrome,
      WebSocket: FakeWebSocket,
      navigator: { userAgent: 'test-browser' },
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      Date,
      JSON,
      Math,
      Number,
      String,
      Promise,
    });

    vm.runInContext(backgroundSource, context, { filename: 'background.js' });
    expect(tabUpdatedListeners).toHaveLength(1);

    tabUpdatedListeners[0]?.(42, { status: 'complete' }, { url: 'https://evoad.df888evo.com/live/baccarat' });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(executeScript.mock.calls.some(([options]) => String(options.func).includes('__baccaratRuntimeStateHookReplay'))).toBe(true);
  });

  it('reports live-bet readiness without executing a wager', async () => {
    const harness = await createHarness();

    harness.socket.emit('message', {
      data: JSON.stringify({
        kind: 'command',
        name: 'probeBetReadiness',
        tableIds: ['D067'],
      }),
    });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isMstromProbeInjection(injection.func),
    )).toBe(true);
    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isMstromFinalInjection(injection.func),
    )).toBe(false);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'sessionAction',
      action: 'command-executed',
      detail: expect.stringContaining('probeBetReadiness:D067:candidates=1'),
    }));
  });

  it('reports safe frame structure when no target bet store is found', async () => {
    const harness = await createHarness({
      probeResults: [{
        frameId: 7,
        result: {
          frameUrl: 'https://gci.agad.mstrom-uno.com/pc/pcv2/index.jsp',
          host: 'gci.agad.mstrom-uno.com',
          tableId: 'D067',
          ownsTargetStore: false,
          diagnostics: {
            corePresent: true,
            coreKeys: ['LinkStoreFactory'],
            linkFactoryPresent: true,
            linkFactoryKeys: ['getBetTableStore', 'betStoreMap'],
            gameLinkStorePresent: true,
            gameLinkStoreKeys: ['visibleVids'],
          },
        },
      }],
    });

    harness.socket.emit('message', {
      data: JSON.stringify({
        kind: 'command',
        name: 'probeBetReadiness',
        tableIds: ['D067'],
      }),
    });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'sessionAction',
      action: 'command-executed',
      detail: expect.stringContaining(
        'frames=host=gci.agad.mstrom-uno.com,core=true,coreKeys=LinkStoreFactory,linkFactory=true,linkKeys=getBetTableStore,betStoreMap',
      ),
    }));
  });

});
describe('extension background live bet gate', () => {
  it.each(['close', 'error'] as const)(
    'invalidates an in-flight bet when the bridge WebSocket reports %s before execution',
    async event => {
      const harness = await createHarness();
      type ScriptInjection = {
        readonly files?: readonly string[];
        readonly func?: unknown;
      };
      type ProbeResult = {
        readonly frameId: number;
        readonly result: Readonly<Record<string, unknown>>;
      };
      let releaseProbe: ((results: readonly ProbeResult[]) => void) | undefined;
      const pendingProbe = new Promise<readonly ProbeResult[]>(resolve => {
        releaseProbe = resolve;
      });
      harness.executeScript.mockImplementation(async (injection: ScriptInjection) => {
        if (injection.files?.includes('mstrom-bet-runtime.js')) return [];
        if (isMstromProbeInjection(injection.func)) {
          return pendingProbe;
        }
        if (isMstromFinalInjection(injection.func)) {
          return [{ frameId: 7, result: harness.receipt }];
        }
        return [];
      });

      harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
      await flushBetHarnessAsyncWork();
      await flushBetHarnessAsyncWork();

      expect(harness.executeScript.mock.calls.some(
        ([injection]) => isMstromProbeInjection(injection.func),
      )).toBe(true);

      if (event === 'close') harness.socket.close();
      harness.socket.emit(event);
      expect(harness.runNextTimer()).toBe(true);
      await flushBetHarnessAsyncWork();
      await flushBetHarnessAsyncWork();
      const reconnectedSocket = BetHarnessWebSocket.instances[1];
      expect(reconnectedSocket).toBeDefined();
      if (!reconnectedSocket) throw new Error('reconnected WebSocket was not created');
      reconnectedSocket.emit('open');
      reconnectedSocket.emit('message', {
        data: JSON.stringify({ kind: 'command', name: 'liveOn' }),
      });
      await flushBetHarnessAsyncWork();
      await flushBetHarnessAsyncWork();
      if (!releaseProbe) throw new Error('probe release callback was not initialized');
      releaseProbe([{
        frameId: 7,
        result: {
          status: 'ready',
          runtimeRevision: 'mstrom-bet-runtime/2026-08-28.1',
          frameUrl: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp',
          host: 'gci.agad.mstrom-uno.com',
          tableId: 'D067',
        },
      }]);
      await flushBetHarnessAsyncWork();
      await flushBetHarnessAsyncWork();

      expect(harness.executeScript.mock.calls.some(
        ([injection]) => isMstromFinalInjection(injection.func),
      )).toBe(false);
    },
  );

  it.each(['close', 'error'] as const)(
    'returns UNKNOWN exactly once when the final execute is in flight and the bridge reports %s',
    async event => {
      const harness = await createHarness();
      type ScriptInjection = {
        readonly files?: readonly string[];
        readonly func?: unknown;
        readonly target?: { readonly frameIds?: readonly number[] };
      };
      type ProbeResult = {
        readonly frameId: number;
        readonly result: Readonly<Record<string, unknown>>;
      };
      let releaseFinal: ((results: readonly ProbeResult[]) => void) | undefined;
      const pendingFinal = new Promise<readonly ProbeResult[]>(resolve => {
        releaseFinal = resolve;
      });
      harness.executeScript.mockImplementation(async (injection: ScriptInjection) => {
        if (injection.files?.includes('mstrom-bet-runtime.js')) return [];
        if (isMstromProbeInjection(injection.func)) {
          return [{
            frameId: 7,
            result: {
              status: 'ready',
              runtimeRevision: 'mstrom-bet-runtime/2026-08-28.1',
              frameUrl: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp',
              host: 'gci.agad.mstrom-uno.com',
              tableId: 'D067',
            },
          }];
        }
        const finalExecute =
          injection.target?.frameIds?.length === 1
          && isMstromFinalInjection(injection.func);
        if (finalExecute) return pendingFinal;
        return [];
      });

      harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
      await flushBetHarnessAsyncWork();
      await flushBetHarnessAsyncWork();

      expect(harness.executeScript.mock.calls.some(
        ([injection]) => {
          const target = injection.target as ScriptInjection['target'];
          return target?.frameIds?.length === 1 && isMstromFinalInjection(injection.func);
        },
      )).toBe(true);

      if (event === 'close') harness.socket.close();
      harness.socket.emit(event);
      if (!releaseFinal) throw new Error('final execute release callback was not initialized');
      releaseFinal([{ frameId: 7, result: harness.receipt }]);
      await flushBetHarnessAsyncWork();
      await flushBetHarnessAsyncWork();

      expect(harness.runNextTimer()).toBe(true);
      await flushBetHarnessAsyncWork();
      await flushBetHarnessAsyncWork();
      const reconnectedSocket = BetHarnessWebSocket.instances[1];
      expect(reconnectedSocket).toBeDefined();
      if (!reconnectedSocket) throw new Error('reconnected WebSocket was not created');
      reconnectedSocket.emit('open');
      await flushBetHarnessAsyncWork();

      expect(sentMessages(reconnectedSocket).filter(
        message => message.kind === 'betResult' && message.requestId === 'request-1',
      )).toHaveLength(0);
      expect(harness.executeScript.mock.calls.filter(
        ([injection]) => {
          const target = injection.target as ScriptInjection['target'];
          return target?.frameIds?.length === 1 && isMstromFinalInjection(injection.func);
        },
      )).toHaveLength(1);
    },
  );

  it('returns UNKNOWN on the current socket when the gate closes after final execute starts', async () => {
    const harness = await createHarness();
    type ScriptInjection = {
      readonly files?: readonly string[];
      readonly func?: unknown;
      readonly target?: { readonly frameIds?: readonly number[] };
    };
    let releaseFinal: ((results: readonly { readonly frameId: number; readonly result: unknown }[]) => void) | undefined;
    const pendingFinal = new Promise<readonly { readonly frameId: number; readonly result: unknown }[]>(resolve => {
      releaseFinal = resolve;
    });
    harness.executeScript.mockImplementation(async (injection: ScriptInjection) => {
      if (isMstromProbeInjection(injection.func)) {
        return [{
          frameId: 7,
          result: {
            status: 'ready',
            runtimeRevision: 'mstrom-bet-runtime/2026-08-28.1',
            host: 'gci.agad.mstrom-uno.com',
            tableId: 'D067',
          },
        }];
      }
      if (injection.target?.frameIds?.length === 1 && isMstromFinalInjection(injection.func)) {
        return pendingFinal;
      }
      return [];
    });

    harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();
    harness.socket.emit('message', { data: JSON.stringify({ kind: 'command', name: 'liveOff' }) });
    await flushBetHarnessAsyncWork();
    if (!releaseFinal) throw new Error('final execute release callback was not initialized');
    releaseFinal([{ frameId: 7, result: harness.receipt }]);
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'request-1',
      receipt: expect.objectContaining({
        status: 'UNKNOWN',
        raw: expect.objectContaining({ commitPoint: 'confirmBet' }),
      }),
    }));
  });

  it('fails closed immediately when the bridge WebSocket closes', async () => {
    const harness = await createHarness();

    harness.socket.close();
    harness.socket.emit('close');
    harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isMstromFinalInjection(injection.func),
    )).toBe(false);
  });

  it('fails closed immediately when the bridge WebSocket reports an error', async () => {
    const harness = await createHarness();

    harness.socket.emit('error');
    harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isMstromFinalInjection(injection.func),
    )).toBe(false);
  });

  it('does not restore the live bet gate when the bridge reconnects', async () => {
    const harness = await createHarness();

    harness.socket.close();
    harness.socket.emit('close');
    expect(harness.runNextTimer()).toBe(true);
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    const reconnectedSocket = BetHarnessWebSocket.instances[1];
    expect(reconnectedSocket).toBeDefined();
    if (!reconnectedSocket) throw new Error('reconnected WebSocket was not created');
    reconnectedSocket.emit('open');
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();
    reconnectedSocket.emit('message', { data: JSON.stringify(liveRequest('after-reconnect')) });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isMstromFinalInjection(injection.func),
    )).toBe(false);
    expect(reconnectedSocket.sent.map(message => JSON.parse(message))).not.toContainEqual(
      expect.objectContaining({ kind: 'command', name: 'liveOn' }),
    );
  });
});
