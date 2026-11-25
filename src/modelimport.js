// Model import for the Track Creator: OBJ / FBX / DAE -> triangles grouped by material, then packed into track parts.
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { BRUSHES } from './surfaces.js';

// texture slots of the base model the game draws with (the model's own textures aren't written yet)
export const SLOTS = [
  ['asphalt', 'Road (asphalt)'], ['floortile', 'Floor tiles'], ['floorparts', 'Floor panels'], ['frame', 'Frame / wall'],
  ['wall03', 'Wall parts 1'], ['wall06', 'Wall parts 2'], ['backside01', 'Backing 1'], ['backside00', 'Backing 2'],
  ['wiremesh', 'Wire mesh'], ['watersedge', 'Water\'s edge'], ['framesparts', 'Frame parts'], ['decomark', 'Deco marks'], ['floorlight', 'Floor lights'],
];
export const SLOT_COLOR = { asphalt: 0x6b7280, floortile: 0x3f6f38, floorparts: 0x5f9e4a, frame: 0xd08a52, wall03: 0xb07a5a, wall06: 0x9a6a4a, backside01: 0x6a6f8a,
  backside00: 0x5a5f7a, wiremesh: 0x8899aa, watersedge: 0x4a90c0, framesparts: 0xc0a060, decomark: 0xe0e0e0, floorlight: 0xf0e080 };

// best guesses from a material's name
export function guessSlot(name) {
  const n = name.toLowerCase();
  if (/road|asphalt|track|street|tarmac|pave/.test(n)) return 'asphalt';
  if (/grass|lawn|turf|ground|terrain|dirt|sand|soil|offroad/.test(n)) return 'floortile';
  if (/wall|fence|barrier|rail|guard|frame/.test(n)) return 'frame';
  if (/floor|tile|plat|deck|bridge/.test(n)) return 'floorparts';
  if (/water|sea|river/.test(n)) return 'watersedge';
  if (/mark|line|stripe|deco|sign/.test(n)) return 'decomark';
  return 'floorparts';
}
export function guessSurface(name) {
  const n = name.toLowerCase();
  if (/boost|dash/.test(n)) return 'boost';
  if (/invis|air.?wall|block(er)?$/.test(n)) return 'invisible_wall';
  if (/lamp.?post|street.?light|light.?pole|lightpole/.test(n)) return 'pole_iron';
  if (/(^|[^a-z])pole|trunk|tree.?bark|(^|[^a-z])post($|[^a-z])/.test(n)) return 'pole_wood';
  if (/wall|fence|barrier|rail|guard/.test(n)) return 'wall_concrete';
  if (/grass|lawn|turf|ground|terrain/.test(n)) return 'grass';
  if (/sand|beach/.test(n)) return 'sand';
  if (/dirt|soil|mud|offroad/.test(n)) return 'offroad';
  if (/water|sea|river/.test(n)) return 'water';
  if (/ice/.test(n)) return 'ice';
  if (/snow/.test(n)) return 'snow';
  if (/lava/.test(n)) return 'lava';
  if (/kerb|curb|rumble/.test(n)) return 'bumpy';
  if (/wood|plank/.test(n)) return 'road_wood';
  if (/metal|iron|steel|grate/.test(n)) return 'road_iron';
  return 'road_asphalt';
}

// textures referenced by the file can't be loaded from here: hand the loaders a blank pixel instead
const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const IMG = /\.(png|jpe?g|bmp|gif|webp|tga)$/i;
const base = u => decodeURIComponent(String(u).split(/[\\/]/).pop().split('?')[0]).toLowerCase();
// textures the model refers to are taken from the image files picked along with it (matched by file name)
function manager(images) {
  const m = new THREE.LoadingManager();
  m.setURLModifier(u => (u.startsWith('data:') || u.startsWith('blob:')) ? u : (images.get(base(u)) || BLANK));
  m.addHandler(/\.tga$/i, new TGALoader(m));
  return m;
}
export const isImage = n => IMG.test(n);

