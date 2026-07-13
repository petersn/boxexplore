//! Per-chunk surface extraction and meshing, a faithful port of the JS
//! mesher: flat lambert shading from a fixed light, Minecraft-style corner
//! AO with the AO-aware diagonal flip, optional displacement (sculpted view)
//! and displacement-magnitude tinting (untextured view).

use crate::store::{unpack_paint, Chunk, ChunkStore, Neighborhood, Offsets, Paints, S};
use crate::{add_iv, pack, plane_axes, quad_normal, IV, V3, CORNERS, DIRS};
use rustc_hash::FxHashMap;

const LIGHT: V3 = [0.372, 0.904, 0.213];
const VOL_BASE: V3 = [0.78, 0.80, 0.85];
const AO_CURVE: [f32; 4] = [0.55, 0.72, 0.86, 1.0];
const SHIFT_TINT: V3 = [1.0, 0.5, 0.12];

#[derive(Default)]
pub struct ChunkMesh {
    pub positions: Vec<f32>,
    pub colors: Vec<f32>,
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
    /// Per-face key: cellx, celly, cellz, dir (parallel to faces, 4 ints each).
    pub face_keys: Vec<i32>,
    /// Faces [0, unpainted_faces) are flat-shaded; the rest sample the tileset.
    pub unpainted_faces: usize,
}

impl ChunkMesh {
    pub fn face_count(&self) -> usize {
        self.face_keys.len() / 4
    }

    /// Append `other`'s faces after this mesh's (rebasing indices).
    fn append(&mut self, other: ChunkMesh) {
        let vbase = (self.positions.len() / 3) as u32;
        self.positions.extend_from_slice(&other.positions);
        self.colors.extend_from_slice(&other.colors);
        self.uvs.extend_from_slice(&other.uvs);
        self.indices.extend(other.indices.iter().map(|i| i + vbase));
        self.face_keys.extend_from_slice(&other.face_keys);
    }
}

pub struct MeshOpts {
    /// Apply lattice displacements (false = raw voxel debug view).
    pub sculpted: bool,
    /// Tint displaced corners orange (the "untextured" view).
    pub tint: bool,
    /// Emit tile UVs for painted faces (the "textured" view).
    pub paint: bool,
    /// Tileset grid (columns, rows) for UV computation.
    pub grid: (u32, u32),
}

const P: i32 = S + 2; // padded side (1-cell apron for neighbors + AO)

#[inline]
fn pidx(x: i32, y: i32, z: i32) -> usize {
    ((x + 1) + (y + 1) * P + (z + 1) * P * P) as usize
}

/// Mesh one chunk. Empty chunks yield an empty mesh (callers drop the mesh).
/// Faces are emitted unpainted-first, painted-after, so the renderer can draw
/// them as two material groups (flat shading vs. tileset texture).
pub fn mesh_chunk(
    store: &ChunkStore,
    offsets: &Offsets,
    paints: &Paints,
    cp: IV,
    opts: &MeshOpts,
) -> ChunkMesh {
    let mut out = ChunkMesh::default();
    let chunk = match store.chunks.get(&cp) {
        None => return out,
        Some(c) => c,
    };
    // fast skip: a Full chunk with Full face-neighbors has no faces at all
    if matches!(chunk, Chunk::Full) {
        let buried = DIRS.iter().all(|d| {
            matches!(
                store.chunks.get(&(cp.0 + d.0, cp.1 + d.1, cp.2 + d.2)),
                Some(Chunk::Full)
            )
        });
        if buried {
            return out;
        }
    }

    let base = (cp.0 * S, cp.1 * S, cp.2 * S);
    // padded occupancy (34³) — center from the chunk, apron via neighbors
    let mut occ = vec![0u8; (P * P * P) as usize];
    match chunk {
        Chunk::Full => {
            for z in 0..S {
                for y in 0..S {
                    let row = pidx(0, y, z);
                    occ[row..row + S as usize].fill(1);
                }
            }
        }
        Chunk::Bits(b) => {
            for li in 0..(S * S * S) as usize {
                if (b[li >> 6] >> (li & 63)) & 1 != 0 {
                    let x = (li as i32) & 31;
                    let y = ((li as i32) >> 5) & 31;
                    let z = (li as i32) >> 10;
                    occ[pidx(x, y, z)] = 1;
                }
            }
        }
    }
    let mut hood = Neighborhood::new(store, cp);
    for z in -1..=S {
        for y in -1..=S {
            for x in -1..=S {
                let inside = (0..S).contains(&x) && (0..S).contains(&y) && (0..S).contains(&z);
                if inside {
                    continue;
                }
                if hood.get((base.0 + x, base.1 + y, base.2 + z)) {
                    occ[pidx(x, y, z)] = 1;
                }
            }
        }
    }

    let use_offsets = opts.sculpted && !offsets.is_empty();
    let want_tint = opts.tint && !offsets.is_empty();
    let want_paint = opts.paint && !paints.is_empty();

    let mut painted = ChunkMesh::default();
    for z in 0..S {
        for y in 0..S {
            for x in 0..S {
                if occ[pidx(x, y, z)] == 0 {
                    continue;
                }
                let cell = (base.0 + x, base.1 + y, base.2 + z);
                let ck = pack(cell);
                for (d, dir) in DIRS.iter().enumerate() {
                    if occ[pidx(x + dir.0, y + dir.1, z + dir.2)] != 0 {
                        continue;
                    }
                    let paint = if want_paint { paints.get(ck, d as u8) } else { None };
                    let target = if paint.is_some() { &mut painted } else { &mut out };
                    emit_face(
                        target,
                        &occ,
                        offsets,
                        cell,
                        (x, y, z),
                        d,
                        use_offsets,
                        want_tint,
                        paint,
                        opts.grid,
                    );
                }
            }
        }
    }
    out.unpainted_faces = out.face_count();
    out.append(painted);
    out
}

