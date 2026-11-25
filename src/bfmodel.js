// Write triangle geometry into a copy of CmnObj_ProvisionalPartsCentral000_A.bfres (same file size): one shape per
// material, every other shape collapsed. Port of the tested meshmodel.py, plus: LODs too small for the geometry
// reuse LOD 0's draw (so parts don't vanish in the distance).
import { roundEven } from './hk.js';

export const MAT = { asphalt: 10, floorparts: 8, floortile: 11, decomark: 7, frame: 9, wall03: 0, backside01: 2, watersedge: 4, framesparts: 5, backside00: 6, wall06: 1, wiremesh: 12, floorlight: 3 };

const f32buf = new Float32Array(1), u32buf = new Uint32Array(f32buf.buffer);
export function f2h(x) {           // float -> half, round to nearest even (like numpy)
  f32buf[0] = x; const b = u32buf[0], s = (b >>> 16) & 0x8000, e = (b >>> 23) & 0xff, m = b & 0x7fffff;
  if (e === 0xff) return s | 0x7c00 | (m ? 0x200 : 0);
  let E = e - 127 + 15;
  if (E >= 0x1f) return s | 0x7c00;
  if (E <= 0) {
    if (E < -10) return s;
    const mm = m | 0x800000, sh = 14 - E, half = 1 << (sh - 1), rest = mm & ((1 << sh) - 1);
    let r = mm >>> sh; if (rest > half || (rest === half && (r & 1))) r++;
    return s | r;
  }
  let r = (E << 10) | (m >>> 13); const rest = m & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (r & 1))) r++;
  return s | r;
}
const snorm10 = (v, w = 0) => { const q = v.map(c => Math.max(-511, Math.min(511, roundEven(c * 511))) & 0x3ff); return (q[0] | (q[1] << 10) | (q[2] << 20) | (w << 30)) >>> 0; };

/**
 * src: decompressed Central bfres. geom: {materialKey: [verts=[[pos,normal,uv]], tris=[[a,b,c]]]}
 * returns {bytes, report, capacity}
 */
// make room at the end of the file's GPU buffer (vertices and indices): the buffer is followed by the memory pool and
// the relocation table, so those move down and every pointer to them (and the table's own entries) follows
export function growBuffer(src, extra) {
  const sv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const u32 = o => sv.getUint32(o, true), u64 = o => Number(sv.getBigUint64(o, true));
  const bi = u64(0xb0), bstart = u64(bi + 8), bsize = u32(bi + 4), end = bstart + bsize;
  const delta = Math.ceil(extra / 0x1000) * 0x1000;
  const rlt = u32(0x18);
  if (String.fromCharCode(...src.subarray(rlt, rlt + 4)) !== '_RLT') throw new Error('model: no relocation table');
  const nsec = u32(rlt + 8), ent0 = rlt + 0x10 + 0x18 * nsec, ptrs = [];
  for (let k = 0; k < nsec; k++) {
    const so = rlt + 0x10 + 0x18 * k, first = u32(so + 0x10), cnt = u32(so + 0x14);
    for (let e = first; e < first + cnt; e++) {
      const eo = ent0 + 8 * e, at = u32(eo), structs = sv.getUint16(eo + 4, true), nptr = src[eo + 6], skip = src[eo + 7];
      let p = at; for (let s = 0; s < structs; s++) { for (let i = 0; i < nptr; i++) { ptrs.push(p); p += 8; } p += 8 * skip; }
    }
  }
  const d = new Uint8Array(src.length + delta); d.set(src.subarray(0, end)); d.set(src.subarray(end), end + delta);
  const dv = new DataView(d.buffer), mv = o => o >= end ? o + delta : o;
  for (const p of ptrs) { const v = u64(p); if (v) dv.setBigUint64(mv(p), BigInt(mv(v)), true); }
  dv.setUint32(0x18, rlt + delta, true); dv.setUint32(0x1c, d.length, true);
  dv.setUint32(bi + 4, bsize + delta, true);
  const r = rlt + delta; dv.setUint32(r + 4, r, true);
  for (let k = 0; k < nsec; k++) {
    const so = r + 0x10 + 0x18 * k, o = u32(rlt + 0x10 + 0x18 * k + 8), z = u32(rlt + 0x10 + 0x18 * k + 12);
    if (o >= end) dv.setUint32(so + 8, o + delta, true); else if (o < end && o + z === end) dv.setUint32(so + 12, z + delta, true);
  }
  for (let e = 0; e < (src.length - ent0) / 8; e++) { const eo = ent0 + 8 * e; if (eo + 8 > src.length) break; const at = u32(eo); if (at >= end) dv.setUint32(eo + delta, at + delta, true); }
  return { d, free: bsize, room: delta };
}

