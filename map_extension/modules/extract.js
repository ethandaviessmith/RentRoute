// modules/extract.js — extract size, type, rent from a listing page.
// Returns { size, type, rent } where any field may be '' (string) or 0 (rent).
//   size: normalized "<beds> bd + <baths> bath" (e.g. "3 bd + 1.5 bath")
//   type: one of "Apartment" | "Condo" | "Townhouse" | "House" |
//                "2 Stack Apt" | "3 Stack Apt" | "Duplex" | "" (default "Apartment")
//   rent: integer dollars (high end of any range), 0 if not found

import { createLogger } from './logger.js';
const log = createLogger('extract');

// ── Site rules ───────────────────────────────────────────────────────────────
// Each rule provides selectors for rent, beds, baths, type, plus an optional
// `descriptionSelectors` block whose combined text is keyword-scanned for
// stack/duplex inference.
const SITE_RULES = [
  {
    test: h => h.includes('zillow.com'),
    rent:  ['[data-testid="price"]', 'span[data-test="property-card-price"]', '[class*="Price"]'],
    beds:  ['[data-testid="bed-bath-beyond"] [data-testid*="bed"]'],
    baths: ['[data-testid="bed-bath-beyond"] [data-testid*="bath"]'],
    bedsBathsCombined: ['[data-testid="bed-bath-beyond"]'],
    typeText: ['[data-testid="home-type"]', '[class*="home-type"]'],
    descriptionSelectors: [
      '[data-testid="description"]',
      '[class*="Description"]',
      'h1',
    ],
  },
  {
    test: h => h.includes('apartments.com'),
    rent:  ['.priceBedRangeInfo .rentInfoDetail', '.propertyRent', '.rentRollup'],
    bedsBathsCombined: ['.priceBedRangeInfoInnerContainer', '.bedBathContainer', '.priceBedRangeInfo'],
    typeText: ['.propertyTypeContainer', '[class*="propertyType"]'],
    descriptionSelectors: [
      '#descriptionSection',
      '.descriptionSection',
      'h1',
      '.propertyName',
    ],
  },
  {
    test: h => h.includes('realtor.com'),
    rent:  ['[data-testid="price"]', '[data-label="property-price"]', '[class*="Price"]'],
    beds:  ['[data-testid="property-meta-beds"]'],
    baths: ['[data-testid="property-meta-baths"]'],
    typeText: ['[data-testid="property-type"]', '[data-label="property-type"]'],
    descriptionSelectors: [
      '[data-testid="description"]',
      '[class*="description"]',
      'h1',
    ],
  },
  {
    test: h => h.includes('padmapper.com'),
    rent:  ['.ListingPrice_price', '[class*="ListingPrice"]', '[class*="price"]'],
    bedsBathsCombined: [
      '[class*="Summary"]',
      '[class*="ListingDetails"]',
      '[class*="bedrooms"]',
    ],
    typeText: ['[class*="propertyType"]', '[class*="PropertyType"]'],
    descriptionSelectors: [
      '[class*="ListingDescription"]',
      '[class*="description"]',
      'h1',
      'title',
    ],
  },
];

