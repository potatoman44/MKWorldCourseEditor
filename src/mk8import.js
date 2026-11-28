// Mario Kart 8 Deluxe course files -> plain data the Track Creator can use.
//   course_model.szs   (Yaz0 -> BFRES 0.5 with an embedded BNTX): meshes, UVs, materials, albedo textures
//   course_kcl.szs     (Yaz0 -> KCL v2, several sub-models): collision triangles and their 16-bit flags
//   course_muunt.byaml (BYML v1 with path nodes): lap / CPU / item / gravity / glide paths and objects
// Nothing here touches the DOM, so it also runs under Node for testing.
import { untile } from './astc.js';

// ---------------------------------------------------------------- Yaz0
export function yaz0(d) {
  if (String.fromCharCode(d[0], d[1], d[2], d[3]) !== 'Yaz0') return d;
  const n = (d[4] << 24 | d[5] << 16 | d[6] << 8 | d[7]) >>> 0, out = new Uint8Array(n);
  let i = 16, o = 0;
  while (o < n) {
    const h = d[i++];
    for (let b = 0; b < 8 && o < n; b++) {
      if (h & (0x80 >> b)) { out[o++] = d[i++]; continue; }
      const b1 = d[i++], b2 = d[i++], dist = ((b1 & 15) << 8 | b2) + 1;
      let c = b1 >> 4; c = c === 0 ? d[i++] + 0x12 : c + 2;
      for (let k = 0; k < c && o < n; k++, o++) out[o] = out[o - dist];
    }
  }
  return out;
}

// ---------------------------------------------------------------- BYML v1-v3 (MK8: little endian, with path nodes)
export function byml1(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), u32 = o => dv.getUint32(o, true);
  if (d[0] !== 0x59 || d[1] !== 0x42) throw new Error('not a little-endian BYML file');
  const ver = dv.getUint16(2, true), dec = new TextDecoder();
  const keyT = u32(4), strT = u32(8), pathT = ver === 1 ? u32(12) : 0, root = u32(ver === 1 ? 16 : 12);
  const table = o => { if (!o) return []; const n = u32(o) >>> 8, r = []; for (let i = 0; i < n; i++) { const s = o + u32(o + 4 + 4 * i); let e = s; while (d[e]) e++; r.push(dec.decode(d.subarray(s, e))); } return r; };
  const keys = table(keyT), strs = table(strT), paths = [];
  if (pathT) { const n = u32(pathT) >>> 8; for (let i = 0; i < n; i++) { const a = pathT + u32(pathT + 4 + 4 * i), b = pathT + u32(pathT + 8 + 4 * i), pts = []; for (let p = a; p + 28 <= b; p += 28) pts.push(Array.from({ length: 7 }, (_, k) => dv.getFloat32(p + 4 * k, true))); paths.push(pts); } }
  const val = (t, raw, at) => {
    switch (t) {
      case 0xa0: return strs[raw];
      case 0xc0: case 0xc1: return node(raw);
      case 0xc3: return { path: paths[raw] };
      case 0xd0: return !!raw;
      case 0xd1: return dv.getInt32(at, true);
      case 0xd2: return dv.getFloat32(at, true);
      case 0xd3: return raw;
      case 0xff: return null;
      default: return null;
    }
  };
  const node = o => {
    const t = d[o], n = u32(o) >>> 8;
    if (t === 0xc0) { const base = o + 4 + ((n + 3) & ~3); return Array.from({ length: n }, (_, i) => val(d[o + 4 + i], u32(base + 4 * i), base + 4 * i)); }
    if (t === 0xc1) { const r = {}; for (let i = 0; i < n; i++) { const e = o + 4 + 8 * i; r[keys[u32(e) & 0xffffff]] = val(d[e + 3], u32(e + 4), e + 4); } return r; }
    throw new Error('BYML: unexpected node 0x' + t.toString(16));
  };
  return node(root);
}

