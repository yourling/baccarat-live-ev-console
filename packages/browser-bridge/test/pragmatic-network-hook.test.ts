import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const hookSource = readFileSync(
  new URL('../../../apps/browser-extension/pragmatic-network-hook.js', import.meta.url),
  'utf8',
);

type Listener = (event: { data: unknown; source?: unknown; origin?: string }) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(name: string, listener: Listener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  emit(name: string, event: { data: unknown; source?: unknown; origin?: string }): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

class FakeWebSocket extends FakeEventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly send = vi.fn();
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

class FakeWorker extends FakeEventTarget {
  readonly postMessage = vi.fn();

  constructor(readonly url: string) {
    super();
  }
}

class FakeMessagePort extends FakeEventTarget {
  readonly start = vi.fn();
  readonly postMessage = vi.fn();
}

class FakeMessageChannel {
  readonly port1 = new FakeMessagePort();
  readonly port2 = new FakeMessagePort();
}

function runHook(posted: unknown[], page: {
  readonly pathname?: string;
  readonly referrer?: string;
} = {}): {
  readonly testWindow: FakeEventTarget & {
    WebSocket: typeof FakeWebSocket;
    Worker: typeof FakeWorker;
    MessageChannel: typeof FakeMessageChannel;
    postMessage(message: unknown): void;
  };
  readonly windowEvents: FakeEventTarget;
} {
  const windowEvents = new FakeEventTarget();
  const testWindow = Object.assign(windowEvents, {
    WebSocket: FakeWebSocket,
    Worker: FakeWorker,
    MessageChannel: FakeMessageChannel,
    postMessage(message: unknown) { posted.push(message); },
  });
  const context = vm.createContext({
    window: testWindow,
    globalThis: testWindow,
    location: {
      hostname: 'client.pragmaticplaylive.net',
      origin: 'https://client.pragmaticplaylive.net',
      pathname: page.pathname ?? '/desktop/multibaccarat/',
    },
    document: { referrer: page.referrer ?? '' },
    URL,
    WebSocket: FakeWebSocket,
    Worker: FakeWorker,
    MessageChannel: FakeMessageChannel,
    navigator: {},
    ArrayBuffer,
    Uint8Array,
    Object,
    String,
    Number,
    Blob,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
  });
  vm.runInContext(hookSource, context, { filename: 'pragmatic-network-hook.js' });
  return { testWindow, windowEvents };
}

function signalContentReady(testWindow: unknown, windowEvents: FakeEventTarget): void {
  windowEvents.emit('message', {
    source: testWindow,
    origin: 'https://client.pragmaticplaylive.net',
    data: { source: 'baccarat-bridge-pragmatic-network-ready' },
  });
}

describe('Pragmatic passive network hook', () => {
  it('buffers early receive frames and never sends to game transports', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    const socket = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    socket.emit('message', { data: JSON.stringify({ type: 'tableState', tableId: 'speedbca14gesbc1' }) });

    expect(posted).toEqual([]);
    signalContentReady(testWindow, windowEvents);
    expect(posted).toContainEqual(expect.objectContaining({
      source: 'baccarat-bridge-pragmatic-ws',
      url: 'wss://gs24.pragmaticplaylive.net/game',
      direction: 'recv',
      encoding: 'text',
      data: expect.stringContaining('speedbca14gesbc1'),
    }));
    expect(posted.every(message => (message as { direction?: string }).direction !== 'send')).toBe(true);
  });

  it('captures outbound WebSocket sends and can replay a mutated bet template', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    signalContentReady(testWindow, windowEvents);
    const socket = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    socket.readyState = FakeWebSocket.OPEN;
    socket.send(JSON.stringify({
      bet: { table: 'speedbca14gesbc1', game: '111', amount: 10, bc: '0' },
    }));

    expect(posted).toContainEqual(expect.objectContaining({
      source: 'baccarat-bridge-pragmatic-ws',
      direction: 'send',
      data: expect.stringContaining('"bc":"0"'),
    }));

    const channel = (testWindow as { __baccaratPragmaticBetChannel?: {
      placeBet(command: Record<string, unknown>): { ok: boolean };
    } }).__baccaratPragmaticBetChannel;
    expect(channel?.placeBet({
      tableId: 'speedbca14gesbc1',
      roundId: '222',
      amount: 10,
      code: '1',
    })).toEqual({ ok: true });
    const sends = posted.filter(message => (message as { direction?: string }).direction === 'send');
    expect(sends).toHaveLength(2);
    expect(String((sends[1] as { data?: string }).data)).toContain('"bc":"1"');
    expect(String((sends[1] as { data?: string }).data)).toContain('"game":"222"');
  });

  it('learns a bet template from a payload that mentions amount and table', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    signalContentReady(testWindow, windowEvents);
    const socket = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    socket.readyState = FakeWebSocket.OPEN;
    socket.send(JSON.stringify({
      playerWager: { table: 'speedbca14gesbc1', game: '333', amount: 10, code: '0' },
    }));
    const channel = testWindow as {
      __baccaratPragmaticBetChannel?: { hasTemplate(): boolean; templatePreview(): string };
    };
    expect(channel.__baccaratPragmaticBetChannel?.hasTemplate()).toBe(true);
    expect(channel.__baccaratPragmaticBetChannel?.templatePreview()).toContain('playerWager');
  });

  it('replays a captured Pragmatic lpbet XML command', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    signalContentReady(testWindow, windowEvents);
    const socket = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    socket.readyState = FakeWebSocket.OPEN;
    socket.send(
      '<command channel="table-h22z8qhp17sa0vkh"><lpbet gm="mtb_desktop" gId="16387255610" uId="ppc1735377833837" ck="1" ><bet amt="10" bc="0" ck="1"/></lpbet></command>',
    );
    const channel = (testWindow as {
      __baccaratPragmaticBetChannel?: { placeBet(command: Record<string, unknown>): { ok: boolean } };
    }).__baccaratPragmaticBetChannel;
    expect(channel?.placeBet({
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387259910',
      amount: 10,
      code: '1',
    })).toEqual({ ok: true });
    const sends = posted
      .filter(message => (message as { direction?: string }).direction === 'send')
      .map(message => String((message as { data?: string }).data));
    expect(sends.some(data => data.includes('<autoBet></autoBet>'))).toBe(false);
    expect(sends.some(data =>
      data.includes('<lpbet')
      && data.includes('channel="table-h22z8qhp17sa0vkh"')
      && data.includes('gId="16387259910"')
      && data.includes('uId="ppc1735377833837"')
      && data.includes('bc="1"')
      && data.includes('amt="10"')
    )).toBe(true);
    socket.emit('message', {
      data: '<command channel="table-speedbca14gesbc1"><timer table="speedbca14gesbc1" value="8"/></command>',
    });
    expect(channel?.placeBet({
      tableId: 'speedbca14gesbc1',
      roundId: '16387259910',
      amount: 10,
      code: '1',
    })).toEqual({ ok: true });
    const laterSends = posted
      .filter(message => (message as { direction?: string }).direction === 'send')
      .map(message => String((message as { data?: string }).data));
    expect(laterSends.some(data => data.includes('channel="table-speedbca14gesbc1"') && data.includes('<lpbet'))).toBe(true);
    expect(laterSends.some(data => data.includes('<autoBet></autoBet>'))).toBe(false);
  });

  it('does not close a previous multibaccarat game socket after the new socket receives', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    signalContentReady(testWindow, windowEvents);
    const first = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    first.readyState = FakeWebSocket.OPEN;
    const second = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    second.readyState = FakeWebSocket.OPEN;
    second.emit('message', {
      data: '<command channel="table-h22z8qhp17sa0vkh"><timer table="h22z8qhp17sa0vkh" value="8"/></command>',
    });
    expect(first.readyState).toBe(FakeWebSocket.OPEN);
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('retires the previous dedicated-table game socket after the new socket receives', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted, { pathname: '/desktop/baccarat/' });
    signalContentReady(testWindow, windowEvents);
    const first = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    first.readyState = FakeWebSocket.OPEN;
    const second = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    second.readyState = FakeWebSocket.OPEN;
    second.emit('message', {
      data: '<command channel="table-h22z8qhp17sa0vkh"><timer table="h22z8qhp17sa0vkh" value="8"/></command>',
    });
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('does not close sibling game sockets on multibaccarat path without trailing slash', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted, { pathname: '/desktop/multibaccarat' });
    signalContentReady(testWindow, windowEvents);
    const first = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    first.readyState = FakeWebSocket.OPEN;
    const second = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    second.readyState = FakeWebSocket.OPEN;
    second.emit('message', {
      data: '<command channel="table-h22z8qhp17sa0vkh"><timer table="h22z8qhp17sa0vkh" value="8"/></command>',
    });
    expect(first.readyState).toBe(FakeWebSocket.OPEN);
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('keeps sibling game sockets on dedicated path when mtb_ gm was observed', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted, { pathname: '/desktop/baccarat/' });
    signalContentReady(testWindow, windowEvents);
    const first = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    first.readyState = FakeWebSocket.OPEN;
    first.send(
      '<command channel="table-h22z8qhp17sa0vkh"><lpbet gm="mtb_desktop" gId="16387255610" uId="ppc1735377833837" ck="1" ><bet amt="10" bc="0" ck="1"/></lpbet></command>',
    );
    const second = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    second.readyState = FakeWebSocket.OPEN;
    second.emit('message', {
      data: '<command channel="table-h22z8qhp17sa0vkh"><timer table="h22z8qhp17sa0vkh" value="8"/></command>',
    });
    expect(first.readyState).toBe(FakeWebSocket.OPEN);
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('keeps sibling game sockets on dedicated path when multiple table ids were seen', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted, { pathname: '/desktop/baccarat/' });
    signalContentReady(testWindow, windowEvents);
    const first = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    first.readyState = FakeWebSocket.OPEN;
    first.emit('message', {
      data: '<command channel="table-h22z8qhp17sa0vkh"><timer table="h22z8qhp17sa0vkh" value="8"/></command>',
    });
    first.emit('message', {
      data: '<command channel="table-speedbca14gesbc1"><timer table="speedbca14gesbc1" value="7"/></command>',
    });
    const second = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    second.readyState = FakeWebSocket.OPEN;
    second.emit('message', {
      data: '<command channel="table-h22z8qhp17sa0vkh"><timer table="h22z8qhp17sa0vkh" value="6"/></command>',
    });
    expect(first.readyState).toBe(FakeWebSocket.OPEN);
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('does not close the previous same-frame game socket during reconnect', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    signalContentReady(testWindow, windowEvents);
    const first = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    first.readyState = FakeWebSocket.OPEN;
    const second = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    second.readyState = FakeWebSocket.OPEN;

    expect(first.readyState).toBe(FakeWebSocket.OPEN);
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('keeps capturing from the previous socket after a same-frame reconnect and bets on the latest open socket', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    signalContentReady(testWindow, windowEvents);
    const first = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    first.readyState = FakeWebSocket.OPEN;
    first.send(
      '<command channel="table-h22z8qhp17sa0vkh"><lpbet gm="mtb_desktop" gId="16387255610" uId="ppc1735377833837" ck="1" ><bet amt="10" bc="0" ck="1"/></lpbet></command>',
    );
    const second = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    second.readyState = FakeWebSocket.OPEN;

    first.emit('message', {
      data: '<command channel="table-h22z8qhp17sa0vkh"><timer table="h22z8qhp17sa0vkh" value="8"/></command>',
    });
    expect(first.readyState).toBe(FakeWebSocket.OPEN);
    expect(posted.some(message =>
      String((message as { data?: string }).data || '').includes('table-h22z8qhp17sa0vkh')
      && (message as { direction?: string }).direction !== 'send',
    )).toBe(true);

    const channel = (testWindow as {
      __baccaratPragmaticBetChannel?: {
        placeBet(command: Record<string, unknown>): { ok: boolean };
      };
    }).__baccaratPragmaticBetChannel;
    expect(channel?.placeBet({
      tableId: 'h22z8qhp17sa0vkh',
      roundId: '16387259910',
      amount: 10,
      code: '1',
    })).toEqual({ ok: true });
    const lpbetSends = posted
      .filter(message => (message as { direction?: string }).direction === 'send')
      .map(message => String((message as { data?: string }).data || ''));
    expect(lpbetSends.some(data => data.includes('<lpbet') && data.includes('gId="16387259910"'))).toBe(true);
    expect(first.readyState).toBe(FakeWebSocket.OPEN);

    second.emit('message', {
      data: '<command channel="table-h22z8qhp17sa0vkh"><timer table="h22z8qhp17sa0vkh" value="7"/></command>',
    });
    expect(first.readyState).toBe(FakeWebSocket.OPEN);
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('closes the game socket and blocks new ones after releaseSession', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    signalContentReady(testWindow, windowEvents);
    const socket = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('message', {
      data: '<command channel="table-bcpirpmfpeobc198"><timer table="bcpirpmfpeobc198" value="8"/></command>',
    });
    const channel = (testWindow as {
      __baccaratPragmaticBetChannel?: {
        releaseSession(): { ok: boolean };
        placeBet(command: Record<string, unknown>): { ok: boolean; reason?: string };
        status(): { hasSocket: boolean };
      };
    }).__baccaratPragmaticBetChannel;

    expect(channel?.releaseSession()).toEqual({ ok: true });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(channel?.status()).toEqual(expect.objectContaining({ hasSocket: false }));
    expect(channel?.placeBet({
      tableId: 'bcpirpmfpeobc198',
      roundId: '16426491510',
      amount: 10,
      code: '0',
    })).toEqual({ ok: false, reason: 'session-released' });

    const next = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    expect(next.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('refuses dedicated-frame lpbet for a table other than the referrer-bound table', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted, {
      pathname: '/desktop/baccarat/',
      referrer: 'https://client.pragmaticplaylive.net/desktop/launcher/?table_id=bc392chromabc392',
    });
    signalContentReady(testWindow, windowEvents);
    const socket = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('message', {
      data: '<command channel="table-bc392chromabc392"><timer table="bc392chromabc392" value="8"/></command>',
    });
    socket.emit('message', {
      data: '<command channel="table-bcpirpmfpeobc198"><timer table="bcpirpmfpeobc198" value="7"/></command>',
    });
    const channel = (testWindow as {
      __baccaratPragmaticBetChannel?: {
        placeBet(command: Record<string, unknown>): { ok: boolean; reason?: string };
        status(): {
          framePath?: string;
          boundTableId?: string;
          tableIds?: readonly string[];
        };
      };
    }).__baccaratPragmaticBetChannel;

    expect(channel?.status()).toEqual(expect.objectContaining({
      framePath: '/desktop/baccarat/',
      boundTableId: 'bc392chromabc392',
    }));
    expect(channel?.placeBet({
      tableId: 'bcpirpmfpeobc198',
      roundId: '16413832010',
      amount: 10,
      code: '0',
    })).toEqual({ ok: false, reason: 'table-not-in-current-session' });
    expect(posted.some(message =>
      String((message as { data?: string }).data || '').includes('gId="16413832010"'),
    )).toBe(false);
  });

  it('refuses to send lpbet on a socket that has never seen the target table', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    signalContentReady(testWindow, windowEvents);
    const socket = new testWindow.WebSocket('wss://gs10.pragmaticplaylive.net/game');
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('message', {
      data: '<command channel="table-bc392chromabc392"><timer table="bc392chromabc392" value="8"/></command>',
    });
    const channel = (testWindow as {
      __baccaratPragmaticBetChannel?: {
        placeBet(command: Record<string, unknown>): { ok: boolean; reason?: string };
        status(): { hasSocket: boolean; tableIds?: readonly string[] };
      };
    }).__baccaratPragmaticBetChannel;

    expect(channel?.status()).toEqual(expect.objectContaining({
      hasSocket: true,
      tableIds: ['bc392chromabc392'],
    }));
    expect(channel?.placeBet({
      tableId: 'bcpirpmfpeobc198',
      roundId: '16413832010',
      amount: 10,
      code: '0',
    })).toEqual({ ok: false, reason: 'table-not-in-current-session' });
    expect(posted.some(message =>
      String((message as { data?: string }).data || '').includes('bcpirpmfpeobc198'),
    )).toBe(false);
  });

  it('does not capture binary WebSocket frames or video sockets', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    signalContentReady(testWindow, windowEvents);
    const game = new testWindow.WebSocket('wss://gs24.pragmaticplaylive.net/game');
    game.emit('message', { data: new Uint8Array([1, 2, 3, 4]).buffer });
    const video = new testWindow.WebSocket('wss://video.pragmaticplaylive.net/stream');
    video.emit('message', { data: JSON.stringify({ type: 'media' }) });
    expect(posted).toEqual([]);
  });

  it('does not capture Worker, MessageChannel, or window IPC', () => {
    const posted: unknown[] = [];
    const { testWindow, windowEvents } = runHook(posted);
    signalContentReady(testWindow, windowEvents);
    const worker = new testWindow.Worker('/worker.js');
    worker.emit('message', { data: JSON.stringify({ eventType: 'roundUpdate', roundId: '12345' }) });
    const channel = new testWindow.MessageChannel();
    channel.port1.emit('message', {
      data: { type: 'tableState', tableId: 'speedbca14gesbc1', roundId: '17260818724' },
    });
    windowEvents.emit('message', {
      source: testWindow,
      origin: 'https://client.pragmaticplaylive.net',
      data: { type: 'video-stats', bytes: 1_024_000 },
    });
    expect(posted).toEqual([]);
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(channel.port1.postMessage).not.toHaveBeenCalled();
    expect(channel.port2.postMessage).not.toHaveBeenCalled();
  });

  it('is injected at document start with a forwarding content script', () => {
    const manifest = JSON.parse(readFileSync(
      new URL('../../../apps/browser-extension/manifest.json', import.meta.url),
      'utf8',
    )) as { content_scripts?: Array<{ js?: string[]; run_at?: string; world?: string }> };
    expect(manifest.content_scripts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        matches: expect.arrayContaining([
          'https://client.pragmaticplaylive.net/*',
          'https://*.vbgames88.com/*',
          'https://*.zavjcswh.biz/*',
        ]),
        js: ['pragmatic-network-hook.js'],
        run_at: 'document_start',
        world: 'MAIN',
      }),
      expect.objectContaining({
        matches: expect.arrayContaining([
          'https://client.pragmaticplaylive.net/*',
          'https://*.vbgames88.com/*',
          'https://*.zavjcswh.biz/*',
        ]),
        js: ['content.js'],
        run_at: 'document_start',
      }),
    ]));
  });
});
