import * as THREE from 'three';
import type { WorldHandle } from './world';
import type { Viewport } from './viewport';

// Body dimensions mirror boxcore::physics (world scale ≈ 2 units per meter).
const RADIUS = 0.9;
const HEIGHT = 3.5;
const EYE_HEIGHT = 2.9; // camera focus height on the body
const FOCUS_SMOOTH = 10; // 1/s — how fast the camera focus catches up
const PLOT_SAMPLES = 36; // debug plot: clearance curve resolution

/**
 * Third-person play mode shell. All physics — collision, gravity, jumping,
 * slopes, stepping — runs in the Rust core (boxcore::physics, rapier3d
 * queries over per-chunk trimeshes). This class only maps input to a wish
 * direction, mirrors the resulting pose onto a mesh, and drives the chase
 * camera: the focus point is smoothed (swivel stays snappy) and the boom
 * length is the core's stateless cone-cast (`camera_boom`) — same position
 * and view always give the same distance, gliding in near ceilings/walls
 * instead of snapping. Press C in play mode for the radius→distance debug
 * plot behind that decision.
 */
export class PlayController {
  readonly group = new THREE.Group();
  pos = new THREE.Vector3();
  onGround = false;

  private body: THREE.Mesh;
  private facing = 0;
  private focus = new THREE.Vector3();
  private plot: HTMLCanvasElement | null = null;
  private plotOn = true;

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
    this.focus.set(p.x, p.y + EYE_HEIGHT, p.z);
    this.syncMesh();
  }

  /** C key: show/hide the camera-boom debug plot. */
  togglePlot(): void {
    this.plotOn = !this.plotOn;
    if (this.plot) this.plot.style.display = this.plotOn ? 'block' : 'none';
  }

  /** Remove DOM leftovers when leaving play mode. */
  dispose(): void {
    this.plot?.remove();
    this.plot = null;
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

    // -- boom length: the core's stateless cone-cast over sphere radii
    const cp2 = Math.cos(viewport.pitch);
    const back = {
      x: cp2 * Math.cos(viewport.yaw),
      y: Math.sin(viewport.pitch),
      z: cp2 * Math.sin(viewport.yaw),
    };
    const fp = { x: this.focus.x, y: this.focus.y, z: this.focus.z };
    const cb = this.world.cameraBoom(fp, back, viewport.dist);
    viewport.distClamp = cb.boom;
    if (this.plotOn) this.drawPlot(fp, back, viewport.dist, cb);
  }

  /**
   * Debug plot of the camera decision: the sampled clearance-vs-radius
   * curve (cyan), dmin/dmax anchor levels, the fixed-slope trend line
   * through the winning sample (its intercept at rmin IS the boom), and
   * the chosen point. Everything camera_boom sees, drawn per frame.
   */
  private drawPlot(
    fp: { x: number; y: number; z: number },
    back: { x: number; y: number; z: number },
    dist: number,
    cb: { boom: number; rstar: number; dmin: number; dmax: number; rmin: number; rmax: number; k: number },
  ): void {
    if (!this.plot) {
      this.plot = document.createElement('canvas');
      this.plot.width = 320;
      this.plot.height = 200;
      this.plot.style.cssText =
        'position:absolute;right:12px;bottom:34px;background:rgba(12,14,18,0.82);' +
        'border:1px solid #2a2f3a;border-radius:4px;pointer-events:none;z-index:30;';
      document.getElementById('viewport-wrap')!.appendChild(this.plot);
      this.plot.style.display = this.plotOn ? 'block' : 'none';
    }
    const g = this.plot.getContext('2d')!;
    const W = this.plot.width;
    const H = this.plot.height;
    const mL = 34;
    const mR = 10;
    const mT = 16;
    const mB = 24;
    const rSpan = cb.rmax - cb.rmin;
    const X = (r: number) => mL + ((r - cb.rmin) / rSpan) * (W - mL - mR);
    const Y = (d: number) => H - mB - (Math.min(d, dist) / dist) * (H - mT - mB);
    g.clearRect(0, 0, W, H);
    g.font = '10px monospace';

    // axes
    g.strokeStyle = '#3a4150';
    g.beginPath();
    g.moveTo(mL, mT);
    g.lineTo(mL, H - mB);
    g.lineTo(W - mR, H - mB);
    g.stroke();
    g.fillStyle = '#8a93a5';
    g.fillText('radius →', W - 60, H - 8);
    g.fillText(cb.rmin.toFixed(1), mL - 4, H - 10);
    g.fillText(cb.rmax.toFixed(1), W - mR - 16, H - 10);

    // dmin / dmax levels
    g.strokeStyle = '#5a6274';
    g.setLineDash([3, 3]);
    for (const [d, label] of [
      [cb.dmax, `dmax ${cb.dmax.toFixed(1)}`],
      [cb.dmin, `dmin ${cb.dmin.toFixed(1)}`],
    ] as Array<[number, string]>) {
      g.beginPath();
      g.moveTo(mL, Y(d));
      g.lineTo(W - mR, Y(d));
      g.stroke();
      g.fillText(label, mL + 4, Y(d) - 3);
    }
    g.setLineDash([]);

    // sampled clearance curve
    g.strokeStyle = '#57d3f2';
    g.beginPath();
    for (let i = 0; i <= PLOT_SAMPLES; i++) {
      const r = cb.rmin + (rSpan * i) / PLOT_SAMPLES;
      const d = this.world.cameraClearance(fp, back, dist, r);
      if (i === 0) g.moveTo(X(r), Y(d));
      else g.lineTo(X(r), Y(d));
    }
    g.stroke();

    // fixed-slope trend line through the winning sample: d = boom − k·(r − rmin)
    g.strokeStyle = '#ffb454';
    g.setLineDash([5, 3]);
    g.beginPath();
    g.moveTo(X(cb.rmin), Y(cb.boom));
    const rEnd = Math.min(cb.rmax, cb.rmin + cb.boom / cb.k);
    g.lineTo(X(rEnd), Y(cb.boom - cb.k * (rEnd - cb.rmin)));
    g.stroke();
    g.setLineDash([]);

    // chosen sample + resulting boom
    const dStar = this.world.cameraClearance(fp, back, dist, cb.rstar);
    g.fillStyle = '#ffb454';
    g.beginPath();
    g.arc(X(cb.rstar), Y(dStar), 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffe08a';
    g.beginPath();
    g.arc(X(cb.rmin), Y(cb.boom), 4, 0, Math.PI * 2);
    g.fill();
    g.fillText(`boom ${cb.boom.toFixed(1)}  r* ${cb.rstar.toFixed(2)}`, mL + 4, 12);
  }

  private syncMesh(): void {
    this.body.position.set(this.pos.x, this.pos.y + HEIGHT / 2, this.pos.z);
    this.body.rotation.y = this.facing + Math.PI;
  }
}
