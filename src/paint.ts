import type { Editor } from './editor';
import { type Quad, quadFromBuffer } from './meshbuilder';
import type { FaceRef, PaintOrient } from './world';

/** The two in-plane axes for a face axis (matches the core's convention). */
const planeAxes = (axis: number): [number, number] => [axis === 0 ? 1 : 0, axis === 2 ? 1 : 2];

const mod = (n: number, m: number) => ((n % m) + m) % m;

interface Target {
  face: FaceRef;
  tx: number;
  ty: number;
  orient: PaintOrient;
}

interface StampLayout {
  w: number;
  h: number;
  /** "lx,ly" (y-up arrangement coords) → tile. */
  cells: Map<string, { tx: number; ty: number }>;
}

/**
 * Paint mode: assign tileset tiles to volume faces.
 *
 * - Single tile selected: the radius slider paints every face within reach
 *   (a real brush); sweeps fill the whole path between pointer events.
 * - Multi-tile stamp: places the whole block, grid-locked so neighboring
 *   placements tile seamlessly; Q/E/F/R rotate/flip the block, and a live
 *   textured preview shows exactly what will land where.
 * - Random scatter: each face in the radius gets a random tile from the
 *   selection with a random orientation — for organic variety.
 *
 * Alt+click eyedrops, X/Ctrl/Cmd+drag or right-click erases, a drag is one
 * undo op, and paints follow geometry edits (extrusion carries them).
 */
export class PaintMode {
  readonly name = 'paint';
  orient: PaintOrient = { rot: 0, flipH: false, flipV: false };
  private stroke: 'paint' | 'erase' | null = null;
  private lastPt: { x: number; y: number } | null = null;
  private hoverFace: FaceRef | null = null;
  private hoverPoint: { x: number; y: number; z: number } | null = null;

  constructor(private ed: Editor) {}

  enter(): void {
    if (this.ed.texView !== 'textured') {
      this.ed.toggleTexView(); // painting is invisible untextured — switch
    }
    this.refreshPreview();
  }

  exit(): void {
    if (this.stroke) {
      this.ed.world.paintStrokeEnd();
      this.stroke = null;
    }
    this.hoverFace = null;
    this.hoverPoint = null;
    this.lastPt = null;
    this.ed.setGhost(null);
    this.ed.setStampGhost(null);
  }

  // -- stamp layout ---------------------------------------------------------------

  /** The stamp arrangement under the current orientation (flips, then CW turns). */
  private layout(): StampLayout {
    const s = this.ed.stamp;
    let w = s.w;
    let h = s.h;
    let cells: Array<{ x: number; y: number; tx: number; ty: number }> = [];
    for (let sy = 0; sy < s.h; sy++) {
      for (let sx = 0; sx < s.w; sx++) {
        // arrangement is y-up: tileset row 0 (top) lands at the highest y
        cells.push({ x: sx, y: s.h - 1 - sy, tx: s.tx + sx, ty: s.ty + sy });
      }
    }
    if (this.orient.flipH) cells = cells.map((c) => ({ ...c, x: w - 1 - c.x }));
    if (this.orient.flipV) cells = cells.map((c) => ({ ...c, y: h - 1 - c.y }));
    for (let k = 0; k < this.orient.rot; k++) {
      cells = cells.map((c) => ({ ...c, x: c.y, y: w - 1 - c.x }));
      const t = w;
      w = h;
      h = t;
    }
    const map = new Map<string, { tx: number; ty: number }>();
    for (const c of cells) map.set(`${c.x},${c.y}`, { tx: c.tx, ty: c.ty });
    return { w, h, cells: map };
  }

