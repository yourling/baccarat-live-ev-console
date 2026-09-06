import { existsSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

export const DEFAULT_STALL_LOG_MS = 8_000;
export const DEFAULT_STALL_KILL_MS = 20_000;

export interface StallDetector {
  ping(): void;
  stalledMs(now?: number): number | null;
}

export function createStallDetector(stallMs: number, now: () => number = Date.now): StallDetector {
  let last = now();
  return {
    ping() {
      last = now();
    },
    stalledMs(at = now()) {
      const elapsed = at - last;
      return elapsed >= stallMs ? elapsed : null;
    },
  };
}

export interface MainThreadWatchdog {
  ping(): void;
  stop(): void;
}

export interface MainThreadWatchdogOptions {
  readonly logPath: string;
  readonly stallMs?: number;
  readonly killMs?: number;
  readonly checkEveryMs?: number;
  readonly pid?: number;
  readonly exitOnStall?: boolean;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
let last = Date.now();
let logged = false;
parentPort.on('message', message => {
  if (message === 'ping') last = Date.now();
  if (message === 'stop') process.exit(0);
});
const timer = setInterval(() => {
  const stalled = Date.now() - last;
  if (stalled < workerData.stallMs) {
    logged = false;
    return;
  }
  if (!logged) {
    logged = true;
    try {
      fs.appendFileSync(
        workerData.logPath,
        JSON.stringify({
          at: new Date().toISOString(),
          stalledMs: stalled,
          pid: workerData.pid,
        }) + String.fromCharCode(10),
      );
    } catch {
      // Logging must never throw inside the watchdog.
    }
  }
  if (workerData.exitOnStall && stalled >= workerData.killMs) {
    try {
      process.kill(workerData.pid, 9);
    } catch {
      // Process may already be exiting.
    }
  }
}, workerData.checkEveryMs);
timer.unref?.();
`;

export function startMainThreadWatchdog(options: MainThreadWatchdogOptions): MainThreadWatchdog {
  const stallMs = Math.max(1_000, Math.trunc(options.stallMs ?? DEFAULT_STALL_LOG_MS));
  const killMs = Math.max(stallMs, Math.trunc(options.killMs ?? DEFAULT_STALL_KILL_MS));
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      logPath: options.logPath,
      stallMs,
      killMs,
      checkEveryMs: Math.max(200, Math.trunc(options.checkEveryMs ?? 1_000)),
      pid: options.pid ?? process.pid,
      exitOnStall: options.exitOnStall === true,
    },
  });
  worker.unref?.();
  const timer = setInterval(() => {
    worker.postMessage('ping');
  }, 1_000);
  timer.unref?.();
  let stopped = false;
  return {
    ping() {
      if (!stopped) worker.postMessage('ping');
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      worker.postMessage('stop');
      void worker.terminate();
    },
  };
}

export function warnIfPreviousMainThreadStall(logPath: string): boolean {
  if (!existsSync(logPath)) return false;
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
    const tail = lines[lines.length - 1];
    if (!tail) return false;
    console.error('previous Electron main-thread stall', tail);
    return true;
  } catch {
    return false;
  }
}
