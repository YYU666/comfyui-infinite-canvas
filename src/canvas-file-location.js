export function nodeFileLocation(node, projectId, origin = 'http://localhost') {
  const data = node?.data || {};
  // Uploaded replacements can retain stale ComfyUI output metadata.
  if (data.assetPath) return projectId ? { kind: 'project', projectId, assetPath: data.assetPath } : null;
  if (data.output && data.filename) return { kind: 'output', name: `${data.subfolder ? `${data.subfolder}/` : ''}${data.filename}` };
  if (data.remoteName) return { kind: 'input', name: data.remoteName };
  if (data.resultUrl) {
    try {
      const params = new URL(data.resultUrl, origin).searchParams;
      const filename = params.get('filename');
      if (filename) return { kind: params.get('type') || 'output', name: `${params.get('subfolder') ? `${params.get('subfolder')}/` : ''}${filename}` };
    } catch { /* A malformed media URL has no revealable location. */ }
  }
  return null;
}

export async function revealProjectAsset(file) {
  const response = await fetch(`/api/projects/${encodeURIComponent(file.projectId)}/assets/reveal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetPath: file.assetPath }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '无法打开文件位置。');
  return body;
}
