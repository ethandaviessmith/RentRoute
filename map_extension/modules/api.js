// modules/api.js — Nominatim geocoding + HERE Routing v8 + HERE Public Transit v8

import { createLogger }    from './logger.js';
import { getApiKey }       from './state.js';
import { toGeoJSON }       from './flexpolyline.js';

const log = createLogger('api');

// ── Rate-limit helpers ───────────────────────────────────────────────────────
// HERE Free plan limits (per-service RPS from plan table):
//   Routing Car/Bicycle/Pedestrian : 10 RPS
//   Public Transit                 : 10 RPS
//   Geocode & Reverse Geocode      : 5 RPS
// Nominatim: ~1 req/s (honour usage policy)
const _lastCall = {};   // hostname → timestamp

const HOST_GAP = {
  'nominatim.openstreetmap.org': 1100,
  'router.hereapi.com':           100,   // 10 RPS → 100 ms gap
  'transit.router.hereapi.com':   100,   // 10 RPS → 100 ms gap
};

async function _rateLimitedFetch(url, options = {}) {
  const host = new URL(url).hostname;
  const now  = Date.now();
  const gap  = HOST_GAP[host] ?? 0;
  const wait = Math.max(0, gap - (now - (_lastCall[host] ?? 0)));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCall[host] = Date.now();

  return chrome.runtime.sendMessage({ action: 'fetch', url, options });
}

// ── Address cleaning ─────────────────────────────────────────────────────────
// Strip apartment / unit / suite / floor numbers that confuse Nominatim.
// e.g. "23 Thurston Rd #23, Newton …" → "23 Thurston Rd, Newton …"
//       "47 Algonquin Rd Unit 1, Chestnut Hill, MA" → "47 Algonquin Rd, Chestnut Hill, MA"
//       "100 Main St, Apt B-2, Boston MA" → "100 Main St, Boston MA"
const _UNIT_KEYWORDS =
  '(?:apt|apartment|unit|suite|ste|fl|floor|rm|room|bldg|building|lot|space|ph|penthouse|no|number)';
const _UNIT_RE = new RegExp(
  // Optional leading comma, then either:
  //   #<id>  OR  keyword.<space>#?<id>
  // <id> = alphanumeric/hyphen token ("1", "A", "3-B", "B2", etc.)
  '\\s*,?\\s*(?:#\\s*[\\w-]+|' + _UNIT_KEYWORDS + '\\.?\\s*#?\\s*[\\w-]+)',
  'gi'
);

function _cleanAddress(raw) {
  let addr = raw.trim();
  addr = addr.replace(_UNIT_RE, '');

  // Collapse leftover double commas / leading commas / trailing commas / extra whitespace
  addr = addr.replace(/,\s*,/g, ',').replace(/^\s*,\s*/, '').replace(/,\s*$/, '').replace(/\s{2,}/g, ' ').trim();

  return addr;
}

/**
 * Aggressively strip the address down to "<number> <street-name>, <city-state-zip>".
 * Used as a fallback when the normal clean still fails to geocode.
 * e.g. "47 Algonquin Rd Unit 1, Chestnut Hill, MA 02467"
 *    → "47 Algonquin Rd, Chestnut Hill, MA 02467"
 */
function _aggressiveClean(raw) {
  let addr = _cleanAddress(raw);

  // Split on first comma → street part vs. rest (city/state/zip)
  const commaIdx = addr.indexOf(',');
  if (commaIdx === -1) return addr;

  let street = addr.slice(0, commaIdx).trim();
  const rest = addr.slice(commaIdx);  // keeps leading ","

  // Strip anything after the core street: keep "<number(s)> <word(s)>" but drop
  // trailing tokens that look like leftover unit info (short alphanumeric fragments).
  // e.g. "47 Algonquin Rd B" → "47 Algonquin Rd"
  street = street.replace(/\s+[A-Za-z](?:\d|[-]\w)*$/i, '');
  street = street.replace(/\s+\d{1,5}[A-Za-z]{0,2}$/i, '');

  return (street + rest).replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
}

