import { describe, expect, it } from 'vitest';
import { monitorDisplayedConnection } from '../src/ui/monitor-connection';

describe('monitorDisplayedConnection', () => {
  it('keeps ledger CONNECTED when the live feed is healthy', () => {
    expect(monitorDisplayedConnection(
      { connectionStatus: 'CONNECTED' },
      { feedState: 'CONNECTED', reasons: [] },
    )).toBe('CONNECTED');
  });

  it('shows DISCONNECTED when the table feed is down even if the ledger still says CONNECTED', () => {
    expect(monitorDisplayedConnection(
      { connectionStatus: 'CONNECTED' },
      { feedState: 'DISCONNECTED', reasons: ['table-feed-disconnected'] },
    )).toBe('DISCONNECTED');
  });

  it('shows 同步中 when the feed is connected but stale', () => {
    expect(monitorDisplayedConnection(
      { connectionStatus: 'CONNECTED' },
      { feedState: 'CONNECTED', reasons: ['table-feed-stale'] },
    )).toBe('RESYNCING');
  });

  it('does not keep showing 已断开 after the live feed has resumed', () => {
    expect(monitorDisplayedConnection(
      { connectionStatus: 'DISCONNECTED' },
      { feedState: 'CONNECTED', reasons: [] },
    )).toBe('RESYNCING');
  });
});
