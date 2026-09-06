import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createStallDetector,
  warnIfPreviousMainThreadStall,
} from '../electron-src/main-thread-watchdog.js';

describe('main-thread stall detector', () => {
  it('stays quiet while pings arrive and reports after the threshold', () => {
    let now = 1_000;
    const detector = createStallDetector(80, () => now);

    expect(detector.stalledMs()).toBeNull();
    now = 1_040;
    detector.ping();
    now = 1_100;
    expect(detector.stalledMs()).toBeNull();
    now = 1_200;
    expect(detector.stalledMs()).toBe(160);
  });

  it('warns from the previous stall log', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stall-'));
    const logPath = path.join(dir, 'main-thread-stall.log');
    writeFileSync(logPath, '{"stalledMs":12000}\n', 'utf8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(warnIfPreviousMainThreadStall(logPath)).toBe(true);
      expect(error).toHaveBeenCalled();
      expect(warnIfPreviousMainThreadStall(path.join(dir, 'missing.log'))).toBe(false);
    } finally {
      error.mockRestore();
    }
    expect(readFileSync(logPath, 'utf8')).toContain('12000');
  });
});
