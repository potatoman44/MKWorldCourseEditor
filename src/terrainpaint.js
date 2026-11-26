// Terrain editor (first version: ground materials). A top-down 2D view of a piece of the open world: paint its ground
// materials with a brush, then save the changed .mate files as a mod. Every level of detail under the brush is painted,
// so the change shows near and far.
import { readTscb, readMate, writeMate, readHeights, areasIn, matePath, hghtPath, TSCB_PATH, paintPixel, dominant, PX, WMIN } from './terrainmat.js';

const CELL = 250;   // the view is drawn from the 250 m areas (level 6), or at High detail from the 125 m ones (level 7) where the game has them
// material colours in the view (the game's own colours come from other maps, so these are just to tell them apart)
const KNOWN = { 1: ['Road bed (dirt)', [196, 168, 118]], 8: ['Road edge (dirt)', [214, 190, 140]], 27: ['Soil', [138, 104, 70]], 26: ['Rock', [128, 128, 124]],
  29: ['River bed', [60, 100, 170]], 36: ['Grass', [92, 150, 74]], 37: ['Grass, darker', [62, 112, 52]], 38: ['Dry earth', [178, 152, 104]], 32: ['Stone', [170, 170, 170]], 4: ['Sand road', [226, 200, 150]] };
function colourOf(i) {
  if (KNOWN[i]) return KNOWN[i][1];
  const h = (i * 137.508) % 360, s = 0.45, l = 0.52, k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}
const NAMES_KEY = 'mkwe-terrain-names', PREF_KEY = 'mkwe-terrain-paint';

