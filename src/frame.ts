import { type Vec2, type Vec3, add, dot, mul, sub, v2, v3 } from './vec';

export type PlaneAxis = 'x' | 'y' | 'z';

/**
 * A plane frame: `origin` is the corner of cell (0,0); `u` and `v` are the
 * cell step vectors; `n` is the unit normal. cross(u, v) points along +n.
 * Used for the reference grid and ray/plane picking.
 */
export interface Frame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
}

/** Axis-aligned frame. */
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
