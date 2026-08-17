import {
  BETTING_MARKETS,
  CARD_RANKS,
  type BettingMarket,
  type BurnModel,
  type Card,
  type CardRank,
  type NormalizedEvent,
  type RiskLimits,
  type TableProfile,
} from './index.js';

export class ContractValidationError extends Error {
  constructor(message: string, readonly field?: string) {
    super(field ? `${message} (field: ${field})` : message);
    this.name = 'ContractValidationError';
  }
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractValidationError(`expected a finite number`, field);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  const n = finiteNumber(value, field);
  if (n < 0) throw new ContractValidationError(`expected a non-negative number`, field);
  return n;
}

function positiveNumber(value: unknown, field: string): number {
  const n = finiteNumber(value, field);
  if (n <= 0) throw new ContractValidationError(`expected a positive number`, field);
  return n;
}

function optionalNonNegativeInteger(value: unknown, field: string): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ContractValidationError(`expected a non-negative integer`, field);
  }
}

export function assertValidCard(card: Card, field = 'card'): void {
  if (!card || typeof card !== 'object') throw new ContractValidationError('expected a card object', field);
  if (!CARD_RANKS.includes(card.rank as CardRank)) {
    throw new ContractValidationError(`unknown card rank: ${String(card.rank)}`, `${field}.rank`);
  }
}

export function assertValidBurnModel(model: BurnModel, field = 'burnModel'): void {
  if (!model || typeof model !== 'object') throw new ContractValidationError('expected a burn model', field);
  if (!['unknown', 'countKnown', 'partialKnown', 'fullyKnown'].includes(model.kind)) {
    throw new ContractValidationError(`unknown burn model kind: ${String(model.kind)}`, `${field}.kind`);
  }
  optionalNonNegativeInteger(model.count, `${field}.count`);
  if (model.knownCards) {
    if (!Array.isArray(model.knownCards)) throw new ContractValidationError('knownCards must be an array', `${field}.knownCards`);
    model.knownCards.forEach((c, i) => assertValidCard(c, `${field}.knownCards[${i}]`));
  }
  if (model.kind === 'partialKnown' && model.knownCards && model.count !== null && model.count !== undefined && model.knownCards.length > model.count) {
    throw new ContractValidationError('known burn cards cannot exceed total burn count', `${field}.knownCards`);
  }
}

export function assertValidTableProfile(profile: TableProfile, field = 'profile'): void {
  if (!profile || typeof profile !== 'object') throw new ContractValidationError('expected a profile object', field);
  if (!profile.tableId || typeof profile.tableId !== 'string') {
    throw new ContractValidationError('tableId must be a non-empty string', `${field}.tableId`);
  }
  if (!Number.isInteger(profile.numberOfDecks) || profile.numberOfDecks <= 0 || profile.numberOfDecks > 20) {
    throw new ContractValidationError('numberOfDecks must be an integer in 1..20', `${field}.numberOfDecks`);
  }
  if (!profile.pairRule || profile.pairRule.kind !== 'standard') {
    throw new ContractValidationError('unsupported pair rule', `${field}.pairRule`);
  }
  for (const market of BETTING_MARKETS) {
    const odds = profile.odds?.[market];
    if (!odds) throw new ContractValidationError(`missing odds for ${market}`, `${field}.odds`);
    positiveNumber(odds.netWin, `${field}.odds.${market}.netWin`);
    positiveNumber(odds.loss, `${field}.odds.${market}.loss`);
  }
  assertValidBurnModel(profile.burnModel, `${field}.burnModel`);
  finiteNumber(profile.minEV, `${field}.minEV`);
  nonNegativeNumber(profile.limits.minBet, `${field}.limits.minBet`);
  positiveNumber(profile.limits.maxBet, `${field}.limits.maxBet`);
  if (profile.limits.minBet > profile.limits.maxBet) {
    throw new ContractValidationError('minBet cannot exceed maxBet', `${field}.limits`);
  }
  if (!profile.betStrategy || typeof profile.betStrategy !== 'object') {
    throw new ContractValidationError('betStrategy is required', `${field}.betStrategy`);
  }
  const strategy = profile.betStrategy;
  switch (strategy.type) {
    case 'both':
      break;
    case 'random':
      break;
    case 'fixed':
      if (!BETTING_MARKETS.includes(strategy.market as BettingMarket)) {
        throw new ContractValidationError('fixed strategy has invalid market', `${field}.betStrategy.market`);
      }
      break;
    case 'alternate':
      if (!BETTING_MARKETS.includes(strategy.start as BettingMarket)) {
        throw new ContractValidationError('alternate strategy has invalid start market', `${field}.betStrategy.start`);
      }
      break;
    default:
      throw new ContractValidationError(`unknown bet strategy: ${String((strategy as { type?: unknown }).type)}`, `${field}.betStrategy.type`);
  }
}

export function assertValidRiskLimits(limits: RiskLimits, field = 'riskLimits'): void {
  if (!limits || typeof limits !== 'object') throw new ContractValidationError('expected risk limits', field);
  nonNegativeNumber(limits.defaultExposureCap, `${field}.defaultExposureCap`);
  nonNegativeNumber(limits.perTableLossLimit, `${field}.perTableLossLimit`);
  nonNegativeNumber(limits.perShoeLossLimit, `${field}.perShoeLossLimit`);
  nonNegativeNumber(limits.perDayLossLimit, `${field}.perDayLossLimit`);
  if (!Number.isInteger(limits.maxConcurrentExecutions) || limits.maxConcurrentExecutions < 0) {
    throw new ContractValidationError('maxConcurrentExecutions must be a non-negative integer', `${field}.maxConcurrentExecutions`);
  }
  if (limits.insufficientBehavior !== 'skip' && limits.insufficientBehavior !== 'shrink') {
    throw new ContractValidationError('insufficientBehavior must be skip or shrink', `${field}.insufficientBehavior`);
  }
}

const EVENT_TYPES = new Set([
  'newShoeSignal',
  'shoeConfirmation',
  'cardObserved',
  'bettingWindowOpened',
  'bettingWindowClosed',
  'handSettled',
  'redCardSeen',
  'burnModelUpdated',
  'connectionLost',
  'connectionRestored',
  'betReceipt',
  'shoeInvalidated',
  'manualCorrection',
  'autoArmChanged',
  'autoDisarmChanged',
]);

export function assertValidEventEnvelope(event: NormalizedEvent): void {
  if (!event || typeof event !== 'object') throw new ContractValidationError('event is not an object');
  if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) {
    throw new ContractValidationError(`unknown or missing event type: ${String(event.type)}`);
  }
  if (!event.eventId || typeof event.eventId !== 'string') throw new ContractValidationError('eventId required');
  if (!event.tableId || typeof event.tableId !== 'string') throw new ContractValidationError('tableId required');
  if (typeof event.sourceSeq !== 'number' || !Number.isInteger(event.sourceSeq) || event.sourceSeq < 0) {
    throw new ContractValidationError('sourceSeq must be a non-negative integer');
  }
  if (typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) {
    throw new ContractValidationError('timestamp must be a parseable date string');
  }
  if (event.schemaVersion !== undefined && event.schemaVersion !== 1) {
    throw new ContractValidationError(`unsupported event schema version: ${event.schemaVersion}`);
  }
}
