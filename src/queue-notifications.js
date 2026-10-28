const TERMINAL = new Set(['done', 'error']);
const ACTIVE = new Set(['queued', 'running', 'finishing']);

export function notificationToken(job) {
  return `${job.id}:${job.finishedAt || job.updatedAt || job.attempts || 0}`;
}

export function isActiveJob(job) {
  return ACTIVE.has(job?.status);
}

export class QueueNotificationTracker {
  constructor(tokens = [], limit = 200) {
    this.tokens = new Set(tokens);
    this.limit = limit;
  }

  observe(job) {
    if (!TERMINAL.has(job?.status)) return null;
    const token = notificationToken(job);
    if (this.tokens.has(token)) return null;
    this.tokens.add(token);
    if (this.tokens.size > this.limit) this.tokens.delete(this.tokens.values().next().value);
    const label = job.kind === 'outfit' ? '换装任务' : '生成任务';
    return {
      type: job.status,
      text: job.status === 'done' ? `${label}已完成。` : `${label}失败，请查看节点错误并重试。`,
    };
  }

  snapshot() {
    return [...this.tokens];
  }
}

export function summarizeOfflineNotifications(items) {
  if (!items.length) return null;
  if (items.length === 1) return { ...items[0], text: `离线期间，${items[0].text}` };
  const failed = items.filter((item) => item.type === 'error').length;
  return {
    type: failed ? 'error' : 'done',
    text: `离线期间有 ${items.length} 个任务结束：${items.length - failed} 个完成，${failed} 个失败。`,
  };
}
