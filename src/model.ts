import { type Vec3, c3 } from './vec';

/** A lattice-corner displacement change (null = no displacement). */
export interface ShiftChange {
  key: string;
  before: Vec3 | null;
  after: Vec3 | null;
}

/**
 * A reversible edit: solid cells added/removed and lattice-corner
 * displacement changes.
 */
export interface EditOp {
  cellsAdded?: string[];
  cellsRemoved?: string[];
  shifts?: ShiftChange[];
}

export function opIsEmpty(op: EditOp): boolean {
  return !op.cellsAdded?.length && !op.cellsRemoved?.length && !op.shifts?.length;
}

export interface DocJSON {
  cells: string[];
  shifts: Record<string, Vec3>;
}

export class Doc {
  /** Solid volume: sparse set of unit cells, keyed "x,y,z" (integer min corner). */
  cells = new Set<string>();
  /** Lattice-corner displacements, keyed by integer lattice point "x,y,z". */
  shifts = new Map<string, Vec3>();
  /** Bumped on every change, so the surface cache knows to rebuild. */
  volVersion = 0;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
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

  /** Live-mutate cells during a brush stroke (no history). */
  writeCellsLive(add: Iterable<string>, remove: Iterable<string>): void {
    for (const k of remove) this.cells.delete(k);
    for (const k of add) this.cells.add(k);
    this.volVersion++;
    this.emit();
  }

  /** Apply (dir=1) or revert (dir=-1) an edit op, then notify. */
  applyOp(op: EditOp, dir: 1 | -1): void {
    if (dir === 1) {
      op.cellsRemoved?.forEach((k) => this.cells.delete(k));
      op.cellsAdded?.forEach((k) => this.cells.add(k));
      op.shifts?.forEach((s) => this.setShift(s.key, s.after));
    } else {
      op.cellsAdded?.forEach((k) => this.cells.delete(k));
      op.cellsRemoved?.forEach((k) => this.cells.add(k));
      op.shifts?.forEach((s) => this.setShift(s.key, s.before));
    }
    this.volVersion++;
    this.emit();
  }

  toJSON(): DocJSON {
    const shifts: Record<string, Vec3> = {};
    for (const [k, v] of this.shifts) shifts[k] = c3(v);
    return { cells: [...this.cells], shifts };
  }

  loadJSON(data: DocJSON): void {
    this.cells.clear();
    this.shifts.clear();
    for (const k of data.cells ?? []) this.cells.add(k);
    for (const [k, v] of Object.entries(data.shifts ?? {})) {
      this.shifts.set(k, Doc.clampShift(c3(v)));
    }
    this.volVersion++;
    this.emit();
  }

  clear(): void {
    this.cells.clear();
    this.shifts.clear();
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
