// Step 2 of the local asset pipeline: geometry only. UV and PBR/ORM stay later.
export const WHITE_MESH_STEP_LABEL = '图生白模 · 未展UV无材质';

const NAMED = /白模|未展\s*UV|white[-_ ]?mesh|geometry[-_ ]?only/i;

export function isWhiteMeshStep(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.operation === 'image_to_3d') return true;
  if (data.mode !== 'customWorkflow') return false;
  const definition = data.workflowDefinition || {};
  const marked = definition.geometryOnly === true || definition.step === 'white-mesh'
    || NAMED.test(`${definition.name || ''} ${definition.title || ''} ${data.title || ''}`);
  if (!marked) return false;
  const outputs = Array.isArray(definition.outputs) ? definition.outputs : [];
  const inputs = Array.isArray(definition.inputs) ? definition.inputs : [];
  if (!outputs.length || outputs.some((output) => output?.type !== 'model')) return false;
  if (inputs.some((input) => input?.type && input.type !== 'image')) return false;
  return true;
}

export function whiteMeshStepLabel(data) {
  return isWhiteMeshStep(data) ? WHITE_MESH_STEP_LABEL : null;
}