/// UVs for a painted face, [bl, br, tr, tl]: the tile rect from the tileset
/// grid (rows counted from the top of the image, three.js flipY convention),
/// with flips applied first and then clockwise quarter-turns.
fn paint_uvs(paint: u32, grid: (u32, u32)) -> [[f32; 2]; 4] {
    let (tx, ty, rot, fh, fv) = unpack_paint(paint);
    let cols = grid.0.max(1) as f32;
    let rows = grid.1.max(1) as f32;
    let u0 = tx as f32 / cols;
    let u1 = (tx + 1) as f32 / cols;
    let v1 = 1.0 - ty as f32 / rows;
    let v0 = 1.0 - (ty + 1) as f32 / rows;
    let mut uv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    if fh {
        uv.swap(0, 1);
        uv.swap(2, 3);
    }
    if fv {
        uv.swap(0, 3);
        uv.swap(1, 2);
    }
    let mut rotated = uv;
    for (i, slot) in rotated.iter_mut().enumerate() {
        *slot = uv[(i + 3 * rot as usize) % 4];
    }
    rotated
}

#[allow(clippy::too_many_arguments)]
fn emit_face(
    out: &mut ChunkMesh,
    occ: &[u8],
    offsets: &Offsets,
    cell: IV,
    local: IV,
    d: usize,
    use_offsets: bool,
    want_tint: bool,
    paint: Option<u32>,
    grid: (u32, u32),
) {
    let dir = DIRS[d];
    let axis = d >> 1;
    let (a1, a2) = plane_axes(axis);
    // the empty cell this face looks into (local coords, for AO sampling)
    let e = (local.0 + dir.0, local.1 + dir.1, local.2 + dir.2);

    let mut verts = [[0f32; 3]; 4];
    let mut ao = [0u8; 4];
    let mut tint_t = [0f32; 4];
    for k in 0..4 {
        let c = CORNERS[d][k];
        let lat = (cell.0 + c.0, cell.1 + c.1, cell.2 + c.2);
        let off = if use_offsets || want_tint {
            offsets.get_opt(lat)
        } else {
            None
        };
        let applied = if use_offsets { off.unwrap_or([0.0; 3]) } else { [0.0; 3] };
        verts[k] = [
            lat.0 as f32 + applied[0],
            lat.1 as f32 + applied[1],
            lat.2 as f32 + applied[2],
        ];
        if want_tint {
            if let Some(o) = off {
                let mag = (o[0] * o[0] + o[1] * o[1] + o[2] * o[2]).sqrt();
                tint_t[k] = 0.85 * (mag / 0.5).min(1.0);
            }
        }
        // Minecraft-style corner AO in the empty layer the face looks into
        let ca = [c.0, c.1, c.2];
        let mut p1 = [e.0, e.1, e.2];
        let mut p2 = p1;
        p1[a1] += if ca[a1] == 1 { 1 } else { -1 };
        p2[a2] += if ca[a2] == 1 { 1 } else { -1 };
        let mut pc = p1;
        pc[a2] += if ca[a2] == 1 { 1 } else { -1 };
        let s1 = occ[pidx(p1[0], p1[1], p1[2])];
        let s2 = occ[pidx(p2[0], p2[1], p2[2])];
        let sc = occ[pidx(pc[0], pc[1], pc[2])];
        ao[k] = if s1 != 0 && s2 != 0 {
            0
        } else {
            3 - s1 - s2 - sc
        };
    }

    let n = quad_normal(&verts);
    let lambert = (n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]).max(0.0);
    let bright = 0.58 + 0.42 * lambert + 0.1 * n[1].min(0.0);

    let uvs = paint.map(|p| paint_uvs(p, grid));
    let vbase = (out.positions.len() / 3) as u32;
    for k in 0..4 {
        out.positions.extend_from_slice(&verts[k]);
        if let Some(uv) = &uvs {
            // painted faces: vertex color carries the shading only (the map
            // is modulated by it), full-brightness base
            let bk = bright * AO_CURVE[ao[k] as usize];
            out.colors.extend_from_slice(&[bk, bk, bk]);
            out.uvs.extend_from_slice(&uv[k]);
        } else {
            let bk = bright * AO_CURVE[ao[k] as usize];
            let mut r = VOL_BASE[0] * bk;
            let mut g = VOL_BASE[1] * bk;
            let mut b = VOL_BASE[2] * bk;
            let t = tint_t[k];
            if t > 0.0 {
                r += (SHIFT_TINT[0] - r) * t;
                g += (SHIFT_TINT[1] - g) * t;
                b += (SHIFT_TINT[2] - b) * t;
            }
            out.colors.extend_from_slice(&[r, g, b]);
            out.uvs.extend_from_slice(&[0.0, 0.0]);
        }
    }
    // AO-aware diagonal (the classic anisotropy fix)
    if ao[0] as i32 + ao[2] as i32 >= ao[1] as i32 + ao[3] as i32 {
        out.indices
            .extend_from_slice(&[vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3]);
    } else {
        out.indices
            .extend_from_slice(&[vbase, vbase + 1, vbase + 3, vbase + 1, vbase + 2, vbase + 3]);
    }
    out.face_keys
        .extend_from_slice(&[cell.0, cell.1, cell.2, d as i32]);
}

