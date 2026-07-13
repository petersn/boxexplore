//! Editor operations, ported behavior-for-behavior from the TypeScript
//! editor: rect extrude/carve with offset extrapolation + hygiene, seed
//! voxel, corner drags, selection operators, spatial sculpt brushes with
//! optional topology changes (voxel flips with offset rebasing), shortest
//! path selection, visibility, and diff-based undo/redo.

use crate::store::{clamp_shift, cpos_of, ChunkStore, Offsets, Paints};
use crate::{
    add_iv, axis_of, pack, plane_axes, quad_normal, unpack, v3_add, v3_len, v3_norm,
    v3_scale, v3_sub, IV, V3, CORNERS, DIRS,
};
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BinaryHeap;

// ---------------------------------------------------------------------------
// Edit ops + history
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct EditOp {
    pub added: Vec<i64>,
    pub removed: Vec<i64>,
    pub shifts: Vec<(i64, Option<V3>, Option<V3>)>, // key, before, after
    pub paints: Vec<((i64, u8), Option<u32>, Option<u32>)>, // (cell, dir), before, after
}

impl EditOp {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty()
            && self.removed.is_empty()
            && self.shifts.is_empty()
            && self.paints.is_empty()
    }
}

pub fn apply_op(
    store: &mut ChunkStore,
    offsets: &mut Offsets,
    paints: &mut Paints,
    op: &EditOp,
    forward: bool,
) {
    if forward {
        for k in &op.removed {
            store.set(unpack(*k), false);
        }
        for k in &op.added {
            store.set(unpack(*k), true);
        }
        for (k, _, after) in &op.shifts {
            offsets.set(unpack(*k), *after);
            store.mark_lattice_dirty(unpack(*k));
        }
        for ((ck, d), _, after) in &op.paints {
            paints.set(*ck, *d, *after);
            store.dirty.insert(cpos_of(unpack(*ck)));
        }
    } else {
        for k in &op.added {
            store.set(unpack(*k), false);
        }
        for k in &op.removed {
            store.set(unpack(*k), true);
        }
        for (k, before, _) in &op.shifts {
            offsets.set(unpack(*k), *before);
            store.mark_lattice_dirty(unpack(*k));
        }
        for ((ck, d), before, _) in &op.paints {
            paints.set(*ck, *d, *before);
            store.dirty.insert(cpos_of(unpack(*ck)));
        }
    }
}

#[derive(Default)]
pub struct History {
    undo: Vec<EditOp>,
    redo: Vec<EditOp>,
}

const LIMIT: usize = 200;

