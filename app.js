import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { unzipSync, strFromU8 } from 'https://esm.sh/fflate@0.8.2';

const canvas = document.getElementById('viewer');
const fileInput = document.getElementById('fileInput');
const resetBtn = document.getElementById('resetView');
const wireframeInput = document.getElementById('wireframe');
const info = document.getElementById('info');
const dropZone = document.getElementById('dropZone');

if (location.protocol === 'file:') {
  info.textContent = 'Открой через сервер (например: python -m http.server 8080), file:// часто ломает загрузчики';
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1630);

const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 2000);
camera.position.set(2.2, 1.8, 2.2);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.2, 0);

scene.add(new THREE.HemisphereLight(0xcfe1ff, 0x16203a, 0.95));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(4, 7, 5);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x9bb8ff, 0.45);
fillLight.position.set(-3, 3, -4);
scene.add(fillLight);

const grid = new THREE.GridHelper(6, 24, 0x3f568f, 0x2a3a61);
grid.position.y = -0.0001;
grid.renderOrder = -1;
const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
for (const m of gridMaterials) m.depthWrite = false;
scene.add(grid);

let modelRoot = null;

function createModelMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xdbe6ff,
    metalness: 0.08,
    roughness: 0.46,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
}

function optimizeGeometry(geometry) {
  let g = geometry.clone();
  if (!g.index) g = mergeVertices(g, 1e-6);
  if (!g.index) {
    g.computeVertexNormals();
    return g;
  }

  const src = g.index.array;
  const clean = [];
  const seen = new Set();

  for (let i = 0; i < src.length; i += 3) {
    const a = src[i], b = src[i + 1], c = src[i + 2];
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join('_');
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(a, b, c);
  }

  g.setIndex(clean);
  g.computeVertexNormals();
  return g;
}

function setSize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', setSize);
setSize();

function clearModel() {
  if (!modelRoot) return;
  scene.remove(modelRoot);
  modelRoot.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material.dispose();
    }
  });
  modelRoot = null;
}

function applyWireframe(enabled) {
  if (!modelRoot) return;
  modelRoot.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m) => (m.wireframe = enabled));
      else obj.material.wireframe = enabled;
    }
  });
}

function fitToView(object3d) {
  const box = new THREE.Box3().setFromObject(object3d);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxSize = Math.max(size.x, size.y, size.z) || 1;
  const fitDist = maxSize / (2 * Math.tan((Math.PI * camera.fov) / 360));

  controls.target.copy(center);
  camera.position.set(center.x + fitDist * 1.1, center.y + fitDist * 0.9, center.z + fitDist * 1.1);
  camera.near = Math.max(maxSize / 120, 0.001);
  camera.far = Math.max(maxSize * 18, 10);
  camera.updateProjectionMatrix();
  controls.update();
}

function normalizeModel(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 1.5 / maxDim;
  root.scale.setScalar(scale);

  root.position.x += -center.x * scale;
  root.position.y += -box.min.y * scale;
  root.position.z += -center.z * scale;
}

function byLocalName(root, name) {
  return [...root.getElementsByTagName('*')].filter((n) => n.localName === name);
}

function applyTransformFrom3mf(node, t) {
  if (!t) return;
  const m = t.trim().split(/\s+/).map(Number);
  if (m.length !== 12 || !m.every((n) => Number.isFinite(n))) return;
  const mat = new THREE.Matrix4();
  mat.set(
    m[0], m[1], m[2], m[3],
    m[4], m[5], m[6], m[7],
    m[8], m[9], m[10], m[11],
    0, 0, 0, 1
  );
  node.applyMatrix4(mat);
}

