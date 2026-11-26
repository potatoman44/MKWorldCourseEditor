// Track pack creator: several of your tracks (Track Creator projects), each built into its own new slot, plus the Track list
// menu (the TrackList mod: the + list in VS / Time Trials) with a folder per track, in one mod. The menu's files (its AI
// changes, pictures, course list) come from your installed TrackList mod; its plugin comes with the editor (a newer build
// with room for 128 folders, 64 courses each, 512 in all).
import { PLUGIN_DLL_B64 } from './trackpack_plugin.js';

const UI_RULES = ['Balloon', 'Coin', 'Bomb'];
const utf16z = s => { const a = new Uint8Array(2 * (s.length + 1)); for (let i = 0; i < s.length; i++) { a[2 * i] = s.charCodeAt(i) & 255; a[2 * i + 1] = s.charCodeAt(i) >> 8; } return a; };
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const typed = (src, v) => (src && typeof src === 'object') ? Object.assign(Object.create(Object.getPrototypeOf(src)), src, { v }) : v;

export function setupTrackPack(D) {
  const { $, el, toast, busy, S, writeAt, walk, permit, zsDecompress, zsStore, parseRstb, rstbGet, rstbSet, writeRstb, manifestFor, idb,
    romReader, gameVersion, parseByml, writeByml, parseSarc, sarcAdd, mmh3, msbtAppend, parseMsbt, renameBntx, buildNewSlot, TCAPI } = D;
  const PK = { tracks: [], oneFolder: false };
  const dlg = $('#pkdlg');

  function fill() {
    const box = $('#pk_list'); box.innerHTML = '';
    PK.tracks.forEach((t, i) => box.append(el('div', { class: 'pkrow' },
      el('span', { class: 'pknum' }, String(i + 1)),
      el('input', { type: 'text', value: t.name, title: 'The name in the menu', oninput: e => { t.name = e.target.value; } }),
      el('span', { class: 'hint', title: t.file }, t.file),
      el('button', { title: 'Move up', onclick: () => { if (i) { PK.tracks.splice(i - 1, 0, PK.tracks.splice(i, 1)[0]); fill(); } } }, '↑'),
      el('button', { title: 'Remove', onclick: () => { PK.tracks.splice(i, 1); fill(); } }, '✕'))));
    $('#pk_count').textContent = PK.tracks.length ? `${PK.tracks.length} track${PK.tracks.length > 1 ? 's' : ''}` : 'No tracks yet: add your track projects (.mkwtrack.zip, or the .zip of a mod built with the Track Creator).';
  }

  async function addFiles(list) {
    for (const f of list) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let name = f.name.replace(/\.mkwtrack\.zip$|\.zip$/i, '');
      try { const z = await TCAPI.unzip(bytes); let pj = z.get('project.json');
        if (!pj) { const inner = [...z.keys()].find(k => /trackcreator-project\.zip$/i.test(k)); if (inner) pj = (await TCAPI.unzip(z.get(inner))).get('project.json'); }
        if (!pj) { toast(`${f.name} has no Track Creator project in it.`, 'err'); continue; }
        const d = JSON.parse(new TextDecoder().decode(pj)); name = d.display || d.name || name;
      } catch (e) { toast(`Couldn't read ${f.name}: ${e.message}`, 'err'); continue; }
      PK.tracks.push({ file: f.name, bytes, name });
    }
    fill();
  }

  // every file of a folder, by its path inside it
  async function readFolder(dir) { const m = new Map(); for (const [p, h] of await walk(dir)) m.set(p, new Uint8Array(await (await h.getFile()).arrayBuffer())); return m; }

  async function build() {
    if (!S.romfs || S.romfs.fake) return toast('Open your RomFS first (File ▸ Open RomFS…).', 'err');
    if (!PK.tracks.length) return toast('Add some track projects first.', 'err');
    if (PK.tracks.length > 99) return toast('Up to 99 tracks in one pack.', 'err');
    const packName = ($('#pk_name').value || '').trim().replace(/[^A-Za-z0-9_-]+/g, '') || 'TrackPack'; $('#pk_name').value = packName;
    const menuName = ($('#pk_menu').value || '').trim() || 'TrackList';
    let mods = S.modsDir;
    if (!mods || !await permit(mods, 'readwrite')) {
      toast('Pick the recomp\'s "mods" folder (inside mkw-recomp).');
      try { mods = await showDirectoryPicker({ id: 'mods', mode: 'readwrite' }); } catch { return; }
      if (!await permit(mods, 'readwrite')) return;
      try { mods = await mods.getDirectoryHandle('mods'); } catch {}
      S.modsDir = mods; idb.set('mods', mods);
    }
    let menuDir; try { menuDir = await mods.getDirectoryHandle(menuName); } catch { return toast(`There's no "${menuName}" mod in your mods folder: the pack takes the menu's files from the Track list mod (TrackList). Put it in mods, or type its folder's name.`, 'err'); }
    const keep = await TCAPI.projectZip().catch(() => null), wasActive = TCAPI.active();
    const log = [];
    try {
      busy('Reading the Track list mod…');
      let menuRomfs; try { menuRomfs = await menuDir.getDirectoryHandle('romfs'); } catch { throw new Error(`the "${menuName}" mod has no romfs folder`); }
      const TL = await readFolder(menuRomfs); TL.delete('manifest.tsv');
      let coursesTxt = ''; try { coursesTxt = new TextDecoder().decode(new Uint8Array(await (await (await menuDir.getFileHandle('courses.txt')).getFile()).arrayBuffer())); } catch { throw new Error(`the "${menuName}" mod has no courses.txt`); }
      const built = new Map(), base = romReader();
      const rd = async p => built.has(p) ? built.get(p) : TL.has(p) ? TL.get(p) : base(p);
      const V = await gameVersion(rd);
      if (!wasActive) TCAPI.open();
      const added = [];   // [{ name, courses: [[shown name, course]] }]
      for (let i = 0; i < PK.tracks.length; i++) {
        const t = PK.tracks[i], n3 = String(i + 1).padStart(3, '0');
        const slot = { SZ: `Pack${n3}_00`, CZ: `Race_Pack${n3}_A_00`, tag: `P${n3}` };
        busy(`Track ${i + 1} of ${PK.tracks.length}: opening ${t.name}…`);
        await TCAPI.openProject(t.file, t.bytes);
        const { spec } = await TCAPI.buildSpec();
        const full = { ...spec, display: t.name || spec.display, slot, cup: null, vsStage: null, vsExtra: false, picturesStandIn: false, freeRoam: null, island: false };
        const { files, warnings } = await buildNewSlot(rd, full, m => busy(`Track ${i + 1} of ${PK.tracks.length} (${t.name}): ${m}`));
        for (const [p, b] of files) built.set(p, b);
        if (warnings?.length) log.push(`${t.name}: ${warnings.join('; ')}`);
        added.push({ name: t.name, slot, courses: [['Normal', slot.CZ], ...(spec.variants || []).map(v => [v.name || `Route ${v.letter}`, `Race_Pack${n3}_${v.letter}_00`])] });
      }
      // ---- the menu: each course as an entry of the list (the battle course lists the menu is made from), its name and picture
      busy('Adding the tracks to the menu…');
      const gp = `System/GymlArchive/general_format.Product_${V}.sarc.zs`, G = zsDecompress(await rd(gp)), GS = parseSarc(G), rep = new Map();
      let firstLabel = null;
      const entries = added.flatMap(tr => tr.courses.map(([shown, course], k) => ({ tr, shown, course, k })));
      for (const rule of UI_RULES) {
        const key = `Gyml/BattleCourseSelectUIInfo/${rule}.game__BattleCourseSelectUIInfo.bgyml`, doc = parseByml(GS.get(key)), ci = doc.root.CourseInfo;
        if (!ci?.length) throw new Error('the battle course list ' + rule + ' is empty');
        const proto = ci[ci.length - 1], start = 1801 + ci.length; if (firstLabel === null) firstLabel = start;
        if (firstLabel + entries.length > 1801 + 511) throw new Error('too many courses for the list (512 at most)');
        entries.forEach((e, j) => {
          const x = { ...proto }, base = e.tr.slot.SZ.slice(1);   // C_StageS_Pack001_00 -> C_BattleS_ack001_00 (same length)
          x.CourseId = typed(proto.CourseId, mmh3(e.course));
          x.CourseMessageLabel = typed(proto.CourseMessageLabel, String(firstLabel + j));
          x.UITextureName = typed(proto.UITextureName, 'C_BattleS_' + base);
          x.UITextureBaseName = typed(proto.UITextureBaseName, base);
          ci.push(x);
        });
        rep.set(key, writeByml(doc.root, doc.version ?? 7));
      }
      const NG = sarcAdd(G, new Map(), rep); built.set(gp, zsStore(NG));
      const sizes = new Map([[gp.replace(/\.zs$/, ''), NG.length]]);
      for (const reg of ['EUen', 'USen']) {
        const mp = `Mals/${reg}/MsgMain.msarc`, raw = await rd(mp); if (!raw) continue;
        const M = parseSarc(raw), file = [...M.keys()].find(k => k.endsWith('BattleCourse.msbt')); if (!file) continue;
        const labs = Object.values(parseMsbt(M.get(file)).labels), like = labs.includes('1801') ? '1801' : labs[0];
        const items = entries.map((e, j) => [String(firstLabel + j), utf16z(e.k === 0 ? e.tr.name : e.shown)]);
        const nb = msbtAppend(M.get(file), items, like); if (!nb) throw new Error('couldn\'t add the names to ' + mp);
        const out = sarcAdd(raw, new Map(), new Map([[file, nb]])); built.set(mp, out); sizes.set(mp, out.length);
      }
      const pics = [];
      for (const tr of added) {
        const src = `C_StageS_${tr.slot.SZ}`, dst = 'C_BattleS_' + tr.slot.SZ.slice(1), sp = `Layout/${src}.Nin_Ounce_NVN2.bntx.zs`;
        const b = await rd(sp); if (!b) { log.push(`${tr.name}: no picture`); continue; }
        const out = renameBntx(zsDecompress(b), src, dst); built.set(`Layout/${dst}.Nin_Ounce_NVN2.bntx.zs`, zsStore(out)); pics.push([`Layout/${dst}.Nin_Ounce_NVN2.bntx`, sp.replace(/\.zs$/, ''), out.length]);
      }
      // size table: the menu's bigger files and the pictures
      const rp = `System/Resource/ResourceSizeTable.Product.${V}.Nin_Ounce_NVN2.rsizetable.zs`, tbl = parseRstb(zsDecompress(await rd(rp)));
      for (const [k, n] of sizes) { const need = Math.ceil(n * 1.25 / 32) * 32 + 16384; if (need > (rstbGet(tbl, k) || 0)) rstbSet(tbl, k, need); }
      for (const [k, srcK, n] of pics) rstbSet(tbl, k, Math.max(rstbGet(tbl, srcK) || 0, Math.ceil((n + 1024) / 32) * 32));
      built.set(rp, zsStore(writeRstb(tbl)));
      // the course list: a folder per track (or one folder for them all)
      let txt = coursesTxt.replace(/\s*$/, '\n');
      if (PK.oneFolder) { txt += `\n[${($('#pk_folder').value || 'Custom tracks').trim()}]\n`; for (const tr of added) tr.courses.forEach(([shown, c], k) => { txt += `${k ? tr.name + ' – ' + shown : tr.name}\t${c}\n`; }); }
      else for (const tr of added) { txt += `\n[${tr.name}]\n`; for (const [shown, c] of tr.courses) txt += `${shown}\t${c}\n`; }
      // ---- write the mod
      busy('Writing the pack…');
      const mod = await mods.getDirectoryHandle(packName, { create: true }), romfs = await mod.getDirectoryHandle('romfs', { create: true });
      const all = new Map(TL); for (const [p, b] of built) all.set(p, b);
      let k = 0; for (const [p, b] of all) { await writeAt(romfs, p, b); if (++k % 20 === 0) busy(`Writing the pack… ${k} of ${all.size}`); }
      await writeAt(romfs, 'manifest.tsv', new TextEncoder().encode(await manifestFor(all, rp)));
      await writeAt(mod, 'plugin/custom_courses.dll', b64(PLUGIN_DLL_B64));
      await writeAt(mod, 'courses.txt', new TextEncoder().encode(txt));
      await writeAt(mod, 'mod.json', new TextEncoder().encode(JSON.stringify({ name: packName, title: `${packName} (track pack: ${added.length} track${added.length > 1 ? 's' : ''} + Track list)`, has_romfs: true, romfs_files: all.size, has_exefs: false, has_plugin: true, producer: 'MK World Course Editor' }, null, 2) + '\n'));
      toast(`Built "${packName}": ${added.length} track(s), ${entries.length} course(s) added to the Track list. Turn OFF ${menuName} and the tracks' own mods, turn ON ${packName}, then press + on the VS / Time Trials map.`, 'ok', 15000);
      if (log.length) setTimeout(() => toast('Notes: ' + log.join(' · '), 'err', 12000), 800);
    } catch (e) { console.error(e); toast('Building the pack failed: ' + e.message, 'err', 12000); }
    finally {
      busy('Putting your own track back…');
      try { if (keep) await TCAPI.openProject('your track.zip', keep); } catch (e) { console.error(e); }
      if (!wasActive) TCAPI.close();
      busy();
    }
  }

  $('#pk_add').onclick = () => $('#pk_file').click();
  $('#pk_file').onchange = async e => { await addFiles([...e.target.files]); e.target.value = ''; };
  $('#pk_one').onchange = () => { PK.oneFolder = $('#pk_one').checked; $('#pk_folderrow').style.display = PK.oneFolder ? '' : 'none'; };
  $('#pk_build').onclick = build;
  $('#pk_close').onclick = () => dlg.close();
  return () => { dlg.showModal(); fill(); };
}
