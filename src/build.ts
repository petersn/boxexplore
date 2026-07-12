import type { Editor } from './editor';
import type { Frame } from './frame';
import type { Face } from './model';
import { type Vec3, v3 } from './vec';
import { type Cell, type VolFace, cellKey, planShiftChanges, planeAxes } from './volume';

/**
 * A rectangular face-plane selection: an axis-aligned rect of footprint cells
 * on the plane of a clicked face. It may overhang into air or across other
 * geometry — extrusion fills the whole rect, carving removes whatever solid
 * the rect covers. `plane` is the integer lattice coordinate of the working
 * face plane along `axis`; it follows the surface as you extrude/carve.
 */
export interface BoxSel {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  plane: number;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

type Drag = { kind: 'rect'; sel: BoxSel } | null;

const DUMMY_UVS: Face['uvs'] = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];

/**
 * Build mode — the Jarlsberg flow. Click a face (click = 1×1) or drag across
 * its plane to select an axis-aligned rectangle (overhang allowed), then press
 * `=` to extrude the rect out one layer or `-` to carve one layer in. The
 * selection plane follows the surface. Right-click carves a single cell;
 * the "+ Voxel" toolbar button seeds a cell when there's nothing to click.
 */
export class BuildMode {
  readonly name = 'build';
  private drag: Drag = null;
  private hoverKey: string | null = null;

  constructor(private ed: Editor) {}

  enter(): void {
    this.refreshGhost();
  }

  exit(): void {
    this.drag = null;
    this.hoverKey = null;
    this.ed.setGhost(null);
    if (this.ed.boxSel) {
      this.ed.boxSel = null;
      this.ed.refreshOverlays();
    }
  }

  // -- selection geometry helpers ------------------------------------------------

  /** World-space frame of the selection plane (for ray intersection). */
  private planeFrame(sel: BoxSel): Frame {
    const [a1, a2] = planeAxes(sel.axis);
    const origin = [0, 0, 0];
    origin[sel.axis] = sel.plane;
    const u = [0, 0, 0];
    u[a1] = 1;
    const v = [0, 0, 0];
    v[a2] = 1;
    const n = [0, 0, 0];
    n[sel.axis] = sel.sign;
    return {
      origin: v3(origin[0], origin[1], origin[2]),
      u: v3(u[0], u[1], u[2]),
      v: v3(v[0], v[1], v[2]),
      n: v3(n[0], n[1], n[2]),
    };
  }

  private selFromFace(vf: VolFace): BoxSel {
    const axis = (vf.dir >> 1) as 0 | 1 | 2;
    const sign = vf.dir % 2 === 0 ? 1 : -1;
    const [a1, a2] = planeAxes(axis);
    const a = vf.cell[a1];
    const b = vf.cell[a2];
    return { axis, sign, plane: vf.cell[axis] + (sign > 0 ? 1 : 0), a0: a, a1: a, b0: b, b1: b };
  }

  private cellAtLayer(sel: BoxSel, a: number, b: number, layer: number): string {
    const c = [0, 0, 0];
    c[sel.axis] = layer;
    const [x1, x2] = planeAxes(sel.axis);
    c[x1] = a;
    c[x2] = b;
    return cellKey(c[0], c[1], c[2]);
  }

  private updateRect(sel: BoxSel, e: PointerEvent): void {
    const hit = this.ed.viewport.pickFrame(e, this.planeFrame(sel));
    if (!hit) return;
    const [a1, a2] = planeAxes(sel.axis);
    const p = [hit.x, hit.y, hit.z];
    const a = Math.floor(p[a1] + 1e-6);
    const b = Math.floor(p[a2] + 1e-6);
    sel.a1 = a;
    sel.b1 = b;
  }

  /** Overlay faces for the selection rect: real faces where exposed, flat grid quads in air. */
  selectionFaces(): Face[] {
    const sel = this.ed.boxSel;
    if (!sel) return [];
    const out: Face[] = [];
    const [lo0, hi0] = [Math.min(sel.a0, sel.a1), Math.max(sel.a0, sel.a1)];
    const [lo1, hi1] = [Math.min(sel.b0, sel.b1), Math.max(sel.b0, sel.b1)];
    const dir = sel.axis * 2 + (sel.sign > 0 ? 0 : 1);
    const inLayer = sel.plane + (sel.sign > 0 ? -1 : 0); // solid-side cell layer
    const [a1, a2] = planeAxes(sel.axis);
    for (let b = lo1; b <= hi1; b++) {
      for (let a = lo0; a <= hi0; a++) {
        const key = `${this.cellAtLayer(sel, a, b, inLayer)}:${dir}`;
        const vf = this.ed.displayMap.get(key);
        if (vf) {
          out.push({ id: 0, verts: vf.verts, uvs: DUMMY_UVS });
        } else {
          // flat quad on the plane (air / overhang)
          const mk = (da: number, db: number): Vec3 => {
            const p = [0, 0, 0];
            p[sel.axis] = sel.plane;
            p[a1] = a + da;
            p[a2] = b + db;
            return v3(p[0], p[1], p[2]);
          };
          out.push({ id: 0, verts: [mk(0, 0), mk(1, 0), mk(1, 1), mk(0, 1)], uvs: DUMMY_UVS });
        }
      }
    }
    return out;
  }

  // -- extrude / carve --------------------------------------------------------------

