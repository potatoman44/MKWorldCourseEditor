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
| `src/presets.js`, `boost.js`, `roadtex.js`, `surfaces.js`, `terrain.js`, `objinfo.js`, `modelimport.js` | Preset models, boost/glide pieces, road textures, collision types, world terrain, object info, model import |
| `launcher/` | The Go launcher that serves the page on this PC and opens its window |
| `extras/` | The start grid reference model |

Mario Kart World is © Nintendo. This project contains no game files; it reads them from your own dump.
