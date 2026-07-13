// The document lives in Rust (rust/boxcore, compiled to WASM): chunked voxel
// volume, clamped lattice offsets, every edit op, undo/redo, meshing, and
// serialization. This wrapper adds change notification and ergonomic types;
// regenerate the bindings with `npm run wasm`.

import init, { World, gfx_create } from './wasm/boxcore.js';

export { gfx_create };
import type { Vec3 } from './vec';

export async function initWasm(): Promise<void> {
  await init();
}

/** "x,y,z" — integer lattice-corner key (the UI's selection currency). */
export type LatticeKey = string;

export const latticeKey = (x: number, y: number, z: number): LatticeKey => `${x},${y},${z}`;
export const parseLattice = (k: LatticeKey): [number, number, number] =>
  k.split(',').map(Number) as [number, number, number];

export interface FaceRef {
  cell: [number, number, number];
  dir: number;
}

/** Tile orientation for painted faces: quarter turns + flips. */
export interface PaintOrient {
  rot: 0 | 1 | 2 | 3;
  flipH: boolean;
  flipV: boolean;
}

export interface RectSel {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  plane: number;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

export interface CornerHandle {
  lattice: LatticeKey;
  pos: Vec3;
  selected: boolean;
}

export class WorldHandle {
  readonly raw: World;
  private listeners = new Set<() => void>();

