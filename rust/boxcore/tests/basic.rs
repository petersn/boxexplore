//! Parity-critical behavior tests, mirroring the browser verify suite.

use boxcore::mesh::{boundary_stats, mesh_chunk, MeshOpts};
use boxcore::ops::{self, BrushTool, RectSel, Stroke};
use boxcore::store::{ChunkStore, Offsets, Paints};

fn opts() -> MeshOpts {
    MeshOpts {
        sculpted: true,
        tint: false,
        paint: false,
        grid: (8, 8),
    }
}

fn total_faces(store: &ChunkStore, offsets: &Offsets) -> usize {
    let paints = Paints::default();
    let mut n = 0;
    for cp in store.chunks.keys() {
        n += mesh_chunk(store, offsets, &paints, *cp, &opts()).face_count();
    }
    n
}

#[test]
fn cube_face_counts() {
    let mut store = ChunkStore::new();
    let offsets = Offsets::default();
    store.fill_box((0, 0, 0), (1, 1, 1), true);
    assert_eq!(store.cell_count(), 1);
    assert_eq!(total_faces(&store, &offsets), 6);

    // 4x3x1 slab: 2*12 + 2*(4+3) = 38
    store.clear();
    let mut store = store;
    store.fill_box((0, 0, 0), (4, 1, 3), true);
    assert_eq!(store.cell_count(), 12);
    assert_eq!(total_faces(&store, &offsets), 38);
    let (faces, odd) = boundary_stats(&store);
    assert_eq!(faces, 38);
    assert_eq!(odd, 0);
}

#[test]
fn big_cube_is_cheap_and_watertight_at_chunk_scale() {
    let mut store = ChunkStore::new();
    let offsets = Offsets::default();
    store.fill_box((0, 0, 0), (128, 128, 128), true);
    assert_eq!(store.cell_count(), 128 * 128 * 128);
    let (full, bits) = store.chunk_state_counts();
    assert_eq!(full, 64); // all 4³ chunks collapse to Full tags
    assert_eq!(bits, 0);
    assert_eq!(total_faces(&store, &offsets), 6 * 128 * 128);
}

#[test]
fn extrude_faces_present_only_and_carve_footprint() {
    let mut store = ChunkStore::new();
    let mut offsets = Offsets::default();
    let mut paints = Paints::default();
    store.fill_box((0, -1, 0), (1, 0, 1), true); // the seed voxel

    // rect on the top plane extending into air: extrude fills only over solid
    let sel = RectSel {
        axis: 1,
        sign: 1,
        plane: 0,
        a0: 0,
        a1: 5,
        b0: 0,
        b1: 0,
    };
    let op = ops::extrude_rect(&mut store, &mut offsets, &mut paints, &sel, 1);
    assert_eq!(op.added.len(), 1); // only above the seed
    assert!(store.get((0, 0, 0)));

    // carve removes the whole footprint present at the plane
    let sel2 = RectSel {
        axis: 1,
        sign: 1,
        plane: 1,
        a0: 0,
        a1: 5,
        b0: 0,
        b1: 0,
    };
    let op2 = ops::extrude_rect(&mut store, &mut offsets, &mut paints, &sel2, -1);
    assert_eq!(op2.removed.len(), 1);
    assert!(!store.get((0, 0, 0)));
}

