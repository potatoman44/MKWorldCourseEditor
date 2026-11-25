// Writing Switch 2 BNTX textures: an ASTC 4x4 encoder (one partition, RGBA endpoints, 2-bit
// weights) and the block-linear tiling the game reads (Orin GOB order, see TrackStudioWorld's
// bntx.rs for the reading side).

// ---- ASTC 4x4 -------------------------------------------------------------
// block mode 0x42: 4x4 weight grid, weights 0..3 (2 bits), single plane; CEM 12 (LDR RGBA direct)
// colour endpoints: 8 values of 8 bits (r0 r1 g0 g1 b0 b1 a0 a1) from bit 17; weights from bit 127 down
function writeBits(block, pos, n, v) { for (let i = 0; i < n; i++) if ((v >> i) & 1) block[(pos + i) >> 3] |= 1 << ((pos + i) & 7); }
function encodeBlock(px, out, at) {
  // px: 16 RGBA texels. Endpoints = the two texels farthest apart; others projected between them.
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
    let d = 0; for (let k = 0; k < 4; k++) { const t = px[i * 4 + k] - px[j * 4 + k]; d += t * t; }
    if (d > best) { best = d; a = i; b = j; }
  }
  let e0 = px.slice(a * 4, a * 4 + 4), e1 = px.slice(b * 4, b * 4 + 4);
  // the decoder swaps (and blue-contracts) when e1's RGB sum is below e0's: keep e1 >= e0
  if (e1[0] + e1[1] + e1[2] < e0[0] + e0[1] + e0[2]) { const t = e0; e0 = e1; e1 = t; }
  const block = new Uint8Array(16);
  writeBits(block, 0, 11, 0x42);         // block mode
  writeBits(block, 11, 2, 0);            // one partition
  writeBits(block, 13, 4, 12);           // CEM 12
  const ep = [e0[0], e1[0], e0[1], e1[1], e0[2], e1[2], e0[3], e1[3]];
  ep.forEach((v, i) => writeBits(block, 17 + 8 * i, 8, v));
  const dir = [e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2], e1[3] - e0[3]];
  const len2 = dir.reduce((s, v) => s + v * v, 0);
  let wbits = 0n;
  for (let i = 0; i < 16; i++) {
    let w = 0;
    if (len2 > 0) { let t = 0; for (let k = 0; k < 4; k++) t += (px[i * 4 + k] - e0[k]) * dir[k]; w = Math.max(0, Math.min(3, Math.round((t / len2) * 3))); }
    wbits |= BigInt(w) << BigInt(2 * i);
  }
  // weights are stored bit-reversed from the top of the block
  for (let i = 0; i < 32; i++) if ((wbits >> BigInt(i)) & 1n) { const p = 127 - i; block[p >> 3] |= 1 << (p & 7); }
  out.set(block, at);
}
export function encodeAstc4x4(rgba, w, h) {
  const bx = Math.ceil(w / 4), by = Math.ceil(h / 4), out = new Uint8Array(bx * by * 16), px = new Array(64);
  for (let y = 0; y < by; y++) for (let x = 0; x < bx; x++) {
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const sx = Math.min(w - 1, x * 4 + i), sy = Math.min(h - 1, y * 4 + j), s = (sy * w + sx) * 4, d = (j * 4 + i) * 4;
      px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3];
    }
    encodeBlock(px, out, (y * bx + x) * 16);
  }
  return out;
}

// ---- block-linear tiling ----------------------------------------------------
const gobOffset = (x, y, orin) => orin
  ? ((x / 32) | 0) * 256 + ((y / 4) | 0) * 128 + (((x % 32) / 16) | 0) * 64 + (y % 4) * 16 + x % 16
  : ((x / 32) | 0) * 256 + ((y / 2) | 0) * 64 + (((x % 32) / 16) | 0) * 32 + (y % 2) * 16 + x % 16;
export function tile(lin, widthBytes, rows, blockHeightLog2, orin, outSize) {
  let bh = 1 << blockHeightLog2;
  while (bh > 1 && rows <= (bh / 2) * 8) bh /= 2;
  const gobsWide = Math.ceil(widthBytes / 64), blockBytes = 512 * bh;
  const size = outSize || gobsWide * blockBytes * Math.ceil(rows / (8 * bh));
  const out = new Uint8Array(size);
  for (let y = 0; y < rows; y++) {
    const rowBase = Math.floor(y / (8 * bh)) * gobsWide * blockBytes + Math.floor((y % (8 * bh)) / 8) * 512;
    for (let x = 0; x < widthBytes; x += 16) {
      const dst = rowBase + Math.floor(x / 64) * blockBytes + gobOffset(x % 64, y % 8, orin);
      const n = Math.min(16, widthBytes - x);
      if (dst + n <= size) out.set(lin.subarray(y * widthBytes + x, y * widthBytes + x + n), dst);
    }
  }
  return out;
}

