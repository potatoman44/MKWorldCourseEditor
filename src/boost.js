// Road pieces for the centre-line road: the game's boost panel, glide panel and glider ramp, put into the road's model with
// their own collision (Dash / Glide as the game's courses have it baked in), so they work without any map object.
// pieces: [{ kind: 'boost' | 'glidepanel' | 'ramp', s: metres along the road from the start line, x: metres left of the middle }]
import { MATERIALS } from './surfaces.js';

// arrows: the panel's glowing part (a game shader draws it; we give it a picture made from its colour and glow masks)
// body: the frame or the ramp. fwd: +1 if the model's front is +Z, -1 if it is -Z. mid: the model's z in its middle.
// col: the game's own collision shape, or (panels) collision made from the arrows (surf) and the frame (frameSurf).
export const PIECES = {
  boost: { label: 'Boost panel', model: 'Model/CmnObj_DashBoard000.CmnObj_DashBoard000_A.bfres.zs', arrowMat: /Mt_Dash$/, glow: 'DashBoard',
    arrowSlot: 'wall03', body: 'Tex/CmnObj_DashBoard000_Frame_Cutout_Alb.bntx.zs', bodySlot: 'wiremesh', bodyKey: 'dashframe',
    fwd: 1, mid: 2.25, lift: 0.03, half: 5.1, surf: [MATERIALS.indexOf('Dash'), 0, 0] },
  glidepanel: { label: 'Glide panel', model: 'Model/CmnObj_GlideBoard000.CmnObj_GlideBoard000_A.bfres.zs', arrowMat: /Mt_Glide$/, glow: 'GlideBoard',
    arrowSlot: 'wall06', body: 'Tex/CmnObj_DashBoard000_Frame_Cutout_Alb.bntx.zs', bodySlot: 'wiremesh', bodyKey: 'dashframe',
    fwd: 1, mid: 2.25, lift: 0.03, half: 5.1, surf: [MATERIALS.indexOf('Glide'), 0, 0] },
  ramp: { label: 'Glider ramp', model: 'Model/CmnObj_GlideRamp000.CmnObj_GlideRamp000_A.bfres.zs', arrowMat: /Mt_Glide$/, glow: 'GlideBoard',
    arrowSlot: 'wall06', body: 'Tex/CmnObj_DashRamp000_Ramp_Cutout_Alb.bntx.zs', bodySlot: 'framesparts', bodyKey: 'rampbody',
    col: 'Phive/Shape/Dcc/CmnObj_GlideRamp000_A.Nin_Ounce_NVN2.bphsh.zs', fwd: -1, mid: -2.7, lift: 0, half: 6.1 },
};
export const pieceOf = b => PIECES[b.kind] || PIECES.boost;
// back compatibility (v76)
export const DASH_MODEL = PIECES.boost.model, DASH_SLOT = PIECES.boost.arrowSlot, DASH_FSLOT = PIECES.boost.bodySlot;

// a piece's triangles (3 corners each) in its own space: { arrow: [{p, n, uv}], body: [...], col: [{p:[3 corners], surf}] }
// model: loadBfres() result; shape: readMeshShape() of its collision (or null)
export function pieceGeometry(def, model, shape) {
  const out = { arrow: [], body: [], col: [] };
  for (const part of model.parts) {
    const L = def.arrowMat.test(part.material) ? out.arrow : out.body;
    for (const k of part.indices) L.push({ p: [part.positions[3 * k], part.positions[3 * k + 1], part.positions[3 * k + 2]], n: [part.normals[3 * k], part.normals[3 * k + 1], part.normals[3 * k + 2]], uv: [part.uvs[2 * k], part.uvs[2 * k + 1]] });
  }
  if (shape) for (const t of shape.tris) out.col.push({ p: t.p, surf: shape.mats[t.mat] });
  else for (let i = 0; i < out.arrow.length; i += 3) out.col.push({ p: [out.arrow[i].p, out.arrow[i + 1].p, out.arrow[i + 2].p].map(q => [q[0], q[1] + 0.02, q[2]]), surf: def.surf });
  return out;
}
export const dashGeometry = model => pieceGeometry(PIECES.boost, model, null);