// ── Address parsing for structured queries ───────────────────────────────────
// US two-letter state abbreviations
const _US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

/**
 * Parse a US-style address into structured components.
 * @returns {{ street: string, city?: string, state?: string, zip?: string } | null}
 */
function _parseAddress(addr) {
  // Expected format: "Street, City, ST ZIP" or "Street, City, ST"
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const street = parts[0];
  // Last part usually has "STATE ZIP" or just "STATE"
  const lastPart = parts[parts.length - 1];
  const stateZipMatch = lastPart.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i)
                     || lastPart.match(/^([A-Z]{2})$/i);

  if (!stateZipMatch) return null;
  const state = stateZipMatch[1].toUpperCase();
  if (!_US_STATES.has(state)) return null;

  const zip   = stateZipMatch[2] || undefined;
  // City is everything between street and the state/zip part
  const city  = parts.length > 2 ? parts.slice(1, -1).join(', ') : undefined;

  return { street, city, state, zip };
}

// ── Session-level route/geocode cache ────────────────────────────────────────
const _geocodeCache = {};   // address → { lat, lon }
const _routeCache   = {};   // `${originKey}|${destKey}|${mode}` → result

// ── Nominatim helpers ────────────────────────────────────────────────────────
const _NOMINATIM_HEADERS = { 'Accept-Language': 'en', 'User-Agent': 'RentRoute-Extension/0.1' };

/** Free-form Nominatim query. Returns parsed array or null on error. */
async function _nominatimFreeform(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  log.debug('geocode (freeform)', query);
  const res = await _rateLimitedFetch(url, { headers: _NOMINATIM_HEADERS });
  if (!res.ok) { log.error('geocode failed', res.status); return null; }
  try { return JSON.parse(res.body); } catch { log.error('geocode parse error'); return null; }
}

/**
 * Structured Nominatim query — bypasses free-form ambiguity.
 * Nominatim often fails on neighbourhood/village names (e.g. "Chestnut Hill")
 * but succeeds when queried as street + postalcode + countrycodes.
 */
async function _nominatimStructured(parsed) {
  const params = new URLSearchParams({ format: 'json', limit: '1' });
  params.set('street', parsed.street);
  if (parsed.state) params.set('state', parsed.state);
  if (parsed.zip)   params.set('postalcode', parsed.zip);
  params.set('countrycodes', 'us');

  const url = `https://nominatim.openstreetmap.org/search?${params}`;
  log.debug('geocode (structured)', Object.fromEntries(params));
  const res = await _rateLimitedFetch(url, { headers: _NOMINATIM_HEADERS });
  if (!res.ok) { log.error('geocode structured failed', res.status); return null; }
  try { return JSON.parse(res.body); } catch { log.error('geocode parse error'); return null; }
}

// ── Geocode (Nominatim) ──────────────────────────────────────────────────────
/**
 * @param {string} address
 * @returns {Promise<{lat: number, lon: number}|null>}
 */
