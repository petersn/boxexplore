import { type Vec2, type Vec3, c2, c3, vkey } from './vec';

/**
 * A single textured quad — the atom of the editor, like a Crocotile tile.
 * Corners are ordered bottom-left, bottom-right, top-right, top-left in the
 * face's own frame; winding determines the front side. Corners may be moved
 * independently (non-planar quads are allowed and render as two triangles).
 */
export interface Face {
  id: number;
  verts: [Vec3, Vec3, Vec3, Vec3];
  uvs: [Vec2, Vec2, Vec2, Vec2];
  /** Which diagonal splits the quad: false → (0,1,2)+(0,2,3), true → (0,1,3)+(1,2,3). */
  flipDiag?: boolean;
}

export function copyFace(f: Face): Face {
  return {
    id: f.id,
    verts: [c3(f.verts[0]), c3(f.verts[1]), c3(f.verts[2]), c3(f.verts[3])],
    uvs: [c2(f.uvs[0]), c2(f.uvs[1]), c2(f.uvs[2]), c2(f.uvs[3])],
    flipDiag: f.flipDiag,
  };
}

/** Position-only key identifying a quad footprint, used to replace instead of stack. */
export function quadKey(verts: readonly Vec3[]): string {
  return verts.map(vkey).sort().join('|');
}

/** A lattice-vertex displacement change (null = no displacement). */
export interface ShiftChange {
  key: string;
  before: Vec3 | null;
  after: Vec3 | null;
}

/**
 * A reversible edit. `added`/`removed` are full snapshots; `before`/`after`
 * are snapshots of modified faces (matched by id). `cellsAdded`/`cellsRemoved`
 * change the solid volume; `shifts` change lattice displacements.
 */
export interface EditOp {
  added?: Face[];
  removed?: Face[];
  before?: Face[];
  after?: Face[];
  cellsAdded?: string[];
  cellsRemoved?: string[];
  shifts?: ShiftChange[];
}

export function opIsEmpty(op: EditOp): boolean {
  return (
    !op.added?.length &&
    !op.removed?.length &&
    !op.before?.length &&
    !op.after?.length &&
    !op.cellsAdded?.length &&
    !op.cellsRemoved?.length &&
    !op.shifts?.length
  );
}

export interface DocJSON {
  nextId: number;
  faces: Face[];
  cells?: string[];
  shifts?: Record<string, Vec3>;
}

export class Doc {
  faces = new Map<number, Face>();
  /** Solid volume: sparse set of unit cells, keyed "x,y,z" (integer min corner). */
  cells = new Set<string>();
  /** Lattice-vertex displacements, keyed by integer lattice point "x,y,z". */
  shifts = new Map<string, Vec3>();
  /** Bumped whenever cells or shifts change, so the surface cache knows to rebuild. */
  volVersion = 0;
  nextId = 1;
  private quadIndex = new Map<string, Set<number>>();
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Create a face snapshot (not yet inserted into the doc). */
  makeFace(verts: Face['verts'], uvs: Face['uvs'], flipDiag = false): Face {
    return { id: this.nextId++, verts, uvs, flipDiag };
  }

  facesAtQuad(verts: readonly Vec3[]): Face[] {
    const ids = this.quadIndex.get(quadKey(verts));
    if (!ids) return [];
    const out: Face[] = [];
    for (const id of ids) {
      const f = this.faces.get(id);
      if (f) out.push(f);
    }
    return out;
  }

  private insert(f: Face): void {
    const copy = copyFace(f);
    this.faces.set(copy.id, copy);
    this.indexAdd(copy);
    if (copy.id >= this.nextId) this.nextId = copy.id + 1;
  }

  private remove(id: number): void {
    const f = this.faces.get(id);
    if (!f) return;
    this.indexRemove(f);
    this.faces.delete(id);
  }

  /** Overwrite the contents of an existing face (same id). */
  private write(f: Face): void {
    const old = this.faces.get(f.id);
    if (old) this.indexRemove(old);
    const copy = copyFace(f);
    this.faces.set(copy.id, copy);
    this.indexAdd(copy);
  }

  /**
   * Live-mutate faces during a drag (no history). Pass snapshots; contents are copied in.
   */
  writeLive(faces: Iterable<Face>): void {
    for (const f of faces) this.write(f);
    this.emit();
  }