/**
 * files: [{name, bytes}] — one .obj/.fbx/.dae, plus any .mtl and image files that go with it.
 * -> {name, mats: Map(name -> {pos, nrm, uv}) (3 corners per triangle), tris, tex: Map(material -> {file, image})}
 */
export async function parseModel(files) {
  const main = files.find(f => /\.(obj|fbx|dae)$/i.test(f.name)); if (!main) throw new Error('pick an .obj, .fbx or .dae file');
  const name = main.name, bytes = main.bytes, ext = name.toLowerCase().split('.').pop();
  const images = new Map(), urls = [];
  for (const f of files) if (IMG.test(f.name)) { const u = URL.createObjectURL(new Blob([f.bytes])); urls.push(u); images.set(base(f.name), u); }
  const mgr = manager(images);
  let root;
  const text = b => new TextDecoder().decode(b);
  if (ext === 'obj') {
    const ol = new OBJLoader(mgr), mtl = files.find(f => /\.mtl$/i.test(f.name));
    if (mtl) { const mc = new MTLLoader(mgr).parse(text(mtl.bytes), ''); mc.preload(); ol.setMaterials(mc); }
    root = ol.parse(text(bytes));
  } else if (ext === 'fbx') root = new FBXLoader(mgr).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  else root = new ColladaLoader(mgr).parse(text(bytes), '').scene;
  if (ext === 'fbx') { const u = fbxUnitScale(bytes); if (u && Math.abs(u - 100) > 1e-6) root.scale.multiplyScalar(u / 100); }   // FBX units -> metres
  root.updateMatrixWorld(true);
  const mats = new Map(), maps = new Map(); let tris = 0;
  const P = new THREE.Vector3(), N = new THREE.Vector3(), nm = new THREE.Matrix3();
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry, pos = g.attributes.position; if (!pos) return;
    const nrm = g.attributes.normal, uv = g.attributes.uv, idx = g.index;
    nm.getNormalMatrix(o.matrixWorld);
    const mlist = Array.isArray(o.material) ? o.material : [o.material];
    const count = idx ? idx.count : pos.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const gr of groups) {
      const m = mlist[gr.materialIndex] || mlist[0];
      const key = (m && m.name) || (mlist.length > 1 ? 'Material' + gr.materialIndex : 'Material');
      if (!mats.has(key)) mats.set(key, { pos: [], nrm: [], uv: [] });
      if (m && m.map && !maps.has(key)) maps.set(key, m.map);
      const T = mats.get(key);
      const end = Math.min(count, gr.start + gr.count);
      for (let k = gr.start; k + 2 < end + 0 && k + 2 < count; k += 3) {
        const c = [0, 1, 2].map(j => idx ? idx.getX(k + j) : k + j);
        const ps = c.map(i => P.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).toArray());
        let fn = null;
        if (!nrm) { const a = new THREE.Vector3(...ps[0]), b = new THREE.Vector3(...ps[1]), d = new THREE.Vector3(...ps[2]); fn = b.sub(a).cross(d.sub(a)).normalize().toArray(); }
        for (let j = 0; j < 3; j++) {
          T.pos.push(...ps[j]);
          T.nrm.push(...(nrm ? N.fromBufferAttribute(nrm, c[j]).applyMatrix3(nm).normalize().toArray() : fn));
          const u = uv ? uv.getX(c[j]) : 0, v = uv ? uv.getY(c[j]) : 0; T.uv.push(isFinite(u) ? u : 0, isFinite(v) ? v : 0);
        }
        tris++;
      }
    }
  });
  if (!tris) throw new Error('no triangles found in ' + name);
  // wait (a little) for the textures to finish loading, then keep the ones that really loaded
  const ready = t => { const im = t.image; return im && ((im.width > 1 && im.height > 1) || (im.data && im.width > 1)) && (im.complete !== false); };
  const done = t => t.image && (t.image.data || t.image.complete !== false);
  for (let i = 0; i < 80 && [...maps.values()].some(t => !done(t)); i++) await new Promise(r => setTimeout(r, 100));
  const tex = new Map();
  const nameOf = new Map([...images].map(([n, u]) => [u, n]));
  // which image file it is: from the image itself (FBX textures can all carry the same name, so the name alone would merge them)
  for (const [k, t] of maps) { if (!ready(t)) continue; const src = t.image && t.image.src || ''; const file = (src && (nameOf.get(src) || (src.startsWith('blob:') ? src : base(src)))) || t.name || k; tex.set(k, { file, image: toCanvas(t.image, t.flipY === false) }); }
  setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 5000);
  return { name, mats, tris, tex };
}
// any image (img element, ImageBitmap, TGA data) -> canvas
export function toCanvas(im, flip) {
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d');
  if (im.data) { const id = new ImageData(im.width, im.height); const src = im.data; const ch = src.length / (im.width * im.height);
    for (let i = 0; i < im.width * im.height; i++) { id.data[4 * i] = src[ch * i]; id.data[4 * i + 1] = src[ch * i + 1]; id.data[4 * i + 2] = src[ch * i + 2]; id.data[4 * i + 3] = ch > 3 ? src[ch * i + 3] : 255; }
    g.putImageData(id, 0, 0); if (flip) { const c2 = document.createElement('canvas'); c2.width = c.width; c2.height = c.height; const g2 = c2.getContext('2d'); g2.translate(0, c.height); g2.scale(1, -1); g2.drawImage(c, 0, 0); return c2; } }
  else g.drawImage(im, 0, 0);
  return c;
}
export async function imageFileToCanvas(f) {
  if (/\.tga$/i.test(f.name)) { const t = new TGALoader().parse(f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength)); return toCanvas(t, true); }
  const bmp = await createImageBitmap(new Blob([f.bytes])); return toCanvas(bmp);
}
// pixels of a canvas scaled to w x h (opaque)
export function canvasRGBA(c, w, h, keepAlpha) {
  const o = document.createElement('canvas'); o.width = w; o.height = h; const g = o.getContext('2d');
  g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data; if (!keepAlpha) for (let i = 3; i < d.length; i += 4) d[i] = 255; return d;
}
export function thumb(c, size = 64) { const o = document.createElement('canvas'); o.width = size; o.height = size; o.getContext('2d').drawImage(c, 0, 0, size, size); return o.toDataURL(); }

