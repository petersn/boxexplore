# The volume representation (Rust core)

How the editor stores and processes very large voxel worlds, why this
representation was chosen, and what the measured numbers are. The code lives
in `rust/boxcore` and compiles to WASM (`npm run wasm`); the same crate runs
natively for tests (`cargo test`) and benchmarks (`cargo run --release --bin
bench`).

## Requirements

1. Identical editor behavior to the JS implementation (proven by the
   60-check playwright suite in `scripts/verify.mjs`).
2. A 1000³ solid cube must cost ~n² storage, not n³.
3. Natural chunking for incremental remeshing and LOD.
4. Ops and diff-based undo/redo must stay simple.

## Candidates considered

**A. Hash set of cells** (what the JS editor did). O(n³) memory and O(n³)
surface scans. 1000³ = ~37 GiB — infeasible. Kept in the benchmark as the
baseline.

**B. Jarlsberg-style boundary rectangles** — per-direction, per-altitude
lists of coplanar rectangles. O(surface) storage and great for boxy shapes,
but: (a) boundary CSG (`subtract`/`prune`/`optimize`) is fiddly and easy to
get wrong; (b) point queries ("is this cell solid?" — needed constantly by
brushes, hygiene, visibility) require a spatial index anyway; (c) sculpted
organic surfaces fragment into per-cell rectangles, erasing the advantage.
The rectangle idea survives in spirit as a *mesher* optimization (greedy
meshing), not as the source of truth.

**C. Sparse voxel octree / openvdb.** Best asymptotics (a solid cube
collapses to a handful of nodes), natural LOD, but higher implementation
complexity and slower neighbor queries than flat bitmaps.

**D. Chunked occupancy with uniform-chunk collapsing ("VDB-lite") — chosen.**
The world is divided into 32³ chunks stored in a hash map. Each present chunk
is either `Full` (a tag — O(1)) or `Bits` (a 4 KiB bitmap). Absent chunks are
empty. This is effectively a one-level VDB: bitmaps exist only where the
surface passes through, so real storage is O(n²); interior chunks cost one
map entry each.

Offsets (lattice-corner displacements, clamped ±0.5) are a separate sparse
hash map keyed by packed integer coordinates. Op-level hygiene guarantees
offsets only exist on surface corners, so they're O(surface) by construction.

Key point that made everything simple: **a lattice corner is on the surface
iff its 8 incident cells are mixed** (some solid, some empty). This local
test replaces the old global surface-set computation in ops, hygiene,
brushes, and visibility.

## Measured (M-series laptop, single thread, release)

```
1000³ solid cube (1e9 cells)
  fill                 299 ms
  storage              13.6 MiB   (29 791 Full tags + 2 977 bitmaps)
  full mesh            1.84 s     (6.0 M faces, one-time)
  carve 32×32 rect     0.32 ms op + 1.38 ms remesh (9 chunks)

hash-set baseline (old JS representation)
  256³ = 16.7M cells   313 ms fill, 1.62 s surface scan, ~640 MiB
  1000³                ~37 GiB — infeasible

1024×1024 fbm terrain (32.0 M cells)
  fill                 524 ms     (7.0 MiB)
  full mesh            445 ms     (2.9 M faces, 6.5 M faces/s)
  LOD 1 / LOD 2        231 / 149 ms (726 k / 180 k faces)
  draw-brush dab       0.61 ms including chunk remesh
  smooth stroke (r=6)  1.64 ms including remesh
```

Interactive edits are sub-millisecond; only whole-world meshing takes real
time, and it happens once (then only dirty chunks remesh).

## Meshing & rendering

- Per chunk: build a 34³ padded occupancy (1-cell apron via a 3×3×3 chunk
  cache), emit a quad wherever solid meets empty. AO, shading constants, the
  AO-aware diagonal flip, displacement, and the untextured tint are exact
  ports of the JS mesher.
- Chunks whose cells/offsets change are marked dirty (including neighbors —
  AO reaches across borders); the TS renderer re-uploads only those buffers.
- Picking is a three.js raycast against chunk meshes; each mesh carries a
  face-key array mapping triangles back to (cell, dir).
- **LOD**: `mesh_chunk_lod(level)` downsamples occupancy by 2^level
  ("any-solid", conservative hull). Faces on chunk borders cull only against
  *fully*-solid neighbors, which seals cracks at LOD transitions. The
  renderer swaps levels by camera distance (160/320 units) with a per-frame
  rebuild budget, and hides cell outlines beyond 96 units.

## Boundaries (what's settled vs. still prototype)

Settled ("core"): the op semantics and hygiene rules, EditOp/undo shape, the
surface-corner local test, the mesher's shading/AO conventions, the wasm API
surface.

Prototype (expected to change in the wgpu rework): the exact chunk size (32³
chosen for the bitmap-per-chunk sweet spot), scalar meshing loops (bitwise
SIMD-style face extraction can win ~10×), offsets as a single global hash map
(per-chunk offset pages would improve locality), visibility via voxel DDA
(replace with depth-buffer readback), rendering via three.js draw calls
(replace with wgpu + persistent GPU buffers), LOD selection policy, and
greedy meshing for flat textured regions once face painting lands.