/// The displaced (or raw) quad of one exposed cell face, [bl,br,tr,tl] · xyz.
pub fn face_quad(
    store: &ChunkStore,
    offsets: &Offsets,
    cell: IV,
    d: usize,
    sculpted: bool,
) -> Option<[f32; 12]> {
    if !store.get(cell) {
        return None;
    }
    let dir = DIRS[d];
    if store.get(add_iv(cell, dir)) {
        return None;
    }
    let mut out = [0f32; 12];
    for k in 0..4 {
        let c = CORNERS[d][k];
        let lat = (cell.0 + c.0, cell.1 + c.1, cell.2 + c.2);
        let off = if sculpted { offsets.get(lat) } else { [0.0; 3] };
        out[k * 3] = lat.0 as f32 + off[0];
        out[k * 3 + 1] = lat.1 as f32 + off[1];
        out[k * 3 + 2] = lat.2 as f32 + off[2];
    }
    Some(out)
}

/// A coarse LOD mesh: occupancy downsampled by 2^level ("any solid" rule so
/// the hull is conservative), no displacement, cells rendered at scale.
pub fn mesh_chunk_lod(store: &ChunkStore, cp: IV, level: u32) -> ChunkMesh {
    let mut out = ChunkMesh::default();
    if store.chunks.get(&cp).is_none() {
        return out;
    }
    let step = 1i32 << level; // coarse cell size
    let n = S / step; // coarse cells per side
    let base = (cp.0 * S, cp.1 * S, cp.2 * S);
    let pn = n + 2;
    let cidx = |x: i32, y: i32, z: i32| ((x + 1) + (y + 1) * pn + (z + 1) * pn * pn) as usize;

    let mut hood = Neighborhood::new(store, cp);
    // coarse occupancy: 0 = empty, 1 = partially solid, 2 = fully solid
    let mut coarse = vec![0u8; (pn * pn * pn) as usize];
    for z in -1..=n {
        for y in -1..=n {
            for x in -1..=n {
                let mut any = false;
                let mut all = true;
                'probe: for dz in 0..step {
                    for dy in 0..step {
                        for dx in 0..step {
                            if hood.get((
                                base.0 + x * step + dx,
                                base.1 + y * step + dy,
                                base.2 + z * step + dz,
                            )) {
                                any = true;
                            } else {
                                all = false;
                            }
                            if any && !all {
                                break 'probe;
                            }
                        }
                    }
                }
                coarse[cidx(x, y, z)] = if !any {
                    0
                } else if all {
                    2
                } else {
                    1
                };
            }
        }
    }

    for z in 0..n {
        for y in 0..n {
            for x in 0..n {
                if coarse[cidx(x, y, z)] == 0 {
                    continue;
                }
                for (d, dir) in DIRS.iter().enumerate() {
                    let np = (x + dir.0, y + dir.1, z + dir.2);
                    let nv = coarse[cidx(np.0, np.1, np.2)];
                    let inside = (0..n).contains(&np.0) && (0..n).contains(&np.1) && (0..n).contains(&np.2);
                    // interior faces cull against any-solid neighbors; faces on
                    // the chunk border only cull when the neighbor is *fully*
                    // solid, so LOD-transition cracks stay covered
                    if (inside && nv != 0) || (!inside && nv == 2) {
                        continue;
                    }
                    // emit a scaled quad, flat shading, coarse AO from coarse field
                    let cell_w = (
                        base.0 + x * step,
                        base.1 + y * step,
                        base.2 + z * step,
                    );
                    let axis = d >> 1;
                    let (a1, a2) = plane_axes(axis);
                    let e = (x + dir.0, y + dir.1, z + dir.2);
                    let mut verts = [[0f32; 3]; 4];
                    let mut ao = [0u8; 4];
                    for k in 0..4 {
                        let c = CORNERS[d][k];
                        verts[k] = [
                            (cell_w.0 + c.0 * step) as f32,
                            (cell_w.1 + c.1 * step) as f32,
                            (cell_w.2 + c.2 * step) as f32,
                        ];
                        let ca = [c.0, c.1, c.2];
                        let mut p1 = [e.0, e.1, e.2];
                        let mut p2 = p1;
                        p1[a1] += if ca[a1] == 1 { 1 } else { -1 };
                        p2[a2] += if ca[a2] == 1 { 1 } else { -1 };
                        let mut pc = p1;
                        pc[a2] += if ca[a2] == 1 { 1 } else { -1 };
                        let s1 = (coarse[cidx(p1[0], p1[1], p1[2])] != 0) as u8;
                        let s2 = (coarse[cidx(p2[0], p2[1], p2[2])] != 0) as u8;
                        let sc = (coarse[cidx(pc[0], pc[1], pc[2])] != 0) as u8;
                        ao[k] = if s1 != 0 && s2 != 0 { 0 } else { 3 - s1 - s2 - sc };
                    }
                    let nrm = quad_normal(&verts);
                    let lambert =
                        (nrm[0] * LIGHT[0] + nrm[1] * LIGHT[1] + nrm[2] * LIGHT[2]).max(0.0);
                    let bright = 0.58 + 0.42 * lambert + 0.1 * nrm[1].min(0.0);
                    let vbase = (out.positions.len() / 3) as u32;
                    for k in 0..4 {
                        out.positions.extend_from_slice(&verts[k]);
                        let bk = bright * AO_CURVE[ao[k] as usize];
                        out.colors.extend_from_slice(&[
                            VOL_BASE[0] * bk,
                            VOL_BASE[1] * bk,
                            VOL_BASE[2] * bk,
                        ]);
                        out.uvs.extend_from_slice(&[0.0, 0.0]);
                    }
                    if ao[0] as i32 + ao[2] as i32 >= ao[1] as i32 + ao[3] as i32 {
                        out.indices.extend_from_slice(&[
                            vbase,
                            vbase + 1,
                            vbase + 2,
                            vbase,
                            vbase + 2,
                            vbase + 3,
                        ]);
                    } else {
                        out.indices.extend_from_slice(&[
                            vbase,
                            vbase + 1,
                            vbase + 3,
                            vbase + 1,
                            vbase + 2,
                            vbase + 3,
                        ]);
                    }
                    out.face_keys
                        .extend_from_slice(&[cell_w.0, cell_w.1, cell_w.2, d as i32]);
                }
            }
        }
    }
    out.unpainted_faces = out.face_count();
    out
}

