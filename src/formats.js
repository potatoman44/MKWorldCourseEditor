import { decompress } from 'fzstd';
import { Typed } from './byml.js';

// ---------- zstd ----------
export function zsDecompress(u8) { return decompress(u8); }

// A valid zstd frame made of raw (stored) blocks. The game's zstd decoder reads it like any other frame.
export function zsStore(data) {
  const BLOCK = 1 << 17;
  const nBlocks = Math.max(1, Math.ceil(data.length / BLOCK));
  const out = new Uint8Array(4 + 1 + 4 + nBlocks * 3 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0xFD2FB528, true);
  out[4] = 0xA0;                       // FCS 4 bytes, single segment, no checksum
  dv.setUint32(5, data.length, true);
  let p = 9;
  for (let i = 0; i < nBlocks; i++) {
    const s = i * BLOCK, len = Math.min(BLOCK, data.length - s);
    const last = i === nBlocks - 1 ? 1 : 0;
    const h = last | (0 << 1) | (len << 3);
    out[p++] = h & 255; out[p++] = (h >> 8) & 255; out[p++] = (h >> 16) & 255;
    out.set(data.subarray(s, s + len), p); p += len;
  }
  return out;
}

// ---------- CRC32 / SHA-256 ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(str) {
  const b = new TextEncoder().encode(str); let c = 0xFFFFFFFF;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export async function sha256hex(u8) {
  if (globalThis.crypto && crypto.subtle) {
    const h = await crypto.subtle.digest('SHA-256', u8);
    return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  return sha256fallback(u8);
}
function sha256fallback(m) {
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const l = m.length, n = ((l + 9 + 63) >> 6) << 6, b = new Uint8Array(n); b.set(m); b[l] = 0x80;
  const dv = new DataView(b.buffer); dv.setUint32(n - 4, l * 8 >>> 0); dv.setUint32(n - 8, Math.floor(l / 0x20000000));
  const W = new Uint32Array(64), r = (x, y) => (x >>> y) | (x << (32 - y));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + 4 * i);
    for (let i = 16; i < 64; i++) { const s0 = r(W[i-15],7)^r(W[i-15],18)^(W[i-15]>>>3), s1 = r(W[i-2],17)^r(W[i-2],19)^(W[i-2]>>>10); W[i] = (W[i-16]+s0+W[i-7]+s1)|0; }
    let [a,bb,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e,6)^r(e,11)^r(e,25)) + ((e&f)^(~e&g)) + K[i] + W[i])|0;
      const t2 = ((r(a,2)^r(a,13)^r(a,22)) + ((a&bb)^(a&c)^(bb&c)))|0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=bb; bb=a; a=(t1+t2)|0;
    }
    H[0]+=a;H[1]+=bb;H[2]+=c;H[3]+=d;H[4]+=e;H[5]+=f;H[6]+=g;H[7]+=h;
  }
  return [...H].map(x => x.toString(16).padStart(8, '0')).join('');
}

