import React from 'react';
import { hasUnconfirmedVideoSubmission } from './video-submission.js';
import './video-job-status.css';

export function videoExportLabel(id, data, label) {
  return hasUnconfirmedVideoSubmission({ id, data }) ? '核对原任务' : label;
}

export default function VideoJobStatus({ data, running, fallback }) {
  const terminal = ['cancelled', 'error'].includes(data.status);
  const stage = running || terminal ? data.stage || (running ? '导出中' : data.status === 'cancelled' ? '已取消' : '导出失败') : fallback;
  const progress = Math.round(Math.min(1, Math.max(0, Number(data.progress) || 0)) * 100);
  return <span className="video-job-status" role="status">
    <span>{stage}{running ? ` ${progress}%` : ''}</span>
    {running && <progress value={progress} max={100} aria-label="视频任务进度" />}
  </span>;
}
