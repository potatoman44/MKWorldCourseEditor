// The open world's ground textures (Game03): TerrainArc/Game03_Proc.tscb lists the areas (a quadtree, levels 0-7: 16 km down to
// 125 m) and the materials. Each area has its own files: <name>.hght (heights) and <name>.mate (materials), 260 x 260 pixels,
// pixel p's centre at the area's edge + (p - 1.5) / 257 * size (so pixels 2..258 cover the area, the outer ones overlap its neighbours).
// A .mate pixel is 4 bytes: material A, material B, blend (0 = all A, 255 = all B), and a spare byte.
// The files are a 0x14-byte "TARB" header (+0x0c: unpacked size, +0x10: packed size) and a zstd frame; the picture is the last part
// of what's unpacked, stored in the GPU's block-linear layout (block height 1) with its own order of the 16-byte pieces.
import { zsDecompress, zsStore } from './formats.js';

export const WORLD = 16000, WMIN = -8000, PX = 260;
const ORDER = ['y0', 'y1', 'x8', 'y2', 'x16'];
const maps = {};
// texel order: for each texel stored in the file, its spot in the 260 x 260 picture (-1: padding)
function texelMap(bpp) {
  if (maps[bpp]) return maps[bpp];
  const gx = Math.ceil(PX * bpp / 64), rows = Math.ceil(PX / 8) * 8, tpc = 16 / bpp, gobW = 64 / bpp;
  const n = gx * 64 * rows / bpp, m = new Int32Array(n);
  for (let r = 0; r < n; r++) {
    const chunk = (r / tpc) | 0, k = r % tpc, gob = chunk >> 5, c = chunk & 31, b = {};
    ORDER.forEach((name, i) => b[name] = (c >> i) & 1);
    const y = ((gob / gx) | 0) * 8 + b.y0 + 2 * b.y1 + 4 * b.y2, x = (gob % gx) * gobW + tpc * b.x8 + 2 * tpc * b.x16 + k;
    m[r] = x < PX && y < PX ? y * PX + x : -1;
  }
  return maps[bpp] = m;
}
function unpack(file) {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const dec = zsDecompress(file.subarray(0x14));
  if (dec.length !== dv.getUint32(0x0c, true)) throw new Error('unexpected terrain file size');
  return dec;
}
export function readMate(file) {
  const dec = unpack(file), map = texelMap(4), size = map.length * 4, off = dec.length - size;
  const raw = new Uint32Array(dec.slice(off).buffer), img = new Uint32Array(PX * PX);
  for (let r = 0; r < map.length; r++) if (map[r] >= 0) img[map[r]] = raw[r];
  return { dec, off, raw, img };
}
export function writeMate(file, m, img) {
  const map = texelMap(4), raw = new Uint32Array(m.raw);
  for (let r = 0; r < map.length; r++) if (map[r] >= 0) raw[r] = img[map[r]];
  const dec = new Uint8Array(m.dec); dec.set(new Uint8Array(raw.buffer), m.off);
  const z = zsStore(dec), out = new Uint8Array(0x14 + z.length), dv = new DataView(out.buffer);
  out.set(file.subarray(0, 0x0c)); dv.setUint32(0x0c, dec.length, true); dv.setUint32(0x10, z.length, true); out.set(z, 0x14);
  return out;
}
// heights in metres
export function readHeights(file) {
  const dec = unpack(file), map = texelMap(2), size = map.length * 2, off = dec.length - size;
  const raw = new Uint16Array(dec.slice(off).buffer), h = new Float32Array(PX * PX);
  for (let r = 0; r < map.length; r++) if (map[r] >= 0) h[map[r]] = raw[r] * 2000 / 65536;
  return h;
}
// the scene: area names -> centre/size, and the materials (texture slice and tint)
export function readTscb(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), u = o => dv.getUint32(o, true), f = o => dv.getFloat32(o, true);
  if (String.fromCharCode(...d.subarray(0, 4)) !== 'TSCB') throw new Error('not a TSCB file');
  const nMat = u(0x34), nArea = u(0x38), matArr = 0x74 + u(0x74), areaArr = 0x78 + u(0x78);
  const mats = [];
  for (let i = 0; i < nMat; i++) { const o = matArr + 4 * i + u(matArr + 4 * i); mats.push({ slice: u(o), tint: [f(o + 0x30), f(o + 0x34), f(o + 0x38)] }); }
  const areas = new Map();
  for (let i = 0; i < nArea; i++) {
    const o = areaArr + 4 * i + u(areaArr + 4 * i), np = o + 0x60 + u(o + 0x60);
    let e = np; while (d[e]) e++;
    const name = String.fromCharCode(...d.subarray(np, e)), size = f(o + 8) * 250;
    areas.set(name, { name, level: +name[1], x: f(o) * 250 - size / 2, z: f(o + 4) * 250 - size / 2, size });
  }
  return { mats, areas };
}
const morton = (x, z, L) => { let v = 0; for (let b = 0; b < L; b++) v += (((x >> b) & 1) + 2 * ((z >> b) & 1)) * 4 ** b; return v; };
export const areaName = (L, ix, iz) => '6' + L + morton(ix, iz, L).toString(16).toUpperCase().padStart(8, '0');
// every area (all levels) that overlaps a box in world metres
export function areasIn(tscb, x0, z0, x1, z1) {
  const out = [];
  for (let L = 0; L <= 9; L++) {
    const s = WORLD / 2 ** L;
    for (let iz = Math.floor((z0 - WMIN) / s); iz <= Math.floor((z1 - 1e-3 - WMIN) / s); iz++)
      for (let ix = Math.floor((x0 - WMIN) / s); ix <= Math.floor((x1 - 1e-3 - WMIN) / s); ix++) {
        const a = tscb.areas.get(areaName(L, ix, iz)); if (a) out.push(a);
      }
  }
  return out;
}
export const matePath = n => `TerrainArc/Game03_Proc/${n}.mate`, hghtPath = n => `TerrainArc/Game03_Proc/${n}.hght`;
export const TSCB_PATH = 'TerrainArc/Game03_Proc.tscb';

// one brush dab on a pixel: blends material M in by w (0..1). The pixel keeps two materials, so a third one replaces the weaker.
export function paintPixel(v, M, w) {
  let A = v & 255, B = (v >>> 8) & 255, t = (v >>> 16) & 255; const s = v & 0xff000000;
  if (w >= 0.995) { A = B = M; t = 0; }
  else if (A === M && (B === M || t === 0)) return v;
  else if (B === M) t = t + (255 - t) * w;
  else if (A === M) t = t * (1 - w);
  else { const dom = t < 128 ? A : B, keep = t < 128 ? 255 - t : t; A = dom; B = M; t = 255 * w * Math.min(1, keep / 255 + 0.5); }
  t = Math.round(t);
  if (t >= 252 && B === M) { A = M; t = 0; }
  if (t <= 2) t = 0;
  return (s | (t << 16) | (B << 8) | A) >>> 0;
}
export const dominant = v => (((v >>> 16) & 255) < 128 ? v & 255 : (v >>> 8) & 255);
