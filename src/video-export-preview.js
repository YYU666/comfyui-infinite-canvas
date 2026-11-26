const JOB_ID = {
  edit: /^ved_[a-f0-9]{32}$/,
  rhythm: /^vry_[a-f0-9]{32}$/,
};

export function videoExportPreviewSrc(kind, jobId, frame) {
  if (!JOB_ID[kind]?.test(jobId) || !Number.isInteger(frame) || frame < 0 || frame > 1_000_000) return null;
  const route = kind === 'edit' ? '/api/video-edit/jobs/' : '/api/video-rhythm/jobs/';
  return `${route}${jobId}/preview?frame=${frame}`;
}

export function videoExportPreviewPatch(job) {
  const frame = job?.previewFrame;
  return { previewFrame: Number.isInteger(frame) && frame >= 0 && frame <= 1_000_000 ? frame : null };
}
