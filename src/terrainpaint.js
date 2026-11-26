// Terrain editor (first version: ground materials). A top-down 2D view of a piece of the open world: paint its ground
// materials with a brush, then save the changed .mate files as a mod.
// Loading reads only the ground files for the detail you're viewing. Every brush stroke is also kept as a list of dabs; when
// you save, the other levels of detail under your painting (nearer and farther views) are read then and get the same strokes,
// so the change shows near and far.
import { readTscb, readMate, writeMate, readHeights, areasIn, matePath, hghtPath, TSCB_PATH, paintPixel, dominant, PX, WMIN } from './terrainmat.js';

const CELL = 250;   // areas are chosen in 250 m squares
// detail levels: which level of the game's ground files the view is drawn from (level 4: 1 km files ~3.9 m a pixel, ... 7: 125 m ~0.49 m)
const DETAILS = [
  { label: 'Very low (about 4 m)', L: 4, max: 24 },
  { label: 'Low (about 2 m)', L: 5, max: 12 },
  { label: 'Normal (about 1 m)', L: 6, max: 6 },
  { label: 'High (about 0.5 m)', L: 7, max: 4 },
];
// material colours in the view (the game's own colours come from other maps, so these are just to tell them apart)
const KNOWN = { 1: ['Road bed (dirt)', [196, 168, 118]], 8: ['Road edge (dirt)', [214, 190, 140]], 27: ['Soil', [138, 104, 70]], 26: ['Rock', [128, 128, 124]],
  29: ['River bed', [60, 100, 170]], 36: ['Grass', [92, 150, 74]], 37: ['Grass, darker', [62, 112, 52]], 38: ['Dry earth', [178, 152, 104]], 32: ['Stone', [170, 170, 170]], 4: ['Sand road', [226, 200, 150]] };
function colourOf(i) {
  if (KNOWN[i]) return KNOWN[i][1];
  const h = (i * 137.508) % 360, s = 0.45, l = 0.52, k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}
const NAMES_KEY = 'mkwe-terrain-names', PREF_KEY = 'mkwe-terrain-paint';
const tick = () => new Promise(r => setTimeout(r));

