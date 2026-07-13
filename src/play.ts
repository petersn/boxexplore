import * as THREE from 'three';
import type { WorldHandle } from './world';
import type { Viewport } from './viewport';

// Body dimensions mirror boxcore::physics (world scale ≈ 2 units per meter).
const RADIUS = 0.9;
const HEIGHT = 3.5;
const EYE_HEIGHT = 2.9; // camera focus height on the body
const CAM_RADIUS = 0.5; // spherecast radius for the chase camera
const FOCUS_SMOOTH = 10; // 1/s — how fast the camera focus catches up
const BOOM_IN = 9; // 1/s — pull-in toward a shorter clearance (fast)
const BOOM_OUT = 1.6; // 1/s — ease back out when space opens up (slow)
const LOOKAHEAD = [0.3, 0.6]; // s — predicted focus positions along velocity
const WHISKERS = [0.12, 0.24]; // rad — steeper-pitch probes (ceilings ahead)

/**
 * Third-person play mode shell. All physics — collision, gravity, jumping,
 * slopes, stepping — runs in the Rust core (boxcore::physics, rapier3d
 * queries over per-chunk trimeshes). This class only maps input to a wish
 * direction, mirrors the resulting pose onto a mesh, and drives the chase
 * camera: the focus point is smoothed (swivel stays snappy) and the boom is
 * clamped by a backward spherecast so the camera never enters geometry.
 */
export class PlayController {
  readonly group = new THREE.Group();
  pos = new THREE.Vector3();
  onGround = false;

  private body: THREE.Mesh;
  private facing = 0;
  private focus = new THREE.Vector3();
  private boom = -1; // smoothed boom length (-1 = uninitialized)
  private lastPos = new THREE.Vector3();

  constructor(private world: WorldHandle) {
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
    const p = this.world.playerSpawn(x, z);
    this.pos.set(p.x, p.y, p.z);
    this.lastPos.copy(this.pos);
    this.focus.set(p.x, p.y + EYE_HEIGHT, p.z);
    this.boom = -1;
    this.syncMesh();
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

    // -- step the Rust controller
    this.lastPos.copy(this.pos);
    const r = this.world.playerUpdate(dt, wish.x, wish.z, held(' '));
    this.pos.set(r.pos.x, r.pos.y, r.pos.z);
    this.facing = r.facing;
    this.onGround = r.onGround;
    this.syncMesh();

    // -- chase camera: smooth only the focus point; swivel stays snappy
    const want = new THREE.Vector3(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
    this.focus.lerp(want, 1 - Math.exp(-FOCUS_SMOOTH * dt));
    viewport.target.copy(this.focus);

    // -- boom length: predictive whisker casts + asymmetric smoothing.
    // The primary spherecast is the hard line-of-sight floor (never clip);
    // the extra samples see occlusion COMING — the focus a beat ahead along
    // our velocity, and slightly steeper boom pitches that graze ceilings
    // first — so the camera glides in before LoS actually breaks instead
    // of snapping the moment it does.
    const dir = (pitch: number, yaw: number) => ({
      x: Math.cos(pitch) * Math.cos(yaw),
      y: Math.sin(pitch),
      z: Math.cos(pitch) * Math.sin(yaw),
    });
    const fp = { x: this.focus.x, y: this.focus.y, z: this.focus.z };
    const back = dir(viewport.pitch, viewport.yaw);
    const clear = (from: { x: number; y: number; z: number }, d: typeof back) =>
      this.world.cameraClearance(from, d, viewport.dist, CAM_RADIUS);

    const primary = clear(fp, back);
    let target = primary;
    const vx = (this.pos.x - this.lastPos.x) / Math.max(dt, 1e-4);
    const vz = (this.pos.z - this.lastPos.z) / Math.max(dt, 1e-4);
    for (const t of LOOKAHEAD) {
      target = Math.min(target, clear({ x: fp.x + vx * t, y: fp.y, z: fp.z + vz * t }, back));
    }
    for (const a of WHISKERS) {
      target = Math.min(target, clear(fp, dir(Math.min(viewport.pitch + a, 1.55), viewport.yaw)));
    }

    if (this.boom < 0) this.boom = target;
    const k = target < this.boom ? BOOM_IN : BOOM_OUT;
    this.boom += (target - this.boom) * (1 - Math.exp(-k * dt));
    this.boom = Math.min(this.boom, primary); // LoS is absolute
    viewport.distClamp = this.boom;
  }

  private syncMesh(): void {
    this.body.position.set(this.pos.x, this.pos.y + HEIGHT / 2, this.pos.z);
    this.body.rotation.y = this.facing + Math.PI;
  }
}
