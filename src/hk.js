// Havok (Phive) collision writer for Mario Kart World: builds a standalone .bphsh (hknpMeshShape) from triangles.
// Port of the tested Python tools (bphsh.py / meshenc.py / inplace.py).

const FMAX = new Float32Array(new Uint32Array([0x7f7fffee]).buffer)[0];
const be32 = (d, o) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
const ascii = (d, a, b) => String.fromCharCode(...d.subarray(a, b));
// Python's round(): halves go to the even neighbour
export const roundEven = x => { const f = Math.floor(x), r = x - f; if (r > 0.5) return f + 1; if (r < 0.5) return f; return f % 2 === 0 ? f : f + 1; };

// ---------------------------------------------------------------- tagfile reading (just what the writer needs)
function subs(d, start) {
  const size = be32(d, start) & 0x3fffffff, out = {}; let p = start + 8;
  while (p < start + size) { const sz = be32(d, p) & 0x3fffffff; out[ascii(d, p + 4, p + 8)] = [p + 8, p + sz]; p += sz; }
  return [out, start + size];
}
function readTag(d, start) {
  const [S, end] = subs(d, start);
  const [I] = subs(d, S.INDX[0] - 8), [TY] = subs(d, S.TYPE[0] - 8);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const items = []; for (let p = I.ITEM[0]; p < I.ITEM[1]; p += 12) items.push([dv.getUint32(p, true), dv.getUint32(p + 4, true), dv.getUint32(p + 8, true)]);
  const strs = ascii(d, TY.TST1[0], TY.TST1[1]).split('\0');
  let p = TY.TNA1[0];
  const vi = () => { const b = d[p];
    if (!(b & 0x80)) { p += 1; return b; }
    if (!(b & 0x40)) { const v = ((b & 0x3f) << 8) | d[p + 1]; p += 2; return v; }
    if (!(b & 0x20)) { const v = ((b & 0x1f) << 16) | (d[p + 1] << 8) | d[p + 2]; p += 3; return v; }
    if (!(b & 0x10)) { const v = ((b & 0x0f) * 0x1000000) + ((d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]); p += 4; return v; }
    const v = (b & 7) * 2 ** 32 + ((d[p + 1] << 24) >>> 0) + ((d[p + 2] << 16) | (d[p + 3] << 8) | d[p + 4]); p += 5; return v; };
  const n = vi(), names = [null];
  for (let i = 1; i < n; i++) { const ni = vi(), tc = vi(); for (let k = 0; k < tc; k++) { vi(); vi(); } names.push(strs[ni]); }
  return { S, end, items, names, D0: S.DATA[0] };
}

// ---------------------------------------------------------------- byte buffer with absolute offsets
class Blob {
  constructor(base) { this.base = base; this.b = new Uint8Array(1 << 16); this.n = 0; }
  grow(n) { if (n <= this.b.length) return; let c = this.b.length; while (c < n) c *= 2; const nb = new Uint8Array(c); nb.set(this.b.subarray(0, this.n)); this.b = nb; }
  alloc(n, a = 16) { while ((this.base + this.n) % a) this.n++; const p = this.base + this.n; this.grow(this.n + n); this.n += n; return p; }
  get dv() { return new DataView(this.b.buffer); }
  i32(p, v) { this.dv.setInt32(p - this.base, v, true); }
  u32(p, v) { this.dv.setUint32(p - this.base, v >>> 0, true); }
  i64(p, v) { this.dv.setBigInt64(p - this.base, BigInt(v), true); }
  u16(p, v) { this.dv.setUint16(p - this.base, v, true); }
  i16(p, v) { this.dv.setInt16(p - this.base, v, true); }
  f32(p, v) { this.dv.setFloat32(p - this.base, v, true); }
  u8(p, v) { this.b[p - this.base] = v; }
  raw(p, data) { this.b.set(data, p - this.base); }
  bytes() { return this.b.slice(0, this.n); }
}

