// modules/panel.js — floating side panel DOM management

import { createLogger }        from './logger.js';
import { getDestinations, getSavedSelector, setSavedSelector, clearSavedSelector } from './state.js';
import { geocode, getRoute }   from './api.js';
import { initMap }             from './map.js';
import { autoDetectInfo, pickAddressWithSelector, watchAddress } from './detect.js';
import { extractListingInfo } from './extract.js';

const log = createLogger('panel');

const PANEL_ID   = 'rentroute-panel';
const MODE_ICON  = { drive: '🚗', walk: '🚶', bike: '🚴', transit: '🚌' };
const MODE_LABEL = { drive: 'Drive', walk: 'Walk', bike: 'Bike', transit: 'Transit' };

// Active map instances so we can destroy on re-render
const _mapInstances = [];

let _panel         = null;
let _currentAddr   = null;
let _currentCoords = null;
let _minimised     = false;
let _isSavedSel    = false;   // true when the current address came from a saved selector
let _renderedKey   = null;    // fingerprint of last rendered state (addr + dests)

// Latest commute results, keyed by destination label (e.g. "Harvard", "Work")
// { [label]: { durationMin, mode } }
let _lastRoutes = {};

// Lazy-loaded sheets config (from keys.js)
let _sheetsCfg = null;
async function _getSheetsCfg() {
  if (_sheetsCfg !== null) return _sheetsCfg;
  try {
    const url  = new URL('../keys.js', import.meta.url).href;
    const mod  = await import(url);
    _sheetsCfg = {
      url:    mod.SHEETS_WEBAPP_URL || '',
      secret: mod.SHEETS_SECRET     || '',
    };
  } catch {
    _sheetsCfg = { url: '', secret: '' };
  }
  return _sheetsCfg;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function injectPanel() {
  if (document.getElementById(PANEL_ID)) return;

  _panel = document.createElement('div');
  _panel.id = PANEL_ID;
  _panel.innerHTML = _buildPanelHTML();
  document.body.appendChild(_panel);

  _makeDraggable(_panel.querySelector('.rr-panel-header'));
  _bindHeaderButtons();

  // Reflect any pre-existing saved selector for this site
  const hasSaved = !!getSavedSelector(location.hostname);
  if (hasSaved) { _isSavedSel = true; _updateSavedBadge(true); }

  log.info('panel injected');
}

export function removePanel() {
  _destroyMaps();
  document.getElementById(PANEL_ID)?.remove();
  _panel = null;
}

/** Force next refreshCards() to re-render even if fingerprint matches. */
export function invalidateRenderedKey() {
  _renderedKey = null;
}

/** Re-render commute cards for the current origin address. */
export async function refreshCards(address) {
  if (!_panel) return;
  if (address) {
    _currentAddr   = address;
    _currentCoords = null;
  }
  // Keep badge in sync whenever cards refresh
  _updateSavedBadge(!!getSavedSelector(location.hostname));
  if (!_currentAddr) {
    _setAddressDisplay('(no address detected)');
    return;
  }
  _setAddressDisplay(_currentAddr);

  // Build a fingerprint of (address + destinations); skip re-render if unchanged
  const dests = getDestinations();
  const renderKey = JSON.stringify({
    addr: _currentAddr,
    dests: dests.map(d => `${d.id}|${d.address}|${d.mode}`),
  });
  if (renderKey === _renderedKey) {
    log.debug('refreshCards: skipping — nothing changed');
    return;
  }

  _setCardsLoading();

  // Geocode origin
  if (!_currentCoords) {
    _currentCoords = await geocode(_currentAddr);
    if (!_currentCoords) {
      _setCardsError('Could not geocode listing address.');
      return;
    }
  }

  if (!dests.length) {
    _setCardsEmpty();
    _renderedKey = renderKey;
    return;
  }

  const container = _panel.querySelector('.rr-cards');
  container.innerHTML = '';
  _destroyMaps();
  _lastRoutes = {};

  for (const dest of dests) {
    const card = _makeCardSkeleton(dest);
    container.appendChild(card);
    _loadCard(card, dest);
  }

  _renderedKey = renderKey;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _buildPanelHTML() {
  return `
    <div class="rr-panel-header">
      <span class="rr-panel-title">🗺 RentRoute</span>
      <div class="rr-panel-btns">
        <button class="rr-btn-icon" id="rr-btn-min"  title="Minimise">─</button>
        <button class="rr-btn-icon" id="rr-btn-close" title="Close">✕</button>
      </div>
    </div>
    <div class="rr-panel-body">
      <div class="rr-detect-row">
        <button id="rr-btn-detect" title="Detect or pick listing address">
          🏠 Detect Address
        </button>
        <span id="rr-address-display" class="rr-address-text">—</span>
        <button id="rr-btn-refresh" class="rr-btn-refresh" title="Re-detect address">↻</button>
        <button id="rr-btn-clear-detect" class="rr-detect-clear" title="Clear saved detection for this site" style="display:none">
          ✕ saved
        </button>
      </div>
      <div class="rr-cards"></div>
      <button id="rr-btn-export" class="rr-btn-settings" title="Append this listing to Google Sheet">
        📤 Export to Sheet
      </button>
      <span id="rr-export-status" class="rr-address-text" style="display:block;text-align:center;margin-top:4px;"></span>
      <button id="rr-btn-settings" class="rr-btn-settings">⚙ Manage Destinations</button>
    </div>`;
}

function _bindHeaderButtons() {
  _panel.querySelector('#rr-btn-close').addEventListener('click', () => removePanel());

  _panel.querySelector('#rr-btn-min').addEventListener('click', () => {
    _minimised = !_minimised;
    _panel.querySelector('.rr-panel-body').style.display = _minimised ? 'none' : '';
    _panel.querySelector('#rr-btn-min').textContent = _minimised ? '▢' : '─';
  });

  _panel.querySelector('#rr-btn-detect').addEventListener('click', async () => {
    const btn = _panel.querySelector('#rr-btn-detect');
    btn.disabled = true;

    // 1. Try auto-detect (checks saved selector first, then site rules)
    let info = autoDetectInfo();
    if (info) {
      log.info('auto-detected:', info.text, '| isSaved:', info.isSaved);
      // Save selector if this is a new site-rule match (not already saved)
      if (!info.isSaved) {
        await setSavedSelector(location.hostname, info.selector);
        log.info('saved selector for future use:', info.selector);
      }
      btn.disabled = false;
      _isSavedSel = true;
      _updateSavedBadge(true);
      await refreshCards(info.text);
      return;
    }

    // 2. Fall back to click-to-pick
    _setAddressDisplay('Click any address on the page…');
    let picked;
    try {
      picked = await pickAddressWithSelector();
    } catch (e) {
      _setAddressDisplay(_currentAddr ?? '(cancelled)');
      btn.disabled = false;
      return;
    }

    // Save the generated selector for future page loads
    await setSavedSelector(location.hostname, picked.selector);
    log.info('saved picked selector:', picked.selector);

    btn.disabled = false;
    _isSavedSel = true;
    _updateSavedBadge(true);
    await refreshCards(picked.text);
  });

  _panel.querySelector('#rr-btn-refresh').addEventListener('click', async () => {
    const info = autoDetectInfo();
    if (info) {
      log.info('manual refresh:', info.text);
      await refreshCards(info.text);
    } else {
      log.warn('refresh: could not detect address');
    }
  });

  _panel.querySelector('#rr-btn-clear-detect').addEventListener('click', async () => {
    await clearSavedSelector(location.hostname);
    _isSavedSel = false;
    _updateSavedBadge(false);
    log.info('cleared saved selector for', location.hostname);
  });

  _panel.querySelector('#rr-btn-settings').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openSettings' });
  });

  _panel.querySelector('#rr-btn-export').addEventListener('click', _onExportClick);
}

