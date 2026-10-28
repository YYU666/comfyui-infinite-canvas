import assert from 'node:assert/strict';
import { notificationToken, QueueNotificationTracker, summarizeOfflineNotifications } from './src/queue-notifications.js';

const done = { id: 'job_done', kind: 'workflow', status: 'done', finishedAt: '2026-10-29T01:00:00Z' };
const failed = { id: 'job_failed', kind: 'outfit', status: 'error', finishedAt: '2026-10-29T01:01:00Z' };
const tracker = new QueueNotificationTracker();
assert.deepEqual(tracker.observe(done), { type: 'done', text: '生成任务已完成。' });
assert.equal(tracker.observe(done), null, 'snapshot and live event must not duplicate a terminal notification');
assert.deepEqual(tracker.observe(failed), { type: 'error', text: '换装任务失败，请查看节点错误并重试。' });
assert.equal(tracker.observe({ ...done, status: 'running' }), null);
assert.notEqual(notificationToken(done), notificationToken({ ...done, finishedAt: '2026-10-29T02:00:00Z' }), 'retry creates a new terminal token');
const offline = summarizeOfflineNotifications([{ type: 'done', text: '生成任务已完成。' }, { type: 'error', text: '换装任务失败。' }]);
assert.equal(offline.type, 'error');
assert.match(offline.text, /2 个任务结束：1 个完成，1 个失败/);
assert.equal(summarizeOfflineNotifications([]), null);
const restored = new QueueNotificationTracker(tracker.snapshot());
assert.equal(restored.observe(done), null, 'a reopened page does not repeat an already notified task');
console.log('QUEUE_NOTIFICATIONS_OK dedupe=true retry=true offlineSummary=true');
