// Brand-new course slot (its own stage, course, model and collision) as a mod for MKW 1.8 / mkw-recomp.
// Port of the tested Python builder (newstage.py + plane_mod.py + ovalcourse.mjs).
import { parseByml, writeByml, T, Typed } from './byml.js';
import { zsDecompress, zsStore, parseRstb, rstbSet, writeRstb, crc32 } from './formats.js';
import { parseSarc } from './sarc.js';
import { writeBphsh } from './hk.js';
import { writeModel, slotTextures, renameStrings, MAT } from './bfmodel.js';
import { replaceBntx, flatBntx, renameBntx, bntxInfo } from './astc.js';
const _mn = a => { let m = Infinity; for (const v of a) if (v < m) m = v; return m; }, _mx = a => { let m = -Infinity; for (const v of a) if (v > m) m = v; return m; };   // Math.min/max(...a) without the argument limit

const LIFT_OBJ = /Wanwan|Bomhei|Kuribo|Hanachan|Nokonoko|Togezo|Heyho/;
// an island tunnel (CmnObj_IslandTunnel000) turned to face heading yaw (atan2(x, z) of the way out). Scene rotations are
// Rz·Ry·Rx; the blank island's tunnel at +X, (π, -π/2, -π/2), faces -X: turn that about Y, then back to angles
function tunnelRot(yaw) {
  const mul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const ry = a => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const RA = [[0, -1, 0], [0, 0, -1], [1, 0, 0]], R = mul(ry(yaw + Math.PI / 2), RA);
  const y = Math.asin(Math.max(-1, Math.min(1, -R[2][0])));
  // straight up or down (gimbal lock): x and z turn about the same axis, so z = 0 and x takes it all
  const lock = Math.abs(R[2][0]) > 0.99999, x = lock ? Math.atan2(-R[1][2], R[1][1]) : Math.atan2(R[2][1], R[2][2]), z = lock ? 0 : Math.atan2(R[1][0], R[0][0]);
  return [x, y, z].map(Math.fround);
}   // Chain Chomps and walking enemies
export const SLOT = { SA: 'Rainbow_00', SZ: 'TestTrk_00', CA: 'Race_Rainbow_A_00', CZ: 'Race_TestTrk_A_00', ICON: [-330, 330] };
// where Rainbow Road's start grid stands: the start line, facing -Z (the grid is behind it, up to 46 m back, x -8..+7)
export const START = [0, 2785.7, 3731];
export const SRCN = 'CmnObj_ProvisionalPartsCentral000', JF = 'CmnObj_JumpFloor002_A_00';
// average of each look's Mix texture (R = B, G): measured from the game's own textures
const MIX_AVG = { wall03: [101, 4, 101, 255], wall06: [134, 57, 134, 255], backside01: [94, 177, 94, 255], watersedge: [138, 16, 138, 255], framesparts: [190, 44, 190, 255],
  backside00: [107, 171, 107, 255], decomark: [134, 133, 134, 255], floorparts: [165, 91, 165, 255], frame: [154, 59, 154, 255], asphalt: [198, 21, 198, 255],
  floortile: [163, 19, 163, 255], wiremesh: [113, 88, 113, 255], floorlight: [152, 141, 152, 255] };
export const CUPS = ['Kinoko', 'Flower', 'Star', 'Special', 'Shell', 'Banana', 'Leaf', 'Lightning'];

const enc = new TextEncoder(), dec = new TextDecoder();
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

// ---------------------------------------------------------------- hashing
export function mmh3(str, seed = 0) {
  const k8 = enc.encode(str), n = k8.length, nb = n >> 2; let h = seed >>> 0;
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  for (let i = 0; i < nb; i++) {
    let k = k8[4 * i] | (k8[4 * i + 1] << 8) | (k8[4 * i + 2] << 16) | (k8[4 * i + 3] << 24);
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0; const t = n & 3, b = 4 * nb;
  if (t === 3) k ^= k8[b + 2] << 16;
  if (t >= 2) k ^= k8[b + 1] << 8;
  if (t >= 1) { k ^= k8[b]; k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k; }
  h ^= n; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

// ---------------------------------------------------------------- SARC
export function sarcAdd(d, add, rep) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const hl = dv.getUint16(4, true), doff = dv.getUint32(12, true), n = dv.getUint16(hl + 6, true), mult = dv.getUint32(hl + 8, true);
  const sfnt = hl + 12 + 16 * n, ents = [];
  for (let i = 0; i < n; i++) {
    const attr = dv.getUint32(hl + 12 + 16 * i + 4, true), s = dv.getUint32(hl + 12 + 16 * i + 8, true), e = dv.getUint32(hl + 12 + 16 * i + 12, true);
    const no = sfnt + 8 + (attr & 0xffffff) * 4; let z = no; while (d[z]) z++;
    ents.push([dec.decode(d.subarray(no, z)), s, e]);
  }
  const parts = [d.subarray(doff)]; let len = d.length - doff;
  const idx = new Map(ents.map(e => [e[0], e]));
  const blob = b => { const pad = (256 - len % 256) % 256; if (pad) { parts.push(new Uint8Array(pad)); len += pad; } const s = len; parts.push(b); len += b.length; return [s, len]; };
  for (const [k, b] of rep) { if (!idx.has(k)) throw new Error('not in archive: ' + k); const [s, e] = blob(b); idx.get(k)[1] = s; idx.get(k)[2] = e; }
  for (const [k, b] of add) { if (idx.has(k)) { const [s, e] = blob(b); idx.get(k)[1] = s; idx.get(k)[2] = e; continue; } const [s, e] = blob(b); const en = [k, s, e]; ents.push(en); idx.set(k, en); }
  const sh = nm => { let h = 0; for (const c of enc.encode(nm)) h = (Math.imul(h, mult) + c) >>> 0; return h; };
  ents.sort((a, b) => sh(a[0]) - sh(b[0]));
  const names = [], offs = new Map(); let nl = 0;
  for (const [nm] of ents) { offs.set(nm, nl / 4); let b = enc.encode(nm + '\0'); const p = (4 - b.length % 4) % 4; if (p) b = cat(b, new Uint8Array(p)); names.push(b); nl += b.length; }
  const N = ents.length, end = hl + 12 + 16 * N + 8 + nl; let nd = doff; while (nd < end) nd += 0x200;
  const head = new Uint8Array(nd); head.set(d.subarray(0, hl)); const hv = new DataView(head.buffer);
  head.set(enc.encode('SFAT'), hl); hv.setUint16(hl + 4, 12, true); hv.setUint16(hl + 6, N, true); hv.setUint32(hl + 8, mult, true);
  ents.forEach(([nm, s, e], i) => { const o = hl + 12 + 16 * i; hv.setUint32(o, sh(nm), true); hv.setUint32(o + 4, (0x01000000 | offs.get(nm)) >>> 0, true); hv.setUint32(o + 8, s, true); hv.setUint32(o + 12, e, true); });
  const so = hl + 12 + 16 * N; head.set(enc.encode('SFNT'), so); hv.setUint16(so + 4, 8, true); hv.setUint16(so + 6, 0, true);
  let p = so + 8; for (const b of names) { head.set(b, p); p += b.length; }
  const out = cat(head, ...parts), ov = new DataView(out.buffer);
  ov.setUint32(8, out.length, true); ov.setUint32(12, nd, true);
  return out;
}
function buildSarc1(name, data, orig) {
  const dv = new DataView(orig.buffer, orig.byteOffset, orig.byteLength), hl = dv.getUint16(4, true), doff = dv.getUint32(12, true);
  let h = 0; for (const c of enc.encode(name)) h = (Math.imul(h, 0x65) + c) >>> 0;
  let nm = enc.encode(name + '\0'); const p = (4 - nm.length % 4) % 4; if (p) nm = cat(nm, new Uint8Array(p));
  const head = new Uint8Array(Math.max(doff, hl + 32 + 8 + nm.length)), v = new DataView(head.buffer);
  head.set(orig.subarray(0, hl));
  head.set(enc.encode('SFAT'), hl); v.setUint16(hl + 4, 12, true); v.setUint16(hl + 6, 1, true); v.setUint32(hl + 8, 0x65, true);
  v.setUint32(hl + 12, h, true); v.setUint32(hl + 16, 0x01000000, true); v.setUint32(hl + 20, 0, true); v.setUint32(hl + 24, data.length, true);
  head.set(enc.encode('SFNT'), hl + 28); v.setUint16(hl + 32, 8, true); v.setUint16(hl + 34, 0, true); head.set(nm, hl + 36);
  const out = cat(head, data), ov = new DataView(out.buffer); ov.setUint32(8, out.length, true); ov.setUint32(12, head.length, true); return out;
}

// ---------------------------------------------------------------- MSBT (names)
function parseMsbt(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const nsec = dv.getUint16(0xe, true); let p = 0x20; const S = {};
  for (let i = 0; i < nsec; i++) { const mg = String.fromCharCode(...b.subarray(p, p + 4)), sz = dv.getUint32(p + 4, true); S[mg] = b.subarray(p + 0x10, p + 0x10 + sz); p = (p + 0x10 + sz + 15) & ~15; }
  const L = S.LBL1, lv = new DataView(L.buffer, L.byteOffset, L.byteLength), labels = {};
  const nslots = lv.getUint32(0, true);
  for (let i = 0; i < nslots; i++) { const cnt = lv.getUint32(4 + 8 * i, true); let q = lv.getUint32(8 + 8 * i, true);
    for (let k = 0; k < cnt; k++) { const ln = L[q]; const nm = dec.decode(L.subarray(q + 1, q + 1 + ln)); labels[lv.getUint32(q + 1 + ln, true)] = nm; q += 1 + ln + 4; } }
  const X = S.TXT2, xv = new DataView(X.buffer, X.byteOffset, X.byteLength), n = xv.getUint32(0, true);
  const offs = []; for (let i = 0; i < n; i++) offs.push(xv.getUint32(4 + 4 * i, true)); offs.push(X.length);
  return { hdr: b.subarray(0, 0x20), labels, texts: offs.slice(0, n).map((o, i) => X.subarray(o, offs[i + 1])) };
}
function buildMsbt(hdr, labels, texts, nslots = 17) {
  const N = texts.length, slots = Array.from({ length: nslots }, () => []);
  const lh = s => { let h = 0; for (const c of enc.encode(s)) h = (Math.imul(h, 0x492) + c) >>> 0; return h % nslots; };
  for (let i = 0; i < N; i++) slots[lh(labels[i])].push(i);
  const u32 = x => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, x, true); return a; };
  const head = [u32(nslots)], body = []; let blen = 0; const base = 4 + 8 * nslots;
  for (const sl of slots) { head.push(u32(sl.length), u32(base + blen)); for (const i of sl) { const lb = enc.encode(labels[i]); const e = cat(Uint8Array.of(lb.length), lb, u32(i)); body.push(e); blen += e.length; } }
  const LBL = cat(...head, ...body), ATR = cat(u32(N), u32(0));
  const toff = 4 + 4 * N, tparts = [u32(N)]; let tl = 0;
  for (const t of texts) { tparts.push(u32(toff + tl)); tl += t.length; }
  const TXT = cat(...tparts, ...texts), RMT = new Uint8Array(N);
  const out = [hdr.slice(0, 0x20)]; let len = 0x20;
  for (const [mg, bd] of [['LBL1', LBL], ['ATR1', ATR], ['TXT2', TXT], ['RMT1', RMT]]) {
    out.push(enc.encode(mg), u32(bd.length), new Uint8Array(8), bd); len += 16 + bd.length;
    const p = (16 - len % 16) % 16; if (p) { out.push(new Uint8Array(p).fill(0xAB)); len += p; }
  }
  const o = cat(...out); new DataView(o.buffer).setUint32(0x12, o.length, true); return o;
}
const utf16 = s => { const a = new Uint8Array(2 * (s.length + 1)); for (let i = 0; i < s.length; i++) { a[2 * i] = s.charCodeAt(i) & 255; a[2 * i + 1] = s.charCodeAt(i) >> 8; } return a; };

