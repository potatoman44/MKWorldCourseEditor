// Track generator: a closed centre line -> road/shoulder/wall/ground geometry, collision, lap path, CPU route and items.
// Everything is built in "track space": the start line is at (0,0,0) and the race starts heading -Z.
import { MAT } from './bfmodel.js';

export const DEFAULTS = {
  width: 20, shoulder: 3, wallHeight: 1.5, ground: true, groundMargin: 25, segLen: 5,
  itemFirst: 90, itemEvery: 160, itemPer: 4, coins: true, laps: 3,
  roadMat: 'asphalt', shoulderMat: 'floorparts', wallMat: 'frame', groundMat: 'floortile',
  tunnel: false,                       // a roof over the road at the walls' height
  beach: 0, beachMat: 'backside01',    // beach: metres of sand round the ground square, sloping down from its edge to beachY (or 8 m down)
  beachY: null,
  rails: 'none', railMat: 'backside00', railR: 0.25,   // grind rails on the wall tops: 'left' | 'right' | 'both' (the way you drive)
  cliffMat: 'watersedge', mushroomMat: 'floorlight', hillSlope: 1.5,   // a point's sides (cliffs / hills / bridge) and trampoline gaps
};
const RAIL_SIDES = 8;
// locked points that keep a straight over the start grid (the grid reaches 46 m behind the line)
export const LOCK_BEFORE = [[0, 0, 60], [0, 0, 28]];      // last points of the loop, in driving order
export const LOCK_AFTER = [[0, 0, 0], [0, 0, -22]];       // the start line, then the first bit after it
export const DEFAULT_POINTS = [[-6, 0, -62], [-40, 0, -88], [-82, 0, -62], [-92, 0, 0], [-82, 0, 62], [-40, 0, 88], [-6, 0, 76]];
// what the collision of each surface is: [material, subMaterial, mask] (road/asphalt, wall/concrete, dirt/grass)
export const SURF = { road: [4, 4, 0], wall: [10, 5, 0], grass: [6, 8, 0], sand: [6, 10, 0], railTop: [4, 13, 0], railSide: [10, 13, 0], fall: [28, 0, 0], trampoline: [19, 0, 0] };   // a rail's collision: a box with a metal road top and metal wall sides, like the game's (Mario Bros. Circuit's stand-top rails)

export const controlLoop = pts => [...LOCK_AFTER, ...pts, ...LOCK_BEFORE];

// ---- the ground's own shape: a polygon [[x, z], ...] (any order, may bend inwards)
const area2 = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
// triangles of a simple polygon (ear clipping): index triples
export function triangulate(P) {
  const n = P.length; if (n < 3) return [];
  let idx = [...Array(n).keys()]; if (area2(P) < 0) idx.reverse();
  const cr = (a, b, c) => (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]);
  const inside = (p, a, b, c) => cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0;
  const out = []; let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (cr(a, b, c) <= 1e-9) continue;
      if (idx.some(k => k !== a && k !== b && k !== c && inside(k, a, b, c))) continue;
      out.push([a, b, c]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) break;   // not a simple polygon: give what we have
  }
  if (idx.length === 3) out.push(idx);
  return out;
}
// the polygon pushed outwards by d (corners mitred, but not more than 3 d)
export function offsetPoly(P, d) {
  const s = area2(P) >= 0 ? 1 : -1, n = P.length;
  return P.map((p, i) => {
    const a = P[(i + n - 1) % n], b = P[(i + 1) % n];
    const e1 = [p[0] - a[0], p[1] - a[1]], e2 = [b[0] - p[0], b[1] - p[1]], l1 = Math.hypot(...e1) || 1, l2 = Math.hypot(...e2) || 1;
    const n1 = [s * e1[1] / l1, -s * e1[0] / l1], n2 = [s * e2[1] / l2, -s * e2[0] / l2];   // outward normals
    let m = [n1[0] + n2[0], n1[1] + n2[1]]; const ml = Math.hypot(...m) || 1; m = [m[0] / ml, m[1] / ml];
    const k = Math.min(3, 1 / Math.max(0.2, m[0] * n1[0] + m[1] * n1[1]));
    return [p[0] + m[0] * d * k, p[1] + m[1] * d * k];
  });
}

// centripetal Catmull-Rom through a closed list of points -> dense polyline
function catmull(P, perSeg = 24) {
  const n = P.length, out = [];
  const d = (a, b) => Math.max(1e-4, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) ** 0.5);
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    for (let k = 0; k < perSeg; k++) {
      const t = t1 + (t2 - t1) * k / perSeg;
      const L = (a, b, ta, tb) => a.map((x, j) => ((tb - t) * x + (t - ta) * b[j]) / (tb - ta));
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
      out.push(L(B1, B2, t1, t2));
    }
  }
  return out;
}

