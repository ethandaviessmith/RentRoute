// popup.js — destination management UI

import {
  initState, getApiKey, setApiKey,
  getSheetsUrl, setSheetsUrl, getSheetsSecret, setSheetsSecret,
  isApiKeyBundled, isSheetsUrlBundled, isSheetsSecretBundled,
  getDestinations, addDestination, removeDestination, updateDestination,
} from './modules/state.js';
import { geocode } from './modules/api.js';
import { createLogger } from './modules/logger.js';

const log = createLogger('popup');

const MODE_OPTIONS = [
  { value: 'drive',   label: '🚗 Drive'   },
  { value: 'walk',    label: '🚶 Walk'    },
  { value: 'bike',    label: '🚴 Bike'    },
  { value: 'transit', label: '🚌 Transit' },
];

(async function main() {
  await initState();

  // ── API key ────────────────────────────────────────────────────────────────
  const keyInput    = document.getElementById('api-key-input');
  const btnSaveKey  = document.getElementById('btn-save-key');
  const bundledHint = document.getElementById('key-bundled-hint');

  const currentKey = getApiKey();
  keyInput.value = currentKey;

  // If a key was loaded from keys.js, show the hint
  if (currentKey) {
    bundledHint.style.display = '';
  }

  btnSaveKey.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    await setApiKey(key);
    _flash(btnSaveKey, 'Saved ✓');
    bundledHint.style.display = key ? '' : 'none';
    log.info('API key saved');
  });

  // ── Sheets Web App URL ─────────────────────────────────────────────────────
  const sheetsUrlInput   = document.getElementById('sheets-url-input');
  const btnSaveSheetsUrl = document.getElementById('btn-save-sheets-url');
  const sheetsUrlHint    = document.getElementById('sheets-url-bundled-hint');

  sheetsUrlInput.value = getSheetsUrl();
  if (isSheetsUrlBundled()) sheetsUrlHint.style.display = '';

  btnSaveSheetsUrl.addEventListener('click', async () => {
    const url = sheetsUrlInput.value.trim();
    await setSheetsUrl(url);
    _flash(btnSaveSheetsUrl, 'Saved ✓');
    log.info('sheets URL saved');
  });

  // ── Sheets Secret ──────────────────────────────────────────────────────────
  const sheetsSecretInput   = document.getElementById('sheets-secret-input');
  const btnSaveSheetsSecret = document.getElementById('btn-save-sheets-secret');
  const sheetsSecretHint    = document.getElementById('sheets-secret-bundled-hint');

  sheetsSecretInput.value = getSheetsSecret();
  if (isSheetsSecretBundled()) sheetsSecretHint.style.display = '';

  btnSaveSheetsSecret.addEventListener('click', async () => {
    const secret = sheetsSecretInput.value.trim();
    await setSheetsSecret(secret);
    _flash(btnSaveSheetsSecret, 'Saved ✓');
    log.info('sheets secret saved');
  });

  // ── Destination list ───────────────────────────────────────────────────────
  _renderDestinations();

  document.getElementById('btn-add').addEventListener('click', async () => {
    const id = `dest_${Date.now()}`;
    await addDestination({ id, label: '', address: '', lat: null, lon: null, mode: 'drive' });
    _renderDestinations();
    // Focus new card's address input
    const inputs = document.querySelectorAll('.dest-address');
    inputs[inputs.length - 1]?.focus();
  });
})();

// ── Render all destination cards ─────────────────────────────────────────────
function _renderDestinations() {
  const list  = document.getElementById('dest-list');
  const dests = getDestinations();
  list.innerHTML = '';

  if (!dests.length) {
    list.innerHTML = '<p class="empty-hint">No destinations yet. Add one below.</p>';
    return;
  }

  for (const dest of dests) {
    list.appendChild(_makeDestCard(dest));
  }
}

function _makeDestCard(dest) {
  const card = document.createElement('div');
  card.className = 'dest-card';
  card.dataset.id = dest.id;

  // Mode select
  const modeSelect = document.createElement('select');
  modeSelect.className = 'dest-mode';
  for (const { value, label } of MODE_OPTIONS) {
    const opt = document.createElement('option');
    opt.value   = value;
    opt.textContent = label;
    opt.selected = dest.mode === value;
    modeSelect.appendChild(opt);
  }

  // Label input
  const labelInput = document.createElement('input');
  labelInput.type        = 'text';
  labelInput.className   = 'dest-label';
  labelInput.placeholder = 'Name (e.g. Work)';
  labelInput.value       = dest.label ?? '';

  // Address input
  const addrInput = document.createElement('input');
  addrInput.type        = 'text';
  addrInput.className   = 'dest-address';
  addrInput.placeholder = 'Full address…';
  addrInput.value       = dest.address ?? '';

  // Geocode status
  const geoStatus = document.createElement('span');
  geoStatus.className = 'dest-geo-status';
  geoStatus.textContent = dest.lat ? '✓ geocoded' : '';

  // Remove button
  const btnRemove = document.createElement('button');
  btnRemove.className   = 'btn-remove';
  btnRemove.textContent = '−';
  btnRemove.title       = 'Remove destination';

  // Row layout
  const row1 = document.createElement('div');
  row1.className = 'dest-row';
  row1.appendChild(modeSelect);
  row1.appendChild(labelInput);
  row1.appendChild(btnRemove);

  const row2 = document.createElement('div');
  row2.className = 'dest-row dest-row--addr';
  row2.appendChild(addrInput);
  row2.appendChild(geoStatus);

  card.appendChild(row1);
  card.appendChild(row2);

  // ── Events ─────────────────────────────────────────────────────────────────
  modeSelect.addEventListener('change', () =>
    updateDestination(dest.id, { mode: modeSelect.value }));

  labelInput.addEventListener('change', () =>
    updateDestination(dest.id, { label: labelInput.value.trim() }));

  addrInput.addEventListener('change', async () => {
    const address = addrInput.value.trim();
    geoStatus.textContent = '⏳ geocoding…';
    geoStatus.className   = 'dest-geo-status';
    await updateDestination(dest.id, { address, lat: null, lon: null });

    if (!address) { geoStatus.textContent = ''; return; }

    const coords = await geocode(address);
    if (coords) {
      await updateDestination(dest.id, { lat: coords.lat, lon: coords.lon });
      geoStatus.textContent = '✓ geocoded';
      geoStatus.className   = 'dest-geo-status dest-geo-status--ok';
    } else {
      geoStatus.textContent = '⚠ not found';
      geoStatus.className   = 'dest-geo-status dest-geo-status--err';
    }
  });

  btnRemove.addEventListener('click', async () => {
    await removeDestination(dest.id);
    _renderDestinations();
  });

  return card;
}

// ── Micro helpers ─────────────────────────────────────────────────────────────
function _flash(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
}