// ---- BNTX -------------------------------------------------------------------
export function bntxInfo(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const off = o => Number(dv.getBigUint64(o, true));
  if (String.fromCharCode(...d.subarray(0, 4)) !== 'BNTX') throw new Error('not a BNTX file');
  const orin = String.fromCharCode(...d.subarray(0x20, 0x24)) === 'Ounc';
  const p = off(off(0x28));
  const mips = Math.max(1, dv.getUint16(p + 0x16, true));
  const mipTable = off(p + 0x70);
  return {
    orin, tileMode: dv.getUint16(p + 0x12, true), mips, format: dv.getUint32(p + 0x1c, true),
    width: dv.getUint32(p + 0x24, true), height: dv.getUint32(p + 0x28, true), blockHeightLog2: dv.getUint32(p + 0x34, true) & 7,
    dataSize: dv.getUint32(p + 0x50, true), mipOffsets: Array.from({ length: mips }, (_, i) => off(mipTable + 8 * i)),
  };
}
// a copy of an ASTC 4x4 BNTX with its image replaced (same size); rgbaAt(level) gives each mip's pixels
export function replaceBntxAstc(orig, rgbaAt) {
  const info = bntxInfo(orig);
  if ((info.format >> 8) !== 0x2d) throw new Error('this minimap texture is not ASTC 4x4 (format 0x' + info.format.toString(16) + ')');
  if (info.tileMode === 1) throw new Error('linear textures are not supported');
  const out = orig.slice();
  for (let l = 0; l < info.mips; l++) {
    const w = Math.max(1, info.width >> l), h = Math.max(1, info.height >> l);
    const blocks = encodeAstc4x4(rgbaAt(l, w, h), w, h);
    const start = info.mipOffsets[l], end = l + 1 < info.mips ? info.mipOffsets[l + 1] : info.mipOffsets[0] + info.dataSize;
    const tiled = tile(blocks, Math.ceil(w / 4) * 16, Math.ceil(h / 4), info.blockHeightLog2, info.orin, end - start);
    out.set(tiled, start);
  }
  return out;
}

