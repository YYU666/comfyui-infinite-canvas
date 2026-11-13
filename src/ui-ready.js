// The launch page (frontend root) is enough. Do not wait for a project to open.
export function reportUiReady(fetchImpl = fetch) {
  return fetchImpl('/api/ui-ready', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => null);
}