// the message file (inside one of a region's archives) that has `label`: {path, zs, sarcRaw, file, msbt}
async function findNames(rd, reg, label) {
  if (!rd.list) return null;
  const cands = [];
  for (const n of await rd.list(`Mals/${reg}`)) cands.push(`Mals/${reg}/${n}`);
  for (const n of await rd.list('Mals')) if (n.startsWith(reg)) cands.push(`Mals/${n}`);
  const want = enc.encode(label);
  for (const path of cands.filter(p => /\.(msarc|sarc)(\.zs)?$/i.test(p))) {
    const raw = await rd(path); if (!raw) continue;
    const zs = /\.zs$/i.test(path); let d; try { d = zs ? zsDecompress(raw) : raw; } catch { continue; }
    if (indexOf(d, want) < 0) continue;
    let sarc; try { sarc = parseSarc(d); } catch { continue; }
    for (const [file, b] of sarc) {
      if (!/\.msbt$/i.test(file) || indexOf(b, want) < 0) continue;
      try { if (Object.values(parseMsbt(b).labels).includes(label)) return { path, zs, sarcRaw: d, file, msbt: b }; } catch {}
    }
  }
  return false;
}
function indexOf(h, n) { outer: for (let i = 0; i + n.length <= h.length; i++) { for (let k = 0; k < n.length; k++) if (h[i + k] !== n[k]) continue outer; return i; } return -1; }
// add entries to an MSBT, keeping its other sections: new entries copy `like`'s attributes and style
function msbtAppend(b, items, like) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), nsec = dv.getUint16(0xe, true), secs = []; let p = 0x20;
  for (let i = 0; i < nsec; i++) { const mg = String.fromCharCode(...b.subarray(p, p + 4)), sz = dv.getUint32(p + 4, true); secs.push({ mg, body: b.subarray(p + 0x10, p + 0x10 + sz) }); p = (p + 0x10 + sz + 15) & ~15; }
  const m = parseMsbt(b), N = m.texts.length, labels = m.texts.map((_, i) => m.labels[i]), li = labels.indexOf(like); if (li < 0) return null;
  const nslots = new DataView(secs.find(x => x.mg === 'LBL1').body.buffer, secs.find(x => x.mg === 'LBL1').body.byteOffset).getUint32(0, true);
  const all = [...labels, ...items.map(x => x[0])], texts = [...m.texts, ...items.map(x => x[1])], K = items.length;
  const u32 = x => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, x, true); return a; };
  const lh = s => { let h = 0; for (const c of enc.encode(s)) h = (Math.imul(h, 0x492) + c) >>> 0; return h % nslots; };
  const slots = Array.from({ length: nslots }, () => []); all.forEach((l, i) => slots[lh(l)].push(i));
  const head = [u32(nslots)], body = []; let blen = 0; const base = 4 + 8 * nslots;
  for (const sl of slots) { head.push(u32(sl.length), u32(base + blen)); for (const i of sl) { const lb = enc.encode(all[i]); const e = cat(Uint8Array.of(lb.length), lb, u32(i)); body.push(e); blen += e.length; } }
  const newBody = {};
  newBody.LBL1 = cat(...head, ...body);
  const toff = 4 + 4 * texts.length, tparts = [u32(texts.length)]; let tl = 0; for (const t of texts) { tparts.push(u32(toff + tl)); tl += t.length; }
  newBody.TXT2 = cat(...tparts, ...texts);
  for (const sc of secs) {
    const v = new DataView(sc.body.buffer, sc.body.byteOffset, sc.body.byteLength);
    if (sc.mg === 'ATR1') {
      const cnt = v.getUint32(0, true), size = v.getUint32(4, true);
      if (cnt !== N) return null;
      if (size === 0) { newBody.ATR1 = cat(u32(N + K), u32(0), sc.body.subarray(8)); continue; }
      if (sc.body.length !== 8 + N * size) return null;   // attributes with a string pool: leave this file alone
      const rec = sc.body.subarray(8 + li * size, 8 + (li + 1) * size), recs = []; for (let k = 0; k < K; k++) recs.push(rec);
      newBody.ATR1 = cat(u32(N + K), u32(size), sc.body.subarray(8), ...recs);
    } else if (sc.mg === 'TSY1') {
      if (sc.body.length !== 4 * N) return null;
      const rec = sc.body.subarray(4 * li, 4 * li + 4), recs = []; for (let k = 0; k < K; k++) recs.push(rec);
      newBody.TSY1 = cat(sc.body, ...recs);
    } else if (sc.mg === 'RMT1' && sc.body.length === N) newBody.RMT1 = cat(sc.body, new Uint8Array(K));
    else if (!['LBL1', 'TXT2', 'NLI1'].includes(sc.mg) && sc.body.length) return null;   // another per-entry section we don't know: leave the file alone
  }
  const out = [b.slice(0, 0x20)]; let len = 0x20;
  for (const sc of secs) {
    const bd = newBody[sc.mg] || sc.body;
    out.push(enc.encode(sc.mg), u32(bd.length), new Uint8Array(8), bd); len += 16 + bd.length;
    const pd = (16 - len % 16) % 16; if (pd) { out.push(new Uint8Array(pd).fill(0xAB)); len += pd; }
  }
  const o = cat(...out); new DataView(o.buffer).setUint32(0x12, o.length, true); return o;
}

// ---------------------------------------------------------------- BYML helpers
const pbyml = b => parseByml(b);
const wbyml = (doc, root, pad = false) => writeByml(root, doc.version, pad);
function edit(bytes, fn, pad = false) { const doc = pbyml(bytes); const r = fn(doc.root) ?? doc.root; return wbyml(doc, r, pad); }
function deepStrings(o, f) {
  if (typeof o === 'string') return f(o);
  if (Array.isArray(o)) return o.map(x => deepStrings(x, f));
  if (o && typeof o === 'object' && !(o instanceof Typed) && !o.__bin) { for (const k in o) o[k] = deepStrings(o[k], f); }
  return o;
}
function cloneTyped(o) {
  if (o instanceof Typed) return new Typed(o.t, o.v);
  if (Array.isArray(o)) return o.map(cloneTyped);
  if (o && typeof o === 'object') { if (o.__bin) return { ...o, __bin: o.__bin.slice() }; const r = {}; for (const k in o) r[k] = cloneTyped(o[k]); return r; }
  return o;
}
const byRowId = (x, y) => x.__RowId < y.__RowId ? -1 : x.__RowId > y.__RowId ? 1 : 0;
function replaceBytes(b, pairs) {
  const out = b.slice();
  for (const [a, z] of pairs) {
    const A = enc.encode(a), Z = enc.encode(z); if (A.length !== Z.length) throw new Error('rename must keep the length');
    outer: for (let i = 0; i + A.length <= out.length; i++) { for (let k = 0; k < A.length; k++) if (out[i + k] !== A[k]) continue outer; out.set(Z, i); i += A.length - 1; }
  }
  return out;
}

// PathAdditionalData: {routeNodeHash: {4925852885074210900: {SD: 0.0, ST: 20}}} (hash-keyed BYML dictionaries)
export function writePad(hashes) {
  const keys = ['SD', 'ST'], parts = []; let len = 0;
  const put = b => { parts.push(b); len += b.length; };
  const align = () => { const p = (4 - len % 4) % 4; if (p) put(new Uint8Array(p)); };
  // header + key table
  const hdr = new Uint8Array(16); put(hdr);
  const kt = len, kb = keys.map(k => enc.encode(k + '\0'));
  const tbl = new Uint8Array(4 + 4 * (keys.length + 1)), tv = new DataView(tbl.buffer);
  tbl[0] = 0xC2; tbl[1] = keys.length; let o = tbl.length; keys.forEach((k, i) => { tv.setUint32(4 + 4 * i, o, true); o += kb[i].length; }); tv.setUint32(4 + 4 * keys.length, o, true);
  put(tbl); kb.forEach(put);
  const hs = [...hashes].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  // root: 0x21 with n entries (key u64, value u32) then n type bytes
  align(); const root = len, n = hs.length, rb = new Uint8Array(4 + 12 * n + n), rv = new DataView(rb.buffer);
  rb[0] = 0x21; rb[1] = n & 255; rb[2] = (n >> 8) & 255; rb[3] = n >> 16; put(rb);
  hs.forEach((h, i) => {
    rv.setBigUint64(4 + 12 * i, h, true); rb[4 + 12 * n + i] = 0x21;
    align(); rv.setUint32(4 + 12 * i + 8, len, true);
    const ib = new Uint8Array(4 + 12 + 1), iv = new DataView(ib.buffer); ib[0] = 0x21; ib[1] = 1; iv.setBigUint64(4, 4925852885074210900n, true); ib[16] = 0xC1; put(ib);
    align(); iv.setUint32(12, len, true);
    const cb = new Uint8Array(4 + 16), cv = new DataView(cb.buffer); cb[0] = 0xC1; cb[1] = 2;
    cb[4] = 0; cb[7] = 0xD2; cv.setFloat32(8, 0, true); cb[12] = 1; cb[15] = 0xD1; cv.setInt32(16, 20, true); put(cb);
  });
  const out = cat(...parts), ov = new DataView(out.buffer);
  out[0] = 0x59; out[1] = 0x42; ov.setUint16(2, 7, true); ov.setUint32(4, kt, true); ov.setUint32(8, 0, true); ov.setUint32(12, root, true);
  return out;
}

// ---------------------------------------------------------------- RSDB edits
function rsdbCourse(bytes, A, Z, stageHash) {
  return edit(bytes, rows => { const src = rows.find(r => r.__RowId.endsWith('/' + A + '.game__CourseGParam.gyml'));
    rows.push({ ...src, __RowId: src.__RowId.replace(A, Z), BancFile: src.BancFile.replace(A, Z) }); rows.sort(byRowId);
    rows.find(x => x.__RowId.includes('/' + Z + '.')).FromStageIdValue = T.u32(stageHash); });
}
function rsdbCloneRow(bytes, src, dst, label) {
  return edit(bytes, rows => { const s = rows.find(x => x.__RowId.includes('/' + src + '.')); if (!s) throw new Error('no RSDB row for ' + src);
    rows.push({ ...s, Label: label, __RowId: s.__RowId.replace(src, dst) }); rows.sort(byRowId); });
}
function rsdbTags(bytes, pairs) {
  const doc = pbyml(bytes), r = doc.root, PL = r.PathList, TN = r.TagList.length, N = PL.length / 3, RB = TN / 8, bit = r.BitTable.__bin;
  let rows = []; for (let i = 0; i < N; i++) rows.push({ p: [PL[3 * i], PL[3 * i + 1], PL[3 * i + 2]], bits: bit.slice(i * RB, (i + 1) * RB) });
  for (const [full, Z] of pairs) {
    let pre = 'Work/Gyml/CourseGParam/', A = full; const j = A.lastIndexOf('/'); if (j >= 0) { pre = A.slice(0, j + 1); A = A.slice(j + 1); }
    const src = rows.find(x => x.p[1] === A && x.p[0] === pre); if (!src) throw new Error('no tag row ' + pre + A);
    rows.push({ p: [pre, Z, src.p[2]], bits: src.bits.slice() });
  }
  const key = x => enc.encode(x.p.join(''));
  rows.sort((x, y) => { const A = key(x), B = key(y); for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) return A[i] - B[i]; return A.length - B.length; });
  const N2 = rows.length, W2 = Math.ceil(N2 / 32), nb = new Uint8Array(N2 * RB); rows.forEach((x, i) => nb.set(x.bits, i * RB));
  const rank = new Uint32Array(TN * W2);
  for (let t = 0; t < TN; t++) { let c = 0; for (let w = 0; w < W2; w++) { for (let e = w * 32; e < Math.min(N2, w * 32 + 32); e++) if (nb[e * RB + (t >> 3)] >> (t & 7) & 1) c++; rank[t * W2 + w] = c; } }
  r.PathList = rows.flatMap(x => x.p); r.BitTable = { __bin: nb }; r.RankTable = { __bin: new Uint8Array(rank.buffer) };
  return wbyml(doc, r);
}

// ---------------------------------------------------------------- the course file
const rnd64 = () => { const a = new BigUint64Array(1); crypto.getRandomValues(a); return a[0]; };
const rnd32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
const uuid = () => crypto.randomUUID();
const LINK = 'Work/Gyml/LinkDefGParam/BasicSignal.gear__LinkDefGParam.gyml';
// a path graph: rails of nodes; each rail's last node links on to the first node of the rails in its `next`
// (that's how the game's own courses fork and rejoin: always rail end -> rail start). node.rot: a full Rotate (else [0, yaw, 0])
function railGraph(kind, rails, H) {
  const G = `Work/Gyml/GraphRailDefGParam/${kind}.gear__GraphRailDefGParam.gyml`;
  const hs = rails.map(rl => rl.nodes.map(() => H()));
  return rails.map((rl, ri) => {
    const rh = H();
    const pts = rl.nodes.map((n, i) => {
      const p = { Gyaml: G, Hash: T.u64(hs[ri][i]), InstanceId: uuid(), Name: `${kind}.Node`, Parent: T.u64(rh), RectOffset: n.ro, RectSize: n.rs, Rotate: n.rot || [0, n.yaw, 0], Translation: n.pos };
      if (i === rl.nodes.length - 1 && rl.next.length) p.Links = rl.next.map(k => ({ Dst: T.u64(hs[k][0]), Gyaml: LINK, Name: 'BasicSignal', Src: T.u64(hs[ri][i]) }));
      if (n.dyn && Object.keys(n.dyn).length) p.Dynamic = { ...n.dyn };
      return p;
    });
    return { Gyaml: G, Hash: T.u64(rh), InstanceId: uuid(), IsClosed: false, Name: kind, Points: pts };
  });
}
// glide paths (where gliding karts and CPUs fly): spec.glidePaths = [[node, ...], ...], one open rail each, not linked to anything
const glideRails = (spec, H) => railGraph('GlidePath', (spec.glidePaths || []).filter(n => n.length >= 2).map(nodes => ({ nodes, next: [] })), H);
// grind rails: spec.railPaths = [[node, ...], ...] -> RailSlidePath (a line along a rail's top; the 0.5 m box is the rail's thickness)
const slideRails = (spec, H) => railGraph('RailSlidePath', (spec.railPaths || []).filter(n => n.length >= 2).map(nodes => ({ nodes, next: [] })), H);
// anti-gravity (like Rainbow Road's): spec.gravityPaths / spec.gravityCamPaths = [[node with a full rot, ...], ...]. Each
// GravityPath node's rot says which way is down there; GravityCameraPath turns the camera with the kart
const gravityRails = (spec, H) => [...railGraph('GravityPath', (spec.gravityPaths || []).filter(n => n.length >= 2).map(nodes => ({ nodes, next: [] })), H),
  ...railGraph('GravityCameraPath', (spec.gravityCamPaths || []).filter(n => n.length >= 2).map(nodes => ({ nodes, next: [] })), H)];
