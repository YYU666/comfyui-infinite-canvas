import { imageGenerationEvidence } from './image-visible-run.js';


const executionPreviews = new Map();
const reviewValue = (key, value) => typeof value === 'string'
  && /api[-_ ]?key|authorization|password|secret|credential|token/i.test(key) ? '[隐藏]' : value;
const PARAMETERS = ['prompt', 'negativePrompt', 'seed', 'ratio', 'resolution', 'duration', 'width', 'height',
  'steps', 'cfg', 'turbo', 'imageModel', 'qwenModel', 'extensionDigest', 'nodeDefinitionId', 'workflowParameters',
  'editDocument', 'speed', 'remapKeyframes', 'rhythmAudio'];

export function visibleGenerationRecord(node, references, settings, { requestId, origin }) {
  const image = imageGenerationEvidence(node, references, settings);
  return {
    requestId, origin, phase: 'prepared', engine: node.data.mode || node.type,
    inputs: image ? image.inputs.map(({ uploadedName, ...input }) => ({ ...input, resolvedName: uploadedName || null }))
      : references.map((reference) => ({ nodeId: reference.id, slot: reference.data.slot || null,
        title: reference.data.title || reference.id, assetPath: reference.data.assetPath || null,
        resolvedName: reference.data.remoteName || null })),
    basisRevision: settings.basisRevision,
    parameters: JSON.parse(JSON.stringify({
      ...Object.fromEntries(PARAMETERS.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]])),
      ...image?.parameters,
    }, reviewValue)),
  };
}

// The same exact serialized bytes are admitted by the server after save.
export async function captureVisibleExecution(workflow, plan) {
  const json = JSON.stringify({ workflow: workflow ?? null, plan: plan ?? null });
  const bytes = new TextEncoder().encode(json);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  return { json, record: { digest, bytes: bytes.length, kind: plan ? 'plan' : 'workflow' } };
}

export function stageVisibleExecutionPreview(requestId, execution) {
  if (execution.record.bytes <= 64 * 1024) {
    const preview = JSON.stringify(JSON.parse(execution.json), reviewValue, 2);
    executionPreviews.set(requestId, preview);
  }
}

export const getVisibleExecutionPreview = (requestId) => executionPreviews.get(requestId);
export const releaseVisibleExecutionPreview = (requestId) => executionPreviews.delete(requestId);

export function visibleGenerationFailure(error, requestId) {
  return { ok: false, code: error?.code || 'SUBMISSION_FAILED', error: error?.message || String(error), requestId };
}