#[test]
fn extrusion_carries_ramp_and_cleans_stale() {
    let mut store = ChunkStore::new();
    let mut offsets = Offsets::default();
    let mut paints = Paints::default();
    store.fill_box((0, -1, 0), (1, 0, 1), true);
    offsets.set((1, 0, 0), Some([0.0, -0.5, 0.0]));
    offsets.set((1, 0, 1), Some([0.0, -0.5, 0.0]));
    offsets.set((9, 9, 9), Some([0.3, 0.3, 0.3])); // stale, floating in space

    // extrude the +x face one layer
    let sel = RectSel {
        axis: 0,
        sign: 1,
        plane: 1,
        a0: -1,
        a1: 0,
        b0: 0,
        b1: 0,
    };
    let op = ops::extrude_rect(&mut store, &mut offsets, &mut paints, &sel, 1);
    assert_eq!(op.added.len(), 1);
    assert!(store.get((1, -1, 0)));
    // the ramp cross-section carried to the new ring
    assert_eq!(offsets.get((2, 0, 0))[1], -0.5);
    assert_eq!(offsets.get((2, 0, 1))[1], -0.5);
    // the stale offset was cleaned up
    assert!(offsets.get_opt((9, 9, 9)).is_none());
    // undo restores everything
    ops::apply_op(&mut store, &mut offsets, &mut paints, &op, false);
    assert!(!store.get((1, -1, 0)));
    assert!(offsets.get_opt((2, 0, 0)).is_none());
    assert_eq!(offsets.get((9, 9, 9))[0], 0.3);
}

#[test]
fn offsets_hard_clamp() {
    let mut offsets = Offsets::default();
    let mut paints = Paints::default();
    offsets.set((0, 0, 0), Some([2.0, -3.0, 0.1]));
    let v = offsets.get((0, 0, 0));
    assert_eq!(v, [0.5, -0.5, 0.1]);
    offsets.set((0, 0, 0), Some([1e-12, 0.0, 0.0]));
    assert!(offsets.get_opt((0, 0, 0)).is_none()); // near-zero deletes
}

#[test]
fn visibility_lone_cube_shows_seven_corners() {
    let mut store = ChunkStore::new();
    let offsets = Offsets::default();
    store.fill_box((0, -1, 0), (1, 0, 1), true);
    // default editor camera position
    let eye = [8.44, 8.31, -8.44];
    let visible = ops::visible_corners(&store, &offsets, eye, f32::INFINITY);
    assert_eq!(ops::all_surface_corners(&store).len(), 8);
    assert_eq!(visible.len(), 7);
}

#[test]
fn draw_brush_with_topology_grows_and_stays_watertight() {
    let mut store = ChunkStore::new();
    let mut offsets = Offsets::default();
    let mut paints = Paints::default();
    store.fill_box((0, -1, 0), (3, 0, 2), true); // small slab
    let before = store.cell_count();

    let mut stroke = Stroke::new(BrushTool::Draw, false, 2.0, 1.0, true);
    for _ in 0..6 {
        stroke.dab(&mut store, &mut offsets, [1.5, 0.0, 1.0]);
    }
    let op = stroke.end(&mut store, &mut offsets, &mut paints);
    assert!(store.cell_count() > before, "topology growth");
    let (_, odd) = boundary_stats(&store);
    assert_eq!(odd, 0, "watertight after growth");
    // no stranded offsets
    for l in offsets.keys() {
        assert!(ops::on_surface(&store, l), "offset stranded at {:?}", l);
    }
    // one-op undo restores exactly
    ops::apply_op(&mut store, &mut offsets, &mut paints, &op, false);
    assert_eq!(store.cell_count(), before);
    assert_eq!(offsets.len(), 0);
}

#[test]
fn smooth_brush_rounds_edges_from_zero_offsets() {
    let mut store = ChunkStore::new();
    let mut offsets = Offsets::default();
    let mut paints = Paints::default();
    store.fill_box((0, -1, 0), (3, 0, 3), true);
    store.fill_box((1, 0, 1), (2, 1, 2), true); // box on a plateau
    let mut stroke = Stroke::new(BrushTool::Smooth, false, 2.0, 0.8, false);
    for _ in 0..4 {
        stroke.dab(&mut store, &mut offsets, [1.5, 1.0, 1.5]);
    }
    let _ = stroke.end(&mut store, &mut offsets, &mut paints);
    assert!(offsets.len() > 4, "smoothing produced offsets");
    let (_, odd) = boundary_stats(&store);
    assert_eq!(odd, 0);
}

#[test]
fn shortest_path_follows_edges() {
    let mut store = ChunkStore::new();
    let offsets = Offsets::default();
    store.fill_box((0, -1, 0), (4, 0, 1), true); // a row of 4
    let path = ops::shortest_path(&store, &offsets, (0, 0, 0), (4, 0, 0));
    assert_eq!(path.len(), 5);
    assert!(path.contains(&(2, 0, 0)));
}

