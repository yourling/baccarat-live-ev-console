import { describe, expect, it, vi } from 'vitest';
import { tryKeepaliveInOrder } from '../electron-src/operational-wager';

describe('tryKeepaliveInOrder', () => {
  it('falls through monitored tables in display order until a wager is accepted', async () => {
    // Given: the first table rejects and the next table can accept the wager.
    const requestWager = vi.fn()
      .mockResolvedValueOnce({ status: 'REJECTED', tableId: 'D055' })
      .mockResolvedValueOnce({ status: 'ACCEPTED', tableId: 'D065' });

    // When: the keepalive interval becomes due.
    const result = await tryKeepaliveInOrder({
      tableIds: ['D055', 'D065', 'D066'],
      amount: 20,
      market: 'banker',
      requestWager,
    });

    // Then: only the necessary ordered attempts run and the accepted table is returned.
    expect(requestWager).toHaveBeenNthCalledWith(1, 'D055', 'banker', 20);
    expect(requestWager).toHaveBeenNthCalledWith(2, 'D065', 'banker', 20);
    expect(requestWager).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: 'ACCEPTED', tableId: 'D065' });
  });

  it('stops the pass when a platform result is unknown', async () => {
    // Given: the first request crossed the platform commit point without an observable result.
    const requestWager = vi.fn().mockResolvedValue({ status: 'UNKNOWN', tableId: 'D055' });

    // When: the keepalive interval becomes due.
    const result = await tryKeepaliveInOrder({
      tableIds: ['D055', 'D065'],
      amount: 20,
      market: 'player',
      requestWager,
    });

    // Then: no fallback request can risk a duplicate wager.
    expect(requestWager).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'UNKNOWN', tableId: 'D055' });
  });

  it('makes one complete failed pass when every table rejects the wager', async () => {
    // Given: every monitored table is unavailable for the requested wager.
    const requestWager = vi.fn()
      .mockResolvedValueOnce({ status: 'REJECTED', tableId: 'D055' })
      .mockResolvedValueOnce({ status: 'REJECTED', tableId: 'D065' });

    // When: the keepalive interval becomes due.
    const result = await tryKeepaliveInOrder({
      tableIds: ['D055', 'D065'],
      amount: 20,
      market: 'banker',
      requestWager,
    });

    // Then: the scheduler stops after the ordered fallback pass.
    expect(requestWager).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: 'REJECTED', tableId: null });
  });
});
