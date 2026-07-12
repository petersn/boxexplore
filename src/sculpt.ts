import type { Editor } from './editor';
import { type ShiftChange } from './model';
import { type Vec3, add, cross, dot, len, mul, norm, snap, sub, v3 } from './vec';
import { type VolFace, DIRS, cellKey, parseCell, segmentBlocked } from './volume';

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

export type SculptTool = 'select' | 'smooth' | 'draw';

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

interface Stroke {
  invert: boolean;
  /** First-touch snapshots of every offset the stroke has written. */
  shiftsBefore: Map<string, Vec3 | null>;
  cellsAdded: Set<string>;
  cellsRemoved: Set<string>;
}

const AXIS_UNITS: readonly Vec3[] = [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)];

const faceNormal = (verts: readonly Vec3[]): Vec3 =>
  norm(cross(sub(verts[2], verts[0]), sub(verts[3], verts[1])));

/**
 * Sculpt mode. The Select tool works on corners: click selects, click a
 * selected corner again to drag it, other drags box-select, X/Y/Z constrain,
 * Ctrl/Cmd+click path-selects. The Smooth and Draw brushes paint over a
 * spatial radius instead: Smooth relaxes the *actual displaced surface* (so
 * hard voxel edges round over even when offsets are zero), Draw pushes the
 * surface out along its normal (Alt pulls in). When "brushes may add/remove
 * voxels" is enabled, a brush pushing a corner past the ±½ clamp flips the
 * voxel and rebases the offset onto the new ring (+0.55 out becomes −0.45 on
 * the next cell), so the surface stays continuous and edits converge instead
 * of oscillating.
 */
export class SculptMode {
  readonly name = 'sculpt';
  tool: SculptTool = 'select';
  constraint: Constraint | null = null;
  private drag: Drag | null = null;
  private stroke: Stroke | null = null;
  private lastPicked: string | null = null;

  constructor(private ed: Editor) {}

  enter(): void {
    this.constraint = null;
    this.setTool('select');
    this.ed.refreshOverlays();
  }

  exit(): void {
    this.constraint = null;
    this.drag = null;
    this.stroke = null;
    this.lastPicked = null;
    this.ed.hideSelBox();
    this.ed.setBrushCursor(null);
    this.ed.refreshOverlays();
  }

