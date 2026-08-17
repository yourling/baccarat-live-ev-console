import type {
  Card,
  HandSettledEvent,
  NormalizedEvent,
  TableProfile,
} from '@baccarat/contracts';

export interface FixtureBuilder {
  events: NormalizedEvent[];
  seq: number;
}

export class FixtureBuilder {
  events: NormalizedEvent[] = [];
  seq = 1;

  constructor(private readonly tableId: string, private readonly baseTime = '2025-01-01T00:00:00.000Z') {}

  private nextTimestamp(): string {
    return new Date(Date.parse(this.baseTime) + this.seq * 1000).toISOString();
  }

  private add(type: string, payload: Record<string, unknown>): this {
    this.events.push({
      eventId: `ev_${this.tableId}_${this.seq}`,
      tableId: this.tableId,
      timestamp: this.nextTimestamp(),
      sourceSeq: this.seq,
      type,
      ...payload,
    } as unknown as NormalizedEvent);
    this.seq += 1;
    return this;
  }

  newShoe(shoeId: string, profile: TableProfile): this {
    return this.add('newShoeSignal', { shoeId, profile });
  }

  confirmShoe(shoeId: string, approved = true): this {
    return this.add('shoeConfirmation', { shoeId, approved });
  }

  openWindow(shoeId: string, handId: string, market: 'bankerPair' | 'playerPair'): this {
    return this.add('bettingWindowOpened', { shoeId, handId, market });
  }

  closeWindow(shoeId: string, handId: string, market: 'bankerPair' | 'playerPair'): this {
    return this.add('bettingWindowClosed', { shoeId, handId, market });
  }

  card(shoeId: string, handId: string, card: Card, position?: string): this {
    return this.add('cardObserved', { shoeId, handId, card, position });
  }

  redCard(shoeId: string, handId: string | null): this {
    return this.add('redCardSeen', { shoeId, handId });
  }

  settle(
    shoeId: string,
    handId: string,
    playerCards: Card[],
    bankerCards: Card[],
    outcomes?: { bankerPair: boolean; playerPair: boolean },
  ): this {
    return this.add('handSettled', { shoeId, handId, playerCards, bankerCards, outcomes });
  }

  build(): NormalizedEvent[] {
    return this.events;
  }
}

export function pairMarketStream(
  tableId: string,
  profile: TableProfile,
  options: { shoeCount?: number; handsPerShoe?: number; redCardOnHand?: number } = {},
): NormalizedEvent[] {
  const { shoeCount = 1, handsPerShoe = 2, redCardOnHand } = options;
  const b = new FixtureBuilder(tableId);
  for (let shoe = 1; shoe <= shoeCount; shoe++) {
    const shoeId = `shoe-${tableId}-${shoe}`;
    b.newShoe(shoeId, profile);
    if (!profile.autoConfirmNewShoe) b.confirmShoe(shoeId, true);
    for (let hand = 1; hand <= handsPerShoe; hand++) {
      const handId = `${shoeId}-h${hand}`;
      if (redCardOnHand === hand) b.redCard(shoeId, handId);
      b.openWindow(shoeId, handId, 'bankerPair');
      b.openWindow(shoeId, handId, 'playerPair');
      const pc = hand % 2 === 0 ? [{ rank: 'A' }, { rank: 'A' }] as Card[] : [{ rank: 'K' }, { rank: 'Q' }] as Card[];
      const bc = hand % 2 === 0 ? [{ rank: '10' }, { rank: 'J' }] as Card[] : [{ rank: 'A' }, { rank: 'K' }] as Card[];
      for (const c of pc) b.card(shoeId, handId, c, `player${pc.indexOf(c)+1}`);
      for (const c of bc) b.card(shoeId, handId, c, `banker${bc.indexOf(c)+1}`);
      b.closeWindow(shoeId, handId, 'bankerPair');
      b.closeWindow(shoeId, handId, 'playerPair');
      b.settle(shoeId, handId, pc, bc, { bankerPair: hand % 2 === 0, playerPair: hand % 2 === 1 });
    }
  }
  return b.build();
}