impl History {
    pub fn push(&mut self, op: EditOp) {
        if op.is_empty() {
            return;
        }
        self.undo.push(op);
        if self.undo.len() > LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub fn undo(&mut self, store: &mut ChunkStore, offsets: &mut Offsets, paints: &mut Paints) -> bool {
        match self.undo.pop() {
            None => false,
            Some(op) => {
                apply_op(store, offsets, paints, &op, false);
                self.redo.push(op);
                true
            }
        }
    }

    pub fn redo(&mut self, store: &mut ChunkStore, offsets: &mut Offsets, paints: &mut Paints) -> bool {
        match self.redo.pop() {
            None => false,
            Some(op) => {
                apply_op(store, offsets, paints, &op, true);
                self.undo.push(op);
                true
            }
        }
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
}

// ---------------------------------------------------------------------------
// Surface queries
// ---------------------------------------------------------------------------

/// A lattice point is on the surface iff its 8 incident cells are mixed
/// (some solid, some empty) — equivalent to being a corner of an exposed face.
pub fn on_surface(store: &ChunkStore, l: IV) -> bool {
    let mut any_solid = false;
    let mut any_empty = false;
    for dz in -1..=0 {
        for dy in -1..=0 {
            for dx in -1..=0 {
                if store.get((l.0 + dx, l.1 + dy, l.2 + dz)) {
                    any_solid = true;
                } else {
                    any_empty = true;
                }
            }
        }
    }
    any_solid && any_empty
}

/// Exposed faces touching a lattice corner, as (cell, dir) pairs.
pub fn faces_at_corner(store: &ChunkStore, l: IV) -> Vec<(IV, usize)> {
    let mut out = Vec::new();
    for dz in -1..=0 {
        for dy in -1..=0 {
            for dx in -1..=0 {
                let cell = (l.0 + dx, l.1 + dy, l.2 + dz);
                if !store.get(cell) {
                    continue;
                }
                // the 3 faces of this cell that touch the corner
                for axis in 0..3usize {
                    let coord = axis_of(cell, axis);
                    let lcoord = axis_of(l, axis);
                    let d = axis * 2 + if lcoord == coord + 1 { 0 } else { 1 };
                    if !store.get(add_iv(cell, DIRS[d])) {
                        out.push((cell, d));
                    }
                }
            }
        }
    }
    out
}

pub fn displaced(offsets: &Offsets, l: IV) -> V3 {
    let o = offsets.get(l);
    [l.0 as f32 + o[0], l.1 as f32 + o[1], l.2 as f32 + o[2]]
}

fn face_verts(offsets: &Offsets, cell: IV, d: usize) -> [V3; 4] {
    let mut v = [[0f32; 3]; 4];
    for k in 0..4 {
        let c = CORNERS[d][k];
        v[k] = displaced(offsets, (cell.0 + c.0, cell.1 + c.1, cell.2 + c.2));
    }
    v
}

/// Averaged displaced surface normal at a corner (world up as a last resort).
pub fn corner_normal(store: &ChunkStore, offsets: &Offsets, l: IV) -> V3 {
    let faces = faces_at_corner(store, l);
    if faces.is_empty() {
        return [0.0, 1.0, 0.0];
    }
    let mut n = [0f32; 3];
    for (cell, d) in faces {
        n = v3_add(n, quad_normal(&face_verts(offsets, cell, d)));
    }
    if v3_len(n) > 1e-9 {
        v3_norm(n)
    } else {
        [0.0, 1.0, 0.0]
    }
}

/// Edge-adjacent surface corners (along exposed quad edges), matching the
/// original editor's lattice adjacency exactly.
pub fn corner_neighbors(store: &ChunkStore, l: IV) -> Vec<IV> {
    let mut out: Vec<IV> = Vec::new();
    for (cell, d) in faces_at_corner(store, l) {
        let mut idx = usize::MAX;
        let mut corners = [(0i32, 0i32, 0i32); 4];
        for k in 0..4 {
            let c = CORNERS[d][k];
            corners[k] = (cell.0 + c.0, cell.1 + c.1, cell.2 + c.2);
            if corners[k] == l {
                idx = k;
            }
        }
        if idx == usize::MAX {
            continue;
        }
        for nb in [corners[(idx + 1) % 4], corners[(idx + 3) % 4]] {
            if !out.contains(&nb) {
                out.push(nb);
            }
        }
    }
    out
}

/// Exposed faces whose (displaced) center lies within `radius` of a point,
/// excluding faces opposite the hit direction (a paint brush shouldn't bleed
/// through onto back sides).
pub fn faces_in_radius(
    store: &ChunkStore,
    offsets: &Offsets,
    p: V3,
    radius: f32,
    hit_dir: usize,
) -> Vec<(IV, usize)> {
    let r = radius + 1.6;
    let lo = (
        (p[0] - r).floor() as i32,
        (p[1] - r).floor() as i32,
        (p[2] - r).floor() as i32,
    );
    let hi = (
        (p[0] + r).ceil() as i32,
        (p[1] + r).ceil() as i32,
        (p[2] + r).ceil() as i32,
    );
    let opposite = hit_dir ^ 1;
    let mut out = Vec::new();
    for x in lo.0..=hi.0 {
        for y in lo.1..=hi.1 {
            for z in lo.2..=hi.2 {
                let cell = (x, y, z);
                if !store.get(cell) {
                    continue;
                }
                for (d, dir) in DIRS.iter().enumerate() {
                    if d == opposite || store.get(add_iv(cell, *dir)) {
                        continue;
                    }
                    let v = face_verts(offsets, cell, d);
                    let c = [
                        (v[0][0] + v[1][0] + v[2][0] + v[3][0]) * 0.25,
                        (v[0][1] + v[1][1] + v[2][1] + v[3][1]) * 0.25,
                        (v[0][2] + v[1][2] + v[2][2] + v[3][2]) * 0.25,
                    ];
                    if v3_len(v3_sub(c, p)) <= radius {
                        out.push((cell, d));
                    }
                }
            }
        }
    }
    out
}

/// All surface lattice corners within `radius` of a world point.
pub fn surface_corners_in_radius(store: &ChunkStore, offsets: &Offsets, p: V3, radius: f32) -> Vec<IV> {
    let r = radius + 0.75; // offsets can move a corner up to ~0.87 away
    let lo = (
        (p[0] - r).floor() as i32,
        (p[1] - r).floor() as i32,
        (p[2] - r).floor() as i32,
    );
    let hi = (
        (p[0] + r).ceil() as i32,
        (p[1] + r).ceil() as i32,
        (p[2] + r).ceil() as i32,
    );
    let mut out = Vec::new();
    for x in lo.0..=hi.0 {
        for y in lo.1..=hi.1 {
            for z in lo.2..=hi.2 {
                let l = (x, y, z);
                if !on_surface(store, l) {
                    continue;
                }
                let d = v3_sub(displaced(offsets, l), p);
                if v3_len(d) <= radius {
                    out.push(l);
                }
            }
        }
    }
    out
}

/// Every surface lattice corner (O(surface); enumerated per chunk).
pub fn all_surface_corners(store: &ChunkStore) -> Vec<IV> {
    let mut seen: FxHashSet<i64> = FxHashSet::default();
    let mut out = Vec::new();
    let chunk_positions: Vec<IV> = store.chunks.keys().copied().collect();
    for cp in chunk_positions {
        let base = (cp.0 * crate::store::S, cp.1 * crate::store::S, cp.2 * crate::store::S);
        let mut hood = crate::store::Neighborhood::new(store, cp);
        for z in 0..crate::store::S {
            for y in 0..crate::store::S {
                for x in 0..crate::store::S {
                    let cell = (base.0 + x, base.1 + y, base.2 + z);
                    if !hood.get(cell) {
                        continue;
                    }
                    for (d, dir) in DIRS.iter().enumerate() {
                        if hood.get(add_iv(cell, *dir)) {
                            continue;
                        }
                        for c in CORNERS[d] {
                            let l = (cell.0 + c.0, cell.1 + c.1, cell.2 + c.2);
                            if seen.insert(pack(l)) {
                                out.push(l);
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Visibility (voxel DDA — depth-buffer-exact visibility comes with wgpu)
// ---------------------------------------------------------------------------

/// Whether the straight segment from `from` to `to` passes through a solid
/// cell, stopping just short of the endpoint.
pub fn segment_blocked(store: &ChunkStore, from: V3, to: V3) -> bool {
    let d = v3_sub(to, from);
    let seg_len = v3_len(d);
    if seg_len < 1e-6 {
        return false;
    }
    let t_stop = 1.0 - (0.06 / seg_len).min(0.5);

    let mut x = from[0].floor() as i32;
    let mut y = from[1].floor() as i32;
    let mut z = from[2].floor() as i32;
    let step = [
        if d[0] > 0.0 { 1 } else { -1 },
        if d[1] > 0.0 { 1 } else { -1 },
        if d[2] > 0.0 { 1 } else { -1 },
    ];
    let inf = f32::INFINITY;
    let t_delta = [
        if d[0] != 0.0 { 1.0 / d[0].abs() } else { inf },
        if d[1] != 0.0 { 1.0 / d[1].abs() } else { inf },
        if d[2] != 0.0 { 1.0 / d[2].abs() } else { inf },
    ];
    let mut t_max = [
        if d[0] != 0.0 {
            (if step[0] > 0 { x as f32 + 1.0 - from[0] } else { from[0] - x as f32 }) / d[0].abs()
        } else {
            inf
        },
        if d[1] != 0.0 {
            (if step[1] > 0 { y as f32 + 1.0 - from[1] } else { from[1] - y as f32 }) / d[1].abs()
        } else {
            inf
        },
        if d[2] != 0.0 {
            (if step[2] > 0 { z as f32 + 1.0 - from[2] } else { from[2] - z as f32 }) / d[2].abs()
        } else {
            inf
        },
    ];
    for _ in 0..1024 {
        let t_enter = t_max[0].min(t_max[1]).min(t_max[2]);
        if t_enter >= t_stop {
            return false;
        }
        if t_max[0] <= t_max[1] && t_max[0] <= t_max[2] {
            x += step[0];
            t_max[0] += t_delta[0];
        } else if t_max[1] <= t_max[2] {
            y += step[1];
            t_max[1] += t_delta[1];
        } else {
            z += step[2];
            t_max[2] += t_delta[2];
        }
        if store.get((x, y, z)) {
            return true;
        }
    }
    false
}

/// Corners the camera can actually see: at least one adjacent face turned
/// toward the eye, plus a clear voxel line of sight to a probe just off the
/// surface (two probe distances so concave junctions survive grazing rays).
/// Corners beyond `max_dist` are skipped before any expensive work.
pub fn visible_corners(store: &ChunkStore, offsets: &Offsets, eye: V3, max_dist: f32) -> Vec<(IV, V3)> {
    let mut out = Vec::new();
    for l in all_surface_corners(store) {
        let pos = displaced(offsets, l);
        if v3_len(v3_sub(pos, eye)) > max_dist {
            continue;
        }
        let faces = faces_at_corner(store, l);
        if faces.is_empty() {
            continue;
        }
        let facing = faces.iter().any(|(_, d)| {
            let n = DIRS[*d];
            n.0 as f32 * (eye[0] - pos[0])
                + n.1 as f32 * (eye[1] - pos[1])
                + n.2 as f32 * (eye[2] - pos[2])
                > 1e-6
        });
        if !facing {
            continue;
        }
        let mut n = [0f32; 3];
        for (cell, d) in &faces {
            n = v3_add(n, quad_normal(&face_verts(offsets, *cell, *d)));
        }
        let n = if v3_len(n) > 1e-9 { v3_norm(n) } else { [0.0, 1.0, 0.0] };
        let near = v3_add(pos, v3_scale(n, 0.08));
        let far = v3_add(pos, v3_scale(n, 0.4));
        if !segment_blocked(store, eye, near) || !segment_blocked(store, eye, far) {
            out.push((l, pos));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Offset hygiene (local, equivalent to the old global sweep)
// ---------------------------------------------------------------------------

/// Whether a face is exposed (its cell solid, the neighbor across it empty).
fn face_exposed(store: &ChunkStore, cell: IV, d: usize) -> bool {
    store.get(cell) && !store.get(add_iv(cell, DIRS[d]))
}

pub type ShiftChanges = Vec<(i64, Option<V3>, Option<V3>)>;
pub type PaintChanges = Vec<((i64, u8), Option<u32>, Option<u32>)>;

/// Plan offset AND paint changes for a cell edit. Offsets: corners leaving the
/// surface get cleared; corners joining it copy the offset from `source_delta`
/// away when that corner was on the old surface (extrusion carries ramps),
/// and are cleared otherwise. Paints get the per-face analog: entries whose
/// face stops being exposed are cleared (globally), and faces that become
/// exposed copy the paint from the source face `source_delta` back (extruding
/// a painted wall yields more painted wall; carving into painted ground keeps
/// the paint on the new floor). Call BEFORE applying the cell changes.
pub fn plan_edit_changes(
    store: &mut ChunkStore,
    offsets: &Offsets,
    paints: &Paints,
    added: &[IV],
    removed: &[IV],
    source_delta: Option<IV>,
) -> (ShiftChanges, PaintChanges) {
    // affected corners = corners of every changed cell
    let mut affected: FxHashSet<i64> = FxHashSet::default();
    for cell in added.iter().chain(removed.iter()) {
        for dx in 0..=1 {
            for dy in 0..=1 {
                for dz in 0..=1 {
                    affected.insert(pack((cell.0 + dx, cell.1 + dy, cell.2 + dz)));
                }
            }
        }
    }
    // membership before
    let mut was_on: FxHashMap<i64, bool> = FxHashMap::default();
    for k in &affected {
        was_on.insert(*k, on_surface(store, unpack(*k)));
    }
    let added_set: FxHashSet<i64> = added.iter().map(|c| pack(*c)).collect();
    let removed_set: FxHashSet<i64> = removed.iter().map(|c| pack(*c)).collect();
    // tentatively apply, evaluate membership after, then revert
    for c in removed {
        store.set(*c, false);
    }
    for c in added {
        store.set(*c, true);
    }
    let mut changes: Vec<(i64, Option<V3>, Option<V3>)> = Vec::new();
    // global stale sweep (matches the original editor): any offset that is not
    // on the post-edit surface gets cleared, wherever it is
    for (k, v) in &offsets.map {
        if affected.contains(k) {
            continue; // handled below with extrapolation rules
        }
        if !on_surface(store, unpack(*k)) {
            changes.push((*k, Some(*v), None));
        }
    }
    for k in &affected {
        let l = unpack(*k);
        let now_on = on_surface(store, l);
        let before = offsets.get_opt(l);
        if !now_on {
            if before.is_some() {
                changes.push((*k, before, None));
            }
            continue;
        }
        if was_on[k] {
            continue; // already-visible corners keep their offsets
        }
        // newly exposed: extrapolate from the source ring, or clear stale
        let mut after: Option<V3> = None;
        if let Some(sd) = source_delta {
            let src = (l.0 + sd.0, l.1 + sd.1, l.2 + sd.2);
            // note: membership of src is evaluated on the OLD volume
            if before_on_old(store, &added_set, &removed_set, src) {
                if let Some(sv) = offsets.get_opt(src) {
                    after = Some(sv);
                }
            }
        }
        let same = match (&before, &after) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9 && (a[2] - b[2]).abs() < 1e-9
            }
            _ => false,
        };
        if !same {
            changes.push((*k, before, after));
        }
    }
    // paints, planned in the same tentative (post-edit) window
    let mut paint_changes: PaintChanges = Vec::new();
    // global sweep: clear paints whose face is no longer exposed
    for ((ck, d), v) in &paints.map {
        if !face_exposed(store, unpack(*ck), *d as usize) {
            paint_changes.push(((*ck, *d), Some(*v), None));
        }
    }
    if let Some(sd) = source_delta {
        // candidate faces = faces of changed cells and their neighbors
        let mut candidates: FxHashSet<i64> = FxHashSet::default();
        for cell in added.iter().chain(removed.iter()) {
            candidates.insert(pack(*cell));
            for dir in DIRS {
                candidates.insert(pack(add_iv(*cell, dir)));
            }
        }
        let solid_before = |cell: IV| -> bool {
            let k = pack(cell);
            if added_set.contains(&k) {
                return false;
            }
            if removed_set.contains(&k) {
                return true;
            }
            store.get(cell)
        };
        for ck in candidates {
            let cell = unpack(ck);
            if !store.get(cell) {
                continue;
            }
            for d in 0..6usize {
                let now_exposed = face_exposed(store, cell, d);
                let was_exposed = solid_before(cell) && !solid_before(add_iv(cell, DIRS[d]));
                if !now_exposed || was_exposed {
                    continue;
                }
                let src_cell = (cell.0 + sd.0, cell.1 + sd.1, cell.2 + sd.2);
                let src_was_exposed =
                    solid_before(src_cell) && !solid_before(add_iv(src_cell, DIRS[d]));
                if !src_was_exposed {
                    continue;
                }
                if let Some(p) = paints.get(pack(src_cell), d as u8) {
                    let before = paints.get(ck, d as u8);
                    if before != Some(p) {
                        paint_changes.push(((ck, d as u8), before, Some(p)));
                    }
                }
            }
        }
    }
    // revert the tentative cell changes
    for c in added {
        store.set(*c, false);
    }
    for c in removed {
        store.set(*c, true);
    }
    (changes, paint_changes)
}

/// `on_surface` as it was before the pending edit (store currently holds the
/// tentative post-edit state inside plan_shift_changes).
fn before_on_old(
    store: &ChunkStore,
    added: &FxHashSet<i64>,
    removed: &FxHashSet<i64>,
    l: IV,
) -> bool {
    let mut any_solid = false;
    let mut any_empty = false;
    for dz in -1..=0 {
        for dy in -1..=0 {
            for dx in -1..=0 {
                let cell = (l.0 + dx, l.1 + dy, l.2 + dz);
                let k = pack(cell);
                let mut solid = store.get(cell);
                if added.contains(&k) {
                    solid = false; // was empty before the edit
                }
                if removed.contains(&k) {
                    solid = true; // was solid before the edit
                }
                if solid {
                    any_solid = true;
                } else {
                    any_empty = true;
                }
            }
        }
    }
    any_solid && any_empty
}

// ---------------------------------------------------------------------------
// Build-mode ops
// ---------------------------------------------------------------------------

pub struct RectSel {
    pub axis: usize,
    pub sign: i32,
    pub plane: i32,
    pub a0: i32,
    pub a1: i32,
    pub b0: i32,
    pub b1: i32,
}

fn cell_at_layer(sel: &RectSel, a: i32, b: i32, layer: i32) -> IV {
    let (x1, x2) = plane_axes(sel.axis);
    let mut c = [0i32; 3];
    c[sel.axis] = layer;
    c[x1] = a;
    c[x2] = b;
    (c[0], c[1], c[2])
}

/// One layer of extrusion (`dir=1`) or carving (`dir=-1`), with the exact
/// semantics of the editor: extrude grows only faces present at the plane,
/// carve removes the whole footprint. Returns the committed op (empty = no-op).
pub fn extrude_rect(
    store: &mut ChunkStore,
    offsets: &mut Offsets,
    paints: &mut Paints,
    sel: &RectSel,
    dir: i32,
) -> EditOp {
    let (lo0, hi0) = (sel.a0.min(sel.a1), sel.a0.max(sel.a1));
    let (lo1, hi1) = (sel.b0.min(sel.b1), sel.b0.max(sel.b1));
    let out = dir > 0;
    let out_layer = sel.plane + if sel.sign > 0 { 0 } else { -1 };
    let in_layer = sel.plane + if sel.sign > 0 { -1 } else { 0 };
    let mut changed: Vec<IV> = Vec::new();
    for b in lo1..=hi1 {
        for a in lo0..=hi0 {
            if out {
                let solid = store.get(cell_at_layer(sel, a, b, in_layer));
                let out_cell = cell_at_layer(sel, a, b, out_layer);
                if solid && !store.get(out_cell) {
                    changed.push(out_cell);
                }
            } else {
                let in_cell = cell_at_layer(sel, a, b, in_layer);
                if store.get(in_cell) {
                    changed.push(in_cell);
                }
            }
        }
    }
    if changed.is_empty() {
        return EditOp::default();
    }
    let mut sd = [0i32; 3];
    sd[sel.axis] = if out { -sel.sign } else { sel.sign };
    let (added, removed): (Vec<IV>, Vec<IV>) = if out {
        (changed.clone(), Vec::new())
    } else {
        (Vec::new(), changed.clone())
    };
    let (shifts, paint_changes) = plan_edit_changes(
        store,
        offsets,
        paints,
        &added,
        &removed,
        Some((sd[0], sd[1], sd[2])),
    );
    let op = EditOp {
        added: added.iter().map(|c| pack(*c)).collect(),
        removed: removed.iter().map(|c| pack(*c)).collect(),
        shifts,
        paints: paint_changes,
    };
    apply_op(store, offsets, paints, &op, true);
    op
}

/// Clear the offsets of the corners of the faces present in the rect.
pub fn reset_rect_offsets(store: &ChunkStore, offsets: &mut Offsets, sel: &RectSel) -> EditOp {
    let (lo0, hi0) = (sel.a0.min(sel.a1), sel.a0.max(sel.a1));
    let (lo1, hi1) = (sel.b0.min(sel.b1), sel.b0.max(sel.b1));
    let d = sel.axis * 2 + if sel.sign > 0 { 0 } else { 1 };
    let in_layer = sel.plane + if sel.sign > 0 { -1 } else { 0 };
    let mut op = EditOp::default();
    let mut seen: FxHashSet<i64> = FxHashSet::default();
    for b in lo1..=hi1 {
        for a in lo0..=hi0 {
            let cell = cell_at_layer(sel, a, b, in_layer);
            if !store.get(cell) || store.get(add_iv(cell, DIRS[d])) {
                continue;
            }
            for c in CORNERS[d] {
                let l = (cell.0 + c.0, cell.1 + c.1, cell.2 + c.2);
                if !seen.insert(pack(l)) {
                    continue;
                }
                if let Some(was) = offsets.get_opt(l) {
                    op.shifts.push((pack(l), Some(was), None));
                }
            }
        }
    }
    op
}

/// Lattice corners of the faces present in a rect (for build→sculpt handoff).
pub fn rect_lattice_corners(store: &ChunkStore, sel: &RectSel) -> Vec<IV> {
    let (lo0, hi0) = (sel.a0.min(sel.a1), sel.a0.max(sel.a1));
    let (lo1, hi1) = (sel.b0.min(sel.b1), sel.b0.max(sel.b1));
    let d = sel.axis * 2 + if sel.sign > 0 { 0 } else { 1 };
    let in_layer = sel.plane + if sel.sign > 0 { -1 } else { 0 };
    let mut seen: FxHashSet<i64> = FxHashSet::default();
    let mut out = Vec::new();
    for b in lo1..=hi1 {
        for a in lo0..=hi0 {
            let cell = cell_at_layer(sel, a, b, in_layer);
            if !store.get(cell) || store.get(add_iv(cell, DIRS[d])) {
                continue;
            }
            for c in CORNERS[d] {
                let l = (cell.0 + c.0, cell.1 + c.1, cell.2 + c.2);
                if seen.insert(pack(l)) {
                    out.push(l);
                }
            }
        }
    }
    out
}

/// Seed a voxel near the origin, stacking upward if occupied.
pub fn seed_voxel(store: &mut ChunkStore, offsets: &mut Offsets, paints: &mut Paints) -> EditOp {
    let mut y = -1;
    while store.get((0, y, 0)) && y < 64 {
        y += 1;
    }
    let cell = (0, y, 0);
    let (shifts, paint_changes) = plan_edit_changes(store, offsets, paints, &[cell], &[], None);
    let op = EditOp {
        added: vec![pack(cell)],
        removed: vec![],
        shifts,
        paints: paint_changes,
    };
    apply_op(store, offsets, paints, &op, true);
    op
}

// ---------------------------------------------------------------------------
// Sculpt: drags, selection operators, spatial brushes
// ---------------------------------------------------------------------------

/// Live drag of a set of corners: `before` offsets are captured at begin,
/// every update writes `before + delta` (clamped by the store).
pub struct DragState {
    pub before: Vec<(IV, Option<V3>)>,
}

pub fn drag_begin(offsets: &Offsets, keys: &[IV]) -> DragState {
    DragState {
        before: keys.iter().map(|l| (*l, offsets.get_opt(*l))).collect(),
    }
}

pub fn drag_update(store: &mut ChunkStore, offsets: &mut Offsets, drag: &DragState, delta: V3) {
    for (l, before) in &drag.before {
        let base = before.unwrap_or([0.0; 3]);
        offsets.set(*l, Some(v3_add(base, delta)));
        store.mark_lattice_dirty(*l);
    }
}

pub fn drag_end(offsets: &Offsets, drag: DragState) -> EditOp {
    let mut op = EditOp::default();
    for (l, before) in drag.before {
        let now = offsets.get_opt(l);
        let same = match (&before, &now) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9 && (a[2] - b[2]).abs() < 1e-9
            }
            _ => false,
        };
        if !same {
            op.shifts.push((pack(l), before, now));
        }
    }
    op
}

pub enum SelectionOp {
    Smooth,
    Inflate,
    Deflate,
    Noise,
    Reset,
    Nudge(V3),
}

/// Apply a selection operator to a set of corners; returns the committed op.
pub fn selection_op(
    store: &mut ChunkStore,
    offsets: &mut Offsets,
    keys: &[IV],
    kind: &SelectionOp,
    rng: &mut u64,
) -> EditOp {
    let mut op = EditOp::default();
    // compute all targets first (Jacobi-style, like the original)
    let mut targets: Vec<(IV, Option<V3>)> = Vec::with_capacity(keys.len());
    for l in keys {
        let cur = offsets.get_opt(*l);
        let cur_v = cur.unwrap_or([0.0; 3]);
        let raw: Option<V3> = match kind {
            SelectionOp::Reset => None,
            SelectionOp::Nudge(delta) => Some(v3_add(cur_v, *delta)),
            SelectionOp::Inflate => Some(v3_add(
                cur_v,
                v3_scale(corner_normal(store, offsets, *l), 0.25),
            )),
            SelectionOp::Deflate => Some(v3_add(
                cur_v,
                v3_scale(corner_normal(store, offsets, *l), -0.25),
            )),
            SelectionOp::Noise => {
                let r = |rng: &mut u64| {
                    *rng ^= *rng << 13;
                    *rng ^= *rng >> 7;
                    *rng ^= *rng << 17;
                    ((*rng >> 11) as f64 / (1u64 << 53) as f64) as f32 - 0.5
                };
                Some(v3_add(cur_v, [r(rng) * 0.3, r(rng) * 0.3, r(rng) * 0.3]))
            }
            SelectionOp::Smooth => {
                let ns = corner_neighbors(store, *l);
                if ns.is_empty() {
                    cur
                } else {
                    let mut avg = [0f32; 3];
                    for n in &ns {
                        avg = v3_add(avg, displaced(offsets, *n));
                    }
                    avg = v3_scale(avg, 1.0 / ns.len() as f32);
                    let target = v3_add(
                        v3_scale(displaced(offsets, *l), 0.5),
                        v3_scale(avg, 0.5),
                    );
                    Some(v3_sub(target, [l.0 as f32, l.1 as f32, l.2 as f32]))
                }
            }
        };
        targets.push((*l, raw));
    }
    for (l, raw) in targets {
        let before = offsets.get_opt(l);
        let after = raw.map(clamp_shift).and_then(|c| {
            if c[0].abs() < 1e-9 && c[1].abs() < 1e-9 && c[2].abs() < 1e-9 {
                None
            } else {
                Some(c)
            }
        });
        let same = match (&before, &after) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9 && (a[2] - b[2]).abs() < 1e-9
            }
            _ => false,
        };
        if !same {
            offsets.set(l, after);
            store.mark_lattice_dirty(l);
            op.shifts.push((pack(l), before, after));
        }
    }
    op
}

#[derive(Clone, Copy, PartialEq)]
pub enum BrushTool {
    Smooth,
    Draw,
}

/// A spatial brush stroke: accumulates first-touch snapshots and voxel flips,
/// committing everything as one op at the end.
pub struct Stroke {
    pub tool: BrushTool,
    pub invert: bool,
    pub radius: f32,
    pub strength: f32,
    pub topo: bool,
    /// When set (sculpt axis constraint), the Draw brush pushes along this
    /// direction instead of each corner's surface normal.
    pub dir_override: Option<V3>,
    shifts_before: FxHashMap<i64, Option<V3>>,
    cells_added: FxHashSet<i64>,
    cells_removed: FxHashSet<i64>,
}

impl Stroke {
    pub fn new(tool: BrushTool, invert: bool, radius: f32, strength: f32, topo: bool) -> Self {
        Self {
            tool,
            invert,
            radius,
            strength,
            topo,
            dir_override: None,
            shifts_before: FxHashMap::default(),
            cells_added: FxHashSet::default(),
            cells_removed: FxHashSet::default(),
        }
    }

    /// One brush application centered on a surface point.
    pub fn dab(&mut self, store: &mut ChunkStore, offsets: &mut Offsets, point: V3) {
        let corners = surface_corners_in_radius(store, offsets, point, self.radius);
        if corners.is_empty() {
            return;
        }
        // desired (unclamped) offsets for every corner in range
        let mut desired: Vec<(IV, V3)> = Vec::with_capacity(corners.len());
        for l in &corners {
            let pos = displaced(offsets, *l);
            let dist = v3_len(v3_sub(pos, point));
            let t = dist / self.radius;
            let w = self.strength * (1.0 - t * t) * (1.0 - t * t);
            let target = match self.tool {
                BrushTool::Smooth => {
                    let ns = corner_neighbors(store, *l);
                    if ns.is_empty() {
                        continue;
                    }
                    let mut avg = [0f32; 3];
                    for n in &ns {
                        avg = v3_add(avg, displaced(offsets, *n));
                    }
                    avg = v3_scale(avg, 1.0 / ns.len() as f32);
                    v3_add(pos, v3_scale(v3_sub(avg, pos), (w * 0.7).min(1.0)))
                }
                BrushTool::Draw => {
                    let n = self
                        .dir_override
                        .unwrap_or_else(|| corner_normal(store, offsets, *l));
                    let s = if self.invert { -1.0 } else { 1.0 };
                    v3_add(pos, v3_scale(n, s * w * 0.22))
                }
            };
            desired.push((*l, v3_sub(target, [l.0 as f32, l.1 as f32, l.2 as f32])));
        }
        if desired.is_empty() {
            return;
        }

        // topology: flip voxels where the surface wants to move past the ±½
        // clamp, rebasing offsets onto the new ring for continuity
        if self.topo {
            let mut add_cells: Vec<IV> = Vec::new();
            let mut remove_cells: Vec<IV> = Vec::new();
            let mut rebases: Vec<(IV, V3)> = Vec::new();
            for (l, off) in &desired {
                for (cell, d) in faces_at_corner(store, *l) {
                    let axis = d >> 1;
                    let sign = if d % 2 == 0 { 1.0 } else { -1.0 };
                    let o = off[axis] * sign;
                    let dirv = DIRS[d];
                    if o > 0.55 {
                        let nk = add_iv(cell, dirv);
                        if !store.get(nk) && !add_cells.contains(&nk) {
                            add_cells.push(nk);
                            for c in CORNERS[d] {
                                let corner = (cell.0 + c.0, cell.1 + c.1, cell.2 + c.2);
                                if let Some((_, want)) = desired.iter().find(|(dl, _)| *dl == corner) {
                                    rebases.push((
                                        add_iv(corner, dirv),
                                        [
                                            want[0] - dirv.0 as f32,
                                            want[1] - dirv.1 as f32,
                                            want[2] - dirv.2 as f32,
                                        ],
                                    ));
                                }
                            }
                        }
                    } else if o < -0.55 && !remove_cells.contains(&cell) {
                        remove_cells.push(cell);
                        for c in CORNERS[d] {
                            let corner = (cell.0 + c.0, cell.1 + c.1, cell.2 + c.2);
                            if let Some((_, want)) = desired.iter().find(|(dl, _)| *dl == corner) {
                                rebases.push((
                                    (corner.0 - dirv.0, corner.1 - dirv.1, corner.2 - dirv.2),
                                    [
                                        want[0] + dirv.0 as f32,
                                        want[1] + dirv.1 as f32,
                                        want[2] + dirv.2 as f32,
                                    ],
                                ));
                            }
                        }
                    }
                }
            }
            if !add_cells.is_empty() || !remove_cells.is_empty() {
                for c in &add_cells {
                    let k = pack(*c);
                    if !self.cells_removed.remove(&k) {
                        self.cells_added.insert(k);
                    }
                    store.set(*c, true);
                }
                for c in &remove_cells {
                    let k = pack(*c);
                    if !self.cells_added.remove(&k) {
                        self.cells_removed.insert(k);
                    }
                    store.set(*c, false);
                }
                for (l, v) in rebases {
                    if let Some(slot) = desired.iter_mut().find(|(dl, _)| *dl == l) {
                        slot.1 = v;
                    } else {
                        desired.push((l, v));
                    }
                }
            }
        }

        for (l, off) in desired {
            if !on_surface(store, l) {
                continue; // flipped off the surface
            }
            self.shifts_before
                .entry(pack(l))
                .or_insert_with(|| offsets.get_opt(l));
            offsets.set(l, Some(off)); // clamps
            store.mark_lattice_dirty(l);
        }
    }

    /// Finish the stroke: clean stranded offsets and orphaned paints, produce
    /// the single op.
    pub fn end(mut self, store: &mut ChunkStore, offsets: &mut Offsets, paints: &mut Paints) -> EditOp {
        let stranded: Vec<IV> = offsets
            .keys()
            .filter(|l| !on_surface(store, *l))
            .collect();
        for l in stranded {
            self.shifts_before
                .entry(pack(l))
                .or_insert_with(|| offsets.get_opt(l));
            offsets.set(l, None);
            store.mark_lattice_dirty(l);
        }
        let mut op = EditOp {
            added: self.cells_added.iter().copied().collect(),
            removed: self.cells_removed.iter().copied().collect(),
            shifts: Vec::new(),
            paints: Vec::new(),
        };
        // topology flips can orphan paints — clear them, recorded in the op
        // (new faces grown by brushing start unpainted; paint them afterward)
        let orphaned: Vec<((i64, u8), u32)> = paints
            .map
            .iter()
            .filter(|((ck, d), _)| !face_exposed(store, unpack(*ck), *d as usize))
            .map(|(k, v)| (*k, *v))
            .collect();
        for ((ck, d), v) in orphaned {
            paints.set(ck, d, None);
            store.dirty.insert(cpos_of(unpack(ck)));
            op.paints.push(((ck, d), Some(v), None));
        }
        for (k, before) in self.shifts_before {
            let now = offsets.get_opt(unpack(k));
            let same = match (&before, &now) {
                (None, None) => true,
                (Some(a), Some(b)) => {
                    (a[0] - b[0]).abs() < 1e-9
                        && (a[1] - b[1]).abs() < 1e-9
                        && (a[2] - b[2]).abs() < 1e-9
                }
                _ => false,
            };
            if !same {
                op.shifts.push((k, before, now));
            }
        }
        op
    }
}

// ---------------------------------------------------------------------------
// Paint strokes (per-face tile assignment)
// ---------------------------------------------------------------------------

/// A paint-mode stroke: paints/erases faces live, records first-touch
/// snapshots, and commits everything as one op at the end.
#[derive(Default)]
pub struct PaintStroke {
    before: FxHashMap<(i64, u8), Option<u32>>,
}

impl PaintStroke {
    pub fn new() -> Self {
        Self::default()
    }

    /// Paint one face (no-op if the face isn't exposed). Returns success.
    pub fn paint(
        &mut self,
        store: &mut ChunkStore,
        paints: &mut Paints,
        cell: IV,
        d: usize,
        value: Option<u32>,
    ) -> bool {
        if !face_exposed(store, cell, d) {
            return false;
        }
        let ck = pack(cell);
        self.before
            .entry((ck, d as u8))
            .or_insert_with(|| paints.get(ck, d as u8));
        paints.set(ck, d as u8, value);
        store.dirty.insert(cpos_of(cell));
        true
    }

    pub fn end(self, paints: &Paints) -> EditOp {
        let mut op = EditOp::default();
        for (key, before) in self.before {
            let now = paints.get(key.0, key.1);
            if before != now {
                op.paints.push((key, before, now));
            }
        }
        op
    }
}

// ---------------------------------------------------------------------------
// Shortest path (Dijkstra over surface quad edges, displaced edge lengths)
// ---------------------------------------------------------------------------

pub fn shortest_path(store: &ChunkStore, offsets: &Offsets, from: IV, to: IV) -> Vec<IV> {
    #[derive(PartialEq)]
    struct Entry(f32, i64);
    impl Eq for Entry {}
    impl PartialOrd for Entry {
        fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp(other))
        }
    }
    impl Ord for Entry {
        fn cmp(&self, other: &Self) -> std::cmp::Ordering {
            // min-heap by distance
            other.0.partial_cmp(&self.0).unwrap_or(std::cmp::Ordering::Equal)
        }
    }

    let fk = pack(from);
    let tk = pack(to);
    let mut dist: FxHashMap<i64, f32> = FxHashMap::default();
    let mut prev: FxHashMap<i64, i64> = FxHashMap::default();
    let mut heap = BinaryHeap::new();
    dist.insert(fk, 0.0);
    heap.push(Entry(0.0, fk));
    let mut found = false;
    while let Some(Entry(d, k)) = heap.pop() {
        if k == tk {
            found = true;
            break;
        }
        if d > dist.get(&k).copied().unwrap_or(f32::INFINITY) {
            continue;
        }
        let l = unpack(k);
        for nb in corner_neighbors(store, l) {
            let nk = pack(nb);
            let w = v3_len(v3_sub(displaced(offsets, nb), displaced(offsets, l)));
            let alt = d + w;
            if alt < dist.get(&nk).copied().unwrap_or(f32::INFINITY) {
                dist.insert(nk, alt);
                prev.insert(nk, k);
                heap.push(Entry(alt, nk));
            }
        }
        // safety bound for pathological cases
        if dist.len() > 200_000 {
            break;
        }
    }
    if !found {
        return Vec::new();
    }
    let mut path = vec![to];
    let mut cur = tk;
    while cur != fk {
        match prev.get(&cur) {
            None => break,
            Some(p) => {
                cur = *p;
                path.push(unpack(cur));
            }
        }
    }
    path
}
