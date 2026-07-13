//! The wasm-bindgen facade: a single `World` object owning the document,
//! history, and in-flight drag/stroke state. The TypeScript shell calls
//! these methods and renders the returned buffers.

use crate::mesh::{self, ChunkMesh, MeshOpts};
use crate::ops::{self, BrushTool, DragState, EditOp, History, PaintStroke, RectSel, SelectionOp, Stroke};
use crate::physics::{Phys, Player};
use crate::plan::Plan;
use crate::store::{pack_paint, unpack_paint, ChunkStore, Offsets, Paints};
use crate::{unpack, IV};
use wasm_bindgen::prelude::*;

/// Binary doc (v6). Cells are stored per 32³ CHUNK — fully-solid chunks
/// as bare coordinates, partial chunks as run-length-encoded bitmaps — so
/// document size scales with the surface, never the volume. Layout (LE):
///   "BXD6"
///   u32 n_full,   n_full  × (i32 cx, cy, cz)
///   u32 n_bits,   n_bits  × (i32 cx, cy, cz; u16 n_runs; n_runs × (u16 len, u64 word))
///   u32 n_shifts, n_shifts × (i32 x, y, z; f32 sx, sy, sz)
///   u32 n_paints, n_paints × (i32 x, y, z; u8 dir; u32 packed)
const BIN_MAGIC: &[u8; 4] = b"BXD8";