// ---------------------------------------------------------------- KCL v2 (MK8): {pos: Float32Array (9 per triangle), attr: Uint16Array}
export function readKcl(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), u32 = o => dv.getUint32(o, true), f = o => dv.getFloat32(o, true);
  const mcount = u32(12), mofs = u32(8), pos = [], attr = [];
  for (let m = 0; m < mcount; m++) {
    const mo = u32(mofs + 4 * m), P = mo + u32(mo), N = mo + u32(mo + 4), R = mo + u32(mo + 8), O = mo + u32(mo + 12);
    const v = (base, i) => [f(base + 12 * i), f(base + 12 * i + 4), f(base + 12 * i + 8)];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (let p = R; p + 20 <= O; p += 20) {
      const len = f(p), A = v(P, dv.getUint16(p + 4, true)), fn = v(N, dv.getUint16(p + 6, true));
      const e1 = v(N, dv.getUint16(p + 8, true)), e2 = v(N, dv.getUint16(p + 10, true)), e3 = v(N, dv.getUint16(p + 12, true));
      const ca = cross(e1, fn), cb = cross(e2, fn), sb = len / dot(cb, e3), sa = len / dot(ca, e3);
      if (!isFinite(sa) || !isFinite(sb)) continue;
      pos.push(...A, A[0] + cb[0] * sb, A[1] + cb[1] * sb, A[2] + cb[2] * sb, A[0] + ca[0] * sa, A[1] + ca[1] * sa, A[2] + ca[2] * sa);
      attr.push(dv.getUint16(p + 14, true));
    }
  }
  return { pos: Float32Array.from(pos), attr: Uint16Array.from(attr) };
}

// ---------------------------------------------------------------- BFRES 0.5 (Switch) + its embedded BNTX
function half(h) { const s = h >> 15 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); }
// -> {shapes: [{name, mat, pos: Float32Array, nrm, uv, idx: Uint32Array}], mats: [{name, textures: [names], samplers: [names]}], bntx: Uint8Array|null}
export function readBfres5(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), dec = new TextDecoder();
  const u8 = o => d[o], u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true), f32 = o => dv.getFloat32(o, true), off = o => Number(dv.getBigUint64(o, true));
  const str = o => { if (!o) return ''; const n = u16(o); return dec.decode(d.subarray(o + 2, o + 2 + n)); };
  const tag = o => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
  if (tag(0) !== 'FRES') throw new Error('not a BFRES file');
  const base = u32(off(0x90) + 8);                // buffer memory: vertex and index data
  const m = off(0x28); if (tag(m) !== 'FMDL') throw new Error('BFRES: no model');
  const vbufs = off(m + 0x28), shapesA = off(m + 0x30), matsA = off(m + 0x40), nShape = u16(m + 0x6a), nMat = u16(m + 0x6c);
  // materials: texture names and the sampler each one is bound to (_a0 = albedo)
  const mats = [];
  for (let i = 0; i < nMat; i++) {
    const mt = matsA + 0xb8 * i, nTex = u8(mt + 0xa8), names = off(mt + 0x38), sd = off(mt + 0x50);
    const textures = Array.from({ length: nTex }, (_, k) => str(off(names + 8 * k)));
    const samplers = []; if (sd) { const n = u32(sd + 4); for (let k = 1; k <= n; k++) samplers.push(str(off(sd + 8 + 16 * k + 8))); }
    mats.push({ name: str(off(mt + 0x10)), textures, samplers });
  }
  const attrVal = (o, fmt, n) => {
    const ty = fmt & 0xff, kind = fmt >>> 8, out = [0, 0, 0];
    if (kind === 0x0e) { const v = u32(o); for (let i = 0; i < 3; i++) { const x = (v >>> (10 * i)) & 0x3ff; out[i] = ty === 2 ? Math.max(((x << 22) >> 22) / 511, -1) : x / 1023; } return out; }
    const spec = { 0x02: [1, 8], 0x09: [2, 8], 0x0b: [4, 8], 0x0a: [1, 16], 0x12: [2, 16], 0x15: [4, 16], 0x14: [1, 32], 0x17: [2, 32], 0x18: [3, 32], 0x19: [4, 32] }[kind];
    if (!spec) return out;
    const [count, bits] = spec;
    for (let i = 0; i < Math.min(count, n); i++) {
      const p = o + i * bits / 8;
      out[i] = bits === 8 ? (ty === 1 ? u8(p) / 255 : ty === 2 ? Math.max(dv.getInt8(p) / 127, -1) : u8(p))
        : bits === 16 ? (ty === 1 ? u16(p) / 65535 : ty === 2 ? Math.max(dv.getInt16(p, true) / 32767, -1) : ty === 5 ? half(u16(p)) : u16(p))
        : (ty === 5 ? f32(p) : u32(p));
    }
    return out;
  };
  const shapes = [];
  for (let s = 0; s < nShape; s++) {
    const sh = shapesA + 0x70 * s; if (tag(sh) !== 'FSHP') throw new Error('BFRES: bad shape');
    const name = str(off(sh + 0x10)), fv = off(sh + 0x18), mesh = off(sh + 0x20), mat = u16(sh + 0x5e);
    // vertex buffers: one after another from the vertex buffer's offset, each 8-aligned
    const nAttr = u8(fv + 0x54), nBuf = u8(fv + 0x55), nVert = u32(fv + 0x58), attrs = off(fv + 0x10), sizes = off(fv + 0x38), strides = off(fv + 0x40);
    const bufAt = []; let at = base + u32(fv + 0x50);
    for (let b = 0; b < nBuf; b++) { bufAt.push(at); at += (u32(sizes + 0x10 * b) + 7) & ~7; }
    const A = {}; for (let a = 0; a < nAttr; a++) { const e = attrs + 0x10 * a; A[str(off(e))] = { fmt: u32(e + 8), o: u16(e + 12), b: u16(e + 14) }; }
    const read = (key, n) => { const a = A[key]; if (!a) return null; const st = u32(strides + 0x10 * a.b), out = new Float32Array(nVert * n);
      for (let v = 0; v < nVert; v++) { const x = attrVal(bufAt[a.b] + v * st + a.o, a.fmt, n); for (let k = 0; k < n; k++) out[v * n + k] = x[k]; } return out; };
    const pos = read('_p0', 3); if (!pos) continue;
    const nrm = read('_n0', 3), uv = read('_u0', 2);
    // the most detailed mesh (LOD 0)
    const prim = u32(mesh + 0x24), ifmt = u32(mesh + 0x28), count = u32(mesh + 0x2c), first = u32(mesh + 0x30), io = base + u32(mesh + 0x20);
    if (prim !== 3) continue;
    const idx = new Uint32Array(count);
    for (let i = 0; i < count; i++) idx[i] = first + (ifmt === 2 ? u32(io + 4 * i) : ifmt === 1 ? u16(io + 2 * i) : u8(io + i));
    shapes.push({ name, mat, pos, nrm, uv, idx });
  }
  // embedded texture container
  let bntx = null; for (let i = 0; i + 4 < d.length; i += 8) if (d[i] === 0x42 && d[i + 1] === 0x4e && d[i + 2] === 0x54 && d[i + 3] === 0x58) { bntx = d.subarray(i, i + u32(i + 0x1c)); break; }
  return { shapes, mats, bntx };
}

