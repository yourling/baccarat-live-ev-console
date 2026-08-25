import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const networkHookSource = readFileSync(
  new URL('../../../apps/browser-extension/network-hook.js', import.meta.url),
  'utf8',
);

type PostedMessage = {
  readonly source?: unknown;
  readonly data?: unknown;
};

type WorkerMessageListener = (event: { readonly data: unknown }) => void;

class FakeWorker {
  private readonly listeners = new Map<string, WorkerMessageListener[]>();

  constructor(_url: string) {}

  addEventListener(name: string, listener: WorkerMessageListener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data });
  }
}

describe('passive Worker message hook', () => {
  it('reports game-shaped Worker responses without sending a Worker message', () => {
    const messages: PostedMessage[] = [];
    const testWindow = {
      postMessage: (message: PostedMessage) => { messages.push(message); },
      Worker: FakeWorker,
    };
    const context = vm.createContext({
      location: { href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' },
      window: testWindow,
      setInterval: vi.fn(),
      JSON,
      ArrayBuffer,
      Uint8Array,
      WeakSet,
      Object,
      String,
      Number,
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    });
    vm.runInContext(networkHookSource, context, { filename: 'network-hook.js' });

    const worker = new testWindow.Worker('resource/workers/ag-worker.js');
    worker.emitMessage({
      type: 'gameResult',
      tableId: 'D065',
      roundId: 'GD065268230WF',
      playerCards: [0x11, 0x22],
      bankerCards: [0x13, 0x24],
    });

    const message = messages.find(candidate => candidate.source === 'baccarat-bridge-worker-message');
    expect(message).toBeDefined();
    expect(typeof message?.data).toBe('string');
    if (typeof message?.data !== 'string') return;

    const parsed: unknown = JSON.parse(message.data);
    expect(parsed).toEqual(expect.objectContaining({
      kind: 'worker',
      direction: 'recv',
      url: 'resource/workers/ag-worker.js',
      payload: expect.objectContaining({
        kind: 'json',
        json: expect.stringContaining('GD065268230WF'),
      }),
    }));
  });
});