  /** Everything one application at (point, face) would paint. */
  private targetsFor(point: { x: number; y: number; z: number }, face: FaceRef): Target[] {
    const ed = this.ed;
    const s = ed.stamp;
    const brush = ed.paintBrush;

    if (brush.scatter) {
      const faces =
        brush.radius > 0.05
          ? ed.world.facesInRadius(point, brush.radius, face.dir)
          : [face];
      return faces.map((f) => ({
        face: f,
        tx: s.tx + Math.floor(Math.random() * s.w),
        ty: s.ty + Math.floor(Math.random() * s.h),
        orient: {
          rot: Math.floor(Math.random() * 4) as PaintOrient['rot'],
          flipH: Math.random() < 0.5,
          flipV: Math.random() < 0.5,
        },
      }));
    }

    if (s.w === 1 && s.h === 1) {
      const faces =
        brush.radius > 0.05
          ? ed.world.facesInRadius(point, brush.radius, face.dir)
          : [face];
      return faces.map((f) => ({ face: f, tx: s.tx, ty: s.ty, orient: { ...this.orient } }));
    }

    // multi-tile stamp: place the whole block, grid-aligned on the face plane
    const layout = this.layout();
    const axis = face.dir >> 1;
    const [a1, a2] = planeAxes(axis);
    const a = face.cell[a1];
    const b = face.cell[a2];
    const a0 = Math.floor(a / layout.w) * layout.w;
    const b0 = Math.floor(b / layout.h) * layout.h;
    const out: Target[] = [];
    for (const [key, tile] of layout.cells) {
      const [lx, ly] = key.split(',').map(Number);
      const cell: [number, number, number] = [0, 0, 0];
      cell[axis] = face.cell[axis];
      cell[a1] = a0 + lx;
      cell[a2] = b0 + ly;
      if (!this.ed.world.faceQuad(cell, face.dir, true)) continue; // not exposed
      out.push({ face: { cell, dir: face.dir }, tx: tile.tx, ty: tile.ty, orient: { ...this.orient } });
    }
    return out;
  }

  private applyAt(point: { x: number; y: number; z: number }, face: FaceRef): void {
    if (this.stroke === 'erase') {
      const brush = this.ed.paintBrush;
      const faces =
        brush.radius > 0.05
          ? this.ed.world.facesInRadius(point, brush.radius, face.dir)
          : [face];
      this.ed.world.eraseFacesBatch(faces);
    } else {
      this.ed.world.paintFacesBatch(this.targetsFor(point, face));
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
    this.stroke = ed.keyHeld('x') || e.ctrlKey || e.metaKey ? 'erase' : 'paint';
    this.applyAt(pick.point, pick.face);
    this.lastPt = ed.viewport.eventPoint(e);
  }

  pointerMove(e: PointerEvent): void {
    const ed = this.ed;
    const cur = ed.viewport.eventPoint(e);
    if (this.stroke) {
      // fill the whole swept path, not just this frame's pointer position
      const prev = this.lastPt ?? cur;
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(dist / 6));
      for (let i = 1; i <= steps; i++) {
        const x = prev.x + (dx * i) / steps;
        const y = prev.y + (dy * i) / steps;
        const hit = ed.viewport.pickGroupAt(x, y, ed.renderer.group);
        if (!hit || hit.faceIndex == null) continue;
        const face = ed.renderer.faceAt(hit.object, hit.faceIndex);
        if (face) {
          this.applyAt({ x: hit.point.x, y: hit.point.y, z: hit.point.z }, face);
        }
      }
      this.lastPt = cur;
      return;
    }
    // hover preview
    const pick = ed.pickVolFace(e);
    const face = pick ? pick.face : null;
    const moved =
      (face === null) !== (this.hoverFace === null) ||
      (face &&
        this.hoverFace &&
        (face.cell[0] !== this.hoverFace.cell[0] ||
          face.cell[1] !== this.hoverFace.cell[1] ||
          face.cell[2] !== this.hoverFace.cell[2] ||
          face.dir !== this.hoverFace.dir)) ||
      (pick && this.ed.paintBrush.radius > 0.05); // radius previews track the point
    if (moved) {
      this.hoverFace = face;
      this.hoverPoint = pick ? pick.point : null;
      this.refreshPreview();
    }
  }

  pointerUp(_e: PointerEvent): void {
    if (this.stroke) {
      this.ed.world.paintStrokeEnd();
      this.stroke = null;
      this.lastPt = null;
    }
  }

