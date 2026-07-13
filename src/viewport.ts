import * as THREE from 'three';
import type { Frame } from './frame';
import type { Vec3 } from './vec';

const MIN_DIST = 0.5;
const MAX_DIST = 400;

export type CameraMode = 'orbit' | 'fly';

/**
 * Owns the WebGL canvas, camera rig and low-level picking. Two camera modes:
 * `orbit` (CAD-style: pivot around a target point) and `fly` (Minecraft
 * creative-style: free position + mouselook, no pivot). Tool logic lives in
 * the modes; this class is dumb.
 */
export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  mode: CameraMode = 'orbit';
  /** Play mode drives the camera; suspend WASD flying. */
  suspendFly = false;
  target = new THREE.Vector3(0, 0.5, 0);
  /** Camera position — ground truth in fly mode, derived in orbit mode. */
  position = new THREE.Vector3();
  yaw = -Math.PI / 4;
  pitch = 0.55;
  dist = 14;

  /** Called every frame before render. */
  onTick: ((dt: number) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly raycaster = new THREE.Raycaster();
  private held = new Set<string>();
  private cameraDrag: { kind: 'orbit' | 'pan'; lastX: number; lastY: number; moved: number } | null =
    null;
  private lastTime = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x15171b);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.02, 2000);

    const axes = new THREE.AxesHelper(1.5);
    (axes.material as THREE.Material).transparent = true;
    (axes.material as THREE.Material).opacity = 0.7;
    this.scene.add(axes);

    const resize = () => {
      const parent = canvas.parentElement!;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(canvas.parentElement!);
    resize();

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
      this.updateCamera();
      this.renderer.render(this.scene, this.camera);
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
    this.updateCamera();
    if (mode === 'fly') {
      this.position.copy(this.camera.position);
    } else {
      const f = this.forward();
      this.target
        .copy(this.position)
        .add(new THREE.Vector3(f.x, f.y, f.z).multiplyScalar(this.dist));
    }
    this.mode = mode;
  }

  private updateCamera(): void {
    if (this.mode === 'orbit') {
      const cp = Math.cos(this.pitch);
      this.camera.position.set(
        this.target.x + this.dist * cp * Math.cos(this.yaw),
        this.target.y + this.dist * Math.sin(this.pitch),
        this.target.z + this.dist * cp * Math.sin(this.yaw),
      );
      this.camera.lookAt(this.target);
    } else {
      this.camera.position.copy(this.position);
      const f = this.forward();
      this.camera.lookAt(
        this.position.x + f.x,
        this.position.y + f.y,
        this.position.z + f.z,
      );
    }
  }

  private fly(dt: number): void {
    if (this.suspendFly || this.held.size === 0) return;
    const speed =
      this.mode === 'fly'
        ? (this.held.has('shift') ? 48 : 16) * dt
        : this.dist * (this.held.has('shift') ? 2.4 : 0.8) * dt;
    const f = this.forward();
    const fwd = new THREE.Vector3(f.x, f.y, f.z);
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3();
    if (this.held.has('w')) move.addScaledVector(fwd, speed);
    if (this.held.has('s')) move.addScaledVector(fwd, -speed);
    if (this.held.has('d')) move.addScaledVector(right, speed);
    if (this.held.has('a')) move.addScaledVector(right, -speed);
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
      this.camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const k = (this.mode === 'fly' ? 8 : this.dist) * 0.0018;
      const pan = new THREE.Vector3().addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
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
      // dolly along the view direction
      const f = this.forward();
      this.position.addScaledVector(new THREE.Vector3(f.x, f.y, f.z), -deltaY * 0.02);
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
    this.updateCamera();
    return { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z };
  }

  // -- picking --------------------------------------------------------------

  private setRayFromEvent(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.updateCamera();
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  pickObject(e: PointerEvent, object: THREE.Object3D): THREE.Intersection | null {
    this.setRayFromEvent(e);
    const hits = this.raycaster.intersectObject(object, false);
    return hits.length ? hits[0] : null;
  }

  /** Nearest intersection among a group's direct children (chunk meshes). */
  pickGroup(e: PointerEvent, group: THREE.Object3D): THREE.Intersection | null {
    this.setRayFromEvent(e);
    const hits = this.raycaster.intersectObjects(group.children, false);
    return hits.length ? hits[0] : null;
  }

  /** Like pickGroup, but from canvas-space coordinates (for sweep interpolation). */
  pickGroupAt(x: number, y: number, group: THREE.Object3D): THREE.Intersection | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    this.updateCamera();
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(group.children, false);
    return hits.length ? hits[0] : null;
  }

  /** Intersect the pointer ray with a working-plane frame. */
  pickFrame(e: PointerEvent, frame: Frame): Vec3 | null {
    this.setRayFromEvent(e);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3(frame.n.x, frame.n.y, frame.n.z),
      new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z),
    );
    const out = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, out)) return null;
    return { x: out.x, y: out.y, z: out.z };
  }

  /** Intersect the pointer ray with an arbitrary plane through `point` with normal `n`. */
  pickPlaneThrough(e: PointerEvent, point: Vec3, n: Vec3): Vec3 | null {
    this.setRayFromEvent(e);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3(n.x, n.y, n.z),
      new THREE.Vector3(point.x, point.y, point.z),
    );
    const out = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, out)) return null;
    return { x: out.x, y: out.y, z: out.z };
  }

  /** Closest point (as scalar t along `dir` from `point`) of the pointer ray to a line. */
  pickLineThrough(e: PointerEvent, point: Vec3, dir: Vec3): number {
    this.setRayFromEvent(e);
    const p0 = new THREE.Vector3(point.x, point.y, point.z);
    const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
    const ro = this.raycaster.ray.origin;
    const rd = this.raycaster.ray.direction;
    // closest point between line (p0, d) and ray (ro, rd)
    const w0 = new THREE.Vector3().subVectors(p0, ro);
    const b = d.dot(rd);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-8) return 0;
    const dw = d.dot(w0);
    const rw = rd.dot(w0);
    return (b * rw - dw) / denom;
  }

  /** Project a world point to canvas pixels; null if behind the camera. */
  screenPoint(p: Vec3): { x: number; y: number } | null {
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(this.camera.matrixWorldInverse);
    if (v.z > -this.camera.near) return null;
    v.applyMatrix4(this.camera.projectionMatrix);
    const rect = this.canvas.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height };
  }

  eventPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
}
