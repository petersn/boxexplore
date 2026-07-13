import type { Editor } from './editor';
import { quadFromBuffer } from './meshbuilder';
import type { FaceRef, PaintOrient } from './world';

/** The two in-plane axes for a face axis (matches the core's convention). */
const planeAxes = (axis: number): [number, number] => [axis === 0 ? 1 : 0, axis === 2 ? 1 : 2];

const mod = (n: number, m: number) => ((n % m) + m) % m;

/**
 * Paint mode: assign tileset tiles to volume faces. Click/drag paints the
 * hovered faces with the palette stamp — multi-tile stamps tile as a pattern
 * locked to the face grid, so dragging lays coherent patterns. Q/E rotate,
 * F/R flip, Alt+click eyedrops, X+drag or right-click erases. A drag is one
 * undo op. Paints render in the "Textured" view and follow geometry edits
 * (extrusions carry paint with them).
 */
export class PaintMode {
  readonly name = 'paint';
  orient: PaintOrient = { rot: 0, flipH: false, flipV: false };
  private stroke: 'paint' | 'erase' | null = null;
  private hoverFace: FaceRef | null = null;

  constructor(private ed: Editor) {}

  enter(): void {
    if (this.ed.texView !== 'textured') {
      this.ed.toggleTexView(); // painting is invisible untextured — switch
    }
    this.refreshGhost();
  }

  exit(): void {
    if (this.stroke) {
      this.ed.world.paintStrokeEnd();
      this.stroke = null;
    }
    this.hoverFace = null;
    this.ed.setGhost(null);
  }

  /** The stamp tile for a face: pattern-locked to the face's in-plane grid. */
  private tileFor(face: FaceRef): [number, number] {
    const s = this.ed.stamp;
    const [a1, a2] = planeAxes(face.dir >> 1);
    const a = face.cell[a1];
    const b = face.cell[a2];
    return [s.tx + mod(a, s.w), s.ty + mod(s.h - 1 - mod(b, s.h), s.h)];
  }

  private applyAt(face: FaceRef): void {
    if (this.stroke === 'erase') {
      this.ed.world.erasePaintFace(face);
    } else {
      const [tx, ty] = this.tileFor(face);
      this.ed.world.paintFace(face, tx, ty, this.orient);
    }
  }

  // -- events -----------------------------------------------------------------

  pointerDown(e: PointerEvent): void {
    const ed = this.ed;
    const pick = ed.pickVolFace(e);
    if (!pick) return;
    if (e.altKey) {
      // eyedrop the face's tile into the palette
      const p = ed.world.getPaint(pick.face);
      if (p) {
        ed.palette.select(p[0], p[1]);
        this.orient = { rot: p[2] as PaintOrient['rot'], flipH: p[3], flipV: p[4] };
      }
      return;
    }
    ed.world.paintStrokeBegin();
    this.stroke = ed.keyHeld?.('x') || e.ctrlKey || e.metaKey ? 'erase' : 'paint';
    this.applyAt(pick.face);
  }

  pointerMove(e: PointerEvent): void {
    const ed = this.ed;
    const pick = ed.pickVolFace(e);
    if (this.stroke && pick) {
      this.applyAt(pick.face);
    }
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
    if (this.stroke) {
      this.ed.world.paintStrokeEnd();
      this.stroke = null;
    }
  }

  rmbClick(e: PointerEvent): void {
    // right-click erases one face's paint
    const pick = this.ed.pickVolFace(e);
    if (!pick) return;
    this.ed.world.paintStrokeBegin();
    this.ed.world.erasePaintFace(pick.face);
    this.ed.world.paintStrokeEnd();
  }

  private refreshGhost(): void {
    const f = this.hoverFace;
    const q = f
      ? this.ed.world.faceQuad(f.cell, f.dir, this.ed.geomView === 'sculpted')
      : null;
    this.ed.setGhost(q ? [quadFromBuffer(q)] : null);
  }

  key(e: KeyboardEvent): boolean {
    switch (e.key.toLowerCase()) {
      case 'q':
        this.orient.rot = ((this.orient.rot + 3) % 4) as PaintOrient['rot'];
        return true;
      case 'e':
        this.orient.rot = ((this.orient.rot + 1) % 4) as PaintOrient['rot'];
        return true;
      case 'f':
        this.orient.flipH = !this.orient.flipH;
        return true;
      case 'r':
        this.orient.flipV = !this.orient.flipV;
        return true;
    }
    return false;
  }

  statusInfo(): string {
    const s = this.ed.stamp;
    const o = this.orient;
    const parts = [`tile (${s.tx},${s.ty})${s.w > 1 || s.h > 1 ? ` ${s.w}×${s.h}` : ''}`];
    if (o.rot) parts.push(`rot ${o.rot * 90}°`);
    if (o.flipH) parts.push('flipH');
    if (o.flipV) parts.push('flipV');
    parts.push('drag paint · X/RMB erase · Alt eyedrop');
    return parts.join(' · ');
  }
}