// ---------- Resource size table (RESTBL) ----------
export function parseRstb(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = new TextDecoder().decode(u8.subarray(0, 6));
  if (magic !== 'RESTBL') throw new Error('not a RESTBL file');
  const ver = dv.getUint32(6, true), strSize = dv.getUint32(10, true), nCrc = dv.getUint32(14, true), nName = dv.getUint32(18, true);
  const crc = new Map(); let o = 22;
  for (let i = 0; i < nCrc; i++, o += 8) crc.set(dv.getUint32(o, true), dv.getUint32(o + 4, true));
  const names = new Map();
  for (let i = 0; i < nName; i++, o += strSize + 4) {
    let e = o; while (e < o + strSize && u8[e]) e++;
    names.set(new TextDecoder().decode(u8.subarray(o, e)), dv.getUint32(o + strSize, true));
  }
  return { ver, strSize, crc, names };
}
export function rstbGet(t, path) { return t.names.has(path) ? t.names.get(path) : t.crc.get(crc32(path)); }
export function rstbSet(t, path, size) { if (t.names.has(path)) t.names.set(path, size); else t.crc.set(crc32(path), size); }
export function writeRstb(t) {
  const crcs = [...t.crc.entries()].sort((a, b) => a[0] - b[0]);
  const names = [...t.names.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const u8 = new Uint8Array(22 + crcs.length * 8 + names.length * (t.strSize + 4));
  const dv = new DataView(u8.buffer);
  u8.set(new TextEncoder().encode('RESTBL'));
  dv.setUint32(6, t.ver, true); dv.setUint32(10, t.strSize, true); dv.setUint32(14, crcs.length, true); dv.setUint32(18, names.length, true);
  let o = 22;
  for (const [c, s] of crcs) { dv.setUint32(o, c, true); dv.setUint32(o + 4, s, true); o += 8; }
  for (const [n, s] of names) { u8.set(new TextEncoder().encode(n).subarray(0, t.strSize - 1), o); dv.setUint32(o + t.strSize, s, true); o += t.strSize + 4; }
  return u8;
}

// ---------- Text form of BYML values ----------
// JSON, plus number suffixes so every BYML type survives editing:
//   1.5 / 2.0 = float   7 = int   7u = u32   7ul = u64   7l = i64   1.5d = double
export function toText(v, ind = '') {
  const n = ind + '  ';
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') { if (!isFinite(v)) return String(v); const s = String(Math.fround(v) === v ? +v.toPrecision(9) : v); return /[.eE]/.test(s) ? s : s + '.0'; }
  if (v instanceof Typed) return String(v.v) + ({ i32: '', u32: 'u', u64: 'ul', i64: 'l', f64: 'd' }[v.t]) + (v.t === 'f64' && !/[.eE]/.test(String(v.v)) ? '' : '');
  if (Array.isArray(v)) {
    if (v.every(x => typeof x === 'number' || x instanceof Typed) && v.length <= 4) return '[' + v.map(x => toText(x)).join(', ') + ']';
    if (!v.length) return '[]';
    return '[\n' + v.map(x => n + toText(x, n)).join(',\n') + '\n' + ind + ']';
  }
  const ks = Object.keys(v);
  if (!ks.length) return '{}';
  return '{\n' + ks.map(k => n + JSON.stringify(k) + ': ' + toText(v[k], n)).join(',\n') + '\n' + ind + '}';
}
export function fromText(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /[\s]/.test(src[i])) i++; };
  const err = m => { const line = src.slice(0, i).split('\n').length; throw new Error(m + ' (line ' + line + ')'); };
  const val = () => {
    ws(); const c = src[i];
    if (c === '{') { i++; const o = {}; ws(); if (src[i] === '}') { i++; return o; }
      for (;;) { ws(); if (src[i] !== '"') err('expected a key'); const k = str(); ws(); if (src[i++] !== ':') err('expected :'); o[k] = val(); ws();
        if (src[i] === ',') { i++; continue; } if (src[i] === '}') { i++; return o; } err('expected , or }'); } }
    if (c === '[') { i++; const a = []; ws(); if (src[i] === ']') { i++; return a; }
      for (;;) { a.push(val()); ws(); if (src[i] === ',') { i++; continue; } if (src[i] === ']') { i++; return a; } err('expected , or ]'); } }
    if (c === '"') return str();
    if (src.startsWith('true', i)) { i += 4; return true; }
    if (src.startsWith('false', i)) { i += 5; return false; }
    if (src.startsWith('null', i)) { i += 4; return null; }
    const m = /^(-?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|Infinity|NaN))(ul|u|l|d)?/.exec(src.slice(i, i + 64));
    if (!m) err('unexpected character ' + JSON.stringify(c));
    i += m[0].length;
    const num = m[1], suf = m[2];
    if (suf === 'ul') return new Typed('u64', BigInt.asUintN(64, BigInt(num)));
    if (suf === 'l') return new Typed('i64', BigInt.asIntN(64, BigInt(num)));
    if (suf === 'u') return new Typed('u32', Number(num) >>> 0);
    if (suf === 'd') return new Typed('f64', Number(num));
    if (/[.eE]|Infinity|NaN/.test(num)) return Number(num);
    return new Typed('i32', Number(num) | 0);
  };
  const str = () => { const s = i; i++; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; } i++; return JSON.parse(src.slice(s, i)); };
  const v = val(); ws(); if (i < src.length) err('extra text after the value');
  return v;
}