// ---------------------------------------------------------------- BNTX with many textures (BC1-BC5, RGBA8)
export function bntxList(t) {
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength), u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true), off = o => Number(dv.getBigUint64(o, true));
  const n = u32(0x24), arr = off(0x28), orin = String.fromCharCode(...t.subarray(0x20, 0x24)) === 'Ounc', dec = new TextDecoder(), list = new Map();
  for (let i = 0; i < n; i++) {
    const p = off(arr + 8 * i), nm = off(p + 0x60), mips = Math.max(1, u16(p + 0x16)), mt = off(p + 0x70);
    list.set(dec.decode(t.subarray(nm + 2, nm + 2 + u16(nm))), { p, orin, format: u32(p + 0x1c), width: u32(p + 0x24), height: u32(p + 0x28), bhl: u32(p + 0x34) & 7, dataSize: u32(p + 0x50), mips, mipOffsets: Array.from({ length: mips }, (_, k) => off(mt + 8 * k)) });
  }
  return list;
}
const c565 = v => [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
function bc1(b, o, out, w, h, x0, y0, alpha) {
  const c0 = b[o] | b[o + 1] << 8, c1 = b[o + 2] | b[o + 3] << 8, A = c565(c0), B = c565(c1);
  const pal = [A, B, c0 > c1 || !alpha ? A.map((v, i) => (2 * v + B[i]) / 3) : A.map((v, i) => (v + B[i]) / 2), c0 > c1 || !alpha ? A.map((v, i) => (v + 2 * B[i]) / 3) : [0, 0, 0]];
  const bits = b[o + 4] | b[o + 5] << 8 | b[o + 6] << 16 | b[o + 7] << 24;
  for (let k = 0; k < 16; k++) { const x = x0 + (k & 3), y = y0 + (k >> 2); if (x >= w || y >= h) continue; const s = (bits >>> (2 * k)) & 3, q = (y * w + x) * 4; out[q] = pal[s][0]; out[q + 1] = pal[s][1]; out[q + 2] = pal[s][2]; if (alpha) out[q + 3] = c0 <= c1 && s === 3 ? 0 : 255; }
}
function bc4(b, o) {   // -> 16 values
  const a0 = b[o], a1 = b[o + 1], pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7); else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5); pal.push(0, 255); }
  let lo = b[o + 2] | b[o + 3] << 8 | b[o + 4] << 16, hi = b[o + 5] | b[o + 6] << 8 | b[o + 7] << 16; const r = [];
  for (let k = 0; k < 16; k++) { const v = k < 8 ? (lo >> (3 * k)) & 7 : (hi >> (3 * (k - 8))) & 7; r.push(pal[v]); }
  return r;
}
// one texture -> {w, h, rgba} at the first mip no bigger than maxSize
export function bntxDecode(t, info, maxSize = 512) {
  const kind = info.format >> 8;
  let l = 0; while (l + 1 < info.mips && Math.max(info.width >> l, info.height >> l) > maxSize) l++;
  const w = Math.max(1, info.width >> l), h = Math.max(1, info.height >> l), out = new Uint8Array(w * h * 4).fill(255);
  const start = info.mipOffsets[l], end = l + 1 < info.mips ? info.mipOffsets[l + 1] : info.mipOffsets[0] + info.dataSize;
  if (kind === 0x0b) {   // RGBA8
    const lin = untile(t.subarray(start, end), w * 4, h, info.bhl, info.orin); out.set(lin.subarray(0, out.length)); return { w, h, rgba: out };
  }
  const bpb = kind === 0x1a || kind === 0x1d ? 8 : 16; if (![0x1a, 0x1b, 0x1c, 0x1d, 0x1e].includes(kind)) return null;
  const bx = Math.ceil(w / 4), by = Math.ceil(h / 4), lin = untile(t.subarray(start, end), bx * bpb, by, info.bhl, info.orin);
  for (let y = 0; y < by; y++) for (let x = 0; x < bx; x++) {
    const o = (y * bx + x) * bpb, x0 = x * 4, y0 = y * 4;
    if (kind === 0x1a) bc1(lin, o, out, w, h, x0, y0, true);
    else if (kind === 0x1b || kind === 0x1c) {
      bc1(lin, o + 8, out, w, h, x0, y0, false);
      const a = kind === 0x1c ? bc4(lin, o) : Array.from({ length: 16 }, (_, k) => ((lin[o + (k >> 1)] >> (4 * (k & 1))) & 15) * 17);
      for (let k = 0; k < 16; k++) { const xx = x0 + (k & 3), yy = y0 + (k >> 2); if (xx < w && yy < h) out[(yy * w + xx) * 4 + 3] = a[k]; }
    } else {
      const r = bc4(lin, o), g = kind === 0x1e ? bc4(lin, o + 8) : r;
      for (let k = 0; k < 16; k++) { const xx = x0 + (k & 3), yy = y0 + (k >> 2); if (xx >= w || yy >= h) continue; const q = (yy * w + xx) * 4; out[q] = r[k]; out[q + 1] = kind === 0x1e ? g[k] : r[k]; out[q + 2] = kind === 0x1e ? 255 : r[k]; }
    }
  }
  return { w, h, rgba: out };
}

