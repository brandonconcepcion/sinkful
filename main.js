import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import * as sfx from './sfx.js';
import { unlockCloud, forgetCloud } from './vault.js';

// ---------------------------------------------------------------------------
// Task model: the dish type is the task's size, the grime is its urgency.
// ---------------------------------------------------------------------------
const DISHES = {
  fork:  { file: 'utensil-fork', label: 'Fork',  size: '2 min' },
  glass: { file: 'glass',        label: 'Glass', size: '10 min' },
  mug:   { file: 'mug',          label: 'Mug',   size: '15 min' },
  plate: { file: 'plate',        label: 'Plate', size: '30 min' },
  bowl:  { file: 'bowl',         label: 'Bowl',  size: '1 hr' },
  pan:   { file: 'frying-pan',   label: 'Pan',   size: '2 hr' },
  pot:   { file: 'pot',          label: 'Pot',   size: 'half day' },
};
const GRIME = {
  1: { label: 'Rinse',    color: 0xc8a978, blobs: 4 },
  2: { label: 'Crusty',   color: 0x8a5a2b, blobs: 7 },
  3: { label: 'Burnt-on', color: 0x3b2414, blobs: 11 },
};
const DISH_SCALE = 2.2;
// Metal dishes ring when they land and get the brush instead of the sponge.
const METAL = new Set(['pot', 'pan']);
const STORAGE_KEY = 'sinkful.tasks.v1';

const SEED = [
  { title: 'Reply to recruiter emails', type: 'glass', grime: 2 },
  { title: 'Review open PRs', type: 'plate', grime: 3, notes: 'Two are waiting on me' },
  { title: 'Write weekly update', type: 'bowl', grime: 2 },
  { title: 'Plan next sprint', type: 'pot', grime: 1 },
  { title: 'Book dentist', type: 'fork', grime: 1 },
  { title: 'Fix flaky CI test', type: 'pan', grime: 3 },
  { title: 'Expense the team lunch', type: 'mug', grime: 2 },
  { title: 'Read design doc', type: 'plate', grime: 1 },
];

// Sink interior in world units (counter top is y = 0).
const SINK = { w: 6.4, d: 4.4, depth: 1.8 };
const FLOOR_Y = -SINK.depth;
const RACK = { x: 6.9, z: 0.2, w: 4.2, d: 4.0, top: 0.22 };
// Soaking tub left of the sink for long-running tasks: a 3 x 2 grid of spots in soapy water.
// Capacity is just the number of spots, so add or remove spots here to resize it.
const TUB = { x: -6.5, z: 0.2, w: 5.0, d: 3.8, h: 1.0, wall: 0.12, floor: 0.1, water: 0.72 };
const SPOTS = [-1.55, 0, 1.55].flatMap((x) => [-0.85, 0.85].map((z) => new THREE.Vector3(TUB.x + x, TUB.floor, TUB.z + z)));
// Where a dish is held while it gets washed: right under the faucet spout.
const SPOUT = new THREE.Vector3(0, 2.3, -0.9);
const WASH_POS = new THREE.Vector3(0, 0.9, -0.9);

// ---------------------------------------------------------------------------
// Renderer, camera, lights
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
// GPU memory scales with pixels: cap the pixel ratio, and only pay for MSAA on 1x screens.
const PIXEL_RATIO = Math.min(devicePixelRatio, 1.5);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: PIXEL_RATIO < 1.25, powerPreference: 'low-power' });
renderer.setPixelRatio(PIXEL_RATIO);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd9e4e2);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
// Home view is recomputed on resize (fitHome) so tub, sink and rack fill the space above the panel.
const HOME_VIEW = { pos: new THREE.Vector3(0.6, 15.2, 7.6), look: new THREE.Vector3(0.6, -1.6, 1.6) };
const VIEW_TILT = new THREE.Vector3(0, 16.8, 6.0).normalize();
// Everything the home view must show: tub, sink, faucet, rack.
const FIT_BOX = new THREE.Box3(new THREE.Vector3(-9.05, 0, -3.3), new THREE.Vector3(9.35, 2.6, 2.5));
// The add button sits on the back counter, right of the faucet.
const ADD_SPOT = new THREE.Vector3(2.3, 0, -3.6);
const ZONES = { soak: [-8.96, -4.04], sink: [-3.45, 3.45], rack: [4.45, 9.35] };
const WASH_VIEW = { pos: new THREE.Vector3(1.0, 4.9, 4.6), look: new THREE.Vector3(-0.5, 0.75, -0.9) };
const view = { pos: HOME_VIEW.pos.clone(), look: HOME_VIEW.look.clone() };
function applyView() {
  camera.position.copy(view.pos);
  camera.lookAt(view.look);
}
applyView();

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9a96, 0.6));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
sun.position.set(-4, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 10, bottom: -10, near: 1, far: 40 });
sun.shadow.bias = -0.0005;
scene.add(sun);

// Depth of field: during the wash the kitchen behind the dish goes soft.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bokeh = new BokehPass(scene, camera, { focus: 6, aperture: 0.004, maxblur: 0 });
composer.addPass(bokeh);
composer.addPass(new OutputPass());
const dof = { amount: 0, target: 0, point: new THREE.Vector3() };
function focusOn(point) {
  dof.target = point ? 1 : 0;
  if (point) dof.point.copy(point);
}
// The blur's full-screen buffers are only needed mid-wash; give the memory back afterwards.
// (Three.js reallocates them automatically the next time the composer renders.)
let dofAllocated = false;
function releaseBlurBuffers() {
  composer.renderTarget1.dispose();
  composer.renderTarget2.dispose();
  bokeh.renderTargetDepth.dispose();
  dofAllocated = false;
}

let washing = null; // the dish being washed, or 'finale'
let needsRender = true; // set when something changes while the scene is otherwise idle
const invalidate = () => { needsRender = true; };
const HEADER_SPACE = 24;
const panelHeight = () => THREE.MathUtils.clamp(Math.round(innerHeight * 0.22), 140, 220);

// Project world points through a camera placed at `pose`; returns screen-pixel bounds.
const fitCam = new THREE.PerspectiveCamera();
function screenBounds(pose, points) {
  fitCam.copy(camera);
  fitCam.position.copy(pose.pos);
  fitCam.lookAt(pose.look);
  fitCam.updateMatrixWorld();
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of points) {
    const v = p.clone().project(fitCam);
    const x = ((v.x + 1) / 2) * innerWidth, y = ((1 - v.y) / 2) * innerHeight;
    b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
  }
  return b;
}
function fitHome() {
  const top = HEADER_SPACE, bottom = innerHeight - panelHeight() - 28;
  const availW = innerWidth - 32, availH = Math.max(120, bottom - top);
  const { min, max } = FIT_BOX;
  const corners = [];
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) corners.push(new THREE.Vector3(x, y, z));
  const center = FIT_BOX.getCenter(new THREE.Vector3()).setY(0);
  const pose = (d, shift) => ({ pos: center.clone().addScaledVector(VIEW_TILT, d).add(shift), look: center.clone().add(shift) });
  // Closest distance where the whole box still fits.
  let lo = 4, hi = 90;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const b = screenBounds(pose(mid, new THREE.Vector3()), corners);
    if (b.maxX - b.minX <= availW && b.maxY - b.minY <= availH) hi = mid; else lo = mid;
  }
  // Slide the camera sideways/up so the box sits centred in the free area.
  const shift = new THREE.Vector3();
  const pxToWorld = (2 * hi * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / innerHeight;
  for (let i = 0; i < 3; i++) {
    const b = screenBounds(pose(hi, shift), corners);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(fitCam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(fitCam.quaternion);
    shift.addScaledVector(right, ((b.minX + b.maxX) / 2 - innerWidth / 2) * pxToWorld);
    shift.addScaledVector(up, -((b.minY + b.maxY) / 2 - (top + bottom) / 2) * pxToWorld); // screen y grows downward
  }
  const p = pose(hi, shift);
  HOME_VIEW.pos.copy(p.pos);
  HOME_VIEW.look.copy(p.look);
  layoutPanel();
}
// Each panel column sits under its zone of the kitchen, like a label.
function layoutPanel() {
  const spot = screenBounds(HOME_VIEW, [ADD_SPOT]);
  const add = document.getElementById('add-btn'); // runs before the $ helper is defined
  add.style.left = `${spot.minX}px`;
  add.style.top = `${spot.minY}px`;
  const list = document.querySelector('.list');
  list.style.height = `${panelHeight()}px`;
  const cols = [...list.querySelectorAll('.col')];
  const spans = Object.values(ZONES).map(([a, b]) => {
    const r = screenBounds(HOME_VIEW, [new THREE.Vector3(a, 0, 2.5), new THREE.Vector3(b, 0, 2.5)]);
    return [r.minX, r.maxX];
  });
  const tooNarrow = spans.some(([a, b]) => b - a < 200);
  cols.forEach((col, i) => {
    let [a, b] = spans[i];
    if (tooNarrow) { // small screens: three equal columns
      const w = (innerWidth - 32 - 16) / 3;
      a = 16 + i * (w + 8); b = a + w;
    }
    col.style.left = `${Math.max(8, a)}px`;
    col.style.width = `${Math.min(innerWidth - 8, b) - Math.max(8, a)}px`;
  });
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(1); // the blur pass doesn't need Retina pixels
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fitHome();
  if (!washing) { view.pos.copy(HOME_VIEW.pos); view.look.copy(HOME_VIEW.look); }
  invalidate();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Kitchen: counter with a cut-out, steel basin, faucet, soaking tub, drying rack
// ---------------------------------------------------------------------------
const sphereGeoShared = new THREE.SphereGeometry(1, 12, 8);
const sudsMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, transparent: true, opacity: 0.95 });
const steel = new THREE.MeshStandardMaterial({ color: 0xc6cbd0, metalness: 0.85, roughness: 0.32 });
const counterTex = speckleTexture();
const counterMat = new THREE.MeshStandardMaterial({ map: counterTex, roughness: 0.55 });
const wallMat = new THREE.MeshStandardMaterial({ color: 0x9cc7bd, roughness: 0.9 });

function speckleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#ece6da';
  g.fillRect(0, 0, 512, 512);
  const flecks = ['#d6cebe', '#f7f3eb', '#c9bfad', '#b5aa97'];
  for (let i = 0; i < 4200; i++) {
    g.globalAlpha = 0.35 + Math.random() * 0.4;
    g.fillStyle = flecks[i % flecks.length];
    g.beginPath();
    g.arc(Math.random() * 512, Math.random() * 512, 0.6 + Math.random() * 1.6, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
// Counter slabs get their own texture repeat so the speckle scale matches across slabs.
function counterBox(w, h, d, x, y, z) {
  const mat = counterMat.clone();
  mat.map = counterTex.clone();
  mat.map.repeat.set(w / 3, d / 3);
  return box(w, h, d, mat, x, y, z);
}

function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  return m;
}

(function buildKitchen() {
  const T = 0.3; // counter thickness
  const CW = 34, CD = 10;
  const hx = SINK.w / 2 + 0.25, hz = SINK.d / 2 + 0.25; // hole incl. steel lip
  // Counter as four slabs around the sink hole.
  counterBox((CW / 2) - hx, T, CD, -(hx + (CW / 2 - hx) / 2), -T / 2, 0);
  counterBox((CW / 2) - hx, T, CD, hx + (CW / 2 - hx) / 2, -T / 2, 0);
  counterBox(hx * 2, T, CD / 2 - hz, 0, -T / 2, -(hz + (CD / 2 - hz) / 2));
  counterBox(hx * 2, T, CD / 2 - hz, 0, -T / 2, hz + (CD / 2 - hz) / 2);
  // Steel lip around the hole.
  box(hx * 2, 0.04, 0.25, steel, 0, 0.02, -hz + 0.125);
  box(hx * 2, 0.04, 0.25, steel, 0, 0.02, hz - 0.125);
  box(0.25, 0.04, hz * 2, steel, -hx + 0.125, 0.02, 0);
  box(0.25, 0.04, hz * 2, steel, hx - 0.125, 0.02, 0);
  // Basin.
  const W = SINK.w, D = SINK.d, H = SINK.depth, t = 0.06;
  box(W, t, D, steel, 0, FLOOR_Y - t / 2, 0);
  box(W, H, t, steel, 0, -H / 2, -D / 2 - t / 2);
  box(W, H, t, steel, 0, -H / 2, D / 2 + t / 2);
  box(t, H, D, steel, -W / 2 - t / 2, -H / 2, 0);
  box(t, H, D, steel, W / 2 + t / 2, -H / 2, 0);
  const drain = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 24), new THREE.MeshStandardMaterial({ color: 0x555a60, metalness: 0.9, roughness: 0.4 }));
  drain.position.set(0, FLOOR_Y + 0.01, 0);
  scene.add(drain);
  // Backsplash wall.
  box(CW, 8, 0.3, wallMat, 0, 4, -CD / 2 - 0.15);
  // Faucet: base, riser, arm reaching over the sink, downward spout.
  const fz = -SINK.d / 2 - 0.9;
  box(0.5, 0.2, 0.5, steel, 0, 0.1, fz);
  const riser = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 2.4, 20), steel);
  riser.position.set(0, 1.3, fz);
  riser.castShadow = true;
  scene.add(riser);
  const armLen = SPOUT.z - fz;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, armLen, 20), steel);
  arm.rotation.x = Math.PI / 2;
  arm.position.set(0, 2.5, fz + armLen / 2);
  arm.castShadow = true;
  scene.add(arm);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.25, 20), steel);
  nozzle.position.set(SPOUT.x, SPOUT.y + 0.12, SPOUT.z);
  scene.add(nozzle);
})();

// Running water from the spout down to whatever it hits.
const water = new THREE.Mesh(
  new THREE.CylinderGeometry(0.09, 0.13, 1, 16, 1, true),
  new THREE.MeshStandardMaterial({ color: 0x7cc8f5, emissive: 0x2a7fb8, emissiveIntensity: 0.35, transparent: true, opacity: 0, roughness: 0.05 }),
);
water.visible = false;
scene.add(water);
function setWater(on, bottomY = WASH_POS.y) {
  water.visible = on;
  if (!on) return;
  const top = SPOUT.y, len = Math.max(0.1, top - bottomY);
  water.position.set(SPOUT.x, top - len / 2, SPOUT.z);
  water.scale.set(1, len, 1);
}

const rackMat = new THREE.MeshStandardMaterial({ color: 0xdfe5e6, metalness: 0.55, roughness: 0.3 });
const tubFoam = [];
(function buildTub() {
  const plastic = new THREE.MeshStandardMaterial({ color: 0x4f9fbf, roughness: 0.5 });
  const { x, z, w, d, h, wall } = TUB;
  box(w, TUB.floor, d, plastic, x, TUB.floor / 2, z);
  box(w, h, wall, plastic, x, h / 2, z - d / 2 + wall / 2);
  box(w, h, wall, plastic, x, h / 2, z + d / 2 - wall / 2);
  box(wall, h, d, plastic, x - w / 2 + wall / 2, h / 2, z);
  box(wall, h, d, plastic, x + w / 2 - wall / 2, h / 2, z);
  // Rolled lip around the top.
  const lip = new THREE.MeshStandardMaterial({ color: 0x6db6d1, roughness: 0.45 });
  box(w + 0.12, 0.08, wall + 0.12, lip, x, h, z - d / 2 + wall / 2);
  box(w + 0.12, 0.08, wall + 0.12, lip, x, h, z + d / 2 - wall / 2);
  box(wall + 0.12, 0.08, d, lip, x - w / 2 + wall / 2, h, z);
  box(wall + 0.12, 0.08, d, lip, x + w / 2 - wall / 2, h, z);
  // Soapy water, drawn after the dishes so they show through it.
  const iw = w - wall * 2, id = d - wall * 2, depth = TUB.water - TUB.floor;
  const water = new THREE.Mesh(
    new THREE.BoxGeometry(iw, depth, id),
    new THREE.MeshStandardMaterial({ color: 0x6fc0de, transparent: true, opacity: 0.55, roughness: 0.05, depthWrite: false }),
  );
  water.position.set(x, TUB.floor + depth / 2, z);
  water.renderOrder = 1;
  scene.add(water);
  // Suds floating on top, mostly hugging the walls.
  for (let i = 0; i < 60; i++) {
    const edge = Math.random() < 0.65;
    const fx = edge ? (Math.random() < 0.5 ? -1 : 1) * (iw / 2 - Math.random() * 0.4) : (Math.random() - 0.5) * iw * 0.9;
    const fz = edge && Math.random() < 0.5 ? (Math.random() < 0.5 ? -1 : 1) * (id / 2 - Math.random() * 0.4) : (Math.random() - 0.5) * id * 0.9;
    const m = new THREE.Mesh(sphereGeoShared, sudsMat);
    const r = 0.07 + Math.random() * 0.13;
    m.scale.set(r, r * 0.6, r);
    m.position.set(x + fx, TUB.water + 0.01, z + fz);
    m.userData.phase = Math.random() * Math.PI * 2;
    scene.add(m);
    tubFoam.push(m);
  }
})();

