import type { Editor } from './editor';
import { type Face, type ShiftChange, copyFace } from './model';
import { type Vec3, add, cross, dot, len, mul, norm, snap, sub, v3, vkey } from './vec';
import { type VolFace, DIRS, parseCell, segmentBlocked } from './volume';

export interface VertexHandle {
  pos: Vec3;
  /** [faceId, cornerIndex] pairs sharing this position (welded free corners). */
  refs: Array<[number, number]>;
  /** Set for volume-surface corners: the lattice key this handle displaces. */
  lattice?: string;
  selected: boolean;
}

type Drag =
  | { kind: 'box'; start: { x: number; y: number }; additive: boolean }
  | {
      kind: 'move';
      before: Map<number, Face>;
      /** Lattice key → displacement before the drag (null = none). */
      latticeBefore: Map<string, Vec3 | null>;
      grab: Vec3;
      /** Averaged surface normal at the grabbed handle (Shift constrains to it). */
      normal: Vec3;
      moved: boolean;
      /** Shift+click on an already-selected vertex deselects it on release (unless dragged). */
      pendingDeselect: string[] | null;
    };

const faceNormal = (verts: readonly Vec3[]): Vec3 =>
  norm(cross(sub(verts[2], verts[0]), sub(verts[3], verts[1])));

/**
 * Vertex mode: drag corners to sculpt slopes and terrain. Plain drags move in
 * the camera-facing plane (snapped to the grid per world axis); Shift drags
 * along the corner's surface normal; Alt disables snapping. Volume corners
 * write lattice displacements — hard-clamped to ±½ cell — deforming every
 * touching face at once so the volume stays sealed. Only corners the camera
 * can actually see are shown and pickable.
 */
export class VertexMode {
  readonly name = 'vertex';
  private drag: Drag | null = null;

  constructor(private ed: Editor) {}

  enter(): void {
    this.ed.refreshOverlays();
  }

  exit(): void {
    this.drag = null;
    this.ed.hideSelBox();
    this.ed.refreshOverlays();
  }

