//! Physics queries and the character controller, built on rapier3d.
//!
//! Each chunk gets a trimesh collider generated from the *sculpted* surface
//! mesh, so collision matches exactly what's rendered. Rapier is used purely
//! as a query engine (BVH ray/shape casts) — the character controller is
//! hand-rolled kinematics on top of those queries, not a rigid body.

use crate::mesh::{mesh_chunk, MeshOpts};
use crate::store::{ChunkStore, Offsets, Paints};
use crate::{IV, V3};
use rapier3d::math::{Pose, Vector};
use rapier3d::parry::query::{contact, DefaultQueryDispatcher, ShapeCastOptions};
use rapier3d::parry::shape::{Ball, Capsule};
use rapier3d::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};

fn vec(v: V3) -> Vector {
    Vector::new(v[0], v[1], v[2])
}

fn v3(v: Vector) -> V3 {
    [v.x, v.y, v.z]
}

pub struct Phys {
    bodies: RigidBodySet,
    colliders: ColliderSet,
    islands: IslandManager,
    broad: BroadPhaseBvh,
    dispatcher: DefaultQueryDispatcher,
    params: IntegrationParameters,
    chunk_colliders: FxHashMap<IV, ColliderHandle>,
    /// Chunks whose collider needs rebuilding (fed by the store's edits).
    pub dirty: FxHashSet<IV>,
}

impl Default for Phys {
    fn default() -> Self {
        Self::new()
    }
}

impl Phys {
    pub fn new() -> Self {
        Self {
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            islands: IslandManager::new(),
            broad: BroadPhaseBvh::new(),
            dispatcher: DefaultQueryDispatcher,
            params: IntegrationParameters::default(),
            chunk_colliders: FxHashMap::default(),
            dirty: FxHashSet::default(),
        }
    }

    /// Rebuild colliders for all dirty chunks from the sculpted surface.
    pub fn sync(&mut self, store: &ChunkStore, offsets: &Offsets, paints: &Paints) {
        if self.dirty.is_empty() {
            return;
        }
        let mut modified: Vec<ColliderHandle> = Vec::new();
        let mut removed: Vec<ColliderHandle> = Vec::new();
        let dirty: Vec<IV> = self.dirty.drain().collect();
        for cp in dirty {
            if let Some(h) = self.chunk_colliders.remove(&cp) {
                self.colliders.remove(h, &mut self.islands, &mut self.bodies, false);
                removed.push(h);
            }
            let m = mesh_chunk(
                store,
                offsets,
                paints,
                cp,
                &MeshOpts {
                    sculpted: true,
                    tint: false,
                    paint: false,
                    grid: (8, 8),
                },
            );
            if m.face_count() == 0 {
                continue;
            }
            let vertices: Vec<Vector> = m
                .positions
                .chunks_exact(3)
                .map(|p| Vector::new(p[0], p[1], p[2]))
                .collect();
            let indices: Vec<[u32; 3]> = m
                .indices
                .chunks_exact(3)
                .map(|t| [t[0], t[1], t[2]])
                .collect();
            if let Ok(builder) = ColliderBuilder::trimesh(vertices, indices) {
                let h = self.colliders.insert(builder);
                self.chunk_colliders.insert(cp, h);
                modified.push(h);
            }
        }
        let mut events = Vec::new();
        self.broad.update(
            &self.params,
            &self.colliders,
            &self.bodies,
            &modified,
            &removed,
            &mut events,
        );
    }