// ---------------------------------------------------------------- mesh encoding
function splitBig(tris, maxext = 100) {
  const out = [], stack = tris.slice();
  while (stack.length) {
    const [t, tag] = stack.pop();
    let ext = 0; for (let a = 0; a < 3; a++) ext = Math.max(ext, Math.max(t[0][a], t[1][a], t[2][a]) - Math.min(t[0][a], t[1][a], t[2][a]));
    if (ext <= maxext) { out.push([t, tag]); continue; }
    let best = -1, bi = 0;
    for (let i = 0; i < 3; i++) { let l = 0; for (let a = 0; a < 3; a++) l += (t[i][a] - t[(i + 1) % 3][a]) ** 2; if (l >= best) { best = l; bi = i; } }
    const a = t[bi], b = t[(bi + 1) % 3], c = t[(bi + 2) % 3], m = [0, 1, 2].map(k => (a[k] + b[k]) / 2);
    stack.push([[a, m, c], tag]); stack.push([[m, b, c], tag]);
  }
  return out;
}
function mortonSort(tris) {
  const cs = tris.map(([t]) => [0, 1, 2].map(a => (t[0][a] + t[1][a] + t[2][a]) / 3));
  const mn = [0, 1, 2].map(a => Math.min(...cs.map(c => c[a]))), mx = [0, 1, 2].map(a => Math.max(...cs.map(c => c[a])));
  const key = c => { const q = [0, 1, 2].map(a => Math.trunc((c[a] - mn[a]) / ((mx[a] - mn[a]) || 1) * 1023)); let k = 0n;
    for (let bit = 0; bit < 10; bit++) for (const a of [0, 2, 1]) k = (k << 1n) | BigInt((q[a] >> (9 - bit)) & 1); return k; };
  const keys = cs.map(key);
  return tris.map((t, i) => i).sort((i, j) => keys[i] < keys[j] ? -1 : keys[i] > keys[j] ? 1 : 0).map(i => tris[i]);
}
function argmaxFirst(a) { let b = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[b]) b = i; return b; }

// top-level 4-wide float tree over sections
function buildSimdTree(boxes) {
  const nodes = [null];
  const mk = (items, parent) => {
    const idx = nodes.length; nodes.push(null);
    if (items.length <= 4 && parent !== 0) { nodes[idx] = { leaf: true, data: items, parent, depth: 1, num: items.length }; return [idx, 1, items.length]; }
    let groups;
    if (items.length <= 4) groups = [items];
    else {
      const ext = [0, 1, 2].map(a => Math.max(...items.map(i => boxes[i][1][a])) - Math.min(...items.map(i => boxes[i][0][a])));
      const ax = argmaxFirst(ext), srt = items.slice().sort((i, j) => (boxes[i][0][ax] + boxes[i][1][ax]) - (boxes[j][0][ax] + boxes[j][1][ax]));
      let cap = 4; while (cap * 4 < srt.length) cap *= 4;
      groups = []; for (let k = 0; k < srt.length; k += cap) groups.push(srt.slice(k, k + cap));
    }
    nodes[idx] = { leaf: false, data: null, parent };
    const kids = []; let dep = 0, num = 0;
    for (const g of groups) { const [ci, dd, nn] = mk(g, idx); kids.push([ci, g]); dep = Math.max(dep, dd); num += nn; }
    Object.assign(nodes[idx], { data: kids.map(k => k[0]), groups: kids.map(k => k[1]), depth: dep + 1, num });
    return [idx, dep + 1, num];
  };
  mk(boxes.map((_, i) => i), 0);
  return nodes;
}
function writeSimdNodes(blob, p, nodes, boxes) {
  const gbox = items => [[0, 1, 2].map(a => Math.min(...items.map(i => boxes[i][0][a]))), [0, 1, 2].map(a => Math.max(...items.map(i => boxes[i][1][a])))];
  nodes.forEach((nd, n) => {
    const q = p + 128 * n;
    let lanes = [];
    if (nd) lanes = nd.leaf ? nd.data.map(i => [boxes[i], i]) : nd.data.map((c, k) => [gbox(nd.groups[k]), c]);
    for (let a = 0; a < 3; a++) for (let l = 0; l < 4; l++) {
      const lo = l < lanes.length ? lanes[l][0][0][a] : FMAX, hi = l < lanes.length ? lanes[l][0][1][a] : -FMAX;
      blob.f32(q + 0x20 * a + 4 * l, lo); blob.f32(q + 0x20 * a + 0x10 + 4 * l, hi);
    }
    if (!nd) return;
    const fill = nd.leaf ? 0xFFFFFFFF : 0;
    for (let l = 0; l < 4; l++) blob.u32(q + 96 + 4 * l, l < lanes.length ? lanes[l][1] : fill);
    blob.u8(q + 116, nd.leaf ? 1 : 0); blob.u8(q + 117, nd.depth); blob.u32(q + 120, nd.parent); blob.u32(q + 124, nd.num);
  });
}
// per-section 8-bit tree: preorder, root always internal, leaves hold <=4 primitives
function leafOrder(items) { const o = items.slice().sort((a, b) => a - b); return o.length === 4 ? [o[0], o[1], o[3], o[2]] : o; }
function buildBvh8(boxes) {
  const nodes = [];
  const cen = (i, a) => boxes[i][a][0] + boxes[i][a][1];
  const ubox = items => [0, 1, 2].map(a => [Math.min(...items.map(i => boxes[i][a][0])), Math.max(...items.map(i => boxes[i][a][1]))]);
  const split = items => {
    if (items.length <= 4) return items.map(i => [i]);
    const ext = [0, 1, 2].map(a => Math.max(...items.map(i => cen(i, a))) - Math.min(...items.map(i => cen(i, a))));
    const ax = argmaxFirst(ext), s = items.slice().sort((i, j) => cen(i, ax) - cen(j, ax));
    let cap = 4; while (cap * 4 < s.length) cap *= 4;
    const groups = []; for (let k = 0; k < s.length; k += cap) groups.push(s.slice(k, k + cap));
    while (groups.length > 4) { groups[groups.length - 2].push(...groups.pop()); }
    return groups;
  };
  const mk = (items, root) => {
    const idx = nodes.length; nodes.push(null);
    if (items.length <= 4 && !root) { nodes[idx] = ['L', leafOrder(items).map(i => [ubox([i]), i])]; return idx; }
    let groups;
    if (items.length <= 4) groups = [items];
    else { groups = split(items); if (groups.every(g => g.length === 1)) groups = [items]; }
    const lanes = []; nodes[idx] = ['I', lanes];
    for (const g of groups) { const c = mk(g, false); lanes.push([ubox(g), c]); }
    return idx;
  };
  mk(boxes.map((_, i) => i), true);
  if (nodes.length > 255) throw new Error('collision section tree too big');
  const out = new Uint8Array(28 * nodes.length);
  nodes.forEach(([kind, lanes], n) => {
    const o = 28 * n;
    for (let l = 0; l < 4; l++) {
      if (l < lanes.length) { const [b, dat] = lanes[l]; for (let a = 0; a < 3; a++) { out[o + 8 * a + l] = b[a][0]; out[o + 8 * a + 4 + l] = b[a][1]; } out[o + 24 + l] = dat; }
      else { for (let a = 0; a < 3; a++) { out[o + 8 * a + l] = 255; out[o + 8 * a + 4 + l] = 0; } out[o + 24 + l] = kind === 'I' ? lanes[lanes.length - 1][1] : [0, 0, 1, 0][l]; }
    }
  });
  return [out, nodes.length];
}