// FBX "UnitScaleFactor" (centimetres per unit; 1 = cm, 100 = m), ASCII or binary
function fbxUnitScale(b) {
  const key = new TextEncoder().encode('UnitScaleFactor');
  let i = -1;
  outer: for (let k = 0; k + key.length < b.length; k++) { for (let j = 0; j < key.length; j++) if (b[k + j] !== key[j]) continue outer; i = k; break; }
  if (i < 0) return null;
  if (b[0] !== 0x4b) {   // ASCII: P: "UnitScaleFactor", "double", "Number", "",100
    const m = /UnitScaleFactor"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*([-0-9.eE+]+)/.exec(new TextDecoder().decode(b.subarray(i - 1, i + 120)));
    return m ? parseFloat(m[1]) : null;
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); let p = i + key.length;
  for (let n = 0; n < 3; n++) { if (b[p] !== 0x53) return null; p += 5 + dv.getUint32(p + 1, true); }   // three more strings
  if (b[p] === 0x44) return dv.getFloat64(p + 1, true);
  if (b[p] === 0x46) return dv.getFloat32(p + 1, true);
  return null;
}

// placement: scale, Z-up -> Y-up, turn around Y, then move
export function makeXform(o) {
  const s = o.scale || 1, a = (o.rotY || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), off = [o.ox || 0, o.oy || 0, o.oz || 0];
  const zUp = !!o.zUp;
  // tilt (levelling): turn about X, then Z, round a pivot (the start line), after everything else
  const tx = (o.tiltX || 0) * Math.PI / 180, tz = (o.tiltZ || 0) * Math.PI / 180, cx = Math.cos(tx), sx = Math.sin(tx), cz = Math.cos(tz), sz = Math.sin(tz);
  const pv = o.pivot || [0, 0, 0], tilted = tx || tz;
  const tilt = (x, y, z) => { const y1 = y * cx - z * sx, z1 = y * sx + z * cx; return [x * cz - y1 * sz, x * sz + y1 * cz, z1]; };
  const pos = (x, y, z) => { x *= s; y *= s; z *= s; if (zUp) { const t = y; y = z; z = -t; }
    let p = [ca * x + sa * z + off[0], y + off[1], -sa * x + ca * z + off[2]];
    if (tilted) { const q = tilt(p[0] - pv[0], p[1] - pv[1], p[2] - pv[2]); p = [q[0] + pv[0], q[1] + pv[1], q[2] + pv[2]]; }
    return p; };
  const nrm = (x, y, z) => { if (zUp) { const t = y; y = z; z = -t; } const n = [ca * x + sa * z, y, -sa * x + ca * z]; return tilted ? tilt(...n) : n; };
  return { pos, nrm, tilt: tilted ? (p => { const q = tilt(p[0] - pv[0], p[1] - pv[1], p[2] - pv[2]); return [q[0] + pv[0], q[1] + pv[1], q[2] + pv[2]]; }) : (p => p) };
}
// how far the model leans: the average "up" of its flat-ish faces -> the tilt that levels it
export function measureTilt(model, xf) {
  // the most common "up" among flat-ish faces (by area): the floor the track was built on, ignoring slopes and hills
  const faces = [];
  for (const T of model.mats.values()) for (let i = 0; i < T.pos.length; i += 9) {
    const a = xf.pos(T.pos[i], T.pos[i + 1], T.pos[i + 2]), b = xf.pos(T.pos[i + 3], T.pos[i + 4], T.pos[i + 5]), c = xf.pos(T.pos[i + 6], T.pos[i + 7], T.pos[i + 8]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n); if (!l) continue;
    if (n[1] < 0) n = n.map(x => -x); if (n[1] / l < 0.85) continue;
    faces.push([n[0] / l, n[2] / l, l]);
  }
  if (!faces.length) return { tiltX: 0, tiltZ: 0 };
  const deg = Math.PI / 180, bin = 0.5 * deg, H = new Map();
  for (const [x, z, w] of faces) { const k = Math.round(Math.asin(Math.max(-1, Math.min(1, x))) / bin) + ',' + Math.round(Math.asin(Math.max(-1, Math.min(1, z))) / bin); H.set(k, (H.get(k) || 0) + w); }
  let best = null, bw = -1; for (const [k, w] of H) if (w > bw) { bw = w; best = k; }
  const [bx, bz] = best.split(',').map(Number);
  let sx = 0, sz = 0, sw = 0;
  for (const [x, z, w] of faces) { const ax = Math.asin(Math.max(-1, Math.min(1, x))) / bin, az = Math.asin(Math.max(-1, Math.min(1, z))) / bin; if (Math.abs(ax - bx) <= 2 && Math.abs(az - bz) <= 2) { sx += x * w; sz += z * w; sw += w; } }
  const nx = sx / sw, nz = sz / sw, ny = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz));
  const tx = -Math.atan2(nz, ny), y1 = ny * Math.cos(tx) - nz * Math.sin(tx), tz = Math.atan2(nx, y1);
  return { tiltX: tx / deg, tiltZ: tz / deg };
}
export function boundsOf(model, xf) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const T of model.mats.values()) for (let i = 0; i < T.pos.length; i += 3) { const p = xf.pos(T.pos[i], T.pos[i + 1], T.pos[i + 2]); for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]); } }
  return [mn, mx];
}
// a three.js preview of a model, coloured by its slot/surface
export function previewMesh(model, xf, colorOf, opts = {}) {
  const grp = new THREE.Group();
  for (const [name, T] of model.mats) {
    const n = T.pos.length / 3, pos = new Float32Array(n * 3), nr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const p = xf.pos(T.pos[3 * i], T.pos[3 * i + 1], T.pos[3 * i + 2]), q = xf.nrm(T.nrm[3 * i], T.nrm[3 * i + 1], T.nrm[3 * i + 2]); pos.set(p, 3 * i); nr.set(q, 3 * i); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nr, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(T.uv), 2));
    const map = !opts.wire && opts.tex ? opts.tex(name) : null;
    g.computeBoundsTree?.();
    const m = opts.wire ? new THREE.MeshBasicMaterial({ color: colorOf(name), wireframe: true, transparent: true, opacity: 0.35 })
      : new THREE.MeshStandardMaterial({ color: map ? 0xffffff : colorOf(name), map, roughness: 0.85, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m); mesh.userData.mat = name; grp.add(mesh);
  }
  return grp;
}