#[test]
fn json_roundtrip() {
    use boxcore::wasm_api::World;
    let mut w = World::new();
    w.seed_voxel();
    w.set_shift_raw(0, 0, 0, 0.25, 0.5, -0.25);
    w.paint_stroke_begin();
    assert!(w.paint_face(0, -1, 0, 2, 3, 4, 1, true, false));
    w.paint_stroke_end();
    let json = w.to_json();
    let mut w2 = World::new();
    assert!(w2.load_json(&json));
    assert_eq!(w2.cell_count(), 1.0);
    assert_eq!(w2.get_shift(0, 0, 0), vec![0.25, 0.5, -0.25]);
    assert_eq!(w2.get_paint(0, -1, 0, 2), vec![3, 4, 1, 1, 0]);
}

#[test]
fn character_controller_walks_jumps_and_climbs() {
    use boxcore::physics::{Phys, Player};
    let mut store = ChunkStore::new();
    let mut offsets = Offsets::default();
    let paints = Paints::default();
    // floor + a 45° ramp rising +x from x=5
    store.fill_box((-10, -1, -10), (20, 0, 10), true);
    for i in 0..4 {
        store.fill_box((5 + i, 0, -2), (6 + i, 1 + i, 2), true);
    }
    for i in 0..4 {
        for z in -2..=2 {
            offsets.set((5 + i, 1 + i, z), Some([0.0, -0.5, 0.0]));
            offsets.set((6 + i, 1 + i, z), Some([0.0, 0.5, 0.0]));
        }
    }
    let mut phys = Phys::new();
    for cp in store.chunks.keys() {
        phys.dirty.insert(*cp);
    }
    phys.sync(&store, &offsets, &paints);

    let mut p = Player::new();
    p.spawn_at(&phys, 0.0, 0.0);
    // settle
    for _ in 0..60 {
        p.update(&phys, 1.0 / 60.0, [0.0, 0.0], false);
    }
    assert!(p.on_ground, "landed");
    assert!(p.pos[1].abs() < 0.05, "on the floor: y={}", p.pos[1]);

    // run +x
    for _ in 0..40 {
        p.update(&phys, 1.0 / 60.0, [1.0, 0.0], false);
    }
    assert!(p.pos[0] > 2.0, "ran forward: x={}", p.pos[0]);

    // jump
    let y0 = p.pos[1];
    p.update(&phys, 1.0 / 60.0, [0.0, 0.0], true);
    let mut apex = y0;
    for _ in 0..40 {
        p.update(&phys, 1.0 / 60.0, [0.0, 0.0], false);
        apex = apex.max(p.pos[1]);
    }
    assert!(apex > y0 + 2.0, "jump apex {} (higher jump)", apex);

    // climb the 45° ramp (peak height — the run continues past the top)
    let mut peak = p.pos[1];
    for _ in 0..150 {
        p.update(&phys, 1.0 / 60.0, [1.0, 0.0], false);
        peak = peak.max(p.pos[1]);
    }
    assert!(peak > 3.0, "climbed the ramp: peak={}", peak);
}

fn phys_for(store: &ChunkStore, offsets: &Offsets) -> boxcore::physics::Phys {
    let paints = Paints::default();
    let mut phys = boxcore::physics::Phys::new();
    for cp in store.chunks.keys() {
        phys.dirty.insert(*cp);
    }
    phys.sync(store, offsets, &paints);
    phys
}

#[test]
fn depenetration_ejects_overlapping_capsule() {
    use boxcore::physics::{HEIGHT, RADIUS};
    let mut store = ChunkStore::new();
    let offsets = Offsets::default();
    store.fill_box((0, -1, -8), (16, 8, 8), true); // a big solid block
    let phys = phys_for(&store, &offsets);
    // capsule center shoved 0.4 into the block's -x face (x=0 plane)
    let half = (HEIGHT - 2.0 * RADIUS) / 2.0;
    let (c, resolved) = phys.depenetrate([0.4 - RADIUS, 3.0, 0.0], half, RADIUS);
    assert!(resolved, "depenetration converged");
    assert!(c[0] <= -RADIUS + 0.02, "pushed back out of the face: x={}", c[0]);
    // an already-free capsule is untouched
    let free = [-5.0, 20.0, 0.0];
    let (c2, ok) = phys.depenetrate(free, half, RADIUS);
    assert!(ok && c2 == free, "free capsule unchanged");
}

