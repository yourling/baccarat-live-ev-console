/**
 * Isolated content script for Dafabet Tao Yuan / Winfinity pages.
 * Forwards protocol captures. No reload, no bet executor, no keeper tabs.
 */
(function () {
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

  const SCAN_INTERVAL_MS = 2000;
  const KEEPALIVE_INTERVAL_MS = 30 * 1000;
  let diagnosticSent = false;
  let sessionExpiredSent = false;

  function frameKind() {
    return window.top === window ? 'top' : 'iframe';
  }

  function sendToBackground(message) {
    try { chrome.runtime.sendMessage(message); } catch (_) {}
  }

  function sendSessionAction(action, detail) {
    sendToBackground({
      kind: 'sessionAction',
      action,
      url: location.href,
      frame: frameKind(),
      timestamp: new Date().toISOString(),
      ...(detail ? { detail: String(detail).slice(0, 120) } : {}),
    });
  }

  function isSessionExpiredText(text) {
    return /会话已过期|session expired|session timeout/i.test(String(text || ''));
  }

  function checkSessionExpired(bodyText) {
    if (!isSessionExpiredText(bodyText)) {
      if (sessionExpiredSent) {
        sessionExpiredSent = false;
        sendSessionAction('recovered');
      }
      return;
    }
    if (sessionExpiredSent) return;
    sessionExpiredSent = true;
    sendToBackground({
      kind: 'sessionExpired',
      url: location.href,
      frame: frameKind(),
      textLength: bodyText.length,
      recovering: false,
      timestamp: new Date().toISOString(),
    });
  }

  function sendDiagnostic() {
    const bodyText = document.body ? document.body.innerText : '';
    sendToBackground({
      kind: 'diagnostic',
      url: location.href,
      frame: frameKind(),
      readyState: document.readyState,
      titleLength: String(document.title || '').length,
      bodyTextLength: bodyText.length,
      htmlLength: document.documentElement ? document.documentElement.outerHTML.length : 0,
      candidateCount: document.querySelectorAll('[class*="table"],[id*="table"],[class*="game"],[id*="game"]').length,
      canvasCount: document.querySelectorAll('canvas').length,
      videoCount: document.querySelectorAll('video').length,
      iframeCount: document.querySelectorAll('iframe').length,
    });
  }

  function isKeepaliveFrame() {
    try {
      return /(^|\.)baccarat-multitable\.youngpoisson\.xyz$/i.test(String(location.hostname || ''));
    } catch (_) {
      return false;
    }
  }

  function syntheticKeepalive() {
    if (!isKeepaliveFrame()) return;
    try {
      window.dispatchEvent(new Event('mousemove'));
      window.dispatchEvent(new Event('focus'));
      window.scrollBy(0, 1);
      window.scrollBy(0, -1);
      sendSessionAction('trusted-activity', 'synthetic');
    } catch (_) {}
  }

  async function beaconKeepalive() {
    if (!isKeepaliveFrame() || typeof fetch !== 'function') return;
    try {
      const response = await fetch(location.origin + '/', {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'include',
        redirect: 'follow',
      });
      if (!response.ok) {
        await fetch(location.origin + '/', {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          redirect: 'follow',
        });
      }
    } catch (error) {
      sendSessionAction('beacon-failed', error && error.message);
      return;
    }
    sendSessionAction('keepalive-click', 'beacon');
  }

  function scan() {
    const bodyText = document.body ? document.body.innerText : '';
    checkSessionExpired(bodyText);
    if (!diagnosticSent) {
      diagnosticSent = true;
      sendDiagnostic();
    }
    sendToBackground({ kind: 'heartbeat', timestamp: new Date().toISOString() });
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data.source !== 'string' || !data.source.startsWith('baccarat-bridge-winfinity-')) return;
    if (data.encoding === 'base64') return;
    const text = String(data.data || '');
    if (!text || text.length > 65536) return;
    sendToBackground({
      kind: 'networkCapture',
      source: data.source,
      url: String(data.url || location.href),
      direction: data.direction || 'recv',
      encoding: 'text',
      data: text,
    });
  });

  try {
    window.postMessage({ kind: 'baccarat-winfinity-content-ready' }, '*');
  } catch (_) {}

  function emitLaunchMapping() {
    try {
      const url = new URL(location.href);
      const streamRaw = String(url.searchParams.get('streamId') || '').trim().toLowerCase();
      const vendorRaw = String(url.searchParams.get('tableId') || '').trim().toLowerCase();
      const streamId = /^[a-z0-9]+-bac\d+$/.test(streamRaw) ? streamRaw : undefined;
      const vendorTableId = /^[a-f0-9]{24}$/.test(vendorRaw) ? vendorRaw : undefined;
      if (!streamId && !vendorTableId) return;
      const tableId = streamId || (vendorTableId ? `wnf-${vendorTableId}` : '');
      if (!tableId) return;
      sendToBackground({
        kind: 'networkCapture',
        source: 'baccarat-bridge-winfinity-state',
        url: location.href,
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          observedAt: new Date().toISOString(),
          tables: [{
            tableId,
            source: 'launch',
            ...(streamId ? { streamId } : {}),
            ...(vendorTableId ? { vendorTableId } : {}),
          }],
        }),
      });
    } catch (_) {}
  }

  sendSessionAction('trusted-activity', 'winfinity-content-boot');
  emitLaunchMapping();
  scan();
  setInterval(scan, SCAN_INTERVAL_MS);
  setInterval(() => {
    syntheticKeepalive();
    void beaconKeepalive();
  }, KEEPALIVE_INTERVAL_MS);
})();
