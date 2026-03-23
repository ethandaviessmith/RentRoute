You are an expert Chrome Extension developer. Generate a comprehensive rules file (in Markdown) for an AI coding agent (Claude Sonnet or OpenAI Codex) to follow when building, iterating, and debugging a Chrome Extension. The rules file should cover the following areas:

---

## 1. Project Stack & Libraries

- Use **Manifest V3** (MV3) as the extension manifest format
- Use **vanilla JS** with the following common libraries loaded via local copy (no bundler required):
  - `lodash-es` — import **only named functions** (e.g. `import debounce from 'lodash-es/debounce.js'`); never import the full bundle
  - `dayjs` — date/time handling
  - `mitt` — tiny event emitter for messaging between extension contexts
  - **No `axios`** — use the native `fetch` API via `utils/http.js` (see below); `axios` is ~15 KB and has service worker compatibility issues
- Keep all code modular using **ES Modules** (`type: module` is fully supported for content scripts in MV3, Chrome 101+; use ES modules throughout)
- No build step required — files are loaded directly by Chrome

---

## 2. Project Structure

Define a clean folder layout:

```text
/extension
  manifest.json
  /background
    service-worker.js
  /content
    content.js
    content.css
  /popup
    popup.html
    popup.js
    popup.css
  /options
    options.html
    options.js
  /lib
    lodash-es/        ← individual function files only (debounce, throttle, etc.)
    dayjs.min.js
    mitt.esm.js
  /utils
    storage.js       ← chrome.storage helpers (local, sync, session)
    messaging.js     ← typed message passing helpers
    http.js          ← fetch wrapper replacing axios
    logger.js        ← structured console logger with prefix tags
  /assets
    icon16.png
    icon48.png
    icon128.png
```

---

## 3. Coding Conventions

- Always use `async/await` — never raw `.then()` chains
- All `chrome.*` API calls must be wrapped in try/catch with structured error logging
- Use `logger.js` for all console output — never use raw `console.log` directly
- Messages between background ↔ content ↔ popup must use typed message objects: `{ type: string, payload: any }`
- `storage.js` must abstract `chrome.storage.local` and `chrome.storage.sync` with get/set/clear helpers
- No inline scripts in HTML files (CSP compliance)
- All event listeners must be registered at the top level of service workers (not inside async functions)

---

## 4. Manifest V3 Rules

- `permissions` must be minimal — only request what is actively used
- Use `host_permissions` for URL matching, not broad `<all_urls>` unless absolutely necessary
- `background.service_worker` must point to a single entry file
- Use `action.default_popup` for the popup UI
- Declare all content scripts statically in `manifest.json` unless dynamic injection is explicitly needed

### MV3 Service Worker Lifecycle

- **Never store state in SW module-scope variables** — the SW is killed after ~30 s of inactivity and restarted on demand; all persistent state must live in `chrome.storage`
- **Do not use `setInterval` in the SW** — timers die with the SW; use `chrome.alarms` for recurring work instead
- **Keep SW top-level code minimal** — heavy initialisation must go inside event handlers, not at module scope, to reduce restart latency
- **Expect cold starts**: any message handler must be able to reinitialise state from storage before responding

---

## 5. Dev Cycle — Loading & Reloading the Extension

### Initial Load
1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked** and select the `/extension` folder
4. Note the generated **Extension ID** — store it in `DEV_NOTES.md`

### After Every Code Change
1. Go to `chrome://extensions`
2. Click the **reload icon (↺)** on the extension card
3. If changes are in a **content script**, also reload the target tab
4. If changes are in the **service worker**, click *"Inspect views: service worker"* to reopen DevTools for it

### Automated Reload (optional)
A small Node.js watcher script (`scripts/watch.js`) that triggers reload on file changes:

```js
// scripts/watch.js  (run with: node scripts/watch.js)
const fs = require('fs');
const EXT_DIR = './extension';

fs.watch(EXT_DIR, { recursive: true }, (event, filename) => {
  if (filename) {
    console.log(`[watch] changed: ${filename} — triggering reload`);
    // Signal reload via a local HTTP endpoint or native messaging
  }
});
```

---

## 6. Reading Logs & Debugging

The agent must know where each context logs to:

| Context | Where to open DevTools |
|---|---|
| **Popup** | Right-click popup → *Inspect* |
| **Content Script** | DevTools of the active tab (F12) → Console |
| **Service Worker** | `chrome://extensions` → *Inspect views: service worker* |
| **Options Page** | Right-click options page → *Inspect* |

### Logger Utility (`utils/logger.js`)

```js
// utils/logger.js
const createLogger = (context) => ({
  info:  (...args) => console.log(`[${context}][INFO]`, ...args),
  warn:  (...args) => console.warn(`[${context}][WARN]`, ...args),
  error: (...args) => console.error(`[${context}][ERROR]`, ...args),
  debug: (...args) => console.debug(`[${context}][DEBUG]`, ...args),
});

export default createLogger;
```

