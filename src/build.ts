import type { Editor } from './editor';
import type { Frame } from './frame';
import { type Quad, quadFromBuffer } from './meshbuilder';
import { type Vec3, v3 } from './vec';
import type { FaceRef, LatticeKey, RectSel } from './world';

/** The two in-plane axes for a face axis (matches the core's convention). */
const planeAxes = (axis: number): [number, number] => [axis === 0 ? 1 : 0, axis === 2 ? 1 : 2];

type Drag = { kind: 'rect'; sel: RectSel } | null;

/**
 * Build mode — the Jarlsberg flow. Click a face (click = 1×1) or drag across
 * its plane to select an axis-aligned rectangle (overhang allowed), then press
 * `=` to extrude the faces present in the rect out one layer, or `-` to carve
 * one layer of the rect's footprint in (the carve plane keeps marching even
 * once nothing is left). All ops execute in the Rust core.
 */
export class BuildMode {
  readonly name = 'build';
  private drag: Drag = null;
  private hoverFace: FaceRef | null = null;

  constructor(private ed: Editor) {}

  enter(): void {
    this.refreshGhost();
  }

  exit(): void {
    this.drag = null;
    this.hoverFace = null;
    this.ed.setGhost(null);
    if (this.ed.boxSel) {
      this.ed.boxSel = null;
      this.ed.refreshOverlays();
    }
  }

  // -- selection geometry helpers ------------------------------------------------

  /** World-space frame of the selection plane (for ray intersection). */
  private planeFrame(sel: RectSel): Frame {
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

  private selFromFace(f: FaceRef): RectSel {
    const axis = (f.dir >> 1) as 0 | 1 | 2;
    const sign = f.dir % 2 === 0 ? 1 : -1;
    const [a1, a2] = planeAxes(axis);
    const a = f.cell[a1];
    const b = f.cell[a2];
    return {
      axis,
      sign,
      plane: f.cell[axis] + (sign > 0 ? 1 : 0),
      a0: a,
      a1: a,
      b0: b,
      b1: b,
    };
  }

  private cellAtLayer(sel: RectSel, a: number, b: number, layer: number): [number, number, number] {
    const c: [number, number, number] = [0, 0, 0];
    c[sel.axis] = layer;
    const [x1, x2] = planeAxes(sel.axis);
    c[x1] = a;
    c[x2] = b;
    return c;
  }

  private updateRect(sel: RectSel, e: PointerEvent): void {
    const hit = this.ed.viewport.pickFrame(e, this.planeFrame(sel));
    if (!hit) return;
    const [a1, a2] = planeAxes(sel.axis);
    const p = [hit.x, hit.y, hit.z];
    sel.a1 = Math.floor(p[a1] + 1e-6);
    sel.b1 = Math.floor(p[a2] + 1e-6);
  }

  /** Overlay quads for the selection rect: real faces where exposed, flat grid quads in air. */
  selectionFaces(): Quad[] {
    const sel = this.ed.boxSel;
    if (!sel) return [];
    const out: Quad[] = [];
    const [lo0, hi0] = [Math.min(sel.a0, sel.a1), Math.max(sel.a0, sel.a1)];
    const [lo1, hi1] = [Math.min(sel.b0, sel.b1), Math.max(sel.b0, sel.b1)];
    const dir = sel.axis * 2 + (sel.sign > 0 ? 0 : 1);
    const inLayer = sel.plane + (sel.sign > 0 ? -1 : 0); // solid-side cell layer
    const [a1, a2] = planeAxes(sel.axis);
    const sculpted = this.ed.geomView === 'sculpted';
    for (let b = lo1; b <= hi1; b++) {
      for (let a = lo0; a <= hi0; a++) {
        const q = this.ed.world.faceQuad(this.cellAtLayer(sel, a, b, inLayer), dir, sculpted);
        if (q) {
          out.push(quadFromBuffer(q));
        } else {
          // flat quad on the plane (air / overhang)
          const mk = (da: number, db: number): Vec3 => {
            const p = [0, 0, 0];
            p[sel.axis] = sel.plane;
            p[a1] = a + da;
            p[a2] = b + db;
            return v3(p[0], p[1], p[2]);
          };
          out.push({ verts: [mk(0, 0), mk(1, 0), mk(1, 1), mk(0, 1)] });
        }
      }
    }
    return out;
  }

  /** Lattice corners of the faces present in the selection rect (for mode handoff). */
  selectionLatticeKeys(): LatticeKey[] {
    const sel = this.ed.boxSel;
    return sel ? this.ed.world.rectCorners(sel) : [];
  }

  // -- extrude / carve --------------------------------------------------------------

  /** Apply one layer of extrusion (dir=1, `=`) or carving (dir=-1, `-`). */
  extrudeStep(dir: 1 | -1): void {
    const ed = this.ed;
    const sel = ed.boxSel;
    if (!sel) return;
    const changed = ed.world.extrudeRect(sel, dir);
    if (dir > 0 && !changed) return; // nothing to grow from — plane stays
    // the carve plane keeps marching even through empty space
    sel.plane += dir > 0 ? sel.sign : -sel.sign;
    ed.refreshOverlays();
  }

  /** Seed a voxel near the origin — the "get unstuck" fallback. */
  seedVoxel(): void {
    this.ed.world.seedVoxel();
    this.ed.refreshOverlays();
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
    const sel = this.selFromFace(pick.face);
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
    const face = pick ? pick.face : null;
    const changed =
      (face === null) !== (this.hoverFace === null) ||
      (face &&
        this.hoverFace &&
        (face.cell[0] !== this.hoverFace.cell[0] ||
          face.cell[1] !== this.hoverFace.cell[1] ||
          face.cell[2] !== this.hoverFace.cell[2] ||
          face.dir !== this.hoverFace.dir));
    if (changed) {
      this.hoverFace = face;
      this.refreshGhost();
    }
  }

  pointerUp(_e: PointerEvent): void {
    this.drag = null;
  }

  rmbClick(_e: PointerEvent): void {
    // reserved for a future tool — LMB-select + `-` covers deletion
  }

  private refreshGhost(): void {
    const f = this.hoverFace;
    const q = f
      ? this.ed.world.faceQuad(f.cell, f.dir, this.ed.geomView === 'sculpted')
      : null;
    this.ed.setGhost(q ? [quadFromBuffer(q)] : null);
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
      case 'o':
      case 'O': {
        // reset the offsets of the selected rect's corners (matches sculpt's O)
        const ed = this.ed;
        if (!ed.boxSel) return false;
        ed.world.resetRectOffsets(ed.boxSel);
        return true;
      }
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
    if (this.hoverFace) {
      const [x, y, z] = this.hoverFace.cell;
      return `cell (${x}, ${y}, ${z}) — click or drag a rect, then = extrude / − carve`;
    }
    return this.ed.world.cellCount() ? '' : 'empty scene — press “+ Voxel” to start';
  }
}
