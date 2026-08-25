import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, vi } from 'vitest';

export const backgroundSource = readFileSync(
  new URL('../../../apps/browser-extension/background.js', import.meta.url),
  'utf8',
);

export const mstromRuntimeSource = readFileSync(
  new URL('../../../apps/browser-extension/mstrom-bet-runtime.js', import.meta.url),
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

export function liveRequest(requestId = 'request-1') {
  return {
    kind: 'betRequest',
    requestId,
    request: {
      mode: 'live',
      reservationId: 'reservation-1',
      intent: {
        intentId: 'intent-1',
        tableId: 'D067',
        shoeId: 'shoe-1',
        handId: 'GD06726824AB',
        market: 'bankerPair',
        amount: 10,
        mode: 'live',
        idempotencyKey: 'D067:GD06726824AB:bankerPair',
        strategy: { type: 'fixed', market: 'bankerPair' },
        decisionSnapshotId: 'decision-1',
        createdAt: '2026-08-24T12:00:00.000Z',
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
};

export async function createHarness(options: HarnessOptions = {}) {
  FakeWebSocket.instances.length = 0;
  const scheduledTimers: Array<() => void> = [];
  const tabs = options.tabs ?? [{
    id: 42,
    url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-pa',
  }];
  const receipt = {
    receiptId: 'mstrom-receipt-1',
    intentId: 'intent-1',
    reservationId: 'reservation-1',
    status: 'ACCEPTED',
    amount: 10,
    market: 'bankerPair',
    mode: 'live',
    externalRef: 'playType:4',
    createdAt: '2026-08-24T12:00:01.000Z',
  };
  const executeScript = vi.fn().mockImplementation(async (
    injection: {
      readonly files?: readonly string[];
      readonly func?: unknown;
      readonly target?: { readonly frameIds?: readonly number[] };
    },
  ) => {
    if (
      String(injection.func).includes('__baccaratMstromBetProbe')
      || String(injection.func).includes('probeMstromBetStore')
    ) {
      return options.probeResults ?? [{
        frameId: 7,
        result: {
          status: 'ready',
          frameUrl: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp',
          host: 'gci.agad.mstrom-uno.com',
          tableId: 'D067',
          gmcode: 'GD06726824AB',
          betEnabled: true,
        },
      }];
    }
    if (
      injection.target?.frameIds?.length === 1
      && (
        String(injection.func).includes('__baccaratMstromBetExecute')
        || String(injection.func).includes('executeMstromBetOneShot')
      )
    ) {
      return [{ frameId: 7, result: receipt }];
    }
    return [];
  });
  const eventTarget = { addListener: vi.fn() };
  const sendMessage = vi.fn().mockResolvedValue(undefined);
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
      if (script !== 'mstrom-bet-runtime.js') {
        throw new Error(`unexpected script import: ${script}`);
      }
      vm.runInContext(mstromRuntimeSource, context, { filename: script });
    },
  });

  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
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
    executeScript,
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