struct Reader<'a> {
    d: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.d.get(self.at..self.at + n)?;
        self.at += n;
        Some(s)
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes(self.take(2)?.try_into().ok()?))
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn i32(&mut self) -> Option<i32> {
        Some(i32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn f32(&mut self) -> Option<f32> {
        Some(f32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn iv(&mut self) -> Option<IV> {
        Some((self.i32()?, self.i32()?, self.i32()?))
    }
}

fn put_iv(out: &mut Vec<u8>, c: IV) {
    out.extend_from_slice(&c.0.to_le_bytes());
    out.extend_from_slice(&c.1.to_le_bytes());
    out.extend_from_slice(&c.2.to_le_bytes());
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            break;
        }
        out.push(b | 0x80);
    }
}

impl<'a> Reader<'a> {
    fn varint(&mut self) -> Option<u64> {
        let mut v = 0u64;
        let mut shift = 0;
        loop {
            let b = *self.take(1)?.first()?;
            v |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                return Some(v);
            }
            shift += 7;
            if shift > 63 {
                return None;
            }
        }
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
    plan: Option<Plan>,
    #[cfg(target_arch = "wasm32")]
    gfx: Option<crate::gfx::Gfx>,
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
            plan: None,
            #[cfg(target_arch = "wasm32")]
            gfx: None,
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
        #[cfg(target_arch = "wasm32")]
        if let Some(g) = &mut self.gfx {
            g.tileset_grid = self.tileset_grid;
            g.invalidate_all();
            for cp in self.store.chunks.keys() {
                self.store.dirty.insert(*cp);
            }
        }
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

    /// sx × sz slab, `thickness` deep, centered in x/z, top at y = 0.
    pub fn make_slab(&mut self, sx: i32, sz: i32, thickness: i32) -> bool {
        let op = ops::make_slab(&mut self.store, &mut self.offsets, &mut self.paints, sx, sz, thickness);
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

    /// Serialize the whole document to the v6 binary format.
    pub fn to_bin(&self) -> Vec<u8> {
        use crate::store::Chunk;
        let mut full: Vec<IV> = Vec::new();
        let mut bits: Vec<(IV, &[u64])> = Vec::new();
        for (cp, chunk) in &self.store.chunks {
            match chunk {
                Chunk::Full => full.push(*cp),
                Chunk::Bits(b) => bits.push((*cp, &b[..])),
            }
        }
        full.sort();
        bits.sort_by_key(|(cp, _)| *cp);

        let mut out = Vec::new();
        out.extend_from_slice(BIN_MAGIC);
        out.extend_from_slice(&(full.len() as u32).to_le_bytes());
        for cp in &full {
            put_iv(&mut out, *cp);
        }
        out.extend_from_slice(&(bits.len() as u32).to_le_bytes());
        for (cp, words) in &bits {
            put_iv(&mut out, *cp);
            // RLE the 512 words: (u16 run length, u64 word)
            let mut runs: Vec<(u16, u64)> = Vec::new();
            for &w in *words {
                match runs.last_mut() {
                    Some((n, last)) if *last == w && *n < u16::MAX => *n += 1,
                    _ => runs.push((1, w)),
                }
            }
            out.extend_from_slice(&(runs.len() as u16).to_le_bytes());
            for (n, w) in runs {
                out.extend_from_slice(&n.to_le_bytes());
                out.extend_from_slice(&w.to_le_bytes());
            }
        }
        // Shifts: generated terrain sets MILLIONS of (mostly y-only)
        // offsets — encode sorted keys as varint deltas and store only the
        // nonzero components (a flags byte), ~7 bytes/entry instead of 24.
        out.extend_from_slice(&(self.offsets.map.len() as u32).to_le_bytes());
        let mut shifts: Vec<(u64, [f32; 3])> = self
            .offsets
            .map
            .iter()
            .map(|(k, v)| (*k as u64, *v))
            .collect();
        shifts.sort_by_key(|(k, _)| *k);
        let mut prev = 0u64;
        for (k, v) in shifts {
            put_varint(&mut out, k.wrapping_sub(prev));
            prev = k;
            let mut flags = 0u8;
            for (a, c) in v.iter().enumerate() {
                if *c != 0.0 {
                    flags |= 1 << a;
                }
            }
            out.push(flags);
            for (a, c) in v.iter().enumerate() {
                if flags & (1 << a) != 0 {
                    out.extend_from_slice(&c.to_le_bytes());
                }
            }
        }
        out.extend_from_slice(&(self.paints.map.len() as u32).to_le_bytes());
        let mut paints: Vec<_> = self.paints.map.iter().collect();
        paints.sort_by_key(|((k, d), _)| (*k, *d));
        for ((ck, d), p) in paints {
            put_iv(&mut out, unpack(*ck));
            out.push(*d);
            out.extend_from_slice(&p.to_le_bytes());
        }
        // plan section (w = h = 0 when absent)
        match &self.plan {
            None => out.extend_from_slice(&[0u8; 8]),
            Some(p) => p.to_bytes(&mut out),
        }
        out
    }

    /// Load a v6 binary document (replaces the current one entirely).
    pub fn load_bin(&mut self, data: &[u8]) -> bool {
        let mut r = Reader { d: data, at: 0 };
        if r.take(4) != Some(BIN_MAGIC) {
            return false;
        }
        // parse fully before touching the document, so a truncated file
        // can't leave a half-loaded world
        let Some(parsed) = (|| {
            let mut full = Vec::new();
            for _ in 0..r.u32()? {
                full.push(r.iv()?);
            }
            let mut bits = Vec::new();
            for _ in 0..r.u32()? {
                let cp = r.iv()?;
                let mut words: Vec<u64> = Vec::with_capacity(crate::store::WORDS);
                for _ in 0..r.u16()? {
                    let n = r.u16()? as usize;
                    let w = r.u64()?;
                    if n == 0 || words.len() + n > crate::store::WORDS {
                        return None;
                    }
                    words.extend(std::iter::repeat(w).take(n));
                }
                if words.len() != crate::store::WORDS {
                    return None;
                }
                bits.push((cp, words));
            }
            let mut shifts = Vec::new();
            let mut prev = 0u64;
            for _ in 0..r.u32()? {
                prev = prev.wrapping_add(r.varint()?);
                let flags = *r.take(1)?.first()?;
                let mut v = [0.0f32; 3];
                for (a, c) in v.iter_mut().enumerate() {
                    if flags & (1 << a) != 0 {
                        *c = r.f32()?;
                    }
                }
                shifts.push((unpack(prev as i64), v));
            }
            let mut paints = Vec::new();
            for _ in 0..r.u32()? {
                let c = r.iv()?;
                let d = *r.take(1)?.first()?;
                let p = r.u32()?;
                if d >= 6 {
                    return None;
                }
                paints.push((c, d, p));
            }
            let pw = r.u32()?;
            let ph = r.u32()?;
            let plan = if pw > 0 && ph > 0 {
                let n = (pw as usize).checked_mul(ph as usize)?;
                let bytes = r.take(n * 8 + n.div_ceil(8))?;
                Some(Plan::from_bytes(pw, ph, bytes)?)
            } else {
                None
            };
            Some((full, bits, shifts, paints, plan))
        })() else {
            return false;
        };

        self.clear();
        let (full, bits, shifts, paints, plan) = parsed;
        self.plan = plan;
        for cp in full {
            self.store.insert_chunk_raw(cp, crate::store::Chunk::Full);
        }
        for (cp, words) in bits {
            let mut b = Box::new([0u64; crate::store::WORDS]);
            b.copy_from_slice(&words);
            self.store.insert_chunk_raw(cp, crate::store::Chunk::Bits(b));
        }
        for (l, v) in shifts {
            self.offsets.set(l, Some(v));
            self.store.mark_lattice_dirty(l);
        }
        for (c, d, p) in paints {
            self.paints.set(crate::pack(c), d, Some(p));
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

    /// First face hit by a ray, exact against the rendered quads.
    /// [] on miss, else [cellx, celly, cellz, dir, px, py, pz, t].
    #[allow(clippy::too_many_arguments)]
    pub fn pick(
        &self,
        ox: f32,
        oy: f32,
        oz: f32,
        dx: f32,
        dy: f32,
        dz: f32,
        max_dist: f32,
        sculpted: bool,
    ) -> Vec<f32> {
        match ops::pick(&self.store, &self.offsets, [ox, oy, oz], [dx, dy, dz], max_dist, sculpted)
        {
            None => vec![],
            Some((c, d, p, t)) => vec![
                c.0 as f32, c.1 as f32, c.2 as f32, d as f32, p[0], p[1], p[2], t,
            ],
        }
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

    /// Stateless chase-camera boom (cone cast over sphere radii; see
    /// `Phys::camera_boom` and docs/camera.md). Returns [boom, los].
    #[allow(clippy::too_many_arguments)]
    pub fn camera_boom(
        &mut self,
        fx: f32,
        fy: f32,
        fz: f32,
        dx: f32,
        dy: f32,
        dz: f32,
        dist: f32,
    ) -> Vec<f32> {
        self.phys_sync();
        self.phys.camera_boom([fx, fy, fz], [dx, dy, dz], dist).to_vec()
    }

    // -- world planning (height-map pair + mask; see plan.rs) -------------------------

    pub fn plan_init(&mut self, w: u32, h: u32) {
        let w = w.clamp(8, 4096) as usize;
        let h = h.clamp(8, 4096) as usize;
        self.plan = Some(Plan::new(w, h));
    }

    /// [w, h, scale]; zeros when no plan exists.
    pub fn plan_dims(&self) -> Vec<u32> {
        match &self.plan {
            None => vec![0, 0, crate::plan::PLAN_SCALE as u32],
            Some(p) => vec![p.w as u32, p.h as u32, crate::plan::PLAN_SCALE as u32],
        }
    }

    pub fn plan_stroke_begin(&mut self) {
        if let Some(p) = &mut self.plan {
            p.stroke_begin();
        }
    }

    pub fn plan_stroke_end(&mut self) {
        if let Some(p) = &mut self.plan {
            p.stroke_end();
        }
    }

    pub fn plan_undo(&mut self) -> bool {
        self.plan.as_mut().is_some_and(|p| p.undo_op())
    }

    pub fn plan_redo(&mut self) -> bool {
        self.plan.as_mut().is_some_and(|p| p.redo_op())
    }

    pub fn plan_brush(&mut self, cx: f32, cy: f32, radius: f32, delta: f32, layer: u32) {
        if let Some(p) = &mut self.plan {
            p.brush(cx, cy, radius, delta, layer);
        }
    }

    pub fn plan_smooth(&mut self, cx: f32, cy: f32, radius: f32, strength: f32, layer: u32) {
        if let Some(p) = &mut self.plan {
            p.smooth(cx, cy, radius, strength, layer);
        }
    }

    pub fn plan_mask_brush(&mut self, cx: f32, cy: f32, radius: f32, value: bool) {
        if let Some(p) = &mut self.plan {
            p.mask_brush(cx, cy, radius, value);
        }
    }

    /// One RGBA pixel per plan cell (contour bands, coast, void checker).
    pub fn plan_rgba(&self, layer: u32) -> Vec<u8> {
        match &self.plan {
            None => vec![],
            Some(p) => p.rgba(layer),
        }
    }

    /// [top, bottom, mask] at a plan cell (for the status readout).
    pub fn plan_sample(&self, x: u32, y: u32) -> Vec<f32> {
        match &self.plan {
            Some(p) if (x as usize) < p.w && (y as usize) < p.h => {
                let i = y as usize * p.w + x as usize;
                vec![p.top[i], p.bottom[i], if p.mask[i] { 1.0 } else { 0.0 }]
            }
            _ => vec![],
        }
    }

    /// Replace the world's volume with the plan's geometry (like Slab, but
    /// shaped). Clears the document first; history is reset.
    pub fn plan_generate(&mut self) -> bool {
        let Some(plan) = self.plan.take() else {
            return false;
        };
        self.store.clear();
        self.offsets.map.clear();
        self.paints.map.clear();
        plan.generate(&mut self.store, &mut self.offsets);
        self.plan = Some(plan);
        self.history.clear();
        true
    }

    /// Approximate document heap bytes (for the status/debug display).
    pub fn approx_bytes(&self) -> f64 {
        (self.store.approx_bytes() + self.offsets.map.capacity() * (8 + 12 + 8)) as f64
    }
}

/// Async wgpu setup result, handed to `World::gfx_attach` (wasm_bindgen
/// cannot await inside a &mut self method).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct GfxInit {
    inner: Option<crate::gfx::Gfx>,
}

/// Create the renderer for a canvas (async: adapter + device negotiation).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn gfx_create(
    canvas: web_sys::HtmlCanvasElement,
    width: u32,
    height: u32,
) -> Result<GfxInit, JsValue> {
    let gfx = crate::gfx::Gfx::new(canvas, width, height)
        .await
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(GfxInit { inner: Some(gfx) })
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl World {
    pub fn gfx_attach(&mut self, mut init: GfxInit) {
        self.gfx = init.inner.take();
        if let Some(g) = &mut self.gfx {
            g.tileset_grid = self.tileset_grid;
        }
        // everything is dirty on first attach
        for cp in self.store.chunks.keys() {
            self.store.dirty.insert(*cp);
        }
    }

    pub fn gfx_ready(&self) -> bool {
        self.gfx.is_some()
    }

    pub fn gfx_resize(&mut self, w: u32, h: u32) {
        if let Some(g) = &mut self.gfx {
            g.resize(w, h);
        }
    }

    /// Render one frame (also drains document dirt into remesh work).
    #[allow(clippy::too_many_arguments)]
    pub fn gfx_frame(
        &mut self,
        ex: f32,
        ey: f32,
        ez: f32,
        fx: f32,
        fy: f32,
        fz: f32,
        fov_y: f32,
        near: f32,
        far: f32,
    ) {
        let Some(g) = &mut self.gfx else { return };
        g.frame(
            &mut self.store,
            &self.offsets,
            &self.paints,
            &crate::gfx::CameraParams {
                eye: [ex, ey, ez],
                forward: [fx, fy, fz],
                fov_y,
                near,
                far,
            },
        );
    }

    pub fn gfx_set_view(&mut self, sculpted: bool, tint: bool, paint: bool) {
        if let Some(g) = &mut self.gfx {
            g.view = crate::gfx::ViewOpts { sculpted, tint, paint };
            g.invalidate_all();
            for cp in self.store.chunks.keys() {
                self.store.dirty.insert(*cp);
            }
        }
    }

    pub fn gfx_set_lod_scale(&mut self, k: f32) {
        if let Some(g) = &mut self.gfx {
            g.lod_scale = k.clamp(0.1, 8.0);
        }
    }

    pub fn gfx_set_tileset(&mut self, w: u32, h: u32, rgba: &[u8]) {
        if let Some(g) = &mut self.gfx {
            g.set_tileset(w, h, rgba);
        }
    }

    /// Overlay slots: 0 ghost, 1 selection fill, 2 selection lines,
    /// 3 constraint lines, 4 brush ring, 5 axes, 6 stamp ghost, 7 player.
    #[allow(clippy::too_many_arguments)]
    pub fn gfx_overlay_quads(
        &mut self,
        which: usize,
        quads: &[f32],
        uvs: &[f32],
        r: f32,
        gr: f32,
        b: f32,
        a: f32,
    ) {
        if let Some(g) = &mut self.gfx {
            g.set_overlay_quads(which, quads, uvs, [r, gr, b, a]);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn gfx_overlay_lines(
        &mut self,
        which: usize,
        points: &[f32],
        r: f32,
        gr: f32,
        b: f32,
        a: f32,
    ) {
        if let Some(g) = &mut self.gfx {
            g.set_overlay_lines(which, points, [r, gr, b, a]);
        }
    }

    pub fn gfx_overlay_lines_colored(&mut self, which: usize, data: &[f32]) {
        if let Some(g) = &mut self.gfx {
            g.set_overlay_lines_colored(which, data);
        }
    }

    /// Player body triangles (pos3 + rgba4 per vertex); empty hides it.
    pub fn gfx_set_player(&mut self, data: &[f32]) {
        if let Some(g) = &mut self.gfx {
            g.set_player(data);
        }
    }

    /// Corner handles (pos3, pixel size, rgba4 per instance); empty hides.
    pub fn gfx_set_handles(&mut self, data: &[f32]) {
        if let Some(g) = &mut self.gfx {
            g.set_handles(data);
        }
    }

    /// Planning mode: draw only the plan preview (plus axes).
    pub fn gfx_plan_mode(&mut self, on: bool) {
        if let Some(g) = &mut self.gfx {
            g.plan_mode = on;
        }
    }

    /// Rebuild the 3D disc-world preview from the plan (step = decimation).
    pub fn gfx_plan_preview(&mut self, step: u32) {
        let (Some(g), Some(p)) = (&mut self.gfx, &self.plan) else {
            return;
        };
        let m = p.preview_mesh(step.max(1) as usize);
        g.set_plan_mesh(&m);
    }

    /// [chunks, regions, paintedFaces, pendingRebuilds, drawCalls, lod0..lod4]
    pub fn gfx_stats(&self) -> Vec<u32> {
        match &self.gfx {
            None => vec![0; 10],
            Some(g) => {
                let l = g.lod_counts();
                vec![
                    g.chunk_count(),
                    g.region_count(),
                    g.painted_face_count(),
                    g.pending(),
                    g.last_draw_calls,
                    l[0],
                    l[1],
                    l[2],
                    l[3],
                    l[4],
                ]
            }
        }
    }
}