async function _onExportClick() {
  const btn      = _panel.querySelector('#rr-btn-export');
  const statusEl = _panel.querySelector('#rr-export-status');
  const setStatus = (msg, isErr = false) => {
    statusEl.textContent = msg;
    statusEl.style.color = isErr ? '#c00' : '#080';
  };

  if (!_currentAddr) {
    setStatus('⚠ No address detected', true);
    return;
  }

  const cfg = await _getSheetsCfg();
  if (!cfg.url || !cfg.secret) {
    setStatus('⚠ Sheets not configured (keys.js)', true);
    return;
  }

  // Find Harvard / Work commute strings (case-insensitive label match)
  const findRoute = (name) => {
    const key = Object.keys(_lastRoutes).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? _lastRoutes[key] : null;
  };
  const fmt = (r) => r ? `${r.durationMin}m ${r.mode}` : '';

  // Extract size / type / rent from the page
  const info = extractListingInfo();
  log.info('extracted listing info:', info);

  const listing = {
    url:            location.href,
    address:        _currentAddr,
    size:           info.size || '',
    type:           info.type || '',
    rent:           info.rent || '',
    sqft:           info.sqft || '',
    commuteHarvard: fmt(findRoute('Harvard')),
    commuteWork:    fmt(findRoute('Work')),
  };

  btn.disabled = true;
  setStatus('Sending…');
  log.info('exporting to sheet', listing);

  try {
    // Use text/plain to avoid CORS preflight (Apps Script doPost still parses JSON)
    const res = await fetch(cfg.url, {
      method:   'POST',
      headers:  { 'Content-Type': 'text/plain;charset=utf-8' },
      body:     JSON.stringify({
        secret:   cfg.secret,
        listings: [listing],
      }),
      redirect: 'follow',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    setStatus(`✓ Added ${data.appended ?? 1} row`);
    log.info('export ok', data);
  } catch (err) {
    log.error('export failed', err);
    setStatus('⚠ Export failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function _makeCardSkeleton(dest) {
  const card = document.createElement('div');
  card.className = 'rr-card rr-card--loading';
  card.dataset.destId = dest.id;
  card.innerHTML = `
    <div class="rr-card-header">
      <span class="rr-card-icon">${MODE_ICON[dest.mode] ?? '📍'}</span>
      <span class="rr-card-label">${_esc(dest.label || dest.address)}</span>
      <span class="rr-card-mode">${MODE_LABEL[dest.mode] ?? dest.mode}</span>
    </div>
    <div class="rr-card-map-wrap"><div class="rr-card-map"></div></div>
    <div class="rr-card-stats">
      <span class="rr-skeleton">Loading…</span>
    </div>`;
  return card;
}

async function _loadCard(card, dest) {
  log.debug('_loadCard — dest:', dest.label, '| mode:', dest.mode,
            '| stored coords:', dest.lat != null ? `${dest.lat},${dest.lon}` : 'none');
  // Ensure destination has coordinates
  let destCoords = dest.lat != null ? { lat: dest.lat, lon: dest.lon } : null;
  if (!destCoords) {
    destCoords = await geocode(dest.address);
    if (!destCoords) {
      _cardError(card, 'Could not geocode destination');
      return;
    }
  }

  log.debug('calling getRoute — origin:', _currentCoords, '| dest:', destCoords, '| mode:', dest.mode);
  const route = await getRoute(_currentCoords, destCoords, dest.mode);
  log.debug('getRoute result:', route
    ? `durationMin=${route.durationMin} distanceMi=${route.distanceMi} fromCache=${route.fromCache} isFallback=${route.isFallback} blocked=${route.blocked}`
    : 'null');
  if (!route) {
    _cardError(card, 'Route unavailable');
    return;
  }
  if (route.blocked) {
    _cardError(card, route.reason);
    return;
  }

  // Record for export
  _lastRoutes[dest.label || dest.address] = {
    durationMin: route.durationMin,
    distanceMi:  route.distanceMi,
    mode:        dest.mode,
  };

  card.classList.remove('rr-card--loading');

  // Stats
  const statsEl = card.querySelector('.rr-card-stats');
  let transitHTML = '';
  if (route.transitDetails) {
    const td = route.transitDetails;
    // Build per-leg breakdown (including walking)
    const legItems = td.legs.map(leg => {
      const durMin = Math.round(leg.duration / 60);
      const isWalk = (leg.mode === 'pedestrian' || leg.mode === 'walk' || leg.type === 'pedestrian');
      if (isWalk) {
        const distFt = leg.length ? Math.round(leg.length * 3.281) : null;
        const distTxt = distFt ? ` (${distFt >= 1000 ? (distFt / 5280).toFixed(1) + ' mi' : distFt + ' ft'})` : '';
        const toStop = leg.arrivalStop ? ` \u2192 ${_esc(leg.arrivalStop)}` : '';
        return `<div class="rr-leg rr-leg--walk">\ud83d\udeb6 Walk ${durMin} min${distTxt}${toStop}</div>`;
      }
      // Transit leg
      const icon = _transitIcon(leg.category ?? leg.mode);
      const label = leg.shortName || leg.name || leg.mode;
      const headTxt = leg.headsign ? ` \u2192 ${_esc(leg.headsign)}` : '';
      const stopsTxt = leg.numStops > 0 ? ` \u00b7 ${leg.numStops} stop${leg.numStops !== 1 ? 's' : ''}` : '';
      const fromTo = (leg.departureStop || leg.arrivalStop)
        ? `<div class="rr-leg-stops-detail">${leg.departureStop ? _esc(leg.departureStop) : ''} \u2192 ${leg.arrivalStop ? _esc(leg.arrivalStop) : ''}</div>` : '';
      return `<div class="rr-leg rr-leg--transit">${icon} <strong>${_esc(label)}</strong>${headTxt} \u2014 ${durMin} min${stopsTxt}${fromTo}</div>`;
    }).join('');

    transitHTML = `
      <div class="rr-transit-legs">${legItems}</div>
      <span class="rr-transit-info">\ud83d\udd04 ${td.transfers} transfer${td.transfers !== 1 ? 's' : ''}</span>`;
  }
  statsEl.innerHTML = `
    <span>⏱ <strong>${route.durationMin} min</strong></span>
    <span>📏 ${route.distanceMi} mi</span>
    ${transitHTML}`;

  // Map
  const mapEl = card.querySelector('.rr-card-map');
  log.debug('about to initMap — mapEl in DOM:', document.body?.contains(mapEl), '| window.L:', typeof window.L);
  const instance = initMap(mapEl, _currentCoords, destCoords, route, dest.mode);
  if (instance) _mapInstances.push(instance);
}

function _cardError(card, msg) {
  card.classList.remove('rr-card--loading');
  card.classList.add('rr-card--error');
  card.querySelector('.rr-card-stats').textContent = '⚠ ' + msg;
  card.querySelector('.rr-card-map-wrap').style.display = 'none';
}

function _setAddressDisplay(text) {
  const el = _panel?.querySelector('#rr-address-display');
  if (el) el.textContent = text;
}

function _updateSavedBadge(show) {
  const btn = _panel?.querySelector('#rr-btn-clear-detect');
  if (btn) btn.style.display = show ? '' : 'none';
}

function _setCardsLoading() {
  const c = _panel?.querySelector('.rr-cards');
  if (c) c.innerHTML = '<div class="rr-loading-msg">Fetching commute data…</div>';
  _destroyMaps();
}

function _setCardsError(msg) {
  const c = _panel?.querySelector('.rr-cards');
  if (c) c.innerHTML = `<div class="rr-error-msg">⚠ ${_esc(msg)}</div>`;
}

function _setCardsEmpty() {
  const c = _panel?.querySelector('.rr-cards');
  if (c) c.innerHTML = `<div class="rr-empty-msg">No destinations configured.<br>Use ⚙ to add some.</div>`;
}

function _destroyMaps() {
  while (_mapInstances.length) {
    _mapInstances.pop()?.destroy?.();
  }
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _transitIcon(category) {
  const map = {
    bus: '🚌', busRapid: '🚍',
    subway: '🚇', metro: '🚇',
    lightRail: '🚈', rail: '🚆', train: '🚆',
    ferry: '⛴', cableCar: '🚡', monorail: '🚝',
  };
  return map[category] ?? '🚌';
}

// ── Draggable header ─────────────────────────────────────────────────────────
function _makeDraggable(handle) {
  let startX, startY, startLeft, startTop;

  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = _panel.getBoundingClientRect();
    startX    = e.clientX;
    startY    = e.clientY;
    startLeft = rect.left;
    startTop  = rect.top;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      _panel.style.left  = `${startLeft + dx}px`;
      _panel.style.top   = `${startTop  + dy}px`;
      _panel.style.right = 'auto';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}
