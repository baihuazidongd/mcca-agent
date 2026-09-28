"use strict";
function createBackoff({ now = Date.now, baseMs = 20000, maxMs = 600000 } = {}) {
  const states = new Map();
  return {
    ready(id) { return now() >= (states.get(id)?.retryAt || 0); },
    failed(id) { const failures = (states.get(id)?.failures || 0) + 1; const state = { failures, retryAt: now() + Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 10)) }; states.set(id, state); return state; },
    healthy(id) { states.delete(id); },
    state(id) { return states.get(id) || null; },
  };
}
module.exports = { createBackoff };