  /** Apply one layer of extrusion (dir=1, `=`) or carving (dir=-1, `-`). */
  extrudeStep(dir: 1 | -1): void {
    const ed = this.ed;
    const sel = ed.boxSel;
    if (!sel) return;
    const [lo0, hi0] = [Math.min(sel.a0, sel.a1), Math.max(sel.a0, sel.a1)];
    const [lo1, hi1] = [Math.min(sel.b0, sel.b1), Math.max(sel.b0, sel.b1)];
    const out = dir > 0;
    const layer = out
      ? sel.plane + (sel.sign > 0 ? 0 : -1) // the cell just outside the plane
      : sel.plane + (sel.sign > 0 ? -1 : 0); // the cell just inside the plane
    const changed: string[] = [];
    for (let b = lo1; b <= hi1; b++) {
      for (let a = lo0; a <= hi0; a++) {
        const key = this.cellAtLayer(sel, a, b, layer);
        if (out ? !ed.doc.cells.has(key) : ed.doc.cells.has(key)) changed.push(key);
      }
    }
    if (!changed.length) return; // nothing ahead/behind — don't move the plane
    // new surface corners inherit the offset of the corner one layer back along
    // the extrusion axis (the ring they grew out of)
    const sourceDelta: Cell = [0, 0, 0];
    sourceDelta[sel.axis] = out ? -sel.sign : sel.sign;
    const shifts = planShiftChanges(
      ed.doc.cells,
      ed.doc.shifts,
      ed.surfaceLattice,
      out ? changed : [],
      out ? [] : changed,
      sourceDelta,
    );
    ed.commit({
      cellsAdded: out ? changed : undefined,
      cellsRemoved: out ? undefined : changed,
      shifts: shifts.length ? shifts : undefined,
    });
    sel.plane += out ? sel.sign : -sel.sign;
    ed.refreshOverlays();
  }

  /** Seed a voxel near the origin — the "get unstuck" fallback. */
  seedVoxel(): void {
    const ed = this.ed;
    let y = -1;
    while (ed.doc.cells.has(cellKey(0, y, 0)) && y < 64) y++;
    const key = cellKey(0, y, 0);
    const shifts = planShiftChanges(ed.doc.cells, ed.doc.shifts, ed.surfaceLattice, [key], []);
    ed.commit({ cellsAdded: [key], shifts: shifts.length ? shifts : undefined });
    ed.refreshOverlays();
  }

  // -- events ------------------------------------------------------------------------

  pointerDown(e: PointerEvent): void {
    const ed = this.ed;
    const pick = ed.pickVolFace(e);
    if (!pick) {
      if (ed.boxSel) {
        ed.boxSel = null;
        ed.refreshOverlays();
      }
      return;
    }
    const sel = this.selFromFace(pick.vf);
    ed.boxSel = sel;
    this.drag = { kind: 'rect', sel };
    ed.refreshOverlays();
  }

  pointerMove(e: PointerEvent): void {
    const ed = this.ed;
    if (this.drag) {
      this.updateRect(this.drag.sel, e);
      ed.refreshOverlays();
      return;
    }
    const pick = ed.pickVolFace(e);
    const key = pick ? pick.vf.key : null;
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      this.refreshGhost();
    }
  }

  pointerUp(_e: PointerEvent): void {
    this.drag = null;
  }

  rmbClick(e: PointerEvent): void {
    const ed = this.ed;
    const pick = ed.pickVolFace(e);
    if (!pick) return;
    const key = cellKey(...pick.vf.cell);
    const sourceDelta: Cell = [0, 0, 0];
    const axis = pick.vf.dir >> 1;
    sourceDelta[axis] = pick.vf.dir % 2 === 0 ? 1 : -1;
    const shifts = planShiftChanges(
      ed.doc.cells,
      ed.doc.shifts,
      ed.surfaceLattice,
      [],
      [key],
      sourceDelta,
    );
    ed.commit({ cellsRemoved: [key], shifts: shifts.length ? shifts : undefined });
    this.refreshGhost();
  }

  private refreshGhost(): void {
    const vf = this.hoverKey ? this.ed.displayMap.get(this.hoverKey) : null;
    this.ed.setGhost(vf ? [{ id: 0, verts: vf.verts, uvs: DUMMY_UVS }] : null, false, true);
  }

  key(e: KeyboardEvent): boolean {
    switch (e.key) {
      case '=':
      case '+':
        this.extrudeStep(1);
        return true;
      case '-':
      case '_':
        this.extrudeStep(-1);
        return true;
      case 'Delete':
      case 'Backspace':
        this.extrudeStep(-1);
        return true;
      case 'Escape':
        if (this.ed.boxSel) {
          this.ed.boxSel = null;
          this.ed.refreshOverlays();
          return true;
        }
        return false;
    }
    return false;
  }

  statusInfo(): string {
    const sel = this.ed.boxSel;
    if (sel) {
      const w = Math.abs(sel.a1 - sel.a0) + 1;
      const h = Math.abs(sel.b1 - sel.b0) + 1;
      const axis = 'xyz'[sel.axis];
      return `${w}×${h} rect on ${sel.sign > 0 ? '+' : '−'}${axis} @ ${sel.plane} — = extrude · − carve · Esc clear`;
    }
    if (this.hoverKey) {
      const vf = this.ed.surfaceMap.get(this.hoverKey);
      if (vf) {
        const [x, y, z] = vf.cell;
        return `cell (${x}, ${y}, ${z}) — click/drag a rect, then = / −`;
      }
    }
    return this.ed.doc.cells.size ? '' : 'empty scene — press “+ Voxel” to start';
  }
}