(function buildRack() {
  const { x, z, w, d, top } = RACK;
  // Drainboard: a shallow tray with a rim and drainage grooves.
  const tray = new THREE.MeshStandardMaterial({ color: 0x8fbcae, roughness: 0.5 });
  const groove = new THREE.MeshStandardMaterial({ color: 0x78a898, roughness: 0.6 });
  const tw = w + 0.5, td = d + 0.5;
  box(tw, 0.05, td, tray, x, 0.025, z);
  box(tw, 0.1, 0.08, tray, x, 0.05, z - td / 2 + 0.04);
  box(tw, 0.1, 0.08, tray, x, 0.05, z + td / 2 - 0.04);
  box(0.08, 0.1, td, tray, x - tw / 2 + 0.04, 0.05, z);
  box(0.08, 0.1, td, tray, x + tw / 2 - 0.04, 0.05, z);
  for (let i = 1; i < 10; i++) box(0.035, 0.012, td - 0.3, groove, x - tw / 2 + (i * tw) / 10, 0.055, z);

  // Wire basket: a floor grid, two rails, corner posts, and plate tines in the back row.
  const wireGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 8);
  const up = new THREE.Vector3(0, 1, 0);
  const wire = (a, b) => {
    const m = new THREE.Mesh(wireGeo, rackMat);
    const dir = new THREE.Vector3().subVectors(b, a);
    m.position.copy(a).addScaledVector(dir, 0.5);
    m.quaternion.setFromUnitVectors(up, dir.clone().normalize());
    m.scale.y = dir.length();
    m.castShadow = true;
    scene.add(m);
  };
  const L = x - w / 2, R = x + w / 2, B = z - d / 2, F = z + d / 2;
  const V = (px, py, pz) => new THREE.Vector3(px, py, pz);
  for (let zz = B; zz <= F + 0.01; zz += d / 5) wire(V(L, top, zz), V(R, top, zz));
  for (let xx = L; xx <= R + 0.01; xx += w / 3) wire(V(xx, top, B), V(xx, top, F));
  for (const y of [0.8]) {
    wire(V(L, y, B), V(R, y, B));
    wire(V(L, y, F), V(R, y, F));
    wire(V(L, y, B), V(L, y, F));
    wire(V(R, y, B), V(R, y, F));
  }
  for (const [cx, cz] of [[L, B], [R, B], [L, F], [R, F]]) wire(V(cx, 0.05, cz), V(cx, 0.8, cz));
  const row = z - 0.9;
  for (let xx = L + 0.2; xx <= R - 0.1; xx += 0.42) {
    for (const off of [-0.32, 0.32]) wire(V(xx, top, row + off), V(xx, top + 0.6, row + off));
  }
})();

// ---------------------------------------------------------------------------
// Decor on the back counter. Each piece can be picked up and turned (see "Counter props"),
// but always goes back to its spot and is never saved.
// Keep x 1.2..3.4 near the faucet clear for the Add a dish button.
// ---------------------------------------------------------------------------
const DECOR = [
  // file under models/, target height in world units, position on the counter, turn, surprise
  { file: 'decor/pottedPlant', name: 'Potted plant', fx: 'wobble', h: 2.6, x: -7.1, z: -4.1, rot: 0.3 },
  { file: 'knife-block', name: 'Knife block', fx: 'rattle', h: 1.3, x: -6.0, z: -4.4, rot: 0.5 },
  { file: 'cutting-board', name: 'Cutting board', fx: 'flip', h: 0.12, x: -4.9, z: -3.75, rot: 0.15 },
  { file: 'lemon', name: 'Lemon', fx: 'squeeze', h: 0.42, x: -4.6, z: -3.7, y: 0.12, rot: 1 },
  { file: 'decor/plantSmall2', name: 'Little cactus', fx: 'wobble', h: 0.85, x: -2.7, z: -4.2 },
  { file: 'shaker-salt', name: 'Salt shaker', fx: 'salt', h: 0.7, x: 3.75, z: -3.5 },
  { file: 'pepper-mill', name: 'Pepper mill', fx: 'grind', h: 0.95, x: 4.25, z: -3.75 },
  { file: 'bottle-oil', name: 'Olive oil', fx: 'glug', h: 1.25, x: 4.3, z: -4.5 },
  { file: 'decor/toaster', name: 'Toaster', fx: 'toast', h: 1.0, x: 5.7, z: -4.15, tint: 0xf4a28c },
];
const UTENSILS = [['cooking-spoon', -0.08, 0.12], ['whisk', 0.1, -0.1], ['cooking-spatula', -0.05, -0.15]];

// Load a GLB, optionally stand it upright, then scale to `h` with its base at y = 0.
async function loadProp(file, h, { upright = false } = {}) {
  const model = (await loader.loadAsync(`models/${file}.glb`)).scene;
  const inner = new THREE.Group();
  inner.add(model);
  const raw = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  if (upright) { // stand a long, flat utensil on its handle
    if (raw.x >= raw.y && raw.x >= raw.z) model.rotation.z = Math.PI / 2;
    else if (raw.z >= raw.y) model.rotation.x = Math.PI / 2;
  }
  inner.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(inner).getSize(new THREE.Vector3());
  inner.scale.setScalar(h / size.y);
  inner.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(inner);
  const c = bb.getCenter(new THREE.Vector3());
  model.parent.position.set(-c.x, -bb.min.y, -c.z);
  const prop = new THREE.Group();
  prop.add(inner);
  prop.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return prop;
}

async function buildDecor() {
  await Promise.all(DECOR.map(async (d) => {
    const prop = await loadProp(d.file, d.h);
    // Tint multiplies the model's colours, so dark details (like toaster slots) stay dark.
    if (d.tint) prop.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.multiply(new THREE.Color(d.tint)); } });
    prop.position.set(d.x, d.y || 0, d.z);
    prop.rotation.y = d.rot || 0;
    addProp(prop, d.name, d.fx);
  }));

  // Utensil crock with spoon, whisk and spatula.
  const crock = new THREE.Group();
  const glaze = new THREE.MeshPhysicalMaterial({ color: 0x3a7ca5, roughness: 0.25, clearcoat: 0.8, side: THREE.DoubleSide });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.32, 0.8, 28, 1, true), glaze);
  wall.position.y = 0.4;
  const base = new THREE.Mesh(new THREE.CircleGeometry(0.32, 28), glaze);
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.02;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.035, 10, 32), glaze);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.8;
  crock.add(wall, base, rim);
  for (const [name, dx, dz] of UTENSILS) {
    const u = await loadProp(name, 1.5, { upright: true });
    u.position.set(dx, 0.1, dz);
    u.rotation.set(dz * 1.2, Math.random() * Math.PI, -dx * 1.4);
    crock.add(u);
  }
  crock.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  crock.position.set(7.2, 0, -4.2);
  addProp(crock, 'Utensil crock', 'rattle');

  // Hand-soap pump by the faucet.
  const pump = new THREE.Group();
  const soapGlass = new THREE.MeshPhysicalMaterial({ color: 0x58c98a, roughness: 0.12, transmission: 0.3, thickness: 0.4, clearcoat: 1 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf6f3ec, roughness: 0.35 });
  const part = (geo, mat, y, x = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, 0); m.rotation.z = rz; m.castShadow = true; pump.add(m); };
  part(new THREE.CylinderGeometry(0.24, 0.26, 0.75, 24), soapGlass, 0.375);
  part(new THREE.CylinderGeometry(0.265, 0.265, 0.3, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0xfff3dc, roughness: 0.8 }), 0.35);
  part(new THREE.CylinderGeometry(0.11, 0.13, 0.1, 18), white, 0.8);
  part(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 10), white, 0.94);
  part(new THREE.BoxGeometry(0.2, 0.1, 0.12), white, 1.07);
  part(new THREE.CylinderGeometry(0.028, 0.028, 0.24, 10), white, 1.06, 0.2, Math.PI / 2);
  pump.position.set(-0.95, 0, -3.15);
  pump.rotation.y = 0.5;
  addProp(pump, 'Hand soap', 'pump');

  // A spare sponge resting by the soap.
  const spare = new THREE.Group();
  const s1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.34), new THREE.MeshStandardMaterial({ color: 0xfff07a, roughness: 0.95 }));
  s1.position.y = 0.13;
  const s2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.34), new THREE.MeshStandardMaterial({ color: 0x2f8f45, roughness: 1 }));
  s2.position.y = 0.03;
  spare.add(s1, s2);
  spare.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  spare.position.set(-1.75, 0, -3.05);
  spare.rotation.y = -0.35;
  addProp(spare, 'Spare sponge', 'squeeze');

  // Striped tea towel draped over the tub's front edge.
  const towelMat = new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.95 });
  const front = TUB.z + TUB.d / 2;
  const tx = TUB.x + 0.95;
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.03, 0.32), towelMat);
  top.position.set(tx, TUB.h + 0.06, front - 0.02);
  const hang = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.8, 0.03), towelMat);
  hang.position.set(tx, TUB.h - 0.33, front + 0.15);
  hang.rotation.x = 0.06;
  for (const m of [top, hang]) { m.castShadow = m.receiveShadow = true; scene.add(m); }
}

// Glazed 3D letters on a little shelf on the backsplash, above the faucet.
const SIGN = { text: 'Sinkful', size: 1.1, gap: 0.08, y: 2.9, z: -4.62, lean: 0.5 };
const SIGN_COLORS = [0x1f8a73, 0x2b7fc0, 0xe8775c, 0xe6a91e, 0x36a86a, 0x3566a8, 0xd65a4a];
const signLetters = [];
async function buildSign() {
  const font = await new FontLoader().loadAsync('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/fonts/helvetiker_bold.typeface.json');
  const sign = new THREE.Group();
  let x = 0;
  [...SIGN.text].forEach((ch, i) => {
    const geo = new TextGeometry(ch, { font, size: SIGN.size, depth: 0.28, curveSegments: 8, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.045, bevelSegments: 4 });
    geo.computeBoundingBox();
    const { min, max } = geo.boundingBox;
    geo.translate(-(min.x + max.x) / 2, -min.y, -min.z); // pivot at the bottom centre so letters can hop
    const glaze = new THREE.MeshPhysicalMaterial({ color: SIGN_COLORS[i % SIGN_COLORS.length], roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.15, envMapIntensity: 0.5 });
    const letter = new THREE.Mesh(geo, glaze);
    letter.position.x = x + (max.x - min.x) / 2;
    letter.castShadow = letter.receiveShadow = true;
    x += max.x - min.x + SIGN.gap;
    sign.add(letter);
    signLetters.push(letter);
  });
  for (const l of signLetters) l.position.x -= (x - SIGN.gap) / 2;
  // A few soap bubbles clinging to the letters.
  for (const [i, dx, y, r] of [[0, -0.32, 0.12, 0.13], [0, -0.14, 0.05, 0.08], [3, 0.3, 0.1, 0.11], [6, 0.16, 0.06, 0.09], [6, 0.32, 0.18, 0.06]]) {
    const b = new THREE.Mesh(sphereGeoShared, sudsMat);
    b.scale.setScalar(r);
    b.position.set(dx, y, 0.4);
    signLetters[i].add(b);
  }
  sign.position.set(0, SIGN.y + 0.08, SIGN.z);
  sign.rotation.x = -SIGN.lean; // top leans back against the wall, face turns up toward the camera
  // Wooden shelf with two brackets.
  const wood = new THREE.MeshStandardMaterial({ color: 0xc89c6d, roughness: 0.7 });
  const shelf = new THREE.Group();
  const plank = new THREE.Mesh(new THREE.BoxGeometry(x + 0.6, 0.12, 0.75), wood);
  plank.position.set(0, SIGN.y + 0.02, -4.62);
  shelf.add(plank);
  for (const bx of [-1, 1]) {
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.45, 0.3), wood);
    bracket.position.set(bx * (x / 2 - 0.4), SIGN.y - 0.25, -4.85);
    shelf.add(bracket);
  }
  shelf.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  const group = new THREE.Group();
  group.add(shelf, sign);
  scene.add(group);
  return group;
}
// Wall calendar beside the sign: shows today's date, and clicking it syncs calendar dishes.
const WALL_CAL = { x: 5.9, y: 4.25, z: -4.95, w: 1.5, h: 1.72, lean: 0.45 };
let wallCal = null;
function calendarFace() {
  const c = document.createElement('canvas');
  c.width = 260; c.height = 300;
  const g = c.getContext('2d');
  const now = new Date();
  g.fillStyle = '#fbf7ef'; g.fillRect(0, 0, 260, 300);
  g.fillStyle = '#e8775c'; g.fillRect(0, 0, 260, 78);
  g.fillStyle = '#fff'; g.textAlign = 'center';
  g.font = '700 38px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
  g.fillText(now.toLocaleString('en-US', { month: 'long' }).toUpperCase(), 130, 54);
  g.fillStyle = '#1f2a2e';
  g.font = '800 132px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
  g.fillText(String(now.getDate()), 130, 205);
  g.fillStyle = '#5d6b70';
  g.font = '600 28px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
  g.fillText(now.toLocaleString('en-US', { weekday: 'long' }), 130, 252);
  g.fillStyle = '#2f8f7a';
  g.font = '600 20px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
  g.fillText('tap to sync', 130, 284);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function buildWallCalendar() {
  const group = new THREE.Group(); // pivots at the nail, so the pad hangs below it
  const pad = new THREE.Group();
  const face = calendarFace();
  const pageMat = () => new THREE.MeshStandardMaterial({ map: face, roughness: 0.9, envMapIntensity: 0.35 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(WALL_CAL.w + 0.08, WALL_CAL.h + 0.08, 0.05), new THREE.MeshStandardMaterial({ color: 0xc89c6d, roughness: 0.7 }));
  back.position.set(0, -WALL_CAL.h / 2 - 0.12, -0.03);
  const page = new THREE.Mesh(new THREE.PlaneGeometry(WALL_CAL.w, WALL_CAL.h), pageMat());
  page.position.set(0, -WALL_CAL.h / 2 - 0.12, 0.002);
  // The top sheet flips over the rings when you sync; it pivots at the top edge.
  const flipper = new THREE.Group();
  flipper.position.set(0, -0.12, 0.006);
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(WALL_CAL.w, WALL_CAL.h), pageMat());
  sheet.material.transparent = true;
  sheet.material.side = THREE.DoubleSide;
  sheet.position.y = -WALL_CAL.h / 2;
  flipper.add(sheet);
  pad.add(back, page, flipper);
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a949a, metalness: 0.8, roughness: 0.3 });
  for (const rx of [-0.38, 0.38]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 8, 20), metal);
    ring.rotation.y = Math.PI / 2;
    ring.position.set(rx, -0.12, 0.02);
    pad.add(ring);
  }
  const nail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 10), metal);
  nail.rotation.x = Math.PI / 2;
  nail.position.z = -0.02;
  group.add(nail, pad);
  pad.rotation.x = -WALL_CAL.lean; // bottom swings out from the wall, face tilts toward the camera
  group.position.set(WALL_CAL.x, WALL_CAL.y, WALL_CAL.z);
  group.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  group.userData = { model: group, page, sheet, flipper, face };
  scene.add(group);
  wallCal = group;
  return group;
}
// New day since the face was drawn: redraw it.
function refreshCalendarFace() {
  if (!wallCal) return;
  const tex = calendarFace();
  for (const m of [wallCal.userData.page, wallCal.userData.sheet]) { m.material.map = tex; m.material.needsUpdate = true; }
  wallCal.userData.face.dispose();
  wallCal.userData.face = tex;
  invalidate();
}
async function flipCalendarPage() {
  const { flipper, sheet } = wallCal.userData;
  if (flipper.userData.flipping) return;
  flipper.userData.flipping = true;
  sfx.rustle();
  await animate(0.6, (k) => {
    flipper.rotation.x = -easeInOut(k) * Math.PI * 0.95; // up and over the rings
    sheet.material.opacity = 1 - Math.max(0, k - 0.6) / 0.4;
  });
  flipper.rotation.x = 0;
  sheet.material.opacity = 0;
  await animate(0.3, (k) => { sheet.material.opacity = k; }); // the next page settles in
  flipper.userData.flipping = false;
}