  rmbClick(e: PointerEvent): void {
    // right-click erases (radius-aware)
    const pick = this.ed.pickVolFace(e);
    if (!pick) return;
    this.ed.world.paintStrokeBegin();
    const brush = this.ed.paintBrush;
    const faces =
      brush.radius > 0.05
        ? this.ed.world.facesInRadius(pick.point, brush.radius, pick.face.dir)
        : [pick.face];
    this.ed.world.eraseFacesBatch(faces);
    this.ed.world.paintStrokeEnd();
  }

  /** Textured ghost of exactly what a click would paint (tint for scatter). */
  refreshPreview(): void {
    const ed = this.ed;
    if (!this.hoverFace || !this.hoverPoint) {
      ed.setGhost(null);
      ed.setStampGhost(null);
      return;
    }
    if (ed.paintBrush.scatter) {
      // scatter is random — show the affected area as a tint instead
      const faces =
        ed.paintBrush.radius > 0.05
          ? ed.world.facesInRadius(this.hoverPoint, ed.paintBrush.radius, this.hoverFace.dir)
          : [this.hoverFace];
      const quads: Quad[] = [];
      for (const f of faces) {
        const q = ed.world.faceQuad(f.cell, f.dir, ed.geomView === 'sculpted');
        if (q) quads.push(quadFromBuffer(q));
      }
      ed.setStampGhost(null);
      ed.setGhost(quads.length ? quads : null);
      return;
    }
    const targets = this.targetsFor(this.hoverPoint, this.hoverFace);
    const quads: Quad[] = [];
    const uvs: number[] = [];
    for (const t of targets) {
      const q = ed.world.faceQuad(t.face.cell, t.face.dir, ed.geomView === 'sculpted');
      if (!q) continue;
      quads.push(quadFromBuffer(q));
      uvs.push(...tileUVs(ed, t.tx, t.ty, t.orient));
    }
    ed.setGhost(null);
    ed.setStampGhost(quads.length ? { quads, uvs } : null);
  }

  key(e: KeyboardEvent): boolean {
    switch (e.key.toLowerCase()) {
      case 'q':
        this.orient.rot = ((this.orient.rot + 3) % 4) as PaintOrient['rot'];
        this.refreshPreview();
        return true;
      case 'e':
        this.orient.rot = ((this.orient.rot + 1) % 4) as PaintOrient['rot'];
        this.refreshPreview();
        return true;
      case 'f':
        this.orient.flipH = !this.orient.flipH;
        this.refreshPreview();
        return true;
      case 'r':
        this.orient.flipV = !this.orient.flipV;
        this.refreshPreview();
        return true;
    }
    return false;
  }

  statusInfo(): string {
    const s = this.ed.stamp;
    const o = this.orient;
    const b = this.ed.paintBrush;
    const parts = [`tile (${s.tx},${s.ty})${s.w > 1 || s.h > 1 ? ` ${s.w}×${s.h}` : ''}`];
    if (b.scatter) parts.push('scatter');
    if (b.radius > 0.05) parts.push(`r=${b.radius}`);
    if (o.rot) parts.push(`rot ${o.rot * 90}°`);
    if (o.flipH) parts.push('flipH');
    if (o.flipV) parts.push('flipV');
    parts.push('drag paint · X/RMB erase · Alt eyedrop');
    return parts.join(' · ');
  }
}

/** UVs for a tile with orientation, [bl,br,tr,tl] — mirrors the core mesher. */
function tileUVs(ed: Editor, tx: number, ty: number, o: PaintOrient): number[] {
  const cols = ed.tileset.cols;
  const rows = ed.tileset.rows;
  const u0 = tx / cols;
  const u1 = (tx + 1) / cols;
  const v1 = 1 - ty / rows;
  const v0 = 1 - (ty + 1) / rows;
  let uv: Array<[number, number]> = [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
  if (o.flipH) {
    uv = [uv[1], uv[0], uv[3], uv[2]];
  }
  if (o.flipV) {
    uv = [uv[3], uv[2], uv[1], uv[0]];
  }
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const src = uv[(i + 3 * o.rot) % 4];
    out.push(src[0], src[1]);
  }
  return out;
}
