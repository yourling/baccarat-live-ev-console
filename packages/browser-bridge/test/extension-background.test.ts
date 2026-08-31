import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  createHarness,
  FakeWebSocket as BetHarnessWebSocket,
  flushAsyncWork as flushBetHarnessAsyncWork,
  pragmaticLiveRequest,
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

function isPragmaticProbeInjection(value: unknown): boolean {
  return String(value).includes('probePragmaticBetTable');
}

function isPragmaticFinalInjection(value: unknown): boolean {
  return String(value).includes('executePragmaticBetOneShot');
}

describe('extension background multitable command', () => {
  it('revokes the live gate before reloading a frozen baccarat popup', async () => {
    const harness = await createHarness();

    harness.socket.emit('message', {
      data: JSON.stringify({
        kind: 'command',
        name: 'reloadGameTabs',
        tableIds: ['bc281koreanch281', 'tobcbaccaragen92'],
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

    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest('blocked-after-reload')) });
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

  it('reloads the Pragmatic Jeju popup without treating unrelated popup games as baccarat', async () => {
    const harness = await createHarness({
      tabs: [
        { id: 42, url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat' },
        { id: 43, url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/another-game' },
      ],
    });

    harness.socket.emit('message', {
      data: JSON.stringify({
        kind: 'command',
        name: 'reloadGameTabs',
        tableIds: ['bc281koreanch281'],
      }),
    });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.chrome.tabs.reload).toHaveBeenCalledOnce();
    expect(harness.chrome.tabs.reload).toHaveBeenCalledWith(42, { bypassCache: true });
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'sessionAction',
      detail: 'reloadGameTabs:reloaded=1:tables=1',
    }));
  });

  it('reports Pragmatic readiness without executing a wager', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
    });

    harness.socket.emit('message', {
      data: JSON.stringify({
        kind: 'command',
        name: 'probeBetReadiness',
        tableIds: [pragmaticLiveRequest().request.intent.tableId],
      }),
    });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isPragmaticProbeInjection(injection.func),
    )).toBe(true);
    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes('scrollIntoView'),
    )).toBe(true);
    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes('icon-Video'),
    )).toBe(true);
    const preparation = harness.executeScript.mock.calls.find(
      ([injection]) => String(injection.func).includes('icon-Video'),
    );
    expect(preparation?.[0].args?.[2]).toBeNull();
    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isPragmaticFinalInjection(injection.func),
    )).toBe(false);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'sessionAction',
      action: 'command-executed',
      detail: expect.stringContaining(
        'probeBetReadiness:bc281koreanch281:candidates=1:status=ready:readyCandidates=1:authority=unique-ready:roundId=1726012345',
      ),
    }));
  });

  it('maintains a fresh per-table Pragmatic protocol betting window', async () => {
    const harness = await createHarness();
    const capture = (data: unknown) => vm.runInContext(
      `ingestPragmaticProtocolWindow(${JSON.stringify({
        kind: 'networkCapture',
        source: 'baccarat-bridge-pragmatic-ws',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify(data),
      })})`,
      harness.context,
    );

    capture({ game: { table: 'tobcbaccaragen92', game: '17260578524', seq: 1 } });
    capture({ betsopen: { table: 'tobcbaccaragen92', game: '17260578524', seq: 2 } });
    capture({ timer: { table: 'tobcbaccaragen92', game: '17260578524', value: 9, seq: 3 } });

    expect(vm.runInContext(
      `pragmaticProtocolWindow('tobcbaccaragen92')`,
      harness.context,
    )).toEqual(expect.objectContaining({
      roundId: '17260578524',
    }));
    capture({ betsclosed: { table: 'tobcbaccaragen92', game: '17260578524', seq: 4 } });
    expect(vm.runInContext(
      `pragmaticProtocolWindow('tobcbaccaragen92')`,
      harness.context,
    )).toBeNull();
  });

  it('keeps a Pragmatic protocol betting window when a dedicated-socket seq is lower than the shared stream', async () => {
    const harness = await createHarness();
    const capture = (data: unknown) => vm.runInContext(
      `ingestPragmaticProtocolWindow(${JSON.stringify({
        kind: 'networkCapture',
        source: 'baccarat-bridge-pragmatic-ws',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify(data),
      })})`,
      harness.context,
    );

    capture({ game: { table: 'bc281koreanch281', game: '16392002810', seq: 12500 } });
    capture({ betsopen: { table: 'bc281koreanch281', game: '16392002810', seq: 105 } });
    capture({ timer: { table: 'bc281koreanch281', game: '16392002810', value: 9, seq: 106 } });

    expect(vm.runInContext(
      `pragmaticProtocolWindow('bc281koreanch281')`,
      harness.context,
    )).toEqual(expect.objectContaining({
      roundId: '16392002810',
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
        if (injection.files?.includes('pragmatic-bet-runtime.js')) return [];
        if (isPragmaticProbeInjection(injection.func)) {
          return pendingProbe;
        }
        if (isPragmaticFinalInjection(injection.func)) {
          return [{ frameId: 7, result: harness.receipt }];
        }
        return [];
      });

      harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
      await flushBetHarnessAsyncWork();
      await flushBetHarnessAsyncWork();

      expect(harness.executeScript.mock.calls.some(
        ([injection]) => isPragmaticProbeInjection(injection.func),
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
          runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
          frameUrl: 'https://client.pragmaticplaylive.net/pc/pcv1/index.jsp',
          host: 'client.pragmaticplaylive.net',
          tableId: 'bc281koreanch281',
        },
      }]);
      await flushBetHarnessAsyncWork();
      await flushBetHarnessAsyncWork();

      expect(harness.executeScript.mock.calls.some(
        ([injection]) => isPragmaticFinalInjection(injection.func),
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
        if (injection.files?.includes('pragmatic-bet-runtime.js')) return [];
        if (isPragmaticProbeInjection(injection.func)) {
          return [{
            frameId: 7,
            result: {
              status: 'ready',
              runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
              frameUrl: 'https://client.pragmaticplaylive.net/pc/pcv1/index.jsp',
              host: 'client.pragmaticplaylive.net',
              tableId: 'bc281koreanch281',
            },
          }];
        }
        const finalExecute =
          injection.target?.frameIds?.length === 1
          && isPragmaticFinalInjection(injection.func);
        if (finalExecute) return pendingFinal;
        return [];
      });

      harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
      await flushBetHarnessAsyncWork();
      await flushBetHarnessAsyncWork();

      expect(harness.executeScript.mock.calls.some(
        ([injection]) => {
          const target = injection.target as ScriptInjection['target'];
          return target?.frameIds?.length === 1 && isPragmaticFinalInjection(injection.func);
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
        message => message.kind === 'betResult' && message.requestId === 'pragmatic-request-1',
      )).toHaveLength(0);
      expect(harness.executeScript.mock.calls.filter(
        ([injection]) => {
          const target = injection.target as ScriptInjection['target'];
          return target?.frameIds?.length === 1 && isPragmaticFinalInjection(injection.func);
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
      if (isPragmaticProbeInjection(injection.func)) {
        return [{
          frameId: 7,
          result: {
            status: 'ready',
            runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
            host: 'client.pragmaticplaylive.net',
            tableId: 'bc281koreanch281',
          },
        }];
      }
      if (injection.target?.frameIds?.length === 1 && isPragmaticFinalInjection(injection.func)) {
        return pendingFinal;
      }
      return [];
    });

    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();
    harness.socket.emit('message', { data: JSON.stringify({ kind: 'command', name: 'liveOff' }) });
    await flushBetHarnessAsyncWork();
    if (!releaseFinal) throw new Error('final execute release callback was not initialized');
    releaseFinal([{ frameId: 7, result: harness.pragmaticReceipt }]);
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'pragmatic-request-1',
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
    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isPragmaticFinalInjection(injection.func),
    )).toBe(false);
  });

  it('fails closed immediately when the bridge WebSocket reports an error', async () => {
    const harness = await createHarness();

    harness.socket.emit('error');
    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isPragmaticFinalInjection(injection.func),
    )).toBe(false);
  });

  it('reconnects from the persistent alarm after the service-worker timer is lost', async () => {
    const harness = await createHarness();

    harness.socket.close();
    const alarmListener = harness.chrome.alarms.onAlarm.addListener.mock.calls
      .map(([listener]) => listener as (alarm: { readonly name: string }) => void)
      .find(listener => String(listener).includes('BRIDGE_RECONNECT_ALARM'));
    expect(alarmListener).toBeDefined();

    alarmListener?.({ name: 'baccarat-bridge-reconnect' });
    await flushBetHarnessAsyncWork();

    expect(BetHarnessWebSocket.instances).toHaveLength(2);
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
    reconnectedSocket.emit('message', { data: JSON.stringify(pragmaticLiveRequest('after-reconnect')) });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => isPragmaticFinalInjection(injection.func),
    )).toBe(false);
    expect(reconnectedSocket.sent.map(message => JSON.parse(message))).not.toContainEqual(
      expect.objectContaining({ kind: 'command', name: 'liveOn' }),
    );
  });
});
