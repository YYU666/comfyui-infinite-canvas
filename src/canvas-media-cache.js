export function mediaCacheIdentity(data = {}) {
  return JSON.stringify([
    data.assetPath || '',
    data.mediaStorageId || '',
    data.remoteName || '',
    data.localFile ? '' : (data.url || ''),
    data.output ? (data.resultUrl || data.url || '') : '',
  ]);
}

/** Drop a cached File whenever history restores a different immutable asset. */
export function reconcileMediaCache(nodes, files, identities) {
  const nextFiles = {};
  const nextIdentities = {};
  for (const node of nodes || []) {
    const identity = mediaCacheIdentity(node.data);
    if (files[node.id] && identities[node.id] === identity) {
      nextFiles[node.id] = files[node.id];
      nextIdentities[node.id] = identity;
    }
  }
  return { files: nextFiles, identities: nextIdentities };
}

export function assertMediaCacheIdentity(node, file, identity) {
  if (file && identity !== mediaCacheIdentity(node?.data)) {
    throw new Error(`“${node?.data?.title || '素材'}”的缓存与当前资产不一致，请重新上传后再生成。`);
  }
}
