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
  into air); `=`/`-` fill or carve one layer via `BuildMode.extrudeStep`, and the
  selection plane follows. Vertex drags move in the camera-facing plane (Shift =
  along the corner's averaged surface normal), snapped per world axis.
- Cell ops must keep offset hygiene: route shift changes through
  `planShiftChanges` (volume.ts) — it clears offsets leaving the surface and
  copies offsets onto newly exposed corners from one layer back along the
  extrusion axis (so extruding a ramp yields more ramp, and stale invisible
  offsets never affect new geometry).
- The document model (`src/model.ts`) uses plain-object vectors (`src/vec.ts`), not
  THREE vectors — everything in the doc must stay JSON-serializable.
- All edits go through `EditOp` (`cellsAdded`/`cellsRemoved`/`shifts` + legacy face
  snapshots) so undo works; vertex drags use `doc.writeShiftsLive` then
  `editor.commitApplied` on release; build ops `commit` once per keypress.
- `doc.faces` (free textured quads) is a legacy layer: still rendered and
  serialized, no longer editable. Future texturing = per-cell-face tile
  assignment on the derived surface, not new quads. Face corners are ordered
  [bl, br, tr, tl]; `CORNERS` in volume.ts follows the same convention.
- Modes: 1 Build, 2 Vertex. Grid step is per-mode (`editor.gridStep` accessor;
  vertex defaults to 0.5) and only affects vertex snapping + the reference grid.
- Camera: `viewport.mode` is 'orbit' (target/dist pivot) or 'fly' (free position +
  mouselook), toggled with P. The y=0 reference grid centers on the view ray.
  View: V toggles `editor.viewMode` 'sculpted'/'voxels'; `editor.displaySurface`/
  `displayMap` hold what's on screen (raw voxels in voxel view, displaced corners
  tinted orange) and all previews/overlays must use them; face keys are stable
  across views so picking/tools work in both.
- Vertex handles are exactly visibility-filtered: front-facing adjacent face +
  voxel-DDA line of sight (`segmentBlocked`, stops just short of the endpoint).
  Sculpt brushes: H smooth, U/J inflate/deflate, Y noise, O reset.

## Verification

The end-to-end playwright suite is `scripts/verify.mjs` (seed/rect-extrude/carve/
overhang/offset extrapolation/clamp/visibility/brushes/views/cameras/undo/
save-load). Run it with the dev server up: `node scripts/verify.mjs` (from the
repo root so `playwright` resolves). It drives the real UI and asserts via
`window.editor`; screenshots land in `/tmp/boxexplore-shots`. Always verify
interactively, not just tsc.
