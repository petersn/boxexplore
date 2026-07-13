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
  Toolbar "Slab" prompts for X/Z/thickness and lays ground centered at the
  origin, top at y=0 (`ops::make_slab`, one undo op; New scene lays 16×16×2).
  Bulk fills are box-recorded in EditOp (`BoxFill` + `prev` overlap cells) and
  run O(chunks + offsets + paints), never O(volume) — 500³ ≈ 33 ms. fill_box
  writes partial-chunk bitmaps directly (no per-cell dirty marking).
  Build panel has the LOD-distance slider (`renderer.lodScale`).
  Paint: radius brush for single tiles, whole-block placement for multi-tile
  stamps (grid-locked, R rotate / F flip — Q/E are the fly camera's,
  textured preview via `setStampGhost`),
  random-scatter + only-paint-unpainted checkboxes, sweep interpolation
  between pointer events
  (`pickGroupAt`), X/Ctrl/RMB erase, Alt eyedrop; entering paint forces the
  Textured view and is the only mode showing the tileset panel. Sculpt
  tools M/B/F (default Draw, topo checkbox default ON; tool persists
  across mode switches);
  the Draw brush pushes along a locked X/Y/Z axis (camera-nearer sign) when
  a constraint is active (`stroke_begin` dir override). X/Y/Z blender
  constraints (Shift = plane), `=`/`-` nudges. Camera: P orbit/fly, default
  FLY (fly-down Q, up E/Space — Z is reserved). Views: V sculpted/voxels, T
  textured/untextured (untextured = direction-coded offset colors: axis →
  channel, normal-map style). There is NO reference grid anymore.
- Play mode: physics lives in Rust (`boxcore::physics` — rapier3d used as
  a QUERY engine only: per-chunk trimesh colliders synced lazily from
  `store.dirty_phys`, BVH ray/capsule/ball casts; the controller is
  hand-rolled kinematics, never a rigid body). While grounded, vertical
  velocity stays zero — slopes/steps are handled by ground snap + step-up,
  so climbs never go ballistic. Robustness is layered: all movement is
  SWEPT (capsule casts both vertical directions — no tunneling), sweeps
  use stop_at_penetration=false so light contact never blocks sliding,
  `Phys::depenetrate` (parry contact query, deepest-first) ejects residual
  overlap each tick, snaps are bounded (±step up, steep faces never lift),
  and `rescue_player_if_buried` (wasm_api) climbs to the nearest air
  column if the voxel store says the body is deep inside solid. Ground
  snapping is SWEPT (`snap_down`), never a ray teleport — teleport snaps
  re-penetrated slope planes and made the ramp base a limit cycle at fine
  dt (regression test: ramp_climb_is_timestep_independent). Walkable
  contacts deflect motion 3D-along the slope in `move_horizontal`; only
  unwalkable ones are walls. "Stable implies jumpable": resting unwalkably
  (wedge, ledge lip — `rest_ticks`) or sliding grants a tech-out jump
  (weaker hop + kick along the brace normal + brief control lockout, so
  steep faces can't be climbed by jump-mashing). Chase camera boom is STATELESS
  (`Phys::camera_boom`, no smoothing/history): a discretized cone cast —
  min over sphere radii of clearance(r) + K·(r−RMIN) — glides in near
  ceilings/walls and settles at the thin line-of-sight distance (tested:
  camera_boom_glides_in_under_ceilings). C in play mode shows the live
  radius→distance debug plot. `src/play.ts` is only input → wish dir,
  the body mesh, and the chase camera: smoothed focus point (swivel stays
  snappy), boom clamped by a backward spherecast (`viewport.distClamp`).
  Editor suspends fly keys + overlays while playing.
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
- `node scripts/verify.mjs` with the dev server up — the 85-check end-to-end
  suite driving the real UI via `window.editor` (world API + modes).
  Screenshots land in `/tmp/boxexplore-shots`. Always verify interactively,
  not just tsc: run the suite after ANY behavior-adjacent change.