#[test]
fn controller_survives_steep_slope_assault() {
    use boxcore::physics::Player;
    let mut store = ChunkStore::new();
    let mut offsets = Offsets::default();
    store.fill_box((-12, -1, -12), (12, 0, 12), true); // floor at y=0
    // a tall steep prow: 5-high wall whose face leans out ~79° (unwalkable)
    store.fill_box((4, 0, -6), (8, 5, 6), true);
    for z in -6..=6 {
        offsets.set((4, 0, z), Some([-0.5, 0.0, 0.0]));
        offsets.set((4, 5, z), Some([0.5, 0.0, 0.0]));
    }
    let phys = phys_for(&store, &offsets);
    let mut p = Player::new();
    p.spawn_at(&phys, 0.0, 0.0);
    // charge the slope with jump mashing for 10 seconds
    for i in 0..600 {
        p.update(&phys, 1.0 / 60.0, [1.0, 0.0], i % 9 < 2);
        assert!(
            p.pos.iter().all(|v| v.is_finite()),
            "position stays finite: {:?}",
            p.pos
        );
        assert!(p.pos[1] > -0.6, "never falls through the floor: {:?}", p.pos);
        assert!(p.pos[0] < 5.0, "never passes through the steep wall: {:?}", p.pos);
    }
    assert!(!p.embedded, "not stuck inside geometry at the end");
}

#[test]
fn controller_fuzz_stays_in_world() {
    use boxcore::physics::Player;
    let mut store = ChunkStore::new();
    let mut offsets = Offsets::default();
    // a closed arena: bumpy floor, walls all around
    store.fill_box((-16, -2, -16), (16, 0, 16), true);
    store.fill_box((-17, -2, -17), (-16, 12, 17), true);
    store.fill_box((16, -2, -17), (17, 12, 17), true);
    store.fill_box((-17, -2, -17), (17, 12, -16), true);
    store.fill_box((-17, -2, 16), (17, 12, 17), true);
    // scattered pillars and ledges to collide with
    for k in 0..8 {
        let x = -12 + k * 3;
        store.fill_box((x, 0, -12 + k * 2), (x + 2, 1 + (k % 4), -10 + k * 2), true);
    }
    // deterministic LCG jitters the floor corners for organic slopes
    let mut rng: u64 = 0x1234_5678_9ABC_DEF0;
    let mut rand = move || {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((rng >> 33) as f32 / (1u64 << 31) as f32) - 0.5
    };
    for x in -16..16 {
        for z in -16..16 {
            offsets.set((x, 0, z), Some([0.0, rand(), 0.0]));
        }
    }
    let phys = phys_for(&store, &offsets);
    let mut p = Player::new();
    p.spawn_at(&phys, 0.0, 0.0);
    // 30 seconds of erratic input driven by the same LCG
    let mut wish = [1.0f32, 0.0f32];
    for i in 0..1800 {
        if i % 23 == 0 {
            let a = rand() * std::f32::consts::TAU;
            wish = [a.cos(), a.sin()];
        }
        p.update(&phys, 1.0 / 60.0, wish, i % 13 < 3);
        assert!(p.pos.iter().all(|v| v.is_finite()), "finite at tick {i}");
        assert!(
            p.pos[1] > -2.5 && p.pos[1] < 40.0,
            "stays inside the arena vertically at tick {i}: {:?}",
            p.pos
        );
        assert!(
            p.pos[0].abs() < 16.5 && p.pos[2].abs() < 16.5,
            "never escapes the walls at tick {i}: {:?}",
            p.pos
        );
    }
}