    fn qp(&self) -> QueryPipeline<'_> {
        self.broad.as_query_pipeline(
            &self.dispatcher,
            &self.bodies,
            &self.colliders,
            QueryFilter::default(),
        )
    }

    /// First hit along a ray: (distance, surface normal).
    pub fn ray(&self, origin: V3, dir: V3, max: f32) -> Option<(f32, V3)> {
        let ray = Ray::new(vec(origin), vec(dir));
        self.qp()
            .cast_ray_and_get_normal(&ray, max, true)
            .map(|(_, hit)| (hit.time_of_impact, v3(hit.normal)))
    }

    /// Sweep a ball along `dir` (unit): (travel distance ≤ max, hit normal).
    pub fn cast_ball(&self, center: V3, radius: f32, dir: V3, max: f32) -> Option<(f32, V3)> {
        let shape = Ball::new(radius);
        let pose = Pose::from_translation(vec(center));
        // stop_at_penetration=false: a sweep that starts in light contact
        // (wall hug, ground snap) only reports hits that deepen penetration,
        // so movement out of or along a surface is never spuriously blocked.
        // Residual overlap is depenetrate()'s job.
        let opts = ShapeCastOptions {
            max_time_of_impact: max,
            target_distance: 0.0,
            stop_at_penetration: false,
            compute_impact_geometry_on_penetration: true,
        };
        self.qp()
            .cast_shape(&pose, vec(dir), &shape, opts)
            .map(|(_, hit)| {
                let mut n = v3(hit.normal1);
                if n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] > 0.0 {
                    n = [-n[0], -n[1], -n[2]];
                }
                (hit.time_of_impact, n)
            })
    }

    /// Sweep a y-aligned capsule (center given) along `dir` (unit).
    pub fn cast_capsule(
        &self,
        center: V3,
        half_height: f32,
        radius: f32,
        dir: V3,
        max: f32,
    ) -> Option<(f32, V3)> {
        let shape = Capsule::new_y(half_height, radius);
        let pose = Pose::from_translation(vec(center));
        // stop_at_penetration=false: a sweep that starts in light contact
        // (wall hug, ground snap) only reports hits that deepen penetration,
        // so movement out of or along a surface is never spuriously blocked.
        // Residual overlap is depenetrate()'s job.
        let opts = ShapeCastOptions {
            max_time_of_impact: max,
            target_distance: 0.0,
            stop_at_penetration: false,
            compute_impact_geometry_on_penetration: true,
        };
        self.qp()
            .cast_shape(&pose, vec(dir), &shape, opts)
            .map(|(_, hit)| {
                let mut n = v3(hit.normal1);
                if n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] > 0.0 {
                    n = [-n[0], -n[1], -n[2]];
                }
                (hit.time_of_impact, n)
            })
    }

    /// How far a ball of `radius` can travel from `from` along `dir` before
    /// hitting the world (used to keep the chase camera out of geometry).
    pub fn clearance(&self, from: V3, dir: V3, dist: f32, radius: f32) -> f32 {
        match self.cast_ball(from, radius, dir, dist) {
            None => dist,
            Some((toi, _)) => toi.max(0.0),
        }
    }

    /// Chunk colliders whose 32³ cell range can overlap the given AABB.
    fn handles_near(&self, lo: V3, hi: V3) -> Vec<ColliderHandle> {
        let c0 = (
            (lo[0].floor() as i32) >> 5,
            (lo[1].floor() as i32) >> 5,
            (lo[2].floor() as i32) >> 5,
        );
        let c1 = (
            (hi[0].ceil() as i32) >> 5,
            (hi[1].ceil() as i32) >> 5,
            (hi[2].ceil() as i32) >> 5,
        );
        let mut out = Vec::new();
        for x in c0.0..=c1.0 {
            for y in c0.1..=c1.1 {
                for z in c0.2..=c1.2 {
                    if let Some(h) = self.chunk_colliders.get(&(x, y, z)) {
                        out.push(*h);
                    }
                }
            }
        }
        out
    }

    /// Push a y-aligned capsule out of any geometry it penetrates (deepest
    /// contact first, a few iterations). Returns the corrected center and
    /// whether all penetration got resolved. This is the safety net that
    /// keeps the controller recoverable: sweeps prevent tunneling, and any
    /// residual overlap (snap onto a slope, step-up into a tight spot, an
    /// edit made under the player) is ejected here instead of accumulating.
    pub fn depenetrate(&self, center: V3, half_height: f32, radius: f32) -> (V3, bool) {
        const TOLERANCE: f32 = 0.005;
        let capsule = Capsule::new_y(half_height, radius);
        let reach_y = half_height + radius + 0.6;
        let reach_xz = radius + 0.6;
        let mut c = center;
        for _ in 0..4 {
            let lo = [c[0] - reach_xz, c[1] - reach_y, c[2] - reach_xz];
            let hi = [c[0] + reach_xz, c[1] + reach_y, c[2] + reach_xz];
            let pose = Pose::from_translation(vec(c));
            let mut worst: Option<(f32, V3)> = None;
            for h in self.handles_near(lo, hi) {
                let co = &self.colliders[h];
                if let Ok(Some(ct)) = contact(co.position(), co.shape(), &pose, &capsule, 0.0) {
                    if ct.dist < -TOLERANCE && worst.is_none_or(|(d, _)| ct.dist < d) {
                        // normal1 points from the world geometry toward the capsule
                        worst = Some((ct.dist, v3(ct.normal1)));
                    }
                }
            }
            match worst {
                None => return (c, true),
                Some((dist, n)) => {
                    let push = -dist + TOLERANCE;
                    c = [c[0] + n[0] * push, c[1] + n[1] * push, c[2] + n[2] * push];
                }
            }
        }
        (c, false)
    }
}