// evenly spaced samples along the closed centre line: [{p, t (unit tangent, 3D), l (left, horizontal), s}]
export function sampleCentre(points, segLen) {
  const dense = catmull(controlLoop(points));
  const cum = [0];
  for (let i = 1; i <= dense.length; i++) { const a = dense[i - 1], b = dense[i % dense.length]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])); }
  const L = cum[cum.length - 1], N = Math.max(12, Math.round(L / segLen));
  const at = s => { s = ((s % L) + L) % L; let lo = 0, hi = cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const a = dense[lo], b = dense[(lo + 1) % dense.length], f = (s - cum[lo]) / ((cum[lo + 1] - cum[lo]) || 1); return a.map((x, j) => x + (b[j] - x) * f); };
  const segAt = s => { s = ((s % L) + L) % L; let lo = 0, hi = cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; } return Math.floor(lo / 24); };
  const frame = s => { const p = at(s), a = at(s - 0.5), b = at(s + 0.5); let t = b.map((x, j) => x - a[j]); const tl = Math.hypot(...t); t = t.map(x => x / tl);
    let l = [t[2], 0, -t[0]]; const ll = Math.hypot(l[0], l[2]) || 1; l = l.map(x => x / ll); return { p, t, l, s, seg: segAt(s) }; };   // seg: which stretch of controlLoop (from its point seg to the next)
  const rings = []; for (let i = 0; i <= N; i++) rings.push(frame(L * i / N));
  return { L, N, rings, frame };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
const off = (r, d, y = 0) => [r.p[0] + r.l[0] * d, r.p[1] + y, r.p[2] + r.l[2] * d];