// A long thin texture (MK8 has lots: road strips 5:1, building strips 4:1) is made square by repeating it along its
// short side, and the model's UVs are shrunk to match. The game only takes square textures, and squashing a strip into a
// square makes it go blurry a short way ahead (the GPU picks the smaller copies sooner along the stretched direction).
function squareUp(im) {
  const { w, h } = im; if (w === h) return { ...im, su: 1, sv: 1 };
  // k copies along the short side, each squeezed or stretched a little so that they fill the square exactly
  const L = Math.max(w, h), k = Math.max(1, Math.round(L / Math.min(w, h))), out = new Uint8Array(L * L * 4), wide = w > h;
  for (let y = 0; y < L; y++) for (let x = 0; x < L; x++) {
    const sx = wide ? x : Math.min(w - 1, Math.floor(((x * k) % L) * w / L)), sy = wide ? Math.min(h - 1, Math.floor(((y * k) % L) * h / L)) : y;
    const q = (sy * w + sx) * 4, o = (y * L + x) * 4; out[o] = im.rgba[q]; out[o + 1] = im.rgba[q + 1]; out[o + 2] = im.rgba[q + 2]; out[o + 3] = im.rgba[q + 3];
  }
  return { w: L, h: L, rgba: out, su: wide ? 1 : 1 / k, sv: wide ? 1 / k : 1 };
}
// ---------------------------------------------------------------- MK8DX course -> Track Creator material
export const MK8_SCALE = 0.1;   // MK8 units are 10 cm (coins 2.5 m apart, item boxes ~4.5 m, the Stadium's start straight ~37 m wide)
// KCL type (low 5 bits) and variant (next 3) -> the Track Creator's collision brush. Worked out on Mario Kart Stadium
// by matching each type with the model's materials around it (dash/glide/gravity panels, grass, sand, walls...)
export function mk8Surface(attr) {
  const t = attr & 31, v = (attr >> 5) & 7;
  if (t <= 3) return 'road_asphalt';
  if (t === 4) return 'ice';
  if (t === 5) return 'sand';
  if (t === 6) return v === 0 ? 'sand' : 'light_offroad';   // sand / the lawn along the road's edges
  if (t === 7 || t === 8) return 'heavy_offroad';
  if (t === 9) return 'ice';
  if (t === 10) return 'boost';
  if (t === 11) return 'road_asphalt';   // anti-gravity panel: plain road (MKW's gravity comes from the gravity paths)
  if (t === 12) return 'glide';
  if (t === 13 || t === 14) return 'road_asphalt';
  if (t === 15) return 'wall_concrete';
  if (t === 16) return 'grass';         // offroad (the big grass areas; some of it is right next to the road)
  if (t >= 17 && t <= 22) return 'wall_concrete';
  if (t === 23 || t === 24) return 'invisible_wall';
  if (t === 28 || t === 29) return 'fall';
  if (t === 31) return v === 0 ? 'glide' : 'grass';
  return 'road_asphalt';
}
const V3 = o => [o.X, o.Y, o.Z];
const yawTo = (a, b) => Math.atan2(b[0] - a[0], b[2] - a[2]);
// paths: MK8 graphs (groups of points; a point's NextPt can join any point of another group). The lap path and CPU
// route are followed from the start through NextPt[0] until they come back round, as one loop.
function loopFrom(groups, g0, p0) {
  const out = [], seen = new Set(); let g = g0, p = p0;
  while (!seen.has(g + '/' + p) && groups[g] && groups[g].PathPt[p]) {
    seen.add(g + '/' + p); const pt = groups[g].PathPt[p]; out.push(pt);
    const n = (pt.NextPt || [])[0]; if (!n) break; g = n.PathId; p = n.PtId;
  }
  return out;
}
// -> {visual: {obj, mtl, images: [{name, w, h, rgba}]}, collision: {obj}, qc, start, stats}
// files: {model, kcl, muunt} as Uint8Arrays (the .szs files can still be Yaz0-compressed)
export function convertMk8(files, opt = {}) {
  const S = MK8_SCALE, mu = byml1(yaz0(files.muunt));
  // the start: the "Start" object (ObjId 6003), else the lap path's first point
  const startObj = (mu.Obj || []).find(o => o.ObjId === 6003);
  const lapLoop = mu.LapPath?.length ? loopFrom(mu.LapPath, 0, 0) : [];
  const o0 = startObj ? V3(startObj.Translate) : lapLoop[0] ? V3(lapLoop[0].Translate) : [0, 0, 0];
  const T = p => [Math.fround((p[0] - o0[0]) * S), Math.fround((p[1] - o0[1]) * S), Math.fround((p[2] - o0[2]) * S)];
  const R = o => [o.X, o.Y, o.Z].map(Math.fround);
  // ---- collision
  const k = readKcl(yaz0(files.kcl)), byS = new Map();
  for (let i = 0; i < k.attr.length; i++) { const s = mk8Surface(k.attr[i]); if (!byS.has(s)) byS.set(s, []); byS.get(s).push(i); }
  let col = '# Mario Kart 8 Deluxe collision, converted\n', vi = 1;
  const kp = i => T([k.pos[i], k.pos[i + 1], k.pos[i + 2]]);
  for (const [s, list] of byS) {
    col += `o ${s}\nusemtl ${s}\n`;
    for (const i of list) { for (let c = 0; c < 3; c++) { const p = kp(9 * i + 3 * c); col += `v ${p[0].toFixed(3)} ${p[1].toFixed(3)} ${p[2].toFixed(3)}\n`; } col += `f ${vi} ${vi + 1} ${vi + 2}\n`; vi += 3; }
  }
  // road height under a point (for the start grid)
  const roadTris = []; for (let i = 0; i < k.attr.length; i++) if (/^road/.test(mk8Surface(k.attr[i]))) roadTris.push(i);
  const groundAt = (x, z, y0) => { let best = null;
    for (const i of roadTris) { const a = kp(9 * i), b = kp(9 * i + 3), c = kp(9 * i + 6);
      const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]); if (Math.abs(d) < 1e-9) continue;
      const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue; const y = l1 * a[1] + l2 * b[1] + l3 * c[1]; if (best === null || Math.abs(y - y0) < Math.abs(best - y0)) best = y; }
    return best; };
  // ---- visual model
  const bf = readBfres5(yaz0(files.model)), texList = bf.bntx ? bntxList(bf.bntx) : new Map(), images = [], imgOf = new Map();
  const skip = n => /StaticShadow|Shadow$|_nuki_?shadow/i.test(n);
  let obj = '# Mario Kart 8 Deluxe course model, converted\nmtllib course.mtl\n', mtl = '', v = 1; const matsUsed = new Set(), uvScale = new Map();
  for (const s of bf.shapes) {
    const m = bf.mats[s.mat]; if (!m || skip(m.name)) continue;
    if (!matsUsed.has(m.name)) {
      matsUsed.add(m.name); mtl += `newmtl ${m.name}\nKd 1 1 1\n`;
      const ai = m.samplers.indexOf('_a0'), tname = ai >= 0 ? m.textures[ai] : m.textures.find(t => /_Alb/.test(t));
      if (tname && texList.has(tname)) {
        if (!imgOf.has(tname)) { const im = bntxDecode(bf.bntx, texList.get(tname), opt.texSize || 1024); if (im) { const sq = squareUp(im); images.push({ name: tname + '.png', w: sq.w, h: sq.h, rgba: sq.rgba }); imgOf.set(tname, { file: tname + '.png', su: sq.su, sv: sq.sv }); } }
        if (imgOf.has(tname)) { mtl += `map_Kd ${imgOf.get(tname).file}\n`; uvScale.set(m.name, imgOf.get(tname)); }
      }
    }
    obj += `o ${s.name}\nusemtl ${m.name}\n`;
    const n = s.pos.length / 3;
    for (let i = 0; i < n; i++) { const p = T([s.pos[3 * i], s.pos[3 * i + 1], s.pos[3 * i + 2]]); obj += `v ${p[0].toFixed(3)} ${p[1].toFixed(3)} ${p[2].toFixed(3)}\n`; }
    const us = uvScale.get(m.name) || { su: 1, sv: 1 };
    for (let i = 0; i < n; i++) obj += s.uv ? `vt ${(s.uv[2 * i] * us.su).toFixed(5)} ${(1 - s.uv[2 * i + 1] * us.sv).toFixed(5)}\n` : 'vt 0 0\n';
    for (let i = 0; i < n; i++) obj += s.nrm ? `vn ${s.nrm[3 * i].toFixed(4)} ${s.nrm[3 * i + 1].toFixed(4)} ${s.nrm[3 * i + 2].toFixed(4)}\n` : 'vn 0 1 0\n';
    for (let i = 0; i + 2 < s.idx.length; i += 3) { const a = s.idx[i] + v, b = s.idx[i + 1] + v, c = s.idx[i + 2] + v; obj += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`; }
    v += n;
  }
  // ---- paths and objects
  const lap = lapLoop.map((p, i) => { const pos = T(V3(p.Translate)), nx = T(V3(lapLoop[(i + 1) % lapLoop.length].Translate));
    return { pos, yaw: Math.fround(yawTo(pos, nx)), rot: R(p.Rotate), w: Math.round(Math.min(80, Math.max(12, p.Scale.X * S * 0.7)) * 10) / 10, h: Math.round(Math.min(80, Math.max(20, (p.Scale.Y || 0) * S))), start: i === 0, cp: p.CheckPoint >= 0 }; });
  // the CPU route: the group that loops back on itself, else the biggest
  const eg = mu.EnemyPath || []; let main = eg.findIndex((g, i) => g.PathPt.at(-1)?.NextPt?.some(n => n.PathId === i));
  if (main < 0) main = eg.reduce((b, g, i) => g.PathPt.length > (eg[b]?.PathPt.length || 0) ? i : b, 0);
  const enemy = eg.length ? loopFrom(eg, main, 0) : [];
  const route = enemy.map((p, i) => { const pos = T(V3(p.Translate)), nx = T(V3(enemy[(i + 1) % enemy.length].Translate)); return { pos, yaw: Math.fround(yawTo(pos, nx)), w: 10 }; });
  const rail = (g, keepRot) => g.PathPt.map((p, i, a) => { const pos = T(V3(p.Translate)), nx = a[i + 1] ? T(V3(a[i + 1].Translate)) : a[i - 1] ? pos.map((x, j) => 2 * x - T(V3(a[i - 1].Translate))[j]) : pos;
    const n = { pos, yaw: Math.fround(yawTo(pos, nx)), rs: [Math.fround(Math.max(4, p.Scale.X * S)), Math.fround(Math.max(4, (p.Scale.Y || p.Scale.X) * S))], ro: [0, 0] };
    if (keepRot) n.rot = R(p.Rotate); return n; });
  const glides = (mu.GlidePath || []).filter(g => g.PathPt.length >= 2).map(g => rail(g, false));
  const gravity = (mu.GravityPath || []).filter(g => g.PathPt.length >= 2).map(g => rail(g, true));
  const gcam = (mu.GCameraPath || []).filter(g => g.PathPt.length >= 2).map(g => rail(g, true));
  const objs = mu.Obj || [], at = o => T(V3(o.Translate));
  const items = objs.filter(o => o.ObjId === 1013).map(o => ({ pos: at(o), yaw: Math.fround(o.Rotate.Y) }));
  const coins = objs.filter(o => o.ObjId === 1018).map(o => ({ name: 'CmnObj_Coin000_A_00', pos: at(o), yaw: Math.fround(o.Rotate.Y) }));
  // start grid: 4 across, rows 9 m apart, behind the start line (like Quick Create's)
  const sy = startObj ? startObj.Rotate.Y : lap[0]?.yaw || 0, f = [Math.sin(sy), 0, Math.cos(sy)], side = [Math.cos(sy), 0, -Math.sin(sy)];
  const width = Math.min(lap[0]?.w || 30, 40), starts = [];
  for (let i = 0; i < 24; i++) { const col = i % 4, row = Math.floor(i / 4), back = 6 + row * 9 + col * 2.2, off = (col - 1.5) * width * 0.18;
    const x = -f[0] * back + side[0] * off, z = -f[2] * back + side[2] * off, y = groundAt(x, z, 0);
    starts.push({ pos: [x, (y ?? 0) + 0.1, z].map(Math.fround), yaw: Math.fround(sy), id: i }); }
  const qc = { closed: true, width: Math.round(width * 10) / 10, routePct: 40, lap, routes: route.length ? [route] : [], items, starts, deco: coins, fenceCol: [], glides, gravity, gcam, mk8: true };
  return { visual: { obj, mtl, images }, collision: { obj: col }, qc, stats: { tris: bf.shapes.reduce((a, s) => a + s.idx.length / 3, 0), colTris: k.attr.length, surfaces: Object.fromEntries([...byS].map(([s, l]) => [s, l.length])), textures: images.length, lap: lap.length, route: route.length, items: items.length, coins: coins.length, glides: glides.length, gravity: gravity.length } };
}
