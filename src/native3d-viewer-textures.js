// ImageBitmapLoader fetches blob URLs under connect-src. HTML images instead
// use img-src, which already permits embedded GLB images in this application.
export function installViewerTextureLoader(loader,TextureLoader,manager) {
  loader.register(parser=>{
    parser.textureLoader=new TextureLoader(manager);
    return {name:'REFMUSE_local_embedded_images',beforeRoot(){
      for (const image of parser.json.images || []) {
        if (image.uri!==undefined && !/^data:image\/(png|jpeg|webp);base64,/i.test(image.uri)) throw new Error('模型贴图包含外部资源，已拒绝加载。');
      }
    }};
  });
  return loader;
}

export function assertViewerMaterialTextures(definitions,materials) {
  const slots=definition=>[
    [definition.pbrMetallicRoughness?.baseColorTexture,'map'],
    [definition.pbrMetallicRoughness?.metallicRoughnessTexture,'metalnessMap'],
    [definition.pbrMetallicRoughness?.metallicRoughnessTexture,'roughnessMap'],
    [definition.normalTexture,'normalMap'],[definition.occlusionTexture,'aoMap'],[definition.emissiveTexture,'emissiveMap'],
  ];
  let count=0;
  definitions.forEach((definition,index)=>{
    for (const [declared,slot] of slots(definition)) if (declared) {
      const texture=materials[index]?.[slot];
      if (!texture?.isTexture || !texture.image || !(texture.image.naturalWidth || texture.image.width)) throw new Error(`材质贴图未完整加载（${slot}），无法验证真实烘焙效果。`);
      count++;
    }
  });
  return count;
}
