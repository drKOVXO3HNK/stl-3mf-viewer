import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
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

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.2, 0);

scene.add(new THREE.HemisphereLight(0xcde0ff, 0x1a223a, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(4, 6, 5);
scene.add(dir);

const grid = new THREE.GridHelper(6, 24, 0x3f568f, 0x2a3a61);
grid.position.y = -0.0001;
scene.add(grid);

let modelRoot = null;

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
  camera.near = maxSize / 1000;
  camera.far = maxSize * 100;
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

function parse3MFArrayBuffer(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const modelPath = Object.keys(zip).find((k) => /(^|\/)3D\/.*\.model$/i.test(k)) || Object.keys(zip).find((k) => /\.model$/i.test(k));
  if (!modelPath) throw new Error('В 3MF не найден .model');

  const xmlText = strFromU8(zip[modelPath]);
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');

  const objectEls = byLocalName(xml, 'object');
  const objects = new Map();

  for (const objEl of objectEls) {
    const objId = objEl.getAttribute('id');
    if (!objId) continue;

    const meshEl = [...objEl.children].find((n) => n.localName === 'mesh');
    if (!meshEl) continue;

    const verticesEl = [...meshEl.children].find((n) => n.localName === 'vertices');
    const trianglesEl = [...meshEl.children].find((n) => n.localName === 'triangles');
    if (!verticesEl || !trianglesEl) continue;

    const vEls = [...verticesEl.children].filter((n) => n.localName === 'vertex');
    const tEls = [...trianglesEl.children].filter((n) => n.localName === 'triangle');

    const pos = [];
    for (const v of vEls) {
      pos.push(Number(v.getAttribute('x') || 0), Number(v.getAttribute('y') || 0), Number(v.getAttribute('z') || 0));
    }

    const idx = [];
    for (const t of tEls) {
      idx.push(Number(t.getAttribute('v1') || 0), Number(t.getAttribute('v2') || 0), Number(t.getAttribute('v3') || 0));
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();

    const mesh = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ color: 0xcfdcff, metalness: 0.12, roughness: 0.62 })
    );
    objects.set(objId, mesh);
  }

  const root = new THREE.Group();
  const buildEls = byLocalName(xml, 'item');

  if (buildEls.length) {
    for (const item of buildEls) {
      const id = item.getAttribute('objectid');
      if (!id || !objects.has(id)) continue;
      const inst = objects.get(id).clone();

      const t = item.getAttribute('transform');
      if (t) {
        const m = t.trim().split(/\s+/).map(Number);
        if (m.length === 12 && m.every((n) => Number.isFinite(n))) {
          const mat = new THREE.Matrix4();
          mat.set(
            m[0], m[1], m[2], m[3],
            m[4], m[5], m[6], m[7],
            m[8], m[9], m[10], m[11],
            0, 0, 0, 1
          );
          inst.applyMatrix4(mat);
        }
      }

      root.add(inst);
    }
  }

  if (!root.children.length) {
    for (const mesh of objects.values()) root.add(mesh);
  }

  if (!root.children.length) {
    throw new Error('Не удалось извлечь геометрию из 3MF');
  }

  return root;
}

function loadFromArrayBuffer(name, buffer) {
  const ext = name.toLowerCase().split('.').pop();
  clearModel();

  if (ext === 'stl') {
    const loader = new STLLoader();
    const geometry = loader.parse(buffer);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0xcfdcff, metalness: 0.15, roughness: 0.6 });
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
