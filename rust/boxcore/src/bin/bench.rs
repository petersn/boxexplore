//! Representation benchmarks: the chunked store vs a naive hash-set of cells,
//! on the two shapes that matter — a huge solid cube (storage must be ~n²,
//! not n³) and blobby sculpted terrain (brush latency, incremental remesh).
//!
//! Run: cargo run --release --bin bench

use boxcore::mesh::{mesh_chunk, mesh_chunk_lod, MeshOpts};
use boxcore::ops::{BrushTool, RectSel, Stroke};
use boxcore::store::{ChunkStore, Offsets};
use boxcore::IV;
use rustc_hash::FxHashSet;
use std::time::Instant;

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

fn mesh_all(store: &ChunkStore, offsets: &Offsets, opts: &MeshOpts) -> (usize, f64) {
    let t = Instant::now();
    let mut faces = 0usize;
    let positions: Vec<IV> = store.chunks.keys().copied().collect();
    for cp in positions {
        faces += mesh_chunk(store, offsets, cp, opts).face_count();
    }
    (faces, ms(t))
}

fn remesh_dirty(store: &mut ChunkStore, offsets: &Offsets, opts: &MeshOpts) -> (usize, usize, f64) {
    let t = Instant::now();
    let dirty: Vec<IV> = store.dirty.drain().collect();
    let mut faces = 0usize;
    for cp in &dirty {
        faces += mesh_chunk(store, offsets, *cp, opts).face_count();
    }
    (dirty.len(), faces, ms(t))
}

// deterministic 2D value noise for blobby terrain
fn hash2(x: i32, z: i32) -> f32 {
    let mut h = (x as u64).wrapping_mul(0x9E3779B97F4A7C15) ^ (z as u64).wrapping_mul(0xC2B2AE3D27D4EB4F);
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51AFD7ED558CCD);
    h ^= h >> 33;
    (h >> 40) as f32 / (1u64 << 24) as f32
}

fn value_noise(x: f32, z: f32) -> f32 {
    let xi = x.floor() as i32;
    let zi = z.floor() as i32;
    let fx = x - xi as f32;
    let fz = z - zi as f32;
    let sx = fx * fx * (3.0 - 2.0 * fx);
    let sz = fz * fz * (3.0 - 2.0 * fz);
    let a = hash2(xi, zi);
    let b = hash2(xi + 1, zi);
    let c = hash2(xi, zi + 1);
    let d = hash2(xi + 1, zi + 1);
    a + (b - a) * sx + (c - a) * sz + (d - c - (b - a)) * sx * sz
}

