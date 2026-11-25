// Preset models: pieces of the game's own scenery, read from the dump and added into the track's model.
// Open-world scenery (like the Toad houses) isn't a model of its own: it's merged into the world's grid pieces
// (Model/Piece_Gridify_*), so those presets are cut out of a piece and centred.
import { zsDecompress } from './formats.js';
import { loadBfres } from './bfres.js';
import { bntxToRGBA } from './astc.js';
import { readMeshShape } from './phive.js';
import { glowPicture } from './boost.js';
import { BRUSHES } from './surfaces.js';

export const PRESETS = [
  { id: 'KinokoHouse000', label: 'Toad house (with its mound and path)', model: 'Model/Piece_Gridify_Game03_X07_Z07.Gridify_Game03_X07_Z07_31.bfres.zs',
    mat: /KinokoHouse/, keep: p => p[2] < 10, yaw: 0.3730418384075165,
    tex: m => 'CmnObj_KinokoHouse000_' + m.replace(/^Mt_.*_A_Mt_/, ''), short: m => m.replace(/^Mt_.*_A_Mt_/, ''),
    cut: () => false, two: () => false, surf: m => /Body_Merged/.test(m) ? 'wall_concrete' : 'wall_concrete' },
  { id: 'TreeHardwood000', label: 'Hardwood tree', model: 'Model/CmnObj_TreeHardwood000.CmnObj_TreeHardwood000_A.bfres.zs',
    mat: /./, tex: m => 'CmnObj_TreeHardwood000_' + m.replace(/^Mt_/, '').replace(/_Inside$/, ''), short: m => m.replace(/^Mt_/, ''),
    cut: m => /Leaf/.test(m), two: m => /Leaf/.test(m), surf: m => /Leaf/.test(m) ? 'none' : 'pole_wood' },
  // ramps and panels: the game's own collision shape comes with them (col), so the model itself gets none. glow: the glowing part's look.
  // They face -Z (the way the race starts), so you drive up a ramp going -Z.
  // glide: where its glide path starts (the front edge: z, height), in the preset's own space
  ...[['GlideRamp000', 'Glider ramp', 'CmnObj_DashRamp000_Ramp_Cutout', [-6.1, 1.77]], ['GlideRamp001', 'Glider ramp (wooden)', 'CmnObj_DashRamp001_WoodRamp', [-6.1, 1.81]], ['GlideRamp002', 'Glider ramp (big)', 'CmnObj_GlideRamp002_Ramp_Cutout', [-18.7, 5.38]]].map(([id, label, body, lip]) => ({
    id, label, glide: { lip }, model: `Model/CmnObj_${id}.CmnObj_${id}_A.bfres.zs`, col: `Phive/Shape/Dcc/CmnObj_${id}_A.Nin_Ounce_NVN2.bphsh.zs`,
    mat: /./, glow: 'GlideBoard', glowMat: /Mt_Glide$/, tex: () => body, short: m => m.replace(/^Mt_/, ''), cut: () => false, two: () => false, surf: () => 'none' })),
  { id: 'GlideBoard000', label: 'Glide panel', glide: { lip: [-4.1, 0.06] }, model: 'Model/CmnObj_GlideBoard000.CmnObj_GlideBoard000_A.bfres.zs', col: 'Phive/Shape/Dcc/CmnObj_GlideBoard000_A.Nin_Ounce_NVN2.bphsh.zs', yaw: Math.PI,
    mat: /./, glow: 'GlideBoard', glowMat: /Mt_Glide$/, tex: () => 'CmnObj_DashBoard000_Frame_Cutout', short: m => m.replace(/^Mt_/, ''), cut: m => /Cutout/.test(m), two: () => false, surf: () => 'none' },
  { id: 'DashBoard000', label: 'Boost panel', model: 'Model/CmnObj_DashBoard000.CmnObj_DashBoard000_A.bfres.zs', col: 'Phive/Shape/Dcc/CmnObj_DashBoard000_A.Nin_Ounce_NVN2.bphsh.zs', yaw: Math.PI,
    mat: /./, glow: 'DashBoard', glowMat: /Mt_Dash$/, tex: () => 'CmnObj_DashBoard000_Frame_Cutout', short: m => m.replace(/^Mt_/, ''), cut: m => /Cutout/.test(m), two: () => false, surf: () => 'none' },
];
// the editor's collision brush for a (material, sub, mask) of the game's
export function brushFor([m, sub, mask]) {
  return (BRUSHES.find(b => b.mat === m && b.sub === sub && b.mask === mask) || BRUSHES.find(b => b.mat === m && b.sub === sub) || BRUSHES.find(b => b.mat === m && b.mask === mask) || BRUSHES.find(b => b.mat === m))?.id || 'road_asphalt';
}
export const presetById = id => PRESETS.find(p => p.id === id);

const toCanvas = (img) => { const c = document.createElement('canvas'); c.width = img.w; c.height = img.h; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.rgba.length), img.w, img.h), 0, 0); return c; };

