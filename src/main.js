import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { parseByml, writeByml, Typed, T } from './byml.js';
import { zsDecompress, zsStore, sha256hex, parseRstb, writeRstb, rstbGet, rstbSet, toText, fromText } from './formats.js';
import { loadBfres } from './bfres.js';
import { objInfo } from './objinfo.js';
import { parseSarc } from './sarc.js';
import { replaceBntxAstc, bntxInfo, bntxToRGBA, untile } from './astc.js';
import { SURFACES, ROADTEX, ALL_TEX, texByName, DEFAULT_SIZE, VS_STAGES } from './roadtex.js';
import { removeBakedCollision } from './bphsc.js';
const EDITOR_VER = 'v1.15';
import { buildNewSlot, courseDocBytes, START as SLOT_START, SLOT as NEWSLOT, gameVersion, verLabel, barsHas } from './newslot.js';
import { parseSarc as parseSarcM } from './sarc.js';
import { generate, toWorld, applySections, DEFAULTS as TC_DEFAULTS, DEFAULT_POINTS, LOCK_AFTER, LOCK_BEFORE, SURF } from './trackgen.js';
import { modelCapacity } from './bfmodel.js';
import { parseModel, makeXform, measureTilt, boundsOf, previewMesh, packParts, startGridObj, guessSlot, guessSurface, SLOTS, SLOT_COLOR, GRID_X, isImage, imageFileToCanvas, canvasRGBA, thumb } from './modelimport.js';
import { BRUSHES } from './surfaces.js';
import { PIECES, pieceGeometry, glowPicture, boostTris, boostClamp, addBoosts, glidePaths, glideStraight, GLIDES, GLIDE_LEN } from './boost.js';
import { readMeshShape } from './phive.js';
import { PRESETS, presetById, loadPreset, brushFor } from './presets.js';
import { setupTerrainEditor } from './terrainpaint.js';
import { TILE, TILES, WORLD_MIN, tileName, tileCentre, tileAt, terrainTris, rasterTile, tileMesh, trisPerTile, heightIn } from './terrain.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else e.setAttribute(k, v); } for (const k of kids) e.append(k); return e; };
// messages and the busy note go in the open dialog when there is one (a modal dialog hides everything behind it)
const onTop = () => { const d = [...document.querySelectorAll('dialog[open]')].pop() || document.body, t = $('#toasts'), b = $('#busy'); if (t.parentNode !== d) d.append(t, b); };
const toast = (msg, kind = '', ms) => { onTop(); const t = el('div', { class: 'toast ' + kind }, msg); $('#toasts').append(t); setTimeout(() => t.remove(), ms || (kind === 'err' ? 9000 : 4500)); };
const busy = (msg) => { onTop(); $('#busy').textContent = msg || ''; $('#busy').style.display = msg ? 'block' : 'none'; };
const hashKey = v => v instanceof Typed ? String(v.v) : String(v);
const rand64 = () => { const a = new Uint32Array(2); crypto.getRandomValues(a); return BigInt.asUintN(64, (BigInt(a[0]) << 32n) | BigInt(a[1])); };
const rand32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const DEG = 180 / Math.PI;
const fmt = n => (Math.round(n * 1000) / 1000).toString();
// save with a "Save as" window that remembers the last folder (per kind of file); plain download where that isn't available
// ask where to save first: the browser only shows the "Save as" window straight after a click, so for anything that
// takes a while to make (a track build) the window comes first and the file is written when it's ready
async function pickSave(name, kind) {
  if (!window.showSaveFilePicker) return { name };
  try { return { name, h: await showSaveFilePicker({ id: 'mkwe-' + kind, suggestedName: name, types: [{ description: name.endsWith('.mkwtrack.zip') ? 'Track Creator project' : 'Zip file', accept: { 'application/zip': ['.zip'] } }] }) }; }
  catch (e) { if (e.name === 'AbortError') return null; console.error(e); return { name }; }
}
async function writeSave(target, data) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  if (target.h) { const w = await target.h.createWritable(); await w.write(blob); await w.close(); return target.h.name; }
  download(blob, target.name); return target.name;
}
async function saveFile(data, name, kind) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  if (window.showSaveFilePicker) {
    let h;
    try { h = await showSaveFilePicker({ id: 'mkwe-' + kind, suggestedName: name, types: [{ description: name.endsWith('.mkwtrack.zip') ? 'Track Creator project' : 'Zip file', accept: { 'application/zip': ['.zip'] } }] }); }
    catch (e) { if (e.name === 'AbortError') return null; console.error(e); download(blob, name); return name; }
    const w = await h.createWritable(); await w.write(blob); await w.close(); return h.name;
  }
  download(blob, name); return name;
}
const download = (bytes, name) => { const a = el('a', { href: URL.createObjectURL(new Blob([bytes])), download: name }); document.body.append(a); a.click(); a.remove(); };

// ---------------------------------------------------------------- handles (remembered between visits)
const idb = (() => {
  let db; const open = () => db ? Promise.resolve(db) : new Promise((res, rej) => { const r = indexedDB.open('mkworld-editor', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => res(db = r.result); r.onerror = () => rej(r.error); });
  return {
    get: async k => { try { const d = await open(); return await new Promise(r => { const q = d.transaction('h').objectStore('h').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); } catch { return null; } },
    set: async (k, v) => { try { const d = await open(); d.transaction('h', 'readwrite').objectStore('h').put(v, k); } catch {} },
  };
})();
async function permit(h, mode = 'read') { if (!h) return false; const o = { mode }; if (await h.queryPermission(o) === 'granted') return true; return await h.requestPermission(o) === 'granted'; }
async function fileAt(dir, path, create = false) {
  const parts = path.split('/'); let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create });
  return d.getFileHandle(parts[parts.length - 1], { create });
}
async function readAt(dir, path) {
  const one = async d => { try { const f = await (await fileAt(d, path)).getFile(); return new Uint8Array(await f.arrayBuffer()); } catch { return null; } };
  const r = await one(dir);
  // an update's romfs only has the files that changed: anything else comes from the base game's romfs, when it's open
  if (r || !S.baseRomfs || dir !== S.romfs) return r;
  return one(S.baseRomfs);
}
async function writeAt(dir, path, bytes) { const h = await fileAt(dir, path, true); const w = await h.createWritable(); await w.write(bytes); await w.close(); }
async function walk(dir, prefix = '', out = []) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') await walk(h, prefix + name + '/', out); else out.push([prefix + name, h]);
  }
  return out;
}

// ---------------------------------------------------------------- state
const S = {
  romfs: null, modsDir: null,
  path: null,            // romfs-relative path of the open course, e.g. Banc/Race_X.bcett.byml.zs
  doc: null,             // parsed BYML root
  dirty: false,
  edited: new Map(),     // path -> uncompressed BYML bytes for every course changed this session
  sel: new Set(),        // selected item ids
  items: new Map(),      // id -> {kind, data, rail, mesh}
  undo: [], redo: [],
  catalog: null,         // Name -> {gyaml, count, tpl}
  origSize: new Map(), rstbFile: null,
  extra: new Map(),      // other mod files (minimap textures, minimap settings): romfs path -> .zs bytes
  collectBase: null,
};

// ---------------------------------------------------------------- three.js scene
const view = $('#view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1f27);
scene.fog = new THREE.Fog(0x1b1f27, 2000, 9000);
const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 40000);
camera.position.set(0, 300, 300);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true; orbit.dampingFactor = 0.15; orbit.screenSpacePanning = true;
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3328, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 2, 0.6); scene.add(sun);
let grid = new THREE.GridHelper(2000, 100, 0x3c4658, 0x2a313d); scene.add(grid);

const world = new THREE.Group(); scene.add(world);
const railGroup = new THREE.Group(); world.add(railGroup);
const linkGroup = new THREE.Group(); world.add(linkGroup);
const pivot = new THREE.Object3D(); scene.add(pivot);
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.9);
scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);
gizmo.addEventListener('dragging-changed', e => {
  orbit.enabled = !e.value;
  if (gizmo.object?.userData.preset) { if (!e.value) tcPresetDragEnd(); return; }
  if (e.value) beginDrag(); else endDrag();
});
gizmo.addEventListener('objectChange', () => { if (gizmo.object?.userData.preset) tcPresetDragMove(); else dragUpdate(); });

function resize() { const r = view.getBoundingClientRect(); renderer.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(view);
const held = new Set(); let lastT = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (held.size) flyStep(dt);
  orbit.update(); trFrame(); renderer.render(scene, camera);
});
// WASD moves the camera and its orbit point together: W/S forward/back, A/D sideways, Q/E down/up, Shift faster
function flyStep(dt) {
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x), mv = new THREE.Vector3();
  if (held.has('w')) mv.add(fwd); if (held.has('s')) mv.sub(fwd);
  if (held.has('d')) mv.add(right); if (held.has('a')) mv.sub(right);
  if (held.has('e')) mv.y += 1; if (held.has('q')) mv.y -= 1;
  if (!mv.lengthSq()) return;
  const dist = camera.position.distanceTo(orbit.target);
  const speed = Math.max(25, dist * 0.9) * (held.has('shift') ? 3.5 : 1);
  mv.normalize().multiplyScalar(speed * dt);
  camera.position.add(mv); orbit.target.add(mv);
}
const FLY = new Set(['w', 'a', 's', 'd', 'q', 'e']);
window.addEventListener('keyup', e => { held.delete(e.key.toLowerCase()); if (e.key === 'Shift') held.delete('shift'); });
window.addEventListener('blur', () => held.clear());

// ---------------------------------------------------------------- look of objects
const GEO = {
  box: new THREE.BoxGeometry(2, 2, 2), cone: new THREE.ConeGeometry(1.2, 2.6, 16).rotateX(Math.PI / 2),
  sphere: new THREE.SphereGeometry(1.2, 16, 12), coin: new THREE.CylinderGeometry(1, 1, 0.3, 20).rotateX(Math.PI / 2),
  point: new THREE.SphereGeometry(1.1, 10, 8), area: new THREE.BoxGeometry(2, 2, 2),
};
const STYLE = [
  [/^StartPosition/, 'cone', 0x3ddc84, 'Start position'],
  [/ItemBox/, 'box', 0xf5c542, 'Item box'],
  [/Coin\d/, 'coin', 0xffd700, 'Coin'],
  [/Audience|Citizen|Relay/, 'sphere', 0x8a94a6, 'Crowd'],
  [/^CmnObj_Mob/, 'box', 0x4aa3ff, 'Traffic / moving'],
  [/^SystemObj_/, 'area', 0xb07cff, 'System / area'],
  [/^EffectObj_/, 'sphere', 0x34d6d6, 'Effect'],
  [/Arrow|Sign|Fence|Barrier|Barricade/, 'box', 0xff8a4a, 'Barrier / sign'],
  [/./, 'box', 0xe8695e, 'Other object'],
];
const styleOf = name => STYLE.find(s => s[0].test(name || ''));
const MATS = new Map();
function matFor(color, area) {
  const k = color + (area ? 'a' : '');
  if (!MATS.has(k)) MATS.set(k, area ? new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.55 }) : new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 }));
  return MATS.get(k);
}
const SEL_MAT = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x2266ff, emissiveIntensity: 0.9 });
const SEL_AREA = new THREE.MeshBasicMaterial({ color: 0x66aaff, wireframe: true });

const vec = a => new THREE.Vector3(a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0);
function applyTransform(mesh, d, posKey) {
  mesh.position.copy(vec(d[posKey]));
  const r = d.Rotate || [0, 0, 0];
  mesh.rotation.set(r[0], r[1], r[2], 'ZYX');
  const s = d.Scale; mesh.scale.set(s?.[0] ?? 1, s?.[1] ?? 1, s?.[2] ?? 1);
}

// ---------------------------------------------------------------- building the scene from the document
let nextId = 1;
function buildScene(keepSel) {
  const selHashes = keepSel ? [...S.sel].map(id => S.items.get(id)).filter(Boolean).map(it => hashKey(it.data.Hash)) : [];
  for (const it of S.items.values()) if (it.mesh) world.remove(it.mesh);
  KITMESH.length = 0;
  S.items.clear(); S.sel.clear(); gizmo.detach();
  railGroup.clear(); linkGroup.clear();
  if (!S.doc) return;
  const hide = { actors: !$('#showActors').checked, rails: !$('#showRails').checked };
  for (const a of S.doc.Actors || []) {
    const st = styleOf(a.Name); let shape = st[1];
    const pt = a.PrimitiveType; if (pt === 'Cone') shape = 'cone'; else if (pt === 'Sphere') shape = 'sphere';
    const mesh = new THREE.Mesh(GEO[shape], matFor(st[2], shape === 'area'));
    const id = nextId++; mesh.userData.id = id; applyTransform(mesh, a, 'Translate');
    mesh.visible = !hide.actors && !hiddenCats.has(st[3]);
    world.add(mesh); S.items.set(id, { kind: 'actor', data: a, mesh, style: st, shape });
    if (wantModel(a.Name)) attachModel(id);
  }
  (S.doc.Rails || []).forEach((rail, ri) => {
    for (const p of rail.Points || []) {
      const mesh = new THREE.Mesh(GEO.point, matFor(railColor(rail.Name)));
      const id = nextId++; mesh.userData.id = id; mesh.position.copy(vec(p.Translation)); if (p.Rotate) { const r = p.Rotate.map(v => +(v?.v ?? v)); mesh.rotation.set(r[0], r[1], r[2], 'ZYX'); } mesh.visible = !hide.rails;
      world.add(mesh); S.items.set(id, { kind: 'point', data: p, rail, ri, mesh });
    }
  });
  drawRails(); drawLinks();
  if (selHashes.length) { const want = new Set(selHashes); for (const [id, it] of S.items) if (want.has(hashKey(it.data.Hash))) S.sel.add(id); }
  refreshSelection(); fillOutliner(); updateStats();
}
const railColor = n => /Lap/.test(n) ? 0x3ddc84 : /Route/.test(n) ? 0x4aa3ff : /Slide/.test(n) ? 0xff8a4a : 0xd0d0d0;

function drawRails() {
  railGroup.clear();
  if (!$('#showRails').checked || !S.doc) return;
  for (const rail of S.doc.Rails || []) {
    const pts = (rail.Points || []).map(p => vec(p.Translation));
    if (pts.length < 2) continue;
    if (rail.IsClosed) pts.push(pts[0].clone());
    const col = railColor(rail.Name);
    railGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col })));
    // road outline from each point's RectSize (width) across the direction of travel
    if ($('#showWidth').checked) {
      const L = [], R = [];
      const P = rail.Points;
      P.forEach((p, i) => {
        if (!p.RectSize) return;
        // the box faces the point's own turn (Rotate) when it has one, else the way the path goes
        let dir;
        if (p.Rotate) { const r = p.Rotate.map(v => +(v?.v ?? v)); dir = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(r[0], r[1], r[2], 'ZYX')); }
        else { const a = vec(P[Math.max(0, i - 1)].Translation), b = vec(P[Math.min(P.length - 1, i + 1)].Translation); dir = b.sub(a); }
        dir.y = 0; if (dir.lengthSq() < 1e-6) return; dir.normalize();
        const side = new THREE.Vector3(-dir.z, 0, dir.x);
        const c = vec(p.Translation).addScaledVector(side, -(p.RectOffset?.[0] ?? 0));
        const w = p.RectSize[0] / 2;
        L.push(c.clone().addScaledVector(side, -w)); R.push(c.clone().addScaledVector(side, w));
      });
      const m = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.35 });
      if (L.length > 1) { railGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(L), m)); railGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(R), m)); }
    }
  }
  // the selected points' range: a box across the path, width x height, shifted by RectOffset (sideways, up)
  const box = [];
  for (const id of S.sel) {
    const it = S.items.get(id); if (!it || it.kind !== 'point' || !it.data.RectSize) continue;
    const P = it.rail.Points, i = P.indexOf(it.data), p = it.data;
    const a = vec(P[Math.max(0, i - 1)].Translation), b = vec(P[Math.min(P.length - 1, i + 1)].Translation), dir = b.sub(a); dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(Math.sin(p.Rotate?.[1] || 0), 0, Math.cos(p.Rotate?.[1] || 0)); dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x), w = p.RectSize[0] / 2, h = p.RectSize[1] ?? 10;
    const c = vec(p.Translation).addScaledVector(side, -(p.RectOffset?.[0] ?? 0)); c.y += (p.RectOffset?.[1] ?? h / 2);
    const q = (sx, sy) => c.clone().addScaledVector(side, sx * w).add(new THREE.Vector3(0, sy * h / 2, 0));
    const c4 = [q(-1, -1), q(1, -1), q(1, 1), q(-1, 1)]; for (let k = 0; k < 4; k++) box.push(c4[k], c4[(k + 1) % 4]);
  }
  if (box.length) { const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(box), new THREE.LineBasicMaterial({ color: 0xffe14a, depthTest: false })); l.renderOrder = 10; railGroup.add(l); }
}
// what a path's points are for, and what their range does
const PATHINFO = {
  LapPathGraph: { title: 'Lap path point', def: [25, 20, 0, 10], what: 'The lap path tracks each kart\'s progress round the course (laps, checkpoints, race positions).', range: 'Karts inside this box count as on the lap path here. Make it cover the whole road. Too narrow and karts on the edge may not register progress. The game\'s courses use about 20–32 m wide and 20 m tall.', offset: 'Side shift moves the box sideways off the line (0 = centred). Up shift is the height of the box\'s centre above the point: 10 with a 20 m tall box covers the ground up to 20 m.' },
  RoutePathGraph: { title: 'CPU / item route point', def: [10, 10, 0, 5], what: 'CPU racers drive along these routes, and items that chase (like red shells) follow them. Route points also hold item settings (ItemType, ItemGroup…).', range: 'The width CPUs are allowed to spread across around this point, and the height of that zone. The game uses about 8–11 m wide and 10 m tall: narrower keeps CPUs tight to the line, wider lets them spread out.', offset: 'Side shift moves the zone sideways off the line: the game often shifts it a few metres (e.g. -3) to keep CPUs towards one side of the road. Up shift is the height of the zone\'s centre (5 with a 10 m tall zone).' },
  GuideGraphRail: { title: 'Guide path point', def: [5, 1, 0, 0], what: 'A path that moving objects (such as Rainbow Road\'s eagles) follow.', range: 'The game uses small sizes here (0.1–10 m).', offset: '' },
};
function drawLinks() {
  linkGroup.clear();
  if (!$('#showLinks').checked || !S.doc) return;
  const pos = new Map();
  for (const it of S.items.values()) pos.set(hashKey(it.data.Hash), it.mesh.position);
  const segs = [];
  for (const it of S.items.values()) for (const l of it.data.Links || []) {
    const a = pos.get(hashKey(l.Src ?? it.data.Hash)), b = pos.get(hashKey(l.Dst));
    if (a && b) segs.push(a.clone(), b.clone());
  }
  if (segs.length) linkGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), new THREE.LineBasicMaterial({ color: 0xff5fa2, transparent: true, opacity: 0.7 })));
}

function frame(target) {
  let box = new THREE.Box3();
  const items = target ? target : [...S.items.values()].filter(it => it.kind === 'actor');
  if (!items.length && S.doc?.AABB) { box.set(vec(S.doc.AABB.Min), vec(S.doc.AABB.Max)); }
  else items.forEach(it => box.expandByPoint(it.mesh.position));
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), size = Math.max(20, box.getSize(new THREE.Vector3()).length());
  orbit.target.copy(c);
  const dir = camera.position.clone().sub(orbit.target).normalize(); if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(0.4, 0.8, 0.45).normalize();
  camera.position.copy(c).addScaledVector(dir.set(dir.x, Math.max(dir.y, 0.35), dir.z).normalize(), size * 0.9);
  camera.near = Math.max(0.1, size / 2000); camera.far = size * 60 + 5000; camera.updateProjectionMatrix();
  scene.fog.near = size * 3; scene.fog.far = size * 20;
  if (!target) { scene.remove(grid); const g = Math.ceil(size * 3 / 100) * 100; grid = new THREE.GridHelper(g, Math.min(200, g / 10), 0x3c4658, 0x2a313d); grid.position.set(c.x, box.min.y - 0.5, c.z); scene.add(grid); }
}

// ---------------------------------------------------------------- selection & picking
const ray = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || gizmo.dragging) return;
  if (QC.drawing) { if (e.button === 0) qcAddPoint(e); else if (e.button === 2) qcUndoPoint(); return; }
  if ($('#qcpanel').open && !QC.mode && e.button === 0 && QC.guide.length) {
    const r0 = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((e.clientX - r0.left) / r0.width * 2 - 1, -(e.clientY - r0.top) / r0.height * 2 + 1), camera);
    const hit = ray.intersectObjects(QC.drawGroup.children.filter(o => o.userData.guide !== undefined), false)[0];
    if (hit) { const i = hit.object.userData.guide; if (e.ctrlKey || e.metaKey) QC.sel.has(i) ? QC.sel.delete(i) : QC.sel.add(i); else QC.sel = new Set([i]); qcPointUI(); drawGuide(); return; }
  }
  if (TC.active) { if (e.button === 0) tcClick(e); return; }
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  const meshes = [...S.items.values()].filter(it => it.mesh.visible).map(it => it.mesh);
  const hits = ray.intersectObjects(meshes, false), hit = hits[0];
  if (!hit) { if (!e.shiftKey) { S.sel.clear(); refreshSelection(); } return; }
  // things in the same spot (a lap path point and a CPU route point made together): clicking again picks the next one
  const here = [...new Set(hits.filter(h => h.distance < hit.distance + 1.5).map(h => h.object.userData.id))];
  let id = here[0];
  if (here.length > 1 && !(e.shiftKey || e.ctrlKey)) {
    const cur = S.sel.size === 1 ? [...S.sel][0] : null, i = here.indexOf(cur);
    if (i >= 0) id = here[(i + 1) % here.length];
    const it = S.items.get(id), what = it?.kind === 'point' ? (PATHINFO[it.rail.Name]?.title || it.rail.Name) : (it?.data?.Name || 'object');
    toast(`${here.length} things here: selected the ${what}. Click again for the next one.`);
  }
  select(id, e.shiftKey || e.ctrlKey);
});
function select(id, add) {
  if (!add) S.sel.clear();
  if (add && S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
  refreshSelection();
  const row = document.querySelector(`[data-id="${id}"]`); if (row) row.scrollIntoView({ block: 'nearest' });
}
function refreshSelection() {
  for (const [id, it] of S.items) {
    const area = it.shape === 'area';
    if (it.model) { it.mesh.material = S.sel.has(id) ? SEL_AREA : INVIS; continue; }
    it.mesh.material = S.sel.has(id) ? (area ? SEL_AREA : SEL_MAT) : (it.kind === 'point' ? matFor(railColor(it.rail.Name)) : matFor(it.style[2], area));
  }
  document.querySelectorAll('#outliner .row.sel').forEach(r => r.classList.remove('sel'));
  for (const id of S.sel) document.querySelector(`[data-id="${id}"]`)?.classList.add('sel');
  const sel = [...S.sel].map(id => S.items.get(id)).filter(Boolean);
  if (sel.length) {
    const c = new THREE.Vector3(); sel.forEach(it => c.add(it.mesh.position)); c.divideScalar(sel.length);
    pivot.position.copy(c); pivot.rotation.set(0, 0, 0); pivot.scale.set(1, 1, 1);
    if (sel.length === 1 && sel[0].kind === 'actor') { pivot.rotation.copy(sel[0].mesh.rotation); pivot.scale.copy(sel[0].mesh.scale); }
    else if (sel.length === 1 && sel[0].kind === 'point') pivot.rotation.copy(sel[0].mesh.rotation);
    gizmo.attach(pivot);
  } else gizmo.detach();
  fillInspector();
}

// ---------------------------------------------------------------- gizmo dragging
let dragStart = null;
function beginDrag() {
  pushUndo();
  dragStart = { pos: pivot.position.clone(), rot: pivot.rotation.clone(), scl: pivot.scale.clone(),
    items: [...S.sel].map(id => S.items.get(id)).map(it => ({ it, pos: it.mesh.position.clone(), rot: it.mesh.rotation.clone(), scl: it.mesh.scale.clone(), hover: hoverOf(it.mesh.position, it), lastY: it.mesh.position.y })) };
}
function dragUpdate() {
  if (!dragStart) return;
  const single = dragStart.items.length === 1;
  const dpos = pivot.position.clone().sub(dragStart.pos);
  const qd = new THREE.Quaternion().setFromEuler(pivot.rotation).multiply(new THREE.Quaternion().setFromEuler(dragStart.rot).invert());
  for (const s of dragStart.items) {
    const { it } = s;
    if (gizmo.mode === 'translate') {
      it.mesh.position.copy(s.pos).add(dpos);
      if (snapOn()) { const g = groundAt(it.mesh.position.x, it.mesh.position.z, s.lastY - s.hover, ownMeshes(it)); if (g !== null) it.mesh.position.y = g + s.hover; s.lastY = it.mesh.position.y; }
    }
    if (gizmo.mode === 'rotate' && (it.kind === 'actor' || it.kind === 'point')) {
      if (single) it.mesh.rotation.copy(new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromEuler(pivot.rotation), 'ZYX'));
      else { const q = qd.clone().multiply(new THREE.Quaternion().setFromEuler(s.rot)); it.mesh.rotation.setFromQuaternion(q, 'ZYX'); it.mesh.position.copy(s.pos).sub(dragStart.pos).applyQuaternion(qd).add(dragStart.pos); }
    }
    if (gizmo.mode === 'scale' && it.kind === 'actor') {
      const k = pivot.scale.clone().divide(dragStart.scl);
      it.mesh.scale.copy(s.scl).multiply(k);
    }
    writeBack(it);
  }
  drawRailsSoon(); fillInspectorValues();
}
let railTimer = 0; const drawRailsSoon = () => { if (!railTimer) railTimer = requestAnimationFrame(() => { railTimer = 0; drawRails(); drawLinks(); }); };
function endDrag() { dragStart = null; markDirty(); refreshSelection(); }
const f32 = x => Math.fround(x);
function writeBack(it) {
  const m = it.mesh, d = it.data;
  if (it.kind === 'point') {
    d.Translation = [f32(m.position.x), f32(m.position.y), f32(m.position.z)];
    // lap and route points keep a turn too: it sets which way their box faces
    const e = new THREE.Euler().setFromQuaternion(m.quaternion, 'ZYX');
    if (d.Rotate || Math.abs(e.x) + Math.abs(e.y) + Math.abs(e.z) > 1e-7) d.Rotate = [f32(e.x), f32(e.y), f32(e.z)];
    return;
  }
  d.Translate = [f32(m.position.x), f32(m.position.y), f32(m.position.z)];
  const e = new THREE.Euler().setFromQuaternion(m.quaternion, 'ZYX');
  if (d.Rotate || Math.abs(e.x) + Math.abs(e.y) + Math.abs(e.z) > 1e-7) d.Rotate = [f32(e.x), f32(e.y), f32(e.z)];
  if (d.Scale || Math.abs(m.scale.x - 1) + Math.abs(m.scale.y - 1) + Math.abs(m.scale.z - 1) > 1e-6) d.Scale = [f32(m.scale.x), f32(m.scale.y), f32(m.scale.z)];
}

// ---------------------------------------------------------------- undo
const snapshot = () => writeByml(S.doc, 7, false);
function pushUndo() { if (!S.doc) return; S.undo.push(snapshot()); if (S.undo.length > 60) S.undo.shift(); S.redo.length = 0; }
function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); S.doc = parseByml(S.undo.pop()).root; buildScene(true); markDirty(); }
function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); S.doc = parseByml(S.redo.pop()).root; buildScene(true); markDirty(); }
function markDirty() { S.dirty = true; S.edited.set(S.path, null); updateStats(); if (S.customTrack) { clearTimeout(TC.flushT); TC.flushT = setTimeout(tcFlushDoc, 600); } }

// ---------------------------------------------------------------- outliner
const hiddenCats = new Set();
function fillOutliner() {
  const box = $('#outliner'); box.innerHTML = '';
  if (!S.doc) return;
  const q = $('#filter').value.trim().toLowerCase();
  const groups = new Map();
  for (const [id, it] of S.items) {
    if (it.kind !== 'actor') continue;
    const n = it.data.Name || '(no name)';
    if (q && !n.toLowerCase().includes(q) && !(it.data.Gyaml || '').toLowerCase().includes(q)) continue;
    if (!groups.has(n)) groups.set(n, []); groups.get(n).push(id);
  }
  const head = (txt, ids, open, color) => {
    const det = el('details'); if (open) det.open = true;
    const sum = el('summary', {}, el('span', { class: 'dot', style: `background:#${color.toString(16).padStart(6, '0')}` }), txt, el('span', { class: 'cnt' }, String(ids.length)));
    sum.addEventListener('dblclick', e => { e.preventDefault(); S.sel = new Set(ids); refreshSelection(); frame(ids.map(i => S.items.get(i))); });
    det.append(sum);
    det.addEventListener('toggle', () => { if (det.open && det.children.length === 1) ids.forEach((id, i) => det.append(row(id, i))); }, { once: false });
    if (open) ids.forEach((id, i) => det.append(row(id, i)));
    return det;
  };
  const row = (id, i) => {
    const it = S.items.get(id);
    const label = it.kind === 'point' ? `point ${i}` : `#${i}  ${it.data.Dynamic ? Object.entries(it.data.Dynamic).slice(0, 1).map(([k, v]) => k + '=' + (v instanceof Typed ? v.v : typeof v === 'number' ? fmt(v) : v)).join('') : ''}`;
    const r = el('div', { class: 'row' + (S.sel.has(id) ? ' sel' : ''), 'data-id': id, onclick: e => select(id, e.shiftKey || e.ctrlKey), ondblclick: () => frame([it]) }, label);
    return r;
  };
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  box.append(el('div', { class: 'sec' }, `Objects (${[...S.items.values()].filter(i => i.kind === 'actor').length})`));
  for (const [n, ids] of sorted) box.append(head(n, ids, q && sorted.length < 6, styleOf(n)[2]));
  box.append(el('div', { class: 'sec' }, `Paths (${(S.doc.Rails || []).length})`));
  (S.doc.Rails || []).forEach((rail, ri) => {
    if (q && !rail.Name.toLowerCase().includes(q)) return;
    const ids = [...S.items].filter(([, it]) => it.kind === 'point' && it.rail === rail).map(([id]) => id);
    box.append(head(`${rail.Name} ${ri}`, ids, false, railColor(rail.Name)));
  });
}

// ---------------------------------------------------------------- inspector
function fillInspector() {
  const box = $('#inspector'); box.innerHTML = '';
  if (S.doc) drawRails();   // keeps the selected points' range box current
  const sel = [...S.sel].map(id => S.items.get(id)).filter(Boolean);
  if (!S.doc) { box.append(el('p', { class: 'hint' }, 'Open your game RomFS folder, then pick a course.')); return; }
  if (!sel.length) {
    box.append(el('h3', {}, 'Course'), el('div', { class: 'kv' }, el('b', {}, 'File'), S.path || ''),
      el('div', { class: 'kv' }, el('b', {}, 'Objects'), String((S.doc.Actors || []).length)),
      el('div', { class: 'kv' }, el('b', {}, 'Paths'), String((S.doc.Rails || []).length)),
      el('p', { class: 'hint' }, 'Click an object (Shift-click for more). Double-click a group in the list to select all of that type.'),
      el('button', { onclick: () => editRaw(null) }, 'Edit whole course as text…'));
    return;
  }
  const it = sel[0];
  if (sel.length > 1) box.append(el('h3', {}, `${sel.length} selected`));
  else {
    const info = it.kind === 'actor' ? objInfo(it.data.Name) : null;
    if (it.kind === 'actor') {
      const q = el('button', { class: 'qhelp' + (S.helpOpen ? ' on' : ''), title: 'What this object does, and hints for its settings' }, '?');
      q.onclick = () => { S.helpOpen = !S.helpOpen; try { localStorage.setItem('mkwe-help', S.helpOpen ? '1' : ''); } catch {} fillInspector(); };
      box.append(el('div', { class: 'ohead' }, el('h3', {}, info ? info.title : it.data.Name || 'Object'), q));
      if (info) box.append(el('div', { class: 'kv small' }, el('b', {}, 'Object'), el('span', { class: 'mono' }, it.data.Name)));
      box.append(el('div', { class: 'kv small' }, el('b', {}, 'Type'), it.style[3]));
      if (S.helpOpen) {
        const h = el('div', { class: 'ohelp' });
        if (info) {
          h.append(el('p', {}, info.what));
          if (info.scale) h.append(el('p', {}, el('b', {}, 'Scale: '), info.scale));
          if (info.links) h.append(el('p', {}, el('b', {}, 'Links: '), info.links));
          for (const st of info.settings || []) h.append(el('p', {}, el('b', {}, st.key + ': '), st.hint));
          if (info.tips?.length) { const ul = el('ul'); for (const t of info.tips) ul.append(el('li', {}, t)); h.append(el('b', {}, 'Tips'), ul); }
          h.append(el('p', { class: 'hint' }, 'From the game\'s own label for this object and how its courses use it. "Probably" marks a best guess.'));
        } else h.append(el('p', {}, 'No notes for this object yet. Its settings (if any) are listed below; copying one from a game course (Duplicate) keeps them right.'));
        box.append(h);
      }
    } else box.append(el('h3', {}, `${it.rail.Name} point`));
  }
  const vecRow = (label, key, factor, get, set) => {
    const r = el('div', { class: 'vec' }, el('label', {}, label));
    ['X', 'Y', 'Z'].forEach((ax, i) => {
      const inp = el('input', { type: 'number', step: factor === DEG ? '5' : key === 'scale' ? '0.1' : '1', 'data-k': key + i });
      inp.value = fmt(get()[i] * factor);
      inp.addEventListener('change', () => { pushUndo(); const v = get().slice(); v[i] = parseFloat(inp.value) / factor; set(v); markDirty(); });
      r.append(el('span', { class: 'ax ax' + ax }, ax), inp);
    });
    box.append(r);
  };
  if (sel.length === 1) {
    const posKey = it.kind === 'point' ? 'Translation' : 'Translate';
    const sync = () => { applyTransform(it.mesh, it.data, posKey); drawRails(); drawLinks(); refreshSelectionLight(); };
    vecRow('Position', 'pos', 1, () => it.data[posKey] || [0, 0, 0], v => { it.data[posKey] = v.map(f32); sync(); });
    if (it.kind === 'point') vecRow('Rotation°', 'rot', DEG, () => it.data.Rotate || [0, 0, 0], v => { it.data.Rotate = v.map(f32); sync(); });
    if (it.kind === 'actor') {
      vecRow('Rotation°', 'rot', DEG, () => it.data.Rotate || [0, 0, 0], v => { it.data.Rotate = v.map(f32); sync(); });
      vecRow('Scale', 'scale', 1, () => it.data.Scale || [1, 1, 1], v => { it.data.Scale = v.map(f32); sync(); });
    }
    const info2 = it.kind === 'actor' ? objInfo(it.data.Name) : null, known = info2?.settings || [];
    const others = Object.keys(it.data.Dynamic || {}).filter(k => !known.some(st => st.key === k));
    if (known.length || others.length) {
      box.append(el('h4', {}, 'Settings'));
      const setVal = (k, v) => { pushUndo(); it.data.Dynamic = it.data.Dynamic || {}; if (v === undefined) { delete it.data.Dynamic[k]; if (!Object.keys(it.data.Dynamic).length) delete it.data.Dynamic; } else it.data.Dynamic[k] = v; markDirty(); fillOutliner(); };
      // the object's known settings: shown even when not set yet (then the game's default applies)
      for (const st of known) {
        const cur = it.data.Dynamic?.[st.key], has = cur !== undefined;
        const raw = cur instanceof Typed ? Number(cur.v) : cur;
        let inp;
        if (st.type === 'bool') { inp = el('input', { type: 'checkbox' }); inp.checked = has ? !!raw : !!st.def; inp.onchange = () => setVal(st.key, inp.checked); }
        else { inp = el('input', { type: 'number', step: st.type === 'int' ? '1' : 'any', placeholder: String(st.def) }); if (has) inp.value = st.type === 'int' ? String(raw) : fmt(raw);
          inp.onchange = () => { if (inp.value === '') return setVal(st.key, undefined); const n = +inp.value; setVal(st.key, st.type === 'int' ? T.i32(Math.round(n)) : f32(n)); }; }
        const row = el('div', { class: 'kv' + (has ? '' : ' unset'), title: st.hint + (has ? '' : `\n\nNot set on this object: the game uses its default (${st.def}).`) }, el('b', {}, st.key + (st.unit ? ` (${st.unit})` : '')), inp);
        box.append(row);
      }
      // anything else this object has
      for (const k of others) {
        const v = it.data.Dynamic[k], isBool = typeof v === 'boolean', isStr = typeof v === 'string';
        const inp = el('input', isBool ? { type: 'checkbox' } : { type: isStr ? 'text' : 'number', step: 'any' });
        if (isBool) inp.checked = v; else inp.value = v instanceof Typed ? String(v.v) : isStr ? v : fmt(v);
        inp.addEventListener('change', () => {
          const nv = isBool ? inp.checked : isStr ? inp.value : v instanceof Typed ? (v.t === 'u64' ? T.u64(inp.value) : v.t === 'i64' ? T.i64(inp.value) : new Typed(v.t, v.t === 'f64' ? +inp.value : (v.t === 'u32' ? (+inp.value >>> 0) : (+inp.value | 0)))) : f32(+inp.value);
          setVal(k, nv);
        });
        box.append(el('div', { class: 'kv' }, el('b', {}, k), inp));
      }
      if (known.some(st => it.data.Dynamic?.[st.key] === undefined)) box.append(el('p', { class: 'hint small' }, 'Greyed settings aren\'t set on this object, so the game uses the default shown. Type a value to set one; clear it to go back to the default.'));
    }
    if (info2?.scale && it.kind === 'actor') box.append(el('p', { class: 'hint small' }, el('b', {}, 'Scale: '), info2.scale));
    if (it.kind === 'actor') box.append(el('div', { class: 'kv small' }, el('b', {}, 'Gyaml'), el('span', { class: 'mono' }, (it.data.Gyaml || '').replace('Work/Gyml/', ''))));
    if (it.data.Links?.length) box.append(el('div', { class: 'kv small' }, el('b', {}, 'Links'), `${it.data.Links.length} (pink lines)`));
  }
  if (sel.every(s => s.kind === 'point')) rangeBlock(box, sel);
  const btns = el('div', { class: 'btns' });
  btns.append(el('button', { onclick: duplicateSel, title: 'Ctrl+D' }, 'Duplicate'), el('button', { onclick: deleteSel, class: 'danger', title: 'Delete' }, 'Delete'), el('button', { onclick: () => frame(sel), title: 'F' }, 'Focus'));
  if (sel.length === 1) btns.append(el('button', { onclick: () => editRaw(it) }, 'Edit as text…'));
  if (sel.length === 1 && it.kind === 'point') btns.append(el('button', { onclick: () => addRailPoint(it) }, 'Insert point after'), el('button', { onclick: () => startBranchDraw(it), title: 'Draw a new path that splits off here' }, 'Draw branch from here'));
  if (sel.length === 2 && sel.every(pathPoint)) btns.append(el('button', { onclick: () => branchBetween(sel[0], sel[1]), title: 'A new path from the 1st point to the 2nd, bowed out so you can drag it into place' }, 'Branch 1st → 2nd'), el('button', { onclick: () => linkSel(true) }, 'Link 1st → 2nd'), el('button', { onclick: () => linkSel(false) }, 'Unlink'));
  if (TRACK.meshes.length) btns.append(el('button', { onclick: dropToTrack, title: 'Put the selection on the track surface (End)' }, 'Drop to track'));
  if (sel.length > 1 && sel.every(s => s.kind === 'actor')) btns.append(el('button', { onclick: dropToGround, title: 'Line them up on the lowest Y' }, 'Level Y'));
  box.append(btns);
}
// width / height / side shift / up shift of the selected path points, with an explanation behind "?"
function rangeBlock(box, sel) {
  const kinds = [...new Set(sel.map(s => s.rail.Name))], info = PATHINFO[kinds[0]] || { title: 'Path point', def: [10, 10, 0, 5], what: 'A point on a ' + kinds[0] + '.', range: '', offset: '' };
  const q = el('button', { class: 'qhelp' + (S.helpOpen ? ' on' : ''), title: 'What the range does' }, '?');
  q.onclick = () => { S.helpOpen = !S.helpOpen; try { localStorage.setItem('mkwe-help', S.helpOpen ? '1' : ''); } catch {} fillInspector(); };
  box.append(el('div', { class: 'ohead' }, el('h4', {}, `Range${sel.length > 1 ? ` (${sel.length} points)` : ''}`), q));
  if (S.helpOpen) {
    const h = el('div', { class: 'ohelp' }, el('p', {}, el('b', {}, info.title + ': '), info.what));
    if (info.range) h.append(el('p', {}, el('b', {}, 'Width / Height: '), info.range));
    if (info.offset) h.append(el('p', {}, el('b', {}, 'Side / Up shift: '), info.offset));
    h.append(el('p', { class: 'hint' }, 'The yellow box in the view shows the selected points\' range. Select several points (Shift-click, or double-click a path in the list) to set them all at once.'));
    box.append(h);
  }
  const fields = [['Width', 'RectSize', 0, 'm'], ['Height', 'RectSize', 1, 'm'], ['Side shift', 'RectOffset', 0, 'm'], ['Up shift', 'RectOffset', 1, 'm']];
  for (const [label, key, k, unit] of fields) {
    const vals = sel.map(s => s.data[key]?.[k] ?? info.def[key === 'RectSize' ? k : 2 + k]);
    const same = vals.every(v => Math.abs(v - vals[0]) < 1e-4);
    const inp = el('input', { type: 'number', step: '0.5', placeholder: same ? '' : 'mixed' }); if (same) inp.value = fmt(vals[0]);
    inp.onchange = () => {
      if (inp.value === '') return; const v = f32(+inp.value); pushUndo();
      for (const s of sel) {
        const arr = (s.data[key] || (key === 'RectSize' ? info.def.slice(0, 2) : info.def.slice(2))).slice(), old = arr[k]; arr[k] = v; s.data[key] = arr.map(f32);
        // a new height grows or shrinks the box from its bottom, so a box standing on the road stays on the road
        if (key === 'RectSize' && k === 1) { const o = (s.data.RectOffset || info.def.slice(2)).slice(); o[1] = o[1] + (v - old) / 2; s.data.RectOffset = o.map(f32); }
      }
      markDirty(); drawRails(); fillInspector();
    };
    box.append(el('div', { class: 'kv' }, el('b', {}, `${label} (${unit})`), inp));
  }
  // a box that starts above the path point (or is very thin) leaves karts on the road outside it
  const bad = sel.filter(s => { const sz = s.data.RectSize || info.def.slice(0, 2), o = s.data.RectOffset || info.def.slice(2); return o[1] - sz[1] / 2 > 0.5; });
  if (bad.length) box.append(el('div', { class: 'hint', style: 'color:#ff8a4a' }, `The box starts ${fmt((bad[0].data.RectOffset?.[1] ?? info.def[3]) - (bad[0].data.RectSize?.[1] ?? info.def[1]) / 2)} m above the path${bad.length > 1 ? ` (${bad.length} points)` : ''}, so karts on the road are outside it${kinds[0] === 'LapPathGraph' ? ' and get taken back as out of bounds' : ''}. Make Up shift half the Height (or less).`));
  const rails = [...new Set(sel.map(s => s.rail))];
  box.append(el('div', { class: 'btns' }, el('button', { title: 'Give every point on the selected point\'s path(s) this range', onclick: () => {
    const src = sel[0].data, n = rails.reduce((a, r) => a + r.Points.length, 0);
    if (!confirm(`Set all ${n} points on ${rails.length > 1 ? 'these paths' : 'this path'} to ${fmt(src.RectSize?.[0] ?? info.def[0])} × ${fmt(src.RectSize?.[1] ?? info.def[1])} m?`)) return;
    pushUndo(); for (const r of rails) for (const p of r.Points) { if (src.RectSize) p.RectSize = src.RectSize.slice(); if (src.RectOffset) p.RectOffset = src.RectOffset.slice(); }
    markDirty(); drawRails(); toast(`Range copied to ${n} points.`, 'ok');
  } }, 'Use for whole path')));
}
function refreshSelectionLight() { const sel = [...S.sel].map(id => S.items.get(id)); if (sel.length) { const c = new THREE.Vector3(); sel.forEach(it => c.add(it.mesh.position)); pivot.position.copy(c.divideScalar(sel.length)); if (sel.length === 1) { pivot.rotation.copy(sel[0].mesh.rotation); pivot.scale.copy(sel[0].mesh.scale); } } }
function fillInspectorValues() {
  const sel = [...S.sel].map(id => S.items.get(id)); if (sel.length !== 1) return; const it = sel[0];
  const posKey = it.kind === 'point' ? 'Translation' : 'Translate';
  const set = (k, arr, f) => arr && arr.forEach((v, i) => { const inp = document.querySelector(`[data-k="${k}${i}"]`); if (inp && document.activeElement !== inp) inp.value = fmt(v * f); });
  set('pos', it.data[posKey], 1); set('rot', it.data.Rotate, DEG); set('scale', it.data.Scale, 1);
}

// ---------------------------------------------------------------- edits
function newIdentity(o) { o.Hash = T.u64(rand64()); o.InstanceId = uuid(); if ('SRTHash' in o) o.SRTHash = T.u32(rand32()); }
function cloneVal(v) { return parseByml(writeByml({ v }, 7, false)).root.v; }
function duplicateSel() {
  const sel = [...S.sel].map(id => S.items.get(id)); if (!sel.length) return;
  pushUndo();
  const newHashes = [];
  for (const it of sel) {
    if (it.kind === 'actor') {
      const c = cloneVal(it.data); newIdentity(c); delete c.Links; delete c.ParentPrefab;
      c.Translate = c.Translate.map((v, i) => f32(v + (i === 0 ? 3 : 0)));
      S.doc.Actors.push(c); newHashes.push(hashKey(c.Hash));
    } else {
      const pts = it.rail.Points, i = pts.indexOf(it.data);
      const c = cloneVal(it.data); newIdentity(c); delete c.Links; delete c.Dynamic?.IsStart;
      c.Translation = c.Translation.map((v, k) => f32(v + (k === 0 ? 3 : 0)));
      pts.splice(i + 1, 0, c); newHashes.push(hashKey(c.Hash));
    }
  }
  afterStructureChange(newHashes);
}
function addRailPoint(it) {
  pushUndo();
  const pts = it.rail.Points, i = pts.indexOf(it.data), next = pts[i + 1];
  const c = cloneVal(it.data); newIdentity(c); delete c.Links; if (c.Dynamic) { delete c.Dynamic.IsStart; if (!Object.keys(c.Dynamic).length) delete c.Dynamic; }
  c.Translation = next ? c.Translation.map((v, k) => f32((v + next.Translation[k]) / 2)) : c.Translation.map((v, k) => f32(v + (k === 0 ? 10 : 0)));
  pts.splice(i + 1, 0, c);
  afterStructureChange([hashKey(c.Hash)]);
}
function deleteSel() {
  const sel = [...S.sel].map(id => S.items.get(id)); if (!sel.length) return;
  pushUndo();
  const gone = new Set(sel.map(it => hashKey(it.data.Hash)));
  S.doc.Actors = S.doc.Actors.filter(a => !gone.has(hashKey(a.Hash)));
  for (const r of S.doc.Rails || []) {
    const keep = r.Points.filter(p => !gone.has(hashKey(p.Hash)));
    if (keep.length < 1) { toast(`Kept the last point of ${r.Name}: a path can't be empty.`); continue; }
    r.Points = keep;
  }
  // drop links that pointed at deleted things
  const scrub = o => { if (o.Links) { o.Links = o.Links.filter(l => !gone.has(hashKey(l.Dst))); if (!o.Links.length) delete o.Links; } };
  S.doc.Actors.forEach(scrub); (S.doc.Rails || []).forEach(r => r.Points.forEach(scrub));
  afterStructureChange([]);
}
function dropToGround() {
  const sel = [...S.sel].map(id => S.items.get(id)); pushUndo();
  const y = Math.min(...sel.map(s => s.data.Translate[1]));
  sel.forEach(s => { s.data.Translate = [s.data.Translate[0], f32(y), s.data.Translate[2]]; applyTransform(s.mesh, s.data, 'Translate'); });
  markDirty(); refreshSelection(); drawLinks();
}
function afterStructureChange(selectHashes) {
  syncCounts(); buildScene(false);
  if (selectHashes.length) { const want = new Set(selectHashes); for (const [id, it] of S.items) if (want.has(hashKey(it.data.Hash))) S.sel.add(id); refreshSelection(); }
  markDirty();
}
function addFromCatalog(name) {
  if (!S.doc) return toast('Open a course first.');
  const entry = S.catalog?.[name] || localCatalog()[name]; if (!entry) return;
  if (entry.noActor) return toast(`${name} isn't a real object in this version of the game: there's no actor data or model for it in the romfs (in the open world it's only placement data, drawn some other way). The game would show nothing, or could crash.`, 'err');
  pushUndo();
  const a = fromText(entry.tpl); newIdentity(a); if (!a.SRTHash) a.SRTHash = T.u32(rand32());
  delete a.Links; delete a.ParentPrefab; delete a.Marking; delete a.AreaName;   // open-world bookkeeping (road-tool marks, world areas) that a course doesn't use
  const t = orbit.target; let ty = t.y;
  if (snapOn()) { const g = groundAt(t.x, t.z, t.y); if (g !== null) ty = g + (/ItemBox/.test(name) ? 1.6 : 0); }
  a.Translate = [f32(t.x), f32(ty), f32(t.z)];
  if (!('IsGridify' in a)) a.IsGridify = false;
  for (const st of objInfo(name)?.settings || []) if (st.type === 'bool' && st.def === false && name.includes('ItemBox')) { a.Dynamic = a.Dynamic || {}; if (!(st.key in a.Dynamic)) a.Dynamic[st.key] = false; }   // as the game sets every item box
  S.doc.Actors.push(a);
  afterStructureChange([hashKey(a.Hash)]);
  toast(`Added ${name} at the centre of the view. Drag the arrows to place it.`);
}

// keep the course's own tallies right: CountActor / CountRail / Collects / AABB
const COLLECT_RULES = { Coin: n => /Coin\d/.test(n), MobVehicle: n => /^CmnObj_Mob/.test(n), Citizen: n => /Audience(?!Platform)/.test(n) };
function ruleCounts(doc) { const c = {}; for (const k in COLLECT_RULES) c[k] = (doc.Actors || []).filter(a => COLLECT_RULES[k](a.Name || '')).length; return c; }
function syncCounts() {
  const d = S.doc; if (!d) return;
  if (d.CountActor) { const c = {}; for (const a of d.Actors) c[a.Name] = (c[a.Name] || 0) + 1; for (const k in c) c[k] = T.i32(c[k]); d.CountActor = c; }
  if (d.CountRail) { const c = {}; for (const r of d.Rails || []) c[r.Name] = (c[r.Name] || 0) + 1; for (const k in c) c[k] = T.i32(c[k]); d.CountRail = c; }
  if (d.Collects && S.collectBase) {
    const now = ruleCounts(d);
    for (const k in d.Collects) if (k in now) {
      const base = S.collectBase.file[k], v = Math.max(0, base + now[k] - S.collectBase.rule[k]);
      d.Collects[k] = d.Collects[k] instanceof Typed ? new Typed(d.Collects[k].t, v) : T.i32(v);
    }
  }
}
function growAABB() {
  const d = S.doc; if (!d.AABB) return;
  const mn = d.AABB.Min.slice(), mx = d.AABB.Max.slice();
  for (const a of d.Actors) a.Translate && a.Translate.forEach((v, i) => { mn[i] = Math.min(mn[i], v - 1); mx[i] = Math.max(mx[i], v + 1); });
  d.AABB.Min = mn.map(f32); d.AABB.Max = mx.map(f32);
}

// ---------------------------------------------------------------- raw text editing
function editRaw(it) {
  const dlg = $('#rawdlg'), ta = $('#rawtext');
  $('#rawtitle').textContent = it ? `Edit ${it.data.Name || 'item'} as text` : 'Edit the whole course as text';
  ta.value = toText(it ? it.data : S.doc);
  $('#rawerr').textContent = '';
  dlg.showModal();
  $('#rawapply').onclick = () => {
    let v; try { v = fromText(ta.value); } catch (e) { $('#rawerr').textContent = e.message; return; }
    pushUndo();
    if (!it) S.doc = v;
    else if (it.kind === 'actor') { const i = S.doc.Actors.indexOf(it.data); S.doc.Actors[i] = v; }
    else { const pts = it.rail.Points; pts[pts.indexOf(it.data)] = v; }
    dlg.close(); afterStructureChange(it ? [hashKey(v.Hash)] : []);
  };
}

// ---------------------------------------------------------------- opening things
async function openRomfs(handle) {
  if (!handle) {
    if (!window.showDirectoryPicker) { $('#bancdlg').showModal(); return; }
    try { handle = await showDirectoryPicker({ id: 'romfs', mode: 'read' }); } catch { return; }
  }
  if (!await permit(handle)) return;
  let banc;
  try { banc = await handle.getDirectoryHandle('Banc'); }
  catch {
    // they may have picked the dump's base folder or the folder above romfs
    for (const sub of ['romfs', 'base/romfs']) { try { let h = handle; for (const p of sub.split('/')) h = await h.getDirectoryHandle(p); banc = await h.getDirectoryHandle('Banc'); handle = h; break; } catch {} }
  }
  if (!banc) return toast('That folder has no Banc folder. Pick the game\'s romfs folder (e.g. mkw 1.0\\base\\romfs).', 'err');
  S.romfs = handle; if (!handle.fake) idb.set('romfs', handle);
  const names = [];
  for await (const [n, h] of banc.entries()) if (h.kind === 'file' && n.endsWith('.bcett.byml.zs')) names.push(n);
  names.sort();
  fillCourseList(names);
  $('#romfsName').textContent = 'RomFS: ' + handle.name;
  toast(`Found ${names.length} course/scene files.`);
  if (TC.active) { tcLoadCap(); tcUpdate(); }
}
const COURSE_GROUPS = [['Race courses', /^Race_/], ['Balloon battle', /^BalloonBattle_/], ['Coin battle', /^CoinBattle_/], ['Connecting roads', /^InterStage/], ['Missions', /^Mission/], ['Free roam / world', /^(Game|World|FreeRun|Free)/], ['Other', /./]];
function fillCourseList(names) {
  const sel = $('#course'); sel.innerHTML = ''; sel.append(el('option', { value: '' }, `— pick a course (${names.length}) —`));
  const used = new Set();
  for (const [label, re] of COURSE_GROUPS) {
    const g = el('optgroup', { label });
    for (const n of names) if (!used.has(n) && re.test(n)) { used.add(n); g.append(el('option', { value: n }, n.replace('.bcett.byml.zs', ''))); }
    if (g.children.length) sel.append(g);
  }
}
// an edited copy of this course in one of the recomp's mods: offer to carry on from it
async function courseInMods(path) {
  const mods = S.modsDir; if (!mods) return null;
  try { if (await mods.queryPermission({ mode: 'readwrite' }) !== 'granted' && await mods.requestPermission({ mode: 'readwrite' }) !== 'granted') return null; } catch { return null; }
  const hits = [];
  for await (const [n, h] of mods.entries()) {
    if (h.kind !== 'directory' || n.startsWith('.')) continue;
    const b = await readAt(h, 'romfs/' + path); if (b) hits.push([n, b]);
  }
  if (!hits.length) return null;
  let pick = hits[0];
  if (hits.length === 1) { if (!confirm(`Your mod "${pick[0]}" already has an edited version of this course.\n\nOK = open that version and keep working on it\nCancel = start from the original course`)) return null; }
  else {
    const ans = prompt(`These mods have an edited version of this course:\n${hits.map(h => h[0]).join('\n')}\n\nType the one to open (or leave empty for the original):`, hits[0][0]);
    pick = hits.find(h => h[0] === (ans || '').trim()); if (!pick) return null;
  }
  return { mod: pick[0], raw: zsDecompress(pick[1]) };
}
async function confirmLeave() { return !S.dirty || confirm('You have unsaved changes to this course. They\'re kept for this session and will still be included when you save the mod. Switch anyway?'); }
async function openCourse(name) {
  if (!name || !S.romfs) return;
  if (!await confirmLeave()) return;
  const path = 'Banc/' + name;
  busy('Loading ' + name + '…');
  try {
    let raw = S.edited.get(path);
    if (!raw) {
      const orig = zsDecompress(await readAt(S.romfs, path)); if (!S.origSize.has(path)) S.origSize.set(path, orig.length);
      raw = orig;
      const fromMod = await courseInMods(path);
      if (fromMod) { raw = fromMod.raw; S.edited.set(path, raw); $('#modname').value = fromMod.mod; toast(`Opened your edited version from the mod "${fromMod.mod}". Saving updates that mod.`, 'ok'); }
    }
    loadDoc(raw, path);
  } catch (e) { toast('Couldn\'t open that file: ' + e.message, 'err'); console.error(e); }
  busy();
}
function loadDoc(raw, path) {
  S.customTrack = path === CUSTOM_PATH && !!TC.docBytes; $('#tc_editmodel').style.display = S.customTrack ? '' : 'none'; wsApply(); if ($('#cv_routebox')) $('#cv_routebox').style.display = S.customTrack ? '' : 'none';
  S.doc = parseByml(raw).root; S.path = path; S.undo = []; S.redo = []; S.dirty = S.edited.has(path);
  S.collectBase = S.doc.Collects ? { file: Object.fromEntries(Object.entries(S.doc.Collects).map(([k, v]) => [k, v instanceof Typed ? Number(v.v) : v])), rule: ruleCounts(S.doc) } : null;
  if (!S.doc.Actors) S.doc.Actors = [];
  buildScene(false); frame();
  $('#title').textContent = path.split('/').pop().replace('.bcett.byml.zs', '');
  learnFromDoc(S.doc);
  fillPalette();
  loadTrack();
}
async function openSingleFile(file) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  try {
    const raw = file.name.endsWith('.zs') ? zsDecompress(u8) : u8;
    loadDoc(raw, 'Banc/' + file.name.replace(/\.zs$/, '') + '.zs');
    toast('Opened ' + file.name + '. Without the RomFS folder you can still edit and download it.');
  } catch (e) { toast('Not a course file: ' + e.message, 'err'); }
}

// ---------------------------------------------------------------- object palette
function localCatalog() { const c = {}; if (S.doc) learnInto(c, S.doc); return c; }
function learnInto(cat, doc, world = false) {
  for (const a of doc.Actors || []) {
    const n = a.Name; if (!n) continue;
    if (!cat[n]) {
      const t = {}; for (const k of Object.keys(a)) if (!['Hash', 'InstanceId', 'SRTHash', 'Links', 'ParentPrefab', 'Translate', ...(world ? ['AreaName', 'Marking'] : [])].includes(k)) t[k] = a[k];
      cat[n] = { gyaml: a.Gyaml, count: 0, tpl: toText(t) };
    }
    cat[n].count++;
  }
}
function learnFromDoc(doc) { if (S.catalog) learnInto(S.catalog, doc); }
async function scanCatalog() {
  if (!S.romfs) return toast('Open the RomFS folder first.');
  const banc = await S.romfs.getDirectoryHandle('Banc');
  // every course, plus the open world's own tiles (most trees, lamp posts and buildings are only placed there)
  const files = []; for await (const [n, h] of banc.entries()) { if (h.kind === 'file' && n.endsWith('.byml.zs')) files.push(h);
    else if (h.kind === 'directory' && /^World_/.test(n)) for await (const [n2, h2] of h.entries()) if (h2.kind === 'file' && n2.endsWith('.byml.zs')) files.push(h2); }
  const cat = {}; let i = 0;
  for (const h of files) {
    i++; if (i % 10 === 0) { busy(`Scanning objects… ${i}/${files.length}`); await new Promise(r => setTimeout(r)); }
    try { learnInto(cat, parseByml(zsDecompress(new Uint8Array(await (await h.getFile()).arrayBuffer()))).root, /^\d{4}\.|^World/.test(h.name)); } catch {}
  }
  // objects the game has no actor data for (open-world scenery drawn some other way): kept in the list but marked, and not added
  try { const A = await omArchives(); if (A.actor.size) for (const n of Object.keys(cat)) if (!A.actor.has(`Gyml/ActorGParam/${n}.gear__ActorGParam.bgyml`)) cat[n].noActor = true; } catch (e) { console.error(e); }
  busy(); S.catalog = cat;
  try { localStorage.setItem('mkwe-catalog-1', JSON.stringify(cat)); } catch {}
  fillPalette(); toast(`Object list ready: ${Object.keys(cat).length} kinds of object from every course and the open world.`);
}
function fillPalette() {
  const box = $('#palette'); box.innerHTML = '';
  const cat = Object.assign({}, S.catalog || {}, localCatalog());
  const q = $('#pfilter').value.trim().toLowerCase();
  const local = localCatalog();
  const names = Object.keys(cat).filter(n => !q || n.toLowerCase().includes(q)).sort((a, b) => (local[b] ? 1 : 0) - (local[a] ? 1 : 0) || a.localeCompare(b));
  $('#pcount').textContent = S.catalog ? `${names.length} kinds` : `${names.length} kinds in this course`;
  for (const n of names.slice(0, 400)) {
    box.append(el('div', { class: 'prow', style: cat[n].noActor ? 'opacity:.45' : '', title: (cat[n].gyaml || '') + (cat[n].noActor ? '\nNo actor data in this version of the game: it can\'t be added' : '\nClick to add'), onclick: () => addFromCatalog(n) },
      el('span', { class: 'dot', style: `background:#${styleOf(n)[2].toString(16).padStart(6, '0')}` }), n, local[n] ? el('span', { class: 'cnt' }, 'here') : cat[n].noActor ? el('span', { class: 'cnt', title: 'No actor data in this version of the game: can\'t be added' }, 'n/a') : ''));
  }
  if (names.length > 400) box.append(el('div', { class: 'hint' }, `…${names.length - 400} more, type to narrow down`));
}

// ---------------------------------------------------------------- saving
function stashCurrent() { if (S.doc && S.dirty) { syncCounts(); growAABB(); S.edited.set(S.path, writeByml(S.doc)); } }
// output files for the mod, as romfs-relative path -> bytes (shared by the folder writer and the zip download)
async function buildModFiles(modName, existing) {
  const files = new Map();
  for (const [path, raw] of S.edited) files.set(path, zsStore(raw));
  for (const [path, zs] of S.extra) files.set(path, zs);
  // resource size table: the game sizes its load buffers from it, so a course that grew needs a bigger entry
  let rstbNote = '', tblPath = null, base = null;
  if (S.romfs && !S.romfs.fake) {
    const sysRes = await S.romfs.getDirectoryHandle('System').then(d => d.getDirectoryHandle('Resource')).catch(() => null);
    if (sysRes) for await (const [n] of sysRes.entries()) if (/^ResourceSizeTable\.Product\.\d+\..*rsizetable\.zs$/.test(n)) tblPath = 'System/Resource/' + n;
    if (tblPath) base = (existing && await existing(tblPath)) || await readAt(S.romfs, tblPath);
  } else if (S.rstbFile) { tblPath = 'System/Resource/' + S.rstbFile.name; base = new Uint8Array(await S.rstbFile.arrayBuffer()); }
  if (base) {
    const tbl = parseRstb(zsDecompress(base)); let changed = false;
    for (const [path, raw] of S.edited) {
      const key = path.replace(/\.zs$/, ''), old = rstbGet(tbl, key) || 0, need = raw.length + 1024;
      if (need > old) { rstbSet(tbl, key, need); changed = true; }
    }
    if (changed) { files.set(tblPath, zsStore(writeRstb(tbl))); rstbNote = ' (size table updated)'; S.rstbOrig = S.rstbOrig || base; }
  }
  // objects with baked collision that were deleted: switch their collision off in the course's .bphsc files
  let collNote = '';
  if (S.romfs && !S.romfs.fake) {
    try { const c = await bakedCollisionFiles(); for (const [p, b] of c.out) files.set(p, zsStore(b)); collNote = c.note; }
    catch (e) { console.error(e); collNote = ' (couldn\'t update collision: ' + e.message + ')'; }
  }
  return { files, rstbNote: rstbNote + collNote, tblPath };
}

// Bakeable objects keep their collision in Phive/StaticCompoundBody/Course/*_<course>.bphsc: when they
// are deleted from a course, switch that collision off too (Race_ and RaceStage_ both carry it)
async function bakedCollisionFiles() {
  const out = new Map(); let objects = 0; const moved = new Set();
  const dir = await S.romfs.getDirectoryHandle('Phive').then(d => d.getDirectoryHandle('StaticCompoundBody')).then(d => d.getDirectoryHandle('Course')).catch(() => null);
  if (!dir) return { out, note: '' };
  const names = []; for await (const [n] of dir.entries()) names.push(n);
  const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  for (const [path, raw] of S.edited) {
    const origRaw = await readAt(S.romfs, path); if (!origRaw) continue;
    const orig = parseByml(zsDecompress(origRaw)).root, now = parseByml(raw).root;
    const nowBy = new Map((now.Actors || []).map(a => [hashKey(a.Hash), a]));
    const gone = new Set();
    for (const a of orig.Actors || []) {
      const b = nowBy.get(hashKey(a.Hash));
      if (!b) gone.add(hashKey(a.Hash));
      else if (a.Bakeable === true && (!same(a.Translate, b.Translate) || !same(a.Rotate, b.Rotate) || !same(a.Scale, b.Scale))) moved.add(a.Name);
    }
    if (!gone.size) continue;
    const base = path.split('/').pop().replace('.bcett.byml.zs', '').replace(/\[.*\]$/, '');
    const core = base.replace(/^(Race|BalloonBattle|CoinBattle|Mission)_/, '');
    let n = 0;
    for (const f of names) {
      if (!f.endsWith('.bphsc.zs') || !(f.startsWith(base + '.') || f.includes('_' + core + '.'))) continue;
      const p = 'Phive/StaticCompoundBody/Course/' + f;
      const cur = out.get(p) || zsDecompress(await readAt(S.romfs, p));
      const r = removeBakedCollision(cur, gone);
      if (r) { out.set(p, r.bytes); n = Math.max(n, r.objects); }
    }
    objects += n;
  }
  let note = objects ? ` (collision of ${objects} deleted object${objects > 1 ? 's' : ''} removed)` : '';
  if (moved.size) toast(`Heads up: ${[...moved].join(', ')} ha${moved.size > 1 ? 've' : 's'} baked collision, which stays where the object originally was. Delete and re-add it if that's a problem.`, 'err');
  return { out, note };
}
async function manifestFor(entries, tblPath) {
  let manifest = '';
  for (const [p, bytes] of [...entries].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    let orig = null;
    if (S.romfs) orig = await readAt(S.romfs, p);
    if (!orig && p === tblPath && S.rstbFile) orig = new Uint8Array(await S.rstbFile.arrayBuffer());
    manifest += `${p}\t${bytes.length}\t${await sha256hex(bytes)}\t${orig ? await sha256hex(orig) : '-'}\n`;
  }
  return manifest;
}
const modMeta = (modName, n) => JSON.stringify({ name: modName, title: modName, has_romfs: true, romfs_files: n, has_exefs: false, exefs_builds: [], exefs_match: true, switches: {}, warnings: [], producer: 'MK World Course Editor' }, null, 2) + '\n';
const grewWithoutTable = () => S.romfs?.fake && !S.rstbFile && !S.skipRstb && [...S.edited].some(([p, raw]) => raw.length > (S.origSize.get(p) || 0));

async function saveMod() {
  if (S.customTrack) return tcBuild(false);
  if (!S.doc) return;
  stashCurrent();
  if (!S.edited.size && !S.extra.size) return toast('Nothing has been changed yet.');
  let modName = $('#modname').value.trim().replace(/[^A-Za-z0-9_-]+/g, '');
  if (!modName) { modName = 'MyCourseEdit'; $('#modname').value = modName; }
  if (!window.showDirectoryPicker || S.romfs?.fake) {
    // no folder access in this browser: hand over the finished mod as a .zip
    if (grewWithoutTable()) { $('#rstbdlg').showModal(); return; }
    busy('Building mod zip…');
    try {
      const { files, rstbNote, tblPath } = await buildModFiles(modName);
      const manifest = await manifestFor(files, tblPath);
      const zipFiles = [...files].map(([p, b]) => [`${modName}/romfs/${p}`, b]);
      zipFiles.push([`${modName}/romfs/manifest.tsv`, new TextEncoder().encode(manifest)], [`${modName}/mod.json`, new TextEncoder().encode(modMeta(modName, files.size))]);
      busy(); const saved = await saveFile(makeZip(zipFiles), modName + '.zip', 'modzip'); if (!saved) return toast('Not saved.');
      S.dirty = false; updateStats();
      toast(`Saved ${saved}${rstbNote}. Extract it into mkw-recomp\\mods (so you get mods\\${modName}\\romfs), then turn it on in the recomp's Mods page.`, 'ok');
    } catch (e) { console.error(e); toast('Saving failed: ' + e.message, 'err'); }
    busy(); return;
  }
  let mods = S.modsDir;
  if (!mods || !await permit(mods, 'readwrite')) {
    toast('Pick the recomp\'s "mods" folder (inside mkw-recomp).');
    try { mods = await showDirectoryPicker({ id: 'mods', mode: 'readwrite' }); } catch { return; }
    if (!await permit(mods, 'readwrite')) return;
    try { mods = await mods.getDirectoryHandle('mods'); } catch {}   // they picked mkw-recomp itself
    S.modsDir = mods; idb.set('mods', mods);
  }
  busy('Writing mod…');
  try {
    const mod = await mods.getDirectoryHandle(modName, { create: true });
    const romfs = await mod.getDirectoryHandle('romfs', { create: true });
    const { files, rstbNote, tblPath } = await buildModFiles(modName, p => readAt(romfs, p));
    for (const [p, b] of files) await writeAt(romfs, p, b);
    // the manifest covers everything in the mod's romfs, including files from earlier saves
    const all = new Map();
    for (const [p, h] of await walk(romfs)) if (p !== 'manifest.tsv') all.set(p, new Uint8Array(await (await h.getFile()).arrayBuffer()));
    await writeAt(romfs, 'manifest.tsv', new TextEncoder().encode(await manifestFor(all, tblPath)));
    await writeAt(mod, 'mod.json', new TextEncoder().encode(modMeta(modName, all.size)));
    S.dirty = false; updateStats();
    toast(`Saved mod "${modName}" with ${S.edited.size} course file(s)${rstbNote}. Turn it on in the recomp's Mods page.`, 'ok');
  } catch (e) { console.error(e); toast('Saving failed: ' + e.message, 'err'); }
  busy();
}

// a plain stored .zip (no compression needed: the course files are already zstd)
function makeZip(entries) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const crcOf = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = ZCRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  for (const [name, data] of entries) {
    const nb = enc.encode(name), crc = crcOf(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(h.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nb);
    off += 30 + nb.length + data.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)]);
}
const ZCRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();

function downloadCurrent() {
  if (!S.doc) return; stashCurrent();
  const raw = S.edited.get(S.path) || writeByml(S.doc);
  download(zsStore(raw), S.path.split('/').pop());
  toast('Downloaded. Put it in <mod>/romfs/Banc/ for an emulator mod.');
}


// ---------------------------------------------------------------- folder fallback (Firefox, Brave, Safari…): read the picked Banc folder
class FakeDir {
  constructor(name) { this.name = name; this.kind = 'directory'; this.fake = true; this.dirs = new Map(); this.files = new Map(); }
  async getDirectoryHandle(n) { const d = this.dirs.get(n); if (!d) throw new DOMException('not found', 'NotFoundError'); return d; }
  async getFileHandle(n) { const f = this.files.get(n); if (!f) throw new DOMException('not found', 'NotFoundError'); return { kind: 'file', name: n, getFile: async () => f }; }
  async *entries() { for (const [n, d] of this.dirs) yield [n, d]; for (const [n, f] of this.files) yield [n, { kind: 'file', name: n, getFile: async () => f }]; }
  async queryPermission() { return 'granted'; } async requestPermission() { return 'granted'; }
}
function fakeRomfs(fileList) {
  const root = new FakeDir('romfs');
  let n = 0;
  for (const f of fileList) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    let i = parts.indexOf('Banc'); if (i < 0) i = parts.indexOf('System'); if (i < 0) continue;   // keep paths from Banc/ or System/ on
    let d = root;
    for (const p of parts.slice(i, -1)) { if (!d.dirs.has(p)) d.dirs.set(p, new FakeDir(p)); d = d.dirs.get(p); }
    d.files.set(parts[parts.length - 1], f); n++;
  }
  return n ? root : null;
}
$('#bancpick').onclick = () => $('#bancInput').click();
$('#bancInput').onchange = async e => {
  $('#bancdlg').close();
  const root = fakeRomfs(e.target.files); e.target.value = '';
  if (!root || !root.dirs.has('Banc')) return toast('That wasn\'t the Banc folder. Pick romfs\\Banc (the folder with the .bcett.byml.zs files).', 'err');
  await openRomfs(root);
  $('#romfsName').textContent = 'Banc folder (read-only, saves as .zip)';
};
$('#bancrstb').onclick = () => $('#rstbInput').click();
$('#rstbpick').onclick = () => $('#rstbInput').click();
$('#rstbskip').onclick = () => { $('#rstbdlg').close(); S.skipRstb = true; saveMod(); };
$('#rstbInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (!/rsizetable\.zs$/.test(f.name)) return toast('Pick the file ending in .rsizetable.zs from romfs\\System\\Resource.', 'err');
  S.rstbFile = f; toast('Size table loaded: ' + f.name, 'ok');
  if ($('#rstbdlg').open) { $('#rstbdlg').close(); saveMod(); } };

// ---------------------------------------------------------------- stats / UI wiring
function updateStats() {
  $('#stats').textContent = S.doc ? `${(S.doc.Actors || []).length} objects · ${(S.doc.Rails || []).length} paths${S.dirty ? ' · unsaved changes' : ''}${S.edited.size > 1 ? ` · ${S.edited.size} courses edited` : ''}` : '';
  $('#save').classList.toggle('hot', S.dirty);
}
function setMode(m) { gizmo.setMode(m); tcGizmoAxes(); document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m)); }
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$('#space').onclick = () => { gizmo.setSpace(gizmo.space === 'local' ? 'world' : 'local'); $('#space').textContent = gizmo.space === 'local' ? 'Local' : 'World'; };
$('#openRomfs').onclick = () => openRomfs();
// the base game's romfs, for the files an update doesn't carry (most open-world scenery models)
async function openBaseRomfs(handle) {
  if (!handle) { if (!window.showDirectoryPicker) return toast('This browser can\'t open folders.', 'err'); try { handle = await showDirectoryPicker({ id: 'baseromfs', mode: 'read' }); } catch { return; } }
  if (!await permit(handle)) return;
  let ok = false; try { await handle.getDirectoryHandle('Model'); ok = true; } catch {
    for (const sub of ['romfs', 'base/romfs']) { try { let h = handle; for (const p of sub.split('/')) h = await h.getDirectoryHandle(p); await h.getDirectoryHandle('Model'); handle = h; ok = true; break; } catch {} } }
  if (!ok) return toast('That folder has no Model folder. Pick the base game\'s romfs folder (e.g. mkw 1.0\\base\\romfs).', 'err');
  S.baseRomfs = handle; idb.set('baseromfs', handle);
  $('#openBase').textContent = 'Base: ' + handle.name; $('#openBase').title = 'Base game romfs in use for files the update doesn\'t have. Click to pick another.';
  OM.cache.clear(); for (const [id, it] of S.items) if (!it.model) attachModel(id);
  toast('Base game romfs added: files missing from the update (like most open-world scenery models) now come from it.', 'ok');
}
$('#openBase').onclick = () => openBaseRomfs();
$('#course').onchange = e => { stashCurrent(); openCourse(e.target.value); };
$('#openFile').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = e => e.target.files[0] && openSingleFile(e.target.files[0]);
$('#save').onclick = saveMod;
$('#dl').onclick = downloadCurrent;
$('#undo').onclick = undo; $('#redo').onclick = redo;
$('#filter').oninput = fillOutliner;
$('#pfilter').oninput = fillPalette;
$('#scan').onclick = scanCatalog;
$('#frameAll').onclick = () => frame();
for (const id of ['showActors', 'showRails', 'showLinks', 'showWidth']) $('#' + id).onchange = () => buildScene(true);
$('#showTrack').onchange = () => { trackGroup.visible = $('#showTrack').checked; };
try { $('#snap').checked = localStorage.getItem('mkwe-snap') !== '0'; } catch {}
$('#snap').onchange = () => { try { localStorage.setItem('mkwe-snap', $('#snap').checked ? '1' : '0'); } catch {} };
$('#rawcancel').onclick = () => $('#rawdlg').close();
$('#help').onclick = () => $('#helpdlg').showModal();
$('#minimap').onclick = openMinimap;
$('#mm_close').onclick = () => $('#mmdlg').close();
$('#mm_add').onclick = () => { try { addMinimapToMod(); } catch (e) { console.error(e); toast('Minimap: ' + e.message, 'err'); } };
$('#mm_png').onclick = () => MM.canvas && MM.canvas.toBlob(b => { const a = el('a', { href: URL.createObjectURL(b), download: (MM.info?.name || 'minimap') + '.png' }); document.body.append(a); a.click(); a.remove(); });
for (const id of ['mm_color', 'mm_outline', 'mm_doOutline', 'mm_opacity', 'mm_width', 'mm_routes', 'mm_fit', 'mm_tex', 'mm_pathtoo']) $('#' + id).oninput = drawMinimapPreview;
$('#mm_src').onchange = () => { if ($('#mm_src').value !== 'path' && +$('#mm_opacity').value === 80) $('#mm_opacity').value = 100; mmSrcUI(); drawMinimapPreview(); };
$('#mm_pick').onclick = () => $('#mm_filein').click();
$('#mm_filein').onchange = async () => {
  const files = await Promise.all([...$('#mm_filein').files].map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))); $('#mm_filein').value = '';
  if (!files.length) return;
  busy('Reading the minimap model…');
  try { TC.mmModel = { name: files.find(f => /\.(obj|fbx|dae)$/i.test(f.name))?.name || files[0].name, files, model: await parseModel(files) }; idb.set('tc-mm', { files }); $('#mm_src').value = 'file'; if (+$('#mm_opacity').value === 80) $('#mm_opacity').value = 100; mmSrcUI(); drawMinimapPreview(); }
  catch (e) { console.error(e); toast('Couldn\'t read that model: ' + e.message, 'err'); }
  busy();
};
$('#helpclose').onclick = () => $('#helpdlg').close();
$('#legend').append(...STYLE.map(s => { const cb = el('input', { type: 'checkbox', checked: '' }); cb.onchange = () => { cb.checked ? hiddenCats.delete(s[3]) : hiddenCats.add(s[3]); buildScene(true); }; return el('label', {}, cb, el('span', { class: 'dot', style: `background:#${s[2].toString(16).padStart(6, '0')}` }), s[3]); }));
window.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (e.key === 'Shift') held.add('shift');
  if (FLY.has(k) && !e.ctrlKey && !e.altKey && !e.metaKey) { held.add(k); e.preventDefault(); return; }
  if (QC.drawing) {
    if (k === 'enter') qcFinishDraw(); else if (k === 'backspace' || (e.ctrlKey && k === 'z')) { e.preventDefault(); qcUndoPoint(); } else if (k === 'escape') qcCancelDraw();
    return;
  }
  if (TC.active) { tcKey(e, k); return; }
  if (e.ctrlKey && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.ctrlKey && k === 'y') { e.preventDefault(); redo(); }
  else if (e.ctrlKey && k === 'd') { e.preventDefault(); duplicateSel(); }
  else if (e.ctrlKey && k === 's') { e.preventDefault(); saveMod(); }
  else if (k === 'delete' || k === 'backspace') deleteSel();
  else if (k === '1' || k === 'g') setMode('translate');
  else if (k === '2' || k === 'r') setMode('rotate');
  else if (k === '3' || k === 't') setMode('scale');
  else if (k === 'l') $('#space').click();
  else if (k === 'f') { const sel = [...S.sel].map(id => S.items.get(id)); frame(sel.length ? sel : undefined); }
  else if (k === 'escape') { S.sel.clear(); refreshSelection(); }
  else if (k === 'end') dropToTrack();
});
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- the track itself: stage models from the world, used as the ground
const trackGroup = new THREE.Group(); scene.add(trackGroup);
const TRACK = { stages: null, cache: new Map(), meshes: [], loadedFor: null, note: '' };
const snapOn = () => $('#snap').checked && (TRACK.meshes.length > 0 || KITMESH.length > 0);
const down = new THREE.Vector3(0, -1, 0);
const groundRay = new THREE.Raycaster(); groundRay.firstHitOnly = true;
// height of the track under (x, z): of every surface on that vertical line, the one nearest nearY
// (surfaces below win small ties), so a bridge or overpass above the road is never chosen by mistake
function groundMeshes(skip) { const all = TRACK.meshes.concat(KITMESH); return skip && skip.size ? all.filter(m => !skip.has(m)) : all; }
function groundAt(x, z, nearY, skip) {
  const meshes = groundMeshes(skip);
  if (!meshes.length) return null;
  groundRay.firstHitOnly = false;
  groundRay.set(new THREE.Vector3(x, nearY + 3000, z), down); groundRay.far = 6000;
  const hits = groundRay.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const cost = y => y > nearY + 0.5 ? (y - nearY) * 2 : Math.abs(nearY - y);
  let best = hits[0].point.y;
  for (const h of hits) if (cost(h.point.y) < cost(best)) best = h.point.y;
  return best;
}
// how high an object floats above the ground (item boxes hover, karts sit on it)
function hoverOf(p, it) {
  const g = TRACK.meshes.length ? groundAt(p.x, p.z, p.y) : null;
  const def = it && it.kind === 'actor' && /ItemBox/.test(it.data.Name || '') ? 1.6 : 0;
  if (g === null) return def;
  const h = p.y - g; return h >= -0.5 && h <= 6 ? Math.max(0, h) : def;
}
function dropToTrack() {
  if (!TRACK.meshes.length) return toast('No track model is loaded for this course.');
  const sel = [...S.sel].map(id => S.items.get(id)); if (!sel.length) return;
  pushUndo(); let n = 0;
  for (const it of sel) {
    const p = it.mesh.position, g = groundAt(p.x, p.z, p.y); if (g === null) continue;
    p.y = g + (it.kind === 'actor' && /ItemBox/.test(it.data.Name || '') ? 1.6 : 0); writeBack(it); n++;
  }
  markDirty(); refreshSelection(); drawRails(); drawLinks();
  toast(n === sel.length ? `Dropped ${n} onto the track.` : `Dropped ${n} of ${sel.length}; the rest aren't above the track model.`);
}

const TRACK_COLORS = [[/Road|Asphalt|Circuit_Ground|Pavement/i, 0x6b7280], [/Grass|Lawn|Turf|Leaf|Tree|Bush/i, 0x5f9e4a], [/Dirt|Sand|Soil|Cliff|Rock|Stone/i, 0xa08060], [/Water|Sea/i, 0x3b82c4], [/Line|White/i, 0xe5e7eb], [/Wall|Fence|Barrier|Guard/i, 0xc58a5a]];
function trackColor(name) {
  for (const [re, c] of TRACK_COLORS) if (re.test(name)) return c;
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.25, 0.55).getHex();
}
const stageModelPath = name => { const variant = name.replace(/_\d+$/, ''), base = variant.replace(/_[A-Z0-9]$/, ''); return `Model/${base}.${variant}.bfres.zs`; };

async function worldStages() {
  if (TRACK.stages) return TRACK.stages;
  const raw = await readAt(S.romfs, 'Banc/World_Game03/WorldResident.bcett.byml.zs');
  TRACK.stages = [];
  if (raw) for (const a of parseByml(zsDecompress(raw)).root.Actors || []) if ((a.Name || '').startsWith('Stage_')) TRACK.stages.push({ name: a.Name, t: a.Translate || [0, 0, 0], r: a.Rotate || [0, 0, 0], s: a.Scale || [1, 1, 1] });
  return TRACK.stages;
}
async function stageMesh(st) {
  if (TRACK.cache.has(st.name)) return TRACK.cache.get(st.name);
  const raw = await readAt(S.romfs, stageModelPath(st.name));
  let group = null;
  if (raw) {
    const model = loadBfres(zsDecompress(raw));
    group = new THREE.Group(); group.name = st.name;
    for (const p of model.parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
      g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      g.computeBoundsTree();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: trackColor(p.material), roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      m.name = p.material; group.add(m);
    }
    group.position.set(st.t[0], st.t[1], st.t[2]); group.rotation.set(st.r[0], st.r[1], st.r[2], 'ZYX'); group.scale.set(st.s[0], st.s[1], st.s[2]);
    group.updateMatrixWorld(true);
  }
  TRACK.cache.set(st.name, group);
  return group;
}
async function loadTrack() {
  trackGroup.clear(); TRACK.meshes = []; TRACK.note = '';
  if (S.customTrack) return tcTrackView();
  if (!S.doc || !S.romfs || S.romfs.fake) { TRACK.note = S.romfs?.fake ? 'No track model: only the Banc folder is open. Use Open RomFS on the whole romfs folder (the .exe or Chrome/Edge can).' : 'No track model: open the RomFS folder to see the track.'; updateTrackNote(); if (S.doc) toast(TRACK.note, 'err'); return; }
  const box = new THREE.Box3();
  if (S.doc.AABB) box.set(vec(S.doc.AABB.Min), vec(S.doc.AABB.Max)); else (S.doc.Actors || []).forEach(a => a.Translate && box.expandByPoint(vec(a.Translate)));
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), want = box.clone().expandByScalar(150);
  const token = S.path; TRACK.loadedFor = token;
  busy('Loading the track model…');
  try {
    const stages = (await worldStages()).map(st => ({ st, d: Math.hypot(st.t[0] - c.x, st.t[2] - c.z) })).filter(x => x.d < 1600).sort((a, b) => a.d - b.d).slice(0, 4);
    const names = [];
    for (const { st } of stages) {
      const g = await stageMesh(st);
      if (TRACK.loadedFor !== token) return;   // another course was opened meanwhile
      if (!g || !new THREE.Box3().setFromObject(g).intersectsBox(want)) continue;
      trackGroup.add(g); g.traverse(o => o.isMesh && TRACK.meshes.push(o)); names.push(st.name.replace(/^Stage_|_\d+$/g, ''));
    }
    TRACK.note = names.length ? `Track: ${names.join(', ')}` : 'No track model found for this course';
  } catch (e) { console.error(e); TRACK.note = 'Track model failed to load: ' + e.message; }
  busy(); trackGroup.visible = $('#showTrack').checked; updateTrackNote();
  toast(TRACK.note || 'No track model for this course.', TRACK.meshes.length ? 'ok' : 'err');
}
function updateTrackNote() { $('#trackNote').textContent = TRACK.note; $('#snapWrap').classList.toggle('off', !TRACK.meshes.length); }
// double-click the track to look at that spot
renderer.domElement.addEventListener('dblclick', e => {
  if (!TRACK.meshes.length || QC.drawing) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  const hit = ray.intersectObjects(TRACK.meshes, false)[0]; if (hit) orbit.target.copy(hit.point);
});

// ---------------------------------------------------------------- Quick Create: lay out a whole course from one guide line
const QC = { drawing: false, guide: [], closed: true, ghost: new THREE.Group(), drawGroup: new THREE.Group(),
  ps: [], sel: new Set(), cur: { w: null, fence: 'none', glide: false, arch: 15, panel: true, props: false } };   // ps: each guide point's settings (for the stretch to the next point)
scene.add(QC.ghost); scene.add(QC.drawGroup);
renderer.domElement.addEventListener('contextmenu', e => { if (QC.drawing) e.preventDefault(); });
const GY = {
  lap: 'Work/Gyml/GraphRailDefGParam/LapPathGraph.gear__GraphRailDefGParam.gyml',
  route: 'Work/Gyml/GraphRailDefGParam/RoutePathGraph.gear__GraphRailDefGParam.gyml',
  item: 'Work/Gyml/ActorGParam/CmnObj_ItemBox000_A_00.gear__ActorGParam.gyml',
  start: 'Work/Gyml/ActorGParam/StartPosition.gear__ActorGParam.gyml',
  link: 'Work/Gyml/LinkDefGParam/BasicSignal.gear__LinkDefGParam.gyml',
};
const qv = id => $('#qc_' + id);
const qnum = id => parseFloat(qv(id).value);

// heights: the road isn't loaded, so a clicked point takes the height of the course data around it
function refPoints() {
  const out = [];
  for (const r of S.doc?.Rails || []) for (const p of r.Points) if (/Lap|Route/.test(r.Name)) out.push(vec(p.Translation));
  for (const a of S.doc?.Actors || []) if (/StartPosition|ItemBox|Coin/.test(a.Name || '')) out.push(vec(a.Translate));
  return out;
}
function heightAt(x, z, refs, fallback) {
  let wsum = 0, ysum = 0, best = Infinity;
  for (const p of refs) { const d2 = (p.x - x) ** 2 + (p.z - z) ** 2; best = Math.min(best, d2); const w = 1 / (d2 + 1) ** 2; wsum += w; ysum += w * p.y; }
  return wsum && best < 250 ** 2 ? ysum / wsum : fallback;
}
function qcAddPoint(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  let pt = null;
  if (TRACK.meshes.length || KITMESH.length) { const hit = ray.intersectObjects(TRACK.meshes.concat(KITMESH), false)[0]; if (hit) pt = hit.point.clone(); }
  if (!pt && qv('snapObj').checked) { const hit = ray.intersectObjects([...S.items.values()].filter(it => it.mesh.visible).map(it => it.mesh), false)[0]; if (hit) pt = hit.object.position.clone(); }
  if (!pt) {
    const refs = refPoints();
    let h = QC.guide.length ? QC.guide[QC.guide.length - 1].y : orbit.target.y;
    for (let i = 0; i < 4; i++) {   // settle: where the ray meets that height, then the height there
      const p = new THREE.Vector3(); if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h), p)) return toast('Aim at the ground (tilt the camera down a bit).');
      pt = p; if (!qv('snapH').checked) break; const nh = heightAt(p.x, p.z, refs, h); if (Math.abs(nh - h) < 0.01) break; h = nh;
    }
    pt.y = h;
  }
  QC.guide.push(pt); QC.ps.push({ ...QC.cur }); drawGuide(); qcPreview();
}
function qcUndoPoint() { QC.guide.pop(); QC.ps.pop(); QC.sel.delete(QC.guide.length); drawGuide(); qcPreview(); }
// each guide point's settings, kept the same length as the guide
function qcPS() { while (QC.ps.length < QC.guide.length) QC.ps.push({ ...QC.cur }); QC.ps.length = QC.guide.length; for (const i of [...QC.sel]) if (i >= QC.guide.length) QC.sel.delete(i); return QC.ps; }
function qcResetPoints() { QC.ps = QC.guide.map(() => ({ ...QC.cur })); QC.sel.clear(); qcPointUI(); }
// the point settings fields show the picked points' settings, or (none picked) what new points get
function qcPointUI() {
  const ps = qcPS(), sel = [...QC.sel].sort((a, b) => a - b), src = sel.length ? ps[sel[0]] : QC.cur;
  $('#qc_pwho').textContent = sel.length ? (sel.length === 1 ? `point ${sel[0] + 1} picked` : `${sel.length} points picked`) : 'settings for new points';
  qv('pw').value = src.w ?? ''; qv('pfence').value = src.fence || 'none'; qv('pglide').checked = !!src.glide; qv('parch').value = src.arch ?? 15;
  qv('ppanel').checked = src.panel !== false; qv('pprops').checked = !!src.props; $('#qc_pglideopts').style.opacity = src.glide ? '' : '.5';
}
function qcPointSet(key, v) {
  const ps = qcPS();
  if (QC.sel.size) for (const i of QC.sel) ps[i][key] = v; else QC.cur[key] = v;
  qcPointUI(); drawGuide(); qcPreview();
}
function drawGuide() {
  QC.drawGroup.clear();
  const m = new THREE.MeshBasicMaterial({ color: 0xffe14a });
  const ms = new THREE.MeshBasicMaterial({ color: 0x38e8ff });
  QC.guide.forEach((p, i) => { const s = new THREE.Mesh(GEO.point, QC.sel.has(i) ? ms : i === 0 ? new THREE.MeshBasicMaterial({ color: 0xffffff }) : m); s.position.copy(p); s.scale.setScalar(QC.sel.has(i) ? 2.2 : 1.6); s.userData.guide = i; QC.drawGroup.add(s); });
  if (QC.guide.length > 1) QC.drawGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(QC.closed && QC.guide.length > 2 ? [...QC.guide, QC.guide[0]] : QC.guide), new THREE.LineDashedMaterial({ color: 0xffe14a, dashSize: 4, gapSize: 3 })).computeLineDistances());
  $('#qc_count').textContent = QC.guide.length ? `${QC.guide.length} guide points` : 'no guide yet';
}
function qcStartDraw() {
  if (!S.doc && !TC.active) return toast('Open a course first.');
  QC.drawing = true; QC.guide = []; QC.ps = []; QC.sel.clear(); qcPointUI(); gizmo.detach(); drawGuide(); qcPreview();
  $('#qc_draw').classList.add('hot'); $('#qc_draw').textContent = 'Done drawing'; $('#qcpanel').classList.add('drawing');
}
function qcFinishDraw() {
  if (QC.mode === 'kit') { QC.mode = null; QC.drawing = false; const g = QC.guide.slice(); QC.guide = []; drawGuide(); tcLineDone(g); return; }
  if (QC.mode === 'tcbranch') { QC.mode = null; QC.drawing = false; const g = QC.guide.slice(); QC.guide = []; drawGuide(); tcBranchDone(g); return; }
  if (QC.mode === 'branch') { QC.mode = null; QC.drawing = false; const from = QC.branchFrom, guide = QC.guide.slice(); QC.guide = []; drawGuide(); const to = guide.length > 1 ? nearestPathPoint(guide[guide.length - 1], from.rail.Name, new Set(), 25) : null; if (to && to !== from) guide[guide.length - 1] = to.mesh.position.clone(); makeBranch(from, to && to !== from ? to : null, guide); return; }
  QC.drawing = false; $('#qcpanel').classList.remove('drawing'); $('#qc_draw').classList.remove('hot'); $('#qc_draw').textContent = 'Draw guide'; qcPreview(); refreshSelection(); }
function qcCancelDraw() { if (QC.mode === 'tcbranch') { QC.mode = null; QC.drawing = false; QC.guide = []; QC.closed = QC.closedWas ?? QC.closed; drawGuide(); tcBranchUI(); return; } if (QC.mode === 'kit') { QC.mode = null; QC.drawing = false; QC.guide = []; drawGuide(); tcRefresh(); return; } if (QC.mode === 'branch') { QC.mode = null; QC.drawing = false; QC.guide = []; drawGuide(); refreshSelection(); return; } QC.guide = []; qcFinishDraw(); drawGuide(); }

// the course's existing lap path, followed rail to rail through its links, starting at the start line
function lapChain() {
  const rails = (S.doc?.Rails || []).filter(r => r.Name === 'LapPathGraph' && r.Points?.length);
  if (!rails.length) return null;
  const where = new Map(); rails.forEach(r => r.Points.forEach((p, i) => where.set(hashKey(p.Hash), [r, i])));
  let start = null; for (const r of rails) r.Points.forEach((p, i) => { if (p.Dynamic?.IsStart === true) start = [r, i]; });
  if (!start) start = [rails[0], 0];
  const pts = [], widths = [], seen = new Set(); let [r, i] = start, closed = false;
  for (let guard = 0; guard < 10000; guard++) {
    const p = r.Points[i], key = hashKey(p.Hash);
    if (seen.has(key)) { closed = key === hashKey(start[0].Points[start[1]].Hash); break; }
    seen.add(key); pts.push(vec(p.Translation)); if (p.RectSize) widths.push(p.RectSize[0]);
    if (i + 1 < r.Points.length) { i++; continue; }
    const next = (p.Links || []).map(l => where.get(hashKey(l.Dst))).find(Boolean);
    if (!next) break; [r, i] = next;
  }
  return { pts, closed, width: widths.length ? widths.reduce((a, b) => a + b) / widths.length : null };
}
function qcUseLap() {
  const c = lapChain(); if (!c || c.pts.length < 2) return toast('This course has no lap path to follow. Draw a guide instead.', 'err');
  QC.guide = c.pts; qcResetPoints(); QC.closed = c.closed; qv('closed').checked = c.closed; if (c.width) qv('width').value = Math.round(c.width);
  drawGuide(); qcPreview(); toast(`Following the course's lap path: ${c.pts.length} points${c.closed ? ', a full loop' : ''}.`);
}
function qcUseSelected() {
  const it = [...S.sel].map(id => S.items.get(id)).find(it => it?.kind === 'point');
  if (!it) return toast('Select a point on a path first (click one of the small spheres).');
  QC.guide = it.rail.Points.map(p => vec(p.Translation)); qcResetPoints();
  const last = it.rail.Points[it.rail.Points.length - 1];
  QC.closed = !!it.rail.IsClosed || (last.Links || []).some(l => hashKey(l.Dst) === hashKey(it.rail.Points[0].Hash));
  qv('closed').checked = QC.closed; drawGuide(); qcPreview();
}

// sample the guide into evenly spaced frames: position, forward, sideways, yaw, and which guide point's stretch it's in
function qcFrames(spacing) {
  if (QC.guide.length < 2) return null;
  const closed = QC.closed && QC.guide.length > 2, N = QC.guide.length, segs = closed ? N : N - 1;
  const curve = new THREE.CatmullRomCurve3(QC.guide.map(p => p.clone()), closed, 'centripetal');
  curve.arcLengthDivisions = Math.max(200, N * 60);
  const L = curve.getLength(), n = Math.max(2, Math.round(L / spacing)), lens = curve.getLengths(), D = lens.length - 1;
  const gu = QC.guide.map((_, i) => lens[Math.round(i / segs * D)] / L); if (closed) gu.push(1);   // where each guide point is (0..1 along)
  const segAt = u => { let i = 0; while (i + 1 < segs && gu[i + 1] <= u) i++; const f = Math.min(1, Math.max(0, (u - gu[i]) / Math.max(1e-9, gu[i + 1] - gu[i]))); return [i, f]; };
  const frames = [];
  const at = u => {
    const uu = closed ? ((u % 1) + 1) % 1 : Math.min(1, Math.max(0, u)), p = curve.getPointAt(uu), t = curve.getTangentAt(uu);
    const f = new THREE.Vector3(t.x, 0, t.z).normalize(), side = new THREE.Vector3(-f.z, 0, f.x);
    const [seg, sf] = segAt(uu);
    return { p, f, side, yaw: Math.atan2(f.x, f.z), seg, sf, u: uu };
  };
  for (let i = 0; i < (closed ? n : n + 1); i++) frames.push(at(i / n));
  return { frames, L, closed, at, curve, gu, segs, next: i => (i + 1) % N };
}

// fences: the game's own pieces, 20 m long, running from their origin along their -Z (their face, -X, toward the road)
const FENCE_LEN = 20;
// floating guides (no ground under them): name ({LR} = which way the arrow points), height over the road, spacing
const FLOAT_GUIDES = {
  'float:BannerFlag': { name: 'CmnObj_ArrowPropellerBannerFlag000_{LR}_00', lift: 4.5, every: 22 },
  'float:Electric': { name: 'CmnObj_ArrowPropellerElectric000_{LR}_00', lift: 4.5, every: 22 },
  'float:Cloud': { name: 'CmnObj_ArrowJugemCloud000_{LR}_00', lift: 4, every: 22 },
  'float:Barrier': { name: 'CmnObj_FloatingBarrier000_A_00', lift: 1.5, every: 20 },
};
function qcPlan() {
  const sp = Math.max(4, qnum('spacing') || 25), width = Math.max(4, qnum('width') || 30);
  const F = qcFrames(sp); if (!F) return null;
  const ps = qcPS(), W = i => ps[i]?.w ?? width;
  const wAt = fr => W(fr.seg) + (W(F.next(fr.seg)) - W(fr.seg)) * fr.sf;   // road width there: blends point to point
  const lift = fr => ps[fr.seg]?.glide ? (ps[fr.seg].arch ?? 15) * Math.sin(Math.PI * fr.sf) : 0;   // up in a glide's arch
  for (const fr of F.frames) fr.w = wAt(fr);
  const plan = { lap: [], routes: [], items: [], starts: [], closed: F.closed, width, deco: [], fenceCol: [], glides: [], panels: [], routePct: Math.min(100, Math.max(5, qnum('routePct') || 40)) };
  if (qv('doLap').checked) plan.lap = F.frames.map((fr, i) => ({ ...fr, cp: i > 0 && i % Math.max(1, qnum('cpEvery') || 4) === 0, start: i === 0 }));
  if (qv('doRoute').checked) {
    const lanes = Math.max(1, Math.min(5, qnum('lanes') || 1));
    for (let l = 0; l < lanes; l++) {
      plan.routes.push(F.frames.map(fr => { const off = lanes === 1 ? 0 : (l / (lanes - 1) - 0.5) * fr.w * 0.5;
        return { ...fr, p: fr.p.clone().addScaledVector(fr.side, off), w: Math.max(2, fr.w * plan.routePct / 100 / lanes) }; }));
    }
  }
  if (qv('doItems').checked) {
    const every = Math.max(20, qnum('itemEvery') || 250), per = Math.max(1, Math.min(8, qnum('itemPer') || 4)), first = Math.max(0, qnum('itemFirst') || 0);
    for (let s = first; s < F.L - (F.closed ? 40 : 0); s += every) {
      const fr = F.at(s / F.L), across = wAt(fr) * 0.6;
      for (let k = 0; k < per; k++) {
        const off = per === 1 ? 0 : (k / (per - 1) - 0.5) * across;
        plan.items.push({ p: fr.p.clone().addScaledVector(fr.side, off).add(new THREE.Vector3(0, 1.6, 0)), yaw: fr.yaw, fr });
      }
    }
  }
  if (qv('doStart').checked) {
    const count = Math.max(1, Math.min(24, qnum('startCount') || 24)), cols = 4, gap = 9;
    for (let i = 0; i < count; i++) {
      const col = i % cols, row = Math.floor(i / cols), back = 6 + row * gap + col * 2.2;
      let fr;
      if (F.closed) fr = F.at(1 - back / F.L);
      else { const f0 = F.at(0); fr = { ...f0, p: f0.p.clone().addScaledVector(f0.f, -back) }; }
      const off = (col - (cols - 1) / 2) * wAt(fr) * 0.18;
      plan.starts.push({ p: fr.p.clone().addScaledVector(fr.side, off), yaw: fr.yaw, id: i });
    }
  }
  // a snap far from the guide's own height is the wrong surface (e.g. the ground under a jump): keep the guide's height there
  const snap = snapOn(), put = (p, up) => { if (!snap) return; const g = groundAt(p.x, p.z, p.y); if (g !== null && (!TC.active || Math.abs(g - p.y) < 15)) p.y = g + up; };
  plan.lap.forEach(f => { f.p = f.p.clone(); put(f.p, 0); f.p.y += lift(f); });
  plan.routes.forEach(r => r.forEach(f => { put(f.p, 0); f.p.y += lift(f); }));
  plan.items.forEach(b => { put(b.p, 1.6); b.p.y += lift(b.fr); delete b.fr; });
  plan.starts.forEach(b => put(b.p, 0));

  // the stretches between guide points, finely sampled: [{ p, f, side, yaw, seg, sf, w }]
  const stretch = (i, step = 2) => { const u0 = F.gu[i], u1 = F.gu[i + 1], k = Math.max(2, Math.ceil((u1 - u0) * F.L / step)), out = [];
    for (let j = 0; j <= k; j++) { const fr = F.at(u0 + (u1 - u0) * j / k); fr.w = wAt(fr); out.push(fr); } return out; };
  // fences: one run per side over neighbouring stretches that have them (not over a glide's gap)
  const fname = qv('fencekind').value || 'CmnObj_Guardrail001_A_00';
  for (const side of ['left', 'right']) {
    const has = i => !ps[i]?.glide && (ps[i]?.fence === side || ps[i]?.fence === 'both');
    const runs = []; let cur = null;
    for (let i = 0; i < F.segs; i++) { if (has(i)) { if (!cur) runs.push(cur = []); cur.push(i); } else cur = null; }
    if (F.closed && runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1].at(-1) === F.segs - 1) runs[0] = [...runs.pop(), ...runs[0]];
    const sgn = side === 'right' ? 1 : -1;   // fr.side points to your right as you drive
    for (const run of runs) {
      const edge = []; for (const i of run) { const st = stretch(i); (edge.length ? st.slice(1) : st).forEach(fr => { const q = fr.p.clone().addScaledVector(fr.side, sgn * (fr.w / 2 + 1)); q.y = fr.p.y; put(q, 0); edge.push(q); }); }
      const cum = [0]; for (let k = 1; k < edge.length; k++) cum.push(cum[k - 1] + Math.hypot(edge[k].x - edge[k - 1].x, edge[k].z - edge[k - 1].z));
      const total = cum.at(-1), pAt = d => { let k = 1; while (k < cum.length - 1 && cum[k] < d) k++; const t = Math.min(1, Math.max(0, (d - cum[k - 1]) / Math.max(1e-6, cum[k] - cum[k - 1]))); return edge[k - 1].clone().lerp(edge[k], t); };
      const fl = FLOAT_GUIDES[fname];
      if (fl) {   // floating guides: a set height over the road's surface (never down on the ground, so slopes can't swallow them)
        const n = Math.max(1, Math.round(total / fl.every)), head = d => { const a = pAt(Math.max(0, d - 1)), b = pAt(Math.min(total, d + 1)); return b.clone().sub(a).setY(0).normalize(); };
        for (let k = 0; k < n; k++) {
          const d = (k + 0.5) * total / n, q = pAt(d).clone(), f0 = head(d), f1 = head(Math.min(total, d + 35));
          q.y += fl.lift;
          const turn = Math.atan2(f0.x * f1.z - f0.z * f1.x, f0.dot(f1)) * 180 / Math.PI;   // + : to the right
          const lr = Math.abs(turn) < 12 ? (side === 'right' ? 'L' : 'R') : turn > 0 ? 'R' : 'L';   // the way the road goes (on a straight: in toward it)
          plan.deco.push({ name: fl.name.replace('{LR}', lr), p: q, yaw: Math.atan2(f0.x, f0.z) + Math.PI, float: true });
        }
        continue;
      }
      const n = Math.max(1, Math.round(total / FENCE_LEN));
      for (let k = 0; k < n; k++) {
        const a = pAt(k * total / n), b = pAt((k + 1) * total / n), dir = b.clone().sub(a).setY(0).normalize(), end = a.clone().addScaledVector(dir, FENCE_LEN);
        end.y = b.y;
        const [o, e] = side === 'right' ? [a, end] : [end, a];   // the face toward the road: left-side pieces run backwards
        plan.deco.push({ name: fname, p: o, yaw: Math.atan2(e.x - o.x, e.z - o.z) + Math.PI, fence: true });
        plan.fenceCol.push([o.clone(), e.clone()]);
      }
    }
  }
  // glides: an arch from the point to the next one, a glide panel where it starts, arrow signs either side
  const pkind = qv('propkind').value || 'BannerFlag000';
  for (let i = 0; i < F.segs; i++) {
    if (!ps[i]?.glide) continue;
    const st = stretch(i, 4), len = (F.gu[i + 1] - F.gu[i]) * F.L, h = ps[i].arch ?? 15, base = st.map(fr => { const q = fr.p.clone(); put(q, 0); return q; });
    const steps = Math.max(4, Math.round(len / 20)), path = [];
    for (let j = 0; j <= steps; j++) { const k = Math.round(j / steps * (st.length - 1)), fr = st[k];
      path.push({ p: base[k].clone().add(new THREE.Vector3(0, h * Math.sin(Math.PI * k / (st.length - 1)) + 1.5, 0)), yaw: fr.yaw, rs: [Math.round(Math.min(fr.w + 20, 25 + len * j / steps * 0.3)), Math.round(Math.min(40, 20 + len * j / steps * 0.12))] }); }
    plan.glides.push(path);
    const s0 = st[0];
    if (ps[i].panel !== false) plan.panels.push({ p: base[0].clone().addScaledVector(s0.f, -4.1), yaw: s0.yaw });
    if (ps[i].props) {
      // which way the road goes after landing: the signs point that way, on the outside of the turn (both sides when it's straight)
      const after = F.at(Math.min(F.closed ? F.gu[i + 1] + 40 / F.L : 1, F.gu[i + 1] + 40 / F.L)), endF = st.at(-1).f;
      const turn = Math.atan2(endF.x * after.f.z - endF.z * after.f.x, endF.dot(after.f)) * 180 / Math.PI;   // + : to the right (fr.side's way)
      const signs = Math.abs(turn) < 15 ? [[1, 'L'], [-1, 'R']] : turn > 0 ? [[-1, 'R']] : [[1, 'L']];
      for (const t of [0.3, 0.65]) {
        const k = Math.round(t * (st.length - 1)), fr = st[k], y = base[k].y + h * Math.sin(Math.PI * t) + 8;
        for (const [sg, lr] of signs) { const q = base[k].clone().addScaledVector(fr.side, sg * (fr.w / 2 + 5)); q.y = y;
          plan.deco.push({ name: `CmnObj_ArrowPropeller${pkind}_${lr}_00`, p: q, yaw: fr.yaw + Math.PI }); }
      }
    }
  }
  return plan;
}
function qcPreview() {
  QC.ghost.clear();
  if ((!S.doc && !TC.active) || !$('#qcpanel').open) return;
  const plan = qcPlan(); if (!plan) { $('#qc_sum').textContent = 'Draw a guide or pick one to see a preview.'; return; }
  const line = (pts, color, loop) => { if (pts.length > 1) QC.ghost.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop ? [...pts, pts[0]] : pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }))); };
  if (plan.lap.length) {
    line(plan.lap.map(f => f.p), 0x3ddc84, plan.closed);
    line(plan.lap.map(f => f.p.clone().addScaledVector(f.side, -f.w / 2)), 0x7dffb0, plan.closed);
    line(plan.lap.map(f => f.p.clone().addScaledVector(f.side, f.w / 2)), 0x7dffb0, plan.closed);
    plan.lap.forEach(f => { if (f.cp || f.start) line([f.p.clone().addScaledVector(f.side, -f.w / 2), f.p.clone().addScaledVector(f.side, f.w / 2)], f.start ? 0xffffff : 0x3ddc84); });
  }
  plan.routes.forEach(r => { line(r.map(f => f.p), 0x4aa3ff, plan.closed); line(r.map(f => f.p.clone().addScaledVector(f.side, -f.w / 2)), 0x2a6fb8, plan.closed); line(r.map(f => f.p.clone().addScaledVector(f.side, f.w / 2)), 0x2a6fb8, plan.closed); });
  qcDecoPreview(QC.ghost, plan.fenceCol.map(([a, b]) => [a, b]), plan.glides.map(g => g.map(n => n.p)), plan.deco.filter(d => !d.fence).map(d => d.p), plan.panels.map(b => [b.p, b.yaw]));
  const gm = new THREE.MeshBasicMaterial({ color: 0xf5c542, transparent: true, opacity: 0.8 }), sm = new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.8 });
  plan.items.forEach(b => { const m = new THREE.Mesh(GEO.box, gm); m.position.copy(b.p); m.rotation.y = b.yaw; QC.ghost.add(m); });
  plan.starts.forEach(b => { const m = new THREE.Mesh(GEO.cone, sm); m.position.copy(b.p); m.rotation.set(0, b.yaw, 0, 'ZYX'); QC.ghost.add(m); });
  $('#qc_sum').textContent = qcSummary(plan);
}
const qcSummary = plan => [plan.lap.length && `lap path ${plan.lap.length} points (${plan.lap.filter(f => f.cp).length} checkpoints)`, plan.routes.length && `${plan.routes.length} CPU route${plan.routes.length > 1 ? 's' : ''}`, plan.items.length && `${plan.items.length} item boxes`, plan.starts.length && `${plan.starts.length} start spots`,
  plan.fenceCol?.length && `${plan.fenceCol.length} fence pieces`, plan.deco?.some(d => d.float) && `${plan.deco.filter(d => d.float).length} floating guides`, plan.glides?.length && `${plan.glides.length} glide${plan.glides.length > 1 ? 's' : ''}`, plan.deco?.some(d => !d.fence && !d.float) && `${plan.deco.filter(d => !d.fence && !d.float).length} arrow signs`].filter(Boolean).join(' · ') || 'Nothing ticked.';
// fences (orange, with posts), glide arches (light blue), arrow signs (pink), glide panels (blue)
function qcDecoPreview(group, fences, glides, signs, panels) {
  const seg = (pts, color) => { if (pts.length) group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }))); };
  const V = a => a.isVector3 ? a : new THREE.Vector3(...a), up = (v, h) => V(v).clone().add(new THREE.Vector3(0, h, 0));
  const fp = []; for (const [a, b] of fences) { fp.push(up(a, 1.2), up(b, 1.2), up(a, 0.6), up(b, 0.6), up(a, 0), up(a, 1.3)); } seg(fp, 0xff9a3d);
  const gp = []; for (const g of glides) for (let i = 1; i < g.length; i++) gp.push(V(g[i - 1]), V(g[i])); seg(gp, 0x5fd3ff);
  const sm = new THREE.MeshBasicMaterial({ color: 0xff6ad5 }); for (const p of signs) { const m = new THREE.Mesh(GEO.box, sm); m.position.copy(V(p)); m.scale.set(0.6, 0.6, 0.15); group.add(m); }
  const pm = new THREE.MeshBasicMaterial({ color: 0x3a7bff }); for (const [p, yaw] of panels) { const m = new THREE.Mesh(GEO.box, pm); m.position.copy(V(p)); m.rotation.y = yaw; m.scale.set(0.8, 0.05, 0.6); group.add(m); }
}

// just the edge guides (floating arrows and barriers, fences): added to what's there, everything else left as it is
function qcGuidesOnly(plan) {
  const deco = plan.deco.filter(d => d.float || d.fence);
  return deco.length ? { ...plan, lap: [], routes: [], items: [], starts: [], glides: [], panels: [], deco, fenceCol: plan.fenceCol, guidesOnly: true } : null;
}
function qcCreate(onlyGuides) {
  onlyGuides = onlyGuides === true;
  let plan = qcPlan(); if (!plan) return toast(TC.active ? 'Draw a guide along your road first.' : 'Draw a guide first, or use the lap path.', 'err');
  if (onlyGuides) { plan = qcGuidesOnly(plan); if (!plan) return toast('No edge guides here: pick points and set their Edge guides (left, right or both) first.', 'err'); }
  if (TC.active) return onlyGuides ? tcAddGuides(plan) : tcApplyQC(plan);
  if (!S.doc) return;
  pushUndo();
  const d = S.doc; d.Rails = d.Rails || []; d.Actors = d.Actors || [];
  // templates from this course when it has them, so new things carry the same fields as the game's own
  const tplRail = n => d.Rails.find(r => r.Name === n);
  const tplActor = re => d.Actors.find(a => re.test(a.Name || ''));
  const lapT = tplRail('LapPathGraph'), routeT = tplRail('RoutePathGraph');
  const itemT = tplActor(/^CmnObj_ItemBox000_A/) || tplActor(/ItemBox/), startT = tplActor(/^StartPosition$/);
  const linkGy = (() => { for (const r of d.Rails) for (const p of r.Points) for (const l of p.Links || []) return l.Gyaml; return GY.link; })();
  // clear out what's being replaced
  const gone = new Set();
  const dropRails = name => d.Rails = d.Rails.filter(r => { if (r.Name !== name) return true; gone.add(hashKey(r.Hash)); r.Points.forEach(p => gone.add(hashKey(p.Hash))); return false; });
  const dropActors = re => d.Actors = d.Actors.filter(a => { if (!re.test(a.Name || '')) return true; gone.add(hashKey(a.Hash)); return false; });
  if (plan.lap.length && qv('repLap').checked) dropRails('LapPathGraph');
  if (plan.routes.length && qv('repRoute').checked) dropRails('RoutePathGraph');
  if (plan.items.length && qv('repItems').checked) dropActors(/ItemBox/);
  if (plan.starts.length && qv('repStart').checked) dropActors(/^StartPosition$/);
  const scrub = o => { if (o.Links) { o.Links = o.Links.filter(l => !gone.has(hashKey(l.Dst))); if (!o.Links.length) delete o.Links; } };
  d.Actors.forEach(scrub); d.Rails.forEach(r => r.Points.forEach(scrub));

  const P3 = v => [f32(v.x), f32(v.y), f32(v.z)];
  const newHashes = [];
  const makeRail = (name, gyaml, frames, w, extra) => {
    const rail = { Gyaml: gyaml, Hash: T.u64(rand64()), InstanceId: uuid(), IsClosed: false, Name: name, Points: [] };
    for (const f of frames) {
      const pt = { Gyaml: gyaml, Hash: T.u64(rand64()), InstanceId: uuid(), Name: name + '.Node', Parent: rail.Hash,
        RectOffset: [0, 10], RectSize: [f32(f.w ?? w), 20], Rotate: [0, f32(f.yaw), 0], Translation: P3(f.p) };
      extra?.(pt, f); rail.Points.push(pt);
    }
    d.Rails.push(rail); newHashes.push(hashKey(rail.Hash)); return rail;
  };
  const link = (from, to) => { (from.Links = from.Links || []).push({ Dst: to.Hash, Gyaml: linkGy, Name: 'BasicSignal', Src: from.Hash }); };
  if (plan.lap.length) {
    const gy = lapT?.Gyaml || GY.lap;
    const setLap = (pt, f) => { if (f.start) pt.Dynamic = { IsStart: true }; else if (f.cp) pt.Dynamic = { CheckPoint: 1.0 }; };
    if (plan.closed && plan.lap.length >= 4) {
      // like the game's own courses: the loop is two rails, each one's end linked to the other's start
      const mid = Math.floor(plan.lap.length / 2);
      const a = makeRail('LapPathGraph', gy, plan.lap.slice(0, mid), plan.width, setLap), b = makeRail('LapPathGraph', gy, plan.lap.slice(mid), plan.width, setLap);
      link(a.Points[a.Points.length - 1], b.Points[0]); link(b.Points[b.Points.length - 1], a.Points[0]);
    } else makeRail('LapPathGraph', gy, plan.lap, plan.width, setLap);
  }
  for (const r of plan.routes) {
    const rail = makeRail('RoutePathGraph', routeT?.Gyaml || GY.route, r, plan.width * plan.routePct / 100 / Math.max(1, plan.routes.length));
    if (plan.closed) link(rail.Points[rail.Points.length - 1], rail.Points[0]);   // the main route loops onto itself
  }
  const makeActor = (tpl, fallback, p, yaw) => {
    const a = tpl ? cloneVal(tpl) : fallback();
    delete a.Links; delete a.ParentPrefab; delete a.Scale; delete a.Bakeable;
    a.Hash = T.u64(rand64()); a.InstanceId = uuid(); a.SRTHash = T.u32(rand32()); a.IsGridify = false;
    a.Translate = P3(p); a.Rotate = [0, f32(yaw), 0];
    d.Actors.push(a); newHashes.push(hashKey(a.Hash)); return a;
  };
  for (const b of plan.items) makeActor(itemT, () => ({ Gyaml: GY.item, Name: 'CmnObj_ItemBox000_A_00' }), b.p, b.yaw);
  for (const s of plan.starts) {
    const a = makeActor(startT, () => ({ Gyaml: GY.start, Name: 'StartPosition', PrimitiveType: 'Cone' }), s.p, s.yaw);
    if (s.id === 0) delete a.Dynamic; else a.Dynamic = { StartPositionId: T.i32(s.id) };
  }
  const gyOf = name => tplActor(new RegExp('^' + name + '$'))?.Gyaml || `Work/Gyml/ActorGParam/${name}.gear__ActorGParam.gyml`;
  for (const o of plan.deco) makeActor(null, () => ({ Gyaml: gyOf(o.name), Name: o.name }), o.p, o.yaw);
  for (const b of plan.panels) makeActor(null, () => ({ Gyaml: gyOf('CmnObj_GlideBoard000_A_00'), Name: 'CmnObj_GlideBoard000_A_00' }), b.p, b.yaw);
  const glideGy = tplRail('GlidePath')?.Gyaml || 'Work/Gyml/GraphRailDefGParam/GlidePath.gear__GraphRailDefGParam.gyml';
  for (const g of plan.glides) makeRail('GlidePath', glideGy, g, 20, (pt, n) => { pt.RectSize = [f32(n.rs[0]), f32(n.rs[1])]; pt.RectOffset = [0, 0]; });
  QC.ghost.clear();
  afterStructureChange([]);
  toast((plan.guidesOnly ? `Added ${plan.deco.length} edge guides (nothing else changed).` : `Created: ${$('#qc_sum').textContent}.`) + ' Ctrl+Z undoes it all.' + (plan.panels.length ? ' (A glide panel added as an object only starts a glide if the course\'s collision has one there: on your own tracks, use Quick Create in the Track Creator, which builds it into the model.)' : ''), 'ok', 9000);
  $('#qcpanel').open = false; QC.drawGroup.clear(); QC.guide = []; drawGuide();
}

$('#quick').onclick = () => { const p = $('#qcpanel'); p.open = !p.open; if (p.open && TC.active && !TC.qc) qv('doStart').checked = true; if (p.open) { if (!QC.guide.length) drawGuide(); qcPreview(); } else { QC.ghost.clear(); if (QC.drawing) qcFinishDraw(); } };
$('#qc_draw').onclick = () => QC.drawing ? qcFinishDraw() : qcStartDraw();
$('#qc_lap').onclick = qcUseLap; $('#qc_sel').onclick = qcUseSelected;
$('#qc_clear').onclick = () => { QC.guide = []; qcResetPoints(); drawGuide(); qcPreview(); };
$('#qc_pall').onclick = () => { QC.sel = new Set(QC.guide.map((_, i) => i)); qcPointUI(); drawGuide(); };
$('#qc_pnone').onclick = () => { QC.sel.clear(); qcPointUI(); drawGuide(); };
qv('pw').onchange = () => qcPointSet('w', qv('pw').value === '' ? null : Math.max(4, +qv('pw').value));
qv('pfence').onchange = () => qcPointSet('fence', qv('pfence').value);
qv('pglide').onchange = () => qcPointSet('glide', qv('pglide').checked);
qv('parch').onchange = () => qcPointSet('arch', Math.max(2, +qv('parch').value || 15));
qv('ppanel').onchange = () => qcPointSet('panel', qv('ppanel').checked);
qv('pprops').onchange = () => qcPointSet('props', qv('pprops').checked);
qcPointUI();
$('#qc_create').onclick = () => qcCreate(false);
$('#qc_guides').onclick = () => qcCreate(true);
$('#qc_close').onclick = () => $('#quick').click();
$('#qcpanel').addEventListener('input', e => { if (/^qc_p(w|fence|glide|arch|panel|props)$/.test(e.target.id)) return; if (e.target.id === 'qc_closed') QC.closed = e.target.checked; drawGuide(); qcPreview(); });

// running inside the .exe: tell it the window is still open
if (location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  let mine = null, told = false;
  const ping = () => fetch('/__ping', { cache: 'no-store' }).then(r => {
    const v = r.headers.get('X-Mkwe-Version'); if (!v) return;
    if (mine === null) mine = v;
    else if (v !== mine) {   // a newer editor took over: switch this window to it
      if (!S.dirty) location.reload();
      else if (!told) { told = true; const b = $('#outdated'); b.style.display = 'flex'; }
    }
  }).catch(() => {});
  ping(); setInterval(ping, 5000);
}

// ---------------------------------------------------------------- branching routes
const pathPoint = it => it && it.kind === 'point';
function startBranchDraw(it) {
  QC.mode = 'branch'; QC.branchFrom = it; QC.drawing = true; QC.guide = [it.mesh.position.clone()];
  gizmo.detach(); drawGuide();
  toast(`Click where the new ${it.rail.Name} branch should go. Finish near another point of a ${it.rail.Name} path and it joins back there. Enter = done, Esc = cancel.`);
}
function nearestPathPoint(p, name, exclude, maxDist) {
  let best = null, bd = maxDist;
  for (const it of S.items.values()) {
    if (it.kind !== 'point' || it.rail.Name !== name || exclude.has(it.rail)) continue;
    const d = it.mesh.position.distanceTo(p); if (d < bd) { bd = d; best = it; }
  }
  return best;
}
// a new rail through `guide` (world points), linked from `from` and, if given, into `to`
function makeBranch(from, to, guide) {
  if (guide.length < 2) return toast('A branch needs at least one more point.', 'err');
  pushUndo();
  const tpl = from.data, rail0 = from.rail;
  const curve = new THREE.CatmullRomCurve3(guide.map(p => p.clone()), false, 'centripetal');
  const n = Math.max(2, Math.round(curve.getLength() / 20));
  const pts = []; for (let i = 1; i <= n; i++) pts.push(curve.getPointAt(i / n));
  if (to) pts.pop();   // the last sample is the join point itself
  if (!pts.length) pts.push(curve.getPointAt(0.5));
  const rail = { Gyaml: rail0.Gyaml, Hash: T.u64(rand64()), InstanceId: uuid(), IsClosed: false, Name: rail0.Name, Points: [] };
  pts.forEach((p, i) => {
    const nx = i + 1 < pts.length ? pts[i + 1] : (to ? to.mesh.position : p), pv = i ? pts[i - 1] : from.mesh.position;
    const dir = nx.clone().sub(pv); dir.y = 0;
    if (snapOn()) { const g = groundAt(p.x, p.z, p.y); if (g !== null) p.y = g; }
    rail.Points.push({ Gyaml: tpl.Gyaml, Hash: T.u64(rand64()), InstanceId: uuid(), Name: tpl.Name || rail0.Name + '.Node', Parent: rail.Hash,
      RectOffset: tpl.RectOffset ? tpl.RectOffset.slice() : [0, 10], RectSize: tpl.RectSize ? tpl.RectSize.slice() : [20, 20],
      Rotate: [0, f32(dir.lengthSq() ? Math.atan2(dir.x, dir.z) : 0), 0], Translation: [f32(p.x), f32(p.y), f32(p.z)] });
  });
  const linkGy = (() => { for (const r of S.doc.Rails) for (const p of r.Points) for (const l of p.Links || []) return l.Gyaml; return 'Work/Gyml/LinkDefGParam/BasicSignal.gear__LinkDefGParam.gyml'; })();
  const link = (a, b) => (a.Links = a.Links || []).push({ Dst: b.Hash, Gyaml: linkGy, Name: 'BasicSignal', Src: a.Hash });
  link(from.data, rail.Points[0]);
  if (to) link(rail.Points[rail.Points.length - 1], to.data);
  S.doc.Rails.push(rail);
  afterStructureChange(rail.Points.map(p => hashKey(p.Hash)));
  toast(to ? `Branch added: ${rail.Points.length} points, splitting off and joining back (pink lines show the links).` : `Branch added, but its end isn't joined to anything. Select its last point and a ${rail0.Name} point, then press "Link 1st → 2nd".`, to ? 'ok' : 'err');
}
function branchBetween(a, b) {
  const pa = a.mesh.position, pb = b.mesh.position, d = pb.clone().sub(pa); const len = Math.hypot(d.x, d.z);
  const side = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(Math.max(8, len * 0.25));
  const mid = pa.clone().add(pb).multiplyScalar(0.5).add(side);
  makeBranch(a, b, [pa.clone(), mid, pb.clone()]);
}
function linkSel(add) {
  const sel = [...S.sel].map(id => S.items.get(id)).filter(pathPoint);
  if (sel.length !== 2) return toast('Select exactly two path points (click one, Shift-click the other).');
  pushUndo();
  const [a, b] = sel;
  if (add) {
    if ((a.data.Links || []).some(l => hashKey(l.Dst) === hashKey(b.data.Hash))) return toast('Those are already linked.');
    const linkGy = (() => { for (const r of S.doc.Rails) for (const p of r.Points) for (const l of p.Links || []) return l.Gyaml; return 'Work/Gyml/LinkDefGParam/BasicSignal.gear__LinkDefGParam.gyml'; })();
    (a.data.Links = a.data.Links || []).push({ Dst: b.data.Hash, Gyaml: linkGy, Name: 'BasicSignal', Src: a.data.Hash });
  } else {
    for (const [x, y] of [[a, b], [b, a]]) if (x.data.Links) { x.data.Links = x.data.Links.filter(l => hashKey(l.Dst) !== hashKey(y.data.Hash)); if (!x.data.Links.length) delete x.data.Links; }
  }
  markDirty(); drawLinks(); fillInspector();
  toast(add ? 'Linked: the first point now leads on to the second.' : 'Unlinked.');
}

// ---------------------------------------------------------------- minimap generator
const MM = { sarc: null, sarcPath: null, sarcRaw: null, canvas: null, info: null };
const minimapName = path => 'MiniMap_' + path.split('/').pop().replace('.bcett.byml.zs', '').replace(/\[.*\]$/, '').replace(/^(Balloon|Coin)Battle_/, 'Battle_');
async function gymlArchive() {
  if (MM.sarc) return MM.sarc;
  const dir = await S.romfs.getDirectoryHandle('System').then(d => d.getDirectoryHandle('GymlArchive'));
  for await (const [n] of dir.entries()) if (/^general_format\.Product_\d+\.sarc\.zs$/.test(n)) MM.sarcPath = 'System/GymlArchive/' + n;
  if (!MM.sarcPath) throw new Error('general_format archive not found');
  const mine = S.extra.get(MM.sarcPath);
  MM.sarcRaw = mine ? zsDecompress(mine) : zsDecompress(await readAt(S.romfs, MM.sarcPath));
  MM.sarc = parseSarc(MM.sarcRaw);
  return MM.sarc;
}
// world -> minimap pixel transform from a MiniMapCourseGParam (race courses store it relative to their stage)
const mmDoc = () => MM.doc || S.doc;
async function minimapFrame(param, w, h) {
  const box = new THREE.Box3(); if (mmDoc().AABB) box.set(vec(mmDoc().AABB.Min), vec(mmDoc().AABB.Max));
  const c = box.getCenter(new THREE.Vector3());
  let pos = new THREE.Vector3(param.CamPos.X, 0, param.CamPos.Z), yaw = param.CamRot.Y * Math.PI / 180, parent = null;
  if (Math.hypot(pos.x - c.x, pos.z - c.z) > 1500) {
    const st = (await worldStages()).slice().sort((a, b) => Math.hypot(a.t[0] - c.x, a.t[2] - c.z) - Math.hypot(b.t[0] - c.x, b.t[2] - c.z))[0];
    if (st) {
      parent = new THREE.Object3D(); parent.position.set(...st.t); parent.rotation.set(st.r[0], st.r[1], st.r[2], 'ZYX'); parent.updateMatrixWorld(true);
      pos = parent.localToWorld(pos.clone());
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(parent.quaternion); yaw += Math.atan2(f.x, f.z);
    }
  }
  return { pos, yaw, size: param.CamSizeX, w, h, parent };
}
function project(fr, p) {
  const rx = Math.cos(fr.yaw), rz = -Math.sin(fr.yaw), ux = -Math.sin(fr.yaw), uz = -Math.cos(fr.yaw), s = fr.w / fr.size;
  const dx = p.x - fr.pos.x, dz = p.z - fr.pos.z;
  return [fr.w / 2 + (dx * rx + dz * rz) * s, fr.h / 2 - (dx * ux + dz * uz) * s];
}
// the rails to draw, each as a list of points, with link-joined ends bridged
function lapStrokes(names) {
  const rails = (mmDoc().Rails || []).filter(r => names.includes(r.Name) && r.Points?.length);
  const where = new Map(); rails.forEach(r => r.Points.forEach(p => where.set(hashKey(p.Hash), p)));
  const strokes = [];
  for (const r of rails) {
    const pts = r.Points.slice();
    const last = pts[pts.length - 1];
    for (const l of last.Links || []) { const t = where.get(hashKey(l.Dst)); if (t) { strokes.push({ pts: [...pts, t], lap: r.Name === 'LapPathGraph' }); pts.length = 0; break; } }
    if (pts.length) strokes.push({ pts, lap: r.Name === 'LapPathGraph' });
    // a branch leaving from the middle of another rail
    for (const p of r.Points) for (const l of p.Links || []) { const t = where.get(hashKey(l.Dst)); if (t && p !== last) strokes.push({ pts: [p, t], lap: r.Name === 'LapPathGraph' }); }
    if (r.IsClosed) strokes.push({ pts: [last, r.Points[0]], lap: r.Name === 'LapPathGraph' });
  }
  return strokes;
}
// the track's model (or another model) drawn from straight above with the minimap's framing, on a clear background.
// MM.place: the matrix from the Track Creator's coordinates to the course's (the slot's start, or the track's open-world spot)
let mmGL = null;
function mmModelGroup(opt) {
  const grp = new THREE.Group(), xf = makeXform(tcPlace());
  const texOf = (model, own) => n => { if (!opt.tex) return null; const c = own ? tcTexCanvas(n) : model.tex.get(n)?.image; return c ? tcPreviewTex(c) : null; };
  if (opt.src === 'file') { if (TC.mmModel) grp.add(previewMesh(TC.mmModel.model, xf, () => 0xbbbbbb, { tex: texOf(TC.mmModel.model, false) })); }
  else if (tcImporting()) { if (TC.vis) grp.add(previewMesh(tcVisOnly(tcVM()), xf, n => SLOT_COLOR[TC.map.slot[n] || 'floorparts'] ?? 0x999999, { tex: texOf(tcVM(), true) })); }
  else for (const m of TC.preview.children) if (m.userData.mmTrack) grp.add(new THREE.Mesh(m.geometry, m.material));
  return grp;
}
function mmModelLayer(fr, opt) {
  const grp = mmModelGroup(opt); if (!grp.children.length) return null;
  if (!mmGL) { mmGL = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true, antialias: true, preserveDrawingBuffer: true }); mmGL.outputColorSpace = THREE.SRGBColorSpace; }
  mmGL.setPixelRatio(1); mmGL.setSize(fr.w, fr.h, false); mmGL.setClearColor(0x000000, 0);
  const scene = new THREE.Scene(), holder = new THREE.Group(); holder.matrixAutoUpdate = false; holder.matrix.copy(MM.place || new THREE.Matrix4()); holder.add(grp); scene.add(holder);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6)); const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-0.5, 1, -0.3); scene.add(sun);
  // unlit: the minimap shows the textures' own colours (lit, it came out dark in game)
  grp.traverse(m => { if (m.isMesh) { const o = m.material; m.material = new THREE.MeshBasicMaterial({ map: o.map || null, color: o.map ? 0xffffff : (o.color || new THREE.Color(0x999999)), side: THREE.DoubleSide }); } });
  if (!opt.tex) scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: opt.pathToo ? new THREE.Color(opt.color).multiplyScalar(0.8) : opt.color, side: THREE.DoubleSide });   // darker under the road, so the road shows
  const hw = fr.size / 2, hh = hw * fr.h / fr.w, cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 1, 200000);
  cam.position.set(fr.pos.x, 100000, fr.pos.z); cam.up.set(-Math.sin(fr.yaw), 0, -Math.cos(fr.yaw)); cam.lookAt(fr.pos.x, 0, fr.pos.z); cam.updateMatrixWorld(true);
  mmGL.render(scene, cam);
  const out = document.createElement('canvas'); out.width = fr.w; out.height = fr.h; const og = out.getContext('2d'); og.drawImage(mmGL.domElement, 0, 0);
  // the game's minimap textures are greyscale (it keeps only the brightness), so show it that way here, and stretch the
  // brightness up to the range the game's own minimaps use: dark textures (grass, rock) otherwise come out murky
  const im = og.getImageData(0, 0, fr.w, fr.h), d = im.data, L = [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8) L.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  if (L.length && opt.tex) {
    L.sort((a, b) => a - b); const lo0 = L[Math.floor(L.length * 0.01)], hi0 = L[Math.floor(L.length * 0.99)], flat = hi0 - lo0 < 24, lo = flat ? lo0 - 1000 : lo0, hi = flat ? lo0 + 1 : hi0;   // one flat colour (a model without textures): as bright as the game's roads
    for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2], v = Math.round(255 * (0.72 + 0.28 * Math.max(0, Math.min(1, (l - lo) / (hi - lo))))); d[i] = d[i + 1] = d[i + 2] = v; }
    og.putImageData(im, 0, 0);
  }
  return out;
}
function mmSrcUI() {
  const v = $('#mm_src').value;
  $('#mm_texrow').style.display = $('#mm_pathrow').style.display = v === 'path' ? 'none' : '';
  $('#mm_file').textContent = TC.mmModel ? TC.mmModel.name + (v === 'file' ? '' : ' (pick "An imported model" above to use it)') : '';
}
function renderMinimap(fr, opt) {
  const cv = document.createElement('canvas'); cv.width = fr.w; cv.height = fr.h;
  const g = cv.getContext('2d'), s = fr.w / fr.size;
  const layer = document.createElement('canvas'); layer.width = fr.w; layer.height = fr.h;
  const lg = layer.getContext('2d'); lg.lineCap = 'round'; lg.lineJoin = 'round';
  const strokes = lapStrokes(opt.routes ? ['LapPathGraph', 'RoutePathGraph'] : ['LapPathGraph']);
  const widthOf = p => Math.max(4, (p.RectSize?.[0] ?? 20) * s * opt.width);
  const pass = (color, extra) => {
    lg.strokeStyle = color;
    for (const st of strokes) for (let i = 1; i < st.pts.length; i++) {
      const a = project(fr, vec(st.pts[i - 1].Translation)), b = project(fr, vec(st.pts[i].Translation));
      lg.lineWidth = ((widthOf(st.pts[i - 1]) + widthOf(st.pts[i])) / 2) * (st.lap ? 1 : 0.6) + extra;
      lg.beginPath(); lg.moveTo(a[0], a[1]); lg.lineTo(b[0], b[1]); lg.stroke();
    }
  };
  const model = opt.src && opt.src !== 'path' ? mmModelLayer(fr, opt) : null;
  if (model) {
    // the model seen from above; the outline is its silhouette grown by a few pixels
    if (opt.outline) {
      const sil = document.createElement('canvas'); sil.width = fr.w; sil.height = fr.h; const sg = sil.getContext('2d');
      sg.drawImage(model, 0, 0); sg.globalCompositeOperation = 'source-in'; sg.fillStyle = opt.outlineColor; sg.fillRect(0, 0, fr.w, fr.h);
      const r = Math.max(2, Math.round(fr.w / 170)); for (let a = 0; a < 16; a++) lg.drawImage(sil, Math.cos(a * Math.PI / 8) * r, Math.sin(a * Math.PI / 8) * r);
    }
    lg.drawImage(model, 0, 0);
    if (opt.pathToo) { if (opt.outline) pass(opt.outlineColor, 5); pass(opt.color, 0); }
  } else {
    if (opt.outline) pass(opt.outlineColor, 5);
    pass(opt.color, 0);
  }
  g.globalAlpha = model ? 1 : opt.opacity; g.drawImage(layer, 0, 0);
  return cv;
}
// best framing for the current lap paths: the yaw where the course fills the texture most
function fitFrame(fr) {
  const pts = []; for (const st of lapStrokes(['LapPathGraph'])) for (const p of st.pts) pts.push(vec(p.Translation));
  if (MM.fitExtra) pts.push(...MM.fitExtra);
  if (pts.length < 2) return fr;
  let best = null;
  for (let deg = 0; deg < 360; deg += 1) {
    const yaw = deg * Math.PI / 180, rx = Math.cos(yaw), rz = -Math.sin(yaw), ux = -Math.sin(yaw), uz = -Math.cos(yaw);
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const p of pts) { const u = p.x * rx + p.z * rz, v = p.x * ux + p.z * uz; a = Math.min(a, u); b = Math.max(b, u); c = Math.min(c, v); d = Math.max(d, v); }
    const size = Math.max((b - a) / fr.w, (d - c) / fr.h) * fr.w * 1.18 + 40;
    // prefer the game's own heading when it fits about as well
    const turn = Math.abs(Math.atan2(Math.sin(yaw - fr.yaw), Math.cos(yaw - fr.yaw)));
    const score = size * (1 + turn * 0.02);
    if (!best || score < best.score) {
      const cu = (a + b) / 2, cv2 = (c + d) / 2;
      best = { score, yaw, size, pos: new THREE.Vector3(cu * rx + cv2 * ux, 0, cu * rz + cv2 * uz) };
    }
  }
  return { ...fr, yaw: best.yaw, size: best.size, pos: best.pos };
}
async function openMinimap() {
  if (TC.active || S.customTrack) return tcOpenMinimap();
  if (!S.doc) return toast('Open a course first.');
  if (!S.romfs || S.romfs.fake) return toast('The minimap generator needs the whole RomFS folder (Open RomFS in the .exe).', 'err');
  const name = minimapName(S.path), texPath = `Layout/${name}.Nin_Ounce_NVN2.bntx.zs`;
  busy('Reading minimap settings…');
  try {
    const sarc = await gymlArchive();
    const key = `Gyml/MiniMapCourseGParam/${name}.game__MiniMapCourseGParam.bgyml`;
    if (!sarc.has(key)) throw new Error(`the game has no minimap settings for ${name}`);
    const tex = await readAt(S.romfs, texPath); if (!tex) throw new Error(`${texPath} not found`);
    const texRaw = zsDecompress(tex), info = bntxInfo(texRaw);
    const param = parseByml(sarc.get(key)).root;
    const game = await minimapFrame(param, info.width, info.height);
    MM.info = { name, key, texPath, texRaw, info, param, game };
    $('#mm_name').textContent = `${name} · ${info.width}×${info.height}`;
    $('#mmdlg').showModal(); drawMinimapPreview();
  } catch (e) { console.error(e); toast('Minimap: ' + e.message, 'err'); }
  busy();
}
function mmOptions() {
  return { color: $('#mm_color').value, outlineColor: $('#mm_outline').value, outline: $('#mm_doOutline').checked, opacity: +$('#mm_opacity').value / 100, width: +$('#mm_width').value / 100, routes: $('#mm_routes').checked, src: MM.info?.custom ? $('#mm_src').value : 'path', tex: $('#mm_tex').checked, pathToo: $('#mm_pathtoo').checked };
}
// the model's outline corners (in the course's coordinates), so re-framing fits the whole model and not just the lap path
function mmFitPts(opt) {
  if (!opt.src || opt.src === 'path') return null;
  const grp = mmModelGroup(opt); if (!grp.children.length) return null;
  const pts = []; grp.updateMatrixWorld(true);
  for (const m of grp.children.flatMap(c => c.isMesh ? [c] : c.children)) { const a = m.geometry.attributes.position; for (let i = 0; i < a.count; i += Math.max(1, Math.floor(a.count / 400))) pts.push(new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)).applyMatrix4(MM.place || new THREE.Matrix4())); }
  return pts;
}
function currentFrame() { MM.fitExtra = mmFitPts(mmOptions()); try { return $('#mm_fit').checked ? fitFrame(MM.info.game) : MM.info.game; } finally { MM.fitExtra = null; } }
function drawMinimapPreview() {
  if (!MM.info) return;
  const fr = currentFrame(); MM.canvas = renderMinimap(fr, mmOptions());
  const pv = $('#mm_preview'); pv.width = fr.w; pv.height = fr.h;
  const g = pv.getContext('2d'); g.clearRect(0, 0, fr.w, fr.h); g.drawImage(MM.canvas, 0, 0);
  // how much of the lap path ends up off the image
  let out = 0, n = 0; for (const st of lapStrokes(['LapPathGraph'])) for (const p of st.pts) { const [u, v] = project(fr, vec(p.Translation)); n++; if (u < 0 || v < 0 || u > fr.w || v > fr.h) out++; }
  $('#mm_warn').textContent = n && out ? `${out} of ${n} lap points fall outside the minimap. Tick "Re-frame to fit" to zoom out.` : '';
}
function addMinimapToMod() {
  if (MM.info.custom) { TC.mm = { opt: mmOptions(), fit: $('#mm_fit').checked }; tcSave(); $('#mmdlg').close(); return toast('Minimap set. It\'s drawn again every time you build the track, so it always matches.', 'ok'); }
  const { texPath, texRaw, info, key, param } = MM.info;
  const fr = currentFrame(), opt = mmOptions();
  const full = renderMinimap(fr, opt).getContext('2d').getImageData(0, 0, fr.w, fr.h).data;
  const levels = (l, w, h) => {
    if (l === 0) return full;
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(renderMinimap(fr, opt), 0, 0, w, h);
    return c.getContext('2d').getImageData(0, 0, w, h).data;
  };
  S.extra.set(texPath, zsStore(replaceBntxAstc(texRaw, levels)));
  let note = '';
  if ($('#mm_fit').checked) {
    // write the new framing into the game's minimap settings (same size, patched in place)
    const g = MM.info.game;
    let pos = fr.pos.clone(), yawDeg = fr.yaw * 180 / Math.PI;
    if (g.parent) { pos = g.parent.worldToLocal(pos.clone()); const f = new THREE.Vector3(0, 0, 1).applyQuaternion(g.parent.quaternion); yawDeg -= Math.atan2(f.x, f.z) * 180 / Math.PI; }
    yawDeg = ((yawDeg % 360) + 540) % 360 - 180;
    const p2 = cloneVal(param); p2.CamPos.X = f32(pos.x); p2.CamPos.Z = f32(pos.z); p2.CamRot.Y = f32(yawDeg); p2.CamSizeX = f32(fr.size);
    const old = MM.sarc.get(key), ver = parseByml(old).version, bytes = writeByml(p2, ver, false);
    const raw = patchSarcFile(MM.sarcRaw, old, bytes);
    MM.sarcRaw = raw; MM.sarc = parseSarc(raw);
    S.extra.set(MM.sarcPath, zsStore(raw));
    note = ' and its new framing';
  }
  S.dirty = true; updateStats(); $('#mmdlg').close();
  toast(`Minimap${note} added to the mod. It's written when you Save as mod. If you change the lap path again, generate it again.`, 'ok');
}
// replace one file of a SARC in place: it must fit in the room before the next file
function patchSarcFile(raw, oldView, bytes) {
  const out = raw.slice(), dv = new DataView(out.buffer);
  const hdr = dv.getUint16(4, true), dataOff = dv.getUint32(12, true), n = dv.getUint16(hdr + 6, true);
  const start = oldView.byteOffset - raw.byteOffset - dataOff;
  let entry = -1, next = raw.length - dataOff;
  for (let i = 0; i < n; i++) { const e = hdr + 12 + 16 * i, s = dv.getUint32(e + 8, true); if (s === start) entry = e; else if (s > start && s < next) next = s; }
  if (entry < 0) throw new Error('settings file not found in the archive');
  if (bytes.length > next - start) throw new Error('the new minimap settings are larger than the old ones');
  out.fill(0, dataOff + start, dataOff + next); out.set(bytes, dataOff + start);
  dv.setUint32(entry + 12, start + bytes.length, true);
  return out;
}

// the top bar scrolls sideways when the window is narrow; the mouse wheel scrolls it too
$('#top').addEventListener('wheel', e => { const t = $('#top'); if (t.scrollWidth > t.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.target.closest('select')) { t.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

// arrows at the ends of the top bar while it doesn't fit; hold to keep scrolling
{
  const t = $('#top'), L = $('#navL'), R = $('#navR');
  const upd = () => { L.classList.toggle('show', t.scrollLeft > 2); R.classList.toggle('show', t.scrollLeft + t.clientWidth < t.scrollWidth - 2); };
  t.addEventListener('scroll', upd); new ResizeObserver(upd).observe(t); window.addEventListener('resize', upd); setTimeout(upd, 300);
  const hold = (btn, dir) => { let timer = null; const step = () => { t.scrollBy({ left: dir * 220, behavior: 'smooth' }); };
    btn.addEventListener('pointerdown', e => { e.preventDefault(); step(); timer = setInterval(step, 250); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, () => clearInterval(timer)); };
  hold(L, -1); hold(R, 1);
}

// boot: remember the folders from last time
(async () => {
  try { const c = localStorage.getItem('mkwe-catalog-1'); if (c) S.catalog = JSON.parse(c); } catch {}
  try { S.helpOpen = !!localStorage.getItem('mkwe-help'); } catch {}
  const r = await idb.get('romfs'), rb = await idb.get('baseromfs'); if (r) { $('#reopen').style.display = ''; $('#reopen').onclick = async () => { $('#reopen').style.display = 'none'; await openRomfs(r); if (rb) await openBaseRomfs(rb).catch(() => {}); }; }
  S.modsDir = await idb.get('mods');
  setMode('translate'); fillInspector(); fillPalette(); resize();
})();

// ================================================================ Track Creator: a brand-new track in its own slot
// (leftovers of the old kit idea that other code still calls)
const KITMESH = [];
const INVIS = new THREE.MeshBasicMaterial({ visible: false }), INVIS2 = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
// ---------------------------------------------------------------- object models
// each object's own model from the game (actor -> ModelInfo -> its .bfres), shaded in its category's colour.
// One load per kind of object; the object's invisible box is fitted to the model so clicking anywhere on it selects it.
const OM = { cache: new Map(), arcs: null, mats: new Map(), boxes: new Map(), on: true };
const NO_MODEL = /^(Area_|SystemObj_|System_|EffectObj_|StartPosition$|Sound|Stage_|CmnObj_CTrkPart)/;
const wantModel = name => OM.on && !!S.romfs && !S.romfs.fake && !!name && !NO_MODEL.test(name);
const gymlKey = ref => String(ref).replace(/^Work\//, '').replace(/\.gyml$/, '.bgyml');
function omArchives() {
  if (!OM.arcs) OM.arcs = (async () => {
    const rd = romReader(), V = await gameVersion(rd);
    const get = async n => { try { const b = V && await rd(`System/GymlArchive/${n}.Product_${V}.sarc.zs`); return b ? parseSarcM(zsDecompress(b)) : new Map(); } catch { return new Map(); } };
    return { actor: await get('actor_general_format'), info: await get('modelinfo_general_format') };
  })();
  return OM.arcs;
}
// the .bfres files an object draws with
async function omPaths(name) {
  const out = new Set();
  try {
    const A = await omArchives();
    let ref = null, k = `Gyml/ActorGParam/${name}.gear__ActorGParam.bgyml`;
    for (let i = 0; i < 8 && k; i++) { const b = A.actor.get(k); if (!b) break; const r = parseByml(b).root; if (r.Components?.ModelInfoRef) { ref = r.Components.ModelInfoRef; break; } k = r.$parent ? gymlKey(r.$parent) : null; }
    let mk = ref && gymlKey(ref);
    for (let i = 0; i < 8 && mk; i++) {
      const b = A.info.get(mk); if (!b) break; const r = parseByml(b).root;
      if (r.ModelResource?.length) { for (const m of r.ModelResource) { const f = /\/([^/]+)\/output\/([^/]+)\.fmdb$/.exec(String(m.Fmdb || '')); if (f) out.add(`Model/${f[1]}.${f[2]}.bfres.zs`); } break; }
      mk = r.$parent ? gymlKey(r.$parent) : null;
    }
  } catch (e) { console.error(e); }
  const g = /^(.*)_([A-Z][A-Za-z0-9]*)_\d\d$/.exec(name); if (!out.size && g) out.add(`Model/${g[1]}.${g[1]}_${g[2]}.bfres.zs`);
  return [...out];
}
function omTemplate(name) {
  if (!OM.cache.has(name)) OM.cache.set(name, (async () => {
    const grp = new THREE.Group(); let n = 0;
    for (const p of await omPaths(name)) {
      const raw = await readAt(S.romfs, p); if (!raw) continue;
      let model; try { model = loadBfres(zsDecompress(raw)); } catch (e) { console.warn(p, e.message); continue; }
      for (const part of model.parts) {
        if (!part.indices?.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3)); g.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3)); g.setIndex(new THREE.BufferAttribute(part.indices, 1));
        g.computeBoundingSphere(); grp.add(new THREE.Mesh(g)); n++;
      }
      await new Promise(r => setTimeout(r, 0));   // keep the window responsive while a course's models load
    }
    if (!n) return null;
    grp.userData.box = new THREE.Box3().setFromObject(grp);
    return grp;
  })());
  return OM.cache.get(name);
}
const omMat = color => { if (!OM.mats.has(color)) OM.mats.set(color, new THREE.MeshStandardMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xb8bcc4), 0.45), roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide })); return OM.mats.get(color); };
async function attachModel(id) {
  const it = S.items.get(id); if (!it) return;
  const name = it.data.Name, t = await omTemplate(name);
  if (!t || S.items.get(id) !== it || !it.mesh.parent || it.model) return;   // no model, or the scene was rebuilt meanwhile
  const m = t.clone(), mat = omMat(it.style[2]);
  m.traverse(o => { if (o.isMesh) { o.material = mat; o.raycast = () => {}; } });
  it.mesh.add(m); it.model = m;
  if (!OM.boxes.has(name)) { const b = t.userData.box, sz = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3()); OM.boxes.set(name, new THREE.BoxGeometry(Math.max(sz.x, 0.5), Math.max(sz.y, 0.5), Math.max(sz.z, 0.5)).translate(c.x, c.y, c.z)); }
  it.mesh.geometry = OM.boxes.get(name);
  it.mesh.material = S.sel.has(id) ? SEL_AREA : INVIS;
}
$('#showModels').addEventListener('change', () => { OM.on = $('#showModels').checked; buildScene(true); });
const ownMeshes = () => null;
function tcLineDone() {}
function tcRefresh() {}

// what the base model can hold per material (used until the real file is read from the RomFS)
const TC_CAP0 = { wall03: { tris: 192, verts: 1023 }, wall06: { tris: 40, verts: 320 }, backside01: { tris: 440, verts: 2319 }, floorlight: { tris: 600, verts: 1562 }, watersedge: { tris: 96, verts: 445 }, framesparts: { tris: 28, verts: 176 }, backside00: { tris: 262, verts: 684 }, decomark: { tris: 6, verts: 64 }, floorparts: { tris: 130, verts: 367 }, frame: { tris: 606, verts: 2712 }, asphalt: { tris: 174, verts: 529 }, floortile: { tris: 128, verts: 246 }, wiremesh: { tris: 128, verts: 479 } };
const CENTRAL = 'Model/CmnObj_ProvisionalPartsCentral000.CmnObj_ProvisionalPartsCentral000_A.bfres.zs';
const TC = { active: false, adding: false, pts: [], sel: -1, cap: TC_CAP0, gen: null, drag: null, hist: [], group: new THREE.Group(), preview: new THREE.Group(), handles: new THREE.Group(), camSaved: null };
TC.group.add(TC.preview, TC.handles); TC.group.visible = false; scene.add(TC.group);
const TC_COL = { asphalt: 0x6b7280, floorparts: 0x5f9e4a, frame: 0xd08a52, floortile: 0x3f6f38, backside01: 0xdcc58a, backside00: 0xb8bcc4 };
const tcMat = new Map();
const tcMatFor = (k, c) => { if (!tcMat.has(k)) tcMat.set(k, new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: k === 'floortile' ? 2 : 0, polygonOffsetUnits: k === 'floortile' ? 2 : 0 })); return tcMat.get(k); };
const TC_KEY = 'mkwe-trackcreator-1';
const tcFields = { width: 'tc_width', shoulder: 'tc_shoulder', wallHeight: 'tc_wall', segLen: 'tc_seg', itemFirst: 'tc_ifirst', itemEvery: 'tc_ievery', itemPer: 'tc_iper', laps: 'tc_laps', sections: 'tc_sections' };

function tcOpts() {
  const o = { ...TC_DEFAULTS };
  for (const [k, id] of Object.entries(tcFields)) { const v = parseFloat($('#' + id).value); if (isFinite(v)) o[k] = v; }
  o.width = Math.max(6, o.width); o.segLen = Math.min(20, Math.max(2, o.segLen)); o.shoulder = Math.max(0, o.shoulder); o.wallHeight = Math.max(0, o.wallHeight);
  o.itemPer = Math.max(0, Math.min(8, Math.round(o.itemPer))); o.laps = Math.max(1, Math.min(9, Math.round(o.laps)));
  o.ground = $('#tc_ground').checked; o.coins = $('#tc_coins').checked;
  o.race = $('#tc_race').value || 'laps'; o.sections = Math.max(2, Math.min(8, Math.round(o.sections || 3))); o.open = o.race === 'ab' && !tcImporting();
  o.groundPoly = TC.groundPoly && TC.groundPoly.length >= 3 ? TC.groundPoly.map(q => [q[0], q[1]]) : null; o.rails = 'none'; o.beachOn = $('#tc_beach').checked; o.beachW = parseFloat($('#tc_beachw').value) || 30;
  o.tex = JSON.parse(JSON.stringify(TC.surf));
  return o;
}
function tcDesign() { return { v: 1, w2: $('#tc_w2').checked, race: $('#tc_race').value, boosts: TC.boosts || [], rails: TC.railsImp || [], glideMade: TC.glideMade || [], hour: $('#tc_time').value, mm: TC.mm || null, music: $('#tc_music').value || TC.musicWant || '', musicHost: $('#tc_host').value || TC.hostWant || '', qc: TC.qc || null, name: $('#tc_name').value, mod: $('#tc_mod').value, cup: $('#tc_cup').value, vs: $('#tc_vs').value, picsvs: $('#tc_picsvs').checked, small: !$('#tc_big').checked, presets: TC.presets, nflip: $('#tc_nflip').checked, sharp: $('#tc_sharp').checked, bright: tcBright(), fr: TC.fr || null, points: TC.pts, opts: tcOpts(), src: $('#tc_src').value, place: tcPlace(), map: TC.map, files: { vis: TC.vis?.name || null, col: TC.col?.name || null } }; }
function tcApplyDesign(d) {
  TC.pts = (d.points || DEFAULT_POINTS).map(p => p[3] && typeof p[3] === 'object' ? [+p[0], +p[1], +p[2], { ...p[3] }] : [+p[0], +p[1], +p[2]]); TC.multi = new Set();
  if (d.name) $('#tc_name').value = d.name; if (d.mod) $('#tc_mod').value = d.mod; if (d.cup !== undefined) $('#tc_cup').value = d.cup; $('#tc_vs').value = d.vs !== undefined ? d.vs : 'Rainbow_00'; $('#tc_picsvs').checked = !!d.picsvs; $('#tc_big').checked = !d.small; TC.presets = Array.isArray(d.presets) ? d.presets.map(p => ({ ...p })) : []; setTimeout(tcEnsurePresets, 0); $('#tc_nflip').checked = !!d.nflip; $('#tc_sharp').checked = !!d.sharp; $('#tc_bright').value = d.bright ? Math.round(d.bright * 100) : 100; TC.fr = d.fr ? { ...frDefault(), ...d.fr } : null; $('#tc_fr').checked = !!TC.fr?.on; frInfo(); TC.musicWant = d.music || ''; TC.hostWant = d.musicHost || ''; tcMusicFill(); TC.mm = d.mm || null; $('#tc_time').value = d.hour || '';
  $('#tc_race').value = ['laps', 'loop', 'ab'].includes(d.race) ? d.race : 'laps'; tcRaceUI(); $('#tc_w2').checked = !!d.w2;
  const o = { ...TC_DEFAULTS, ...(d.opts || {}) };
  for (const [k, id] of Object.entries(tcFields)) $('#' + id).value = o[k];
  $('#tc_ground').checked = !!o.ground; $('#tc_coins').checked = !!o.coins;
  TC.groundPoly = Array.isArray(o.groundPoly) && o.groundPoly.length >= 3 ? o.groundPoly.map(q => [+q[0], +q[1]]) : null;
  if (o.walls === 'tunnel' || o.walls === 'tall') $('#tc_wall').value = 1.5;   // (a whole-track tunnel or tall wall from v80–v84 goes back to normal walls: styles are per point now)
  $('#tc_beach').checked = !!o.beachOn; $('#tc_beachw').value = o.beachW || 30;
  TC.surf = tcSurfDefaults(); for (const k of Object.keys(TC.surf)) if (o.tex?.[k]) TC.surf[k] = { ...TC.surf[k], ...o.tex[k] }; tcFillSurfTex();
  if (d.src) $('#tc_src').value = d.src;
  if (d.place) { for (const [k, id] of Object.entries(TC_PLACE)) $('#' + id).value = d.place[k] ?? (k === 'scale' ? 1 : 0); $('#tc_zup').checked = !!d.place.zUp; TC.pivot = d.place.pivot || null; }
  if (d.map) TC.map = { slot: { ...d.map.slot }, surf: { ...d.map.surf }, cut: { ...(d.map.cut || {}) }, two: { ...(d.map.two || {}) } };
  TC.qc = d.qc || null;
  TC.railsImp = (d.rails || []).filter(r => Array.isArray(r) && r.length).map(r => r.map(p => [+p[0], +p[1], +p[2]]));
  TC.glideMade = (d.glideMade || []).filter(p => Array.isArray(p) && p.length === 3).map(p => p.map(Number));
  TC.boosts = (d.boosts || []).map(b => ({ kind: PIECES[b.kind] ? b.kind : 'boost', s: +b.s || 0, x: +b.x || 0, ...(b.len ? { len: +b.len } : {}) }));
  tcSrcChanged();
}
const tcVsNote = () => $('#tc_vs').value === '+extra' ? ' (in VS / Time Trials, look for its own icon in the sea on the course map; test)' : $('#tc_vs').value ? ` (in VS / Time Trials, pick ${VS_STAGES.find(x => x[0] === $('#tc_vs').value)?.[1]})` : TC.fr?.on ? ' (in VS / Time Trials, pick its own icon on the map)' : '';
function tcSave() { try { localStorage.setItem(TC_KEY, JSON.stringify(tcDesign())); } catch {} }
function tcPush() { TC.hist.push(JSON.stringify({ pts: TC.pts, gp: TC.groundPoly || null })); if (TC.hist.length > 80) TC.hist.shift(); }
function tcUndo() { if (!TC.hist.length) return; const h = JSON.parse(TC.hist.pop()); if (Array.isArray(h)) TC.pts = h; else { TC.pts = h.pts; TC.groundPoly = h.gp; } TC.gsel = -1; TC.sel = Math.min(TC.sel, TC.pts.length - 1); TC.multi = new Set(); tcUpdate(); }
// the selected points: Ctrl+click adds and removes; a plain click picks one
const tcPicked = () => { const s = new Set(TC.multi || []); if (TC.sel >= 0) s.add(TC.sel); return [...s].filter(i => i < TC.pts.length).sort((a, b) => a - b); };

function tcOpen() {
  if (TC.active) return;
  if (S.customTrack) tcFlushDoc();
  TC.impKey = '';
  TC.active = true; document.body.classList.add('tcmode');
  if ($('#qcpanel').open) $('#quick').click();
  S.sel.clear(); refreshSelection(); gizmo.detach();
  world.visible = false; trackGroup.visible = false; QC.ghost.clear(); QC.guide = []; drawGuide(); TC.group.visible = true;
  TC.camSaved = { pos: camera.position.clone(), target: orbit.target.clone() };
  if (!TC.pts.length) { let d = null; try { d = JSON.parse(localStorage.getItem(TC_KEY) || 'null'); } catch {} tcApplyDesign(d || {}); tcRestoreModels(); }
  $('#tcpanel').style.display = ''; $('#title').textContent = $('#tc_name').value || 'Your track'; tcFillPics(); wsApply();
  tcUpdate(); tcFrame();
  tcLoadCap();
}
function tcClose() {
  if (TC.psel) { TC.psel = null; gizmo.detach(); TC.impKey = ''; }
  TC.active = false; TC.adding = false; $('#tc_add').classList.remove('on'); document.body.classList.remove('tcmode');
  world.visible = true; trackGroup.visible = $('#showTrack').checked; QC.ghost.visible = true; QC.drawGroup.visible = true; TC.group.visible = false;
  $('#tcpanel').style.display = 'none'; $('#title').textContent = S.path ? S.path.split('/').pop() : ''; wsApply(); if ($('#qcpanel').open) $('#quick').click();
  if (TC.camSaved) { camera.position.copy(TC.camSaved.pos); orbit.target.copy(TC.camSaved.target); }
  tcSave();
}
// big parts: the model's buffers grow to fit (up to 65535 corners per look), so a track needs only a few parts
const tcCapOf = raw => { const c = modelCapacity(raw); if (!$('#tc_big').checked) return c; const o = {}; for (const k of Object.keys(c)) o[k] = { tris: 40000, verts: 65000 }; return o; };
async function tcLoadCap() {
  if (!S.romfs || S.romfs.fake) return;
  try { const raw = await readAt(S.romfs, CENTRAL); if (raw) { TC.cap = tcCapOf(zsDecompress(raw)); tcUpdate(); } } catch (e) { console.error(e); }
  try { if (!TC.musicList) $('#tc_musichint').textContent = 'Reading the music list from your dump…'; await tcLoadMusic(); if (!TC.musicList) $('#tc_musichint').textContent = 'Couldn\'t find the music in this RomFS (Sound/Resource/M_Bgm.bars.zs and System/GymlArchive/general_format.Product_###.sarc.zs). Open the update\'s romfs folder.'; } catch (e) { console.error(e); $('#tc_musichint').textContent = 'Couldn\'t read the music list: ' + e.message; }
}
// ---------------------------------------------------------------- Track Creator: music
// race music comes from the course's stage (StageType -> BGM_Stage_<stage>); a Free Roam radio song can take over one
// stage's race music instead (that stage's own course then plays the song too)
const prettyName = n => n.replace(/([a-z'])([A-Z0-9])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ');
const SRC_NAMES = { MK8: 'Mario Kart 8', MKDS: 'Mario Kart DS', MKN64: 'Mario Kart 64', MKGC: 'Double Dash!!', MKSFC: 'Super Mario Kart', MK7: 'Mario Kart 7', MKWii: 'Mario Kart Wii', MKAGB: 'Super Circuit', MKGBA: 'Super Circuit', MKTour: 'Mario Kart Tour', Galaxy: 'Mario Galaxy', Galaxy2: 'Mario Galaxy 2', Odyssey: 'Mario Odyssey', Bros3: 'Super Mario Bros. 3', USA: 'Super Mario Bros. 2', LuigiM: "Luigi's Mansion", NewBrosU: 'New Super Mario Bros. U', '3DWFury': "3D World + Bowser's Fury", YoshiIsland: "Yoshi's Island", MarioPaint: 'Mario Paint', Bros: 'Super Mario Bros.', N64: 'Super Mario 64', GCMario: 'Super Mario Sunshine', '3DLand': 'Super Mario 3D Land', '3DL': 'Super Mario 3D Land', '3DW': 'Super Mario 3D World', MLand: 'Super Mario Land', MLand2: 'Super Mario Land 2', WiiMario: 'New Super Mario Bros. Wii', YoshiStory: "Yoshi's Story", MarioMaker: 'Super Mario Maker', SMW: 'Super Mario World', MKLHC: 'Mario Kart Live', NewBros: 'New Super Mario Bros.', DK: 'Donkey Kong', WSeries: 'Wario series' };
function songLabel(rt) {
  const p = rt.replace(/^BGM_JukeBox_/, '').replace(/_Outro(Full)?$/, '').split('_'); const src = p[1] || '';
  return prettyName(p.slice(2).join(' ') || src) + ' (' + (SRC_NAMES[src] || prettyName(src)) + ')';
}
async function tcLoadMusic() {
  const rd = p => readAt(S.romfs, p), V = await gameVersion(rd); TC.ver = V; if (!V) return;
  const bars = await rd('Sound/Resource/M_Bgm.bars.zs'), gf = await rd(`System/GymlArchive/general_format.Product_${V}.sarc.zs`); if (!bars || !gf) return;
  const B = zsDecompress(bars), has = n => barsHas(B, n), songs = [];
  for (const [n, b] of parseSarcM(zsDecompress(gf))) if (/SoundJukeBoxBgm\//.test(n)) { try { const r = parseByml(b).root, rt = r.RuntimeName?.v ?? r.RuntimeName; if (rt && has(rt)) songs.push({ rt, label: songLabel(rt), radioOnly: !!(r.IsFreerunOnly?.v ?? r.IsFreerunOnly) }); } catch {} }
  songs.sort((a, b) => a.label.localeCompare(b.label));
  const ST = ['AirshipFortress', 'BigTree', 'Cave', 'Central', 'ChocoMountain', 'Cinema', 'Coaster', 'DesertHills', 'DinoBones', 'DinoDinoJungle', 'DKJungleParkway', 'DKPass', 'DonkeyKong', 'FirstCircuit', 'IceBuildings', 'KoopaTroopaBeach', 'LagoonCity', 'Lava', 'MooMooFarm', 'PeachBeach', 'RaftingRiver', 'SFCMarioCircuit', 'ShyGuyBazaar', 'SnowMountain', 'StormClouds', 'ToadFactory', 'WarioShipyard', 'WarioStadium', 'WestCity'];
  const stages = ST.filter(x => has('BGM_Stage_' + x)), hosts = stages.filter(x => ['_Fast', '_Pre', '_Pre_Short'].every(k => has('BGM_Stage_' + x + k)));
  TC.musicList = { stages, hosts, songs }; tcMusicFill();
}
function tcMusicFill() {
  const L = TC.musicList, sel = $('#tc_music'), host = $('#tc_host'); if (!sel) return;
  let want = sel.value || TC.musicWant || '', hw = host.value || TC.hostWant || ''; if (want.startsWith('song:')) want = '';
  const opt = (v, t) => el('option', { value: v }, t);
  const groups = [opt('', TC.fr?.on ? 'Default (the stage it\'s next to)' : 'Default (as before)')];
  if (L) {
    groups.push(el('optgroup', { label: 'Race music of a stage' }, ...L.stages.map(x => opt('stage:' + x, prettyName(x)))));
    // (Free Roam radio songs are left out: swapping one in for a stage's race music didn't play in game)
    host.replaceChildren(...L.hosts.map(x => opt(x, prettyName(x))));
    if (hw && L.hosts.includes(hw)) host.value = hw; else if (L.hosts.includes('Cinema')) host.value = 'Cinema';
  } else if (want) groups.push(opt(want, want.replace(/^\w+:/, '')));
  sel.replaceChildren(...groups); sel.value = want; if (sel.value !== want) sel.value = '';
  const song = sel.value.startsWith('song:');
  $('#tc_hostrow').style.display = song ? '' : 'none';
  $('#tc_musichint').textContent = !L ? 'Open RomFS to choose the music.' : song ? `The song replaces ${prettyName(host.value)}'s race music while this mod is on (that course plays it too). ★ = normally only on the Free Roam radio.` : sel.value ? 'Uses that stage\'s race music, final-lap version included.' : '';
}
function tcMusicSpec() {
  const v = $('#tc_music').value;
  if (v.startsWith('stage:')) return { stageType: v.slice(6), music: null };
  if (v.startsWith('song:')) return { stageType: $('#tc_host').value, music: { song: v.slice(5), host: $('#tc_host').value } };
  // Default: in the open world, the stage it's next to (its music, and the stage type the game lights it by); otherwise as before
  const n = TC.fr?.on && typeof frNear === 'function' ? frNear(TC.fr.x, TC.fr.z) : null, st = n?.key?.replace(/_\d+$/, '');
  if (st && (!TC.musicList?.stages || TC.musicList.stages.includes(st))) return { stageType: st, music: null };
  return { stageType: 'Underground', music: null };
}
$('#tc_music').addEventListener('change', () => { TC.musicWant = $('#tc_music').value; tcMusicFill(); tcSave(); });
$('#tc_host').addEventListener('change', () => { TC.hostWant = $('#tc_host').value; tcMusicFill(); tcSave(); });
function tcFrame() {
  const g = TC.gen; if (!g) return;
  const [mn, mx] = g.bounds, c = new THREE.Vector3((mn[0] + mx[0]) / 2, 0, (mn[2] + mx[2]) / 2), size = Math.max(60, mx[0] - mn[0], mx[2] - mn[2]);
  camera.position.set(c.x + size * 0.35, size * 1.1, c.z + size * 0.75);
  const right = new THREE.Vector3().subVectors(c, camera.position).cross(new THREE.Vector3(0, 1, 0)).normalize();
  c.addScaledVector(right, size * 0.28); camera.position.addScaledVector(right, size * 0.28); orbit.target.copy(c);   // leave room for the panel on the right
  camera.near = 0.5; camera.far = 40000; camera.updateProjectionMatrix(); scene.fog.near = size * 4; scene.fog.far = size * 30;
  scene.remove(grid); grid = new THREE.GridHelper(Math.ceil(size * 3 / 10) * 10, Math.ceil(size * 3 / 10), 0x3c4658, 0x2a313d); grid.position.set(c.x, mn[1] - 0.2, c.z); scene.add(grid);
}

let tcTimer = 0;
// ---------------------------------------------------------------- game look: the track as the game will draw it
// sky and light like a day race, the sea, and the open world's ground round the track (from the game's height map);
// the model's materials as the build makes them: one-sided unless "2-sided", cut-outs only where "see-through" is on
const tcGameOn = () => $('#tc_game')?.checked;
const GL = { group: new THREE.Group(), key: '', saved: null };
function tcGameLook(g) {
  const on = tcGameOn();
  if (on && !GL.saved) { GL.saved = { bg: scene.background, fog: scene.fog.color.clone() }; scene.background = new THREE.Color(0x8fc4ef); scene.fog.color.set(0xb8d8f2); }
  if (!on && GL.saved) { scene.background = GL.saved.bg; scene.fog.color.copy(GL.saved.fog); GL.saved = null; }
  grid.visible = !on;
  if (!on) { GL.key = ''; GL.group.clear(); return; }
  TC.preview.add(GL.group);
  const fr = TC.fr, P = tcImporting() && TC.impBounds ? TC.impBounds : g.bounds;
  const key = JSON.stringify([fr?.on && fr.x, fr?.z, fr?.yaw, fr?.on && frHeight(fr), !!FRM.h, P.map(p => p.map(Math.round)), TR.group.children.length > 0 && TR.show]);
  if (key === GL.key) return;
  GL.key = key; GL.group.clear();
  const cx = (P[0][0] + P[1][0]) / 2, cz = (P[0][2] + P[1][2]) / 2, half = Math.max(P[1][0] - P[0][0], P[1][2] - P[0][2]) / 2 + 1500;
  const wy = tcWaterY();
  if (wy !== null) {   // the sea
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(half * 6, half * 6), new THREE.MeshStandardMaterial({ color: 0x1d6fae, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.88 }));
    sea.rotation.x = -Math.PI / 2; sea.position.set(cx, wy, cz); sea.renderOrder = 5; GL.group.add(sea);
  }
  if (fr?.on && FRM.h) {   // the open world's ground: 32 m squares, like the game's height map
    const yaw = fr.yaw * Math.PI / 180, c = Math.cos(yaw), sn = Math.sin(yaw), base = frHeight(fr), step = 32, n = Math.ceil(2 * half / step);
    const pos = new Float32Array((n + 1) * (n + 1) * 3), uv = new Float32Array((n + 1) * (n + 1) * 2), idx = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const lx = cx - half + i * step, lz = cz - half + j * step, x = fr.x + c * lx + sn * lz, z = fr.z - sn * lx + c * lz, k = j * (n + 1) + i;
      pos.set([lx, frGround(x, z) - base - (TR.group.children.length && TR.show ? 6 : 0.6), lz], 3 * k); uv.set([(x + FR_HALF) / (2 * FR_HALF), (z + FR_HALF) / (2 * FR_HALF)], 2 * k);
      if (i < n && j < n) idx.push(k, k + n + 1, k + 1, k + 1, k + n + 1, k + n + 2);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
    if (!GL.tex && FRM.img) { GL.tex = new THREE.CanvasTexture(FRM.img); GL.tex.colorSpace = THREE.SRGBColorSpace; GL.tex.flipY = false; }
    GL.group.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: GL.tex || null, color: GL.tex ? 0xffffff : 0x7fa860 })));
  }
}
function tcGameMaterials() {   // after the model preview is made: what the build will really show
  if (!tcGameOn()) return;
  TC.impGroup.traverse(m => { if (!m.isMesh || !m.userData.mat || m.material.wireframe) return; const n = m.userData.mat;
    m.material = m.material.clone(); m.material.side = TC.map.two?.[n] ? THREE.DoubleSide : THREE.FrontSide;
    m.material.alphaTest = TC.map.cut?.[n] ? 0.5 : 0; m.material.transparent = false;
    const nc = TC.texOver['#nrm:' + n]?.canvas; if (nc && m.material.map) { const t = new THREE.CanvasTexture(nc); t.wrapS = t.wrapT = THREE.RepeatWrapping; m.material.normalMap = t; if ($('#tc_nflip').checked) m.material.normalScale.set(1, -1); } });
}
function tcUpdate(soon) {
  if (soon) { if (!tcTimer) tcTimer = requestAnimationFrame(() => { tcTimer = 0; tcUpdate(); }); return; }
  let g;
  try { g = generate(TC.pts, tcGenOpts(), TC.cap); } catch (e) { console.error(e); $('#tc_warn').textContent = 'Can\'t build this shape: ' + e.message; return; }
  TC.gen = g; tcBoostList(); tcRailList(); if (tcShowCol()) tcColLegend(g);
  // track preview
  TC.preview.clear();
  if (tcImporting()) { tcImpPreview(); TC.preview.add(TC.impGroup); }
  if (TC.fr?.on && !FRM.h && !FRM.loading && S.romfs && !S.romfs.fake) frLoadMap().then(ok => { if (ok) tcUpdate(true); });
  tcGameLook(g);
  { const wy = tcWaterY(); if (wy !== null && $('#tc_water').checked && !tcGameOn()) {
    const P = tcImporting() && TC.impBounds ? TC.impBounds : g.bounds, cx = (P[0][0] + P[1][0]) / 2, cz = (P[0][2] + P[1][2]) / 2, size = Math.max(1500, 1.6 * Math.max(P[1][0] - P[0][0], P[1][2] - P[0][2]));
    const wm = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: 0x2a8fd6, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
    wm.rotation.x = -Math.PI / 2; wm.position.set(cx, wy, cz); wm.renderOrder = 5; wm.userData.noPick = true; TC.preview.add(wm);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)), new THREE.LineBasicMaterial({ color: 0x7cc8ff, transparent: true, opacity: 0.6 }));
    edge.rotation.x = -Math.PI / 2; edge.position.copy(wm.position); TC.preview.add(edge);
  } }
  const gen = !tcImporting();   // the centre-line road, its paths and items: only when the road is built from the centre line
  if (gen && tcShowCol()) for (const part of g.parts) {
    const by = new Map(); for (const [t, mi] of part.col.tris) { if (!by.has(mi)) by.set(mi, []); by.get(mi).push(...t.flatMap(v => [v[0] + part.local[0], v[1] + part.local[1], v[2] + part.local[2]])); }
    for (const [mi, P] of by) { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3)); geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: brushColor(brushFor(part.col.mats[mi])), side: THREE.DoubleSide })); mesh.userData.mmTrack = true; TC.preview.add(mesh); }
  }
  if (gen && !tcShowCol()) for (const part of g.parts) for (const [m, [V, TR]] of Object.entries(part.geom)) {
    const pos = new Float32Array(V.length * 3); V.forEach((v, i) => { pos[3 * i] = v[0][0] + part.local[0]; pos[3 * i + 1] = v[0][1] + part.local[1]; pos[3 * i + 2] = v[0][2] + part.local[2]; });
    const seen = new Set(), once = TR.filter(t => { const k = [...t].sort((a, b) => a - b).join(); if (seen.has(k)) return false; seen.add(k); return true; });   // two-sided walls: the material shows both sides already
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(once.flat()); geo.computeVertexNormals();
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(V.flatMap(v => v[2])), 2));
    { const mesh = new THREE.Mesh(geo, tcSurfMat(m) || tcMatFor(m, TC_COL[m] ?? 0x999999)); mesh.userData.mmTrack = true; TC.preview.add(mesh); }
  }
  if (gen) tcBoostPreview(g);
  tcGlidePreview(g);
  tcRailPreview(g);
  // part boundaries
  const seams = []; if (gen) for (const part of g.parts) { const r = g.rings[part.rings[0]], hw = g.opts.width / 2 + g.opts.shoulder; seams.push(new THREE.Vector3(r.p[0] + r.l[0] * hw, r.p[1] + 0.15, r.p[2] + r.l[2] * hw), new THREE.Vector3(r.p[0] - r.l[0] * hw, r.p[1] + 0.15, r.p[2] - r.l[2] * hw)); }
  TC.preview.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seams), new THREE.LineBasicMaterial({ color: 0x8ab4ff, transparent: true, opacity: 0.6 })));
  // paths
  const line = (pts, color, closed) => { const p = pts.map(q => new THREE.Vector3(q[0], q[1] + 0.3, q[2])); if (closed) p.push(p[0].clone()); TC.preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), new THREE.LineBasicMaterial({ color }))); };
  if (gen) line(g.route.map(n => n.pos), 0x4aa3ff, true);
  if (gen) for (const n of g.lap) {
    const r = n.rs[0] / 2, s = Math.sin(n.yaw), c = Math.cos(n.yaw);
    const a = new THREE.Vector3(n.pos[0] - c * r, n.pos[1] + 0.4, n.pos[2] + s * r), b = new THREE.Vector3(n.pos[0] + c * r, n.pos[1] + 0.4, n.pos[2] - s * r);
    const col = n.dyn?.IsStart ? 0xffffff : n.dyn?.IsGoal ? 0xff4a4a : n.dyn?.IsLapCheck ? 0xffa53d : n.dyn?.CheckPoint ? 0x3ddc84 : 0x2a7a4a;
    TC.preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: col })));
  }
  if (gen) for (const a of g.actors) {
    const item = /ItemBox/.test(a.name), m = new THREE.Mesh(item ? GEO.box : GEO.coin, matFor(item ? 0xf5c542 : 0xffd700));
    m.position.set(...a.pos); if (item) m.scale.setScalar(0.6); else m.scale.setScalar(0.5); TC.preview.add(m);
  }
  // Rainbow Road's start grid (fixed): karts at x -8..+7, up to 46 m behind the line, facing -Z
  if (gen || !TC.qc?.starts?.length) for (let i = 0; i < 24; i++) { const m = new THREE.Mesh(GEO.cone, matFor(0x3ddc84)); m.position.set(GRID_X[i % 12], 0.6, 2 * i); m.rotation.y = Math.PI; m.scale.setScalar(0.5); TC.preview.add(m); }
  if (tcImporting()) tcDrawQC(); else tcPathsUI();
  // handles
  TC.handles.clear();
  TC.handles.visible = !tcImporting();
  const hgeo = new THREE.SphereGeometry(1.6, 16, 12);
  const locked = [...LOCK_AFTER, ...LOCK_BEFORE];
  for (const p of locked) { const m = new THREE.Mesh(hgeo, new THREE.MeshBasicMaterial({ color: 0x777f8c })); m.position.set(p[0], p[1] + 1.5, p[2]); TC.handles.add(m); }
  { // the ground's own shape: green corners (drag them; Delete removes the picked one) and its outline
    const gy = (g.bounds?.[0]?.[1] ?? 0) - 0.05, poly = TC.gdraw || TC.groundPoly;
    if (poly && poly.length) {
      const ggeo = new THREE.SphereGeometry(1.1, 12, 8), line = poly.map(q => new THREE.Vector3(q[0], gy + 0.3, q[1])); if (!TC.gdraw && poly.length >= 3) line.push(line[0].clone());
      TC.preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(line), new THREE.LineBasicMaterial({ color: 0x3ddc84, depthTest: false })));
      poly.forEach((q, i) => { const m = new THREE.Mesh(ggeo, new THREE.MeshBasicMaterial({ color: i === TC.gsel ? 0xffffff : 0x3ddc84 })); m.position.set(q[0], gy + 0.8, q[1]); m.userData.gp = i; TC.handles.add(m); });
    }
    $('#tc_ginfo').textContent = TC.gdraw ? `Drawing: ${TC.gdraw.length} corner${TC.gdraw.length === 1 ? '' : 's'} (Enter or Done finishes)` : TC.groundPoly ? `Your own shape: ${TC.groundPoly.length} corners. Drag the green ones; Delete removes the picked one.` : 'A square round the track.';
    $('#tc_gdraw').textContent = TC.gdraw ? 'Done' : 'Draw the ground\'s shape'; $('#tc_gdraw').classList.toggle('hot', !!TC.gdraw); $('#tc_gsquare').disabled = !TC.groundPoly && !TC.gdraw;
  }
  const picked = new Set(tcPicked());
  TC.pts.forEach((p, i) => { const on = picked.has(i), st = p[3] || {}, own = (st.w && st.w !== 'default') || (st.r && st.r !== 'default');
    const m = new THREE.Mesh(hgeo, new THREE.MeshBasicMaterial({ color: on ? 0xffffff : own ? 0xffa040 : 0xffe14a })); m.position.set(p[0], p[1] + 1.5, p[2]); m.userData.tc = i; m.scale.setScalar(i === TC.sel ? 1.35 : on ? 1.2 : 1); TC.handles.add(m); });
  // panel
  const st = g.stats;
  if (tcImporting()) {
    const P = TC.pack, q = TC.qc;
    $('#tc_stats').innerHTML = `${P ? `${P.stats.visualTris} triangles, ${P.stats.collisionTris} collision triangles → <b>${P.stats.parts} model parts</b>` : 'no model yet'} · ` +
      (q ? `lap path ${q.lap.length} points (${q.lap.filter(f => f.cp).length} checkpoints) · ${q.routes.length} CPU route${q.routes.length > 1 ? 's' : ''} · ${q.items.length} item boxes · ${q.starts.length ? q.starts.length + ' start spots' : 'Rainbow Road\'s start grid at the origin'}` : 'no paths yet: use Quick Create');
  } else $('#tc_stats').innerHTML = `Length <b>${Math.round(st.length)} m</b> · ${st.parts} model part${st.parts > 1 ? 's' : ''} (${st.perPart} pieces each) · ${st.lapNodes} lap points, ${st.checkpoints} checkpoints · ${st.routeNodes} CPU points · ${st.items} item boxes`;
  const iw = [];
  if (tcImporting() && TC.qc && !TC.qc.starts.length && Math.hypot(TC.qc.lap[0]?.pos[0] ?? 0, TC.qc.lap[0]?.pos[2] ?? 0) > 30)
    iw.push('No start grid: the karts would start at the origin, away from your start line. Tick "Start grid" in Quick Create and Create again.');
  if (tcImporting() && !TC.vis) iw.push('Import your model (OBJ, FBX or DAE).');
  if (tcImporting() && TC.vis && Object.keys(TC.map.cut || {}).some(n => TC.map.cut[n] && tcVM().mats.has(n))) iw.push('See-through materials only fit in the two "mask" looks (about 150 triangles per part), so keep them light.');
  if (tcImporting() && TC.pack && TC.pack.stats.parts > 60) iw.push(`That's a lot of parts (${TC.pack.stats.parts}): the base model holds only a few hundred triangles per look, so lighten the model or spread its materials over more looks.`);
  if (tcImporting() && TC.vis && TC.impBounds) { const [mn, mx] = TC.impBounds; if (Math.max(mx[0] - mn[0], mx[2] - mn[2]) > 5000) iw.push('The model is huge: is the scale right? (Try 0.01 for centimetres.)'); else if (Math.max(mx[0] - mn[0], mx[2] - mn[2]) < 30) iw.push('The model is tiny: is the scale right? (1 unit should be 1 metre.)'); }
  $('#tc_warn').textContent = [...iw, ...g.warn].join(' ') + (TC.cap === TC_CAP0 && (!S.romfs || S.romfs.fake) ? ' Open the RomFS folder before building.' : '');
  { const wy = tcWaterY(), sp0 = TC.pts[TC.sel], d = sp0 && wy !== null ? wy - sp0[1] : null;
    $('#tc_ptinfo').textContent = `${TC.pts.length} points` + (d === null ? '' : d > 0 ? ` · this point is ${d.toFixed(1)} m under water` : ` · this point is ${(-d).toFixed(1)} m above the water`);
    $('#tc_sink').disabled = !sp0 || wy === null; }
  { const ks = tcPicked(), val = key => { const vs = new Set(ks.map(i => TC.pts[i][3]?.[key] || 'default')); return vs.size === 1 ? [...vs][0] : 'mixed'; };
    for (const [id, key] of [['#tc_pwall', 'w'], ['#tc_prail', 'r'], ['#tc_pside', 'sd'], ['#tc_pgap', 'gap']]) { const sel = $(id); sel.disabled = !ks.length; const v = ks.length ? val(key) : 'default';
      sel.querySelector('option[value="mixed"]').hidden = v !== 'mixed'; if (document.activeElement !== sel) sel.value = v; }
    $('#tc_pcount').textContent = ks.length > 1 ? `${ks.length} points picked` : ks.length ? 'from this point to the next' : 'pick a point (Ctrl+click picks more)'; }
  const sp = TC.pts[TC.sel];
  $('#tc_h').disabled = !sp; $('#tc_del').disabled = !sp || TC.pts.length <= 2;
  if (sp && document.activeElement !== $('#tc_h')) $('#tc_h').value = +sp[1].toFixed(2);
  $('#tc_xz').textContent = sp ? `${sp[0].toFixed(1)} / ${sp[2].toFixed(1)}` : '–';
  tcSave();
}

const tcRay = e => { const r = renderer.domElement.getBoundingClientRect(); ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera); return ray; };
const tcOnPlane = (e, y) => { const p = new THREE.Vector3(); return tcRay(e).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null; };
renderer.domElement.addEventListener('pointerdown', e => {
  if (!TC.active || e.button !== 0 || QC.drawing || tcImporting()) return;
  const hit = tcRay(e).intersectObjects(TC.handles.children.filter(m => m.userData.tc !== undefined), false)[0];
  if (!hit) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const i = hit.object.userData.tc, p = TC.pts[i], at = tcOnPlane(e, p[1] + 1.5);
  if (e.ctrlKey || e.metaKey) {   // Ctrl+click: add it to the selection, or take it out
    TC.multi = new Set(tcPicked());
    if (TC.multi.has(i)) { TC.multi.delete(i); if (TC.sel === i) TC.sel = TC.multi.size ? [...TC.multi][TC.multi.size - 1] : -1; } else { TC.multi.add(i); TC.sel = i; }
    tcUpdate(); return;
  }
  if (!tcPicked().includes(i)) TC.multi = new Set([i]);
  tcPush(); TC.sel = i; TC.drag = { i, dx: at ? p[0] - at.x : 0, dz: at ? p[2] - at.z : 0, moved: false, base: tcPicked().map(k => [k, TC.pts[k][0], TC.pts[k][2]]) };
  orbit.enabled = false; renderer.domElement.setPointerCapture(e.pointerId); tcUpdate();
}, { capture: true });
renderer.domElement.addEventListener('pointermove', e => {
  if (!TC.drag) return;
  const p = TC.pts[TC.drag.i], at = tcOnPlane(e, p[1] + 1.5); if (!at) return;
  const b0 = TC.drag.base.find(b => b[0] === TC.drag.i), mx = at.x + TC.drag.dx - b0[1], mz = at.z + TC.drag.dz - b0[2];   // move every picked point the same way
  for (const [k, x, z] of TC.drag.base) { const q = TC.pts[k]; q[0] = Math.round((x + mx) * 10) / 10; q[2] = Math.round((z + mz) * 10) / 10;
    const hy = tcHeight(q[0], q[1], q[2]); if (hy !== null) q[1] = Math.round(hy * 100) / 100; }
  TC.drag.moved = true;
  tcUpdate(true);
});
const tcEndDrag = e => { if (!TC.drag) return; if (!TC.drag.moved) TC.hist.pop(); TC.drag = null; orbit.enabled = true; try { renderer.domElement.releasePointerCapture(e.pointerId); } catch {} downAt = null; tcUpdate(); };
renderer.domElement.addEventListener('pointerup', tcEndDrag, { capture: true });
renderer.domElement.addEventListener('pointercancel', tcEndDrag);

// ---- the ground's own shape (centre-line road)
function tcGroundEnd(keep) {
  if (!TC.gdraw) return;
  if (keep && TC.gdraw.length >= 3) { tcPush(); TC.groundPoly = TC.gdraw; } else if (keep) toast('The shape needs at least three corners.', 'err');
  TC.gdraw = null; tcUpdate(); tcSave();
}
$('#tc_gdraw').onclick = () => { $('#tc_gdraw').blur(); if (TC.gdraw) return tcGroundEnd(true); TC.gdraw = []; TC.gsel = -1; if (!$('#tc_ground').checked) { $('#tc_ground').checked = true; } tcUpdate(); toast('Click round the ground\'s outline. Backspace: undo a corner · Enter: done · Esc: cancel'); };
$('#tc_gsquare').onclick = () => { TC.gdraw = null; TC.groundPoly = null; TC.gsel = -1; tcUpdate(); tcSave(); };
renderer.domElement.addEventListener('pointerdown', e => {
  if (!TC.active || e.button !== 0 || tcImporting()) return;
  const gy = (TC.gen?.bounds?.[0]?.[1] ?? 0) - 0.05;
  if (TC.gdraw) { e.stopImmediatePropagation(); e.preventDefault(); const at = tcOnPlane(e, gy); if (at) { TC.gdraw.push([Math.round(at.x * 10) / 10, Math.round(at.z * 10) / 10]); tcUpdate(true); } return; }
  if (!TC.groundPoly) return;
  const hit = tcRay(e).intersectObjects(TC.handles.children.filter(m => m.userData.gp !== undefined), false)[0]; if (!hit) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const i = hit.object.userData.gp; tcPush(); TC.gsel = i; TC.sel = -1; TC.multi = new Set(); TC.gdrag = { i, y: gy, moved: false };
  orbit.enabled = false; renderer.domElement.setPointerCapture(e.pointerId); tcUpdate(true);
}, { capture: true });
renderer.domElement.addEventListener('pointermove', e => {
  if (!TC.gdrag) return; const at = tcOnPlane(e, TC.gdrag.y); if (!at) return;
  TC.groundPoly[TC.gdrag.i] = [Math.round(at.x * 10) / 10, Math.round(at.z * 10) / 10]; TC.gdrag.moved = true; tcUpdate(true);
});
renderer.domElement.addEventListener('pointerup', e => { if (!TC.gdrag) return; if (!TC.gdrag.moved) TC.hist.pop(); TC.gdrag = null; orbit.enabled = true; try { renderer.domElement.releasePointerCapture(e.pointerId); } catch {} tcUpdate(); tcSave(); }, { capture: true });
// a click on the ground: add a point (in Add mode) where it fits best in the loop, or clear the selection
function tcClick(e) {
  if (!TC.adding) { TC.sel = -1; TC.multi = new Set(); TC.gsel = -1; tcUpdate(); return; }
  const near = TC.pts[TC.sel] || TC.pts[0]; const at = tcOnPlane(e, near ? near[1] : 0);
  if (!at) return toast('Aim at the ground (tilt the camera down a bit).');
  const p = [Math.round(at.x * 10) / 10, near ? near[1] : 0, Math.round(at.z * 10) / 10];
  if (tcImporting() && TC.vis) { const hit = tcRay(e).intersectObjects(TC.rayGroup.children, false)[0]; if (hit) { p[0] = Math.round(hit.point.x * 10) / 10; p[1] = Math.round(hit.point.y * 100) / 100; p[2] = Math.round(hit.point.z * 10) / 10; } }
  const ctrl = [LOCK_AFTER[LOCK_AFTER.length - 1], ...TC.pts, LOCK_BEFORE[0]];
  let best = Infinity, k = 0;
  for (let i = 0; i + 1 < ctrl.length; i++) {
    const a = ctrl[i], b = ctrl[i + 1], abx = b[0] - a[0], abz = b[2] - a[2], l2 = abx * abx + abz * abz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[2] - a[2]) * abz) / l2)), d = Math.hypot(a[0] + abx * t - p[0], a[2] + abz * t - p[2]);
    if (d < best) { best = d; k = i; }
  }
  tcPush(); TC.pts.splice(k, 0, p); TC.sel = k; TC.multi = new Set([k]); tcUpdate();
}
function tcDelete() { const ks = tcPicked(); if (!ks.length) return; if (TC.pts.length - ks.length < 2) return toast('The loop needs at least two of your points.', 'err'); tcPush(); for (const k of ks.reverse()) TC.pts.splice(k, 1); TC.sel = -1; TC.multi = new Set(); tcUpdate(); }
function tcKey(e, k) {
  if (TC.gdraw) { if (k === 'enter') { e.preventDefault(); document.activeElement?.blur?.(); return tcGroundEnd(true); } if (k === 'escape') { TC.gdraw = null; tcUpdate(); return; } if (k === 'backspace') { TC.gdraw.pop(); tcUpdate(true); return; } }
  if (TC.gsel >= 0 && TC.groundPoly && (k === 'delete' || k === 'backspace')) { if (TC.groundPoly.length <= 3) return toast('The shape needs at least three corners.', 'err'); tcPush(); TC.groundPoly.splice(TC.gsel, 1); TC.gsel = -1; tcUpdate(); tcSave(); return; }
  if (TC.railDraw) { if (k === 'enter') { e.preventDefault(); document.activeElement?.blur?.(); return tcRailEnd(true); } if (k === 'escape') return tcRailEnd(false); if (k === 'backspace') { TC.railDraw.pop(); tcUpdate(true); return; } }
  if (TC.psel) {
    if (k === 'escape') return tcPresetSelect(null);
    if (k === 'delete') { TC.presets = TC.presets.filter(x => x !== TC.psel); tcPresetSelect(null); tcFillMaps(); tcSave(); return; }
    if (k === '1' || k === '2' || k === '3') return setMode(['translate', 'rotate', 'scale'][+k - 1]);
  }
  if (tcEKey(e, k)) return;
  if (e.ctrlKey && k === 'z') { e.preventDefault(); tcUndo(); }
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); tcDelete(); }
  else if (k === 'escape') { if (TC.adding) $('#tc_add').click(); else { TC.sel = -1; TC.multi = new Set(); tcUpdate(); } }
  else if (k === 'f') tcFrame();
  else if (k === 'pageup' || k === 'pagedown') { const p = TC.pts[TC.sel]; if (p) { e.preventDefault(); tcPush(); for (const q of tcPicked().map(i => TC.pts[i])) q[1] = Math.round((q[1] + (k === 'pageup' ? 0.5 : -0.5)) * 10) / 10; tcUpdate(); } }
}

// a test build of the default oval, in memory only: says whether this dump has everything the Track Creator needs
async function tcCheckDump() {
  if (!S.romfs || S.romfs.fake) return toast('Open RomFS first (your dump\'s romfs folder; for 1.1 and later, the update\'s romfs).', 'err');
  busy('Checking your dump…');
  const rd = romReader(), V = await gameVersion(rd).catch(() => null), ver = V ? verLabel(V) : 'unknown';
  let report;
  try {
    const raw = await rd(CENTRAL); if (!raw) throw new Error('missing from the dump: ' + CENTRAL);
    const cap = modelCapacity(zsDecompress(raw)), g = generate(DEFAULT_POINTS, tcGenOpts(), cap), w = toWorld(g, SLOT_START);
    const { files, warnings } = await buildNewSlot(rd, { display: 'Test', cup: 'Kinoko', stageType: 'Underground', laps: 3, parts: w.parts, lap: w.lap, route: w.route, routes: w.routes, starts: w.starts, actors: w.actors, extent: w.extent, textures: new Map() }, m => busy(m));
    report = `MK World Course Editor ${EDITOR_VER} · game version ${ver} · test build OK (${files.size} files). The Track Creator can build from this dump.` + (warnings?.length ? ' Notes: ' + warnings.join('; ') : '');
    toast(report, 'ok');
  } catch (e) {
    console.error(e);
    report = `MK World Course Editor ${EDITOR_VER} · game version ${ver} · test build FAILED: ${e.message}`;
    toast(report + ' (Copied to the clipboard: send it to the editor\'s maker.)', 'err');
  }
  busy();
  try { await navigator.clipboard.writeText(report); } catch {}
  return report;
}
// the track in world space: parts (when packing the model), paths, objects, start grid
// read a romfs file; rd.list(dir) lists a folder's files (for finding the base game's message archives)
function romReader() {
  const rd = p => readAt(S.romfs, p);
  rd.list = async dir => { try { let h = S.romfs; for (const part of dir.split('/').filter(Boolean)) h = await h.getDirectoryHandle(part); const out = []; for await (const [n, e] of h.entries()) if (e.kind === 'file') out.push(n); return out; } catch { return []; } };
  return rd;
}
async function tcWorldSpec(withParts) {
  const rd = romReader();
  const raw = await rd(CENTRAL); if (!raw) throw new Error('this RomFS has no ' + CENTRAL + ' (for 1.1 and later, open the update\'s romfs, not the base game\'s)');
  TC.cap = tcCapOf(zsDecompress(raw));
  const g = generate(TC.pts, tcGenOpts(), TC.cap);
  if (tcImporting()) {
    if ($('#tc_race').value === 'ab' && TC.qc?.closed) throw new Error('an A to B race needs a lap path that doesn\'t loop: in Quick Create untick "Loop", draw the guide from the start to the finish and click Create');
    if (!TC.vis) throw new Error('import your model first');
    if (withParts) { busy('Packing your model into parts…'); await new Promise(r => setTimeout(r, 30)); TC.pack = tcPack(); g.parts = TC.pack.parts; } else g.parts = [];
    if (!TC.qc || !TC.qc.lap.length) throw new Error('lay out the paths first: open Quick Create, draw the guide along your road and click Create');
    const q = tcQCSpec(TC.qc); g.lap = q.lap; g.route = q.routes[0] || q.lap.map(n => ({ ...n, rs: [Math.max(4, TC.qc.width * (TC.qc.routePct ?? 40) / 100), 10], ro: [0, 5], dyn: null })); g.routes = q.routes.length ? q.routes : [g.route]; g.actors = q.actors; g.starts = q.starts; g.lapRails = q.lapRails; g.routeRails = q.routeRails;
  } else if (!withParts) g.parts = [];
  else if (tcPiecesOf(g).length) { await tcDashLoad(rd, g); tcAddBoosts(g); }
  const w = toWorld(g, SLOT_START);
  const glides = tcGlidePaths(g).map(path => path.map(n => ({ ...n, pos: n.pos.map((v, i) => Math.fround(SLOT_START[i] + v)), yaw: Math.fround(n.yaw) })));
  // where the editor's glide paths start (now and in earlier builds): those are the ones a rebuild replaces; other glide paths on the track stay
  TC.glideMade = TC.glideMade || [];
  for (const path of glides) { const p = path[0].pos; if (!TC.glideMade.some(m => Math.hypot(m[0] - p[0], m[1] - p[1], m[2] - p[2]) < 1)) TC.glideMade.push(p.map(v => +v.toFixed(2))); }
  if (TC.glideMade.length > 300) TC.glideMade = TC.glideMade.slice(-300);
  const toW = n => ({ ...n, pos: n.pos.map((v, i) => Math.fround(SLOT_START[i] + v)), yaw: Math.fround(n.yaw) });
  const railPaths = (tcImporting() ? TC.railsImp.map(tcRailNodes) : g.railPaths || []).filter(r => r.length >= 2).map(r => r.map(toW));
  return { g, w, rd, spec: { glidePaths: glides, glideMade: TC.glideMade, railPaths, laps: g.opts.laps, raceType: g.opts.race, parts: w.parts, lap: w.lap, route: w.route, routes: w.routes, lapRails: w.lapRails, routeRails: w.routeRails, starts: w.starts, actors: w.actors, extent: w.extent, startHeight: tcImporting() && !(w.starts && w.starts.length) ? (x, z) => tcHeightW(x, 0, z) : null } };
}
async function tcBuild(asZip) {
  if (!S.romfs || S.romfs.fake) return toast('Open the RomFS folder first (Open RomFS… → your dump\'s romfs folder): the track is built from your game files.', 'err');
  const modName = $('#tc_mod').value.trim().replace(/[^A-Za-z0-9_-]+/g, '') || 'CustomTrack'; $('#tc_mod').value = modName;
  const display = $('#tc_name').value.trim() || 'Custom Track';
  let mods = null, zipTarget = null;
  if (asZip) { zipTarget = await pickSave(modName + '.zip', 'modzip'); if (!zipTarget) return toast('Not saved.'); }
  if (!asZip) {
    if (!window.showDirectoryPicker) return tcBuild(true);
    mods = S.modsDir;
    if (!mods || !await permit(mods, 'readwrite')) {
      toast('Pick the recomp\'s "mods" folder (inside mkw-recomp).');
      try { mods = await showDirectoryPicker({ id: 'mods', mode: 'readwrite' }); } catch { return; }
      if (!await permit(mods, 'readwrite')) return;
      try { mods = await mods.getDirectoryHandle('mods'); } catch {}
      S.modsDir = mods; idb.set('mods', mods);
    }
  }
  busy('Building the track…');
  try {
    const { g, rd, spec } = await tcWorldSpec(true);
    const docBytes = TC.docBytes ? await tcFinishedDoc() : null;   // finished: the course from the course view
    if (S.customTrack) tcFlushDoc();
    const variants = TC.variants.filter(v => v.bytes).map(v => ({ letter: v.letter, name: v.name, docBytes: v.bytes }));
    const mixOf = id => { const k = [...tcVM().mats.keys()].find(m => tcTexOf(m) === id && TC.texOver['#mix:' + m]); const c = k && TC.texOver['#mix:' + k].canvas; return c ? { get: (l, w, h) => canvasRGBA(c, w, h), w: c.width, h: c.height } : undefined; };
    const nrmOf = id => { const k = [...tcVM().mats.keys()].find(m => tcTexOf(m) === id && (TC.texOver['#nrm:' + m] || tcPresetNrm(m))); const c = k && (TC.texOver['#nrm:' + k]?.canvas || tcPresetNrm(k)); return c ? { get: (l, w, h) => canvasRGBA(c, w, h, true), w: c.width, h: c.height, flipY: !!$('#tc_nflip').checked } : undefined; };
    const BR = tcBright();
    const textures = tcImporting() ? new Map([...new Set([...tcVM().mats.keys()].map(n => tcTexOf(n)).filter(Boolean))].map(n => [n, { get: (l, w, h, a) => brightRGBA(canvasRGBA(tcTexCanvas(n), w, h, a), BR), w: tcTexCanvas(n).width, h: tcTexCanvas(n).height, nrm: nrmOf(n), mix: mixOf(n) }])) : tcBoostTextures(spec.parts, tcCentreTextures(spec.parts));
    const { files, warnings } = await buildNewSlot(rd, { ...spec, ...tcSkySpec(), docBytes, variants, display, cup: $('#tc_cup').value || null, vsStage: ($('#tc_vs').value || '').startsWith('+') ? null : ($('#tc_vs').value || null), vsExtra: $('#tc_vs').value === '+extra', pictures: tcPicSpec(), picturesStandIn: $('#tc_picsvs').checked, freeRoam: $('#tc_w2').checked ? null : await frSpec(), island: $('#tc_w2').checked, music: tcMusicSpec().music, textures, minimap: tcMinimapFor, stageType: tcStageType() }, m => busy(m));
    if (warnings?.length) setTimeout(() => toast('Note: ' + warnings.join(' · '), 'err'), 4500);
    busy('Writing the mod…');
    if (asZip) {
      const manifest = await manifestFor(files, null);
      const zf = [...files].map(([p, b]) => [`${modName}/romfs/${p}`, b]);
      zf.push([`${modName}/trackcreator-project.zip`, await tcProjectZip()]);
      zf.push([`${modName}/romfs/manifest.tsv`, new TextEncoder().encode(manifest)], [`${modName}/mod.json`, new TextEncoder().encode(modMeta(modName, files.size))]);
      busy('Saving the zip…'); const saved = await writeSave(zipTarget, makeZip(zf)); busy();
      toast(`Saved ${saved}. Extract it into mkw-recomp\\mods (so you get mods\\${modName}\\romfs), turn it on in the recomp's Mods page, then race ${$('#tc_cup').selectedOptions[0].text}${tcVsNote()}${TC.fr?.on ? ' (it races at its Free Roam spot, and is in Free Roam too)' : ''}.`, 'ok');
    } else {
      const mod = await mods.getDirectoryHandle(modName, { create: true });
      const romfs = await mod.getDirectoryHandle('romfs', { create: true });
      for (const [p, b] of files) await writeAt(romfs, p, b);
      try { await writeAt(mod, 'trackcreator-project.zip', await tcProjectZip()); } catch (e) { console.error(e); }
      const all = new Map();
      for (const [p, h] of await walk(romfs)) if (p !== 'manifest.tsv') all.set(p, new Uint8Array(await (await h.getFile()).arrayBuffer()));
      await writeAt(romfs, 'manifest.tsv', new TextEncoder().encode(await manifestFor(all, null)));
      await writeAt(mod, 'mod.json', new TextEncoder().encode(modMeta(modName, all.size)));
      toast(`Built "${modName}" (${g.parts.length} model parts, ${Math.round(g.stats.length)} m). Turn it on in the recomp's Mods page, then race ${$('#tc_cup').selectedOptions[0].text}${tcVsNote()}${TC.fr?.on ? ' (it races at its Free Roam spot, and is in Free Roam too)' : ''}.`, 'ok');
    }
  } catch (e) { console.error(e); toast('Building failed: ' + e.message, 'err'); }
  busy();
}

$('#tcOpen').onclick = () => TC.active ? tcClose() : tcOpen();
$('#tc_close').onclick = tcClose;
$('#tc_add').onclick = () => { TC.adding = !TC.adding; $('#tc_add').classList.toggle('on', TC.adding); $('#tc_add').textContent = TC.adding ? 'Adding: click the ground' : 'Add points'; };
$('#tc_del').onclick = tcDelete;
$('#tc_undo').onclick = tcUndo;
$('#tc_reset').onclick = () => { if (!confirm('Start again from the default oval? (Undo can bring your shape back.)')) return; tcPush(); TC.pts = DEFAULT_POINTS.map(p => p.slice()); TC.sel = -1; tcUpdate(); tcFrame(); };
$('#tc_h').oninput = () => { const v = parseFloat($('#tc_h').value); if (TC.pts[TC.sel] && isFinite(v)) { for (const i of tcPicked()) TC.pts[i][1] = v; tcUpdate(true); } };
$('#tc_h').onfocus = () => tcPush();
$('#tc_sink').onclick = () => { const p = TC.pts[TC.sel], wy = tcWaterY(); if (!p || wy === null) return; tcPush(); for (const i of tcPicked()) TC.pts[i][1] = +(wy - 4).toFixed(2); tcUpdate(); toast('That point is 4 m under the water now. Points next to it stay where they are, so lower those too for a longer dip.', 'ok'); };
$('#tc_water').onchange = () => { tcUpdate(); tcSave(); };
$('#tc_game').onchange = () => { if (tcGameOn() && TC.fr?.on) frLoadMap().then(() => tcUpdate()); tcUpdate(); };
for (const id of [...Object.values(tcFields), 'tc_ground', 'tc_coins', 'tc_beach', 'tc_beachw']) $('#' + id).addEventListener('input', () => { tcUpdate(true); tcSave(); });
for (const [id, key] of [['#tc_pwall', 'w'], ['#tc_prail', 'r'], ['#tc_pside', 'sd'], ['#tc_pgap', 'gap']]) $(id).onchange = () => {
  const v = $(id).value; if (v === 'mixed') return; tcPush();
  for (const i of tcPicked()) { const p = TC.pts[i], st = { ...(p[3] || {}) }; if (v === 'default') delete st[key]; else st[key] = v; if (Object.keys(st).length) p[3] = st; else p.length = 3; }
  tcUpdate(); tcSave();
};
$('#tc_vs').append(el('option', { value: '+extra' }, 'Its own stage, the 31st (test)'), el('option', { value: '' }, 'No stand-in (in the open world: its own map icon)'), ...VS_STAGES.map(([k, n]) => el('option', { value: k }, 'In place of ' + n)));
$('#tc_vs').value = 'Rainbow_00';
for (const id of ['tc_name', 'tc_mod', 'tc_cup', 'tc_vs', 'tc_picsvs']) $('#' + id).addEventListener('change', tcSave);
$('#tc_nflip').addEventListener('change', tcSave);
// the race: laps, or sections (looping, or one way from A to B)
function tcRaceUI() {
  const r = $('#tc_race').value, sec = r !== 'laps';
  $('#tc_lapsrow').style.display = sec ? 'none' : ''; $('#tc_secrow').style.display = sec ? '' : 'none';
  $('#tc_racehint').textContent = r === 'loop' ? 'One run round the whole track, split into sections (orange marks on the lap path); the finish (red) is just before the start.'
    : r === 'ab' ? (tcImporting() ? 'One way from the start to the finish (red), split into sections (orange). In Quick Create untick "Loop" and draw the guide from the start to the finish.' : 'One way: the road starts at the start line and ends at your last point (the finish, red), split into sections (orange marks).') : '';
}
$('#tc_race').addEventListener('change', () => { tcRaceUI(); tcUpdate(true); tcSave(); });
$('#tc_sections').addEventListener('input', () => { tcUpdate(true); tcSave(); });
$('#tc_sharp').addEventListener('change', () => { TC.impKey = ''; tcUpdate(); tcSave(); });
$('#tc_bright').addEventListener('change', () => { TC.impKey = ''; tcUpdate(); tcSave(); });
// your textures' brightness (1 = as they are): multiplies their colour when the mod is built
function tcBright() { const v = parseFloat($('#tc_bright').value); return isFinite(v) ? Math.min(1.5, Math.max(0.2, v / 100)) : 1; }
function brightRGBA(px, k) { if (k === 1) return px; for (let i = 0; i < px.length; i += 4) { px[i] = Math.min(255, px[i] * k); px[i + 1] = Math.min(255, px[i + 1] * k); px[i + 2] = Math.min(255, px[i + 2] * k); } return px; }
$('#tc_big').addEventListener('change', () => { TC.impKey = ''; tcLoadCap(); tcSave(); });
$('#tc_build').onclick = () => tcBuild(false);
$('#tc_zip').onclick = () => tcBuild(true);
// ---------------------------------------------------------------- Track Creator: Finish / Edit Model
// Finish turns the track into a course you edit like any other (objects, paths, the Minimap tool) with your model as the track.
// The course is kept (TC.docBytes); building uses it plus the model's parts. Changing paths in the Track Creator after
// finishing replaces the course's paths, item boxes and start grid on the next Finish (other objects stay).
const CUSTOM_PATH = `Banc/${NEWSLOT.CZ}[Game03].bcett.byml.zs`;
const tcPathKey = () => JSON.stringify([$('#tc_race').value, $('#tc_sections').value, tcImporting() ? TC.qc : null, tcImporting() ? null : TC.pts, tcImporting() ? null : tcGenOpts()]);
function tcFlushDoc() { if (!S.customTrack || !S.doc || TC.noFlush) return; try { syncCounts(); const b = writeByml(S.doc);
  if (TC.route && TC.route !== 'A') { const v = TC.variants.find(x => x.letter === TC.route); if (v) { v.bytes = b; tcSaveVariants(); } return; }
  TC.docBytes = b; idb.set('tc-doc', { bytes: TC.docBytes, key: TC.docKey }); } catch (e) { console.error(e); } }
// ---------------------------------------------------------------- extra routes (lap-type variants, like Crown City's)
// route A is the track's main course (TC.docBytes); B, C… are copies with their own paths, start and objects, sharing the model
TC.variants = []; TC.route = 'A';
const tcSaveVariants = () => idb.set('tc-variants', TC.variants.map(v => ({ letter: v.letter, name: v.name, bytes: v.bytes })));
const tcRouteName = l => l === 'A' ? ($('#tc_name').value.trim() || 'Custom Track') : (TC.variants.find(v => v.letter === l)?.name || 'Route ' + l);
function tcRoutesFill() {
  const opts = () => [el('option', { value: 'A' }, 'A: ' + tcRouteName('A') + ' (main)'), ...TC.variants.map(v => el('option', { value: v.letter }, v.letter + ': ' + v.name))];
  for (const id of ['#tc_route', '#cv_route']) { const sel = $(id); if (!sel) continue; sel.replaceChildren(...opts()); sel.value = TC.route; }
  $('#cv_routebox').style.display = S.customTrack ? '' : 'none';
  $('#tc_routedel').disabled = $('#tc_routeren').disabled = TC.route === 'A';
}
async function tcRouteBytes(l) { if (l !== 'A') return TC.variants.find(v => v.letter === l)?.bytes; TC.noFlush = true; try { return await tcFinishedDoc(); } finally { TC.noFlush = false; } }
async function tcSwitchRoute(l) {
  if (l === TC.route) return;
  if (S.customTrack) tcFlushDoc();
  TC.route = l; tcRoutesFill();
  if (S.customTrack && !TC.active) { const b = await tcRouteBytes(l); if (b) { loadDoc(b, CUSTOM_PATH); $('#title').textContent = tcRouteName('A') + (l === 'A' ? '' : ` – route ${l}: ${tcRouteName(l)}`) + ' (custom track)'; } }
}
async function tcNewRoute() {
  if (!S.romfs || S.romfs.fake) return toast('Open RomFS first.', 'err');
  const used = new Set(TC.variants.map(v => v.letter)), letter = 'BCDEFGHIJKLMNOPQRSTUVWXY'.split('').find(x => !used.has(x));
  if (!letter) return toast('That\'s the most routes a track can have.', 'err');
  const name = prompt(`Name for route ${letter} (shown in game):`, `${tcRouteName('A')} ${letter}`); if (name === null) return;
  busy('Copying the route…');
  try { if (S.customTrack) tcFlushDoc(); const src = await tcRouteBytes(TC.route); if (!src) throw new Error('finish the track first');
    TC.variants.push({ letter, name: name.trim() || `Route ${letter}`, bytes: src.slice() }); tcSaveVariants(); tcSave();
    await tcSwitchRoute(letter);
    toast(`Route ${letter} made from a copy of the route you had open. ${S.customTrack ? 'It\'s open now: change its paths, start and objects.' : 'Press Finish to edit it in the course view.'} In game it's one of the track's lap types.`, 'ok');
  } catch (e) { console.error(e); toast('Couldn\'t make the route: ' + e.message, 'err'); }
  busy();
}
async function tcFreshDoc() { const { rd, spec } = await tcWorldSpec(false); return courseDocBytes(rd, spec); }
// the paths, item boxes and start grid of `fresh`, everything else from `old`
function tcMergeDoc(oldBytes, freshBytes) {
  const o = parseByml(oldBytes).root, f = parseByml(freshBytes).root, paths = n => n === 'LapPathGraph' || n === 'RoutePathGraph', mine = a => /ItemBox/.test(a.Name || '') || a.Name === 'StartPosition';
  o.Rails = [...(o.Rails || []).filter(r => !paths(r.Name)), ...(f.Rails || []).filter(r => paths(r.Name))];
  o.Actors = [...(o.Actors || []).filter(a => !mine(a)), ...(f.Actors || []).filter(mine)];
  return writeByml(o);
}
async function tcFinishedDoc() {
  if (S.customTrack) tcFlushDoc();
  if (TC.docBytes && TC.docKey === tcPathKey()) return TC.docBytes;
  const fresh = await tcFreshDoc();
  TC.docBytes = TC.docBytes ? tcMergeDoc(TC.docBytes, fresh) : fresh; TC.docKey = tcPathKey();
  idb.set('tc-doc', { bytes: TC.docBytes, key: TC.docKey });
  if (S.customTrack && S.doc && TC.route === 'A' && !TC.noFlush) { S.doc = parseByml(TC.docBytes).root; buildScene(true); }
  return TC.docBytes;
}
async function tcFinish() {
  if (!S.romfs || S.romfs.fake) return toast('Open RomFS first: the course is made from your game files.', 'err');
  busy('Finishing the track…');
  try {
    tcUpdate();
    const changed = TC.docBytes && TC.docKey !== tcPathKey();
    const raw = await tcFinishedDoc();
    tcClose(); S.edited.delete(CUSTOM_PATH); TC.docBytes = raw;
    const vb = TC.route !== 'A' && TC.variants.find(v => v.letter === TC.route)?.bytes; if (!vb) TC.route = 'A';
    loadDoc(vb || raw, CUSTOM_PATH);
    $('#title').textContent = tcRouteName('A') + (TC.route === 'A' ? '' : ` – route ${TC.route}: ${tcRouteName(TC.route)}`) + ' (custom track)'; tcRoutesFill();
    toast(`${changed ? 'Paths, item boxes and start grid updated from the Track Creator. ' : ''}Your track is open in the Map: add objects and edit paths like any course. Save as mod (or Ctrl+S) builds it; the Model, Collision and Paths tabs go back to its other editors.`, 'ok');
  } catch (e) { console.error(e); toast('Couldn\'t finish: ' + e.message, 'err'); }
  busy();
}
// the course view of a finished track: your model (and its collision, for snapping) where the track is
function tcTrackView() {
  KITMESH.length = 0;
  const grp = new THREE.Group(); grp.position.set(...SLOT_START);
  if (tcImporting() && TC.vis) {
    if (!TC.impGroup.children.length) { TC.impKey = ''; tcImpPreview(); }
    for (const c of TC.impGroup.children) grp.add(c.clone());
    for (const m of TC.rayGroup.children) { const r = m.clone(); grp.add(r); TRACK.meshes.push(r); }
  } else for (const m of TC.preview.children) if (m.isMesh) { const c = m.clone(); grp.add(c); TRACK.meshes.push(c); }
  trackGroup.add(grp); grp.updateMatrixWorld(true);
  TRACK.note = 'Track: your custom track model'; trackGroup.visible = $('#showTrack').checked; updateTrackNote();
}
$('#tc_finish').onclick = tcFinish;
$('#tc_presetkind')?.replaceChildren(...PRESETS.map(p => el('option', { value: p.id }, p.label)));
$('#tc_presetadd').onclick = async () => {
  if (!tcImporting() || !TC.vis) return toast('Import your track model first: presets are added into it.', 'err');
  if (!S.romfs || S.romfs.fake) return toast('Open RomFS first: presets are read from your game files.', 'err');
  const t = orbit.target, y = tcHeight(t.x, t.y + 50, t.z);
  TC.presets.push({ id: Date.now(), kind: $('#tc_presetkind').value, pos: [+t.x.toFixed(2), +(y ?? t.y).toFixed(2), +t.z.toFixed(2)], yaw: 0, scale: 1 });
  tcSave(); await tcEnsurePresets(); TC.impKey = ''; tcUpdate(); tcPresetList();
};
$('#tc_route').onchange = () => tcSwitchRoute($('#tc_route').value);
$('#cv_route').onchange = () => tcSwitchRoute($('#cv_route').value);
$('#tc_routenew').onclick = tcNewRoute; $('#cv_routenew').onclick = tcNewRoute;
$('#tc_routeren').onclick = () => { const v = TC.variants.find(x => x.letter === TC.route); if (!v) return; const n = prompt(`New name for route ${v.letter}:`, v.name); if (n === null) return; v.name = n.trim() || v.name; tcSaveVariants(); tcRoutesFill(); };
$('#tc_routedel').onclick = async () => { const v = TC.variants.find(x => x.letter === TC.route); if (!v || !confirm(`Delete route ${v.letter} (${v.name})? Its paths and objects are lost (unless you saved the project).`)) return;
  TC.variants = TC.variants.filter(x => x !== v); tcSaveVariants(); TC.route = 'A'; tcRoutesFill(); if (S.customTrack && !TC.active) { const b = await tcRouteBytes('A'); if (b) loadDoc(b, CUSTOM_PATH); } };
$('#tc_editmodel').onclick = () => { if (!TC.active) tcOpen(); };
async function tcRestoreDoc() { try { const d = await idb.get('tc-doc'); if (d && d.bytes && !TC.docBytes) { TC.docBytes = d.bytes; TC.docKey = d.key; } const v = await idb.get('tc-variants'); if (Array.isArray(v)) TC.variants = v; tcRoutesFill(); } catch {} }

// ---------------------------------------------------------------- Track Creator: minimap
// the editor's Minimap tool on the custom track: its settings are kept and the minimap is drawn from the lap path at every build
async function tcOpenMinimap() {
  if (!S.romfs || S.romfs.fake) return toast('The minimap needs the RomFS folder open.', 'err');
  busy('Drawing the minimap…');
  try {
    const rd = p => readAt(S.romfs, p), V = await gameVersion(rd);
    const doc = S.customTrack && !TC.active ? S.doc : parseByml(TC.docBytes && TC.docKey === tcPathKey() ? TC.docBytes : await tcFreshDoc()).root;
    const tex = await rd(`Layout/MiniMap_${NEWSLOT.CA}.Nin_Ounce_NVN2.bntx.zs`), gf = await rd(`System/GymlArchive/general_format.Product_${V}.sarc.zs`);
    if (!tex || !gf) throw new Error('Rainbow Road\'s minimap files are missing from the dump');
    const param = parseByml(parseSarcM(zsDecompress(gf)).get(`Gyml/MiniMapCourseGParam/MiniMap_${NEWSLOT.CA}.game__MiniMapCourseGParam.bgyml`)).root;
    const texRaw = zsDecompress(tex), info = bntxInfo(texRaw);
    MM.doc = doc;
    const game = await minimapFrame(param, info.width, info.height);
    MM.info = { custom: true, name: 'MiniMap_' + NEWSLOT.CZ, texRaw, info, param, game };
    MM.place = new THREE.Matrix4().makeTranslation(...SLOT_START);
    $('#mm_srcrow').style.display = 'flex';
    { const o = TC.mm?.opt || {}; $('#mm_src').value = o.src || 'path'; $('#mm_tex').checked = o.tex !== false; $('#mm_pathtoo').checked = !!o.pathToo; if ($('#mm_src').value === 'track' && !tcImporting() && !TC.gen) $('#mm_src').value = 'path'; mmSrcUI(); }
    if (TC.mm) { const o = TC.mm.opt; $('#mm_color').value = o.color; $('#mm_outline').value = o.outlineColor; $('#mm_doOutline').checked = o.outline; $('#mm_opacity').value = o.opacity * 100; $('#mm_width').value = o.width * 100; $('#mm_routes').checked = o.routes; $('#mm_fit').checked = TC.mm.fit; }
    else $('#mm_fit').checked = true;
    $('#mm_name').textContent = `${$('#tc_name').value.trim() || 'Custom Track'} · ${info.width}×${info.height}`;
    $('#mm_add').textContent = 'Use for this track';
    $('#mmdlg').showModal(); drawMinimapPreview();
  } catch (e) { console.error(e); toast('Minimap: ' + e.message, 'err'); }
  busy();
}
$('#mmdlg').addEventListener('close', () => { if (MM.info?.custom) { MM.doc = null; MM.info = null; MM.place = null; $('#mm_add').textContent = 'Add to mod'; $('#mm_srcrow').style.display = 'none'; } });
$('#tc_minimap').onclick = tcOpenMinimap;
// called by the build with the finished course, Rainbow Road's minimap texture and settings: draw ours, frame it to fit
async function tcMinimapFor(root, texRaw, param, world) {
  const opt = TC.mm?.opt || mmOptions(), fit = world ? true : TC.mm ? TC.mm.fit : true, info = bntxInfo(texRaw);
  const keepDoc = MM.doc, keepPlace = MM.place; MM.doc = root;
  // the course is in the open world in this build: the model goes where the build puts the track
  MM.place = world && TC.fr?.on ? new THREE.Matrix4().makeTranslation(TC.fr.x, frHeight(TC.fr), TC.fr.z).multiply(new THREE.Matrix4().makeRotationY(TC.fr.yaw * Math.PI / 180)) : new THREE.Matrix4().makeTranslation(...SLOT_START);
  try {
    const game = await minimapFrame(param, info.width, info.height);
    MM.fitExtra = mmFitPts(opt); let fr; try { fr = fit ? fitFrame(game) : game; } finally { MM.fitExtra = null; }
    // a course in the open world: its minimap camera is in world coordinates (tested in game: the player icons show)
    if (world) game.parent = null;
    const levels = (l, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(renderMinimap(fr, opt), 0, 0, w, h); return c.getContext('2d').getImageData(0, 0, w, h).data; };
    const tex = replaceBntxAstc(texRaw, levels);
    let pos = fr.pos.clone(), yawDeg = fr.yaw * 180 / Math.PI;
    if (game.parent) { pos = game.parent.worldToLocal(pos.clone()); const f = new THREE.Vector3(0, 0, 1).applyQuaternion(game.parent.quaternion); yawDeg -= Math.atan2(f.x, f.z) * 180 / Math.PI; }
    yawDeg = ((yawDeg % 360) + 540) % 360 - 180;
    return { tex, cam: fit ? { x: f32(pos.x), z: f32(pos.z), yaw: f32(yawDeg), size: f32(fr.size) } : null };
  } finally { MM.doc = keepDoc; MM.place = keepPlace; }
}

// ---------------------------------------------------------------- Track Creator projects
// one .zip with everything: project.json (the design, paths, music, materials) + the model, collision model and hand-picked textures.
// Built mods carry a copy (trackcreator-project.zip), so a mod's zip opens as a project too.
async function unzip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = new Map();
  let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--; if (e < 0) throw new Error('not a zip file');
  let c = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true), dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(c + 10, true), csize = dv.getUint32(c + 20, true), nl = dv.getUint16(c + 28, true), xl = dv.getUint16(c + 30, true), cl = dv.getUint16(c + 32, true), lo = dv.getUint32(c + 42, true);
    const name = dec.decode(u8.subarray(c + 46, c + 46 + nl)); c += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), raw = u8.subarray(start, start + csize);
    if (method === 0) out.set(name, raw.slice());
    else if (method === 8) out.set(name, new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
  }
  return out;
}
async function tcProjectZip() {
  const d = tcDesign(), entries = [], enc = new TextEncoder(), safe = n => n.replace(/[\\/:*?"<>|]/g, '_');
  d.kind = 'mkwe-track-project'; d.texOver = {};
  if (tcImporting()) for (const kind of ['vis', 'col']) for (const f of TC[kind]?.files || []) entries.push([`${kind}/${safe(f.name)}`, f.bytes]);
  for (const f of TC.mmModel?.files || []) entries.push([`mm/${safe(f.name)}`, f.bytes]);
  Object.entries(TC.texOver).filter(([mat]) => tcImporting() || mat.startsWith('@')).forEach(([mat, t], i) => { const p = `tex/${i}_${safe(t.name)}`; d.texOver[mat] = p; entries.push([p, t.bytes]); });
  if (TC.docBytes) { tcFlushDoc(); entries.push(['course.byml', TC.docBytes]); d.docKey = TC.docKey; }
  d.variants = TC.variants.map(v => ({ letter: v.letter, name: v.name })); for (const v of TC.variants) if (v.bytes) entries.push([`routes/${v.letter}.byml`, v.bytes]);
  entries.unshift(['project.json', enc.encode(JSON.stringify(d, null, 1))]);
  return new Uint8Array(await makeZip(entries).arrayBuffer());
}
async function tcOpenProject(name, bytes) {
  if (/\.json$/i.test(name)) { tcPush(); tcApplyDesign(JSON.parse(new TextDecoder().decode(bytes))); TC.sel = -1; tcUpdate(); tcFrame(); return toast('Loaded ' + name + ' (an old design file: it has no model in it).', 'ok'); }
  let z = await unzip(bytes);
  if (!z.has('project.json')) {   // a built mod's zip: open the project it carries
    const inner = [...z.keys()].find(k => /trackcreator-project\.zip$/i.test(k));
    if (!inner) throw new Error('this zip has no Track Creator project in it (mods built before v23 don\'t carry one)');
    z = await unzip(z.get(inner));
  }
  const d = JSON.parse(new TextDecoder().decode(z.get('project.json')));
  busy('Opening ' + name + '…');
  try {
    tcPush(); tcApplyDesign(d); TC.qcHist = []; TC.esel = null; TC.wsel = null; TC.texOver = {}; TC.texVer++;
    const files = kind => [...z].filter(([k]) => k.startsWith(kind + '/')).map(([k, b]) => ({ name: k.slice(kind.length + 1), bytes: b }));
    TC.vis = null; TC.col = null;
    if (files('vis').length) await tcSetModel('vis', files('vis'), true); else idb.set('tc-vis', null);
    if (files('col').length) await tcSetModel('col', files('col'), true); else idb.set('tc-col', null);
    TC.mmModel = null; idb.set('tc-mm', null); if (files('mm').length) try { const f = files('mm'); TC.mmModel = { name: f.find(x => /\.(obj|fbx|dae)$/i.test(x.name))?.name || f[0].name, files: f, model: await parseModel(f) }; idb.set('tc-mm', { files: f }); } catch (e) { console.error(e); }
    for (const [mat, p] of Object.entries(d.texOver || {})) { const b = z.get(p); if (b) try { TC.texOver[mat] = { name: p.replace(/^tex\/\d+_/, ''), bytes: b, canvas: await imageFileToCanvas({ name: p, bytes: b }) }; } catch {} }
    tcSurfMats.clear(); tcFillSurfTex(); tcFillPics();
    idb.set('tc-texover', Object.fromEntries(Object.entries(TC.texOver).map(([k, v]) => [k, { name: v.name, bytes: v.bytes }])));
    TC.map = d.map ? { slot: { ...d.map.slot }, surf: { ...d.map.surf }, cut: { ...(d.map.cut || {}) }, two: { ...(d.map.two || {}) } } : TC.map;
    TC.variants = (d.variants || []).map(v => ({ ...v, bytes: z.get(`routes/${v.letter}.byml`) || null })).filter(v => v.bytes); TC.route = 'A'; tcSaveVariants(); tcRoutesFill();
    TC.docBytes = z.get('course.byml') || null; TC.docKey = d.docKey || null; idb.set('tc-doc', TC.docBytes ? { bytes: TC.docBytes, key: TC.docKey } : null);
    tcFillMaps(); TC.impKey = ''; TC.sel = -1; tcSave(); tcUpdate();
    if (TC.vis) tcFrameModel(); else tcFrame();
    toast(`Opened ${d.name || name}${TC.vis ? ` with ${TC.vis.name}` : ''}.`, 'ok');
  } finally { busy(); }
}
$('#tc_export').onclick = async () => {
  const n = ($('#tc_mod').value.trim() || 'track').replace(/[^A-Za-z0-9_-]+/g, '');
  const target = await pickSave(n + '.mkwtrack.zip', 'project'); if (!target) return toast('Not saved.');
  busy('Saving the project…'); try { const z = await tcProjectZip(); const saved = await writeSave(target, z); busy(); toast(`Saved ${saved}: the design, paths, music and your model files. Open project loads it back (here or on another PC).`, 'ok'); } finally { busy(); }
};
$('#tc_import').onclick = () => $('#tc_file').click();
$('#tc_file').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { await tcOpenProject(f.name, new Uint8Array(await f.arrayBuffer())); } catch (err) { console.error(err); busy(); toast('Couldn\'t open ' + f.name + ': ' + err.message, 'err'); } };
window.__mkwe = { tcVM: () => tcVM(),  GL, select, orbit, camera, renderer, tcOpenProject, tcProjectZip, unzip, tcCheckDump, S, TC, QC, tcBuild, tcUpdate, tcSetModel, qcPreview, drawGuide, gizmo, frHeight: f => frHeight(f), frGround: (x, z) => frGround(x, z), trGround: (x, z) => trGround(x, z) };

// ---------------------------------------------------------------- Track Creator: your own models
const TC_PLACE = { scale: 'tc_sc', rotY: 'tc_rot', ox: 'tc_ox', oy: 'tc_oy', oz: 'tc_oz', tiltX: 'tc_tx', tiltZ: 'tc_tz' };
Object.assign(TC, { surf: null, edit: false, esel: null, edrag: null, addItem: false, qcHist: [], handlesQC: [], eSnap: true, wpick: false, wsel: null, pivot: null, texOver: {}, texVer: 0, pickFor: null, vis: null, col: null, map: { slot: {}, surf: {}, cut: {}, two: {} }, impGroup: new THREE.Group(), rayGroup: new THREE.Group(), impKey: '', pack: null, impBounds: null });
const tcImporting = () => $('#tc_src').value === 'import';
function tcPlace() { const o = {}; for (const [k, id] of Object.entries(TC_PLACE)) { const v = parseFloat($('#' + id).value); o[k] = isFinite(v) ? v : (k === 'scale' ? 1 : 0); } if (!(o.scale > 0)) o.scale = 1; o.zUp = $('#tc_zup').checked; o.pivot = TC.pivot || [0, 0, 0]; return o; }
function tcGenOpts() {
  const o = tcOpts();
  o.uv = { road: tcUV('road'), shoulder: tcUV('edge'), wall: tcUV('wall'), ground: tcUV('ground'), beach: tcUV('beach'), rail: tcUV('rail'), cliff: tcUV('cliff'), mushroom: tcUV('mushroom') };
  // beach: sand round the grass ground's square, down into the water (4 m under it in the open world, else 8 m down)
  $('#tc_beach').disabled = !$('#tc_ground').checked;
  if (!tcImporting() && $('#tc_beach').checked) { o.beach = Math.max(4, parseFloat($('#tc_beachw').value) || 30); const wy = tcWaterY(); o.beachY = wy === null ? null : wy - 4; }
  o.tunnel = false;   // tunnels: per point
  if (tcImporting()) { o.noRoad = true; o.ground = false; if ($('#tc_snapm').checked && TC.vis) o.heightAt = tcHeightW; }
  return o;
}
const tcDown = new THREE.Raycaster();
function tcHeight(x, y, z) {   // the model's surface under (x, z), searching down from a bit above y
  if (!tcImporting() || !TC.vis || !$('#tc_snapm').checked || !TC.rayGroup.children.length) return null;
  tcDown.set(new THREE.Vector3(x, y + 12, z), new THREE.Vector3(0, -1, 0)); tcDown.far = 200;
  const hit = tcDown.intersectObjects(TC.rayGroup.children, false)[0];
  if (hit) return hit.point.y;
  tcDown.set(new THREE.Vector3(x, (TC.impBounds?.[1][1] ?? y) + 50, z), new THREE.Vector3(0, -1, 0)); tcDown.far = 100000;
  const h2 = tcDown.intersectObjects(TC.rayGroup.children, false)[0];
  return h2 ? h2.point.y : null;
}
// ---------------------------------------------------------------- Free Roam placement
// The track's model parts and objects are copied into the open world. The map is drawn from the game's own height map
// (Tex/Map_Height_Root_Height: 512 x 512 pixels of 32 m, centred on the world's origin, north up).
const FR_SEA = 220, FR_HALF = 8192;
const FRM = { h: null, img: null, names: [], zoom: 1, cx: 0, cz: 2000, drag: null, loading: null };
window.__mkwe.FRM = FRM;
const frDefault = () => ({ on: false, x: -200, z: 5400, yaw: 0, auto: true, raise: 3, y: FR_SEA });   // 3 m up: the road sits above the water unless you lower part of it
async function frLoadMap() {
  if (FRM.h) return true;
  if (FRM.loading) return FRM.loading;
  return FRM.loading = (async () => {
    if (!S.romfs || S.romfs.fake) return false;
    const raw = await readAt(S.romfs, 'Tex/Map_Height_Root_Height.bntx.zs'); if (!raw) return false;
    const b = zsDecompress(raw), i = bntxInfo(b), size = i.mipOffsets[1] - i.mipOffsets[0], bpp = size / (i.width * i.height);
    const lin = untile(b.subarray(i.mipOffsets[0], i.mipOffsets[1]), i.width * bpp, i.height, i.blockHeightLog2, i.orin), u = new Uint16Array(lin.buffer, lin.byteOffset, lin.length / 2);
    const W = i.width, h = new Float32Array(W * W);
    for (let k = 0; k < W * W; k++) h[k] = u[k * bpp / 2] * 0.02763 - 15.2;   // metres (fitted to the courses' start lines)
    FRM.h = h; FRM.W = W;
    // shaded relief: sea in blues by depth, land by height, lit from the north-west
    const c = document.createElement('canvas'); c.width = c.height = W; const im = c.getContext('2d').createImageData(W, W);
    const H = (x, y) => h[Math.min(W - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const v = H(x, y), o = (y * W + x) * 4; let col;
      if (v < FR_SEA - 1) { const d = Math.min(1, (FR_SEA - v) / 40); col = [40 - 25 * d, 110 - 60 * d, 170 - 70 * d]; }
      else { const t = Math.min(1, (v - FR_SEA) / 900), shade = Math.max(0.45, Math.min(1.35, 1 + ((H(x - 1, y - 1) - H(x + 1, y + 1)) / 64)));
        const base = t < 0.12 ? [222, 205, 150] : t < 0.55 ? [96 + 60 * t, 150 - 20 * t, 72] : [150 + 60 * t, 140 + 70 * t, 120 + 100 * t];
        col = base.map(q => q * shade); }
      im.data.set([...col.map(q => Math.max(0, Math.min(255, q))), 255], o);
    }
    c.getContext('2d').putImageData(im, 0, 0); FRM.img = c;
    // course names: the middle of each course's area boxes in the world file
    try {
      const wr = await readAt(S.romfs, 'Banc/World_Game03/WorldResident.bcett.byml.zs');
      if (wr) { const acc = {}; const nv = v => (v && typeof v === 'object' && 'v' in v) ? Number(v.v) : Number(v);
        for (const a of parseByml(zsDecompress(wr)).root.Actors || []) if (a.Name === 'Area_CourseAreaCube' && a.Dynamic?.CourseArea && a.Translate) {
          const k = String(a.Dynamic.CourseArea).split('/').pop().split('.')[0]; (acc[k] = acc[k] || []).push([nv(a.Translate[0]), nv(a.Translate[2])]); }
        FRM.names = Object.entries(acc).map(([k, ps]) => ({ key: k, label: VS_STAGES.find(v => v[0] === k)?.[1] || k, x: ps.reduce((q, p) => q + p[0], 0) / ps.length, z: ps.reduce((q, p) => q + p[1], 0) / ps.length })); }
    } catch (e) { console.error(e); }
    return true;
  })();
}
function frGround(x, z) {
  const real = trGround(x, z); if (real !== null) return real;   // the real ground, where World terrain has loaded it
  if (!FRM.h) return FR_SEA;
  const W = FRM.W, fx = Math.max(0, Math.min(W - 1.001, (x + FR_HALF) / 32 - 0.5)), fz = Math.max(0, Math.min(W - 1.001, (z + FR_HALF) / 32 - 0.5)), x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0, H = (a, b) => FRM.h[b * W + a];
  return (H(x0, z0) * (1 - tx) + H(x0 + 1, z0) * tx) * (1 - tz) + (H(x0, z0 + 1) * (1 - tx) + H(x0 + 1, z0 + 1) * tx) * tz;
}
const frHeight = fr => (fr.auto ? (fr.seabed ? frGround(fr.x, fr.z) : Math.max(frGround(fr.x, fr.z), FR_SEA)) : +fr.y || FR_SEA) + (+fr.raise || 0);
// the sea's height in the track's own coordinates (0 = the start line), when the track is in the open world
const tcWaterY = () => TC.fr?.on ? FR_SEA - frHeight(TC.fr) : null;
// the model's surface, or the water's where the model is under it: karts ride on the water there, so the lap path,
// CPU routes and item boxes follow the water's surface (lap boxes on the seabed would count karts as out of bounds)
const tcHeightW = (x, y, z) => { const h = tcHeight(x, y, z), w = tcWaterY(); return h === null || h === undefined || w === null ? h : Math.max(h, w); };
// the track's outline in track space: its lap path and the box round its model
function frShape() {
  const g = TC.gen, lap = (tcImporting() ? TC.qc?.lap : g?.lap) || [];
  let box = tcImporting() ? TC.impBounds : g?.bounds; if (box && !tcImporting()) { const m = (g.opts?.width || 20) / 2 + (g.opts?.shoulder || 0); box = [[box[0][0] - m, 0, box[0][2] - m], [box[1][0] + m, 0, box[1][2] + m]]; }
  return { path: lap.map(n => [n.pos[0], n.pos[2]]), box };
}
const frPlace = (fr, x, z) => { const c = Math.cos(fr.yaw * Math.PI / 180), s = Math.sin(fr.yaw * Math.PI / 180); return [fr.x + c * x + s * z, fr.z - s * x + c * z]; };
function frNear(x, z) { let best = null, d = Infinity; for (const n of FRM.names) { const e = Math.hypot(n.x - x, n.z - z); if (e < d) { d = e; best = n; } } return best ? { ...best, d } : null; }
function frInfo() {
  const fr = TC.fr || frDefault(), n = frNear(fr.x, fr.z);
  $('#tc_frinfo').textContent = !fr.on ? 'Not in Free Roam.' : `In Free Roam${n ? `, ${n.d < 400 ? 'at' : 'near'} ${n.label}` : ''}: x ${Math.round(fr.x)}, z ${Math.round(fr.z)}, height ${Math.round(frHeight(fr))}${fr.yaw ? `, turned ${fr.yaw}°` : ''}. The water is ${(() => { const w = FR_SEA - frHeight(fr); return Math.abs(w) < 0.5 ? 'level with your start line' : `${Math.abs(w).toFixed(1)} m ${w < 0 ? 'below' : 'above'} your start line`; })()}.`;
}
function frDraw() {
  const cv = $('#fr_map'), ctx = cv.getContext('2d'), Wc = cv.width, fr = TC.fr, k = FRM.zoom * Wc / (2 * FR_HALF);
  const X = x => Wc / 2 + (x - FRM.cx) * k, Z = z => Wc / 2 + (z - FRM.cz) * k;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0d1a2b'; ctx.fillRect(0, 0, Wc, Wc);
  if (FRM.img) { ctx.imageSmoothingEnabled = FRM.zoom < 6; ctx.drawImage(FRM.img, X(-FR_HALF), Z(-FR_HALF), 2 * FR_HALF * k, 2 * FR_HALF * k); }
  else { ctx.fillStyle = '#9aa'; ctx.font = '14px sans-serif'; ctx.fillText('Open RomFS to see the world map.', 20, 30); }
  if ($('#fr_grid').checked) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '10px sans-serif';
    for (let v = -8000; v <= 8000; v += 1000) { ctx.beginPath(); ctx.moveTo(X(v), 0); ctx.lineTo(X(v), Wc); ctx.moveTo(0, Z(v)); ctx.lineTo(Wc, Z(v)); ctx.stroke(); }
    if (k * 1000 > 40) for (let v = -8000; v < 8000; v += 1000) { ctx.fillText(String(v), X(v) + 2, 10); ctx.fillText(String(v), 2, Z(v) - 2); }
  }
  if ($('#fr_names').checked) { ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    for (const n of FRM.names) { const x = X(n.x), y = Z(n.z); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(n.label, x + 1, y + 1); ctx.fillStyle = '#fff'; ctx.fillText(n.label, x, y); }
    ctx.textAlign = 'left'; }
  // the track
  const sh = frShape(), P = ([x, z]) => { const [a, b] = frPlace(fr, x, z); return [X(a), Z(b)]; };
  if (sh.box) { const [mn, mx] = sh.box, cs = [[mn[0], mn[2]], [mx[0], mn[2]], [mx[0], mx[2]], [mn[0], mx[2]]].map(P);
    ctx.fillStyle = 'rgba(255,225,74,0.18)'; ctx.strokeStyle = '#ffe14a'; ctx.lineWidth = 1.5; ctx.beginPath(); cs.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  if (sh.path.length > 1) { ctx.strokeStyle = '#3ddc84'; ctx.lineWidth = 2; ctx.beginPath(); sh.path.map(P).forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath(); ctx.stroke(); }
  const s0 = P([0, 0]), s1 = P([0, -Math.max(12, 30 / k)]); ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(...s0); ctx.lineTo(...s1); ctx.stroke(); ctx.beginPath(); ctx.arc(...s0, 3.5, 0, 7); ctx.fill();
  const g = frGround(fr.x, fr.z), n = frNear(fr.x, fr.z);
  $('#fr_read').innerHTML = `x <b>${Math.round(fr.x)}</b>, z <b>${Math.round(fr.z)}</b> · ground ${g < FR_SEA ? 'under the sea' : Math.round(g)} · your track at <b>${Math.round(frHeight(fr))}</b>${n ? `<br>${n.d < 400 ? 'At' : 'Near'} ${n.label} (${Math.round(n.d)} m)` : ''}`;
  $('#fr_yawv').textContent = fr.yaw + '°';
}
// ---------------------------------------------------------------- World terrain: the open world's real ground, read tile by tile
// Pick an area on the map: only those 250 m tiles are read. Detail turns each tile into an even grid (fewer triangles).
const TR_KEY = 'mkwe-terrain';
const TR = { area: null, step: 0, show: true, tiles: new Map(), group: new THREE.Group(), mat: new THREE.MeshLambertMaterial({ vertexColors: true }), ver: 0, loading: false, sel: null };
TR.group.matrixAutoUpdate = false; scene.add(TR.group); window.__mkwe.TR = TR; window.__mkwe.trLoad = trLoad;
try { const o = JSON.parse(localStorage.getItem(TR_KEY) || '{}'); if (o.area) TR.area = o.area; if (o.step !== undefined && o.v === 2) TR.step = o.step; if (o.show !== undefined) TR.show = o.show; } catch {}
const trSave = () => { try { localStorage.setItem(TR_KEY, JSON.stringify({ v: 2, area: TR.area, step: TR.step, show: TR.show })); } catch {} };
const trTilesOf = a => { const out = []; if (!a) return out; for (let tz = a[1]; tz <= a[3]; tz++) for (let tx = a[0]; tx <= a[2]; tx++) out.push([tx, tz]); return out; };
const trAreaText = a => { if (!a) return 'No area chosen.'; const w = a[2] - a[0] + 1, d = a[3] - a[1] + 1, n = w * d;
  return `${n} tile${n > 1 ? 's' : ''} (${(w * TILE / 1000).toFixed(2)} × ${(d * TILE / 1000).toFixed(2)} km), about ${Math.round(n * trisPerTile(TR.step) / 1000).toLocaleString()}k triangles at this detail`; };
// read the area's tiles (and forget the others)
async function trLoad() {
  if (TR.loading) return;
  if (!S.romfs || S.romfs.fake) return toast('Open RomFS first: the ground is read from your game files.', 'err');
  const want = trTilesOf(TR.area), keep = new Set(want.map(t => t.join(',')));
  for (const k of [...TR.tiles.keys()]) if (!keep.has(k)) TR.tiles.delete(k);
  TR.loading = true; let n = 0, miss = 0;
  try {
    for (const [tx, tz] of want) {
      const k = tx + ',' + tz, have = TR.tiles.get(k);
      if (have && (TR.step || have.tris || have.none)) continue;
      if (++n % 4 === 0) { busy(`Reading the ground… ${n} of ${want.length} tiles`); await new Promise(r => setTimeout(r)); }
      let raw = null; try { raw = await readAt(S.romfs, tileName(tx, tz)); } catch {}
      if (!raw) { TR.tiles.set(k, { none: true }); miss++; continue; }
      const tris = terrainTris(zsDecompress(raw));
      TR.tiles.set(k, { h: have?.h || rasterTile(tris), tris: TR.step ? null : tris });
    }
    if (TR.step) for (const t of TR.tiles.values()) t.tris = null;   // not needed at the grid details
  } catch (e) { console.error(e); toast('Couldn\'t read the ground: ' + e.message, 'err'); }
  busy(); TR.loading = false;
  if (miss === want.length && want.length) toast('None of these tiles are in this RomFS (Phive/Terrain/Game03_Proc). Open the 1.8 update\'s romfs folder.', 'err');
  trBuild();
}
function trBuild() {
  for (const m of TR.group.children) m.geometry.dispose();
  TR.group.clear();
  for (const [tx, tz] of trTilesOf(TR.area)) { const t = TR.tiles.get(tx + ',' + tz); if (!t || t.none || (!TR.step && !t.tris)) continue;
    const m = new THREE.Mesh(tileMesh(THREE, tx, tz, t.h, TR.step, t.tris), TR.mat); m.position.set(...tileCentre(tx, tz).flatMap((v, i) => i ? [0, v] : [v])); m.updateMatrix(); m.matrixAutoUpdate = false; m.userData.tile = [tx, tz]; TR.group.add(m); }
  TR.ver++; GL.key = ''; trInfo(); if (TC.active) tcUpdate(true);
}
// the ground's height at a world spot, from the loaded tiles (or null)
function trGround(x, z) {
  if (!TR.show) return null;
  const [tx, tz] = tileAt(x, z), t = TR.tiles.get(tx + ',' + tz); if (!t?.h) return null;
  const [cx, cz] = tileCentre(tx, tz); return heightIn(t.h, x - cx, z - cz);
}
// where the ground goes: world spots in the course view of an open-world course; in the Track Creator, round your track
// (where Free Roam placement puts it, or with the area's middle at your start line until you place it)
const TRM = new THREE.Matrix4();
function trFrame() {
  // your own track (Track Creator, or its course view) is drawn round its start line: the ground goes where Free Roam puts the track.
  // The game's open-world courses are drawn at their real world spots, so the ground stays put there.
  const has = TR.group.children.length > 0, mine = TC.active || S.customTrack || S.path === CUSTOM_PATH, world = /\[Game03\]|World_Game03/.test(S.path || '');
  TR.group.visible = has && TR.show && (mine || world);
  if (!TR.group.visible) return;
  if (!mine) { TR.group.matrix.identity(); TR.group.matrixWorldNeedsUpdate = true; return; }
  let fr = TC.fr?.on ? TC.fr : null, x, z, y, yaw = 0;
  if (fr) { x = fr.x; z = fr.z; y = frHeight(fr); yaw = fr.yaw * Math.PI / 180; }
  else { const a = TR.area; x = WORLD_MIN + (a[0] + a[2] + 1) * TILE / 2; z = WORLD_MIN + (a[1] + a[3] + 1) * TILE / 2; y = trGround(x, z); if (y === null) { const hs = [...TR.tiles.values()].filter(t => t.h).map(t => t.h[64 * 129 + 64]).filter(isFinite).sort((p, q) => p - q); y = hs.length ? hs[hs.length >> 1] : frGround(x, z); } }
  TRM.makeRotationY(yaw).setPosition(x, y, z); TR.group.matrix.copy(TRM).invert(); TR.group.matrixWorldNeedsUpdate = true;
}
function trInfo() {
  const el2 = $('#tc_trinfo'); if (!el2) return;
  const loaded = [...TR.tiles.values()].filter(t => t.h).length;
  el2.textContent = !TR.area ? 'Choose an area on the map to load its ground.' : `${trAreaText(TR.area)}. ${loaded ? `${loaded} loaded` : 'Not loaded yet'}${TC.fr?.on ? '' : '; until you place your track in Free Roam, the area\'s middle sits at your start line'}.`;
  $('#tc_trdetail').value = String(TR.step); $('#tc_trshow').checked = TR.show;
}
function trDraw() {
  const cv = $('#tr_map'), ctx = cv.getContext('2d'), Wc = cv.width, k = FRM.zoom * Wc / (2 * FR_HALF);
  const X = x => Wc / 2 + (x - FRM.cx) * k, Z = z => Wc / 2 + (z - FRM.cz) * k;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0d1a2b'; ctx.fillRect(0, 0, Wc, Wc);
  if (FRM.img) { ctx.imageSmoothingEnabled = FRM.zoom < 6; ctx.drawImage(FRM.img, X(-FR_HALF), Z(-FR_HALF), 2 * FR_HALF * k, 2 * FR_HALF * k); }
  else { ctx.fillStyle = '#9aa'; ctx.font = '14px sans-serif'; ctx.fillText('Open RomFS to see the world map.', 20, 30); }
  const tl = k * TILE;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
  for (let v = 0; v <= TILES; v += tl > 10 ? 1 : 4) { const w = WORLD_MIN + v * TILE; ctx.beginPath(); ctx.moveTo(X(w), Z(WORLD_MIN)); ctx.lineTo(X(w), Z(-WORLD_MIN)); ctx.moveTo(X(WORLD_MIN), Z(w)); ctx.lineTo(X(-WORLD_MIN), Z(w)); ctx.stroke(); }
  ctx.fillStyle = 'rgba(61,220,132,0.35)';
  for (const [key, t] of TR.tiles) if (t.h) { const [tx, tz] = key.split(',').map(Number), x = WORLD_MIN + tx * TILE, z = WORLD_MIN + tz * TILE; ctx.fillRect(X(x), Z(z), tl, tl); }
  if ($('#tr_names').checked) { ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    for (const n of FRM.names) { const x = X(n.x), y = Z(n.z); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(n.label, x + 1, y + 1); ctx.fillStyle = '#fff'; ctx.fillText(n.label, x, y); }
    ctx.textAlign = 'left'; }
  const a = TR.sel || TR.area;
  if (a) { const x0 = X(WORLD_MIN + a[0] * TILE), z0 = Z(WORLD_MIN + a[1] * TILE), x1 = X(WORLD_MIN + (a[2] + 1) * TILE), z1 = Z(WORLD_MIN + (a[3] + 1) * TILE);
    ctx.fillStyle = 'rgba(255,225,74,0.18)'; ctx.fillRect(x0, z0, x1 - x0, z1 - z0); ctx.strokeStyle = '#ffe14a'; ctx.lineWidth = 2; ctx.strokeRect(x0, z0, x1 - x0, z1 - z0); }
  if (TC.fr?.on) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(X(TC.fr.x), Z(TC.fr.z), 4, 0, 7); ctx.fill(); }
  $('#tr_read').textContent = trAreaText(a);
  const n = a ? (a[2] - a[0] + 1) * (a[3] - a[1] + 1) : 0, tris = n * trisPerTile(TR.step);
  $('#tr_warn').textContent = tris > 4e6 ? 'That\'s a lot of triangles: the 3D view may get slow. Pick a smaller area or less detail.' : n > 1024 ? 'Big area: reading it takes a while.' : '';
}
async function trOpen() {
  $('#trdlg').showModal(); $('#tr_detail').value = String(TR.step);
  const a = TR.area; if (a) { FRM.cx = WORLD_MIN + (a[0] + a[2] + 1) * TILE / 2; FRM.cz = WORLD_MIN + (a[1] + a[3] + 1) * TILE / 2; FRM.zoom = Math.max(1.5, Math.min(12, 6000 / Math.max(500, (a[2] - a[0] + 1) * TILE, (a[3] - a[1] + 1) * TILE))); }
  else if (TC.fr?.on) { FRM.cx = TC.fr.x; FRM.cz = TC.fr.z; FRM.zoom = 3; }
  trDraw(); if (await frLoadMap()) trDraw();
}
{
  const cv = $('#tr_map');
  const toWorld = e => { const r = cv.getBoundingClientRect(), Wc = cv.width, k = FRM.zoom * Wc / (2 * FR_HALF), px = (e.clientX - r.left) * Wc / r.width, py = (e.clientY - r.top) * Wc / r.height; return [FRM.cx + (px - Wc / 2) / k, FRM.cz + (py - Wc / 2) / k]; };
  const clampT = v => Math.max(0, Math.min(TILES - 1, v));
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId);
    if (e.button === 2) { FRM.drag = { pan: true, x: e.clientX, y: e.clientY, cx: FRM.cx, cz: FRM.cz }; return; }
    const [tx, tz] = tileAt(...toWorld(e)); FRM.drag = { pan: false, t: [clampT(tx), clampT(tz)] }; TR.sel = [FRM.drag.t[0], FRM.drag.t[1], FRM.drag.t[0], FRM.drag.t[1]]; trDraw(); });
  cv.addEventListener('pointermove', e => { if (!FRM.drag) return;
    if (FRM.drag.pan) { const r = cv.getBoundingClientRect(), k = FRM.zoom * cv.width / (2 * FR_HALF) * r.width / cv.width; FRM.cx = FRM.drag.cx - (e.clientX - FRM.drag.x) / k; FRM.cz = FRM.drag.cz - (e.clientY - FRM.drag.y) / k; trDraw(); return; }
    const [tx, tz] = tileAt(...toWorld(e)).map(clampT), s = FRM.drag.t; TR.sel = [Math.min(s[0], tx), Math.min(s[1], tz), Math.max(s[0], tx), Math.max(s[1], tz)]; trDraw(); });
  cv.addEventListener('pointerup', () => { if (FRM.drag && !FRM.drag.pan && TR.sel) { TR.area = TR.sel; trSave(); } TR.sel = null; FRM.drag = null; trDraw(); trInfo(); });
  cv.addEventListener('wheel', e => { e.preventDefault(); const [x, z] = toWorld(e), f = e.deltaY < 0 ? 1.25 : 0.8; FRM.zoom = Math.max(1, Math.min(40, FRM.zoom * f)); const [x2, z2] = toWorld(e); FRM.cx += x - x2; FRM.cz += z - z2; trDraw(); }, { passive: false });
  $('#tr_names').onchange = trDraw;
  $('#tr_detail').onchange = () => { TR.step = +$('#tr_detail').value; $('#tc_trdetail').value = String(TR.step); trSave(); trDraw(); };
  $('#tr_load').onclick = async () => { if (!TR.area) return toast('Drag on the map to choose an area first.', 'err'); await trLoad(); trDraw(); };
  $('#tr_clear').onclick = () => { TR.area = null; TR.tiles.clear(); trSave(); trBuild(); trDraw(); };
  $('#tr_close').onclick = () => $('#trdlg').close();
  $('#tc_trmap').onclick = trOpen;
  $('#tc_trload').onclick = trLoad;
  $('#tc_trdetail').onchange = () => { TR.step = +$('#tc_trdetail').value; trSave(); if (TR.tiles.size) trLoad(); else trInfo(); };
  $('#tc_trshow').onchange = () => { TR.show = $('#tc_trshow').checked; trSave(); GL.key = ''; if (TC.active) tcUpdate(true); };
  trInfo();
}
// ---------------------------------------------------------------- Terrain editor (ground materials, top-down)
{
  const openTerrain = setupTerrainEditor({ $, el, toast, busy, S, readAt, writeAt, walk, permit, zsDecompress, zsStore, parseRstb, rstbGet, rstbSet, writeRstb, manifestFor, modMeta, makeZip, saveFile, FRM, FR_HALF, frLoadMap, idb });
  $('#terrainEd').onclick = () => openTerrain();
}
function frCentre() { const sh = frShape(); if (!sh.box) return [0, 0]; return [(sh.box[0][0] + sh.box[1][0]) / 2, (sh.box[0][2] + sh.box[1][2]) / 2]; }
async function frOpen() {
  if (!TC.fr) TC.fr = frDefault();
  TC.fr.on = true; $('#tc_fr').checked = true;
  for (const [id, key] of [['fr_yaw', 'yaw'], ['fr_raise', 'raise'], ['fr_y', 'y']]) $('#' + id).value = TC.fr[key]; $('#fr_auto').checked = TC.fr.auto; $('#fr_seabed').checked = !!TC.fr.seabed; $('#fr_clear').checked = TC.fr.clear !== false;
  $('#frdlg').showModal(); FRM.cx = TC.fr.x; FRM.cz = TC.fr.z; FRM.zoom = 2.5; frDraw();
  if (await frLoadMap()) frDraw();
}
{
  const cv = $('#fr_map'), toWorld = e => { const r = cv.getBoundingClientRect(), Wc = cv.width, k = FRM.zoom * Wc / (2 * FR_HALF), px = (e.clientX - r.left) * Wc / r.width, py = (e.clientY - r.top) * Wc / r.height; return [FRM.cx + (px - Wc / 2) / k, FRM.cz + (py - Wc / 2) / k, px, py]; };
  const moveTo = e => { const [x, z] = toWorld(e), [lx, lz] = frCentre(), c = Math.cos(TC.fr.yaw * Math.PI / 180), s = Math.sin(TC.fr.yaw * Math.PI / 180);
    TC.fr.x = x - (c * lx + s * lz); TC.fr.z = z - (-s * lx + c * lz); frDraw(); };   // the box's middle goes where you click
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); if (e.button === 2) FRM.drag = { pan: true, x: e.clientX, y: e.clientY, cx: FRM.cx, cz: FRM.cz }; else { FRM.drag = { pan: false }; moveTo(e); } });
  cv.addEventListener('pointermove', e => { if (!FRM.drag) return; if (FRM.drag.pan) { const r = cv.getBoundingClientRect(), k = FRM.zoom * cv.width / (2 * FR_HALF) * r.width / cv.width; FRM.cx = FRM.drag.cx - (e.clientX - FRM.drag.x) / k; FRM.cz = FRM.drag.cz - (e.clientY - FRM.drag.y) / k; frDraw(); } else moveTo(e); });
  cv.addEventListener('pointerup', () => { FRM.drag = null; tcSave(); });
  cv.addEventListener('wheel', e => { e.preventDefault(); const [x, z] = toWorld(e), f = e.deltaY < 0 ? 1.25 : 0.8; FRM.zoom = Math.max(1, Math.min(40, FRM.zoom * f)); const [x2, z2] = toWorld(e); FRM.cx += x - x2; FRM.cz += z - z2; frDraw(); }, { passive: false });
  $('#fr_yaw').oninput = () => { TC.fr.yaw = +$('#fr_yaw').value; frDraw(); };
  $('#fr_raise').oninput = () => { TC.fr.raise = parseFloat($('#fr_raise').value) || 0; frDraw(); };
  $('#fr_y').oninput = () => { TC.fr.y = parseFloat($('#fr_y').value) || FR_SEA; frDraw(); };
  $('#fr_auto').onchange = () => { TC.fr.auto = $('#fr_auto').checked; frDraw(); };
  $('#fr_seabed').onchange = () => { TC.fr.seabed = $('#fr_seabed').checked; frDraw(); };
  $('#fr_clear').onchange = () => { TC.fr.clear = $('#fr_clear').checked; tcSave(); };
  for (const id of ['fr_grid', 'fr_names']) $('#' + id).onchange = frDraw;
  $('#fr_close').onclick = () => { $('#frdlg').close(); tcSave(); frInfo(); };
  $('#frdlg').addEventListener('close', () => { tcSave(); frInfo(); tcUpdate(); });
  $('#tc_frmap').onclick = frOpen;
  $('#tc_w2').onchange = () => { tcSave(); tcUpdate(); };
  $('#tc_fr').onchange = () => { if (!TC.fr) TC.fr = frDefault(); TC.fr.on = $('#tc_fr').checked; tcSave(); frInfo(); tcUpdate(); if (TC.fr.on) frLoadMap().then(() => { frInfo(); tcUpdate(); }); };
}
// what the build gets: where the track's origin goes in the world, its height and turn
async function frSpec() {
  const fr = TC.fr; if (!fr?.on) return null;
  if (fr.auto) await frLoadMap();
  await frLoadMap();
  return { x: fr.x, z: fr.z, y: frHeight(fr), yaw: fr.yaw * Math.PI / 180, stage: frNear(fr.x, fr.z)?.key || 'KoopaTroopaBeach_00', clear: fr.clear !== false };
}
// ---------------------------------------------------------------- the track's own pictures (menus, map, badge)
const PICS = [['course', 'Course picture', 'menus, loading screen, results (16:9)', 'cover'], ['map', 'Map picture', 'course map and Grand Prix (see-through background)', 'contain'], ['badge', 'Badge', 'the round course badge (see-through background)', 'contain']];
function tcPicGetter(key) {
  const c = TC.texOver?.['@pic_' + key]?.canvas; if (!c) return null;
  const mode = PICS.find(p => p[0] === key)[3];
  return (w, h) => {
    const o = document.createElement('canvas'); o.width = w; o.height = h; const x = o.getContext('2d');
    const s = mode === 'cover' ? Math.max(w / c.width, h / c.height) : Math.min(w / c.width, h / c.height), dw = c.width * s, dh = c.height * s;
    x.imageSmoothingQuality = 'high'; x.drawImage(c, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return new Uint8Array(x.getImageData(0, 0, w, h).data.buffer);
  };
}
// pictures made from the 3D view: the course picture is the view as it is (16:9); the map picture and badge are the track
// model on its own, seen from above at an angle on a clear background, like the game's map icons
let snapGL = null;
async function tcSnapPic(key) {
  const course = key === 'course', W = course ? 1280 : 1024, H = course ? 720 : 1024;
  if (!snapGL) { snapGL = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true, antialias: true, preserveDrawingBuffer: true }); snapGL.outputColorSpace = THREE.SRGBColorSpace; }
  snapGL.setPixelRatio(1); snapGL.setSize(W, H, false);
  if (course) {
    // the 3D view without the editor's handles, lines and markers
    const hidden = []; const hide = o => { if (o.visible) { o.visible = false; hidden.push(o); } };
    hide(TC.handles); hide(grid); for (const c of TC.preview.children) if (c !== TC.impGroup && c !== GL.group && !c.userData.mmTrack) hide(c);
    const cam = camera.clone(); cam.aspect = W / H; cam.updateProjectionMatrix();
    snapGL.setClearColor(scene.background?.isColor ? scene.background : 0x000000, 1);
    try { snapGL.render(scene, cam); } finally { for (const o of hidden) o.visible = true; }
  } else {
    const grp = mmModelGroup({ src: 'track', tex: true }); if (!grp.children.length) throw new Error('there\'s no track model to draw yet');
    const sc = new THREE.Scene(); sc.add(grp, new THREE.HemisphereLight(0xffffff, 0x8a7a66, 2.4)); const sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(-0.6, 1, 0.8); sc.add(sun);
    const box = new THREE.Box3().setFromObject(grp), c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
    const cam = new THREE.OrthographicCamera(-r, r, r, -r, 0.1, r * 10), dir = new THREE.Vector3(1, 1.1, 1).normalize();
    cam.position.copy(c).addScaledVector(dir, r * 4); cam.lookAt(c); cam.updateMatrixWorld(true);
    // tighten the framing to what's really on screen
    const pts = []; for (const m of grp.children.flatMap(o => o.isMesh ? [o] : o.children)) { const a = m.geometry.attributes.position; for (let i = 0; i < a.count; i += Math.max(1, Math.floor(a.count / 2000))) pts.push(new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)).project(cam)); }
    const mx = Math.max(...pts.map(p => Math.abs(p.x))), my = Math.max(...pts.map(p => Math.abs(p.y))), k = Math.max(mx, my) * 1.06;
    cam.left = -r * k; cam.right = r * k; cam.top = r * k; cam.bottom = -r * k; cam.updateProjectionMatrix();
    snapGL.setClearColor(0x000000, 0); snapGL.render(sc, cam);
  }
  const out = document.createElement('canvas'); out.width = W; out.height = H; const g2 = out.getContext('2d');
  if (key === 'badge') { g2.beginPath(); g2.arc(W / 2, H / 2, W / 2 - 4, 0, 7); g2.fillStyle = '#ffffff'; g2.fill(); g2.beginPath(); g2.arc(W / 2, H / 2, W / 2 - 40, 0, 7); g2.fillStyle = '#7cc7f2'; g2.fill(); g2.save(); g2.clip(); g2.drawImage(snapGL.domElement, 60, 60, W - 120, H - 120); g2.restore(); }
  else g2.drawImage(snapGL.domElement, 0, 0);
  const bytes = new Uint8Array(await (await new Promise(r => out.toBlob(r, 'image/png'))).arrayBuffer());
  TC.texOver['@pic_' + key] = { name: key + '-3d.png', bytes, canvas: out };
  idb.set('tc-texover', Object.fromEntries(Object.entries(TC.texOver).map(([k2, v]) => [k2, { name: v.name, bytes: v.bytes }])));
  tcFillPics(); tcSave();
  toast(course ? 'Course picture taken from the 3D view.' : `${key === 'map' ? 'Map picture' : 'Badge'} drawn from your track model.`, 'ok');
}
function tcFillPics() {
  const box = $('#tc_pics'); if (!box) return;
  box.replaceChildren(...PICS.map(([key, label, where]) => {
    const t = TC.texOver?.['@pic_' + key], sw = el('span', { class: 'ticon' + (t ? '' : ' none'), title: where });
    if (t) sw.append(el('img', { src: thumb(t.canvas) })); else sw.textContent = '–';
    const pick = el('button', { title: 'Choose an image for the ' + label.toLowerCase() + ': ' + where }, t ? 'Change…' : 'Choose…');
    pick.onclick = () => { TC.pickFor = '@pic_' + key; $('#tc_texfile').click(); };
    const snap = el('button', { title: key === 'course' ? 'Take the picture from the 3D view as it is now (turn on Game look first for the sky, sea and ground)' : 'Draw it from your track model: a little 3D island seen from above at an angle, like the game\'s own map icons' }, '3D');
    snap.onclick = () => tcSnapPic(key).catch(e => { console.error(e); toast('Couldn\'t make the picture: ' + e.message, 'err'); });
    const clr = el('button', { title: 'Use Rainbow Road\'s again' }, 'Clear'); clr.disabled = !t;
    clr.onclick = () => { delete TC.texOver['@pic_' + key]; idb.set('tc-texover', Object.fromEntries(Object.entries(TC.texOver).map(([k, v]) => [k, { name: v.name, bytes: v.bytes }]))); tcFillPics(); };
    return el('div', { class: 'mrow t tpic' }, sw, el('span', { title: where }, label), el('span', { class: 'qbtns' }, pick, snap, clr));
  }));
}
const tcPicSpec = () => { const out = {}; for (const [k] of PICS) { const g = tcPicGetter(k); if (g) out[k] = g; } return Object.keys(out).length ? out : null; };
// ---------------------------------------------------------------- textures of a road built from the centre line
// per surface: '' = the base model's own look, a game texture's name (read from the dump), or '@<surface>' = your own picture
const tcSurfDefaults = () => Object.fromEntries(SURFACES.map(x => [x.key, { name: x.def || '', size: '' }]));
const TEXC = new Map();   // game texture name -> Promise<{canvas, aspect}>
function tcGameTex(name) {
  if (!TEXC.has(name)) TEXC.set(name, (async () => {
    if (!S.romfs || S.romfs.fake) return null;
    const raw = await readAt(S.romfs, `Tex/${name}.bntx.zs`); if (!raw) return null;
    const r = bntxToRGBA(zsDecompress(raw), 256), c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba.buffer), r.w, r.h), 0, 0);
    return { canvas: c, aspect: r.fullH / r.fullW };
  })().catch(e => { console.error(name, e); return null; }));
  return TEXC.get(name);
}
const TEXDONE = new Map();   // name -> loaded result (for the synchronous preview / layout)
const tcTexLoad = name => tcGameTex(name).then(r => { const had = TEXDONE.has(name); TEXDONE.set(name, r); if (!had) { tcFillSurfTex(); tcUpdate(true); } return r; });
function tcSurfPic(key) {   // {canvas, aspect} of a surface's chosen picture, once loaded
  const sel = TC.surf?.[key]; if (!sel?.name) return null;
  if (sel.name.startsWith('@')) { const c = TC.texOver[sel.name]?.canvas; return c ? { canvas: c, aspect: c.height / c.width } : null; }
  if (!TEXDONE.has(sel.name)) { tcTexLoad(sel.name); return null; }
  return TEXDONE.get(sel.name);
}
function tcUV(key) {
  const sel = TC.surf?.[key], pic = tcSurfPic(key), typed = parseFloat(sel?.size);
  if (!sel?.name) return { size: isFinite(typed) && typed > 0 ? typed : DEFAULT_SIZE[key], aspect: 1 };
  const preset = sel.name.startsWith('@') ? 0 : (texByName(sel.name)?.size ?? 0);
  return { size: isFinite(typed) && typed >= 0 ? typed : preset, aspect: pic?.aspect || 1 };
}
const tcSurfMats = new Map();
function tcSurfMat(slot) {
  const sf = SURFACES.find(x => x.slot === slot); if (!sf) return null;
  const pic = tcSurfPic(sf.key); if (!pic) return null;
  const k = slot + '|' + TC.surf[sf.key].name + '|' + (pic.canvas.width + 'x' + pic.canvas.height);
  if (!tcSurfMats.has(k)) {
    const t = new THREE.CanvasTexture(pic.canvas); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    tcSurfMats.set(k, new THREE.MeshStandardMaterial({ map: t, roughness: 0.85, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: slot === 'floortile' ? 2 : 0, polygonOffsetUnits: slot === 'floortile' ? 2 : 0 }));
  }
  return tcSurfMats.get(k);
}
function tcFillSurfTex() {
  const box = $('#tc_surftex'); if (!box || !TC.surf) return;
  const rows = SURFACES.map(sf => {
    const cur = TC.surf[sf.key], fitKey = { road: 'r', edge: 'e', wall: 'w', ground: 'g', beach: 'g', rail: 'w' }[sf.key];
    const sel = el('select', { title: 'Pictures from the game\'s courses (read from your dump), or your own' });
    sel.append(el('option', { value: '' }, 'Default look'));
    for (const g of ROADTEX) { const og = el('optgroup', { label: g.course }); for (const t of g.items.filter(t => t.fit.includes(fitKey))) og.append(el('option', { value: t.name }, t.label)); if (og.children.length) sel.append(og); }
    const other = el('optgroup', { label: 'Other pictures' }); for (const t of ALL_TEX.filter(t => !t.fit.includes(fitKey))) other.append(el('option', { value: t.name }, `${t.course}: ${t.label}`)); sel.append(other);
    sel.append(el('option', { value: '@pick' }, TC.texOver['@' + sf.key] ? `Your picture (${TC.texOver['@' + sf.key].name})` : 'Your own picture…'));
    if (TC.texOver['@' + sf.key]) sel.lastChild.value = '@' + sf.key;
    sel.value = cur.name || '';
    sel.onchange = () => {
      if (sel.value === '@pick' || (sel.value === '@' + sf.key && !TC.texOver['@' + sf.key])) { TC.pickFor = '@' + sf.key; sel.value = cur.name || ''; return $('#tc_texfile').click(); }
      cur.name = sel.value; cur.size = ''; tcFillSurfTex(); tcUpdate(); tcSave();
    };
    const pic = tcSurfPic(sf.key), sw = el('span', { class: 'ticon' + (pic ? '' : ' none'), title: cur.name ? (texByName(cur.name)?.label || cur.name) : 'the base model\'s own look' });
    if (pic) sw.append(el('img', { src: thumb(pic.canvas) })); else sw.textContent = cur.name ? '…' : '–';
    const u = tcUV(sf.key);
    const size = el('input', { type: 'number', min: '0', step: '0.5', value: cur.size, placeholder: u.size ? u.size + ' m' : 'fit', title: 'Metres one copy of the picture covers (0 = stretched across the ' + sf.label.toLowerCase() + '). Empty = the picture\'s usual size.' });
    size.oninput = () => { cur.size = size.value; tcUpdate(true); }; size.onchange = tcSave;
    return el('div', { class: 'mrow t tsurf' }, sw, el('span', {}, sf.label), sel, size);
  });
  box.replaceChildren(...rows);
  $('#tc_surfnote').textContent = !S.romfs || S.romfs.fake ? 'Open RomFS to see the game\'s pictures.' : '';
}
// the textures a centre-line build needs: part.tex[slot] = id, and each id's picture
// ---------------------------------------------------------------- Track Creator: road pieces (centre-line road)
// The game's boost panel, glide panel and glider ramp, put into the road's model with their own collision (see boost.js).
// TC.boosts: [{ kind, s: metres along the road from the start line, x: metres to the left of the middle (negative = right) }]
TC.boosts = TC.boosts || [];
const PGEO = {};   // kind -> { arrow, body, col, arrowTex: canvas, bodyTex: canvas }
const rgbaCanvas = img => { const c = document.createElement('canvas'); c.width = img.w; c.height = img.h; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.rgba.length), img.w, img.h), 0, 0); return c; };
function flatCanvas(col) { const c = document.createElement('canvas'); c.width = c.height = 4; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, 4, 4); return c; }
async function tcPieceLoad(rd, kind) {
  if (PGEO[kind]) return PGEO[kind];
  const def = PIECES[kind], raw = await rd(def.model); if (!raw) throw new Error(`this RomFS has no ${def.model} (the ${def.label.toLowerCase()})`);
  let shape = null; if (def.col) { const c = await rd(def.col); if (!c) throw new Error(`this RomFS has no ${def.col}`); shape = readMeshShape(zsDecompress(c)); }
  const G = pieceGeometry(def, loadBfres(zsDecompress(raw)), shape);
  const tex = async n => { try { const t = await rd(n); return t ? bntxToRGBA(zsDecompress(t), 1024) : null; } catch (e) { console.warn(e); return null; } };
  const alb = await tex(`Tex/CmnTex_Special_${def.glow}_Dash_Alb.bntx.zs`), emm = await tex(`Tex/CmnTex_Special_${def.glow}_Dash_Emm.bntx.zs`);
  G.arrowTex = alb && emm ? rgbaCanvas(glowPicture(alb, emm, def.glow)) : flatCanvas(kind === 'boost' ? '#ff9a20' : '#3a7bff');
  const body = await tex(def.body); G.bodyTex = body ? rgbaCanvas(body) : flatCanvas('#c8c8d0');
  return (PGEO[kind] = G);
}
// the road pieces: yours, and a glide panel before each glide gap
const tcPiecesOf = g => [...(TC.boosts || []), ...(g?.gapPieces || [])];
async function tcDashLoad(rd, g) { for (const k of new Set(tcPiecesOf(g || TC.gen).map(b => b.kind || 'boost'))) await tcPieceLoad(rd, k); }
function tcAddBoosts(g) { addBoosts(g, tcPiecesOf(g), PGEO); }
const tcBoostClamp = boostClamp;
function tcBoostTextures(parts, textures) {
  if (!Object.keys(PGEO).length) return textures;
  const add = (name, c) => textures.set(name, { get: (l, w, h, a) => canvasRGBA(c, w, h, a), w: c.width, h: c.height });
  for (const [kind, G] of Object.entries(PGEO)) { const def = PIECES[kind]; add('@arrows_' + def.glow, G.arrowTex); add('@body_' + def.bodyKey, G.bodyTex); }
  const slotTex = {}; for (const kind of Object.keys(PGEO)) { const def = PIECES[kind]; slotTex[def.arrowSlot] = '@arrows_' + def.glow; slotTex[def.bodySlot] = '@body_' + def.bodyKey; }
  for (const p of parts) for (const [slot, t] of Object.entries(slotTex)) if (p.geom?.[slot] && !p.tex[slot]) p.tex[slot] = t;
  return textures;
}
const PMAT = {};
function tcBoostPreview(g) {
  TC.boostObjs = [];
  const all = tcPiecesOf(g); if (!all.length) return;
  const need = [...new Set(all.map(b => b.kind || 'boost'))].filter(k => !PGEO[k]);
  if (need.length) { if (!TC.dashLoading && S.romfs && !S.romfs.fake) { TC.dashLoading = true; tcDashLoad(romReader()).then(() => tcUpdate(true)).catch(e => toast('Road pieces: ' + e.message, 'err')).finally(() => { TC.dashLoading = false; }); } }
  const tx = c => { const t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };
  all.forEach((b, i) => { const G = PGEO[b.kind || 'boost']; if (!G) return; if (!b.auto) tcBoostClamp(g, b); const T = boostTris(g, b, G);
    const k = b.kind || 'boost'; if (!PMAT[k]) PMAT[k] = { a: new THREE.MeshBasicMaterial({ map: tx(G.arrowTex) }), f: new THREE.MeshLambertMaterial({ map: tx(G.bodyTex), side: THREE.DoubleSide }) };
    for (const [L, mat] of [[T.arrow, PMAT[k].a], [T.body, PMAT[k].f]]) {
      if (!L.length) continue;
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(L.flatMap(v => v.p)), 3)); geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(L.flatMap(v => v.n)), 3)); geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(L.flatMap(v => v.uv)), 2));
      const m = new THREE.Mesh(geo, mat); m.userData.mmTrack = true; TC.preview.add(m); if (!b.auto) { m.userData.boost = i; TC.boostObjs.push(m); }
    } });
}
function tcBoostList() {
  const box = $('#tc_boostlist'); if (!box) return; box.innerHTML = '';
  const L = TC.gen?.stats.length || 0;
  if (!TC.boosts.length) { box.append(el('div', { class: 'hint' }, 'None yet.')); return; }
  TC.boosts.forEach((b, i) => {
    const num = (v, title, step, set) => { const n = el('input', { type: 'number', step, value: String(Math.round(v * 10) / 10), title, style: 'width:64px' }); n.onchange = () => { set(+n.value || 0); tcUpdate(); tcSave(); }; return n; };
    const kind = el('select', { title: 'What it is', style: 'width:auto' }); for (const [k, d] of Object.entries(PIECES)) kind.append(el('option', { value: k }, d.label)); kind.value = b.kind || 'boost';
    kind.onchange = () => { b.kind = kind.value; tcUpdate(); tcSave(); };
    const del = el('button', { title: 'Remove it' }, '✕'); del.onclick = () => { TC.boosts.splice(i, 1); tcUpdate(); tcSave(); };
    box.append(el('div', { class: 'mrow', style: 'display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin:3px 0' }, kind,
      el('span', { class: 'hint' }, 'at'), num(b.s, `Metres along the road from the start line (the loop is ${Math.round(L)} m)`, 1, v => { b.s = v; }), el('span', { class: 'hint' }, 'm, left'),
      num(b.x, 'Metres to the left of the middle of the road (negative: to the right)', 0.5, v => { b.x = v; }), el('span', { class: 'hint' }, 'm'),
      ...(GLIDES[b.kind] ? [el('span', { class: 'hint' }, 'glide'), num(b.len || GLIDE_LEN, 'How far its glide path goes (metres along the road): gliding karts and CPUs follow it, and land at its end', 10, v => { b.len = Math.max(30, v); }), el('span', { class: 'hint' }, 'm')] : []), del));
  });
}
// click the road to put a piece there
function tcBoostAt(g, pt) {
  let best = 0, bd = Infinity; g.rings.forEach((r, i) => { const d = (r.p[0] - pt.x) ** 2 + (r.p[2] - pt.z) ** 2; if (d < bd) { bd = d; best = i; } });
  const r = g.rings[best], dx = pt.x - r.p[0], dz = pt.z - r.p[2];
  const b = { kind: $('#tc_boostkind').value || 'boost', s: Math.round((r.s + dx * r.t[0] + dz * r.t[2]) * 10) / 10, x: Math.round((dx * r.l[0] + dz * r.l[2]) * 2) / 2 }; tcBoostClamp(g, b); return b;
}
renderer.domElement.addEventListener('pointerdown', e => {
  if (!TC.active || !TC.boostPlace || e.button !== 0 || tcImporting() || !TC.gen) return;
  const hits = tcRay(e).intersectObjects(TC.preview.children.filter(m => m.isMesh && m.userData.mmTrack), false);
  e.stopImmediatePropagation(); e.preventDefault();
  if (!hits.length) return toast('Click on the road.', 'err');
  TC.boosts.push(tcBoostAt(TC.gen, hits[0].point)); TC.boostPlace = false; $('#tc_boostplace').classList.remove('hot'); tcUpdate(); tcSave();
}, { capture: true });
{
  for (const [k, d] of Object.entries(PIECES)) $('#tc_boostkind').append(el('option', { value: k }, d.label));
  $('#tc_boostplace').onclick = () => { TC.boostPlace = !TC.boostPlace; $('#tc_boostplace').classList.toggle('hot', TC.boostPlace); if (TC.boostPlace) toast('Click on the road where it goes.'); };
  $('#tc_boostadd').onclick = () => { if (!TC.gen) return; TC.boosts.push(tcBoostAt(TC.gen, orbit.target)); tcUpdate(); tcSave(); };
}
// glide paths, in the track's space: from the centre-line road's ramps and glide panels, and from ramp / glide panel presets
function tcGlidePaths(g) {
  if (!tcImporting()) return g ? glidePaths(g, tcPiecesOf(g)) : [];
  const out = [];
  for (const g of TC.qc?.glides || []) out.push(g);   // Quick Create's arches
  for (const p of TC.presets) {
    const def = presetById(p.kind); if (!def?.glide || p.qc || p.noGlide) continue;
    const a = (p.yaw || 0) * Math.PI / 180, sc = p.scale || 1, [lz, ly] = def.glide.lip;
    const lip = [p.pos[0] + Math.sin(a) * lz * sc, p.pos[1] + ly * sc, p.pos[2] + Math.cos(a) * lz * sc];
    out.push(glideStraight(lip, Math.atan2(-Math.sin(a), -Math.cos(a)), 0, Math.max(30, +p.len || GLIDE_LEN), (x, z, y) => tcHeight(x, y, z)));
  }
  return out;
}
// show them: the line and each node's box (what the glide aims through)
function tcGlidePreview(g) {
  const paths = tcGlidePaths(g); if (!paths.length) return;
  const pts = [];
  for (const path of paths) path.forEach((n, i) => {
    const P = new THREE.Vector3(...n.pos); if (i) pts.push(new THREE.Vector3(...path[i - 1].pos), P);
    const c = Math.cos(n.yaw), s = Math.sin(n.yaw), w = n.rs[0] / 2, h = n.rs[1] / 2;   // across = (cos, 0, -sin)
    const C = (u, v) => new THREE.Vector3(n.pos[0] + c * u, n.pos[1] + v, n.pos[2] - s * u);
    const q = [C(-w, -h), C(w, -h), C(w, h), C(-w, h)]; for (let k = 0; k < 4; k++) pts.push(q[k], q[(k + 1) % 4]);
  });
  TC.preview.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x5fd3ff })));
}
// ---------------------------------------------------------------- grind rails (RailSlidePath)
// centre-line road: made with the road (trackgen's railPaths, along the wall-top tubes). Imported model: drawn by clicking along it.
TC.railsImp = TC.railsImp || [];   // [[x, y, z], ...] per rail, in the track's space
function tcRailNodes(pts) { return pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]; return { pos: p, yaw: Math.atan2(b[0] - a[0], b[2] - a[2]), rs: [0.5, 0.5], ro: [0, 0] }; }); }
function tcRailPreview(g) {
  const paths = tcImporting() ? [...TC.railsImp, ...(TC.railDraw ? [TC.railDraw] : [])] : (g?.railPaths || []).map(r => r.map(n => n.pos));
  if (!paths.length) return;
  const seg = [], dots = [];
  for (const r of paths) r.forEach((p, i) => { const v = new THREE.Vector3(p[0], p[1] + 0.05, p[2]); dots.push(v); if (i) seg.push(new THREE.Vector3(r[i - 1][0], r[i - 1][1] + 0.05, r[i - 1][2]), v); });
  TC.preview.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seg), new THREE.LineBasicMaterial({ color: 0xff8a3d, depthTest: false })));
  TC.preview.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(dots), new THREE.PointsMaterial({ color: 0xffb070, size: 6, sizeAttenuation: false, depthTest: false })));
}
function tcRailList() {
  const box = $('#tc_raillist'); if (!box) return; box.innerHTML = '';
  if (!TC.railsImp.length) { box.append(el('div', { class: 'hint' }, 'No rails yet.')); return; }
  TC.railsImp.forEach((r, i) => {
    let L = 0; for (let k = 1; k < r.length; k++) L += Math.hypot(r[k][0] - r[k - 1][0], r[k][1] - r[k - 1][1], r[k][2] - r[k - 1][2]);
    const del = el('button', { title: 'Remove this rail' }, '✕'); del.onclick = () => { TC.railsImp.splice(i, 1); tcRailList(); tcUpdate(); tcSave(); };
    box.append(el('div', { class: 'mrow', style: 'display:flex;gap:8px;align-items:center;margin:3px 0' }, el('b', {}, `Rail ${i + 1}`), el('span', { class: 'hint', style: 'flex:1' }, `${r.length} points · ${Math.round(L)} m`), del));
  });
}
function tcRailEnd(keep) {
  if (!TC.railDraw) return;
  if (keep && TC.railDraw.length >= 2) TC.railsImp.push(TC.railDraw); else if (keep) toast('A rail needs at least two points.', 'err');
  TC.railDraw = null; $('#tc_raildraw').classList.remove('hot'); $('#tc_raildraw').textContent = 'Draw a rail';
  tcRailList(); tcUpdate(); tcSave();
}
$('#tc_raildraw').onclick = () => {
  $('#tc_raildraw').blur(); if (TC.railDraw) return tcRailEnd(true);
  if (!tcImporting() || !TC.vis) return toast('Import your model first: rails are drawn along it.', 'err');
  TC.railDraw = []; $('#tc_raildraw').classList.add('hot'); $('#tc_raildraw').textContent = 'Done';
  toast('Click along the top of the rail in your model. Backspace: undo a point · Enter: done · Esc: cancel');
};
renderer.domElement.addEventListener('pointerdown', e => {
  if (!TC.active || !TC.railDraw || e.button !== 0) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const hit = tcRay(e).intersectObjects(TC.rayGroup.children, false)[0];
  if (!hit) return toast('Click on your model.', 'err');
  TC.railDraw.push([+hit.point.x.toFixed(2), +hit.point.y.toFixed(2), +hit.point.z.toFixed(2)]); tcUpdate(true);
}, { capture: true });
tcRailList();
function tcCentreTextures(parts) {
  const textures = new Map(), bySlot = {};
  for (const sf of SURFACES) {
    const n = TC.surf?.[sf.key]?.name; if (!n) continue;
    if (n.startsWith('@')) { const c = TC.texOver[n]?.canvas; if (!c) continue; textures.set(n, { get: (l, w, h, a) => canvasRGBA(c, w, h, a), w: c.width, h: c.height }); }
    else textures.set(n, { game: n });
    bySlot[sf.slot] = n;
  }
  for (const p of parts) p.tex = Object.fromEntries(Object.entries(bySlot).filter(([slot]) => p.geom?.[slot]));
  return textures;
}
function tcSrcChanged() {
  const imp = tcImporting(); $('#tc_imp').style.display = imp ? '' : 'none'; $('#tc_impc').style.display = imp ? '' : 'none'; document.body.classList.toggle('tcimport', imp);
}
const brushColor = id => parseInt((BRUSHES.find(b => b.id === id)?.color || '#888888').slice(1), 16);
// rebuild the model previews when the model, its placement or its looks change
// the picture each material shows: one you picked by hand, else the model's own texture
function tcTexCanvas(n) {
  const strip = x => x.replace(/^(col|coll|collision|kcl)[_\-. ]*/i, '').replace(/[_\-. ]*(col|coll|collision|kcl)$/i, '');
  return TC.texOver[n]?.canvas || tcVM()?.tex.get(n)?.image || TC.col?.model.tex.get(n)?.image
    || (strip(n) !== n ? (TC.texOver[strip(n)]?.canvas || tcVM()?.tex.get(strip(n))?.image) : null) || null;
}
// materials that share one image share one texture: the id is the first material with that image
const tcTexKey = n => { const c = tcTexCanvas(n); if (!c) return null; if (TC.texOver[n]) return 'o:' + TC.texOver[n].name; const t = tcVM()?.tex.get(n) || TC.col?.model.tex.get(n); return t && t.file ? 'f:' + t.file.toLowerCase() : c; };
const tcTexOf = n => { const k = tcTexKey(n); if (!k || !$('#tc_usetex').checked) return null; for (const m of tcVM().mats.keys()) if (tcTexKey(m) === k) return m; return n; };
const tcThumbs = new Map();
function tcThumb(n) { const c = tcTexCanvas(n); if (!c) return null; if (!tcThumbs.has(c)) tcThumbs.set(c, thumb(c, 96)); return tcThumbs.get(c); }
const tcPrevTex = new Map();
function tcPreviewTex(c) { if (!tcPrevTex.has(c)) { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; tcPrevTex.set(c, t); } return tcPrevTex.get(c); }
// ---------------------------------------------------------------- preset models (the game's own scenery, added into your model)
// TC.presets: [{ id, kind, pos: [x, y, z] (track coordinates), yaw (degrees), scale }]; their geometry is read from the dump
TC.presets = []; TC.presetGeo = new Map();
const VM = { key: '', vis: null, col: null };
const tcVMKey = () => JSON.stringify([$('#tc_sharp').checked, TC.presets, [...TC.presetGeo.keys()].filter(k => TC.presetGeo.get(k)?.mats), tcPlace(), TC.vis?.name, TC.vis?.size, TC.col?.name]);
const tcPresetNrm = n => { for (const g of TC.presetGeo.values()) if (g?.nrm?.has(n)) return g.nrm.get(n); return null; };
// a preset's own collision shape is collision only: not drawn with the model
const tcVisOnly = m => m && { ...m, mats: new Map([...m.mats].filter(([n]) => !(/_col_/.test(n) && TC.map.slot[n] === 'none'))) };
function tcMergePresets(base, skip) {
  if (!base || !TC.presets.some(p => p !== skip && TC.presetGeo.get(p.kind)?.mats)) return base;
  // presets are placed in the track's coordinates; the model is stored before its own placement (scale, turn, shift), so undo that
  const xf = makeXform(tcPlace()), o = xf.pos(0, 0, 0), ax = xf.pos(1, 0, 0), ay = xf.pos(0, 1, 0), az = xf.pos(0, 0, 1);
  const XF = new THREE.Matrix4().set(ax[0] - o[0], ay[0] - o[0], az[0] - o[0], o[0], ax[1] - o[1], ay[1] - o[1], az[1] - o[1], o[1], ax[2] - o[2], ay[2] - o[2], az[2] - o[2], o[2], 0, 0, 0, 1), inv = XF.clone().invert();
  const mats = new Map(base.mats), tex = new Map(base.tex); let tris = base.tris;
  const v = new THREE.Vector3();
  for (const p of TC.presets) {
    const g = TC.presetGeo.get(p.kind); if (!g?.mats || p === skip) continue;
    const M = inv.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...p.pos), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (p.yaw || 0) * Math.PI / 180), new THREE.Vector3().setScalar(p.scale || 1))), NM = new THREE.Matrix3().getNormalMatrix(M);
    for (const [n, T] of g.mats) {
      if (!mats.has(n) || mats.get(n) === base.mats.get(n)) mats.set(n, { pos: [], nrm: [], uv: [] });
      const O = mats.get(n);
      for (let i = 0; i < T.pos.length; i += 3) { v.set(T.pos[i], T.pos[i + 1], T.pos[i + 2]).applyMatrix4(M); O.pos.push(v.x, v.y, v.z); v.set(T.nrm[i], T.nrm[i + 1], T.nrm[i + 2]).applyMatrix3(NM).normalize(); O.nrm.push(v.x, v.y, v.z); }
      O.uv.push(...T.uv); tris += T.pos.length / 9;
      if (g.tex.has(n)) tex.set(n, g.tex.get(n));
    }
  }
  return { ...base, mats, tex, tris };
}
function tcVM() { if (!TC.vis) return null; const k = tcVMKey(); if (k !== VM.key) { VM.key = k; VM.vis = tcMergePresets($('#tc_sharp').checked ? sharpNormals(TC.vis.model) : TC.vis.model); VM.col = TC.col ? tcMergePresets(TC.col.model) : null; } return VM.vis; }
// re-made shading normals: each corner averages only the faces round it that meet its own at under ANGLE (so a cliff's edge stays sharp)
const SHARP_DEG = 35, sharpCache = new WeakMap();
function sharpNormals(model) {
  if (!model?.mats) return model; if (sharpCache.has(model)) return sharpCache.get(model);
  const cos = Math.cos(SHARP_DEG * Math.PI / 180), faces = [], at = new Map(), key = (P, i) => `${Math.round(P[i] * 1000)},${Math.round(P[i + 1] * 1000)},${Math.round(P[i + 2] * 1000)}`;
  for (const [n, T] of model.mats) for (let t = 0; t < T.pos.length / 9; t++) {
    const P = T.pos, o = 9 * t, e1 = [P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2]], e2 = [P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2]];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...c);
    const f = { n, t, fn: l > 1e-12 ? c.map(v => v / l) : null, w: l };
    faces.push(f); if (f.fn) for (let j = 0; j < 3; j++) { const k = key(P, o + 3 * j); if (!at.has(k)) at.set(k, []); at.get(k).push(f); }
  }
  const mats = new Map([...model.mats].map(([n, T]) => [n, { ...T, nrm: T.nrm.slice() }]));
  for (const f of faces) {
    if (!f.fn) continue; const T = model.mats.get(f.n), N = mats.get(f.n).nrm, o = 9 * f.t;
    for (let j = 0; j < 3; j++) {
      const s = [0, 0, 0]; for (const g of at.get(key(T.pos, o + 3 * j))) if (g.fn[0] * f.fn[0] + g.fn[1] * f.fn[1] + g.fn[2] * f.fn[2] >= cos) for (let k = 0; k < 3; k++) s[k] += g.fn[k] * g.w;
      const l = Math.hypot(...s) || 1; for (let k = 0; k < 3; k++) N[o + 3 * j + k] = s[k] / l;
    }
  }
  const out = { ...model, mats }; sharpCache.set(model, out); return out;
}
function tcCM() { tcVM(); return VM.col || TC.col?.model; }
async function tcEnsurePresets() {
  if (!S.romfs || S.romfs.fake) return;
  let changed = false;
  for (const p of TC.presets) if (!TC.presetGeo.has(p.kind)) {
    const def = presetById(p.kind); if (!def) continue;
    TC.presetGeo.set(p.kind, {});
    try { busy('Reading ' + def.label + ' from your game files…'); const g = await loadPreset(def, romReader()); TC.presetGeo.set(p.kind, g); changed = true;
      for (const [n, T] of g.mats) { if (g.colOnly?.has(n)) { TC.map.slot[n] = 'none'; TC.map.surf[n] = g.colOnly.get(n); continue; }
        const src = T.src; if (!TC.map.slot[n]) TC.map.slot[n] = guessSlot(src); if (!TC.map.surf[n]) TC.map.surf[n] = def.surf(src);
        if (def.cut(src)) (TC.map.cut = TC.map.cut || {})[n] = TC.map.cut[n] ?? true; if (def.two(src)) (TC.map.two = TC.map.two || {})[n] = TC.map.two[n] ?? true; }
    } catch (e) { console.error(e); TC.presetGeo.delete(p.kind); toast('Couldn\'t read ' + def.label + ': ' + e.message, 'err'); }
    busy();
  }
  if (changed) { TC.impKey = ''; tcFillMaps(); tcUpdate(); }
  tcPresetList();
}
// a glider ramp / glide panel makes its own straight glide path unless this is unticked (then the track's own glide paths are used:
// ones from Quick Create, or ones you made or moved in the course view after Finish)
function glideTick(p) {
  const cb = el('input', { type: 'checkbox' }); cb.checked = !p.noGlide;
  cb.onchange = () => { if (cb.checked) delete p.noGlide; else p.noGlide = true; tcUpdate(); tcSave(); tcPresetList(); };
  return el('label', { class: 'qck', style: 'margin:0', title: 'Makes its own glide path straight ahead. Untick to use the glide paths already on your track instead (Quick Create\'s, or ones you put in the course view after Finish).' }, cb, 'Glide path');
}
function tcPresetList() {
  const box = $('#tc_presetlist'); if (!box) return;
  const num = (v, step, on) => { const i = el('input', { type: 'number', step, value: +(+v).toFixed(2), style: 'width:58px' }); i.onchange = () => { on(parseFloat(i.value) || 0); TC.impKey = ''; tcUpdate(); tcSave(); }; return i; };
  box.replaceChildren(...TC.presets.map(p => {
    const def = presetById(p.kind), here = el('button', { title: 'Move it to the middle of the view (on your model\'s surface)' }, 'Here'), del = el('button', { title: 'Remove it' }, '✕');
    here.onclick = () => { const t = orbit.target, y = tcHeight(t.x, t.y + 50, t.z); p.pos = [+t.x.toFixed(2), +(y ?? t.y).toFixed(2), +t.z.toFixed(2)]; TC.impKey = ''; tcUpdate(); tcSave(); tcPresetList(); };
    del.onclick = () => { TC.presets = TC.presets.filter(x => x !== p); TC.impKey = ''; tcFillMaps(); tcUpdate(); tcSave(); tcPresetList(); };
    const name = el('b', { style: 'flex:none;white-space:nowrap;cursor:pointer', title: 'Pick it (or click it in the 3D view) to move it with the gizmo' }, def?.label || p.kind);
    name.onclick = () => tcPresetSelect(TC.psel === p ? null : p);
    return el('div', { class: 'mrow' + (TC.psel === p ? ' psel' : ''), style: 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:3px 0;padding:3px;border-radius:6px' + (TC.psel === p ? ';background:#3a3320;outline:1px solid #f5c542' : '') },
      el('div', { style: 'min-width:100%;display:flex;gap:6px;align-items:baseline' }, name, el('span', { class: 'hint pinfo' }, TC.psel === p ? 'selected: drag the gizmo (1 Move, 2 Rotate, 3 Scale)' : '')),
      el('span', { class: 'hint' }, 'X'), num(p.pos[0], 1, v => p.pos[0] = v), el('span', { class: 'hint' }, 'Y'), num(p.pos[1], 0.5, v => p.pos[1] = v), el('span', { class: 'hint' }, 'Z'), num(p.pos[2], 1, v => p.pos[2] = v),
      el('span', { class: 'hint' }, 'Turn°'), num(p.yaw || 0, 15, v => p.yaw = v), el('span', { class: 'hint' }, 'Size'), num(p.scale || 1, 0.1, v => p.scale = v > 0 ? v : 1),
      ...(def?.glide && !p.qc ? [glideTick(p), ...(p.noGlide ? [] : [el('span', { class: 'hint', title: 'How far its glide path goes, straight ahead: gliding karts and CPUs follow it, and land at its end' }, 'Glide m'), num(p.len || GLIDE_LEN, 10, v => p.len = Math.max(30, v))])] : []),
      ...(p.qc ? [el('span', { class: 'hint', title: 'Quick Create made this glide panel; its glide path is the arch you set there' }, 'glide: Quick Create\'s arch')] : []), here, del);
  }));
}
// ---------------------------------------------------------------- Track Creator: moving presets with the gizmo
// click a preset in the 3D view to pick it; Move / Rotate / Scale (1 / 2 / 3) like map objects. The build bakes them into the model.
function tcPresetPlace(o, p) { o.position.set(...p.pos); o.rotation.set(0, (p.yaw || 0) * Math.PI / 180, 0); o.scale.setScalar(p.scale || 1); }
function tcGizmoAxes() {
  const pr = !!gizmo.object?.userData.preset;
  gizmo.showX = gizmo.showZ = !(pr && gizmo.mode === 'rotate'); gizmo.showY = true;
}
function tcPresetSelect(p) {
  if (TC.psel === p) return;
  TC.psel = p || null;
  if (!p && gizmo.object?.userData.preset) gizmo.detach();
  TC.impKey = ''; tcUpdate(); tcPresetList();
}
function tcPresetDragMove() {
  const o = gizmo.object, p = o.userData.preset;
  if (gizmo.mode === 'rotate') { const f = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion); o.rotation.set(0, Math.atan2(f.x, f.z), 0); }
  if (gizmo.mode === 'scale') { const s0 = p.scale || 1, d = [o.scale.x, o.scale.y, o.scale.z].reduce((a, b) => Math.abs(b - s0) > Math.abs(a - s0) ? b : a, s0); o.scale.setScalar(Math.max(0.05, d)); }
  const r = $('#tc_presetlist .psel .pinfo'); if (r) r.textContent = `${o.position.x.toFixed(1)}, ${o.position.y.toFixed(1)}, ${o.position.z.toFixed(1)} · ${Math.round(o.rotation.y * 180 / Math.PI)}° · ×${o.scale.x.toFixed(2)}`;
}
function tcPresetDragEnd() {
  const o = gizmo.object, p = o?.userData.preset; if (!p) return;
  p.pos = [+o.position.x.toFixed(2), +o.position.y.toFixed(2), +o.position.z.toFixed(2)];
  p.yaw = +((o.rotation.y * 180 / Math.PI + 360) % 360).toFixed(1); p.scale = +o.scale.x.toFixed(3);
  TC.impKey = ''; tcUpdate(); tcSave(); tcPresetList();
}
let tcPDown = null;
renderer.domElement.addEventListener('pointerdown', e => {
  tcPDown = null;
  if (!TC.active || e.button !== 0 || QC.drawing || !tcImporting() || !TC.presetObjs?.length) return;
  if (gizmo.axis && gizmo.object) return;   // a gizmo handle: let the gizmo have it
  const hit = tcRay(e).intersectObjects(TC.presetObjs, true)[0];
  if (hit) { let o = hit.object; while (o && !o.userData.preset) o = o.parent; if (o) { tcPresetSelect(o.userData.preset); return; } }
  if (TC.psel) tcPDown = [e.clientX, e.clientY];
}, { capture: true });
renderer.domElement.addEventListener('pointerup', e => {
  if (tcPDown && Math.hypot(e.clientX - tcPDown[0], e.clientY - tcPDown[1]) < 4 && !gizmo.dragging) tcPresetSelect(null);
  tcPDown = null;
});
function tcImpPreview() {
  const key = JSON.stringify([tcGameOn(), tcVMKey(), TC.presets.indexOf(TC.psel), TC.vis?.name, TC.vis?.size, TC.col?.name, TC.col?.size, tcPlace(), TC.map, tcShowCol(), $('#tc_usetex').checked, Object.keys(TC.texOver), TC.texVer]);
  if (key === TC.impKey) return;
  TC.impKey = key; TC.impGroup.clear(); TC.rayGroup.clear(); TC.pack = null; TC.impBounds = null;
  if (!TC.vis) return;
  const xf = makeXform(tcPlace());
  TC.impBounds = boundsOf(tcVM(), xf);
  const showCol = tcShowCol();
  const visCol = n => SLOT_COLOR[TC.map.slot[n] || 'floorparts'] ?? 0x999999, visTex = n => tcTexOf(n) ? tcPreviewTex(tcTexCanvas(n)) : null;
  // the selected preset is drawn on its own (so the gizmo can carry it); the rest are already merged into the model
  const vis = previewMesh(tcVisOnly(TC.psel ? tcMergePresets(TC.vis.model, TC.psel) : tcVM()), xf, visCol, { tex: visTex });
  TC.presetObjs = [];
  for (const p of TC.presets) {
    const g = TC.presetGeo.get(p.kind); if (!g?.mats) continue;
    const o = new THREE.Group(); o.userData.preset = p; tcPresetPlace(o, p);
    const m = previewMesh(p === TC.psel && !showCol ? tcVisOnly({ mats: g.mats }) : { mats: g.mats }, makeXform({}), visCol, { tex: visTex });
    if (p !== TC.psel || showCol) m.traverse(c => { if (c.isMesh) { c.material = INVIS2; delete c.userData.mat; } });
    o.add(m); TC.impGroup.add(o); TC.presetObjs.push(o);
  }
  if (!showCol) { TC.impGroup.add(vis); tcGameMaterials(); const br = tcBright(); TC.impGroup.traverse(c => { if (c.isMesh && c.material?.map && c.material.color) c.material.color.setScalar(br); }); }
  if (TC.psel) { const o = TC.presetObjs.find(o => o.userData.preset === TC.psel); if (o) { gizmo.attach(o); tcGizmoAxes(); } else tcPresetSelect(null); }
  const colModel = (TC.col ? tcCM() : tcVM());
  const col = previewMesh(colModel, xf, n => brushColor(TC.map.surf[n] || 'road_asphalt'), { wire: !showCol });
  TC.rayGroup.add(...[...col.children].filter(m => TC.map.surf[m.userData.mat] !== 'none').map(m => new THREE.Mesh(m.geometry, INVIS)));
  KITMESH.length = 0; KITMESH.push(...TC.rayGroup.children);
  if (showCol) TC.impGroup.add(col);
  try { TC.pack = tcPack(); } catch (e) { console.error(e); }
  const nt = [...TC.vis.model.mats.keys()].filter(n => tcTexCanvas(n)).length;
  $('#tc_impinfo').textContent = `${TC.vis.name}: ${TC.vis.model.tris} triangles${TC.presets.length ? ` (+ ${TC.presets.length} preset${TC.presets.length > 1 ? 's' : ''})` : ''}, ${TC.vis.model.mats.size} material${TC.vis.model.mats.size > 1 ? 's' : ''} (${nt} with a texture)` +
    (TC.col ? ` · collision: ${TC.col.name}, ${TC.col.model.tris} triangles` : ' · collision: same model') + ((() => { $('#tc_colinfo').textContent = TC.col ? `Collision model: ${TC.col.name}, ${TC.col.model.tris} triangles.` : `Collision: the same model as the look (${TC.vis.name}). Import a simpler collision model if you like.`; return ''; })()) +
    ` · size ${Math.round(TC.impBounds[1][0] - TC.impBounds[0][0])} × ${Math.round(TC.impBounds[1][1] - TC.impBounds[0][1])} × ${Math.round(TC.impBounds[1][2] - TC.impBounds[0][2])} m`;
}
function tcPack() { const xf = makeXform(tcPlace()); return packParts(tcVM(), TC.col ? tcCM() : null, TC.map, xf, xf, TC.cap, tcTexOf); }
// a material's picture: hover to enlarge, click to pick another image
function tcIcon(n, pickable) {
  const src = tcThumb(n);
  const box = el('span', { class: 'ticon' + (src ? '' : ' none'), title: n + (pickable ? ' — click to choose its texture image' : '') });
  if (src) box.append(el('img', { src }));
  else box.textContent = '?';
  if (pickable) box.onclick = () => { TC.pickFor = n; $('#tc_texfile').click(); };
  return box;
}
function tcFillMaps() {
  const slotSel = n => { const s = el('select', {}); for (const [k, label] of [...SLOTS, ['none', '(hidden)']]) s.append(el('option', { value: k }, label)); s.value = TC.map.slot[n]; s.onchange = () => { TC.map.slot[n] = s.value; tcUpdate(); }; return s; };
  const surfSel = n => { const s = el('select', {}); for (const b of BRUSHES) s.append(el('option', { value: b.id }, b.label)); s.append(el('option', { value: 'none' }, '(no collision)')); s.value = TC.map.surf[n]; s.onchange = () => { TC.map.surf[n] = s.value; tcUpdate(); }; return s; };
  const flag = (n, kind, label, tip) => { TC.map[kind] = TC.map[kind] || {}; const b = el('button', { class: 'mflag' + (TC.map[kind][n] ? ' on' : ''), title: tip }, label);
    b.onclick = () => { TC.map[kind][n] = !TC.map[kind][n]; b.classList.toggle('on', TC.map[kind][n]); TC.impKey = ''; tcUpdate(); }; return b; };
  // its own normal map (bumps and grooves catching the light): click to pick one, right-click to remove it
  // extra maps for a material (normal map, Mix surface map): one + button with a small menu
  const saveTex = () => idb.set('tc-texover', Object.fromEntries(Object.entries(TC.texOver).map(([k, v]) => [k, { name: v.name, bytes: v.bytes }])));
  const EXTRA = [['nrm', 'normal map', 'N', 'an ordinary blue-ish tangent-space normal map'], ['mix', 'mix map', 'M', 'the game\'s purple-ish _Mix surface map for shine and metal, used as it is']];
  const nrmBtn = n => {
    const set = EXTRA.filter(([kind]) => TC.texOver['#' + kind + ':' + n]);
    const b = el('button', { class: 'mflag' + (set.length ? ' on' : ''), title: (set.length ? set.map(([kind, label]) => `${label}: ${TC.texOver['#' + kind + ':' + n].name}`).join('\n') + '\n' : '') + 'Add a normal map or mix map (only used when this material has a texture)' }, '+' + set.map(e => ' ' + e[2]).join(''));
    b.onclick = e => {
      e.stopPropagation(); document.querySelector('.tcmenu')?.remove();
      const r = b.getBoundingClientRect(), menu = el('div', { class: 'tcmenu', style: `position:fixed;left:${Math.round(r.left)}px;top:${Math.round(r.bottom + 2)}px;z-index:1000;background:#232833;border:1px solid #3a4252;border-radius:6px;padding:4px;display:flex;flex-direction:column;min-width:170px;box-shadow:0 6px 20px rgba(0,0,0,.4)` });
      const item = (label, fn, tip) => { const it = el('button', { style: 'text-align:left;background:none;border:0;padding:6px 10px;border-radius:4px', title: tip || '' }, label); it.onmouseenter = () => it.style.background = '#2f3644'; it.onmouseleave = () => it.style.background = 'none'; it.onclick = () => { menu.remove(); fn(); }; menu.append(it); };
      for (const [kind, label, , tip] of EXTRA) {
        const k = '#' + kind + ':' + n, has = TC.texOver[k];
        item((has ? 'Change ' : 'Add ') + label + '…', () => { TC.pickFor = k; $('#tc_texfile').click(); }, tip);
        if (has) item('Remove ' + label + ` (${has.name})`, () => { delete TC.texOver[k]; saveTex(); tcFillMaps(); tcSave(); });
      }
      document.body.append(menu);
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
    };
    return b;
  };
  $('#tc_slots').replaceChildren(...(TC.vis ? [...tcVM().mats.keys()].map(n => el('div', { class: 'mrow t tt' }, tcIcon(n, true), el('span', { title: n }, n),
    el('span', { class: 'mflags' }, flag(n, 'cut', 'see-through', 'Use the texture\'s transparency: clear parts are cut away (fences, grates, leaves). Needs a texture with alpha.'), flag(n, 'two', '2-sided', 'Show both sides of every face (thin walls, signs, leaves)'), nrmBtn(n)), slotSel(n))) : []));
  // collision: the picture says which material it is (its name is in the tooltip)
  $('#tc_surfs').replaceChildren(...(TC.vis ? [...(TC.col ? tcCM() : tcVM()).mats.keys()].map(n => { const has = !!tcThumb(n);
    return el('div', { class: 'mrow t tsurfm' }, tcIcon(n, false), el('span', { title: n }, n), surfSel(n)); }) : []));
}
const tcModelSize = files => files.reduce((a, f) => a + f.bytes.length, 0);
async function tcSetModel(kind, files, quiet) {
  const main = files.find(f => /\.(obj|fbx|dae)$/i.test(f.name));
  if (!main) return toast('Pick the .obj, .fbx or .dae file (you can pick its .mtl and texture images with it).', 'err');
  busy('Reading ' + main.name + '…'); await new Promise(r => setTimeout(r, 20));
  try {
    const model = await parseModel(files);
    TC[kind] = { name: main.name, files, size: tcModelSize(files), model };
    for (const n of model.mats.keys()) {
      if (kind === 'vis' && !TC.map.slot[n]) TC.map.slot[n] = guessSlot(n);
      if (!TC.map.surf[n]) TC.map.surf[n] = guessSurface(n);
    }
    idb.set('tc-' + kind, { files });
    tcFillMaps(); TC.impKey = ''; tcUpdate();
    const nimg = files.filter(f => isImage(f.name)).length, ntex = model.tex.size;
    if (!quiet) { toast(`Loaded ${main.name}: ${model.tris} triangles, ${ntex} of ${model.mats.size} materials with a texture` + (ntex < model.mats.size && !nimg && kind === 'vis' ? '. If it has texture images, pick them together with the model (or click a material\'s ? to choose one).' : '.'), 'ok'); if (kind === 'vis') tcFrameModel(); }
  } catch (e) { console.error(e); toast('Couldn\'t read ' + main.name + ': ' + e.message, 'err'); }
  busy();
}
async function tcRestoreModels() {
  for (const kind of ['vis', 'col']) { const r = await idb.get('tc-' + kind); if (r && r.files) await tcSetModel(kind, r.files, true); else if (r && r.bytes) await tcSetModel(kind, [{ name: r.name, bytes: r.bytes }], true); }
  { const r = await idb.get('tc-mm'); if (r?.files) try { TC.mmModel = { name: r.files.find(x => /\.(obj|fbx|dae)$/i.test(x.name))?.name || r.files[0].name, files: r.files, model: await parseModel(r.files) }; } catch (e) { console.error(e); } }
  const o = await idb.get('tc-texover');
  if (o) for (const [n, f] of Object.entries(o)) { try { TC.texOver[n] = { ...f, canvas: await imageFileToCanvas(f) }; } catch {} }
  TC.texVer++; tcFillMaps(); tcSurfMats.clear(); tcFillSurfTex(); tcFillPics(); TC.impKey = ''; tcUpdate();
}
function tcFrameModel() {
  if (!TC.impBounds) return;
  const [mn, mx] = TC.impBounds, size = Math.max(40, mx[0] - mn[0], mx[2] - mn[2]);
  // look at the start (the origin), from far enough to see the area round it
  const c = new THREE.Vector3(0, 0, 0), v = Math.min(size, 350);
  orbit.target.copy(c); camera.position.set(v * 0.35, v * 0.9, v * 0.75);
  camera.near = 0.5; camera.far = size * 20 + 5000; camera.updateProjectionMatrix(); scene.fog.near = size * 2; scene.fog.far = size * 12;
}
$('#tc_src').onchange = () => { tcSrcChanged(); TC.impKey = ''; tcUpdate(); };
$('#tc_vis').onclick = () => $('#tc_visfile').click();
$('#tc_col').onclick = () => { if (!TC.vis) return toast('Import the model first, then its collision model.'); $('#tc_colfile').click(); };
$('#tc_colclear').onclick = () => { TC.col = null; idb.set('tc-col', null); tcFillMaps(); TC.impKey = ''; tcUpdate(); };
const tcReadFiles = async list => Promise.all([...list].map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
$('#tc_visfile').onchange = async e => { const fs = await tcReadFiles(e.target.files); e.target.value = ''; if (fs.length) await tcSetModel('vis', fs); };
$('#tc_colfile').onchange = async e => { const fs = await tcReadFiles(e.target.files); e.target.value = ''; if (fs.length) await tcSetModel('col', fs); };
$('#tc_texfile').onchange = async e => {
  const [f] = await tcReadFiles(e.target.files); e.target.value = ''; const n = TC.pickFor; if (!f || !n) return;
  try { TC.texOver[n] = { name: f.name, bytes: f.bytes, canvas: await imageFileToCanvas(f) }; TC.texVer++;
    if (n.startsWith('@pic_')) tcFillPics();
    if (n.startsWith('@') && TC.surf?.[n.slice(1)]) { TC.surf[n.slice(1)].name = n; TC.surf[n.slice(1)].size = ''; tcSurfMats.clear(); tcFillSurfTex(); tcSave(); }
    idb.set('tc-texover', Object.fromEntries(Object.entries(TC.texOver).map(([k, v]) => [k, { name: v.name, bytes: v.bytes }])));
    tcFillMaps(); TC.impKey = ''; tcUpdate(); } catch (err) { toast('Couldn\'t read that image: ' + err.message, 'err'); }
};
// textures that weren't picked with the model: read the model again with them, then match any still-bare material by name
$('#tc_addtex').onclick = () => { if (!TC.vis) return toast('Import the model first, then add its textures.'); $('#tc_addtexfile').click(); };
$('#tc_addtexfile').onchange = async e => {
  const add = (await tcReadFiles(e.target.files)).filter(f => isImage(f.name) || /\.mtl$/i.test(f.name)); e.target.value = '';
  if (!add.length || !TC.vis) return;
  const lc = s => s.toLowerCase(), names = new Set(add.map(f => lc(f.name)));
  const had = [...TC.vis.model.mats.keys()].filter(n => tcTexCanvas(n)).length;
  for (const kind of ['vis', 'col']) if (TC[kind]) await tcSetModel(kind, [...TC[kind].files.filter(f => !names.has(lc(f.name))), ...add], true);
  // fall back to the image whose name is the material's name (e.g. "Rock.png" for material "Rock")
  const key = s => lc(s).replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '');
  const imgs = add.filter(f => isImage(f.name)); let byName = 0;
  for (const n of TC.vis.model.mats.keys()) {
    if (tcTexCanvas(n)) continue;
    const f = imgs.find(f => key(f.name) === key(n)) || imgs.find(f => key(n).length > 2 && (key(f.name).includes(key(n)) || key(n).includes(key(f.name))));
    if (!f) continue;
    try { TC.texOver[n] = { name: f.name, bytes: f.bytes, canvas: await imageFileToCanvas(f) }; byName++; } catch {}
  }
  if (byName) { TC.texVer++; idb.set('tc-texover', Object.fromEntries(Object.entries(TC.texOver).map(([k, v]) => [k, { name: v.name, bytes: v.bytes }]))); }
  tcFillMaps(); TC.impKey = ''; tcUpdate();
  const all = [...TC.vis.model.mats.keys()], now = all.filter(n => tcTexCanvas(n)).length, bare = all.filter(n => !tcTexCanvas(n));
  toast(`Added ${add.length} file${add.length > 1 ? 's' : ''}: ${now} of ${all.length} materials have a texture (was ${had}).` +
    (bare.length ? ` Still without one: ${bare.slice(0, 6).join(', ')}${bare.length > 6 ? '…' : ''} — click a material's ? to pick its image.` : ''), now > had ? 'ok' : (bare.length ? 'err' : 'ok'));
};
$('#tc_usetex').addEventListener('input', () => { TC.impKey = ''; tcUpdate(); });
for (const id of [...Object.values(TC_PLACE), 'tc_zup', 'tc_snapm']) $('#' + id).addEventListener('input', () => tcUpdate(true));
$('#tc_check').onclick = tcCheckDump;
// sky: a fixed time of day, and optionally Rainbow Road's space sky round the whole track
const tcSkySpec = () => ({ hour: $('#tc_time').value === '' ? null : +$('#tc_time').value, space: false });   // space: false also clears a box left by the v29/v30 sky tests
// Rainbow Road mode: the stage type Rainbow Road's own code (which switches its sky to space) looks for; it overrides the music's stage
const tcStageType = () => tcMusicSpec().stageType;
for (const id of ['#tc_time']) $(id).addEventListener('change', () => tcSave());
// start a fresh track: forget the model, materials, paths, alternate routes, the finished course, minimap and music
async function tcNewProject() {
  if (!confirm('Start a new track?\n\nThis clears the current one from the Track Creator: model, materials, Quick Create paths, alternate routes, the finished course, minimap and music.\n\nUse Save project first if you want to keep it (mods you already built aren\'t touched).')) return;
  if (QC.drawing) qcCancelDraw();
  if (S.customTrack || S.path === CUSTOM_PATH) { S.doc = null; S.path = ''; S.customTrack = false; S.edited.delete(CUSTOM_PATH); buildScene(false); trackGroup.clear(); TRACK.meshes = []; TRACK.note = ''; updateTrackNote(); $('#tc_editmodel').style.display = 'none'; }
  Object.assign(TC, { vis: null, col: null, pack: null, qc: null, texOver: {}, map: { slot: {}, surf: {}, cut: {}, two: {} }, docBytes: null, docKey: null, mm: null, mmModel: null, musicWant: '', hostWant: '',
    qcHist: [], hist: [], esel: null, wsel: null, edit: false, wpick: false, addItem: false, pivot: null, sel: -1, impKey: '' });
  TC.texVer++; KITMESH.length = 0; TC.impGroup.clear(); TC.rayGroup.clear();
  for (const id of ['#tc_edit', '#tc_wpick', '#tc_additem']) $(id).classList.remove('on');
  for (const k of ['tc-vis', 'tc-col', 'tc-texover', 'tc-doc', 'tc-mm', 'tc-variants']) idb.set(k, null); TC.variants = []; TC.route = 'A'; tcRoutesFill();
  try { localStorage.removeItem(TC_KEY); } catch {}
  QC.guide = []; drawGuide(); QC.ghost.clear();
  tcApplyDesign({}); $('#tc_music').value = ''; tcMusicFill();
  $('#tc_name').value = 'Custom Track'; $('#tc_mod').value = 'CustomTrack'; $('#tc_impinfo').textContent = '';
  tcFillMaps(); tcSave(); tcUpdate(); tcFrame();
  toast('New track started.', 'ok');
}
$('#tc_new').onclick = tcNewProject;
tcRestoreDoc();
$('#tc_grid').onclick = () => { const g = startGridObj(); download(new TextEncoder().encode(g.obj), 'start_grid.obj'); setTimeout(() => download(new TextEncoder().encode(g.mtl), 'start_grid.mtl'), 300); toast('Downloaded start_grid.obj (+ .mtl). 1 unit = 1 metre, Y up, the race starts at the origin heading -Z.', 'ok'); };

// ---------------------------------------------------------------- Track Creator: Quick Create on an imported model
// The Quick Create panel works here too: draw the guide on your model and Create lays out the lap path,
// CPU routes, item boxes and start grid; the Track Creator keeps them and builds them into the course.
function tcAddGuides(plan) {
  const P = v => [Math.fround(v.x), Math.fround(v.y), Math.fround(v.z)];
  if (TC.qc) tcEPush();
  const q = TC.qc || { closed: plan.closed, width: plan.width, routePct: plan.routePct, lap: [], routes: [], items: [], starts: [] };
  q.deco = [...(q.deco || []), ...plan.deco.map(d => ({ name: d.name, pos: P(d.p), yaw: d.yaw }))];
  q.fenceCol = [...(q.fenceCol || []), ...plan.fenceCol.map(([a, b]) => [P(a), P(b)])];
  TC.qc = q; tcSave();
  QC.ghost.clear(); QC.drawGroup.clear(); QC.guide = []; QC.ps = []; QC.sel.clear(); drawGuide(); qcPointUI();
  tcUpdate();
  toast(`Added ${plan.deco.length} edge guide${plan.deco.length > 1 ? 's' : ''}; your paths, items and start grid are as they were. Draw another guide to add more.`, 'ok');
}
function tcApplyQC(plan) {
  const P = v => [Math.fround(v.x), Math.fround(v.y), Math.fround(v.z)];
  const q = { closed: plan.closed, width: plan.width, routePct: plan.routePct,
    lap: plan.lap.map(f => ({ pos: P(f.p), yaw: f.yaw, cp: !!f.cp, start: !!f.start, ...(Math.abs(f.w - plan.width) > 0.01 ? { w: Math.round(f.w * 10) / 10 } : {}) })),
    routes: plan.routes.map(r => r.map(f => ({ pos: P(f.p), yaw: f.yaw, w: Math.round(f.w * 10) / 10 }))),
    deco: plan.deco.map(d => ({ name: d.name, pos: P(d.p), yaw: d.yaw })), fenceCol: plan.fenceCol.map(([a, b]) => [P(a), P(b)]),
    glides: plan.glides.map(g => g.map(n => ({ pos: P(n.p), yaw: n.yaw, rs: n.rs, ro: [0, 0] }))),
    items: plan.items.map(b => ({ pos: P(b.p), yaw: b.yaw })),
    starts: plan.starts.map(b => ({ pos: P(b.p), yaw: b.yaw, id: b.id })) };
  if (!q.closed) toast('The guide isn\'t a loop: tick "Loop" so laps work.', 'err');
  if (TC.qc) { if (!plan.lap.length) q.lap = TC.qc.lap; if (!plan.routes.length) q.routes = TC.qc.routes; if (!plan.items.length && !qv('repItems').checked) q.items = TC.qc.items; if (!plan.starts.length) q.starts = TC.qc.starts; }
  if (!plan.items.length && qv('repItems').checked && TC.qc) q.items = qv('doItems').checked ? [] : TC.qc.items;
  if (TC.qc?.branches?.length) q.branches = TC.qc.branches;
  // glide panels: the game's glide panel built into the model (its glide surface is what starts a glide); Quick Create's own, redone each time
  TC.presets = TC.presets.filter(p => !p.qc);
  plan.panels.forEach((b, k) => TC.presets.push({ id: Date.now() + k, kind: 'GlideBoard000', pos: P(b.p).map(v => +v.toFixed(2)), yaw: +((b.yaw + Math.PI) * 180 / Math.PI).toFixed(1), scale: 1, qc: true }));
  TC.impKey = '';
  if (plan.panels.length) tcEnsurePresets();
  if (TC.qc) tcEPush(); TC.esel = null;
  TC.wsel = null; TC.qc = q; tcSave();
  QC.ghost.clear(); $('#qcpanel').open = false; QC.drawGroup.clear(); QC.guide = []; drawGuide();
  tcUpdate();
  toast(`Created: ${qcSummary(plan)}. Build mod when you're ready.`, 'ok');
}
function tcDrawQC() {
  const q = TC.qc; tcPathsUI(); if (!q) return;
  const line = (pts, color, loop) => { if (pts.length < 2) return; const v = pts.map(p => new THREE.Vector3(p[0], p[1] + 0.3, p[2])); if (loop) v.push(v[0].clone()); TC.preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), new THREE.LineBasicMaterial({ color }))); };
  const side = (f, w) => { const s = [Math.cos(f.yaw), -Math.sin(f.yaw)], h = w / 2; return [[f.pos[0] - s[0] * h, f.pos[1], f.pos[2] - s[1] * h], [f.pos[0] + s[0] * h, f.pos[1], f.pos[2] + s[1] * h]]; };
  const rail = (nodes, def, loop, color, edge, who) => {
    line(nodes.map(f => f.pos), color, loop);
    const e = nodes.map(f => side(f, f.w ?? def));
    line(e.map(x => x[0]), edge, loop); line(e.map(x => x[1]), edge, loop);
    for (const f of nodes) if (f.cp || f.start) { const [l, r] = side(f, f.w ?? def); line([l, r], f.start ? 0xffffff : color); }
    const sel = TC.wsel && TC.wsel.who === who ? TC.wsel : null;
    if (sel) for (let k = Math.min(sel.i, sel.j); k <= Math.max(sel.i, sel.j); k++) { const f = nodes[k]; if (!f) continue; const [l, r] = side(f, f.w ?? def); line([l, r], 0xffe14a);
      const m = new THREE.Mesh(GEO.point, matFor(0xffe14a)); m.position.set(f.pos[0], f.pos[1] + 0.3, f.pos[2]); m.scale.setScalar(1.4); TC.preview.add(m); }
  };
  rail(q.lap, q.width, q.closed, 0x3ddc84, 0x1f8a52, 'main');
  for (const r of q.routes) line(r.map(f => f.pos), 0x4aa3ff, q.closed);
  (q.branches || []).forEach((b, k) => {
    const A = q.lap[nearestIdx(q.lap, b.from)]?.pos || b.from, Z = q.lap[nearestIdx(q.lap, b.to)]?.pos || b.to;
    line([A, ...b.lap.map(f => f.pos), Z], 0xff7ad9, false); rail(b.lap, b.width, false, 0xff7ad9, 0x9c3f86, k);
    b.routes.forEach(r => line(r.map(f => f.pos), 0x4aa3ff, false));
    for (const it of b.items || []) { const m = new THREE.Mesh(GEO.box, matFor(0xf5c542)); m.position.set(...it.pos); m.rotation.y = it.yaw; m.scale.setScalar(0.6); TC.preview.add(m); }
  });
  for (const b of q.items) { const m = new THREE.Mesh(GEO.box, matFor(0xf5c542)); m.position.set(...b.pos); m.rotation.y = b.yaw; m.scale.setScalar(0.6); TC.preview.add(m); }
  for (const b of q.starts) { const m = new THREE.Mesh(GEO.cone, matFor(0x3ddc84)); m.position.set(b.pos[0], b.pos[1] + 0.6, b.pos[2]); m.rotation.set(0, b.yaw, 0, 'ZYX'); m.scale.setScalar(0.5); TC.preview.add(m); }
  for (const r of q.routes) if (r.some(f => f.w)) { const e = r.map(f => side(f, f.w ?? 0)); line(e.map(x => x[0]), 0x2a6fb8, q.closed); line(e.map(x => x[1]), 0x2a6fb8, q.closed); }
  qcDecoPreview(TC.preview, q.fenceCol || [], (q.glides || []).map(g => g.map(n => n.pos)), (q.deco || []).filter(d => !/Fence|Guardrail/.test(d.name)).map(d => d.pos), []);
  tcDrawHandles(q);
}
// the course's paths and objects from the Quick Create result (track space)
const nodeW = (q, f) => f.w ?? q.width;
function nearestIdx(nodes, pos, max = Infinity) { let bi = -1, bd = max; nodes.forEach((n, i) => { const d = Math.hypot(n.pos[0] - pos[0], n.pos[1] - pos[1], n.pos[2] - pos[2]); if (d < bd) { bd = d; bi = i; } }); return bi; }
// split a loop into rails at the forks and joins of its alternate routes, like the game's own courses:
// a rail ends where a route splits off (its last point links to both ways on) and a new rail starts where it rejoins
function railGraph(main, closed, alts) {
  const n = main.length, cuts = new Set([0]);
  for (const t of alts) { if (t.a + 1 < n) cuts.add(t.a + 1); cuts.add(t.b); }
  const cs = [...cuts].sort((x, y) => x - y);
  const rails = cs.map((c, k) => ({ nodes: main.slice(c, k + 1 < cs.length ? cs[k + 1] : n), next: [] }));
  rails.forEach((r, k) => { if (k + 1 < rails.length) r.next.push(k + 1); else if (closed) r.next.push(0); });
  const segOf = i => { let k = 0; cs.forEach((c, j) => { if (c <= i) k = j; }); return k; };
  for (const t of alts) { rails.push({ nodes: t.nodes, next: [cs.indexOf(t.b)] }); rails[segOf(t.a)].next.push(rails.length - 1); }
  return rails;
}
// alternate routes that still line up with the lap path: they split off before they rejoin
const tcBranches = q => (q.branches || []).map(b => ({ b, a: nearestIdx(q.lap, b.from), z: nearestIdx(q.lap, b.to) })).filter(x => x.a >= 0 && x.z > x.a + 1 && x.b.lap.length);
function tcQCSpec(q) {
  let cp = 0;
  const lap = q.lap.map(f => ({ pos: f.pos, yaw: f.yaw, rs: [nodeW(q, f), 20], ro: [0, 10], dyn: f.start ? { IsStart: true } : f.cp ? { CheckPoint: ++cp } : null }));
  { const o = tcOpts(); applySections(lap, o.race, o.sections, q.closed); }
  const brs = tcBranches(q);
  // each alternate route carries the same checkpoint numbers as the stretch of lap path it replaces
  const lapAlts = brs.map(({ b, a, z }) => {
    const cps = lap.slice(a + 1, z).filter(n => n.dyn?.CheckPoint).map(n => n.dyn.CheckPoint), m = b.lap.length;
    const nodes = b.lap.map(f => ({ pos: f.pos, yaw: f.yaw, rs: [f.w ?? b.width, 20], ro: [0, 10], dyn: null }));
    cps.forEach((c, j) => { let k = Math.min(m - 1, Math.max(0, Math.round((j + 1) * m / (cps.length + 1)) - 1)); while (k < m - 1 && nodes[k].dyn) k++; if (!nodes[k].dyn) nodes[k].dyn = { CheckPoint: c }; });
    return { a, b: z, nodes };
  });
  const lanes = Math.max(1, q.routes.length);
  const rPct = (q.routePct ?? 40) / 100;   // CPU / item routes: narrower than the lap path, like the game's
  const routes = q.routes.map(r => r.map((f, i) => ({ pos: f.pos, yaw: f.yaw, rs: [f.w ?? Math.max(2, (r.length === q.lap.length ? nodeW(q, q.lap[i]) : q.width) * rPct / lanes), 10], ro: [0, 5] })));
  const routeRails = [];
  routes.forEach((r, l) => {
    const alts = brs.map(({ b }) => ({ a: nearestIdx(r, b.from), b: nearestIdx(r, b.to), nodes: (b.routes[l] || b.routes[0] || []).map(f => ({ pos: f.pos, yaw: f.yaw, rs: [Math.max(2, b.width * rPct / lanes), 10], ro: [0, 5] })) })).filter(t => t.a >= 0 && t.b > t.a + 1 && t.nodes.length);
    const off = routeRails.length;
    routeRails.push(...railGraph(r, q.closed, alts).map(x => ({ ...x, next: x.next.map(k => k + off) })));
  });
  const actors = [...q.items, ...(q.branches || []).flatMap(b => b.items || [])].map(b => ({ name: 'CmnObj_ItemBox000_A_00', pos: [b.pos[0], b.pos[1], b.pos[2]], rot: [0, b.yaw, 0] }));
  for (const d of q.deco || []) actors.push({ name: d.name, pos: [...d.pos], rot: [0, Math.fround(d.yaw), 0] });
  const starts = q.starts.map(b => ({ pos: b.pos, yaw: b.yaw, id: b.id }));
  return { lap, routes, actors, starts, lapRails: railGraph(lap, q.closed, lapAlts), routeRails: routes.length ? routeRails : null };
}

// ---------------------------------------------------------------- Track Creator: lap path widths
// tick "Pick points", click the lap path (Shift-click a second point for a stretch), then type its width
const tcRailOf = (q, who) => who === 'main' ? { nodes: q.lap, closed: q.closed, def: q.width } : { nodes: q.branches[who].lap, closed: false, def: q.branches[who].width };
function tcPathsUI() {
  $('#tc_finishinfo').textContent = TC.docBytes ? (TC.docKey === tcPathKey() ? 'Your objects and path edits live in the Map tab. Changing the paths here (Quick Create, edits) replaces the course\'s paths, item boxes and start grid the next time you open the Map; other objects are kept.' : 'You changed the paths here since you last opened the Map: opening it (or building) puts these paths, item boxes and start grid into the course and keeps your other objects.') : 'The Map tab opens your track like any course, to add objects and edit every path.';
  const q = TC.qc, show = tcImporting() && !!q;
  $('#tc_paths').style.display = show ? '' : 'none'; if (!show) return;
  tcEInfo();
  if (document.activeElement !== $('#tc_lapw')) $('#tc_lapw').value = Math.round(q.width * 10) / 10;
  const sel = TC.wsel && (TC.wsel.who === 'main' || q.branches?.[TC.wsel.who]) ? TC.wsel : null; if (!sel) TC.wsel = null;
  $('#tc_wsel').style.display = sel ? '' : 'none';
  if (sel) { const R = tcRailOf(q, sel.who), f = R.nodes[sel.i]; if (f && document.activeElement !== $('#tc_ptw')) $('#tc_ptw').value = Math.round((f.w ?? R.def) * 10) / 10;
    $('#tc_wselinfo').textContent = (sel.who === 'main' ? 'lap path' : 'alternate route ' + (sel.who + 1)) + (sel.i === sel.j ? `, point ${sel.i + 1}` : `, points ${Math.min(sel.i, sel.j) + 1}–${Math.max(sel.i, sel.j) + 1}`); }
  const nb = (q.branches || []).length, ok = tcBranches(q).length;
  $('#tc_brinfo').textContent = nb ? `${nb} made` + (ok < nb ? ` (${nb - ok} no longer line up with the lap path and are left out)` : '') : '';
  $('#tc_brdel').disabled = !nb;
}
function tcSetWidth(v) {
  const q = TC.qc, sel = TC.wsel; if (!q || !sel || !(v >= 2)) return;
  const R = tcRailOf(q, sel.who), n = R.nodes.length, lo = Math.min(sel.i, sel.j), hi = Math.max(sel.i, sel.j), blend = Math.max(0, Math.min(30, +$('#tc_wblend').value || 0));
  for (let k = lo; k <= hi; k++) R.nodes[k].w = v;
  // ease into the new width over the points either side
  for (let s = 1; s <= blend; s++) { const t = s / (blend + 1);
    for (let k of [lo - s, hi + s]) { if (R.closed) k = ((k % n) + n) % n; if (k < 0 || k >= n || (k >= lo && k <= hi)) continue;
      const cur = R.nodes[k].w ?? R.def; R.nodes[k].w = Math.round((v * (1 - t) + cur * t) * 10) / 10; } }
  tcSave(); tcUpdate();
}
renderer.domElement.addEventListener('pointerdown', e => {
  if (!TC.active || !TC.wpick || !TC.qc || e.button !== 0 || QC.drawing) return;
  const r = tcRay(e).ray, q = TC.qc, V = new THREE.Vector3(); let best = null;
  const look = (who, R) => R.nodes.forEach((f, i) => { V.set(f.pos[0], f.pos[1] + 0.3, f.pos[2]); const d = Math.sqrt(r.distanceSqToPoint(V)), lim = Math.max(3, (f.w ?? R.def) / 2); if (d < lim && (!best || d < best.d)) best = { who, i, d }; });
  look('main', tcRailOf(q, 'main')); (q.branches || []).forEach((b, k) => look(k, tcRailOf(q, k)));
  if (!best) return;
  e.stopImmediatePropagation(); e.preventDefault();
  if (e.shiftKey && TC.wsel && TC.wsel.who === best.who) TC.wsel.j = best.i; else TC.wsel = { who: best.who, i: best.i, j: best.i };
  tcUpdate(); setTimeout(() => { $('#tc_ptw').focus(); $('#tc_ptw').select(); }, 0);
}, { capture: true });
$('#tc_wpick').onclick = () => { if (!TC.wpick && TC.edit) $('#tc_edit').click(); TC.wpick = !TC.wpick; $('#tc_wpick').classList.toggle('on', TC.wpick); if (!TC.wpick) TC.wsel = null; else toast('Click the lap path (or an alternate route) to pick a point. Shift-click another point to pick the stretch between them.'); tcUpdate(); };
$('#tc_ptw').addEventListener('change', () => tcSetWidth(+$('#tc_ptw').value));
$('#tc_lapw').addEventListener('change', () => {
  const q = TC.qc, v = +$('#tc_lapw').value; if (!q || !(v >= 2)) return;
  q.width = v; q.lap.forEach(f => delete f.w); (q.branches || []).forEach(b => { b.width = v; b.lap.forEach(f => delete f.w); });
  tcSave(); tcUpdate(); toast(`Lap path is ${v} m wide everywhere.`, 'ok');
});


// ---------------------------------------------------------------- Track Creator: editing the Quick Create result
// every lap / CPU route point, item box and start spot gets a handle: drag it along the model, Delete removes it
const EKIND = { lap: 'lap path point', blap: 'alternate lap path point', route: 'CPU route point', broute: 'alternate CPU route point', item: 'item box', bitem: 'item box', start: 'start spot' };
function tcEArr(q, r) {
  const b = r.b !== undefined ? q.branches?.[r.b] : null;
  switch (r.kind) {
    case 'lap': return { arr: q.lap, closed: q.closed, path: true };
    case 'route': return { arr: q.routes[r.r], closed: q.closed, path: true };
    case 'blap': return b && { arr: b.lap, closed: false, path: true };
    case 'broute': return b && { arr: b.routes[r.r], closed: false, path: true };
    case 'item': return { arr: q.items, closed: false };
    case 'bitem': return b && { arr: b.items || (b.items = []), closed: false };
    case 'start': return { arr: q.starts, closed: false };
  }
}
const tcESame = (a, b) => a && b && a.kind === b.kind && a.i === b.i && a.r === b.r && a.b === b.b;
function tcDrawHandles(q) {
  TC.handlesQC = [];
  if (!TC.edit) return;
  const sel = TC.esel, add = (ref, pos, color, size, lift = 0) => {
    const on = tcESame(ref, sel), m = new THREE.Mesh(GEO.point, matFor(on ? 0xffe14a : color));
    m.position.set(pos[0], pos[1] + lift, pos[2]); m.scale.setScalar(on ? size * 1.6 : size); m.userData.eref = ref; TC.preview.add(m); TC.handlesQC.push(m);
  };
  q.lap.forEach((f, i) => add({ kind: 'lap', i }, f.pos, f.start ? 0xffffff : 0x3ddc84, 1.3, 0.3));
  q.routes.forEach((r, ri) => r.forEach((f, i) => add({ kind: 'route', r: ri, i }, f.pos, 0x4aa3ff, 0.9, 0.3)));
  (q.branches || []).forEach((b, bi) => { b.lap.forEach((f, i) => add({ kind: 'blap', b: bi, i }, f.pos, 0xff7ad9, 1.3, 0.3)); b.routes.forEach((r, ri) => r.forEach((f, i) => add({ kind: 'broute', b: bi, r: ri, i }, f.pos, 0x4aa3ff, 0.9, 0.3)));
    (b.items || []).forEach((f, i) => add({ kind: 'bitem', b: bi, i }, f.pos, 0xf5c542, 1.2)); });
  q.items.forEach((f, i) => add({ kind: 'item', i }, f.pos, 0xf5c542, 1.2));
  q.starts.forEach((f, i) => add({ kind: 'start', i }, f.pos, 0x3ddc84, 1.1, 0.6));
}
function tcEPush() { TC.qcHist = TC.qcHist || []; TC.qcHist.push(JSON.stringify(TC.qc)); if (TC.qcHist.length > 60) TC.qcHist.shift(); }
function tcEUndo() { if (!TC.qcHist?.length) return false; TC.qc = JSON.parse(TC.qcHist.pop()); TC.esel = null; TC.wsel = null; tcSave(); tcUpdate(); return true; }
// a path point faces along its path
function tcFixYaw(E, k) {
  const a = E.arr, n = a.length; if (n < 2) return;
  for (const j of [k - 1, k, k + 1]) {
    let i = j; if (E.closed) i = ((i % n) + n) % n; if (i < 0 || i >= n) continue;
    const p = a[E.closed ? (i - 1 + n) % n : Math.max(0, i - 1)].pos, nx = a[E.closed ? (i + 1) % n : Math.min(n - 1, i + 1)].pos;
    if (Math.hypot(nx[0] - p[0], nx[2] - p[2]) > 1e-3) a[i].yaw = Math.atan2(nx[0] - p[0], nx[2] - p[2]);
  }
}
// where the pointer meets the model, preferring the surface nearest the height it started at (so bridges and the ground under them don't swap)
function tcSurfaceAt(e, y0) {
  const hits = tcRay(e).intersectObjects(TC.rayGroup.children, false);
  if (hits.length) { hits.sort((a, b) => Math.abs(a.point.y - y0) - Math.abs(b.point.y - y0)); if (Math.abs(hits[0].point.y - y0) < 25 || !TC.eSnap) return hits[0].point; }
  return tcOnPlane(e, y0);
}
function tcEInfo() {
  const q = TC.qc, r = TC.esel, E = q && r && tcEArr(q, r), f = E?.arr[r.i];
  $('#tc_einfo').textContent = !TC.edit ? '' : TC.addItem ? 'Click the road to drop item boxes. Esc (or the button) stops.' : f ? `Selected: ${EKIND[r.kind]} ${r.i + 1}${r.kind.includes('route') ? ` (route ${r.r + 1})` : ''} · height ${f.pos[1].toFixed(1)} m` : 'Click a point, item box or start spot to select it; drag to move it.';
  $('#tc_ins').disabled = !(f && E.path); $('#tc_edel').disabled = !f;
}
function tcEDelete() {
  const q = TC.qc, r = TC.esel, E = q && r && tcEArr(q, r); if (!E || !E.arr[r.i]) return;
  if (r.kind === 'start') return toast('Start spots can\'t be removed (the race needs all of them): move them instead, or redo the start grid with Quick Create.', 'err');
  if (r.kind === 'lap' && E.arr[r.i].start) return toast('That\'s the start line point: move it instead.', 'err');
  if (E.path && E.arr.length <= 2) return toast('A path needs at least two points.', 'err');
  tcEPush(); E.arr.splice(r.i, 1); if (E.path) tcFixYaw(E, Math.min(r.i, E.arr.length - 1));
  tcSave(); tcESelect(E.arr.length ? { ...r, i: Math.min(r.i, E.arr.length - 1) } : null);
}
function tcEInsert() {
  const q = TC.qc, r = TC.esel, E = q && r && tcEArr(q, r); if (!E || !E.path || !E.arr[r.i]) return;
  const n = E.arr.length, j = r.i + 1 < n ? r.i + 1 : (E.closed ? 0 : -1);
  const a = E.arr[r.i], b = j >= 0 ? E.arr[j] : null;
  const pos = b ? a.pos.map((v, k) => Math.fround((v + b.pos[k]) / 2)) : a.pos.map((v, k) => Math.fround(v + (k === 0 ? Math.sin(a.yaw) * 10 : k === 2 ? Math.cos(a.yaw) * 10 : 0)));
  tcEPush(); const nf = { pos, yaw: a.yaw }; if (a.w !== undefined && b?.w !== undefined) nf.w = (a.w + b.w) / 2;
  E.arr.splice(r.i + 1, 0, nf); tcFixYaw(E, r.i + 1); tcSave(); tcESelect({ ...r, i: r.i + 1 });
}
function tcESelect(ref) {
  TC.esel = ref;
  TC.wsel = ref && (ref.kind === 'lap' || ref.kind === 'blap') ? { who: ref.kind === 'lap' ? 'main' : ref.b, i: ref.i, j: ref.i } : null;
  tcUpdate();
}
renderer.domElement.addEventListener('pointerdown', e => {
  if (!TC.active || !TC.edit || !TC.qc || e.button !== 0 || QC.drawing) return;
  const hit = tcRay(e).intersectObjects(TC.handlesQC || [], false)[0];
  if (TC.addItem && !hit) {
    const p = tcSurfaceAt(e, TC.qc.lap[0]?.pos[1] ?? 0); if (!p) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const k = nearestIdx(TC.qc.lap, [p.x, p.y, p.z]); tcEPush();
    TC.qc.items.push({ pos: [Math.fround(p.x), Math.fround(p.y + 1.6), Math.fround(p.z)], yaw: TC.qc.lap[k]?.yaw || 0 });
    TC.esel = { kind: 'item', i: TC.qc.items.length - 1 }; tcSave(); tcUpdate(); return;
  }
  if (!hit) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const ref = hit.object.userData.eref, E = tcEArr(TC.qc, ref), f = E.arr[ref.i];
  tcEPush(); tcESelect(ref);
  TC.edrag = { ref, E, lift: ref.kind.includes('item') ? 1.6 : 0, y0: f.pos[1], moved: false };
  orbit.enabled = false; renderer.domElement.setPointerCapture(e.pointerId);
}, { capture: true });
renderer.domElement.addEventListener('pointermove', e => {
  const d = TC.edrag; if (!d) return;
  const p = tcSurfaceAt(e, d.y0 - d.lift); if (!p) return;
  const f = d.E.arr[d.ref.i]; f.pos = [Math.fround(p.x), Math.fround(p.y + d.lift), Math.fround(p.z)]; d.moved = true;
  if (d.E.path) tcFixYaw(d.E, d.ref.i);
  tcUpdate(true);
});
const tcEEnd = e => { const d = TC.edrag; if (!d) return; TC.edrag = null; if (!d.moved) TC.qcHist.pop(); orbit.enabled = true; try { renderer.domElement.releasePointerCapture(e.pointerId); } catch {} downAt = null; tcSave(); tcUpdate(); };
renderer.domElement.addEventListener('pointerup', tcEEnd, { capture: true });
renderer.domElement.addEventListener('pointercancel', tcEEnd);
// keys while editing: Delete, PageUp/PageDown height, [ ] turn, Insert, Ctrl+Z
function tcEKey(e, k) {
  if (!TC.edit || !TC.qc) return false;
  const r = TC.esel, E = r && tcEArr(TC.qc, r), f = E?.arr[r.i];
  if (e.ctrlKey && k === 'z') { e.preventDefault(); if (!tcEUndo()) toast('Nothing to undo.'); return true; }
  if (k === 'escape') { if (TC.addItem) $('#tc_additem').click(); else tcESelect(null); return true; }
  if (!f) return false;
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); tcEDelete(); return true; }
  if (k === 'insert') { e.preventDefault(); tcEInsert(); return true; }
  if (k === 'pageup' || k === 'pagedown') { e.preventDefault(); tcEPush(); f.pos = [f.pos[0], Math.fround(f.pos[1] + (k === 'pageup' ? 0.5 : -0.5)), f.pos[2]]; tcSave(); tcUpdate(); return true; }
  if ((k === '[' || k === ']') && !E.path) { e.preventDefault(); tcEPush(); f.yaw += (k === '[' ? 1 : -1) * Math.PI / 24; tcSave(); tcUpdate(); return true; }
  return false;
}
$('#tc_edit').onclick = () => {
  TC.edit = !TC.edit; $('#tc_edit').classList.toggle('on', TC.edit);
  if (TC.edit) { if (TC.wpick) $('#tc_wpick').click(); toast('Drag points, item boxes and start spots along your model. Delete removes, Insert adds a point after the selected one, PageUp/PageDown raise or lower, [ and ] turn item boxes and start spots, Ctrl+Z undoes.'); }
  else { TC.esel = null; TC.addItem = false; $('#tc_additem').classList.remove('on'); }
  tcUpdate();
};
$('#tc_additem').onclick = () => { if (!TC.edit) $('#tc_edit').click(); TC.addItem = !TC.addItem; $('#tc_additem').classList.toggle('on', TC.addItem); tcUpdate(); };
$('#tc_ins').onclick = tcEInsert; $('#tc_edel').onclick = tcEDelete;
// ---------------------------------------------------------------- Track Creator: alternate routes
// click along the other road from where it splits off the lap path to where it joins back:
// it gets its own lap path (with the matching checkpoints) and CPU routes, linked in at both ends
function tcBranchUI() { const b = $('#tc_branch'), on = QC.mode === 'tcbranch'; b.classList.toggle('on', on); b.textContent = on ? 'Finish (Enter)' : 'Add alternate route'; }
function tcStartBranch() {
  if (QC.mode === 'tcbranch') return qcFinishDraw();
  if (!TC.qc || !TC.qc.lap.length) return toast('Make the main lap path first: Quick Create, draw the guide, Create.', 'err');
  if (QC.drawing) return;
  if ($('#qcpanel').open) $('#quick').click();
  if (TC.wpick) $('#tc_wpick').click();
  QC.mode = 'tcbranch'; QC.drawing = true; QC.guide = []; QC.closedWas = QC.closed; QC.closed = false; drawGuide(); tcBranchUI();
  toast('Click along the other road: first click on the green lap path where it splits off, last click where it joins back on. Enter finishes, Esc cancels, right-click undoes a click.');
}
function tcBranchDone(g) {
  QC.closed = QC.closedWas ?? QC.closed; tcBranchUI();
  const q = TC.qc; if (!q) return;
  if (g.length < 2) return toast('An alternate route needs at least a start and an end click.', 'err');
  const P = v => [v.x, v.y, v.z], a = nearestIdx(q.lap, P(g[0]), 40), z = nearestIdx(q.lap, P(g[g.length - 1]), 40);
  if (a < 0 || z < 0) return toast('Start and end the alternate route on the lap path (the green line).', 'err');
  if (z <= a + 1) return toast('It has to split off before it joins back: click in the race direction, and don\'t cross the start line.', 'err');
  const A = new THREE.Vector3(...q.lap[a].pos), Z = new THREE.Vector3(...q.lap[z].pos);
  const pts = [A, ...g.slice(1, -1).map(v => v.clone()), Z];
  if (pts.length === 2) { const d = Z.clone().sub(A); pts.splice(1, 0, A.clone().add(Z).multiplyScalar(0.5).add(new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(Math.max(8, d.length() * 0.25)))); }
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal'), L = curve.getLength();
  const sp = Math.max(4, qnum('spacing') || 25), m = Math.max(z - a - 1, Math.round(L / sp) - 1, 1);
  let wsum = 0; for (let k = a; k <= z; k++) wsum += nodeW(q, q.lap[k]); const width = Math.round(wsum / (z - a + 1) * 10) / 10;
  const lanes = q.routes.length, F = v => [Math.fround(v.x), Math.fround(v.y), Math.fround(v.z)];
  const put = p => { if (!snapOn()) return; const h = groundAt(p.x, p.z, p.y); if (h !== null && Math.abs(h - p.y) < 15) p.y = h; };
  const lap = [], routes = Array.from({ length: lanes }, () => []);
  for (let i = 1; i <= m; i++) {
    const u = i / (m + 1), p = curve.getPointAt(u), t = curve.getTangentAt(u), f = new THREE.Vector3(t.x, 0, t.z).normalize(), side = new THREE.Vector3(-f.z, 0, f.x), yaw = Math.atan2(f.x, f.z);
    put(p); lap.push({ pos: F(p), yaw });
    routes.forEach((r, l) => { const off = lanes === 1 ? 0 : (l / (lanes - 1) - 0.5) * width * 0.5, rp = p.clone().addScaledVector(side, off); put(rp); r.push({ pos: F(rp), yaw }); });
  }
  // a row of item boxes half way along, if the lap path has them
  const items = [];
  if (q.items.length) { const per = Math.max(1, Math.min(8, qnum('itemPer') || 4)), u = 0.5, p = curve.getPointAt(u), t = curve.getTangentAt(u), f = new THREE.Vector3(t.x, 0, t.z).normalize(), side = new THREE.Vector3(-f.z, 0, f.x);
    for (let k = 0; k < per; k++) { const bp = p.clone().addScaledVector(side, per === 1 ? 0 : (k / (per - 1) - 0.5) * width * 0.6); put(bp); bp.y += 1.6; items.push({ pos: F(bp), yaw: Math.atan2(f.x, f.z) }); } }
  tcEPush(); (q.branches = q.branches || []).push({ from: q.lap[a].pos.slice(), to: q.lap[z].pos.slice(), width, lap, routes, items });
  tcSave(); tcUpdate();
  toast(`Alternate route added: ${lap.length} lap path points${lanes ? `, ${lanes} CPU route${lanes > 1 ? 's' : ''}` : ''}${items.length ? `, ${items.length} item boxes` : ''}. It splits off at lap point ${a + 1} and rejoins at ${z + 1}.`, 'ok');
}
$('#tc_branch').onclick = tcStartBranch;
$('#tc_brdel').onclick = () => { const q = TC.qc; if (!q?.branches?.length) return; tcEPush(); q.branches.pop(); TC.esel = null; TC.wsel = null; tcSave(); tcUpdate(); toast('Removed the last alternate route.'); };

// ---------------------------------------------------------------- levelling a tilted model
function tcRot(tiltX, tiltZ, inverse) {   // the tilt as a function on a vector (or its undo)
  const tx = tiltX * Math.PI / 180, tz = tiltZ * Math.PI / 180, cx = Math.cos(tx), sx = Math.sin(tx), cz = Math.cos(tz), sz = Math.sin(tz);
  if (!inverse) return v => { const y1 = v[1] * cx - v[2] * sx, z1 = v[1] * sx + v[2] * cx; return [v[0] * cz - y1 * sz, v[0] * sz + y1 * cz, z1]; };
  return v => { const x0 = v[0] * cz + v[1] * sz, y1 = -v[0] * sz + v[1] * cz; return [x0, y1 * cx + v[2] * sx, -y1 * sx + v[2] * cx]; };
}
$('#tc_level').onclick = () => {
  if (!TC.vis) return toast('Import your model first.', 'err');
  const old = tcPlace(), pv = TC.pivot || (TC.qc?.lap[0]?.pos ? TC.qc.lap[0].pos.slice() : [0, 0, 0]);
  const t = measureTilt(TC.vis.model, makeXform({ ...old, tiltX: 0, tiltZ: 0 }));
  const nx = Math.round(t.tiltX * 100) / 100, nz = Math.round(t.tiltZ * 100) / 100;
  if (Math.abs(nx - old.tiltX) < 0.3 && Math.abs(nz - old.tiltZ) < 0.3) return toast('The track is already level.', 'ok');
  // paths made with Quick Create follow the model: undo the old tilt, apply the new one (round the same pivot)
  const P = TC.pivot || pv, un = tcRot(old.tiltX, old.tiltZ, true), re = tcRot(nx, nz);
  const move = p => { const a = un([p[0] - P[0], p[1] - P[1], p[2] - P[2]]), b = re(a); return [Math.fround(b[0] + P[0]), Math.fround(b[1] + P[1]), Math.fround(b[2] + P[2])]; };
  if (TC.qc) { const q = TC.qc; q.lap.forEach(f => f.pos = move(f.pos)); q.routes.forEach(r => r.forEach(f => f.pos = move(f.pos))); q.items.forEach(b => b.pos = move(b.pos)); q.starts.forEach(b => b.pos = move(b.pos)); (q.branches || []).forEach(b => { b.from = move(b.from); b.to = move(b.to); b.lap.forEach(f => f.pos = move(f.pos)); b.routes.forEach(r => r.forEach(f => f.pos = move(f.pos))); (b.items || []).forEach(it => it.pos = move(it.pos)); }); }
  TC.pivot = P; $('#tc_tx').value = nx; $('#tc_tz').value = nz;
  TC.impKey = ''; tcUpdate(); tcSave();
  toast(`Levelled: tilted ${nx}° forward/back and ${nz}° sideways round the start line.` + (TC.qc ? ' Your Quick Create paths moved with it; check them, or redo Quick Create.' : ''), 'ok');
};

// ---------------------------------------------------------------- resizable side windows (Track Creator, Quick Create)
// drag the left edge (width), the bottom edge (height) or the bottom-left corner; ⤢ makes it big and back; double-click an edge resets
function resizablePanel(panel, key) {
  const host = panel.parentElement, K = 'mkwe-panel-' + key, st = (() => { try { return JSON.parse(localStorage.getItem(K) || '{}'); } catch { return {}; } })();
  const save = () => { try { localStorage.setItem(K, JSON.stringify(st)); } catch {} };
  const room = () => { const H = host.getBoundingClientRect(), P = panel.getBoundingClientRect(); return { w: H.width - 30, h: H.bottom - P.top - 10 }; };
  const apply = () => {
    const r = room();
    if (st.w) panel.style.width = Math.min(r.w, Math.max(300, st.w)) + 'px'; else panel.style.width = '';
    if (st.h) { const h = Math.min(r.h, Math.max(200, st.h)) + 'px'; panel.style.maxHeight = h; panel.style.height = h; } else { panel.style.maxHeight = ''; panel.style.height = ''; }
    big.textContent = st.big ? '⤡' : '⤢'; big.title = st.big ? 'Back to the size it was' : 'Make this window big';
  };
  const big = el('button', { class: 'pbig' }); panel.querySelector('.qhead')?.insertBefore(big, panel.querySelector('.qhead button'));
  big.onclick = () => { if (st.big) { st.w = st.prev?.w; st.h = st.prev?.h; st.big = false; } else { st.prev = { w: st.w, h: st.h }; const r = room(); st.w = Math.min(r.w, Math.max(620, Math.round(host.clientWidth * 0.75))); st.h = r.h + 2000; st.big = true; } apply(); save(); };
  const grips = ['l', 'b', 'c'].map(k => { const g = el('div', { class: 'pgrip ' + k, title: 'Drag to resize · double-click to reset' }); host.append(g); return g; });
  grips.forEach(g => {
    g.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); g.setPointerCapture(e.pointerId); g.classList.add('on');
      const R = panel.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
      const mv = ev => { if (!g.classList.contains('b')) st.w = Math.round(R.width + (x0 - ev.clientX)); if (!g.classList.contains('l')) st.h = Math.round(R.height + (ev.clientY - y0)); st.big = false; apply(); };
      const up = () => { g.classList.remove('on'); g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); save(); };
      g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); });
    g.addEventListener('dblclick', () => { delete st.w; delete st.h; st.big = false; apply(); save(); });
  });
  // keep the edges on the window (it scrolls, opens and closes)
  const sync = () => {
    const shown = panel.offsetParent !== null && (panel.tagName !== 'DETAILS' || panel.open);
    if (shown) { const H = host.getBoundingClientRect(), P = panel.getBoundingClientRect(), x = P.left - H.left, y = P.top - H.top;
      Object.assign(grips[0].style, { left: x - 5 + 'px', top: y + 10 + 'px', height: Math.max(0, P.height - 24) + 'px' });
      Object.assign(grips[1].style, { left: x + 10 + 'px', top: y + P.height - 4 + 'px', width: Math.max(0, P.width - 20) + 'px' });
      Object.assign(grips[2].style, { left: x - 6 + 'px', top: y + P.height - 8 + 'px' }); }
    for (const g of grips) g.style.display = shown ? 'block' : 'none';
    requestAnimationFrame(sync);
  };
  apply(); sync(); addEventListener('resize', apply);
}
// ---------------------------------------------------------------- workspaces (like Track Studio): Track · Model · Collision · Paths · Map
// your track's editors are docked on the left, Quick Create on the right; Map is the course view (objects and every path)
const WSN = { track: 'Track', model: 'Model', collision: 'Collision', paths: 'Paths', map: 'Map' };
TC.ws = (() => { try { const w = localStorage.getItem('mkwe-ws'); return WSN[w] && w !== 'map' ? w : 'model'; } catch { return 'model'; } })();
function tcShowCol() { return TC.active && TC.ws === 'collision'; }
function wsApply() {
  const custom = TC.active || S.customTrack, cur = TC.active ? TC.ws : S.customTrack ? 'map' : null;
  document.body.classList.toggle('wson', !!custom);
  for (const k of Object.keys(WSN)) document.body.classList.toggle('ws-' + k, !!TC.active && TC.ws === k);
  document.querySelectorAll('#wstabs button').forEach(b => b.classList.toggle('on', b.dataset.ws === cur));
  $('#tc_wstitle').textContent = WSN[TC.ws] || 'Track';
}
async function wsGo(ws) {
  if (ws === 'map') { if (TC.active) await tcFinish(); wsApply(); return; }
  const was = TC.ws; TC.ws = ws; try { localStorage.setItem('mkwe-ws', ws); } catch {}
  if (!TC.active) tcOpen();
  if ((was === 'collision') !== (ws === 'collision')) TC.impKey = '';
  if (ws !== 'paths' && $('#qcpanel').open) $('#quick').click();
  wsApply(); tcUpdate(); $('#tcpanel').scrollTop = 0;
}
document.querySelectorAll('#wstabs button').forEach(b => b.onclick = () => wsGo(b.dataset.ws));
// the Collision workspace's colour key: the kinds of surface your track has
function tcColLegend(g) {
  const ids = new Set();
  if (tcImporting()) { for (const n of [...((TC.col ? tcCM() : tcVM())?.mats?.keys() || [])]) { const b = TC.map.surf[n] || 'road_asphalt'; if (b !== 'none') ids.add(b); } }
  else if (g) for (const part of g.parts) for (const m of part.col.mats) ids.add(brushFor(m));
  $('#tc_collegend').replaceChildren(...[...ids].map(id => { const b = BRUSHES.find(x => x.id === id); return el('div', { class: 'legrow' }, el('i', { style: `background:${b?.color || '#888'}` }), b?.label || id); }));
}
$('#tc_qc').onclick = () => { if (!$('#qcpanel').open) $('#quick').click(); };
// docked: the Track Creator in the left column, Quick Create in the right one
$('#left').append($('#tcpanel')); $('#right').prepend($('#qcpanel'));
new MutationObserver(() => document.body.classList.toggle('qcopen', $('#qcpanel').open)).observe($('#qcpanel'), { attributes: true, attributeFilter: ['open'] });
// File menu
{ const m = $('#filemenu'); $('#filebtn').onclick = e => { e.stopPropagation(); const b = $('#filebtn').getBoundingClientRect(), pop = m.querySelector('.menupop'); pop.style.left = b.left + 'px'; pop.style.top = (b.bottom + 4) + 'px'; m.classList.toggle('open'); };
  document.addEventListener('pointerdown', e => { if (!m.contains(e.target)) m.classList.remove('open'); });
  m.querySelector('.menupop').addEventListener('click', e => { if (e.target.tagName === 'BUTTON') m.classList.remove('open'); });
  const viaTC = id => () => { if (!TC.active) tcOpen(); TC.ws = 'track'; wsApply(); $(id).click(); };
  $('#fm_trnew').onclick = viaTC('#tc_new'); $('#fm_tropen').onclick = viaTC('#tc_import'); $('#fm_trsave').onclick = viaTC('#tc_export');
  $('#fm_trbuild').onclick = () => { if (S.customTrack && !TC.active) return $('#save').click(); viaTC('#tc_build')(); }; }
// column splitters: drag the edges of the side panels (double-click: back to the usual width)
{ const main = $('#main'), K = 'mkwe-cols', st = (() => { try { return JSON.parse(localStorage.getItem(K) || '{}'); } catch { return {}; } })();
  const put = () => { for (const [k, v] of Object.entries(st)) main.style.setProperty('--' + k, v + 'px'); };
  const mk = (host, side) => { host.style.position = 'relative'; const g = el('div', { class: 'split', title: 'Drag to resize · double-click to reset', style: side === 'L' ? 'right:-4px' : 'left:3px' }); host.append(g);
    const key = () => side === 'L' ? (TC.active ? 'tclw' : 'cvlw') : (TC.active ? 'qcw' : 'cvrw');
    g.addEventListener('pointerdown', e => { e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('on'); const M = main.getBoundingClientRect();
      const mv = ev => { st[key()] = Math.round(Math.min(M.width * 0.6, Math.max(220, side === 'L' ? ev.clientX - M.left : M.right - ev.clientX))); put(); };
      const up = () => { g.classList.remove('on'); g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); try { localStorage.setItem(K, JSON.stringify(st)); } catch {} };
      g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); });
    g.addEventListener('dblclick', () => { delete st[key()]; main.style.removeProperty('--' + key()); try { localStorage.setItem(K, JSON.stringify(st)); } catch {} }); };
  mk($('#left'), 'L'); mk($('#right'), 'R'); put(); }
wsApply();