function buildCourse(bytes, spec) {
  const doc = pbyml(bytes), r = doc.root; r.FilePath = r.FilePath.replace(SLOT.CA, SLOT.CZ);
  const used = new Set(); const H = () => { let h; do h = rnd64(); while (used.has(h) || h === 0n); used.add(h); return h; };
  const tpl = n => r.Actors.find(a => a.Name === n);
  const keep = r.Actors.filter(a => a.Name === 'StartPosition'); keep.forEach(a => used.add(a.Hash.v));
  if (spec.starts && spec.starts.length) {   // the start grid laid out by Quick Create: move the game's start spots there
    const byId = new Map(); for (const a of keep) { const id = a.Dynamic?.StartPositionId?.v; if (a.Dynamic?.IsTimeAttack) continue; byId.set(id === undefined ? 0 : id, a); }
    const ta = keep.find(a => a.Dynamic?.IsTimeAttack);
    spec.starts.forEach((b, i) => { const a = byId.get(b.id ?? i); if (a) { a.Translate = b.pos; a.Rotate = [0, Math.fround(b.yaw), 0]; } });
    const last = spec.starts[spec.starts.length - 1];
    for (const [id, a] of byId) if (id >= spec.starts.length) { a.Translate = last.pos; a.Rotate = [0, Math.fround(last.yaw), 0]; }
    if (ta) { ta.Translate = spec.starts[0].pos; ta.Rotate = [0, Math.fround(spec.starts[0].yaw), 0]; }
  } else if (spec.startHeight) for (const a of keep) {   // sit the start grid on the track's own surface (it may slope)
    const t = a.Translate, y = spec.startHeight(t[0] - START[0], t[2] - START[2]);
    if (y !== null && y !== undefined && isFinite(y)) a.Translate = [t[0], Math.fround(START[1] + y + 0.1), t[2]];
  }
  const actors = [...keep];
  for (const s of spec.actors) {
    const t = tpl(s.name), g = t ? t.Gyaml : `Work/Gyml/ActorGParam/${s.name}.gear__ActorGParam.gyml`;
    const a = { Gyaml: g, Hash: T.u64(H()), InstanceId: uuid(), IsGridify: false, Name: s.name, Rotate: s.rot || [0, 0, 0], SRTHash: T.u32(rnd32()), Translate: s.pos };
    if (s.scale) a.Scale = [s.scale, s.scale, s.scale]; actors.push(a);
  }
  const graph = (kind, rails) => railGraph(kind, rails, H);
  const routes = spec.routes && spec.routes.length ? spec.routes : [spec.route];
  // a single loop: only last -> first closes it
  const lapRails = spec.lapRails || [{ nodes: spec.lap, next: [0] }];
  const routeRails = spec.routeRails || routes.map((rt, i) => ({ nodes: rt, next: [i] }));
  r.Rails = [...graph('LapPathGraph', lapRails), ...graph('RoutePathGraph', routeRails), ...glideRails(spec, H), ...slideRails(spec, H), ...gravityRails(spec, H)];
  r.Actors = actors;
  const ca = {}; for (const a of actors) ca[a.Name] = T.i32((ca[a.Name]?.v || 0) + 1); r.CountActor = ca;
  r.CountRail = { LapPathGraph: T.i32(lapRails.length), RoutePathGraph: T.i32(routeRails.length) }; for (const k of ['GlidePath', 'RailSlidePath', 'GravityPath', 'GravityCameraPath']) { const ng = r.Rails.filter(rl => rl.Name === k).length; if (ng) r.CountRail[k] = T.i32(ng); }
  r.Collects = { Coin: T.i32(actors.filter(a => a.Name === 'CmnObj_Coin000_A_00').length) };
  const ps = [...actors.map(a => a.Translate), ...lapRails.flatMap(rl => rl.nodes.map(n => n.pos)), ...(spec.extent || [])];
  r.AABB = { Max: [0, 1, 2].map(k => _mx(ps.map(p => p[k])) + 150), Min: [0, 1, 2].map(k => _mn(ps.map(p => p[k])) - 150) };
  if (spec.space) setSpaceSky(r, true, H);
  return { bytes: wbyml(doc, r, true), routeHashes: r.Rails.filter(rl => rl.Name === 'RoutePathGraph').flatMap(rl => rl.Points.map(p => p.Hash.v)) };
}

// Rainbow Road's sky switch: inside this box the sky becomes space. One box round the whole track (or none)
const SPACE = 'SystemObj_RainbowChangeSpace_00';
function setSpaceSky(r, on, H) {
  r.Actors = (r.Actors || []).filter(a => a.Name !== SPACE); if (r.CountActor) delete r.CountActor[SPACE];
  if (!on || !r.AABB) return;
  const n = v => (v && typeof v === 'object' && 'v' in v) ? Number(v.v) : Number(v), mn = r.AABB.Min.map(n), mx = r.AABB.Max.map(n);
  r.Actors.push({ Gyaml: `Work/Gyml/ActorGParam/${SPACE}.gear__ActorGParam.gyml`, Hash: T.u64(H()), InstanceId: uuid(), IsGridify: false, Name: SPACE, PrimitiveType: 'Cube',
    Rotate: [0, 0, 0], SRTHash: T.u32(rnd32()), Scale: [0, 1, 2].map(k => Math.fround((mx[k] - mn[k]) / 2 + 400)), Translate: [0, 1, 2].map(k => Math.fround((mn[k] + mx[k]) / 2)) });
  const ca = r.CountActor || {}; ca[SPACE] = T.i32(1); r.CountActor = ca;
}
// the finished course: everything from the course editor's document, with the track's model parts put in fresh
function courseFromDoc(bytes, spec) {
  const doc = pbyml(bytes), r = doc.root;
  const used = new Set(); for (const a of r.Actors || []) if (a.Hash) used.add(a.Hash.v);
  const H = () => { let h; do h = rnd64(); while (used.has(h) || h === 0n); used.add(h); return h; };
  const actors = (r.Actors || []).filter(a => !/^CmnObj_CTrkPart\d+_A_00$/.test(a.Name || ''));
  for (const p of spec.parts) { const n = p.name + '_A_00'; actors.push({ Gyaml: `Work/Gyml/ActorGParam/${n}.gear__ActorGParam.gyml`, Hash: T.u64(H()), InstanceId: uuid(), IsGridify: false, Name: n, Rotate: [0, 0, 0], SRTHash: T.u32(rnd32()), Translate: p.pos }); }
  r.Actors = actors;
  // the editor's glide paths replace its old ones (those starting where it made one before); glide paths you added or kept in the course view stay
  if (spec.glidePaths) { const made = spec.glideMade, nv = v => (v && typeof v === 'object' && 'v' in v) ? Number(v.v) : Number(v);
    const mine = rl => { if (!made) return true; const p = rl.Points?.[0]?.Translation; if (!p) return true; const q = p.map(nv); return made.some(m => Math.hypot(m[0] - q[0], m[1] - q[1], m[2] - q[2]) < 10); };
    r.Rails = [...(r.Rails || []).filter(rl => rl.Name !== 'GlidePath' || !mine(rl)), ...glideRails(spec, H)]; }
  if (spec.railPaths) r.Rails = [...(r.Rails || []).filter(rl => rl.Name !== 'RailSlidePath'), ...slideRails(spec, H)];   // and its rail paths
  if (spec.gravityPaths?.length || spec.gravityCamPaths?.length) r.Rails = [...(r.Rails || []).filter(rl => !/^Gravity(Camera)?Path$/.test(rl.Name)), ...gravityRails(spec, H)];
  const ca = {}; for (const a of actors) ca[a.Name] = T.i32((ca[a.Name]?.v || 0) + 1); r.CountActor = ca;
  const cr = {}; for (const rl of r.Rails || []) cr[rl.Name] = T.i32((cr[rl.Name]?.v || 0) + 1); r.CountRail = cr;
  r.Collects = { ...(r.Collects || {}), Coin: T.i32(actors.filter(a => a.Name === 'CmnObj_Coin000_A_00').length) };
  const num = v => (v && typeof v === 'object' && 'v' in v) ? Number(v.v) : Number(v);
  const ps = [...actors.map(a => a.Translate), ...(r.Rails || []).filter(rl => rl.Name === 'LapPathGraph').flatMap(rl => rl.Points.map(p => p.Translation)), ...(spec.extent || [])].filter(Boolean).map(p => p.map(num));
  r.AABB = { Max: [0, 1, 2].map(k => Math.fround(_mx(ps.map(p => p[k])) + 150)), Min: [0, 1, 2].map(k => Math.fround(_mn(ps.map(p => p[k])) - 150)) };
  if (spec.space !== undefined) setSpaceSky(r, spec.space, H);
  return { bytes: wbyml(doc, r, true), routeHashes: (r.Rails || []).filter(rl => rl.Name === 'RoutePathGraph').flatMap(rl => rl.Points.map(p => p.Hash.v)) };
}
// the course alone (paths, item boxes, start grid, no model parts), for the course editor to open when the track is finished
export async function courseDocBytes(rd, spec) {
  const b = await rd(`Banc/${SLOT.CA}[Game03].bcett.byml.zs`); if (!b) throw new Error(`missing from the dump: Banc/${SLOT.CA}[Game03].bcett.byml.zs`);
  return buildCourse(zsDecompress(b), { ...spec, parts: [] }).bytes;
}

// ---------------------------------------------------------------- one model+collision actor per track part
function partFiles(AR, part, central, templ, texNames) {
  const NEWN = part.name, A1 = NEWN + '_A_00', A0 = SRCN + '_A_00';
  const ren = s => s.replaceAll(SRCN + '_A_00', A1).replaceAll('ShapeParam/' + SRCN + '_A.', 'ShapeParam/' + NEWN + '_A.').replaceAll('Dcc/' + SRCN + '_A.phsh', 'Dcc/' + NEWN + '_A.phsh').replaceAll(`CmnObj/${SRCN}/output/${SRCN}_A.fmdb`, `CmnObj/${NEWN}/output/${NEWN}_A.fmdb`);
  const g = (arc, p) => { const b = AR[arc].get(p); if (!b) throw new Error('missing ' + p); return b; };
  const adds = { actor: new Map(), modelinfo: new Map(), phwe: new Map(), phive: new Map(), actorinfo: new Map(), fmdbsummary: new Map() };
  adds.actor.set(`Gyml/ActorGParam/${A1}.gear__ActorGParam.bgyml`, edit(g('actor', `Gyml/ActorGParam/${JF}.gear__ActorGParam.bgyml`), r => {
    r.Components.ModelInfoRef = `Work/Gyml/Component/ModelInfoGParam/${A1}.gear__ModelInfoGParam.gyml`;
    r.Components.PhysicsRef = `Work/Gyml/Component/PhysicsGParam/${A1}.gear__PhysicsGParam.gyml`; r.Label = 'Custom track part'; }));
  adds.modelinfo.set(`Gyml/Component/ModelInfoGParam/${A1}.gear__ModelInfoGParam.bgyml`, edit(g('modelinfo', `Gyml/Component/ModelInfoGParam/${A0}.gear__ModelInfoGParam.bgyml`), r => {
    r = deepStrings(r, ren);
    r.BakeLightInfo = `Work/Gyml/BakeLightList/${A0}.gear__BakeLightList.gyml`; r.SingleActorBakeInfo = `Work/Gyml/BakeSingleActorInfoGParam/${A0}.gear__BakeSingleActorInfoGParam.gyml`; return r; }));
  adds.phwe.set(`Gyml/Component/PhysicsGParam/${A1}.gear__PhysicsGParam.bgyml`, edit(g('phwe', `Gyml/Component/PhysicsGParam/${A0}.gear__PhysicsGParam.bgyml`), r => deepStrings(r, ren)));
  // the road's collision is stage ground (like the game's own road pieces), not a prop: Thwomps and other
  // objects that look for the ground below them only find stage ground, and stay frozen over a prop
  adds.phive.set(`Phive/ControllerSetParam/${A1}.phive__ControllerSetParam.bgyml`, edit(g('phive', `Phive/ControllerSetParam/${JF}.phive__ControllerSetParam.bgyml`), r => ({
    ControllerEntityNamePathAry: [{ FilePath: 'Work/Phive/RigidBodyControllerEntityParam/StageDefault.phive__RigidBodyControllerEntityParam.gyml', Name: 'MainController' }],
    RigidBodyEntityNamePathAry: [{ FilePath: 'Work/Phive/RigidBodyEntityParam/StageDefault.phive__RigidBodyEntityParam.gyml', Name: 'StageDefault' }],
    ShapeNamePathAry: [{ FilePath: `Work/Phive/ShapeParam/${NEWN}_A.phive__ShapeParam.gyml`, Name: 'StageDefault' }] })));
  adds.phive.set(`Phive/ShapeParam/${NEWN}_A.phive__ShapeParam.bgyml`, edit(g('phive', `Phive/ShapeParam/${SRCN}_A.phive__ShapeParam.bgyml`), r => deepStrings(r, ren)));
  const mn = part.min, mx = part.max, c = [0, 1, 2].map(a => (mn[a] + mx[a]) / 2), R = Math.hypot(mx[0] - c[0], mx[1] - c[1], mx[2] - c[2]);
  const rh = pbyml(g('actorinfo', `Gyml/ActorInfoGParam/${A0}.game__ActorInfoGParam.bgyml`)).root.RenderModelHeapSize.Default.v;
  const V = v => ({ X: v[0], Y: v[1], Z: v[2] });
  adds.actorinfo.set(`Gyml/ActorInfoGParam/${A1}.game__ActorInfoGParam.bgyml`, edit(g('actorinfo', `Gyml/ActorInfoGParam/${JF}.game__ActorInfoGParam.bgyml`), r => {
    r.ActorPath = `Work/Gyml/ActorGParam/${A1}.gear__ActorGParam.gyml`; r.ModelInfoPath = `Work/Gyml/Component/ModelInfoGParam/${A1}.gear__ModelInfoGParam.gyml`;
    r.LoadDist = 4000; r.CalcDist = 4000; r.ActorRadius = R + 10; r.ModelRadius = R; r.ModelAABBMin = V(mn); r.ModelAABBMax = V(mx); r.ModelCenter = V(c);
    r.RenderModelHeapSize.Default = T.i32(rh); r.DrawArraySize = T.u32(1); }));
  adds.fmdbsummary.set(`Gyml/FmdbExSummaryGParam/${NEWN}.${NEWN}_A.gear__FmdbExSummaryGParam.bgyml`, edit(g('fmdbsummary', `Gyml/FmdbExSummaryGParam/${SRCN}.${SRCN}_A.gear__FmdbExSummaryGParam.bgyml`), r => {
    r.BoundingMin = V(mn); r.BoundingMax = V(mx); r.SphereBBCenter = V(c); r.SphereBBRadius = R; }));
  // this part's own textures (renamed before anything else shortens strings in the pool)
  const src = texNames && Object.keys(texNames).length ? renameStrings(central.slice(), texNames) : central;
  const bf = writeModel(src, part.geom, NEWN + '_A', { allLods: true });
  const col = writeBphsh(templ, part.col.tris, part.col.mats);
  return { adds, A1, raw: [[`Model/${NEWN}.${NEWN}_A.bfres`, bf.bytes], [`Phive/Shape/Dcc/${NEWN}_A.Nin_Ounce_NVN2.bphsh`, col.bytes]], report: bf.report,
    tags: [[`Work/Gyml/ActorGParam/${JF}`, A1], [`Work/Gyml/Component/ModelInfoGParam/${JF}`, A1], [`Work/Gyml/Component/PhysicsGParam/${JF}`, A1]] };
}

