import type { WorldHandle } from './world';
import type { Viewport } from './viewport';
import { MVec, type Vec3, cross, norm, srgbHex, v3 } from './vec';

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
const SEG = 20;

/**
 * Third-person play mode shell. All physics runs in the Rust core
 * (boxcore::physics); rendering too (the body is uploaded as an overlay
 * triangle list each frame). This class maps input to a wish direction and
 * drives the chase camera: smoothed focus point, stateless cone-cast boom
 * (docs/camera.md) with fast-in/slow-out smoothing, hard line-of-sight clamp.
 */
export class PlayController {
  pos = new MVec();
  onGround = false;

  private facing = 0;
  private focus = new MVec();
  private boom = -1; // smoothed boom length (-1 = uninitialized)
  /** Unit-cylinder body triangles (model space), transformed every frame. */
  private model: { pos: Vec3; part: number }[] = [];

  constructor(private world: WorldHandle) {
    const tri = (part: number, a: Vec3, b: Vec3, c: Vec3) => {
      this.model.push({ pos: a, part }, { pos: b, part }, { pos: c, part });
    };
    // cylinder sides + caps
    for (let i = 0; i < SEG; i++) {
      const a0 = (i / SEG) * Math.PI * 2;
      const a1 = ((i + 1) / SEG) * Math.PI * 2;
      const p00 = v3(Math.cos(a0) * RADIUS, 0, Math.sin(a0) * RADIUS);
      const p10 = v3(Math.cos(a1) * RADIUS, 0, Math.sin(a1) * RADIUS);
      const p01 = v3(p00.x, HEIGHT, p00.z);
      const p11 = v3(p10.x, HEIGHT, p10.z);
      tri(0, p00, p10, p11);
      tri(0, p00, p11, p01);
      tri(0, v3(0, HEIGHT, 0), p11, p10); // top cap
      tri(0, v3(0, 0, 0), p00, p10); // bottom cap
    }
    // nose: a darker strip marking the facing direction (-z in model space)
    const nz = -RADIUS - 0.02;
    const w = 0.16;
    const y0 = HEIGHT * 0.35;
    const y1 = HEIGHT * 0.85;
    tri(1, v3(-w, y0, nz), v3(w, y0, nz), v3(w, y1, nz));
    tri(1, v3(-w, y0, nz), v3(w, y1, nz), v3(-w, y1, nz));
  }

  /** Drop the player onto the ground near a point (or hover if there's none). */
  spawnAt(x: number, z: number): void {
    const p = this.world.playerSpawn(x, z);
    this.pos.set(p.x, p.y, p.z);
    this.focus.set(p.x, p.y + EYE_HEIGHT, p.z);
    this.boom = -1;
    this.uploadBody(1);
  }

  update(dt: number, held: (k: string) => boolean, viewport: Viewport): void {
    // -- input → wish direction (camera-yaw relative)
    const f = viewport.forward();
    let fwd = v3(f.x, 0, f.z);
    fwd = fwd.x * fwd.x + fwd.z * fwd.z < 1e-6 ? v3(1, 0, 0) : norm(fwd);
    const right = norm(cross(fwd, v3(0, 1, 0)));
    let wx = 0;
    let wz = 0;
    if (held('w')) {
      wx += fwd.x;
      wz += fwd.z;
    }
    if (held('s')) {
      wx -= fwd.x;
      wz -= fwd.z;
    }
    if (held('d')) {
      wx += right.x;
      wz += right.z;
    }
    if (held('a')) {
      wx -= right.x;
      wz -= right.z;
    }
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-9) {
      wx /= wl;
      wz /= wl;
    }

    // -- step the Rust controller
    const r = this.world.playerUpdate(dt, wx, wz, held(' '));
    this.pos.set(r.pos.x, r.pos.y, r.pos.z);
    this.facing = r.facing;
    this.onGround = r.onGround;

    // -- chase camera: smooth only the focus point; swivel stays snappy
    const want = v3(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
    this.focus.lerp(want, 1 - Math.exp(-FOCUS_SMOOTH * dt));
    viewport.target.copy(this.focus);

    // -- boom: stateless cone-cast target, smoothed fast-in/slow-out; the
    // thin line-of-sight distance is a hard clamp so smoothing lag can
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

    // -- body: fade out as the camera closes in, transform, upload
    const camDist = Math.min(viewport.dist, this.boom);
    const alpha = Math.min(1, Math.max(0.1, 0.1 + (0.9 * (camDist - FADE_NEAR)) / (FADE_FAR - FADE_NEAR)));
    this.uploadBody(alpha);
  }

  private uploadBody(alpha: number): void {
    const body = srgbHex(0xffb454);
    const nose = srgbHex(0x8a5a1e);
    const cosF = Math.cos(this.facing + Math.PI);
    const sinF = Math.sin(this.facing + Math.PI);
    const out = new Float32Array(this.model.length * 7);
    let i = 0;
    for (const v of this.model) {
      // rotate around y by facing, translate to pos
      out[i++] = this.pos.x + v.pos.x * cosF + v.pos.z * sinF;
      out[i++] = this.pos.y + v.pos.y;
      out[i++] = this.pos.z - v.pos.x * sinF + v.pos.z * cosF;
      const c = v.part === 0 ? body : nose;
      out[i++] = c[0];
      out[i++] = c[1];
      out[i++] = c[2];
      out[i++] = alpha;
    }
    this.world.raw.gfx_set_player(out);
  }
}
