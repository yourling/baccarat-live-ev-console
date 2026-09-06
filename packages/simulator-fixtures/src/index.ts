import {
  EVENT_SCHEMA_VERSION,
  type Card,
  type HandSettledEvent,
  type NormalizedEvent,
  type ShoeBaseline,
  type TableProfile,
} from '@baccarat/contracts';

export interface FixtureBuilder {
  events: NormalizedEvent[];
  seq: number;
}

/** 两张牌同 rank 即为对子;与桌面演示 core-demo.ts 的 isPair 语义一致。 */
export function isPair(cards: Card[]): boolean {
  return cards.length >= 2 && cards[0].rank === cards[1].rank;
}

export class FixtureBuilder {
  events: NormalizedEvent[] = [];
  seq = 1;

  constructor(
    private readonly tableId: string,
    private readonly baseTime = '2025-01-01T00:00:00.000Z',
    private readonly eventIdNamespace?: string,
  ) {}

  private nextTimestamp(): string {
    return new Date(Date.parse(this.baseTime) + this.seq * 1000).toISOString();
  }

  private add(type: string, payload: Record<string, unknown>): this {
    const timestamp = this.nextTimestamp();
    const event: Record<string, unknown> = {
      eventId: `ev_${this.eventIdNamespace ?? this.tableId}_${this.seq}`,
      tableId: this.tableId,
      timestamp,
      sourceSeq: this.seq,
      source: 'simulator-fixtures',
      schemaVersion: EVENT_SCHEMA_VERSION,
      type,
      ...payload,
    };
    if (type === 'bettingWindowOpened' && typeof event.closesAt !== 'string') {
      event.closesAt = new Date(Date.parse(timestamp) + 10_000).toISOString();
    }
    this.events.push(event as unknown as NormalizedEvent);
    this.seq += 1;
    return this;
  }

  newShoe(shoeId: string, profile: TableProfile, baseline: ShoeBaseline = 'physical-shoe'): this {
    return this.add('newShoeSignal', { shoeId, profile, baseline });
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
    // 单一事实源:未显式给 outcomes 时由牌面派生,杜绝"牌面与结算自相矛盾"的伪地面真值。
    const resolved = outcomes ?? { bankerPair: isPair(bankerCards), playerPair: isPair(playerCards) };
    return this.add('handSettled', { shoeId, handId, playerCards, bankerCards, outcomes: resolved });
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
      b.settle(shoeId, handId, pc, bc);
    }
  }
  return b.build();
}
