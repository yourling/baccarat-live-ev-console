import { describe, expect, it } from 'vitest';
import {
  getOneShotLiveBetModeGate,
  planExecutionModeChange,
} from '../src/ui/execution-mode';

describe('execution mode interaction', () => {
  it('requires an in-app confirmation before enabling persistent live execution', () => {
    // Given: the operator selects persistent live execution.
    // When: the UI plans the requested mode change.
    const change = planExecutionModeChange('live');

    // Then: no live IPC request is made until a second explicit confirmation.
    expect(change).toEqual({ kind: 'confirm-live' });
  });

  it('keeps a one-shot operation blocked while persistent live execution is active', () => {
    // Given: at least one table remains in persistent live execution.
    // When: one-shot availability is evaluated.
    const gate = getOneShotLiveBetModeGate(true);

    // Then: the UI can explain the mutually exclusive execution path.
    expect(gate).toBe('persistent-live-execution');
  });
});
