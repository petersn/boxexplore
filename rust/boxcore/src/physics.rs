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

    /// Stateless chase-camera boom length (no smoothing, no history — the
    /// same player position and view always give the same camera distance).
    ///
    /// Spherecast the boom direction at a ladder of radii from RMIN (the
    /// camera's physical radius) to RMAX. Each sample is judged against a
    /// fixed-slope linear trend: a hit at radius r and distance d costs
    /// `d + K·(r − RMIN)` — trading K units of boom length per unit of
    /// obstacle margin. The boom is the minimum such cost, i.e. the lowest
    /// point the clearance-vs-radius curve dips below the trend line, read
    /// back at RMIN. This is a discretized CONE cast (half-angle atan(1/K)):
    /// as the player walks toward a ceiling edge, the largest radius that
    /// still slips past shrinks continuously, so the boom glides from the
    /// open-field distance down to the under-ceiling line-of-sight distance
    /// with no snap — and settles AT that distance, since versus a surface
    /// parallel to the boom the credit K outweighs the clearance loss.
    ///
    /// The coarse ladder alone quantizes the result (the winning rung moves
    /// in steps of K·Δr as an edge sweeps past), so after picking a winner
    /// the cliff edge between it and its free neighbor is bisected —
    /// clearance is monotone non-increasing in radius, which makes that
    /// search sound — and the minimum cost over every cast wins.
    ///
    /// Grazing filter: geometry the sweep slides PAST must not pull the
    /// camera in — hugging a wall while looking along it would otherwise
    /// cost credit-only (a trimesh reports fresh triangle contacts at
    /// toi≈0 even with stop_at_penetration=false). Each anticipation
    /// sample is weighted by how much its hit normal opposes the sweep:
    /// a ceiling ahead counts fully, a parallel wall not at all, with a
    /// smooth ramp between so camera swivel can't pop the boom.
    ///
    /// Returns [boom, los]: `los` is the thin-sphere line-of-sight distance
    /// (the hard never-clip ceiling for any smoothing the shell adds).
    /// Design notes + the alternatives we tried: docs/camera.md.
    pub fn camera_boom(&self, focus: V3, dir: V3, max_dist: f32) -> [f32; 2] {
        const SAMPLES: usize = 14;
        const REFINE: usize = 7;
        let k = max_dist.max(4.0) / (CAM_RMAX - CAM_RMIN);
        // sample cost: hit distance blended toward "unobstructed" by how
        // grazing the contact is, plus the radius credit
        let sample = |r: f32| -> (f32, f32) {
            match self.cast_ball(focus, r, dir, max_dist) {
                // toi ≈ 0 = the sample sphere already overlaps geometry AT
                // the focus (the wall beside the player, the floor below) —
                // that is the player's vicinity, not the camera path, and
                // trimesh penetration contacts carry noise normals anyway.
                // Short-range camera safety is the thin LoS cast's job.
                None => (max_dist, max_dist + k * (r - CAM_RMIN)),
                Some((toi, _)) if toi < 0.05 => {
                    (toi, max_dist + k * (r - CAM_RMIN))
                }
                Some((toi, n)) => {
                    // cast_ball flips n to oppose dir, so this is ≥ 0
                    let align = -(n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]);
                    let w = ((align - 0.10) / 0.15).clamp(0.0, 1.0);
                    let d_eff = toi * w + max_dist * (1.0 - w);
                    (toi, d_eff + k * (r - CAM_RMIN))
                }
            }
        };
        let radius = |i: usize| CAM_RMIN + (CAM_RMAX - CAM_RMIN) * i as f32 / SAMPLES as f32;
        let dmax = self.clearance(focus, dir, max_dist, CAM_RMIN);
        let mut d = [0f32; SAMPLES + 1];
        d[0] = dmax;
        let mut best = (dmax, CAM_RMIN);
        for i in 1..=SAMPLES {
            let (toi, cost) = sample(radius(i));
            d[i] = toi;
            if cost < best.0 {
                best = (cost, radius(i));
            }
        }
        // localize the cliff edge left of the winning rung (bisection is
        // driven by the raw monotone hit distances, cost by the weighted)
        let win = ((best.1 - CAM_RMIN) / (CAM_RMAX - CAM_RMIN) * SAMPLES as f32).round() as usize;
        if win > 0 {
            let (mut lo, mut hi) = (radius(win - 1), radius(win));
            let (mut dlo, mut dhi) = (d[win - 1], d[win]);
            for _ in 0..REFINE {
                let mid = 0.5 * (lo + hi);
                let (dm, cost) = sample(mid);
                if cost < best.0 {
                    best = (cost, mid);
                }
                if dm > 0.5 * (dlo + dhi) {
                    lo = mid;
                    dlo = dm;
                } else {
                    hi = mid;
                    dhi = dm;
                }
            }
        }
        // never usefully closer than ~1 unit (unless the pocket truly is)
        let boom = best.0.max(1.0f32.min(dmax)).min(max_dist);
        [boom, dmax]
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
        // deepest contact at a candidate center: (penetration depth ≥ 0, normal)
        let deepest = |c: V3| -> (f32, V3) {
            let lo = [c[0] - reach_xz, c[1] - reach_y, c[2] - reach_xz];
            let hi = [c[0] + reach_xz, c[1] + reach_y, c[2] + reach_xz];
            let pose = Pose::from_translation(vec(c));
            let mut worst = (0.0f32, [0.0f32; 3]);
            for h in self.handles_near(lo, hi) {
                let co = &self.colliders[h];
                if let Ok(Some(ct)) = contact(co.position(), co.shape(), &pose, &capsule, 0.0) {
                    if -ct.dist > worst.0 {
                        // normal1 points from the world geometry toward the capsule
                        worst = (-ct.dist, v3(ct.normal1));
                    }
                }
            }
            worst
        };
        let mut c = center;
        let (mut depth, mut n) = deepest(c);
        for _ in 0..4 {
            if depth <= TOLERANCE {
                return (c, true);
            }
            let push = depth + TOLERANCE;
            let c2 = [c[0] + n[0] * push, c[1] + n[1] * push, c[2] + n[2] * push];
            let (d2, n2) = deepest(c2);
            // Monotone descent only: in a squeeze (sill below, slanted
            // lintel above) the deepest contact's push points INTO the
            // pinch — accepting it would ratchet the capsule deeper every
            // tick and cancel the player's escape input. A stable partial
            // overlap is strictly better; the penetration-tolerant sweeps
            // still move the player out along the surfaces.
            if d2 >= depth {
                return (c, false);
            }
            c = c2;
            depth = d2;
            n = n2;
        }
        (c, depth <= TOLERANCE)
    }
}