// ---------------------------------------------------------------------------
// Character controller (hand-rolled kinematics over rapier queries)
// ---------------------------------------------------------------------------

pub const RADIUS: f32 = 0.9;
pub const HEIGHT: f32 = 3.5;
const GRAVITY: f32 = 22.0;
const RUN_SPEED: f32 = 11.0;
const AIR_CONTROL: f32 = 0.35;
const ACCEL: f32 = 60.0;
const JUMP_V: f32 = 12.0; // ≈ 3.3u apex
const MAX_SLOPE_COS: f32 = 0.643; // 50°
const STEP_HEIGHT: f32 = 0.55;
const SNAP_DIST: f32 = 0.35;
const SKIN: f32 = 0.05;

pub struct Player {
    pub pos: V3,
    pub vel: V3,
    pub on_ground: bool,
    pub facing: f32,
    /// Depenetration failed to fully resolve this tick — the caller should
    /// try a coarser rescue (the wasm layer scans the voxel store upward).
    pub embedded: bool,
    coyote: f32,
    jump_held: bool,
    spawn: V3,
}

impl Player {
    pub fn new() -> Self {
        Self {
            pos: [0.0, 2.0, 0.0],
            vel: [0.0; 3],
            on_ground: false,
            facing: 0.0,
            embedded: false,
            coyote: 0.0,
            jump_held: false,
            spawn: [0.0, 2.0, 0.0],
        }
    }

    pub fn spawn_at(&mut self, phys: &Phys, x: f32, z: f32) {
        let y = match phys.ray([x, 300.0, z], [0.0, -1.0, 0.0], 600.0) {
            Some((toi, _)) => 300.0 - toi,
            None => 2.0,
        };
        self.pos = [x, y + 0.01, z];
        self.vel = [0.0; 3];
        self.spawn = self.pos;
        self.on_ground = false;
    }

    /// Best walkable ground under the cylinder (center + rim ray probes).
    fn ground_hit(&self, phys: &Phys) -> Option<(f32, V3)> {
        let probes: [[f32; 2]; 5] = [
            [0.0, 0.0],
            [RADIUS * 0.7, 0.0],
            [-RADIUS * 0.7, 0.0],
            [0.0, RADIUS * 0.7],
            [0.0, -RADIUS * 0.7],
        ];
        let mut best: Option<(f32, V3)> = None;
        for [ox, oz] in probes {
            let origin = [self.pos[0] + ox, self.pos[1] + 1.0, self.pos[2] + oz];
            if let Some((toi, mut n)) = phys.ray(origin, [0.0, -1.0, 0.0], 1.0 + SNAP_DIST + 0.5) {
                if n[1] < 0.0 {
                    n = [-n[0], -n[1], -n[2]];
                }
                let y = origin[1] - toi;
                if best.is_none() || y > best.unwrap().0 {
                    best = Some((y, n));
                }
            }
        }
        best
    }

