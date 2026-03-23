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

// ── Session-level route/geocode cache ────────────────────────────────────────
const _geocodeCache = {};   // address → { lat, lon }
const _routeCache   = {};   // `${originKey}|${destKey}|${mode}` → result

// ── Geocode (Nominatim) ──────────────────────────────────────────────────────
/**
 * @param {string} address
 * @returns {Promise<{lat: number, lon: number}|null>}
 */
export async function geocode(address) {
  const key = address.trim().toLowerCase();
  if (_geocodeCache[key]) return _geocodeCache[key];

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  log.debug('geocode', address);

  const res = await _rateLimitedFetch(url, {
    headers: { 'Accept-Language': 'en', 'User-Agent': 'RentRoute-Extension/0.1' }
  });

  if (!res.ok) { log.error('geocode failed', res.status); return null; }

  let data;
  try { data = JSON.parse(res.body); } catch { log.error('geocode parse error'); return null; }

  if (!data.length) { log.warn('geocode: no results for', address); return null; }

  const result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  _geocodeCache[key] = result;
  log.info('geocoded', address, '→', result);
  return result;
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