/** Build everything. cap: modelCapacity() of the Central model (tris/verts per material). */
// a point's own walls and rails (p[3] = { w: 'none' | 'short' | 'tall' | 'tunnel', r: 'none' | 'left' | 'right' | 'both' }): from it to the next point
// and its sides (sd: 'cliff' straight down to the ground | 'hill' sloping down to it | 'bridge' a deck on pillars) or a gap instead of road
// (gap: 'glide' a glide panel before it | 'tramp' trampoline mushrooms in it | 'jump' just a gap)
export const WALL_STYLES = { none: 0, short: 1.5, tall: 5, tunnel: 8 };
export const SIDE_STYLES = ['cliff', 'hill', 'bridge'], GAP_STYLES = ['glide', 'tramp', 'jump'];
export function generate(points, o, cap) {
  o = { ...DEFAULTS, ...o };
  const styles = points.map(p => p[3] || null); points = points.map(p => [p[0], p[1], p[2]]);
  const C = sampleCentre(points, o.segLen), { rings, N, L } = C, hw = o.width / 2, sw = hw + o.shoulder;
  const warn = [];
  if (o.width < 18 && !o.noRoad) warn.push('The start grid is about 16 m wide: make the road at least 18 m wide or karts start off the road.');
  // segments per part, from what each material can hold
  // each ring's walls: its stretch's point's own setting, else the track's
  const styleOfSeg = c => (c >= LOCK_AFTER.length && c < LOCK_AFTER.length + styles.length ? styles[c - LOCK_AFTER.length] : null) || {};
  const ringStyle = rings.map(r => { const st = styleOfSeg(r.seg), w = st.w && st.w in WALL_STYLES ? st.w : null;
    const h = w ? WALL_STYLES[w] : o.wallHeight, tunnel = w ? w === 'tunnel' : !!o.tunnel, rails = h > 0 && !tunnel ? ({ left: [1], right: [-1], both: [1, -1] }[st.r] || []) : [];   // rails only where a point asks for them
    return { h, tunnel: tunnel && h > 0, rails, sd: SIDE_STYLES.includes(st.sd) ? st.sd : null, gap: GAP_STYLES.includes(st.gap) ? st.gap : null }; });
  // the gaps: runs of rings with no road (i0..i1, all in the gap), round the loop
  const gaps = []; for (let i = 0; i <= N; i++) if (ringStyle[i].gap && (i === 0 || ringStyle[i - 1].gap !== ringStyle[i].gap)) { let j = i; while (j < N && ringStyle[j + 1].gap === ringStyle[i].gap) j++; gaps.push({ i0: i, i1: j, type: ringStyle[i].gap }); }
  const anySide = k => ringStyle.some(x => x.sd === k && !x.gap);
  const anyWall = ringStyle.some(x => x.h > 0), anyTunnel = ringStyle.some(x => x.tunnel), maxRails = Math.max(0, ...ringStyle.map(x => x.rails.length));
  const lim = [];
  const need = (mat, trisPerSeg, vertsPerRing) => { const c = cap[mat]; if (!c) throw new Error('unknown material ' + mat); lim.push(Math.min(Math.floor(c.tris / trisPerSeg), Math.floor(c.verts / vertsPerRing) - 1)); };
  const by = {};   // material -> [tris/seg, verts/ring] (materials may be shared between surfaces)
  const use = (m, t, v) => { by[m] = by[m] || [0, 0]; by[m][0] += t; by[m][1] += v; };
  use(o.roadMat, 2, 2);
  if (o.shoulder > 0) use(o.shoulderMat, 4, 4);
  if (anyWall) use(o.wallMat, 8 + (anyTunnel ? 4 : 0), 4 + (anyTunnel ? 2 : 0));
  const gN = o.groundPoly && o.groundPoly.length >= 3 ? o.groundPoly.length : 4;
  if (o.beach > 0 && o.ground) use(o.beachMat, 2 * gN, 2 * gN);
  if (maxRails) use(o.railMat, 2 * RAIL_SIDES * maxRails, (RAIL_SIDES + 1) * maxRails);
  if (anySide('cliff') || gaps.length) use(o.cliffMat, 4, 4);
  if (anySide('hill')) use(o.groundMat, 4, 4);
  if (anySide('bridge')) use(o.wallMat, 8, 8);
  for (const [m, [t, v]] of Object.entries(by)) need(m, t, v);
  const perPart = Math.max(4, Math.min(...lim));
  const parts = [];
  if (!o.noRoad) for (let i0 = 0; i0 < N; i0 += perPart) parts.push([i0, Math.min(N, i0 + perPart)]);
  // with an imported model the paths sit on its surface
  const H = p => { if (!o.heightAt) return p; const y = o.heightAt(p[0], p[1], p[2]); return y === null || y === undefined ? p : [p[0], y, p[2]]; };
  const all = rings.map(r => r.p);
  const mn = [0, 1, 2].map(a => Math.min(...all.map(p => p[a]))), mx = [0, 1, 2].map(a => Math.max(...all.map(p => p[a])));
  const out = parts.map(([i0, i1], pi) => {
    const R = rings.slice(i0, i1 + 1);
    const pos = [0, 1, 2].map(a => R.reduce((s, r) => s + r.p[a], 0) / R.length);
    const loc = p => sub(p, pos);
    const geom = {}, tris = [];
    const G = m => (geom[m] = geom[m] || [[], []]);
    const quadStrip = (m, A, B, tag, uvA, uvB, twoSided, upFacing) => {     // A[i], B[i]: two edges along the strip
      const [V, TR] = G(m), base = V.length;
      for (let i = 0; i < A.length; i++) {
        const t = norm(sub(A[Math.min(i + 1, A.length - 1)], A[Math.max(i - 1, 0)])), acr = sub(B[i], A[i]);
        let n = norm(cross(acr, t)); if (upFacing && n[1] < 0) n = n.map(x => -x);
        V.push([loc(A[i]), n, uvA[i]], [loc(B[i]), n, uvB[i]]);
      }
      for (let i = 0; i + 1 < A.length; i++) {
        const a = base + 2 * i, b = base + 2 * i + 1, c = base + 2 * i + 3, d = base + 2 * i + 2;
        const pa = V[a][0], pb = V[b][0], pc = V[c][0], pd = V[d][0];
        let t1 = [a, b, c], t2 = [a, c, d];
        if (upFacing) { const n1 = cross(sub(pb, pa), sub(pc, pa)); if (n1[1] < 0) { t1 = [a, c, b]; t2 = [a, d, c]; } }
        const P = t => t.map(k => V[k][0]), area = t => { const q = P(t), n = cross(sub(q[1], q[0]), sub(q[2], q[0])); return Math.hypot(...n); };
        for (const t of [t1, t2]) { if (area(t) < 1e-6) continue; TR.push(t); if (twoSided) TR.push([t[0], t[2], t[1]]); if (tag !== null) tris.push([P(t), tag]); }
      }
    };
    // texture coordinates: across the surface (u) and along the road (v, from the distance driven), so road
    // pictures follow the bends. size 0 = one copy stretched across the surface; the length a copy covers
    // along the road follows the picture's shape (aspect = its height / width). v restarts near 0 in every part
    // (whole copies only, so the pattern carries on across the seam) to keep the game's half-float UVs exact.
    const UV = k => ({ size: 0, aspect: 1, ...(o.uv?.[k] || {}) });
    const along = (k, across) => { const u = UV(k), rep = (u.size || across) * u.aspect; return { rep, v0: Math.floor(R[0].s / rep) * rep }; };
    const strip = (k, A, B, wdt, tag) => {      // A: inner/left edge, B: outer/right edge
      const u = UV(k), a = along(k, wdt), uA = 0, uB = u.size ? wdt / u.size : 1;
      quadStrip(o[k + 'Mat'], A, B, tag, R.map(r => [uA, (r.s - a.v0) / a.rep]), R.map(r => [uB, (r.s - a.v0) / a.rep]), false, true);
    };
    // runs of rings (k0..k1 in this part) where pass(k, k + 1) holds for every stretch between them
    const RS = k => ringStyle[i0 + k], solid = (a, b) => !RS(a).gap && !RS(b).gap;
    const runs = pass => { const out = []; let a = -1; for (let k = 0; k + 1 < R.length; k++) { if (pass(k, k + 1)) { if (a < 0) a = k; } else if (a >= 0) { out.push([a, k]); a = -1; } } if (a >= 0) out.push([a, R.length - 1]); return out; };
    const stripR = (k, Rr, A, B, wdt, tag) => { const u = UV(k), a = along(k, wdt), uB = u.size ? wdt / u.size : 1;
      quadStrip(o[k + 'Mat'], A, B, tag, Rr.map(r => [0, (r.s - a.v0) / a.rep]), Rr.map(r => [uB, (r.s - a.v0) / a.rep]), false, true); };
    // road (not over a gap)
    for (const [k0, k1] of runs(solid)) { const Rr = R.slice(k0, k1 + 1);
      stripR('road', Rr, Rr.map(r => off(r, hw)), Rr.map(r => off(r, -hw)), o.width, 0);
      if (o.shoulder > 0) for (const side of [1, -1]) stripR('shoulder', Rr, Rr.map(r => off(r, side * hw)), Rr.map(r => off(r, side * sw)), o.shoulder, 2); }
    // the sides below the road: cliffs straight down to the ground, hills sloping down to it, or a bridge deck on pillars
    const gy = mn[1] - 0.05, drop = r => r.p[1] - gy;
    const UVs = (k, Rr, h) => { const u = UV(k), sz = u.size || 6, s0 = Math.floor(Rr[0].s / sz) * sz; return Rr.map((r, j) => [(r.s - s0) / sz, h(r, j) / (sz * u.aspect)]); };
    for (const [k0, k1] of runs((a, b) => solid(a, b) && RS(a).sd === 'cliff' && RS(b).sd === 'cliff')) for (const side of [1, -1]) {
      const Rr = R.slice(k0, k1 + 1);
      quadStrip(o.cliffMat, Rr.map(r => off(r, side * sw)), Rr.map(r => off(r, side * sw, -drop(r))), 1, UVs('cliff', Rr, () => 0), UVs('cliff', Rr, r => drop(r)), true, false);
    }
    for (const [k0, k1] of runs((a, b) => solid(a, b) && RS(a).sd === 'hill' && RS(b).sd === 'hill')) for (const side of [1, -1]) {
      const Rr = R.slice(k0, k1 + 1), gu = UV('ground'), gs = gu.size || 10;
      const A = Rr.map(r => off(r, side * sw)), B = Rr.map(r => off(r, side * (sw + Math.max(0, drop(r)) * o.hillSlope), -drop(r)));
      quadStrip(o.groundMat, A, B, 2, A.map(q => [q[0] / gs, q[2] / (gs * gu.aspect)]), B.map(q => [q[0] / gs, q[2] / (gs * gu.aspect)]), false, true);
    }
    for (const [k0, k1] of runs((a, b) => solid(a, b) && RS(a).sd === 'bridge' && RS(b).sd === 'bridge')) {
      const Rr = R.slice(k0, k1 + 1), T = 1.2, u = UV('wall'), sz = u.size || 4, s0 = Math.floor(Rr[0].s / sz) * sz, us = Rr.map(r => (r.s - s0) / sz);
      quadStrip(o.wallMat, Rr.map(r => off(r, sw, -T)), Rr.map(r => off(r, -sw, -T)), null, us.map(v => [v, 0]), us.map(v => [v, 2 * sw / sz]), true, false);   // underneath
      for (const side of [1, -1]) quadStrip(o.wallMat, Rr.map(r => off(r, side * sw)), Rr.map(r => off(r, side * sw, -T)), null, us.map(v => [v, 0]), us.map(v => [v, T / sz]), true, false);   // its edges
      // pillars every 30 m (where the drop is worth it): walls for karts down below
      const [V, TR] = G(o.wallMat);
      for (let k = 1; k < Rr.length; k++) { const r = Rr[k]; if (Math.floor(r.s / 30) === Math.floor(Rr[k - 1].s / 30) || drop(r) < 3) continue;
        const pw = Math.min(2.5, sw * 0.3), c = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [r.p[0] + r.l[0] * a * pw + r.t[0] * b * pw, r.p[2] + r.l[2] * a * pw + r.t[2] * b * pw]);
        for (let e = 0; e < 4; e++) { const a = c[e], b = c[(e + 1) % 4], top = r.p[1] - T, q = [[a[0], top, a[1]], [b[0], top, b[1]], [b[0], gy, b[1]], [a[0], gy, a[1]]];
          const n = norm(cross(sub(q[1], q[0]), sub(q[3], q[0]))), base = V.length, ln = Math.hypot(b[0] - a[0], b[1] - a[1]) / sz;
          q.forEach((p, j) => V.push([loc(p), n, [[0, 0], [ln, 0], [ln, (top - gy) / sz], [0, (top - gy) / sz]][j]]));
          TR.push([base, base + 1, base + 2], [base, base + 2, base + 3], [base, base + 2, base + 1], [base, base + 3, base + 2]);
          tris.push([[q[0], q[1], q[2]].map(loc), 1], [[q[0], q[2], q[3]].map(loc), 1], [[q[0], q[2], q[1]].map(loc), 1], [[q[0], q[3], q[2]].map(loc), 1]); }
      }
    }
    // the ends of the road at a gap: a rock face down to the ground (a bridge's deck: just its thickness)
    for (let k = 0; k < R.length; k++) {
      const into = k + 1 < R.length && !RS(k).gap && RS(k + 1).gap, outof = k > 0 && !RS(k).gap && RS(k - 1).gap; if (!into && !outof) continue;
      const r = R[k], depth = RS(k).sd === 'bridge' ? 1.2 : drop(r); if (depth < 0.2) continue;
      const u = UV('cliff'), sz = u.size || 6;
      quadStrip(o.cliffMat, [off(r, sw), off(r, sw, -depth)], [off(r, -sw), off(r, -sw, -depth)], 1, [[0, 0], [0, depth / sz]], [[2 * sw / sz, 0], [2 * sw / sz, depth / sz]], true, false);
    }
    for (const [k0, k1] of runs((a, b) => solid(a, b) && (RS(a).h > 0 || RS(b).h > 0))) for (const side of [1, -1]) {
      const u = UV('wall'), Rr = R.slice(k0, k1 + 1), hs = Rr.map((_, k) => RS(k0 + k).h), tall = u.size || Math.max(...hs), wide = tall / u.aspect, s0 = Math.floor(Rr[0].s / wide) * wide;
      const a = Rr.map(r => off(r, side * sw)), b = Rr.map((r, k) => off(r, side * sw, hs[k]));
      quadStrip(o.wallMat, a, b, 1, Rr.map((r, k) => [(r.s - s0) / wide, hs[k] / tall]), Rr.map(r => [(r.s - s0) / wide, 0]), true, false);
    }
    for (const [k0, k1] of runs((a, b) => solid(a, b) && RS(a).tunnel && RS(b).tunnel)) {   // the roof: across from wall top to wall top, seen from below (and above)
      const u = UV('wall'), Rr = R.slice(k0, k1 + 1), hs = Rr.map((_, k) => RS(k0 + k).h), tall = u.size || Math.max(...hs), wide = tall / u.aspect, s0 = Math.floor(Rr[0].s / wide) * wide;
      quadStrip(o.wallMat, Rr.map((r, k) => off(r, sw, hs[k])), Rr.map((r, k) => off(r, -sw, hs[k])), 1, Rr.map(r => [(r.s - s0) / wide, 0]), Rr.map(r => [(r.s - s0) / wide, 2 * sw / tall]), true, false);
    }
    for (const side of [1, -1]) for (const [k0, k1] of runs((a, b) => solid(a, b) && RS(a).rails.includes(side) && RS(b).rails.includes(side))) {   // a metal tube along the wall's top (looks only: the rail path is what you grind on)
      const [V, TR] = G(o.railMat), u = UV('rail'), rep = (u.size || 2) * u.aspect, v0 = Math.floor(R[k0].s / rep) * rep;
      for (let k = k0; k <= k1; k++) { const r = R[k];
        const c = off(r, side * sw, RS(k).h + o.railR);
        for (let j = 0; j <= RAIL_SIDES; j++) { const an = 2 * Math.PI * j / RAIL_SIDES, ca = Math.cos(an), sa = Math.sin(an);
          const n = [r.l[0] * ca, sa, r.l[2] * ca], q = [c[0] + n[0] * o.railR, c[1] + n[1] * o.railR, c[2] + n[2] * o.railR];
          V.push([loc(q), n, [j / RAIL_SIDES, (r.s - v0) / rep]]); }
        if (k > k0) { const b0 = V.length - 2 * (RAIL_SIDES + 1), b1 = V.length - (RAIL_SIDES + 1);
          for (let j = 0; j < RAIL_SIDES; j++) { const A = b0 + j, B = b0 + j + 1, Cc = b1 + j + 1, D = b1 + j;
            const n = cross(sub(V[B][0], V[A][0]), sub(V[D][0], V[A][0])), out = V[A][1];
            if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] > 0) TR.push([A, B, Cc], [A, Cc, D]); else TR.push([A, Cc, B], [A, D, Cc]); } }
      }
      // its collision, as the game's rails: a box on the wall's top, 0.73 m wide, its top flat metal road (where the rail path lies) and its sides metal wall
      const RW = 0.365, box = k => { const r = R[k], h = RS(k).h, top = h + 2 * o.railR; return { lo: [off(r, side * sw + RW, h), off(r, side * sw - RW, h)], hi: [off(r, side * sw + RW, top), off(r, side * sw - RW, top)] }; };
      for (let k = k0; k < k1; k++) { const A = box(k), B = box(k + 1);
        const face = (q, tag, upward) => { for (let t of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) { const n = cross(sub(t[1], t[0]), sub(t[2], t[0])); if (Math.hypot(...n) < 1e-6) continue; if (upward && n[1] < 0) t = [t[0], t[2], t[1]]; tris.push([t.map(loc), tag]); } };
        face([A.hi[0], A.hi[1], B.hi[1], B.hi[0]], 4, true);   // the top
        for (const e of [0, 1]) face([A.lo[e], A.hi[e], B.hi[e], B.lo[e]], 5, false);   // the sides
      }
    }
    for (const gp of gaps) {
      const mid = Math.floor((gp.i0 + gp.i1) / 2); if (mid < i0 || mid >= i1 || (mid === i1 - 1 && false)) continue;
      const a = rings[Math.max(0, gp.i0 - 1)], b = rings[Math.min(N, gp.i1 + 1)], len = b.s - a.s + (b.s < a.s ? L : 0);
      // a fall-out zone at the bottom: miss the far side and you're put back on the road (collision only)
      if (Math.min(drop(a), drop(b)) > 2) { const k = Math.max(2, Math.ceil(len / 8)), F = j => C.frame(a.s + len * j / k), W = sw + 6;
        for (let j = 0; j < k; j++) { const p = F(j), q = F(j + 1), c = [off(p, W, gy + 0.3 - p.p[1]), off(p, -W, gy + 0.3 - p.p[1]), off(q, -W, gy + 0.3 - q.p[1]), off(q, W, gy + 0.3 - q.p[1])];
          tris.push([[c[0], c[1], c[2]].map(loc), 6], [[c[0], c[2], c[3]].map(loc), 6]); } }
      if (gp.type === 'tramp') {   // trampoline mushrooms: caps a little under the road, bouncy on top (the game's Trampoline), rows across the road
        const along = Math.max(1, Math.round(len / 24)), across = Math.max(1, Math.round(o.width / 12)), rad = Math.min(6.5, o.width / (2 * across) * 0.95);
        const [V, TR] = G(o.mushroomMat), SEG = 10;
        for (let i = 0; i < along; i++) { const r = C.frame(a.s + len * (i + 0.5) / along), top = r.p[1] + (a.p[1] + (b.p[1] - a.p[1]) * (i + 0.5) / along - r.p[1]) - 1.5;
          for (let j = 0; j < across; j++) {
            const cx = r.p[0] + r.l[0] * (j - (across - 1) / 2) * 2 * rad, cz = r.p[2] + r.l[2] * (j - (across - 1) / 2) * 2 * rad, hh = rad * 0.45, base = top - hh;
            // the cap: a dome (3 bands) on a flat rim, with its underside
            const ringPt = (f, ang) => { const rr = rad * Math.cos(f * Math.PI / 2), y = base + hh * Math.sin(f * Math.PI / 2); return [cx + rr * Math.cos(ang), y, cz + rr * Math.sin(ang)]; };
            const b0 = V.length, BANDS = 3;
            for (let f = 0; f <= BANDS; f++) for (let q = 0; q <= SEG; q++) { const ang = 2 * Math.PI * q / SEG, p = ringPt(f / BANDS, ang), n = norm([p[0] - cx, (p[1] - base) * 2.2 + 0.01, p[2] - cz]); V.push([loc(p), n, [q / SEG, f / BANDS]]); }
            for (let f = 0; f < BANDS; f++) for (let q = 0; q < SEG; q++) { const A = b0 + f * (SEG + 1) + q, B = A + 1, Cc = A + SEG + 2, D = A + SEG + 1;
              const t1 = [A, D, Cc], t2 = [A, Cc, B]; for (let t of [t1, t2]) { const P = t.map(x => V[x][0]), nn = cross(sub(P[1], P[0]), sub(P[2], P[0])); if (Math.hypot(...nn) < 1e-8) continue; if (nn[1] < 0) t = [t[0], t[2], t[1]]; TR.push(t); tris.push([t.map(x => V[x][0]), 7]); } }
            const ub = V.length; V.push([loc([cx, base, cz]), [0, -1, 0], [0.5, 0.5]]); for (let q = 0; q <= SEG; q++) { const ang = 2 * Math.PI * q / SEG; V.push([loc([cx + rad * Math.cos(ang), base, cz + rad * Math.sin(ang)]), [0, -1, 0], [0.5 + 0.5 * Math.cos(ang), 0.5 + 0.5 * Math.sin(ang)]]); }
            for (let q = 0; q < SEG; q++) TR.push([ub, ub + 2 + q, ub + 1 + q]);
            // the stalk, down to the ground
            if (base - gy > 0.5) { const sr = rad * 0.32, s0 = V.length;
              for (let q = 0; q <= SEG; q++) { const ang = 2 * Math.PI * q / SEG, n = [Math.cos(ang), 0, Math.sin(ang)]; V.push([loc([cx + sr * n[0], base, cz + sr * n[2]]), n, [q / SEG, 0]], [loc([cx + sr * n[0], gy, cz + sr * n[2]]), n, [q / SEG, (base - gy) / (2 * Math.PI * sr)]]); }
              for (let q = 0; q < SEG; q++) { const A = s0 + 2 * q, B = A + 1, Cc = A + 3, D = A + 2; TR.push([A, Cc, B], [A, D, Cc]); tris.push([[A, Cc, B].map(x => V[x][0]), 1], [[A, D, Cc].map(x => V[x][0]), 1]); } }
          } }
      }
    }
    if (pi === 0 && o.ground) {
      const y = mn[1] - 0.05, m = o.groundMargin + sw;
      // the outline: your own shape, or a square round the track
      const poly = o.groundPoly && o.groundPoly.length >= 3 ? o.groundPoly.map(q => [q[0], q[1]]) : [[mn[0] - m, mn[2] - m], [mx[0] + m, mn[2] - m], [mx[0] + m, mx[2] + m], [mn[0] - m, mx[2] + m]];
      const [V, TR] = G(o.groundMat), base = V.length;
      const gu = UV('ground'), gs = gu.size || 10;
      for (const q of poly) { const l = loc([q[0], y, q[1]]); V.push([l, [0, 1, 0], [q[0] / gs, q[1] / (gs * gu.aspect)]]); }
      for (const t of triangulate(poly)) { const T = t.map(k => base + k); TR.push(T); tris.push([T.map(k => V[k][0]), 2]); }
      if (o.beach > 0) {   // sand round it: from its edge down into the water, beach metres further out
        const W = o.beach, yo = Math.min(y - 1, o.beachY ?? y - 8), bu = UV('beach'), bs = bu.size || 10, outer = offsetPoly(poly, W), n = poly.length;
        const [BV, BT] = G(o.beachMat), b0 = BV.length;
        for (const q of poly) BV.push([loc([q[0], y, q[1]]), [0, 1, 0], [q[0] / bs, q[1] / (bs * bu.aspect)]]);
        for (const q of outer) BV.push([loc([q[0], yo, q[1]]), [0, 1, 0], [q[0] / bs, q[1] / (bs * bu.aspect)]]);
        const added = [];
        for (let k = 0; k < n; k++) {
          const a = b0 + k, b = b0 + (k + 1) % n, c = b0 + n + (k + 1) % n, d = b0 + n + k;   // inner edge a-b, outer edge d-c
          for (let t of [[a, b, c], [a, c, d]]) { const q = t.map(i => BV[i][0]), nn = cross(sub(q[1], q[0]), sub(q[2], q[0])); if (Math.hypot(...nn) < 1e-6) continue; if (nn[1] < 0) t = [t[0], t[2], t[1]]; BT.push(t); added.push(t); tris.push([t.map(i => BV[i][0]), 3]); }
        }
        for (const t of added) { const q = t.map(i => BV[i][0]), nn = cross(sub(q[1], q[0]), sub(q[2], q[0])), l = Math.hypot(...nn) || 1; for (const i of t) if (i >= b0 + n) BV[i][1] = nn.map(x => x / l); }
      }
    }
    // fix the winding of every up-facing ground triangle (normal +Y)
    for (const [m, [V, TR]] of Object.entries(geom)) if (m === o.groundMat && pi === 0)
      for (const t of TR) { const n = cross(sub(V[t[1]][0], V[t[0]][0]), sub(V[t[2]][0], V[t[0]][0])); if (n[1] < 0) [t[1], t[2]] = [t[2], t[1]]; }
    for (const t of tris) { const [a, b, c] = t[0]; const n = cross(sub(b, a), sub(c, a)); if (t[1] !== 1 && t[1] !== 5 && t[1] !== 7 && n[1] < 0) t[0] = [a, c, b]; }
    const pts = Object.values(geom).flatMap(([V]) => V.map(v => v[0]));
    const bmin = [0, 1, 2].map(a => Math.min(...pts.map(p => p[a]))), bmax = [0, 1, 2].map(a => Math.max(...pts.map(p => p[a])));
    return { name: `CmnObj_CTrkPart${String(pi).padStart(3, '0')}`, local: pos, min: bmin, max: bmax, geom, col: { tris, mats: [SURF.road, SURF.wall, SURF.grass, SURF.sand, SURF.railTop, SURF.railSide, SURF.fall, SURF.trampoline] }, rings: [i0, i1] };
  });
  // paths and objects (track space)
  const yaw = r => Math.atan2(r.t[0], r.t[2]);
  const nL = Math.max(8, Math.round(L / 25)), lap = [];
  const gapAt = r => !!styleOfSeg(r.seg).gap;
  for (let i = 0; i < nL; i++) { const r = C.frame(L * i / nL), g = gapAt(r);   // over a gap the box reaches well below and above the road (you drop, bounce or glide there)
    lap.push({ pos: H(r.p), yaw: yaw(r), rs: [2 * sw + 4, g ? 90 : 20], ro: [0, g ? 20 : 10], dyn: i === 0 ? { IsStart: true } : (i % 3 === 2 ? { CheckPoint: Math.floor((i + 1) / 3) } : null) }); }
  const last = lap.reduce((m, n) => n.dyn && n.dyn.CheckPoint ? n.dyn.CheckPoint : m, 0);
  const nR = Math.max(16, Math.round(L / 12)), route = [];
  for (let i = 0; i < nR; i++) { const r = C.frame(L * i / nR); route.push({ pos: H(r.p), yaw: yaw(r), rs: [Math.max(4, Math.round(o.width * 0.4)), 10], ro: [0, 5] }); }   // narrower than the lap path, like the game's own routes
  const actors = [];
  if (o.itemPer > 0 && o.itemEvery > 0) for (let s = o.itemFirst; s < L - 60; s += o.itemEvery) {
    const r = C.frame(s), gap = Math.min(4.5, o.width / o.itemPer); if (gapAt(r)) continue;
    for (let k = 0; k < o.itemPer; k++) { const q = H(off(r, (k - (o.itemPer - 1) / 2) * gap)); actors.push({ name: 'CmnObj_ItemBox000_A_00', pos: [q[0], q[1] + 1.3, q[2]] }); }
  }
  if (o.coins) for (let s = o.itemFirst + o.itemEvery / 2; s < L - 80; s += o.itemEvery) {
    for (let k = 0; k < 5; k++) { const r = C.frame(s + k * 4); if (gapAt(r)) continue; const q = H(off(r, hw * 0.5 * (Math.floor(s / o.itemEvery) % 2 ? 1 : -1))); actors.push({ name: 'CmnObj_Coin000_A_00', pos: [q[0], q[1] + 1.0, q[2]] }); }
  }
  // rail paths (RailSlidePath) along the tubes: a node wherever the wall bends a few degrees (and at least every 20 m), in rails of up to 30 nodes
  const railPaths = [];
  for (const side of [1, -1]) {
    const on = i => ringStyle[i].rails.includes(side) && ringStyle[i + 1].rails.includes(side) && !ringStyle[i].gap && !ringStyle[i + 1].gap;
    for (let i = 0; i < N;) {
      if (!on(i)) { i++; continue; }
      let j = i; while (j < N && on(j)) j++;   // rings i..j
      const idx = [i]; let last = i;
      for (let k = i + 1; k < j; k++) { const a = rings[last].t, b = rings[k].t, turn = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
        if (turn > 0.06 || rings[k].s - rings[last].s >= 20) { idx.push(k); last = k; } }
      if (idx[idx.length - 1] !== j) idx.push(j);
      const node = k => { const r = rings[k], q = off(r, side * sw, ringStyle[k].h + 2 * o.railR - 0.02); return { pos: q, yaw: Math.atan2(r.t[0], r.t[2]), rs: [0.5, 0.5], ro: [0, 0] }; };
      for (let k = 0; k < idx.length - 1; k += 29) railPaths.push(idx.slice(k, Math.min(idx.length, k + 30)).map(node));
      i = j;
    }
  }
  const gapPieces = gaps.filter(g => g.type === 'glide').map(g => { const a = rings[Math.max(0, g.i0 - 1)], b = rings[Math.min(N, g.i1 + 1)], len = b.s - a.s + (b.s < a.s ? L : 0);
    return { kind: 'glidepanel', s: a.s - 3.2, x: 0, len: Math.round(len + 40), auto: true }; });
  for (const g of gaps) { const a = rings[Math.max(0, g.i0 - 1)], b = rings[Math.min(N, g.i1 + 1)]; if (Math.min(a.p[1], b.p[1]) - (mn[1] - 0.05) < 3) { warn.push('A gap needs a drop under it: raise the points round it a few metres above the lowest part of the track.'); break; } }
  const stats = { length: L, segments: N, parts: out.length, perPart, checkpoints: last, lapNodes: nL, routeNodes: nR, items: actors.filter(a => /ItemBox/.test(a.name)).length };
  return { parts: out, lap, route, actors, rings, stats, warn, bounds: [mn, mx], opts: o, railPaths, gapPieces, gaps };
}

