// The open world's ground (Game03): Phive/Terrain/Game03_Proc/X<aa>_Z<bb>_<i><j>.Nin_Ounce_NVN2.bphsh.zs
// 16 x 16 cells of 1000 m (cell aa covers x from (aa-8)*1000), each split in 4 x 4 tiles of 250 m (i along x, j along z).
// A tile is a Havok mesh shape (hknpMeshShape) round the tile's middle, about 11,000 triangles at ~1 m, heights in world metres.
export const TILE = 250, TILES = 64, WORLD_MIN = -8000;
export const tileName = (tx, tz) => {
  const p = n => String(n).padStart(2, '0');
  return `Phive/Terrain/Game03_Proc/X${p(tx >> 2)}_Z${p(tz >> 2)}_${tx & 3}${tz & 3}.Nin_Ounce_NVN2.bphsh.zs`;
};
export const tileCentre = (tx, tz) => [WORLD_MIN + tx * TILE + TILE / 2, WORLD_MIN + tz * TILE + TILE / 2];
export const tileAt = (x, z) => [Math.floor((x - WORLD_MIN) / TILE), Math.floor((z - WORLD_MIN) / TILE)];

const be32 = (d, o) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
function subs(d, start) {
  const size = be32(d, start) & 0x3fffffff, out = {}; let p = start + 8;
  while (p < start + size) { const sz = be32(d, p) & 0x3fffffff; out[String.fromCharCode(...d.subarray(p + 4, p + 8))] = [p + 8, p + sz]; p += sz; }
  return out;
}
// the triangles of a decompressed .bphsh, in the tile's own space: Float32Array of x,y,z per corner
export function terrainTris(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const S = subs(d, 0x30), I = subs(d, S.INDX[0] - 8), D0 = S.DATA[0];
  let ms = -1;
  for (let p = I.ITEM[0] + 12; p < I.ITEM[1]; p += 12) if ((dv.getUint32(p, true) >>> 24) === 0x10) { ms = D0 + dv.getUint32(p + 4, true); break; }
  if (ms < 0) throw new Error('no mesh in this terrain tile');
  const ns = dv.getInt32(ms + 0x94, true), gs = ms + 0x90 + dv.getInt32(ms + 0x90, true);
  const out = [];
  for (let s = 0; s < ns; s++) {
    const g = gs + 0x40 * s;
    const pr = g + 8 + dv.getInt32(g + 8, true), np = dv.getInt32(g + 12, true);
    const vb = g + 0x10 + dv.getInt32(g + 0x10, true), nv = dv.getInt32(g + 0x14, true) / 6;
    const ox = dv.getInt32(g + 0x20, true), oy = dv.getInt32(g + 0x24, true), oz = dv.getInt32(g + 0x28, true);
    const V = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) { V[3 * i] = (dv.getUint16(vb + 6 * i, true) + ox) / 512; V[3 * i + 1] = (dv.getUint16(vb + 6 * i + 2, true) + oy) / 512; V[3 * i + 2] = (dv.getUint16(vb + 6 * i + 4, true) + oz) / 512; }
    const put = k => out.push(V[3 * k], V[3 * k + 1], V[3 * k + 2]);
    for (let i = 0; i < np; i++) {
      const a = d[pr + 4 * i], b = d[pr + 4 * i + 1], c = d[pr + 4 * i + 2], e = d[pr + 4 * i + 3];
      put(a); put(b); put(c); if (e !== c) { put(a); put(c); put(e); }
    }
  }
  return new Float32Array(out);
}

// heights on an even grid of (N+1) x (N+1) points over the tile (N = 128: about 1.95 m apart); NaN where there's no ground
export const RASTER = 128;
export function rasterTile(tris, N = RASTER) {
  const n1 = N + 1, h = new Float32Array(n1 * n1).fill(NaN), st = TILE / N, half = TILE / 2, eps = 1e-4;
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2], bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5], cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(det) < 1e-9) continue;   // seen edge-on (cliff walls)
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) + half) / st - eps)), i1 = Math.min(N, Math.floor((Math.max(ax, bx, cx) + half) / st + eps));
    const j0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) + half) / st - eps)), j1 = Math.min(N, Math.floor((Math.max(az, bz, cz) + half) / st + eps));
    for (let j = j0; j <= j1; j++) { const z = j * st - half;
      for (let i = i0; i <= i1; i++) { const x = i * st - half;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det, l3 = 1 - l1 - l2;
        if (l1 < -eps || l2 < -eps || l3 < -eps) continue;
        const y = l1 * ay + l2 * by + l3 * cy, k = j * n1 + i;
        if (!(h[k] >= y)) h[k] = y;   // overhangs: the top
      } }
  }
  return h;
}

