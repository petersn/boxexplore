import type { Frame } from './frame';
import { MVec, type Vec3, cross, dot, norm, sub, v3 } from './vec';
import { type Mat4, lookTo, matMul, perspective, rayDir, transform } from './mat';

const MIN_DIST = 0.5;
const MAX_DIST = 400;

export const FOV_Y = (60 * Math.PI) / 180;
export const NEAR = 0.02;
export const FAR = 4000;

export type CameraMode = 'orbit' | 'fly';

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/**
 * Camera rig, frame loop, and pointer→ray math. Rendering itself lives in
 * the Rust core (gfx.rs) — this class owns no GPU state at all; the editor's
 * tick hands the camera to `world.gfxFrame` each animation frame. Two camera
 * modes: `orbit` (CAD-style pivot around a target) and `fly` (Minecraft
 * creative-style free look).
 */
export class Viewport {
  mode: CameraMode = 'orbit';
  /** Play mode drives the camera; suspend WASD flying. */
  suspendFly = false;
  target = new MVec(0, 0.5, 0);
  /** Camera position — ground truth in fly mode, derived in orbit mode. */
  position = new MVec();
  yaw = -Math.PI / 4;
  pitch = 0.55;
  dist = 14;
  /** Play mode: cap on the effective orbit distance (camera-vs-geometry). */
  distClamp: number | null = null;

