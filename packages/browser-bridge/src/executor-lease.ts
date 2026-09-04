import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const EXECUTOR_ID_PATTERN = /^[a-zA-Z0-9._-]{8,128}$/;

export type ExecutorLease = {
  readonly leaseId: string;
  readonly profileId: string;
  readonly secret: string;
  readonly claimantId: string;
  readonly acquiredAt: string;
};

export type ExecutorLeaseAcquireResult =
  | { readonly status: 'acquired'; readonly lease: ExecutorLease; readonly reacquired: boolean }
  | { readonly status: 'rejected'; readonly reason: string; readonly activeLeaseId: string };

export type HostExecutionChannelClaimResult =
  | { readonly ok: true; readonly channelId: string }
  | { readonly ok: false; readonly reason: string; readonly activeChannelId: string };

export type SignedBetEnvelope = {
  readonly leaseId: string;
  readonly requestId: string;
  readonly signature: string;
};

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
}

function normalizeExecutorId(value: string): string {
  return String(value || '').trim();
}

export function signExecutorPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyExecutorPayload(secret: string, payload: string, signature: string): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = signExecutorPayload(secret, payload);
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(signature, 'hex');
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

export function betSignaturePayload(leaseId: string, requestId: string): string {
  return `betRequest:${leaseId}:${requestId}`;
}

/**
 * The local host grants at most one executor lease. One Chrome profile holds it.
 * Disconnect parks the leaseId/secret so a service-worker restart can rebind;
 * a live second claimant is rejected. Parallel Electron channels are also unique.
 */
export class ExecutorLeaseRegistry {
  private active: ExecutorLease | null = null;
  private hostChannelId: string | null = null;

  activeExecutorCount(): number {
    return this.active ? 1 : 0;
  }

  getActiveLease(): ExecutorLease | null {
    return this.active;
  }

  getActiveClaimantId(): string | null {
    return this.active?.claimantId ?? null;
  }

  tryAcquire(profileId: string, claimantId: string): ExecutorLeaseAcquireResult {
    const normalizedProfile = normalizeExecutorId(profileId);
    const normalizedClaimant = normalizeExecutorId(claimantId);
    if (!EXECUTOR_ID_PATTERN.test(normalizedProfile)) {
      return { status: 'rejected', reason: 'invalid-profile-id', activeLeaseId: this.active?.leaseId ?? '' };
    }
    if (!EXECUTOR_ID_PATTERN.test(normalizedClaimant)) {
      return { status: 'rejected', reason: 'invalid-claimant-id', activeLeaseId: this.active?.leaseId ?? '' };
    }

    if (!this.active) {
      const lease: ExecutorLease = {
        leaseId: newId('lease'),
        profileId: normalizedProfile,
        secret: randomBytes(32).toString('hex'),
        claimantId: normalizedClaimant,
        acquiredAt: new Date().toISOString(),
      };
      this.active = lease;
      return { status: 'acquired', lease, reacquired: false };
    }

    if (this.active.profileId !== normalizedProfile) {
      return {
        status: 'rejected',
        reason: 'executor-lease-held-by-other-profile',
        activeLeaseId: this.active.leaseId,
      };
    }

    if (this.active.claimantId === normalizedClaimant) {
      return { status: 'acquired', lease: this.active, reacquired: true };
    }

    if (!this.active.claimantId) {
      return this.rebindClaimant(normalizedProfile, normalizedClaimant);
    }

    return {
      status: 'rejected',
      reason: 'executor-lease-duplicate-claimant',
      activeLeaseId: this.active.leaseId,
    };
  }

  /**
   * Re-bind the parked lease after the previous socket is gone (SW restart).
   * Keeps the same leaseId and HMAC secret.
   */
  rebindClaimant(profileId: string, claimantId: string): ExecutorLeaseAcquireResult {
    const normalizedProfile = normalizeExecutorId(profileId);
    const normalizedClaimant = normalizeExecutorId(claimantId);
    if (!this.active) return this.tryAcquire(normalizedProfile, normalizedClaimant);
    if (this.active.profileId !== normalizedProfile) {
      return {
        status: 'rejected',
        reason: 'executor-lease-held-by-other-profile',
        activeLeaseId: this.active.leaseId,
      };
    }
    if (this.active.claimantId && this.active.claimantId !== normalizedClaimant) {
      return {
        status: 'rejected',
        reason: 'executor-lease-duplicate-claimant',
        activeLeaseId: this.active.leaseId,
      };
    }
    const rebound: ExecutorLease = {
      ...this.active,
      claimantId: normalizedClaimant,
    };
    this.active = rebound;
    return { status: 'acquired', lease: rebound, reacquired: true };
  }

  /** Park the lease (keep leaseId) so a SW restart can rebind the same profile. */
  release(claimantId: string): boolean {
    if (!this.active || this.active.claimantId !== claimantId) return false;
    this.active = { ...this.active, claimantId: '' };
    return true;
  }

  /** Drop the parked/active lease entirely (host shutdown). */
  clear(): void {
    this.active = null;
    this.hostChannelId = null;
  }

  claimHostExecutionChannel(channelId: string): HostExecutionChannelClaimResult {
    const normalized = normalizeExecutorId(channelId) || 'desktop-primary';
    if (this.hostChannelId && this.hostChannelId !== normalized) {
      return {
        ok: false,
        reason: 'parallel-execution-channel-rejected',
        activeChannelId: this.hostChannelId,
      };
    }
    this.hostChannelId = normalized;
    return { ok: true, channelId: normalized };
  }

  getHostExecutionChannelId(): string | null {
    return this.hostChannelId;
  }

  signBetRequest(requestId: string): SignedBetEnvelope | null {
    if (!this.active) return null;
    const leaseId = this.active.leaseId;
    return {
      leaseId,
      requestId,
      signature: signExecutorPayload(this.active.secret, betSignaturePayload(leaseId, requestId)),
    };
  }

  verifyBetRequest(envelope: SignedBetEnvelope): boolean {
    if (!this.active) return false;
    if (envelope.leaseId !== this.active.leaseId) return false;
    return verifyExecutorPayload(
      this.active.secret,
      betSignaturePayload(envelope.leaseId, envelope.requestId),
      envelope.signature,
    );
  }
}