// colour by height and slope (like the editor's world map): sand by the sea, grass, rock on steep ground, light rock high up
const SEA = 220;
function shade(y, ny, out, o) {
  let r, g, b;
  if (y < SEA - 0.5) { r = 0.55; g = 0.52; b = 0.42; }
  else if (y < SEA + 6) { r = 0.87; g = 0.8; b = 0.59; }
  else { const t = Math.min(1, (y - SEA) / 900); r = 0.38 + 0.2 * t; g = 0.6 - 0.08 * t; b = 0.28; if (t > 0.55) { r = 0.6 + 0.25 * t; g = 0.58 + 0.27 * t; b = 0.5 + 0.4 * t; } }
  if (ny < 0.75) { const k = Math.min(1, (0.75 - ny) / 0.3); r += (0.5 - r) * k; g += (0.47 - g) * k; b += (0.43 - b) * k; }
  out[o] = r; out[o + 1] = g; out[o + 2] = b;
}
// a tile's mesh round the tile's middle (place it with tileCentre). step: grid cells per quad (1, 2, 4, 8, 16), or 0 for the
// game's own triangles: the collision exactly as the game has it (the array is used as it is, not copied)
export function tileMesh(THREE, tx, tz, h, step, tris) {
  const geo = new THREE.BufferGeometry(), cx = 0, cz = 0;
  if (!step) {
    const pos = tris;
    if (!tris.up) { for (let i = 0; i < pos.length; i += 9) {   // the game's winding may face down: face everything up
      const ux = pos[i + 3] - pos[i], uz = pos[i + 5] - pos[i + 2], vx = pos[i + 6] - pos[i], vz = pos[i + 8] - pos[i + 2];
      if (uz * vx - ux * vz < 0) for (let a = 0; a < 3; a++) { const t = pos[i + 3 + a]; pos[i + 3 + a] = pos[i + 6 + a]; pos[i + 6 + a] = t; }
    } tris.up = true; }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.computeVertexNormals();
  } else {
    const N = RASTER, n1 = N + 1, m = N / step, m1 = m + 1, st = TILE / N, pos = new Float32Array(m1 * m1 * 3), idx = [];
    for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) { const k = j * m1 + i; pos[3 * k] = cx - TILE / 2 + i * step * st; pos[3 * k + 1] = h[j * step * n1 + i * step]; pos[3 * k + 2] = cz - TILE / 2 + j * step * st; }
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const a = j * m1 + i, b = a + 1, c = a + m1, d = c + 1;
      if ([a, b, c, d].some(k => !isFinite(pos[3 * k + 1]))) continue;
      idx.push(a, c, b, b, c, d);
    }
    for (let k = 0; k < m1 * m1; k++) if (!isFinite(pos[3 * k + 1])) pos[3 * k + 1] = 0;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  }
  const P = geo.attributes.position.array, Nn = geo.attributes.normal.array, col = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) shade(P[i + 1], Nn[i + 1], col, i);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}
export const trisPerTile = step => step ? 2 * (RASTER / step) ** 2 : 11000;

// the ground's height at a spot in the tile (tile-local x, z), between the raster points (~2 m apart; the points come straight off
// the collision triangles)
export function heightIn(h, lx, lz) {
  const N = RASTER, st = TILE / N, fi = Math.min(N, Math.max(0, (lx + TILE / 2) / st)), fj = Math.min(N, Math.max(0, (lz + TILE / 2) / st));
  const i = Math.min(N - 1, Math.floor(fi)), j = Math.min(N - 1, Math.floor(fj)), u = fi - i, v = fj - j, n1 = N + 1;
  const a = h[j * n1 + i], b = h[j * n1 + i + 1], c = h[(j + 1) * n1 + i], d = h[(j + 1) * n1 + i + 1];
  const w = [[a, (1 - u) * (1 - v)], [b, u * (1 - v)], [c, (1 - u) * v], [d, u * v]].filter(([y]) => isFinite(y));
  if (!w.length) return null;
  const sw = w.reduce((t, [, k]) => t + k, 0); return sw > 1e-6 ? w.reduce((t, [y, k]) => t + y * k, 0) / sw : w[0][0];
}