// ---------------------------------------------------------------- packing into parts
function mortonOrder(cs) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const c of cs) for (let a = 0; a < 3; a++) { if (c[a] < mn[a]) mn[a] = c[a]; if (c[a] > mx[a]) mx[a] = c[a]; }
  const key = c => { const q = [0, 1, 2].map(a => Math.min(1023, Math.trunc((c[a] - mn[a]) / ((mx[a] - mn[a]) || 1) * 1023))); let k = 0;
    for (let bit = 0; bit < 10; bit++) for (const a of [0, 2, 1]) k = k * 2 + ((q[a] >> (9 - bit)) & 1); return k; };
  const keys = cs.map(key);
  return cs.map((_, i) => i).sort((i, j) => keys[i] - keys[j]);
}
const DUMMY = [[[0, -600, 0], [0.5, -600, 0], [0, -600, 0.5]], 0];

/**
 * visual/collision: parsed models (collision may be null: the visual model is used).
 * map: {slot: {matName: slot}, surf: {matName: brushId}}, xfV/xfC: placements, cap: modelCapacity()
 * returns {parts:[{name, local, min, max, geom, col}], stats}
 */
// slots a textured material may borrow when its own choice is taken (plain, opaque looks)
const BORROW = ['floortile', 'floorparts', 'frame', 'backside01', 'asphalt', 'wall03', 'backside00', 'wall06'];
// the looks whose material cuts holes from a mask texture (render mode "mask"): see-through materials go here
export const MASKED = ['wiremesh', 'framesparts'];
export function packParts(visual, collision, map, xfV, xfC, cap, texOf = () => null, nameBase = 'CmnObj_CTrkPart') {
  // groups: every textured material on its own; untextured materials share their look's slot
  const groups = new Map();
  for (const [name, T] of visual.mats) {
    let slot = map.slot[name] || 'floorparts'; if (slot === 'none') continue;
    const tex = texOf(name), cut = !!(tex && map.cut && map.cut[name]), two = !!(map.two && map.two[name]);
    if (cut && !MASKED.includes(slot)) slot = 'wiremesh';
    const key = tex ? 'm:' + name : 's:' + slot;
    if (!groups.has(key)) groups.set(key, { key, slot, tex, cut, tris: [], pos: 0 });
    const L = groups.get(key).tris;
    for (let i = 0; i < T.pos.length / 9; i++) {
      const t = [0, 1, 2].map(j => { const k = 3 * i + j; return [xfV.pos(T.pos[3 * k], T.pos[3 * k + 1], T.pos[3 * k + 2]), xfV.nrm(T.nrm[3 * k], T.nrm[3 * k + 1], T.nrm[3 * k + 2]), [T.uv[2 * k], 1 - T.uv[2 * k + 1]]]; });
      // keep UVs small (they're stored as 16-bit floats): move each triangle's UVs by whole tiles
      const du = Math.floor(Math.min(t[0][2][0], t[1][2][0], t[2][2][0])), dv = Math.floor(Math.min(t[0][2][1], t[1][2][1], t[2][2][1]));
      if (isFinite(du) && isFinite(dv) && (du || dv)) for (const v of t) v[2] = [v[2][0] - du, v[2][1] - dv];
      L.push(t);
      if (two) L.push([t[0], t[2], t[1]].map(([p, n, uv]) => [p, n.map(x => -x), uv]));   // the back face
    }
  }
  for (const g of groups.values()) { const o = mortonOrder(g.tris.map(t => [0, 1, 2].map(a => (t[0][0][a] + t[1][0][a] + t[2][0][a]) / 3))); g.tris = o.map(i => g.tris[i]); }
  // fill parts: each part has 13 slots, one group per slot
  const vparts = [], q = x => Math.round(x * 1000);
  const left = g => g.tris.length - g.pos;
  while ([...groups.values()].some(g => left(g) > 0)) {
    const used = new Map(), order = [...groups.values()].filter(g => left(g) > 0).sort((a, b) => left(b) - left(a));
    for (const g of order) for (let first = true; left(g) > 0; first = false) {
      // its own look first; a textured material may also spread over other free slots of this part
      let slot = first && !used.has(g.slot) ? g.slot : null;
      if (!slot && g.tex) slot = (g.cut ? MASKED : BORROW).filter(s => !used.has(s) && cap[s]).sort((a, b) => cap[b].tris - cap[a].tris)[0] || null;
      if (!slot) break;
      const c = cap[slot]; if (!c) throw new Error('unknown texture slot ' + slot);
      const ch = { V: [], vi: new Map(), tris: [], tex: g.tex };
      while (g.pos < g.tris.length) {
        const t = g.tris[g.pos], keys = t.map(v => [...v[0].map(q), ...v[1].map(x => Math.round(x * 100)), ...v[2].map(q)].join(','));
        const newV = keys.filter((k, j) => !ch.vi.has(k) && keys.indexOf(k) === j).length;
        if (ch.tris.length + 1 > c.tris || ch.V.length + newV > c.verts) break;
        ch.tris.push(keys.map((k, j) => { if (!ch.vi.has(k)) { ch.vi.set(k, ch.V.length); ch.V.push(t[j]); } return ch.vi.get(k); }));
        g.pos++;
      }
      used.set(slot, ch); if (!ch.tris.length) break;
    }
    for (const [k, ch] of used) if (!ch.tris.length) used.delete(k);
    if (!used.size) throw new Error('could not fit the model into parts');
    vparts.push(used);
  }
  // collision triangles (in chunks of up to 3000)
  const src = collision || visual, xc = collision ? xfC : xfV;
  const brushIds = [], ctris = [];
  for (const [name, T] of src.mats) {
    const b = map.surf[name] || 'road_asphalt'; if (b === 'none') continue;
    let tag = brushIds.indexOf(b); if (tag < 0) { tag = brushIds.length; brushIds.push(b); }
    for (let i = 0; i < T.pos.length / 9; i++) ctris.push([[0, 1, 2].map(j => { const k = 3 * i + j; return xc.pos(T.pos[3 * k], T.pos[3 * k + 1], T.pos[3 * k + 2]); }), tag]);
  }
  const mats = brushIds.map(id => { const b = BRUSHES.find(x => x.id === id); return [b.mat, b.sub, b.mask]; });
  const corder = mortonOrder(ctris.map(([t]) => [0, 1, 2].map(a => (t[0][a] + t[1][a] + t[2][a]) / 3)));
  const colChunks = []; for (let i = 0; i < corder.length; i += 3000) colChunks.push(corder.slice(i, i + 3000).map(k => ctris[k]));
  // part i = chunk i of every slot + collision chunk i
  const n = Math.max(1, colChunks.length, vparts.length);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const all = [], vp = vparts[i] || new Map();
    for (const ch of vp.values()) for (const v of ch.V) all.push(v[0]);
    if (colChunks[i]) for (const [t] of colChunks[i]) all.push(...t);
    const mn = [0, 1, 2].map(a => Math.min(...all.map(p => p[a]))), mx = [0, 1, 2].map(a => Math.max(...all.map(p => p[a])));
    const local = [0, 1, 2].map(a => (mn[a] + mx[a]) / 2), L = p => [p[0] - local[0], p[1] - local[1], p[2] - local[2]];
    const geom = {}, tex = {};
    for (const [slot, ch] of vp) { geom[slot] = [ch.V.map(([p, nr, uv]) => [L(p), nr, uv]), ch.tris]; if (ch.tex) tex[slot] = ch.tex; }
    const col = colChunks[i] ? { tris: colChunks[i].map(([t, tag]) => [t.map(L), tag]), mats } : { tris: [DUMMY], mats: [[4, 4, 0]] };
    parts.push({ name: nameBase + String(i).padStart(3, '0'), local, min: mn.map((x, a) => x - local[a]), max: mx.map((x, a) => x - local[a]), geom, col, tex });
  }
  const vtris = [...groups.values()].reduce((s, g) => s + g.tris.length, 0);
  return { parts, stats: { parts: n, visualTris: vtris, collisionTris: ctris.length, textured: [...groups.values()].filter(g => g.tex).length } };
}

