// Node previews derive from original identities. Never store a thumbnail URL in
// node.data: preview, masks, generation references and exports need the original.
const ORIGIN = 'http://canvas.local';

export function thumbnailUrl(source) {
  if (typeof source !== 'string' || !source.startsWith('/') || source.startsWith('//')) return null;
  try {
    const url = new URL(source, ORIGIN);
    const asset = url.pathname.match(/^\/api\/projects\/(prj_[A-Za-z0-9_-]+)\/assets\/([^/]+)$/);
    let params;
    if (asset) {
      const filename = decodeURIComponent(asset[2]);
      if (!safePath(filename)) return null;
      params = new URLSearchParams({ project: asset[1], asset: `assets/${filename}` });
    } else if (url.pathname === '/api/comfy/view') {
      const filename = url.searchParams.get('filename');
      const subfolder = url.searchParams.get('subfolder') || '';
      const type = url.searchParams.get('type') || 'output';
      if (!safePath(filename) || (subfolder && !safePath(subfolder, true)) || !['input', 'output', 'temp'].includes(type)) return null;
      params = new URLSearchParams({ filename, subfolder, type });
    } else return null;
    return `/api/thumbnails?${params}`;
  } catch { return null; }
}

function safePath(value, nested = false) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\0]/.test(value)
    && (nested || !value.includes('/')) && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

export function hydrateProjectMedia(nodes, projectId) {
  return (nodes || []).map((node) => {
    if (node.type !== 'media' || !node.data?.assetPath) return node;
    const parts = node.data.assetPath.split('/');
    if (parts.length !== 2 || parts[0] !== 'assets' || !safePath(parts[1])) return { ...node, data: { ...node.data, url: null } };
    const url = `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(parts[1])}`;
    return { ...node, data: { ...node.data, url } };
  });
}
