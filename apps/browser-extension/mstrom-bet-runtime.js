if (typeof chrome === 'undefined' || !chrome || !chrome.scripting) {
  // The page world intentionally receives no runtime exports.
} else {
function probeMstromBetStore(tableId) {
  const PLAY_TYPES = Object.freeze({ banker: 1, player: 2, bankerPair: 4, playerPair: 5 });

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function validTableId(value) {
    return typeof value === 'string' && /^[A-Z]\d{3}$/.test(value);
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
  };
}

async function executeMstromBetOneShot(request) {
  const PLAY_TYPES = Object.freeze({ banker: 1, player: 2, bankerPair: 4, playerPair: 5 });
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

  function explicitFailure(diffPool, playType) {
    const rows = stakeRows(diffPool);
    const row = rows && rows.find(item => item && item.playType === playType);
    if (row && row.pending === false && row.success === false) {
      const rowAmount = finiteNumber(Number(row.amount));
      if (rowAmount === null || rowAmount > 0) return true;
    }
    try {
      return diffPool && diffPool.pending === false && diffPool.success === false
        && finiteNumber(Number(diffPool.totalAmount)) !== null
        && Number(diffPool.totalAmount) > 0;
    } catch (_) {
      return false;
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
        raw,
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
      raw,
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

  function committedRejected(parsed, reason) {
    return rejected(parsed, reason, {
      commitPoint: COMMIT_POINT,
      commitStarted: true,
    });
  }

  function unknown(parsed, reason) {
    return makeReceipt(parsed, 'UNKNOWN', {
      reason,
      tableId: parsed.tableId,
      playType: parsed.playType,
      commitPoint: commitStarted ? COMMIT_POINT : null,
      commitStarted,
    });
  }

  function accepted(parsed) {
    return makeReceipt(parsed, 'ACCEPTED', {
      tableId: parsed.tableId,
      playType: parsed.playType,
      commitPoint: COMMIT_POINT,
      commitStarted: true,
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
      await store.confirmBet();
    } catch (_) {
      const doneAfterError = readPoolAmount(donePool, parsed.playType);
      if (doneAfterError !== null && doneAfterError - beforeDone >= parsed.amount) {
        return accepted(parsed);
      }
      if (explicitFailure(diffPool, parsed.playType)) {
        return committedRejected(parsed, 'platform-rejected');
      }
      return unknown(parsed, 'confirm-failed-uncertain');
    }

    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const doneAmount = readPoolAmount(donePool, parsed.playType);
      if (doneAmount !== null && doneAmount - beforeDone >= parsed.amount) {
        return accepted(parsed);
      }
      if (explicitFailure(diffPool, parsed.playType)) {
        return committedRejected(parsed, 'platform-rejected');
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
    return unknown(parsed, 'result-timeout');
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
