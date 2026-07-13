# boxexplore

A browser-based 3D metroidvania-in-progress with an integrated volume editor.
Draw a tileset in Aseprite, sculpt watertight voxel worlds, and (soon) paint the
surfaces with tiles.

## Running

Requires Node 18+ (Vite 6). The editor core is Rust compiled to WASM; a
prebuilt module is checked in under `src/wasm/`, so plain `npm run dev` works
without a Rust toolchain.

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm run wasm       # rebuild the Rust core (needs rustup + wasm-bindgen-cli)
```

Rust-side tests and benchmarks (from `rust/boxcore/`):

```sh
cargo test                        # parity-critical behavior tests
cargo run --release --bin bench   # representation benchmarks
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
  `Esc` clears; `Tab` hands the rect's corners to sculpt mode; the **+ Voxel**
  toolbar button seeds a cell when the scene is empty.
- **Sculpt mode (2)** — three tools, switched in the sidebar or with `M`/`B`/`F`
  (Draw is the default):
  - **Select** (`M`): **click** selects a corner; **click a selected corner
    again** to drag it; dragging from anywhere else box-selects (`Shift` adds);
    `Ctrl/Cmd+click` selects the shortest edge path from the last-picked corner.
    **X/Y/Z** constrain movement to a world axis, `Shift+X/Y/Z` to the plane
    normal to it (an axis widget shows the constraint; the same key clears it) —
    and with an axis set, **`=`/`−`** nudge the selection along it toward/away
    from the camera (the Draw brush also pushes along a locked axis instead
    of the surface normal — handy for raising terrain). Selection ops: `H` smooth, `U`/`J` inflate/deflate, `N`
    noise, `O` reset. Snap defaults to ½ steps.
  - **Smooth brush** (`B`): paint over a radius (sidebar sliders set radius and
    strength) to relax the *actual displaced surface* — hard voxel edges round
    over and crevices fill in even when every offset starts at zero.
  - **Draw brush** (`F`): pushes the surface out along its normal; `Alt` pulls
    it in. With **"brushes may add/remove voxels"** checked (the default),
    brushes reshape the volume itself: pushing a corner past the ±½ clamp flips the voxel and
    rebases the offset onto the new ring, so strokes grow (or dig away) real
    geometry while the surface stays continuous and watertight.

- **Paint mode (3)** — assign tileset tiles to faces, with a live textured
  preview of exactly what will land where. A single tile paints with a
  **radius** brush (sidebar slider); a multi-tile stamp places the whole
  block, grid-locked so neighboring placements tile seamlessly, with `R`
  rotation and `F` flip; the **random scatter** checkbox sprays random
  tiles from the selection with random orientations instead. Strokes fill the
  whole swept path (no gaps on fast drags), `Alt+click` eyedrops, `X+drag` or
  right-click erases (radius-aware). Paints render in the Textured view,
  shaded by the same AO/lambert, and **follow geometry edits**: extruding a
  painted wall yields more painted wall, carving into painted ground keeps
  the paint on the new floor, buried faces are cleaned up.

- **Play mode (`G`)** — run around your world in third person: a cylinder
  character with gravity, jumping (Space), wall sliding, half-cell auto-step,
  and slope climbing up to 50°. Physics runs in the Rust core: rapier3d BVH
  queries (rays, capsule sweeps, spherecasts) against per-chunk trimesh
  colliders built from the same displaced surface you see, driving a
  hand-rolled kinematic controller — sculpted ramps walk exactly as they
  look. Movement is fully swept (no tunneling through steep faces) with an
  iterative depenetration pass ejecting any residual overlap, so the
  character stays unstuck and above ground. Drag/wheel orbit the chase
  camera; its focus point is smoothed while swivel stays snappy, and a
  backward spherecast keeps it out of geometry. `G`/`Esc` returns to
  editing.

The camera has two modes (`P` toggles): **orbit** (CAD-style pivot) and **fly**
(Minecraft-creative-style — WASD + mouselook, no pivot). Two independent view
toggles: `V` switches geometry between **Sculpted** and raw **Voxels**, and `T`
switches **Textured** (painted tiles) / **Untextured** (displaced corners get
a direction-coded vertex color — each offset axis maps to a channel, so +x is
salmon, −x teal, +y green, −y purple, +z blue, −z olive; stronger push =
stronger color). Previews and overlays follow the active views.

Scenes autosave to localStorage and can be saved/loaded as JSON (`Ctrl+S` / `Ctrl+O`);
the tileset image is embedded in the file. Press `?` in the app for the full
shortcut list.

## Architecture

The document and all heavy lifting live in **Rust → WASM** (`rust/boxcore`):
a chunked voxel store (32³ chunks, Empty/Full/bitmap — a one-level VDB, so a
1000³ solid cube costs ~14 MiB instead of ~37 GiB), sparse clamped offsets,
every edit operation with offset hygiene, diff-based undo/redo, per-chunk
meshing with AO and LOD levels, visibility queries, and serialization.
TypeScript is the shell: input, camera, overlays, and three.js drawing the
buffers the core produces. See `docs/representation.md` for the design
discussion and benchmark numbers.

| file | role |
| --- | --- |
| `rust/boxcore/src/store.rs` | chunked volume + sparse clamped offsets |
| `rust/boxcore/src/mesh.rs` | per-chunk surface extraction, AO, LOD meshes |
| `rust/boxcore/src/ops.rs` | edit ops, hygiene, brushes, paths, visibility, undo |
| `rust/boxcore/src/physics.rs` | rapier3d query world + character controller |
| `rust/boxcore/src/wasm_api.rs` | the `World` facade the shell talks to |
| `src/world.ts` | typed wrapper + change notification |
| `src/render.ts` | per-chunk three.js meshes, dirty sync, distance LOD |
| `src/build.ts` / `src/sculpt.ts` / `src/paint.ts` | the three editor modes (input → core calls) |
| `src/play.ts` | play-mode shell: input, body mesh, chase camera |
| `src/viewport.ts` | renderer, orbit/fly camera, ray picking |
| `src/tileset.ts` / `src/palette.ts` | tileset canvas + stamp picker |
| `src/editor.ts` | glue: input routing, overlays, toolbar, persistence |

The scene format is plain JSON (v4:
`{ tileSize, tileset: dataURL, doc: { cells, shifts, paints } }`) — the future
game runtime will consume it directly.

## Roadmap

- Scroll-wheel extrude on the active rect selection
- Paint bucket fill; first-person camera option in play mode
- Select/move/copy volume regions; sub-unit cells for fine geometry
- Prefab objects with live-updating instances
- Game runtime: player controller, collision from the derived surface, room/chunk streaming
- wgpu renderer: persistent GPU buffers, depth-buffer-exact vertex
  visibility, bitwise meshing, greedy meshing for painted flats