/**
 * rd(path) -> raw bytes of a romfs file (still .zs-compressed where the game's is)
 * spec: { display, cup, stageType, parts:[{name, pos, min, max, geom, col:{tris,mats}}], lap, route, actors }
 * returns Map(romfs path -> bytes ready to write) and a report
 */
export async function buildNewSlot(rd, spec, progress = () => {}) {
  // spec.slot (track packs): another slot's names. SZ 'XXXXXXX_00' and CZ 'Race_XXXXXXX_A_00' must be the same length as
  // Rainbow Road's (stage files are renamed in place); tag: 4 letters that replace 'CTrk' in the track's part and texture names
  const SL = spec.slot ? { ...SLOT, ...spec.slot } : SLOT, { SA, SZ, CA, CZ } = SL, TAG = SL.tag || 'CTrk', SZ7 = SZ.slice(0, SZ.length - 3), files = new Map(), sizes = new Map();
  if (SZ.length !== SA.length || CZ.length !== CA.length || TAG.length !== 4) throw new Error('slot names must be the same length as Rainbow Road\'s');
  if (spec.slot) spec = { ...spec, parts: spec.parts.map(pt => ({ ...pt, name: pt.name.replace('CTrk', TAG) })) };
  const V = await gameVersion(rd);
  if (!V) throw new Error('this RomFS has no System/Resource/ResourceSizeTable.Product.###… file: pick the game\'s romfs folder (for 1.1 and later, the update\'s romfs)');
  const R = async p => { const b = await rd(p); if (!b) throw new Error('missing from the dump: ' + p + (p.includes(V) ? ` (your dump is version ${verLabel(V)})` : '')); return b; };
  const Rz = async p => zsDecompress(await R(p));
  const ren = b => replaceBytes(b, [[SA, SZ], [CA, CZ]]);
  const putZ = (p, raw) => { files.set(p, zsStore(raw)); };
  const warnings = [];
  progress('Reading the game files…');
  const ARCN = { actor: 'actor_general_format', modelinfo: 'modelinfo_general_format', phwe: 'phwe_general_format', phive: 'phive_general_format', actorinfo: 'actorinfo_general_format', fmdbsummary: 'fmdbsummary_general_format' };
  const ARraw = {}, AR = {};
  for (const [k, n] of Object.entries(ARCN)) { ARraw[k] = await Rz(`System/GymlArchive/${n}.Product_${V}.sarc.zs`); AR[k] = parseSarc(ARraw[k]); }
  const central = await Rz(`Model/${SRCN}.${SRCN}_A.bfres.zs`);
  const templ = await Rz(`Phive/Shape/Dcc/${SRCN}_A.Nin_Ounce_NVN2.bphsh.zs`);
  // the track's parts: model + collision + params
  progress('Writing the track model and collision…');
  const P = { adds: {}, tags: [], names: [], report: [] };
  // textures: one file per (image, slot), plus a flat normal map and a black glow map per slot that shows an image
  const ST = slotTextures(central), texFiles = new Map(), texIds = new Map(), flats = new Set();
  const sidx = slot => String(MAT[slot]).padStart(2, '0');
  // one texture file per image, whatever look it's drawn with (materials find textures by name)
  const albName = id => { if (!texIds.has(id)) texIds.set(id, { name: `${TAG}Tex${String(texIds.size).padStart(3, '0')}_Alb`, id, mask: false }); return texIds.get(id).name; };
  // pictures from the game's own courses: copied under a short name, with their own normal and surface maps when they have them
  const gameExtra = new Map();
  for (const part of spec.parts) for (const id of Object.values(part.tex || {})) {
    const tx = spec.textures.get(id); if (!tx?.game || gameExtra.has(id)) continue;
    const base = tx.game.replace(/_Alb$/, ''), get = async suf => { try { const b = await rd(`Tex/${base}_${suf}.bntx.zs`); return b ? zsDecompress(b) : null; } catch { return null; } };
    gameExtra.set(id, { nrm: await get('Nrm'), mix: await get('Mix'), emm: await get('Emm') });
  }
  const texRenames = part => {
    const m = {};
    for (const [slot, id] of Object.entries(part.tex || {})) {
      const t = ST[slot]; if (!t || !t.alb) continue;
      m[t.alb] = albName(id);
      const gx = gameExtra.get(id), own = spec.textures.get(id)?.nrm;
      if ((gx?.nrm || own) && t.nrm) m[t.nrm] = albName(id).replace(/_Alb$/, '_Nrm');   // its own normal map (the game's, or one you picked)
      else if (t.nrm) { m[t.nrm] = `${TAG}Flat_${sidx(slot)}_Nrm`; flats.add(slot + '|nrm'); }
      if (gx?.emm && t.emm) m[t.emm] = albName(id).replace(/_Alb$/, '_Emm');   // its glow (Rainbow Road)
      else if (t.emm) { m[t.emm] = `${TAG}Black_${sidx(slot)}_Emm`; flats.add(slot + '|emm'); }
      if ((gx?.mix || spec.textures.get(id)?.mix) && t.mix) m[t.mix] = albName(id).replace(/_Alb$/, '_Mix');   // its own surface map (the game's, or one you picked)
      else if (t.mix) { m[t.mix] = `${TAG}Mix_${sidx(slot)}_Mix`; flats.add(slot + '|mix'); }   // the surface settings without the original pattern
      if (t.msk) { m[t.msk] = albName(id).replace(TAG + 'Tex', TAG + 'Msk').replace(/_Alb$/, '_Msk'); texIds.get(id).mask = true; }   // see-through: the mask comes from the image's alpha
    }
    return m;
  };
  for (const part of spec.parts) {
    const f = partFiles(AR, part, central, templ, texRenames(part));
    for (const [k, m] of Object.entries(f.adds)) { P.adds[k] = P.adds[k] || new Map(); for (const [n, b] of m) P.adds[k].set(n, b); }
    for (const [p, b] of f.raw) { putZ(p + '.zs', b); sizes.set(p, b.length); }
    P.tags.push(...f.tags); P.names.push(f.A1); P.report.push(f.report);
  }
  // templates: the game's own textures of the right kind, from small to big; each image uses the smallest one that's big enough
  const tmpl = async kind => { const out = []; for (const t of Object.values(ST)) if (t[kind] && !out.some(o => o.src === t[kind])) { const raw = await rd(`Tex/${t[kind]}.bntx.zs`); if (!raw) continue; const b = zsDecompress(raw); out.push({ src: t[kind], b, w: bntxInfo(b).width }); } return out.sort((a, c) => a.w - c.w); };
  const pick = (list, want) => list.find(o => o.w >= want) || list[list.length - 1];
  const albT = texIds.size ? (await tmpl('alb')).filter(o => (bntxInfo(o.b).format & 0xff) === 0x06) : [];   // colour (sRGB) textures
  if (texIds.size && !albT.length) throw new Error('no colour texture to use as a template');
  const mskT = [...texIds.values()].some(t => t.mask) ? await tmpl('msk') : [];
  const nrmT = [...texIds.values()].some(t => spec.textures.get(t.id)?.nrm) ? await tmpl('nrm') : [];
  const mixT = [...texIds.values()].some(t => spec.textures.get(t.id)?.mix) ? await tmpl('mix') : [];
  let ti = 0;
  for (const { name, id, mask } of texIds.values()) {
    progress(`Writing textures… ${++ti} of ${texIds.size} (big ones take a few seconds each)`); await new Promise(r => setTimeout(r, 0));
    const tx = spec.textures.get(id); if (!tx) throw new Error('missing image for ' + id);
    if (tx.game) {   // the game's own picture (and its normal / surface maps), renamed
      const raw = await rd(`Tex/${tx.game}.bntx.zs`); if (!raw) throw new Error(`missing from the dump: Tex/${tx.game}.bntx.zs`);
      const put = (b, from, to) => { const out = renameBntx(b, from, to); putZ(`Tex/${to}.bntx.zs`, out); sizes.set(`Tex/${to}.bntx`, out.length); };
      put(zsDecompress(raw), tx.game, name);
      const gx = gameExtra.get(id), base = tx.game.replace(/_Alb$/, '');
      if (gx?.nrm) put(gx.nrm, base + '_Nrm', name.replace(/_Alb$/, '_Nrm'));
      if (gx?.mix) put(gx.mix, base + '_Mix', name.replace(/_Alb$/, '_Mix'));
      if (gx?.emm) put(gx.emm, base + '_Emm', name.replace(/_Alb$/, '_Emm'));
      continue;
    }
    const get = typeof tx === 'function' ? tx : tx.get, want = Math.min(2048, Math.max(512, typeof tx === 'function' ? 1024 : Math.max(tx.w, tx.h)));
    const T = pick(albT, want);
    const out = renameBntx(replaceBntx(T.b, (l, w, h) => get(l, w, h)), T.src, name);
    putZ(`Tex/${name}.bntx.zs`, out); sizes.set(`Tex/${name}.bntx`, out.length);
    if (tx.nrm && nrmT.length) {   // your normal map: the game keeps X in RGB and Y in alpha (a flat one is 128 everywhere)
      const N = pick(nrmT, Math.min(2048, Math.max(512, Math.max(tx.nrm.w, tx.nrm.h)))), nname = name.replace(/_Alb$/, '_Nrm');
      const nout = renameBntx(replaceBntx(N.b, (l, w, h) => { const p = tx.nrm.get(l, w, h), o = new Uint8Array(p.length);
        for (let i = 0; i < p.length; i += 4) { const x = p[i], y = tx.nrm.flipY ? 255 - p[i + 1] : p[i + 1]; o[i] = o[i + 1] = o[i + 2] = x; o[i + 3] = y; } return o; }, true), N.src, nname);
      putZ(`Tex/${nname}.bntx.zs`, nout); sizes.set(`Tex/${nname}.bntx`, nout.length);
    }
    if (tx.mix && mixT.length) {   // your surface map (_Mix: shine, metal and the like, in the game's own channels): written as it is
      const X = pick(mixT, Math.min(2048, Math.max(512, Math.max(tx.mix.w, tx.mix.h)))), xname = name.replace(/_Alb$/, '_Mix');
      const xout = renameBntx(replaceBntx(X.b, (l, w, h) => tx.mix.get(l, w, h)), X.src, xname);
      putZ(`Tex/${xname}.bntx.zs`, xout); sizes.set(`Tex/${xname}.bntx`, xout.length);
    }
    if (mask) {   // white = solid, black = cut away
      const M = pick(mskT, want), mname = name.replace(TAG + 'Tex', TAG + 'Msk').replace(/_Alb$/, '_Msk');
      const mout = renameBntx(replaceBntx(M.b, (l, w, h) => { const p = get(l, w, h, true), o = new Uint8Array(p.length); for (let i = 0; i < p.length; i += 4) { const a = p[i + 3] >= 128 ? 255 : 0; o[i] = o[i + 1] = o[i + 2] = a; o[i + 3] = 255; } return o; }), M.src, mname);
      putZ(`Tex/${mname}.bntx.zs`, mout); sizes.set(`Tex/${mname}.bntx`, mout.length);
    }
  }
  for (const f of flats) {
    const [slot, kind] = f.split('|'), src = ST[slot][kind];
    const name = { nrm: `${TAG}Flat_${sidx(slot)}_Nrm`, emm: `${TAG}Black_${sidx(slot)}_Emm`, mix: `${TAG}Mix_${sidx(slot)}_Mix` }[kind];
    // normal maps keep X in RGB and Y in alpha: flat is 128 everywhere. Mix: that look's average values, so it keeps its shine but loses its pattern
    const col = { nrm: [128, 128, 128, 128], emm: [0, 0, 0, 255], mix: MIX_AVG[slot] || [160, 40, 160, 255] }[kind];
    const out = renameBntx(flatBntx(await Rz(`Tex/${src}.bntx.zs`), col), src, name);
    putZ(`Tex/${name}.bntx.zs`, out); sizes.set(`Tex/${name}.bntx`, out.length);
  }
  // course file + CPU data (once the track is finished: the course edited in the course view, plus the model's parts)
  progress('Writing the course…');
  const banc = spec.docBytes ? courseFromDoc(spec.docBytes, spec) : buildCourse(await Rz(`Banc/${CA}[Game03].bcett.byml.zs`), { ...spec, actors: [...spec.parts.map(p => ({ name: p.name + '_A_00', pos: p.pos })), ...spec.actors] });
  { // lap path boxes that float above the road: karts on the road would count as out of bounds
    const nv = v => (v && typeof v === 'object' && 'v' in v) ? Number(v.v) : Number(v); let up = 0, thin = 0;
    for (const rl of pbyml(banc.bytes).root.Rails || []) if (rl.Name === 'LapPathGraph') for (const p of rl.Points) {
      const sz = (p.RectSize || [25, 20]).map(nv), o = (p.RectOffset || [0, 10]).map(nv); if (o[1] - sz[1] / 2 > 0.5) up++; if (sz[0] < 12) thin++; }
    if (up) warnings.push(`${up} lap path point${up > 1 ? 's have boxes' : ' has a box'} starting above the road, so karts there count as out of bounds: in the course view, select the lap path and make Up shift half the Height`);
    if (thin) warnings.push(`${thin} lap path point${thin > 1 ? 's are' : ' is'} under 12 m wide: karts near the road's edges may count as out of bounds`);
  }
  // racing in the open world: the course is moved to its Free Roam spot (world coordinates, like the game's own courses),
  // and its model parts and objects come from the world copy only, so they aren't there twice
  let worldActors = null, worldStart = null, worldStartRot = null;
  // a course's file moved to the open world: returns its new bytes, the objects that go into the world instead, and its start
  const worldMove = bytes => {
    const cdoc = pbyml(bytes), r = cdoc.root, fr = spec.freeRoam, c = Math.cos(fr.yaw || 0), sn = Math.sin(fr.yaw || 0), num = v => (v && typeof v === 'object' && 'v' in v) ? Number(v.v) : Number(v);
    const place = p => { const x = num(p[0]) - START[0], y = num(p[1]) - START[1], z = num(p[2]) - START[2]; return [Math.fround(fr.x + c * x + sn * z), Math.fround(fr.y + y), Math.fround(fr.z - sn * x + c * z)]; };
    const turn = rt => [num(rt?.[0] ?? 0), Math.fround(num(rt?.[1] ?? 0) + (fr.yaw || 0)), num(rt?.[2] ?? 0)];
    const objs = r.Actors.filter(a => /^CmnObj_/.test(a.Name || '') && a.Translate).map(a => ({ ...a }));
    r.Actors = r.Actors.filter(a => !/^CmnObj_/.test(a.Name || ''));
    for (const a of r.Actors) { if (a.Translate) a.Translate = place(a.Translate); if (a.Rotate) a.Rotate = turn(a.Rotate); }
    for (const rl of r.Rails || []) for (const p of rl.Points) { p.Translation = place(p.Translation); if (p.Rotate) p.Rotate = turn(p.Rotate); }
    const ca = {}; for (const a of r.Actors) ca[a.Name] = T.i32((ca[a.Name]?.v || 0) + 1); r.CountActor = ca;
    const ps = [...r.Actors.filter(a => a.Translate).map(a => a.Translate.map(num)), ...objs.map(a => place(a.Translate))];
    if (ps.length) r.AABB = { Max: [0, 1, 2].map(k => Math.fround(_mx(ps.map(p => p[k])) + 150)), Min: [0, 1, 2].map(k => Math.fround(_mn(ps.map(p => p[k])) - 150)) };
    const st = r.Actors.find(a => a.Name === 'StartPosition' && !a.Dynamic?.StartPositionId) || r.Actors.find(a => a.Name === 'StartPosition');
    return { bytes: wbyml(cdoc, r, true), objs, start: st ? st.Translate.map(num) : [fr.x, fr.y, fr.z], startRot: st?.Rotate ? st.Rotate.map(num) : [0, fr.yaw || 0, 0] };
  };
  if (spec.freeRoam) { const m = worldMove(banc.bytes); banc.bytes = m.bytes; worldActors = m.objs; worldStart = m.start; worldStartRot = m.startRot; }
  putZ(`Banc/${CZ}[Game03].bcett.byml.zs`, banc.bytes); sizes.set(`Banc/${CZ}[Game03].bcett.byml`, banc.bytes.length);
  files.set(`Banc/PathAdditionalData/${CZ}.byml`, writePad(banc.routeHashes));
  // extra routes (lap-type variants, like Crown City's): their own course files sharing the track's model. In the open
  // world their objects come from the main route's (those are placed in the world once, for every route)
  const variants = [];
  for (const v of spec.variants || []) {
    if (!/^[B-Y]$/.test(v.letter || '') || !v.docBytes) continue;
    const CV = `Race_${SZ7}_${v.letter}_00`, b = courseFromDoc(v.docBytes, spec); let start = null;
    if (spec.freeRoam) { const m = worldMove(b.bytes); b.bytes = m.bytes; start = m.start; }
    putZ(`Banc/${CV}[Game03].bcett.byml.zs`, b.bytes); sizes.set(`Banc/${CV}[Game03].bcett.byml`, b.bytes.length);
    files.set(`Banc/PathAdditionalData/${CV}.byml`, writePad(b.routeHashes));
    variants.push({ ...v, CV, banc: b, start, ren: x => replaceBytes(x, [[SA, SZ], [CA, CV]]) });
  }
  // a course in the world sits in a world course's scene (Koopa Troopa Beach's race uses Scene/KoopaTroopaBeach_00): the nearest one's
  let worldScene = null;
  if (worldStart) {
    const want = mmh3(spec.freeRoam.stage || 'KoopaTroopaBeach_00'), num = v => (v && typeof v === 'object' && 'v' in v) ? Number(v.v) : Number(v);
    for (const row of pbyml(await Rz(`RSDB/Course.Product.${V}.rstbl.byml.zs`)).root) if (num(row.FromStageIdValue) === want && /^Work\/Gyml\/CourseGParam\/Race_/.test(row.__RowId) && row.WorldTransformParentFile) { worldScene = row.WorldTransformParentFile; break; }
    if (!worldScene) worldScene = 'Work/Banc/Scene/KoopaTroopaBeach_00.bcett.json';
  }
  // general_format: course, stage, cup, UI ids, map icon
  progress('Adding the new stage…');
  const G = await Rz(`System/GymlArchive/general_format.Product_${V}.sarc.zs`), GF = parseSarc(G);
  const g = k => { const b = GF.get(k); if (!b) throw new Error('missing ' + k); return b; };
  const add = new Map(), rep = new Map(), hSZ = mmh3(SZ), hCZ = mmh3(CZ);
  // minimap: drawn from this course's lap path (and framed to fit it) by the editor
  const mmKey = `Gyml/MiniMapCourseGParam/MiniMap_${CA}.game__MiniMapCourseGParam.bgyml`;
  let mm = null;
  if (spec.minimap) { progress('Drawing the minimap…'); mm = await spec.minimap(pbyml(banc.bytes).root, ren(await Rz(`Layout/MiniMap_${CA}.Nin_Ounce_NVN2.bntx.zs`)), pbyml(g(mmKey)).root, worldStart ? { stage: spec.freeRoam.stage || 'KoopaTroopaBeach_00' } : null); }
  for (const v of variants) if (spec.minimap) { progress(`Drawing route ${v.letter}'s minimap…`); v.mm = await spec.minimap(pbyml(v.banc.bytes).root, v.ren(await Rz(`Layout/MiniMap_${CA}.Nin_Ounce_NVN2.bntx.zs`)), pbyml(g(mmKey)).root, worldStart ? { stage: spec.freeRoam.stage || 'KoopaTroopaBeach_00' } : null); }
  for (const C of [CZ, ...variants.map(v => v.CV)]) add.set(`Gyml/CourseGParam/${C}.game__CourseGParam.bgyml`, edit(g(`Gyml/CourseGParam/${CA}.game__CourseGParam.bgyml`), r => {
    r.BancFile = r.BancFile.replace(CA, C); r.FromStageIdValue = T.u32(hSZ);
    delete r.LapNum; delete r.ForceUseTime; delete r.DefaultTimeAttackTime; r.DefaultRaceTime = 3;
    if (spec.hour !== undefined && spec.hour !== null) { r.ForceUseTime = true; r.DefaultRaceTime = spec.hour; r.DefaultTimeAttackTime = spec.hour; }   // a fixed time of day, like Rainbow Road's night
    if (spec.raceType === 'loop' || spec.raceType === 'ab') r.LapNum = T.i32(0);   // a section race, like Rainbow Road and the one-way courses: the lap path's lap checks count the sections
    else if (spec.laps && spec.laps !== 3) r.LapNum = T.i32(spec.laps);
    // (IsForbidEnvirionmentalEffect, from Rainbow Road, stays on: without it the weather effects drew diagonal streaks over imported tracks' walls)
    if (worldScene) { delete r.WorldTransformParentActor; r.WorldTransformParentFile = worldScene; r.AudienceType = 'NoFile'; } }));
  // where the world starts loading in: the start line (Rainbow Road's is up in the sky)
  add.set(`Gyml/PreloadCourseGParam/${CZ}.game__PreloadCourseGParam.bgyml`, worldStart
    ? edit(g(`Gyml/PreloadCourseGParam/${CA}.game__PreloadCourseGParam.bgyml`), r => { r.Position = { X: Math.fround(worldStart[0]), Y: Math.fround(worldStart[1]), Z: Math.fround(worldStart[2]) }; })
    : g(`Gyml/PreloadCourseGParam/${CA}.game__PreloadCourseGParam.bgyml`));
  add.set(`Gyml/MiniMapCourseGParam/MiniMap_${CZ}.game__MiniMapCourseGParam.bgyml`, mm && mm.cam ? edit(g(mmKey), r => { r.CamPos.X = mm.cam.x; r.CamPos.Z = mm.cam.z; r.CamRot.Y = mm.cam.yaw; r.CamSizeX = mm.cam.size; }) : g(mmKey));
  for (const v of variants) {
    add.set(`Gyml/PreloadCourseGParam/${v.CV}.game__PreloadCourseGParam.bgyml`, v.start
      ? edit(g(`Gyml/PreloadCourseGParam/${CA}.game__PreloadCourseGParam.bgyml`), r => { r.Position = { X: Math.fround(v.start[0]), Y: Math.fround(v.start[1]), Z: Math.fround(v.start[2]) }; })
      : g(`Gyml/PreloadCourseGParam/${CA}.game__PreloadCourseGParam.bgyml`));
    add.set(`Gyml/MiniMapCourseGParam/MiniMap_${v.CV}.game__MiniMapCourseGParam.bgyml`, v.mm && v.mm.cam ? edit(g(mmKey), r => { r.CamPos.X = v.mm.cam.x; r.CamPos.Z = v.mm.cam.z; r.CamRot.Y = v.mm.cam.yaw; r.CamSizeX = v.mm.cam.size; }) : g(mmKey));
  }
  add.set(`Gyml/CourseAreaGParam/${SZ}.game__CourseAreaGParam.bgyml`, edit(g(`Gyml/CourseAreaGParam/${SA}.game__CourseAreaGParam.bgyml`), r => { r.NormalCourse = [T.u32(hCZ)]; if (spec.stageType) r.StageType = spec.stageType; if (spec.vsExtra) r.StageType = 'Underground';
    // the extra routes, as the lap types the game offers for a course (1.8's way of adding Crown City-style variants)
    if (variants.length) r.AdditionalCourseAttachments = variants.map(v => ({ NormalCourse: T.u32(mmh3(v.CV)), Weight: T.i32(75) }));
    if (spec.pictures?.badge) r.UIStageIcon = `Sign_${TAG}New`; if (spec.pictures?.map) r.UIGrandprixStageIcon = `LSign_${SZ7}`; }));
  add.set(`Gyml/StageWarpGParam/${SZ}.game__StageWarpGParam.bgyml`, g(`Gyml/StageWarpGParam/${SA}.game__StageWarpGParam.bgyml`));
  let k = 'Gyml/UIIDConverterGParam/Stage.game__UIIDConverterGParam.bgyml'; // the stage's UI number. 30 (a 31st stage) is past the end of the course menus' 30 stage records, so a track pack
  // (SL.uiStandIn) borrows the number of the stage it was copied from: its menus then use that stage's record, not a missing one
  rep.set(k, edit(g(k), r => { r.StrToInt[SZ] = SL.uiStandIn && r.StrToInt[SA] != null ? cloneTyped(r.StrToInt[SA]) : T.i32(30); }));
  k = 'Gyml/Map2DIconDicGParam/StageIllust.game__Map2DIconDicGParam.bgyml';
  rep.set(k, edit(g(k), r => { const walk = o => { if (!o || typeof o !== 'object' || o instanceof Typed) return false;
      if (o[SA] && o[SA].Position) { o[SZ] = cloneTyped(o[SA]); o[SZ].Position = { X: SL.ICON[0], Y: SL.ICON[1] }; delete o[SZ].Type; return true; }
      return Object.values(o).some(walk); };
    if (!walk(r)) throw new Error('icon dict not found'); }));
  // VS and Time Trials: picking this stage on the course map starts the new track instead (Grand Prix keeps the real course)
  if (spec.vsStage) { k = `Gyml/CourseAreaGParam/${spec.vsStage}.game__CourseAreaGParam.bgyml`; rep.set(k, edit(g(k), r => { r.NormalCourse = [T.u32(hCZ)]; })); }
  // (test) its own stage in VS and Time Trials: the 31st in the course map's list, picked by its own icon
  if (spec.vsExtra) { k = 'Gyml/UICourseSelectStageList/Normal.game__UICourseSelectStageList.bgyml';
    rep.set(k, edit(g(k), r => { const nv = x => Number(x && typeof x === 'object' && 'v' in x ? x.v : x); if (!r.StageList.some(x => nv(x) === hSZ)) r.StageList.push(T.u32(hSZ)); })); }
  if (spec.cup) { k = `Gyml/GrandprixCupSettingGParam/${spec.cup}.game__GrandprixCupSettingGParam.bgyml`; rep.set(k, edit(g(k), r => { r.CourseList[0] = { CourseId: T.u32(hCZ) }; })); }
  // (test) World 2: the track and everything round it as its own island scene, the way the game's secret tunnel islands
  // (Storm Clouds, Choco Mountain...) are separate scenes. It takes the place of Choco Mountain's island, so driving into
  // that tunnel in Free Roam goes there. The scene is the game's blank island without its room: our objects, an island
  // area box round them and the two tunnels (in and out) just behind the start line
  if (spec.island) {
    progress('Making World 2…');
    const num = v => (v && typeof v === 'object' && 'v' in v) ? Number(v.v) : Number(v);
    const idoc = pbyml(await Rz('Banc/Island_Blank_00_Fix.bcett.byml.zs')), ir = idoc.root, cr = pbyml(banc.bytes).root;
    const rel = p => [Math.fround(num(p[0]) - START[0]), Math.fround(num(p[1]) - START[1]), Math.fround(num(p[2]) - START[2])];
    const used = new Set(), H = () => { let h; do h = BigInt.asUintN(64, (BigInt(rnd32()) << 32n) | BigInt(rnd32())); while (!h || used.has(String(h))); used.add(String(h)); return h; };
    const PF = 'Scene/Island_World2_00.bcett.json';
    const tunnels = ir.Actors.filter(a => a.Name === 'CmnObj_IslandTunnel000_A_00'), area = ir.Actors.find(a => a.Name === 'SystemObj_IslandArea_00');
    const objs = cr.Actors.filter(a => /^CmnObj_/.test(a.Name || '') && a.Translate).map(a => {
      const b = { Gyaml: a.Gyaml, Hash: T.u64(H()), InstanceId: uuid(), IsGridify: false, Name: a.Name, ParentPrefab: PF, Rotate: (a.Rotate || [0, 0, 0]).map(num), SRTHash: T.u32(rnd32()), Translate: rel(a.Translate) };
      if (LIFT_OBJ.test(a.Name)) b.Translate[1] = Math.fround(b.Translate[1] + 1);
      if (a.Scale) b.Scale = a.Scale; if (a.Dynamic) b.Dynamic = a.Dynamic; return b; });
    // which way the track runs at the start: from the lap path's first point to its second
    const lap = (cr.Rails || []).find(r => r.Name === 'LapPathGraph' && r.Points?.length > 1);
    let fw = [0, 1];
    if (lap) { const p0 = lap.Points[0].Translation.map(num), p1 = lap.Points[1].Translation.map(num), dx = p1[0] - p0[0], dz = p1[2] - p0[2], l = Math.hypot(dx, dz) || 1; fw = [dx / l, dz / l]; }
    const side = [fw[1], -fw[0]], yaw = Math.atan2(fw[0], fw[1]);
    const tpos = k => [Math.fround(-fw[0] * 30 + side[0] * (k ? -12 : 12)), 2.5, Math.fround(-fw[1] * 30 + side[1] * (k ? -12 : 12))];
    const tun = tunnels.map((t, k) => ({ ...t, Hash: T.u64(H()), InstanceId: uuid(), ParentPrefab: PF, Rotate: tunnelRot(yaw), SRTHash: T.u32(rnd32()), Translate: tpos(k) }));
    const ps = [...objs.map(a => a.Translate), ...tun.map(a => a.Translate), ...(spec.extent || []).map(rel)];   // the model's own corners too (a big terrain reaches far past its objects)
    const mn = [0, 1, 2].map(k => _mn(ps.map(p => p[k]))), mx = [0, 1, 2].map(k => _mx(ps.map(p => p[k])));
    const box = { ...area, Hash: T.u64(H()), InstanceId: uuid(), ParentPrefab: PF, SRTHash: T.u32(rnd32()),
      Scale: [0, 1, 2].map(k => Math.fround((mx[k] - mn[k]) / 2 + (k === 1 ? 200 : 400))), Translate: [0, 1, 2].map(k => Math.fround((mx[k] + mn[k]) / 2)) };
    ir.Actors = [box, ...tun, ...objs];
    const ca = {}; for (const a of ir.Actors) ca[a.Name] = T.i32((ca[a.Name]?.v || 0) + 1); ir.CountActor = ca;
    ir.AABB = { Max: mx.map((v, k) => Math.fround(v + (k === 1 ? 200 : 400))), Min: mn.map((v, k) => Math.fround(v - (k === 1 ? 200 : 400))) };   // wide margins: a terrain model reaches past its objects
    ir.FilePath = PF;
    const ib = wbyml(idoc, ir, true); putZ('Banc/Island_World2_00.bcett.byml.zs', ib); sizes.set('Banc/Island_World2_00.bcett.byml', ib.length);
    k = 'Gyml/IslandInfo/Chocomountain_00.game__IslandInfo.bgyml';
    rep.set(k, edit(g(k), r => { r.Banc = 'Work/Banc/Scene/Island_World2_00.bcett.json'; }));

    // its own way in, quicker to reach than the Choco Mountain one: a tunnel sensor 20 m in front of Mario Circuit's Free Roam
    // warp point (warp there, drive straight on) and the tunnel you come back out of 45 m in front of it, facing on
    { const WP = 'Banc/World_Game03/WorldResident.bcett.byml', wdoc = pbyml(await Rz(WP + '.zs')), w = wdoc.root;
      const cp = w.Actors.find(a => a.Name === 'System_CoursePoint' && /SFCMarioCircuit_00/.test(String(a.Dynamic?.Path)));
      const sen0 = w.Actors.find(a => a.Name === 'SystemObj_IslandTunnelSensor_00' && /Chocomountain_00/.test(String(a.Dynamic?.IslandInfo)));
      const tun0 = sen0 && w.Actors.find(a => num(a.Hash) === num(sen0.Links?.[0]?.Dst));
      if (cp && sen0 && tun0) {
        for (const a of w.Actors) used.add(String(num(a.Hash)));
        const p = cp.Translate.map(num), cy = num(cp.Rotate?.[1] ?? 0), f = [Math.sin(cy), Math.cos(cy)];
        const at = d => [Math.fround(p[0] + f[0] * d), Math.fround(p[1]), Math.fround(p[2] + f[1] * d)];
        const hs = H(), ht = H(), grp = { ...(cp.AreaName ? { AreaName: cp.AreaName } : {}), ...(cp.ParentPrefab ? { ParentPrefab: cp.ParentPrefab } : {}) };
        w.Actors.push({ ...tun0, ...grp, Hash: T.u64(ht), InstanceId: uuid(), Rotate: tunnelRot(cy), SRTHash: T.u32(rnd32()), Translate: at(45) });
        w.Actors.push({ ...sen0, ...grp, Hash: T.u64(hs), InstanceId: uuid(), Links: [{ ...sen0.Links[0], Dst: T.u64(ht), Src: T.u64(hs) }],
          Rotate: [0, 0, 0], Scale: [6, 4, 6], SRTHash: T.u32(rnd32()), Translate: (q => [q[0], Math.fround(q[1] + 3), q[2]])(at(20)) });
        for (const n of ['SystemObj_IslandTunnelSensor_00', 'CmnObj_IslandTunnel000_A_00']) w.CountActor[n] = T.i32(num(w.CountActor[n] || 0) + 1);
        const out = wbyml(wdoc, w, true); putZ(WP + '.zs', out); sizes.set(WP, out.length);
      } else warnings.push("World 2: couldn't find Mario Circuit's warp point, so the only way in is Choco Mountain's tunnel");
    }
  }
  const newG = sarcAdd(G, add, rep); putZ(`System/GymlArchive/general_format.Product_${V}.sarc.zs`, newG); sizes.set(`System/GymlArchive/general_format.Product_${V}.sarc`, newG.length);
  for (const [kk, m] of Object.entries(P.adds)) {
    const rel = `System/GymlArchive/${ARCN[kk]}.Product_${V}.sarc`, nb = sarcAdd(ARraw[kk], m, new Map());
    putZ(rel + '.zs', nb); sizes.set(rel, nb.length);
  }
  // RSDB
  progress('Updating the game\'s tables…');
  let courseRows = rsdbCourse(await Rz(`RSDB/Course.Product.${V}.rstbl.byml.zs`), CA, CZ, hSZ);
  for (const v of variants) courseRows = rsdbCourse(courseRows, CA, v.CV, hSZ);
  if (worldScene) courseRows = edit(courseRows, rows => { for (const C of [CZ, ...variants.map(v => v.CV)]) { const row = rows.find(x => x.__RowId.includes('/' + C + '.')); row.WorldTransformParentActor = ''; row.WorldTransformParentFile = worldScene; row.AudienceType = 'NoFile'; } });
  putZ(`RSDB/Course.Product.${V}.rstbl.byml.zs`, courseRows);
  putZ(`RSDB/Tag.Product.${V}.rstbl.byml.zs`, rsdbTags(await Rz(`RSDB/Tag.Product.${V}.rstbl.byml.zs`), [[CA, CZ], ...variants.map(v => [CA, v.CV]), ['Work/Gyml/CourseAreaGParam/' + SA, SZ], ...P.tags]));
  putZ(`RSDB/CourseArea.Product.${V}.rstbl.byml.zs`, rsdbCloneRow(await Rz(`RSDB/CourseArea.Product.${V}.rstbl.byml.zs`), SA, SZ, spec.display));
  let actorRows = await Rz(`RSDB/Actor.Product.${V}.rstbl.byml.zs`);
  for (const a of P.names) actorRows = rsdbCloneRow(actorRows, JF, a, 'Custom track part');
  putZ(`RSDB/Actor.Product.${V}.rstbl.byml.zs`, actorRows);
  // names: updates keep new text in Mals/<region>/Ver###.msarc; the base game has its names in the region's message archives
  const NEWLABS = [`Name_${CZ}`, `Adjust_Name_${CZ}`, `Name_${SZ}`, ...variants.flatMap(v => [`Name_${v.CV}`, `Adjust_Name_${v.CV}`])];
  const textOf = lab => { const v = variants.find(v => lab.endsWith(v.CV)); return utf16(v ? (v.name || `${spec.display} ${v.letter}`) : spec.display); };
  // the course menus and loading screen read names from the main message archive's course files (Course, CourseArea and
  // their "adjust" versions); updates also keep new text in Mals/<region>/Ver###.msarc
  const MAINMSG = [['Course.msbt', `Name_${CZ}`, `Name_${CA}`], ['Course(adjust).msbt', `Adjust_Name_${CZ}`, `Adjust_Name_${CA}`], ['CourseArea.msbt', `Name_${SZ}`, `Name_${SA}`], ['CourseArea(adjust).msbt', `Name_${SZ}`, `Name_${SA}`],
    ...variants.flatMap(v => [['Course.msbt', `Name_${v.CV}`, `Name_${CA}`], ['Course(adjust).msbt', `Adjust_Name_${v.CV}`, `Adjust_Name_${CA}`]])];
  for (const reg of ['EUen', 'USen']) {
    try {
      let named = false;
      const d = await rd(`Mals/${reg}/Ver${V}.msarc`).catch(() => null);
      if (d) {
        const m = parseMsbt(parseSarc(d).get(`Ver${V}.msbt`));
        const labels = m.texts.map((_, i) => m.labels[i]), texts = m.texts.slice();
        for (const lab of NEWLABS) { labels.push(lab); texts.push(textOf(lab)); }
        files.set(`Mals/${reg}/Ver${V}.msarc`, buildSarc1(`Ver${V}.msbt`, buildMsbt(m.hdr, labels, texts), d));
        named = true;
      }
      const mm = await rd(`Mals/${reg}/MsgMain.msarc`).catch(() => null);
      if (mm) {
        const sa = parseSarc(mm), rep2 = new Map();
        for (const [f, lab, like] of MAINMSG) {
          const b0 = rep2.get(f) || sa.get(f); if (!b0) continue;
          if (Object.values(parseMsbt(b0).labels).includes(lab)) continue;
          const nb = msbtAppend(b0, [[lab, textOf(lab)]], like); if (nb) rep2.set(f, nb);
        }
        if (rep2.size) { const out = sarcAdd(mm, new Map(), rep2); files.set(`Mals/${reg}/MsgMain.msarc`, out); sizes.set(`Mals/${reg}/MsgMain.msarc`, out.length); named = true; }
      }
      if (named) continue;
      const hit = await findNames(rd, reg, `Name_${CA}`);
      if (!hit) { warnings.push(`${reg}: no message file with Rainbow Road's name was found, so the track has no ${reg} name (it still works)`); continue; }
      const items = NEWLABS.map(l => [l, textOf(l)]);
      let nb = msbtAppend(hit.msbt, items, `Name_${CA}`), out;
      if (nb) out = sarcAdd(hit.sarcRaw, new Map(), new Map([[hit.file, nb]]));
      else { const dir = hit.file.includes('/') ? hit.file.slice(0, hit.file.lastIndexOf('/') + 1) : ''; out = sarcAdd(hit.sarcRaw, new Map([[dir + TAG + 'Names.msbt', buildMsbt(parseMsbt(hit.msbt).hdr, NEWLABS, items.map(x => x[1]))]]), new Map()); }
      if (hit.zs) { putZ(hit.path, out); sizes.set(hit.path.replace(/\.zs$/, ''), out.length); } else files.set(hit.path, out);
    } catch (e) { console.error(e); warnings.push(`${reg} name: ${e.message} (the track still works, without that name)`); }
  }
  // copies of Rainbow Road's stage files under the new names
  putZ(`Layout/MiniMap_${CZ}.Nin_Ounce_NVN2.bntx.zs`, mm ? mm.tex : ren(await Rz(`Layout/MiniMap_${CA}.Nin_Ounce_NVN2.bntx.zs`)));
  const bphsc = await R(`Phive/StaticCompoundBody/Course/${CA}.Nin_Ounce_NVN2.bphsc.zs`);
  files.set(`Phive/StaticCompoundBody/Course/${CZ}.Nin_Ounce_NVN2.bphsc.zs`, bphsc); sizes.set(`Phive/StaticCompoundBody/Course/${CZ}.Nin_Ounce_NVN2.bphsc`, zsDecompress(bphsc).length);
  for (const v of variants) {
    putZ(`Layout/MiniMap_${v.CV}.Nin_Ounce_NVN2.bntx.zs`, v.mm ? v.mm.tex : v.ren(await Rz(`Layout/MiniMap_${CA}.Nin_Ounce_NVN2.bntx.zs`)));
    files.set(`Phive/StaticCompoundBody/Course/${v.CV}.Nin_Ounce_NVN2.bphsc.zs`, bphsc); sizes.set(`Phive/StaticCompoundBody/Course/${v.CV}.Nin_Ounce_NVN2.bphsc`, zsDecompress(bphsc).length);
  }
  // the track's pictures: copies of Rainbow Road's, or your own (spec.pictures.course / map / badge: (w, h) => RGBA)
  const P2 = spec.pictures || {}, LAY = n => `Layout/${n}.Nin_Ounce_NVN2.bntx.zs`, putL = (p, raw) => { putZ(p, raw); sizes.set(p.replace(/\.zs$/, ''), raw.length); };
  const paint = (bntx, get) => replaceBntx(bntx, (l, w, h) => get(w, h));
  const shadowOf = get => (w, h) => { const src = get(w, h), out = new Uint8Array(w * h * 4), R = Math.max(2, Math.round(w / 40));
    const a = new Float32Array(w * h); for (let i = 0; i < w * h; i++) a[i] = src[i * 4 + 3] / 255;
    const blur = (inp, dx, dy) => { const o = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let k = -R; k <= R; k++) { const xx = x + dx * k, yy = y + dy * k; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += inp[yy * w + xx]; n++; } } o[y * w + x] = s / n; } return o; };
    const b = blur(blur(a, 1, 0), 0, 1); for (let i = 0; i < w * h; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255; out[i * 4 + 3] = Math.round(b[i] * 200); } return out; };
  const PIC = { C_StageL_: P2.course, C_StageS_: P2.course, LSign_: P2.map, MapStageSelect_: P2.map, MapStage_: P2.map, MapStageSh_: P2.map && shadowOf(P2.map) };
  for (const pre of ['C_StageL_', 'C_StageS_', 'LSign_', 'MapStageSelect_', 'MapStageSh_', 'MapStage_']) {
    const base = ren(await Rz(LAY(pre + SA)));
    putL(LAY(pre + SZ), PIC[pre] ? paint(base, PIC[pre]) : base);
  }
  if (P2.course) for (const v of ['A', 'B', 'C', 'D']) { const raw = await Rz(LAY(`C_ResultStage_${SA}_${v}`)).catch(() => null); if (raw) putL(LAY(`C_ResultStage_${SZ}_${v}`), paint(ren(raw), P2.course)); }
  if (P2.badge) putL(LAY(`Sign_${TAG}New`), paint(renameBntx(await Rz(LAY('Sign_Rainbow')), 'Sign_Rainbow', `Sign_${TAG}New`), P2.badge));   // (a texture's new name must end in the same letter)
  // the stand-in course in VS / Time Trials can show your pictures too (that changes them wherever the game shows that course)
  if (spec.vsStage && spec.picturesStandIn && (P2.course || P2.map || P2.badge)) {
    const area = pbyml(g(`Gyml/CourseAreaGParam/${spec.vsStage}.game__CourseAreaGParam.bgyml`)).root, typ = String(area.StageType || '');
    const own = async (name, get) => { if (!get) return; const raw = await Rz(LAY(name)).catch(() => null); if (raw) putL(LAY(name), paint(raw, get)); };
    for (const pre of ['C_StageL_', 'C_StageS_']) await own(pre + spec.vsStage, P2.course);
    for (const v of ['A', 'B', 'C', 'D']) await own(`C_ResultStage_${spec.vsStage}_${v}`, P2.course);
    for (const pre of ['MapStageSelect_', 'MapStage_']) await own(pre + spec.vsStage, P2.map);
    await own('MapStageSh_' + spec.vsStage, P2.map && shadowOf(P2.map));
    await own(`LSign_${typ}_00`, P2.map); await own(`Sign_${typ}`, P2.badge);
  }
  files.set(`Env/EnvStage${SZ}_Area_System.dlpa.zs`, await R(`Env/EnvStage${SA}_Area_System.dlpa.zs`));
  putZ(`Tex/Cubemap/EnvStage${SZ}_Area_System.cubes.bntx.zs`, ren(await Rz(`Tex/Cubemap/EnvStage${SA}_Area_System.cubes.bntx.zs`)));
  // music: a radio song takes over one stage's race music (its name points at the song's entry in M_Bgm.bars)
  if (spec.music && spec.music.song) {
    progress('Setting the music…');
    const M = 'Sound/Resource/M_Bgm.bars.zs', bars = await Rz(M), host = spec.music.host;
    const map = {}; for (const suf of ['', '_Fast', '_Pre', '_Pre_Short']) map['BGM_Stage_' + host + suf] = spec.music.song;
    const out = barsRepoint(bars, map); if (!out.changed) throw new Error('couldn\'t find ' + spec.music.song + ' or the ' + host + ' music in M_Bgm.bars');
    putZ(M, out.bytes);
  }
  // Free Roam: the track's model parts, item boxes, coins and other objects copied into the open world (WorldResident),
  // moved so the track's origin (the start line) lands at spec.freeRoam {x, y, z} and turned by yaw (radians)
  if (spec.freeRoam) {
    progress('Putting the track in Free Roam…');
    const WP = 'Banc/World_Game03/WorldResident.bcett.byml', wdoc = pbyml(await Rz(WP + '.zs')), w = wdoc.root;
    const fr = spec.freeRoam, c = Math.cos(fr.yaw || 0), sn = Math.sin(fr.yaw || 0), num = v => (v && typeof v === 'object' && 'v' in v) ? Number(v.v) : Number(v);
    const place = p => { const x = num(p[0]) - START[0], y = num(p[1]) - START[1], z = num(p[2]) - START[2];
      return [Math.fround(fr.x + c * x + sn * z), Math.fround(fr.y + y), Math.fround(fr.z - sn * x + c * z)]; };
    // the area the world groups nearby things under: the nearest existing object's
    let area = null, best = Infinity;
    for (const a of w.Actors) if (a.AreaName && /_Fix\.bcett\.json$/.test(a.AreaName) && a.Translate) { const d = Math.hypot(num(a.Translate[0]) - fr.x, num(a.Translate[2]) - fr.z); if (d < best) { best = d; area = a.AreaName; } }
    const used = new Set(w.Actors.map(a => String(num(a.Hash))));
    const H = () => { let h; do h = BigInt.asUintN(64, (BigInt(rnd32()) << 32n) | BigInt(rnd32())); while (!h || used.has(String(h))); used.add(String(h)); return h; };
    const src = worldActors || pbyml(banc.bytes).root.Actors.filter(a => /^CmnObj_/.test(a.Name || '') && a.Translate);
    const nW = w.Actors.length;
    for (const a of src) {
      const b = { ...(area ? { AreaName: area } : {}), Gyaml: a.Gyaml, Hash: T.u64(H()), InstanceId: uuid(), IsGridify: false, Name: a.Name,
        Rotate: [num(a.Rotate?.[0] ?? 0), Math.fround(num(a.Rotate?.[1] ?? 0) + (fr.yaw || 0)), num(a.Rotate?.[2] ?? 0)], SRTHash: T.u32(rnd32()), Translate: place(a.Translate) };
      // things that move under their own physics (Chain Chomps and other enemies, things that roll or bounce) start a little above the
      // ground: placed exactly on it, they can drop through the track before its collision is there
      if (LIFT_OBJ.test(a.Name)) b.Translate = [b.Translate[0], Math.fround(b.Translate[1] + 1), b.Translate[2]];
      if (a.Scale) b.Scale = a.Scale; if (a.Dynamic) b.Dynamic = a.Dynamic;
      w.Actors.push(b); w.CountActor[a.Name] = T.i32(num(w.CountActor[a.Name] || 0) + 1);
    }
    // the track's own course area in the world (a box round it, linked to a course point at the start), like each of the game's
    // courses has: being inside it is what tells the game which course's music, name and minimap apply
    const cube0 = w.Actors.find(a => a.Name === 'Area_CourseAreaCube' && /KoopaTroopaBeach_00/.test(String(a.Dynamic?.CourseArea)) && a.Links?.length) || w.Actors.find(a => a.Name === 'Area_CourseAreaCube' && a.Links?.length);
    const pt0 = cube0 && w.Actors.find(a => num(a.Hash) === num(cube0.Links[0].Dst));
    if (cube0 && pt0) {
      const pts = [...src.map(a => place(a.Translate)), ...(worldStart ? [worldStart] : [])];
      for (const rl of pbyml(banc.bytes).root.Rails || []) for (const q of rl.Points) pts.push(q.Translation.map(num));
      const mn = [0, 1, 2].map(k => _mn(pts.map(q => num(q[k])))), mx = [0, 1, 2].map(k => _mx(pts.map(q => num(q[k]))));
      const mid = [0, 1, 2].map(k => Math.fround((mn[k] + mx[k]) / 2)), half = [Math.fround((mx[0] - mn[0]) / 2 + 60), Math.fround(Math.max(150, (mx[1] - mn[1]) / 2 + 100)), Math.fround((mx[2] - mn[2]) / 2 + 60)];
      const hp = H(), hc = H(), st = worldStart || mid;
      // every real course point sits in a course's object group (ParentPrefab); one without it took over every Free Roam warp.
      // Ours joins the group of the nearest course point (tested in game: warps all go to the right place again)
      let prefab = pt0.ParentPrefab, pd = Infinity;
      for (const a of w.Actors) if (a.Name === 'System_CoursePoint' && a.ParentPrefab && a.Dynamic?.Path && a.Translate) { const d = Math.hypot(num(a.Translate[0]) - num(st[0]), num(a.Translate[2]) - num(st[2])); if (d < pd) { pd = d; prefab = a.ParentPrefab; } }
      w.Actors.push({ ...(area ? { AreaName: area } : {}), Dynamic: { Path: `Work/Gyml/StageWarpGParam/${SZ}.game__StageWarpGParam.gyml` }, Gyaml: pt0.Gyaml, Hash: T.u64(hp), InstanceId: uuid(), IsGridify: false, Name: pt0.Name, ...(prefab ? { ParentPrefab: prefab } : {}), PrimitiveType: pt0.PrimitiveType || 'Cone',
        Rotate: (worldStartRot || [0, fr.yaw || 0, 0]).map(v => Math.fround(v)), SRTHash: T.u32(rnd32()), Translate: st.map((v, k) => Math.fround(num(v) + (k === 1 && worldStart ? 1.5 : 0))) });
      w.Actors.push({ ...(area ? { AreaName: area } : {}), Dynamic: { CourseArea: `Work/Gyml/CourseAreaGParam/${SZ}.game__CourseAreaGParam.gyml` }, Gyaml: cube0.Gyaml, Hash: T.u64(hc), InstanceId: uuid(), IsGridify: false,
        Links: [{ Dst: T.u64(hp), Gyaml: cube0.Links[0].Gyaml, Name: cube0.Links[0].Name, Src: T.u64(hc) }], Name: 'Area_CourseAreaCube', ...(prefab ? { ParentPrefab: prefab } : {}), PrimitiveType: cube0.PrimitiveType || 'Cube',
        Rotate: [0, 0, 0], SRTHash: T.u32(rnd32()), Scale: half, Translate: mid });
      for (const n of [pt0.Name, 'Area_CourseAreaCube']) w.CountActor[n] = T.i32(num(w.CountActor[n] || 0) + 1);
    }
    // the edge of the playable world: SystemObj_WorldEndArea boxes round the island (inside one, the game takes you back). A track out
    // near the edge can overlap one: trim each box that does, from the side that loses the least, so the track (+ a margin) is clear
    {
      const pts = [...src.map(a => place(a.Translate)), ...(worldStart ? [worldStart] : [])];
      for (const rl of pbyml(banc.bytes).root.Rails || []) for (const q of rl.Points) pts.push(q.Translation.map(num));
      const M = 120, tmn = [_mn(pts.map(q => num(q[0]))) - M, _mn(pts.map(q => num(q[2]))) - M], tmx = [_mx(pts.map(q => num(q[0]))) + M, _mx(pts.map(q => num(q[2]))) + M];
      const ty0 = _mn(pts.map(q => num(q[1]))) - 60, ty1 = _mx(pts.map(q => num(q[1]))) + 200;
      const corners = [[tmn[0], tmn[1]], [tmx[0], tmn[1]], [tmx[0], tmx[1]], [tmn[0], tmx[1]]];
      let trimmed = 0, removed = 0;
      w.Actors = w.Actors.filter(a => {
        if (a.Name !== 'SystemObj_WorldEndArea_00' || !a.Translate || !a.Scale) return true;
        const t = a.Translate.map(num), h = a.Scale.map(num), R = (a.Rotate || [0, 0, 0]).map(num);
        if (t[1] + h[1] < ty0 || t[1] - h[1] > ty1) return true;
        const yaw = Math.abs(R[0]) > 3 && Math.abs(R[2]) > 3 ? Math.PI - R[1] : R[1], c = Math.cos(yaw), sn = Math.sin(yaw);
        // the track's footprint in the box's own axes (local x = (cos, -sin), local z = (sin, cos))
        const L = corners.map(([x, z]) => [(x - t[0]) * c - (z - t[2]) * sn, (x - t[0]) * sn + (z - t[2]) * c]);
        const lo = [_mn(L.map(q => q[0])), _mn(L.map(q => q[1]))], hi = [_mx(L.map(q => q[0])), _mx(L.map(q => q[1]))];
        if (hi[0] < -h[0] || lo[0] > h[0] || hi[1] < -h[2] || lo[1] > h[2]) return true;   // doesn't touch it
        // the four ways to cut it back: keep the part beyond the track on one side
        const opts = [[0, hi[0], h[0]], [0, -h[0], lo[0]], [1, hi[1], h[2]], [1, -h[2], lo[1]]].map(([ax, a0, a1]) => ({ ax, a0, a1, keep: (a1 - a0) / (2 * (ax ? h[2] : h[0])) }));
        const best = opts.sort((p, q) => q.keep - p.keep)[0];
        if (best.keep < 0.05) { removed++; return false; }
        const mid = (best.a0 + best.a1) / 2, half = (best.a1 - best.a0) / 2, k = best.ax ? 2 : 0;
        const dx = best.ax ? sn * mid : c * mid, dz = best.ax ? c * mid : -sn * mid;
        a.Translate = [Math.fround(t[0] + dx), Math.fround(t[1]), Math.fround(t[2] + dz)];
        a.Scale = a.Scale.map((v, i) => i === k ? Math.fround(half) : v);
        trimmed++; return true;
      });
      if (removed) w.CountActor.SystemObj_WorldEndArea_00 = T.i32(num(w.CountActor.SystemObj_WorldEndArea_00) - removed);
      if (trimmed || removed) progress(`Moved the edge of the world back from the track (${trimmed + removed} of its edge boxes)`);
    }
    // the track's paths in the open world: Free Roam reads the world's files, not the course's. Glide paths go into WorldResident
    // (where the world's own are); grind rails into the world tile they're in (where the world keeps its own: World_Game03/XXZZ)
    const moved = (pbyml(banc.bytes).root.Rails || []).filter(rl => rl.Name === 'GlidePath' || rl.Name === 'RailSlidePath');
    const copyRail = (rl, areaName) => { const rh = H(); return { ...(areaName ? { AreaName: areaName } : {}), Gyaml: rl.Gyaml, Hash: T.u64(rh), InstanceId: uuid(), IsClosed: !!rl.IsClosed, Name: rl.Name,
      Points: rl.Points.map(q => ({ Gyaml: q.Gyaml, Hash: T.u64(H()), InstanceId: uuid(), Name: q.Name, Parent: T.u64(rh), RectOffset: q.RectOffset, RectSize: q.RectSize, Rotate: q.Rotate, Translation: q.Translation, ...(q.Dynamic ? { Dynamic: q.Dynamic } : {}) })) }; };
    const countRails = r => { const cr = {}; for (const rl of r.Rails || []) cr[rl.Name] = (cr[rl.Name] || 0) + 1; r.CountRail = Object.fromEntries(Object.entries(cr).sort().map(([k, v]) => [k, T.i32(v)])); };
    const glides = moved.filter(rl => rl.Name === 'GlidePath');
    if (glides.length) { w.Rails = [...(w.Rails || []), ...glides.map(rl => copyRail(rl, area))]; countRails(w); }
    const byTile = new Map();
    for (const rl of moved.filter(rl => rl.Name === 'RailSlidePath')) {
      const p0 = rl.Points[0].Translation.map(num), k = [p0[0], p0[2]].map(v => String(Math.max(0, Math.min(15, Math.floor(v / 1000) + 8))).padStart(2, '0')).join('');
      if (!byTile.has(k)) byTile.set(k, []); byTile.get(k).push(rl);
    }
    const tiles = new Map();   // world tiles we change: key -> { tdoc, t }
    const tile = async k => { if (tiles.has(k)) return tiles.get(k); const TP = `Banc/World_Game03/${k}.bcett.byml`, traw = await Rz(TP + '.zs').catch(() => null);
      const v = traw ? { tdoc: pbyml(traw), TP } : null; if (v) v.t = v.tdoc.root; tiles.set(k, v); return v; };
    for (const [k, rails] of byTile) {
      const tv = await tile(k); if (!tv) { warnings.push(`grind rails: this RomFS has no Banc/World_Game03/${k}.bcett.byml.zs, so the rails there won't work in Free Roam`); continue; }
      const t = tv.t;
      for (const a of t.Actors || []) if (a.Hash) used.add(String(num(a.Hash)));
      for (const rl of t.Rails || []) { used.add(String(num(rl.Hash))); for (const q of rl.Points) used.add(String(num(q.Hash))); }
      // the area name of the tile's nearest path or object
      let an = null, bd = Infinity; const p0 = rails[0].Points[0].Translation.map(num);
      const nearest = list => { for (const o of list) if (o.AreaName && o.Translate) { const d = Math.hypot(num(o.Translate[0]) - p0[0], num(o.Translate[2]) - p0[2]); if (d < bd) { bd = d; an = o.AreaName; } } };
      nearest((t.Rails || []).filter(rl => /RailSlide/.test(rl.Name)).map(rl => ({ AreaName: rl.AreaName, Translate: rl.Points[0]?.Translation })));   // the tile's rails' own group first
      if (!an) nearest(t.Actors || []);
      t.Rails = [...(t.Rails || []), ...rails.map(rl => copyRail(rl, an))]; countRails(t); tv.changed = true;
    }
    // clear the world's own creatures and props from the track's area: its auto-spawn points (jellyfish, birds, bubbles...) and its
    // placed props (CmnObj / EditObj / EffectObj). Its ground, areas, course points, warps and the like stay.
    if (fr.clear !== false) {
      const P = [...src.map(a => place(a.Translate)), ...(worldStart ? [worldStart] : []), ...moved.flatMap(rl => rl.Points.map(q => q.Translation.map(num)))];
      for (const rl of pbyml(banc.bytes).root.Rails || []) for (const q of rl.Points) P.push(q.Translation.map(num));
      const lo = [_mn(P.map(q => num(q[0]))) - 150, _mn(P.map(q => num(q[2]))) - 150], hi = [_mx(P.map(q => num(q[0]))) + 150, _mx(P.map(q => num(q[2]))) + 150];
      const inside = a => { if (!a.Translate) return false; const x = num(a.Translate[0]), z = num(a.Translate[2]); return x >= lo[0] && x <= hi[0] && z >= lo[1] && z <= hi[1]; };
      const mine = new Set(); const clearable = a => /^SystemObj_AutoGenerate\w*SlatePoint/.test(a.Name || '') || /^(CmnObj|EditObj|EffectObj)_/.test(a.Name || '');
      let gone = 0;
      const sweep = r => { const keep = (r.Actors || []).filter(a => !(clearable(a) && inside(a) && !mine.has(a))); gone += (r.Actors || []).length - keep.length; const out = (r.Actors || []).filter(a => !keep.includes(a)); r.Actors = keep;
        for (const a of out) { const n = num(r.CountActor?.[a.Name] || 0) - 1; if (n > 0) r.CountActor[a.Name] = T.i32(n); else if (r.CountActor) delete r.CountActor[a.Name]; } return out.length > 0; };
      for (const a of w.Actors.slice(nW)) mine.add(a);   // ours, just added
      sweep(w);
      const cell = v => Math.max(0, Math.min(15, Math.floor(v / 1000) + 8));
      for (let cx = cell(lo[0]); cx <= cell(hi[0]); cx++) for (let cz = cell(lo[1]); cz <= cell(hi[1]); cz++) {
        const tv = await tile(String(cx).padStart(2, '0') + String(cz).padStart(2, '0')); if (tv && sweep(tv.t)) tv.changed = true;
      }
      if (gone) progress(`Took ${gone} of the open world's things out of the track's area`);
    }
    for (const tv of tiles.values()) if (tv?.changed) { const tout = wbyml(tv.tdoc, tv.t, true); putZ(tv.TP + '.zs', tout); sizes.set(tv.TP, tout.length); }
    const out = wbyml(wdoc, w, true); putZ(WP + '.zs', out); sizes.set(WP, out.length);
  }
  // resource size table
  const RT = `System/Resource/ResourceSizeTable.Product.${V}.Nin_Ounce_NVN2.rsizetable.zs`;
  const t = parseRstb(await Rz(RT));
  for (const [p, n] of sizes) rstbSet(t, p, Math.ceil((n * 1.25 + 16384) / 32) * 32);
  files.set(RT, zsStore(writeRstb(t)));
  return { files, report: P.report, warnings, generalSize: newG.length };
}

