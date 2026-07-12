import { type Vec3, v3 } from './vec';

// The volume model: a sparse set of solid unit cells (keyed by integer min
// corner) plus per-lattice-vertex displacements. The visible surface is
// *derived* — a face wherever a solid cell meets an empty one — so the world
// stays watertight by construction no matter how you extrude or carve.
// Displacements deform the surface without changing its topology
// (Sauerbraten-style corner pushing), so slopes stay sealed too.

export type Cell = [number, number, number];

export const cellKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;
export const parseCell = (key: string): Cell => key.split(',').map(Number) as Cell;

/** Outward normals of a cell's 6 faces: +x, -x, +y, -y, +z, -z. */
export const DIRS: readonly Cell[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

// Corner offsets per direction, ordered [bl, br, tr, tl] so that
// cross(br-bl, tl-bl) points along the outward normal and the implied u/v
// axes match axisFrame's texture orientation.
const CORNERS: readonly (readonly Cell[])[] = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], // +x
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], // -x
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], // +y
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], // -y
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], // +z
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], // -z
];

/** One derived boundary face of the volume. */
export interface VolFace {
  key: string; // "x,y,z:dir"
  cell: Cell;
  dir: number;
  /** Displaced corner positions, [bl, br, tr, tl]. */
  verts: [Vec3, Vec3, Vec3, Vec3];
  /** Integer lattice keys of the corners (pre-displacement identity). */
  lattice: [string, string, string, string];
  /** Per-corner ambient occlusion level, 0 (fully occluded) … 3 (open). */
  ao: [number, number, number, number];
}

export const faceKey = (cell: Cell, dir: number): string =>
  `${cell[0]},${cell[1]},${cell[2]}:${dir}`;

/** Derive the boundary surface of a cell set, applying lattice displacements. */
export function buildSurface(
  cells: ReadonlySet<string>,
  shifts: ReadonlyMap<string, Vec3>,
): VolFace[] {
  const out: VolFace[] = [];
  for (const key of cells) {
    const [x, y, z] = parseCell(key);
    for (let d = 0; d < 6; d++) {
      const n = DIRS[d];
      if (cells.has(cellKey(x + n[0], y + n[1], z + n[2]))) continue;
      const axis = d >> 1;
      const a1 = axis === 0 ? 1 : 0;
      const a2 = axis === 2 ? 1 : 2;
      const e: Cell = [x + n[0], y + n[1], z + n[2]]; // the empty cell this face looks into
      const verts: Vec3[] = [];
      const lattice: string[] = [];
      const ao: number[] = [];
      for (let k = 0; k < 4; k++) {
        const c = CORNERS[d][k];
        const lx = x + c[0];
        const ly = y + c[1];
        const lz = z + c[2];
        const lk = cellKey(lx, ly, lz);
        const s = shifts.get(lk);
        lattice.push(lk);
        verts.push(s ? v3(lx + s.x, ly + s.y, lz + s.z) : v3(lx, ly, lz));
        // Minecraft-style corner AO: sample the two side cells and the diagonal
        // cell around this corner, in the empty layer the face looks into.
        const p1: Cell = [...e];
        p1[a1] += c[a1] === 1 ? 1 : -1;
        const p2: Cell = [...e];
        p2[a2] += c[a2] === 1 ? 1 : -1;
        const pc: Cell = [...p1];
        pc[a2] += c[a2] === 1 ? 1 : -1;
        const s1 = cells.has(cellKey(p1[0], p1[1], p1[2])) ? 1 : 0;
        const s2 = cells.has(cellKey(p2[0], p2[1], p2[2])) ? 1 : 0;
        const sc = cells.has(cellKey(pc[0], pc[1], pc[2])) ? 1 : 0;
        ao.push(s1 && s2 ? 0 : 3 - s1 - s2 - sc);
      }
      out.push({
        key: `${key}:${d}`,
        cell: [x, y, z],
        dir: d,
        verts: verts as VolFace['verts'],
        lattice: lattice as VolFace['lattice'],
        ao: ao as VolFace['ao'],
      });
    }
  }
  return out;
}

/**
 * Whether the straight segment from `from` to `to` passes through a solid cell.
 * The march stops just short of the endpoint (callers nudge `to` slightly off
 * the surface along the vertex normal), so a corner *on* the surface hull is
 * unobstructed while anything behind solid — even one cell thick — is blocked.
 * Voxel DDA; ignores displacements and free faces, fine for visibility UX.
 */
