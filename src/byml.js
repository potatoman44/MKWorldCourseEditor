// BYML v7 reader/writer for Mario Kart World course files (.bcett.byml)
// Floats (0xD2) are plain JS numbers. Every other numeric type is a Typed wrapper so it round-trips exactly.

export class Typed {
  constructor(t, v) { this.t = t; this.v = v; } // t: 'i32' | 'u32' | 'i64' | 'u64' | 'f64'; v: number or BigInt
}
export const T = {
  i32: v => new Typed('i32', v | 0),
  u32: v => new Typed('u32', v >>> 0),
  i64: v => new Typed('i64', BigInt.asIntN(64, BigInt(v))),
  u64: v => new Typed('u64', BigInt.asUintN(64, BigInt(v))),
  f64: v => new Typed('f64', +v),
};

const dec = new TextDecoder();
const enc = new TextEncoder();

export function parseByml(buf) {
  const d = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d[0] !== 0x59 || d[1] !== 0x42) throw new Error('Not a little-endian BYML file (expected "YB")');
  const ver = dv.getUint16(2, true);
  const keyOff = dv.getUint32(4, true), strOff = dv.getUint32(8, true), rootOff = dv.getUint32(12, true);
  const u24 = o => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16);
  const table = off => {
    if (!off) return [];
    if (d[off] !== 0xC2) throw new Error('bad string table');
    const n = u24(off + 1), out = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = off + dv.getUint32(off + 4 + 4 * i, true);
      let e = s; while (d[e]) e++;
      out[i] = dec.decode(d.subarray(s, e));
    }
    return out;
  };
  const keys = table(keyOff), strs = table(strOff);
  const val = (t, v) => {
    switch (t) {
      case 0xA0: return strs[v];
      case 0xD0: return v !== 0;
      case 0xD1: return new Typed('i32', v | 0);
      case 0xD2: { const tmp = new DataView(new ArrayBuffer(4)); tmp.setUint32(0, v, true); return tmp.getFloat32(0, true); }
      case 0xD3: return new Typed('u32', v >>> 0);
      case 0xD4: return new Typed('i64', dv.getBigInt64(v, true));
      case 0xD5: return new Typed('u64', dv.getBigUint64(v, true));
      case 0xD6: return new Typed('f64', dv.getFloat64(v, true));
      case 0xFF: return null;
      case 0xA1: { const n = dv.getUint32(v, true); return { __bin: d.slice(v + 4, v + 4 + n) }; }
      case 0xC0: case 0xC1: return node(v);
      default: throw new Error('Unsupported BYML value type 0x' + t.toString(16));
    }
  };
  const node = off => {
    const t = d[off], n = u24(off + 1);
    if (t === 0xC0) {
      const arr = new Array(n), base = off + 4 + ((n + 3) & ~3);
      for (let i = 0; i < n; i++) arr[i] = val(d[off + 4 + i], dv.getUint32(base + 4 * i, true));
      return arr;
    }
    if (t === 0xC1) {
      const o = {};
      for (let i = 0; i < n; i++) {
        const e = off + 4 + 8 * i;
        o[keys[u24(e)]] = val(d[e + 3], dv.getUint32(e + 4, true));
      }
      return o;
    }
    throw new Error('Unsupported BYML node 0x' + t.toString(16));
  };
  return { version: ver, root: node(rootOff) };
}

