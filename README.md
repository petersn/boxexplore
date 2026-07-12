# boxexplore

A browser-based 3D metroidvania-in-progress with an integrated volume editor.
Draw a tileset in Aseprite, sculpt watertight voxel worlds, and (soon) paint the
surfaces with tiles.

## Running

Requires Node 18+ (Vite 6).

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
```

## The editor

The world is a **volume**: a sparse set of solid unit cells whose boundary surface
is derived automatically (a face wherever solid meets empty), so rooms and terrain
stay enclosed and watertight no matter how you extrude or carve — Sauerbraten-style.
Every lattice corner of that surface can be displaced — hard-clamped to **±½ cell
per axis** so geometry always stays legible against its voxel — to make slopes and
organic terrain without breaking the seal.

- **Build mode (1)** — the core flow: **click a face** (a 1×1 selection) or **drag
  a rectangle** across its plane — the rect is axis-aligned automatically and may
  overhang into the air or across other geometry. Then press **`=`** to extrude
  the faces present in the rect one layer outward (the rect's air stays air) or
  **`−`** to carve one layer of the whole footprint inward (overhang and all;
  the carve plane keeps marching even through empty space, so you can shave a
  region flat or dig as deep as you like). The selection plane follows the
  surface, so repeated presses keep going. Extrusion *carries corner offsets
  with it*: extruding the side of a ramp yields more ramp, and offsets stranded
  off the surface are cleaned up so nothing invisible ever wiggles new geometry.
  `Esc` clears; `Tab` hands the rect's corners to vertex mode; the **+ Voxel**
  toolbar button seeds a cell when the scene is empty.
- **Vertex mode (2)** — sculpting (snap defaults to ½ steps). **Click** selects a
  corner; **click a selected corner again** to drag it; dragging from anywhere
  else box-selects (`Shift` adds); `Ctrl/Cmd+click` selects the shortest edge
  path from the last-picked corner (great for following edges). **X/Y/Z**
  constrain movement to a world axis, `Shift+X/Y/Z` to the plane normal to it
  (an axis widget shows the constraint; the same key clears it) — and with an
  axis set, **`=`/`−`** nudge the whole selection along it toward/away from the
  camera. Only corners the camera can actually see are shown and pickable.
  Brushes act on the selection: `H` smooths (breaks edges into natural slopes),
  `U`/`J` inflate/deflate along the surface normal, `N` adds organic noise, `O`
  resets.

The camera has two modes (`P` toggles): **orbit** (CAD-style pivot) and **fly**
(Minecraft-creative-style — WASD + mouselook, no pivot). `V` toggles between the
**Sculpted** view and a **Voxels** debug view that ignores displacements and
highlights displaced corners in orange, so you can always see the underlying
voxels; previews and overlays follow the active view.

Painting the volume surface with tiles is the next milestone (per-face tile
assignment applied to the derived geometry); for now it renders flat-shaded with
per-corner ambient occlusion and cell outlines.

Scenes autosave to localStorage and can be saved/loaded as JSON (`Ctrl+S` / `Ctrl+O`);
the tileset image is embedded in the file. Press `?` in the app for the full
shortcut list.

## Architecture

| file | role |
| --- | --- |
| `src/model.ts` | document: volume cells + clamped lattice shifts, reversible edit ops, undo |
| `src/volume.ts` | surface derivation, AO, offset hygiene/extrapolation, visibility DDA |
| `src/meshbuilder.ts` | doc → BufferGeometry (shaded volume, overlay quads), picking map |
| `src/viewport.ts` | renderer, orbit/fly camera, ray picking, grid visuals |
| `src/build.ts` / `src/vertex.ts` | the two editor modes |
| `src/tileset.ts` / `src/palette.ts` | tileset canvas + picker (texturing comes later) |
| `src/frame.ts` | small plane-frame math helpers (grid, ray picking) |
| `src/editor.ts` | glue: input routing, overlays, toolbar, persistence |

The scene format is plain JSON
(`{ tileSize, tileset: dataURL, doc: { cells, shifts } }`) — the future game
runtime will consume it directly.

## Roadmap

- Scroll-wheel extrude on the active rect selection
- Paint the volume surface with tileset tiles (per-cell-face tile assignment),
  with sensible defaults when geometry changes under painted faces
- Select/move/copy volume regions; sub-unit cells for fine geometry
- Prefab objects with live-updating instances
- Vertex colors / baked lighting
- Game runtime: player controller, collision from the derived surface, room/chunk streaming