function encodeMesh(blob, tris, headerSrc, items, TI, opt) {
  tris = mortonSort(splitBig(tris));
  const secs = []; let cur = [], cmn = null, cmx = null;
  for (const t of tris) {
    const tmn = [0, 1, 2].map(a => Math.min(t[0][0][a], t[0][1][a], t[0][2][a])), tmx = [0, 1, 2].map(a => Math.max(t[0][0][a], t[0][1][a], t[0][2][a]));
    if (cur.length) {
      const nmn = [0, 1, 2].map(a => Math.min(cmn[a], tmn[a])), nmx = [0, 1, 2].map(a => Math.max(cmx[a], tmx[a]));
      if (cur.length < 4 && Math.max(...[0, 1, 2].map(a => nmx[a] - nmn[a])) <= 120) { cur.push(t); cmn = nmn; cmx = nmx; continue; }
      secs.push(cur);
    }
    cur = [t]; cmn = tmn; cmx = tmx;
  }
  if (cur.length) secs.push(cur);
  const ns = secs.length;
  const ms = blob.alloc(160); items.push([0x10, TI.mesh, ms, 1]);
  blob.raw(ms, headerSrc.subarray(0, 0x70));
  blob.u8(ms + 0x1c, 9 + Math.max(0, (ns - 1).toString(2).length * (ns > 1 ? 1 : 0)));
  const ent = [];
  secs.forEach((s, si) => s.forEach(([, tag], pi) => { const k = si * 512 + (pi << 1); if (!ent.length || ent[ent.length - 1][1] !== tag) ent.push([k, tag]); }));
  ent.push([ns * 512 + 510, 65535]);
  const tt = blob.alloc(8 * ent.length, 4); items.push([0x20, TI.tag, tt, ent.length]);
  ent.forEach(([k, tag], i) => { blob.u32(tt + 8 * i, k); blob.u16(tt + 8 * i + 4, tag); });
  blob.i32(ms + 0x70, tt - (ms + 0x70)); blob.i32(ms + 0x74, ent.length);
  const gsp = blob.alloc(0x40 * ns); items.push([0x20, TI.sec, gsp, ns]);
  blob.i32(ms + 0x90, gsp - (ms + 0x90)); blob.i32(ms + 0x94, ns);
  const sboxes = [];
  secs.forEach((s, si) => {
    const g = gsp + 0x40 * si, vi = new Map(), V = [], P = [];
    for (const [t] of s) {
      const ids = t.map(v => { const q = [0, 1, 2].map(a => roundEven(v[a] * 512)), k = q.join(','); if (!vi.has(k)) { vi.set(k, V.length); V.push(q); } return vi.get(k); });
      P.push([ids[0], ids[1], ids[2], ids[2]]);
    }
    const off = [0, 1, 2].map(a => Math.min(...V.map(v => v[a])));
    for (const v of V) for (let a = 0; a < 3; a++) if (!(v[a] - off[a] >= 0 && v[a] - off[a] < 65536)) throw new Error('collision section too big');
    const lmn = off.map(o => o / 512), lmx = [0, 1, 2].map(a => Math.max(...V.map(v => v[a])) / 512);
    sboxes.push([lmn.map(x => x - opt.boxPad), lmx.map(x => x + opt.boxPad)]);
    const s8 = [], bo = [];
    for (let a = 0; a < 3; a++) {
      const ext = lmx[a] - lmn[a], big = Math.max(Math.abs(lmn[a]), Math.abs(lmx[a]));
      const sc = Math.max(ext / 248, big / 30000, opt.minScale); s8.push(sc); bo.push(Math.floor(lmn[a] / sc) - 1);
    }
    const f32 = x => Math.fround(x);
    const pboxes = P.map(([i0, i1, i2]) => [0, 1, 2].map(a => { const ws = [...new Set([i0, i1, i2])].map(i => V[i][a] / 512);
      return [Math.max(0, Math.min(255, Math.floor(Math.min(...ws) / s8[a]) - bo[a] - 1)), Math.max(0, Math.min(255, Math.ceil(Math.max(...ws) / s8[a]) - bo[a] + 1))]; }));
    const [nb, nn] = buildBvh8(pboxes);
    const bv = blob.alloc(28 * nn, 4); blob.raw(bv, nb); items.push([0x20, TI.node8, bv, nn]);
    const pr = blob.alloc(4 * P.length, 4); items.push([0x20, TI.prim, pr, P.length]);
    P.forEach((p, i) => p.forEach((x, k) => blob.u8(pr + 4 * i + k, x)));
    const vb = blob.alloc(6 * V.length, 2); items.push([0x20, TI.u8, vb, 6 * V.length]);
    V.forEach((v, i) => { for (let a = 0; a < 3; a++) blob.u16(vb + 6 * i + 2 * a, v[a] - off[a]); });
    const ninb = (2 * P.length + 7) >> 3;
    const ib = blob.alloc(ninb, 1); items.push([0x20, TI.u8, ib, ninb]);
    blob.i32(g, bv - g); blob.i32(g + 4, nn); blob.i32(g + 8, pr - (g + 8)); blob.i32(g + 12, P.length);
    blob.i32(g + 0x10, vb - (g + 0x10)); blob.i32(g + 0x14, 6 * V.length); blob.i32(g + 0x18, ib - (g + 0x18)); blob.i32(g + 0x1c, ninb);
    for (let a = 0; a < 3; a++) { blob.u32(g + 0x20 + 4 * a, off[a] >>> 0); blob.f32(g + 0x2c + 4 * a, f32(s8[a])); blob.i16(g + 0x38 + 2 * a, bo[a]); }
  });
  const nodes = buildSimdTree(sboxes);
  const tp = blob.alloc(128 * nodes.length); items.push([0x20, TI.simd, tp, nodes.length]);
  writeSimdNodes(blob, tp, nodes, sboxes);
  blob.i64(ms + 0x78, tp - (ms + 0x78)); blob.i32(ms + 0x80, nodes.length); blob.u32(ms + 0x84, 0); blob.u32(ms + 0x88, 0); blob.u32(ms + 0x8c, 1);
  blob.i64(ms + 0x98, 0);
  const mn = [0, 1, 2].map(a => Math.min(...sboxes.map(b => b[0][a]))), mx = [0, 1, 2].map(a => Math.max(...sboxes.map(b => b[1][a])));
  return { ms, mn, mx, sections: ns, tris: tris.length };
}