  /** Welded free-face corners plus one handle per volume-surface lattice point. */
  handles(): VertexHandle[] {
    const ed = this.ed;
    const map = new Map<string, VertexHandle>();
    for (const f of ed.doc.faces.values()) {
      for (let ci = 0; ci < 4; ci++) {
        const key = vkey(f.verts[ci]);
        let h = map.get(key);
        if (!h) {
          h = { pos: f.verts[ci], refs: [], selected: false };
          map.set(key, h);
        }
        h.refs.push([f.id, ci]);
        if (ed.selectedVerts.has(`${f.id}:${ci}`)) h.selected = true;
      }
    }
    const out = [...map.values()];
    for (const lk of ed.surfaceLattice) {
      const [x, y, z] = parseCell(lk);
      const s = ed.doc.shifts.get(lk);
      out.push({
        pos: v3(x + (s?.x ?? 0), y + (s?.y ?? 0), z + (s?.z ?? 0)),
        refs: [],
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

  /** Averaged surface normal at a handle (world up as a last resort). */
  private handleNormal(h: VertexHandle, latticeFaces?: Map<string, VolFace[]>): Vec3 {
    if (h.lattice) {
      const faces = (latticeFaces ?? this.latticeFaces()).get(h.lattice);
      if (faces?.length) {
        let n = v3();
        for (const f of faces) n = add(n, faceNormal(f.verts));
        if (len(n) > 1e-9) return norm(n);
      }
    } else if (h.refs.length) {
      let n = v3();
      for (const [id] of h.refs) {
        const f = this.ed.doc.faces.get(id);
        if (f) n = add(n, faceNormal(f.verts));
      }
      if (len(n) > 1e-9) return norm(n);
    }
    return v3(0, 1, 0);
  }

  /**
   * Handles the camera can actually see: at least one adjacent face turned
   * toward the camera, and an unobstructed voxel line of sight to the corner
   * (nudged just off the surface along its normal).
   */
  visibleHandles(): VertexHandle[] {
    const ed = this.ed;
    const eye = ed.viewport.cameraPos();
    const lf = this.latticeFaces();
    return this.handles().filter((h) => {
      if (h.lattice) {
        const faces = lf.get(h.lattice);
        if (!faces?.length) return false;
        const facing = faces.some((f) => {
          const n = DIRS[f.dir];
          return n[0] * (eye.x - h.pos.x) + n[1] * (eye.y - h.pos.y) + n[2] * (eye.z - h.pos.z) > 1e-6;
        });
        if (!facing) return false;
        const probe = add(h.pos, mul(this.handleNormal(h, lf), 0.04));
        return !segmentBlocked(ed.doc.cells, eye, probe);
      }
      return !segmentBlocked(ed.doc.cells, eye, h.pos);
    });
  }

  private handleKeys(h: VertexHandle): string[] {
    return h.lattice ? [`L:${h.lattice}`] : h.refs.map(([id, ci]) => `${id}:${ci}`);
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

  // -- events -----------------------------------------------------------------

  pointerDown(e: PointerEvent): void {
    const ed = this.ed;
    const h = this.pickHandle(e);
    if (!h) {
      this.drag = { kind: 'box', start: ed.viewport.eventPoint(e), additive: e.shiftKey };
      return;
    }
    const keys = this.handleKeys(h);
    let pendingDeselect: string[] | null = null;
    if (e.shiftKey) {
      if (keys.every((k) => ed.selectedVerts.has(k))) {
        pendingDeselect = keys;
      } else {
        for (const k of keys) ed.selectedVerts.add(k);
        ed.refreshOverlays();
      }
    } else if (!keys.some((k) => ed.selectedVerts.has(k))) {
      ed.selectedVerts.clear();
      for (const k of keys) ed.selectedVerts.add(k);
      ed.refreshOverlays();
    }
    const before = new Map<number, Face>();
    const latticeBefore = new Map<string, Vec3 | null>();
    for (const key of ed.selectedVerts) {
      if (key.startsWith('L:')) {
        const lk = key.slice(2);
        const s = ed.doc.shifts.get(lk);
        latticeBefore.set(lk, s ? { ...s } : null);
      } else {
        const id = Number(key.split(':')[0]);
        const f = ed.doc.faces.get(id);
        if (f && !before.has(id)) before.set(id, copyFace(f));
      }
    }
    this.drag = {
      kind: 'move',
      before,
      latticeBefore,
      grab: { ...h.pos },
      normal: this.handleNormal(h),
      moved: false,
      pendingDeselect,
    };
  }

  pointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const ed = this.ed;
    if (d.kind === 'box') {
      ed.showSelBox(d.start, ed.viewport.eventPoint(e));
      return;
    }
    let delta: Vec3 | null = null;
    if (e.shiftKey) {
      // constrain to the corner's surface normal
      let t = ed.viewport.pickLineThrough(e, d.grab, d.normal);
      if (!e.altKey) t = snap(t, ed.gridStep);
      delta = mul(d.normal, t);
    } else {
      // free move in the camera-facing plane, snapped per world axis
      const p = ed.viewport.pickPlaneThrough(e, d.grab, ed.viewport.forward());
      if (p) {
        const target = e.altKey
          ? p
          : v3(snap(p.x, ed.gridStep), snap(p.y, ed.gridStep), snap(p.z, ed.gridStep));
        delta = sub(target, d.grab);
      }
    }
    if (!delta) return;
    const moved: Face[] = [];
    for (const [id, before] of d.before) {
      const c = copyFace(before);
      for (let ci = 0; ci < 4; ci++) {
        if (ed.selectedVerts.has(`${id}:${ci}`)) {
          c.verts[ci] = add(before.verts[ci], delta);
        }
      }
      moved.push(c);
    }
    if (moved.length) ed.doc.writeLive(moved);
    if (d.latticeBefore.size) {
      const entries: Array<[string, Vec3 | null]> = [];
      for (const [lk, before] of d.latticeBefore) {
        entries.push([lk, add(before ?? v3(), delta)]);
      }
      ed.doc.writeShiftsLive(entries); // offsets hard-clamp to ±0.5 in the doc
    }
    d.moved = d.moved || Math.hypot(delta.x, delta.y, delta.z) > 1e-9;
    ed.refreshOverlays();
  }

  pointerUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    const ed = this.ed;
    if (!d) return;
    if (d.kind === 'box') {
      this.applyBoxSelect(d.start, ed.viewport.eventPoint(e), d.additive);
      ed.hideSelBox();
      return;
    }
    if (!d.moved) {
      if (d.pendingDeselect) {
        for (const k of d.pendingDeselect) ed.selectedVerts.delete(k);
        ed.refreshOverlays();
      }
      return;
    }
    const before = [...d.before.values()];
    const after = before
      .map((f) => ed.doc.faces.get(f.id))
      .filter((f): f is Face => !!f)
      .map(copyFace);
    const shifts: ShiftChange[] = [];
    for (const [lk, was] of d.latticeBefore) {
      const now = ed.doc.shifts.get(lk);
      shifts.push({ key: lk, before: was, after: now ? { ...now } : null });
    }
    ed.commitApplied({ before, after, shifts });
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
        for (const k of this.handleKeys(h)) ed.selectedVerts.add(k);
      }
    }
    ed.refreshOverlays();
  }

  rmbClick(_e: PointerEvent): void {
    this.ed.selectedVerts.clear();
    this.ed.refreshOverlays();
  }

  /** Merge all selected free corners at their centroid (Crocotile's combine). */
  private mergeSelected(): void {
    const ed = this.ed;
    if (!ed.selectedVerts.size) return;
    const byFace = new Map<number, Face>();
    let c: Vec3 = { x: 0, y: 0, z: 0 };
    let n = 0;
    const seen = new Set<string>();
    for (const key of ed.selectedVerts) {
      if (key.startsWith('L:')) continue; // lattice corners keep their topology
      const [idStr, ciStr] = key.split(':');
      const f = ed.doc.faces.get(Number(idStr));
      if (!f) continue;
      byFace.set(f.id, f);
      const v = f.verts[Number(ciStr)];
      const pk = vkey(v);
      if (!seen.has(pk)) {
        seen.add(pk);
        c = add(c, v);
        n++;
      }
    }
    if (!n) return;
    c = mul(c, 1 / n);
    const faces = [...byFace.values()];
    const before = faces.map(copyFace);
    const after = faces.map((f) => {
      const copy = copyFace(f);
      for (let ci = 0; ci < 4; ci++) {
        if (ed.selectedVerts.has(`${f.id}:${ci}`)) copy.verts[ci] = { ...c };
      }
      return copy;
    });
    ed.commit({ before, after });
    ed.refreshOverlays();
  }

  // -- brushes -------------------------------------------------------------------
  // All brushes act on the selected lattice corners; the doc clamps offsets to
  // ±½ cell so geometry never strays far from its voxel.

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
      const faces = lf.get(lk);
      if (!faces?.length) return cur;
      let n = v3();
      for (const f of faces) n = add(n, faceNormal(f.verts));
      if (len(n) < 1e-9) return cur;
      return add(cur, mul(norm(n), 0.25 * sign));
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
        this.mergeSelected();
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
      case 'y':
        this.brushNoise();
        return true;
      case 'o':
        this.applyBrush(() => null); // reset offsets
        return true;
      case 'escape':
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
    return n ? `${n} corner${n === 1 ? '' : 's'} selected` : '';
  }
}

function clampOffset(v: Vec3): Vec3 | null {
  const c = (x: number) => Math.max(-0.5, Math.min(0.5, x));
  const out = v3(c(v.x), c(v.y), c(v.z));
  return Math.abs(out.x) < 1e-9 && Math.abs(out.y) < 1e-9 && Math.abs(out.z) < 1e-9 ? null : out;
}
