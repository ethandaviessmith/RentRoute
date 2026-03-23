// modules/map.js — Leaflet map init and route rendering per commute card

import { createLogger } from './logger.js';

const log = createLogger('map');

// Leaflet is loaded as a plain script tag by content.js (web_accessible_resource).
// After that, `window.L` is available.

const MODE_COLOR = {
  drive:   '#3b82f6',   // blue
  walk:    '#22c55e',   // green
  bike:    '#f97316',   // orange
  transit: '#a855f7',   // purple
};

/**
 * Initialise a Leaflet map inside `containerEl`.
 * @param {HTMLElement} containerEl  — must already be in the DOM with a fixed size
 * @param {{ lat: number, lon: number }} origin
 * @param {{ lat: number, lon: number }} dest
 * @param {{ durationMin, distanceMi, geojson, isFallback }} routeData
 * @param {'drive'|'walk'|'bike'|'transit'} mode
 * @returns {{ map: L.Map, destroy: () => void }}
 */
export function initMap(containerEl, origin, dest, routeData, mode) {
  const L = window.L;
  log.debug('initMap called — window.L type:', typeof L,
            '| containerEl in DOM:', document.body?.contains(containerEl),
            '| containerEl size:', containerEl?.offsetWidth, 'x', containerEl?.offsetHeight,
            '| mode:', mode);
  if (!L) {
    log.error('Leaflet not loaded — window.L is', typeof L,
              '\nAll window keys matching L:', Object.keys(window).filter(k => k.startsWith('L')));
    return null;
  }

  // Prevent double-init
  if (containerEl._leaflet_id) {
    log.debug('map already init on this container, skipping');
    return null;
  }

  const map = L.map(containerEl, {
    zoomControl:       true,
    attributionControl: true,
    scrollWheelZoom:   false,  // avoid hijacking page scroll
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  // Markers
  const originIcon = _makeIcon('🏠');
  const destIcon   = _makeIcon('📍');
  L.marker([origin.lat, origin.lon], { icon: originIcon }).addTo(map)
    .bindTooltip('Listing', { permanent: false });
  L.marker([dest.lat, dest.lon], { icon: destIcon }).addTo(map)
    .bindTooltip('Destination', { permanent: false });

  // Route polyline
  const color = MODE_COLOR[mode] ?? '#3b82f6';
  const routeLayer = L.geoJSON(routeData.geojson, {
    style: { color, weight: 4, opacity: 0.8 },
  }).addTo(map);

  // Fit map to route bounds
  try {
    map.fitBounds(routeLayer.getBounds(), { padding: [16, 16] });
  } catch {
    map.setView([origin.lat, origin.lon], 13);
  }

  log.debug('map initialised', mode, origin, dest);

  return {
    map,
    destroy() {
      try { map.remove(); } catch {}
    },
  };
}

// ── Emoji div-icon helper ─────────────────────────────────────────────────────
function _makeIcon(emoji) {
  const L = window.L;
  return L.divIcon({
    html: `<span style="font-size:20px;line-height:1">${emoji}</span>`,
    className: 'rr-emoji-icon',
    iconAnchor: [10, 20],
  });
}
