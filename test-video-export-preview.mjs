import assert from 'node:assert/strict';
import { videoExportPreviewPatch, videoExportPreviewSrc } from './src/video-export-preview.js';

const editId = `ved_${'a'.repeat(32)}`;
const rhythmId = `vry_${'b'.repeat(32)}`;

assert.equal(videoExportPreviewSrc('edit', editId, 12), `/api/video-edit/jobs/${editId}/preview?frame=12`);
assert.equal(videoExportPreviewSrc('rhythm', rhythmId, 0), `/api/video-rhythm/jobs/${rhythmId}/preview?frame=0`);
assert.equal(videoExportPreviewSrc('edit', 'ved_short', 1), null);
assert.equal(videoExportPreviewSrc('edit', editId, 1.5), null);
assert.equal(videoExportPreviewSrc('plate', editId, 1), null);
assert.deepEqual(videoExportPreviewPatch({ previewFrame: 4 }), { previewFrame: 4 });
assert.deepEqual(videoExportPreviewPatch({ previewFrame: -1 }), { previewFrame: null });
assert.deepEqual(videoExportPreviewPatch({}), { previewFrame: null });

console.log('video export preview urls accept only live edit and rhythm frames');
