import assert from 'node:assert/strict';
import { createUpdateCheckScheduler, UPDATE_CHECK_INTERVAL } from './src/update-check-scheduler.js';

const win = new EventTarget();
const doc = new EventTarget();
doc.visibilityState = 'visible';
const nav = { onLine: true };
let time = 0;
let sequence = 0;
const timers = new Map();
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const advance = async (ms) => {
  const end = time + ms;
  while (true) {
    const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
  }
  time = end; await flush();
};
let checks = 0;
let finish;
let busy = false;
const scheduler = createUpdateCheckScheduler({
  window: win, document: doc, navigator: nav, now: () => time,
  setTimer: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: time + delay }); return id; },
  clearTimer: (id) => timers.delete(id), isBusy: () => busy,
  check: () => { checks++; return new Promise((resolve) => { finish = resolve; }); },
});
scheduler.setEnabled(true);
await advance(1199); assert.equal(checks, 0);
await advance(1); assert.equal(checks, 1);
win.dispatchEvent(new Event('focus'));
await advance(UPDATE_CHECK_INTERVAL); assert.equal(checks, 1, 'in-flight request never overlaps');
finish(); await flush();
await advance(UPDATE_CHECK_INTERVAL - 1); assert.equal(checks, 1);
await advance(1); assert.equal(checks, 2, 'four-hour repeat');
finish(); await flush();
doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
await advance(UPDATE_CHECK_INTERVAL * 2); assert.equal(checks, 2, 'hidden page does not check');
doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
await advance(0); assert.equal(checks, 3, 'overdue visible resume');
finish(); await flush();
nav.onLine = false; win.dispatchEvent(new Event('offline'));
await advance(UPDATE_CHECK_INTERVAL * 2); assert.equal(checks, 3);
nav.onLine = true; win.dispatchEvent(new Event('online'));
await advance(0); assert.equal(checks, 4, 'overdue online resume');
finish(); await flush();
busy = true;
await advance(UPDATE_CHECK_INTERVAL + 120000); assert.equal(checks, 4, 'dialog/apply blocks automatic check');
busy = false; win.dispatchEvent(new Event('focus'));
await advance(0); assert.equal(checks, 5);
scheduler.setEnabled(false); finish(); await flush();
await advance(UPDATE_CHECK_INTERVAL * 2); assert.equal(checks, 5, 'opt-out stops timer even after completion');
scheduler.setEnabled(true); await advance(0); assert.equal(checks, 6, 're-enable checks overdue');
scheduler.stop(); finish(); await flush();
win.dispatchEvent(new Event('focus')); await advance(UPDATE_CHECK_INTERVAL * 2);
assert.equal(checks, 6); assert.equal(timers.size, 0);
console.log('update scheduler: startup, 4h, overlap, visibility, online, focus, busy, opt-out, cleanup passed');