#[test]
fn camera_clearance_stops_at_walls() {
    use boxcore::physics::Phys;
    let mut store = ChunkStore::new();
    let offsets = Offsets::default();
    let paints = Paints::default();
    store.fill_box((5, -2, -5), (7, 8, 5), true); // a wall at x∈[5,7]
    let mut phys = Phys::new();
    for cp in store.chunks.keys() {
        phys.dirty.insert(*cp);
    }
    phys.sync(&store, &offsets, &paints);
    let d = phys.clearance([0.0, 2.0, 0.0], [1.0, 0.0, 0.0], 12.0, 0.4);
    assert!(d < 5.0 && d > 3.5, "camera stops before the wall: {}", d);
    let free = phys.clearance([0.0, 2.0, 0.0], [-1.0, 0.0, 0.0], 12.0, 0.4);
    assert!((free - 12.0).abs() < 1e-3, "free direction unobstructed: {}", free);
}

#[test]
fn paint_strokes_hygiene_and_undo() {
    use boxcore::wasm_api::World;
    let mut w = World::new();
    w.seed_voxel(); // cell (0,-1,0)

    // paint the top face; a stroke is one op
    w.paint_stroke_begin();
    assert!(w.paint_face(0, -1, 0, 2, 5, 6, 0, false, false));
    // painting a buried face is refused (no cell there to face into)
    assert!(!w.paint_face(5, 5, 5, 2, 5, 6, 0, false, false));
    w.paint_stroke_end();
    assert_eq!(w.paint_count(), 1);
    assert!(w.undo());
    assert_eq!(w.paint_count(), 0);
    assert!(w.redo());
    assert_eq!(w.paint_count(), 1);

    // extruding the painted top carries the paint to the new top
    assert!(w.extrude_rect(1, 1, 0, 0, 0, 0, 0, 1)); // adds (0,0,0)
    assert_eq!(w.get_paint(0, 0, 0, 2), vec![5, 6, 0, 0, 0], "extrusion inherits paint");
    // the old top face is now buried; its paint entry was cleaned
    assert_eq!(w.get_paint(0, -1, 0, 2), Vec::<i32>::new());

    // carving the new cell exposes the old top again, inheriting back down
    assert!(w.extrude_rect(1, 1, 1, 0, 0, 0, 0, -1)); // removes (0,0,0)
    assert_eq!(w.get_paint(0, -1, 0, 2), vec![5, 6, 0, 0, 0], "carve inherits paint");
    assert_eq!(w.paint_count(), 1);

    // undo the carve: paint moves back up with the cell
    assert!(w.undo());
    assert_eq!(w.get_paint(0, 0, 0, 2), vec![5, 6, 0, 0, 0]);
}

#[test]
fn wedged_player_can_always_jump() {
    use boxcore::physics::Player;
    let mut store = ChunkStore::new();
    let mut offsets = Offsets::default();
    // a 76° V-valley over a pit: two 4-high prows leaning apart, gap 1.0 at
    // the bottom widening to 3.0 at the top — the 1.8-wide capsule wedges
    // partway down with no walkable ground anywhere near
    store.fill_box((-5, -8, -4), (-1, 4, 4), true);
    store.fill_box((1, -8, -4), (5, 4, 4), true);
    for z in -4..=4 {
        offsets.set((-1, 0, z), Some([0.5, 0.0, 0.0]));
        offsets.set((-1, 4, z), Some([-0.5, 0.0, 0.0]));
        offsets.set((1, 0, z), Some([-0.5, 0.0, 0.0]));
        offsets.set((1, 4, z), Some([0.5, 0.0, 0.0]));
    }
    let phys = phys_for(&store, &offsets);
    let mut p = Player::new();
    p.pos = [0.0, 6.0, 0.0];
    p.vel = [0.0; 3];
    // drop in and settle
    for _ in 0..180 {
        p.update(&phys, 1.0 / 60.0, [0.0, 0.0], false);
    }
    let settled = p.pos[1];
    for _ in 0..30 {
        p.update(&phys, 1.0 / 60.0, [0.0, 0.0], false);
    }
    assert!(
        (p.pos[1] - settled).abs() < 0.05,
        "wedged stably: {} vs {}",
        p.pos[1],
        settled
    );
    assert!(p.pos[1] > 0.0, "held by the wedge, not the pit: y={}", p.pos[1]);
    // stability implies support: the jump must work even though no walkable
    // ground is in reach (this is the "stable but can't jump" regression)
    p.update(&phys, 1.0 / 60.0, [0.0, 0.0], true);
    let mut apex = settled;
    for _ in 0..30 {
        p.update(&phys, 1.0 / 60.0, [0.0, 0.0], false);
        apex = apex.max(p.pos[1]);
    }
    assert!(apex > settled + 1.5, "jumped out of the wedge: apex {apex} from {settled}");
}

