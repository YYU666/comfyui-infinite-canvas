import React, { useEffect, useState } from 'react';
export function useResultPresentation(data, url, blocked = false, revealSettings = false) {
  const [expanded, setExpanded] = useState(revealSettings);
  const complete = Boolean(url) && ['done', 'completed'].includes(data.status) && !data.error && !data.shareError && !blocked;
  useEffect(() => { if (complete) setExpanded(revealSettings); }, [complete, url, revealSettings]);
  return { compact: complete && !expanded, complete, expanded, toggle: () => setExpanded(value => !value) };
}
export function ResultSettingsToggle({ presentation }) {
  return presentation.complete ? <button className="result-settings-toggle nodrag nopan" aria-label="调整设置" aria-expanded={presentation.expanded} onClick={presentation.toggle}>{presentation.expanded ? '收起设置' : '调整设置'}</button> : null;
}
export function openResultImage(event, url, title, isVideo, open) {
  if (!url || isVideo) return;
  event.preventDefault(); event.stopPropagation(); open({ url, title });
}