  constructor() {
    this.raw = new World();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // -- queries -----------------------------------------------------------------

  cellCount(): number {
    return this.raw.cell_count();
  }

  shiftCount(): number {
    return this.raw.shift_count();
  }

  getCell(x: number, y: number, z: number): boolean {
    return this.raw.get_cell(x, y, z);
  }

  getShift(x: number, y: number, z: number): [number, number, number] | null {
    const v = this.raw.get_shift(x, y, z);
    return v.length === 3 ? [v[0], v[1], v[2]] : null;
  }

  /** Test/scripting hook (no history). */
  setShiftRaw(x: number, y: number, z: number, v: [number, number, number] | null): void {
    if (v) this.raw.set_shift_raw(x, y, z, v[0], v[1], v[2]);
    else this.raw.clear_shift_raw(x, y, z);
    this.notify();
  }

  surfaceHasCorner(k: LatticeKey): boolean {
    const [x, y, z] = parseLattice(k);
    return this.raw.surface_has_corner(x, y, z);
  }

  surfaceCornerCount(): number {
    return this.raw.surface_corner_count();
  }

  cornerPos(k: LatticeKey): Vec3 {
    const [x, y, z] = parseLattice(k);
    const p = this.raw.corner_pos(x, y, z);
    return { x: p[0], y: p[1], z: p[2] };
  }

  stats(): { faces: number; oddEdges: number } {
    const s = this.raw.stats();
    return { faces: s[0], oddEdges: s[1] };
  }

  /** Displaced (or raw) quad of an exposed face, or null. 12 floats [bl,br,tr,tl]. */
  faceQuad(cell: [number, number, number], dir: number, sculpted: boolean): Float32Array | null {
    const q = this.raw.face_quad(cell[0], cell[1], cell[2], dir, sculpted);
    return q.length === 12 ? q : null;
  }

  // -- build ops ------------------------------------------------------------------

  /** Centered sx × sz slab, `thickness` deep, top at y = 0 (one undo op). */
  makeSlab(sx: number, sz: number, thickness: number): boolean {
    const r = this.raw.make_slab(sx, sz, thickness);
    if (r) this.notify();
    return r;
  }

  seedVoxel(): boolean {
    const changed = this.raw.seed_voxel();
    if (changed) this.notify();
    return changed;
  }

  /** dir=1 extrudes present faces one layer out; dir=-1 carves the footprint. */
  extrudeRect(sel: RectSel, dir: 1 | -1): boolean {
    const changed = this.raw.extrude_rect(
      sel.axis,
      sel.sign,
      sel.plane,
      sel.a0,
      sel.a1,
      sel.b0,
      sel.b1,
      dir,
    );
    if (changed) this.notify();
    return changed;
  }

  resetRectOffsets(sel: RectSel): boolean {
    const changed = this.raw.reset_rect_offsets(
      sel.axis,
      sel.sign,
      sel.plane,
      sel.a0,
      sel.a1,
      sel.b0,
      sel.b1,
    );
    if (changed) this.notify();
    return changed;
  }

  rectCorners(sel: RectSel): LatticeKey[] {
    const t = this.raw.rect_corners(sel.axis, sel.sign, sel.plane, sel.a0, sel.a1, sel.b0, sel.b1);
    const out: LatticeKey[] = [];
    for (let i = 0; i < t.length; i += 3) out.push(latticeKey(t[i], t[i + 1], t[i + 2]));
    return out;
  }

  undo(): void {
    if (this.raw.undo()) this.notify();
  }

  redo(): void {
    if (this.raw.redo()) this.notify();
  }

  // -- sculpt ------------------------------------------------------------------------

  visibleCorners(eye: Vec3, maxDist = 150): Array<{ lattice: LatticeKey; pos: Vec3 }> {
    const v = this.raw.visible_corners(eye.x, eye.y, eye.z, maxDist);
    const out: Array<{ lattice: LatticeKey; pos: Vec3 }> = [];
    for (let i = 0; i < v.length; i += 6) {
      out.push({
        lattice: latticeKey(v[i], v[i + 1], v[i + 2]),
        pos: { x: v[i + 3], y: v[i + 4], z: v[i + 5] },
      });
    }
    return out;
  }

  cornerNormal(k: LatticeKey): Vec3 {
    const [x, y, z] = parseLattice(k);
    const n = this.raw.corner_normal(x, y, z);
    return { x: n[0], y: n[1], z: n[2] };
  }

  private triples(keys: LatticeKey[]): Int32Array {
    const t = new Int32Array(keys.length * 3);
    keys.forEach((k, i) => {
      const [x, y, z] = parseLattice(k);
      t[i * 3] = x;
      t[i * 3 + 1] = y;
      t[i * 3 + 2] = z;
    });
    return t;
  }

  dragBegin(keys: LatticeKey[]): void {
    this.raw.drag_begin(this.triples(keys));
  }

  dragUpdate(delta: Vec3): void {
    this.raw.drag_update(delta.x, delta.y, delta.z);
    this.notify();
  }

  dragEnd(): void {
    this.raw.drag_end();
    this.notify();
  }

  /** kind: smooth | inflate | deflate | noise | reset | nudge (with delta). */
  selectionOp(
    keys: LatticeKey[],
    kind: 'smooth' | 'inflate' | 'deflate' | 'noise' | 'reset' | 'nudge',
    delta?: Vec3,
  ): boolean {
    const kinds = { smooth: 0, inflate: 1, deflate: 2, noise: 3, reset: 4, nudge: 5 };
    const changed = this.raw.selection_op(
      this.triples(keys),
      kinds[kind],
      delta?.x ?? 0,
      delta?.y ?? 0,
      delta?.z ?? 0,
    );
    if (changed) this.notify();
    return changed;
  }

  strokeBegin(
    tool: 'smooth' | 'draw',
    invert: boolean,
    radius: number,
    strength: number,
    topo: boolean,
    dirOverride?: Vec3,
  ): void {
    this.raw.stroke_begin(
      tool === 'smooth' ? 0 : 1,
      invert,
      radius,
      strength,
      topo,
      dirOverride?.x ?? 0,
      dirOverride?.y ?? 0,
      dirOverride?.z ?? 0,
    );
  }

  strokeDab(p: Vec3): void {
    this.raw.stroke_dab(p.x, p.y, p.z);
    this.notify();
  }

  strokeEnd(): void {
    this.raw.stroke_end();
    this.notify();
  }

  // -- painting -----------------------------------------------------------------

  setTilesetGrid(cols: number, rows: number): void {
    this.raw.set_tileset_grid(cols, rows);
  }

  paintStrokeBegin(): void {
    this.raw.paint_stroke_begin();
  }

  paintFace(face: FaceRef, tx: number, ty: number, orient: PaintOrient): boolean {
    const ok = this.raw.paint_face(
      face.cell[0],
      face.cell[1],
      face.cell[2],
      face.dir,
      tx,
      ty,
      orient.rot,
      orient.flipH,
      orient.flipV,
    );
    if (ok) this.notify();
    return ok;
  }

  erasePaintFace(face: FaceRef): boolean {
    const ok = this.raw.erase_paint_face(face.cell[0], face.cell[1], face.cell[2], face.dir);
    if (ok) this.notify();
    return ok;
  }

  paintStrokeEnd(): void {
    this.raw.paint_stroke_end();
    this.notify();
  }

  /** [tx, ty, rot, flipH, flipV] or null when unpainted. */
  getPaint(face: FaceRef): [number, number, number, boolean, boolean] | null {
    const p = this.raw.get_paint(face.cell[0], face.cell[1], face.cell[2], face.dir);
    return p.length === 5 ? [p[0], p[1], p[2], p[3] !== 0, p[4] !== 0] : null;
  }

  paintCount(): number {
    return this.raw.paint_count();
  }

  /** Exposed faces within radius of a point (excluding the opposite of hitDir). */
  facesInRadius(p: Vec3, radius: number, hitDir: number): FaceRef[] {
    const t = this.raw.faces_in_radius(p.x, p.y, p.z, radius, hitDir);
    const out: FaceRef[] = [];
    for (let i = 0; i < t.length; i += 4) {
      out.push({ cell: [t[i], t[i + 1], t[i + 2]], dir: t[i + 3] });
    }
    return out;
  }

  /** Paint many faces in one notification (a single brush application). */
  paintFacesBatch(
    targets: Array<{ face: FaceRef; tx: number; ty: number; orient: PaintOrient }>,
  ): void {
    for (const t of targets) {
      this.raw.paint_face(
        t.face.cell[0],
        t.face.cell[1],
        t.face.cell[2],
        t.face.dir,
        t.tx,
        t.ty,
        t.orient.rot,
        t.orient.flipH,
        t.orient.flipV,
      );
    }
    if (targets.length) this.notify();
  }

  eraseFacesBatch(faces: FaceRef[]): void {
    for (const f of faces) {
      this.raw.erase_paint_face(f.cell[0], f.cell[1], f.cell[2], f.dir);
    }
    if (faces.length) this.notify();
  }

  shortestPath(from: LatticeKey, to: LatticeKey): LatticeKey[] {
    const [x0, y0, z0] = parseLattice(from);
    const [x1, y1, z1] = parseLattice(to);
    const t = this.raw.shortest_path(x0, y0, z0, x1, y1, z1);
    const out: LatticeKey[] = [];
    for (let i = 0; i < t.length; i += 3) out.push(latticeKey(t[i], t[i + 1], t[i + 2]));
    return out;
  }

  /** First face hit by a ray, exact against the rendered quads. */
  pick(
    origin: Vec3,
    dir: Vec3,
    sculpted: boolean,
    maxDist = 2000,
  ): { face: FaceRef; point: Vec3; t: number } | null {
    const v = this.raw.pick(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist, sculpted);
    if (v.length < 8) return null;
    return {
      face: { cell: [v[0], v[1], v[2]], dir: v[3] },
      point: { x: v[4], y: v[5], z: v[6] },
      t: v[7],
    };
  }

  // -- planning -----------------------------------------------------------------

  /** Replace the world volume with the plan's geometry (clears history). */
  planGenerate(): boolean {
    const ok = this.raw.plan_generate();
    if (ok) this.notify();
    return ok;
  }

  /** Plan edits don't change the volume, but should autosave. */
  planTouched(): void {
    this.notify();
  }

  // -- play mode (physics lives in Rust; none of these touch the document) ----------

  /** Drop the player onto the ground near (x, z); returns its position. */
  playerSpawn(x: number, z: number): Vec3 {
    const p = this.raw.player_spawn(x, z);
    return { x: p[0], y: p[1], z: p[2] };
  }

  /** Step the character controller. Returns pos + facing + ground flag. */
  playerUpdate(
    dt: number,
    wishX: number,
    wishZ: number,
    jump: boolean,
  ): { pos: Vec3; facing: number; onGround: boolean } {
    const r = this.raw.player_update(dt, wishX, wishZ, jump);
    return { pos: { x: r[0], y: r[1], z: r[2] }, facing: r[3], onGround: r[4] > 0.5 };
  }

  /** Stateless chase-camera boom length (cone-cast; see docs/camera.md).
   *  `los` is the hard line-of-sight distance the boom must never exceed. */
  cameraBoom(focus: Vec3, dir: Vec3, dist: number): { boom: number; los: number } {
    const v = this.raw.camera_boom(focus.x, focus.y, focus.z, dir.x, dir.y, dir.z, dist);
    return { boom: v[0], los: v[1] };
  }

  // -- io ---------------------------------------------------------------------------

  /** The document as the core's v6 binary blob. */
  docBin(): Uint8Array {
    return this.raw.to_bin();
  }

  loadDocBin(doc: Uint8Array): boolean {
    const ok = this.raw.load_bin(doc);
    if (ok) this.notify();
    return ok;
  }

  clear(): void {
    this.raw.clear();
    this.notify();
  }

  clearHistory(): void {
    this.raw.clear_history();
  }
}