export function writeModel(src, geom, newname, opt = {}) {
  // geometry bigger than the template's buffers: grow the buffer and give those shapes new space at its end
  const need = (() => {
    const sv = new DataView(src.buffer, src.byteOffset, src.byteLength), u8 = o => src[o], u16 = o => sv.getUint16(o, true), u32 = o => sv.getUint32(o, true), off = o => Number(sv.getBigUint64(o, true));
    const m = off(0x28), shapes = off(m + 0x28), ns = u16(m + 0x6a), out = new Map();
    for (const [k, [V, TR]] of Object.entries(geom)) {
      const s = MAT[k]; if (s === undefined || s >= ns || !TR.length) continue;
      const sh = shapes + 0x60 * s, vb = off(sh + 0x10), nv = u32(vb + 0x50), me = off(sh + 0x18), cnt = u32(me + 0x2c), base = u32(me + 0x30);
      if (3 * TR.length <= cnt && base + V.length <= nv) continue;
      if (V.length > 65535) throw new Error('too many vertices in one material (' + V.length + '): the most is 65535');
      out.set(s, { vb: V.length * u32(off(vb + 0x38)), ib: 6 * TR.length });
    }
    return out;
  })();
  let d, room = 0, cursor = 0;
  if (need.size) { const extra = [...need.values()].reduce((a, n) => a + Math.ceil(n.vb / 256) * 256 + Math.ceil(n.ib / 256) * 256, 0); const g = growBuffer(src, extra); d = g.d; cursor = g.free; room = g.free + g.room; }
  else d = src.slice();
  const alloc = n => { const at = cursor; cursor += Math.ceil(n / 256) * 256; if (cursor > room) throw new Error('model buffer overflow'); return at; };
  const dv = new DataView(d.buffer);
  const u8 = o => d[o], u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true), off = o => Number(dv.getBigUint64(o, true));
  const str = o => { if (!o) return ''; const n = u16(o); return new TextDecoder().decode(d.subarray(o + 2, o + 2 + n)); };
  const strAt = o => str(off(o));
  const buffers = off(off(0xb0) + 8), m = off(0x28);
  const nm = off(m + 8), old = str(nm);
  if (newname.length > old.length) throw new Error('model name too long');
  dv.setUint16(nm, newname.length, true); d.fill(0, nm + 2, nm + 2 + old.length + 1); d.set(new TextEncoder().encode(newname), nm + 2);
  const shapes = off(m + 0x28), ns = u16(m + 0x6a);
  const bysh = new Map(Object.entries(geom).map(([k, v]) => [MAT[k], v]));
  const report = {};
  for (let s = 0; s < ns; s++) {
    const sh = shapes + 0x60 * s, vb = off(sh + 0x10), nv = u32(vb + 0x50), attrs = off(vb + 8), A = {};
    for (let a = 0; a < u8(vb + 0x4c); a++) { const o = attrs + 0x10 * a; A[strAt(o)] = [u16(o + 0xc), u32(o + 8)]; }
    const stride = u32(off(vb + 0x38)), vstart = buffers + u32(vb + 0x48);
    const mesh = off(sh + 0x18), nmesh = u8(sh + 0x5b);
    for (let i = 0; i < nv; i++) { const p = vstart + stride * i + A._p0[0]; dv.setFloat32(p, 0, true); dv.setFloat32(p + 4, -500, true); dv.setFloat32(p + 8, 0, true); }
    const [V, TR] = bysh.get(s) || [[], []];
    if (need.has(s)) {   // new space: a copy of the shape's first vertex per vertex (keeps the attributes we don't set), and its own index list
      const vrel = alloc(need.get(s).vb), irel = alloc(need.get(s).ib), src0 = vstart;
      for (let i = 0; i < V.length; i++) d.copyWithin(buffers + vrel + stride * i, src0, src0 + stride);
      dv.setUint32(vb + 0x48, vrel, true); dv.setUint32(vb + 0x50, V.length, true);
      dv.setUint32(off(vb + 0x30), V.length * stride, true);
      const me = mesh, n = 3 * TR.length;
      dv.setUint32(me + 0x20, irel, true); dv.setUint32(me + 0x2c, n, true); dv.setUint32(me + 0x30, 0, true);
      const sub = off(me); dv.setUint32(sub, 0, true); dv.setUint32(sub + 4, n, true);
      const ibs = off(me + 0x18); if (ibs) dv.setUint32(ibs, 2 * n, true);
      const vs = buffers + vrel, put = (i, pos, nrm, uv) => {
        const p = vs + stride * i;
        pos.forEach((x, k) => dv.setFloat32(p + A._p0[0] + 4 * k, x, true));
        dv.setUint32(p + A._n0[0], snorm10(nrm), true);
        const t = u32(p + A._t0[0]), tan = Math.abs(nrm[1]) < 0.9 ? [nrm[2], 0, -nrm[0]] : [1, 0, 0];
        dv.setUint32(p + A._t0[0], snorm10(tan, (t >>> 30) & 3), true);
        const [o, uf] = A._u0; if (uf === 0x1705) { dv.setFloat32(p + o, uv[0], true); dv.setFloat32(p + o + 4, uv[1], true); } else { dv.setUint16(p + o, f2h(uv[0]), true); dv.setUint16(p + o + 2, f2h(uv[1]), true); }   // BackSide00 keeps its UVs as 32-bit floats
        if (A._u1) { const [o1, f] = A._u1;
          if (f === 0x1205) { dv.setUint16(p + o1, f2h(0.5), true); dv.setUint16(p + o1 + 2, f2h(0.5), true); }
          else if (f === 0x1201) { dv.setUint16(p + o1, 32768, true); dv.setUint16(p + o1 + 2, 32768, true); } }
      };
      V.forEach(([pos, nrm, uv], i) => put(i, pos, nrm, uv));
      const ia = buffers + irel; TR.flat().forEach((x, i) => dv.setUint16(ia + 2 * i, x, true));
      for (let k = 1; k < nmesh; k++) d.copyWithin(mesh + 0x38 * k, mesh, mesh + 0x38);   // every LOD draws it
      report[s] = { verts: V.length, tris: TR.length, lods: [0], cap: { tris: TR.length, verts: V.length }, grown: true };
    } else {
    const put = (i, pos, nrm, uv) => {
      const p = vstart + stride * i;
      pos.forEach((x, k) => dv.setFloat32(p + A._p0[0] + 4 * k, x, true));
      dv.setUint32(p + A._n0[0], snorm10(nrm), true);
      const t = u32(p + A._t0[0]);
      const tan = Math.abs(nrm[1]) < 0.9 ? [nrm[2], 0, -nrm[0]] : [1, 0, 0];
      dv.setUint32(p + A._t0[0], snorm10(tan, (t >>> 30) & 3), true);
      const [o, uf] = A._u0; if (uf === 0x1705) { dv.setFloat32(p + o, uv[0], true); dv.setFloat32(p + o + 4, uv[1], true); } else { dv.setUint16(p + o, f2h(uv[0]), true); dv.setUint16(p + o + 2, f2h(uv[1]), true); }   // BackSide00 keeps its UVs as 32-bit floats
      if (A._u1) { const [o1, f] = A._u1;
        if (f === 0x1205) { dv.setUint16(p + o1, f2h(0.5), true); dv.setUint16(p + o1 + 2, f2h(0.5), true); }
        else if (f === 0x1201) { dv.setUint16(p + o1, 32768, true); dv.setUint16(p + o1 + 2, 32768, true); } }
    };
    const drawn = []; const cap = [];
    for (let k = 0; k < nmesh; k++) {
      const me = mesh + 0x38 * k, at = buffers + u32(me + 0x20), fmt = u32(me + 0x28), cnt = u32(me + 0x2c), base = u32(me + 0x30);
      if (fmt !== 1) throw new Error('unexpected index format');
      cap.push({ tris: Math.floor(cnt / 3), verts: nv - base });
      let idx = [];
      // with allLods only LOD 0 is written: the other LODs' vertex ranges overlap LOD 0's, so writing them too
      // would overwrite part of LOD 0 (they reuse LOD 0's draw instead, below)
      if (opt.allLods && k > 0 && TR.length) continue;
      if (TR.length && 3 * TR.length <= cnt && base + V.length <= nv && V.length <= 65535) {
        V.forEach(([pos, nrm, uv], i) => put(base + i, pos, nrm, uv));
        idx = TR.flat(); drawn.push(k);
      }
      for (let i = 0; i < cnt; i++) dv.setUint16(at + 2 * i, i < idx.length ? idx[i] : (idx.length ? idx[0] : 0), true);
    }
    if (opt.allLods && TR.length && drawn[0] === 0)        // every LOD draws LOD 0's geometry
      for (let k = 1; k < nmesh; k++) d.copyWithin(mesh + 0x38 * k, mesh, mesh + 0x38);
    if (TR.length) report[s] = { verts: V.length, tris: TR.length, lods: drawn, cap: cap[0] };
    }
    const bb = off(sh + 0x38), br = off(sh + 0x40);
    if (TR.length) {
      const ps = V.map(v => v[0]), mn = [0, 1, 2].map(a => Math.min(...ps.map(p => p[a]))), mx = [0, 1, 2].map(a => Math.max(...ps.map(p => p[a])));
      const c = [0, 1, 2].map(a => (mn[a] + mx[a]) / 2), e = [0, 1, 2].map(a => Math.max(0.5, (mx[a] - mn[a]) / 2));
      for (let p = bb; p < br; p += 24) [...c, ...e].forEach((x, i) => dv.setFloat32(p + 4 * i, x, true));
      [...c, Math.sqrt(e[0] ** 2 + e[1] ** 2 + e[2] ** 2)].forEach((x, i) => dv.setFloat32(br + 4 * i, x, true));
    } else {
      for (let p = bb; p < br; p += 24) [0, -500, 0, 0.01, 0.01, 0.01].forEach((x, i) => dv.setFloat32(p + 4 * i, x, true));
      [0, -500, 0, 0.02].forEach((x, i) => dv.setFloat32(br + 4 * i, x, true));
    }
  }
  return { bytes: d, report };
}