// Letters hop one after another, like a wave (on load and when the sink is emptied).
function waveSign({ drop = false } = {}) {
  signLetters.forEach((l, i) => hopLetter(l, i * 70, false, drop));
}
function hopLetter(l, delay = 0, squeak = false, drop = false) {
  if (l.userData.hopping) return;
  l.userData.hopping = true;
  setTimeout(async () => {
    if (drop) l.visible = true;
    if (squeak) sfx.squeak();
    await animate(drop ? 0.7 : 0.55, (k) => {
      l.position.y = drop ? (1 - easeOutBounce(k)) * 2.2 : Math.sin(k * Math.PI) * 0.45;
      const squash = drop ? 1 : 1 + Math.sin(k * Math.PI * 2) * 0.08;
      l.scale.set(1 / Math.sqrt(squash), squash, 1);
    });
    l.position.y = 0;
    l.scale.set(1, 1, 1);
    l.userData.hopping = false;
  }, delay);
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#f7f4ee';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#2f7fb3';
  for (const x of [8, 40, 72, 104]) g.fillRect(x, 0, 16, 128);
  g.fillStyle = '#e4664f';
  for (const x of [28, 92]) g.fillRect(x, 0, 6, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toDateString();
// Every task carries `updatedAt` (stamped automatically in save()), and removed tasks leave a
// tombstone in `deleted` (id -> when). That lets two copies of the data (this browser's cache and
// data/sinkful.json, or two tabs) be merged task by task instead of one overwriting the other.
const local = readLocal(); // this browser's copy, or null if it has none
let tasks = local ? local.tasks : seedTasks();
let deleted = local ? local.deleted : {};

// Older saves had a stove: carry simmering tasks over into the soaking tub.
function migrate(list) {
  for (const t of list) if (t.simmer) { t.soak = { since: t.simmer.since, spot: t.simmer.burner }; delete t.simmer; }
  return list;
}
function seedTasks() {
  return SEED.map((s, i) => ({ id: uid(), notes: '', createdAt: Date.now() + i, doneAt: null, archived: false, ...s }));
}
function readLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) return { tasks: migrate(saved), deleted: {} }; // pre-merge format
    if (saved && Array.isArray(saved.tasks)) return { tasks: migrate(saved.tasks), deleted: saved.deleted || {} };
  } catch { /* unreadable: treat as no local copy */ }
  return null;
}
// Union of both copies: the newer version of each task wins (ties go to `a`), and a task stays
// gone only if it was deleted after its last change.
function mergeStates(a, b) {
  const gone = { ...a.deleted };
  for (const [id, at] of Object.entries(b.deleted || {})) gone[id] = Math.max(gone[id] || 0, at);
  const byId = new Map();
  for (const t of [...b.tasks, ...a.tasks]) {
    const cur = byId.get(t.id);
    if (!cur || (t.updatedAt || 0) >= (cur.updatedAt || 0)) byId.set(t.id, t);
  }
  const merged = [...byId.values()].filter((t) => !((gone[t.id] || 0) > (t.updatedAt || 0)));
  merged.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  return { tasks: merged, deleted: gone };
}

// Change tracking: compare each task with how it looked at the last save.
const stamps = new Map(); // id -> JSON of the task (minus updatedAt)
const bare = (t) => { const { updatedAt, ...rest } = t; return JSON.stringify(rest); };
function resetStamps() {
  stamps.clear();
  for (const t of tasks) stamps.set(t.id, bare(t));
}
function stampChanges() {
  const now = Date.now();
  const present = new Set();
  for (const t of tasks) {
    const j = bare(t);
    if (stamps.get(t.id) !== j) { t.updatedAt = now; stamps.set(t.id, j); }
    present.add(t.id);
    delete deleted[t.id]; // undo can bring a task back
  }
  for (const id of [...stamps.keys()]) if (!present.has(id)) { deleted[id] = now; stamps.delete(id); }
}
resetStamps();
const serialize = () => JSON.stringify({ tasks, deleted });

// Persistence. When served by server.py, data/sinkful.json is shared storage: every change is
// written to it (debounced) and merged with whatever is already there. On the hosted copy
// (GitHub Pages) the same state lives in a secret Gist instead, unlocked by vault.js.
// localStorage is a cache and the fallback under any other static server.
const storage = { mode: 'browser', backend: null, lastSaved: '', timer: null, failed: false, rev: 0, calendar: null };
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('sinkful') : null;