const cmpBytes = (a, b) => { // sort strings by UTF-8 bytes, like the game's tools
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

export function writeByml(root, version = 7, padPow2 = true) {
  const keySet = new Set(), strSet = new Set();
  const collect = v => {
    if (typeof v === 'string') strSet.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object' && !(v instanceof Typed) && !v.__bin) for (const k in v) { keySet.add(k); collect(v[k]); }
  };
  collect(root);
  const sortTable = set => [...set].map(s => [s, enc.encode(s)]).sort((a, b) => cmpBytes(a[1], b[1]));
  const keys = sortTable(keySet), strs = sortTable(strSet);
  const keyIdx = new Map(keys.map(([s], i) => [s, i])), strIdx = new Map(strs.map(([s], i) => [s, i]));

  let cap = 1 << 16, out = new Uint8Array(cap), dv = new DataView(out.buffer), pos = 0;
  const ensure = n => { while (pos + n > cap) { cap *= 2; const o2 = new Uint8Array(cap); o2.set(out); out = o2; dv = new DataView(out.buffer); } };
  const align = a => { const p = (pos + a - 1) & ~(a - 1); ensure(p - pos); pos = p; };
  const u8 = v => { ensure(1); out[pos++] = v; };
  const u24 = v => { ensure(3); out[pos++] = v & 255; out[pos++] = (v >> 8) & 255; out[pos++] = (v >> 16) & 255; };
  const u32 = v => { ensure(4); dv.setUint32(pos, v >>> 0, true); pos += 4; };

  // header
  u8(0x59); u8(0x42); ensure(2); dv.setUint16(pos, version, true); pos += 2;
  const hdrKey = pos; u32(0); const hdrStr = pos; u32(0); const hdrRoot = pos; u32(0);
  const writeTable = list => {
    align(4); const start = pos;
    u8(0xC2); u24(list.length);
    ensure(4 * (list.length + 1));
    const offsAt = pos; pos += 4 * (list.length + 1);
    list.forEach(([, bytes], i) => {
      dv.setUint32(offsAt + 4 * i, pos - start, true);
      ensure(bytes.length + 1); out.set(bytes, pos); pos += bytes.length; out[pos++] = 0;
    });
    dv.setUint32(offsAt + 4 * list.length, pos - start, true);
    return start;
  };
  if (keys.length) { const p = writeTable(keys); dv.setUint32(hdrKey, p, true); }
  if (strs.length) { const p = writeTable(strs); dv.setUint32(hdrStr, p, true); }

  const typeOf = v => {
    if (v === null || v === undefined) return 0xFF;
    if (typeof v === 'string') return 0xA0;
    if (typeof v === 'boolean') return 0xD0;
    if (typeof v === 'number') return 0xD2;
    if (v instanceof Typed) return { i32: 0xD1, u32: 0xD3, i64: 0xD4, u64: 0xD5, f64: 0xD6 }[v.t];
    if (v && v.__bin) return 0xA1;
    if (Array.isArray(v)) return 0xC0;
    if (typeof v === 'object') return 0xC1;
    throw new Error('cannot write value ' + v);
  };
  const f32 = new DataView(new ArrayBuffer(4));
  // returns the 32-bit slot value; containers and 64-bit values are written later and patched in
  const fixups = [];
  const inline = (v, slotPos) => {
    const t = typeOf(v);
    switch (t) {
      case 0xFF: return 0;
      case 0xA0: return strIdx.get(v);
      case 0xD0: return v ? 1 : 0;
      case 0xD2: f32.setFloat32(0, v, true); return f32.getUint32(0, true);
      case 0xD1: return v.v >>> 0;
      case 0xD3: return v.v >>> 0;
      default: fixups.push([slotPos, v]); return 0;
    }
  };
  const writeNode = v => {
    align(4); const start = pos;
    if (Array.isArray(v)) {
      u8(0xC0); u24(v.length);
      ensure(v.length); v.forEach(x => out[pos++] = typeOf(x));
      align(4);
      const slots = pos; ensure(4 * v.length); pos += 4 * v.length;
      v.forEach((x, i) => dv.setUint32(slots + 4 * i, inline(x, slots + 4 * i), true));
    } else {
      const ks = Object.keys(v).sort((a, b) => keyIdx.get(a) - keyIdx.get(b));
      u8(0xC1); u24(ks.length);
      ensure(8 * ks.length);
      ks.forEach(k => {
        const e = pos; pos += 8;
        out[e] = keyIdx.get(k) & 255; out[e + 1] = (keyIdx.get(k) >> 8) & 255; out[e + 2] = (keyIdx.get(k) >> 16) & 255;
        out[e + 3] = typeOf(v[k]);
        dv.setUint32(e + 4, inline(v[k], e + 4), true);
      });
    }
    return start;
  };
  // breadth-first so parents come before children
  const rootPos = writeNode(root);
  dv.setUint32(hdrRoot, rootPos, true);
  while (fixups.length) {
    const [slot, v] = fixups.shift();
    if (v && v.__bin) {
      align(v.__align || 4); ensure(4 + v.__bin.length);
      dv.setUint32(slot, pos, true); dv.setUint32(pos, v.__bin.length, true); pos += 4; out.set(v.__bin, pos); pos += v.__bin.length;
    } else if (v instanceof Typed) {
      align(8); ensure(8);
      if (v.t === 'i64') dv.setBigInt64(pos, BigInt(v.v), true);
      else if (v.t === 'u64') dv.setBigUint64(pos, BigInt(v.v), true);
      else dv.setFloat64(pos, v.v, true);
      dv.setUint32(slot, pos, true); pos += 8;
    } else {
      const p = writeNode(v);
      dv.setUint32(slot, p, true);
    }
  }
  let size = pos;
  if (padPow2) { size = 1; while (size < pos) size *= 2; }
  const res = new Uint8Array(size); res.set(out.subarray(0, pos));
  return res;
}
