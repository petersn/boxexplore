import * as THREE from 'three';
import type { ChunkRenderer } from './render';
import type { Viewport } from './viewport';

// World scale ≈ 2 units per meter (the player is 3.5u ≈ 1.75 m tall).
const RADIUS = 0.9;
const HEIGHT = 3.5;
const GRAVITY = 22.0; // u/s²
const RUN_SPEED = 11.0; // u/s
const AIR_CONTROL = 0.35;
const ACCEL = 60.0;
const JUMP_V = 10.0; // ≈ 2.3u jump apex
const MAX_SLOPE_COS = Math.cos((50 * Math.PI) / 180); // climb up to 50°
const STEP_HEIGHT = 0.55; // auto-step onto half-cell ledges
const SNAP_DIST = 0.35; // ground magnetism while walking
const SKIN = 0.05;
const EYE_HEIGHT = 2.9; // camera focus height on the body

/**
 * Third-person character controller: a 0.9-radius, 3.5-tall cylinder driven
 * by WASD relative to the camera, with gravity, jumping, wall sliding,
 * auto-step, and ground snapping. Collision uses raycasts against the
 * rendered (displaced) surface, so what you see is what you collide with;
 * slopes up to 50° are walkable, steeper is a slide.
 */
export class PlayController {
  readonly group = new THREE.Group();
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  onGround = false;

  private body: THREE.Mesh;
  private ray = new THREE.Raycaster();
  private coyote = 0;
  private jumpHeld = false;
  private facing = 0;
  private spawn = new THREE.Vector3();

