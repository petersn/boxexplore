import type { Editor } from './editor';
import { type ShiftChange } from './model';
import { type Vec3, add, cross, dot, len, mul, norm, snap, sub, v3 } from './vec';
import { type VolFace, DIRS, parseCell, segmentBlocked } from './volume';

export interface VertexHandle {
  pos: Vec3;
  /** The lattice key this handle displaces. */
  lattice: string;
  selected: boolean;
}

/** Blender-style movement constraint: an axis, or the plane normal to it. */
export interface Constraint {
  axis: 0 | 1 | 2;
  plane: boolean;
}

type Drag =
  | {
      kind: 'box';
      start: { x: number; y: number };
      additive: boolean;
      /** Handle under the initial press — a no-move release (de)selects it. */
      clickHandle: VertexHandle | null;
      moved: boolean;
    }
  | {
      kind: 'move';
      /** Lattice key → displacement before the drag (null = none). */
      latticeBefore: Map<string, Vec3 | null>;
      grab: Vec3;
      moved: boolean;
    };

const AXIS_UNITS: readonly Vec3[] = [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)];

const faceNormal = (verts: readonly Vec3[]): Vec3 =>
  norm(cross(sub(verts[2], verts[0]), sub(verts[3], verts[1])));

/**
 * Vertex mode: sculpt the surface by moving lattice corners (offsets are
 * hard-clamped to ±½ cell, and the surface stays sealed). Click selects; click
 * a *selected* corner again to drag it — drags from unselected corners or empty
 * space box-select (Shift = additive). X/Y/Z constrain movement to an axis
 * (Shift+X/Y/Z = the plane normal to it); with an axis set, `=`/`-` nudge the
 * selection along it toward/away from the camera. Ctrl/Cmd+click selects the
 * shortest edge path from the previously picked corner. Only corners the
 * camera can actually see are shown and pickable.
 */
export class VertexMode {
  readonly name = 'vertex';
  constraint: Constraint | null = null;
  private drag: Drag | null = null;
  private lastPicked: string | null = null;

  constructor(private ed: Editor) {}

  enter(): void {
    this.constraint = null;
    this.ed.refreshOverlays();
  }

  exit(): void {
    this.constraint = null;
    this.drag = null;
    this.lastPicked = null;
    this.ed.hideSelBox();
    this.ed.refreshOverlays();
  }

  /** One handle per volume-surface lattice corner. */
  handles(): VertexHandle[] {
    const ed = this.ed;
    const out: VertexHandle[] = [];
    for (const lk of ed.surfaceLattice) {
      const [x, y, z] = parseCell(lk);
      const s = ed.doc.shifts.get(lk);
      out.push({
        pos: v3(x + (s?.x ?? 0), y + (s?.y ?? 0), z + (s?.z ?? 0)),
        lattice: lk,
        selected: ed.selectedVerts.has(`L:${lk}`),
      });
    }
    return out;
  }

  /** Surface faces touching each lattice corner. */
  private latticeFaces(): Map<string, VolFace[]> {
    const map = new Map<string, VolFace[]>();
    for (const f of this.ed.surface) {
      for (const lk of f.lattice) {
        let arr = map.get(lk);
        if (!arr) map.set(lk, (arr = []));
        arr.push(f);
      }
    }
    return map;
  }

  /** Averaged surface normal at a corner (world up as a last resort). */
  private latticeNormal(lk: string, latticeFaces?: Map<string, VolFace[]>): Vec3 {
    const faces = (latticeFaces ?? this.latticeFaces()).get(lk);
    if (faces?.length) {
      let n = v3();
      for (const f of faces) n = add(n, faceNormal(f.verts));
      if (len(n) > 1e-9) return norm(n);
    }
    return v3(0, 1, 0);
  }

  /**
   * Handles the camera can actually see: at least one adjacent face turned
   * toward the camera, plus an unobstructed voxel line of sight to a probe
   * just off the surface. Two probe distances along the corner normal keep
   * concave corners (where the sight line grazes a surface) from being
   * hidden over-eagerly.
   */
  visibleHandles(): VertexHandle[] {
    const ed = this.ed;
    const eye = ed.viewport.cameraPos();
    const lf = this.latticeFaces();
    return this.handles().filter((h) => {
      const faces = lf.get(h.lattice);
      if (!faces?.length) return false;
      const facing = faces.some((f) => {
        const n = DIRS[f.dir];
        return n[0] * (eye.x - h.pos.x) + n[1] * (eye.y - h.pos.y) + n[2] * (eye.z - h.pos.z) > 1e-6;
      });
      if (!facing) return false;
      const n = this.latticeNormal(h.lattice, lf);
      return (
        !segmentBlocked(ed.doc.cells, eye, add(h.pos, mul(n, 0.08))) ||
        !segmentBlocked(ed.doc.cells, eye, add(h.pos, mul(n, 0.4)))
      );
    });
  }

