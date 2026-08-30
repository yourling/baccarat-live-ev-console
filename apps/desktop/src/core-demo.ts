import { SqliteLedger } from '@baccarat/ledger-state';
import { Orchestrator } from '@baccarat/orchestrator';
import { SimulatedAdapter } from '@baccarat/adapter-contract';
import { FixtureBuilder } from '@baccarat/simulator-fixtures';
import { evaluatePairMarket } from '@baccarat/probability';
import {
  defaultProfile,
  defaultRiskLimits,
  CARD_RANKS,
  sha256,
  stableStringify,
  type Card,
  type CardRank,
  type DecisionSnapshot,
  type NormalizedEvent,
  type RiskLimits,
  type TableProfile,
} from '@baccarat/contracts';

export interface TableView {
  tableId: string;
  shoeId: string;
  status: string;
  remainingTotal: number;
  seenCount: number;
  autoBetStatus: string;
  connectionStatus: string;
  modelRevision: string;
  redCardSeen: boolean;
  sealed: boolean;
  ev: { pMean: number; pLower: number; evLower: number };
}

export interface DemoResult {
  seed: number;
  events: NormalizedEvent[];
  eventCount: number;
  decisionCount: number;
  receiptCount: number;
  hash: string;
  tables: TableView[];
  decisions: DecisionSnapshot[];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_SUITS = ['♠', '♥', '♦', '♣'] as const;

function drawCard(deck: Record<CardRank, number>, rand: () => number): Card {
  const suit = DEMO_SUITS[Math.floor(rand() * DEMO_SUITS.length)];
  const total = CARD_RANKS.reduce((sum, r) => sum + deck[r], 0);
  if (total <= 0) throw new Error('demo shoe has no cards left');
  let idx = Math.floor(rand() * total);
  for (const rank of CARD_RANKS) {
    if (idx < deck[rank]) {
      deck[rank] -= 1;
      return { rank, suit };
    }
    idx -= deck[rank];
  }
  throw new Error('demo shoe draw failed');
}

function freshDeck(decks: number): Record<CardRank, number> {
  const deck = { 'A':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0,'8':0,'9':0,'10':0,'J':0,'Q':0,'K':0 } as Record<CardRank, number>;
  for (const r of CARD_RANKS) deck[r] = 4 * decks;
  return deck;
}

export interface BaccaratHand {
  playerCards: Card[];
  bankerCards: Card[];
}

function baccaratCardValue(card: Card): number {
  if (card.rank === 'A') return 1;
  if (card.rank === '10' || card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 0;
  return Number(card.rank);
}

function baccaratTotal(cards: Card[]): number {
  return cards.reduce((sum, card) => sum + baccaratCardValue(card), 0) % 10;
}

function bankerDrawsAfterPlayerThird(bankerTotal: number, playerThirdValue: number): boolean {
  if (bankerTotal <= 2) return true;
  if (bankerTotal === 3) return playerThirdValue !== 8;
  if (bankerTotal === 4) return playerThirdValue >= 2 && playerThirdValue <= 7;
  if (bankerTotal === 5) return playerThirdValue >= 4 && playerThirdValue <= 7;
  if (bankerTotal === 6) return playerThirdValue === 6 || playerThirdValue === 7;
  return false;
}

export function dealBaccaratHand(deck: Record<CardRank, number>, rand: () => number): BaccaratHand {
  const playerCards = [drawCard(deck, rand), drawCard(deck, rand)];
  const bankerCards = [drawCard(deck, rand), drawCard(deck, rand)];
  const playerInitialTotal = baccaratTotal(playerCards);
  const bankerInitialTotal = baccaratTotal(bankerCards);

  // A natural 8 or 9 ends the hand before either side can draw.
  if (playerInitialTotal >= 8 || bankerInitialTotal >= 8) return { playerCards, bankerCards };

  if (playerInitialTotal <= 5) {
    const playerThird = drawCard(deck, rand);
    playerCards.push(playerThird);
    if (bankerDrawsAfterPlayerThird(bankerInitialTotal, baccaratCardValue(playerThird))) {
      bankerCards.push(drawCard(deck, rand));
    }
  } else if (bankerInitialTotal <= 5) {
    bankerCards.push(drawCard(deck, rand));
  }

  return { playerCards, bankerCards };
}

function isPair(cards: Card[]): boolean {
  return cards.length >= 2 && cards[0].rank === cards[1].rank;
}

export interface RandomDemoStream {
  seed: number;
  profiles: [TableProfile, TableProfile];
  streams: Record<string, NormalizedEvent[]>;
}

export function demoProfiles(): [TableProfile, TableProfile] {
  const p1: TableProfile = {
    ...defaultProfile('table-1'),
    autoConfirmNewShoe: true,
    autoBetArmedByDefault: true,
    minEV: 0,
    limits: { minBet: 10, maxBet: 1000 },
    odds: { bankerPair: { netWin: 11, loss: 1 }, playerPair: { netWin: 11, loss: 1 } },
    betStrategy: { type: 'both' },
  };
  const p2: TableProfile = {
    ...defaultProfile('table-2'),
    autoConfirmNewShoe: true,
    autoBetArmedByDefault: true,
    minEV: 0,
    limits: { minBet: 10, maxBet: 500 },
    odds: { bankerPair: { netWin: 11, loss: 1 }, playerPair: { netWin: 11, loss: 1 } },
    betStrategy: { type: 'alternate', start: 'bankerPair' },
  };
  return [p1, p2];
}

export function buildRandomDemo(seed?: number, namespace?: string): RandomDemoStream {
  const actualSeed = seed ?? Math.floor(Math.random() * 0xffffffff);
  const profiles = demoProfiles();
  const streams = {
    [profiles[0].tableId]: buildRandomTable(profiles[0].tableId, profiles[0], actualSeed, namespace),
    [profiles[1].tableId]: buildRandomTable(profiles[1].tableId, profiles[1], actualSeed ^ 0x9e3779b9, namespace),
  };
  return { seed: actualSeed, profiles, streams };
}

export function buildRandomTable(
  tableId: string,
  profile: TableProfile,
  seed: number,
  namespace?: string,
): NormalizedEvent[] {
  const b = new FixtureBuilder(tableId, undefined, namespace ? `${tableId}_${namespace}` : undefined);
  const rand = mulberry32(seed);
  const shoeCount = 1 + Math.floor(rand() * 3);
  for (let shoeIdx = 1; shoeIdx <= shoeCount; shoeIdx++) {
    const deck = freshDeck(profile.numberOfDecks);
    const shoeId = `${namespace ? `${namespace}_` : ``}${tableId}-shoe-${shoeIdx}`;
    b.newShoe(shoeId, profile);
    if (!profile.autoConfirmNewShoe) b.confirmShoe(shoeId, true);
    const totalShoeCards = profile.numberOfDecks * 52;
    // Cut-card signals are restricted to the final fifth of the shoe.
    const redCutPoint = Math.floor(totalShoeCards * (0.80 + rand() * 0.15));
    let cardsUsed = 0;
    let handIdx = 1;
    let redNext = false;
    while (handIdx <= 100 && cardsUsed < totalShoeCards) {
      const handId = `${shoeId}-h${handIdx}`;
      if (redNext) b.redCard(shoeId, handId);
      b.openWindow(shoeId, handId, 'bankerPair');
      if (profile.betStrategy.type !== 'alternate' || profile.betStrategy.start === 'playerPair') {
        b.openWindow(shoeId, handId, 'playerPair');
      }
      const hand = dealBaccaratHand(deck, rand);
      const playerCards = hand.playerCards;
      const bankerCards = hand.bankerCards;
      for (let i = 0; i < playerCards.length; i++) b.card(shoeId, handId, playerCards[i], `player${i + 1}`);
      for (let i = 0; i < bankerCards.length; i++) b.card(shoeId, handId, bankerCards[i], `banker${i + 1}`);
      b.closeWindow(shoeId, handId, 'bankerPair');
      if (profile.betStrategy.type !== 'alternate' || profile.betStrategy.start === 'playerPair') {
        b.closeWindow(shoeId, handId, 'playerPair');
      }
      b.settle(shoeId, handId, playerCards, bankerCards, { bankerPair: isPair(bankerCards), playerPair: isPair(playerCards) });
      cardsUsed += playerCards.length + bankerCards.length;
      handIdx++;
      if (redNext) break;
      if (cardsUsed >= redCutPoint) redNext = true;
    }
  }
  return b.build();
}

export async function runDemo(seed?: number): Promise<DemoResult> {
  const demo = buildRandomDemo(seed);
  const actualSeed = demo.seed;
  const ledger = new SqliteLedger();
  const riskLimits: RiskLimits = {
    ...defaultRiskLimits,
    defaultExposureCap: 100000,
    perTableLossLimit: 100000,
    perShoeLossLimit: 100000,
    perDayLossLimit: 1000000,
    maxConcurrentExecutions: 4,
    insufficientBehavior: 'skip',
  };
  const adapter = new SimulatedAdapter({ events: [] });
  const orch = new Orchestrator({ ledger, riskLimits, executor: adapter });

  const [p1, p2] = demo.profiles;
  orch.registerTable(p1, 'simulated', 100);
  orch.registerTable(p2, 'simulated', 80);

  for (const e of demo.streams[p1.tableId]) orch.enqueue(p1.tableId, e);
  for (const e of demo.streams[p2.tableId]) orch.enqueue(p2.tableId, e);
  await orch.getActor(p1.tableId)?.flush();
  await orch.getActor(p2.tableId)?.flush();

  const allEvents = ledger.listEvents();
  const actors = [orch.getActor(p1.tableId)!, orch.getActor(p2.tableId)!];
  const profiles = [p1, p2];
  const tables: TableView[] = actors.map((a, idx) => {
    const p = a.getProjection();
    const ev = evaluatePairMarket(profiles[idx], 'bankerPair', p.seenCards);
    return {
      tableId: a.tableId,
      shoeId: p.shoeId,
      status: p.status,
      remainingTotal: p.remainingTotal,
      seenCount: p.seenCards.length,
      autoBetStatus: p.autoBetStatus,
      connectionStatus: p.connectionStatus,
      modelRevision: p.modelRevision,
      redCardSeen: p.redCardSeen,
      sealed: p.sealed,
      ev: {
        pMean: ev.pMean,
        pLower: ev.pLower,
        evLower: ev.evLower,
      },
    };
  });

  return {
    seed: actualSeed,
    events: allEvents,
    eventCount: allEvents.length,
    decisionCount: ledger.listDecisions().length,
    receiptCount: ledger.listReceipts().length,
    hash: sha256(stableStringify(allEvents)),
    tables,
    decisions: ledger.listDecisions(),
  };
}
