import assert from 'node:assert/strict';
import { ensureReferenceTags, nextReferenceTag, referenceDescriptors, replaceReferenceTags } from './src/reference-tags.js';

const original = ensureReferenceTags([
  { id: 'b', type: 'media', data: { kind: 'image' } },
  { id: 'v', type: 'media', data: { kind: 'video' } },
  { id: 'a', type: 'media', data: { kind: 'image' } },
]);
assert.deepEqual(original.map((node) => node.data.refTag), ['<Picture 1>', '<Video 1>', '<Picture 2>']);
const reordered = referenceDescriptors([original[2], original[0], original[1]]);
assert.deepEqual(reordered.map(({ tag }) => tag), ['<Picture 2>', '<Picture 1>', '<Video 1>'], '重排不改变既有引用标签');
const duplicates = ensureReferenceTags([...original, { ...original[0], id: 'copy', data: { ...original[0].data } }]);
assert.equal(duplicates[3].data.refTag, '<Picture 3>');
assert.equal(new Set(duplicates.map((node) => node.data.refTag)).size, 4);
assert.equal(nextReferenceTag(duplicates, 'image'), '<Picture 4>');
assert.equal(replaceReferenceTags('Use <Picture 1> and <Video 1>; keep <Picture 9>.', new Map([['<Picture 1>', '<Picture 3>'], ['<Video 1>', '<Video 2>']])), 'Use <Picture 3> and <Video 2>; keep <Picture 9>.');
console.log('REFERENCE_TAGS_OK stable across reorder, unique after copy, prompt tags migrated');