    /// Horizontal move with capsule sweeps + wall sliding.
    fn move_horizontal(&mut self, phys: &Phys, mut mx: f32, mut mz: f32) {
        let half = (HEIGHT - 2.0 * RADIUS) / 2.0;
        for _ in 0..2 {
            let len = (mx * mx + mz * mz).sqrt();
            if len < 1e-6 {
                return;
            }
            let dir = [mx / len, 0.0, mz / len];
            // capsule lifted slightly so walkable ramps don't read as walls
            let center = [
                self.pos[0],
                self.pos[1] + HEIGHT / 2.0 + 0.12,
                self.pos[2],
            ];
            match phys.cast_capsule(center, half, RADIUS, dir, len + SKIN) {
                None => {
                    self.pos[0] += mx;
                    self.pos[2] += mz;
                    return;
                }
                Some((toi, n)) => {
                    let allowed = (toi - SKIN).clamp(0.0, len);
                    self.pos[0] += dir[0] * allowed;
                    self.pos[2] += dir[2] * allowed;
                    // slide the remainder (and velocity) along the wall
                    let mut wall = [n[0], 0.0, n[2]];
                    let wl = (wall[0] * wall[0] + wall[2] * wall[2]).sqrt();
                    if wl < 1e-6 {
                        return;
                    }
                    wall = [wall[0] / wl, 0.0, wall[2] / wl];
                    let rest = len - allowed;
                    let rx = dir[0] * rest;
                    let rz = dir[2] * rest;
                    let into = rx * wall[0] + rz * wall[2];
                    mx = rx - wall[0] * into;
                    mz = rz - wall[2] * into;
                    let vin = self.vel[0] * wall[0] + self.vel[2] * wall[2];
                    if vin < 0.0 {
                        self.vel[0] -= wall[0] * vin;
                        self.vel[2] -= wall[2] * vin;
                    }
                }
            }
        }
    }

    fn capsule_center(&self) -> V3 {
        [self.pos[0], self.pos[1] + HEIGHT / 2.0, self.pos[2]]
    }

    const HALF: f32 = (HEIGHT - 2.0 * RADIUS) / 2.0;

    /// Resolve any overlap with the world (edits under the player, snap
    /// residue, sweep skin) before/after moving.
    fn depenetrate(&mut self, phys: &Phys) {
        let (c, resolved) = phys.depenetrate(self.capsule_center(), Self::HALF, RADIUS);
        self.pos = [c[0], c[1] - HEIGHT / 2.0, c[2]];
        self.embedded = !resolved;
    }