export function setupTerrainEditor(D) {
  const { $, el, toast, busy, S, readAt, writeAt, walk, permit, zsDecompress, zsStore, parseRstb, rstbGet, rstbSet, writeRstb, manifestFor, modMeta, makeZip, saveFile, FRM, FR_HALF, frLoadMap, idb } = D;
  const pal = Array.from({ length: 256 }, (_, i) => colourOf(i));
  let names = {}; try { names = JSON.parse(localStorage.getItem(NAMES_KEY) || '{}'); } catch {}
  const matName = i => names[i] || KNOWN[i]?.[0] || `Material ${i}`;
  const P = { detail: 0, tool: 'paint', size: 6, strength: 1, soft: 0.5, mat: 1, shade: true, grid: true, mod: 'TerrainPaint' };
  try { Object.assign(P, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch {}
  const MAXC = () => P.detail ? 4 : 6;
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(P)); } catch {} };
  const T = { res: 257, box: null, l7: new Map(), zoomPick: false, tscb: null, region: null, sel: null, areas: [], l6: new Map(), img: null, ctx: null, view: { cx: 0, cz: 2000, k: 0.05 }, picking: true,
    undo: [], redo: [], stroke: null, drag: null, hover: null, counts: null };

  // ------------------------------------------------------------ UI
  const dlg = $('#tpdlg'), cv = $('#tp_cv'), side = $('#tp_side');
  const fit = () => { const r = cv.getBoundingClientRect(); const w = Math.max(100, Math.round(r.width)), h = Math.max(100, Math.round(r.height)); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } };
  function syncUI() {
    $('#tp_size').value = P.size; $('#tp_sizev').textContent = P.size + ' m';
    $('#tp_str').value = Math.round(P.strength * 100); $('#tp_strv').textContent = Math.round(P.strength * 100) + '%';
    $('#tp_soft').value = Math.round(P.soft * 100); $('#tp_softv').textContent = Math.round(P.soft * 100) + '%';
    $('#tp_shade').checked = P.shade; $('#tp_detail').value = String(P.detail); $('#tp_grid').checked = P.grid; $('#tp_mod').value = P.mod;
    document.querySelectorAll('#tpdlg [data-tptool]').forEach(b => b.classList.toggle('on', b.dataset.tptool === P.tool));
    const c = pal[P.mat]; $('#tp_cur').innerHTML = ''; $('#tp_cur').append(el('span', { class: 'tpsw', style: `background:rgb(${c})` }), el('b', {}, `${P.mat}`), ' ' + matName(P.mat));
    $('#tp_undo').disabled = !T.undo.length; $('#tp_redo').disabled = !T.redo.length;
    const dirty = T.areas.filter(a => a.dirty).length;
    $('#tp_state').textContent = !T.region ? `Drag on the map to choose an area (up to ${MAXC() * 0.25} × ${MAXC() * 0.25} km at this detail), then Load.` : T.picking ? `Drag on the map to choose ${T.zoomPick ? 'the part to zoom into' : 'an area'} (up to ${MAXC() * 0.25} × ${MAXC() * 0.25} km at this detail)${T.zoomPick ? '' : ', then Load'}.` : `${T.areas.length} terrain files loaded (all levels of detail), ${T.res > 257 ? 'high detail (about 0.5 m)' : 'normal detail (about 1 m)'}. Painting stays inside the area. ${dirty ? dirty + ' changed.' : 'Nothing painted yet.'}`;
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

  // ------------------------------------------------------------ loading
  async function ensureTscb() {
    if (T.tscb) return true;
    const raw = await readAt(S.romfs, TSCB_PATH); if (!raw) { toast('This RomFS has no TerrainArc/Game03_Proc.tscb (open the update\'s romfs, with the base game too if it\'s an update).', 'err'); return false; }
    T.tscb = readTscb(raw); return true;
  }
  async function modRomfs(create) {
    const mods = S.modsDir; if (!mods || !window.showDirectoryPicker) return null;
    try { if (await mods.queryPermission({ mode: 'readwrite' }) !== 'granted') return null; const m = await mods.getDirectoryHandle(P.mod, { create }); return await m.getDirectoryHandle('romfs', { create }); } catch { return null; }
  }
  async function load() {
    if (!S.romfs || S.romfs.fake) return toast('Open RomFS first: the ground is read from your game files.', 'err');
    if (!T.region) return toast('Drag on the map to choose an area first.', 'err');
    if (T.areas.some(a => a.dirty) && !confirm('Load a new area? What you painted and haven\'t saved will be lost.')) return;
    if (!await ensureTscb()) return;
    const [i0, j0, i1, j1] = T.region, x0 = WMIN + i0 * CELL, z0 = WMIN + j0 * CELL, x1 = WMIN + (i1 + 1) * CELL, z1 = WMIN + (j1 + 1) * CELL;
    const list = areasIn(T.tscb, x0, z0, x1, z1), mine = await modRomfs(false);
    T.areas = []; T.l6.clear(); T.l7.clear(); T.undo = []; T.redo = []; let fromMod = 0, missing = 0;
    try {
      for (let n = 0; n < list.length; n++) {
        const a = list[n]; if (n % 6 === 0) { busy(`Reading the ground… ${n} of ${list.length}`); await new Promise(r => setTimeout(r)); }
        let file = mine && await readAt(mine, matePath(a.name)), own = !!file; if (own) fromMod++; else file = await readAt(S.romfs, matePath(a.name));
        if (!file) { missing++; continue; }
        const m = readMate(file), area = { ...a, file, m, img: m.img, orig: (own && await readOrig(a.name, file)) || m.img.slice(), dirty: false };
        if (a.level >= 6) { try { area.h = readHeights(await readAt(S.romfs, hghtPath(a.name))); } catch { area.h = null; }
          (a.level === 6 ? T.l6 : T.l7).set(Math.round((a.x - WMIN) / a.size) * 4096 + Math.round((a.z - WMIN) / a.size), area); }
        T.areas.push(area);
      }
    } catch (e) { console.error(e); toast('Couldn\'t read the ground: ' + e.message, 'err'); }
    busy();
    if (!T.l6.size) { toast(`Couldn't read this area's ground files (TerrainArc/Game03_Proc/…mate)${missing ? `: ${missing} missing` : ''}. Open the update's romfs (with the base game's romfs too if you have it).`, 'err'); syncUI(); return; }
    busy('Drawing the map…'); await new Promise(r => setTimeout(r));
    T.picking = false; T.zoomPick = false; T.res = P.detail ? 514 : 257; T.box = [x0, z0, x1, z1];
    for (const a of [...T.l6.values(), ...T.l7.values()]) shadeOf(a);
    const W = (i1 - i0 + 1) * T.res, H = (j1 - j0 + 1) * T.res, c = document.createElement('canvas'); c.width = W; c.height = H;
    T.img = c; T.ctx = c.getContext('2d'); T.id = T.ctx.createImageData(W, H);
    T.view.cx = (x0 + x1) / 2; T.view.cz = (z0 + z1) / 2; fit(); T.view.k = Math.min(cv.width / (x1 - x0), cv.height / (z1 - z0)) * 0.95;
    renderAll(); countMats(); busy(); fillPalette(); syncUI(); draw();
    toast(`Loaded ${T.areas.length} terrain files. Left-drag to paint.`, 'ok');
    if (fromMod) toast(`Carried on from your mod "${P.mod}": ${fromMod} file(s) already painted there.`, 'ok');
  }
  // the game's own version (for "Restore"), when the file came from the mod
  async function readOrig(name, file) {
    const o = await readAt(S.romfs, matePath(name)); if (!o || o.length === file.length && o.every((v, i) => v === file[i])) return null;
    try { return readMate(o).img; } catch { return null; }
  }
  function countMats() {
    const c = new Uint32Array(256);
    for (const a of T.l6.values()) for (let q = 2; q <= 258; q++) for (let p = 2; p <= 258; p++) c[dominant(a.img[q * PX + p])]++;
    T.counts = c;
  }

  // ------------------------------------------------------------ the picture (from the 250 m areas)
  function shadeOf(a) {
    const sh = a.sh = new Float32Array(PX * PX).fill(1), h = a.h, step = a.size / 257; if (!h) return;
    for (let q = 1; q < PX - 1; q++) for (let p = 1; p < PX - 1; p++) {
      const gx = (h[q * PX + p + 1] - h[q * PX + p - 1]) / (2 * step), gz = (h[(q + 1) * PX + p] - h[(q - 1) * PX + p]) / (2 * step);
      sh[q * PX + p] = Math.max(0.35, Math.min(1.35, 1 + (-gx - gz) * 0.6 / Math.sqrt(1 + gx * gx + gz * gz)));
    }
  }
  // the most detailed area shown at a world spot
  function areaAt(x, z) {
    if (T.res > 257) { const a = T.l7.get(Math.floor((x - WMIN) / 125) * 4096 + Math.floor((z - WMIN) / 125)); if (a) return a; }
    return T.l6.get(Math.floor((x - WMIN) / CELL) * 4096 + Math.floor((z - WMIN) / CELL));
  }
  const texel = (a, k, out, wgt) => { const v = a.img[k], A = v & 255, B = (v >>> 8) & 255, t = ((v >>> 16) & 255) / 255, ca = pal[A], cb = pal[B], s = (P.shade ? a.sh[k] : 1) * wgt;
    out[0] += (ca[0] + (cb[0] - ca[0]) * t) * s; out[1] += (ca[1] + (cb[1] - ca[1]) * t) * s; out[2] += (ca[2] + (cb[2] - ca[2]) * t) * s; };
  // redraw the picture over a world box (colours blended smoothly between the ground's pixels)
  function renderRect(wx0, wz0, wx1, wz1) {
    const [X0, Z0] = T.box, r = T.res / CELL, W = T.id.width, H = T.id.height, d = T.id.data, c = [0, 0, 0];
    const u0 = Math.max(0, Math.floor((wx0 - X0) * r)), u1 = Math.min(W - 1, Math.ceil((wx1 - X0) * r)), v0 = Math.max(0, Math.floor((wz0 - Z0) * r)), v1 = Math.min(H - 1, Math.ceil((wz1 - Z0) * r));
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
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(T.img, ax, az, bx - ax, bz - az);
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
    const a = areaAt(x, z);
    let s = `x ${Math.round(x)}, z ${Math.round(z)}`;
    if (a) { const p = Math.round(1.5 + (x - a.x) / a.size * 257), q = Math.round(1.5 + (z - a.z) / a.size * 257), v = a.img[q * PX + p], A = v & 255, B = (v >>> 8) & 255, t = (v >>> 16) & 255;
      s += t === 0 || A === B ? ` · ${A} ${matName(A)}` : ` · ${A} ${matName(A)} / ${B} ${matName(B)} (${Math.round(t / 2.55)}% of the second)`;
      if (a.h) s += ` · height ${Math.round(a.h[q * PX + p])} m`; }
    $('#tp_read').textContent = s;
    return a;
  }

  // ------------------------------------------------------------ painting
  function dab(x, z) {
    const st = T.stroke, r = P.size, soft = P.soft;
    const [bx0, bz0, bx1, bz1] = T.box; let hit = false;
    for (const a of T.areas) {
      const ps = a.size / 257, pad = r + ps;
      if (x + pad < a.x - 2 * ps || x - pad > a.x + a.size + 2 * ps || z + pad < a.z - 2 * ps || z - pad > a.z + a.size + 2 * ps) continue;
      const pc = 1.5 + (x - a.x) / ps, qc = 1.5 + (z - a.z) / ps, rr = r / ps;
      const p0 = Math.max(0, Math.floor(pc - rr)), p1 = Math.min(PX - 1, Math.ceil(pc + rr)), q0 = Math.max(0, Math.floor(qc - rr)), q1 = Math.min(PX - 1, Math.ceil(qc + rr));
      if (p0 > p1 || q0 > q1) continue;
      let rec = st.areas.get(a);
      for (let q = q0; q <= q1; q++) for (let p = p0; p <= p1; p++) {
        const d = Math.hypot(p - pc, q - qc) / Math.max(rr, 1e-6); if (d > 1) continue;
        const wx = a.x + (p - 1.5) * ps, wz = a.z + (q - 1.5) * ps; if (wx < bx0 || wx > bx1 || wz < bz0 || wz > bz1) continue;   // only inside the area
        const inner = 1 - soft, f = d <= inner ? 1 : soft > 0 ? (1 - (d - inner) / soft) : 0, w = P.tool === 'restore' ? f : Math.min(1, P.strength * f * f * (3 - 2 * f));
        if (w <= 0.004) continue;
        if (!rec) { rec = { before: a.img.slice(), w: new Float32Array(PX * PX) }; st.areas.set(a, rec); }
        const k = q * PX + p; if (w <= rec.w[k]) continue; rec.w[k] = w;
        const base = rec.before[k];
        a.img[k] = P.tool === 'restore' ? (w >= 0.5 ? a.orig[k] : base) : paintPixel(base, P.mat, w);
        a.dirty = true;
      }
      if (rec) hit = true;
    }
    if (hit) renderRect(x - r - 1, z - r - 1, x + r + 1, z + r + 1);
  }
  function strokeTo(x, z) {
    const st = T.stroke, last = st.last, step = Math.max(0.25, P.size * 0.25);
    if (!last) dab(x, z);
    else { const d = Math.hypot(x - last[0], z - last[1]), n = Math.ceil(d / step); for (let i = 1; i <= n; i++) dab(last[0] + (x - last[0]) * i / n, last[1] + (z - last[1]) * i / n); }
    st.last = [x, z];
  }
  function endStroke() {
    const st = T.stroke; T.stroke = null; if (!st || !st.areas.size) return;
    T.undo.push([...st.areas].map(([a, r]) => ({ a, before: r.before, after: a.img.slice() }))); if (T.undo.length > 40) T.undo.shift(); T.redo = [];
    countMats(); fillPalette(); syncUI();
  }
  function applyHist(from, to, key) {
    const h = from.pop(); if (!h) return;
    for (const e of h) { e.a.img.set(e[key]); e.a.dirty = true; }
    to.push(h); renderAll(); countMats(); fillPalette(); syncUI(); draw();
  }
  function pick(x, z) {
    const a = readout(x, z); if (!a) return;
    const p = Math.round(1.5 + (x - a.x) / a.size * 257), q = Math.round(1.5 + (z - a.z) / a.size * 257);
    P.mat = dominant(a.img[q * PX + p]); P.tool = 'paint'; savePrefs(); syncUI(); fillPalette();
    $('#tp_pal .tprow.on')?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ saving
  async function buildFiles(existing) {
    const files = new Map(), dirty = T.areas.filter(a => a.dirty);
    for (const a of dirty) files.set(matePath(a.name), writeMate(a.file, a.m, a.img));
    let tblPath = null;
    const sysRes = await S.romfs.getDirectoryHandle('System').then(d => d.getDirectoryHandle('Resource')).catch(() => null);
    if (sysRes) for await (const [n] of sysRes.entries()) if (/^ResourceSizeTable\.Product\.\d+\..*rsizetable\.zs$/.test(n)) tblPath = 'System/Resource/' + n;
    if (tblPath) {
      const base = (existing && await existing(tblPath)) || await readAt(S.romfs, tblPath);
      const tbl = parseRstb(zsDecompress(base)); let changed = false;
      for (const [p, b] of files) { const need = Math.ceil((b.length + 512) / 32) * 32; if (need > (rstbGet(tbl, p) || 0)) { rstbSet(tbl, p, need); changed = true; } }
      if (changed) files.set(tblPath, zsStore(writeRstb(tbl)));
    }
    return { files, tblPath, n: dirty.length };
  }
  async function save(zip) {
    if (!T.areas.some(a => a.dirty)) return toast('Nothing has been painted yet.');
    P.mod = ($('#tp_mod').value || '').trim().replace(/[^A-Za-z0-9_-]+/g, '') || 'TerrainPaint'; savePrefs(); syncUI();
    if (zip || !window.showDirectoryPicker) {
      busy('Building mod zip…');
      try {
        const { files, tblPath, n } = await buildFiles(), manifest = await manifestFor(files, tblPath);
        const z = [...files].map(([p, b]) => [`${P.mod}/romfs/${p}`, b]);
        z.push([`${P.mod}/romfs/manifest.tsv`, new TextEncoder().encode(manifest)], [`${P.mod}/mod.json`, new TextEncoder().encode(modMeta(P.mod, files.size))]);
        busy(); const saved = await saveFile(makeZip(z), P.mod + '.zip', 'modzip'); if (!saved) return toast('Not saved.');
        toast(`Saved ${saved} (${n} terrain files). Extract it into mkw-recomp\\mods and turn it on in the recomp's Mods page.`, 'ok');
      } catch (e) { console.error(e); toast('Saving failed: ' + e.message, 'err'); }
      busy(); return;
    }
    let mods = S.modsDir;
    if (!mods || !await permit(mods, 'readwrite')) {
      toast('Pick the recomp\'s "mods" folder (inside mkw-recomp).');
      try { mods = await showDirectoryPicker({ id: 'mods', mode: 'readwrite' }); } catch { return; }
      if (!await permit(mods, 'readwrite')) return;
      try { mods = await mods.getDirectoryHandle('mods'); } catch {}
      S.modsDir = mods; idb.set('mods', mods);
    }
    busy('Writing mod…');
    try {
      const mod = await mods.getDirectoryHandle(P.mod, { create: true }), romfs = await mod.getDirectoryHandle('romfs', { create: true });
      const { files, tblPath, n } = await buildFiles(p => readAt(romfs, p));
      for (const [p, b] of files) await writeAt(romfs, p, b);
      const all = new Map();
      for (const [p, h] of await walk(romfs)) if (p !== 'manifest.tsv') all.set(p, new Uint8Array(await (await h.getFile()).arrayBuffer()));
      await writeAt(romfs, 'manifest.tsv', new TextEncoder().encode(await manifestFor(all, tblPath)));
      await writeAt(mod, 'mod.json', new TextEncoder().encode(modMeta(P.mod, all.size)));
      toast(`Saved mod "${P.mod}" (${n} terrain files). Turn it on in the recomp's Mods page.`, 'ok');
    } catch (e) { console.error(e); toast('Saving failed: ' + e.message, 'err'); }
    busy();
  }

  // ------------------------------------------------------------ events
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); const [x, z] = toWorld(e);
    if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey && !T.picking)) { T.drag = { pan: true, x: e.clientX, y: e.clientY, cx: T.view.cx, cz: T.view.cz }; return; }
    if (T.picking) { const t = [Math.floor((x - WMIN) / CELL), Math.floor((z - WMIN) / CELL)]; T.drag = { t }; T.sel = [t[0], t[1], t[0], t[1]]; draw(); return; }
    if (e.altKey || P.tool === 'pick') { pick(x, z); return; }
    T.stroke = { areas: new Map(), last: null }; T.drag = { paint: true }; strokeTo(x, z); draw();
  });
  cv.addEventListener('pointermove', e => {
    const [x, z] = toWorld(e); T.hover = [x, z]; if (!T.picking) readout(x, z);
    if (T.drag?.pan) { const r = cv.getBoundingClientRect(), k = T.view.k * r.width / cv.width; T.view.cx = T.drag.cx - (e.clientX - T.drag.x) / k; T.view.cz = T.drag.cz - (e.clientY - T.drag.y) / k; }
    else if (T.drag?.t) { const s = T.drag.t, ti = Math.floor((x - WMIN) / CELL), tj = Math.floor((z - WMIN) / CELL);
      const a = [Math.min(s[0], ti), Math.min(s[1], tj), Math.max(s[0], ti), Math.max(s[1], tj)];
      if (a[2] - a[0] >= MAXC()) { if (ti > s[0]) a[2] = a[0] + MAXC() - 1; else a[0] = a[2] - MAXC + 1; }
      if (a[3] - a[1] >= MAXC()) { if (tj > s[1]) a[3] = a[1] + MAXC() - 1; else a[1] = a[3] - MAXC + 1; }
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
  document.querySelectorAll('#tpdlg [data-tptool]').forEach(b => b.onclick = () => { P.tool = b.dataset.tptool; savePrefs(); syncUI(); });
  $('#tp_size').oninput = () => { P.size = +$('#tp_size').value; savePrefs(); syncUI(); };
  $('#tp_str').oninput = () => { P.strength = $('#tp_str').value / 100; savePrefs(); syncUI(); };
  $('#tp_soft').oninput = () => { P.soft = $('#tp_soft').value / 100; savePrefs(); syncUI(); };
  $('#tp_shade').onchange = () => { P.shade = $('#tp_shade').checked; savePrefs(); if (T.img) renderAll(); draw(); };
  $('#tp_detail').onchange = () => { P.detail = +$('#tp_detail').value; savePrefs(); syncUI(); if (T.region && !T.picking && confirm('Load the area again at this detail?')) { if (T.region[2] - T.region[0] >= MAXC() || T.region[3] - T.region[1] >= MAXC()) { T.picking = true; syncUI(); draw(); return toast(`That area is too big for High detail: choose a part of it (up to ${MAXC() * 0.25} km across).`); } load(); } };
  $('#tp_zoom').onclick = () => { if (!T.region || T.picking) return toast('Load an area first, then zoom into a part of it.'); P.detail = 1; savePrefs(); T.picking = true; T.zoomPick = true; syncUI(); draw(); toast('Drag a box round the part to work on (up to 1 × 1 km). It loads at high detail, and only that part gets painted.'); };
  $('#tp_grid').onchange = () => { P.grid = $('#tp_grid').checked; savePrefs(); draw(); };
  $('#tp_used').onchange = fillPalette;
  $('#tp_undo').onclick = () => applyHist(T.undo, T.redo, 'before');
  $('#tp_redo').onclick = () => applyHist(T.redo, T.undo, 'after');
  $('#tp_area').onclick = () => { T.picking = true; T.zoomPick = false; fit(); T.view.k = Math.max(T.view.k / 8, cv.width / 6000); syncUI(); draw(); };
  $('#tp_load').onclick = load;
  $('#tp_save').onclick = () => save(false);
  $('#tp_zip').onclick = () => save(true);
  $('#tp_close').onclick = () => { if (T.areas.some(a => a.dirty) && !confirm('Close the terrain editor? Unsaved painting stays here until you load another area or close the editor program.')) return; dlg.close(); };
  window.addEventListener('resize', () => dlg.open && draw());

  if (window.__mkwe) window.__mkwe.TP = { T, P, load, strokeTo, endStroke, buildFiles, draw };
  return async function open() {
    dlg.showModal(); syncUI(); fillPalette();
    if (T.picking && !T.region) { T.view.cx = -4500; T.view.cz = 1500; fit(); T.view.k = cv.width / 6000; }
    draw(); if (await frLoadMap()) draw();
    cv.focus();
  };
}