  private pickHandle(e: PointerEvent): VertexHandle | null {
    const ed = this.ed;
    const pt = ed.viewport.eventPoint(e);
    let best: VertexHandle | null = null;
    let bestD = 12 * 12;
    for (const h of this.visibleHandles()) {
      const s = ed.viewport.screenPoint(h.pos);
      if (!s) continue;
      const d = (s.x - pt.x) ** 2 + (s.y - pt.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  /** Centroid of the selected corners (for the constraint widget and nudges). */
  selectionCentroid(): Vec3 | null {
    const keys = this.selectedLattice();
    if (!keys.length) return null;
    let c = v3();
    for (const lk of keys) c = add(c, this.displaced(lk));
    return mul(c, 1 / keys.length);
  }

  // -- events -----------------------------------------------------------------

  pointerDown(e: PointerEvent): void {
    const ed = this.ed;
    const h = this.pickHandle(e);
    if (h && (e.ctrlKey || e.metaKey)) {
      this.pathSelect(h);
      return;
    }
    if (h && h.selected && !e.shiftKey) {
      // second click on an already-selected corner starts the move
      const latticeBefore = new Map<string, Vec3 | null>();
      for (const key of ed.selectedVerts) {
        if (!key.startsWith('L:')) continue;
        const lk = key.slice(2);
        const s = ed.doc.shifts.get(lk);
        latticeBefore.set(lk, s ? { ...s } : null);
      }
      this.drag = { kind: 'move', latticeBefore, grab: { ...h.pos }, moved: false };
      return;
    }
    // everything else biases toward box select (click = select on release)
    this.drag = {
      kind: 'box',
      start: ed.viewport.eventPoint(e),
      additive: e.shiftKey,
      clickHandle: h,
      moved: false,
    };
  }

  pointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const ed = this.ed;
    if (d.kind === 'box') {
      const p = ed.viewport.eventPoint(e);
      if (Math.abs(p.x - d.start.x) + Math.abs(p.y - d.start.y) > 4) d.moved = true;
      if (d.moved) ed.showSelBox(d.start, p);
      return;
    }
    const delta = this.dragDelta(e, d.grab);
    if (!delta) return;
    const entries: Array<[string, Vec3 | null]> = [];
    for (const [lk, before] of d.latticeBefore) {
      entries.push([lk, add(before ?? v3(), delta)]);
    }
    ed.doc.writeShiftsLive(entries); // offsets hard-clamp to ±0.5 in the doc
    d.moved = d.moved || Math.hypot(delta.x, delta.y, delta.z) > 1e-9;
    ed.refreshOverlays();
  }

  /** Pointer → world delta under the active constraint. */
  private dragDelta(e: PointerEvent, grab: Vec3): Vec3 | null {
    const ed = this.ed;
    const c = this.constraint;
    if (c && !c.plane) {
      const u = AXIS_UNITS[c.axis];
      let t = ed.viewport.pickLineThrough(e, grab, u);
      if (!e.altKey) t = snap(t, ed.gridStep);
      return mul(u, t);
    }
    const planeN = c ? AXIS_UNITS[c.axis] : ed.viewport.forward();
    const p = ed.viewport.pickPlaneThrough(e, grab, planeN);
    if (!p) return null;
    const target = e.altKey
      ? p
      : v3(snap(p.x, ed.gridStep), snap(p.y, ed.gridStep), snap(p.z, ed.gridStep));
    const delta = sub(target, grab);
    if (c?.plane) {
      // keep exactly in the constraint plane despite per-axis snapping
      if (c.axis === 0) delta.x = 0;
      else if (c.axis === 1) delta.y = 0;
      else delta.z = 0;
    }
    return delta;
  }

  pointerUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    const ed = this.ed;
    if (!d) return;
    if (d.kind === 'box') {
      if (!d.moved && d.clickHandle) {
        const key = `L:${d.clickHandle.lattice}`;
        if (d.additive && d.clickHandle.selected) {
          ed.selectedVerts.delete(key);
        } else {
          if (!d.additive) ed.selectedVerts.clear();
          ed.selectedVerts.add(key);
          this.lastPicked = d.clickHandle.lattice;
        }
        ed.refreshOverlays();
      } else {
        this.applyBoxSelect(d.start, ed.viewport.eventPoint(e), d.additive);
        ed.hideSelBox();
      }
      return;
    }
    if (!d.moved) return;
    const shifts: ShiftChange[] = [];
    for (const [lk, was] of d.latticeBefore) {
      const now = ed.doc.shifts.get(lk);
      shifts.push({ key: lk, before: was, after: now ? { ...now } : null });
    }
    ed.commitApplied({ shifts });
    ed.refreshOverlays();
  }

  private applyBoxSelect(a: { x: number; y: number }, b: { x: number; y: number }, additive: boolean): void {
    const ed = this.ed;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (!additive) ed.selectedVerts.clear();
    for (const h of this.visibleHandles()) {
      const s = ed.viewport.screenPoint(h.pos);
      if (s && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) {
        ed.selectedVerts.add(`L:${h.lattice}`);
      }
    }
    ed.refreshOverlays();
  }

  rmbClick(_e: PointerEvent): void {
    this.ed.selectedVerts.clear();
    this.ed.refreshOverlays();
  }

  /** Ctrl/Cmd+click: add the shortest edge path from the last-picked corner. */
  private pathSelect(target: VertexHandle): void {
    const ed = this.ed;
    const from = this.lastPicked;
    ed.selectedVerts.add(`L:${target.lattice}`);
    if (from && from !== target.lattice && ed.surfaceLattice.has(from)) {
      const path = this.shortestPath(from, target.lattice);
      for (const lk of path) ed.selectedVerts.add(`L:${lk}`);
    }
    this.lastPicked = target.lattice;
    ed.refreshOverlays();
  }

  /** Dijkstra over surface quad edges, weighted by displaced edge length. */
  private shortestPath(from: string, to: string): string[] {
    const adj = this.latticeNeighbors();
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, string>();
    const visited = new Set<string>();
    // simple O(n²) scan — surface graphs here are small
    for (;;) {
      let cur: string | null = null;
      let best = Infinity;
      for (const [k, d] of dist) {
        if (!visited.has(k) && d < best) {
          best = d;
          cur = k;
        }
      }
      if (cur === null) return [];
      if (cur === to) break;
      visited.add(cur);
      const base = dist.get(cur)!;
      for (const nb of adj.get(cur) ?? []) {
        if (visited.has(nb)) continue;
        const w = len(sub(this.displaced(nb), this.displaced(cur)));
        const alt = base + w;
        if (alt < (dist.get(nb) ?? Infinity)) {
          dist.set(nb, alt);
          prev.set(nb, cur);
        }
      }
    }
    const path: string[] = [];
    for (let k: string | undefined = to; k && k !== from; k = prev.get(k)) path.push(k);
    path.push(from);
    return path;
  }

  // -- constraints & nudges --------------------------------------------------------

  private setConstraint(axis: 0 | 1 | 2, plane: boolean): void {
    const c = this.constraint;
    this.constraint = c && c.axis === axis && c.plane === plane ? null : { axis, plane };
    this.ed.refreshOverlays();
  }

  /** With an axis constraint: step the selection along it, toward (+1) or away (−1) from the camera. */
  private nudge(dir: 1 | -1): void {
    const c = this.constraint;
    if (!c || c.plane) return;
    const keys = this.selectedLattice();
    if (!keys.length) return;
    const centroid = this.selectionCentroid()!;
    const eye = this.ed.viewport.cameraPos();
    const u = AXIS_UNITS[c.axis];
    const toward = dot(u, sub(eye, centroid)) >= 0 ? 1 : -1;
    const delta = mul(u, this.ed.gridStep * dir * toward);
    const shifts: ShiftChange[] = [];
    for (const lk of keys) {
      const was = this.ed.doc.shifts.get(lk);
      shifts.push({
        key: lk,
        before: was ? { ...was } : null,
        after: clampOffset(add(was ?? v3(), delta)),
      });
    }
    this.ed.commit({ shifts });
    this.ed.refreshOverlays();
  }

  // -- brushes -------------------------------------------------------------------
  // All brushes act on the selected corners; the doc clamps offsets to ±½ cell.

  private selectedLattice(): string[] {
    return [...this.ed.selectedVerts]
      .filter((k) => k.startsWith('L:'))
      .map((k) => k.slice(2));
  }

  private displaced(lk: string): Vec3 {
    const [x, y, z] = parseCell(lk);
    const s = this.ed.doc.shifts.get(lk);
    return s ? v3(x + s.x, y + s.y, z + s.z) : v3(x, y, z);
  }

  private applyBrush(compute: (lk: string) => Vec3 | null): void {
    const ed = this.ed;
    const keys = this.selectedLattice();
    if (!keys.length) return;
    const shifts: ShiftChange[] = [];
    for (const lk of keys) {
      const was = ed.doc.shifts.get(lk);
      const before = was ? { ...was } : null;
      const raw = compute(lk);
      const after = raw ? clampOffset(raw) : null;
      const same =
        before === after ||
        (before &&
          after &&
          Math.abs(before.x - after.x) < 1e-9 &&
          Math.abs(before.y - after.y) < 1e-9 &&
          Math.abs(before.z - after.z) < 1e-9);
      if (!same) shifts.push({ key: lk, before, after });
    }
    if (shifts.length) ed.commit({ shifts });
    ed.refreshOverlays();
  }

  /** Lattice adjacency along surface quad edges. */
  private latticeNeighbors(): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      let s = adj.get(a);
      if (!s) adj.set(a, (s = new Set()));
      s.add(b);
    };
    for (const f of this.ed.surface) {
      for (let k = 0; k < 4; k++) {
        const a = f.lattice[k];
        const b = f.lattice[(k + 1) % 4];
        link(a, b);
        link(b, a);
      }
    }
    return adj;
  }

  /** Pull each corner halfway toward the average of its neighbors (breaks edges). */
  private brushSmooth(): void {
    const adj = this.latticeNeighbors();
    this.applyBrush((lk) => {
      const ns = adj.get(lk);
      if (!ns?.size) return this.ed.doc.shifts.get(lk) ?? null;
      let avg = v3();
      for (const n of ns) avg = add(avg, this.displaced(n));
      avg = mul(avg, 1 / ns.size);
      const target = add(mul(this.displaced(lk), 0.5), mul(avg, 0.5));
      const [x, y, z] = parseCell(lk);
      return sub(target, v3(x, y, z));
    });
  }

  /** Nudge corners along their surface normal (out or in). */
  private brushInflate(sign: number): void {
    const lf = this.latticeFaces();
    this.applyBrush((lk) => {
      const cur = this.ed.doc.shifts.get(lk) ?? v3();
      return add(cur, mul(this.latticeNormal(lk, lf), 0.25 * sign));
    });
  }

  /** Small random jitter for organic surfaces. */
  private brushNoise(): void {
    this.applyBrush((lk) => {
      const cur = this.ed.doc.shifts.get(lk) ?? v3();
      const r = () => (Math.random() - 0.5) * 0.3;
      return add(cur, v3(r(), r(), r()));
    });
  }

  key(e: KeyboardEvent): boolean {
    const ed = this.ed;
    switch (e.key.toLowerCase()) {
      case 'x':
        this.setConstraint(0, e.shiftKey);
        return true;
      case 'y':
        this.setConstraint(1, e.shiftKey);
        return true;
      case 'z':
        this.setConstraint(2, e.shiftKey);
        return true;
      case '=':
      case '+':
        this.nudge(1);
        return true;
      case '-':
      case '_':
        this.nudge(-1);
        return true;
      case 'h':
        this.brushSmooth();
        return true;
      case 'u':
        this.brushInflate(1);
        return true;
      case 'j':
        this.brushInflate(-1);
        return true;
      case 'n':
        this.brushNoise();
        return true;
      case 'o':
        this.applyBrush(() => null); // reset offsets
        return true;
      case 'escape':
        if (this.constraint) {
          this.constraint = null;
          ed.refreshOverlays();
          return true;
        }
        if (ed.selectedVerts.size) {
          ed.selectedVerts.clear();
          ed.refreshOverlays();
          return true;
        }
        return false;
    }
    return false;
  }

  statusInfo(): string {
    const n = this.ed.selectedVerts.size;
    const parts: string[] = [];
    if (n) parts.push(`${n} corner${n === 1 ? '' : 's'} selected`);
    const c = this.constraint;
    if (c) parts.push(c.plane ? `plane ⊥ ${'xyz'[c.axis]}` : `axis ${'xyz'[c.axis]} — = / − nudge`);
    return parts.join('  ·  ');
  }
}

function clampOffset(v: Vec3): Vec3 | null {
  const c = (x: number) => Math.max(-0.5, Math.min(0.5, x));
  const out = v3(c(v.x), c(v.y), c(v.z));
  return Math.abs(out.x) < 1e-9 && Math.abs(out.y) < 1e-9 && Math.abs(out.z) < 1e-9 ? null : out;
}
