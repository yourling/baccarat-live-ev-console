import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_TOKEN,
} from '../src/index.js';

describe('bundled browser bridge identity', () => {
  it('keeps the manifest key, extension ID, and background token synchronized', () => {
    const manifest = JSON.parse(readFileSync(
      new URL('../../../apps/browser-extension/manifest.json', import.meta.url),
      'utf8',
    )) as { readonly key?: string };
    if (manifest.key === undefined) throw new Error('browser extension manifest key missing');
    const publicKey = Buffer.from(manifest.key, 'base64');
    const digest = createHash('sha256').update(publicKey).digest().subarray(0, 16);
    const extensionId = [...digest]
      .map(byte => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
      .join('');
    const background = readFileSync(
      new URL('../../../apps/browser-extension/background.js', import.meta.url),
      'utf8',
    );

    expect(extensionId).toBe(BUNDLED_BROWSER_EXTENSION_ID);
    expect(background).toContain(BUNDLED_BROWSER_EXTENSION_TOKEN);
  });
});
