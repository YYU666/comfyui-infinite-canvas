import assert from 'node:assert/strict';
import { createProjectSession, PROJECT_SESSION_KEY } from './src/project-session.js';

const values = new Map();
const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
const session = createProjectSession(() => storage);
let opens = 0;
assert.equal(await session.restore(() => { opens += 1; }), null);
assert.equal(opens, 0, 'no session must not guess the globally most recent project');
for (const raw of ['{', 'null', '[]', '{}', '{"version":2,"id":"A","readOnly":false}', '{"version":1,"id":"","readOnly":false}', '{"version":1,"id":"A","readOnly":"false"}']) {
  storage.setItem(PROJECT_SESSION_KEY, raw);
  assert.equal(session.read(), null);
}
const a = { id: 'A', readOnly: false };
session.remember(a);
assert.deepEqual(JSON.parse(storage.getItem(PROJECT_SESSION_KEY)), { version: 1, ...a });
const reloaded = createProjectSession(() => storage);
let release;
const open = (id, options) => { opens += 1; assert.equal(id, 'A'); assert.deepEqual(options, { readOnly: false }); return new Promise((resolve) => { release = resolve; }); };
const first = reloaded.restore(open);
assert.equal(reloaded.restore(open), first, 'effect replay shares pending restore');
await Promise.resolve();
release(a);
assert.equal(await first, a);
assert.equal(await reloaded.restore(open), a, 'remount reuses completed restore');
assert.equal(opens, 1);
const b = { id: 'B' };
Object.defineProperty(b, 'readOnly', { value: true });
reloaded.remember(b);
assert.deepEqual(reloaded.read(), { id: 'B', readOnly: true }, 'nonenumerable readOnly is preserved');
await createProjectSession(() => storage).restore(async (id, options) => {
  assert.equal(id, 'B'); assert.deepEqual(options, { readOnly: true }); return b;
});
reloaded.clear();
assert.equal(await createProjectSession(() => storage).restore(open), null);
assert.equal(opens, 1, 'explicit launcher never reopens');
session.remember(a);
await assert.rejects(createProjectSession(() => storage).restore(async () => { throw new Error('missing'); }), /missing/);
assert.equal(session.read(), null, 'failed restore clears stale target');
for (const getStorage of [() => { throw new Error('blocked getter'); }, () => ({ getItem() { throw Error('read'); }, setItem() { throw Error('full'); }, removeItem() { throw Error('remove'); } })]) {
  const blocked = createProjectSession(getStorage);
  assert.equal(blocked.read(), null);
  assert.equal(blocked.remember(a), a);
  blocked.clear();
  assert.equal(await blocked.restore(open), null);
}
console.log('PROJECT_SESSION_OK invalid=7 restoreDeduplicated=true readonly=true clear=true storageExceptions=true');
