// BFRES v10 model geometry (Model/*.bfres.zs): the first model's most detailed meshes, placed by
// their bones, grouped by material. A JavaScript port of TrackStudioWorld's core/src/bfres.rs
// (BSD Zero Clause License, (c) 2026 The TrackStudioWorld contributors). Geometry only: textures
// are not decoded, each material gets a flat colour.

const M4 = {
  ident: () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), // column-major
  mul(a, b) { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; },
  srt(s, q, t) {
    const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    return new Float64Array([(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0, (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1]);
  },
};
// quaternion from Euler angles applied X, then Y, then Z (R = Rz·Ry·Rx)
function quatZYX(x, y, z) {
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2), cy = Math.cos(y / 2), sy = Math.sin(y / 2), cz = Math.cos(z / 2), sz = Math.sin(z / 2);
  return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}
function half(h) {
  const s = h >> 15 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

export function loadBfres(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u8 = o => dv.getUint8(o), u16 = o => dv.getUint16(o, true), i16 = o => dv.getInt16(o, true), u32 = o => dv.getUint32(o, true), f32 = o => dv.getFloat32(o, true);
  const off = o => Number(dv.getBigUint64(o, true));
  const dec = new TextDecoder();
  const str = o => { if (!o) return ''; const n = u16(o); return dec.decode(d.subarray(o + 2, o + 2 + n)); };
  const strAt = o => str(off(o));
  const dict = o => { if (!o) return []; const n = Math.min(u32(o + 4), 65536); const r = []; for (let i = 1; i <= n; i++) r.push(strAt(o + 8 + 16 * i + 8)); return r; };
  if (dec.decode(d.subarray(0, 4)) !== 'FRES') throw new Error('not a BFRES file');
  if (u16(0xdc) === 0) return { parts: [] };
  const buffers = off(off(0xb0) + 8);
  const m = off(0x28);
  if (dec.decode(d.subarray(m, m + 4)) !== 'FMDL') throw new Error('BFRES: no model');

  // bone matrices (model space)
  const skel = off(m + 0x18), bones = [];
  if (skel) {
    const arr = off(skel + 0x10), n = u16(skel + 0x38);
    for (let i = 0; i < n; i++) {
      const b = arr + i * 0x58, parent = i16(b + 0x22), flags = u32(b + 0x2c);
      const s = [f32(b + 0x30), f32(b + 0x34), f32(b + 0x38)], r = [f32(b + 0x3c), f32(b + 0x40), f32(b + 0x44), f32(b + 0x48)], t = [f32(b + 0x4c), f32(b + 0x50), f32(b + 0x54)];
      let q = (flags & 0x7000) === 0x1000 ? quatZYX(r[0], r[1], r[2]) : r;
      const ql = Math.hypot(...q) || 1; q = q.map(v => v / ql);
      const local = M4.srt(s, q, t);
      bones.push(parent >= 0 && parent < bones.length ? M4.mul(bones[parent], local) : local);
    }
  }
  let matrixToBone = [];
  if (skel) { const n = u16(skel + 0x3a) + u16(skel + 0x3c), list = off(skel + 0x18); if (list) for (let i = 0; i < n; i++) matrixToBone.push(u16(list + 2 * i)); }

  const shapes = off(m + 0x28), mats = off(m + 0x38), nshape = u16(m + 0x6a), nmat = u16(m + 0x6c);
  const matNames = []; for (let i = 0; i < nmat; i++) matNames.push(strAt(mats + 0xb0 * i + 0x08));

  const attr = (o, format) => {
    const ty = format & 0xff, kind = format >>> 8;
    if (kind === 0x0e) { const v = u32(o); const c = i => { const x = (v >>> (10 * i)) & 0x3ff; return ty === 2 ? Math.max(((x << 22) >> 22) / 511, -1) : x / 1023; }; return [c(0), c(1), c(2)]; }
    const spec = { 0x02: [1, 8], 0x09: [2, 8], 0x0b: [4, 8], 0x0a: [1, 16], 0x12: [2, 16], 0x15: [4, 16], 0x14: [1, 32], 0x17: [2, 32], 0x18: [3, 32], 0x19: [4, 32] }[kind];
    if (!spec) throw new Error('BFRES: unsupported attribute format 0x' + format.toString(16));
    const [count, bits] = spec, out = [0, 0, 0];
    for (let i = 0; i < Math.min(count, 3); i++) {
      const p = o + i * bits / 8;
      out[i] = bits === 8 ? (ty === 1 ? u8(p) / 255 : ty === 2 ? Math.max(dv.getInt8(p) / 127, -1) : (ty === 4 || ty === 9) ? dv.getInt8(p) : u8(p))
        : bits === 16 ? (ty === 1 ? u16(p) / 65535 : ty === 2 ? Math.max(i16(p) / 32767, -1) : (ty === 4 || ty === 9) ? i16(p) : ty === 5 ? half(u16(p)) : u16(p))
        : (ty === 5 ? f32(p) : (ty === 4 || ty === 9) ? dv.getInt32(p, true) : u32(p));
    }
    return out;
  };

  const parts = new Map(); // material index -> {material, pos:[], nrm:[], idx:[]}
  for (let s = 0; s < nshape; s++) {
    const sh = shapes + 0x60 * s;
    if (dec.decode(d.subarray(sh, sh + 4)) !== 'FSHP') throw new Error('BFRES: bad shape');
    const matIndex = u16(sh + 0x52), bone = u16(sh + 0x54), skin = u8(sh + 0x5a);
    if (u8(sh + 0x5b) === 0) continue;
    const vb = off(sh + 0x10), nverts = u32(vb + 0x50), nattr = u8(vb + 0x4c), nbuf = u8(vb + 0x4d);
    const starts = [], strides = []; let at = buffers + u32(vb + 0x48);
    for (let b = 0; b < nbuf; b++) { starts.push(at); strides.push(u32(off(vb + 0x38) + 0x10 * b)); at += u32(off(vb + 0x30) + 0x10 * b); }
    const attrs = off(vb + 8);
    const find = want => { for (let a = 0; a < nattr; a++) { const o = attrs + 0x10 * a; if (strAt(o) === want) { const buf = u16(o + 0xe); return [starts[buf] + u16(o + 0xc), strides[buf], u32(o + 8)]; } } return null; };
    const pa = find('_p0'); if (!pa) continue;
    const na = find('_n0'), ia = find('_i0'), ua = find('_u0');
    const mesh = off(sh + 0x18);
    const indexAt = u32(mesh + 0x20), prim = u32(mesh + 0x24), ifmt = u32(mesh + 0x28), count = u32(mesh + 0x2c), base = u32(mesh + 0x30);
    if (prim !== 3) continue; // triangles only
    let part = parts.get(matIndex);
    if (!part) { part = { material: matNames[matIndex] || '', pos: [], nrm: [], uv: [], idx: [] }; parts.set(matIndex, part); }
    const first = part.pos.length / 3;
    const shapeBone = bones[bone] || M4.ident();
    for (let v = 0; v < nverts; v++) {
      let w = shapeBone;
      if (skin === 1 && ia) { const mi = attr(ia[0] + ia[1] * v, ia[2])[0] | 0; const b = matrixToBone[mi]; w = (b !== undefined && bones[b]) || M4.ident(); }
      else if (skin > 1) w = null;
      const p = attr(pa[0] + pa[1] * v, pa[2]);
      if (w) { const x = p[0], y = p[1], z = p[2]; p[0] = w[0] * x + w[4] * y + w[8] * z + w[12]; p[1] = w[1] * x + w[5] * y + w[9] * z + w[13]; p[2] = w[2] * x + w[6] * y + w[10] * z + w[14]; }
      part.pos.push(p[0], p[1], p[2]);
      if (na) {
        const n = attr(na[0] + na[1] * v, na[2]);
        if (w) { const x = n[0], y = n[1], z = n[2]; n[0] = w[0] * x + w[4] * y + w[8] * z; n[1] = w[1] * x + w[5] * y + w[9] * z; n[2] = w[2] * x + w[6] * y + w[10] * z; }
        const l = Math.hypot(n[0], n[1], n[2]) || 1; part.nrm.push(n[0] / l, n[1] / l, n[2] / l);
      } else part.nrm.push(0, 1, 0);
      if (ua) { const t = attr(ua[0] + ua[1] * v, ua[2]); part.uv.push(t[0], t[1]); } else part.uv.push(0, 0);
    }
    const ib = buffers + indexAt;
    for (let i = 0; i < count; i++) {
      const k = base + (ifmt === 0 ? u8(ib + i) : ifmt === 1 ? u16(ib + 2 * i) : u32(ib + 4 * i));
      if (k >= nverts) throw new Error('BFRES: index past the vertices');
      part.idx.push(first + k);
    }
  }
  return { parts: [...parts.values()].filter(p => p.idx.length).map(p => ({ material: p.material, positions: new Float32Array(p.pos), normals: new Float32Array(p.nrm), uvs: new Float32Array(p.uv), indices: new Uint32Array(p.idx) })) };
}
