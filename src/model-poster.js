const cache = new Map();
let running = 0;
const waiters = [];
const MAX_CONCURRENT = 1;

function acquire() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => { waiters.push(resolve); });
}

function release() {
  running -= 1;
  const next = waiters.shift();
  if (next) {
    running += 1;
    next();
  }
}

export function clearModelPosterCache() {
  cache.clear();
}

export function cachedModelPoster(url) {
  return cache.get(url) || '';
}

async function renderGlbPoster(url) {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const response = await fetch(url);
  if (!response.ok) throw new Error('模型预览读取失败');
  const buffer = await response.arrayBuffer();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((resource) => {
    if (/^(blob:|data:)/.test(resource)) return resource;
    throw new Error('预览拒绝加载外部资源');
  });
  const gltf = await new GLTFLoader(manager).parseAsync(buffer, '');
  const model = gltf.scene;
  const owned = [];
  model.traverse((object) => {
    if (!object.isMesh) return;
    const source = object.material;
    const textured = source && (source.map || source.normalMap || source.emissiveMap);
    if (textured) return;
    const clay = new THREE.MeshStandardMaterial({ color: 0xd7dee8, roughness: 0.72, metalness: 0.04, side: THREE.DoubleSide });
    owned.push(clay);
    object.material = clay;
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1b2430');
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.01);
  model.position.sub(center);
  const key = new THREE.DirectionalLight(0xfff4e8, 3.2);
  key.position.set(size, size * 1.4, size * 0.8);
  scene.add(model, new THREE.HemisphereLight(0xffffff, 0x66707c, 1.4), key);
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.001, size * 40);
  camera.position.set(size * 0.9, size * 0.55, size * 1.15);
  camera.lookAt(0, 0, 0);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(480, 270, false);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  } finally {
    model.traverse((object) => {
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      for (const material of materials) {
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
    for (const material of owned) material.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement?.remove?.();
  }
}

export async function captureModelPoster(url, hooks = {}) {
  if (!url) return '';
  if (cache.has(url)) return cache.get(url);
  await acquire();
  try {
    if (cache.has(url)) return cache.get(url);
    const image = await (hooks.render ? hooks.render(url) : renderGlbPoster(url));
    if (image) cache.set(url, image);
    return image || '';
  } finally {
    release();
  }
}