// A backend reads {tasks, deleted, rev} and writes {tasks, deleted, baseRev}, answering
// {rev} on success or {conflict: currentState} if someone else saved first.
const fileBackend = {
  delay: 400,
  async get() {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return undefined;
    return res.json();
  },
  async put(body, keepalive) {
    const res = await fetch('/api/state', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, keepalive, body: JSON.stringify(body),
    });
    if (res.status === 409) return { conflict: await res.json() };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
};
// Every save is also a Gist revision, so its history doubles as a backup.
function gistBackend({ token, gistId }) {
  const url = `https://api.github.com/gists/${gistId}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const get = async () => {
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const files = (await res.json()).files || {};
    try { storage.calendar = files['calendar.json'] ? JSON.parse(files['calendar.json'].content) : null; } catch { storage.calendar = null; }
    const file = files['sinkful.json'];
    if (!file) return { tasks: null, rev: 0 };
    return JSON.parse(file.truncated ? await (await fetch(file.raw_url)).text() : file.content);
  };
  return {
    delay: 1500, // each save is two API calls; GitHub allows 5000 an hour
    get,
    async put({ tasks, deleted, baseRev }, keepalive) {
      // No compare-and-swap on Gists: check the revision first (skipped when the page is closing).
      if (!keepalive) {
        const cur = await get();
        if ((cur.rev || 0) !== baseRev) return { conflict: cur };
      }
      const rev = baseRev + 1;
      const content = JSON.stringify({ tasks, deleted, rev, savedAt: new Date().toISOString() });
      const res = await fetch(url, {
        method: 'PATCH', headers, keepalive, body: JSON.stringify({ files: { 'sinkful.json': { content } } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { rev };
    },
    // calendar.json: the sync web app's URL (saved from here) and the last sync (written by the script).
    async putCalendar(info) {
      const res = await fetch(url, {
        method: 'PATCH', headers, body: JSON.stringify({ files: { 'calendar.json': { content: JSON.stringify(info, null, 2) } } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
  };
}

async function connectStorage() {
  try {
    const data = await fileBackend.get();
    if (data) return { mode: 'file', backend: fileBackend, data };
  } catch { /* not server.py */ }
  const creds = await unlockCloud();
  if (!creds) return null; // plain static hosting: browser storage only
  const backend = gistBackend(creds);
  try {
    return { mode: 'gist', backend, data: await backend.get() };
  } catch (err) {
    if (err.status === 401 || err.status === 404) forgetCloud(); // token revoked: ask again next time
    return { mode: 'gist', backend, data: null };
  }
}
async function loadFromRemote() {
  const found = await connectStorage();
  if (!found) return;
  ({ mode: storage.mode, backend: storage.backend } = found);
  const { data } = found;
  if (!data) { storage.failed = true; return; } // offline: keep the browser copy until it's reachable
  storage.rev = data.rev || 0;
  if (!Array.isArray(data.tasks)) { await flushSave(); return; } // first run: create it from this browser
  const remote = { tasks: migrate(data.tasks), deleted: data.deleted || {} };
  ({ tasks, deleted } = mergeStates(local || { tasks: [], deleted: {} }, remote));
  resetStamps();
  const remoteJson = JSON.stringify(remote);
  storage.lastSaved = remoteJson;
  // This browser had changes the saved copy is missing (e.g. made offline): push them up.
  if (serialize() !== remoteJson) await flushSave();
  else localStorage.setItem(STORAGE_KEY, remoteJson);
}
function save() {
  stampChanges();
  const json = serialize();
  localStorage.setItem(STORAGE_KEY, json);
  if (!storage.backend || json === storage.lastSaved) return;
  clearTimeout(storage.timer);
  storage.timer = setTimeout(flushSave, storage.backend.delay);
}
async function flushSave(keepalive = false) {
  clearTimeout(storage.timer);
  // Merging in another tab's changes rebuilds the dishes, so wait for any wash to finish.
  if (washing && !keepalive) { storage.timer = setTimeout(flushSave, 1000); return; }
  stampChanges();
  for (let attempt = 0; attempt < 3; attempt++) {
    const json = serialize();
    try {
      const res = await storage.backend.put({ tasks, deleted, baseRev: storage.rev }, keepalive);
      if (res.conflict) { applyRemote(res.conflict); continue; } // another tab or device saved first
      storage.rev = res.rev;
      storage.lastSaved = json;
      storage.failed = false;
      channel?.postMessage('saved');
      break;
    } catch {
      storage.failed = true;
      break;
    }
  }
  paintSaveStatus();
}
// Fold someone else's saved state into ours and redraw if anything changed.
function applyRemote(data) {
  storage.rev = data.rev || 0;
  if (!Array.isArray(data.tasks)) return;
  const before = JSON.stringify(tasks);
  ({ tasks, deleted } = mergeStates({ tasks, deleted }, { tasks: migrate(data.tasks), deleted: data.deleted || {} }));
  resetStamps();
  if (JSON.stringify(tasks) === before) return;
  closePanel();
  buildAllDishes();
  render();
}
// Another tab saved, or this tab came back into view: pick up changes from the saved copy.
async function pullFromRemote() {
  if (!storage.backend || washing) return;
  try {
    const data = await storage.backend.get();
    if (data && (data.rev || 0) !== storage.rev) {
      applyRemote(data);
      if (serialize() !== storage.lastSaved) flushSave(); // we had unsaved changes on top
      else storage.lastSaved = serialize();
    } else if (storage.failed && serialize() !== storage.lastSaved) flushSave(); // back online
  } catch { /* offline: try again next time */ }
}
channel?.addEventListener('message', pullFromRemote);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pullFromRemote(); refreshCalendarFace(); } });
// The calendar script adds dishes to the Gist through the day: check for them while the page is open.
setInterval(() => { if (!document.hidden && storage.mode === 'gist') pullFromRemote(); }, 5 * 60 * 1000);
addEventListener('pagehide', () => {
  if (storage.backend && serialize() !== storage.lastSaved) flushSave(true);
});
// Append-only activity log (data/history.jsonl): one line per thing that happened.
function logEvent(type, t, extra) {
  if (storage.mode !== 'file') return;
  const event = { type, at: new Date().toISOString(), ...(t && { id: t.id, title: t.title, dish: t.type }), ...extra };
  fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event), keepalive: true }).catch(() => {});
}
function paintSaveStatus() {
  const el = document.getElementById('save-status');
  const where = storage.mode === 'gist' ? 'your Gist' : 'data/sinkful.json';
  const [cls, text, tip] = !storage.backend
    ? ['browser', 'Saved in this browser', 'Run python3 server.py to also save to data/sinkful.json']
    : storage.failed
      ? ['error', storage.mode === 'gist' ? "Can't reach GitHub" : "Can't reach save server",
        'Changes are kept in this browser and will sync when it is back']
      : ['file', `Auto-saving to ${where}`, storage.mode === 'gist' ? 'Each save is a Gist revision' : 'Activity log: data/history.jsonl'];
  // Quiet when everything is saving; only speak up when it isn't.
  el.className = `save-status ${cls}`;
  el.textContent = cls === 'file' ? '' : text;
  el.title = tip;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
const loader = new GLTFLoader();
const templates = {};
async function loadModels() {
  await Promise.all(Object.entries(DISHES).map(async ([key, d]) => {
    const gltf = await loader.loadAsync(`models/${d.file}.glb`);
    const model = gltf.scene;
    model.scale.setScalar(DISH_SCALE);
    // Center on x/z, rest the base on y = 0.
    const bb = new THREE.Box3().setFromObject(model);
    const c = bb.getCenter(new THREE.Vector3());
    model.position.set(-c.x, -bb.min.y, -c.z);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      // The fork is near-white, which vanishes against the steel sink; make it read as darker metal.
      if (key === 'fork') {
        o.material = o.material.clone();
        o.material.color.set(0x7d8791);
        o.material.metalness = 0.6;
        o.material.roughness = 0.35;
      }
    });
    templates[key] = model;
  }));
}

const dishes = new Map(); // task id -> wrapper group
const raycaster = new THREE.Raycaster();

function makeDish(task) {
  const wrapper = new THREE.Group();
  const model = templates[task.type].clone(true);
  wrapper.add(model);
  wrapper.userData = { taskId: task.id, model, blobs: [], lather: [] };
  wrapper.updateMatrixWorld(true);

  // Grime: drop rays from above onto the dish and stick blobs to what they hit.
  const g = GRIME[task.grime];
  const mat = new THREE.MeshStandardMaterial({ color: g.color, roughness: 1 });
  wrapper.userData.grime = { mat, base: new THREE.Color(g.color) };
  const bb = new THREE.Box3().setFromObject(model);
  const size = bb.getSize(new THREE.Vector3());
  wrapper.userData.size = size;
  const rng = mulberry32(hash(task.id));
  let tries = 0;
  while (wrapper.userData.blobs.length < g.blobs && tries++ < 200) {
    const x = (rng() - 0.5) * size.x * 0.85;
    const z = (rng() - 0.5) * size.z * 0.85;
    raycaster.set(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
    const hit = raycaster.intersectObject(model, true)[0];
    if (!hit) continue;
    const r = (0.05 + rng() * 0.08) * (task.type === 'fork' ? 0.45 : 1) * (0.8 + task.grime * 0.15);
    const blob = new THREE.Mesh(sphereGeoShared, mat);
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    blob.position.copy(hit.point);
    blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    blob.scale.set(r, r * 0.35, r * (0.7 + rng() * 0.6));
    blob.userData = { base: blob.scale.clone(), normal: n };
    wrapper.add(blob);
    wrapper.userData.blobs.push(blob);
  }
  applyLoosened(wrapper, task.loosened || 0);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Piling dishes in the sink with a coarse height map
// ---------------------------------------------------------------------------
const CELL = 0.2;
const PILE_VERSION = 2; // bump to re-spread saved piles after changing placement

// Best of several random spots: the one furthest from dishes already placed.
function spreadSpot(r, placed) {
  const mx = Math.max(0, SINK.w / 2 - r * 0.8 - 0.1), mz = Math.max(0, SINK.d / 2 - r * 0.8 - 0.1);
  let best = { x: 0, z: 0 }, bestScore = -Infinity;
  for (let i = 0; i < 28; i++) {
    const c = { x: (Math.random() * 2 - 1) * mx, z: (Math.random() * 2 - 1) * mz };
    const score = placed.length ? Math.min(...placed.map((p) => Math.hypot(c.x - p.x, c.z - p.z) - (r + p.r) * 0.9)) : Math.random();
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}
const GW = Math.ceil(SINK.w / CELL), GD = Math.ceil(SINK.d / CELL);

function settleSink({ dropFrom } = {}) {
  const heights = new Float32Array(GW * GD).fill(FLOOR_Y);
  const inSink = tasks.filter((t) => !t.doneAt && !t.soak).sort((a, b) => a.createdAt - b.createdAt);
  const placed = [];
  for (const t of inSink) {
    const w = dishes.get(t.id);
    if (!w || w === inspecting || w === washing) continue;
    const size = w.userData.size;
    if (t.x == null || t.pv !== PILE_VERSION) {
      Object.assign(t, spreadSpot(Math.max(size.x, size.z) / 2, placed), { pv: PILE_VERSION });
      t.rotY ??= Math.random() * Math.PI * 2;
      t.tiltX ??= Math.random() - 0.5;
      t.tiltZ ??= Math.random() - 0.5;
    }
    placed.push({ x: t.x, z: t.z, r: Math.max(size.x, size.z) / 2 });
    const radius = Math.max(size.x, size.z) * 0.42;
    // Highest point under this dish's footprint.
    let base = FLOOR_Y;
    const cells = [];
    for (let i = 0; i < GW; i++) for (let j = 0; j < GD; j++) {
      const cx = -SINK.w / 2 + (i + 0.5) * CELL, cz = -SINK.d / 2 + (j + 0.5) * CELL;
      if (Math.hypot(cx - t.x, cz - t.z) < radius) { cells.push(i * GD + j); base = Math.max(base, heights[i * GD + j]); }
    }
    const resting = base > FLOOR_Y + 0.05;
    const tilt = resting ? 0.35 : 0.04;
    const top = base + size.y * (resting ? 0.75 : 1);
    for (const c of cells) heights[c] = Math.max(heights[c], top);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(t.tiltX * tilt, t.rotY, t.tiltZ * tilt));
    const pos = new THREE.Vector3(t.x, base + (resting ? 0.05 : 0), t.z);
    if (dropFrom === t.id) { w.position.set(t.x, 6, t.z); setTimeout(() => sfx.clink(METAL.has(t.type)), 330); }
    moveTo(w, pos, q, dropFrom === t.id ? 0.9 : 0.5, dropFrom === t.id ? easeOutBounce : easeInOut);
  }
  save();
}

// ---------------------------------------------------------------------------
// Soaking tub: long-running tasks sit in soapy water, one per spot.
// ---------------------------------------------------------------------------
const soaking = () => tasks.filter((t) => t.soak && !t.doneAt);
const freeSpot = () => [...SPOTS.keys()].find((i) => !soaking().some((t) => t.soak.spot === i));
function layoutTub() {
  for (const t of soaking()) {
    const w = dishes.get(t.id);
    if (!w || w === inspecting || w === washing) continue;
    // Leaning a little, the way dishes settle in a tub.
    const lean = t.soak.spot % 2 ? -1 : 1;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12 * lean, t.rotY || 0, 0.18 * lean));
    moveTo(w, SPOTS[t.soak.spot], q, 0.7, easeInOut);
  }
}
function soak(w) {
  if (!w) return;
  const t = taskById(w.userData.taskId);
  if (t.soak) { // take it out, back into the sink
    t.soak = null;
    logEvent('taken-out', t);
    closePanel();
    settleSink({ dropFrom: t.id });
  } else {
    const spot = freeSpot();
    if (spot === undefined) return;
    t.soak = { since: Date.now(), spot };
    logEvent('soaked', t);
    closePanel();
    layoutTub();
    splashTub(spot, 600);
    settleSink();
  }
  render();
}
function splashTub(spot, delay) {
  setTimeout(() => {
    sfx.plop();
    const at = SPOTS[spot].clone().setY(TUB.water);
    spawn(at, { n: 12, color: 0xa8dcff, speed: 1.6, gravity: 6, size: [0.03, 0.07], life: 0.7 });
    spawn(at, { n: 6, speed: 0.6, size: [0.06, 0.12], life: 1.2 });
  }, delay);
}
const elapsed = (since) => {
  const m = Math.max(1, Math.round((Date.now() - since) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
// Soaking loosens grime: it fades toward pale suds and shrinks, up to 70% after 4 hours.
const LOOSEN_FULL_MS = 4 * 3600 * 1000;
const LOOSEN_MAX = 0.7;
const SOFT_GRIME = new THREE.Color(0xeadfca);
function applyLoosened(w, l) {
  const g = w.userData.grime;
  if (!g) return;
  g.mat.color.copy(g.base).lerp(SOFT_GRIME, l);
  for (const b of w.userData.blobs) {
    if (washing === w) continue; // the scrub animation owns blob scale
    b.scale.copy(b.userData.base).multiplyScalar(1 - l * 0.4);
  }
}
const loosenedFor = (t) => Math.min(LOOSEN_MAX, Math.max(t.loosened || 0, t.soak ? ((Date.now() - t.soak.since) / LOOSEN_FULL_MS) * LOOSEN_MAX : 0));
let loosenClock = 0;

let bubbleClock = 0;
function stepTub(dt, now) {
  loosenClock += dt;
  if (loosenClock > 1) {
    loosenClock = 0;
    for (const t of soaking()) {
      t.loosened = loosenedFor(t);
      const w = dishes.get(t.id);
      if (w) applyLoosened(w, t.loosened);
    }
  }
  for (const f of tubFoam) f.position.y = TUB.water + 0.01 + Math.sin(now * 1.3 + f.userData.phase) * 0.012;
  bubbleClock += dt;
  if (bubbleClock < 0.18) return;
  bubbleClock = 0;
  for (const t of soaking()) {
    const w = dishes.get(t.id);
    if (!w || w === inspecting || w === washing || tweens.has(w)) continue;
    // Bubbles rise off the soaking dish and pop at the surface.
    const from = w.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.7, 0.1 + Math.random() * 0.2, (Math.random() - 0.5) * 0.7));
    const rise = 0.6;
    spawn(from, { n: 1, speed: 0, vel: new THREE.Vector3(0, rise, 0), size: [0.025, 0.05], life: Math.max(0.2, (TUB.water - from.y) / rise), opacity: 0.8, grow: false });
  }
}

// ---------------------------------------------------------------------------
// Drying rack
// ---------------------------------------------------------------------------
const UPRIGHT = new Set(['plate', 'pan', 'fork']);
function layoutRack(arrivingId) {
  const done = tasks.filter((t) => t.doneAt && !t.archived).sort((a, b) => a.doneAt - b.doneAt);
  const left = RACK.x - RACK.w / 2, right = RACK.x + RACK.w / 2;
  const cursors = [left + 0.15, left + 0.15];
  for (const t of done) {
    const w = dishes.get(t.id);
    if (!w) continue;
    const upright = UPRIGHT.has(t.type);
    // Plates stand edge-on in the wire slots; cups and pots dry upside down.
    const q = upright
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2 - 0.12))
      : new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0.15, 0));
    // Measure the dish in its rack orientation.
    const saved = w.quaternion.clone(), savedPos = w.position.clone();
    w.quaternion.copy(q); w.position.set(0, 0, 0); w.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(w.userData.model);
    w.quaternion.copy(saved); w.position.copy(savedPos); w.updateMatrixWorld(true);
    const width = bb.max.x - bb.min.x;
    // Two rows; plates prefer the back slots, everything takes the first row with room.
    const order = upright ? [0, 1] : [1, 0];
    let row = order.find((r) => cursors[r] + width <= right);
    if (row === undefined) { row = order[0]; cursors[row] = left + 0.15; } // full: start overlapping
    const x = cursors[row] + width / 2;
    cursors[row] += Math.max(width, 0.3) + 0.1;
    const z = RACK.z + (row === 0 ? -0.9 : 1.0);
    const pos = new THREE.Vector3(x - (bb.min.x + bb.max.x) / 2, RACK.top - bb.min.y, z - (bb.min.z + bb.max.z) / 2);
    moveTo(w, pos, q, 0.8, easeInOut, t.id === arrivingId ? () => sfx.clink(METAL.has(t.type)) : undefined);
  }
}

// ---------------------------------------------------------------------------
// Tweens and timed animations
// ---------------------------------------------------------------------------
const tweens = new Map();
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function easeOutBounce(x) {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}
function moveTo(obj, pos, quat, dur, ease = easeInOut, onDone) {
  tweens.set(obj, { p0: obj.position.clone(), p1: pos.clone(), q0: obj.quaternion.clone(), q1: quat.clone(), t: 0, dur, ease, onDone });
}
function stepTweens(dt) {
  for (const [obj, tw] of tweens) {
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    const k = tw.ease(tw.t);
    obj.position.lerpVectors(tw.p0, tw.p1, k);
    obj.quaternion.slerpQuaternions(tw.q0, tw.q1, easeInOut(tw.t));
    if (tw.t >= 1) { tweens.delete(obj); tw.onDone?.(); }
  }
}

// animate(dur, fn) calls fn(k, dt, elapsed) every frame for dur seconds, then resolves.
const actives = new Set();
const animate = (dur, fn) => new Promise((resolve) => actives.add({ t: 0, dur, fn, resolve }));
function stepActives(dt) {
  for (const a of actives) {
    a.t = Math.min(a.dur, a.t + dt);
    a.fn(a.dur ? a.t / a.dur : 1, dt, a.t);
    if (a.t >= a.dur) { actives.delete(a); a.resolve(); }
  }
}
function viewTo(target, dur) {
  const p0 = view.pos.clone(), l0 = view.look.clone();
  return animate(dur, (k) => {
    const e = easeInOut(k);
    view.pos.lerpVectors(p0, target.pos, e);
    view.look.lerpVectors(l0, target.look, e);
  });
}

// ---------------------------------------------------------------------------
// Particles: bubbles, water droplets, soap drops, sparkles
// ---------------------------------------------------------------------------
const particles = [];
const sphereGeo = new THREE.SphereGeometry(1, 10, 8);
function spawn(point, { n = 3, color = 0xffffff, speed = 0.6, gravity = 0, size = [0.03, 0.09], life = 1, glow = false, vel, opacity = 0.85, grow = !gravity } = {}) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(sphereGeo, new THREE.MeshStandardMaterial({
      color, transparent: true, opacity, roughness: 0.1,
      emissive: glow ? color : 0x000000, emissiveIntensity: glow ? 0.8 : 0,
    }));
    const r = size[0] + Math.random() * (size[1] - size[0]);
    m.scale.setScalar(r);
    m.position.copy(point);
    const v = vel ? vel.clone() : new THREE.Vector3();
    v.add(new THREE.Vector3((Math.random() - 0.5) * speed, Math.random() * speed, (Math.random() - 0.5) * speed));
    m.userData = { v, life: 1, decay: 1 / life, r, gravity, opacity, grow };
    scene.add(m);
    particles.push(m);
  }
}
function stepParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    const u = p.userData;
    u.life -= dt * u.decay;
    u.v.y -= u.gravity * dt;
    p.position.addScaledVector(u.v, dt);
    p.material.opacity = Math.max(0, u.life) * u.opacity;
    if (u.grow) p.scale.setScalar(u.r * (1 + (1 - u.life) * 0.8));
    if (u.life <= 0) { scene.remove(p); p.material.dispose(); particles.splice(i, 1); }
  }
}

// Lather: foam that sticks to a dish (or the tool) and grows, then rinses off.
const foamMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, transparent: true, opacity: 0.96 });
function addFoam(parent, list, local, r) {
  const m = new THREE.Mesh(sphereGeo, foamMat);
  m.position.copy(local);
  m.scale.setScalar(0.001);
  m.userData = { r, grow: 0 };
  parent.add(m);
  list.push(m);
}
function growFoam(list, dt) {
  for (const f of list) {
    if (f.userData.grow >= 1) continue;
    f.userData.grow = Math.min(1, f.userData.grow + dt * 5);
    f.scale.setScalar(f.userData.r * easeOut(f.userData.grow));
  }
}

// ---------------------------------------------------------------------------
// Rubber gloves, sponge and soap, built from primitives so the fingers can pose.
// Hand frame: fingers point +z, palm faces -y, thumb is on +x (right hand).
// ---------------------------------------------------------------------------
const gloveMat = new THREE.MeshPhysicalMaterial({ color: 0xf29b00, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.2 });
const cuffMat = gloveMat.clone();
cuffMat.side = THREE.DoubleSide;

function makeGlove(isLeft) {
  const root = new THREE.Group();
  const inner = new THREE.Group();
  if (isLeft) inner.scale.x = -1;
  root.add(inner);
  const add = (geo, mat, parent, pos, scale, rot) => {
    const m = new THREE.Mesh(geo, mat);
    if (pos) m.position.set(...pos);
    if (scale) m.scale.set(...scale);
    if (rot) m.rotation.set(...rot);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  add(sphereGeo, gloveMat, inner, [0, 0, 0], [0.3, 0.13, 0.32]);           // palm
  add(sphereGeo, gloveMat, inner, [0, 0.01, -0.24], [0.23, 0.12, 0.2]);    // wrist
  add(new THREE.CylinderGeometry(0.21, 0.29, 0.5, 24, 1, true), cuffMat, inner, [0, 0.02, -0.5], null, [Math.PI / 2, 0, 0]);
  add(new THREE.TorusGeometry(0.29, 0.04, 10, 28), gloveMat, inner, [0, 0.02, -0.75]); // rolled cuff rim

  const seg = new THREE.CapsuleGeometry(0.066, 0.13, 6, 12);
  const fingers = [];
  for (const [x, L] of [[-0.2, 0.85], [-0.07, 1], [0.07, 0.97], [0.2, 0.86]]) {
    const base = new THREE.Group();
    base.position.set(x, 0, 0.27);
    inner.add(base);
    add(seg, gloveMat, base, [0, 0, 0.1 * L], [1, L, 1], [Math.PI / 2, 0, 0]);
    const knuckle = new THREE.Group();
    knuckle.position.z = 0.2 * L;
    base.add(knuckle);
    add(seg, gloveMat, knuckle, [0, 0, 0.085 * L], [0.95, 0.85 * L, 0.95], [Math.PI / 2, 0, 0]);
    fingers.push({ base, knuckle });
  }
  const thumb = new THREE.Group();
  thumb.position.set(0.25, -0.02, 0.02);
  inner.add(thumb);
  add(seg, gloveMat, thumb, [0, 0, 0.12], [1.1, 1.1, 1.1], [Math.PI / 2, 0, 0]);
  const thumbTip = new THREE.Group();
  thumbTip.position.z = 0.22;
  thumb.add(thumbTip);
  add(seg, gloveMat, thumbTip, [0, 0, 0.07], [1.05, 0.8, 1.05], [Math.PI / 2, 0, 0]);

  root.userData = { fingers, thumb, thumbTip, pose: { curl: 0, thumb: 0.5, spread: 0 } };
  root.visible = false;
  scene.add(root);
  setPose(root, { curl: 0.2, thumb: 0.5 });
  return root;
}

// curl: 0 flat .. 1.6 fist. thumb: 0 tucked .. 1 sticking out sideways (thumbs-up).
function setPose(hand, pose) {
  const p = Object.assign(hand.userData.pose, pose);
  for (const [i, f] of hand.userData.fingers.entries()) {
    f.base.rotation.set(p.curl * 0.85, (i - 1.5) * 0.08 * (1 - p.curl * 0.5), 0);
    f.knuckle.rotation.x = p.curl * 1.15;
  }
  hand.userData.thumb.rotation.set(0.35 * (1 - p.thumb), 0.35 + p.thumb * 1.2, 0);
  hand.userData.thumbTip.rotation.x = 0.4 * (1 - p.thumb);
}

// Orientation from where the fingers point and which way the palm faces.
function handQuat(fingerDir, palmDir) {
  const z = fingerDir.clone().normalize();
  const y = palmDir.clone().negate();
  y.addScaledVector(z, -y.dot(z)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

const leftHand = makeGlove(true);
const rightHand = makeGlove(false);

const sponge = new THREE.Group();
{
  const foamPart = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.22, 0.44), new THREE.MeshStandardMaterial({ color: 0xfff07a, roughness: 0.95 }));
  foamPart.position.y = 0.075;
  const scour = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.07, 0.44), new THREE.MeshStandardMaterial({ color: 0x2f8f45, roughness: 1 }));
  scour.position.y = -0.07;
  foamPart.castShadow = scour.castShadow = true;
  sponge.add(foamPart, scour);
  sponge.position.set(0, -0.24, 0.22);
  rightHand.add(sponge);
}

// Long-handled dish brush for pots and pans. Bristles point down, out past the fingertips.
const brush = new THREE.Group();
const brushHead = new THREE.Group();
{
  const plastic = new THREE.MeshStandardMaterial({ color: 0x3fa7d6, roughness: 0.35 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 1.35, 14), plastic);
  handle.rotation.x = Math.PI / 2;
  handle.position.z = 0.45;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.09, 24), plastic);
  const bristles = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.17, 24), new THREE.MeshStandardMaterial({ color: 0xf3ead2, roughness: 1 }));
  bristles.position.y = -0.13;
  handle.castShadow = base.castShadow = bristles.castShadow = true;
  brushHead.add(base, bristles);
  brushHead.position.z = 1.15;
  brushHead.rotation.x = -0.95; // undo the handle tilt so bristles face straight down
  brush.add(handle, brushHead);
  brush.rotation.x = 0.95;
  brush.position.set(0, -0.12, 0.05);
  brush.visible = false;
  rightHand.add(brush);
}
const tipMarkers = { sponge: new THREE.Object3D(), brush: new THREE.Object3D() };
tipMarkers.sponge.position.y = -0.105;
sponge.add(tipMarkers.sponge);
tipMarkers.brush.position.y = -0.22;
brushHead.add(tipMarkers.brush);
let toolLather = [];
let activeTool = 'sponge';

// circle: plain sponge. twist: sponge squashed into a tall plug for cups. brush: the long brush.
function setTool(mode) {
  for (const f of toolLather) f.parent?.remove(f);
  toolLather = [];
  sponge.scale.setScalar(1);
  brush.scale.setScalar(1);
  sponge.position.set(0, -0.24, 0.22);
  sponge.visible = mode === 'circle' || mode === 'twist';
  brush.visible = mode === 'brush';
  if (mode === 'twist') {
    sponge.scale.set(0.5, 2.4, 0.6);
    sponge.position.set(0, -0.5, 0.12);
  }
  activeTool = mode === 'brush' ? 'brush' : 'sponge';
}
setTool(null);

// Where the active tool touches the dish, in hand space (unscaled).
function toolTip() {
  rightHand.updateMatrixWorld(true);
  return rightHand.worldToLocal(tipMarkers[activeTool].getWorldPosition(new THREE.Vector3()));
}

const soapBottle = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.62, 20), new THREE.MeshPhysicalMaterial({ color: 0x47c47e, roughness: 0.15, transmission: 0.35, thickness: 0.3, clearcoat: 1 }));
  const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), body.material);
  shoulder.position.y = 0.31;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.14, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
  cap.position.y = 0.52;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 12), cap.material);
  tip.position.y = 0.63;
  const label = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.22, 20, 1, true), new THREE.MeshStandardMaterial({ color: 0xfff6e0, roughness: 0.8 }));
  label.position.y = -0.05;
  soapBottle.add(body, shoulder, cap, tip, label);
  soapBottle.visible = false;
  scene.add(soapBottle);
}

// ---------------------------------------------------------------------------
// The wash: the payoff animation once a task is done.
// ---------------------------------------------------------------------------
const wait = (s) => animate(s, () => {});
const dishLocalToWorld = (w, v) => { w.updateMatrixWorld(); return w.localToWorld(v.clone()); };

async function wash(w) {
  if (washing || !w) return;
  const t = taskById(w.userData.taskId);
  washing = w;
  closePanel();
  setHover(null);
  tooltip.classList.add('hidden');
  showToast(`Washing “${t.title}”…`);
  document.body.classList.add('washing');

  const size = w.userData.size;
  const r = Math.max(size.x, size.z) / 2;
  const s = THREE.MathUtils.clamp(r / 0.95, 0.55, 1.05); // glove scale for this dish
  leftHand.scale.setScalar(s);
  rightHand.scale.setScalar(s);
  // Pots and pans get the long brush; cups get a sponge twisted inside; the rest get circles.
  const mode = METAL.has(t.type) ? 'brush' : t.type === 'glass' || t.type === 'mug' ? 'twist' : 'circle';
  setTool(mode);

  // Held under the spout, tipped a little toward the camera.
  const toCam = new THREE.Vector3().subVectors(WASH_VIEW.pos, WASH_POS).normalize();
  const tipDir = new THREE.Vector3(0, 1, 0).lerp(toCam, 0.45).normalize();
  const qWash = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tipDir);
  const washPos = WASH_POS.clone().add(new THREE.Vector3(0, -size.y * 0.4, 0));
  focusOn(washPos);

  // Grip poses in dish space: left hand under the left rim, right hand hovering with the tool.
  const gripLocal = new THREE.Vector3(-r - 0.12 * s, size.y * 0.25, 0.1 * r);
  const gripQ = handQuat(new THREE.Vector3(1, 0.15, 0), new THREE.Vector3(0.2, 1, 0));
  const scrubQ = handQuat(new THREE.Vector3(-1, 0, -0.35), new THREE.Vector3(0, -1, 0));
  const hoverLocal = new THREE.Vector3(r * 0.45, size.y + (mode === 'brush' ? 1.3 : 0.75) * s, r * 0.35);
  const worldPose = (local, q) => ({ pos: dishLocalToWorld(w, local), quat: w.quaternion.clone().multiply(q) });
  const placeHand = (hand, from, to, k) => {
    hand.position.lerpVectors(from.pos, to.pos, k);
    hand.quaternion.slerpQuaternions(from.quat, to.quat, k);
  };
  // Hand pose (dish space) that puts the tool's working tip on `contact`.
  const tipLocal = toolTip();
  const handAt = (contact, q) => worldPose(contact.clone().sub(tipLocal.clone().multiplyScalar(s).applyQuaternion(q)), q);

  // 1. Camera leans in, dish floats to the faucet, gloves fly in.
  moveTo(w, washPos, qWash, 0.9, easeInOut);
  const leftFrom = { pos: new THREE.Vector3(-7, 4, 4), quat: handQuat(new THREE.Vector3(1, -0.3, -0.5), new THREE.Vector3(0, 1, 0)) };
  const rightFrom = { pos: new THREE.Vector3(7, 4.5, 3), quat: handQuat(new THREE.Vector3(-1, -0.3, -0.5), new THREE.Vector3(0, -1, 0)) };
  leftHand.visible = rightHand.visible = true;
  setPose(leftHand, { curl: 0.1, thumb: 0.6 });
  setPose(rightHand, mode === 'brush' ? { curl: 1.15, thumb: 0.15 } : { curl: 0.5, thumb: 0.3 });
  sfx.whoosh();
  // Small dishes get a closer camera so the show is still readable.
  viewTo({ pos: WASH_VIEW.pos.clone().lerp(WASH_VIEW.look, (1.05 - s) * 0.7), look: WASH_VIEW.look }, 0.9);
  const dripping = !!t.soak;
  await animate(0.9, (k) => {
    const e = easeInOut(k);
    if (dripping && Math.random() < 0.6) spawn(w.position.clone(), { n: 1, color: 0xa8dcff, speed: 0.3, gravity: 6, size: [0.025, 0.05], life: 0.7 });
    placeHand(leftHand, leftFrom, worldPose(gripLocal, gripQ), e);
    placeHand(rightHand, rightFrom, worldPose(hoverLocal, scrubQ), e);
    setPose(leftHand, { curl: 0.1 + 0.75 * e });
  });
  const followLeft = () => {
    const p = worldPose(gripLocal, gripQ);
    leftHand.position.copy(p.pos);
    leftHand.quaternion.copy(p.quat);
  };

  // 2. Soap bottle pops in and squirts onto the tool.
  const toolTop = () => (mode === 'brush' ? brushHead.localToWorld(new THREE.Vector3(0, 0.08, 0)) : sponge.localToWorld(new THREE.Vector3(0.15, 0.2, 0.2)));
  const bottleAt = toolTop().add(new THREE.Vector3(0.3, 1.1, 0.4));
  const bottleFrom = bottleAt.clone().add(new THREE.Vector3(0.6, 0.4, 0));
  soapBottle.visible = true;
  soapBottle.scale.setScalar(0.001);
  soapBottle.position.copy(bottleFrom);
  soapBottle.rotation.set(0, 0, 0);
  await animate(0.35, (k) => {
    const e = easeOut(k);
    soapBottle.scale.setScalar(Math.max(0.001, e * 1.5));
    soapBottle.position.lerpVectors(bottleFrom, bottleAt, e);
    soapBottle.rotation.z = e * 2.5; // tip it over
    followLeft();
  });
  let dropped = 0;
  sfx.squirt();
  await animate(0.6, (k, dt, el) => {
    soapBottle.scale.set(1.5 * (1 + Math.sin(el * 30) * 0.1), 1.5, 1.5 * (1 + Math.sin(el * 30) * 0.1)); // squeeze
    soapBottle.updateMatrixWorld();
    const nozzle = soapBottle.localToWorld(new THREE.Vector3(0, 0.68, 0));
    if (el > dropped * 0.15 && dropped < 4) {
      dropped++;
      const fall = toolTop().sub(nozzle);
      spawn(nozzle, { n: 1, color: 0x3fd07a, speed: 0, gravity: 9, size: [0.05, 0.07], life: 0.6, vel: new THREE.Vector3(fall.x * 1.6, 0, fall.z * 1.6) });
    }
    followLeft();
  });
  const tool = mode === 'brush' ? brushHead : sponge;
  for (let i = 0; i < 7; i++) {
    const at = mode === 'brush'
      ? new THREE.Vector3((Math.random() - 0.5) * 0.24, 0.02 + Math.random() * 0.06, (Math.random() - 0.5) * 0.24)
      : new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.2 + Math.random() * 0.04, (Math.random() - 0.5) * 0.34);
    addFoam(tool, toolLather, at, 0.05 + Math.random() * 0.06);
  }
  await animate(0.3, (k, dt) => {
    soapBottle.scale.setScalar(Math.max(0.001, 1.5 * (1 - easeInOut(k))));
    soapBottle.position.y += dt * 1.5;
    growFoam(toolLather, dt);
    followLeft();
  });
  soapBottle.visible = false;

  // 3. Scrub the grime off, building lather as we go.
  const blobs = [...w.userData.blobs].sort((a, b) => Math.atan2(a.position.z, a.position.x) - Math.atan2(b.position.z, b.position.x));
  // Cups get one long twist; everything else visits up to 5 patches.
  const nStops = mode === 'twist' ? Math.min(1, blobs.length) : Math.min(5, blobs.length);
  const stops = [];
  for (let i = 0; i < nStops; i++) stops.push(blobs.slice(Math.floor((i * blobs.length) / nStops), Math.floor(((i + 1) * blobs.length) / nStops)));
  // Soaked dishes come clean faster.
  const ease = 1 - (t.loosened || 0) * 0.6;
  const per = (mode === 'twist' ? 1.9 : THREE.MathUtils.clamp(1.9 / Math.max(1, nStops), 0.3, 0.5)) * ease;
  const startScale = 1 - (t.loosened || 0) * 0.4;
  const centerOf = (group) => {
    const c = new THREE.Vector3(), n = new THREE.Vector3();
    for (const b of group) { c.add(b.position); n.add(b.userData.normal); }
    return { c: c.divideScalar(group.length), n: n.normalize() };
  };
  // Brush strokes run along the hand's reach; sponge circles; cups get twisted.
  const strokeDir = new THREE.Vector3(-1, 0, -0.35).normalize();
  const motion = (el, spread) => {
    const a = el * (mode === 'brush' ? 17 : 22);
    if (mode === 'brush') {
      return { offset: strokeDir.clone().multiplyScalar(Math.sin(a) * (0.16 + spread * 0.3)).add(new THREE.Vector3(0, 0, Math.sin(a * 0.31) * spread * 0.4)), q: scrubQ, speed: Math.abs(Math.cos(a)) };
    }
    if (mode === 'twist') {
      const twist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(el * 9) * 1.3);
      return { offset: new THREE.Vector3(0, Math.sin(el * 15) * 0.04, 0), q: twist.multiply(scrubQ), speed: Math.abs(Math.cos(el * 9)) };
    }
    const amp = 0.08 * s + spread * 0.35;
    return {
      offset: new THREE.Vector3(Math.cos(a) * amp, 0, Math.sin(a * 1.3) * amp * 0.8),
      q: scrubQ.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.sin(a) * 0.25, 0))),
      speed: 0.6 + Math.abs(Math.sin(a * 2)) * 0.4,
    };
  };
  const scrubSound = sfx.scrub(mode === 'brush' ? 'brush' : 'sponge');
  let foamClock = 0, squeakClock = 0;
  for (const group of stops) {
    const { c, n } = centerOf(group);
    const contact = c.clone().addScaledVector(n, 0.01);
    const from = { pos: rightHand.position.clone(), quat: rightHand.quaternion.clone() };
    const start = motion(0, 0);
    await animate(mode === 'twist' ? 0.3 : 0.12, (k) => {
      placeHand(rightHand, from, handAt(contact, start.q), easeInOut(k));
      followLeft();
    });
    const spread = group.reduce((m, b) => Math.max(m, b.position.distanceTo(c)), 0);
    await animate(per, (k, dt, el) => {
      const mo = motion(el, spread);
      const p = handAt(contact.clone().add(mo.offset), mo.q);
      rightHand.position.copy(p.pos);
      rightHand.quaternion.copy(p.quat);
      scrubSound.set(mo.speed);
      for (const blob of group) blob.scale.copy(blob.userData.base).multiplyScalar(startScale * Math.max(0, 1 - easeInOut(k)));
      // The dish gives a little under the pressure.
      w.position.copy(washPos).add(new THREE.Vector3(Math.cos(el * 22) * 0.015, Math.sin(el * 44) * 0.01, 0));
      // Squeaks get more frequent as it comes clean.
      squeakClock -= dt;
      if (mode !== 'brush' && squeakClock <= 0 && k > 0.25) { sfx.squeak(); squeakClock = 0.32 - k * 0.18 + Math.random() * 0.1; }
      foamClock += dt;
      while (foamClock > 0.02) {
        foamClock -= 0.02;
        const src = group[Math.floor(Math.random() * group.length)];
        const local = src.position.clone()
          .add(new THREE.Vector3((Math.random() - 0.5) * 0.45 * s, 0, (Math.random() - 0.5) * 0.45 * s))
          .addScaledVector(src.userData.normal, 0.04);
        addFoam(w, w.userData.lather, local, (0.05 + Math.random() * 0.08) * (0.7 + s * 0.3));
        if (Math.random() < 0.3) spawn(dishLocalToWorld(w, local), { n: 1, speed: 0.5, size: [0.03, 0.06] });
      }
      growFoam(w.userData.lather, dt);
      growFoam(toolLather, dt);
      followLeft();
    });
    for (const blob of group) w.remove(blob);
  }
  scrubSound.stop();
  w.userData.blobs = [];
  w.position.copy(washPos);

  // 4. Rinse: tool hand steps back, water runs, the lather slides off.
  const parkFrom = { pos: rightHand.position.clone(), quat: rightHand.quaternion.clone() };
  const parkLocal = new THREE.Vector3(r + 0.7 * s, size.y + (mode === 'brush' ? 1.1 : 0.4) * s, r * 0.5);
  await animate(0.3, (k) => { placeHand(rightHand, parkFrom, worldPose(parkLocal, scrubQ), easeInOut(k)); followLeft(); });
  const surfaceY = () => dishLocalToWorld(w, new THREE.Vector3(0, size.y * 0.3, 0)).y;
  setWater(true, surfaceY());
  const running = sfx.water();
  const lather = w.userData.lather;
  for (const f of lather) f.userData.slide = new THREE.Vector3((Math.random() - 0.5) * 0.6, 0, 0.4 + Math.random() * 0.8);
  await animate(1.2, (k, dt, el) => {
    water.material.opacity = Math.min(0.8, el * 4) * (k > 0.9 ? (1 - k) * 10 : 1);
    water.scale.x = water.scale.z = 1 + Math.sin(el * 40) * 0.08;
    // Swirl the dish under the stream.
    const swirl = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(el * 5) * 0.25, 0, Math.cos(el * 4) * 0.25));
    w.quaternion.copy(qWash).multiply(swirl);
    setWater(true, surfaceY());
    const hit = new THREE.Vector3(SPOUT.x, surfaceY(), SPOUT.z);
    if (Math.random() < 0.7) spawn(hit, { n: 2, color: 0xa8dcff, speed: 1.6, gravity: 7, size: [0.025, 0.05], life: 0.5 });
    for (const f of lather) {
      if (k < Math.random() * 0.5) continue; // foam goes in waves
      f.position.addScaledVector(f.userData.slide, dt * 0.8);
      f.scale.multiplyScalar(1 - dt * 3.2);
    }
    followLeft();
  });
  running.stop();
  setWater(false);
  for (const f of lather) w.remove(f);
  w.userData.lather = [];

  // 5. Quick shake to get the water off.
  sfx.splash();
  await animate(0.45, (k, dt, el) => {
    w.quaternion.copy(qWash).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.sin(el * 38) * 0.18 * (1 - k))));
    if (Math.random() < 0.6) spawn(dishLocalToWorld(w, new THREE.Vector3((Math.random() - 0.5) * 2 * r, size.y * 0.5, (Math.random() - 0.5) * 2 * r)), { n: 1, color: 0xa8dcff, speed: 2.2, gravity: 6, size: [0.025, 0.05], life: 0.6 });
    followLeft();
  });
  w.quaternion.copy(qWash);

  // 6. Sparkle, off to the rack, thumbs up, gloves leave.
  const sparkleAt = dishLocalToWorld(w, new THREE.Vector3(0, size.y * 0.5, 0));
  for (let i = 0; i < 5; i++) setTimeout(() => spawn(sparkleAt, { n: 6, color: 0xfff3a0, speed: 2.4, size: [0.03, 0.07], glow: true }), i * 70);
  sfx.ding();
  t.doneAt = Date.now();
  t.doneDay = today();
  t.soak = null;
  logEvent('washed', t);
  render();
  layoutRack(t.id);
  settleSink();
  const sinkEmpty = !tasks.some((x) => !x.doneAt && !x.soak);

  const lFrom = { pos: leftHand.position.clone(), quat: leftHand.quaternion.clone() };
  const rFrom = { pos: rightHand.position.clone(), quat: rightHand.quaternion.clone() };
  // Thumbs up toward the camera, off to the right of where the dish was.
  const thumbsPos = WASH_POS.clone().add(new THREE.Vector3(1.4, 0.6, 0.6));
  const camDir = new THREE.Vector3().subVectors(WASH_VIEW.pos, thumbsPos).normalize();
  // Thumb (+x) points up, curled fingers toward the camera.
  const thumbsQ = handQuat(new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), camDir), camDir.clone().negate());
  const leftOut = { pos: new THREE.Vector3(-7, 5, 3), quat: lFrom.quat };
  focusOn(thumbsPos);
  await animate(0.45, (k) => {
    const e = easeInOut(k);
    placeHand(rightHand, rFrom, { pos: thumbsPos, quat: thumbsQ }, e);
    setPose(rightHand, { curl: 0.5 + 1.0 * e, thumb: 0.3 + 0.7 * e });
    (mode === 'brush' ? brush : sponge).scale.multiplyScalar(k < 1 ? 0.85 : 0.001); // tool shrinks away
    placeHand(leftHand, lFrom, leftOut, e);
    setPose(leftHand, { curl: 0.85 * (1 - e) });
  });
  await animate(0.5, (k, dt, el) => {
    rightHand.position.y = thumbsPos.y + Math.sin(el * 14) * 0.05; // little pump
  });
  if (!sinkEmpty) { viewTo(HOME_VIEW, 0.8); focusOn(null); }
  sfx.whoosh();
  const rOut = { pos: new THREE.Vector3(7, 5, 3), quat: thumbsQ };
  const rNow = { pos: rightHand.position.clone(), quat: rightHand.quaternion.clone() };
  await animate(0.5, (k) => placeHand(rightHand, rNow, rOut, easeInOut(k)));

  // Reset props for next time.
  leftHand.visible = rightHand.visible = false;
  setTool(null);
  if (sinkEmpty) await finale();
  else await wait(0.3);
  washing = null;
  document.body.classList.remove('washing');
  hideToast();
}

// ---------------------------------------------------------------------------
// The "sink's empty" finale: fill it up, pull the plug, watch it swirl away.
// ---------------------------------------------------------------------------
const SINK_VIEW = { pos: new THREE.Vector3(0.6, 8.2, 5.4), look: new THREE.Vector3(0, -1.6, -0.2) };
const FILL_Y = -0.75;
const sinkWater = new THREE.Mesh(
  new THREE.BoxGeometry(SINK.w - 0.02, 1, SINK.d - 0.02),
  new THREE.MeshStandardMaterial({ color: 0x7fc6e0, transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1, depthWrite: false }),
);
sinkWater.visible = false;
scene.add(sinkWater);
const swirl = new THREE.Mesh(new THREE.CircleGeometry(3.4, 64), new THREE.MeshBasicMaterial({ map: makeSwirlTexture(), transparent: true, opacity: 0, depthWrite: false }));
swirl.rotation.x = -Math.PI / 2;
swirl.renderOrder = 2; // draw over the water body
swirl.visible = false;
scene.add(swirl);
const funnel = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x2c7fa6, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
funnel.rotation.x = Math.PI; // tip down into the drain
funnel.renderOrder = 3;
funnel.visible = false;
scene.add(funnel);
const plug = new THREE.Group();
{
  const rubber = new THREE.MeshStandardMaterial({ color: 0x2e3438, roughness: 0.7 });
  const stopper = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.29, 0.12, 28), rubber);
  stopper.position.y = 0.06;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.028, 10, 24), steel);
  ring.position.y = 0.23;
  plug.add(stopper, ring);
  plug.visible = false;
  scene.add(plug);
}

function makeSwirlTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.translate(256, 256);
  g.lineCap = 'round';
  for (let arm = 0; arm < 6; arm++) {
    g.beginPath();
    for (let r = 250; r > 8; r -= 3) {
      const a = (arm / 6) * Math.PI * 2 + (250 - r) / 55;
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.strokeStyle = 'rgba(25,105,145,0.75)';
    g.lineWidth = 14;
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 4;
    g.stroke();
  }
  const dark = g.createRadialGradient(0, 0, 0, 0, 0, 120);
  dark.addColorStop(0, 'rgba(20,70,95,0.75)');
  dark.addColorStop(1, 'rgba(20,70,95,0)');
  g.fillStyle = dark;
  g.fillRect(-256, -256, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function setSinkLevel(y) {
  const h = Math.max(0.001, y - FLOOR_Y);
  sinkWater.scale.y = h;
  sinkWater.position.set(0, FLOOR_Y + h / 2, 0);
  // Deeper water reads bluer, so draining visibly lightens it.
  sinkWater.material.opacity = 0.2 + 0.5 * Math.min(1, h / (FILL_Y - FLOOR_Y));
  swirl.position.set(0, y + 0.01, 0);
}

async function finale() {
  showToast("Sink's empty! Pulling the plug…");
  focusOn(null); // the whole sink is the subject here
  await viewTo(SINK_VIEW, 1.0);

  // Fill up with soapy water.
  plug.visible = true;
  plug.scale.setScalar(1);
  plug.position.set(0, FLOOR_Y, 0);
  plug.rotation.set(0, 0, 0);
  sinkWater.visible = swirl.visible = true;
  swirl.material.opacity = 0;
  setSinkLevel(FLOOR_Y);
  const foam = [];
  const running = sfx.water();
  let foamClock = 0;
  await animate(1.6, (k, dt, el) => {
    const level = FLOOR_Y + (FILL_Y - FLOOR_Y) * easeInOut(k);
    setSinkLevel(level);
    setWater(true, level);
    water.material.opacity = Math.min(0.8, el * 4);
    water.scale.x = water.scale.z = 1 + Math.sin(el * 40) * 0.08;
    if (Math.random() < 0.6) spawn(new THREE.Vector3(SPOUT.x, level, SPOUT.z), { n: 2, color: 0xa8dcff, speed: 1.4, gravity: 6, size: [0.03, 0.06], life: 0.5 });
    foamClock += dt;
    while (foamClock > 0.025) {
      foamClock -= 0.025;
      const r = 0.4 + Math.random() * 2.4, ang = Math.random() * Math.PI * 2;
      const x = THREE.MathUtils.clamp(Math.cos(ang) * r, -2.9, 2.9), z = THREE.MathUtils.clamp(Math.sin(ang) * r, -1.9, 1.9);
      addFoam(scene, foam, new THREE.Vector3(x, level, z), 0.08 + Math.random() * 0.14);
    }
    for (const f of foam) f.position.y = level + 0.02;
    growFoam(foam, dt);
    swirl.rotation.z -= dt * 0.2;
  });
  running.stop();
  setWater(false);

  // A glove dives in and yanks the plug.
  const ringTop = new THREE.Vector3(0, FLOOR_Y + 0.26, 0);
  const handQ = handQuat(new THREE.Vector3(0, -0.35, -1), new THREE.Vector3(0, -1, 0.3));
  rightHand.scale.setScalar(1);
  rightHand.visible = true;
  setPose(rightHand, { curl: 0.2, thumb: 0.6 });
  const enter = { pos: new THREE.Vector3(6, 4, 3), quat: handQ };
  const above = { pos: new THREE.Vector3(0.1, FILL_Y + 0.9, 0.55), quat: handQ };
  const grab = { pos: ringTop.clone().add(new THREE.Vector3(0, 0.12, 0.42)), quat: handQ };
  sfx.whoosh();
  await animate(0.5, (k) => { rightHand.position.lerpVectors(enter.pos, above.pos, easeInOut(k)); rightHand.quaternion.copy(handQ); });
  let splashed = false;
  await animate(0.4, (k) => {
    rightHand.position.lerpVectors(above.pos, grab.pos, easeInOut(k));
    if (!splashed && rightHand.position.y < FILL_Y + 0.3) {
      splashed = true;
      sfx.splash();
      spawn(new THREE.Vector3(0, FILL_Y, 0.4), { n: 14, color: 0xa8dcff, speed: 2, gravity: 6, size: [0.03, 0.07], life: 0.7 });
    }
  });
  await animate(0.15, (k) => setPose(rightHand, { curl: 0.2 + 1.1 * k, thumb: 0.6 - 0.5 * k }));
  const plugOffset = plug.position.clone().sub(rightHand.position);
  const lifted = { pos: new THREE.Vector3(1.6, 1.2, 0.9) };
  sfx.pop();
  await animate(0.45, (k) => {
    rightHand.position.lerpVectors(grab.pos, lifted.pos, easeOut(k));
    plug.position.copy(rightHand.position).add(plugOffset);
    if (k > 0.3 && k < 0.4) spawn(new THREE.Vector3(0, FILL_Y, 0.2), { n: 6, color: 0xa8dcff, speed: 1.8, gravity: 6, size: [0.03, 0.06], life: 0.6 });
  });

  // Drain: the water swirls away and takes the foam with it.
  const drainTime = 2.8;
  sfx.gurgle(drainTime);
  funnel.visible = true;
  const polar = foam.map((f) => ({ f, r: Math.hypot(f.position.x, f.position.z), a: Math.atan2(f.position.z, f.position.x) }));
  await animate(drainTime, (k, dt, el) => {
    const level = FILL_Y - (FILL_Y - FLOOR_Y) * (k * k);
    setSinkLevel(level);
    const strength = Math.sin(Math.min(1, k * 1.15) * Math.PI);
    swirl.material.opacity = 0.6 * strength;
    swirl.rotation.z -= dt * (1.5 + k * 9);
    funnel.scale.set(0.4 + strength, Math.max(0.01, (level - FLOOR_Y) * 0.9 + 0.05), 0.4 + strength);
    funnel.position.set(0, level - funnel.scale.y / 2, 0);
    funnel.rotation.y -= dt * 8;
    for (const p of polar) {
      p.a -= dt * (0.8 + 2.6 / (p.r + 0.3)) * (0.5 + k);
      p.r = Math.max(0, p.r - dt * (0.12 + k * 1.1));
      p.f.position.set(Math.cos(p.a) * p.r, level + 0.02, Math.sin(p.a) * p.r);
      if (p.r < 0.35) p.f.scale.multiplyScalar(1 - dt * 6);
    }
    rightHand.position.y = lifted.pos.y + Math.sin(el * 3) * 0.06; // the plug dangles
    plug.position.copy(rightHand.position).add(plugOffset);
  });
  for (const f of foam) scene.remove(f);
  sinkWater.visible = swirl.visible = funnel.visible = false;

  // Celebrate, drop the plug back in, glove leaves.
  sfx.fanfare();
  for (let i = 0; i < 8; i++) {
    setTimeout(() => spawn(new THREE.Vector3((Math.random() - 0.5) * 5, FLOOR_Y + 0.4, (Math.random() - 0.5) * 3), { n: 6, color: [0xfff3a0, 0xa8f0d8, 0xffc2d9][i % 3], speed: 3, size: [0.04, 0.09], glow: true, life: 1.2 }), i * 90);
  }
  const doneToday = tasks.filter((x) => x.doneDay === today()).length;
  showToast(`Sink's empty · ${doneToday} cleaned today`);
  const plugFrom = plug.position.clone();
  await animate(0.45, (k) => {
    plug.position.lerpVectors(plugFrom, new THREE.Vector3(0, FLOOR_Y, 0), easeInOut(k));
    plug.position.y += Math.sin(k * Math.PI) * 0.6;
    setPose(rightHand, { curl: 1.3 * (1 - k), thumb: 0.1 + 0.5 * k });
  });
  sfx.clink(true);
  const out = rightHand.position.clone();
  await animate(0.5, (k) => rightHand.position.lerpVectors(out, new THREE.Vector3(7, 5, 3), easeInOut(k)));
  rightHand.visible = false;
  viewTo(HOME_VIEW, 1.0);
  focusOn(null);
  setTimeout(waveSign, 700); // the sign cheers once the camera is back
  await wait(1.6);
}