#[test]
fn slab_op_builds_and_undoes() {
    use boxcore::wasm_api::World;
    let mut w = World::new();
    assert!(w.make_slab(5, 3, 2));
    assert_eq!(w.cell_count(), 30.0);
    assert!(w.get_cell(-2, -1, -1) && w.get_cell(2, -2, 1), "centered, top at y=0");
    assert!(!w.get_cell(0, 0, 0), "nothing above y=0");
    assert!(!w.get_cell(3, -1, 0), "x extent respected");
    w.undo();
    assert_eq!(w.cell_count(), 0.0);
}

// Regression: at fine timesteps the ramp base once became a limit cycle
// (ray snap penetrated the slope, depenetration pushed back, step-up
// never fired). Climbing must work at any frame rate.


fn climb_scenario(dt: f32) -> f32 {
    use boxcore::physics::{Phys, Player};
    let mut store = ChunkStore::new();
    let mut offsets = Offsets::default();
    let paints = Paints::default();
    store.fill_box((-10, -1, -10), (20, 0, 10), true);
    for i in 0..4 {
        store.fill_box((5 + i, 0, -2), (6 + i, 1 + i, 2), true);
    }
    for i in 0..4 {
        for z in -2..=2 {
            offsets.set((5 + i, 1 + i, z), Some([0.0, -0.5, 0.0]));
            offsets.set((6 + i, 1 + i, z), Some([0.0, 0.5, 0.0]));
        }
    }
    let mut phys = Phys::new();
    for cp in store.chunks.keys() {
        phys.dirty.insert(*cp);
    }
    phys.sync(&store, &offsets, &paints);
    let mut p = Player::new();
    p.spawn_at(&phys, 0.0, 0.0);
    let steps = |t: f32| (t / dt) as usize;
    for _ in 0..steps(1.0) { p.update(&phys, dt, [0.0, 0.0], false); }
    for _ in 0..steps(0.6) { p.update(&phys, dt, [1.0, 0.0], false); }
    for _ in 0..steps(0.4) { p.update(&phys, dt, [-1.0, 0.0], false); }
    for _ in 0..steps(0.3) { p.update(&phys, dt, [0.0, 0.0], false); }
    p.update(&phys, dt, [0.0, 0.0], true);
    for _ in 0..steps(1.0) { p.update(&phys, dt, [0.0, 0.0], false); }
    let mut peak = p.pos[1];
    for _ in 0..steps(1.8) {
        p.update(&phys, dt, [1.0, 0.0], false);
        peak = peak.max(p.pos[1]);
    }
    peak
}

#[test]
fn ramp_climb_is_timestep_independent() {
    for dt in [1.0 / 120.0, 1.0 / 60.0, 1.0 / 30.0, 0.05] {
        let peak = climb_scenario(dt);
        println!("dt={:.4} peak={:.3}", dt, peak);
        assert!(peak > 3.0, "climb works at dt={dt}: peak={peak}");
    }
}