Usage:
```js
import createLogger from '../utils/logger.js';
const log = createLogger('ServiceWorker');
log.info('Extension installed');
log.error('Storage write failed', err);
```

### DevTools Tips
- Filter logs by context tag: `[Popup]`, `[ContentScript]`, etc.
- Enable **Verbose** level to see `debug` logs
- Check **Preserve log** in service worker DevTools to retain logs across reloads

---

## 7. Messaging Conventions (`utils/messaging.js`)

```js
// utils/messaging.js
export const sendToBackground = (type, payload) =>
  chrome.runtime.sendMessage({ type, payload });

export const sendToTab = (tabId, type, payload) =>
  chrome.tabs.sendMessage(tabId, { type, payload });

export const onMessage = (handlers) => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = handlers[msg.type];
    if (handler) {
      const result = handler(msg.payload, sender);
      if (result instanceof Promise) {
        result.then(sendResponse);
        return true; // keep channel open for async
      }
      sendResponse(result);
    }
  });
};
```

### Long-Lived Ports (for frequent / streaming messages)

Use `chrome.runtime.connect()` when a content script and the background need to exchange **more than 2–3 messages** in a session (e.g. progress updates, media events). `sendMessage` opens a new IPC channel per call — ports are far cheaper for ongoing communication.

```js
// content script — open port once
const port = chrome.runtime.connect({ name: 'filmreel' });
port.postMessage({ type: 'FRAME', payload: frameData });
port.onMessage.addListener((msg) => { /* receive from SW */ });
port.onDisconnect.addListener(() => { /* SW was killed or closed port */ });

// background / service worker
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'filmreel') return;
  port.onMessage.addListener((msg) => {
    // handle streaming messages without IPC overhead
    port.postMessage({ type: 'ACK' });
  });
});
```

**Rule:** Use `sendMessage` for infrequent one-shot requests. Use `connect()` ports for any ongoing data stream.

---

## 8. Storage Helpers (`utils/storage.js`)

```js
// utils/storage.js
export const local = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  clear: ()    => chrome.storage.local.clear(),
};

export const sync = {
  get: (keys) => chrome.storage.sync.get(keys),
  set: (items) => chrome.storage.sync.set(items),
  clear: ()    => chrome.storage.sync.clear(),
};

// session storage: in-memory, fast, cleared when the browser session ends.
// Use for hot transient data (e.g. current tab state, active queue) that does
// not need to survive a browser restart. Much faster than local/sync.
export const session = {
  get: (keys) => chrome.storage.session.get(keys),
  set: (items) => chrome.storage.session.set(items),
  clear: ()    => chrome.storage.session.clear(),
};
```

**Storage selection guide:**
| Store | Persists across restart | Synced | Use for |
|---|---|---|---|
| `local` | ✅ | ❌ | User settings, cached data |
| `sync` | ✅ | ✅ | Small user preferences (<100 KB) |
| `session` | ❌ | ❌ | Hot transient state (fastest reads) |

---

## 9a. HTTP Utility (`utils/http.js`)

Do **not** use `axios`. Use this thin `fetch` wrapper instead — zero dependencies, SW-compatible.

```js
// utils/http.js
const parseResponse = async (res) => {
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : res.text();
};

export const get = (url, opts = {}) =>
  fetch(url, { ...opts, method: 'GET' }).then(parseResponse);

export const post = (url, body, opts = {}) =>
  fetch(url, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  }).then(parseResponse);
```

Usage:
```js
import { get, post } from '../utils/http.js';
const data = await get('https://api.example.com/items');
```

---

## 9. Error Handling Rules

- Every `chrome.*` API call must be wrapped:
```js
try {
  await chrome.storage.local.set({ key: value });
} catch (err) {
  log.error('Failed to write storage', err);
}
```
- Service worker must listen for unhandled rejections:
```js
self.addEventListener('unhandledrejection', (event) => {
  log.error('Unhandled rejection', event.reason);
});
```
- Never silently swallow errors — always log with context

---

## 10. Iteration Checklist (agent must follow on every change)

Before marking any task complete, the agent must verify:

- [ ] `manifest.json` is valid JSON and passes `chrome://extensions` load without errors
- [ ] No CSP violations in the console (no inline scripts/styles)
- [ ] Service worker is active (not stopped) in `chrome://extensions`
- [ ] All new `chrome.*` permissions are declared in `manifest.json`
- [ ] Logs appear correctly prefixed in the right DevTools context
- [ ] Messages between contexts receive a response (no orphaned `sendMessage` calls)
- [ ] Extension reloaded and tested on a real tab after every change