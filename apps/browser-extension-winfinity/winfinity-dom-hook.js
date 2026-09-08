/**
 * Isolated-world Winfinity lobby/table discovery.
 * Reads streamId / tableId from observed iframes and Baccarat tiles.
 * Does not invent a table list.
 */
(function () {
  const STREAM_ID = /^[a-z0-9]+-bac\d+$/i;
  const VENDOR_TABLE_ID = /^[a-f0-9]{24}$/i;

  function isSentryHost(host) {
    return /(^|\.)skt\.youngpoisson\.xyz$/i.test(String(host || ''));
  }

  function isWinfinityPage() {
    try {
      const host = String(location.hostname || '');
      const path = String(location.pathname || '');
      if (isSentryHost(host)) return false;
      if (/(^|\.)youngpoisson\.xyz$/i.test(host)) return true;
      if (/(^|\.)dafabet\.net$/i.test(host)) {
        const normalized = path.replace(/^\/[a-z-]+/i, '').replace(/\/+$/, '');
        return normalized === '/live-dealer/popup-launch/tao-yuan-baccarat';
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  if (!isWinfinityPage()) return;

  function extractStreamId(href) {
    try {
      const value = new URL(String(href || ''), 'https://lobby.youngpoisson.xyz/').searchParams.get('streamId');
      if (!value) return undefined;
      const normalized = String(value).trim().toLowerCase();
      return STREAM_ID.test(normalized) ? normalized : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function extractVendorTableId(href) {
    try {
      const value = new URL(String(href || ''), 'https://lobby.youngpoisson.xyz/').searchParams.get('tableId');
      const normalized = String(value || '').trim().toLowerCase();
      return VENDOR_TABLE_ID.test(normalized) ? normalized : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function displayNameFromText(text) {
    const lines = String(text || '').split(/\n+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const line = lines.find(item => /baccarat/i.test(item) && item.length <= 80);
    return line || undefined;
  }

  function gameCountFromText(text) {
    const match = /#(\d+)/.exec(String(text || ''));
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  }

  function closestTile(node) {
    let current = node;
    for (let i = 0; i < 8 && current; i += 1) {
      if (current === document.body || current === document.documentElement) break;
      const text = String(current.innerText || current.textContent || '');
      if (/baccarat/i.test(text) && text.length < 2000) return current;
      current = current.parentElement;
    }
    return node;
  }

  function collectTables() {
    const found = new Map();
    const upsert = (href, tile) => {
      const streamId = extractStreamId(href);
      const vendorTableId = extractVendorTableId(href);
      const text = tile ? String(tile.innerText || tile.textContent || '') : '';
      if (!streamId && !/baccarat/i.test(text)) return;
      const tableId = streamId || (vendorTableId ? `wnf-${vendorTableId}` : '');
      if (!tableId) return;
      const displayName = displayNameFromText(text);
      const gameCount = gameCountFromText(text);
      const prev = found.get(tableId) || {
        tableId,
        source: 'hall',
      };
      found.set(tableId, {
        ...prev,
        ...(streamId ? { streamId } : {}),
        ...(vendorTableId ? { vendorTableId } : {}),
        ...(displayName ? { displayName } : {}),
        ...(gameCount === undefined ? {} : { gameCount }),
      });
    };

    upsert(location.href, null);
    document.querySelectorAll('iframe[src], a[href], [src]').forEach(node => {
      const href = node.getAttribute('src') || node.getAttribute('href') || '';
      if (!/streamId=|tableId=/i.test(href)) return;
      upsert(href, closestTile(node));
    });
    document.querySelectorAll('[data-stream-id],[data-streamid],[data-table-id]').forEach(node => {
      const streamId = String(node.getAttribute('data-stream-id') || node.getAttribute('data-streamid') || '').trim();
      const vendorTableId = String(node.getAttribute('data-table-id') || '').trim();
      const params = new URLSearchParams();
      if (streamId) params.set('streamId', streamId);
      if (vendorTableId) params.set('tableId', vendorTableId);
      upsert(`https://lobby.youngpoisson.xyz/?${params.toString()}`, closestTile(node));
    });
    return [...found.values()];
  }

  function emit(tables) {
    if (tables.length === 0) return;
    const observedAt = new Date().toISOString();
    try {
      chrome.runtime.sendMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-winfinity',
          displayName: 'Dafabet Winfinity',
          tables,
        },
      });
      chrome.runtime.sendMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-winfinity-state',
        url: location.href,
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          observedAt,
          tables,
        }),
      });
    } catch (_) {}
  }

  function scan() {
    emit(collectTables());
  }

  scan();
  setInterval(scan, 2000);
})();