export async function geocode(address) {
  const cleaned = _cleanAddress(address);
  const key = cleaned.toLowerCase();
  if (_geocodeCache[key]) return _geocodeCache[key];

  if (cleaned !== address.trim()) {
    log.info('geocode: cleaned address', address, '→', cleaned);
  }

  // Build candidate list: normal clean → aggressive clean
  const candidates = [cleaned];
  const aggressive = _aggressiveClean(address);
  if (aggressive.toLowerCase() !== key) candidates.push(aggressive);

  // Phase 1: free-form queries
  for (const candidate of candidates) {
    const cacheHit = _geocodeCache[candidate.toLowerCase()];
    if (cacheHit) return cacheHit;

    const data = await _nominatimFreeform(candidate);
    if (data?.length) {
      const result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
      _geocodeCache[candidate.toLowerCase()] = result;
      _geocodeCache[key] = result;
      log.info('geocoded', candidate, '→', result);
      return result;
    }
    log.warn('geocode: no results for', candidate);
  }

  // Phase 2: structured query fallback (street + state + zip, no city)
  // Handles cases where Nominatim's free-form chokes on neighbourhood/village
  // names that OSM doesn't recognise as cities (e.g. Chestnut Hill → Newton).
  const parsed = _parseAddress(cleaned);
  if (parsed) {
    log.info('geocode: trying structured fallback for', parsed);
    const data = await _nominatimStructured(parsed);
    if (data?.length) {
      const result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
      _geocodeCache[key] = result;
      log.info('geocoded (structured)', cleaned, '→', result);
      return result;
    }
  }

  log.warn('geocode: all attempts failed for', address);
  return null;
}

// ── HERE transport mode mapping ──────────────────────────────────────────────
const MODE_TO_HERE = {
  drive: 'car',
  walk:  'pedestrian',
  bike:  'bicycle',
  // transit uses a separate API endpoint — see _getTransitRoute()
};

/**
 * @param {{ lat: number, lon: number }} origin
 * @param {{ lat: number, lon: number }} dest
 * @param {'drive'|'walk'|'bike'|'transit'} mode
 * @returns {Promise<{ durationMin: number, distanceMi: number, geojson: object, isFallback: boolean, transitDetails?: object }|null>}
 */
export async function getRoute(origin, dest, mode) {
  const cacheKey = `${origin.lat},${origin.lon}|${dest.lat},${dest.lon}|${mode}`;
  if (_routeCache[cacheKey]) return _routeCache[cacheKey];

  const apiKey = getApiKey();
  if (!apiKey) { log.warn('no HERE API key configured'); return null; }

  let result;
  if (mode === 'transit') {
    result = await _getTransitRoute(origin, dest, apiKey);
  } else {
    result = await _getVehicleRoute(origin, dest, mode, apiKey);
  }

  if (result) {
    _routeCache[cacheKey] = result;
    log.info('route result', result);
  }
  return result;
}

// ── HERE Routing API v8 (car / pedestrian / bicycle) ─────────────────────────
async function _getVehicleRoute(origin, dest, mode, apiKey) {
  const hereMode = MODE_TO_HERE[mode] ?? 'pedestrian';
  const params = new URLSearchParams({
    transportMode: hereMode,
    origin:        `${origin.lat},${origin.lon}`,
    destination:   `${dest.lat},${dest.lon}`,
    return:        'summary,polyline',
    apiKey,
  });

  const url = `https://router.hereapi.com/v8/routes?${params}`;
  log.debug('HERE route', { origin, dest, mode, hereMode });

  const res = await _rateLimitedFetch(url);
  if (!res.ok) {
    log.error('HERE route failed', res.status, res.body);
    return null;
  }

  let data;
  try { data = JSON.parse(res.body); } catch { log.error('HERE parse error'); return null; }

  const route = data.routes?.[0];
  if (!route?.sections?.length) {
    log.warn('HERE: unexpected response shape', data);
    return null;
  }

  // Aggregate sections (usually just one for simple A→B)
  let totalDuration = 0;   // seconds
  let totalLength   = 0;   // meters
  const allCoords   = [];  // GeoJSON [lng, lat] arrays

  for (const section of route.sections) {
    totalDuration += section.summary?.duration ?? 0;
    totalLength   += section.summary?.length   ?? 0;
    if (section.polyline) {
      const geo = toGeoJSON(section.polyline);
      allCoords.push(...geo.coordinates);
    }
  }

  return {
    durationMin: Math.round(totalDuration / 60),
    distanceMi:  Math.round((totalLength / 1609.34) * 10) / 10,
    geojson:     { type: 'LineString', coordinates: allCoords },
    isFallback:  false,
  };
}

