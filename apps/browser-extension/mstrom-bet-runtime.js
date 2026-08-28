if (typeof chrome === 'undefined' || !chrome || !chrome.scripting) {
  // The page world intentionally receives no runtime exports.
} else {
function probeMstromBetStore(tableId) {
  const PLAY_TYPES = Object.freeze({ banker: 1, player: 2, bankerPair: 4, playerPair: 5 });
  const RUNTIME_REVISION = 'mstrom-bet-runtime/2026-08-28.1';

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function validTableId(value) {
    return typeof value === 'string' && /^[A-Z]\d{3}$/.test(value);
  }

  function diagnosticKeys(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return [];
    const keys = [];
    let cursor = value;
    for (let depth = 0; cursor && depth < 3 && keys.length < 40; depth += 1) {
      try {
        for (const key of Object.getOwnPropertyNames(cursor)) {
          if (!/bet|store|table|link|game/i.test(key) || keys.includes(key)) continue;
          keys.push(key);
          if (keys.length >= 40) break;
        }
        cursor = Object.getPrototypeOf(cursor);
      } catch (_) {
        break;
      }
    }
    return keys;
  }

  function frameInfo() {
    try {
      const pageLocation = globalThis.location || {};
      return {
        frameUrl: String(pageLocation.href || ''),
        host: String(pageLocation.hostname || ''),
      };
    } catch (_) {
      return { frameUrl: '', host: '' };
    }
  }

  function getStore(targetTableId) {
    if (!validTableId(targetTableId)) return null;
    try {
      const core = globalThis.VideoGameCore;
      const factory = core && core.LinkStoreFactory && core.LinkStoreFactory.instance;
      return factory && typeof factory.getBetTableStore === 'function'
        ? factory.getBetTableStore(targetTableId) || null
        : null;
    } catch (_) {
      return null;
    }
  }

  function readStoreValue(store, key) {
    try {
      return store ? store[key] : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function stakeRows(pool) {
    try {
      if (!pool || typeof pool.getAllStakeData !== 'function') return [];
      const rows = pool.getAllStakeData();
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return null;
    }
  }

  function diffPending(diffPool) {
    if (!diffPool) return true;
    try {
      if (diffPool.pending === true) return true;
      const rows = stakeRows(diffPool);
      return rows === null || rows.some(row => row && row.pending === true);
    } catch (_) {
      return true;
    }
  }

  function optionalBalance(store) {
    try {
      const value = store && typeof store.getBalance === 'function'
        ? store.getBalance()
        : store && store.balance !== undefined
          ? store.balance
          : store && store.userInfo
            ? store.userInfo.balance
            : undefined;
      return finiteNumber(Number(value));
    } catch (_) {
      return null;
    }
  }

  function optionalLimit(store, playType) {
    if (!store || typeof store.getBetLimitByPlayType !== 'function') return null;
    try {
      const raw = store.getBetLimitByPlayType(playType);
      if (!isObject(raw)) return null;
      const min = raw.min === undefined ? null : finiteNumber(Number(raw.min));
      const max = raw.max === undefined ? null : finiteNumber(Number(raw.max));
      return raw.min !== undefined && min === null || raw.max !== undefined && max === null
        ? { invalid: true }
        : { min, max, invalid: false };
    } catch (_) {
      return { invalid: true };
    }
  }

  const locationInfo = frameInfo();
  const store = getStore(tableId);
  const core = globalThis.VideoGameCore;
  const linkFactory = core && core.LinkStoreFactory && core.LinkStoreFactory.instance;
  const gameLinkStore = core && core.GameLinkStore && core.GameLinkStore.instance;
  let disabledPlayTypes = null;
  if (store && typeof store.getDisablePlayTypes === 'function') {
    try {
      const disabled = store.getDisablePlayTypes();
      disabledPlayTypes = Array.isArray(disabled) ? disabled : null;
    } catch (_) {
      disabledPlayTypes = null;
    }
  }
  const stakePool = store ? readStoreValue(store, 'stakePool') : null;
  return {
    runtimeRevision: RUNTIME_REVISION,
    frameUrl: locationInfo.frameUrl,
    host: locationInfo.host,
    tableId: String(tableId || ''),
    ownsTargetStore: Boolean(store),
    gmcode: store ? (readStoreValue(store, 'gmcode') ?? null) : null,
    betEnabled: store ? readStoreValue(store, 'betEnabled') === true : false,
    diffPending: store ? diffPending(readStoreValue(store, 'diffPool')) : null,
    balance: store ? optionalBalance(store) : null,
    disabledPlayTypes,
    limits: store ? {
      banker: optionalLimit(store, PLAY_TYPES.banker),
      player: optionalLimit(store, PLAY_TYPES.player),
      bankerPair: optionalLimit(store, PLAY_TYPES.bankerPair),
      playerPair: optionalLimit(store, PLAY_TYPES.playerPair),
    } : null,
    hasAddChip: Boolean(store && typeof store.addChipByPlayType === 'function'),
    hasConfirm: Boolean(store && typeof store.confirmBet === 'function'),
    hasCalculateDiff: Boolean(stakePool && typeof stakePool.calculateDiff === 'function'),
    diagnostics: {
      corePresent: Boolean(core),
      coreKeys: diagnosticKeys(core),
      linkFactoryPresent: Boolean(linkFactory),
      linkFactoryKeys: diagnosticKeys(linkFactory),
      gameLinkStorePresent: Boolean(gameLinkStore),
      gameLinkStoreKeys: diagnosticKeys(gameLinkStore),
    },
  };
}

async function executeMstromBetOneShot(request) {
  const PLAY_TYPES = Object.freeze({ banker: 1, player: 2, bankerPair: 4, playerPair: 5 });
  const RUNTIME_REVISION = 'mstrom-bet-runtime/2026-08-28.1';
  const POLL_INTERVAL_MS = 50;
  const REQUEST_TIMEOUT_MS = 5000;
  const COMMIT_POINT = 'confirmBet';
  let commitStarted = false;

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function validTableId(value) {
    return typeof value === 'string' && /^[A-Z]\d{3}$/.test(value);
  }

  function getStore(tableId) {
    if (!validTableId(tableId)) return null;
    try {
      const core = globalThis.VideoGameCore;
      const factory = core && core.LinkStoreFactory && core.LinkStoreFactory.instance;
      return factory && typeof factory.getBetTableStore === 'function'
        ? factory.getBetTableStore(tableId) || null
        : null;
    } catch (_) {
      return null;
    }
  }

  function readStoreValue(store, key) {
    try {
      return store ? store[key] : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function readPoolAmount(pool, playType) {
    try {
      if (!pool || typeof pool.getAmount !== 'function') return null;
      return finiteNumber(Number(pool.getAmount(playType)));
    } catch (_) {
      return null;
    }
  }

  function stakeRows(pool) {
    try {
      if (!pool || typeof pool.getAllStakeData !== 'function') return [];
      const rows = pool.getAllStakeData();
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return null;
    }
  }

  function diffPending(diffPool) {
    if (!diffPool) return true;
    try {
      if (diffPool.pending === true) return true;
      const rows = stakeRows(diffPool);
      return rows === null || rows.some(row => row && row.pending === true);
    } catch (_) {
      return true;
    }
  }

  function historyPlayTypes(parsed) {
    const playTypes = [parsed.playType];
    if (parsed.market !== 'banker') return playTypes;
    try {
      const noCommission = finiteNumber(Number(globalThis.VideoGameCore && globalThis.VideoGameCore.PLAYTYPE_BANKER_NO_COMMISSION));
      if (noCommission !== null && !playTypes.includes(noCommission)) playTypes.push(noCommission);
    } catch (_) {
      return playTypes;
    }
    return playTypes;
  }

  function readHistoryAmount(parsed) {
    try {
      const core = globalThis.VideoGameCore;
      const historyStore = core && core.MultiBetHistoryStore && core.MultiBetHistoryStore.instance;
      if (!historyStore || !Array.isArray(historyStore.dataList)) return null;
      const playTypes = historyPlayTypes(parsed);
      let total = 0;
      for (const row of historyStore.dataList) {
        if (
          !row
          || row.vid !== parsed.tableId
          || row.gmcode !== parsed.handId
          || !playTypes.includes(Number(row.playType))
        ) {
          continue;
        }
        const amount = finiteNumber(Number(row.betAmount));
        if (amount === null || amount < 0) return null;
        total += amount;
      }
      return total;
    } catch (_) {
      return null;
    }
  }

  function optionalBalance(store) {
    try {
      const value = store && typeof store.getBalance === 'function'
        ? store.getBalance()
        : store && store.balance !== undefined
          ? store.balance
          : store && store.userInfo
            ? store.userInfo.balance
            : undefined;
      return finiteNumber(Number(value));
    } catch (_) {
      return null;
    }
  }

  function optionalLimit(store, playType) {
    if (!store || typeof store.getBetLimitByPlayType !== 'function') return null;
    try {
      const raw = store.getBetLimitByPlayType(playType);
      if (!isObject(raw)) return null;
      const min = raw.min === undefined ? null : finiteNumber(Number(raw.min));
      const max = raw.max === undefined ? null : finiteNumber(Number(raw.max));
      return raw.min !== undefined && min === null || raw.max !== undefined && max === null
        ? { invalid: true }
        : { min, max, invalid: false };
    } catch (_) {
      return { invalid: true };
    }
  }

  function normalizedAmount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return String(value);
  }

  function parseRequest(value) {
    if (!isObject(value) || value.mode !== 'live') return null;
    if (isObject(value.intent)) {
      const intent = value.intent;
      if (intent.mode !== 'live') return null;
      if (
        !validTableId(intent.tableId)
        || typeof intent.shoeId !== 'string'
        || intent.shoeId.trim().length === 0
        || typeof intent.handId !== 'string'
        || intent.handId.length === 0
      ) {
        return null;
      }
      if (intent.market !== 'bankerPair' && intent.market !== 'playerPair') return null;
      if (normalizedAmount(intent.amount) === null) return null;
      if (typeof intent.idempotencyKey !== 'string' || intent.idempotencyKey.trim().length === 0) {
        return null;
      }
      return {
        kind: 'pair',
        request: value,
        intent,
        tableId: intent.tableId,
        shoeId: intent.shoeId,
        handId: intent.handId,
        market: intent.market,
        playType: PLAY_TYPES[intent.market],
        amount: intent.amount,
      };
    }
    if (!isObject(value.wager)) return null;
    const wager = value.wager;
    if (
      !validTableId(wager.tableId)
      || typeof wager.shoeId !== 'string'
      || wager.shoeId.trim().length === 0
      || typeof wager.handId !== 'string'
      || wager.handId.length === 0
      || typeof wager.wagerId !== 'string'
      || wager.wagerId.trim().length === 0
      || (wager.market !== 'banker' && wager.market !== 'player' && wager.market !== 'bankerPair' && wager.market !== 'playerPair')
      || (wager.source !== 'manual' && wager.source !== 'keepalive')
      || normalizedAmount(wager.amount) === null
    ) {
      return null;
    }
    return {
      kind: 'operational',
      request: value,
      wager,
      tableId: wager.tableId,
      shoeId: wager.shoeId,
      handId: wager.handId,
      market: wager.market,
      playType: PLAY_TYPES[wager.market],
      amount: wager.amount,
    };
  }

  function makeReceipt(parsed, status, raw) {
    const revisionedRaw = { runtimeRevision: RUNTIME_REVISION, ...raw };
    const createdAt = new Date().toISOString();
    if (parsed.kind === 'operational') {
      return {
        receiptId: `mstrom-operational-${parsed.wager.wagerId}-${Date.now()}`,
        wagerId: parsed.wager.wagerId,
        tableId: parsed.tableId,
        shoeId: parsed.shoeId,
        handId: parsed.handId,
        market: parsed.market,
        amount: parsed.amount,
        source: parsed.wager.source,
        status,
        externalRef: `mstrom:${parsed.tableId}:${parsed.handId}:${parsed.playType}`,
        createdAt,
        raw: revisionedRaw,
      };
    }
    return {
      receiptId: `mstrom-${String(parsed.intent.intentId || 'intent')}-${Date.now()}`,
      intentId: String(parsed.intent.intentId || ''),
      reservationId: String(parsed.request.reservationId || ''),
      status,
      amount: parsed.amount,
      market: parsed.market,
      mode: 'live',
      externalRef: `mstrom:${parsed.tableId}:${parsed.handId}:${parsed.playType}`,
      createdAt,
      raw: revisionedRaw,
    };
  }

  function rejected(parsed, reason, raw = {}) {
    return makeReceipt(parsed, 'REJECTED', {
      reason,
      tableId: parsed.tableId,
      playType: parsed.playType,
      commitStarted: false,
      ...raw,
    });
  }

  function unknown(parsed, reason, diagnostics = {}) {
    return makeReceipt(parsed, 'UNKNOWN', {
      reason,
      tableId: parsed.tableId,
      playType: parsed.playType,
      commitPoint: commitStarted ? COMMIT_POINT : null,
      commitStarted,
      ...diagnostics,
    });
  }

  function accepted(parsed, acknowledgement) {
    return makeReceipt(parsed, 'ACCEPTED', {
      tableId: parsed.tableId,
      playType: parsed.playType,
      commitPoint: COMMIT_POINT,
      commitStarted: true,
      acknowledgement,
    });
  }

  function restoreStake(store, stakePool, playType, amount) {
    if (commitStarted) return;
    try {
      if (typeof stakePool.setAmount === 'function') stakePool.setAmount(playType, amount);
      else if (typeof store.cancelBet === 'function') store.cancelBet(false);
    } catch (_) {
      return;
    }
  }

  function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  async function run(parsed) {
    const store = getStore(parsed.tableId);
    if (!store) return null;
    const vid = readStoreValue(store, 'vid');
    if (vid !== undefined && vid !== null && vid !== parsed.tableId) return rejected(parsed, 'store-vid-mismatch');
    if (readStoreValue(store, 'gmcode') !== parsed.handId) return rejected(parsed, 'hand-mismatch');
    if (readStoreValue(store, 'betEnabled') !== true) return rejected(parsed, 'betting-disabled');

    const stakePool = readStoreValue(store, 'stakePool');
    const donePool = readStoreValue(store, 'donePool');
    const diffPool = readStoreValue(store, 'diffPool');
    if (!stakePool || !donePool || !diffPool || diffPending(diffPool)) {
      return rejected(parsed, 'bet-diff-pending');
    }
    if (typeof store.getDisablePlayTypes === 'function') {
      let disabled;
      try {
        disabled = store.getDisablePlayTypes();
      } catch (_) {
        return rejected(parsed, 'disabled-playtypes-unreadable');
      }
      if (Array.isArray(disabled) && disabled.includes(parsed.playType)) {
        return rejected(parsed, 'playtype-disabled');
      }
    }

    const beforeStake = readPoolAmount(stakePool, parsed.playType);
    const beforeDone = readPoolAmount(donePool, parsed.playType);
    const beforeHistory = readHistoryAmount(parsed);
    if (beforeStake === null || beforeDone === null || typeof stakePool.calculateDiff !== 'function') {
      return rejected(parsed, 'pool-state-unreadable');
    }
    let diff;
    try {
      diff = stakePool.calculateDiff(donePool);
    } catch (_) {
      return rejected(parsed, 'stake-diff-unreadable');
    }
    if (!diff || finiteNumber(Number(diff.totalAmount)) !== 0) {
      return rejected(parsed, 'unconfirmed-stake-present');
    }

    const balance = optionalBalance(store);
    if (balance !== null && parsed.amount > balance) return rejected(parsed, 'insufficient-balance');
    const limit = optionalLimit(store, parsed.playType);
    if (limit && limit.invalid) return rejected(parsed, 'bet-limit-unreadable');
    const finalStake = beforeStake + parsed.amount;
    if (limit && limit.min !== null && finalStake < limit.min) {
      return rejected(parsed, 'below-platform-minimum');
    }
    if (limit && limit.max !== null && finalStake > limit.max) {
      return rejected(parsed, 'above-platform-maximum');
    }
    if (typeof store.confirmBet !== 'function') return rejected(parsed, 'confirm-unavailable');

    try {
      if (typeof store.addChipByPlayType === 'function') {
        store.addChipByPlayType(parsed.playType, parsed.amount);
      } else if (typeof stakePool.setAmount === 'function') {
        stakePool.setAmount(parsed.playType, finalStake);
      } else {
        return rejected(parsed, 'add-chip-unavailable');
      }
    } catch (_) {
      restoreStake(store, stakePool, parsed.playType, beforeStake);
      return rejected(parsed, 'add-chip-failed');
    }

    const afterStake = readPoolAmount(stakePool, parsed.playType);
    if (afterStake === null || afterStake - beforeStake !== parsed.amount) {
      restoreStake(store, stakePool, parsed.playType, beforeStake);
      return rejected(parsed, 'add-chip-delta-mismatch');
    }
    if (
      readStoreValue(store, 'betEnabled') !== true
      || diffPending(diffPool)
      || readStoreValue(store, 'gmcode') !== parsed.handId
    ) {
      restoreStake(store, stakePool, parsed.playType, beforeStake);
      return rejected(parsed, 'pre-confirm-state-changed');
    }

    try {
      // COMMIT_POINT: once this call begins, the platform may have accepted the bet.
      commitStarted = true;
      const confirmation = store.confirmBet();
      await confirmation;
    } catch (_) {
      // pcv2 exposes donePool as a getter and replaces diffPool in confirmBet().
      // Always re-read both pools after the commit point.
      const doneAfterError = readPoolAmount(readStoreValue(store, 'donePool'), parsed.playType);
      if (doneAfterError !== null && doneAfterError - beforeDone >= parsed.amount) {
        return accepted(parsed, 'done-pool');
      }
      const historyAfterError = readHistoryAmount(parsed);
      if (
        beforeHistory !== null
        && historyAfterError !== null
        && historyAfterError - beforeHistory >= parsed.amount
      ) {
        return accepted(parsed, 'bet-history');
      }
      return unknown(parsed, 'confirm-failed-uncertain', {
        beforeDone,
        observedDone: doneAfterError,
        beforeHistory,
        observedHistory: historyAfterError,
      });
    }

    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    let observedDone = beforeDone;
    let observedHistory = beforeHistory;
    while (Date.now() < deadline) {
      const doneAmount = readPoolAmount(readStoreValue(store, 'donePool'), parsed.playType);
      observedDone = doneAmount;
      if (doneAmount !== null && doneAmount - beforeDone >= parsed.amount) {
        return accepted(parsed, 'done-pool');
      }
      const historyAmount = readHistoryAmount(parsed);
      observedHistory = historyAmount;
      if (
        beforeHistory !== null
        && historyAmount !== null
        && historyAmount - beforeHistory >= parsed.amount
      ) {
        return accepted(parsed, 'bet-history');
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
    const observedStake = readPoolAmount(readStoreValue(store, 'stakePool'), parsed.playType);
    return unknown(parsed, 'result-timeout', {
      beforeDone,
      observedDone,
      beforeHistory,
      observedHistory,
      observedStake,
    });
  }

  const parsed = parseRequest(request);
  if (!parsed) return null;
  try {
    return await run(parsed);
  } catch (_) {
    return commitStarted
      ? unknown(parsed, 'runtime-failed')
      : rejected(parsed, 'runtime-failed-before-commit');
  }
}

  globalThis.probeMstromBetStore = probeMstromBetStore;
  globalThis.executeMstromBetOneShot = executeMstromBetOneShot;
}