  setTool(tool: SculptTool): void {
    this.tool = tool;
    this.ed.updateToolButtons();
    if (tool === 'select') this.ed.setBrushCursor(null);
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
   * just off the surface. (Known to be imperfect — exact depth-buffer
   * visibility is planned for the WASM/wgpu rework.)
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

  // -- spatial brushes ---------------------------------------------------------------

  /** Update the brush cursor ring at the surface under the pointer. */
  private updateCursor(e: PointerEvent): void {
    if (this.tool === 'select') return;
    const pick = this.ed.pickVolFace(e);
    if (pick) {
      const vf = this.ed.displayMap.get(pick.vf.key) ?? pick.vf;
      this.ed.setBrushCursor(pick.point, faceNormal(vf.verts), this.ed.brush.radius);
    } else {
      this.ed.setBrushCursor(null);
    }
  }

  /** One brush application centered on a surface point. */
  private dab(point: Vec3): void {
    const ed = this.ed;
    const st = this.stroke!;
    const { radius, strength } = ed.brush;
    const lf = this.latticeFaces();
    const adj = this.tool === 'smooth' ? this.latticeNeighbors() : null;

    // desired (unclamped) offsets for every corner in range
    const desired = new Map<string, Vec3>();
    for (const lk of ed.surfaceLattice) {
      const pos = this.displaced(lk);
      const dist = Math.hypot(pos.x - point.x, pos.y - point.y, pos.z - point.z);
      if (dist > radius) continue;
      const t = dist / radius;
      const w = strength * (1 - t * t) ** 2;
      let target: Vec3;
      if (this.tool === 'smooth') {
        const ns = adj!.get(lk);
        if (!ns?.size) continue;
        let avg = v3();
        for (const n of ns) avg = add(avg, this.displaced(n));
        avg = mul(avg, 1 / ns.size);
        // relax toward the neighbor average of the *displaced* surface, so
        // voxel edges round over even when all offsets start at zero
        target = add(pos, mul(sub(avg, pos), Math.min(1, w * 0.7)));
      } else {
        const n = this.latticeNormal(lk, lf);
        target = add(pos, mul(n, (st.invert ? -1 : 1) * w * 0.22));
      }
      const [x, y, z] = parseCell(lk);
      desired.set(lk, sub(target, v3(x, y, z)));
    }
    if (!desired.size) return;

    // topology: flip voxels where the surface wants to move past the ±½ clamp,
    // rebasing offsets onto the new ring so the surface stays continuous
    if (ed.brush.topo) {
      const addCells = new Set<string>();
      const removeCells = new Set<string>();
      const rebases = new Map<string, Vec3>();
      for (const [lk, off] of desired) {
        for (const f of lf.get(lk) ?? []) {
          const axis = f.dir >> 1;
          const sign = f.dir % 2 === 0 ? 1 : -1;
          const o = (axis === 0 ? off.x : axis === 1 ? off.y : off.z) * sign;
          const n = DIRS[f.dir];
          if (o > 0.55) {
            const nk = cellKey(f.cell[0] + n[0], f.cell[1] + n[1], f.cell[2] + n[2]);
            if (!ed.doc.cells.has(nk) && !addCells.has(nk)) {
              addCells.add(nk);
              for (const c of f.lattice) {
                const want = desired.get(c);
                if (!want) continue;
                const [cx, cy, cz] = parseCell(c);
                rebases.set(
                  cellKey(cx + n[0], cy + n[1], cz + n[2]),
                  sub(want, v3(n[0], n[1], n[2])),
                );
              }
            }
          } else if (o < -0.55) {
            const ck = cellKey(f.cell[0], f.cell[1], f.cell[2]);
            if (!removeCells.has(ck)) {
              removeCells.add(ck);
              for (const c of f.lattice) {
                const want = desired.get(c);
                if (!want) continue;
                const [cx, cy, cz] = parseCell(c);
                rebases.set(
                  cellKey(cx - n[0], cy - n[1], cz - n[2]),
                  add(want, v3(n[0], n[1], n[2])),
                );
              }
            }
          }
        }
      }
      if (addCells.size || removeCells.size) {
        for (const k of addCells) {
          if (st.cellsRemoved.has(k)) st.cellsRemoved.delete(k);
          else st.cellsAdded.add(k);
        }
        for (const k of removeCells) {
          if (st.cellsAdded.has(k)) st.cellsAdded.delete(k);
          else st.cellsRemoved.add(k);
        }
        ed.doc.writeCellsLive(addCells, removeCells); // rebuilds the surface
        for (const [k, v] of rebases) desired.set(k, v);
      }
    }

    const entries: Array<[string, Vec3 | null]> = [];
    for (const [lk, off] of desired) {
      if (!ed.surfaceLattice.has(lk)) continue; // flipped off the surface
      if (!st.shiftsBefore.has(lk)) {
        const cur = ed.doc.shifts.get(lk);
        st.shiftsBefore.set(lk, cur ? { ...cur } : null);
      }
      entries.push([lk, off]); // the doc hard-clamps to ±0.5
    }
    if (entries.length) ed.doc.writeShiftsLive(entries);
  }

  private endStroke(): void {
    const st = this.stroke;
    this.stroke = null;
    if (!st) return;
    const ed = this.ed;
    // clear any offsets stranded off the surface by topology flips
    const cleanup: Array<[string, Vec3 | null]> = [];
    for (const [k, v] of ed.doc.shifts) {
      if (!ed.surfaceLattice.has(k)) {
        if (!st.shiftsBefore.has(k)) st.shiftsBefore.set(k, { ...v });
        cleanup.push([k, null]);
      }
    }
    if (cleanup.length) ed.doc.writeShiftsLive(cleanup);
    const shifts: ShiftChange[] = [];
    for (const [k, before] of st.shiftsBefore) {
      const now = ed.doc.shifts.get(k);
      const after = now ? { ...now } : null;
      const same =
        (!before && !after) ||
        (before &&
          after &&
          Math.abs(before.x - after.x) < 1e-9 &&
          Math.abs(before.y - after.y) < 1e-9 &&
          Math.abs(before.z - after.z) < 1e-9);
      if (!same) shifts.push({ key: k, before, after });
    }
    ed.commitApplied({
      cellsAdded: st.cellsAdded.size ? [...st.cellsAdded] : undefined,
      cellsRemoved: st.cellsRemoved.size ? [...st.cellsRemoved] : undefined,
      shifts: shifts.length ? shifts : undefined,
    });
    ed.refreshOverlays();
  }

  // -- events -----------------------------------------------------------------

  pointerDown(e: PointerEvent): void {
    const ed = this.ed;
    if (this.tool !== 'select') {
      const pick = ed.pickVolFace(e);
      if (!pick) return;
      this.stroke = {
        invert: e.altKey,
        shiftsBefore: new Map(),
        cellsAdded: new Set(),
        cellsRemoved: new Set(),
      };
      this.dab(pick.point);
      this.updateCursor(e);
      return;
    }
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
    const ed = this.ed;
    if (this.tool !== 'select') {
      if (this.stroke) {
        const pick = ed.pickVolFace(e);
        if (pick) this.dab(pick.point);
      }
      this.updateCursor(e);
      return;
    }
    const d = this.drag;
    if (!d) return;
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
    if (this.tool !== 'select') {
      this.endStroke();
      return;
    }
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

  // -- selection brushes -----------------------------------------------------------
  // These act on the selected corners; the doc clamps offsets to ±½ cell.

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

  /** Pull each selected corner halfway toward the average of its neighbors. */
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

  /** Nudge selected corners along their surface normal (out or in). */
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
      case 'm':
        this.setTool('select');
        return true;
      case 'b':
        this.setTool('smooth');
        return true;
      case 'f':
        this.setTool('draw');
        return true;
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
    const parts: string[] = [];
    if (this.tool !== 'select') {
      parts.push(`${this.tool} brush — drag to paint${this.tool === 'draw' ? ', Alt inverts' : ''}`);
    }
    const n = this.ed.selectedVerts.size;
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