// ---------------------------------------------------------------- start grid reference model (metres, Y up, race heads -Z)
export const GRID_X = [7.3, 4.5, 1.7, -1.1, -3.9, -6.7, 5.9, 3.1, 0.3, -2.5, -5.3, -8.1];
export function startGridObj() {
  const lines = ['# Mario Kart World custom track: start grid reference', '# 1 unit = 1 metre, Y is up, the race starts heading -Z. The start line is at the origin.',
    '# Line your road up with this, then import the road into the Track Creator with scale 1 and no offset.', 'mtllib start_grid.mtl'];
  let v = 0;
  const box = (name, mtl, x0, x1, y0, y1, z0, z1) => {
    lines.push(`o ${name}`, `usemtl ${mtl}`);
    for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]) lines.push(`v ${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)}`);
    for (const f of [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]]) lines.push('f ' + f.map(k => k + v).join(' '));
    v += 8;
  };
  const quad = (name, mtl, pts) => { lines.push(`o ${name}`, `usemtl ${mtl}`); for (const p of pts) lines.push(`v ${p.map(x => x.toFixed(3)).join(' ')}`); lines.push(`f ${v + 1} ${v + 2} ${v + 3} ${v + 4}`); v += 4; };
  quad('StraightTheEditorKeeps', 'Guide', [[-10, -0.02, -22], [-10, -0.02, 60], [10, -0.02, 60], [10, -0.02, -22]]);
  box('StartLine', 'StartLine', -10, 10, 0, 0.03, -0.5, 0.5);
  const xs = GRID_X;
  for (let i = 0; i < 24; i++) {
    const x = xs[i % 12], z = 2 * i;            // Rainbow Road's start spots (the game's own grid): kart centres, facing -Z
    box(`Kart_${String(i + 1).padStart(2, '0')}`, 'Kart', x - 0.7, x + 0.7, 0, 1.0, z - 1.1, z + 1.1);
    box(`Kart_${String(i + 1).padStart(2, '0')}_Front`, 'KartFront', x - 0.3, x + 0.3, 1.0, 1.3, z - 1.1, z - 0.6);
  }
  box('Height_1m_Marker', 'Guide', -12.5, -11.5, 0, 1, -0.5, 0.5);
  box('Width_20m_Marker', 'Guide', -10, 10, 0, 0.05, 62, 62.3);
  const mtl = ['newmtl Guide', 'Kd 0.35 0.4 0.5', 'newmtl StartLine', 'Kd 1 1 1', 'newmtl Kart', 'Kd 0.24 0.86 0.52', 'newmtl KartFront', 'Kd 1 0.3 0.3', ''].join('\n');
  return { obj: lines.join('\n') + '\n', mtl };
}
