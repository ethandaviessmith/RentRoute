// modules/extract.js — extract size, type, rent, sqft from a listing page.
// Returns { size, type, rent, sqft } where any field may be '' (string) or 0.
//   size: normalized "<beds> bd + <baths> bath" (e.g. "3 bd + 1.5 bath")
//   type: one of "Apartment" | "Condo" | "Townhouse" | "House" |
//                "2 Stack Apt" | "3 Stack Apt" | "Duplex" | "" (default "Apartment")
//   rent: integer dollars (high end of any range), 0 if not found
//   sqft: integer square feet, 0 if not found

import { createLogger } from './logger.js';
const log = createLogger('extract');

// ── Site rules ───────────────────────────────────────────────────────────────
// Each rule provides selectors for rent, beds, baths, type, plus an optional
// `descriptionSelectors` block whose combined text is keyword-scanned for
// stack/duplex inference. `labels` maps a field to a label-text string used
// for label-then-sibling extraction (handles hashed CSS classes).
const SITE_RULES = [
  {
    test: h => h.includes('zillow.com'),
    rent:  ['[data-testid="price"]', 'span[data-test="property-card-price"]', '[class*="Price"]'],
    beds:  ['[data-testid="bed-bath-beyond"] [data-testid*="bed"]'],
    baths: ['[data-testid="bed-bath-beyond"] [data-testid*="bath"]'],
    sqft:  ['[data-testid="bed-bath-beyond"] [data-testid*="sqft"]', '[data-testid*="sqft"]'],
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
    sqft:  ['.priceBedRangeInfoInnerContainer .sqftAttr', '.sqftAttr'],
    // Summary header uses <h4>Square Feet</h4> + sibling div with "267 - 725 sq ft"
    labels: {
      sqft:  ['Square Feet', 'Sq Ft', 'Sqft'],
      rent:  ['Total Monthly Price', 'Monthly Rent'],
      beds:  ['Bedrooms', 'Bedroom'],
      baths: ['Bathrooms', 'Bathroom'],
    },
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
    sqft:  ['[data-testid="property-meta-sqft"]', '[data-label="property-meta-sqft"]'],
    typeText: ['[data-testid="property-type"]', '[data-label="property-type"]'],
    descriptionSelectors: [
      '[data-testid="description"]',
      '[class*="description"]',
      'h1',
    ],
  },
  {
    test: h => h.includes('padmapper.com'),
    // PadMapper's hashed class names break CSS selectors. Use label-based lookup
    // against the Details section: <h5>Price</h5>, <h5>Square Feet</h5>, etc.
    labels: {
      rent: ['Price'],
      sqft: ['Square Feet', 'Sq Ft', 'Sqft'],
      beds: ['Bedrooms'],
      baths: ['Bathrooms'],
    },
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

  const result = { size: '', type: '', rent: 0, sqft: 0 };

  if (!rule) {
    log.debug('no extract rule for', host);
    return result;
  }

  // ── Rent ────────────────────────────────────────────────────────────────
  let rentText = _firstText(rule.rent);
  if (!rentText && rule.labels?.rent) rentText = _firstByLabel(rule.labels.rent);
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

  // Label-based fallback (PadMapper)
  if ((!beds || !baths) && rule.labels) {
    if (!beds  && rule.labels.beds)  beds  = _parseNumberWithUnit(_firstByLabel(rule.labels.beds),  /bed|bd|br/i);
    if (!baths && rule.labels.baths) baths = _parseNumberWithUnit(_firstByLabel(rule.labels.baths), /bath|ba\b/i);
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

  // ── Sqft ────────────────────────────────────────────────────────────────
  let sqftText = _firstText(rule.sqft);
  if (!sqftText && rule.labels?.sqft) sqftText = _firstByLabel(rule.labels.sqft);
  // Body-text regex fallback (works on any site)
  if (!sqftText) sqftText = document.body.innerText.slice(0, 8000);
  result.sqft = _parseSqft(sqftText);
  log.debug('sqft →', result.sqft);

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

/**
 * Find an element whose text exactly matches one of the given label strings,
 * then return the trimmed text of the first sibling (or parent's other child)
 * that has meaningful content. Used for sites with hashed class names where
 * stable CSS selectors aren't available.
 */
function _firstByLabel(labels) {
  if (!labels || !labels.length) return '';
  const wanted = labels.map(l => l.toLowerCase());
  const candidates = document.querySelectorAll('h3, h4, h5, h6, dt, strong, b, span, div, p');
  for (const lbl of candidates) {
    const txt = (lbl.innerText ?? lbl.textContent ?? '').trim();
    if (!wanted.includes(txt.toLowerCase())) continue;
    // Try next sibling first, then other parent children
    const tryEls = [lbl.nextElementSibling, ...(lbl.parentElement?.children ?? [])];
    for (const cand of tryEls) {
      if (!cand || cand === lbl) continue;
      const v = (cand.innerText ?? cand.textContent ?? '').trim();
      if (v && v.length < 200 && !wanted.includes(v.toLowerCase())) {
        return v;
      }
    }
  }
  return '';
}

/** Parse "$2,800 - $3,000/mo" → 3000 (high end). Returns 0 if none. */
function _parseRent(text) {
  const matches = text.match(/\$?\s*\d[\d,]{2,}/g) || [];
  const nums = matches
    .map(m => parseInt(m.replace(/[^\d]/g, ''), 10))
    .filter(n => n >= 300 && n <= 50000); // sanity range for monthly rent
  if (!nums.length) return 0;
  return Math.max(...nums); // high end of range
}

/**
 * Parse sqft from text. Returns the LARGEST valid value (covers ranges like
 * "267 - 725 sq ft" → 725, or bare numbers in a range string).
 * Returns 0 if nothing found.
 */
function _parseSqft(text) {
  if (!text) return 0;
  const nums = [];

  // Pass 1: "<number> sq ft / sqft / square feet"
  const re1 = /(\d[\d,]{1,5})\s*(?:sq\.?\s?ft\.?|sqft|square\s?feet)/gi;
  let m;
  while ((m = re1.exec(text)) !== null) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (n >= 100 && n <= 20000) nums.push(n);
  }

  // Pass 2: capture the leading number of a range like "267 - 725 sq ft".
  //   Pattern: <num> <dash/sep> <num> <sq ft unit>  → also include <num1>
  const re2 = /(\d[\d,]{1,5})\s*[-–—]\s*\d[\d,]{1,5}\s*(?:sq\.?\s?ft\.?|sqft|square\s?feet)/gi;
  while ((m = re2.exec(text)) !== null) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (n >= 100 && n <= 20000) nums.push(n);
  }

  if (!nums.length) return 0;
  return Math.max(...nums);
}

/**
 * Find a number that appears alongside the given unit regex. Picks the LARGEST
 * such number (handles ranges like "Studio - 2 bd" → 2, "1 - 1.5 bath" → 1.5).
 * Recognizes "Studio" as 0 beds.
 */
function _parseNumberWithUnit(text, unitRe) {
  if (!text) return null;
  const nums = [];

  // "Studio" counts as 0 beds (only when looking for beds)
  if (/bed|bd|br/.test(unitRe.source) && /\bstudio\b/i.test(text)) {
    nums.push(0);
  }

  // <number> ... <unit-keyword>
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:[^\\d\\n]{0,12}?)?(${unitRe.source})`, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n)) nums.push(n);
  }

  // Also capture the LOW end of "<a> - <b> <unit>" ranges so we have both ends.
  const reRange = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*[-–—]\\s*\\d+(?:\\.\\d+)?\\s*(?:[^\\d\\n]{0,12}?)?(${unitRe.source})`, 'gi');
  while ((m = reRange.exec(text)) !== null) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n)) nums.push(n);
  }

  if (!nums.length) return null;
  return Math.max(...nums);
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
