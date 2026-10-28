import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Bell, Check, X } from 'lucide-react';
import { openQueueEvents } from './workbench-api';
import { getSettings } from './settings-client';
import { isActiveJob, QueueNotificationTracker, summarizeOfflineNotifications } from './queue-notifications';
import './notifications.css';

const STORAGE_KEY = 'h3-queue-notification-tokens-v1';

function storedTokens() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return { baseline: raw !== null, tokens: raw ? JSON.parse(raw) : [] };
  } catch { return { baseline: true, tokens: [] }; }
}

export default function QueueNotificationCenter() {
  const [toasts, setToasts] = useState([]);
  const enabled = useRef(true);
  const activeJobs = useRef(new Set());
  const timers = useRef(new Set());
  const initial = useRef(storedTokens());
  const tracker = useRef(new QueueNotificationTracker(Array.isArray(initial.current.tokens) ? initial.current.tokens : []));

  useEffect(() => {
    let disposed = false;
    const persist = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tracker.current.snapshot())); } catch { /* Page notifications still work without storage. */ }
    };
    const dismiss = (id) => setToasts((items) => items.filter((item) => item.id !== id));
    const present = (item) => {
      if (!item || disposed || !enabled.current) return;
      const id = `${Date.now()}-${Math.random()}`;
      setToasts((items) => [...items.slice(-3), { ...item, id }]);
      const timer = setTimeout(() => { timers.current.delete(timer); dismiss(id); }, 6000);
      timers.current.add(timer);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('H3 视频工作台', { body: item.text, tag: id }); } catch { /* The in-page toast remains available. */ }
      }
    };
    const refreshSettings = (event) => {
      if (event?.detail && typeof event.detail.notifications === 'boolean') enabled.current = event.detail.notifications;
      else getSettings().then((settings) => { enabled.current = settings.notifications; }).catch(() => {});
    };
    const events = openQueueEvents({
      onSnapshot(snapshot) {
        const jobs = snapshot.jobs || [];
        activeJobs.current = new Set(jobs.filter(isActiveJob).map((job) => job.id));
        const items = jobs.map((job) => tracker.current.observe(job)).filter(Boolean);
        if (initial.current.baseline) present(summarizeOfflineNotifications(items));
        initial.current.baseline = true;
        persist();
      },
      onJobEvent(job, type) {
        if (!job) return;
        const wasActive = activeJobs.current.size > 0;
        if (isActiveJob(job)) activeJobs.current.add(job.id);
        else activeJobs.current.delete(job.id);
        present(tracker.current.observe(job));
        if (wasActive && activeJobs.current.size === 0 && ['job.done', 'job.error', 'job.cancelled', 'queue.cleared'].includes(type)) {
          present({ type: 'done', text: '队列已清空，所有任务均已结束。' });
        }
        persist();
      },
    });
    refreshSettings();
    window.addEventListener('h3-settings-changed', refreshSettings);
    return () => {
      disposed = true;
      events.close();
      window.removeEventListener('h3-settings-changed', refreshSettings);
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    };
  }, []);

  return <div className="queue-notifications" aria-live="polite" aria-atomic="false">{toasts.map((toast) => <div key={toast.id} className={`queue-toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>
    <span className="queue-toast-icon">{toast.type === 'error' ? <AlertCircle size={17} /> : toast.text.startsWith('队列') ? <Bell size={17} /> : <Check size={17} />}</span>
    <span>{toast.text}</span><button aria-label="关闭通知" onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}><X size={14} /></button>
  </div>)}</div>;
}
