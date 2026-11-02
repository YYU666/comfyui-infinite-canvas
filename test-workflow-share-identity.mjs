import assert from 'node:assert/strict';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const saved = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) } });
try {
  const { sharePackageIdentity: identity, rememberSharePackageIdentity: remember } = await import('./src/workflow-share-identity.js');
  const first = identity('private-project', 'private-node');
  assert.match(first, /^u-[a-f0-9]{32}\/workflow-[a-f0-9]{32}$/);
  assert.ok(first.length <= 128);
  assert.equal(first.includes('private'), false);
  assert.equal(identity('private-project', 'private-node'), first);
  const second = identity('private-project', 'another-node');
  assert.notEqual(second, first);
  assert.equal(second.split('/')[0], first.split('/')[0]);
  assert.notEqual(identity('another-project', 'private-node'), first);
  const reloaded = await import('./src/workflow-share-identity.js?reload');
  assert.equal(reloaded.sharePackageIdentity('private-project', 'private-node'), first, 'identity survives module/browser restart');
  remember('private-project', 'private-node', 'my-author/my-node');
  assert.equal(identity('private-project', 'private-node'), 'my-author/my-node');
  remember('private-project', 'private-node', 'community/my-workflow');
  assert.equal(identity('private-project', 'private-node'), 'my-author/my-node');
  remember('private-project', 'private-node', '../invalid');
  assert.equal(identity('private-project', 'private-node'), 'my-author/my-node');
  const fresh = identity('private-project', 'private-node', { fresh: true });
  assert.notEqual(fresh.split('/')[0], first.split('/')[0]);
  assert.equal(identity('private-project', 'private-node'), fresh);
  assert.equal(identity('private-project', 'another-node'), second, 'regeneration does not change other packages');
  // Existing read-only storage must not override a regenerated identity in this session.
  const blocked = await import('./src/workflow-share-identity.js?blocked');
  localStorage.setItem = () => { throw new Error('quota'); };
  const temporary = blocked.sharePackageIdentity('private-project', 'another-node', { fresh: true });
  assert.equal(blocked.sharePackageIdentity('private-project', 'another-node'), temporary);
  localStorage.getItem = () => { throw new Error('unavailable'); };
  assert.equal(blocked.sharePackageIdentity('private-project', 'another-node'), temporary);
  assert.notEqual(blocked.sharePackageIdentity('private-project', 'third-node'), temporary);
  console.log('Share identity checks passed: unique defaults, node/project isolation, persistence, manual values, regeneration, storage fallback.');
} finally {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else delete globalThis.localStorage;
}
