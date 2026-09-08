import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_BG_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_IDS,
  BUNDLED_BROWSER_EXTENSION_TOKEN,
  BUNDLED_WINFINITY_BROWSER_EXTENSION_ID,
  DAFABET_WINFINITY_ROOM_ID,
  isLiveBridgeRoomId,
} from '../src/index.js';

function extensionIdFromManifestKey(key: string): string {
  const publicKey = Buffer.from(key, 'base64');
  const digest = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  return [...digest]
    .map(byte => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
    .join('');
}

describe('bundled browser bridge identity', () => {
  it('keeps the manifest key, extension ID, and background token synchronized', () => {
    const manifest = JSON.parse(readFileSync(
      new URL('../../../apps/browser-extension/manifest.json', import.meta.url),
      'utf8',
    )) as { readonly key?: string };
    if (manifest.key === undefined) throw new Error('browser extension manifest key missing');
    expect(extensionIdFromManifestKey(manifest.key)).toBe(BUNDLED_BROWSER_EXTENSION_ID);
    const background = readFileSync(
      new URL('../../../apps/browser-extension/background.js', import.meta.url),
      'utf8',
    );
    expect(background).toContain(BUNDLED_BROWSER_EXTENSION_TOKEN);
  });

  it('keeps the BG manifest key, extension ID, and background token synchronized', () => {
    const manifest = JSON.parse(readFileSync(
      new URL('../../../apps/browser-extension-bg/manifest.json', import.meta.url),
      'utf8',
    )) as { readonly key?: string };
    if (manifest.key === undefined) throw new Error('BG browser extension manifest key missing');
    const background = readFileSync(
      new URL('../../../apps/browser-extension-bg/background.js', import.meta.url),
      'utf8',
    );
    expect(extensionIdFromManifestKey(manifest.key)).toBe(BUNDLED_BG_BROWSER_EXTENSION_ID);
    expect(background).toContain(BUNDLED_BROWSER_EXTENSION_TOKEN);
    expect(BUNDLED_BROWSER_EXTENSION_IDS).toEqual([
      BUNDLED_BROWSER_EXTENSION_ID,
      BUNDLED_BG_BROWSER_EXTENSION_ID,
      BUNDLED_WINFINITY_BROWSER_EXTENSION_ID,
    ]);
  });

  it('keeps the Winfinity manifest key, extension ID, and background token synchronized', () => {
    const manifest = JSON.parse(readFileSync(
      new URL('../../../apps/browser-extension-winfinity/manifest.json', import.meta.url),
      'utf8',
    )) as { readonly key?: string };
    if (manifest.key === undefined) throw new Error('Winfinity browser extension manifest key missing');
    expect(extensionIdFromManifestKey(manifest.key)).toBe(BUNDLED_WINFINITY_BROWSER_EXTENSION_ID);
    expect(BUNDLED_BROWSER_EXTENSION_IDS).toEqual([
      BUNDLED_BROWSER_EXTENSION_ID,
      BUNDLED_BG_BROWSER_EXTENSION_ID,
      BUNDLED_WINFINITY_BROWSER_EXTENSION_ID,
    ]);
    expect(isLiveBridgeRoomId('dafabet-winfinity')).toBe(true);
    expect(DAFABET_WINFINITY_ROOM_ID).toBe('dafabet-winfinity');
  });
});
