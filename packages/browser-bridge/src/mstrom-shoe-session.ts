import { newId, type ShoeBaseline } from '@baccarat/contracts';

export interface MstromShoeSession {
  readonly shoeId: string;
  readonly baseline: ShoeBaseline;
  readonly version: number;
}

export interface MstromShoeConfirmation {
  readonly shoe: MstromShoeSession;
  readonly rotated: boolean;
}

/**
 * A bridge lifetime is one monitoring session. It begins mid-shoe unless the
 * protocol subsequently verifies a physical shoe change.
 */
export class MstromShoeSessionRegistry {
  private readonly monitorSessionId: string;
  private readonly tables = new Map<string, MstromShoeSession>();
  private readonly verifiedBoundaryIds = new Map<string, Set<string>>();
  private readonly activePhysicalShoeEpisodes = new Set<string>();

  constructor(monitorSessionId = newId('session')) {
    this.monitorSessionId = monitorSessionId;
  }

  current(tableId: string): MstromShoeSession {
    const existing = this.tables.get(tableId);
    if (existing) return existing;
    const created: MstromShoeSession = {
      shoeId: `mstrom-monitor-${this.monitorSessionId}-${tableId}-attach`,
      baseline: 'unknown-monitor-session',
      version: 0,
    };
    this.tables.set(tableId, created);
    return created;
  }

  confirmVerifiedPhysicalShoe(tableId: string, boundaryId: string): MstromShoeConfirmation {
    if (boundaryId.length === 0) throw new Error('boundaryId must not be empty');
    const existingBoundaries = this.verifiedBoundaryIds.get(tableId);
    if (existingBoundaries?.has(boundaryId) === true) {
      return { shoe: this.current(tableId), rotated: false };
    }
    const boundaries = existingBoundaries ?? new Set<string>();
    boundaries.add(boundaryId);
    this.verifiedBoundaryIds.set(tableId, boundaries);
    if (this.activePhysicalShoeEpisodes.has(tableId)) {
      return { shoe: this.current(tableId), rotated: false };
    }
    this.activePhysicalShoeEpisodes.add(tableId);
    return { shoe: this.rotateToVerifiedPhysicalShoe(tableId), rotated: true };
  }

  confirmOperatorPhysicalShoe(tableId: string): MstromShoeConfirmation {
    if (this.activePhysicalShoeEpisodes.has(tableId)) {
      return { shoe: this.current(tableId), rotated: false };
    }
    this.activePhysicalShoeEpisodes.add(tableId);
    return { shoe: this.rotateToVerifiedPhysicalShoe(tableId), rotated: true };
  }

  observeOrdinaryShoeActivity(tableId: string): void {
    this.activePhysicalShoeEpisodes.delete(tableId);
  }

  rotateToVerifiedPhysicalShoe(tableId: string): MstromShoeSession {
    const previous = this.current(tableId);
    const next: MstromShoeSession = {
      shoeId: `mstrom-monitor-${this.monitorSessionId}-${tableId}-shoe-${previous.version + 1}`,
      baseline: 'physical-shoe',
      version: previous.version + 1,
    };
    this.tables.set(tableId, next);
    return next;
  }
}
