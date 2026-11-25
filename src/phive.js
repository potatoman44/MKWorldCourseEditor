// Reading the game's own collision shapes (Phive/Shape/Dcc/*.bphsh): a Havok mesh shape with a material per triangle.
// Header: u32 at 0x10 = material table offset, 0x14 = filter table offset; the Havok tagfile (TAG0) starts at 0x30.
// Material table: 16 bytes each {u32 material, u32 subMaterial, u64 userShapeTagMask}. A triangle's material comes from the
// mesh shape's shapeTagTable (sorted (u32 primitiveKey, u16 tag) runs; primitiveKey = section << 9 | primitive << 1 | second half).
const be32 = (d, o) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
function subs(d, start) {
  const size = be32(d, start) & 0x3fffffff, out = {}; let p = start + 8;
  while (p < start + size) { const sz = be32(d, p) & 0x3fffffff; if (sz < 8) break; out[String.fromCharCode(...d.subarray(p + 4, p + 8))] = [p + 8, p + sz]; p += sz; }
  return out;
}
// -> { mats: [[material, sub, mask]], tris: [{ p: [[x,y,z] x3], mat: index into mats }] }
export function readMeshShape(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const matOff = dv.getUint32(0x10, true), fOff = dv.getUint32(0x14, true), mats = [];
  for (let p = matOff; p + 16 <= fOff; p += 16) mats.push([dv.getUint32(p, true), dv.getUint32(p + 4, true), Number(dv.getBigUint64(p + 8, true))]);
  const S = subs(d, 0x30), I = subs(d, S.INDX[0] - 8), D0 = S.DATA[0];
  let ms = -1;
  for (let p = I.ITEM[0] + 12; p < I.ITEM[1]; p += 12) if ((dv.getUint32(p, true) >>> 24) === 0x10) { ms = D0 + dv.getUint32(p + 4, true); break; }
  if (ms < 0) throw new Error('no mesh in this collision shape');
  const tt = ms + 0x70 + dv.getInt32(ms + 0x70, true), nt = dv.getInt32(ms + 0x74, true), tags = [];
  for (let i = 0; i < nt; i++) tags.push([dv.getUint32(tt + 8 * i, true), dv.getUint16(tt + 8 * i + 4, true)]);
  const tagOf = key => { let r = 0; for (const [k, t] of tags) { if (k <= key) r = t; else break; } return r; };
  const ns = dv.getInt32(ms + 0x94, true), gs = ms + 0x90 + dv.getInt32(ms + 0x90, true), tris = [];
  for (let s = 0; s < ns; s++) {
    const g = gs + 0x40 * s;
    const pr = g + 8 + dv.getInt32(g + 8, true), np = dv.getInt32(g + 12, true);
    const vb = g + 0x10 + dv.getInt32(g + 0x10, true), nv = dv.getInt32(g + 0x14, true) / 6;
    const off = [dv.getInt32(g + 0x20, true), dv.getInt32(g + 0x24, true), dv.getInt32(g + 0x28, true)];
    const V = i => [0, 1, 2].map(a => (dv.getUint16(vb + 6 * i + 2 * a, true) + off[a]) / 512);
    for (let i = 0; i < np; i++) {
      const a = d[pr + 4 * i], b = d[pr + 4 * i + 1], c = d[pr + 4 * i + 2], e = d[pr + 4 * i + 3];
      tris.push({ p: [V(a), V(b), V(c)], mat: tagOf((s << 9) | (i << 1)) });
      if (e !== c) tris.push({ p: [V(a), V(c), V(e)], mat: tagOf((s << 9) | (i << 1) | 1) });
    }
  }
  return { mats, tris };
}
