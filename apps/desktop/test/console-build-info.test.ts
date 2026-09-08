import { describe, expect, it } from 'vitest';
import { CONSOLE_VERSION, currentConsoleBuildInfo, formatConsoleBuildLabel } from '../src/console-build-info';

describe('console build label', () => {
  it('formats version plus short sha', () => {
    expect(formatConsoleBuildLabel({ version: '1.0.0', gitSha: 'abc1234' })).toBe('V1.0.0+abc1234');
  });

  it('exposes the current console version', () => {
    const info = currentConsoleBuildInfo();
    expect(info.version).toBe(CONSOLE_VERSION);
    expect(info.version).toBe('1.0.0');
    expect(info.gitSha.length).toBeGreaterThan(0);
    expect(formatConsoleBuildLabel(info)).toBe(`V${info.version}+${info.gitSha}`);
  });
});
