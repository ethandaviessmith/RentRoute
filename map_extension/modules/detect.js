// modules/detect.js — address detection (auto-detect + click-to-pick)
// autoDetectInfo() → { text, selector, isSaved } | null
// pickAddressWithSelector() → Promise<{ text, selector }>

import { createLogger }   from './logger.js';
import { getSavedSelector } from './state.js';

const log = createLogger('detect');

// ── Per-site auto-detect selectors ───────────────────────────────────────────
// Each entry: { test: (hostname) => bool, selectors: string[] }
// First matching element's trimmed textContent is used.
// Optional `combine`: array of selector-arrays; all elements' text is joined
// with ", " to form one address (for sites that split street / city across tags).
const SITE_RULES = [
  {
    test: h => h.includes('zillow.com'),
    // Zillow often splits street into h1 and city/state/zip into p
    combine: [
      ['[data-test-id="bdp-building-title"]', '[data-test-id="bdp-building-address"]'],
      ['[data-testid="bdp-building-title"]',  '[data-testid="bdp-building-address"]'],
    ],
    selectors: [
      '[data-test-id="bdp-building-address"]',
      '[data-testid="bdp-building-address"]',
      'h1[class*="summary-container"]',
      '.building-address',
      '[class*="AddressChiclet"]',
    ],
  },
  {
    test: h => h.includes('apartments.com'),
    // Street is in .delivery-address h1, city/state/zip in h2 inside the same container
    combine: [
      ['.delivery-address h1', '.propertyAddressContainer h2'],
      ['#propertyAddressRow h1', '#propertyAddressRow h2'],
    ],
    selectors: [
      '.propertyAddressContainer',
      '.propertyAddress',
      '[class*="address"]',
    ],
  },
  {
    test: h => h.includes('realtor.com'),
    selectors: [
      '[data-testid="street-address"]',
      '[data-testid="address"]',
      '.address-wrapper',
      '[class*="address"]',
    ],
  },
  {
    test: h => h.includes('padmapper.com'),
    selectors: [
      '[class*="ListingAddress"]',
      '[class*="AddressLine"]',
      '[class*="address"]',
      'h1',
    ],
  },
];

/**
 * Attempt to read the listing address automatically from the current page.
 * Checks the saved selector for this hostname first; falls back to SITE_RULES.
 * @returns {{ text: string, selector: string, isSaved: boolean }|null}
 */
export function autoDetectInfo() {
  const host = location.hostname;

  // 1. Try the user's saved selector for this site
  const saved = getSavedSelector(host);
  if (saved) {
    const el = document.querySelector(saved);
    const text = el?.innerText?.trim() ?? el?.textContent?.trim() ?? '';
    if (text.length > 4) {
      log.info('autoDetect: used saved selector', saved, '→', text);
      return { text, selector: saved, isSaved: true };
    }
    log.warn('autoDetect: saved selector matched nothing, falling through', saved);
  }

  // 2. Fall back to built-in per-site rules
  const rule = SITE_RULES.find(r => r.test(host));
  if (!rule) { log.debug('autoDetect: no rule for', host); return null; }

  // 2a. Try combine groups first (multi-element addresses)
  if (rule.combine) {
    for (const group of rule.combine) {
      const parts = group.map(sel => {
        const el = document.querySelector(sel);
        return (el?.innerText?.trim() ?? el?.textContent?.trim() ?? '');
      });
      // All parts must have content for a valid combined address
      if (parts.every(p => p.length > 0)) {
        const text = parts.join(', ').replace(/,\s*,/g, ',').trim();
        if (text.length > 4) {
          const selector = group.join(' + ');  // for display/logging only
          log.info('autoDetect: combined', group, '→', text);
          return { text, selector, isSaved: false };
        }
      }
    }
  }

  // 2b. Single-element selectors
  for (const sel of rule.selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = el.innerText?.trim() ?? el.textContent?.trim() ?? '';
      if (text.length > 4) {
        log.info('autoDetect: matched', sel, '→', text);
        return { text, selector: sel, isSaved: false };
      }
    }
  }
  log.debug('autoDetect: no selector matched on', host);
  return null;
}

/** Backward-compat wrapper — returns text string or null. */
export function autoDetect() {
  return autoDetectInfo()?.text ?? null;
}

// ── Click-to-pick mode ────────────────────────────────────────────────────────
let _pickActive = false;
let _overlay    = null;

/**
 * Enter click-to-pick mode. Resolves with { text, selector } on success.
 * @returns {Promise<{ text: string, selector: string }>}
 */