#[test]
fn huge_slab_is_box_recorded_and_undoes_exactly() {
    use boxcore::wasm_api::World;
    let mut w = World::new();
    // sculpt a little hill first so the slab overlaps existing cells
    w.fill_box_raw(-3, -2, -3, 3, 4, 3, true);
    let before = w.cell_count();
    assert!(w.make_slab(200, 200, 40)); // 1.6M cells, box-recorded
    assert_eq!(w.cell_count(), 200.0 * 200.0 * 40.0 + 6.0 * 6.0 * 4.0); // + hill above y=0
    w.undo();
    assert_eq!(w.cell_count(), before, "undo restores the pre-slab world exactly");
    assert!(w.get_cell(0, 2, 0) && w.get_cell(-3, -1, -3), "hill intact");
    w.redo();
    assert!(w.get_cell(99, -40, 99) && !w.get_cell(100, -1, 0));
}

#[test]
fn camera_boom_glides_in_under_ceilings() {
    use boxcore::physics::Phys;
    let mut store = ChunkStore::new();
    let offsets = Offsets::default();
    let paints = Paints::default();
    store.fill_box((-30, -1, -10), (40, 0, 10), true); // floor
    store.fill_box((0, 6, -10), (40, 7, 10), true); // ceiling from x=0 onward
    let phys = phys_for(&store, &offsets);
    // camera boom points back-up at ~20°, player walks +x under the ceiling
    let pitch: f32 = 0.35;
    let dir = [-pitch.cos(), pitch.sin(), 0.0];
    let mut prev = f32::NAN;
    let mut max_step = 0.0f32;
    for i in 0..300 {
        let x = -10.0 + i as f32 * 0.1; // -10 → 20
        let [boom, los] = phys.camera_boom([x, 2.9, 0.0], dir, 16.0);
        assert!(boom <= los + 1e-3, "never exceeds line of sight");
        if prev.is_finite() {
            max_step = max_step.max((boom - prev).abs());
        }
        prev = boom;
    }
    let free = phys.camera_boom([-10.0, 2.9, 0.0], dir, 16.0)[0];
    assert!((free - 16.0).abs() < 1e-3, "open field boom = max: {free}");
    // deep under the ceiling: settled AT the thin line-of-sight distance
    // (not the hyper-conservative fat-sphere distance)
    let deep = phys.camera_boom([14.0, 2.9, 0.0], dir, 16.0);
    assert!(
        (deep[0] - deep[1]).abs() < 0.05 && deep[0] < 9.0,
        "settles at the under-ceiling LoS: boom={} los={}",
        deep[0],
        deep[1]
    );
    // and the walk from open field to settled is a glide, never a snap
    assert!(
        max_step < 0.5,
        "boom changes gradually while walking (max step {max_step})"
    );
}

#[test]
fn camera_boom_ignores_grazing_side_walls() {
    use boxcore::physics::Phys;
    let mut store = ChunkStore::new();
    let offsets = Offsets::default();
    let paints = Paints::default();
    store.fill_box((-30, -1, -10), (10, 0, 10), true); // floor
    store.fill_box((-30, 0, 1), (10, 24, 3), true); // tall wall 1.0 to the side
    let phys = phys_for(&store, &offsets);
    // boom runs parallel to the wall: the fat anticipation spheres OVERLAP
    // it from the start, but a sweep that doesn't deepen the overlap
    // reports nothing (stop_at_penetration=false) — hugging a wall while
    // the camera looks along it must not pull the boom in
    let pitch: f32 = 0.35;
    let dir = [-pitch.cos(), pitch.sin(), 0.0];
    let [boom, _] = phys.camera_boom([0.0, 2.9, 0.0], dir, 16.0);
    assert!((boom - 16.0).abs() < 1e-3, "parallel side wall ignored: {boom}");
}

