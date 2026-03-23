// modules/state.js — wraps chrome.storage.sync for destinations and API key
// API key is loaded from keys.js (access-controlled) but can be overridden
// via chrome.storage.sync for development / other key scenarios.

import { createLogger } from './logger.js';
const log = createLogger('state');

// ── Try importing bundled key (may be absent in some environments) ──────────
let _bundledKey = '';
try {
  const keysUrl = new URL('../keys.js', import.meta.url).href;
  const keysMod = await import(keysUrl);
  _bundledKey = keysMod.HERE_API_KEY ?? '';
} catch {
  log.debug('keys.js not found — falling back to stored key');
}

// ── in-memory cache (populated by init()) ──────────────────────────────────
let _cache = {
  apiKey: '',
  destinations: [],   // [{ id, label, address, lat, lon, mode }]
  savedSelectors: {}, // { hostname: cssSelector }
};

const _subs = new Set();

function _notify() {
  for (const fn of _subs) {
    try { fn(_cache); } catch (e) { log.error('subscriber threw', e); }
  }
}

// ── init: load from storage once ───────────────────────────────────────────
export async function initState() {
  const data = await chrome.storage.sync.get(['apiKey', 'destinations']);
  // Prefer bundled key from keys.js; fall back to stored key
  _cache.apiKey       = _bundledKey || data.apiKey || '';
  _cache.destinations = data.destinations ?? [];

  // Saved selectors live in local storage (device-specific, not synced)
  const local = await chrome.storage.local.get('rr_saved_selectors');
  _cache.savedSelectors = local.rr_saved_selectors ?? {};

  log.info('state loaded', _cache);
}

// ── accessors ───────────────────────────────────────────────────────────────
export function getApiKey()          { return _cache.apiKey; }
export function getDestinations()    { return _cache.destinations; }
export function getSavedSelector(h)  { return _cache.savedSelectors[h] ?? null; }

// ── saved selector mutators ──────────────────────────────────────────────────
export async function setSavedSelector(hostname, selector) {
  _cache.savedSelectors[hostname] = selector;
  await chrome.storage.local.set({ rr_saved_selectors: _cache.savedSelectors });
  log.info('saved selector for', hostname, ':', selector);
}

export async function clearSavedSelector(hostname) {
  delete _cache.savedSelectors[hostname];
  await chrome.storage.local.set({ rr_saved_selectors: _cache.savedSelectors });
  log.info('cleared saved selector for', hostname);
}

// ── mutators ─────────────────────────────────────────────────────────────────
export async function setApiKey(key) {
  _cache.apiKey = key;
  await chrome.storage.sync.set({ apiKey: key });
  _notify();
}

export async function setDestinations(dests) {
  _cache.destinations = dests;
  await chrome.storage.sync.set({ destinations: dests });
  log.debug('destinations saved', dests);
  _notify();
}

export async function addDestination(dest) {
  const updated = [..._cache.destinations, dest];
  await setDestinations(updated);
}

export async function removeDestination(id) {
  const updated = _cache.destinations.filter(d => d.id !== id);
  await setDestinations(updated);
}

export async function updateDestination(id, patch) {
  const updated = _cache.destinations.map(d => d.id === id ? { ...d, ...patch } : d);
  await setDestinations(updated);
}

// ── subscriptions ────────────────────────────────────────────────────────────
export function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}