// ---------------------------------------------------------------------------
// Character controller (hand-rolled kinematics over rapier queries)
// ---------------------------------------------------------------------------

pub const RADIUS: f32 = 0.9;
pub const HEIGHT: f32 = 3.5;
/// Camera boom sphere-ladder anchors: RMIN is the camera's physical radius
/// (a boom ≤ clearance(RMIN) can never clip), RMAX the anticipation reach.
pub const CAM_RMIN: f32 = 0.4;
pub const CAM_RMAX: f32 = 2.5;
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
    /// Resting against unwalkable geometry and losing traction (SM64-style
    /// slip): downhill acceleration applies, but jumping out is allowed.
    pub sliding: bool,
    coyote: f32,
    jump_held: bool,
    /// Consecutive ticks spent effectively stationary without walkable
    /// ground (wedged in a crease, balanced on a ledge lip). Stability
    /// implies support: REST_BRACE of these grant jumping, so "I'm not
    /// falling but I can't jump" can't happen. The threshold is ~1/6 s on
    /// purpose: a transient wall-graze at jump apex must NOT grant a tech
    /// jump (it read as a surprise wall-jump), only persistent stuck-ness.
    rest_ticks: u32,
    /// Normal of the unwalkable surface currently carrying us (slide or
    /// arrested fall). A jump from such a brace kicks off along it, so
    /// steep faces can be teched out of but never ratcheted up.
    brace_normal: V3,
    /// Control lockout after a tech-out jump — the kick must actually
    /// separate us from the face before input can steer back into it.
    tech_timer: f32,
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
            sliding: false,
            coyote: 0.0,
            jump_held: false,
            rest_ticks: 0,
            brace_normal: [0.0; 3],
            tech_timer: 0.0,
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

    /// Horizontal move with capsule sweeps + wall sliding. Returns whether a
    /// non-walkable contact (a wall) blocked part of the motion.
    fn move_horizontal(&mut self, phys: &Phys, mut mx: f32, mut mz: f32) -> bool {
        let half = (HEIGHT - 2.0 * RADIUS) / 2.0;
        let mut hit_wall = false;
        for _ in 0..2 {
            let len = (mx * mx + mz * mz).sqrt();
            if len < 1e-6 {
                return hit_wall;
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
                    return hit_wall;
                }
                Some((toi, n)) => {
                    let allowed = (toi - SKIN).clamp(0.0, len);
                    self.pos[0] += dir[0] * allowed;
                    self.pos[2] += dir[2] * allowed;
                    let rest = len - allowed;
                    let rx = dir[0] * rest;
                    let rz = dir[2] * rest;
                    if n[1] >= MAX_SLOPE_COS || n[1] <= -0.2 {
                        // not a wall: a walkable slope (ride up it) or an
                        // overhead plane like a slanted lintel (slide DOWN
                        // along it — the escape route out of a pinch is
                        // down-and-out, and a horizontal-only slide would
                        // read the ceiling as an unpassable wall). Deflect
                        // the remaining motion along the plane in full 3D.
                        let dot = rx * n[0] + rz * n[2];
                        self.pos[0] += rx - n[0] * dot;
                        self.pos[1] += -n[1] * dot;
                        self.pos[2] += rz - n[2] * dot;
                        return hit_wall;
                    }
                    hit_wall = true;
                    // slide the remainder (and velocity) along the wall
                    let mut wall = [n[0], 0.0, n[2]];
                    let wl = (wall[0] * wall[0] + wall[2] * wall[2]).sqrt();
                    if wl < 1e-6 {
                        return hit_wall;
                    }
                    wall = [wall[0] / wl, 0.0, wall[2] / wl];
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
        hit_wall
    }

    fn capsule_center(&self) -> V3 {
        [self.pos[0], self.pos[1] + HEIGHT / 2.0, self.pos[2]]
    }

    const HALF: f32 = (HEIGHT - 2.0 * RADIUS) / 2.0;

    /// Swept ground snap: lower the capsule by up to `max_drop`, stopping at
    /// first contact — unlike a ray-based teleport, this can never place the
    /// body inside a slope plane. Returns the contact normal if support hit.
    fn snap_down(&mut self, phys: &Phys, max_drop: f32) -> Option<V3> {
        match phys.cast_capsule(
            self.capsule_center(),
            Self::HALF,
            RADIUS,
            [0.0, -1.0, 0.0],
            max_drop + SKIN,
        ) {
            Some((toi, n)) => {
                self.pos[1] -= (toi - SKIN).max(0.0);
                Some(n)
            }
            None => None,
        }
    }

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
        let y_start = self.pos[1];
        let ground = self.ground_hit(phys);
        let feet_gap = ground.map_or(f32::INFINITY, |(y, _)| self.pos[1] - y);
        let walkable = ground.is_some_and(|(_, n)| n[1] >= MAX_SLOPE_COS);
        let supported = walkable && feet_gap <= SNAP_DIST && self.vel[1] <= 0.01;
        // anything stable enough to stand on is stable enough to jump from
        const REST_BRACE: u32 = 10;
        let braced = supported || self.sliding || self.rest_ticks >= REST_BRACE;
        self.sliding = false;
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
        self.tech_timer = (self.tech_timer - dt).max(0.0);
        let control = if self.tech_timer > 0.0 {
            0.0
        } else if braced {
            1.0
        } else {
            AIR_CONTROL
        };
        let k = (ACCEL * control * dt * 0.12).min(1.0);
        self.vel[0] += (target[0] - self.vel[0]) * k;
        self.vel[2] += (target[2] - self.vel[2]) * k;
        if supported {
            self.vel[1] = 0.0;
        }

        // jumping — from solid ground, coyote time, a slide (tech out of
        // losing traction), or any braced rest against geometry
        if jump {
            if !self.jump_held && (braced || self.coyote > 0.0) {
                if supported || self.coyote > 0.0 {
                    self.vel[1] = JUMP_V;
                } else {
                    // teching out of a steep surface: a weaker hop that
                    // kicks off along the face normal, with control locked
                    // out briefly so the kick actually separates — escape
                    // is always possible, jump-mash climbing never is
                    self.vel[1] = JUMP_V * 0.75;
                    let bn = self.brace_normal;
                    let h = (bn[0] * bn[0] + bn[2] * bn[2]).sqrt();
                    if h > 1e-3 {
                        self.vel[0] += bn[0] / h * RUN_SPEED * 0.8;
                        self.vel[2] += bn[2] / h * RUN_SPEED * 0.8;
                    }
                    self.tech_timer = 0.35;
                }
                self.coyote = 0.0;
                self.on_ground = false;
                self.rest_ticks = 0;
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
        let hit_wall = self.move_horizontal(phys, mx, mz);
        let adv = ((self.pos[0] - before[0]).powi(2) + (self.pos[2] - before[2]).powi(2)).sqrt();
        let want = (mx * mx + mz * mz).sqrt();
        if self.on_ground && want > 1e-4 && (hit_wall || adv < want * 0.5) {
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
                self.snap_down(phys, STEP_HEIGHT + 0.1);
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
                    } else {
                        // steep surface arrested the fall: remember it as
                        // the brace (a later slide/rest jump kicks off it)
                        self.brace_normal = n;
                    }
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
                    if gap > 0.0 {
                        self.snap_down(phys, gap + 0.02);
                    }
                    self.vel[1] = 0.0;
                    self.on_ground = true;
                } else if (-0.05..=0.02).contains(&gap) && !can_stand {
                    // too steep: losing traction — slide downhill
                    self.sliding = true;
                    self.brace_normal = n;
                    self.vel[0] += n[0] * GRAVITY * dt * 0.8;
                    self.vel[2] += n[2] * GRAVITY * dt * 0.8;
                    self.vel[1] = self.vel[1].min(-0.5);
                }
            }
        }

        // final safety: eject any overlap this tick's moves left behind
        self.depenetrate(phys);

        // Rest detection: gravity ran this tick, yet we barely descended and
        // aren't moving up — something is holding us (a crease, a ledge lip
        // the ray probes miss). Two such ticks make us "braced" above.
        let fell = self.pos[1] < y_start - GRAVITY * dt * dt * 0.5 - 0.005;
        if !self.on_ground && !fell && self.vel[1] <= 0.01 {
            self.rest_ticks = self.rest_ticks.saturating_add(1);
            // whatever we rest on carries our weight: don't bank fall speed
            self.vel[1] = self.vel[1].max(-2.0);
        } else {
            self.rest_ticks = 0;
        }

        // fell off the world
        if self.pos[1] < -128.0 {
            self.pos = self.spawn;
            self.vel = [0.0; 3];
        }

        // facing follows horizontal motion (but not the involuntary tech
        // kick — turning away from the wall read as a wall-jump move)
        let hv = (self.vel[0] * self.vel[0] + self.vel[2] * self.vel[2]).sqrt();
        if hv > 0.5 && self.tech_timer <= 0.0 {
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
