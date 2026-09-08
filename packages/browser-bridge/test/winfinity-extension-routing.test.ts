import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const backgroundSource = readFileSync(
  new URL('../../../apps/browser-extension-winfinity/background.js', import.meta.url),
  'utf8',
);
const networkHookSource = readFileSync(
  new URL('../../../apps/browser-extension-winfinity/winfinity-network-hook.js', import.meta.url),
  'utf8',
);
const manifest = JSON.parse(readFileSync(
  new URL('../../../apps/browser-extension-winfinity/manifest.json', import.meta.url),
  'utf8',
)) as { content_scripts?: Array<{ js?: string[] }>; permissions?: string[] };

describe('Winfinity extension routing', () => {
  it('matches only the tao-yuan popup and does not ship a bet runtime', () => {
    const scripts = (manifest.content_scripts ?? []).flatMap(entry => entry.js ?? []);
    expect(scripts).toContain('winfinity-network-hook.js');
    expect(scripts).not.toContain('bg-bet-runtime.js');
    expect(scripts).not.toContain('pragmatic-bet-runtime.js');
    expect(manifest.permissions ?? []).not.toContain('scripting');
    expect(backgroundSource).toContain('/live-dealer/popup-launch/tao-yuan-baccarat');
    expect(backgroundSource).not.toContain('jeju-speed-baccarat');
    expect(backgroundSource).not.toContain('live-baccarat-bg');
    expect(backgroundSource).not.toContain('autoBet');
    expect(backgroundSource).not.toMatch(/chrome\.tabs\.reload\s*\(/);
    expect(backgroundSource).toContain('winfinity-monitor-only');
    expect(networkHookSource).toContain('baccarat-bridge-winfinity-ws');
    expect(networkHookSource).toContain('youngpoisson.xyz');
    expect(networkHookSource).not.toContain('autoBet');
  });
});
