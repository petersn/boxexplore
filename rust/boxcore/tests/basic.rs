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
