# boxexplore

Browser 3D metroidvania + integrated Crocotile-3D-style tile editor. Vite + TypeScript +
Three.js, no UI framework. See README.md for controls and file roles.

## Environment

- Default `node` here is v18.8, so the project is pinned to **Vite 6** (the last major
  supporting Node 18). Don't bump to Vite 7/8 unless the default node becomes 20.19+
  (nvm has v20.19.6 installed if ever needed).
- `npm run dev` (port 5173), `npm run build` (tsc + vite), `npm run typecheck`.

## Conventions

- The geometry is a **volume**: `doc.cells` (sparse set of solid unit cells, keys
  `"x,y,z"`) plus `doc.shifts` (lattice-corner displacements, **hard-clamped to
  ±0.5 per axis** in `Doc.setShift` — every write path clamps). The boundary
  surface is *derived* in `src/volume.ts` (`buildSurface`) and cached on the editor
  (`editor.surface`/`surfaceMap`, invalidated via `doc.volVersion`) — never stored.
  It is watertight by construction; `editor.surfaceStats().oddEdges === 0` asserts it.
- There is **no working-plane concept**. Build mode is rect-select-then-extrude:
  click/drag on a face selects an axis-aligned rect (`editor.boxSel`, may overhang
  into air); `=` extrudes only faces actually present at the plane, `-` carves the
  whole footprint (and its plane keeps marching even through empty space), via
  `BuildMode.extrudeStep`. RMB is intentionally unbound (reserved). Tab from build
  to vertex hands the rect's corners over as the vertex selection.
- Sculpt mode has three tools (`SculptMode.tool`, keys M/B/F): Select behaves as
  before (click selects; second click on a selected corner drags; other drags
  box-select; Ctrl/Cmd+click = shortest-path select; X/Y/Z blender-style
  constraints, Shift = plane; `=`/`-` nudge along the axis). The Smooth and Draw
  brushes paint over `editor.brush.radius` with falloff: Smooth relaxes the
  displaced surface toward neighbor averages (rounds voxel edges even at zero
  offsets); Draw pushes along vertex normals (Alt inverts). With
  `editor.brush.topo`, a brush pushing past the ±½ clamp flips the voxel and
  REBASES the offset onto the new ring (want − dir), keeping the surface
  continuous so strokes converge instead of oscillating; strokes accumulate into
  ONE undo op (`writeCellsLive`/`writeShiftsLive` live, `commitApplied` at end,
  off-surface offsets cleaned at stroke end). Camera fly-down is Q (E/Space up)
  — Z is reserved for the axis constraint.
- Cell ops must keep offset hygiene: route shift changes through
  `planShiftChanges` (volume.ts) — it clears offsets leaving the surface and
  copies offsets onto newly exposed corners from one layer back along the
  extrusion axis (so extruding a ramp yields more ramp, and stale invisible
  offsets never affect new geometry).
- The document model (`src/model.ts`) uses plain-object vectors (`src/vec.ts`), not
  THREE vectors — everything in the doc must stay JSON-serializable.
- All edits go through `EditOp` (`cellsAdded`/`cellsRemoved`/`shifts`) so undo
  works; vertex drags use `doc.writeShiftsLive` then `editor.commitApplied` on
  release; build ops `commit` once per keypress.
- Peter has explicitly waived backwards compatibility until further notice — the
  free-quad layer is fully deleted (scene format v3 = `{cells, shifts}` only).
  Future texturing = per-cell-face tile assignment on the derived surface, not
  new quads. Quad corners are ordered [bl, br, tr, tl] (`CORNERS` in volume.ts).
- Modes: 1 Build, 2 Sculpt. Grid step is per-mode (`editor.gridStep` accessor;
  sculpt defaults to 0.5) and only affects sculpt snapping + the reference grid.
- Camera: `viewport.mode` is 'orbit' (target/dist pivot) or 'fly' (free position +
  mouselook), toggled with P. The y=0 reference grid centers on the view ray.
  Two independent view toggles: V = `editor.geomView` 'sculpted'/'voxels'
  (geometry), T = `editor.texView` 'textured'/'untextured' (untextured paints
  displacement magnitude into vertex colors; textured will show painted tiles
  once painting lands). `editor.displaySurface`/`displayMap` hold what's on
  screen and all previews/overlays must use them; face keys are stable across
  views so picking/tools work everywhere.
- Corner handles are visibility-filtered: front-facing adjacent face + voxel-DDA
  line of sight (`segmentBlocked`, two probe distances along the corner normal).
  KNOWN imperfect; per Peter, do NOT invest further here — exact depth-buffer
  visibility arrives with the planned Rust+WASM+wgpu performance rework.

## Verification

The end-to-end playwright suite is `scripts/verify.mjs` (seed/rect-extrude/carve/
overhang/offset extrapolation/clamp/visibility/click-select/constraints/path
select/handoff/spatial brushes incl. topology growth/views/cameras/undo/
save-load). Run it with the dev server up: `node scripts/verify.mjs` (from the
repo root so `playwright` resolves). It drives the real UI and asserts via
`window.editor`; screenshots land in `/tmp/boxexplore-shots`. Always verify
interactively, not just tsc.
