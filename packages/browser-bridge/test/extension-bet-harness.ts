import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, vi } from 'vitest';

export const backgroundSource = readFileSync(
  new URL('../../../apps/browser-extension/background.js', import.meta.url),
  'utf8',
);

export const pragmaticRuntimeSource = readFileSync(
  new URL('../../../apps/browser-extension/pragmatic-bet-runtime.js', import.meta.url),
  'utf8',
);

export const extensionManifest: unknown = JSON.parse(readFileSync(
  new URL('../../../apps/browser-extension/manifest.json', import.meta.url),
  'utf8',
));

type SocketEvent = { readonly data?: string };
type SocketListener = (event: SocketEvent) => void;

export class FakeWebSocket {
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
  }
}

export function flushAsyncWork(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export function pragmaticLiveRequest(requestId = 'pragmatic-request-1') {
  return {
    kind: 'betRequest',
    requestId,
    request: {
      mode: 'live',
      reservationId: 'pragmatic-reservation-1',
      intent: {
        intentId: 'pragmatic-intent-1',
        tableId: 'bc281koreanch281',
        shoeId: 'pragmatic-bc281koreanch281-1',
        handId: '1726012345',
        market: 'bankerPair',
        amount: 10,
        mode: 'live',
        idempotencyKey: 'bc281koreanch281:1726012345:bankerPair',
        strategy: { type: 'fixed', market: 'bankerPair' },
        decisionSnapshotId: 'pragmatic-decision-1',
        createdAt: '2026-08-29T00:00:00.000Z',
      },
    },
  };
}

export function pragmaticOperationalRequest(requestId = 'pragmatic-operational-request-1') {
  return {
    kind: 'betRequest',
    requestId,
    request: {
      mode: 'live',
      wager: {
        wagerId: 'pragmatic-wager-1',
        tableId: 'bc281koreanch281',
        shoeId: 'pragmatic-bc281koreanch281-1',
        handId: '1726012345',
        market: 'banker',
        amount: 10,
        source: 'manual',
        createdAt: '2026-08-29T00:00:00.000Z',
      },
    },
  };
}

export type HarnessOptions = {
  readonly tabs?: readonly { readonly id: number; readonly url: string }[];
  readonly probeResults?: readonly {
    readonly frameId: number;
    readonly result: Readonly<Record<string, unknown>>;
  }[];
  readonly liveBetEnabled?: boolean;
  readonly armCurrentSession?: boolean;
  readonly pragmaticProtocolRoundId?: string | null;
  readonly pragmaticPhaseResult?: (
    command: Readonly<Record<string, unknown>>,
    request: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly pragmaticPrepareResult?: Readonly<Record<string, unknown>>;
};

export async function createHarness(options: HarnessOptions = {}) {
  FakeWebSocket.instances.length = 0;
  const scheduledTimers: Array<() => void> = [];
  const tabs = options.tabs ?? [{
    id: 42,
    url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
  }];
  const receipt = {
    receiptId: 'pragmatic-receipt-legacy',
    intentId: 'intent-1',
    reservationId: 'reservation-1',
    status: 'ACCEPTED',
    amount: 10,
    market: 'bankerPair',
    mode: 'live',
    externalRef: 'playType:4',
    createdAt: '2026-08-24T12:00:01.000Z',
  };
  const pragmaticReceipt = {
    receiptId: 'pragmatic-receipt-1',
    intentId: 'pragmatic-intent-1',
    reservationId: 'pragmatic-reservation-1',
    status: 'ACCEPTED',
    amount: 10,
    market: 'bankerPair',
    mode: 'live',
    externalRef: 'pragmatic:bc281koreanch281:1726012345',
    createdAt: '2026-08-29T00:00:01.000Z',
    raw: {
      runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
      commitPoint: 'market-click',
      commitStarted: true,
    },
  };
  const executeScript = vi.fn().mockImplementation(async (
    injection: {
      readonly files?: readonly string[];
      readonly func?: unknown;
      readonly args?: readonly unknown[];
      readonly target?: { readonly frameIds?: readonly number[]; readonly allFrames?: boolean };
    },
  ) => {
    if (String(injection.func).includes('probePragmaticBetTable')) {
      return options.probeResults ?? [{
        frameId: 11,
        result: {
          status: 'ready',
          runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
          host: 'client.pragmaticplaylive.net',
          tableId: 'bc281koreanch281',
          roundId: '1726012345',
          markets: ['player', 'banker', 'playerPair', 'bankerPair'],
          supportedChips: [10, 50, 250],
        },
      }];
    }
    if (
      String(injection.func).includes('TileHeight-')
      && String(injection.func).includes('shared-market-controls-ambiguous')
    ) {
      return [{
        frameId: 11,
        result: options.pragmaticPrepareResult ?? {
          status: 'activated',
          frameUrl: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/',
          roundId: '1726012345',
          countdown: 8,
        },
      }];
    }
    if (String(injection.func).includes('executePragmaticBetOneShot') && injection.target?.allFrames === true) {
      return [{
        frameId: 11,
        result: {
          phase: 'request-unavailable',
          runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
          reason: 'bet-request-channel-unavailable',
          currentRoundId: '1726012345',
        },
      }];
    }
    if (
      injection.target?.frameIds?.length === 1
      && String(injection.func).includes('executePragmaticBetOneShot')
    ) {
      const command = injection.args?.[1] as Readonly<Record<string, unknown>> | undefined;
      const request = injection.args?.[0] as Readonly<Record<string, unknown>> | undefined;
      if (command && request && options.pragmaticPhaseResult) {
        const overridden = options.pragmaticPhaseResult(command, request);
        if (overridden !== undefined) return [{ frameId: 11, result: overridden }];
      }
      if (command?.['phase'] === 'request') {
        return [{
          frameId: 11,
          result: {
            phase: 'request-unavailable',
            runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
            reason: 'bet-request-channel-unavailable',
            currentRoundId: '1726012345',
            currentCountdown: 9,
          },
        }];
      }
      if (command?.['phase'] === 'prepare') {
        return [{
          frameId: 11,
          result: {
            phase: 'prepared',
            runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
            tableId: 'bc281koreanch281',
            handId: '1726012345',
            market: 'bankerPair',
            amount: 10,
            currentRoundId: '1726012345',
            currentCountdown: 9,
            beforeTotal: 0,
            beforeTotalObserved: true,
            denominations: [10],
          },
        }];
      }
      if (command?.['phase'] === 'target') {
        return [{
          frameId: 11,
          result: {
            phase: 'target',
            runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
            action: command['action'],
            denomination: command['denomination'],
            currentRoundId: '1726012345',
            currentCountdown: 8,
            point: {
              x: command['action'] === 'chip' ? 100 : 300,
              y: 400,
              width: 80,
              height: 40,
              viewportWidth: 1280,
              viewportHeight: 720,
            },
          },
        }];
      }
      if (command?.['phase'] === 'observe') {
        const wager = request?.['wager'] as Readonly<Record<string, unknown>> | undefined;
        if (wager) {
          return [{
            frameId: 11,
            result: {
              receiptId: 'pragmatic-operational-receipt-1',
              wagerId: wager['wagerId'],
              tableId: wager['tableId'],
              shoeId: wager['shoeId'],
              handId: wager['handId'],
              market: wager['market'],
              amount: wager['amount'],
              source: wager['source'],
              status: 'ACCEPTED',
              externalRef: `pragmatic:${String(wager['tableId'])}:${String(wager['handId'])}`,
              createdAt: '2026-08-29T00:00:01.000Z',
              raw: {
                runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
                commitPoint: 'market-click',
                commitStarted: true,
                trustedInput: true,
              },
            },
          }];
        }
        return [{ frameId: 11, result: pragmaticReceipt }];
      }
      return [];
    }
    return [];
  });
  const eventTarget = { addListener: vi.fn() };
  const sendMessage = vi.fn().mockImplementation(async (
    _tabId: number,
    message: Readonly<Record<string, unknown>>,
  ) => message['kind'] === 'resolveBetFrameRect' ? message['rect'] : undefined);
  const setTimeoutMock = vi.fn((callback: () => void) => {
    scheduledTimers.push(callback);
    return scheduledTimers.length;
  });
  const chrome = {
    storage: {
      local: {
        get: vi.fn().mockImplementation(async (defaults: Readonly<Record<string, unknown>>) => ({
          ...defaults,
          liveBetEnabled: options.liveBetEnabled ?? true,
        })),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: eventTarget,
    },
    alarms: {
      create: vi.fn(),
      onAlarm: eventTarget,
    },
    runtime: {
      getManifest: () => ({ version: 'test' }),
      lastError: undefined,
      onInstalled: eventTarget,
      onStartup: eventTarget,
      onMessage: eventTarget,
    },
    tabs: {
      query: vi.fn().mockResolvedValue(tabs),
      sendMessage,
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
  let context: vm.Context;
  context = vm.createContext({
    chrome,
    WebSocket: FakeWebSocket,
    navigator: { userAgent: 'test-browser' },
    setTimeout: setTimeoutMock,
    clearTimeout: vi.fn(),
    Date,
    JSON,
    Math,
    Number,
    String,
    Promise,
    URL,
    Map,
    importScripts: (script: string) => {
      if (script !== 'pragmatic-bet-runtime.js') throw new Error(`unexpected script import: ${script}`);
      vm.runInContext(pragmaticRuntimeSource, context, { filename: script });
    },
  });

  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  const pragmaticProtocolRoundId = options.pragmaticProtocolRoundId === undefined
    ? '1726012345'
    : options.pragmaticProtocolRoundId;
  if (pragmaticProtocolRoundId !== null) {
    for (const data of [
      { game: { table: 'bc281koreanch281', game: pragmaticProtocolRoundId, seq: 1 } },
      { betsopen: { table: 'bc281koreanch281', game: pragmaticProtocolRoundId, seq: 2 } },
      { timer: { table: 'bc281koreanch281', game: pragmaticProtocolRoundId, value: 9, seq: 3 } },
    ]) {
      vm.runInContext(
        `ingestPragmaticProtocolWindow(${JSON.stringify({
          kind: 'networkCapture',
          source: 'baccarat-bridge-pragmatic-ws',
          direction: 'recv',
          encoding: 'text',
          data: JSON.stringify(data),
        })})`,
        context,
      );
    }
  }
  await flushAsyncWork();
  const socket = FakeWebSocket.instances[0];
  expect(socket).toBeDefined();
  if (!socket) throw new Error('background WebSocket was not created');
  if (options.armCurrentSession ?? true) {
    socket.emit('message', { data: JSON.stringify({ kind: 'command', name: 'liveOn' }) });
    await flushAsyncWork();
  }
  return {
    chrome,
    context,
    executeScript,
    pragmaticReceipt,
    receipt,
    sendMessage,
    socket,
    runNextTimer: (): boolean => {
      const callback = scheduledTimers.shift();
      if (!callback) return false;
      callback();
      return true;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sentMessages(socket: FakeWebSocket): readonly Record<string, unknown>[] {
  const parsedMessages: Record<string, unknown>[] = [];
  for (const message of socket.sent) {
    const parsed: unknown = JSON.parse(message);
    if (isRecord(parsed)) parsedMessages.push(parsed);
  }
  return parsedMessages;
}

export function installedContentScripts(): readonly string[] {
  if (!isRecord(extensionManifest)) return [];
  const contentScripts = extensionManifest['content_scripts'];
  if (!Array.isArray(contentScripts)) return [];
  const installed: string[] = [];
  for (const entry of contentScripts) {
    if (!isRecord(entry) || !Array.isArray(entry['js'])) continue;
    for (const file of entry['js']) {
      if (typeof file === 'string') installed.push(file);
    }
  }
  return installed;
}
