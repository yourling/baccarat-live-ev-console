import { describe, expect, it } from 'vitest';
import type { DecisionHandRecord } from '@baccarat/ledger-state';
import type { DesktopRecordPage } from '../src/api-types';
import { decisionHandExplanation, planRecordViewChange, recordTabCount } from '../src/ui/record-view';

describe('planRecordViewChange', () => {
  it('requests the first record page when entering a record view', () => {
    // Given: the operator is viewing the live overview.
    const currentView = 'overview';

    // When: the operator opens the decision view.
    const next = planRecordViewChange(currentView, 'decisions');

    // Then: the UI loads its first paginated decision page.
    expect(next).toEqual({ view: 'decisions', shouldLoadRecords: true });
  });

  it('does not issue a record query for non-record views', () => {
    // Given: the operator is currently viewing decisions.
    const currentView = 'decisions';

    // When: the operator opens settings.
    const next = planRecordViewChange(currentView, 'settings');

    // Then: no record query is necessary.
    expect(next).toEqual({ view: 'settings', shouldLoadRecords: false });
  });

  it('labels an unobservable betting window as execution forbidden', () => {
    // Given: the runtime only observed the hand after the wagering window closed.
    const decision = {
      tableId: 'D056',
      shoeId: 'shoe-1',
      handId: 'hand-1',
      markets: ['bankerPair', 'playerPair'],
      selectedMarkets: [],
      pMean: 0.074,
      pLower: 0.074,
      evMean: -0.104,
      evLower: -0.104,
      eligible: false,
      reasons: ['betting-window-not-observable; execution-forbidden'],
      createdAt: '2026-08-25T15:00:00.000Z',
      actualResult: { status: 'PENDING' },
    } satisfies DecisionHandRecord;

    // When: the decision table derives its human-readable reason.
    const explanation = decisionHandExplanation(decision);

    // Then: it exposes the operational safety reason rather than a false EV-threshold explanation.
    expect(explanation).toBe('未观察到下注窗口，已禁止执行');
  });
});

describe('recordTabCount', () => {
  it('prefers the current decision page total over a stale snapshot count', () => {
    // Given: a newly persisted decision has reached the paginated query before the snapshot poll.
    const snapshotCount = 12;
    const recordPage = { kind: 'decisions', total: 13 } satisfies Pick<DesktopRecordPage, 'kind' | 'total'>;

    // When: the operator is viewing the decision tab.
    const count = recordTabCount({
      currentView: 'decisions',
      targetKind: 'decisions',
      snapshotCount,
      recordPage,
    });

    // Then: navigation matches the decision table total immediately.
    expect(count).toBe(13);
  });
});
