# MK World Course Editor

A course editor and track creator for **Mario Kart World** (1.8.0, and 1.0.0), made for the mkw-recomp PC port's mods folder. By Potato44.

It runs as one Windows exe that opens the editor in its own window. You point it at the romfs from your own game dump; it never ships any game files.

## What it does

- **Edit any course**: objects, lap paths, CPU/item routes, item boxes, start grids, glide paths, grind rails. Save the edits as a mod.
- **Make your own track** in its own new slot (Rainbow Road style), with the tabs:
  - **Track**: name in game, cup, laps, music, time of day, menu pictures, Free Roam placement, Build.
  - **Model**: import your own model (OBJ, FBX, DAE…) or build a road from a centre line (walls, rails, sand beach, ground). Materials and textures, the game's preset models, boost panels, glide panels and glider ramps, the open world's terrain for reference.
  - **Collision**: what each surface is made of in game, shown coloured by type.
  - **Paths**: Quick Create (lap path, CPU routes, item boxes, start grid, fences, glides and arrow signs from one guide line), widths, alternate routes, grind rails.
  - **Map**: the track opened like any course, to place objects and edit every path.
- **Free Roam**: put your track in the open world. It clears the world's creatures and props from the track's area, and moves the world's edge back if the track is near it.
- **Terrain editor** (Terrain button): a top-down map of a piece of the open world (up to 1.5 × 1.5 km). Paint its ground materials with a brush (size, strength, soft edge), put the game's own ground back, pick materials from the map, undo/redo, and save the changed terrain files as a mod. Every level of detail under the brush is painted. Four detail levels (about 4 m, 2 m, 1 m and 0.5 m; less detail lets you load bigger areas, up to 6 km), a progress bar, and Zoom in on a part, which works on just that part. Only the detail you view is read when loading; the other levels under your painting are read and painted when you save. The map shows the ground in its game colours (each area's colour map times the materials' textures), and each material shows its texture. Painting can paint the colour map too, so painted ground keeps the colour of where you picked it. A Collision layer paints what the ground is in game (road, offroad, sand, snow, ice, boost…), splitting the ground's collision triangles so edges follow the brush. Both paints the look and the collision together, each material bringing the collision it usually has in the loaded area. Height editing comes next.
- **Mario Kart 8 Deluxe courses** (Track Creator → Model → MK8 Deluxe course…): pick `course_model.szs`, `course_kcl.szs` and `course_muunt.byaml` from a course folder of your own MK8 Deluxe dump. The model (with its textures), collision (KCL surfaces matched to MKW ones), lap path, CPU route, item boxes, coins, glide path and anti-gravity paths (MKW's GravityPath / GravityCameraPath, as on Rainbow Road) come across; build it like any imported track. Other objects aren't converted.
- **Track pack creator** (File → Track pack…): pick several track projects (.mkwtrack.zip) and build them into one mod that adds them all to the TrackList menu (the list that opens instead of the VS / Time Trials map) as new courses instead of replacing slots. Each track gets its own slot (Pack001, Pack002…), name, picture and list entry; the pack copies the TrackList menu's files from your mods folder and includes the custom-courses plugin with raised limits (up to 512 courses in 128 folders). Turn off TrackList and the tracks' own mods when the pack is on.
- Builds the whole mod: model, collision, paths, minimap, course pictures, names and the game's tables.

## Using it

1. Download the zip from [Releases](../../releases) (or the latest build's Artifacts under [Actions](../../actions)) and unzip it.
2. Run `MKWorldCourseEditor vNN.exe`.
3. **File → Open RomFS…** and pick your dump's romfs folder (for 1.8.0, the update's romfs; **Base game…** adds the 1.0 romfs for models that never changed).
4. Pick a course to edit, or **My track** to make your own.

`start_grid.obj` is a reference for modelling: line your road up with it, then import with scale 1.

## Building

Needs [Node.js](https://nodejs.org) 18+ and [Go](https://go.dev) 1.24+.

```
npm ci
npm run build          # the editor page: dist/MKWorld-Course-Editor.html
./build-exe.sh         # the Windows exe (the page wrapped in the launcher)
```

Pushing to `main` builds the exe on GitHub Actions. Publishing a Release (tag `v1.1` and so on) builds it and attaches the zip to the Release.

## Layout

| Path | What |
| --- | --- |
| `src/main.js` | The editor: UI, views, the Track Creator, Quick Create |
| `src/index.html` | The page and its styles |
| `src/newslot.js` | Building a mod: the new course slot, Free Roam, the game's tables |
| `src/trackgen.js` | The centre-line road generator |
| `src/bfres.js`, `bfmodel.js` | Reading and writing the game's models |
| `src/hk.js`, `phive.js`, `bphsc.js` | Collision (Havok / Phive) |
| `src/byml.js`, `sarc.js`, `formats.js` | The game's file formats (BYML, SARC, zstd) |
| `src/astc.js` | Texture decoding |
| `src/mk8import.js` | Mario Kart 8 Deluxe course reader (Yaz0, BYML v1, KCL v2, BFRES 0.5 + BNTX BC1–BC5) and converter |
| `src/trackpack.js`, `trackpack_plugin.js` | Track pack creator and its embedded custom-courses plugin (`tools/custom_courses.c`) |
| `src/presets.js`, `boost.js`, `roadtex.js`, `surfaces.js`, `terrain.js`, `objinfo.js`, `modelimport.js` | Preset models, boost/glide pieces, road textures, collision types, world terrain, object info, model import |
| `launcher/` | The Go launcher that serves the page on this PC and opens its window |
| `extras/` | The start grid reference model |

Mario Kart World is © Nintendo. This project contains no game files; it reads them from your own dump.