// { mats: Map(name -> {pos, nrm, uv}) in the preset's own space (base at 0, metres), tex: Map(name -> {file, image}), nrm: Map(name -> canvas), def }
export async function loadPreset(def, rd) {
  const raw = await rd(def.model); if (!raw) throw new Error(`${def.model} isn't in this RomFS`);
  const model = loadBfres(zsDecompress(raw)), parts = model.parts.filter(p => def.mat.test(p.material));
  if (!parts.length) throw new Error('nothing found for ' + def.label);
  // which triangles, and where its base is
  const tris = [], mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let i = 0; i < p.indices.length; i += 3) {
    const t = [p.indices[i], p.indices[i + 1], p.indices[i + 2]];
    if (def.keep && !t.every(k => def.keep([p.positions[3 * k], p.positions[3 * k + 1], p.positions[3 * k + 2]]))) continue;
    tris.push([p, t]); for (const k of t) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p.positions[3 * k + a]); mx[a] = Math.max(mx[a], p.positions[3 * k + a]); }
  }
  const c = def.keep ? [(mn[0] + mx[0]) / 2, mn[1], (mn[2] + mx[2]) / 2] : [0, 0, 0], y = -(def.yaw || 0), cs = Math.cos(y), sn = Math.sin(y);
  const P = q => { const x = q[0] - c[0], yy = q[1] - c[1], z = q[2] - c[2]; return [cs * x + sn * z, yy, -sn * x + cs * z]; };
  const N = q => [cs * q[0] + sn * q[2], q[1], -sn * q[0] + cs * q[2]];
  const mats = new Map(), tex = new Map(), nrm = new Map(), name = m => `${def.id}_${def.short(m)}`;
  for (const [p, t] of tris) {
    const n = name(p.material); if (!mats.has(n)) mats.set(n, { pos: [], nrm: [], uv: [], src: p.material });
    const T = mats.get(n);
    for (const k of t) { T.pos.push(...P([p.positions[3 * k], p.positions[3 * k + 1], p.positions[3 * k + 2]])); T.nrm.push(...N([p.normals[3 * k], p.normals[3 * k + 1], p.normals[3 * k + 2]])); T.uv.push(p.uvs[2 * k], 1 - p.uvs[2 * k + 1]); }
  }
  // the game's own collision shape: materials of their own (collision only: no model), named by the brush they get
  const colOnly = new Map();
  if (def.col) {
    const c = await rd(def.col); if (!c) throw new Error(`${def.col} isn't in this RomFS`);
    const shape = readMeshShape(zsDecompress(c));
    for (const t of shape.tris) {
      const brush = brushFor(shape.mats[t.mat]), n = `${def.id}_col_${brush}`;
      if (!mats.has(n)) { mats.set(n, { pos: [], nrm: [], uv: [], src: n, col: true }); colOnly.set(n, brush); }
      const T = mats.get(n), q = t.p.map(P), e1 = [0, 1, 2].map(a => q[1][a] - q[0][a]), e2 = [0, 1, 2].map(a => q[2][a] - q[0][a]);
      const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...nn) || 1;
      for (const v of q) { T.pos.push(...v); T.nrm.push(...nn.map(x => x / l)); T.uv.push(0, 0); }
    }
  }
  // textures: colour (with the cut-out mask in its alpha), and the normal map turned into an ordinary blue one
  const read = async n => { try { const b = await rd(`Tex/${n}.bntx.zs`); return b ? bntxToRGBA(zsDecompress(b), 2048) : null; } catch { return null; } };
  for (const [n, T] of mats) {
    if (T.col) continue;
    if (def.glowMat && def.glowMat.test(T.src)) {   // the glowing arrows: made from the colour and the glow masks
      const alb = await read(`CmnTex_Special_${def.glow}_Dash_Alb`), emm = await read(`CmnTex_Special_${def.glow}_Dash_Emm`);
      if (alb && emm) tex.set(n, { file: `${def.glow}_Glow.png`, image: toCanvas(glowPicture(alb, emm, def.glow)) });
      continue;
    }
    const base = def.tex(T.src), alb = await read(base + '_Alb'); if (!alb) continue;
    const msk = await read(base + '_Msk'); if (msk && msk.w === alb.w && msk.h === alb.h) for (let i = 0; i < alb.rgba.length; i += 4) alb.rgba[i + 3] = msk.rgba[i];
    tex.set(n, { file: base + '_Alb.png', image: toCanvas(alb) });
    const nm = await read(base + '_Nrm');
    if (nm) { const o = new Uint8Array(nm.rgba.length); for (let i = 0; i < o.length; i += 4) { const x = nm.rgba[i], yv = nm.rgba[i + 3], nx = x / 127.5 - 1, ny = yv / 127.5 - 1; o[i] = x; o[i + 1] = yv; o[i + 2] = Math.round((Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 0.5 + 0.5) * 255); o[i + 3] = 255; } nrm.set(n, toCanvas({ w: nm.w, h: nm.h, rgba: o })); }
  }
  return { mats, tex, nrm, def, colOnly, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
}