// ---------------------------------------------------------------------------
// Counter props: click to pick one up, drag to turn it, click again to put it back.
// Each has a little surprise when it's lifted (and again when you click it in hand).
// ---------------------------------------------------------------------------
const props = []; // pivot groups centred on each prop, so it turns about its middle
let heldProp = null;

function addProp(prop, name, fx) {
  prop.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(prop);
  const pivot = new THREE.Group();
  pivot.position.copy(box.getCenter(new THREE.Vector3()));
  prop.position.sub(pivot.position);
  pivot.add(prop);
  pivot.userData = { prop: true, name, fx, inner: prop, home: pivot.position.clone(), size: box.getSize(new THREE.Vector3()), model: pivot };
  scene.add(pivot);
  props.push(pivot);
}
const propFromHit = (obj) => { while (obj && !obj.userData?.prop) obj = obj.parent; return obj; };

// Glide a prop to a pose, scaling as it goes.
async function glideProp(p, pos, quat, scale, dur) {
  // A newer glide (picked up again on its way home) takes over from this one.
  const id = (p.userData.glideId || 0) + 1;
  p.userData.glideId = id;
  p.userData.busy = true;
  const p0 = p.position.clone(), q0 = p.quaternion.clone(), s0 = p.scale.x;
  await animate(dur, (k) => {
    if (p.userData.glideId !== id) return;
    const e = easeInOut(k);
    p.position.lerpVectors(p0, pos, e);
    p.quaternion.slerpQuaternions(q0, quat, e);
    p.scale.setScalar(s0 + (scale - s0) * e);
  });
  if (p.userData.glideId === id) p.userData.busy = false;
}

