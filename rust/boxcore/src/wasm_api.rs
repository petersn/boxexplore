//! The wasm-bindgen facade: a single `World` object owning the document,
//! history, and in-flight drag/stroke state. The TypeScript shell calls
//! these methods and renders the returned buffers.

use crate::mesh::{self, ChunkMesh, MeshOpts};
use crate::ops::{self, BrushTool, DragState, EditOp, History, PaintStroke, RectSel, SelectionOp, Stroke};
use crate::physics::{Phys, Player};
use crate::store::{pack_paint, unpack_paint, ChunkStore, Offsets, Paints};
use crate::{unpack, IV};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize, Default)]
struct DocJson {
    #[serde(default)]
    cells: Vec<String>,
    #[serde(default)]
    shifts: BTreeMap<String, ShiftJson>,
    /// "x,y,z:d" -> [tx, ty, rot, flipH, flipV]
    #[serde(default)]
    paints: BTreeMap<String, [u32; 5]>,
}

#[derive(Serialize, Deserialize)]
struct ShiftJson {
    x: f32,
    y: f32,
    z: f32,
}

fn parse_triple(s: &str) -> Option<IV> {
    let mut it = s.split(',').map(|p| p.trim().parse::<i32>());
    match (it.next(), it.next(), it.next()) {
        (Some(Ok(x)), Some(Ok(y)), Some(Ok(z))) => Some((x, y, z)),
        _ => None,
    }
}

fn keys_from_triples(t: &[i32]) -> Vec<IV> {
    t.chunks_exact(3).map(|c| (c[0], c[1], c[2])).collect()
}

