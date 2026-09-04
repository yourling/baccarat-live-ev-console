import { describe, expect, it } from 'vitest';
import {
  ExecutorLeaseRegistry,
  betSignaturePayload,
  signExecutorPayload,
  verifyExecutorPayload,
} from '../src/executor-lease.js';

describe('ExecutorLeaseRegistry', () => {
  it('acquires one lease and keeps active_executor_count at 1', () => {
    const registry = new ExecutorLeaseRegistry();
    const first = registry.tryAcquire('chrome-profile-primary-01', 'claimant-primary-01');
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') throw new Error('expected first acquire');
    expect(first.reacquired).toBe(false);
    expect(first.lease.profileId).toBe('chrome-profile-primary-01');
    expect(first.lease.claimantId).toBe('claimant-primary-01');
    expect(first.lease.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.activeExecutorCount()).toBe(1);
    expect(registry.getActiveLease()?.leaseId).toBe(first.lease.leaseId);
    expect(registry.getActiveClaimantId()).toBe('claimant-primary-01');
  });

  it('rejects a second live claimant on the same profile', () => {
    const registry = new ExecutorLeaseRegistry();
    const first = registry.tryAcquire('chrome-profile-primary-01', 'claimant-primary-01');
    if (first.status !== 'acquired') throw new Error('expected first acquire');
    expect(registry.tryAcquire('chrome-profile-primary-01', 'claimant-secondary-02')).toEqual({
      status: 'rejected',
      reason: 'executor-lease-duplicate-claimant',
      activeLeaseId: first.lease.leaseId,
    });
    expect(registry.activeExecutorCount()).toBe(1);
    expect(registry.getActiveClaimantId()).toBe('claimant-primary-01');
  });

  it('rejects a second Chrome profile while a lease is held', () => {
    const registry = new ExecutorLeaseRegistry();
    const first = registry.tryAcquire('chrome-profile-primary-01', 'claimant-primary-01');
    if (first.status !== 'acquired') throw new Error('expected first acquire');
    expect(registry.tryAcquire('chrome-profile-other-99', 'claimant-other-99')).toMatchObject({
      status: 'rejected',
      reason: 'executor-lease-held-by-other-profile',
      activeLeaseId: first.lease.leaseId,
    });
    expect(registry.activeExecutorCount()).toBe(1);
  });

  it('reacquires for the same claimant without rotating leaseId or secret', () => {
    const registry = new ExecutorLeaseRegistry();
    const first = registry.tryAcquire('chrome-profile-primary-01', 'claimant-primary-01');
    if (first.status !== 'acquired') throw new Error('expected first acquire');
    const again = registry.tryAcquire('chrome-profile-primary-01', 'claimant-primary-01');
    expect(again.status).toBe('acquired');
    if (again.status !== 'acquired') throw new Error('expected same-claimant reacquire');
    expect(again.reacquired).toBe(true);
    expect(again.lease.leaseId).toBe(first.lease.leaseId);
    expect(again.lease.secret).toBe(first.lease.secret);
    expect(registry.activeExecutorCount()).toBe(1);
  });

  it('rebinds the parked leaseId after the previous claimant disconnects', () => {
    const registry = new ExecutorLeaseRegistry();
    const first = registry.tryAcquire('chrome-profile-sw-restart', 'claimant-sw-gen-1');
    if (first.status !== 'acquired') throw new Error('expected first acquire');
    expect(registry.release('claimant-sw-gen-1')).toBe(true);
    expect(registry.release('claimant-sw-gen-1')).toBe(false);
    expect(registry.activeExecutorCount()).toBe(1);
    expect(registry.getActiveClaimantId()).toBe('');

    const rebound = registry.tryAcquire('chrome-profile-sw-restart', 'claimant-sw-gen-2');
    expect(rebound.status).toBe('acquired');
    if (rebound.status !== 'acquired') throw new Error('expected SW rebind');
    expect(rebound.reacquired).toBe(true);
    expect(rebound.lease.leaseId).toBe(first.lease.leaseId);
    expect(rebound.lease.secret).toBe(first.lease.secret);
    expect(rebound.lease.claimantId).toBe('claimant-sw-gen-2');
    expect(registry.activeExecutorCount()).toBe(1);
  });

  it('does not rebind a parked lease onto a different profile', () => {
    const registry = new ExecutorLeaseRegistry();
    const first = registry.tryAcquire('chrome-profile-sw-restart', 'claimant-sw-gen-1');
    if (first.status !== 'acquired') throw new Error('expected first acquire');
    expect(registry.release('claimant-sw-gen-1')).toBe(true);
    expect(registry.tryAcquire('chrome-profile-intruder-x', 'claimant-intruder-x')).toMatchObject({
      status: 'rejected',
      reason: 'executor-lease-held-by-other-profile',
      activeLeaseId: first.lease.leaseId,
    });
  });

  it('rejects invalid profile and claimant identifiers', () => {
    const registry = new ExecutorLeaseRegistry();
    expect(registry.tryAcquire('short', 'claimant-primary-01')).toMatchObject({
      status: 'rejected',
      reason: 'invalid-profile-id',
    });
    expect(registry.tryAcquire('chrome-profile-primary-01', 'bad id')).toMatchObject({
      status: 'rejected',
      reason: 'invalid-claimant-id',
    });
    expect(registry.activeExecutorCount()).toBe(0);
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
    expect(registry.getHostExecutionChannelId()).toBe('desktop-primary');
  });

  it('signs and verifies bet envelopes only for the active lease', () => {
    const registry = new ExecutorLeaseRegistry();
    expect(registry.signBetRequest('bet-none')).toBeNull();
    expect(registry.verifyBetRequest({
      leaseId: 'lease-missing',
      requestId: 'bet-none',
      signature: 'a'.repeat(64),
    })).toBe(false);

    const acquired = registry.tryAcquire('chrome-profile-primary-01', 'claimant-primary-01');
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
    expect(registry.verifyBetRequest({ ...envelope!, leaseId: `${acquired.lease.leaseId}-x` })).toBe(false);
    expect(verifyExecutorPayload(acquired.lease.secret, 'tampered', envelope!.signature)).toBe(false);
    expect(verifyExecutorPayload(
      acquired.lease.secret,
      betSignaturePayload(acquired.lease.leaseId, 'bet-1'),
      'zz',
    )).toBe(false);

    registry.clear();
    expect(registry.activeExecutorCount()).toBe(0);
    expect(registry.signBetRequest('bet-1')).toBeNull();
  });
});
