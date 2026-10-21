/**
 * 执行模式交互计划。
 *
 * FIX(D-P0-4): 本构建**不支持**画面降级 —— 修复前 `planExecutionModeChange('shadow')`
 * 返回 `apply-shadow`，`App.tsx` 据此调用 `setExecutionMode(tableId,'shadow')`，
 * 而服务层当时丢弃了 mode 参数、无条件 arm 真金执行器（review 脚本 a1e 实证
 * "以为在演练、实际下真钱"）。现在：
 *  · 服务层对 shadow/simulated 直接抛错；
 *  · 这里不再提供 shadow 计划分支（保留类型只为兼容既有调用点）。
 * 执行模式字段在 UI 上固定只读显示「真实下注」。
 */
export type ExecutionMode = 'shadow' | 'live';

export type ExecutionModeChangePlan =
  | { readonly kind: 'confirm-live' }
  | { readonly kind: 'unsupported-shadow' };

export type OneShotLiveBetModeGate = 'persistent-live-execution' | null;

export function planExecutionModeChange(mode: ExecutionMode): ExecutionModeChangePlan {
  switch (mode) {
    case 'shadow':
      // 真正的"影子模式"需要 orchestrator 支持降级执行模式（跨包改动），本构建不提供。
      return { kind: 'unsupported-shadow' };
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