export const WORLD_FILTER = Uint8Array.from([0xff, 0xff, 0xff, 0x1f, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x07, 0, 0, 0, 0]);
// the game gives some materials a filter of their own (read from its courses' collision): Pole (30: grind rails, lamp posts,
// fence bars) and the step-marked road edge (mask 0x100)
export const POLE_FILTER = Uint8Array.from([0xfe, 0xff, 0xf7, 0x1f, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x07, 0, 0, 0, 0]);
export const STEP_FILTER = Uint8Array.from([0xf6, 0xff, 0xff, 0x1f, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x07, 0, 0, 0, 0]);
export const filterFor = ([m, , mask], dflt = WORLD_FILTER) => m === 30 ? POLE_FILTER : (Number(mask) & 0x100) ? STEP_FILTER : dflt;

/**
 * template: decompressed .bphsh of any mesh-shape object (CmnObj_ProvisionalPartsCentral000_A is the tested one)
 * tris: [[[v0,v1,v2], tagIndex]] (positions in the actor's space), mats: [[material, subMaterial, mask]] by tagIndex
 */
export function writeBphsh(template, tris, mats, opt = {}) {
  opt = { minScale: 0.004, boxPad: 0.05, filter: WORLD_FILTER, ...opt };
  const d = template, T = readTag(d, 0x30);
  const id = n => T.names.indexOf(n);
  const TI = { mesh: id('hknpMeshShape'), tag: id('hknpMeshShape::ShapeTagTableEntry'), sec: id('hknpMeshShape::GeometrySection'),
    node8: id('hknpAabb8TreeNode'), prim: id('hknpMeshShape::GeometrySection::Primitive'), u8: id('hkUint8'), simd: id('hkcdSimdTreeNamespace::Node') };
  const seen = new Set(T.items.slice(1).map(i => i[0] & 0xffffff));
  if (seen.size !== new Set(Object.values(TI)).size || ![...seen].every(x => Object.values(TI).includes(x))) throw new Error('unexpected collision template');
  const blob = new Blob(0), items = [];
  const r = encodeMesh(blob, tris, d.subarray(T.D0, T.D0 + 0xa0), items, TI, opt);
  while (blob.n % 16) blob.alloc(1, 1);
  const hdr = name => be32(d, T.S[name][0] - 8) & 0xc0000000;
  const sec = (tag, payload, flags) => { const o = new Uint8Array(8 + payload.length); new DataView(o.buffer).setUint32(0, (flags | (8 + payload.length)) >>> 0); for (let i = 0; i < 4; i++) o[4 + i] = tag.charCodeAt(i); o.set(payload, 8); return o; };
  const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const sdkv = d.subarray(T.S.SDKV[0], T.S.SDKV[1]), typ = d.subarray(T.S.TYPE[0] - 8, T.S.TYPE[1]);
  const [I] = subs(d, T.S.INDX[0] - 8), ihdr = be32(d, I.ITEM[0] - 8) & 0xc0000000;
  const itm = new Uint8Array(12 + 12 * items.length), iv = new DataView(itm.buffer);
  items.forEach(([f, t, o, c], i) => { iv.setUint32(12 + 12 * i, ((f << 24) | t) >>> 0, true); iv.setUint32(16 + 12 * i, o, true); iv.setUint32(20 + 12 * i, c, true); });
  const indx = sec('INDX', sec('ITEM', itm, ihdr), hdr('INDX'));
  const tag0flags = be32(d, 0x30) & 0xc0000000;
  let data = blob.bytes();
  const build = () => { const body = cat(sec('SDKV', sdkv, hdr('SDKV')), sec('DATA', data, hdr('DATA')), typ, indx); return sec('TAG0', body, tag0flags); };
  let tag0 = build();
  const pad = (16 - tag0.length % 16) % 16;
  if (pad) { data = cat(data, new Uint8Array(pad)); tag0 = build(); }
  const mt = new Uint8Array(16 * mats.length), mv = new DataView(mt.buffer);
  mats.forEach(([a, b, c], i) => { mv.setUint32(16 * i, a, true); mv.setUint32(16 * i + 4, b, true); mv.setBigUint64(16 * i + 8, BigInt(c), true); });
  const flt = new Uint8Array(16 * mats.length); mats.forEach((m, i) => flt.set(opt.filter === WORLD_FILTER ? filterFor(m) : opt.filter, 16 * i));
  const matOff = 0x30 + tag0.length, fOff = matOff + mt.length, end = fOff + flt.length;
  const head = new Uint8Array(0x30); head.set(d.subarray(0, 0x10));
  const hv = new DataView(head.buffer); [matOff, fOff, end, tag0.length, mt.length, flt.length, 0, 0].forEach((x, i) => hv.setUint32(0x10 + 4 * i, x, true));
  const out = cat(head, tag0, mt, flt);
  const T2 = readTag(out, 0x30); if (T2.end !== matOff || T2.items.length !== items.length + 1) throw new Error('collision self-check failed');
  return { bytes: out, min: r.mn, max: r.mx, sections: r.sections, tris: r.tris };
}
