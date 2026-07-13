# boxexplore

Browser 3D metroidvania + integrated volume editor. **Rust → WASM core**
(`rust/boxcore`) + TypeScript/three.js shell, no UI framework. See README.md
for controls/file roles and `docs/representation.md` for the storage design
and benchmark numbers.

## Environment

- Default `node` here is v18.8, so the project is pinned to **Vite 6** (the last major
  supporting Node 18). Don't bump to Vite 7/8 unless the default node becomes 20.19+
  (nvm has v20.19.6 installed if ever needed).
- `npm run dev` (port 5173), `npm run build` (tsc + vite), `npm run typecheck`.
- `npm run wasm` rebuilds the core (cargo + wasm-bindgen CLI, pinned `=0.2.120`
  to match the installed CLI) into `src/wasm/` (generated, but committed so the
  editor runs without a Rust toolchain). After ANY change under `rust/`, run
  `npm run wasm` or the browser keeps using the stale module.

## Architecture split (keep it this way)

- **Rust owns**: the document (chunked voxel store: 32³ chunks, Empty/Full
  tag or 4 KiB bitmap — a one-level VDB; sparse offsets hard-clamped ±0.5 in
  `Offsets::set`; per-face `Paints` keyed (cell, dir) with packed
  tile+orientation), all edit ops + offset AND paint hygiene, diff undo/redo,
  meshing (AO, sculpted/voxel geometry, untextured tint, tile UVs with two
  material groups, LOD levels), visibility, shortest paths, serialization
  (v4: `{cells, shifts, paints}`).
- **TS owns**: pointer/keyboard interaction, camera, overlays (ghost,
  selection, handles, constraint widget, brush ring), per-chunk three.js
  rendering of core-produced buffers (`src/render.ts`), the toolbar/panels.
- The shell talks to the core ONLY through `src/world.ts` (`WorldHandle`
  wraps the wasm `World`, adds change notification — every mutating call
  must `notify()` so the renderer/autosave react).

## Core invariants (enforced in Rust, tested in `rust/boxcore/tests`)

- Offsets clamp to ±0.5 per axis on every write path; near-zero deletes.
- A lattice corner is on the surface iff its 8 incident cells are mixed —
  this local test replaces any global surface set.
- Cell ops run `plan_shift_changes`: offsets leaving the surface are cleared
  (globally — stale offsets never survive), newly exposed corners copy from
  one layer back along the extrusion axis (extruding a ramp yields more ramp).
- Brushes with `topo` flip voxels past a 0.55 overflow and REBASE the offset
  onto the new ring (want ∓ dir) so the surface stays continuous; a stroke is
  ONE undo op; stranded offsets are cleaned at stroke end.
- Editor semantics: `=` extrudes only faces present at the plane; `-` carves
  the whole rect footprint and its plane keeps marching through air; Tab hands
  build-rect corners to sculpt selection. Paint hygiene mirrors offset hygiene
  in `plan_edit_changes`: newly exposed faces copy paint from the source face
  along the extrusion axis; buried faces' paint is cleared globally. Paint
  strokes are one op; brush topology growth leaves new faces unpainted.
- Meshing constants (light, base color, AO curve, diagonal rule, tint) are
  the visual identity — change them only deliberately.

## UI conventions

- Modes: 1 Build, 2 Sculpt, 3 Paint, plus Play (G/Esc, `editor.playing`).
  Paint: radius brush for single tiles, whole-block placement for multi-tile
  stamps (grid-locked, Q/E/F/R orient, textured preview via `setStampGhost`),
  random-scatter checkbox, sweep interpolation between pointer events
  (`pickGroupAt`), X/Ctrl/RMB erase, Alt eyedrop; entering paint forces the
  Textured view. Sculpt tools M/B/F (tool persists across mode switches);
  the Draw brush pushes along a locked X/Y/Z axis (camera-nearer sign) when
  a constraint is active (`stroke_begin` dir override). X/Y/Z blender
  constraints (Shift = plane), `=`/`-` nudges. Camera: P orbit/fly (fly-down
  Q, up E/Space — Z is reserved). Views: V sculpted/voxels, T
  textured/untextured. There is NO reference grid anymore.
- Play mode (`src/play.ts`): third-person 0.9r×3.5h cylinder, raycast
  collision against the rendered chunks (renderer.group), 50° max slope,
  0.55 auto-step, chase camera = orbit camera with target locked to the
  player. Editor suspends fly keys + overlays while playing.
- Grid step is per-mode (`editor.gridStep` accessor; sculpt defaults 0.5).
- Corner-handle visibility uses voxel DDA + facing test in the core. KNOWN
  imperfect; per Peter, don't polish — depth-buffer visibility arrives with
  the wgpu renderer.
- Peter has waived backwards compatibility until further notice; prefer the
  cleanest code over format/API stability. Future texturing = per-cell-face
  tile assignment on the derived surface, NOT free quads.

## Verification

- `cargo test` in `rust/boxcore` — parity-critical core behavior.
- `cargo run --release --bin bench` — representation benchmarks (1000³ cube,
  terrain, brush latency).
- `node scripts/verify.mjs` with the dev server up — the 60-check end-to-end
  suite driving the real UI via `window.editor` (world API + modes).
  Screenshots land in `/tmp/boxexplore-shots`. Always verify interactively,
  not just tsc: run the suite after ANY behavior-adjacent change.
