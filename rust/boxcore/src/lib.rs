//! boxcore — the boxexplore volume-editor core.
//!
//! The document is a sparse chunked voxel volume plus per-lattice-corner
//! displacements (hard-clamped to ±0.5 per axis). The boundary surface is
//! derived, never stored, so it is watertight by construction. This crate
//! owns the document, all edit operations (rect extrude/carve, sculpt
//! brushes, offset hygiene), undo/redo, meshing (with AO and view modes),
//! visibility queries, and serialization. The TypeScript shell is a thin
//! view/controller on top.

pub mod mesh;
pub mod ops;
pub mod store;
pub mod wasm_api;

/// Integer cell / lattice coordinate.
pub type IV = (i32, i32, i32);

/// Outward normals of a cell's 6 faces: +x, -x, +y, -y, +z, -z.
pub const DIRS: [IV; 6] = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)];

/// Corner offsets per direction, ordered [bl, br, tr, tl] to match the
/// original editor exactly (winding, AO corners, texture orientation).
pub const CORNERS: [[IV; 4]; 6] = [
    [(1, 0, 1), (1, 0, 0), (1, 1, 0), (1, 1, 1)], // +x
    [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)], // -x
    [(0, 1, 1), (1, 1, 1), (1, 1, 0), (0, 1, 0)], // +y
    [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)], // -y
    [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)], // +z
    [(1, 0, 0), (0, 0, 0), (0, 1, 0), (1, 1, 0)], // -z
];

/// The two in-plane axes for a face axis (matches the AO/corner convention).
pub fn plane_axes(axis: usize) -> (usize, usize) {
    (if axis == 0 { 1 } else { 0 }, if axis == 2 { 1 } else { 2 })
}

#[inline]
pub fn axis_of(c: IV, axis: usize) -> i32 {
    match axis {
        0 => c.0,
        1 => c.1,
        _ => c.2,
    }
}

#[inline]
pub fn add_iv(a: IV, b: IV) -> IV {
    (a.0 + b.0, a.1 + b.1, a.2 + b.2)
}

#[inline]
pub fn sub_iv(a: IV, b: IV) -> IV {
    (a.0 - b.0, a.1 - b.1, a.2 - b.2)
}

/// Pack a coordinate into an i64 key (21 signed bits per axis).
#[inline]
pub fn pack(c: IV) -> i64 {
    const M: i64 = 0x1F_FFFF;
    ((c.0 as i64 & M) << 42) | ((c.1 as i64 & M) << 21) | (c.2 as i64 & M)
}

#[inline]
fn sx21(v: i64) -> i32 {
    ((v << 43) >> 43) as i32
}

#[inline]
pub fn unpack(k: i64) -> IV {
    (sx21(k >> 42), sx21(k >> 21), sx21(k))
}

pub type V3 = [f32; 3];

#[inline]
pub fn v3_add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[inline]
pub fn v3_sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
pub fn v3_scale(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

#[inline]
pub fn v3_dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
pub fn v3_cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
pub fn v3_len(a: V3) -> f32 {
    v3_dot(a, a).sqrt()
}

#[inline]
pub fn v3_norm(a: V3) -> V3 {
    let l = v3_len(a);
    if l > 1e-9 {
        v3_scale(a, 1.0 / l)
    } else {
        [0.0, 0.0, 0.0]
    }
}

/// Diagonal-cross normal of a quad, robust for planar and warped quads alike.
pub fn quad_normal(v: &[V3; 4]) -> V3 {
    v3_norm(v3_cross(v3_sub(v[2], v[0]), v3_sub(v[3], v[1])))
}
