// modules/logger.js — namespaced, leveled logger (mirrors filmreel pattern)

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const _ring = [];          // last 500 log entries
const MAX_RING = 500;
const ACTIVE_LEVEL = 'debug';

function _push(level, name, args) {
  const entry = { ts: Date.now(), level, name, args };
  _ring.push(entry);
  if (_ring.length > MAX_RING) _ring.shift();
}

export function createLogger(name) {
  const threshold = LOG_LEVELS[ACTIVE_LEVEL] ?? 0;
  return {
    debug(...args) { if (threshold <= 0) { console.debug(`[RR:${name}]`, ...args); _push('debug', name, args); } },
    info(...args)  { if (threshold <= 1) { console.info (`[RR:${name}]`, ...args); _push('info',  name, args); } },
    warn(...args)  { if (threshold <= 2) { console.warn (`[RR:${name}]`, ...args); _push('warn',  name, args); } },
    error(...args) { if (threshold <= 3) { console.error(`[RR:${name}]`, ...args); _push('error', name, args); } },
  };
}

export function dumpLog(n = 50) {
  return _ring.slice(-n);
}