/// Watertightness check over the whole surface: every lattice edge must be
/// shared by an even number of faces. Test/diagnostic use — O(surface).
pub fn boundary_stats(store: &ChunkStore) -> (u64, u64) {
    let mut faces: u64 = 0;
    let mut edges: FxHashMap<(i64, i64), u32> = FxHashMap::default();
    let chunk_positions: Vec<IV> = store.chunks.keys().copied().collect();
    for cp in chunk_positions {
        let base = (cp.0 * S, cp.1 * S, cp.2 * S);
        let mut hood = Neighborhood::new(store, cp);
        for z in 0..S {
            for y in 0..S {
                for x in 0..S {
                    let cell = (base.0 + x, base.1 + y, base.2 + z);
                    if !hood.get(cell) {
                        continue;
                    }
                    for (d, dir) in DIRS.iter().enumerate() {
                        if hood.get(add_iv(cell, *dir)) {
                            continue;
                        }
                        faces += 1;
                        let mut lats = [0i64; 4];
                        for k in 0..4 {
                            let c = CORNERS[d][k];
                            lats[k] = pack((cell.0 + c.0, cell.1 + c.1, cell.2 + c.2));
                        }
                        for k in 0..4 {
                            let a = lats[k];
                            let b = lats[(k + 1) % 4];
                            let key = if a < b { (a, b) } else { (b, a) };
                            *edges.entry(key).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }
    let odd = edges.values().filter(|c| *c % 2 == 1).count() as u64;
    (faces, odd)
}
