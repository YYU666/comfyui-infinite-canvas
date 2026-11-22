import { IMAGE_MODEL_BY_ID, modelNodeClasses } from './src/image-model-catalog.js';

export function installedImageModelDefinitions(modelId, context) {
  const model = IMAGE_MODEL_BY_ID[modelId];
  const definitions = Object.fromEntries(modelNodeClasses(model, context).map(name => [name, { input: { required: {} } }]));
  for (const { loader, name } of model.files) {
    const node = { unet: 'UNETLoader', clip: 'CLIPLoader', vae: 'VAELoader' }[loader];
    const options = (definitions[node].input.required[`${loader}_name`] ||= [[]]);
    options[0].push(name);
  }
  definitions.CLIPLoader.input.required.type = [[model.clipType]];
  return definitions;
}
