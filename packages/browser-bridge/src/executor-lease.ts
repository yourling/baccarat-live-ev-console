import { createHmac, randomBytes } from 'node:crypto';

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

export function signExecutorPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyExecutorPayload(secret: string, payload: string, signature: string): boolean {
  if (typeof signature !== 'string' || signature.length < 32) return false;
  const expected = signExecutorPayload(secret, payload);
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return mismatch === 0;
}

export function betSignaturePayload(leaseId: string, requestId: string): string {
  return `betRequest:${leaseId}:${requestId}`;
}

/**
 * One Chrome profile may hold at most one executor lease on the local host.
 * A service-worker restart re-binds the same leaseId when the previous claimant
 * is gone; a concurrent second claimant is rejected.
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
    const normalizedProfile = String(profileId || '').trim();
    const normalizedClaimant = String(claimantId || '').trim();
    if (!/^[a-zA-Z0-9._-]{8,128}$/.test(normalizedProfile)) {
      return { status: 'rejected', reason: 'invalid-profile-id', activeLeaseId: this.active?.leaseId ?? '' };
    }
    if (!/^[a-zA-Z0-9._-]{8,128}$/.test(normalizedClaimant)) {
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

    // Previous claimant disconnected: park keeps leaseId so SW restart rebinds.
    if (!this.active.claimantId) {
      return this.rebindClaimant(normalizedProfile, normalizedClaimant);
    }

    // Concurrent second claimant for the same profile while the first is live.
    return {
      status: 'rejected',
      reason: 'executor-lease-duplicate-claimant',
      activeLeaseId: this.active.leaseId,
    };
  }

  /**
   * Re-bind the active lease to a new claimant after the previous socket is gone
   * (service-worker restart). Keeps the same leaseId/secret.
   */
  rebindClaimant(profileId: string, claimantId: string): ExecutorLeaseAcquireResult {
    const normalizedProfile = String(profileId || '').trim();
    const normalizedClaimant = String(claimantId || '').trim();
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
    const normalized = String(channelId || '').trim() || 'desktop-primary';
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