async function holdProp(p) {
  if (washing || !p) return;
  if (inspecting) putBack();
  if (heldProp) dropProp();
  setHover(null);
  tooltip.classList.add('hidden');
  heldProp = p;
  document.body.classList.add('holding');
  const label = $('prop-label');
  label.querySelector('strong').textContent = p.userData.name;
  label.classList.remove('hidden');
  // Same spot the dishes float to, scaled so small things (a lemon) and big ones (the plant) read the same.
  const dir = new THREE.Vector3().subVectors(HOME_VIEW.look, camera.position).normalize();
  const pos = camera.position.clone().addScaledVector(dir, 8.5).add(new THREE.Vector3(0, 0.3, -0.6));
  const size = p.userData.size;
  const scale = THREE.MathUtils.clamp(1.9 / Math.max(size.x, size.y, size.z), 1, 4);
  // Front turned up toward the (high) camera, so you see its side rather than its lid, with a three-quarter twist.
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.asin(-dir.y) * 0.8);
  sfx.whoosh();
  const glide = (p.userData.glideId || 0) + 1;
  await glideProp(p, pos, tilt.multiply(yaw), scale, 0.55);
  if (heldProp === p && p.userData.glideId === glide) surprise(p);
}

function dropProp() {
  const p = heldProp;
  if (!p) return;
  heldProp = null;
  document.body.classList.remove('holding');
  $('prop-label').classList.add('hidden');
  glideProp(p, p.userData.home, new THREE.Quaternion(), 1, 0.5).then(() => {
    if (heldProp !== p) sfx.clink(false);
  });
}

// World-space point on the prop, from a 0..1 position inside its box (0.5, 1, 0.5 = top centre).
function propPoint(p, fx, fy, fz) {
  const s = p.userData.size;
  return p.localToWorld(new THREE.Vector3((fx - 0.5) * s.x, (fy - 0.5) * s.y, (fz - 0.5) * s.z));
}

// The surprises animate the inner model, so they never fight the drag/turn on the pivot.
const SURPRISES = {
  wobble(p, m) {
    sfx.rustle();
    return animate(1.1, (k) => { m.rotation.z = Math.sin(k * Math.PI * 6) * 0.18 * (1 - k); });
  },
  rattle(p, m) {
    [0, 0.12, 0.26].forEach((d) => setTimeout(() => sfx.clink(true), d * 1000));
    return animate(0.5, (k) => { m.position.x = m.userData.x0 + Math.sin(k * Math.PI * 10) * 0.06 * (1 - k); });
  },
  flip(p, m) {
    sfx.knock();
    return animate(0.7, (k) => { m.rotation.x = easeInOut(k) * Math.PI * 2; m.position.y = m.userData.y0 + Math.sin(k * Math.PI) * 0.5; });
  },
  squeeze(p, m) {
    sfx.squish();
    const color = p.userData.name === 'Lemon' ? 0xfff07a : 0xa8dcff;
    spawn(propPoint(p, 0.5, 0.2, 0.5), { n: 12, color, speed: 2, gravity: 6, size: [0.03, 0.06], life: 0.8 });
    return animate(0.45, (k) => { const q = Math.sin(k * Math.PI) * 0.3; m.scale.set(1 + q * 0.5, 1 - q, 1 + q * 0.5); });
  },
  salt(p, m) {
    sfx.shake();
    for (let i = 0; i < 4; i++) setTimeout(() => spawn(propPoint(p, 0.5, 1, 0.5), { n: 8, color: 0xffffff, speed: 0.8, gravity: 5, size: [0.015, 0.03], life: 0.9 }), i * 140);
    return animate(0.6, (k) => { m.position.y = m.userData.y0 + Math.abs(Math.sin(k * Math.PI * 4)) * 0.12; m.rotation.z = Math.sin(k * Math.PI * 4) * 0.25; });
  },
  grind(p, m) {
    sfx.grind();
    for (let i = 0; i < 5; i++) setTimeout(() => spawn(propPoint(p, 0.5, 0, 0.5), { n: 5, color: 0x2b2420, speed: 0.5, gravity: 5, size: [0.015, 0.03], life: 0.9, opacity: 1 }), i * 120);
    return animate(0.7, (k) => { m.rotation.y = m.userData.ry0 + easeInOut(k) * Math.PI * 2; });
  },
  glug(p, m) {
    sfx.glug();
    return animate(0.8, (k) => { m.rotation.z = Math.sin(k * Math.PI) * 0.7; });
  },
  pump(p, m) {
    sfx.squirt();
    setTimeout(() => {
      const at = propPoint(p, 0.85, 0.95, 0.5);
      spawn(at, { n: 10, speed: 0.9, size: [0.05, 0.12], life: 1.4 });
      spawn(at, { n: 6, color: 0x9fe0b8, speed: 0.6, size: [0.03, 0.07], life: 1.2 });
    }, 150);
    return animate(0.4, (k) => { m.position.y = m.userData.y0 - Math.sin(k * Math.PI) * 0.08; });
  },
  async toast(p, m) {
    // Two slices pop out of the slots, then drop back in.
    if (!m.userData.slices) {
      const bread = new THREE.MeshStandardMaterial({ color: 0xd9a35f, roughness: 0.9 });
      m.userData.slices = [-0.12, 0.12].map((dz) => {
        const slice = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.55, 0.1), bread);
        slice.position.set(0, 0.1, dz);
        slice.visible = false;
        p.add(slice);
        return slice;
      });
    }
    const { slices } = m.userData;
    slices.forEach((sl) => { sl.visible = true; });
    sfx.pop();
    await animate(0.35, (k) => slices.forEach((sl, i) => { sl.position.y = 0.1 + easeOut(k) * (0.55 + i * 0.08); }));
    sfx.ding();
    await wait(0.5);
    await animate(0.3, (k) => slices.forEach((sl, i) => { sl.position.y = 0.1 + (1 - k) * (0.55 + i * 0.08); }));
    slices.forEach((sl) => { sl.visible = false; });
  },
};
async function surprise(p) {
  const m = p.userData.inner;
  if (m.userData.playing) return;
  m.userData.playing = true;
  Object.assign(m.userData, { x0: m.position.x, y0: m.position.y, ry0: m.rotation.y });
  const rest = { pos: m.position.clone(), rot: m.rotation.clone(), scale: m.scale.clone() };
  await SURPRISES[p.userData.fx]?.(p, m);
  m.position.copy(rest.pos); m.rotation.copy(rest.rot); m.scale.copy(rest.scale);
  m.userData.playing = false;
  invalidate();
}