  constructor(private renderer: ChunkRenderer) {
    const geo = new THREE.CylinderGeometry(RADIUS, RADIUS, HEIGHT, 24);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb454 });
    this.body = new THREE.Mesh(geo, mat);
    // simple facing indicator: a darker nose strip
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, HEIGHT * 0.5, 0.35),
      new THREE.MeshBasicMaterial({ color: 0x8a5a1e }),
    );
    nose.position.set(0, HEIGHT * 0.15, -RADIUS);
    this.body.add(nose);
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0x15171b }),
    );
    eye.position.set(0, HEIGHT * 0.35, -RADIUS * 0.85);
    this.body.add(eye);
    this.group.add(this.body);
  }

  /** Drop the player onto the ground near a point (or hover if there's none). */
  spawnAt(x: number, z: number): void {
    const hit = this.castRay(new THREE.Vector3(x, 300, z), new THREE.Vector3(0, -1, 0), 600);
    const y = hit ? hit.point.y : 2;
    this.pos.set(x, y + 0.01, z);
    this.vel.set(0, 0, 0);
    this.spawn.copy(this.pos);
    this.syncMesh();
  }

  private castRay(origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Intersection | null {
    this.ray.set(origin, dir);
    this.ray.far = far;
    const hits = this.ray.intersectObjects(this.renderer.group.children, false);
    return hits.length ? hits[0] : null;
  }

  /** Best walkable ground hit under the cylinder (center + rim probes). */
  private groundHit(): { y: number; normal: THREE.Vector3 } | null {
    const up = new THREE.Vector3(0, 1, 0);
    const down = new THREE.Vector3(0, -1, 0);
    let best: { y: number; normal: THREE.Vector3 } | null = null;
    const probes: Array<[number, number]> = [
      [0, 0],
      [RADIUS * 0.7, 0],
      [-RADIUS * 0.7, 0],
      [0, RADIUS * 0.7],
      [0, -RADIUS * 0.7],
    ];
    for (const [ox, oz] of probes) {
      const origin = new THREE.Vector3(this.pos.x + ox, this.pos.y + 1.0, this.pos.z + oz);
      const hit = this.castRay(origin, down, 1.0 + SNAP_DIST + 0.5);
      if (!hit) continue;
      const n = hit.face ? hit.face.normal.clone() : up.clone();
      if (n.dot(up) < 0) n.negate();
      const y = hit.point.y;
      if (!best || y > best.y) best = { y, normal: n };
    }
    return best;
  }

  /** Move horizontally with wall sliding; returns the actually applied move. */
  private moveHorizontal(move: THREE.Vector3): void {
    for (let iter = 0; iter < 2; iter++) {
      const len = Math.hypot(move.x, move.z);
      if (len < 1e-6) return;
      const dir = new THREE.Vector3(move.x / len, 0, move.z / len);
      let blockedNormal: THREE.Vector3 | null = null;
      for (const h of [0.4, HEIGHT * 0.5, HEIGHT - 0.3]) {
        const origin = new THREE.Vector3(this.pos.x, this.pos.y + h, this.pos.z);
        const hit = this.castRay(origin, dir, RADIUS + SKIN + len);
        if (hit && hit.face) {
          blockedNormal = hit.face.normal.clone();
          if (blockedNormal.dot(dir) > 0) blockedNormal.negate();
          const allowed = Math.max(0, hit.distance - RADIUS - SKIN);
          // walk as far as allowed, then slide the remainder along the wall
          const applied = dir.clone().multiplyScalar(Math.min(len, allowed));
          this.pos.add(applied);
          const rest = dir.clone().multiplyScalar(len - Math.min(len, allowed));
          blockedNormal.y = 0;
          if (blockedNormal.lengthSq() > 1e-6) {
            blockedNormal.normalize();
            rest.addScaledVector(blockedNormal, -rest.dot(blockedNormal));
            // strip the into-wall velocity too
            const vn = this.vel.x * blockedNormal.x + this.vel.z * blockedNormal.z;
            if (vn < 0) {
              this.vel.x -= blockedNormal.x * vn;
              this.vel.z -= blockedNormal.z * vn;
            }
          }
          move = rest;
          break;
        }
        blockedNormal = null;
      }
      if (!blockedNormal) {
        this.pos.add(move);
        return;
      }
    }
  }

  update(dt: number, held: (k: string) => boolean, viewport: Viewport): void {
    // -- input → wish direction (camera-yaw relative)
    const f = viewport.forward();
    const fwd = new THREE.Vector3(f.x, 0, f.z);
    if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).negate();
    const wish = new THREE.Vector3();
    if (held('w')) wish.add(fwd);
    if (held('s')) wish.sub(fwd);
    if (held('d')) wish.sub(right);
    if (held('a')) wish.add(right);
    if (wish.lengthSq() > 0) wish.normalize();

    // -- ground state
    const ground = this.groundHit();
    const feetGap = ground ? this.pos.y - ground.y : Infinity;
    const walkable = !!ground && ground.normal.y >= MAX_SLOPE_COS;
    const supported = walkable && feetGap <= SNAP_DIST && this.vel.y <= 0.01;
    this.onGround = supported;
    this.coyote = supported ? 0.12 : Math.max(0, this.coyote - dt);

    // -- horizontal velocity
    let target = wish.clone().multiplyScalar(RUN_SPEED);
    if (supported && ground && wish.lengthSq() > 0) {
      // walk along the slope so ramps up to 50° climb smoothly
      const n = ground.normal;
      const along = wish.clone().addScaledVector(n, -wish.dot(n));
      if (along.lengthSq() > 1e-6) {
        along.normalize().multiplyScalar(RUN_SPEED);
        target = along;
      }
    }
    const control = supported ? 1 : AIR_CONTROL;
    this.vel.x += (target.x - this.vel.x) * Math.min(1, ACCEL * control * dt * 0.12);
    this.vel.z += (target.z - this.vel.z) * Math.min(1, ACCEL * control * dt * 0.12);
    if (supported) this.vel.y = Math.max(0, target.y);

    // -- jumping
    if (held(' ')) {
      if (!this.jumpHeld && (supported || this.coyote > 0)) {
        this.vel.y = JUMP_V;
        this.coyote = 0;
        this.onGround = false;
      }
      this.jumpHeld = true;
    } else {
      this.jumpHeld = false;
    }

    // -- gravity
    if (!supported || this.vel.y > 0) {
      this.vel.y -= GRAVITY * dt;
    }

    // -- integrate: horizontal with step assist, then vertical
    const move = new THREE.Vector3(this.vel.x * dt, 0, this.vel.z * dt);
    const before = this.pos.clone();
    this.moveHorizontal(move.clone());
    const advanced = this.pos.clone().sub(before).length();
    if (supported && advanced < move.length() * 0.5 && move.length() > 1e-4) {
      // blocked at the feet: try again from step height (climb small ledges)
      const retryFrom = before.clone().add(new THREE.Vector3(0, STEP_HEIGHT, 0));
      const saved = this.pos.clone();
      this.pos.copy(retryFrom);
      this.moveHorizontal(move.clone());
      const retryAdvance = new THREE.Vector3(this.pos.x - before.x, 0, this.pos.z - before.z).length();
      const g2 = this.groundHit();
      if (retryAdvance > advanced + 1e-3 && g2 && g2.normal.y >= MAX_SLOPE_COS && this.pos.y - g2.y <= STEP_HEIGHT + 0.1) {
        this.pos.y = g2.y;
      } else {
        this.pos.copy(saved);
      }
    }

    // vertical motion + ceiling
    let dy = this.vel.y * dt;
    if (dy > 0) {
      const head = this.castRay(
        new THREE.Vector3(this.pos.x, this.pos.y + HEIGHT - 0.1, this.pos.z),
        new THREE.Vector3(0, 1, 0),
        dy + 0.15,
      );
      if (head) {
        dy = Math.max(0, head.distance - 0.15);
        this.vel.y = 0;
      }
    }
    this.pos.y += dy;

    // ground landing / snapping
    const g = this.groundHit();
    if (g && this.vel.y <= 0) {
      const gap = this.pos.y - g.y;
      const canStand = g.normal.y >= MAX_SLOPE_COS;
      if (gap <= (this.onGround || canStand ? SNAP_DIST : 0.02) && canStand) {
        this.pos.y = g.y;
        this.vel.y = 0;
        this.onGround = true;
      } else if (gap <= 0.02 && !canStand) {
        // steep slope: rest against it but slide
        this.pos.y = g.y;
        const n = g.normal;
        const slide = new THREE.Vector3(n.x, 0, n.z).multiplyScalar(GRAVITY * dt * 0.8);
        this.vel.add(slide);
        this.vel.y = Math.min(this.vel.y, -0.5);
      }
    }

    // fell off the world
    if (this.pos.y < -128) {
      this.pos.copy(this.spawn);
      this.vel.set(0, 0, 0);
    }

    // -- facing + camera follow
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (hv > 0.5) {
      const want = Math.atan2(this.vel.x, this.vel.z);
      let d = want - this.facing;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.facing += d * Math.min(1, 12 * dt);
    }
    this.syncMesh();
    viewport.target.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
  }

  private syncMesh(): void {
    this.body.position.set(this.pos.x, this.pos.y + HEIGHT / 2, this.pos.z);
    this.body.rotation.y = this.facing + Math.PI;
  }
}