function parse3MFArrayBuffer(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const modelPaths = Object.keys(zip).filter((k) => /\.model$/i.test(k));
  if (!modelPaths.length) throw new Error('В 3MF не найден .model');

  const norm = (p) => p.replace(/^\/+/, '').replace(/\\/g, '/');
  const joinRef = (base, ref) => {
    const r = norm(ref || '');
    if (!r) return norm(base);
    if (r.includes(':/') || r.startsWith('3D/')) return r;
    const baseDir = norm(base).split('/').slice(0, -1).join('/');
    const parts = `${baseDir}/${r}`.split('/');
    const out = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    return out.join('/');
  };

  const docs = new Map();
  const objectDefs = new Map(); // key: modelPath#objectId

  for (const p of modelPaths) {
    const modelPath = norm(p);
    const xml = new DOMParser().parseFromString(strFromU8(zip[p]), 'application/xml');
    docs.set(modelPath, xml);

    for (const objEl of byLocalName(xml, 'object')) {
      const objId = objEl.getAttribute('id');
      if (!objId) continue;
      const key = `${modelPath}#${objId}`;

      const meshEl = [...objEl.children].find((n) => n.localName === 'mesh');
      const componentsEl = [...objEl.children].find((n) => n.localName === 'components');

      if (meshEl) {
        const verticesEl = [...meshEl.children].find((n) => n.localName === 'vertices');
        const trianglesEl = [...meshEl.children].find((n) => n.localName === 'triangles');
        if (!verticesEl || !trianglesEl) continue;

        const pos = [];
        for (const v of [...verticesEl.children].filter((n) => n.localName === 'vertex')) {
          pos.push(Number(v.getAttribute('x') || 0), Number(v.getAttribute('y') || 0), Number(v.getAttribute('z') || 0));
        }

        const idx = [];
        for (const t of [...trianglesEl.children].filter((n) => n.localName === 'triangle')) {
          idx.push(Number(t.getAttribute('v1') || 0), Number(t.getAttribute('v2') || 0), Number(t.getAttribute('v3') || 0));
        }

        objectDefs.set(key, { type: 'mesh', pos, idx });
      } else if (componentsEl) {
        const comps = [...componentsEl.children]
          .filter((n) => n.localName === 'component')
          .map((c) => ({
            objectId: c.getAttribute('objectid'),
            path: c.getAttribute('path') || '',
            transform: c.getAttribute('transform') || '',
          }))
          .filter((c) => c.objectId);
        if (comps.length) objectDefs.set(key, { type: 'components', comps });
      }
    }
  }

  const pickMainModel = () => {
    const preferred = modelPaths.map(norm).find((p) => /(^|\/)3D\/3dmodel\.model$/i.test(p));
    return preferred || norm(modelPaths[0]);
  };

  const buildObject = (modelPath, objectId, stack = new Set()) => {
    const m = norm(modelPath);
    const key = `${m}#${objectId}`;
    const def = objectDefs.get(key);
    if (!def || stack.has(key)) return null;

    if (def.type === 'mesh') {
      let g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(def.pos, 3));
      g.setIndex(def.idx);
      g = optimizeGeometry(g);
      return new THREE.Mesh(g, createModelMaterial());
    }

    const next = new Set(stack);
    next.add(key);
    const group = new THREE.Group();

    for (const c of def.comps) {
      const childModel = c.path ? joinRef(m, c.path) : m;
      const child = buildObject(childModel, c.objectId, next);
      if (!child) continue;
      applyTransformFrom3mf(child, c.transform);
      group.add(child);
    }

    return group.children.length ? group : null;
  };

  const root = new THREE.Group();
  const mainModel = pickMainModel();
  const mainXml = docs.get(mainModel);

  if (mainXml) {
    const buildEl = byLocalName(mainXml, 'build')[0];
    const buildItems = buildEl ? [...buildEl.children].filter((n) => n.localName === 'item') : [];

    for (const item of buildItems) {
      const id = item.getAttribute('objectid');
      const path = item.getAttribute('path') || '';
      if (!id) continue;
      const itemModel = path ? joinRef(mainModel, path) : mainModel;
      const node = buildObject(itemModel, id);
      if (!node) continue;
      applyTransformFrom3mf(node, item.getAttribute('transform') || '');
      root.add(node);
    }
  }

  if (!root.children.length) {
    for (const key of objectDefs.keys()) {
      const [m, id] = key.split('#');
      const node = buildObject(m, id);
      if (node) root.add(node);
    }
  }

  if (!root.children.length) throw new Error('Не удалось извлечь геометрию из 3MF');
  return root;
}

function loadFromArrayBuffer(name, buffer) {
  const ext = name.toLowerCase().split('.').pop();
  clearModel();

  if (ext === 'stl') {
    const loader = new STLLoader();
    let geometry = loader.parse(buffer);
    geometry = optimizeGeometry(geometry);
    const material = createModelMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    modelRoot = new THREE.Group();
    modelRoot.add(mesh);
  } else if (ext === '3mf') {
    modelRoot = parse3MFArrayBuffer(buffer);
  } else {
    throw new Error('Поддерживаются только STL и 3MF');
  }

  normalizeModel(modelRoot);
  scene.add(modelRoot);
  applyWireframe(wireframeInput.checked);
  fitToView(modelRoot);
  info.textContent = `Загружено: ${name}`;
}

async function handleFile(file) {
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    loadFromArrayBuffer(file.name, buf);
  } catch (e) {
    info.textContent = `Ошибка: ${e.message || 'не удалось открыть файл'}`;
  }
}

fileInput.addEventListener('change', (e) => handleFile(e.target.files?.[0]));
wireframeInput.addEventListener('change', () => applyWireframe(wireframeInput.checked));
resetBtn.addEventListener('click', () => {
  if (modelRoot) fitToView(modelRoot);
});

['dragenter', 'dragover'].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  });
});
dropZone.addEventListener('drop', (e) => handleFile(e.dataTransfer?.files?.[0]));

function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