#[test]
fn v5_serialization_scales_with_surface_not_volume() {
    use boxcore::wasm_api::World;
    let mut w = World::new();
    w.make_slab(320, 320, 96); // ~10M cells, mostly Full chunks
    w.set_shift_raw(0, 0, 0, 0.25, -0.5, 0.0);
    w.paint_stroke_begin();
    assert!(w.paint_face(0, -1, 0, 2, 3, 4, 1, true, false));
    w.paint_stroke_end();
    let json = w.to_json();
    assert!(
        json.len() < 400_000,
        "doc stays compact for a 10M-cell slab: {} bytes",
        json.len()
    );
    let mut w2 = World::new();
    assert!(w2.load_json(&json));
    assert_eq!(w2.cell_count(), w.cell_count());
    assert_eq!(w2.get_shift(0, 0, 0), vec![0.25, -0.5, 0.0]);
    assert_eq!(w2.get_paint(0, -1, 0, 2), vec![3, 4, 1, 1, 0]);
    // spot-check cells across chunk types (interior Full, boundary bitmap)
    assert!(w2.get_cell(0, -50, 0) && w2.get_cell(-160, -1, 159) && !w2.get_cell(160, -1, 0));
    let (_, odd) = boundary_stats_of(&w2);
    assert_eq!(odd, 0, "watertight after roundtrip");
}

fn boundary_stats_of(w: &boxcore::wasm_api::World) -> (usize, usize) {
    // stats() returns [faces, odd_edges] as f64
    let s = w.stats();
    (s[0] as usize, s[1] as usize)
}

/// The undersized-hole trap Peter found: an elevated hole 3.0 tall (the
/// player is 3.5) in a wall that leans toward the player, with the lintel
/// drooping toward the entrance. The old depenetration ratcheted the
/// capsule INTO the pinch (the deepest contact's push points inward) and
/// then cancelled every escape input. However the capsule ends up in a
/// pocket, holding "away" must walk it back out.
#[test]
fn player_escapes_undersized_slanted_hole() {
    use boxcore::physics::Player;
    let mut store = ChunkStore::new();
    let mut offsets = Offsets::default();
    store.fill_box((-10, -1, -10), (20, 0, 10), true); // floor
    store.fill_box((6, 0, -6), (9, 6, 6), true); // wall
    store.fill_box((6, 1, -1), (9, 4, 1), false); // hole: 3 tall, sill y=1
    for z in -1..=1 {
        offsets.set((6, 4, z), Some([0.0, -0.4, 0.0])); // lintel droops outward
    }
    for z in -6..=6 {
        offsets.set((6, 6, z), Some([-0.4, 0.0, 0.0])); // wall leans at player
    }
    let phys = phys_for(&store, &offsets);

    // scripted entry: charge the hole with a well-timed jump, then back out
    for jump_tick in [6, 10, 14, 18] {
        let mut p = Player::new();
        p.spawn_at(&phys, 2.0, 0.0);
        for _ in 0..60 {
            p.update(&phys, 1.0 / 60.0, [0.0, 0.0], false);
        }
        for i in 0..150 {
            let jump = i >= jump_tick && i < jump_tick + 4;
            p.update(&phys, 1.0 / 60.0, [1.0, 0.0], jump);
        }
        let mut escaped = false;
        for _ in 0..300 {
            p.update(&phys, 1.0 / 60.0, [-1.0, 0.0], false);
            assert!(p.pos.iter().all(|v| v.is_finite()));
            if p.pos[0] < 3.0 {
                escaped = true;
                break;
            }
        }
        assert!(escaped, "backed out after jump@{jump_tick}: {:?}", p.pos);
    }

    // worst case: the capsule is already deep in the pocket. It must rest
    // STABLY (no depenetration thrash) and walk out on demand.
    let mut p = Player::new();
    p.pos = [7.0, 1.01, 0.0];
    p.vel = [0.0; 3];
    let mut settled = [f32::NAN; 3];
    for t in 0..60 {
        p.update(&phys, 1.0 / 60.0, [0.0, 0.0], false);
        if t == 20 {
            settled = p.pos;
        }
    }
    let drift = (0..3).map(|i| (p.pos[i] - settled[i]).abs()).fold(0.0f32, f32::max);
    assert!(drift < 0.05, "rests stably in the pinch (drift {drift})");
    let mut escaped = false;
    for _ in 0..300 {
        p.update(&phys, 1.0 / 60.0, [-1.0, 0.0], false);
        assert!(p.pos.iter().all(|v| v.is_finite()));
        if p.pos[0] < 4.0 {
            escaped = true;
            break;
        }
    }
    assert!(escaped, "walked out of the pocket: {:?}", p.pos);
}