export function pickAddressWithSelector() {
  if (_pickActive) return Promise.reject(new Error('pick already active'));
  _pickActive = true;

  return new Promise((resolve, reject) => {
    _overlay = document.createElement('div');
    _overlay.id = 'rentroute-pick-overlay';
    _overlay.innerHTML = `
      <div class="rr-pick-banner">
        🖱 Click the address on the page &nbsp;&mdash;&nbsp;
        <kbd>Esc</kbd> to cancel
      </div>`;
    document.body.appendChild(_overlay);
    document.body.style.cursor = 'crosshair';

    function cleanup() {
      _pickActive = false;
      document.body.style.cursor = '';
      _overlay?.remove();
      _overlay = null;
      document.removeEventListener('click',   onClick,   { capture: true });
      document.removeEventListener('keydown', onKeydown, { capture: true });
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      const el   = e.target;
      const text = _extractAddress(el);
      const selector = generateSelector(el);
      cleanup();
      if (text) {
        log.info('pick resolved:', text, '— selector:', selector);
        resolve({ text, selector });
      } else {
        reject(new Error('clicked element had no readable text'));
      }
    }

    function onKeydown(e) {
      if (e.key === 'Escape') { cleanup(); reject(new Error('cancelled')); }
    }

    document.addEventListener('click',   onClick,   { capture: true });
    document.addEventListener('keydown', onKeydown, { capture: true });
  });
}

/** Backward-compat wrapper — returns text string Promise. */
export function pickAddress() {
  return pickAddressWithSelector().then(r => r.text);
}

// ── CSS selector generator ────────────────────────────────────────────────────
/**
 * Generate a stable CSS selector for a DOM element.
 * Prefers data-testid / id / aria-label; falls back to tag+class or nth-child.
 */
export function generateSelector(el) {
  if (!el || el === document.body) return 'body';

  // 1. Stable data attributes (most reliable across re-renders)
  for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
    const val = el.getAttribute(attr);
    if (val) {
      const sel = `[${attr}="${val.replace(/"/g, '\\"')}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
  }

  // 2. ID (skip numeric-only or very short IDs — often dynamic)
  if (el.id && el.id.length > 2 && !/^\d+$/.test(el.id)) {
    try {
      const sel = `#${CSS.escape(el.id)}`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    } catch {}
  }

  // 3. aria-label
  const al = el.getAttribute('aria-label');
  if (al) {
    const sel = `[aria-label="${al.replace(/"/g, '\\"')}"]`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }

  // 4. Stable class names (filter out hashed/likely-dynamic classes)
  const stableClasses = [...el.classList].filter(c =>
    c.length > 2 && c.length < 50 &&
    !/^[a-z]-[A-Za-z0-9]{4,}$/.test(c) &&    // Tailwind-style hashed
    !/[a-z]{2,}\d{4,}/.test(c)                 // e.g. styledComponents abc1234
  );
  if (stableClasses.length) {
    const tag = el.tagName.toLowerCase();
    const cls = stableClasses.slice(0, 2).map(c => { try { return `.${CSS.escape(c)}`; } catch { return ''; } }).join('');
    if (cls) {
      const sel = tag + cls;
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {}
    }
  }

  // 5. nth-child path (reliable but page-layout–dependent)
  return _buildNthPath(el);
}

function _buildNthPath(el, depth = 0) {
  if (!el || el === document.body || depth > 5) return el?.tagName?.toLowerCase() ?? '*';
  const parent = el.parentElement;
  if (!parent) return el.tagName.toLowerCase();
  const tag  = el.tagName.toLowerCase();
  const sameTagSiblings = [...parent.children].filter(c => c.tagName === el.tagName);
  const step = sameTagSiblings.length > 1
    ? `${tag}:nth-of-type(${sameTagSiblings.indexOf(el) + 1})`
    : tag;
  if (!parent.parentElement || parent === document.body) return step;
  return `${_buildNthPath(parent, depth + 1)} > ${step}`;
}

/**
 * Extract the most useful text from a clicked element.
 * Walks up to 3 levels up looking for a non-trivial text node.
 */
// ── SPA address watcher ───────────────────────────────────────────────────────
let _watchTimer = null;
let _lastWatchText = null;
let _lastWatchUrl  = null;

/**
 * Start polling for address changes (SPA navigation).
 * @param {(text: string, info: object) => void} callback — called when detected address changes
 * @param {number} intervalMs — poll interval (default 2 000 ms)
 */
export function watchAddress(callback, intervalMs = 2000) {
  stopWatching();
  _lastWatchUrl  = location.href;
  _lastWatchText = autoDetectInfo()?.text ?? null;

  _watchTimer = setInterval(() => {
    const currentUrl = location.href;
    const urlChanged = currentUrl !== _lastWatchUrl;
    if (urlChanged) _lastWatchUrl = currentUrl;

    const info = autoDetectInfo();
    const text = info?.text ?? null;

    if (text && (text !== _lastWatchText || urlChanged)) {
      log.info('watchAddress: change detected', { from: _lastWatchText, to: text, urlChanged });
      _lastWatchText = text;
      callback(text, info);
    }
  }, intervalMs);
  log.debug('watchAddress started, interval', intervalMs);
}

/** Stop the address watcher. */
export function stopWatching() {
  if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
}

function _extractAddress(el) {
  let node = el;
  for (let i = 0; i < 4; i++) {
    if (!node) break;
    const text = (node.innerText ?? node.textContent ?? '').trim();
    // Accept if it looks like it might be an address (has a digit + some words)
    if (text.length > 5 && /\d/.test(text) && text.length < 200) {
      return text;
    }
    node = node.parentElement;
  }
  // Fall back to just whatever innerText the original element has
  return (el.innerText ?? el.textContent ?? '').trim() || null;
}
