import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: any[]) => any;
};

const source = readFileSync(
  new URL('../../../apps/browser-extension/pragmatic-dom-hook.js', import.meta.url),
  'utf8',
);

describe('Pragmatic DOM hook', () => {
  it('does not pause or mute live table videos', () => {
    expect(source).not.toMatch(/video\.pause\s*\(/);
    expect(source).not.toMatch(/video\.muted\s*=/);
  });

  it('content script does not treat the reconnect banner as try-again', () => {
    const content = readFileSync(
      new URL('../../../apps/browser-extension/content.js', import.meta.url),
      'utf8',
    );
    expect(content).toMatch(/if \(\/重新连接中\/\.test\(text\)\) continue;/);
    expect(content).not.toMatch(/reconnect\|重试\|重新尝试\|再次尝试\|重新连接/);
  });

  it.each([
    ['在其他地方启动了会话', 'https://client.pragmaticplaylive.net/desktop/baccarat/?table_id=bc281koreanch281'],
    ['在其他地方启动了对话', 'https://client.pragmaticplaylive.net/desktop/multibaccarat/'],
  ])('does not click continue on a session-conflict dialog: %s', (copy, url) => {
    const dom = new JSDOM(
      `<body><div role="dialog"><p>${copy}</p><button>继续游戏</button></div></body>`,
      { url },
    );
    Object.defineProperty(dom.window.Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 120, height: 36, top: 0, left: 0, right: 120, bottom: 36 }),
    });
    const button = dom.window.document.querySelector('button')!;
    const click = vi.fn();
    button.click = click;
    const sendMessage = vi.fn();
    const context = vm.createContext({
      chrome: { runtime: { sendMessage } },
      document: dom.window.document,
      location: dom.window.location,
      URL,
      Date,
      JSON,
      Number,
      String,
      Object,
      Array,
      setInterval: vi.fn(),
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      globalThis: null,
    });
    context.globalThis = context;

    vm.runInContext(source, context, { filename: 'pragmatic-dom-hook.js' });

    expect(click).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sessionAction',
      action: 'session-conflict-dialog',
      detail: expect.stringContaining('其他地方'),
    }));
  });

  it('does not click a reconnecting overlay', () => {
    const dom = new JSDOM(
      '<body><p>重新连接中</p></body>',
      { url: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/' },
    );
    const sendMessage = vi.fn();
    const context = vm.createContext({
      chrome: { runtime: { sendMessage } },
      document: dom.window.document,
      location: dom.window.location,
      URL,
      Date,
      JSON,
      Number,
      String,
      Object,
      Array,
      setInterval: vi.fn(),
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      globalThis: null,
    });
    context.globalThis = context;
    vm.runInContext(source, context, { filename: 'pragmatic-dom-hook.js' });
    expect(sendMessage.mock.calls.some(call => call[0]?.kind === 'sessionExpired')).toBe(false);
    expect(sendMessage.mock.calls.some(call => call[0]?.action === 'inline-recovery-click')).toBe(false);
  });

  it('does not click the multibaccarat reconnect banner', () => {
    const dom = new JSDOM(
      '<body><p>重新连接以重返游戏</p><button>重新连接</button></body>',
      { url: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/' },
    );
    Object.defineProperty(dom.window.Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 120, height: 36, top: 0, left: 0, right: 120, bottom: 36 }),
    });
    const button = dom.window.document.querySelector('button')!;
    const click = vi.fn();
    button.click = click;
    const sendMessage = vi.fn();
    const context = vm.createContext({
      chrome: { runtime: { sendMessage } },
      document: dom.window.document,
      location: dom.window.location,
      URL,
      Date,
      JSON,
      Number,
      String,
      Object,
      Array,
      setInterval: vi.fn(),
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      globalThis: null,
    });
    context.globalThis = context;
    vm.runInContext(source, context, { filename: 'pragmatic-dom-hook.js' });
    expect(click).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.some(call => call[0]?.kind === 'sessionExpired')).toBe(false);
  });

  it('uses the native continue-game dialog for idle keepalive', () => {
    const dom = new JSDOM('<body><div role="dialog"><button>继续游戏</button></div></body>', {
      url: 'https://client.pragmaticplaylive.net/desktop/launcher/?table_id=bc281koreanch281',
    });
    Object.defineProperty(dom.window.Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 120, height: 36, top: 0, left: 0, right: 120, bottom: 36 }),
    });
    const button = dom.window.document.querySelector('button')!;
    const click = vi.fn(() => button.remove());
    button.click = click;
    const sendMessage = vi.fn();
    const context = vm.createContext({
      chrome: { runtime: { sendMessage } },
      document: dom.window.document,
      location: dom.window.location,
      URL,
      Date,
      JSON,
      Number,
      String,
      Object,
      Array,
      setInterval: vi.fn(),
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      globalThis: null,
    });
    context.globalThis = context;

    vm.runInContext(source, context, { filename: 'pragmatic-dom-hook.js' });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sessionAction',
      action: 'native-idle-keepalive-armed',
      detail: '/desktop/launcher/',
    }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sessionAction',
      action: 'native-idle-continue-click',
      detail: '继续游戏',
    }));

    context.__baccaratPragmaticReplay();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sessionAction',
      action: 'native-idle-continue-cleared',
    }));
  });

  it('discovers all tables and groups multitable cards by player and banker market', () => {
    const dom = new JSDOM(`
      <body>
        <div id="TileHeight-tobcbaccaragen92">
          <span>粤语极速百家乐</span>
          <span class="game-count"><span>#</span><span>72</span></span>
          <div class="player-market">
            <div data-betcode="0">闲家</div>
            <svg><use href="#card-3-spades"></use></svg>
            <svg><use href="#card-6-clubs"></use></svg>
          </div>
          <div data-betcode="2">和</div>
          <div class="banker-market">
            <div data-betcode="1">庄家</div>
            <svg><use href="#card-5-hearts"></use></svg>
            <svg><use href="#card-8-diamonds"></use></svg>
          </div>
          <div data-betcode="3">闲对</div>
          <div data-betcode="4">庄对</div>
          <div data-testid="timer-countdown-8">8</div>
          <div>¥ 10ID: 17260739924</div>
        </div>
        <div id="TileHeight-placeholdertable1"><span>极速百家乐</span></div>
      </body>
    `, { url: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/' });
    Object.defineProperty(dom.window.Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 237, height: 201, top: 0, left: 0, right: 237, bottom: 201 }),
    });
    const sendMessage = vi.fn();
    const context = vm.createContext({
      chrome: { runtime: { sendMessage } },
      document: dom.window.document,
      location: dom.window.location,
      URL,
      Date,
      JSON,
      Number,
      String,
      Object,
      Array,
      setInterval: vi.fn(),
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      globalThis: null,
    });
    context.globalThis = context;

    vm.runInContext(source, context, { filename: 'pragmatic-dom-hook.js' });

    const capture = sendMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find(message => message['source'] === 'baccarat-bridge-pragmatic-state');
    expect(capture).toBeDefined();
    const snapshot = JSON.parse(String(capture?.['data'])) as {
      tables: Array<Record<string, unknown>>;
    };
    expect(snapshot.tables).toHaveLength(2);
    expect(snapshot.tables[0]).toEqual(expect.objectContaining({
      tableId: 'tobcbaccaragen92',
      roundId: '17260739924',
      bettingOpen: true,
      countdown: 8,
      playerCards: ['3S', '6C'],
      bankerCards: ['5H', '8D'],
      visible: true,
      minBet: 10,
    }));
    expect(snapshot.tables[1]).toEqual(expect.objectContaining({
      tableId: 'placeholdertable1',
      visible: false,
      source: 'dom',
    }));
    expect(snapshot.tables[1]).not.toHaveProperty('playerCards');
    expect(snapshot.tables[1]).not.toHaveProperty('bankerCards');
    const discovery = sendMessage.mock.calls
      .map(([message]) => message as Record<string, any>)
      .find(message => message['kind'] === 'roomDiscovered');
    expect(discovery?.['room']?.tables?.[0]).toEqual(expect.objectContaining({
      tableId: 'tobcbaccaragen92',
      displayName: '粤语极速百家乐',
      roundId: '17260739924',
      gameCount: 72,
    }));
  });
});
