import type { DecisionHandRecord } from '@baccarat/ledger-state';
import type { DesktopRecordPage, DesktopRecordQuery } from '../api-types';

export type ConsoleView = 'overview' | 'monitor' | 'risk' | 'decisions' | 'events' | 'ledger' | 'settings';

export type RecordViewChange = {
  readonly view: ConsoleView;
  readonly shouldLoadRecords: boolean;
};

type RecordTabCountInput = {
  readonly currentView: ConsoleView;
  readonly targetKind: DesktopRecordQuery['kind'];
  readonly snapshotCount: number;
  readonly recordPage: Pick<DesktopRecordPage, 'kind' | 'total'> | null;
};

export function recordKindForView(view: ConsoleView): DesktopRecordQuery['kind'] | null {
  if (view === 'decisions' || view === 'events' || view === 'ledger') return view;
  return null;
}

export function recordTabCount({
  currentView,
  targetKind,
  snapshotCount,
  recordPage,
}: RecordTabCountInput): number {
  return recordKindForView(currentView) === targetKind && recordPage?.kind === targetKind
    ? recordPage.total
    : snapshotCount;
}

export function planRecordViewChange(currentView: ConsoleView, nextView: ConsoleView): RecordViewChange {
  return {
    view: nextView,
    shouldLoadRecords: currentView !== nextView && recordKindForView(nextView) !== null,
  };
}

export function decisionHandExplanation(decision: DecisionHandRecord): string {
  if (decision.reasons.some(reason => reason.includes('betting-window-not-observable'))) {
    return '未观察到下注窗口，已禁止执行';
  }
  const parts = [decision.eligible ? '达到下注阈值' : '未达到下注阈值'];
  if (decision.reasons.some(reason => reason.includes('auto-not-armed'))) parts.push('自动下注当前已暂停');
  if (decision.eligible && decision.selectedMarkets.length === 0 && !parts.includes('自动下注当前已暂停')) parts.push('策略未选择市场');
  return parts.join(' · ');
}
