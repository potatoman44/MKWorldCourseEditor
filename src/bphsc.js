// Course collision (Phive/StaticCompoundBody/Course/*.bphsc): objects marked Bakeable have their
// collision baked into the course's static compound shape, so deleting the object from the course
// file leaves the collision behind. This switches those baked shape instances off.
//
// Layout (worked out from the game's files):
//  * "Phive" header; u32 section offsets from 0x0C. Section 1 is the object table: 0x20-byte rows of
//    {u32 first instance, u32 last instance (0xFFFFFFFF = nothing baked), u64 object Hash, u32 SRTHash}.
//  * One or more Havok tagfiles (TAG0) holding hknpCompoundShape. Their shape instance arrays have
//    64-byte entries: quaternion (16), translation xyz + u32 flags (16), scale xyz + u16 index + u16 0xFFFF
//    (16), shape pointer and padding. Flag 0x40 is "enabled" (0x6E = translation, rotation, scale,
//    scale surface, enabled); the index counts on across the tagfiles and matches the object table.

const be32 = (d, o) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

function tagSections(d, start) {
  const size = be32(d, start) & 0x3fffffff, out = {};
  for (let p = start + 8; p < start + size;) {
    const s = be32(d, p) & 0x3fffffff; if (s < 8) break;
    out[String.fromCharCode(...d.subarray(p + 4, p + 8))] = [p + 8, p + s]; p += s;
  }
  return out;
}

// every shape instance in the file: index -> byte offset of its 64-byte entry
export function shapeInstances(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), found = new Map();
  for (let t = 4; t < d.length - 8; t++) {
    if (d[t] !== 0x54 || d[t + 1] !== 0x41 || d[t + 2] !== 0x47 || d[t + 3] !== 0x30) continue;   // "TAG0"
    const start = t - 4, S = tagSections(d, start);
    if (!S.DATA || !S.INDX) continue;
    const I = tagSections(d, S.INDX[0] - 8);
    if (!I.ITEM) continue;
    const data = S.DATA[0];
    for (let p = I.ITEM[0]; p + 12 <= I.ITEM[1]; p += 12) {
      const off = dv.getUint32(p + 4, true), n = dv.getUint32(p + 8, true);
      if (n === 0 || data + off + 64 * n > S.DATA[1]) continue;
      // looks like an hknpShapeInstance array: unit quaternions, and indices that count up
      let ok = true, first = -1;
      for (let i = 0; i < n && ok; i++) {
        const e = data + off + 64 * i;
        const q = [0, 4, 8, 12].map(k => dv.getFloat32(e + k, true)), len = Math.hypot(...q);
        const idx = dv.getUint16(e + 0x2c, true);
        if (i === 0) first = idx;
        ok = Math.abs(len - 1) < 0.02 && idx === first + i && (dv.getUint32(e + 0x1c, true) & ~0xff) === 0;
      }
      if (!ok) continue;
      for (let i = 0; i < n; i++) found.set(first + i, data + off + 64 * i);
    }
    t = start + (be32(d, start) & 0x3fffffff) - 1;
  }
  return found;
}

// object table: Hash (as decimal string) -> [first, last] instance, only for objects with baked collision
export function bakedObjects(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (String.fromCharCode(...d.subarray(0, 5)) !== 'Phive') throw new Error('not a Phive file');
  const a = dv.getUint32(0x10, true), b = dv.getUint32(0x14, true), out = new Map();
  for (let p = a; p + 0x20 <= b; p += 0x20) {
    const first = dv.getUint32(p, true), last = dv.getUint32(p + 4, true);
    if (first === 0xffffffff) continue;
    out.set(String(dv.getBigUint64(p + 8, true)), [first, last]);
  }
  return out;
}

// a copy with the baked collision of the given objects switched off; returns null if none were baked here
export function removeBakedCollision(orig, hashes) {
  const baked = bakedObjects(orig);
  const hits = [...hashes].filter(h => baked.has(h));
  if (!hits.length) return null;
  const d = orig.slice(), dv = new DataView(d.buffer), inst = shapeInstances(d);
  let n = 0;
  for (const h of hits) {
    const [first, last] = baked.get(h);
    for (let i = first; i <= last; i++) {
      const e = inst.get(i); if (e === undefined) continue;
      dv.setUint32(e + 0x1c, dv.getUint32(e + 0x1c, true) & ~0x40, true);   // not enabled
      dv.setFloat32(e + 0x14, -100000, true);                                // and far below the world
      n++;
    }
  }
  return { bytes: d, objects: hits.length, instances: n };
}
