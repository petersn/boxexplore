//! The world-planning document: a pair of height maps (top and bottom — the
//! world is a floating "disc" with an underside) plus a mask for cells that
//! aren't part of the world at all. One plan cell spans PLAN_SCALE×PLAN_SCALE
//! world cells, so a 500×500 plan describes a 2000×2000 world. The plan is
//! edited as a contour map, previewed as coarse 3D terrain, and finally
//! GENERATED into real volume geometry (like a shaped Slab).

use crate::mesh::ChunkMesh;
use crate::store::ChunkStore;
use crate::{quad_normal, V3};

/// World cells per plan cell.
pub const PLAN_SCALE: i32 = 4;
/// The bottom surface never comes closer than this to the top (world units).
pub const MIN_GAP: f32 = 2.0;

const LIGHT: V3 = [0.372, 0.904, 0.213];

pub struct Plan {
    pub w: usize,
    pub h: usize,
    pub top: Vec<f32>,
    pub bottom: Vec<f32>,
    pub mask: Vec<bool>,
}

impl Plan {
    pub fn new(w: usize, h: usize) -> Plan {
        let n = w * h;
        Plan {
            w,
            h,
            top: vec![2.0; n],
            bottom: vec![-2.0; n],
            mask: vec![true; n],
        }
    }

    #[inline]
    fn idx(&self, x: usize, y: usize) -> usize {
        y * self.w + x
    }

    fn cells_in_radius(&self, cx: f32, cy: f32, radius: f32) -> Vec<(usize, f32)> {
        let mut out = Vec::new();
        let r = radius.max(0.5);
        let x0 = ((cx - r).floor().max(0.0)) as usize;
        let y0 = ((cy - r).floor().max(0.0)) as usize;
        let x1 = ((cx + r).ceil() as usize).min(self.w.saturating_sub(1));
        let y1 = ((cy + r).ceil() as usize).min(self.h.saturating_sub(1));
        for y in y0..=y1 {
            for x in x0..=x1 {
                let dx = x as f32 + 0.5 - cx;
                let dy = y as f32 + 0.5 - cy;
                let d = (dx * dx + dy * dy).sqrt();
                if d <= r {
                    // smoothstep falloff toward the rim
                    let t = 1.0 - d / r;
                    let wgt = t * t * (3.0 - 2.0 * t);
                    out.push((self.idx(x, y), wgt));
                }
            }
        }
        out
    }

    /// Raise/lower one surface with a smooth falloff. The bottom map yields:
    /// it is re-clamped to stay MIN_GAP below the top everywhere.
    pub fn brush(&mut self, cx: f32, cy: f32, radius: f32, delta: f32, layer: u32) {
        for (i, wgt) in self.cells_in_radius(cx, cy, radius) {
            if layer == 0 {
                self.top[i] += delta * wgt;
            } else {
                self.bottom[i] += delta * wgt;
            }
        }
        self.clamp_gap();
    }

    /// Relax a surface toward its neighborhood average (terrain smoothing).
    pub fn smooth(&mut self, cx: f32, cy: f32, radius: f32, strength: f32, layer: u32) {
        let src = if layer == 0 {
            self.top.clone()
        } else {
            self.bottom.clone()
        };
        let cells = self.cells_in_radius(cx, cy, radius);
        for (i, wgt) in cells {
            let x = i % self.w;
            let y = i / self.w;
            let mut sum = 0.0;
            let mut n = 0.0;
            for (nx, ny) in [
                (x.wrapping_sub(1), y),
                (x + 1, y),
                (x, y.wrapping_sub(1)),
                (x, y + 1),
            ] {
                if nx < self.w && ny < self.h {
                    sum += src[self.idx(nx, ny)];
                    n += 1.0;
                }
            }
            if n > 0.0 {
                let target = sum / n;
                let dst = if layer == 0 {
                    &mut self.top[i]
                } else {
                    &mut self.bottom[i]
                };
                *dst += (target - *dst) * (strength * wgt).clamp(0.0, 1.0);
            }
        }
        self.clamp_gap();
    }

    /// Cut cells out of the world (value = false) or restore them.
    pub fn mask_brush(&mut self, cx: f32, cy: f32, radius: f32, value: bool) {
        for (i, _) in self.cells_in_radius(cx, cy, radius) {
            self.mask[i] = value;
        }
    }

