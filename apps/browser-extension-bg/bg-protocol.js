/**
 * Big Gaming live-wire codec (MAIN world).
 * Packets are little-endian: header u32 = command:4 | action:8 | size:11 | ext:9.
 */
(function () {
  const HALL_CMD = 1;
  const GAME_CMD = 2;
  const BET_CMD = 4;
  const USER_INFO_ACT = 3;
  const NEXT_SHOES_ACT = 1;
  const REQUEST_RESULT_ACT = 2;
  const RESULT_ACT = 4;
  const HISTORY_ACT = 3;
  const NEW_ACT = 5;
  const START_BET_ACT = 6;
  const STOP_BET_ACT = 7;
  const GAME_PAYMENT_ACT = 8;
  const HALL_STATE_PREPARING = 1;
  const GAME_HISTORY_ACT = 16;
  const BET_ACT = 3;
  const BET_CONFIRM_ACT = 4;
  const BET_STATE_OK = 1;
  const BACCARAT_TYPES = new Set([1, 7, 9, 10, 11, 16, 17]);
  const BG_TABLE_ID_PATTERN = /^[A-Za-z]\d{2}$/;
  const MARKET_BET_TYPE = {
    banker: 0x10000001,
    player: 0x10000002,
    bankerPair: 0x10000080,
    playerPair: 0x10000100,
  };
  const RANKS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  const SUITS = ['S', 'H', 'C', 'D'];

  function readU16(view, offset) {
    return view.getUint16(offset, true);
  }
  function readU32(view, offset) {
    return view.getUint32(offset, true);
  }
  function readF64(view, offset) {
    return view.getFloat64(offset, true);
  }
  function readI64(view, offset) {
    const lo = readU32(view, offset);
    const hi = readU32(view, offset + 4);
    return hi * 4294967296 + lo;
  }
  function readUtf(view, offset, length) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
    let end = length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    return new TextDecoder('utf-8').decode(bytes.subarray(0, end)).trim();
  }
  function writeU16(view, offset, value) {
    view.setUint16(offset, value >>> 0, true);
  }
  function writeU32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }
  function writeF64(view, offset, value) {
    view.setFloat64(offset, value, true);
  }
  function writeI64(view, offset, value) {
    const lo = value >>> 0;
    const hi = Math.floor(value / 4294967296) >>> 0;
    writeU32(view, offset, lo);
    writeU32(view, offset + 4, hi);
  }
  function writeFixed(bytes, offset, text, length) {
    const encoded = new TextEncoder().encode(String(text || ''));
    for (let i = 0; i < length; i += 1) bytes[offset + i] = i < encoded.length ? encoded[i] : 0;
  }
  function checksum32(value) {
    return 4294967295 & Math.floor(value);
  }
  function betChecksum(uid, seqNo, userFlag, amount, betType) {
    const s = checksum32(amount);
    const i = checksum32(seqNo);
    const n = checksum32(userFlag);
    const a = checksum32(uid);
    const r = checksum32(betType);
    return checksum32(i + 3386 + 3 * n ^ ~(a + (r - s | n + 215 + i + s << 24) & 1367553510));
  }
  function decodeHeader(word) {
    return {
      command: word & 15,
      action: word >> 4 & 255,
      size: word >> 12 & 2047,
      ext: word >> 23 & 511,
    };
  }
  function encodeHeader(command, action, size, ext) {
    return command | action << 4 | size << 12 | (ext || 0) << 23;
  }
  function remoteCard(code) {
    if (!code) return null;
    let rank;
    let suit;
    if (code >= 1 && code <= 13) { rank = code; suit = 0; }
    else if (code >= 14 && code <= 26) { rank = code - 13; suit = 1; }
    else if (code >= 27 && code <= 39) { rank = code - 26; suit = 2; }
    else if (code >= 40 && code <= 52) { rank = code - 39; suit = 3; }
    else return null;
    const rankToken = RANKS[rank] || String(rank);
    return `${rankToken}${SUITS[suit] || 'S'}`;
  }
  function baccaratCards(bytes, historyOrder) {
    const player = [];
    const banker = [];
    // HISTORY rows are [P2,B2,P1,B1,P3,B3]; RESULT rows are [P1,B1,P2,B2,P3,B3].
    const p1 = remoteCard(historyOrder ? bytes[2] : bytes[0]);
    const b1 = remoteCard(historyOrder ? bytes[3] : bytes[1]);
    const p2 = remoteCard(historyOrder ? bytes[0] : bytes[2]);
    const b2 = remoteCard(historyOrder ? bytes[1] : bytes[3]);
    if (p1) player.push(p1);
    if (p2) player.push(p2);
    if (b1) banker.push(b1);
    if (b2) banker.push(b2);
    const p3 = remoteCard(bytes[4]);
    const b3 = remoteCard(bytes[5]);
    if (p3) player.push(p3);
    if (b3) banker.push(b3);
    return { playerCards: player, bankerCards: banker };
  }

  function decodePackets(buffer) {
    const view = new DataView(buffer);
    const packets = [];
    let offset = 0;
    while (offset + 4 <= view.byteLength) {
      const header = decodeHeader(readU32(view, offset));
      let size = header.size;
      if (header.command === HALL_CMD && header.action === USER_INFO_ACT && offset + 86 <= view.byteLength) {
        const total = Math.min(readU16(view, offset + 84), 256);
        const needed = 4 + 176 + total * 72;
        const remaining = view.byteLength - offset;
        if (needed > size && needed <= remaining && size <= 2047 && needed > 2047) size = needed;
      }
      if (size < 4 || offset + size > view.byteLength) break;
      packets.push({
        ...header,
        size: size,
        body: new DataView(buffer, offset + 4, size - 4),
      });
      offset += size;
    }
    return packets;
  }

  function parseGameDto(body) {
    if (body.byteLength < 8) return null;
    return {
      tableId: readUtf(body, 0, 4),
      seqNo: readU32(body, 4),
    };
  }

  function parseStartBet(body) {
    const game = parseGameDto(body);
    if (!game) return null;
    return {
      ...game,
      serialNo: body.byteLength >= 24 ? readUtf(body, 8, 16) : '',
    };
  }

  function parseResult(body) {
    const game = parseGameDto(body);
    if (!game || body.byteLength < 16) return null;
    const count = readU16(body, 10);
    const rows = [];
    let offset = 16;
    for (let i = 0; i < count && offset + 6 <= body.byteLength; i += 1) {
      const row = [];
      for (let j = 0; j < 6; j += 1) row.push(body.getUint8(offset + j));
      rows.push(row);
      offset += 6;
    }
    return { ...game, rows };
  }

  function parseBetConfirm(body) {
    if (body.byteLength < 16) return null;
    return {
      state: readU32(body, 0),
      userFlag: readU16(body, 4),
      errorCode: readU16(body, 6),
      balance: readF64(body, 8),
    };
  }

  function hallGameCount(body, offset) {
    const candidates = [8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64];
    for (let i = 0; i < candidates.length; i += 1) {
      const at = offset + candidates[i];
      if (at + 2 > body.byteLength) continue;
      const value = readU16(body, at);
      if (value >= 1 && value <= 80) return value;
    }
    return 0;
  }

  function hallRecordDebug(body, offset, id, type, seqNo, gameCount) {
    const cand = [];
    for (let o = 8; o <= 66 && offset + o + 2 <= body.byteLength; o += 2) {
      const value = readU16(body, offset + o);
      if (value >= 1 && value <= 80) cand.push({ o: o, v: value, w: 16 });
    }
    return {
      id: String(id || '').toUpperCase(),
      type: type,
      seqNo: seqNo,
      gameCount: gameCount || 0,
      cand: cand.slice(0, 12),
    };
  }

  function normalizeTableId(value) {
    const trimmed = String(value || '').trim();
    if (!BG_TABLE_ID_PATTERN.test(trimmed)) return '';
    return trimmed.toUpperCase();
  }
  function netGameType(raw) {
    const value = raw >>> 0;
    if (value >= 1 && value <= 17) return value;
    const high = value >>> 24 & 255;
    const nibble = high >> 4;
    return nibble !== 0 ? nibble : 15 + (15 & high);
  }
  function isBaccaratHallType(raw) {
    return BACCARAT_TYPES.has(netGameType(raw));
  }
  function isKnownBaccaratTable(value) {
    const tableId = normalizeTableId(value);
    if (!tableId) return false;
    return session.nonBaccaratTableIds.indexOf(tableId) < 0;
  }
  function settledHistoryCards(bytes) {
    const cards = baccaratCards(bytes, true);
    if (cards.playerCards.length < 2 || cards.bankerCards.length < 2) return null;
    return cards;
  }
  function stripStickyBankerLead(visible) {
    if (!visible || visible.length < 8) return visible;
    const lead = visible[0].cards.bankerCards[0];
    if (!lead) return visible;
    for (let i = 0; i < visible.length; i += 1) {
      if (visible[i].cards.bankerCards[0] !== lead) return visible;
    }
    const seen = Object.create(null);
    let unique = 0;
    for (let i = 0; i < visible.length; i += 1) {
      const key = visible[i].cards.playerCards.join(',') + '|' + visible[i].cards.bankerCards.slice(1).join(',');
      if (!seen[key]) {
        seen[key] = 1;
        unique += 1;
      }
    }
    if (unique < 4) return visible;
    return visible.map(function (row) {
      return {
        gameId: row.gameId,
        cards: {
          playerCards: row.cards.playerCards.slice(),
          bankerCards: row.cards.bankerCards.slice(1),
        },
      };
    });
  }
  function visibleHistoryRows(parsed) {
    const currentSeq = session.seqNoByTable[parsed.tableId];
    const rows = [];
    for (let i = 0; i < parsed.rows.length; i += 1) {
      const gameId = parsed.seqNo + i;
      if (Number.isInteger(currentSeq) && currentSeq > 0 && gameId > currentSeq) continue;
      const cards = settledHistoryCards(parsed.rows[i]);
      if (!cards) continue;
      rows.push({ gameId: gameId, cards: cards });
    }
    return rows;
  }
  function currentRoadCount(tableId, seqNo) {
    const hist = session.historyCountByTable[tableId];
    if (Number.isInteger(hist) && hist >= 1 && hist <= 80) return hist;
    return 0;
  }
  function acceptedGameTable(parsed) {
    if (!parsed) return null;
    const tableId = normalizeTableId(parsed.tableId);
    if (!tableId || !isKnownBaccaratTable(tableId)) return null;
    return Object.assign({}, parsed, { tableId: tableId });
  }
  function parseHallTables(body) {
    session.debug.hall = [];

    const tables = [];
    if (body.byteLength < 176) return tables;
    const total = Math.min(readU16(body, 80), 256);
    const typeCounts = Object.create(null);
    let offset = 176;
    let scanned = 0;
    for (let i = 0; i < total && offset + 72 <= body.byteLength; i += 1) {
      const id = normalizeTableId(readUtf(body, offset, 4));
      const rawType = readU32(body, offset + 4);
      const type = netGameType(rawType);
      const state = readU32(body, offset + 24);
      const seqNo = readU32(body, offset + 68);
      scanned += 1;
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      if (id && isBaccaratHallType(rawType)) {
        const guessed = hallGameCount(body, offset);
        session.hallStateByTable[id] = state;
        if (seqNo >= 1000) {
          const prev = session.seqNoByTable[id];
          if (!Number.isInteger(prev) || seqNo >= prev) session.seqNoByTable[id] = seqNo;
        }
        tables.push({
          tableId: id,
          source: 'hall',
        });
        if (session.baccaratTableIds.indexOf(id) < 0) session.baccaratTableIds.push(id);
        const dropAt = session.nonBaccaratTableIds.indexOf(id);
        if (dropAt >= 0) session.nonBaccaratTableIds.splice(dropAt, 1);
        if (session.debug.hall.length < 8) {
          session.debug.hall.push(hallRecordDebug(body, offset, id, rawType, seqNo, guessed));
        }
      } else if (id) {
        if (session.nonBaccaratTableIds.indexOf(id) < 0) session.nonBaccaratTableIds.push(id);
        const keepAt = session.baccaratTableIds.indexOf(id);
        if (keepAt >= 0) session.baccaratTableIds.splice(keepAt, 1);
      }
      offset += 72;
    }
    session.debug.hallMeta = { total: total, scanned: scanned, kept: tables.length, types: typeCounts, dropped: session.nonBaccaratTableIds.slice(0, 40) };
    if (scanned > 0) session.hallSeen = true;
    session.hallTableIds = session.baccaratTableIds.slice();
    ensureWatchTimer();
    return tables;
  }

  function historySnapshots(body) {
    const tables = [];
    const parsed = acceptedGameTable(parseResult(body));
    if (!parsed) return tables;
    const id = parsed.tableId;
    const visible = visibleHistoryRows(parsed);
    const sticky = stripStickyBankerLead(visible);
    if (sticky !== visible && visible.length > 0) {
      session.stickyBankerLeadByTable[id] = visible[0].cards.bankerCards[0];
    } else {
      delete session.stickyBankerLeadByTable[id];
    }
    const road = visible.length;
    const previousRoad = session.historyCountByTable[id];
    session.historyCountByTable[id] = road;
    if (road > 0) {
      const previousFirst = session.firstGameIdByTable[id];
      const firstKept = visible[0].gameId;
      const wrappedNow = Number.isInteger(previousRoad)
        && previousRoad >= 10
        && road <= 8
        && previousRoad - road >= 8;
      if (!Number.isInteger(previousFirst) || firstKept <= previousFirst || wrappedNow) {
        session.firstGameIdByTable[id] = firstKept;
      }
    }
    const wrapped = Number.isInteger(previousRoad)
      && previousRoad >= 10
      && road <= 8
      && previousRoad - road >= 8;
    if (session.debug.histories.length >= 12) session.debug.histories.shift();
    session.debug.histories.push({ tableId: id, seqNo: parsed.seqNo, road: road, wrapped: wrapped });
    if (road === 0) {
      delete session.historyEmittedCount[id];
      if (wrapped) {
        tables.push({
          tableId: id,
          shuffleEvent: true,
          shoeReset: 'seq:' + parsed.seqNo,
          bettingOpen: false,
          source: 'protocol',
        });
      } else {
        // Keep the table feed alive during shuffle when HISTORY is empty.
        tables.push({
          tableId: id,
          bettingOpen: false,
          source: 'protocol',
        });
      }
      return tables;
    }
    const last = visible[road - 1].cards;
    session.historyEmittedCount[id] = road;
    tables.push({
      tableId: id,
      roundId: String(visible[road - 1].gameId),
      gameCount: Math.min(road, 80),
      bettingOpen: false,
      playerCards: last.playerCards,
      bankerCards: last.bankerCards,
      source: 'protocol',
      shoeReset: 'seq:' + String(visible[0].gameId),
      historyHands: visible.slice(0, 80).map(row => row.cards),
      ...(wrapped ? { shuffleEvent: true } : {}),
    });
    return tables;
  }

  function snapshotsFromPacket(packet) {
    const tables = [];
    if (packet.command === HALL_CMD && packet.action === USER_INFO_ACT) {
      return parseHallTables(packet.body);
    }
    if (packet.command === HALL_CMD && packet.action === GAME_HISTORY_ACT) {
      return historySnapshots(packet.body);
    }
    if (packet.command !== GAME_CMD) return tables;
    if (packet.action === NEW_ACT || packet.action === START_BET_ACT) {
      const parsed = acceptedGameTable(parseStartBet(packet.body));
      if (!parsed) return tables;
      if (session.debug.startBets.length >= 12) session.debug.startBets.shift();
      session.debug.startBets.push({
        tableId: parsed.tableId,
        seqNo: parsed.seqNo,
        serialNo: parsed.serialNo,
        ext: packet.ext,
        act: packet.action,
      });
      const road = currentRoadCount(parsed.tableId, parsed.seqNo);
      tables.push({
        tableId: parsed.tableId,
        roundId: String(parsed.seqNo),
        bettingOpen: true,
        countdown: packet.ext,
        playerCards: [],
        bankerCards: [],
        source: 'protocol',
        ...(road > 0 ? { gameCount: road } : {}),
      });
      return tables;
    }
    if (packet.action === STOP_BET_ACT) {
      const parsed = acceptedGameTable(parseGameDto(packet.body));
      if (!parsed) return tables;
      const road = currentRoadCount(parsed.tableId, parsed.seqNo);
      tables.push({
        tableId: parsed.tableId,
        roundId: String(parsed.seqNo),
        bettingOpen: false,
        source: 'protocol',
        ...(road > 0 ? { gameCount: road } : {}),
      });
      return tables;
    }
    if (packet.action === NEXT_SHOES_ACT) {
      const parsed = acceptedGameTable(parseGameDto(packet.body));
      if (!parsed) return tables;
      if (session.debug.shoes.length >= 12) session.debug.shoes.shift();
      session.debug.shoes.push({ tableId: parsed.tableId, seqNo: parsed.seqNo, ext: packet.ext });
      session.historyCountByTable[parsed.tableId] = 0;
      delete session.historyEmittedCount[parsed.tableId];
      delete session.firstGameIdByTable[parsed.tableId];
      delete session.stickyBankerLeadByTable[parsed.tableId];
      tables.push({
        tableId: parsed.tableId,
        shuffleEvent: true,
        shoeReset: `seq:${parsed.seqNo}`,
        bettingOpen: false,
        source: 'protocol',
      });
      return tables;
    }
    if (packet.action === HISTORY_ACT) {
      return historySnapshots(packet.body);
    }
    if (packet.action === RESULT_ACT) {
      const parsed = acceptedGameTable(parseResult(packet.body));
      if (!parsed || parsed.rows.length === 0) return tables;
      const cards = baccaratCards(parsed.rows[0]);
      const road = currentRoadCount(parsed.tableId, parsed.seqNo);
      tables.push({
        tableId: parsed.tableId,
        roundId: String(parsed.seqNo),
        bettingOpen: false,
        gameSettled: true,
        playerCards: cards.playerCards,
        bankerCards: cards.bankerCards,
        source: 'protocol',
        ...(road > 0 ? { gameCount: road } : {}),
      });
    }
    return tables;
  }

  function encodeBet({ uid, token, seqNo, tableId, userFlag, amount, market }) {
    const betType = MARKET_BET_TYPE[market];
    if (!betType) throw new Error('invalid-market');
    const item = new Uint8Array(24);
    const itemView = new DataView(item.buffer);
    writeF64(itemView, 0, amount);
    writeU32(itemView, 8, 0);
    writeU32(itemView, 12, betType);
    writeU32(itemView, 16, 0);
    writeU32(itemView, 20, 0);
    const body = new Uint8Array(64 + 24);
    const view = new DataView(body.buffer);
    writeI64(view, 0, uid);
    writeFixed(body, 8, token, 32);
    writeU32(view, 40, seqNo);
    writeFixed(body, 44, tableId, 4);
    writeU16(view, 48, 0);
    writeU16(view, 50, userFlag);
    writeU32(view, 52, 1);
    writeU32(view, 56, betChecksum(uid, seqNo, userFlag, amount, betType));
    writeU32(view, 60, 0);
    body.set(item, 64);
    const size = 4 + body.length;
    const packet = new Uint8Array(size);
    const headerView = new DataView(packet.buffer);
    writeU32(headerView, 0, encodeHeader(BET_CMD, BET_ACT, size, 0));
    packet.set(body, 4);
    return packet.buffer;
  }

  const session = {
    uid: 0,
    token: '',
    userFlag: 1,
    debug: { hall: [], startBets: [], shoes: [], histories: [] },
    seqNoByTable: Object.create(null),
    countdownByTable: Object.create(null),
    countdownAtByTable: Object.create(null),
    historyCountByTable: Object.create(null),
    historyEmittedCount: Object.create(null),
    firstGameIdByTable: Object.create(null),
    stickyBankerLeadByTable: Object.create(null),
    hallStateByTable: Object.create(null),
    sockets: [],
    betSocket: null,
    gameSocket: null,
    hallTableIds: [],
    baccaratTableIds: [],
    nonBaccaratTableIds: [],
    hallSeen: false,
    watchCursor: 0,
    watchTimer: 0,
    lastConfirm: null,
    recentPackets: [],
    confirmWaitMs: 4000,
    betInFlight: false,
  };

  function packetHex(packet, max) {
    const length = Math.min(packet.body.byteLength, max || 64);
    const bytes = new Uint8Array(packet.body.buffer, packet.body.byteOffset, length);
    let hex = '';
    for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }

  function notePacket(packet, direction) {
    if (packet.command !== BET_CMD && !(packet.command === GAME_CMD && packet.action === GAME_PAYMENT_ACT)) return;
    session.recentPackets.push({
      d: direction,
      c: packet.command,
      a: packet.action,
      e: packet.ext,
      n: packet.body.byteLength,
      hex: packetHex(packet, 48),
      t: Date.now(),
    });
    if (session.recentPackets.length > 40) session.recentPackets.shift();
  }

  function rememberSocket(socket) {
    if (!socket || session.sockets.includes(socket)) return;
    session.sockets = session.sockets.filter(item => item.readyState < 2);
    session.sockets.push(socket);
    if (session.betSocket && session.betSocket.readyState > 1) session.betSocket = null;
  }

  function pickBetSocket() {
    if (session.betSocket && session.betSocket.readyState === 1) return session.betSocket;
    return null;
  }

  function encodeRequestResult(tableId, seqNo, count) {
    const body = new Uint8Array(12);
    const view = new DataView(body.buffer);
    writeFixed(body, 0, String(tableId).toUpperCase(), 4);
    writeU32(view, 4, seqNo >>> 0);
    writeU32(view, 8, count >>> 0);
    const size = 4 + body.length;
    const packet = new Uint8Array(size);
    const headerView = new DataView(packet.buffer);
    writeU32(headerView, 0, encodeHeader(GAME_CMD, REQUEST_RESULT_ACT, size, 0));
    packet.set(body, 4);
    return packet.buffer;
  }

  function requestTableHistory(tableId) {
    const socket = session.gameSocket && session.gameSocket.readyState === 1 ? session.gameSocket : null;
    if (!socket || !tableId) return;
    try { socket.send(encodeRequestResult(tableId, 0, 80)); } catch (_) {}
  }

  function sendNextWatch() {
    const ids = session.hallTableIds;
    if (!ids || ids.length === 0) return;
    const tableId = ids[session.watchCursor % ids.length];
    session.watchCursor = (session.watchCursor + 1) % Math.max(ids.length, 1);
    if (!tableId) return;
    requestTableHistory(tableId);
  }

  function ensureWatchTimer() {
    if (session.watchTimer || typeof setInterval !== 'function') return;
    session.watchTimer = setInterval(sendNextWatch, 250);
  }

  function harvest(packet, direction, socket) {
    notePacket(packet, direction);
    if (packet.command === BET_CMD && socket) session.betSocket = socket;
    if (packet.command === GAME_CMD && socket) {
      session.gameSocket = socket;
      ensureWatchTimer();
    }
    if (packet.command === BET_CMD && packet.action === 1 && direction === 'send' && packet.body.byteLength >= 40) {
      session.uid = readI64(packet.body, 0);
      session.token = readUtf(packet.body, 8, 32);
    }
    if (packet.command === BET_CMD && packet.action === BET_ACT && direction === 'send' && packet.body.byteLength >= 52) {
      session.uid = readI64(packet.body, 0);
      session.token = readUtf(packet.body, 8, 32);
      session.userFlag = readU16(packet.body, 50) || session.userFlag;
      const tableId = readUtf(packet.body, 44, 4);
      const seqNo = readU32(packet.body, 40);
      if (tableId) session.seqNoByTable[tableId.toUpperCase()] = seqNo;
    }
    if (packet.command === BET_CMD && packet.action === BET_CONFIRM_ACT && direction === 'recv') {
      session.lastConfirm = parseBetConfirm(packet.body);
    }
    if (packet.command === HALL_CMD && packet.action === USER_INFO_ACT && packet.body.byteLength >= 8) {
      session.uid = session.uid || readI64(packet.body, 0);
    }
    if (packet.command === GAME_CMD && (packet.action === START_BET_ACT || packet.action === NEW_ACT)) {
      const parsed = parseStartBet(packet.body);
      if (parsed) {
        const id = normalizeTableId(parsed.tableId);
        if (!id || !isKnownBaccaratTable(id)) return;
        session.seqNoByTable[id] = parsed.seqNo;
        session.countdownByTable[id] = packet.ext;
        session.countdownAtByTable[id] = Date.now();
      }
    }
  }

  function ingestBuffer(buffer, direction, socket) {
    rememberSocket(socket);
    const packets = decodePackets(buffer);
    const tables = [];
    for (const packet of packets) {
      harvest(packet, direction, socket);
      if (direction === 'recv') tables.push(...snapshotsFromPacket(packet));
    }
    return tables;
  }

  function packetsSince(startedAt) {
    return session.recentPackets.filter(item => item.t >= startedAt).slice(-12);
  }

  function confirmResult(confirm) {
    if (!confirm) return null;
    if (confirm.state === BET_STATE_OK) {
      return { status: 'ACCEPTED', userFlag: confirm.userFlag, state: confirm.state };
    }
    return {
      status: 'REJECTED',
      reason: 'bet-state:' + confirm.state + ':' + confirm.errorCode,
      userFlag: confirm.userFlag,
    };
  }

  async function submit({ tableId, market, amount, handId }) {
    if (session.betInFlight) {
      return { status: 'REJECTED', reason: 'bet-in-flight', sent: false };
    }
    const seqNo = Number(handId);
    if (!session.uid || !session.token) {
      return { status: 'REJECTED', reason: 'bg-session-missing', sent: false };
    }
    if (!Number.isFinite(seqNo) || seqNo <= 0) {
      return { status: 'REJECTED', reason: 'invalid-hand', sent: false };
    }
    const socket = pickBetSocket();
    if (!socket) {
      return { status: 'REJECTED', reason: 'bg-socket-missing', sent: false };
    }
    session.userFlag = (session.userFlag + 1) & 0xffff || 1;
    const expectedFlag = session.userFlag;
    session.lastConfirm = null;
    const startedAt = Date.now();
    session.betInFlight = true;
    try {
      socket.send(encodeBet({
        uid: session.uid,
        token: session.token,
        seqNo,
        tableId: String(tableId).toUpperCase(),
        userFlag: expectedFlag,
        amount,
        market,
      }));
      const waitMs = Number(session.confirmWaitMs) > 0 ? Number(session.confirmWaitMs) : 4000;
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const confirm = session.lastConfirm;
        if (confirm && confirm.userFlag === expectedFlag) {
          const matched = confirmResult(confirm);
          return { ...matched, sent: true, expectedFlag };
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {
        status: 'UNKNOWN',
        reason: 'bet-confirm-timeout',
        expectedFlag,
        seen: packetsSince(startedAt),
        sent: true,
      };
    } finally {
      session.betInFlight = false;
    }
  }

  globalThis.BaccaratBgProtocol = {
    HALL_CMD,
    GAME_CMD,
    BET_CMD,
    decodeHeader,
    encodeHeader,
    decodePackets,
    snapshotsFromPacket,
    encodeBet,
    encodeRequestResult,
    betChecksum,
    ingestBuffer,
    submit,
    parseBetConfirm,
    session,
    remoteCard,
    baccaratCards,
  };
})();
