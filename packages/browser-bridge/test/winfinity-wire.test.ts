import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const nativeModule = (process as any).getBuiltinModule ? (process as any).getBuiltinModule('module') : await import('node:module');
const { JSDOM } = nativeModule.createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: any[]) => any;
};

const protocolSource = readFileSync(
  new URL('../../../apps/browser-extension-winfinity/winfinity-protocol.js', import.meta.url),
  'utf8',
);
const domHookSource = readFileSync(
  new URL('../../../apps/browser-extension-winfinity/winfinity-dom-hook.js', import.meta.url),
  'utf8',
);

function loadProtocol() {
  const context = vm.createContext({ console, JSON, Set, URL });
  vm.runInContext(`${protocolSource}\nthis.isWinfinityGameFrame = isWinfinityGameFrame;\nthis.extractStreamId = extractStreamId;`, context);
  return context as unknown as {
    isWinfinityGameFrame: (raw: string) => boolean;
    extractStreamId: (href: string) => string | undefined;
  };
}

describe('Winfinity wire protocol helpers', () => {
  it('accepts game JSON and rejects sentry envelopes', () => {
    const proto = loadProtocol();
    expect(proto.isWinfinityGameFrame(JSON.stringify({
      type: 'GAME_STATE_CHANGED',
      meta: { tableId: '638f56dc65729f90d0636fb0' },
    }))).toBe(true);
    expect(proto.isWinfinityGameFrame(JSON.stringify({ type: 'WINNERS_LIST' }))).toBe(false);
    expect(proto.isWinfinityGameFrame('{"ok":true}')).toBe(false);
    expect(proto.extractStreamId('https://baccarat-multitable.youngpoisson.xyz/?streamId=tyn-bac8&tableId=638f56dc65729f90d0636fb0')).toBe('tyn-bac8');
  });
});

function scanLobby(html: string) {
  const dom = new JSDOM(html, { url: 'https://lobby.youngpoisson.xyz/' });
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
    Map,
    setInterval: vi.fn(),
    globalThis: null,
  });
  context.globalThis = context;
  vm.runInContext(domHookSource, context, { filename: 'winfinity-dom-hook.js' });
  const capture = sendMessage.mock.calls
    .map(call => call[0] as { kind?: string; source?: string; data?: string })
    .find(message => message?.kind === 'networkCapture' && message.source === 'baccarat-bridge-winfinity-state');
  const tables = capture?.data === undefined ? [] : (JSON.parse(capture.data) as { tables?: unknown[] }).tables ?? [];
  return tables as Array<Record<string, unknown>>;
}

describe('Winfinity DOM lobby discovery', () => {
  it('emits short stream ids and baccarat hex tiles, dropping hex-only non-baccarat tiles', () => {
    const tables = scanLobby(`
      <div>Tao Yuan Baccarat 8
        <iframe src="https://baccarat-multitable.youngpoisson.xyz/?streamId=tyn-bac8&tableId=638f56dc65729f90d0636fb0"></iframe>
      </div>
      <div>Roulette
        <a href="https://lobby.youngpoisson.xyz/?tableId=aaaaaaaaaaaaaaaaaaaaaaaa">Roulette 1</a>
      </div>
      <div>Shangrila Baccarat
        <iframe src="https://baccarat-multitable.youngpoisson.xyz/?tableId=bbbbbbbbbbbbbbbbbbbbbbbb"></iframe>
      </div>
      <div id="tableId_638f55f0716f771a0c510f6d">Tao Yuan Baccarat 3:
        ¥5 #16
      </div>
    `);
    expect(tables).toEqual(expect.arrayContaining([
      expect.objectContaining({ tableId: 'tyn-bac8', streamId: 'tyn-bac8' }),
      expect.objectContaining({ tableId: 'wnf-bbbbbbbbbbbbbbbbbbbbbbbb' }),
      expect.objectContaining({
        tableId: 'wnf-638f55f0716f771a0c510f6d',
        vendorTableId: '638f55f0716f771a0c510f6d',
        displayName: 'Tao Yuan Baccarat 3',
        gameCount: 16,
      }),
    ]));
    expect(tables.map(table => table.tableId)).not.toContain('wnf-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(tables.map(table => table.tableId)).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
  });
});
