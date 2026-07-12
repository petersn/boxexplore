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
- **Sculpt mode (2)** — three tools, switched in the sidebar or with `M`/`B`/`F`:
  - **Select** (`M`): **click** selects a corner; **click a selected corner
    again** to drag it; dragging from anywhere else box-selects (`Shift` adds);
    `Ctrl/Cmd+click` selects the shortest edge path from the last-picked corner.
    **X/Y/Z** constrain movement to a world axis, `Shift+X/Y/Z` to the plane
    normal to it (an axis widget shows the constraint; the same key clears it) —
    and with an axis set, **`=`/`−`** nudge the selection along it toward/away
    from the camera. Selection ops: `H` smooth, `U`/`J` inflate/deflate, `N`
    noise, `O` reset. Snap defaults to ½ steps.
  - **Smooth brush** (`B`): paint over a radius (sidebar sliders set radius and
    strength) to relax the *actual displaced surface* — hard voxel edges round
    over and crevices fill in even when every offset starts at zero.
  - **Draw brush** (`F`): pushes the surface out along its normal; `Alt` pulls
    it in. With **"brushes may add/remove voxels"** checked, brushes reshape
    the volume itself: pushing a corner past the ±½ clamp flips the voxel and
    rebases the offset onto the new ring, so strokes grow (or dig away) real
    geometry while the surface stays continuous and watertight.

The camera has two modes (`P` toggles): **orbit** (CAD-style pivot) and **fly**
(Minecraft-creative-style — WASD + mouselook, no pivot). Two independent view
toggles: `V` switches geometry between **Sculpted** and raw **Voxels**, and `T`
switches **Textured**/**Untextured** — the untextured view paints displacement
magnitude into the vertex colors (orange = pushed far), and will show painted
tiles on the textured side once face painting lands. Previews and overlays
follow the active views.

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
| `src/build.ts` / `src/sculpt.ts` | the two editor modes |
| `src/tileset.ts` / `src/palette.ts` | tileset canvas + picker (texturing comes later) |
| `src/frame.ts` | small plane-frame math helpers (grid, ray picking) |
| `src/editor.ts` | glue: input routing, overlays, toolbar, persistence |

The scene format is plain JSON
(`{ tileSize, tileset: dataURL, doc: { cells, shifts } }`) — the future game
runtime will consume it directly.

## Roadmap

- Scroll-wheel extrude on the active rect selection
- Paint the volume surface with tileset tiles (per-cell-face tile assignment,
  shown by the "Textured" view), with sensible defaults when geometry changes
  under painted faces
- Select/move/copy volume regions; sub-unit cells for fine geometry
- Prefab objects with live-updating instances
- Game runtime: player controller, collision from the derived surface, room/chunk streaming
- A major performance rework: move surface derivation, visibility, and brush
  math to Rust + WASM + wgpu, with depth-buffer-exact vertex visibility