  /** Called every frame before render. */
  onTick: ((dt: number) => void) | null = null;
  /** Called when the canvas backing store resizes (device pixels). */
  onResize: ((w: number, h: number) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private held = new Set<string>();
  private cameraDrag: { kind: 'orbit' | 'pan'; lastX: number; lastY: number; moved: number } | null =
    null;
  private lastTime = performance.now();
  private eye = new MVec();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const resize = () => {
      const parent = canvas.parentElement!;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      this.onResize?.(canvas.width, canvas.height);
    };
    new ResizeObserver(resize).observe(canvas.parentElement!);
    queueMicrotask(resize);

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      // q/e fly down/up (z is reserved for the vertex-mode axis constraint)
      if (['w', 'a', 's', 'd', 'q', 'e', ' ', 'shift'].includes(k)) {
        this.held.add(k);
        if (k === ' ') e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.held.clear());

    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.fly(dt);
      this.onTick?.(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // -- camera ---------------------------------------------------------------

  /** Unit view direction implied by yaw/pitch (same convention in both modes). */
  forward(): Vec3 {
    const cp = Math.cos(this.pitch);
    return {
      x: -cp * Math.cos(this.yaw),
      y: -Math.sin(this.pitch),
      z: -cp * Math.sin(this.yaw),
    };
  }

  setCameraMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.updateEye();
    if (mode === 'fly') {
      this.position.copy(this.eye);
    } else {
      const f = this.forward();
      this.target.copy(this.position).addScaled(f, this.dist);
    }
    this.mode = mode;
  }

  private updateEye(): void {
    if (this.mode === 'orbit') {
      const d = this.distClamp === null ? this.dist : Math.min(this.dist, this.distClamp);
      const cp = Math.cos(this.pitch);
      this.eye.set(
        this.target.x + d * cp * Math.cos(this.yaw),
        this.target.y + d * Math.sin(this.pitch),
        this.target.z + d * cp * Math.sin(this.yaw),
      );
    } else {
      this.eye.copy(this.position);
    }
  }

  private fly(dt: number): void {
    if (this.suspendFly || this.held.size === 0) return;
    const speed =
      this.mode === 'fly'
        ? (this.held.has('shift') ? 48 : 16) * dt
        : this.dist * (this.held.has('shift') ? 2.4 : 0.8) * dt;
    const f = this.forward();
    const right = norm(cross(f, v3(0, 1, 0)));
    const move = new MVec();
    if (this.held.has('w')) move.addScaled(f, speed);
    if (this.held.has('s')) move.addScaled(f, -speed);
    if (this.held.has('d')) move.addScaled(right, speed);
    if (this.held.has('a')) move.addScaled(right, -speed);
    if (this.held.has(' ') || this.held.has('e')) move.y += speed;
    if (this.held.has('q')) move.y -= speed;
    if (this.mode === 'fly') this.position.add(move);
    else this.target.add(move);
  }

  /** Begin an orbit/mouselook (RMB) or pan (MMB) drag. */
  beginCameraDrag(kind: 'orbit' | 'pan', e: PointerEvent): void {
    this.cameraDrag = { kind, lastX: e.clientX, lastY: e.clientY, moved: 0 };
  }

  /** @returns total pixels moved so far (used to distinguish click from drag). */
  moveCameraDrag(e: PointerEvent): number {
    const d = this.cameraDrag;
    if (!d) return 0;
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    if (d.kind === 'orbit') {
      const k = this.mode === 'fly' ? 0.0045 : 0.007;
      this.yaw += dx * k;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + dy * k));
    } else {
      const f = this.forward();
      const right = norm(cross(f, v3(0, 1, 0)));
      const up = cross(right, f);
      const k = (this.mode === 'fly' ? 8 : this.dist) * 0.0018;
      const pan = new MVec().addScaled(right, -dx * k).addScaled(up, dy * k);
      if (this.mode === 'fly') this.position.add(pan);
      else this.target.add(pan);
    }
    return d.moved;
  }

  endCameraDrag(): number {
    const moved = this.cameraDrag?.moved ?? 0;
    this.cameraDrag = null;
    return moved;
  }

  get cameraDragActive(): boolean {
    return this.cameraDrag !== null;
  }

  zoom(deltaY: number): void {
    if (this.mode === 'fly') {
      this.position.addScaled(this.forward(), -deltaY * 0.02);
    } else {
      const f = Math.pow(1.1, deltaY / 100);
      this.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, this.dist * f));
    }
  }

  centerOn(p: Vec3): void {
    if (this.mode === 'fly') {
      const f = this.forward();
      this.position.set(p.x - f.x * 12, p.y - f.y * 12, p.z - f.z * 12);
    } else {
      this.target.set(p.x, p.y, p.z);
    }
  }

  cameraPos(): Vec3 {
    this.updateEye();
    return { x: this.eye.x, y: this.eye.y, z: this.eye.z };
  }

  private cssSize(): { w: number; h: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { w: rect.width || 1, h: rect.height || 1 };
  }

  aspect(): number {
    const { w, h } = this.cssSize();
    return w / h;
  }

  private viewProj(): Mat4 {
    this.updateEye();
    return matMul(
      perspective(FOV_Y, this.aspect(), NEAR, FAR),
      lookTo(this.eye, this.forward()),
    );
  }

  // -- picking --------------------------------------------------------------

  /** The pointer ray in world space, from canvas-space CSS coordinates. */
  rayAt(x: number, y: number): Ray {
    const { w, h } = this.cssSize();
    this.updateEye();
    return {
      origin: { x: this.eye.x, y: this.eye.y, z: this.eye.z },
      dir: rayDir(this.forward(), FOV_Y, this.aspect(), w, h, x, y),
    };
  }

  rayFromEvent(e: PointerEvent): Ray {
    const p = this.eventPoint(e);
    return this.rayAt(p.x, p.y);
  }

  /** Intersect the pointer ray with a working-plane frame. */
  pickFrame(e: PointerEvent, frame: Frame): Vec3 | null {
    return this.pickPlaneThrough(e, frame.origin, frame.n);
  }

  /** Intersect the pointer ray with the plane through `point` with normal `n`. */
  pickPlaneThrough(e: PointerEvent, point: Vec3, n: Vec3): Vec3 | null {
    const ray = this.rayFromEvent(e);
    const denom = dot(ray.dir, n);
    if (Math.abs(denom) < 1e-9) return null;
    const t = dot(sub(point, ray.origin), n) / denom;
    if (t < 0) return null;
    return {
      x: ray.origin.x + ray.dir.x * t,
      y: ray.origin.y + ray.dir.y * t,
      z: ray.origin.z + ray.dir.z * t,
    };
  }

  /** Closest point (as scalar t along `dir` from `point`) of the pointer ray to a line. */
  pickLineThrough(e: PointerEvent, point: Vec3, dir: Vec3): number {
    const ray = this.rayFromEvent(e);
    const d = norm(dir);
    const w0 = sub(point, ray.origin);
    const b = dot(d, ray.dir);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-8) return 0;
    const dw = dot(d, w0);
    const rw = dot(ray.dir, w0);
    return (b * rw - dw) / denom;
  }

  /** Project a world point to canvas pixels; null if behind the camera. */
  screenPoint(p: Vec3): { x: number; y: number } | null {
    const clip = transform(this.viewProj(), p);
    if (clip[3] <= NEAR) return null;
    const { w, h } = this.cssSize();
    return {
      x: ((clip[0] / clip[3] + 1) / 2) * w,
      y: ((1 - clip[1] / clip[3]) / 2) * h,
    };
  }

  eventPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
}