fn terrain_height(x: i32, z: i32) -> i32 {
    let mut h = 0.0;
    let mut amp = 32.0;
    let mut freq = 1.0 / 64.0;
    for _ in 0..4 {
        h += value_noise(x as f32 * freq, z as f32 * freq) * amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    h as i32 + 2
}

fn main() {
    println!("boxcore representation benchmarks (single-threaded, release)");
    println!("=============================================================\n");

    // --- scenario 1: the 1000³ solid cube --------------------------------------
    {
        println!("[cube] 1000×1000×1000 solid cube — 1e9 cells");
        let mut store = ChunkStore::new();
        let offsets = Offsets::default();
        let t = Instant::now();
        store.fill_box((0, 0, 0), (1000, 1000, 1000), true);
        let fill_ms = ms(t);
        let (full, bits) = store.chunk_state_counts();
        println!("  fill:        {:>10.2} ms", fill_ms);
        println!(
            "  chunks:      {:>10} ({} Full tags, {} bitmaps)",
            full + bits,
            full,
            bits
        );
        println!(
            "  storage:     {:>10.2} MiB  (vs ~{:.1} GiB for a hash-set of cells)",
            store.approx_bytes() as f64 / (1024.0 * 1024.0),
            1e9 * 40.0 / (1024f64.powi(3))
        );
        let (faces, mesh_ms) = mesh_all(
            &store,
            &offsets,
            &MeshOpts {
                sculpted: true,
                tint: false,
            },
        );
        println!(
            "  full mesh:   {:>10.2} ms   ({} faces, {:.1} Mfaces/s)",
            mesh_ms,
            faces,
            faces as f64 / mesh_ms / 1e3
        );

        // incremental edit: carve a 32×32 rect one layer into the top
        store.dirty.clear();
        let mut offsets = Offsets::default();
        let sel = RectSel {
            axis: 1,
            sign: 1,
            plane: 1000,
            a0: 480,
            a1: 511,
            b0: 480,
            b1: 511,
        };
        let t = Instant::now();
        let op = boxcore::ops::extrude_rect(&mut store, &mut offsets, &sel, -1);
        let op_ms = ms(t);
        let (n_dirty, _, rm_ms) = remesh_dirty(
            &mut store,
            &offsets,
            &MeshOpts {
                sculpted: true,
                tint: false,
            },
        );
        println!(
            "  carve 32×32: {:>10.2} ms op ({} cells) + {:.2} ms remesh of {} chunks\n",
            op_ms,
            op.removed.len(),
            rm_ms,
            n_dirty
        );
    }

    // --- scenario 2: naive hash-set baseline (the old JS representation) --------
    {
        println!("[baseline] hash-set-of-cells store (what the JS editor did)");
        for n in [128, 256] {
            let mut cells: FxHashSet<i64> = FxHashSet::default();
            let t = Instant::now();
            for x in 0..n {
                for y in 0..n {
                    for z in 0..n {
                        cells.insert(boxcore::pack((x, y, z)));
                    }
                }
            }
            let fill_ms = ms(t);
            let t = Instant::now();
            let mut faces = 0u64;
            for x in 0..n {
                for y in 0..n {
                    for z in 0..n {
                        for d in boxcore::DIRS {
                            if !cells.contains(&boxcore::pack((x + d.0, y + d.1, z + d.2))) {
                                faces += 1;
                            }
                        }
                    }
                }
            }
            let mesh_ms = ms(t);
            println!(
                "  {0}³: fill {1:>9.1} ms, surface scan {2:>9.1} ms, ~{3:.0} MiB   ({4} faces)",
                n,
                fill_ms,
                mesh_ms,
                cells.len() as f64 * 40.0 / (1024.0 * 1024.0),
                faces
            );
        }
        println!("  1000³: ~40 GiB, infeasible — this is why the representation changed\n");
    }

    // --- scenario 3: blobby terrain + brushes ------------------------------------
    {
        println!("[terrain] 1024×1024 fbm heightfield (blobby organic case)");
        let mut store = ChunkStore::new();
        let mut offsets = Offsets::default();
        let t = Instant::now();
        for x in 0..1024 {
            for z in 0..1024 {
                let h = terrain_height(x, z);
                store.fill_box((x, 0, z), (x + 1, h, z + 1), true);
            }
        }
        let fill_ms = ms(t);
        let (full, bits) = store.chunk_state_counts();
        println!(
            "  fill:        {:>10.2} ms   ({} cells, {} Full + {} bitmap chunks, {:.1} MiB)",
            fill_ms,
            store.cell_count(),
            full,
            bits,
            store.approx_bytes() as f64 / (1024.0 * 1024.0)
        );
        let (faces, mesh_ms) = mesh_all(
            &store,
            &offsets,
            &MeshOpts {
                sculpted: true,
                tint: false,
            },
        );
        println!(
            "  full mesh:   {:>10.2} ms   ({} faces, {:.1} Mfaces/s)",
            mesh_ms,
            faces,
            faces as f64 / mesh_ms / 1e3
        );

        // LOD meshes for the whole world
        for level in [1u32, 2] {
            let t = Instant::now();
            let mut lod_faces = 0usize;
            let positions: Vec<IV> = store.chunks.keys().copied().collect();
            for cp in positions {
                lod_faces += mesh_chunk_lod(&store, cp, level).face_count();
            }
            println!(
                "  LOD {}:       {:>10.2} ms   ({} faces)",
                level,
                ms(t),
                lod_faces
            );
        }

        // sculpt brush strokes with topology on: 200 dabs at random spots
        store.dirty.clear();
        let mut rng: u64 = 12345;
        let mut next = |m: i32| {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            (rng % m as u64) as i32
        };
        let t = Instant::now();
        let mut total_remesh = 0.0;
        let mut total_chunks = 0usize;
        for _ in 0..200 {
            let x = 64 + next(896);
            let z = 64 + next(896);
            let y = terrain_height(x, z);
            let mut stroke = Stroke::new(BrushTool::Draw, false, 3.0, 0.8, true);
            stroke.dab(&mut store, &mut offsets, [x as f32, y as f32, z as f32]);
            let _ = stroke.end(&mut store, &mut offsets);
            let (nd, _, rms) = remesh_dirty(
                &mut store,
                &offsets,
                &MeshOpts {
                    sculpted: true,
                    tint: false,
                },
            );
            total_remesh += rms;
            total_chunks += nd;
        }
        let dabs_ms = ms(t);
        println!(
            "  200 dabs:    {:>10.2} ms total → {:.2} ms/dab incl. remesh ({} chunk remeshes, {:.2} ms remesh total)",
            dabs_ms,
            dabs_ms / 200.0,
            total_chunks,
            total_remesh
        );

        // smooth strokes over a larger radius
        let t = Instant::now();
        for i in 0..50 {
            let x = 100 + i * 15;
            let z = 512;
            let y = terrain_height(x, z);
            let mut stroke = Stroke::new(BrushTool::Smooth, false, 6.0, 0.8, false);
            for _ in 0..4 {
                stroke.dab(&mut store, &mut offsets, [x as f32, y as f32, z as f32]);
            }
            let _ = stroke.end(&mut store, &mut offsets);
            let _ = remesh_dirty(
                &mut store,
                &offsets,
                &MeshOpts {
                    sculpted: true,
                    tint: false,
                },
            );
        }
        println!(
            "  50 smooth strokes (r=6, 4 dabs each): {:>7.2} ms incl. remesh ({:.2} ms/stroke)",
            ms(t),
            ms(t) / 50.0
        );
        println!("  offsets now: {}", offsets.len());
    }
}
