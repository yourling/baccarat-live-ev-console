export type ExecutionMode = 'shadow' | 'live';

export type ExecutionModeChangePlan =
  | { readonly kind: 'apply-shadow' }
  | { readonly kind: 'confirm-live' };

export type OneShotLiveBetModeGate = 'persistent-live-execution' | null;

export function planExecutionModeChange(mode: ExecutionMode): ExecutionModeChangePlan {
  switch (mode) {
    case 'shadow':
      return { kind: 'apply-shadow' };
    case 'live':
      return { kind: 'confirm-live' };
    default:
      return assertNever(mode);
  }
}

export function getOneShotLiveBetModeGate(
  hasPersistentLiveExecution: boolean,
): OneShotLiveBetModeGate {
  return hasPersistentLiveExecution ? 'persistent-live-execution' : null;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected execution mode: ${value}`);
}