// ── Section duration helper ──────────────────────────────────────────────────
/** Compute section duration in seconds from travelSummary / summary / timestamps. */
function _sectionDuration(section) {
  if (section.travelSummary?.duration != null) return section.travelSummary.duration;
  if (section.summary?.duration != null) return section.summary.duration;
  const dep = section.departure?.time;
  const arr = section.arrival?.time;
  if (dep && arr) return Math.round((new Date(arr) - new Date(dep)) / 1000);
  return 0;
}

/** Compute section length in meters from travelSummary / summary. */
function _sectionLength(section) {
  return section.travelSummary?.length ?? section.summary?.length ?? 0;
}

// ── HERE Public Transit API v8 ───────────────────────────────────────────────
async function _getTransitRoute(origin, dest, apiKey) {
  const params = new URLSearchParams({
    origin:      `${origin.lat},${origin.lon}`,
    destination: `${dest.lat},${dest.lon}`,
    return:      'polyline,travelSummary,intermediate',
    apiKey,
  });

  const url = `https://transit.router.hereapi.com/v8/routes?${params}`;
  log.debug('HERE transit route', { origin, dest });

  const res = await _rateLimitedFetch(url);
  if (!res.ok) {
    log.error('HERE transit route failed', res.status, res.body);
    // Parse error body for user-friendly message
    let errMsg = `Transit routing failed (${res.status})`;
    try {
      const err = JSON.parse(res.body);
      if (err.title) errMsg = err.title;
    } catch {}
    return { blocked: true, reason: errMsg };
  }

  let data;
  try { data = JSON.parse(res.body); } catch { log.error('HERE transit parse error'); return null; }

  const route = data.routes?.[0];
  if (!route?.sections?.length) {
    log.warn('HERE transit: no routes found', data);
    return { blocked: true, reason: 'No transit route found' };
  }

  // Aggregate all sections (walking + transit + walking…)
  // Transit API provides departure.time / arrival.time per section, NOT summary.
  let totalDuration = 0;
  let totalLength   = 0;
  const allCoords   = [];
  const legs        = [];     // details per section for UI
  let transfers     = -1;     // number of transit boardings minus 1

  for (const section of route.sections) {
    const secDur = _sectionDuration(section);
    const secLen = _sectionLength(section);
    totalDuration += secDur;
    totalLength   += secLen;

    if (section.polyline) {
      const geo = toGeoJSON(section.polyline);
      allCoords.push(...geo.coordinates);
    }

    const sMode = section.transport?.mode ?? section.type ?? 'unknown';
    const isTransit = (sMode !== 'pedestrian' && sMode !== 'walk' && section.type !== 'pedestrian');

    if (isTransit) transfers++;

    legs.push({
      mode:      sMode,
      type:      section.type ?? 'unknown',
      name:      section.transport?.name      ?? null,
      shortName: section.transport?.shortName  ?? null,
      headsign:  section.transport?.headsign   ?? null,
      category:  section.transport?.category   ?? null,
      duration:  secDur,
      length:    secLen,
      departureStop: section.departure?.place?.name ?? null,
      arrivalStop:   section.arrival?.place?.name   ?? null,
      departureTime: section.departure?.time ?? null,
      arrivalTime:   section.arrival?.time   ?? null,
      numStops:      section.intermediateStops?.length ?? 0,
    });
  }

  if (transfers < 0) transfers = 0;

  return {
    durationMin:    Math.round(totalDuration / 60),
    distanceMi:     Math.round((totalLength / 1609.34) * 10) / 10,
    geojson:        { type: 'LineString', coordinates: allCoords },
    isFallback:     false,
    transitDetails: { legs, transfers },
  };
}

// ── Cache busting (call on new origin address) ────────────────────────────────
export function clearRouteCache() {
  for (const k of Object.keys(_routeCache)) delete _routeCache[k];
}
