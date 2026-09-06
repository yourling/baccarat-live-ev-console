/**
 * Isolated-world BG lobby/table discovery. Only reports observed table ids
 * from URL / data attributes. Does not invent cards or shuffle tokens, and
 * does not scrape innerText (that picked up RGB255 / GB2312 junk).
 */
(function () {
  const TABLE_ID = /^[A-Za-z]\d{2}$/;

  function isBgPage() {
    try {
      const host = String(location.hostname || '');
      const path = String(location.pathname || '');
      const href = String(location.href || '');
      if (/(^|\.)pragmaticplaylive\.net$/i.test(host)) return false;
      if (/(^|\.)dafabet\.net$/i.test(host)) {
        const normalized = path.replace(/^\/[a-z-]+/i, '').replace(/\/+$/, '');
        if (normalized === '/live-dealer/popup-launch/live-baccarat-bg') return true;
      }
      if (/(^|\.)vbgames88\.com$/i.test(host) && /bg~~|\/portals\/bg/i.test(href)) return true;
      if (/\/h5V01\//i.test(path)) return true;
      if (/[?&#]table=([A-Za-z]\d{2})\b/i.test(href)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  if (!isBgPage()) return;

  function normalizeTableId(value) {
    const trimmed = String(value || '').trim();
    if (!TABLE_ID.test(trimmed)) return '';
    return trimmed.toUpperCase();
  }

  function collectTables() {
    const found = new Map();
    const add = (tableId) => {
      const id = normalizeTableId(tableId);
      if (!id) return;
      found.set(id, { tableId: id });
    };

    try {
      const params = new URLSearchParams(location.search);
      add(params.get('table') || '');
    } catch (_) {}

    document.querySelectorAll('[data-table-id]').forEach(node => {
      add(node.getAttribute('data-table-id') || '');
    });
    document.querySelectorAll('iframe[src]').forEach(frame => {
      const match = String(frame.getAttribute('src') || '').match(/[?&#]table=([A-Za-z]\d{2})\b/i);
      if (match) add(match[1]);
    });

    return [...found.values()];
  }

  function emit(tables) {
    if (tables.length === 0) return;
    try {
      chrome.runtime.sendMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-bg',
          displayName: 'Dafabet BG Live',
          tables,
        },
      });
      chrome.runtime.sendMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-bg-state',
        url: location.href,
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          view: tables.length > 1 ? 'multi' : 'single',
          observedAt: new Date().toISOString(),
          tables: tables.map(table => ({
            tableId: table.tableId,
            visible: true,
            source: 'dom',
          })),
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