#[wasm_bindgen]
pub struct World {
    store: ChunkStore,
    offsets: Offsets,
    paints: Paints,
    history: History,
    drag: Option<DragState>,
    stroke: Option<Stroke>,
    paint_stroke: Option<PaintStroke>,
    rng: u64,
    last_mesh: ChunkMesh,
    tileset_grid: (u32, u32),
    phys: Phys,
    player: Player,
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl World {
    #[wasm_bindgen(constructor)]
    pub fn new() -> World {
        World {
            store: ChunkStore::new(),
            offsets: Offsets::default(),
            paints: Paints::default(),
            history: History::default(),
            drag: None,
            stroke: None,
            paint_stroke: None,
            rng: 0x9E3779B97F4A7C15,
            last_mesh: ChunkMesh::default(),
            tileset_grid: (8, 8),
            phys: Phys::new(),
            player: Player::new(),
        }
    }

    fn commit(&mut self, op: EditOp) -> bool {
        if op.is_empty() {
            return false;
        }
        self.history.push(op);
        true
    }

    // -- queries ---------------------------------------------------------------

    pub fn cell_count(&self) -> f64 {
        self.store.cell_count() as f64
    }

    pub fn shift_count(&self) -> u32 {
        self.offsets.len() as u32
    }

    pub fn get_cell(&self, x: i32, y: i32, z: i32) -> bool {
        self.store.get((x, y, z))
    }

    /// [] when absent, [x, y, z] when present.
    pub fn get_shift(&self, x: i32, y: i32, z: i32) -> Vec<f32> {
        match self.offsets.get_opt((x, y, z)) {
            None => vec![],
            Some(v) => v.to_vec(),
        }
    }

    /// Test/scripting hook (no history): set or clear one offset.
    pub fn set_shift_raw(&mut self, x: i32, y: i32, z: i32, sx: f32, sy: f32, sz: f32) {
        self.offsets.set((x, y, z), Some([sx, sy, sz]));
        self.store.mark_lattice_dirty((x, y, z));
    }

    pub fn clear_shift_raw(&mut self, x: i32, y: i32, z: i32) {
        self.offsets.set((x, y, z), None);
        self.store.mark_lattice_dirty((x, y, z));
    }

    pub fn surface_has_corner(&self, x: i32, y: i32, z: i32) -> bool {
        ops::on_surface(&self.store, (x, y, z))
    }

    pub fn corner_pos(&self, x: i32, y: i32, z: i32) -> Vec<f32> {
        ops::displaced(&self.offsets, (x, y, z)).to_vec()
    }

    /// [face_count, odd_edges] — watertightness diagnostics.
    pub fn stats(&self) -> Vec<f64> {
        let (faces, odd) = mesh::boundary_stats(&self.store);
        vec![faces as f64, odd as f64]
    }

    pub fn surface_corner_count(&self) -> u32 {
        ops::all_surface_corners(&self.store).len() as u32
    }

    /// Largest |component| over all offsets (test hook for the ±0.5 clamp).
    pub fn max_shift_abs(&self) -> f32 {
        let mut m = 0f32;
        for v in self.offsets.map.values() {
            m = m.max(v[0].abs()).max(v[1].abs()).max(v[2].abs());
        }
        m
    }

    /// Bulk fill (no history) — world generation and stress testing.
    pub fn fill_box_raw(&mut self, x0: i32, y0: i32, z0: i32, x1: i32, y1: i32, z1: i32, v: bool) {
        self.store.fill_box((x0, y0, z0), (x1, y1, z1), v);
    }

    // -- dirty tracking + meshing -----------------------------------------------

    pub fn take_dirty(&mut self) -> Vec<i32> {
        let mut out = Vec::with_capacity(self.store.dirty.len() * 3);
        for cp in self.store.dirty.drain() {
            out.extend_from_slice(&[cp.0, cp.1, cp.2]);
        }
        out
    }

    pub fn all_chunk_positions(&self) -> Vec<i32> {
        let mut out = Vec::with_capacity(self.store.chunks.len() * 3);
        for cp in self.store.chunks.keys() {
            out.extend_from_slice(&[cp.0, cp.1, cp.2]);
        }
        out
    }

    /// Mesh one chunk into an internal buffer; returns the face count.
    pub fn mesh_chunk(
        &mut self,
        cx: i32,
        cy: i32,
        cz: i32,
        sculpted: bool,
        tint: bool,
        paint: bool,
    ) -> u32 {
        self.last_mesh = mesh::mesh_chunk(
            &self.store,
            &self.offsets,
            &self.paints,
            (cx, cy, cz),
            &MeshOpts {
                sculpted,
                tint,
                paint,
                grid: self.tileset_grid,
            },
        );
        self.last_mesh.face_count() as u32
    }

    pub fn mesh_uvs(&self) -> Vec<f32> {
        self.last_mesh.uvs.clone()
    }

    pub fn mesh_unpainted_faces(&self) -> u32 {
        self.last_mesh.unpainted_faces as u32
    }

    pub fn set_tileset_grid(&mut self, cols: u32, rows: u32) {
        self.tileset_grid = (cols.max(1), rows.max(1));
    }

    pub fn mesh_chunk_lod(&mut self, cx: i32, cy: i32, cz: i32, level: u32) -> u32 {
        self.last_mesh = mesh::mesh_chunk_lod(&self.store, (cx, cy, cz), level.min(4));
        self.last_mesh.face_count() as u32
    }

    pub fn mesh_positions(&self) -> Vec<f32> {
        self.last_mesh.positions.clone()
    }

    pub fn mesh_colors(&self) -> Vec<f32> {
        self.last_mesh.colors.clone()
    }

    pub fn mesh_indices(&self) -> Vec<u32> {
        self.last_mesh.indices.clone()
    }

    pub fn mesh_face_keys(&self) -> Vec<i32> {
        self.last_mesh.face_keys.clone()
    }

    /// [12 floats] for an exposed face's quad, [] if the face isn't exposed.
    pub fn face_quad(&self, x: i32, y: i32, z: i32, d: u32, sculpted: bool) -> Vec<f32> {
        match mesh::face_quad(&self.store, &self.offsets, (x, y, z), d as usize, sculpted) {
            None => vec![],
            Some(q) => q.to_vec(),
        }
    }

    // -- build ops ----------------------------------------------------------------

    pub fn seed_voxel(&mut self) -> bool {
        let op = ops::seed_voxel(&mut self.store, &mut self.offsets, &mut self.paints);
        self.commit(op)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn extrude_rect(
        &mut self,
        axis: u32,
        sign: i32,
        plane: i32,
        a0: i32,
        a1: i32,
        b0: i32,
        b1: i32,
        dir: i32,
    ) -> bool {
        let sel = RectSel {
            axis: axis as usize,
            sign,
            plane,
            a0,
            a1,
            b0,
            b1,
        };
        let op = ops::extrude_rect(&mut self.store, &mut self.offsets, &mut self.paints, &sel, dir);
        self.commit(op)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reset_rect_offsets(
        &mut self,
        axis: u32,
        sign: i32,
        plane: i32,
        a0: i32,
        a1: i32,
        b0: i32,
        b1: i32,
    ) -> bool {
        let sel = RectSel {
            axis: axis as usize,
            sign,
            plane,
            a0,
            a1,
            b0,
            b1,
        };
        let op = ops::reset_rect_offsets(&self.store, &mut self.offsets, &sel);
        if op.is_empty() {
            return false;
        }
        ops::apply_op(&mut self.store, &mut self.offsets, &mut self.paints, &op, true);
        self.commit(op)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn rect_corners(
        &self,
        axis: u32,
        sign: i32,
        plane: i32,
        a0: i32,
        a1: i32,
        b0: i32,
        b1: i32,
    ) -> Vec<i32> {
        let sel = RectSel {
            axis: axis as usize,
            sign,
            plane,
            a0,
            a1,
            b0,
            b1,
        };
        let mut out = Vec::new();
        for l in ops::rect_lattice_corners(&self.store, &sel) {
            out.extend_from_slice(&[l.0, l.1, l.2]);
        }
        out
    }

    pub fn undo(&mut self) -> bool {
        self.history.undo(&mut self.store, &mut self.offsets, &mut self.paints)
    }

    pub fn redo(&mut self) -> bool {
        self.history.redo(&mut self.store, &mut self.offsets, &mut self.paints)
    }

    // -- sculpt ---------------------------------------------------------------------

    /// Interleaved [lat.x, lat.y, lat.z, pos.x, pos.y, pos.z] per visible corner.
    pub fn visible_corners(&self, ex: f32, ey: f32, ez: f32, max_dist: f32) -> Vec<f32> {
        let mut out = Vec::new();
        for (l, pos) in ops::visible_corners(&self.store, &self.offsets, [ex, ey, ez], max_dist) {
            out.extend_from_slice(&[l.0 as f32, l.1 as f32, l.2 as f32, pos[0], pos[1], pos[2]]);
        }
        out
    }

    pub fn corner_normal(&self, x: i32, y: i32, z: i32) -> Vec<f32> {
        ops::corner_normal(&self.store, &self.offsets, (x, y, z)).to_vec()
    }

    pub fn drag_begin(&mut self, keys: &[i32]) {
        self.drag = Some(ops::drag_begin(&self.offsets, &keys_from_triples(keys)));
    }

    pub fn drag_update(&mut self, dx: f32, dy: f32, dz: f32) {
        if let Some(drag) = &self.drag {
            ops::drag_update(&mut self.store, &mut self.offsets, drag, [dx, dy, dz]);
        }
    }

    pub fn drag_end(&mut self) -> bool {
        match self.drag.take() {
            None => false,
            Some(drag) => {
                let op = ops::drag_end(&self.offsets, drag);
                self.commit(op)
            }
        }
    }

    /// kind: 0 smooth · 1 inflate · 2 deflate · 3 noise · 4 reset · 5 nudge(d).
    pub fn selection_op(&mut self, keys: &[i32], kind: u32, dx: f32, dy: f32, dz: f32) -> bool {
        let k = match kind {
            0 => SelectionOp::Smooth,
            1 => SelectionOp::Inflate,
            2 => SelectionOp::Deflate,
            3 => SelectionOp::Noise,
            4 => SelectionOp::Reset,
            _ => SelectionOp::Nudge([dx, dy, dz]),
        };
        let op = ops::selection_op(
            &mut self.store,
            &mut self.offsets,
            &keys_from_triples(keys),
            &k,
            &mut self.rng,
        );
        self.commit(op)
    }

    /// tool: 0 smooth · 1 draw. A non-zero (dx,dy,dz) locks the Draw brush's
    /// push direction (the sculpt axis constraint).
    #[allow(clippy::too_many_arguments)]
    pub fn stroke_begin(
        &mut self,
        tool: u32,
        invert: bool,
        radius: f32,
        strength: f32,
        topo: bool,
        dx: f32,
        dy: f32,
        dz: f32,
    ) {
        let t = if tool == 0 {
            BrushTool::Smooth
        } else {
            BrushTool::Draw
        };
        let mut stroke = Stroke::new(t, invert, radius, strength, topo);
        if dx != 0.0 || dy != 0.0 || dz != 0.0 {
            stroke.dir_override = Some([dx, dy, dz]);
        }
        self.stroke = Some(stroke);
    }

    pub fn stroke_dab(&mut self, px: f32, py: f32, pz: f32) {
        if let Some(stroke) = &mut self.stroke {
            stroke.dab(&mut self.store, &mut self.offsets, [px, py, pz]);
        }
    }

    pub fn stroke_end(&mut self) -> bool {
        match self.stroke.take() {
            None => false,
            Some(stroke) => {
                let op = stroke.end(&mut self.store, &mut self.offsets, &mut self.paints);
                self.commit(op)
            }
        }
    }

    pub fn shortest_path(&self, x0: i32, y0: i32, z0: i32, x1: i32, y1: i32, z1: i32) -> Vec<i32> {
        let mut out = Vec::new();
        for l in ops::shortest_path(&self.store, &self.offsets, (x0, y0, z0), (x1, y1, z1)) {
            out.extend_from_slice(&[l.0, l.1, l.2]);
        }
        out
    }

    // -- painting -------------------------------------------------------------------

    pub fn paint_stroke_begin(&mut self) {
        self.paint_stroke = Some(PaintStroke::new());
    }

    /// Paint one face; returns false if the face isn't exposed.
    #[allow(clippy::too_many_arguments)]
    pub fn paint_face(
        &mut self,
        x: i32,
        y: i32,
        z: i32,
        d: u32,
        tx: u32,
        ty: u32,
        rot: u32,
        fh: bool,
        fv: bool,
    ) -> bool {
        match &mut self.paint_stroke {
            None => false,
            Some(stroke) => stroke.paint(
                &mut self.store,
                &mut self.paints,
                (x, y, z),
                d as usize,
                Some(pack_paint(tx, ty, rot, fh, fv)),
            ),
        }
    }

    pub fn erase_paint_face(&mut self, x: i32, y: i32, z: i32, d: u32) -> bool {
        match &mut self.paint_stroke {
            None => false,
            Some(stroke) => {
                stroke.paint(&mut self.store, &mut self.paints, (x, y, z), d as usize, None)
            }
        }
    }

    pub fn paint_stroke_end(&mut self) -> bool {
        match self.paint_stroke.take() {
            None => false,
            Some(stroke) => {
                let op = stroke.end(&self.paints);
                self.commit(op)
            }
        }
    }

    /// [tx, ty, rot, flipH, flipV] for a painted face, [] when unpainted.
    pub fn get_paint(&self, x: i32, y: i32, z: i32, d: u32) -> Vec<i32> {
        match self.paints.get(crate::pack((x, y, z)), d as u8) {
            None => vec![],
            Some(p) => {
                let (tx, ty, rot, fh, fv) = unpack_paint(p);
                vec![tx as i32, ty as i32, rot as i32, fh as i32, fv as i32]
            }
        }
    }

    pub fn paint_count(&self) -> u32 {
        self.paints.len() as u32
    }

    /// Exposed faces within `radius` of a point (4 ints per face: cell + dir),
    /// excluding faces opposite `hit_dir`.
    pub fn faces_in_radius(&self, px: f32, py: f32, pz: f32, radius: f32, hit_dir: u32) -> Vec<i32> {
        let mut out = Vec::new();
        for (cell, d) in ops::faces_in_radius(
            &self.store,
            &self.offsets,
            [px, py, pz],
            radius,
            hit_dir as usize,
        ) {
            out.extend_from_slice(&[cell.0, cell.1, cell.2, d as i32]);
        }
        out
    }

    // -- io ------------------------------------------------------------------------

    /// The doc as v4 JSON:
    /// {"cells": [...], "shifts": {...}, "paints": {"x,y,z:d": [tx,ty,rot,fh,fv]}}.
    pub fn to_json(&self) -> String {
        let mut doc = DocJson::default();
        self.store.for_each_cell(|c| {
            doc.cells.push(format!("{},{},{}", c.0, c.1, c.2));
        });
        for (k, v) in &self.offsets.map {
            let l = unpack(*k);
            doc.shifts.insert(
                format!("{},{},{}", l.0, l.1, l.2),
                ShiftJson {
                    x: v[0],
                    y: v[1],
                    z: v[2],
                },
            );
        }
        for ((ck, d), p) in &self.paints.map {
            let c = unpack(*ck);
            let (tx, ty, rot, fh, fv) = unpack_paint(*p);
            doc.paints.insert(
                format!("{},{},{}:{}", c.0, c.1, c.2, d),
                [tx, ty, rot, fh as u32, fv as u32],
            );
        }
        serde_json::to_string(&doc).unwrap_or_else(|_| "{}".into())
    }

    pub fn load_json(&mut self, json: &str) -> bool {
        let doc: DocJson = match serde_json::from_str(json) {
            Ok(d) => d,
            Err(_) => return false,
        };
        self.clear();
        for s in &doc.cells {
            if let Some(c) = parse_triple(s) {
                self.store.set(c, true);
            }
        }
        for (k, v) in &doc.shifts {
            if let Some(l) = parse_triple(k) {
                self.offsets.set(l, Some([v.x, v.y, v.z]));
                self.store.mark_lattice_dirty(l);
            }
        }
        for (k, v) in &doc.paints {
            let mut it = k.split(':');
            let (Some(cell_s), Some(d_s)) = (it.next(), it.next()) else {
                continue;
            };
            let (Some(cell), Ok(d)) = (parse_triple(cell_s), d_s.trim().parse::<u8>()) else {
                continue;
            };
            if d < 6 {
                self.paints
                    .set(crate::pack(cell), d, Some(pack_paint(v[0], v[1], v[2], v[3] != 0, v[4] != 0)));
            }
        }
        self.history.clear();
        true
    }

    pub fn clear(&mut self) {
        self.store.clear();
        self.offsets.map.clear();
        self.paints.map.clear();
        self.history.clear();
        self.drag = None;
        self.stroke = None;
        self.paint_stroke = None;
    }

    pub fn clear_history(&mut self) {
        self.history.clear();
    }

    // -- physics + play mode ---------------------------------------------------------

    /// Bring physics colliders up to date with the volume (lazy, incremental).
    fn phys_sync(&mut self) {
        if !self.store.dirty_phys.is_empty() {
            for cp in self.store.dirty_phys.drain() {
                self.phys.dirty.insert(cp);
            }
        }
        self.phys.sync(&self.store, &self.offsets, &self.paints);
    }

    /// Drop the player onto the ground near (x, z); returns [x, y, z].
    pub fn player_spawn(&mut self, x: f32, z: f32) -> Vec<f32> {
        self.phys_sync();
        self.player.spawn_at(&self.phys, x, z);
        self.player.pos.to_vec()
    }

    /// Step the character controller. `wish` is the camera-relative input
    /// direction. Returns [x, y, z, facing, onGround].
    pub fn player_update(&mut self, dt: f32, wish_x: f32, wish_z: f32, jump: bool) -> Vec<f32> {
        self.phys_sync();
        self.player
            .update(&self.phys, dt.clamp(0.0, 0.05), [wish_x, wish_z], jump);
        self.rescue_player_if_buried();
        vec![
            self.player.pos[0],
            self.player.pos[1],
            self.player.pos[2],
            self.player.facing,
            if self.player.on_ground { 1.0 } else { 0.0 },
        ]
    }

    /// Last-resort unstuck: mesh queries can't recover a player buried DEEP
    /// inside solid volume (a trimesh is hollow — far from any triangle,
    /// depenetration finds no contact). The voxel store is the ground truth,
    /// so when the body column reads solid, climb to the nearest air column.
    fn rescue_player_if_buried(&mut self) {
        use crate::physics::HEIGHT;
        let p = self.player.pos;
        let cx = p[0].floor() as i32;
        let cz = p[2].floor() as i32;
        let solid = |store: &ChunkStore, y: f32| store.get((cx, y.floor() as i32, cz));
        // offsets wobble the surface ±0.5, so demand the whole body column is
        // solid before declaring "buried" — never triggers in normal play
        // (a shallow `embedded` overlap is left to next tick's depenetration)
        let buried = solid(&self.store, p[1] + 0.5)
            && solid(&self.store, p[1] + HEIGHT * 0.5)
            && solid(&self.store, p[1] + HEIGHT - 0.5);
        if !buried {
            return;
        }
        let body_cells = HEIGHT.ceil() as i32 + 1;
        let mut y = p[1].floor() as i32;
        for _ in 0..256 {
            y += 1;
            if (0..body_cells).all(|k| !self.store.get((cx, y + k, cz))) {
                self.player.pos[1] = y as f32 + 0.01;
                self.player.vel = [0.0; 3];
                self.player.embedded = false;
                return;
            }
        }
    }

    /// How far the chase camera can pull back before hitting geometry.
    #[allow(clippy::too_many_arguments)]
    pub fn camera_clearance(
        &mut self,
        fx: f32,
        fy: f32,
        fz: f32,
        dx: f32,
        dy: f32,
        dz: f32,
        dist: f32,
        radius: f32,
    ) -> f32 {
        self.phys_sync();
        self.phys.clearance([fx, fy, fz], [dx, dy, dz], dist, radius)
    }

    /// Approximate document heap bytes (for the status/debug display).
    pub fn approx_bytes(&self) -> f64 {
        (self.store.approx_bytes() + self.offsets.map.capacity() * (8 + 12 + 8)) as f64
    }
}
