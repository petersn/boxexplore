import { type Vec2, type Vec3, add, c3, cross, dot, mul, sub, v2, v3 } from './vec';
import type { Face } from './model';
import type { Tileset } from './tileset';

export type PlaneAxis = 'x' | 'y' | 'z';

/**
 * A working-plane frame: `origin` is the corner of cell (0,0); `u` and `v` are
 * the cell step vectors (one tile along each grid direction, not necessarily
 * unit or orthogonal for tilted frames); `n` is the unit normal.
 * cross(u, v) points along +n, so faces built in this frame face +n.
 */
export interface Frame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
}

/** Axis-aligned frame. u/v are chosen so textures read upright from the usual view. */
export function axisFrame(axis: PlaneAxis, offset: number): Frame {
  switch (axis) {
    case 'x':
      return { origin: v3(offset, 0, 0), u: v3(0, 0, -1), v: v3(0, 1, 0), n: v3(1, 0, 0) };
    case 'y':
      return { origin: v3(0, offset, 0), u: v3(1, 0, 0), v: v3(0, 0, -1), n: v3(0, 1, 0) };
    case 'z':
      return { origin: v3(0, 0, offset), u: v3(1, 0, 0), v: v3(0, 1, 0), n: v3(0, 0, 1) };
  }
}

/** Frame lying in an existing face's plane, with cells continuing that face's grid. */
export function frameFromFace(face: { verts: Face['verts'] }): Frame | null {
  const [bl, br, , tl] = face.verts;
  const u = sub(br, bl);
  const v = sub(tl, bl);
  const n = cross(u, v);
  const nl = Math.hypot(n.x, n.y, n.z);
  if (nl < 1e-8) return null;
  return { origin: c3(bl), u, v, n: mul(n, 1 / nl) };
}

/** Mirror a frame so it is right-handed when viewed from the other side. */
export function mirrorFrame(f: Frame): Frame {
  return { origin: f.origin, u: mul(f.u, -1), v: f.v, n: mul(f.n, -1) };
}

/** Frame oriented toward the viewer at `eye` (mirrors if the eye is behind the plane). */
export function frameFacing(f: Frame, eye: Vec3): Frame {
  return dot(f.n, sub(eye, f.origin)) < 0 ? mirrorFrame(f) : f;
}

/** In-plane coordinates (in cell units) of world point `p`; handles skewed u/v. */
export function frameLocal(f: Frame, p: Vec3): Vec2 {
  const d = sub(p, f.origin);
  const uu = dot(f.u, f.u);
  const vv = dot(f.v, f.v);
  const uv = dot(f.u, f.v);
  const du = dot(d, f.u);
  const dv = dot(d, f.v);
  const det = uu * vv - uv * uv || 1e-12;
  return v2((du * vv - dv * uv) / det, (dv * uu - du * uv) / det);
}

/** World position of in-plane coords (a, b), optionally lifted along the normal. */
export function framePoint(f: Frame, a: number, b: number, lift = 0): Vec3 {
  return add(add(f.origin, add(mul(f.u, a), mul(f.v, b))), mul(f.n, lift));
}

// ---------------------------------------------------------------------------
// Stamps: a rectangular selection of tiles from the tileset, plus orientation.
// ---------------------------------------------------------------------------

export interface Stamp {
  tx: number; // tile column
  ty: number; // tile row, counted from the top of the image
  w: number;
  h: number;
}

export interface Orient {
  rot: 0 | 1 | 2 | 3; // quarter turns clockwise
  flipH: boolean;
  flipV: boolean;
}

export const identityOrient = (): Orient => ({ rot: 0, flipH: false, flipV: false });

export interface StampCell {
  cx: number; // cell offset within the laid-out stamp (y up)
  cy: number;
  uvs: [Vec2, Vec2, Vec2, Vec2]; // texture coords for corners [bl, br, tr, tl]
}

export interface StampLayout {
  w: number;
  h: number;
  cells: StampCell[];
}

/**
 * Lay out a stamp into cells with oriented UVs. Flips mirror the arrangement
 * and each tile's texture; rotations turn the whole block in quarter steps.
 */