    /// One tick: `wish` is the camera-relative input direction (unit or zero).
    pub fn update(&mut self, phys: &Phys, dt: f32, wish: [f32; 2], jump: bool) {
        self.depenetrate(phys);
        let ground = self.ground_hit(phys);
        let feet_gap = ground.map_or(f32::INFINITY, |(y, _)| self.pos[1] - y);
        let walkable = ground.is_some_and(|(_, n)| n[1] >= MAX_SLOPE_COS);
        let supported = walkable && feet_gap <= SNAP_DIST && self.vel[1] <= 0.01;
        self.on_ground = supported;
        self.coyote = if supported {
            0.12
        } else {
            (self.coyote - dt).max(0.0)
        };

        // Horizontal velocity toward the wish direction. On a slope the wish
        // is projected onto the ground plane so uphill/downhill runs slower;
        // only the horizontal part goes into `vel` — elevation is handled by
        // ground snapping and the step-up assist, never by vertical velocity,
        // so climbing a ramp doesn't read as "rising" and go ballistic.
        let mut target = [wish[0] * RUN_SPEED, 0.0, wish[1] * RUN_SPEED];
        if supported && (wish[0] != 0.0 || wish[1] != 0.0) {
            if let Some((_, n)) = ground {
                let w = [wish[0], 0.0, wish[1]];
                let dot = w[0] * n[0] + w[1] * n[1] + w[2] * n[2];
                let along = [w[0] - n[0] * dot, w[1] - n[1] * dot, w[2] - n[2] * dot];
                let l = (along[0] * along[0] + along[1] * along[1] + along[2] * along[2]).sqrt();
                if l > 1e-6 {
                    target = [along[0] / l * RUN_SPEED, 0.0, along[2] / l * RUN_SPEED];
                }
            }
        }
        let control = if supported { 1.0 } else { AIR_CONTROL };
        let k = (ACCEL * control * dt * 0.12).min(1.0);
        self.vel[0] += (target[0] - self.vel[0]) * k;
        self.vel[2] += (target[2] - self.vel[2]) * k;
        if supported {
            self.vel[1] = 0.0;
        }

        // jumping (with coyote time)
        if jump {
            if !self.jump_held && (supported || self.coyote > 0.0) {
                self.vel[1] = JUMP_V;
                self.coyote = 0.0;
                self.on_ground = false;
            }
            self.jump_held = true;
        } else {
            self.jump_held = false;
        }

        if !self.on_ground || self.vel[1] > 0.0 {
            self.vel[1] -= GRAVITY * dt;
        }

        // horizontal move with step-up assist
        let mx = self.vel[0] * dt;
        let mz = self.vel[2] * dt;
        let before = self.pos;
        self.move_horizontal(phys, mx, mz);
        let adv = ((self.pos[0] - before[0]).powi(2) + (self.pos[2] - before[2]).powi(2)).sqrt();
        let want = (mx * mx + mz * mz).sqrt();
        if self.on_ground && want > 1e-4 && adv < want * 0.5 {
            let saved = self.pos;
            self.pos = [before[0], before[1] + STEP_HEIGHT, before[2]];
            self.move_horizontal(phys, mx, mz);
            let adv2 =
                ((self.pos[0] - before[0]).powi(2) + (self.pos[2] - before[2]).powi(2)).sqrt();
            let g2 = self.ground_hit(phys);
            let ok = adv2 > adv + 1e-3
                && g2.is_some_and(|(y, n)| {
                    n[1] >= MAX_SLOPE_COS && self.pos[1] - y <= STEP_HEIGHT + 0.1
                });
            if ok {
                self.pos[1] = g2.unwrap().0;
            } else {
                self.pos = saved;
            }
        }

        // vertical: swept with the full capsule in BOTH directions so fast
        // falls (or rises) can never tunnel through geometry
        let dy = self.vel[1] * dt;
        if dy > 0.0 {
            match phys.cast_capsule(self.capsule_center(), Self::HALF, RADIUS, [0.0, 1.0, 0.0], dy + SKIN) {
                Some((toi, _)) => {
                    self.pos[1] += (toi - SKIN).max(0.0);
                    self.vel[1] = 0.0;
                }
                None => self.pos[1] += dy,
            }
        } else if dy < 0.0 {
            match phys.cast_capsule(self.capsule_center(), Self::HALF, RADIUS, [0.0, -1.0, 0.0], -dy + SKIN) {
                Some((toi, n)) => {
                    self.pos[1] -= (toi - SKIN).max(0.0);
                    if n[1] >= MAX_SLOPE_COS {
                        self.vel[1] = 0.0;
                        self.on_ground = true;
                    }
                    // steep surface: keep falling; the slide branch below
                    // (and depenetration) handle resting against it
                }
                None => self.pos[1] += dy,
            }
        }

        if let Some((gy, n)) = self.ground_hit(phys) {
            if self.vel[1] <= 0.0 {
                let gap = self.pos[1] - gy;
                let can_stand = n[1] >= MAX_SLOPE_COS;
                let snap = if self.on_ground || can_stand { SNAP_DIST } else { 0.02 };
                // upward snap is bounded by step height: a rim probe grazing
                // a high ledge (or a steep face read as "ground") must never
                // yank the player up onto it
                if gap <= snap && gap >= -(STEP_HEIGHT + 0.1) && can_stand {
                    self.pos[1] = gy;
                    self.vel[1] = 0.0;
                    self.on_ground = true;
                } else if (-0.05..=0.02).contains(&gap) && !can_stand {
                    // too steep: slide downhill (no position change — the
                    // swept fall already stopped at the surface)
                    self.vel[0] += n[0] * GRAVITY * dt * 0.8;
                    self.vel[2] += n[2] * GRAVITY * dt * 0.8;
                    self.vel[1] = self.vel[1].min(-0.5);
                }
            }
        }

        // final safety: eject any overlap this tick's moves left behind
        self.depenetrate(phys);

        // fell off the world
        if self.pos[1] < -128.0 {
            self.pos = self.spawn;
            self.vel = [0.0; 3];
        }

        // facing follows horizontal motion
        let hv = (self.vel[0] * self.vel[0] + self.vel[2] * self.vel[2]).sqrt();
        if hv > 0.5 {
            let want = self.vel[0].atan2(self.vel[2]);
            let mut d = want - self.facing;
            while d > core::f32::consts::PI {
                d -= 2.0 * core::f32::consts::PI;
            }
            while d < -core::f32::consts::PI {
                d += 2.0 * core::f32::consts::PI;
            }
            self.facing += d * (12.0 * dt).min(1.0);
        }
    }
}

impl Default for Player {
    fn default() -> Self {
        Self::new()
    }
}
