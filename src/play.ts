import * as THREE from 'three';
import type { WorldHandle } from './world';
import type { Viewport } from './viewport';

// Body dimensions mirror boxcore::physics (world scale ≈ 2 units per meter).
const RADIUS = 0.9;
const HEIGHT = 3.5;
const EYE_HEIGHT = 2.9; // camera focus height on the body
const FOCUS_SMOOTH = 10; // 1/s — how fast the camera focus catches up
const BOOM_IN = 12; // 1/s — boom pull-in toward a shorter target (fast)
const BOOM_OUT = 2; // 1/s — boom ease back out when space opens (slow)
// body fade: fully opaque beyond FADE_FAR, alpha 0.1 at FADE_NEAR
const FADE_NEAR = 2.0;
const FADE_FAR = 6.0;

/**
 * Third-person play mode shell. All physics — collision, gravity, jumping,
 * slopes, stepping — runs in the Rust core (boxcore::physics, rapier3d
 * queries over per-chunk trimeshes). This class only maps input to a wish
 * direction, mirrors the resulting pose onto a mesh, and drives the chase
 * camera: the focus point is smoothed (swivel stays snappy), and the boom
 * length is the core's stateless cone-cast (`camera_boom`, docs/camera.md)
 * plus a light fast-in/slow-out smoothing, hard-clamped to line of sight.
 * The body fades out as the camera closes in so it never fills the screen.
 */
export class PlayController {
  readonly group = new THREE.Group();
  pos = new THREE.Vector3();
  onGround = false;

  private body: THREE.Mesh;
  private mats: THREE.MeshBasicMaterial[];
  private facing = 0;
  private focus = new THREE.Vector3();
  private boom = -1; // smoothed boom length (-1 = uninitialized)

  constructor(private world: WorldHandle) {
    const geo = new THREE.CylinderGeometry(RADIUS, RADIUS, HEIGHT, 24);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb454 });
    this.body = new THREE.Mesh(geo, mat);
    // simple facing indicator: a darker nose strip
    const noseMat = new THREE.MeshBasicMaterial({ color: 0x8a5a1e });
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.25, HEIGHT * 0.5, 0.35), noseMat);
    nose.position.set(0, HEIGHT * 0.15, -RADIUS);
    this.body.add(nose);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x15171b });
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), eyeMat);
    eye.position.set(0, HEIGHT * 0.35, -RADIUS * 0.85);
    this.body.add(eye);
    this.group.add(this.body);
    // the camera can get close: render both sides and allow fading
    this.mats = [mat, noseMat, eyeMat];
    for (const m of this.mats) {
      m.side = THREE.DoubleSide;
      m.transparent = true;
    }
  }

  /** Drop the player onto the ground near a point (or hover if there's none). */
  spawnAt(x: number, z: number): void {
    const p = this.world.playerSpawn(x, z);
    this.pos.set(p.x, p.y, p.z);
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
    const r = this.world.playerUpdate(dt, wish.x, wish.z, held(' '));
    this.pos.set(r.pos.x, r.pos.y, r.pos.z);
    this.facing = r.facing;
    this.onGround = r.onGround;
    this.syncMesh();

    // -- chase camera: smooth only the focus point; swivel stays snappy
    const want = new THREE.Vector3(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
    this.focus.lerp(want, 1 - Math.exp(-FOCUS_SMOOTH * dt));
    viewport.target.copy(this.focus);

    // -- boom: stateless cone-cast target, smoothed fast-in/slow-out; the
    // thin line-of-sight distance is a hard clamp so the smoothing lag can
    // never push the camera into geometry
    const cp = Math.cos(viewport.pitch);
    const back = {
      x: cp * Math.cos(viewport.yaw),
      y: Math.sin(viewport.pitch),
      z: cp * Math.sin(viewport.yaw),
    };
    const cb = this.world.cameraBoom(
      { x: this.focus.x, y: this.focus.y, z: this.focus.z },
      back,
      viewport.dist,
    );
    if (this.boom < 0) this.boom = cb.boom;
    const k = cb.boom < this.boom ? BOOM_IN : BOOM_OUT;
    this.boom += (cb.boom - this.boom) * (1 - Math.exp(-k * dt));
    this.boom = Math.min(this.boom, cb.los);
    viewport.distClamp = this.boom;

    // -- fade the body out as the camera closes in
    const camDist = Math.min(viewport.dist, this.boom);
    const alpha = THREE.MathUtils.clamp(
      0.1 + 0.9 * ((camDist - FADE_NEAR) / (FADE_FAR - FADE_NEAR)),
      0.1,
      1,
    );
    for (const m of this.mats) m.opacity = alpha;
  }

  private syncMesh(): void {
    this.body.position.set(this.pos.x, this.pos.y + HEIGHT / 2, this.pos.z);
    this.body.rotation.y = this.facing + Math.PI;
  }
}