// track space -> game world (the start line sits where Rainbow Road's start grid is)
export function toWorld(gen, START) {
  const W = p => [START[0] + p[0], START[1] + p[1], START[2] + p[2]];
  const f = Math.fround;
  const v3 = p => W(p).map(f);
  return {
    parts: gen.parts.map(p => ({ ...p, pos: v3(p.local) })),
    lap: gen.lap.map(n => ({ ...n, pos: v3(n.pos), dyn: n.dyn ? (n.dyn.CheckPoint !== undefined ? { CheckPoint: n.dyn.CheckPoint } : n.dyn) : null })),
    route: gen.route.map(n => ({ ...n, pos: v3(n.pos) })),
    routes: gen.routes ? gen.routes.map(r => r.map(n => ({ ...n, pos: v3(n.pos) }))) : null,
    starts: gen.starts ? gen.starts.map(b => ({ ...b, pos: v3(b.pos) })) : null,
    lapRails: gen.lapRails ? gen.lapRails.map(r => ({ ...r, nodes: r.nodes.map(n => ({ ...n, pos: v3(n.pos) })) })) : null,
    routeRails: gen.routeRails ? gen.routeRails.map(r => ({ ...r, nodes: r.nodes.map(n => ({ ...n, pos: v3(n.pos) })) })) : null,
    actors: gen.actors.map(a => ({ ...a, pos: v3(a.pos) })),
    extent: [W(gen.bounds[0]), W(gen.bounds[1])],
  };
}
export { MAT };
