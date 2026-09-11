export const CONSOLE_VERSION = '1.0.16';

export interface ConsoleBuildInfo {
  readonly version: string;
  readonly gitSha: string;
}

function bakedGitSha(): string {
  const value = import.meta.env.VITE_CONSOLE_GIT_SHA;
  return typeof value === 'string' ? value.trim() : '';
}

export function currentConsoleBuildInfo(): ConsoleBuildInfo {
  return {
    version: CONSOLE_VERSION,
    gitSha: bakedGitSha() || 'unknown',
  };
}

export function formatConsoleBuildLabel(info: ConsoleBuildInfo = currentConsoleBuildInfo()): string {
  return `V${info.version}+${info.gitSha}`;
}
