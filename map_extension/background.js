// background.js — service worker
// Relays fetch requests from content scripts (avoids page CSP issues for
// cross-origin calls to HERE APIs / Nominatim).

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openSettings') {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === 'injectLeaflet') {
    // Inject Leaflet into the ISOLATED world so window.L is visible to modules.
    console.log('[RR:bg] injectLeaflet — tabId:', sender.tab?.id, 'frameId:', sender.frameId);
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      files:  ['lib/leaflet.js'],
      world:  'ISOLATED',
    })
    .then(() => {
      console.log('[RR:bg] injectLeaflet — executeScript OK for tab', sender.tab.id);
      sendResponse({ ok: true });
    })
    .catch(err => {
      console.error('[RR:bg] injectLeaflet failed:', err.message);
      sendResponse({ ok: false, error: err.message });
    });
    return true; // keep channel open
  }
  if (msg.action !== 'fetch') return false;

  const { url, options = {} } = msg;

  fetch(url, options)
    .then(async res => {
      const text = await res.text();
      sendResponse({ ok: res.ok, status: res.status, body: text });
    })
    .catch(err => {
      sendResponse({ ok: false, status: 0, body: err.message });
    });

  return true; // keep message channel open for async response
});
