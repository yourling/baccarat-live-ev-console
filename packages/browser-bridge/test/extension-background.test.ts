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
  it('loads with a runtime connect listener for the keepalive port', async () => {
    const harness = await createHarness();
    expect(harness.chrome.runtime.onConnect.addListener).toHaveBeenCalled();
  });

  it('queues a bridge heartbeat after the socket opens', async () => {
    const harness = await createHarness();
    harness.socket.emit('open');
    expect(harness.runNextTimer()).toBe(true);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'heartbeat',
    }));
  });
  it('includes socket generation and outbox depth in heartbeats', async () => {
    const harness = await createHarness();
    harness.socket.emit('open');
    expect(harness.runNextTimer()).toBe(true);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'heartbeat',
      socketGeneration: expect.any(Number),
      pendingOutbox: expect.any(Number),
    }));
  });

  it('sends a heartbeat on reconnect alarm ticks and keepalive port connects', async () => {
    const harness = await createHarness();
    harness.socket.emit('open');
    const alarmListener = harness.chrome.alarms.onAlarm.addListener.mock.calls
      .map(([listener]) => listener as (alarm: { readonly name: string }) => void)
      .find(listener => String(listener).includes('BRIDGE_RECONNECT_ALARM'));
    expect(alarmListener).toBeDefined();
    const before = sentMessages(harness.socket).length;
    alarmListener?.({ name: 'baccarat-bridge-reconnect' });
    await flushBetHarnessAsyncWork();
    expect(sentMessages(harness.socket).length).toBeGreaterThan(before);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'heartbeat',
    }));
  });


  it('does not create keeper tabs even when keepalive arrives from a top frame', async () => {
    const harness = await createHarness({
      tabs: [{ id: 42, url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat' }],
    });
    const listener = harness.chrome.runtime.onMessage.addListener.mock.calls
      .map(([fn]) => fn as (
        message: Record<string, unknown>,
        sender: { tab?: { id?: number }; url?: string; frameId?: number },
      ) => void)
      .at(-1);
    expect(listener).toBeDefined();
    listener?.(
      {
        kind: 'keepalive',
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
        frame: 'top',
        timestamp: '2026-09-04T00:00:00.000Z',
      },
      {
        tab: { id: 42 },
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
        frameId: 0,
      },
    );
    await flushBetHarnessAsyncWork();
    expect(harness.chrome.tabs.create).not.toHaveBeenCalled();
    expect(harness.chrome.tabs.reload).not.toHaveBeenCalled();
  });

  it('ignores reloadGameTabs and does not reload the game popup', async () => {
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
        tableIds: ['bc281koreanch281', 'tobcbaccaragen92'],
      }),
    });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.chrome.tabs.reload).not.toHaveBeenCalled();
    expect(sentMessages(harness.socket).some(
      message => String(message.detail || '').startsWith('reloadGameTabs:'),
    )).toBe(false);
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
      ([injection]) => String(injection.func).includes('icon-Video'),
    )).toBe(false);
    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes('not-found-after-scroll'),
    )).toBe(false);
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

  it('ignores openMultiView and does not change game frames', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
      pragmaticFrameRoutes: [
        {
          frameId: 11,
          result: {
            pathname: '/desktop/multibaccarat/',
            frameUrl: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/',
          },
        },
        {
          frameId: 12,
          result: {
            pathname: '/desktop/baccarat/',
            frameUrl: 'https://client.pragmaticplaylive.net/desktop/baccarat/?table_id=bc281koreanch281',
          },
        },
      ],
    });

    harness.socket.emit('message', {
      data: JSON.stringify({
        kind: 'command',
        name: 'openMultiView',
        tableIds: ['bc281koreanch281', 'tobcbaccaragen92'],
      }),
    });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes('pragmatic-frame-routes')
        || String(injection.func).includes("location.pathname = '/desktop/multibaccarat/'")
        || String(injection.func).includes('control.click')
        || String(injection.func).includes('多台'),
    )).toBe(false);
    expect(sentMessages(harness.socket).some(
      message => String(message.detail || '').startsWith('openMultiView:'),
    )).toBe(false);
  });

  it('does not blank multiplay when a dedicated table frame is also present', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
    });
    const listeners = harness.chrome.runtime.onMessage.addListener.mock.calls.map(([listener]) => listener);
    const popup = {
      tab: { id: 42, url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat' },
    };
    const emit = (message: any, sender: any) => {
      for (const listener of listeners) listener(message, sender);
    };

    emit({
      kind: 'sessionAction',
      action: 'native-idle-keepalive-armed',
      url: 'https://client.pragmaticplaylive.net/desktop/baccarat/?table_id=bc281koreanch281',
      frame: 'iframe',
      timestamp: '2026-09-01T00:00:00.000Z',
    }, { ...popup, frameId: 12, url: 'https://client.pragmaticplaylive.net/desktop/baccarat/?table_id=bc281koreanch281' });
    emit({
      kind: 'sessionAction',
      action: 'native-idle-keepalive-armed',
      url: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/',
      frame: 'iframe',
      timestamp: '2026-09-01T00:00:01.000Z',
    }, { ...popup, frameId: 11, url: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/' });
    await flushBetHarnessAsyncWork();
    await flushBetHarnessAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes("location.replace('about:blank')"),
    )).toBe(false);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'sessionAction',
      action: 'dual-game-session',
      detail: expect.stringContaining('autonomous'),
    }));
  });

  it('does not forward HTTP, Worker, or CDP captures to the bridge', async () => {
    const harness = await createHarness();
    for (const source of [
      'baccarat-bridge-pragmatic-http',
      'baccarat-bridge-pragmatic-worker',
      'baccarat-bridge-pragmatic-window',
      'baccarat-bridge-pragmatic-cdp-body',
    ]) {
      vm.runInContext(
        `send(${JSON.stringify({
          kind: 'networkCapture',
          source,
          url: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/',
          direction: 'recv',
          encoding: 'text',
          data: '{"ok":true}',
        })})`,
        harness.context,
      );
    }
    vm.runInContext(
      `send(${JSON.stringify({
        kind: 'networkCapture',
        source: 'baccarat-bridge-pragmatic-ws',
        url: 'wss://gs24.pragmaticplaylive.net/game',
        direction: 'recv',
        encoding: 'text',
        data: '{"timer":{"table":"tobcbaccaragen92","value":"9"}}',
      })})`,
      harness.context,
    );
    const captures = sentMessages(harness.socket).filter(message => message.kind === 'networkCapture');
    expect(captures).toEqual([
      expect.objectContaining({
        source: 'baccarat-bridge-pragmatic-ws',
        url: 'wss://gs24.pragmaticplaylive.net/game',
      }),
    ]);
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
