import type { Card, NormalizedEvent } from '@baccarat/contracts';

export type VisibleHandCards = {
  readonly source: 'current' | 'previous-settled' | 'none';
  readonly handId: string | null;
  readonly player: readonly Card[];
  readonly banker: readonly Card[];
};

export function resolveVisibleHandCards(
  events: readonly NormalizedEvent[],
  tableId: string,
  shoeId: string | null,
  currentHandId: string | null,
): VisibleHandCards {
  const current = cardsForHand(events, tableId, currentHandId);
  if (current.player.length > 0 || current.banker.length > 0) {
    return { source: 'current', handId: currentHandId, ...current };
  }

  const settled = latestSettledHand(events, tableId, shoeId);
  if (settled) return settled;

  return { source: 'none', handId: currentHandId, player: [], banker: [] };
}

function cardsForHand(
  events: readonly NormalizedEvent[],
  tableId: string,
  handId: string | null,
): { readonly player: readonly Card[]; readonly banker: readonly Card[] } {
  if (!handId) return { player: [], banker: [] };

  const player: Card[] = [];
  const banker: Card[] = [];
  for (const event of events) {
    if (event.tableId !== tableId) continue;
    if (event.type === 'cardObserved') {
      if (event.handId !== handId) continue;
      const position = (event.position ?? '').toLowerCase();
      if (position.startsWith('player')) player.push({ ...event.card });
      if (position.startsWith('banker')) banker.push({ ...event.card });
      continue;
    }
    if (event.type === 'handSettled') {
      if (event.handId !== handId) continue;
      return {
        player: cloneCards(event.playerCards),
        banker: cloneCards(event.bankerCards),
      };
    }
  }
  return { player, banker };
}

function latestSettledHand(
  events: readonly NormalizedEvent[],
  tableId: string,
  shoeId: string | null,
): VisibleHandCards | null {
  if (!shoeId) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'handSettled' || event.tableId !== tableId || event.shoeId !== shoeId) continue;
    return {
      source: 'previous-settled',
      handId: event.handId,
      player: cloneCards(event.playerCards),
      banker: cloneCards(event.bankerCards),
    };
  }
  return null;
}

function cloneCards(cards: readonly Card[]): readonly Card[] {
  return cards.map(card => ({ ...card }));
}