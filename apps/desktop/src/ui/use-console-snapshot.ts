import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopConsoleSnapshot } from '../api-types';
import type { ConsoleView } from './record-view';

export interface SnapshotRequestToken {
  readonly sequence: number;
  readonly monitorMutationSequence: number;
}

export interface ConsoleSnapshotQuery {
  readonly view: ConsoleView;
  readonly tableFilter: string;
  readonly startTime: string;
  readonly endTime: string;
}

/**
 * 控制台实时快照的收敛 store：
 * - 轮询（监控页 1s / 其余 2s）与序列守卫全部在这里；
 * - 监控桌变更事务（begin/finishMonitorTableMutation）保证"变更进行中"
 *   的轮询结果不会覆盖变更返回的新快照；
 * - setSnapshot 仍暴露给调用方，供命令型操作（下注/调参）直接回填。
 */
export function useConsoleSnapshot(query: ConsoleSnapshotQuery) {
  const [snapshot, setSnapshot] = useState<DesktopConsoleSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const snapshotSequenceRef = useRef(0);
  const monitorMutationSequenceRef = useRef(0);
  const pendingMonitorMutationsRef = useRef(0);
  const refreshBusyRef = useRef(false);
  const desktopReady = typeof window !== 'undefined' && Boolean(window.desktop);

  const beginSnapshotRequest = useCallback((): SnapshotRequestToken => ({
    sequence: ++snapshotSequenceRef.current,
    monitorMutationSequence: monitorMutationSequenceRef.current,
  }), []);

  const beginMonitorTableMutation = useCallback((): SnapshotRequestToken => {
    pendingMonitorMutationsRef.current += 1;
    const monitorMutationSequence = ++monitorMutationSequenceRef.current;
    return {
      sequence: ++snapshotSequenceRef.current,
      monitorMutationSequence,
    };
  }, []);

  const canApplySnapshot = useCallback((token: SnapshotRequestToken): boolean => (
    token.sequence === snapshotSequenceRef.current
      && token.monitorMutationSequence === monitorMutationSequenceRef.current
      && pendingMonitorMutationsRef.current === 0
  ), []);

  const finishMonitorTableMutation = useCallback((token: SnapshotRequestToken, nextSnapshot?: DesktopConsoleSnapshot): boolean => {
    pendingMonitorMutationsRef.current = Math.max(0, pendingMonitorMutationsRef.current - 1);
    const isCurrentMutation = token.monitorMutationSequence === monitorMutationSequenceRef.current;
    if (isCurrentMutation && nextSnapshot !== undefined) {
      // A refresh that started while this mutation was in flight is now stale.
      snapshotSequenceRef.current += 1;
      setSnapshot(nextSnapshot);
    }
    return isCurrentMutation;
  }, []);

  const isMonitorMutationCurrent = useCallback((token: SnapshotRequestToken): boolean =>
    token.monitorMutationSequence === monitorMutationSequenceRef.current, []);

  const refresh = useCallback(async () => {
    if (!window.desktop || refreshBusyRef.current) return;
    const request = beginSnapshotRequest();
    refreshBusyRef.current = true;
    try {
      const nextSnapshot = await window.desktop.snapshot({
        includeHistory: false,
        includeRecordCounts: query.view !== 'monitor' && query.view !== 'settings',
        includeSummary: query.view === 'overview',
        tableId: query.tableFilter === 'all' ? undefined : query.tableFilter,
        fromTime: query.startTime || undefined,
        toTime: query.endTime || undefined,
      });
      if (!canApplySnapshot(request)) return;
      setSnapshot(nextSnapshot);
      setError(null);
    } catch (e) {
      if (!canApplySnapshot(request)) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      refreshBusyRef.current = false;
    }
  }, [beginSnapshotRequest, canApplySnapshot, query.view, query.tableFilter, query.startTime, query.endTime]);

  useEffect(() => {
    void refresh();
    const intervalMs = query.view === 'monitor' ? 1_000 : 2_000;
    timerRef.current = window.setInterval(() => void refresh(), intervalMs);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [refresh, query.view]);

  return {
    snapshot,
    setSnapshot,
    error,
    setError,
    desktopReady,
    refresh,
    beginSnapshotRequest,
    beginMonitorTableMutation,
    canApplySnapshot,
    finishMonitorTableMutation,
    isMonitorMutationCurrent,
  };
}
