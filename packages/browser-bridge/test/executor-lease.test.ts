import { describe, expect, it } from 'vitest';
import {
  ExecutorLeaseRegistry,
  betSignaturePayload,
  signExecutorPayload,
  verifyExecutorPayload,
} from '../src/executor-lease.js';

describe('ExecutorLeaseRegistry', () => {
  it('acquires a unique lease and keeps active_executor_count at 1', () => {
    const registry = new ExecutorLeaseRegistry();
    const first = registry.tryAcquire('chrome-profile-alpha', 'claimant-a');
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') throw new Error('expected acquire');
    expect(registry.activeExecutorCount()).toBe(1);
    expect(registry.getActiveLease()?.leaseId).toBe(first.lease.leaseId);

    const duplicate = registry.tryAcquire('chrome-profile-alpha', 'claimant-b');
    expect(duplicate).toEqual({
      status: 'rejected',
      reason: 'executor-lease-duplicate-claimant',
      activeLeaseId: first.lease.leaseId,
    });
    expect(registry.activeExecutorCount()).toBe(1);
  });

  it('rejects a second profile while a lease is held', () => {
    const registry = new ExecutorLeaseRegistry();
    const first = registry.tryAcquire('chrome-profile-alpha', 'claimant-a');
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') throw new Error('expected acquire');
    expect(registry.tryAcquire('chrome-profile-beta', 'claimant-b')).toMatchObject({
      status: 'rejected',
      reason: 'executor-lease-held-by-other-profile',
      activeLeaseId: first.lease.leaseId,
    });
  });

  it('rebinds the same leaseId after the previous claimant disconnects (SW restart)', () => {
    const registry = new ExecutorLeaseRegistry();
    const first = registry.tryAcquire('chrome-profile-alpha', 'claimant-sw-1');
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') throw new Error('expected acquire');
    const leaseId = first.lease.leaseId;
    const secret = first.lease.secret;

    expect(registry.release('claimant-sw-1')).toBe(true);
    expect(registry.activeExecutorCount()).toBe(1);
    expect(registry.getActiveClaimantId()).toBe('');

    const rebound = registry.tryAcquire('chrome-profile-alpha', 'claimant-sw-2');
    expect(rebound.status).toBe('acquired');
    if (rebound.status !== 'acquired') throw new Error('expected rebind');
    expect(rebound.reacquired).toBe(true);
    expect(rebound.lease.leaseId).toBe(leaseId);
    expect(rebound.lease.secret).toBe(secret);
    expect(registry.activeExecutorCount()).toBe(1);
  });

  it('rejects a parallel Electron execution channel', () => {
    const registry = new ExecutorLeaseRegistry();
    expect(registry.claimHostExecutionChannel('desktop-primary')).toEqual({
      ok: true,
      channelId: 'desktop-primary',
    });
    expect(registry.claimHostExecutionChannel('desktop-secondary')).toEqual({
      ok: false,
      reason: 'parallel-execution-channel-rejected',
      activeChannelId: 'desktop-primary',
    });
    expect(registry.claimHostExecutionChannel('desktop-primary')).toEqual({
      ok: true,
      channelId: 'desktop-primary',
    });
  });

  it('signs and verifies bet envelopes for the active lease', () => {
    const registry = new ExecutorLeaseRegistry();
    const acquired = registry.tryAcquire('chrome-profile-alpha', 'claimant-a');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') throw new Error('expected acquire');
    const envelope = registry.signBetRequest('bet-1');
    expect(envelope).toEqual({
      leaseId: acquired.lease.leaseId,
      requestId: 'bet-1',
      signature: signExecutorPayload(
        acquired.lease.secret,
        betSignaturePayload(acquired.lease.leaseId, 'bet-1'),
      ),
    });
    expect(registry.verifyBetRequest(envelope!)).toBe(true);
    expect(verifyExecutorPayload(acquired.lease.secret, 'tampered', envelope!.signature)).toBe(false);
  });
});
