export const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000;

// Browser lifecycle and time are injected so suspension/resume can be tested without waiting.
export function createUpdateCheckScheduler({ check, isBusy = () => false, window: win = window,
  document: doc = document, navigator: nav = navigator, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, interval = UPDATE_CHECK_INTERVAL,
  startupDelay = 1200 }) {
  let enabled = false;
  let stopped = false;
  let running = false;
  let timer;
  let due = now() + startupDelay;
  const ready = () => doc.visibilityState !== 'hidden' && nav.onLine !== false;
  const clear = () => { clearTimer(timer); timer = undefined; };
  const schedule = () => {
    clear();
    if (!enabled || stopped || running || !ready()) return;
    timer = setTimer(tick, Math.max(0, due - now()));
  };
  const tick = async () => {
    clear();
    if (!enabled || stopped || running || !ready()) return;
    if (now() < due) { schedule(); return; }
    if (isBusy()) { timer = setTimer(tick, 60000); return; }
    running = true;
    try { await check(); } catch { /* Automatic failures stay quiet and retry next period. */ }
    finally { running = false; due = now() + interval; schedule(); }
  };
  const resume = () => schedule();
  win.addEventListener('focus', resume);
  win.addEventListener('online', resume);
  win.addEventListener('offline', resume);
  doc.addEventListener('visibilitychange', resume);
  return {
    setEnabled(value) { enabled = Boolean(value); schedule(); },
    stop() {
      stopped = true;
      clear();
      win.removeEventListener('focus', resume);
      win.removeEventListener('online', resume);
      win.removeEventListener('offline', resume);
      doc.removeEventListener('visibilitychange', resume);
    },
  };
}