// the game's version from its resource size table's name: 180 for 1.8.0, 100 for 1.0.0
const VERS = ['180', '170', '160', '150', '140', '130', '120', '110', '103', '102', '101', '100'];
export async function gameVersion(rd) { for (const v of VERS) if (await rd(`System/Resource/ResourceSizeTable.Product.${v}.Nin_Ounce_NVN2.rsizetable.zs`)) return v; return null; }
export const verLabel = v => v.split('').join('.');
// BARS: sorted CRC32 name hashes, then an (AMTA, BWAV) offset pair per name
export function barsNames(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), n = dv.getUint32(12, true), P = 16 + 4 * n, idx = new Map();
  for (let i = 0; i < n; i++) idx.set(dv.getUint32(16 + 4 * i, true), i);
  return { n, P, idx, dv };
}
export function barsHas(d, name) { return barsNames(d).idx.has(crc32(name) >>> 0); }
export function barsRepoint(d, map) {
  const out = d.slice(), { P, idx } = barsNames(out), dv = new DataView(out.buffer); let changed = 0;
  for (const [name, src] of Object.entries(map)) {
    const i = idx.get(crc32(name) >>> 0), j = idx.get(crc32(src) >>> 0); if (i === undefined || j === undefined) continue;
    dv.setUint32(P + 8 * i, dv.getUint32(P + 8 * j, true), true); dv.setUint32(P + 8 * i + 4, dv.getUint32(P + 8 * j + 4, true), true); changed++;
  }
  return { bytes: out, changed };
}

export const modJson = (modName, n) => JSON.stringify({ name: modName, title: modName, has_romfs: true, romfs_files: n, has_exefs: false, exefs_builds: [], exefs_match: true, switches: {}, warnings: [], producer: 'MK World Course Editor' }, null, 2) + '\n';
export { parseMsbt, msbtAppend };
