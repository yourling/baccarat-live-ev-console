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

  it('does not plan a shadow downgrade in this build', () => {
    // FIX(D-P0-4): 修复前这里返回 { kind: 'apply-shadow' }，App.tsx 据此调用
    // setExecutionMode(tableId,'shadow')；而服务层当时丢弃 mode 参数、无条件
    // arm 真金执行器 —— 结果"切影子"反而打开了下真钱的通道（a1e 实证）。
    // 本构建不支持画面降级，计划必须明确标成 unsupported。
    expect(planExecutionModeChange('shadow')).toEqual({ kind: 'unsupported-shadow' });
  });

  it('keeps a one-shot operation blocked while persistent live execution is active', () => {
    // Given: at least one table remains in persistent live execution.
    // When: one-shot availability is evaluated.
    const gate = getOneShotLiveBetModeGate(true);

    // Then: the UI can explain the mutually exclusive execution path.
    expect(gate).toBe('persistent-live-execution');
  });
});
