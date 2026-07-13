# The chase-camera boom: design notes

*(2026-07-12 — Peter + Claude. The winning algorithm lives in
`rust/boxcore/src/physics.rs`, `Phys::camera_boom`. This file records the
investigation so future-us doesn't re-derive it.)*

## The problem

A third-person chase camera must not enter geometry, but the naive fix — a
single spherecast from the player's focus back along the boom, clamping the
camera to the hit — **snaps**: walk under a ceiling with the camera pitched
down and the instant the cast first clips the ceiling edge, the camera
teleports from "far" to "under the ceiling." Time-based smoothing over that
signal just spreads the teleport over a few frames; the underlying signal is
discontinuous.

A first attempt used stateful heuristics (predictive "whisker" casts along
the player's velocity plus steeper-pitch probes, asymmetric smoothing). It
worked but felt path-dependent and jerky. Requirement adopted after that:
**the boom length must be a stateless function of (player position, view
direction)** — same inputs, same camera, no history. Any smoothing goes on
top of a signal that is already continuous.

## Key structural facts

Everything below follows from three facts about `clearance(r)` = distance a
sphere of radius `r`, swept from the focus along the boom direction, travels
before hitting the world:

1. **Monotone:** `clearance(r)` is non-increasing in `r` (a fatter sphere
   never flies farther). This makes bisection over radius sound.
2. **Step-shaped near edges:** as a function of `r` it is nearly a step: a
   sphere either *slips past* an occluder's edge (long) or *crashes into its
   face* (short). There is no gradual dip. Any algorithm that assumes the
   curve interpolates smoothly between the thin and fat readings is reading
   tea leaves between two plateaus.
3. **The cliff radius is the signal:** the radius `r_crit` where the step
   happens varies *continuously* with player position — the gap between you
   and the ceiling edge closes smoothly. The distances themselves jump; the
   critical radius does not. Every scheme that worked extracts `r_crit`.

## What we tried

### 1. Endpoint-anchored trend + bisection ("Peter's algorithm")

Cast thin (`RMIN`) → `dmax`, fat (`RMAX`) → `dmin`. Draw the line between
`(RMIN, dmax)` and `(RMAX, dmin)`. Bisect for the largest radius whose
clearance is still *above* the line (≈ `r_crit`), then read the line there:
`boom = trend(r_crit)`.

- **Middle band: beautiful.** The cliff sweeps continuously, the boom rides
  the trend — validated the whole cliff-radius idea.
- **Two structural snaps.** The trend's *anchors* are themselves the step
  functions: at fat-sphere onset `dmin` jumps (16 → ~2 in the test scene),
  and at thin-ray collapse `dmax` jumps (16 → 7.9). Each anchor jump moves
  the whole line and the output pops (worst measured step: **14 units**).
  It was also non-monotone: boom *rose* toward `dmax` while walking deeper
  under cover, then snapped down.

### 2. Same, but read the trend at the mirrored radius

`boom = trend(RMIN + RMAX − r_crit)`. One "one-minus" and both end snaps
cancel: at each anchor discontinuity the mirrored read-out happens to sit at
the value the boom already had. Fully continuous (worst step 0.67) and
monotone. The cost: it settles at **`dmin`** under sustained cover — the
fat-cast distance, hyper-conservative. Under a 6-unit ceiling the camera
hugs ~1.75 units behind the player when ~7.9 fits. Tolerable, not great.

### 3. Fixed-slope trend = discretized cone cast (**winner**)

Don't re-anchor the line to the (discontinuous) measurements each frame; fix
its **slope** and slide it:

```
boom = min over r of  clearance(r) + K·(r − RMIN)
```

A hit at radius `r` and distance `d` costs `d` plus a credit of `K` boom
units per unit of obstacle margin. Equivalently: find where the clearance
curve dips furthest below a line of fixed slope −K and read that line back
at `RMIN`. Geometrically it is a **cone cast** (half-angle `atan(1/K)`,
cone reaching `RMAX` at full boom), sampled by spheres.

Why it has all the properties:

- **Continuous:** the minimum tracks `d(r_crit) + K·(r_crit − RMIN)`, and
  `r_crit` moves continuously. Anchor jumps don't matter — no anchors.
- **Settles at line of sight:** deep under a flat ceiling the clearance
  curve's slope vs `r` is `−1/sin(pitch)`; with `K` larger than that, the
  credit outweighs the clearance loss, the min sits at `RMIN`, and
  `boom = dmax` — the true thin-sphere LoS, not the conservative fat one.
- **Glides:** walking toward the ceiling, the fat rungs go short first and
  win by less and less credit as `r_crit` shrinks; measured on the test
  scene, 16 → 7.87 in ~0.8-unit steps per half-unit walked, continuous
  through the thin-ray collapse.

Two refinements were necessary in practice:

- **De-quantization.** The coarse ladder (14 rungs) makes the winner move
  in increments of `K·Δr` (≈1.1 units of boom) as `r_crit` sweeps between
  rungs — visible as rhythmic little snaps. Fix: after picking the winning
  rung, bisect the cliff edge between it and its free neighbor (sound
  because of monotonicity, ~7 casts) and take the min cost over every cast.
  Worst per-frame step measured at run speed dropped from 1.3 to **0.2**.
- **Grazing filter.** Geometry the sweep slides *past* must not pull the
  camera in: hugging a wall while looking along it, the fat spheres overlap
  the wall from t=0, and a trimesh reports fresh triangle contacts at
  toi≈0 (with noisy penetration normals) even with
  `stop_at_penetration=false`. Two rules kill the false positives without
  touching real anticipation: hits with `toi < 0.05` are ignored (a sphere
  overlapping geometry *at the focus* describes the player's vicinity, not
  the camera path — short-range safety is the thin LoS cast's job), and
  surviving hits are weighted by how much their normal opposes the sweep
  (ceiling ahead: full weight; parallel wall: zero; smooth ramp between so
  camera swivel can't pop). Covered by
  `camera_boom_ignores_grazing_side_walls`.

## Final architecture

- `Phys::camera_boom(focus, dir, max_dist) -> [boom, los]` — the stateless
  cone cast (~22 spherecasts/frame). `los` = thin-sphere clearance = the
  hard never-clip distance.
- `src/play.ts` adds light **fast-in / slow-out** smoothing on top
  (`BOOM_IN = 12/s`, `BOOM_OUT = 2/s`), hard-clamped to `los` every frame
  so smoothing lag can never push the camera into geometry. Safe to do now
  *because* the underlying signal is continuous — smoothing polishes, it
  doesn't paper over snaps.
- The player body fades toward alpha 0.1 as the effective camera distance
  drops below ~6 units.

Tuning knobs (all in `camera_boom`): `CAM_RMIN` 0.4 (camera's physical
radius), `CAM_RMAX` 2.5 (anticipation reach), `K = max_dist / (RMAX − RMIN)`
(cone tightness: bigger K = pulls in later and less), `SAMPLES`/`REFINE`
(resolution). Tests: `camera_boom_glides_in_under_ceilings` (glide ≤ 0.5 per
0.1-unit step, settles at LoS, never exceeds LoS) and the grazing-wall test.