export function layoutStamp(stamp: Stamp, o: Orient, ts: Tileset): StampLayout {
  const cells: StampCell[] = [];
  let W = stamp.w;
  let H = stamp.h;
  // role classification: corner order is [bl, br, tr, tl]
  const roleToIndex = [0, 1, 3, 2]; // (xHigh + 2*yHigh) -> corner slot

  for (let sy = 0; sy < stamp.h; sy++) {
    for (let sx = 0; sx < stamp.w; sx++) {
      const rect = ts.tileUV(stamp.tx + sx, stamp.ty + sy);
      const yUp = stamp.h - 1 - sy;
      let pts: Array<[number, number]> = [
        [sx, yUp],
        [sx + 1, yUp],
        [sx + 1, yUp + 1],
        [sx, yUp + 1],
      ];
      const uvs: Vec2[] = [
        v2(rect.u0, rect.v0),
        v2(rect.u1, rect.v0),
        v2(rect.u1, rect.v1),
        v2(rect.u0, rect.v1),
      ];
      let w = stamp.w;
      let h = stamp.h;
      if (o.flipH) pts = pts.map(([x, y]) => [w - x, y]);
      if (o.flipV) pts = pts.map(([x, y]) => [x, h - y]);
      for (let k = 0; k < o.rot; k++) {
        pts = pts.map(([x, y]) => [y, w - x]);
        const t = w;
        w = h;
        h = t;
      }
      W = w;
      H = h;
      const minX = Math.min(...pts.map((p) => p[0]));
      const minY = Math.min(...pts.map((p) => p[1]));
      const out: [Vec2, Vec2, Vec2, Vec2] = [v2(), v2(), v2(), v2()];
      for (let k = 0; k < 4; k++) {
        const [x, y] = pts[k];
        const role = (x > minX + 0.5 ? 1 : 0) + (y > minY + 0.5 ? 2 : 0);
        out[roleToIndex[role]] = uvs[k];
      }
      cells.push({ cx: minX, cy: minY, uvs: out });
    }
  }
  return { w: W, h: H, cells };
}

/** Face snapshots for a stamp placed with cell (0,0) of the layout at frame cell (a, b). */
export function stampFaces(
  frame: Frame,
  a: number,
  b: number,
  layout: StampLayout,
  makeId: () => number,
): Face[] {
  return layout.cells.map((cell) => {
    const x = a + cell.cx;
    const y = b + cell.cy;
    return {
      id: makeId(),
      verts: [
        framePoint(frame, x, y),
        framePoint(frame, x + 1, y),
        framePoint(frame, x + 1, y + 1),
        framePoint(frame, x, y + 1),
      ] as Face['verts'],
      uvs: [
        { ...cell.uvs[0] },
        { ...cell.uvs[1] },
        { ...cell.uvs[2] },
        { ...cell.uvs[3] },
      ] as Face['uvs'],
    };
  });
}

/**
 * Six outward-facing faces of a unit block sitting on frame cell (a, b),
 * extruded one cell along +n. All faces use the same tile UVs.
 */
export function blockFaces(
  frame: Frame,
  a: number,
  b: number,
  uvs: [Vec2, Vec2, Vec2, Vec2],
  makeId: () => number,
): Face[] {
  const height = Math.hypot(frame.u.x, frame.u.y, frame.u.z);
  const p = (x: number, y: number, k: number) => framePoint(frame, a + x, b + y, k * height);
  // corners: p(x, y, k) with x,y,k in {0,1}
  const quads: Array<[Vec3, Vec3, Vec3, Vec3]> = [
    [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)], // top (+n)
    [p(0, 1, 0), p(1, 1, 0), p(1, 0, 0), p(0, 0, 0)], // bottom (-n)
    [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)], // side v=0
    [p(1, 1, 0), p(0, 1, 0), p(0, 1, 1), p(1, 1, 1)], // side v=1
    [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)], // side u=1
    [p(0, 1, 0), p(0, 0, 0), p(0, 0, 1), p(0, 1, 1)], // side u=0
  ];
  return quads.map((verts) => ({
    id: makeId(),
    verts,
    uvs: [{ ...uvs[0] }, { ...uvs[1] }, { ...uvs[2] }, { ...uvs[3] }] as Face['uvs'],
  }));
}