// Keep the prop's name card under it while it's held.
function placePropLabel() {
  if (!heldProp) return;
  const el = $('prop-label');
  const { size } = heldProp.userData;
  const drop = (Math.max(size.x, size.y, size.z) * heldProp.scale.x) / 2 + 0.35;
  const v = heldProp.position.clone().add(new THREE.Vector3(0, -drop, 0).applyQuaternion(camera.quaternion)).project(camera);
  el.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
  el.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
}

// ---------------------------------------------------------------------------
// Interaction: hover, click to pick up, click again to set down, drag to turn.
// ---------------------------------------------------------------------------
const pointer = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');
let hovered = null;
let inspecting = null;
let press = null; // { x, y, moved }

function dishFromHit(obj) {
  while (obj && !obj.userData?.taskId) obj = obj.parent;
  return obj;
}
function pick(clientX, clientY, candidates) {
  pointer.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(candidates, true)[0] || null;
}
const liveDishes = () => tasks.filter((t) => !t.doneAt).map((t) => dishes.get(t.id)).filter((w) => w && w !== inspecting);

function setHover(w) {
  if (hovered === w) return;
  invalidate();
  if (hovered) setGlow(hovered, 0);
  hovered = w;
  if (hovered) setGlow(hovered, 0.18);
  canvas.style.cursor = w ? 'pointer' : 'default';
}
function setGlow(w, amount) {
  w.userData.model.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.userData.ownMat) { o.material = o.material.clone(); o.userData.ownMat = true; }
    o.material.emissive = new THREE.Color(0x7fd1c1);
    o.material.emissiveIntensity = amount;
  });
}

// Dragging a dish between the sink and the tub. The dish floats on a plane above the counter,
// under the cursor; where the pointer meets the counter decides the drop.
const DRAG_Y = 1.4;
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DRAG_Y);
const counterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function rayAt(clientX, clientY, plane) {
  pointer.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
}
const over = (at, x, z, w, d) => at && Math.abs(at.x - x) < w / 2 + 0.3 && Math.abs(at.z - z) < d / 2 + 0.3;
function dropTarget(at, t) {
  if (over(at, TUB.x, TUB.z, TUB.w, TUB.d)) return t.soak || freeSpot() !== undefined ? 'tub' : 'full';
  if (over(at, 0, 0, SINK.w, SINK.d)) return 'sink';
  return null;
}
const DROP_HINT = { tub: (t) => (t.soak ? 'Move it in the tub' : 'Soak'), full: () => "Tub's full", sink: (t) => (t.soak ? 'Back in the sink' : 'Move it here') };
function dragDish(w, e) {
  const t = taskById(w.userData.taskId);
  const at = rayAt(e.clientX, e.clientY, dragPlane);
  if (at) moveTo(w, at, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, t.rotY || 0, 0)), 0.08, easeOut);
  const target = dropTarget(rayAt(e.clientX, e.clientY, counterPlane), t);
  tooltip.textContent = target ? DROP_HINT[target](t) : 'Drop it in the sink or the tub';
  tooltip.style.left = e.clientX + 'px';
  tooltip.style.top = e.clientY + 'px';
  tooltip.classList.remove('hidden');
  canvas.style.cursor = 'grabbing';
}
// Nearest free tub spot to a point (a dish already soaking may keep its own).
function nearestSpot(at, t) {
  const taken = new Set(soaking().filter((s) => s !== t).map((s) => s.soak.spot));
  return [...SPOTS.keys()].filter((i) => !taken.has(i))
    .sort((a, b) => Math.hypot(SPOTS[a].x - at.x, SPOTS[a].z - at.z) - Math.hypot(SPOTS[b].x - at.x, SPOTS[b].z - at.z))[0];
}
function dropDish(w, e) {
  const t = taskById(w.userData.taskId);
  const at = rayAt(e.clientX, e.clientY, counterPlane);
  const target = dropTarget(at, t);
  tooltip.classList.add('hidden');
  canvas.style.cursor = 'default';
  if (target === 'tub') {
    const spot = nearestSpot(at, t);
    if (t.soak) t.soak.spot = spot;
    else { t.soak = { since: Date.now(), spot }; logEvent('soaked', t); }
    splashTub(spot, 450);
  } else if (target === 'sink') {
    if (t.soak) { t.soak = null; logEvent('taken-out', t); }
    const size = w.userData.size, r = Math.max(size.x, size.z) / 2;
    const mx = Math.max(0, SINK.w / 2 - r * 0.8 - 0.1), mz = Math.max(0, SINK.d / 2 - r * 0.8 - 0.1);
    Object.assign(t, { x: THREE.MathUtils.clamp(at.x, -mx, mx), z: THREE.MathUtils.clamp(at.z, -mz, mz), pv: PILE_VERSION });
    setTimeout(() => sfx.clink(METAL.has(t.type)), 350);
  } else if (target === 'full') notify("The tub's full. Wash or take one out first.");
  layoutTub();
  settleSink();
  render();
}

canvas.addEventListener('pointermove', (e) => {
  if (washing) return;
  if (press) {
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (!press.moved && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > 5) press.moved = true;
    const held = inspecting || heldProp;
    if (press.moved && !held && press.dish) {
      if (!press.dragging) { press.dragging = true; setHover(null); sfx.whoosh(); }
      dragDish(press.dish, e);
    } else if (press.moved && held) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      held.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(up, dx * 0.01));
      held.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(right, dy * 0.01));
      canvas.style.cursor = 'grabbing';
    }
    press.x = e.clientX; press.y = e.clientY;
    return;
  }
  const { dish: w, prop, letter, calendar } = pickAny(e.clientX, e.clientY);
  setHover(w || prop || calendar);
  if (letter) canvas.style.cursor = 'pointer';
  else if ((inspecting || heldProp) && !w && !prop) canvas.style.cursor = 'grab';
  if (w || prop || calendar) {
    const t = w && taskById(w.userData.taskId);
    tooltip.textContent = calendar ? calendarTip() : prop ? prop.userData.name : t.soak ? `${t.title} · soaking ${elapsed(t.soak.since)}` : `${t.title} · ${DISHES[t.type].size}`;
    tooltip.style.left = e.clientX + 'px';
    tooltip.style.top = e.clientY + 'px';
    tooltip.classList.remove('hidden');
  } else tooltip.classList.add('hidden');
});

canvas.addEventListener('pointerdown', (e) => {
  if (washing) return;
  canvas.setPointerCapture(e.pointerId);
  press = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false };
  if (!inspecting && !heldProp) press.dish = pickAny(e.clientX, e.clientY).dish || null;
});
// A drag the browser interrupted (e.g. a system gesture): put the dish back.
canvas.addEventListener('pointercancel', () => {
  if (press?.dragging) { tooltip.classList.add('hidden'); layoutTub(); settleSink(); }
  press = null;
});
canvas.addEventListener('pointerup', (e) => {
  const p = press;
  press = null;
  if (p?.dragging && !washing) { dropDish(p.dish, e); return; }
  if (!p || p.moved || washing) return;
  // A click: pick up a dish or prop (swapping if something is already held), otherwise set down.
  const { dish: w, prop, letter, calendar } = pickAny(e.clientX, e.clientY, true);
  if (calendar) { putBack(); dropProp(); syncCalendar(); }
  else if (w && w !== inspecting) inspect(w);
  else if (prop) { if (prop === heldProp) surprise(prop); else holdProp(prop); }
  else if (letter) hopLetter(letter, 0, true);
  else if (inspecting) putBack();
  else if (heldProp) dropProp();
});
const calendarFromHit = (obj) => { while (obj && obj !== wallCal) obj = obj.parent; return obj; };
// Closest thing under the pointer: a dish, a counter prop, a sign letter, or the wall calendar.
function pickAny(x, y, includeHeld = false) {
  const dishList = liveDishes();
  if (includeHeld && inspecting) dishList.push(inspecting);
  const propList = props.filter((p) => includeHeld || p !== heldProp);
  const hit = pick(x, y, [...dishList, ...propList, ...signLetters, ...(wallCal ? [wallCal] : [])]);
  if (!hit) return {};
  if (calendarFromHit(hit.object)) return { calendar: wallCal };
  if (signLetters.includes(hit.object) || signLetters.includes(hit.object.parent)) return { letter: signLetters.includes(hit.object) ? hit.object : hit.object.parent };
  return { dish: dishFromHit(hit.object), prop: propFromHit(hit.object) };
}

// ---------------------------------------------------------------------------
// Inspect panel
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const taskById = (id) => tasks.find((t) => t.id === id);

function inspect(w) {
  if (washing || !w) return;
  if (inspecting) putBack();
  dropProp();
  setHover(null);
  tooltip.classList.add('hidden');
  inspecting = w;
  const t = taskById(w.userData.taskId);
  // Float the dish up in front of the camera, opening facing the viewer.
  const dir = new THREE.Vector3().subVectors(HOME_VIEW.look, camera.position).normalize();
  const pos = camera.position.clone().addScaledVector(dir, 8.5).add(new THREE.Vector3(innerWidth / innerHeight > 1.2 ? -0.8 : 0, 0.4, -0.9));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
  moveTo(w, pos, q, 0.6, easeInOut);
  fillPanel(t);
  document.body.classList.add('holding'); // hides the Add button so it can't collide with the dish shortcuts
  $('inspect').classList.remove('hidden');
  $('dish-actions').classList.remove('hidden');
  settleSink();
}

function fillPanel(t) {
  $('i-title').textContent = t.title;
  $('i-notes').textContent = t.notes || '';
  $('i-size').textContent = `${DISHES[t.type].label} · ${DISHES[t.type].size}`;
  $('i-grime').textContent = GRIME[t.grime].label;
  $('i-grime').style.background = '#' + new THREE.Color(GRIME[t.grime].color).lerp(new THREE.Color(0xffffff), 0.65).getHexString();
  const soakBtn = $('a-soak');
  soakBtn.disabled = !t.soak && freeSpot() === undefined;
  soakBtn.innerHTML = `<span>${icon(t.soak ? 'undo' : 'bubbles')}</span>${t.soak ? 'Take out' : soakBtn.disabled ? 'Tub full' : 'Soak'}`;
  const loose = Math.round((loosenedFor(t) / LOOSEN_MAX) * 100);
  $('i-soak').textContent = t.soak
    ? `Soaking for ${elapsed(t.soak.since)} · grime ${loose >= 100 ? 'fully loosened' : `${loose}% loosened`}`
    : loose > 0 ? `Soaked earlier · grime ${loose}% loosened` : '';
}

// Keep the shortcut buttons pinned beside the held dish.
function placeDishActions() {
  const el = $('dish-actions');
  if (!inspecting || washing) { el.classList.add('hidden'); return; }
  const size = inspecting.userData.size;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const v = inspecting.position.clone().addScaledVector(right, Math.max(size.x, size.z) / 2 + 0.35).project(camera);
  el.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
  el.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
}

function closePanel() {
  dropProp();
  inspecting = null;
  document.body.classList.remove('holding');
  $('inspect').classList.add('hidden');
  $('dish-actions').classList.add('hidden');
}

function putBack() {
  if (!inspecting) return;
  closePanel();
  settleSink();
  layoutTub();
}

function toss(w) {
  const t = taskById(w.userData.taskId);
  closePanel();
  tasks = tasks.filter((x) => x.id !== t.id);
  logEvent('removed', t);
  const out = w.position.clone().add(new THREE.Vector3(0, 8, 0));
  moveTo(w, out, w.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(2, 1, 0))), 0.5, (x) => x * x, () => {
    scene.remove(w);
    dishes.delete(t.id);
  });
  settleSink();
  render();
}

$('a-down').onclick = putBack;
$('a-wash').onclick = () => inspecting && wash(inspecting);
$('a-soak').onclick = () => inspecting && soak(inspecting);
$('i-toss').onclick = () => inspecting && toss(inspecting);
addEventListener('keydown', (e) => {
  if (heldProp && e.key === 'Escape') { dropProp(); return; }
  if ($('add-dialog').open || washing || !inspecting) return;
  if (e.key === 'Escape') putBack();
  if (e.key === 'Enter') wash(inspecting);
  if (e.key === 's' || e.key === 'S') soak(inspecting);
  if (e.key === 'e' || e.key === 'E') { e.preventDefault(); openEdit(taskById(inspecting.userData.taskId)); }
});


const toast = $('toast');
let toastTimer;
// Optional action renders as a link in the toast (used for Undo); such toasts hide themselves.
function showToast(text, action) {
  clearTimeout(toastTimer);
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.classList.toggle('hidden', !action);
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { hideToast(); action.run(); };
    toastTimer = setTimeout(hideToast, 7000);
  }
  toast.classList.remove('hidden');
}
function hideToast() { clearTimeout(toastTimer); toast.classList.add('hidden'); }
// A toast with no button: goes away on its own.
function notify(text, ms = 3500) {
  showToast(text);
  toastTimer = setTimeout(hideToast, ms);
}

// Calendar sync. tools/calendar-dishes.gs, deployed as a web app only you can open, adds today's
// accepted events to the Gist. Clicking the wall calendar opens it in a small popup, waits for
// the script to record the sync in calendar.json, then pulls in the new dishes and closes it.
const clockTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function calendarTip() {
  if (storage.mode !== 'gist') return 'Calendar sync works on the hosted site';
  const last = storage.calendar?.lastSync;
  return last ? `Sync my calendar · last synced ${clockTime(last)}` : 'Sync my calendar';
}
let calendarSyncing = false;
async function syncCalendar() {
  flipCalendarPage();
  refreshCalendarFace();
  if (storage.mode !== 'gist') { notify('Calendar sync works on the hosted site (brandonconcepcion.com/sinkful)'); return; }
  if (calendarSyncing) return;
  let info = storage.calendar || {};
  if (!info.syncUrl) {
    const url = prompt('One-time setup: paste the web app URL of your Sinkful calendar script\n(Apps Script > Deploy > Manage deployments > Web app URL)');
    if (!url) return;
    if (!/^https:\/\/script\.google\.com\/.+\/exec/.test(url.trim())) { notify("That doesn't look like an Apps Script web app URL (it ends in /exec)", 5000); return; }
    info = { ...info, syncUrl: url.trim() };
    storage.calendar = info;
    // Saved for every device; the script keeps it when it records syncs.
    storage.backend.putCalendar(info).catch(() => notify("Couldn't save the URL to your Gist; you may be asked again"));
  }
  calendarSyncing = true;
  const before = info.lastSync;
  const popup = open(info.syncUrl, 'sinkful-calendar', 'width=480,height=420'); // right away, while the click still counts
  showToast('Syncing your calendar…');
  try {
    for (let i = 0; i < 36; i++) { // up to 90 seconds (the first time, Google may ask you to sign in)
      await new Promise((r) => setTimeout(r, 2500));
      const data = await storage.backend.get().catch(() => null);
      const cal = storage.calendar;
      if (!data || !cal?.lastSync || cal.lastSync === before) continue;
      if ((data.rev || 0) !== storage.rev) {
        applyRemote(data);
        if (serialize() !== storage.lastSaved) flushSave();
        else storage.lastSaved = serialize();
      }
      if (!cal.syncUrl) storage.backend.putCalendar({ ...cal, syncUrl: info.syncUrl }).catch(() => {}); // lost in a race with the script
      popup?.close();
      notify(cal.added ? `Added ${plural(cal.added)} from your calendar` : 'Calendar synced: nothing new today');
      if (cal.added) sfx.ding();
      return;
    }
    notify('Still waiting on Google. Finish in the popup, and the dishes will show up within a few minutes.', 6000);
  } finally {
    calendarSyncing = false;
  }
}

// ---------------------------------------------------------------------------
// Bulk actions per area, all undoable
// ---------------------------------------------------------------------------
const inSinkTasks = () => tasks.filter((t) => !t.doneAt && !t.soak);
const onRackTasks = () => tasks.filter((t) => t.doneAt && !t.archived);
const plural = (n) => `${n} dish${n === 1 ? '' : 'es'}`;