// how many triangles / vertices each material can hold (LOD 0)
export function modelCapacity(src) {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true), off = o => Number(dv.getBigUint64(o, true));
  const m = off(0x28), shapes = off(m + 0x28), ns = u16(m + 0x6a), out = {};
  for (let s = 0; s < ns; s++) {
    const sh = shapes + 0x60 * s, vb = off(sh + 0x10), nv = u32(vb + 0x50), me = off(sh + 0x18);
    const key = Object.keys(MAT).find(k => MAT[k] === s); out[key] = { tris: Math.floor(u32(me + 0x2c) / 3), verts: nv - u32(me + 0x30) };
  }
  return out;
}

// ---------------------------------------------------------------- texture names
// every length-prefixed string in the file's string pool: [{off, len, s}]
function stringPool(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), out = [];
  const so = Number(dv.getBigUint64(0x20, true)) || 0;   // not relied on: scan the whole "_STR" block instead
  const STR = [0x5f, 0x53, 0x54, 0x52]; let p = -1;
  for (let i = 0; i + 4 < d.length; i++) if (d[i] === STR[0] && d[i + 1] === STR[1] && d[i + 2] === STR[2] && d[i + 3] === STR[3]) { p = i; break; }
  if (p < 0) throw new Error('no string table');
  const size = Number(dv.getBigUint64(p + 8, true)), count = dv.getUint32(p + 0x10, true);
  let q = p + 0x18; void so;
  for (let k = 0; k < count + 1 && q < p + size; k++) {
    const len = dv.getUint16(q, true), s = new TextDecoder().decode(d.subarray(q + 2, q + 2 + len));
    out.push({ off: q, len, s }); q += 2 + len + 1; q = (q + 1) & ~1;
  }
  return out;
}
// the texture names each material (slot) samples: {slot: {base, alb, nrm, emm, ...}}
export function slotTextures(src) {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const u16 = o => dv.getUint16(o, true), off = o => Number(dv.getBigUint64(o, true));
  const str = o => { const n = u16(o); return new TextDecoder().decode(src.subarray(o + 2, o + 2 + n)); };
  const m = off(0x28), shapes = off(m + 0x28), ns = u16(m + 0x6a), mats = off(m + 0x38);
  const pool = stringPool(src).map(x => x.s), out = {};
  for (let s = 0; s < ns; s++) {
    const sh = shapes + 0x60 * s, mi = u16(sh + 0x52), mname = str(off(mats + 0xb0 * mi + 8)), base = mname.replace(/^Mt_/, '');
    const key = Object.keys(MAT).find(k => MAT[k] === s), t = { material: mname };
    for (const suf of ['Alb', 'Nrm', 'Emm', 'Mix', 'Msk']) { const n = pool.find(x => x.endsWith(base + '_' + suf) && !/_Bake/.test(x)); if (n) t[suf.toLowerCase()] = n; }
    out[key] = t;
  }
  return out;
}
// rename strings in place (new names must not be longer); used to point a part's materials at its own textures
export function renameStrings(d, map) {
  const pool = stringPool(d), dv = new DataView(d.buffer, d.byteOffset, d.byteLength), enc = new TextEncoder();
  for (const [from, to] of Object.entries(map)) {
    const e = pool.find(x => x.s === from); if (!e) throw new Error('texture name not found: ' + from);
    if (to.length > e.len) throw new Error('new texture name too long: ' + to);
    dv.setUint16(e.off, to.length, true); d.fill(0, e.off + 2, e.off + 2 + e.len + 1); d.set(enc.encode(to), e.off + 2);
  }
  return d;
}