// the road's frame at s (between its rings): p, t (the way you drive), l (left), up
export function boostFrame(g, s) {
  const R = g.rings, L = g.stats.length; s = g.open ? Math.min(R[R.length - 1].s, Math.max(R[0].s, s)) : ((s % L) + L) % L;
  let i = 0; while (i < R.length - 2 && R[i + 1].s <= s) i++;
  const a = R[i], b = R[i + 1], f = Math.min(1, Math.max(0, (s - a.s) / ((b.s - a.s) || 1)));
  const lerp = (u, v) => u.map((x, j) => x + (v[j] - x) * f), nz = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  const p = lerp(a.p, b.p), t = nz(lerp(a.t, b.t)), l = nz(lerp(a.l, b.l)), up = nz([t[1] * l[2] - t[2] * l[1], t[2] * l[0] - t[0] * l[2], t[0] * l[1] - t[1] * l[0]]);
  return { p, t, l, up, ring: i };
}
// keep it on the road
export function boostClamp(g, b) { const hw = Math.max(0, g.opts.width / 2 - pieceOf(b).half); b.x = Math.max(-hw, Math.min(hw, b.x)); const L = g.stats.length; b.s = g.open ? Math.min(L, Math.max(0, b.s)) : ((b.s % L) + L) % L; }
// a piece's triangles in track space: its front faces the way you drive, its middle at s, b.x metres to the left
export function boostTris(g, b, G) {
  const def = pieceOf(b), F = boostFrame(g, b.s), f = def.fwd;
  const W = q => [0, 1, 2].map(j => F.p[j] + F.l[j] * (f * q[0] + b.x) + F.up[j] * (q[1] + def.lift) + F.t[j] * (f * (q[2] - def.mid)));
  const N = q => [0, 1, 2].map(j => F.l[j] * f * q[0] + F.up[j] * q[1] + F.t[j] * f * q[2]);
  const map = L => L.map(v => ({ p: W(v.p), n: N(v.n), uv: v.uv }));
  return { F, def, arrow: map(G.arrow), body: map(G.body), col: G.col.map(c => ({ p: c.p.map(W), surf: c.surf })) };
}
// put the pieces into the road parts of generate()'s result. geo: kind -> pieceGeometry
export function addBoosts(g, pieces, geo) {
  for (const b of pieces || []) {
    const G = geo[b.kind || 'boost'] || (b.kind ? null : geo); if (!G?.arrow) continue;   // (v76 passed the boost panel's geometry itself)
    boostClamp(g, b);
    const T = boostTris(g, b, G), part = g.parts.find(p => T.F.ring >= p.rings[0] && T.F.ring < p.rings[1]) || g.parts[g.parts.length - 1];
    if (!part) continue;
    const loc = q => [q[0] - part.local[0], q[1] - part.local[1], q[2] - part.local[2]];
    const put = (slot, L) => { if (!L.length) return; const Gm = part.geom[slot] = part.geom[slot] || [[], []], base = Gm[0].length;
      L.forEach(v => Gm[0].push([loc(v.p), v.n, v.uv])); for (let i = 0; i < L.length; i += 3) Gm[1].push([base + i, base + i + 1, base + i + 2]);
      for (const v of L) { const q = loc(v.p); for (let a = 0; a < 3; a++) { part.min[a] = Math.min(part.min[a], q[a]); part.max[a] = Math.max(part.max[a], q[a]); } } };
    put(T.def.arrowSlot, T.arrow); put(T.def.bodySlot, T.body);
    for (const c of T.col) {
      let tag = part.col.mats.findIndex(m => m.join() === c.surf.join()); if (tag < 0) { part.col.mats.push(c.surf); tag = part.col.mats.length - 1; }
      part.col.tris.push([c.p.map(loc), tag]);   // (the game's own winding)
    }
  }
}
// the glowing part's picture: the colour texture's colour, the glow's streaks (green) as shading and its arrow (red) lit up
export function glowPicture(alb, emm, kind) {
  const w = emm.w, h = emm.h, out = new Uint8ClampedArray(w * h * 4);
  let r = 0, gg = 0, bb = 0, n = 0; for (let i = 0; i < alb.rgba.length; i += 4) { r += alb.rgba[i]; gg += alb.rgba[i + 1]; bb += alb.rgba[i + 2]; n++; }
  const base = [r / n, gg / n, bb / n], hi = kind === 'DashBoard' ? [255, 196, 60] : [120, 205, 255];
  for (let i = 0; i < w * h; i++) {
    const a = emm.rgba[4 * i] / 255, s = emm.rgba[4 * i + 1] / 255;
    for (let c = 0; c < 3; c++) { const bg = base[c] * (0.45 + 0.75 * s); out[4 * i + c] = bg + (hi[c] - bg) * a; }
    out[4 * i + 3] = 255;
  }
  return { w, h, rgba: out };
}

// ---------------------------------------------------------------- glide paths
// The game's GlidePath: open rails of nodes (position, facing, RectSize box the glide aims through) that gliding karts and
// CPUs follow, one from each glide panel or ramp (Rainbow Road: boxes from 25 x 25 at the ramp, growing as the glide goes on).
// Ours start at the piece's front edge, rise a little, then come down to the road `len` metres on.
export const GLIDE_LEN = 150;
export const GLIDES = { ramp: { lip: 3.45, h: 1.8 }, glidepanel: { lip: 1.9, h: 0.1 } };   // front edge: metres ahead of the middle, height
const glideSteps = len => [...[0, 20, 50, 90, 140, 200, 270, 350, 450, 600, 800].filter(d => d < len - 15), len];
export function glideHeight(d, len, h0) { const up = h0 + 5 * Math.min(1, d / 20), down = Math.max(0, d - 20) / Math.max(1, len - 20); return Math.max(d >= len ? 1.5 : 2, up - (up - 1.5) * down); }
export const glideBox = (d, wide) => [Math.round(Math.min(wide, 20 + d * 0.3)), Math.round(Math.min(40, 20 + d * 0.12))];
// centre-line road: follow the road ahead
export function glidePaths(g, pieces) {
  const out = [];
  for (const b of pieces || []) {
    const G = GLIDES[b.kind]; if (!G) continue;
    const len = Math.max(30, +b.len || GLIDE_LEN), s0 = b.s + G.lip, wide = Math.max(30, g.opts.width + 2 * (g.opts.shoulder || 0) + 10);
    out.push(glideSteps(len).map(d => {
      const F = boostFrame(g, s0 + d), x = b.x * (1 - d / len), y = glideHeight(d, len, G.h);
      return { pos: [0, 1, 2].map(j => F.p[j] + F.l[j] * x + (j === 1 ? y : 0)), yaw: Math.atan2(F.t[0], F.t[2]), rs: glideBox(d, wide), ro: [0, 0] };
    }));
  }
  return out;
}
// a straight glide from a point, the way it faces (yaw: facing as atan2(dx, dz)); ground(x, z, yAbove) -> the surface height or null
export function glideStraight(start, yaw, h0, len, ground) {
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  return glideSteps(len).map(d => {
    const x = start[0] + dx * d, z = start[2] + dz * d, base = ground(x, z, start[1] + 50) ?? start[1];
    return { pos: [x, base + glideHeight(d, len, h0), z], yaw, rs: glideBox(d, 120), ro: [0, 0] };
  });
}
