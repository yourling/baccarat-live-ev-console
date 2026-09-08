import { describe, expect, it } from 'vitest';
import {
  WinfinityRuntimeParser,
  normalizeWinfinityTableId,
  publicWinfinityTableId,
} from '../src/winfinity-runtime.js';

describe('Winfinity table ids', () => {
  it('uses lowercase stream id when present', () => {
    expect(publicWinfinityTableId({
      streamId: 'TYN-BAC8',
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).toBe('tyn-bac8');
  });

  it('falls back to wnf- prefix and never emits a bare 24-hex id', () => {
    expect(publicWinfinityTableId({
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).toBe('wnf-638f56dc65729f90d0636fb0');
    expect(publicWinfinityTableId({
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).not.toMatch(/^[a-f0-9]{24}$/i);
  });

  it('rejects pragmatic-shaped and bg-shaped ids', () => {
    expect(publicWinfinityTableId({ streamId: 'pragmatictable01' })).toBeUndefined();
    expect(publicWinfinityTableId({ vendorTableId: 'B06' })).toBeUndefined();
    expect(normalizeWinfinityTableId('tyn-bac8')).toBe('tyn-bac8');
    expect(normalizeWinfinityTableId('wnf-638f56dc65729f90d0636fb0')).toBe('wnf-638f56dc65729f90d0636fb0');
    expect(normalizeWinfinityTableId('638f56dc65729f90d0636fb0')).toBeUndefined();
  });

  it('locks the first public id for a vendor table and ignores later aliases', () => {
    const parser = new WinfinityRuntimeParser();
    expect(parser.resolveTableId('638f56dc65729f90d0636fb0')).toBe('wnf-638f56dc65729f90d0636fb0');
    parser.registerAlias('638f56dc65729f90d0636fb0', 'tyn-bac8');
    expect(parser.resolveTableId('638f56dc65729f90d0636fb0')).toBe('wnf-638f56dc65729f90d0636fb0');
  });

  it('uses stream id when the alias is registered before first resolve', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias('638f56dc65729f90d0636fb0', 'TYN-BAC8');
    expect(parser.resolveTableId('638f56dc65729f90d0636fb0')).toBe('tyn-bac8');
  });
});
