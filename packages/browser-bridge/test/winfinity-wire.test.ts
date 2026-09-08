import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const protocolSource = readFileSync(
  new URL('../../../apps/browser-extension-winfinity/winfinity-protocol.js', import.meta.url),
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