export function setupTerrainEditor(D) {
  const { $, el, toast, busy, S, readAt, writeAt, walk, permit, zsDecompress, zsStore, parseRstb, rstbGet, rstbSet, writeRstb, manifestFor, modMeta, makeZip, saveFile, FRM, FR_HALF, frLoadMap, idb } = D;
  const pal = Array.from({ length: 256 }, (_, i) => colourOf(i));
  let names = {}; try { names = JSON.parse(localStorage.getItem(NAMES_KEY) || '{}'); } catch {}
  const matName = i => names[i] || KNOWN[i]?.[0] || `Material ${i}`;
  const P = { det: 2, tool: 'paint', size: 6, strength: 1, soft: 0.5, mat: 1, shade: true, grid: true, mod: 'TerrainPaint' };
  try { const o = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); if (o.det === undefined && o.detail !== undefined) o.det = o.detail ? 3 : 2; delete o.detail; Object.assign(P, o); } catch {}
  if (!(P.det >= 0 && P.det < DETAILS.length)) P.det = 2;
  const DET = () => DETAILS[P.det], MAXC = () => DET().max, km = () => (MAXC() * 0.25).toString();
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(P)); } catch {} };
  const T = { tscb: null, region: null, sel: null, box: null, ppm: 1, view: { cx: 0, cz: 2000, k: 0.05 }, picking: true, zoomPick: false,
    areas: [], byName: new Map(), disp: new Map(), shownL: 6, img: null, ctx: null, id: null,
    ops: [], undo: [], redo: [], stroke: null, drag: null, hover: null, counts: null, dirs: null, loading: false };

  // ------------------------------------------------------------ UI
  const dlg = $('#tpdlg'), cv = $('#tp_cv');
  const fit = () => { const r = cv.getBoundingClientRect(); const w = Math.max(100, Math.round(r.width)), h = Math.max(100, Math.round(r.height)); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } };
  const progress = (n, total, what) => {
    const w = $('#tp_progwrap'); if (total === undefined) { w.style.display = 'none'; return; }
    w.style.display = ''; $('#tp_prog').max = Math.max(1, total); $('#tp_prog').value = n; $('#tp_progtxt').textContent = `${what} ${Math.min(n, total)} of ${total}`;
  };
  const status = (msg, err) => { const e = $('#tp_msg'); e.textContent = msg || ''; e.style.display = msg ? '' : 'none'; e.style.color = err ? '#ff8a4a' : ''; };
  function syncUI() {
    $('#tp_size').value = P.size; $('#tp_sizev').textContent = P.size + ' m';
    $('#tp_str').value = Math.round(P.strength * 100); $('#tp_strv').textContent = Math.round(P.strength * 100) + '%';
    $('#tp_soft').value = Math.round(P.soft * 100); $('#tp_softv').textContent = Math.round(P.soft * 100) + '%';
    $('#tp_shade').checked = P.shade; $('#tp_detail').value = String(P.det); $('#tp_grid').checked = P.grid; $('#tp_mod').value = P.mod;
    document.querySelectorAll('#tpdlg [data-tptool]').forEach(b => b.classList.toggle('on', b.dataset.tptool === P.tool));
    const c = pal[P.mat]; $('#tp_cur').innerHTML = ''; $('#tp_cur').append(el('span', { class: 'tpsw', style: `background:rgb(${c})` }), el('b', {}, `${P.mat}`), ' ' + matName(P.mat));
    $('#tp_undo').disabled = !T.undo.length; $('#tp_redo').disabled = !T.redo.length;
    const shown = DETAILS.find(d => d.L === T.shownL);
    $('#tp_state').textContent = T.picking || !T.box ? `Drag on the map to choose ${T.zoomPick ? 'the part to zoom into' : 'an area'} (up to ${km()} × ${km()} km at ${DET().label.split(' (')[0].toLowerCase()} detail)${T.zoomPick ? '' : ', then press Load'}.`
      : `${shown ? shown.label.split(' (')[0] : 'Normal'} detail. ${T.ops.length ? `${T.ops.length} stroke${T.ops.length > 1 ? 's' : ''} painted (not saved yet: Save as mod).` : 'Nothing painted yet.'} Painting stays inside the area.`;
    $('#tp_pickbar').style.display = T.picking ? '' : 'none';
  }
  function fillPalette() {
    const box = $('#tp_pal'); box.innerHTML = '';
    const only = $('#tp_used').checked, n = T.tscb ? T.tscb.mats.length : 62;
    for (let i = 0; i < n; i++) {
      const cnt = T.counts ? T.counts[i] : 0; if (only && T.counts && !cnt) continue;
      const row = el('div', { class: 'tprow' + (i === P.mat ? ' on' : ''), title: `Material ${i}${T.tscb ? ` (texture ${T.tscb.mats[i].slice})` : ''}. Click to paint with it, double-click to rename.`,
        onclick: () => { P.mat = i; savePrefs(); if (P.tool === 'pick') P.tool = 'paint'; syncUI(); fillPalette(); },
        ondblclick: () => { const v = prompt(`A name for material ${i}:`, matName(i)); if (v === null) return; if (v.trim()) names[i] = v.trim(); else delete names[i]; try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch {} fillPalette(); syncUI(); } },
        el('span', { class: 'tpsw', style: `background:rgb(${pal[i]})` }), el('b', {}, String(i)), el('span', {}, matName(i)), el('span', { class: 'cnt' }, cnt ? (cnt > 9999 ? Math.round(cnt / 1000) + 'k' : String(cnt)) : ''));
      box.append(row);
    }
  }

  // ------------------------------------------------------------ reading files (folder handles looked up once)
  async function dirsOf() {
    const sub = async root => { try { return await (await root.getDirectoryHandle('TerrainArc')).getDirectoryHandle('Game03_Proc'); } catch { return null; } };
    let mod = null;
    const mods = S.modsDir;
    if (mods && window.showDirectoryPicker) try { if (await mods.queryPermission({ mode: 'readwrite' }) === 'granted') mod = await sub(await (await mods.getDirectoryHandle(P.mod)).getDirectoryHandle('romfs')); } catch {}
    return { game: await sub(S.romfs), base: S.baseRomfs ? await sub(S.baseRomfs) : null, mod };
  }
  const readIn = async (dir, name) => { if (!dir) return null; try { return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer()); } catch { return null; } };
  const readGame = async name => (await readIn(T.dirs.game, name)) || (await readIn(T.dirs.base, name));
  // read one area's material file (from your mod first, if it has one), heights only for the areas the view is drawn from
  async function readArea(a, withHeights) {
    let file = await readIn(T.dirs.mod, a.name + '.mate'), own = !!file, origImg = null;
    if (!file) file = await readGame(a.name + '.mate');
    if (!file) return null;
    const m = readMate(file);
    if (own) { const o = await readGame(a.name + '.mate'); if (o) try { origImg = readMate(o).img; } catch {} }
    const area = { ...a, file, m, img: m.img, base: m.img.slice(), orig: origImg || m.img.slice(), own, dirty: false };
    if (withHeights) { try { area.h = readHeights(await readGame(a.name + '.hght')); } catch { area.h = null; } }
    return area;
  }
  // read many at once (a few in flight together), with the progress bar
  async function readMany(list, withHeights, what) {
    const out = new Array(list.length); let next = 0, done = 0;
    progress(0, list.length, what);
    const worker = async () => { while (next < list.length) { const i = next++; try { out[i] = await readArea(list[i], withHeights(list[i])); } catch (e) { console.error(e); out[i] = null; } done++; progress(done, list.length, what); } };
    await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
    return out;
  }
  async function ensureTscb() {
    if (T.tscb) return true;
    const raw = await readAt(S.romfs, TSCB_PATH); if (!raw) return false;
    T.tscb = readTscb(raw); return true;
  }

  // ------------------------------------------------------------ loading the view
  // each step says what it's doing (and gives up with a message if a step hangs), so a stuck load shows where
  const step = async (msg, p, ms = 30000) => { status(msg); let t; const to = new Promise((_, rej) => t = setTimeout(() => rej(new Error(`no answer after ${ms / 1000} s while: ${msg}`)), ms)); try { return await Promise.race([p, to]); } finally { clearTimeout(t); } };
  async function load() {
    if (T.loading) { status('Still loading… (press Load again in a moment if nothing happens)'); if (Date.now() - T.loading > 60000) T.loading = false; return; }
    T.loading = Date.now(); status('Starting…');
    try { await load2(); } catch (e) { console.error(e); status('Couldn\'t load: ' + (e.message || e), true); toast('Couldn\'t load the ground: ' + (e.message || e), 'err'); }
    T.loading = false; progress(); busy(); syncUI(); if ($('#tp_msg').textContent.endsWith('…')) status('');
  }
  async function load2() {
    if (!S.romfs || S.romfs.fake) { status('Open RomFS first (File ▸ Open RomFS…): the ground is read from your game files.', true); return; }
    if (!T.region) { status('Drag on the map to choose an area first.', true); return; }
    const r = T.region;
    if (r[2] - r[0] >= MAXC() || r[3] - r[1] >= MAXC()) { T.picking = true; draw(); status(`That area is too big for ${DET().label.split(' (')[0].toLowerCase()} detail (up to ${km()} km across): choose a smaller one, or less detail.`, true); return; }
    if (T.ops.length && !confirm('Load a new area? What you painted and haven\'t saved will be lost.')) return;
    if (!await step('Reading the world\'s ground list (Game03_Proc.tscb)…', ensureTscb())) { status('This RomFS has no TerrainArc/Game03_Proc.tscb: open the update\'s romfs (and the base game\'s romfs too, if you have it).', true); return; }
    T.dirs = await step('Finding the ground folder…', dirsOf());
    if (!T.dirs.game && !T.dirs.base) { status('This RomFS has no TerrainArc/Game03_Proc folder: open the update\'s romfs.', true); return; }
    const x0 = WMIN + r[0] * CELL, z0 = WMIN + r[1] * CELL, x1 = WMIN + (r[2] + 1) * CELL, z1 = WMIN + (r[3] + 1) * CELL, L = DET().L;
    // the view's own level (and, for High, level 6 where level 7 has no file)
    const want = areasIn(T.tscb, x0, z0, x1, z1).filter(a => a.level === L || (L === 7 && a.level === 6));
    status(`Reading ${want.length} ground files…`); const got = await step('Reading the ground files…', readMany(want, () => true, 'Reading the ground…'), 180000);
    T.areas = got.filter(Boolean); T.byName = new Map(T.areas.map(a => [a.name, a])); T.disp = new Map();
    for (const a of T.areas) { if (!T.disp.has(a.level)) T.disp.set(a.level, new Map()); T.disp.get(a.level).set(Math.round((a.x - WMIN) / a.size) * 65536 + Math.round((a.z - WMIN) / a.size), a); }
    T.ops = []; T.undo = []; T.redo = [];
    if (!T.areas.length) { status(`Couldn't read this area's ground files (TerrainArc/Game03_Proc/…mate). Open the update's romfs (with the base game's romfs too if you have it).`, true); return; }
    progress(1, 1, 'Drawing the map…'); $('#tp_progtxt').textContent = 'Drawing the map…'; status('Drawing the map…'); await tick();
    T.picking = false; T.zoomPick = false; T.shownL = L; T.box = [x0, z0, x1, z1]; T.ppm = 257 / (16000 / 2 ** L);
    for (const a of T.areas) shadeOf(a);
    const W = Math.ceil((x1 - x0) * T.ppm), H = Math.ceil((z1 - z0) * T.ppm), c = document.createElement('canvas'); c.width = W; c.height = H;
    T.img = c; T.ctx = c.getContext('2d'); T.id = T.ctx.createImageData(W, H);
    T.view.cx = (x0 + x1) / 2; T.view.cz = (z0 + z1) / 2; fit(); T.view.k = Math.min(cv.width / (x1 - x0), cv.height / (z1 - z0)) * 0.95;
    renderAll(); countMats(); fillPalette(); draw();
    const own = T.areas.filter(a => a.own).length;
    toast(`Loaded. Left-drag to paint.${own ? ` Carried on from your mod "${P.mod}" (${own} file(s) already painted there).` : ''}`, 'ok');
  }
  function countMats() {
    const c = new Uint32Array(256), [x0, z0, x1, z1] = T.box;
    for (const m of T.disp.values()) for (const a of m.values()) {
      const ps = a.size / 257;
      for (let q = 2; q <= 258; q++) { const z = a.z + (q - 1.5) * ps; if (z < z0 || z > z1) continue;
        for (let p = 2; p <= 258; p++) { const x = a.x + (p - 1.5) * ps; if (x < x0 || x > x1 || areaAt(x, z) !== a) continue; c[dominant(a.img[q * PX + p])]++; } } }
    T.counts = c;
  }

  // ------------------------------------------------------------ the picture
  function shadeOf(a) {
    const sh = a.sh = new Float32Array(PX * PX).fill(1), h = a.h, step = a.size / 257; if (!h) return;
    for (let q = 1; q < PX - 1; q++) for (let p = 1; p < PX - 1; p++) {
      const gx = (h[q * PX + p + 1] - h[q * PX + p - 1]) / (2 * step), gz = (h[(q + 1) * PX + p] - h[(q - 1) * PX + p]) / (2 * step);
      sh[q * PX + p] = Math.max(0.35, Math.min(1.35, 1 + (-gx - gz) * 0.6 / Math.sqrt(1 + gx * gx + gz * gz)));
    }
  }
  // the most detailed shown area at a world spot
  function areaAt(x, z) {
    for (let L = T.shownL; L >= T.shownL - 1; L--) {
      const m = T.disp.get(L); if (!m) continue; const s = 16000 / 2 ** L;
      const a = m.get(Math.floor((x - WMIN) / s) * 65536 + Math.floor((z - WMIN) / s)); if (a) return a;
    }
    return null;
  }
  const texel = (a, k, out, wgt) => { const v = a.img[k], A = v & 255, B = (v >>> 8) & 255, t = ((v >>> 16) & 255) / 255, ca = pal[A], cb = pal[B], s = (P.shade ? a.sh[k] : 1) * wgt;
    out[0] += (ca[0] + (cb[0] - ca[0]) * t) * s; out[1] += (ca[1] + (cb[1] - ca[1]) * t) * s; out[2] += (ca[2] + (cb[2] - ca[2]) * t) * s; };
  // redraw the picture over a world box (colours blended smoothly between the ground's pixels)
  function renderRect(wx0, wz0, wx1, wz1) {
    const [X0, Z0] = T.box, r = T.ppm, W = T.id.width, H = T.id.height, d = T.id.data, c = [0, 0, 0];
    const u0 = Math.max(0, Math.floor((wx0 - X0) * r)), u1 = Math.min(W - 1, Math.ceil((wx1 - X0) * r)), v0 = Math.max(0, Math.floor((wz0 - Z0) * r)), v1 = Math.min(H - 1, Math.ceil((wz1 - Z0) * r));
    if (u0 > u1 || v0 > v1) return;
    for (let v = v0; v <= v1; v++) { const z = Z0 + (v + 0.5) / r;
      for (let u = u0; u <= u1; u++) { const x = X0 + (u + 0.5) / r, a = areaAt(x, z), o = (v * W + u) * 4;
        if (!a) { d[o] = d[o + 1] = d[o + 2] = 20; d[o + 3] = 255; continue; }
        const fp = 1.5 + (x - a.x) / a.size * 257, fq = 1.5 + (z - a.z) / a.size * 257, p = Math.floor(fp), q = Math.floor(fq), tx = fp - p, tz = fq - q, k = q * PX + p;
        c[0] = c[1] = c[2] = 0;
        texel(a, k, c, (1 - tx) * (1 - tz)); texel(a, k + 1, c, tx * (1 - tz)); texel(a, k + PX, c, (1 - tx) * tz); texel(a, k + PX + 1, c, tx * tz);
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      } }
    T.ctx.putImageData(T.id, 0, 0, u0, v0, u1 - u0 + 1, v1 - v0 + 1);
  }
  function renderAll() { renderRect(...T.box); }

  // ------------------------------------------------------------ view
  const toScreen = (x, z) => [cv.width / 2 + (x - T.view.cx) * T.view.k, cv.height / 2 + (z - T.view.cz) * T.view.k];
  const toWorld = e => { const r = cv.getBoundingClientRect(), px = (e.clientX - r.left) * cv.width / r.width, py = (e.clientY - r.top) * cv.height / r.height; return [T.view.cx + (px - cv.width / 2) / T.view.k, T.view.cz + (py - cv.height / 2) / T.view.k]; };
  function draw() {
    fit(); const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0d1a2b'; ctx.fillRect(0, 0, W, H);
    const [mx0, mz0] = toScreen(-FR_HALF, -FR_HALF), [mx1, mz1] = toScreen(FR_HALF, FR_HALF);
    if (FRM.img) { ctx.imageSmoothingEnabled = true; ctx.globalAlpha = T.img && !T.picking ? 0.45 : 1; ctx.drawImage(FRM.img, mx0, mz0, mx1 - mx0, mz1 - mz0); ctx.globalAlpha = 1; }
    if (T.img && T.box) {
      const [ax, az] = toScreen(T.box[0], T.box[1]), [bx, bz] = toScreen(T.box[2], T.box[3]);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(T.img, 0, 0, (T.box[2] - T.box[0]) * T.ppm, (T.box[3] - T.box[1]) * T.ppm, ax, az, bx - ax, bz - az);
    }
    const cellPx = CELL * T.view.k;
    if (P.grid && cellPx > 12) {
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; ctx.beginPath();
      const [wx0, wz0] = [T.view.cx - W / 2 / T.view.k, T.view.cz - H / 2 / T.view.k], [wx1, wz1] = [T.view.cx + W / 2 / T.view.k, T.view.cz + H / 2 / T.view.k];
      for (let x = Math.ceil(wx0 / CELL) * CELL; x <= wx1; x += CELL) { const s = toScreen(x, 0)[0]; ctx.moveTo(s, 0); ctx.lineTo(s, H); }
      for (let z = Math.ceil(wz0 / CELL) * CELL; z <= wz1; z += CELL) { const s = toScreen(0, z)[1]; ctx.moveTo(0, s); ctx.lineTo(W, s); }
      ctx.stroke();
    }
    if (FRM.names && (T.picking || cellPx < 60)) { ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
      for (const n of FRM.names) { const [x, y] = toScreen(n.x, n.z); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(n.label, x + 1, y + 1); ctx.fillStyle = '#fff'; ctx.fillText(n.label, x, y); }
      ctx.textAlign = 'left'; }
    const box = T.sel || T.region;
    if (box && (T.picking || T.sel)) { const [ax, az] = toScreen(WMIN + box[0] * CELL, WMIN + box[1] * CELL), [bx, bz] = toScreen(WMIN + (box[2] + 1) * CELL, WMIN + (box[3] + 1) * CELL);
      ctx.fillStyle = 'rgba(255,225,74,0.15)'; ctx.fillRect(ax, az, bx - ax, bz - az); ctx.strokeStyle = '#ffe14a'; ctx.lineWidth = 2; ctx.strokeRect(ax, az, bx - ax, bz - az); }
    if (!T.picking && T.hover) { const [x, y] = toScreen(T.hover[0], T.hover[1]), r = P.size * T.view.k;
      ctx.strokeStyle = P.tool === 'restore' ? '#ff8a4a' : '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, Math.max(2, r), 0, 7); ctx.stroke();
      if (P.soft > 0.02 && r > 6) { ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(x, y, r * (1 - P.soft), 0, 7); ctx.stroke(); ctx.setLineDash([]); } }
  }
  function readout(x, z) {
    const a = T.box ? areaAt(x, z) : null;
    let s = `x ${Math.round(x)}, z ${Math.round(z)}`;
    if (a) { const p = Math.round(1.5 + (x - a.x) / a.size * 257), q = Math.round(1.5 + (z - a.z) / a.size * 257), v = a.img[q * PX + p], A = v & 255, B = (v >>> 8) & 255, t = (v >>> 16) & 255;
      s += t === 0 || A === B ? ` · ${A} ${matName(A)}` : ` · ${A} ${matName(A)} / ${B} ${matName(B)} (${Math.round(t / 2.55)}% of the second)`;
      if (a.h) s += ` · height ${Math.round(a.h[q * PX + p])} m`; }
    $('#tp_read').textContent = s;
    return a;
  }

  // ------------------------------------------------------------ painting
  // one dab of a stroke on one area. rec: the area's picture before the stroke, and the strongest weight given to each pixel so far
  function dabOn(a, st, recs, x, z) {
    const r = st.size, soft = st.soft, ps = a.size / 257, pad = r + 2 * ps;
    if (x + pad < a.x || x - pad > a.x + a.size || z + pad < a.z || z - pad > a.z + a.size) return false;
    const [bx0, bz0, bx1, bz1] = T.box, pc = 1.5 + (x - a.x) / ps, qc = 1.5 + (z - a.z) / ps, rr = Math.max(r / ps, 1e-6);
    const p0 = Math.max(0, Math.floor(pc - rr)), p1 = Math.min(PX - 1, Math.ceil(pc + rr)), q0 = Math.max(0, Math.floor(qc - rr)), q1 = Math.min(PX - 1, Math.ceil(qc + rr));
    let rec = recs.get(a), hit = false;
    for (let q = q0; q <= q1; q++) for (let p = p0; p <= p1; p++) {
      const d = Math.hypot(p - pc, q - qc) / rr; if (d > 1) continue;
      const wx = a.x + (p - 1.5) * ps, wz = a.z + (q - 1.5) * ps; if (wx < bx0 || wx > bx1 || wz < bz0 || wz > bz1) continue;   // only inside the area
      const inner = 1 - soft, f = d <= inner ? 1 : soft > 0 ? (1 - (d - inner) / soft) : 0, w = st.tool === 'restore' ? f : Math.min(1, st.strength * f * f * (3 - 2 * f));
      if (w <= 0.004) continue;
      if (!rec) { rec = { before: a.img.slice(), w: new Float32Array(PX * PX) }; recs.set(a, rec); }
      const k = q * PX + p; if (w <= rec.w[k]) continue; rec.w[k] = w;
      const base = rec.before[k];
      a.img[k] = st.tool === 'restore' ? (w >= 0.5 ? a.orig[k] : base) : paintPixel(base, st.mat, w);
      a.dirty = true; hit = true;
    }
    return hit;
  }
  function dab(x, z) {
    const st = T.stroke; st.dabs.push([x, z]); let hit = false;
    for (const a of T.areas) if (dabOn(a, st, st.recs, x, z)) hit = true;
    if (hit) renderRect(x - st.size - 2, z - st.size - 2, x + st.size + 2, z + st.size + 2);
  }
  function strokeTo(x, z) {
    const st = T.stroke, last = st.last, step = Math.max(0.2, P.size * 0.25);
    if (!last) dab(x, z);
    else { const d = Math.hypot(x - last[0], z - last[1]), n = Math.ceil(d / step); for (let i = 1; i <= n; i++) dab(last[0] + (x - last[0]) * i / n, last[1] + (z - last[1]) * i / n); }
    st.last = [x, z];
  }
  const newStroke = () => ({ tool: P.tool === 'restore' ? 'restore' : 'paint', mat: P.mat, size: P.size, soft: P.soft, strength: P.strength, dabs: [], recs: new Map(), last: null });
  function endStroke() {
    const st = T.stroke; T.stroke = null; if (!st || !st.recs.size) return;
    const op = { tool: st.tool, mat: st.mat, size: st.size, soft: st.soft, strength: st.strength, dabs: st.dabs };
    T.ops.push(op); T.undo.push({ op, snaps: [...st.recs].map(([a, r]) => ({ a, before: r.before, after: a.img.slice() })) }); T.redo = [];
    countMats(); fillPalette(); syncUI();
  }
  // play strokes onto an area that was read after they were painted (the other levels of detail, read when saving)
  function replay(a, ops) {
    a.img.set(a.base); a.dirty = false;
    for (const op of ops) { const recs = new Map(); for (const [x, z] of op.dabs) dabOn(a, op, recs, x, z); }
  }
  function applyHist(from, to, key) {
    const h = from.pop(); if (!h) return;
    for (const e of h.snaps) e.a.img.set(e[key]);
    if (key === 'before') T.ops.splice(T.ops.lastIndexOf(h.op), 1); else T.ops.push(h.op);
    // areas read later (at saving) weren't in the snapshots: play the strokes again on them
    const known = new Set(h.snaps.map(e => e.a));
    for (const a of T.areas) if (a.extra && !known.has(a)) replay(a, T.ops);
    for (const a of T.areas) if (!a.extra) a.dirty = a.img.some((v, i) => v !== a.base[i]);
    to.push(h); renderAll(); countMats(); fillPalette(); syncUI(); draw();
  }
  function pick(x, z) {
    const a = readout(x, z); if (!a) return;
    const p = Math.round(1.5 + (x - a.x) / a.size * 257), q = Math.round(1.5 + (z - a.z) / a.size * 257);
    P.mat = dominant(a.img[q * PX + p]); P.tool = 'paint'; savePrefs(); syncUI(); fillPalette();
    $('#tp_pal .tprow.on')?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ saving
  // read the other levels of detail under the painting, and give them the same strokes
  async function fillOtherLevels() {
    if (!T.ops.length) return;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const op of T.ops) for (const [x, z] of op.dabs) { x0 = Math.min(x0, x - op.size); z0 = Math.min(z0, z - op.size); x1 = Math.max(x1, x + op.size); z1 = Math.max(z1, z + op.size); }
    const [bx0, bz0, bx1, bz1] = T.box; x0 = Math.max(x0, bx0); z0 = Math.max(z0, bz0); x1 = Math.min(x1, bx1); z1 = Math.min(z1, bz1);
    if (x0 >= x1 || z0 >= z1) return;
    const need = areasIn(T.tscb, x0, z0, x1, z1).filter(a => !T.byName.has(a.name));
    if (!need.length) return;
    const got = await readMany(need, () => false, 'Painting the other levels of detail…');
    for (const a of got) { if (!a) continue; a.extra = true; a.sh = null; replay(a, T.ops); T.areas.push(a); T.byName.set(a.name, a); }
  }
  async function buildFiles(existing) {
    await fillOtherLevels();
    const files = new Map(), dirty = T.areas.filter(a => a.dirty || a.own);
    progress(0, dirty.length, 'Writing the ground files…');
    let n = 0; for (const a of dirty) { files.set(matePath(a.name), writeMate(a.file, a.m, a.img)); if (++n % 8 === 0) { progress(n, dirty.length, 'Writing the ground files…'); await tick(); } }
    let tblPath = null;
    const sysRes = await S.romfs.getDirectoryHandle('System').then(d => d.getDirectoryHandle('Resource')).catch(() => null);
    if (sysRes) for await (const [nm] of sysRes.entries()) if (/^ResourceSizeTable\.Product\.\d+\..*rsizetable\.zs$/.test(nm)) tblPath = 'System/Resource/' + nm;
    if (tblPath) {
      const base = (existing && await existing(tblPath)) || await readAt(S.romfs, tblPath);
      const tbl = parseRstb(zsDecompress(base)); let changed = false;
      for (const [p, b] of files) { const need = Math.ceil((b.length + 512) / 32) * 32; if (need > (rstbGet(tbl, p) || 0)) { rstbSet(tbl, p, need); changed = true; } }
      if (changed) files.set(tblPath, zsStore(writeRstb(tbl)));
    }
    return { files, tblPath, n: dirty.length };
  }
  async function save(zip) {
    if (!T.ops.length && !T.areas.some(a => a.dirty)) return toast('Nothing has been painted yet.');
    P.mod = ($('#tp_mod').value || '').trim().replace(/[^A-Za-z0-9_-]+/g, '') || 'TerrainPaint'; savePrefs(); syncUI();
    try {
      if (zip || !window.showDirectoryPicker) {
        const { files, tblPath, n } = await buildFiles(), manifest = await manifestFor(files, tblPath);
        const z = [...files].map(([p, b]) => [`${P.mod}/romfs/${p}`, b]);
        z.push([`${P.mod}/romfs/manifest.tsv`, new TextEncoder().encode(manifest)], [`${P.mod}/mod.json`, new TextEncoder().encode(modMeta(P.mod, files.size))]);
        progress(); const saved = await saveFile(makeZip(z), P.mod + '.zip', 'modzip'); if (!saved) return toast('Not saved.');
        toast(`Saved ${saved} (${n} terrain files). Extract it into mkw-recomp\\mods and turn it on in the recomp's Mods page.`, 'ok');
        return;
      }
      let mods = S.modsDir;
      if (!mods || !await permit(mods, 'readwrite')) {
        toast('Pick the recomp\'s "mods" folder (inside mkw-recomp).');
        try { mods = await showDirectoryPicker({ id: 'mods', mode: 'readwrite' }); } catch { return; }
        if (!await permit(mods, 'readwrite')) return;
        try { mods = await mods.getDirectoryHandle('mods'); } catch {}
        S.modsDir = mods; idb.set('mods', mods);
      }
      const mod = await mods.getDirectoryHandle(P.mod, { create: true }), romfs = await mod.getDirectoryHandle('romfs', { create: true });
      const { files, tblPath, n } = await buildFiles(p => readAt(romfs, p));
      let k = 0; for (const [p, b] of files) { await writeAt(romfs, p, b); progress(++k, files.size, 'Saving…'); }
      const all = new Map();
      for (const [p, h] of await walk(romfs)) if (p !== 'manifest.tsv') all.set(p, new Uint8Array(await (await h.getFile()).arrayBuffer()));
      await writeAt(romfs, 'manifest.tsv', new TextEncoder().encode(await manifestFor(all, tblPath)));
      await writeAt(mod, 'mod.json', new TextEncoder().encode(modMeta(P.mod, all.size)));
      toast(`Saved mod "${P.mod}" (${n} terrain files). Turn it on in the recomp's Mods page.`, 'ok');
    } catch (e) { console.error(e); toast('Saving failed: ' + e.message, 'err'); status('Saving failed: ' + e.message, true); }
    finally { progress(); }
  }

  // ------------------------------------------------------------ events
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); const [x, z] = toWorld(e);
    if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey && !T.picking)) { T.drag = { pan: true, x: e.clientX, y: e.clientY, cx: T.view.cx, cz: T.view.cz }; return; }
    if (T.picking) { const t = [Math.floor((x - WMIN) / CELL), Math.floor((z - WMIN) / CELL)]; T.drag = { t }; T.sel = [t[0], t[1], t[0], t[1]]; draw(); return; }
    if (!T.box || T.loading) return;
    if (e.altKey || P.tool === 'pick') { pick(x, z); return; }
    T.stroke = newStroke(); T.drag = { paint: true }; strokeTo(x, z); draw();
  });
  cv.addEventListener('pointermove', e => {
    const [x, z] = toWorld(e); T.hover = [x, z]; if (!T.picking) readout(x, z);
    if (T.drag?.pan) { const r = cv.getBoundingClientRect(), k = T.view.k * r.width / cv.width; T.view.cx = T.drag.cx - (e.clientX - T.drag.x) / k; T.view.cz = T.drag.cz - (e.clientY - T.drag.y) / k; }
    else if (T.drag?.t) { const s = T.drag.t, ti = Math.floor((x - WMIN) / CELL), tj = Math.floor((z - WMIN) / CELL), M = MAXC();
      const a = [Math.min(s[0], ti), Math.min(s[1], tj), Math.max(s[0], ti), Math.max(s[1], tj)];
      if (a[2] - a[0] >= M) { if (ti > s[0]) a[2] = a[0] + M - 1; else a[0] = a[2] - M + 1; }
      if (a[3] - a[1] >= M) { if (tj > s[1]) a[3] = a[1] + M - 1; else a[1] = a[3] - M + 1; }
      T.sel = a; }
    else if (T.drag?.paint) strokeTo(x, z);
    draw();
  });
  cv.addEventListener('pointerup', () => { if (T.drag?.t && T.sel) { T.region = T.sel; syncUI(); if (T.zoomPick) setTimeout(load); } if (T.drag?.paint) endStroke(); T.sel = null; T.drag = null; draw(); });
  cv.addEventListener('pointerleave', () => { T.hover = null; draw(); });
  cv.addEventListener('wheel', e => { e.preventDefault();
    if (e.ctrlKey && !T.picking) { P.size = Math.max(0.5, Math.min(150, +(P.size * (e.deltaY < 0 ? 1.15 : 0.87)).toFixed(1))); savePrefs(); syncUI(); draw(); return; }
    const [x, z] = toWorld(e), f = e.deltaY < 0 ? 1.25 : 0.8; T.view.k = Math.max(0.01, Math.min(40, T.view.k * f)); const [x2, z2] = toWorld(e); T.view.cx += x - x2; T.view.cz += z - z2; draw(); }, { passive: false });
  dlg.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); applyHist(T.undo, T.redo, 'before'); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); applyHist(T.redo, T.undo, 'after'); }
    else if (k === '[') { P.size = Math.max(0.5, +(P.size / 1.25).toFixed(1)); syncUI(); draw(); }
    else if (k === ']') { P.size = Math.min(150, +(P.size * 1.25).toFixed(1)); syncUI(); draw(); }
    else if (k === 'b') { P.tool = 'paint'; syncUI(); } else if (k === 'e') { P.tool = 'restore'; syncUI(); } else if (k === 'i') { P.tool = 'pick'; syncUI(); }
  });
  $('#tp_detail').innerHTML = ''; DETAILS.forEach((d, i) => $('#tp_detail').append(el('option', { value: String(i) }, `${d.label.replace('about ', '')}, ${d.max * 0.25} km`)));
  document.querySelectorAll('#tpdlg [data-tptool]').forEach(b => b.onclick = () => { P.tool = b.dataset.tptool; savePrefs(); syncUI(); });
  $('#tp_size').oninput = () => { P.size = +$('#tp_size').value; savePrefs(); syncUI(); };
  $('#tp_str').oninput = () => { P.strength = $('#tp_str').value / 100; savePrefs(); syncUI(); };
  $('#tp_soft').oninput = () => { P.soft = $('#tp_soft').value / 100; savePrefs(); syncUI(); };
  $('#tp_shade').onchange = () => { P.shade = $('#tp_shade').checked; savePrefs(); if (T.img) renderAll(); draw(); };
  $('#tp_detail').onchange = () => {
    P.det = +$('#tp_detail').value; savePrefs(); syncUI(); status('');
    if (!T.region || T.picking) { draw(); return; }
    const r = T.region;
    if (r[2] - r[0] >= MAXC() || r[3] - r[1] >= MAXC()) { T.picking = true; syncUI(); draw(); status(`The loaded area is too big for this detail: drag a smaller one (up to ${km()} km across), then Load.`, true); return; }
    if (confirm('Load the area again at this detail?' + (T.ops.length ? ' (Save first: unsaved painting would be lost.)' : ''))) load();
  };
  $('#tp_zoom').onclick = () => { if (!T.box || T.picking) return toast('Load an area first, then zoom into a part of it.');
    P.det = DETAILS.length - 1; savePrefs(); T.picking = true; T.zoomPick = true; syncUI(); draw(); toast(`Drag a box round the part to work on (up to ${km()} × ${km()} km). It loads at high detail, and only that part gets painted.`); };
  $('#tp_grid').onchange = () => { P.grid = $('#tp_grid').checked; savePrefs(); draw(); };
  $('#tp_used').onchange = fillPalette;
  $('#tp_undo').onclick = () => applyHist(T.undo, T.redo, 'before');
  $('#tp_redo').onclick = () => applyHist(T.redo, T.undo, 'after');
  $('#tp_area').onclick = () => { T.picking = true; T.zoomPick = false; fit(); T.view.k = Math.max(T.view.k / 8, cv.width / 6000); syncUI(); draw(); };
  $('#tp_load').onclick = load;
  $('#tp_save').onclick = () => save(false);
  $('#tp_zip').onclick = () => save(true);
  $('#tp_close').onclick = () => { if (T.ops.length && !confirm('Close the terrain editor? Unsaved painting stays here until you load another area or close the editor program.')) return; dlg.close(); };
  window.addEventListener('resize', () => dlg.open && draw());
  // anything that goes wrong while the editor is open shows in its panel
  window.addEventListener('error', e => { if (dlg.open) status('Error: ' + (e.message || e.error), true); });
  window.addEventListener('unhandledrejection', e => { if (dlg.open) status('Error: ' + (e.reason?.message || e.reason), true); });

  if (window.__mkwe) window.__mkwe.TP = { T, P, load, strokeTo, endStroke, newStroke, buildFiles, draw };
  return async function open() {
    dlg.showModal(); syncUI(); fillPalette();
    if (T.picking && !T.region) { T.view.cx = -4500; T.view.cz = 1500; fit(); T.view.k = cv.width / 6000; }
    draw(); if (await frLoadMap()) draw();
    cv.focus();
  };
}
