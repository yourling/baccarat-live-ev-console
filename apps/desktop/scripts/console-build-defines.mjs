import { execFileSync } from 'node:child_process';

export function consoleGitSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{4,40}$/i.test(sha) ? sha : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function consoleBuildDefines() {
  return {
    'import.meta.env.VITE_CONSOLE_GIT_SHA': JSON.stringify(consoleGitSha()),
  };
}