function stripGrime(w) {
  for (const b of w.userData.blobs) w.remove(b);
  w.userData.blobs = [];
}
// (Re)create every dish mesh from `tasks` and snap them into place.
function buildAllDishes() {
  for (const w of dishes.values()) scene.remove(w);
  dishes.clear();
  tweens.clear();
  for (const t of tasks) {
    if (t.archived) continue;
    const w = makeDish(t);
    if (t.doneAt) stripGrime(w);
    dishes.set(t.id, w);
    scene.add(w);
  }
  settleSink();
  layoutTub();
  layoutRack();
  for (const [obj, tw] of tweens) { obj.position.copy(tw.p1); obj.quaternion.copy(tw.q1); }
  tweens.clear();
}
function offerUndo(text) {
  const before = JSON.stringify(tasks);
  return () => showToast(text, { label: 'Undo', run: () => { tasks = JSON.parse(before); buildAllDishes(); render(); logEvent('undo', null, { action: text }); } });
}
const busy = () => washing || $('add-dialog').open;

// Every dish lifts out with a sparkle and flies to the rack, a beat apart.
async function washAll(list, area) {
  if (busy() || !list.length) return;
  const undo = offerUndo(`Washed ${plural(list.length)}`);
  closePanel();
  washing = 'bulk';
  sfx.whoosh();
  const spin = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 2.2, 0.3));
  list.forEach((t, i) => setTimeout(() => {
    const w = dishes.get(t.id);
    if (!w) return;
    moveTo(w, w.position.clone().add(new THREE.Vector3(0, 1.8, 0)), w.quaternion.clone().multiply(spin), 0.4, easeOut);
    spawn(w.position.clone().add(new THREE.Vector3(0, 1.2, 0)), { n: 8, color: 0xfff3a0, speed: 2.2, size: [0.03, 0.07], glow: true });
    spawn(w.position.clone().add(new THREE.Vector3(0, 0.6, 0)), { n: 5, speed: 0.8, size: [0.05, 0.1], life: 1.2 });
    sfx.squeak();
  }, i * 110));
  await wait(list.length * 0.11 + 0.45);
  const now = Date.now();
  for (const t of list) {
    const w = dishes.get(t.id);
    if (w) stripGrime(w);
    Object.assign(t, { doneAt: now, doneDay: today(), soak: null });
    logEvent('washed', t, { bulk: true });
  }
  sfx.ding();
  layoutRack();
  settleSink();
  render();
  list.forEach((t, i) => setTimeout(() => sfx.clink(METAL.has(t.type)), 700 + i * 90));
  await wait(1.1);
  if (area === 'sink' && !inSinkTasks().length) {
    document.body.classList.add('washing');
    await finale();
    document.body.classList.remove('washing');
  }
  washing = null;
  undo();
}

// Dishes toss up and away; their tasks are deleted. No text = caller handles undo.
function clearTasks(list, text) {
  if (busy() || !list.length) return;
  const undo = text ? offerUndo(text) : null;
  closePanel();
  const ids = new Set(list.map((t) => t.id));
  tasks = tasks.filter((t) => !ids.has(t.id));
  for (const t of list) logEvent('removed', t, { bulk: true });
  list.forEach((t, i) => setTimeout(() => {
    const w = dishes.get(t.id);
    if (!w) return;
    const out = w.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 8, 2));
    moveTo(w, out, w.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(2, 1, 0))), 0.55, (x) => x * x, () => {
      scene.remove(w);
      dishes.delete(t.id);
    });
  }, i * 60));
  sfx.whoosh();
  settleSink();
  render();
  undo?.();
}

function takeOutAll() {
  const list = soaking();
  if (busy() || !list.length) return;
  const undo = offerUndo(`Took ${plural(list.length)} out of the tub`);
  closePanel();
  for (const t of list) { t.soak = null; logEvent('taken-out', t, { bulk: true }); }
  sfx.splash();
  for (const t of list) {
    const w = dishes.get(t.id);
    if (w) spawn(w.position.clone().setY(TUB.water), { n: 8, color: 0xa8dcff, speed: 1.4, gravity: 6, size: [0.03, 0.06], life: 0.6 });
  }
  settleSink();
  render();
  undo();
}

function putAway(silent) {
  const list = onRackTasks();
  if (busy() || !list.length) return;
  const undo = silent ? null : offerUndo(`Put away ${plural(list.length)}`);
  for (const t of list) {
    t.archived = true;
    logEvent('put-away', t);
    const w = dishes.get(t.id);
    if (w) moveTo(w, w.position.clone().add(new THREE.Vector3(6, 3, 0)), w.quaternion, 0.6, easeInOut, () => { scene.remove(w); dishes.delete(t.id); });
  }
  render();
  undo?.();
}

// Fresh start: sink and tub tasks are removed, the rack is put away (so today's count stays).
function clearEverything() {
  const active = tasks.filter((t) => !t.doneAt);
  if (busy() || (!active.length && !onRackTasks().length)) return;
  const undo = offerUndo('Cleared everything');
  putAway(true);
  clearTasks(active);
  undo();
}

$('sink-wash-all').onclick = () => washAll(inSinkTasks(), 'sink');
$('sink-clear').onclick = () => { const l = inSinkTasks(); clearTasks(l, `Removed ${plural(l.length)} from the sink`); };
$('soak-wash-all').onclick = () => washAll(soaking(), 'soak');
$('soak-take-out').onclick = takeOutAll;
$('put-away').onclick = () => putAway();
$('clear-all').onclick = clearEverything;

// ---------------------------------------------------------------------------
// Add dialog
// ---------------------------------------------------------------------------
const dialog = $('add-dialog');
const form = $('add-form');
$('size-picker').innerHTML = Object.entries(DISHES).map(([k, d]) =>
  `<label><input type="radio" name="type" value="${k}" ${k === 'plate' ? 'checked' : ''} /><span>${d.label}<small>${d.size}</small></span></label>`).join('');
let editingId = null; // set while the dialog is editing an existing task
function openDialog(t) {
  if (washing || dialog.open) return;
  form.reset();
  editingId = t ? t.id : null;
  $('dialog-title').textContent = t ? 'Edit dish' : 'Add a dish to the sink';
  $('add-submit').textContent = t ? 'Save changes' : 'Drop it in';
  if (t) {
    form.title.value = t.title;
    form.notes.value = t.notes || '';
    form.querySelector(`input[name=type][value=${t.type}]`).checked = true;
    form.querySelector(`input[name=grime][value="${t.grime}"]`).checked = true;
  }
  dialog.showModal();
}
const openAdd = () => openDialog(null);
const openEdit = (t) => t && !t.doneAt && openDialog(t);
$('i-edit').onclick = () => inspecting && openEdit(taskById(inspecting.userData.taskId));
$('add-btn').onclick = openAdd;
addEventListener('keydown', (e) => {
  if ((e.key === 'n' || e.key === 'N') && !inspecting && !e.metaKey && !e.ctrlKey && !e.altKey && e.target === document.body) { e.preventDefault(); openAdd(); }
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'add') return;
  const data = new FormData(form);
  const title = String(data.get('title') || '').trim();
  if (!title) return;
  const fields = { title, notes: String(data.get('notes') || '').trim(), type: data.get('type'), grime: Number(data.get('grime')) };
  if (editingId) { applyEdit(taskById(editingId), fields); return; }
  const t = { id: uid(), ...fields, createdAt: Date.now(), doneAt: null, archived: false };
  tasks.push(t);
  logEvent('added', t);
  const w = makeDish(t);
  dishes.set(t.id, w);
  scene.add(w);
  settleSink({ dropFrom: t.id });
  render();
});

// ---------------------------------------------------------------------------
// Icons (inline SVG so they look the same everywhere)
// ---------------------------------------------------------------------------
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  bubbles: '<circle cx="8.5" cy="14.5" r="4.5"/><circle cx="17" cy="8" r="3"/><circle cx="17.5" cy="17.5" r="2"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  muted: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);

// Save edits to a task. A new size or urgency rebuilds its 3D dish in place.
function applyEdit(t, fields) {
  if (!t) return;
  const changed = Object.keys(fields).filter((k) => fields[k] !== (t[k] ?? ''));
  if (!changed.length) return;
  const undo = offerUndo('Saved changes');
  const from = Object.fromEntries(changed.map((k) => [k, t[k]]));
  Object.assign(t, fields);
  logEvent('edited', t, { changes: Object.fromEntries(changed.map((k) => [k, { from: from[k], to: fields[k] }])) });
  const old = dishes.get(t.id);
  if (old && (changed.includes('type') || changed.includes('grime'))) {
    const held = inspecting === old;
    setHover(null);
    const w = makeDish(t);
    w.position.copy(old.position);
    w.quaternion.copy(old.quaternion);
    tweens.delete(old);
    scene.remove(old);
    dishes.set(t.id, w);
    scene.add(w);
    spawn(w.position.clone().add(new THREE.Vector3(0, 0.4, 0)), { n: 10, speed: 1.2, size: [0.05, 0.1], life: 0.9 });
    sfx.whoosh();
    if (held) { inspecting = null; inspect(w); } else { settleSink(); layoutTub(); }
  } else if (inspecting === old) {
    fillPanel(t);
  }
  render();
  undo();
}

// ---------------------------------------------------------------------------
// Side list + stats
// ---------------------------------------------------------------------------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function render() {
  invalidate();
  const dirty = tasks.filter((t) => !t.doneAt && !t.soak).sort((a, b) => b.grime - a.grime || a.createdAt - b.createdAt);
  const done = tasks.filter((t) => t.doneAt && !t.archived);
  const inTub = soaking();
  const toGo = dirty.length + inTub.length;
  document.title = toGo ? `Sinkful (${toGo})` : 'Sinkful';
  $('sink-count').textContent = dirty.length || '';
  $('soak-count').textContent = `${inTub.length}/${SPOTS.length}`;
  $('rack-count').textContent = done.length || '';
  $('dish-list').innerHTML = dirty.length
    ? dirty.map((t) => `<li data-id="${t.id}"><span class="dot" style="background:#${new THREE.Color(GRIME[t.grime].color).getHexString()}"></span><span class="title" title="${esc(t.title)}">${esc(t.title)}</span><span class="size">${DISHES[t.type].label}</span><button class="check" data-edit="${t.id}" title="Edit">${icon('edit')}</button><button class="check" data-wash="${t.id}" title="Done: wash it">${icon('check')}</button></li>`).join('')
    : `<li class="empty">Sink's clear</li>`;
  $('soak-list').innerHTML = inTub.length
    ? inTub.map((t) => `<li data-id="${t.id}"><span class="dot soak">${icon('bubbles')}</span><span class="title" title="${esc(t.title)}">${esc(t.title)}</span><span class="size">${elapsed(t.soak.since)}</span><button class="check" data-edit="${t.id}" title="Edit">${icon('edit')}</button><button class="check" data-wash="${t.id}" title="Done: wash it">${icon('check')}</button></li>`).join('')
    : '<li class="empty">Long tasks can soak here</li>';
  $('done-list').innerHTML = done.length
    ? done.map((t) => `<li>${esc(t.title)}</li>`).join('')
    : '<li class="empty">Finished dishes dry here</li>';
  $('put-away').classList.toggle('hidden', !done.length);
  $('sink-actions').classList.toggle('hidden', !dirty.length);
  $('soak-actions').classList.toggle('hidden', !inTub.length);
  $('clear-all').disabled = !toGo && !done.length;
  save();
}
const onListClick = (e) => {
  if (washing) return;
  const check = e.target.closest('[data-wash]');
  if (check) { wash(dishes.get(check.dataset.wash)); return; }
  const edit = e.target.closest('[data-edit]');
  if (edit) { openEdit(taskById(edit.dataset.edit)); return; }
  const li = e.target.closest('li[data-id]');
  if (li) inspect(dishes.get(li.dataset.id));
};
$('dish-list').addEventListener('click', onListClick);
$('soak-list').addEventListener('click', onListClick);
setInterval(render, 30000); // keep soak timers fresh

// ---------------------------------------------------------------------------
// Sound: unlock on first gesture, mute toggle
// ---------------------------------------------------------------------------
addEventListener('pointerdown', sfx.unlock, { capture: true });
addEventListener('keydown', sfx.unlock, { capture: true });
const muteBtn = $('mute');
const paintMute = () => { muteBtn.innerHTML = icon(sfx.isMuted() ? 'muted' : 'sound'); muteBtn.title = sfx.isMuted() ? 'Sound off' : 'Sound on'; };
muteBtn.onclick = () => { sfx.setMuted(!sfx.isMuted()); paintMute(); };
paintMute();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let lastFrame = 0, frames = 0;
let timeScale = 1;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05) * timeScale;
  stepTweens(dt);
  stepActives(dt);
  stepParticles(dt);
  stepTub(dt, performance.now() / 1000);
  applyView();
  placeDishActions();
  placePropLabel();
  if (inspecting && !press && !tweens.has(inspecting)) inspecting.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion), dt * 0.25);
  if (heldProp && !press && !heldProp.userData.busy) heldProp.rotateY(dt * 0.35); // turntable about its own up axis
  dof.amount += (dof.target - dof.amount) * Math.min(1, dt * 3);

  const now = performance.now();
  const moving = tweens.size || actives.size || inspecting || heldProp || press || washing || dof.amount > 0.01;
  const ambient = particles.length || soaking().length;
  const interval = moving ? 0 : ambient ? 33 : Infinity;
  if (!needsRender && now - lastFrame < interval) return;
  needsRender = false;
  lastFrame = now;
  frames++;

  if (dof.amount > 0.01) {
    bokeh.uniforms.focus.value = camera.position.distanceTo(dof.point);
    bokeh.uniforms.maxblur.value = 0.011 * dof.amount;
    composer.render();
    dofAllocated = true;
  } else {
    if (dofAllocated && dof.target === 0) releaseBlurBuffers();
    renderer.render(scene, camera);
  }
});

FIT_BOX.union(new THREE.Box3().setFromObject(buildWallCalendar()));
const [, , , sign] = await Promise.all([loadModels(), buildDecor(), loadFromRemote(), buildSign().catch(() => null)]);
if (sign) { // make room for the sign in the home view, then drop the letters in
  sign.updateMatrixWorld(true);
  FIT_BOX.union(new THREE.Box3().setFromObject(sign));
  resize();
  for (const l of signLetters) l.visible = false;
  waveSign({ drop: true });
}
buildAllDishes();
render();
paintSaveStatus();

// Handy for debugging in the console.
window.sinkful = {
  tasks: () => tasks,
  reset: async () => {
    localStorage.removeItem(STORAGE_KEY);
    tasks = seedTasks(); // back to the example tasks (old ones get tombstoned on save)
    if (storage.backend) { await flushSave(); logEvent('reset'); }
    location.reload();
  },
  wash: (type = 'plate') => wash(liveDishes().find((w) => taskById(w.userData.taskId).type === type)),
  speed: (s) => { timeScale = s; },
  memory: () => ({
    jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length,
    sceneObjects: (() => { let n = 0; scene.traverse(() => n++); return n; })(),
    particles: particles.length,
    pixelRatio: renderer.getPixelRatio(),
    blurBuffersAllocated: dofAllocated,
    framesRendered: frames,
  }),
  washAll: (area = 'sink') => washAll(area === 'soak' ? soaking() : inSinkTasks(), area),
  ageSoak: (hours) => { for (const t of soaking()) t.soak.since -= hours * 3600 * 1000; render(); },
  debug: () => ({ swirl: +swirl.material.opacity.toFixed(2), level: +(sinkWater.scale.y).toFixed(2), water: sinkWater.visible, funnel: funnel.visible, particles: particles.length, actives: actives.size }),
  finale: async () => { if (washing) return; washing = 'finale'; document.body.classList.add('washing'); await finale(); washing = null; document.body.classList.remove('washing'); hideToast(); },
  hold: (name) => holdProp(props.find((p) => p.userData.name.toLowerCase().includes(name.toLowerCase()))),
  screenOf: (name) => { const p = props.find((q) => q.userData.name.toLowerCase().includes(name.toLowerCase())); const v = p.position.clone().project(camera); return [Math.round((v.x + 1) / 2 * innerWidth), Math.round((1 - v.y) / 2 * innerHeight)]; },
  screenAt: (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(camera); return [Math.round((v.x + 1) / 2 * innerWidth), Math.round((1 - v.y) / 2 * innerHeight)]; },
  dishAt: (title) => { const t = tasks.find((x) => x.title === title); const w = dishes.get(t.id); return window.sinkful.screenAt(w.position.x, w.position.y + 0.2, w.position.z); },
  soak: (type) => soak(liveDishes().find((w) => taskById(w.userData.taskId).type === type)),
};
// #wash or #wash-pot starts a wash on load (used for screenshots).
const m = location.hash.match(/^#wash-?(\w+)?/);
if (m) window.sinkful.wash(m[1] || 'plate');
