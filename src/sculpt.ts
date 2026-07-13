import type { Editor } from './editor';
import { quadFromBuffer } from './meshbuilder';
import { type Vec3, add, cross, mul, norm, snap, sub, v3 } from './vec';
import type { CornerHandle, LatticeKey } from './world';

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
      clickHandle: CornerHandle | null;
      moved: boolean;
    }
  | { kind: 'move'; grab: Vec3; moved: boolean }
  | { kind: 'stroke' };

const AXIS_UNITS: readonly Vec3[] = [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)];

/**
 * Sculpt mode. The Select tool works on corners: click selects, click a
 * selected corner again to drag it, other drags box-select, X/Y/Z constrain,
 * Ctrl/Cmd+click path-selects. The Smooth and Draw brushes paint over a
 * spatial radius. All geometry math runs in the Rust core; this class turns
 * pointer/keyboard input into core calls.
 */
export class SculptMode {
  readonly name = 'sculpt';
  tool: SculptTool = 'draw';
  constraint: Constraint | null = null;
  private drag: Drag | null = null;
  private lastPicked: LatticeKey | null = null;
  private visibleCache: CornerHandle[] | null = null;

  constructor(private ed: Editor) {}

  enter(): void {
    this.constraint = null;
    // the active tool persists across mode switches
    this.ed.updateToolButtons();
    this.ed.refreshOverlays();
  }

  exit(): void {
    this.constraint = null;
    this.drag = null;
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

  /** Invalidate the visible-corner cache (camera or document changed). */
  invalidateVisible(): void {
    this.visibleCache = null;
  }

  /** Corners the camera can actually see (computed in the core). */
  visibleHandles(): CornerHandle[] {
    if (!this.visibleCache) {
      const eye = this.ed.viewport.cameraPos();
      this.visibleCache = this.ed.world.visibleCorners(eye).map((c) => ({
        ...c,
        selected: this.ed.selectedVerts.has(`L:${c.lattice}`),
      }));
    } else {
      for (const h of this.visibleCache) {
        h.selected = this.ed.selectedVerts.has(`L:${h.lattice}`);
      }
    }
    return this.visibleCache;
  }

  private pickHandle(e: PointerEvent): CornerHandle | null {
    const ed = this.ed;
    const pt = ed.viewport.eventPoint(e);
    let best: CornerHandle | null = null;
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

  private selectedLattice(): LatticeKey[] {
    return [...this.ed.selectedVerts]
      .filter((k) => k.startsWith('L:'))
      .map((k) => k.slice(2));
  }

  /** Centroid of the selected corners (for the constraint widget and nudges). */
  selectionCentroid(): Vec3 | null {
    const keys = this.selectedLattice();
    if (!keys.length) return null;
    let c = v3();
    for (const lk of keys) c = add(c, this.ed.world.cornerPos(lk));
    return mul(c, 1 / keys.length);
  }

  // -- events -----------------------------------------------------------------

  private updateCursor(e: PointerEvent): void {
    if (this.tool === 'select') return;
    const pick = this.ed.pickVolFace(e);
    if (pick) {
      const q = this.ed.world.faceQuad(
        pick.face.cell,
        pick.face.dir,
        this.ed.geomView === 'sculpted',
      );
      if (q) {
        const quad = quadFromBuffer(q);
        const n = norm(
          cross(sub(quad.verts[2], quad.verts[0]), sub(quad.verts[3], quad.verts[1])),
        );
        this.ed.setBrushCursor(pick.point, n, this.ed.brush.radius);
        return;
      }
    }
    this.ed.setBrushCursor(null);
  }

  pointerDown(e: PointerEvent): void {
    const ed = this.ed;
    if (this.tool !== 'select') {
      const pick = ed.pickVolFace(e);
      if (!pick) return;
      // with an axis constraint, the Draw brush pushes along that axis,
      // signed toward the camera's side of the surface
      let dirOverride: Vec3 | undefined;
      const c = this.constraint;
      if (this.tool === 'draw' && c && !c.plane) {
        const u = AXIS_UNITS[c.axis];
        const eye = ed.viewport.cameraPos();
        const toward =
          u.x * (eye.x - pick.point.x) +
          u.y * (eye.y - pick.point.y) +
          u.z * (eye.z - pick.point.z);
        dirOverride = mul(u, toward >= 0 ? 1 : -1);
      }
      ed.world.strokeBegin(
        this.tool,
        e.altKey,
        ed.brush.radius,
        ed.brush.strength,
        ed.brush.topo,
        dirOverride,
      );
      ed.world.strokeDab(pick.point);
      this.drag = { kind: 'stroke' };
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
      ed.world.dragBegin(this.selectedLattice());
      this.drag = { kind: 'move', grab: { ...h.pos }, moved: false };
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
      if (this.drag?.kind === 'stroke') {
        const pick = ed.pickVolFace(e);
        if (pick) ed.world.strokeDab(pick.point);
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
    if (d.kind !== 'move') return;
    const delta = this.dragDelta(e, d.grab);
    if (!delta) return;
    ed.world.dragUpdate(delta); // offsets hard-clamp to ±0.5 in the core
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
    const ed = this.ed;
    if (this.tool !== 'select') {
      if (this.drag?.kind === 'stroke') {
        ed.world.strokeEnd();
        this.drag = null;
      }
      return;
    }
    const d = this.drag;
    this.drag = null;
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
    if (d.kind === 'move') {
      ed.world.dragEnd();
      ed.refreshOverlays();
    }
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
  private pathSelect(target: CornerHandle): void {
    const ed = this.ed;
    ed.selectedVerts.add(`L:${target.lattice}`);
    const from = this.lastPicked;
    if (from && from !== target.lattice && ed.world.surfaceHasCorner(from)) {
      for (const lk of ed.world.shortestPath(from, target.lattice)) {
        ed.selectedVerts.add(`L:${lk}`);
      }
    }
    this.lastPicked = target.lattice;
    ed.refreshOverlays();
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
    const towardEye =
      u.x * (eye.x - centroid.x) + u.y * (eye.y - centroid.y) + u.z * (eye.z - centroid.z);
    const toward = towardEye >= 0 ? 1 : -1;
    const delta = mul(u, this.ed.gridStep * dir * toward);
    this.ed.world.selectionOp(keys, 'nudge', delta);
    this.ed.refreshOverlays();
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
        ed.world.selectionOp(this.selectedLattice(), 'smooth');
        ed.refreshOverlays();
        return true;
      case 'u':
        ed.world.selectionOp(this.selectedLattice(), 'inflate');
        ed.refreshOverlays();
        return true;
      case 'j':
        ed.world.selectionOp(this.selectedLattice(), 'deflate');
        ed.refreshOverlays();
        return true;
      case 'n':
        ed.world.selectionOp(this.selectedLattice(), 'noise');
        ed.refreshOverlays();
        return true;
      case 'o':
        ed.world.selectionOp(this.selectedLattice(), 'reset');
        ed.refreshOverlays();
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
