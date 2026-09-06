/**
 * Isolated content script for Dafabet BG pages: forward protocol captures,
 * heartbeat, synthetic keepalive + same-origin beacon. No CDP, no reload,
 * no keeper tabs, no video sit-down, no 重新连接 clicks.
 */
(function () {
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
      if (/[?&#]table=([A-Za-z]\d{2})/i.test(href)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  if (!isBgPage()) return;

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

  function syntheticKeepalive() {
    try {
      window.dispatchEvent(new Event('mousemove'));
      window.dispatchEvent(new Event('focus'));
      window.scrollBy(0, 1);
      window.scrollBy(0, -1);
      sendSessionAction('trusted-activity', 'synthetic');
    } catch (_) {}
  }

  async function beaconKeepalive() {
    try {
      const response = await fetch(location.origin + '/', { method: 'HEAD', cache: 'no-store', credentials: 'include' });
      if (!response.ok) throw new Error(String(response.status));
    } catch (_) {
      try {
        await fetch(location.href, { method: 'GET', cache: 'no-store', credentials: 'include' });
      } catch (error) {
        sendSessionAction('beacon-failed', error && error.message);
        return;
      }
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
    if (!data || typeof data.source !== 'string' || !data.source.startsWith('baccarat-bridge-bg-')) return;
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
    window.postMessage({ kind: 'baccarat-bg-content-ready' }, '*');
  } catch (_) {}

  sendSessionAction('trusted-activity', 'bg-content-boot');
  scan();
  setInterval(scan, SCAN_INTERVAL_MS);
  setInterval(() => {
    syntheticKeepalive();
    void beaconKeepalive();
  }, KEEPALIVE_INTERVAL_MS);
})();
