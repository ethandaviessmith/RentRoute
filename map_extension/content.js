// content.js — entry point injected into listing pages
// MV3 content scripts cannot use static `import`.
// All module loading uses dynamic import() with chrome.runtime.getURL().

// Minimal raw logger until logger.js loads
const _raw = (...a) => console.log('[RR:content]', ...a);
let log = { info: _raw, warn: _raw, error: _raw, debug: _raw };

let _mods = null;

async function loadModules() {
  if (_mods) return _mods;
  const base = chrome.runtime.getURL('modules/');
  const [loggerMod, stateMod, apiMod, detectMod, panelMod] = await Promise.all([
    import(base + 'logger.js'),
    import(base + 'state.js'),
    import(base + 'api.js'),
    import(base + 'detect.js'),
    import(base + 'panel.js'),
  ]);
  _mods = { loggerMod, stateMod, apiMod, detectMod, panelMod };
  return _mods;
}

(async function main() {
  _raw('RentRoute content script starting', location.href);

  // 1. Load Leaflet into the ISOLATED world (same world as content script modules)
  _raw('window.L before inject:', typeof window.L);
  await _loadLeaflet();
  _raw('window.L after inject:', typeof window.L, '— keys:', window.L ? Object.keys(window.L).slice(0, 5) : 'N/A');

  // 2. Dynamic-import all modules
  const { loggerMod, stateMod, apiMod, detectMod, panelMod } = await loadModules();
  log = loggerMod.createLogger('content');

  // 3. Initialise persisted state
  await stateMod.initState();

  // 4. Inject floating panel
  panelMod.injectPanel();

  // 5. Auto-detect address on page load
  const info = detectMod.autoDetectInfo();
  if (info) {
    log.info('auto-detected on load:', info.text, '| isSaved:', info.isSaved);
    // If this match came from a fresh site-rule (not a saved selector), save it
    if (!info.isSaved) {
      await stateMod.setSavedSelector(location.hostname, info.selector);
      log.info('auto-saved selector on first match:', info.selector);
    }
    await panelMod.refreshCards(info.text);
  }

  // 6. Start SPA address watcher — polls for URL / DOM content changes
  detectMod.watchAddress(async (text, watchInfo) => {
    log.info('SPA address change detected:', text);
    if (!watchInfo.isSaved && watchInfo.selector) {
      await stateMod.setSavedSelector(location.hostname, watchInfo.selector);
    }
    apiMod.clearRouteCache();
    await panelMod.refreshCards(text);
  });

  // 7. Re-render cards whenever destinations change in storage
  stateMod.subscribe(() => {
    apiMod.clearRouteCache();
    panelMod.refreshCards(null);   // keep existing origin, re-fetch routes
  });

  // 8. Message handler — popup can trigger a re-detect
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'redetect') {
      const info = detectMod.autoDetectInfo();
      if (info) panelMod.refreshCards(info.text);
      sendResponse({ ok: true });
    }
    return false;
  });

  log.info('RentRoute ready');
})();

// ── Leaflet loader ───────────────────────────────────────────────────────────
// Content scripts run in the ISOLATED world. A <script> tag injection lands in
// the MAIN world where window.L is invisible to our modules.
// Solution: ask background to executeScript into the ISOLATED world instead.
async function _loadLeaflet() {
  if (window.L) { _raw('Leaflet already present, skipping inject'); return; }
  _raw('Sending injectLeaflet to background…');
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ action: 'injectLeaflet' });
  } catch (e) {
    _raw('ERROR: injectLeaflet message threw:', e?.message);
    return;
  }
  _raw('injectLeaflet response:', JSON.stringify(resp));
  _raw('window.L immediately after response:', typeof window.L);
}