export function segmentBlocked(cells: ReadonlySet<string>, from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const segLen = Math.hypot(dx, dy, dz);
  if (segLen < 1e-6) return false;
  const tStop = 1 - Math.min(0.5, 0.06 / segLen); // stop ~0.06 units before the end

  let x = Math.floor(from.x);
  let y = Math.floor(from.y);
  let z = Math.floor(from.z);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
  const tDeltaY = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
  const tDeltaZ = dz !== 0 ? 1 / Math.abs(dz) : Infinity;
  let tMaxX = dx !== 0 ? (stepX > 0 ? x + 1 - from.x : from.x - x) / Math.abs(dx) : Infinity;
  let tMaxY = dy !== 0 ? (stepY > 0 ? y + 1 - from.y : from.y - y) / Math.abs(dy) : Infinity;
  let tMaxZ = dz !== 0 ? (stepZ > 0 ? z + 1 - from.z : from.z - z) / Math.abs(dz) : Infinity;

  for (let i = 0; i < 1024; i++) {
    const tEnter = Math.min(tMaxX, tMaxY, tMaxZ);
    if (tEnter >= tStop) return false; // reached the endpoint without a hit
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxZ) {
      y += stepY;
      tMaxY += tDeltaY;
    } else {
      z += stepZ;
      tMaxZ += tDeltaZ;
    }
    if (cells.has(cellKey(x, y, z))) return true;
  }
  return false;
}

/** The two in-plane axes for a face axis (matches the AO/corner convention). */
export function planeAxes(axis: number): [number, number] {
  return [axis === 0 ? 1 : 0, axis === 2 ? 1 : 2];
}

/** Lattice keys of a cell set's boundary surface. */
export function surfaceLatticeOf(cells: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const key of cells) {
    const [x, y, z] = parseCell(key);
    for (let d = 0; d < 6; d++) {
      const n = DIRS[d];
      if (cells.has(cellKey(x + n[0], y + n[1], z + n[2]))) continue;
      for (let k = 0; k < 4; k++) {
        const c = CORNERS[d][k];
        out.add(cellKey(x + c[0], y + c[1], z + c[2]));
      }
    }
  }
  return out;
}

/**
 * Offset hygiene + extrapolation for a cell edit. Ensures displacements only
 * ever live on visible surface corners:
 *  - corners leaving the surface (buried or orphaned) have their offsets cleared;
 *  - corners *joining* the surface get their offset copied from the corner at
 *    `sourceDelta` away (the ring they were extruded/carved from) when that
 *    corner was on the old surface — so extruding a ramp yields more ramp —
 *    and cleared otherwise, so stale invisible offsets never wiggle new geometry.
 */
export function planShiftChanges(
  cells: ReadonlySet<string>,
  shifts: ReadonlyMap<string, Vec3>,
  oldLattice: ReadonlySet<string>,
  cellsAdded: readonly string[],
  cellsRemoved: readonly string[],
  sourceDelta?: Cell,
): Array<{ key: string; before: Vec3 | null; after: Vec3 | null }> {
  const next = new Set(cells);
  for (const k of cellsRemoved) next.delete(k);
  for (const k of cellsAdded) next.add(k);
  const newLattice = surfaceLatticeOf(next);

  const changes: Array<{ key: string; before: Vec3 | null; after: Vec3 | null }> = [];
  for (const [k, v] of shifts) {
    if (!newLattice.has(k)) changes.push({ key: k, before: { ...v }, after: null });
  }
  for (const k of newLattice) {
    if (oldLattice.has(k)) continue; // already-visible corners keep their offsets
    const before = shifts.get(k) ?? null;
    let after: Vec3 | null = null;
    if (sourceDelta) {
      const [x, y, z] = parseCell(k);
      const src = cellKey(x + sourceDelta[0], y + sourceDelta[1], z + sourceDelta[2]);
      if (oldLattice.has(src)) {
        const sv = shifts.get(src);
        if (sv) after = { ...sv };
      }
    }
    const same =
      (!before && !after) ||
      (before &&
        after &&
        Math.abs(before.x - after.x) < 1e-9 &&
        Math.abs(before.y - after.y) < 1e-9 &&
        Math.abs(before.z - after.z) < 1e-9);
    if (!same) changes.push({ key: k, before: before ? { ...before } : null, after });
  }
  return changes;
}

/**
 * Watertightness check: every lattice edge of a sealed surface is shared by
 * an even number of faces (2 normally, 4 at non-manifold diagonal contacts).
 * Odd edges are holes. Used by the verification scripts.
 */
export function boundaryStats(faces: readonly VolFace[]): { faces: number; oddEdges: number } {
  const counts = new Map<string, number>();
  for (const f of faces) {
    for (let k = 0; k < 4; k++) {
      const a = f.lattice[k];
      const b = f.lattice[(k + 1) % 4];
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      counts.set(e, (counts.get(e) ?? 0) + 1);
    }
  }
  let odd = 0;
  for (const c of counts.values()) if (c % 2) odd++;
  return { faces: faces.length, oddEdges: odd };
}