  /** Lattice offsets are hard-clamped to ±½ cell on every axis — geometry never
   * strays more than half a cell from its voxel, however it was edited. */
  static clampShift(v: Vec3): Vec3 {
    const c = (n: number) => Math.max(-0.5, Math.min(0.5, n));
    return { x: c(v.x), y: c(v.y), z: c(v.z) };
  }

  private setShift(key: string, v: Vec3 | null): void {
    const s = v ? Doc.clampShift(v) : null;
    if (!s || (Math.abs(s.x) < 1e-9 && Math.abs(s.y) < 1e-9 && Math.abs(s.z) < 1e-9)) {
      this.shifts.delete(key);
    } else {
      this.shifts.set(key, s);
    }
    this.volVersion++;
  }

  /** Live-mutate lattice displacements during a drag (no history). */
  writeShiftsLive(entries: Iterable<[string, Vec3 | null]>): void {
    for (const [key, v] of entries) this.setShift(key, v);
    this.emit();
  }

  /** Apply (dir=1) or revert (dir=-1) an edit op, then notify. */
  applyOp(op: EditOp, dir: 1 | -1): void {
    if (dir === 1) {
      op.removed?.forEach((f) => this.remove(f.id));
      op.added?.forEach((f) => this.insert(f));
      op.after?.forEach((f) => this.write(f));
      op.cellsRemoved?.forEach((k) => this.cells.delete(k));
      op.cellsAdded?.forEach((k) => this.cells.add(k));
      op.shifts?.forEach((s) => this.setShift(s.key, s.after));
    } else {
      op.added?.forEach((f) => this.remove(f.id));
      op.removed?.forEach((f) => this.insert(f));
      op.before?.forEach((f) => this.write(f));
      op.cellsAdded?.forEach((k) => this.cells.delete(k));
      op.cellsRemoved?.forEach((k) => this.cells.add(k));
      op.shifts?.forEach((s) => this.setShift(s.key, s.before));
    }
    if (op.cellsAdded?.length || op.cellsRemoved?.length) this.volVersion++;
    this.emit();
  }

  private indexAdd(f: Face): void {
    const key = quadKey(f.verts);
    let set = this.quadIndex.get(key);
    if (!set) this.quadIndex.set(key, (set = new Set()));
    set.add(f.id);
  }

  private indexRemove(f: Face): void {
    const key = quadKey(f.verts);
    const set = this.quadIndex.get(key);
    if (set) {
      set.delete(f.id);
      if (set.size === 0) this.quadIndex.delete(key);
    }
  }

  toJSON(): DocJSON {
    const shifts: Record<string, Vec3> = {};
    for (const [k, v] of this.shifts) shifts[k] = c3(v);
    return {
      nextId: this.nextId,
      faces: [...this.faces.values()].map(copyFace),
      cells: [...this.cells],
      shifts,
    };
  }

  loadJSON(data: DocJSON): void {
    this.faces.clear();
    this.quadIndex.clear();
    this.cells.clear();
    this.shifts.clear();
    this.nextId = 1;
    for (const f of data.faces) this.insert(f);
    for (const k of data.cells ?? []) this.cells.add(k);
    for (const [k, v] of Object.entries(data.shifts ?? {})) this.shifts.set(k, Doc.clampShift(c3(v)));
    this.nextId = Math.max(this.nextId, data.nextId || 1);
    this.volVersion++;
    this.emit();
  }

  clear(): void {
    this.faces.clear();
    this.quadIndex.clear();
    this.cells.clear();
    this.shifts.clear();
    this.nextId = 1;
    this.volVersion++;
    this.emit();
  }
}

export class History {
  private undoStack: EditOp[] = [];
  private redoStack: EditOp[] = [];
  private static readonly LIMIT = 200;

  push(op: EditOp): void {
    if (opIsEmpty(op)) return;
    this.undoStack.push(op);
    if (this.undoStack.length > History.LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(doc: Doc): boolean {
    const op = this.undoStack.pop();
    if (!op) return false;
    doc.applyOp(op, -1);
    this.redoStack.push(op);
    return true;
  }

  redo(doc: Doc): boolean {
    const op = this.redoStack.pop();
    if (!op) return false;
    doc.applyOp(op, 1);
    this.undoStack.push(op);
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