    fn clamp_gap(&mut self) {
        for i in 0..self.top.len() {
            if self.bottom[i] > self.top[i] - MIN_GAP {
                self.bottom[i] = self.top[i] - MIN_GAP;
            }
        }
    }

    // -- contour map -----------------------------------------------------------------

    /// One RGBA pixel per plan cell: height bands with contour lines, void
    /// cells as a dark checkerboard.
    pub fn rgba(&self, layer: u32) -> Vec<u8> {
        let hmap = if layer == 0 { &self.top } else { &self.bottom };
        let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
        for (i, &v) in hmap.iter().enumerate() {
            if self.mask[i] {
                lo = lo.min(v);
                hi = hi.max(v);
            }
        }
        if !lo.is_finite() || hi - lo < 1e-6 {
            lo = -1.0;
            hi = 1.0;
        }
        // band every 2 world units, colored along a terrain ramp
        let band_of = |v: f32| (v / 2.0).floor() as i32;
        let ramp = |t: f32| -> [f32; 3] {
            // deep green → grass → tan → light gray
            let stops: [[f32; 3]; 5] = [
                [0.13, 0.23, 0.16],
                [0.22, 0.42, 0.22],
                [0.48, 0.52, 0.28],
                [0.62, 0.51, 0.36],
                [0.82, 0.80, 0.76],
            ];
            let x = (t.clamp(0.0, 1.0)) * (stops.len() - 1) as f32;
            let i = (x.floor() as usize).min(stops.len() - 2);
            let f = x - i as f32;
            let a = stops[i];
            let b = stops[i + 1];
            [
                a[0] + (b[0] - a[0]) * f,
                a[1] + (b[1] - a[1]) * f,
                a[2] + (b[2] - a[2]) * f,
            ]
        };
        let mut out = vec![0u8; self.w * self.h * 4];
        for y in 0..self.h {
            for x in 0..self.w {
                let i = self.idx(x, y);
                let px = &mut out[i * 4..i * 4 + 4];
                if !self.mask[i] {
                    let c = if (x / 4 + y / 4) % 2 == 0 { 24 } else { 32 };
                    px.copy_from_slice(&[c, c, c + 3, 255]);
                    continue;
                }
                let v = hmap[i];
                let band = band_of(v);
                // banded color, quantized so bands read as terraces
                let t = ((band as f32 * 2.0) - lo) / (hi - lo).max(1.0);
                let mut c = ramp(t);
                // contour line where the band changes against any neighbor
                let mut edge = false;
                let mut coast = false;
                for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
                    if nx < self.w && ny < self.h {
                        let ni = self.idx(nx, ny);
                        if !self.mask[ni] {
                            coast = true;
                        } else if band_of(hmap[ni]) != band {
                            edge = true;
                        }
                    } else {
                        coast = true;
                    }
                }
                if coast {
                    c = [0.95, 0.85, 0.4];
                } else if edge {
                    c = [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55];
                }
                px.copy_from_slice(&[
                    (c[0] * 255.0) as u8,
                    (c[1] * 255.0) as u8,
                    (c[2] * 255.0) as u8,
                    255,
                ]);
            }
        }
        out
    }

    // -- 3D preview -------------------------------------------------------------------

    /// Coarse terrain mesh of the disc world (top sheet, bottom sheet, and
    /// skirt walls at the mask edge), in WORLD coordinates. `step` decimates
    /// (1 = one quad per plan cell). Corner heights average the adjacent
    /// cells so the sheets read as continuous terrain, not stairs.
    pub fn preview_mesh(&self, step: usize) -> ChunkMesh {
        let step = step.max(1);
        let mut m = ChunkMesh::default();
        let gw = self.w / step;
        let gh = self.h / step;
        if gw == 0 || gh == 0 {
            return m;
        }
        let half_w = (self.w as i32 * PLAN_SCALE) as f32 / 2.0;
        let half_h = (self.h as i32 * PLAN_SCALE) as f32 / 2.0;
        let cell_masked = |gx: i32, gy: i32| -> bool {
            if gx < 0 || gy < 0 || gx >= gw as i32 || gy >= gh as i32 {
                return false;
            }
            // a coarse cell counts if its center plan cell is masked
            let px = (gx as usize * step + step / 2).min(self.w - 1);
            let py = (gy as usize * step + step / 2).min(self.h - 1);
            self.mask[self.idx(px, py)]
        };
        // corner height = average of adjacent masked cells' heights
        let corner = |hmap: &Vec<f32>, gx: usize, gy: usize| -> f32 {
            let mut sum = 0.0;
            let mut n = 0.0;
            for (dx, dy) in [(-1i32, -1i32), (0, -1), (-1, 0), (0, 0)] {
                let cx = gx as i32 + dx;
                let cy = gy as i32 + dy;
                if cell_masked(cx, cy) {
                    let px = (cx as usize * step + step / 2).min(self.w - 1);
                    let py = (cy as usize * step + step / 2).min(self.h - 1);
                    sum += hmap[self.idx(px, py)];
                    n += 1.0;
                }
            }
            if n > 0.0 {
                sum / n
            } else {
                0.0
            }
        };
        let world_x = |gx: usize| (gx * step) as f32 * PLAN_SCALE as f32 - half_w;
        let world_z = |gy: usize| (gy * step) as f32 * PLAN_SCALE as f32 - half_h;

        let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
        for (i, &v) in self.top.iter().enumerate() {
            if self.mask[i] {
                lo = lo.min(v);
                hi = hi.max(v);
            }
        }
        if !lo.is_finite() || hi - lo < 1e-6 {
            lo = -1.0;
            hi = 1.0;
        }

        let mut emit = |m: &mut ChunkMesh, verts: [V3; 4], base: [f32; 3]| {
            let n = quad_normal(&verts);
            let lambert = (n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]).max(0.0);
            let bright = 0.58 + 0.42 * lambert + 0.1 * n[1].min(0.0);
            let vbase = (m.positions.len() / 3) as u32;
            for v in verts {
                m.positions.extend_from_slice(&v);
                m.colors
                    .extend_from_slice(&[base[0] * bright, base[1] * bright, base[2] * bright]);
                m.uvs.extend_from_slice(&[0.0, 0.0]);
            }
            m.indices.extend_from_slice(&[
                vbase,
                vbase + 1,
                vbase + 2,
                vbase,
                vbase + 2,
                vbase + 3,
            ]);
            m.face_keys.extend_from_slice(&[0, 0, 0, 0]);
        };
        let ramp = |t: f32| -> [f32; 3] {
            let stops: [[f32; 3]; 5] = [
                [0.13, 0.23, 0.16],
                [0.22, 0.42, 0.22],
                [0.48, 0.52, 0.28],
                [0.62, 0.51, 0.36],
                [0.82, 0.80, 0.76],
            ];
            let x = t.clamp(0.0, 1.0) * (stops.len() - 1) as f32;
            let i = (x.floor() as usize).min(stops.len() - 2);
            let f = x - i as f32;
            let a = stops[i];
            let b = stops[i + 1];
            [
                a[0] + (b[0] - a[0]) * f,
                a[1] + (b[1] - a[1]) * f,
                a[2] + (b[2] - a[2]) * f,
            ]
        };

        for gy in 0..gh {
            for gx in 0..gw {
                if !cell_masked(gx as i32, gy as i32) {
                    continue;
                }
                let (x0, x1) = (world_x(gx), world_x(gx + 1));
                let (z0, z1) = (world_z(gy), world_z(gy + 1));
                let t00 = corner(&self.top, gx, gy);
                let t10 = corner(&self.top, gx + 1, gy);
                let t11 = corner(&self.top, gx + 1, gy + 1);
                let t01 = corner(&self.top, gx, gy + 1);
                let b00 = corner(&self.bottom, gx, gy);
                let b10 = corner(&self.bottom, gx + 1, gy);
                let b11 = corner(&self.bottom, gx + 1, gy + 1);
                let b01 = corner(&self.bottom, gx, gy + 1);
                let mid = (t00 + t10 + t11 + t01) / 4.0;
                let color = ramp(((mid / 2.0).floor() * 2.0 - lo) / (hi - lo).max(1.0));
                // top sheet (facing +y)
                emit(
                    &mut m,
                    [
                        [x0, t00, z0],
                        [x0, t01, z1],
                        [x1, t11, z1],
                        [x1, t10, z0],
                    ],
                    color,
                );
                // bottom sheet (facing -y), dimmed
                let bc = [0.35, 0.32, 0.3];
                emit(
                    &mut m,
                    [
                        [x0, b00, z0],
                        [x1, b10, z0],
                        [x1, b11, z1],
                        [x0, b01, z1],
                    ],
                    bc,
                );
                // skirt walls where the neighbor is void
                let wall = [0.45, 0.4, 0.34];
                if !cell_masked(gx as i32, gy as i32 - 1) {
                    emit(
                        &mut m,
                        [
                            [x0, b00, z0],
                            [x0, t00, z0],
                            [x1, t10, z0],
                            [x1, b10, z0],
                        ],
                        wall,
                    );
                }
                if !cell_masked(gx as i32, gy as i32 + 1) {
                    emit(
                        &mut m,
                        [
                            [x1, b11, z1],
                            [x1, t11, z1],
                            [x0, t01, z1],
                            [x0, b01, z1],
                        ],
                        wall,
                    );
                }
                if !cell_masked(gx as i32 - 1, gy as i32) {
                    emit(
                        &mut m,
                        [
                            [x0, b01, z1],
                            [x0, t01, z1],
                            [x0, t00, z0],
                            [x0, b00, z0],
                        ],
                        wall,
                    );
                }
                if !cell_masked(gx as i32 + 1, gy as i32) {
                    emit(
                        &mut m,
                        [
                            [x1, b10, z0],
                            [x1, t10, z0],
                            [x1, t11, z1],
                            [x1, b11, z1],
                        ],
                        wall,
                    );
                }
            }
        }
        m.unpainted_faces = m.face_count();
        m
    }

    // -- generation ---------------------------------------------------------------------

    /// Build the real volume: every masked plan cell becomes a PLAN_SCALE²
    /// column of solid cells from round(bottom) to round(top), at least
    /// MIN_GAP thick, centered on the origin like the Slab tool.
    pub fn generate(&self, store: &mut ChunkStore) {
        let half_w = (self.w as i32 * PLAN_SCALE) / 2;
        let half_h = (self.h as i32 * PLAN_SCALE) / 2;
        for y in 0..self.h {
            for x in 0..self.w {
                let i = self.idx(x, y);
                if !self.mask[i] {
                    continue;
                }
                let y_top = self.top[i].round() as i32;
                let y_bot = (self.bottom[i].round() as i32).min(y_top - MIN_GAP as i32);
                let x0 = x as i32 * PLAN_SCALE - half_w;
                let z0 = y as i32 * PLAN_SCALE - half_h;
                store.fill_box(
                    (x0, y_bot, z0),
                    (x0 + PLAN_SCALE, y_top, z0 + PLAN_SCALE),
                    true,
                );
            }
        }
    }

    // -- serialization (doc v7 plan section) ---------------------------------------------

    pub fn to_bytes(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&(self.w as u32).to_le_bytes());
        out.extend_from_slice(&(self.h as u32).to_le_bytes());
        for v in self.top.iter().chain(self.bottom.iter()) {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let mut bits = vec![0u8; (self.mask.len() + 7) / 8];
        for (i, &b) in self.mask.iter().enumerate() {
            if b {
                bits[i / 8] |= 1 << (i % 8);
            }
        }
        out.extend_from_slice(&bits);
    }

    pub fn from_bytes(w: u32, h: u32, data: &[u8]) -> Option<Plan> {
        let n = (w as usize).checked_mul(h as usize)?;
        if n == 0 || n > 4096 * 4096 {
            return None;
        }
        let need = n * 8 + (n + 7) / 8;
        if data.len() < need {
            return None;
        }
        let f = |i: usize| f32::from_le_bytes(data[i * 4..i * 4 + 4].try_into().unwrap());
        let mut plan = Plan::new(w as usize, h as usize);
        for i in 0..n {
            plan.top[i] = f(i);
            plan.bottom[i] = f(n + i);
        }
        let bits = &data[n * 8..];
        for i in 0..n {
            plan.mask[i] = bits[i / 8] & (1 << (i % 8)) != 0;
        }
        Some(plan)
    }
}