// ---- any ASTC footprint (used for the track's textures) -----------------------
// footprints of the BNTX ASTC formats (format >> 8)
export const ASTC_FOOT = { 0x2d: [4, 4], 0x2e: [5, 4], 0x2f: [5, 5], 0x30: [6, 5], 0x31: [6, 6], 0x32: [8, 5], 0x33: [8, 6], 0x34: [8, 8], 0x35: [10, 5], 0x36: [10, 6], 0x37: [10, 8], 0x38: [10, 10], 0x39: [12, 10], 0x3a: [12, 12] };
// one block of bw x bh texels with a 4x4 weight grid (block mode 0x42, CEM 12), like the 4x4 encoder.
// Endpoints: the darkest and brightest texels; each grid weight = the projection at its spot in the block.
function encodeBlockN(px, n, bw, bh, out, at) {
  let a = 0, b = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const l = px[4 * i] * 3 + px[4 * i + 1] * 6 + px[4 * i + 2] + px[4 * i + 3] * 2; if (l < lo) { lo = l; a = i; } if (l > hi) { hi = l; b = i; } }
  const e0 = px.slice(a * 4, a * 4 + 4), e1 = px.slice(b * 4, b * 4 + 4);
  if (e1[0] + e1[1] + e1[2] < e0[0] + e0[1] + e0[2]) { for (let k = 0; k < 4; k++) { const t = e0[k]; e0[k] = e1[k]; e1[k] = t; } }
  const block = new Uint8Array(16);
  writeBits(block, 0, 11, 0x42); writeBits(block, 11, 2, 0); writeBits(block, 13, 4, 12);
  [e0[0], e1[0], e0[1], e1[1], e0[2], e1[2], e0[3], e1[3]].forEach((v, i) => writeBits(block, 17 + 8 * i, 8, v));
  const dir = [e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2], e1[3] - e0[3]], len2 = dir.reduce((s, v) => s + v * v, 0);
  const tAt = i => { if (!len2) return 0; let t = 0; for (let k = 0; k < 4; k++) t += (px[i * 4 + k] - e0[k]) * dir[k]; return t / len2; };
  let wbits = 0n;
  for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) {
    // the texel area this grid point stands for
    const x0 = Math.floor(gx * bw / 4), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * bw / 4)), y0 = Math.floor(gy * bh / 4), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * bh / 4));
    let s = 0, c = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += tAt(y * bw + x); c++; }
    const w = Math.max(0, Math.min(3, Math.round(s / c * 3)));
    wbits |= BigInt(w) << BigInt(2 * (gy * 4 + gx));
  }
  for (let i = 0; i < 32; i++) if ((wbits >> BigInt(i)) & 1n) { const p = 127 - i; block[p >> 3] |= 1 << (p & 7); }
  out.set(block, at);
}
// how much each texel counts towards each grid weight (the decoder spreads grid weights bilinearly)
const GW = new Map();
function gridWeights(bw, bh, G) {
  const k = bw + 'x' + bh; if (GW.has(k)) return GW.get(k);
  const out = [];
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    const cx = gx * (bw - 1) / (G - 1), cy = gy * (bh - 1) / (G - 1), row = new Float64Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) row[y * bw + x] = Math.max(0, 1 - Math.abs(x - cx) / ((bw - 1) / (G - 1))) * Math.max(0, 1 - Math.abs(y - cy) / ((bh - 1) / (G - 1)));
    out.push(row);
  }
  GW.set(k, out); return out;
}
// better quality for opaque textures: RGB endpoints along the block's main colour direction (CEM 8),
// 5x5 weight grid of 2-bit weights (block mode 0xE2)
function encodeBlockRGB(px, n, bw, bh, out, at) {
  let mr = 0, mg = 0, mb = 0; for (let i = 0; i < n; i++) { mr += px[4 * i]; mg += px[4 * i + 1]; mb += px[4 * i + 2]; } mr /= n; mg /= n; mb /= n;
  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
  for (let i = 0; i < n; i++) { const r = px[4 * i] - mr, g = px[4 * i + 1] - mg, b = px[4 * i + 2] - mb; c00 += r * r; c01 += r * g; c02 += r * b; c11 += g * g; c12 += g * b; c22 += b * b; }
  let ax = [1, 1, 1];
  for (let it = 0; it < 8; it++) { const v = [c00 * ax[0] + c01 * ax[1] + c02 * ax[2], c01 * ax[0] + c11 * ax[1] + c12 * ax[2], c02 * ax[0] + c12 * ax[1] + c22 * ax[2]]; const l = Math.hypot(...v); if (l < 1e-9) break; ax = v.map(x => x / l); }
  let lo = Infinity, hi = -Infinity; const t = new Float64Array(n);
  for (let i = 0; i < n; i++) { t[i] = (px[4 * i] - mr) * ax[0] + (px[4 * i + 1] - mg) * ax[1] + (px[4 * i + 2] - mb) * ax[2]; if (t[i] < lo) lo = t[i]; if (t[i] > hi) hi = t[i]; }
  const cl = v => Math.max(0, Math.min(255, Math.round(v)));
  let e0 = [cl(mr + ax[0] * lo), cl(mg + ax[1] * lo), cl(mb + ax[2] * lo)], e1 = [cl(mr + ax[0] * hi), cl(mg + ax[1] * hi), cl(mb + ax[2] * hi)];
  if (e1[0] + e1[1] + e1[2] < e0[0] + e0[1] + e0[2]) { const q = e0; e0 = e1; e1 = q; }
  const block = new Uint8Array(16);
  writeBits(block, 0, 11, 0xE2); writeBits(block, 11, 2, 0); writeBits(block, 13, 4, 8);
  [e0[0], e1[0], e0[1], e1[1], e0[2], e1[2]].forEach((v, i) => writeBits(block, 17 + 8 * i, 8, v));
  const dir = [e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2]], len2 = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
  const tAt = i => len2 ? ((px[4 * i] - e0[0]) * dir[0] + (px[4 * i + 1] - e0[1]) * dir[1] + (px[4 * i + 2] - e0[2]) * dir[2]) / len2 : 0;
  const G = 5, W = gridWeights(bw, bh, G), tt = new Float64Array(n);
  for (let i = 0; i < n; i++) tt[i] = tAt(i);
  for (let g = 0; g < G * G; g++) {
    const row = W[g]; let s = 0, c = 0; for (let i = 0; i < n; i++) if (row[i]) { s += row[i] * tt[i]; c += row[i]; }
    const w = Math.max(0, Math.min(3, Math.round((c ? s / c : 0) * 3)));
    for (let b = 0; b < 2; b++) if ((w >> b) & 1) { const p = 127 - (2 * g + b); block[p >> 3] |= 1 << (p & 7); }   // weights from the top, bit-reversed
  }
  out.set(block, at);
}
// normal maps: two channels, X in RGB (luminance) and Y in alpha (CEM 4: luminance + alpha), endpoints along the
// block's main direction in that 2D space, 5x5 grid of 2-bit weights (same block mode as the RGB encoder)
function encodeBlockLA(px, n, bw, bh, out, at) {
  let ml = 0, ma = 0; for (let i = 0; i < n; i++) { ml += px[4 * i]; ma += px[4 * i + 3]; } ml /= n; ma /= n;
  let cll = 0, cla = 0, caa = 0; for (let i = 0; i < n; i++) { const l = px[4 * i] - ml, a = px[4 * i + 3] - ma; cll += l * l; cla += l * a; caa += a * a; }
  const ang = 0.5 * Math.atan2(2 * cla, cll - caa), ax = [Math.cos(ang), Math.sin(ang)];
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { const t = (px[4 * i] - ml) * ax[0] + (px[4 * i + 3] - ma) * ax[1]; if (t < lo) lo = t; if (t > hi) hi = t; }
  const cl = v => Math.max(0, Math.min(255, Math.round(v)));
  const e0 = [cl(ml + ax[0] * lo), cl(ma + ax[1] * lo)], e1 = [cl(ml + ax[0] * hi), cl(ma + ax[1] * hi)];
  const block = new Uint8Array(16);
  writeBits(block, 0, 11, 0xE2); writeBits(block, 11, 2, 0); writeBits(block, 13, 4, 4);
  [e0[0], e1[0], e0[1], e1[1]].forEach((v, i) => writeBits(block, 17 + 8 * i, 8, v));
  const dir = [e1[0] - e0[0], e1[1] - e0[1]], len2 = dir[0] ** 2 + dir[1] ** 2;
  const G = 5, W = gridWeights(bw, bh, G), tt = new Float64Array(n);
  for (let i = 0; i < n; i++) tt[i] = len2 ? ((px[4 * i] - e0[0]) * dir[0] + (px[4 * i + 3] - e0[1]) * dir[1]) / len2 : 0;
  for (let g = 0; g < G * G; g++) {
    const row = W[g]; let s2 = 0, c = 0; for (let i = 0; i < n; i++) if (row[i]) { s2 += row[i] * tt[i]; c += row[i]; }
    const w = Math.max(0, Math.min(3, Math.round((c ? s2 / c : 0) * 3)));
    for (let b = 0; b < 2; b++) if ((w >> b) & 1) { const p = 127 - (2 * g + b); block[p >> 3] |= 1 << (p & 7); }
  }
  out.set(block, at);
}
export function encodeAstc(rgba, w, h, bw, bh, la = false) {
  if (bw === 4 && bh === 4 && !la) return encodeAstc4x4(rgba, w, h);
  if (bw === 4 && bh === 4) return encodeAstc4x4(rgba, w, h);
  const bx = Math.ceil(w / bw), by = Math.ceil(h / bh), out = new Uint8Array(bx * by * 16), n = bw * bh, px = new Array(4 * n);
  for (let y = 0; y < by; y++) for (let x = 0; x < bx; x++) {
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      const sx = Math.min(w - 1, x * bw + i), sy = Math.min(h - 1, y * bh + j), s = (sy * w + sx) * 4, d = (j * bw + i) * 4;
      px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3];
    }
    (la ? encodeBlockLA : encodeBlockRGB)(px, n, bw, bh, out, (y * bx + x) * 16);
  }
  return out;
}
// an ASTC "void extent" block: one flat colour
export function constBlock(r, g, b, a) {
  const k = new Uint8Array(16); k.set([0xFC, 0xFD, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  const dv = new DataView(k.buffer); [r, g, b, a].forEach((v, i) => dv.setUint16(8 + 2 * i, v * 257, true)); return k;
}
const bntxFoot = info => { const f = ASTC_FOOT[info.format >> 8]; if (!f) throw new Error('texture format 0x' + info.format.toString(16) + ' is not ASTC'); return f; };
// a copy of an ASTC BNTX (any footprint) with its image replaced; rgbaAt(level, w, h) gives each mip's pixels
export function replaceBntx(orig, rgbaAt, la = false) {
  const info = bntxInfo(orig), [bw, bh] = bntxFoot(info);
  if (info.tileMode === 1) throw new Error('linear textures are not supported');
  const out = orig.slice();
  for (let l = 0; l < info.mips; l++) {
    const w = Math.max(1, info.width >> l), h = Math.max(1, info.height >> l);
    const blocks = encodeAstc(rgbaAt(l, w, h), w, h, bw, bh, la);
    const start = info.mipOffsets[l], end = l + 1 < info.mips ? info.mipOffsets[l + 1] : info.mipOffsets[0] + info.dataSize;
    out.set(tile(blocks, Math.ceil(w / bw) * 16, Math.ceil(h / bh), info.blockHeightLog2, info.orin, end - start), start);
  }
  return out;
}
// a copy of an ASTC BNTX that is one flat colour everywhere
export function flatBntx(orig, rgba) {
  const info = bntxInfo(orig); bntxFoot(info);
  const out = orig.slice(), blk = constBlock(...rgba), s = info.mipOffsets[0];
  for (let p = s; p + 16 <= s + info.dataSize; p += 16) out.set(blk, p);
  return out;
}
// rename the texture inside a BNTX (in place: the new name must be no longer and end in the same letter, so its name dictionary stays valid)
export function renameBntx(d, from, to) {
  const out = d.slice(), dv = new DataView(out.buffer), enc = new TextEncoder(), f = enc.encode(from);
  if (to.length > from.length || to[to.length - 1] !== from[from.length - 1]) throw new Error('bad texture rename ' + from + ' -> ' + to);
  let p = -1;
  outer: for (let i = 2; i + f.length <= out.length; i++) { if (dv.getUint16(i - 2, true) !== f.length) continue; for (let k = 0; k < f.length; k++) if (out[i + k] !== f[k]) continue outer; p = i - 2; break; }
  if (p < 0) throw new Error('texture name not found in its file: ' + from);
  dv.setUint16(p, to.length, true); out.fill(0, p + 2, p + 2 + f.length + 1); out.set(enc.encode(to), p + 2);
  return out;
}

// ---- reading: block-linear -> linear, and an ASTC (LDR) decoder, for previews of the game's textures ----
export function untile(src, widthBytes, rows, blockHeightLog2, orin) {
  let bh = 1 << blockHeightLog2;
  while (bh > 1 && rows <= (bh / 2) * 8) bh /= 2;
  const gobsWide = Math.ceil(widthBytes / 64), blockBytes = 512 * bh, out = new Uint8Array(widthBytes * rows);
  for (let y = 0; y < rows; y++) {
    const rowBase = Math.floor(y / (8 * bh)) * gobsWide * blockBytes + Math.floor((y % (8 * bh)) / 8) * 512;
    for (let x = 0; x < widthBytes; x += 16) {
      const s = rowBase + Math.floor(x / 64) * blockBytes + gobOffset(x % 64, y % 8, orin), n = Math.min(16, widthBytes - x);
      if (s + n <= src.length) out.set(src.subarray(s, s + n), y * widthBytes + x);
    }
  }
  return out;
}
// integer sequence encoding: [bits, trits, quints] for each number of levels
const ISE = { 2: [1, 0, 0], 3: [0, 1, 0], 4: [2, 0, 0], 5: [0, 0, 1], 6: [1, 1, 0], 8: [3, 0, 0], 10: [1, 0, 1], 12: [2, 1, 0], 16: [4, 0, 0], 20: [2, 0, 1], 24: [3, 1, 0], 32: [5, 0, 0],
  40: [3, 0, 1], 48: [4, 1, 0], 64: [6, 0, 0], 80: [4, 0, 1], 96: [5, 1, 0], 128: [7, 0, 0], 160: [5, 0, 1], 192: [6, 1, 0], 256: [8, 0, 0] };
const COLOR_LEVELS = [256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6];
const iseBits = (levels, n) => { const [b, t, q] = ISE[levels]; return n * b + (t ? Math.ceil(n * 8 / 5) : 0) + (q ? Math.ceil(n * 7 / 3) : 0); };
const bitsAt = (blk, pos, n) => { let v = 0; for (let i = 0; i < n; i++) { const p = pos + i; if (p >= 0 && p < 128 && (blk[p >> 3] >> (p & 7)) & 1) v |= 1 << i; } return v; };
const bit = (v, i) => (v >> i) & 1;
function decodeTrits(T) {
  let C, t4, t3;
  if (((T >> 2) & 7) === 7) { C = (((T >> 5) & 7) << 2) | (T & 3); t4 = t3 = 2; }
  else { C = T & 31; if (((T >> 5) & 3) === 3) { t4 = 2; t3 = bit(T, 7); } else { t4 = bit(T, 7); t3 = (T >> 5) & 3; } }
  let t2, t1, t0;
  if ((C & 3) === 3) { t2 = 2; t1 = bit(C, 4); t0 = (bit(C, 3) << 1) | (bit(C, 2) & ~bit(C, 3) & 1); }
  else if (((C >> 2) & 3) === 3) { t2 = 2; t1 = 2; t0 = C & 3; }
  else { t2 = bit(C, 4); t1 = (C >> 2) & 3; t0 = (bit(C, 1) << 1) | (bit(C, 0) & ~bit(C, 1) & 1); }
  return [t0, t1, t2, t3, t4];
}
function decodeQuints(Q) {
  let q0, q1, q2;
  if (((Q >> 1) & 3) === 3 && ((Q >> 5) & 3) === 0) { q2 = (bit(Q, 0) << 2) | ((bit(Q, 4) & ~bit(Q, 0) & 1) << 1) | (bit(Q, 3) & ~bit(Q, 0) & 1); q1 = q0 = 4; }
  else {
    let C;
    if (((Q >> 1) & 3) === 3) { q2 = 4; C = (((Q >> 3) & 3) << 3) | ((~(Q >> 5) & 3) << 1) | (Q & 1); }
    else { q2 = (Q >> 5) & 3; C = Q & 31; }
    if ((C & 7) === 5) { q1 = 4; q0 = (C >> 3) & 3; } else { q1 = (C >> 3) & 3; q0 = C & 7; }
  }
  return [q0, q1, q2];
}
// n values of the given levels from bit pos; each value: [bits part, trit/quint part]
function readISE(blk, pos, levels, n) {
  const [b, t, q] = ISE[levels], out = [];
  if (t) for (let i = 0; i < n; i += 5) {
    const m = [], T = [];
    let p = pos;
    const take = k => { const v = bitsAt(blk, p, k); p += k; return v; };
    m[0] = take(b); let tb = take(2); m[1] = take(b); tb |= take(2) << 2; m[2] = take(b); tb |= take(1) << 4; m[3] = take(b); tb |= take(2) << 5; m[4] = take(b); tb |= take(1) << 7;
    const tr = decodeTrits(tb);
    for (let k = 0; k < 5 && i + k < n; k++) out.push([m[k], tr[k]]);
    pos = p;
  } else if (q) for (let i = 0; i < n; i += 3) {
    const m = []; let p = pos;
    const take = k => { const v = bitsAt(blk, p, k); p += k; return v; };
    m[0] = take(b); let qb = take(3); m[1] = take(b); qb |= take(2) << 3; m[2] = take(b); qb |= take(2) << 5;
    const qu = decodeQuints(qb);
    for (let k = 0; k < 3 && i + k < n; k++) out.push([m[k], qu[k]]);
    pos = p;
  } else for (let i = 0; i < n; i++) { out.push([bitsAt(blk, pos, b), 0]); pos += b; }
  return out;
}
function unqColor([m, d], levels) {
  const [b, t, q] = ISE[levels];
  if (!t && !q) { let v = m << (8 - b), s = 8 - b; while (s > 0) { v |= (m << s) >> b; s -= b; } return v & 255; }   // bit replication
  const A = (m & 1) ? 0x1FF : 0; let B = 0, C;
  if (t) {
    if (b === 1) C = 204;
    else if (b === 2) { const x = bit(m, 1); B = (x << 8) | (x << 4) | (x << 2) | (x << 1); C = 93; }
    else if (b === 3) { const x = (m >> 1) & 3; B = (x << 7) | (x << 2) | x; C = 44; }
    else if (b === 4) { const x = (m >> 1) & 7; B = (x << 6) | x; C = 22; }
    else if (b === 5) { const x = (m >> 1) & 15; B = (x << 5) | (x >> 2); C = 11; }
    else { const x = (m >> 1) & 31; B = (x << 4) | (x >> 4); C = 5; }
  } else {
    if (b === 1) C = 113;
    else if (b === 2) { const x = bit(m, 1); B = (x << 8) | (x << 3) | (x << 2); C = 54; }
    else if (b === 3) { const x = (m >> 1) & 3; B = (x << 7) | (x << 1) | (x >> 1); C = 26; }
    else if (b === 4) { const x = (m >> 1) & 7; B = (x << 6) | (x >> 1); C = 13; }
    else { const x = (m >> 1) & 15; B = (x << 5) | (x >> 3); C = 6; }
  }
  let T = d * C + B; T ^= A; return ((A & 0x80) | (T >> 2)) & 255;
}
function unqWeight([m, d], levels) {
  const [b, t, q] = ISE[levels]; let v;
  if (!t && !q) { v = 0; let s = 6 - b; v = m << s; while (s > 0) { s -= b; v |= s >= 0 ? m << s : m >> -s; } v &= 63; }
  else if (b === 0) v = t ? [0, 32, 63][d] : [0, 16, 32, 47, 63][d];
  else {
    const A = (m & 1) ? 0x7F : 0; let B = 0, C;
    if (t) { if (b === 1) C = 50; else if (b === 2) { const x = bit(m, 1); B = (x << 6) | (x << 2) | x; C = 23; } else { const x = (m >> 1) & 3; B = (x << 5) | x; C = 11; } }
    else { if (b === 1) C = 28; else { const x = bit(m, 1); B = (x << 6) | (x << 1); C = 13; } }
    let T = d * C + B; T ^= A; v = (A & 0x20) | (T >> 2);
  }
  return v > 32 ? v + 1 : v;
}
function hash52(p) {
  p >>>= 0;
  p ^= p >>> 15; p = (p - (p << 17)) >>> 0; p = (p + (p << 7)) >>> 0; p = (p + (p << 4)) >>> 0; p ^= p >>> 5;
  p = (p + (p << 16)) >>> 0; p ^= p >>> 7; p ^= p >>> 3; p = (p ^ (p << 6)) >>> 0; p ^= p >>> 17; return p >>> 0;
}
function partitionOf(seed, x, y, z, count, small) {
  if (small) { x <<= 1; y <<= 1; z <<= 1; }
  seed += (count - 1) * 1024;
  const r = hash52(seed);
  let s = [r & 15, (r >>> 4) & 15, (r >>> 8) & 15, (r >>> 12) & 15, (r >>> 16) & 15, (r >>> 20) & 15, (r >>> 24) & 15, (r >>> 28) & 15, (r >>> 18) & 15, (r >>> 22) & 15, (r >>> 26) & 15, ((r >>> 30) | (r << 2)) & 15].map(v => v * v);
  let sh1, sh2;
  if (seed & 1) { sh1 = (seed & 2) ? 4 : 5; sh2 = count === 3 ? 6 : 5; } else { sh1 = count === 3 ? 6 : 5; sh2 = (seed & 2) ? 4 : 5; }
  const sh3 = (seed & 0x10) ? sh1 : sh2;
  s = s.map((v, i) => v >> (i < 8 ? (i % 2 ? sh2 : sh1) : sh3));
  let a = (s[0] * x + s[1] * y + s[10] * z + (r >>> 14)) & 63, b = (s[2] * x + s[3] * y + s[11] * z + (r >>> 10)) & 63;
  let c = (s[4] * x + s[5] * y + s[8] * z + (r >>> 6)) & 63, d = (s[6] * x + s[7] * y + s[9] * z + (r >>> 2)) & 63;
  if (count < 4) d = 0; if (count < 3) c = 0;
  return (a >= b && a >= c && a >= d) ? 0 : (b >= c && b >= d) ? 1 : (c >= d) ? 2 : 3;
}
const clamp8 = v => v < 0 ? 0 : v > 255 ? 255 : v;
const bts = (a, b) => { b = (b >> 1) | (a & 0x80); a = (a >> 1) & 0x3F; if (a & 0x20) a -= 0x40; return [a, b]; };
const blueC = (r, g, b, a) => [(r + b) >> 1, (g + b) >> 1, b, a];
function endpoints(cem, v) {
  switch (cem) {
    case 0: return [[v[0], v[0], v[0], 255], [v[1], v[1], v[1], 255]];
    case 1: { const l0 = (v[0] >> 2) | (v[1] & 0xC0), l1 = Math.min(255, l0 + (v[1] & 0x3F)); return [[l0, l0, l0, 255], [l1, l1, l1, 255]]; }
    case 4: return [[v[0], v[0], v[0], v[2]], [v[1], v[1], v[1], v[3]]];
    case 5: { const [o1, b0] = bts(v[1], v[0]), [o3, b2] = bts(v[3], v[2]); return [[b0, b0, b0, b2], [b0 + o1, b0 + o1, b0 + o1, b2 + o3].map(clamp8)]; }
    case 6: return [[(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, 255], [v[0], v[1], v[2], 255]];
    case 8: return v[1] + v[3] + v[5] >= v[0] + v[2] + v[4] ? [[v[0], v[2], v[4], 255], [v[1], v[3], v[5], 255]] : [blueC(v[1], v[3], v[5], 255), blueC(v[0], v[2], v[4], 255)];
    case 9: case 13: {
      const [o1, b0] = bts(v[1], v[0]), [o3, b2] = bts(v[3], v[2]), [o5, b4] = bts(v[5], v[4]);
      const [o7, b6] = cem === 13 ? bts(v[7], v[6]) : [0, 255];
      const e1 = [b0 + o1, b2 + o3, b4 + o5, b6 + o7].map(clamp8);
      return o1 + o3 + o5 >= 0 ? [[b0, b2, b4, b6], e1] : [blueC(...e1).map(clamp8), blueC(b0, b2, b4, b6)];
    }
    case 10: return [[(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, v[4]], [v[0], v[1], v[2], v[5]]];
    case 12: return v[1] + v[3] + v[5] >= v[0] + v[2] + v[4] ? [[v[0], v[2], v[4], v[6]], [v[1], v[3], v[5], v[7]]] : [blueC(v[1], v[3], v[5], v[7]), blueC(v[0], v[2], v[4], v[6])];
    default: return [[255, 0, 255, 255], [255, 0, 255, 255]];   // HDR: not used by these textures
  }
}
function blockMode(m) {
  let W, H, R, Hp = bit(m, 9), D = bit(m, 10);
  if (m & 3) {
    R = bit(m, 4) | ((m & 3) << 1); const A = (m >> 5) & 3, B = (m >> 7) & 3;
    switch ((m >> 2) & 3) {
      case 0: W = B + 4; H = A + 2; break;
      case 1: W = B + 8; H = A + 2; break;
      case 2: W = A + 2; H = B + 8; break;
      default: if (bit(m, 8)) { W = bit(m, 7) + 2; H = A + 2; } else { W = A + 2; H = bit(m, 7) + 6; }
    }
  } else {
    if ((m & 15) === 0) return null;
    R = bit(m, 4) | (bit(m, 2) << 1) | (bit(m, 3) << 2); const A = (m >> 5) & 3;
    switch ((m >> 7) & 3) {
      case 0: W = 12; H = A + 2; break;
      case 1: W = A + 2; H = 12; break;
      case 2: W = A + 6; H = ((m >> 9) & 3) + 6; D = 0; Hp = 0; break;
      default: if (bit(m, 6)) return null; if (bit(m, 5)) { W = 10; H = 6; } else { W = 6; H = 10; }
    }
  }
  if (R < 2) return null;
  const levels = (Hp ? [0, 0, 10, 12, 16, 20, 24, 32] : [0, 0, 2, 3, 4, 5, 6, 8])[R];
  return { W, H, D, levels };
}
const ERR = [255, 0, 255, 255];
// one 16-byte block -> bw*bh RGBA texels in out (row stride ow pixels) at (ox, oy)
function decodeBlock(blk, bw, bh, out, ow, oh, ox, oy) {
  const put = (x, y, c) => { const px = ox + x, py = oy + y; if (px < ow && py < oh) { const o = (py * ow + px) * 4; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3]; } };
  const mode = bitsAt(blk, 0, 11);
  if ((mode & 0x1FF) === 0x1FC) { const c = [0, 1, 2, 3].map(i => blk[9 + 2 * i]); for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) put(x, y, c); return; }
  const bm = blockMode(mode), fill = c => { for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) put(x, y, c); };
  if (!bm || bm.W > bw || bm.H > bh) return fill(ERR);
  const parts = bitsAt(blk, 11, 2) + 1, planes = bm.D ? 2 : 1, nW = bm.W * bm.H * planes;
  if (nW > 64 || (parts === 4 && planes === 2)) return fill(ERR);
  const wBits = iseBits(bm.levels, nW); if (wBits < 24 || wBits > 96) return fill(ERR);
  let cems = [], colorStart, extraBits = 0, seed = 0;
  if (parts === 1) { cems = [bitsAt(blk, 13, 4)]; colorStart = 17; }
  else {
    seed = bitsAt(blk, 13, 10); colorStart = 29;
    const cb = bitsAt(blk, 23, 6), base = cb & 3;
    if (base === 0) { for (let i = 0; i < parts; i++) cems.push(cb >> 2); }
    else {
      extraBits = 3 * parts - 4;
      const enc = (cb >> 2) | (bitsAt(blk, 128 - wBits - extraBits, extraBits) << 4);
      for (let i = 0; i < parts; i++) cems.push(((base - 1 + bit(enc, i)) << 2) | ((enc >> (parts + 2 * i)) & 3));
    }
  }
  const ccsPos = 128 - wBits - extraBits - (planes === 2 ? 2 : 0), ccs = planes === 2 ? bitsAt(blk, ccsPos, 2) : -1;
  const colorBits = ccsPos - colorStart, nVals = cems.reduce((s, c) => s + 2 * ((c >> 2) + 1), 0);
  if (nVals > 18) return fill(ERR);
  const cl = COLOR_LEVELS.find(l => iseBits(l, nVals) <= colorBits); if (!cl || cl < 6) return fill(ERR);
  const vals = readISE(blk, colorStart, cl, nVals).map(v => unqColor(v, cl));
  const eps = []; let vi = 0;
  for (const c of cems) { const n = 2 * ((c >> 2) + 1); eps.push(endpoints(c, vals.slice(vi, vi + n))); vi += n; }
  // weights: read from the top of the block, bit-reversed
  const rev = new Uint8Array(16); for (let i = 0; i < 128; i++) if ((blk[i >> 3] >> (i & 7)) & 1) { const p = 127 - i; rev[p >> 3] |= 1 << (p & 7); }
  const wts = readISE(rev, 0, bm.levels, nW).map(v => unqWeight(v, bm.levels));
  const Ds = Math.floor((1024 + (bw >> 1)) / (bw - 1)), Dt = Math.floor((1024 + (bh >> 1)) / (bh - 1)), small = bw * bh < 31;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const gs = (Ds * x * (bm.W - 1) + 32) >> 6, gt = (Dt * y * (bm.H - 1) + 32) >> 6, js = gs >> 4, fs = gs & 15, jt = gt >> 4, ft = gt & 15;
    const w11 = (fs * ft + 8) >> 4, w10 = ft - w11, w01 = fs - w11, w00 = 16 - fs - ft + w11, v0 = js + jt * bm.W;
    const W = pl => { const g = i => i < bm.W * bm.H ? wts[i * planes + pl] ?? 0 : 0; return (g(v0) * w00 + g(v0 + 1) * w01 + g(v0 + bm.W) * w10 + g(v0 + bm.W + 1) * w11 + 8) >> 4; };
    const p = parts > 1 ? partitionOf(seed, x, y, 0, parts, small) : 0, [e0, e1] = eps[p], w0 = W(0), w1 = planes === 2 ? W(1) : w0;
    const c = [0, 1, 2, 3].map(k => { const w = k === ccs ? w1 : w0, a = (e0[k] << 8) | e0[k], b = (e1[k] << 8) | e1[k]; return ((a * (64 - w) + b * w + 32) >> 6) >> 8; });
    put(x, y, c);
  }
}
// a BNTX's image as RGBA, from its first mip level no bigger than maxSize (for previews)
export function bntxToRGBA(d, maxSize = 256) {
  const info = bntxInfo(d), [bw, bh] = bntxFoot(info);
  let l = 0; while (l + 1 < info.mips && Math.max(info.width >> l, info.height >> l) > maxSize) l++;
  const w = Math.max(1, info.width >> l), h = Math.max(1, info.height >> l), bx = Math.ceil(w / bw), by = Math.ceil(h / bh);
  const start = info.mipOffsets[l], end = l + 1 < info.mips ? info.mipOffsets[l + 1] : info.mipOffsets[0] + info.dataSize;
  const lin = untile(d.subarray(start, end), bx * 16, by, info.blockHeightLog2, info.orin), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < by; y++) for (let x = 0; x < bx; x++) decodeBlock(lin.subarray((y * bx + x) * 16, (y * bx + x) * 16 + 16), bw, bh, out, w, h, x * bw, y * bh);
  return { w, h, rgba: out, fullW: info.width, fullH: info.height };
}