// ── Public API ───────────────────────────────────────────────────────────────
export function extractListingInfo() {
  const host = location.hostname;
  const rule = SITE_RULES.find(r => r.test(host));

  const result = { size: '', type: '', rent: 0 };

  if (!rule) {
    log.debug('no extract rule for', host);
    return result;
  }

  // ── Rent ────────────────────────────────────────────────────────────────
  const rentText = _firstText(rule.rent);
  if (rentText) {
    result.rent = _parseRent(rentText);
    log.debug('rent:', rentText, '→', result.rent);
  }

  // ── Size (beds + baths) ────────────────────────────────────────────────
  let beds = null, baths = null;
  if (rule.beds)  beds  = _parseNumberWithUnit(_firstText(rule.beds), /bed|bd|br/i);
  if (rule.baths) baths = _parseNumberWithUnit(_firstText(rule.baths), /bath|ba\b/i);

  // Fall back to combined block if either missing
  if ((!beds || !baths) && rule.bedsBathsCombined) {
    const combined = _firstText(rule.bedsBathsCombined);
    if (combined) {
      if (!beds)  beds  = _parseNumberWithUnit(combined, /bed|bd|br/i);
      if (!baths) baths = _parseNumberWithUnit(combined, /bath|ba\b/i);
    }
  }

  // Last-resort: scan body text near the price
  if (!beds || !baths) {
    const bodyText = document.body.innerText.slice(0, 5000); // cap for perf
    if (!beds)  beds  = _parseNumberWithUnit(bodyText, /bed|bd|br/i);
    if (!baths) baths = _parseNumberWithUnit(bodyText, /bath|ba\b/i);
  }

  if (beds || baths) {
    const bedStr  = beds  != null ? `${_fmtNum(beds)} bd`     : '? bd';
    const bathStr = baths != null ? `${_fmtNum(baths)} bath`  : '? bath';
    result.size = `${bedStr} + ${bathStr}`;
    log.debug('size:', result.size);
  }

  // ── Type ───────────────────────────────────────────────────────────────
  const typeRaw = _firstText(rule.typeText) || '';
  const descText = (rule.descriptionSelectors ? _allText(rule.descriptionSelectors) : '') + ' ' +
                   (document.title || '');
  result.type = _categorizeType(typeRaw, descText);
  log.debug('type:', `raw="${typeRaw}"`, '→', result.type);

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _firstText(selectors) {
  if (!selectors) return '';
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const txt = el?.innerText?.trim() ?? el?.textContent?.trim() ?? '';
    if (txt) return txt;
  }
  return '';
}

function _allText(selectors) {
  const out = [];
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      const t = el.innerText?.trim() ?? el.textContent?.trim() ?? '';
      if (t) out.push(t);
    });
  }
  return out.join(' ').slice(0, 5000); // cap
}

/** Parse "$2,800 - $3,000/mo" → 3000 (high end). Returns 0 if none. */
function _parseRent(text) {
  // Find all $-prefixed numbers OR bare 4-digit-ish numbers
  const matches = text.match(/\$?\s*\d[\d,]{2,}/g) || [];
  const nums = matches
    .map(m => parseInt(m.replace(/[^\d]/g, ''), 10))
    .filter(n => n >= 300 && n <= 50000); // sanity range for monthly rent
  if (!nums.length) return 0;
  return Math.max(...nums); // high end of range
}

/**
 * Find a number that appears alongside the given unit regex.
 * e.g. _parseNumberWithUnit("3 bd, 1.5 bath", /bath/) → 1.5
 */
function _parseNumberWithUnit(text, unitRe) {
  if (!text) return null;
  // Match: <number> [whitespace/words<8 chars] <unit>
  // Using a permissive pattern: number followed within ~12 chars by unit keyword
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:[^\\d\\n]{0,12}?)?(${unitRe.source})`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function _fmtNum(n) {
  // Drop trailing .0 (3.0 → "3", 1.5 → "1.5")
  return n % 1 === 0 ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

/**
 * Categorize property type. Defaults to "Apartment" when unknown.
 * Heuristics for stack/duplex inference scan typeRaw + description text.
 */
function _categorizeType(typeRaw, descText) {
  const all = `${typeRaw} ${descText}`.toLowerCase();

  // Stack (triple-decker / multi-family) detection — check FIRST so it overrides
  // a generic "Apartment" / "Multi-Family" classification.
  if (/triple[\s-]?decker|3[\s-]?decker|three[\s-]?decker|3[\s-]?family|three[\s-]?family/.test(all)) {
    return '3 Stack Apt';
  }
  if (/two[\s-]?family|2[\s-]?family|2[\s-]?decker|two[\s-]?decker/.test(all)) {
    return '2 Stack Apt';
  }
  if (/\bduplex\b/.test(all)) {
    return 'Duplex';
  }
  if (/\bmulti[\s-]?family\b/.test(all)) {
    // Generic multi-family without unit count → guess 3-stack (most common in Boston)
    return '3 Stack Apt';
  }

  // Direct site-category mapping
  const t = typeRaw.toLowerCase();
  if (/townhouse|townhome|row\s?house/.test(t)) return 'Townhouse';
  if (/single[\s-]?family|house/.test(t))       return 'House';
  if (/condo/.test(t))                          return 'Condo';
  if (/apartment|apt/.test(t))                  return 'Apartment';

  // Default
  return 'Apartment';
}
