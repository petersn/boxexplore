import * as THREE from 'three';
import type { Vec3 } from './vec';
import type { VolFace } from './volume';

/** Anything with four corners, [bl, br, tr, tl]. */
export interface Quad {
  verts: readonly [Vec3, Vec3, Vec3, Vec3];
}

// Fixed light for the untextured volume surface: mostly overhead with a slight
// x/z lean so every axis direction gets a distinct brightness.
const LIGHT: Vec3 = { x: 0.372, y: 0.904, z: 0.213 };
const VOL_BASE: Vec3 = { x: 0.78, y: 0.8, z: 0.85 };
const AO_CURVE = [0.55, 0.72, 0.86, 1];
// Highlight color for displaced lattice corners in the voxel debug view.
const SHIFT_TINT: Vec3 = { x: 1.0, y: 0.5, z: 0.12 };

/** Build (or refill) untextured quad geometry (ghosts, selection overlays). */
export function buildQuadGeometry(quads: readonly Quad[], geometry: THREE.BufferGeometry): void {
  const count = quads.length;
  const positions = new Float32Array(count * 4 * 3);
  const indices = count * 4 > 65535 ? new Uint32Array(count * 6) : new Uint16Array(count * 6);
  let pi = 0;
  let ii = 0;
  for (let i = 0; i < count; i++) {
    const q = quads[i];
    for (let k = 0; k < 4; k++) {
      positions[pi++] = q.verts[k].x;
      positions[pi++] = q.verts[k].y;
      positions[pi++] = q.verts[k].z;
    }
    const base = i * 4;
    indices[ii++] = base + 0;
    indices[ii++] = base + 1;
    indices[ii++] = base + 2;
    indices[ii++] = base + 0;
    indices[ii++] = base + 2;
    indices[ii++] = base + 3;
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
}

/**
 * Build (or refill) a BufferGeometry from derived volume faces, shaded per
 * face by its (possibly displaced) normal with per-corner ambient occlusion.
 * When `tintShifts` is given (voxel debug view), corners whose lattice point
 * carries a displacement blend toward orange. Returns the triangle-index →
 * face-key map used to resolve raycasts.
 */
export function buildVolGeometry(
  faces: readonly VolFace[],
  geometry: THREE.BufferGeometry,
  tintShifts?: ReadonlyMap<string, Vec3>,
): string[] {
  const count = faces.length;
  const positions = new Float32Array(count * 4 * 3);
  const colors = new Float32Array(count * 4 * 3);
  const indices = count * 4 > 65535 ? new Uint32Array(count * 6) : new Uint16Array(count * 6);
  const triKey: string[] = new Array(count * 2);

  let pi = 0;
  let ci = 0;
  let ii = 0;
  for (let i = 0; i < count; i++) {
    const f = faces[i];
    const [a, b, c, d] = f.verts;
    // diagonal cross product: robust normal for planar and warped quads alike
    const e1 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const e2 = { x: d.x - b.x, y: d.y - b.y, z: d.z - b.z };
    let nx = e1.y * e2.z - e1.z * e2.y;
    let ny = e1.z * e2.x - e1.x * e2.z;
    let nz = e1.x * e2.y - e1.y * e2.x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const lambert = Math.max(0, nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z);
    const bright = 0.58 + 0.42 * lambert + 0.1 * Math.min(0, ny);
    for (let k = 0; k < 4; k++) {
      positions[pi++] = f.verts[k].x;
      positions[pi++] = f.verts[k].y;
      positions[pi++] = f.verts[k].z;
      const bk = bright * AO_CURVE[f.ao[k]];
      let r = VOL_BASE.x * bk;
      let g = VOL_BASE.y * bk;
      let bl = VOL_BASE.z * bk;
      if (tintShifts) {
        const s = tintShifts.get(f.lattice[k]);
        if (s) {
          const t = 0.85 * Math.min(1, Math.hypot(s.x, s.y, s.z) / 0.5);
          r += (SHIFT_TINT.x - r) * t;
          g += (SHIFT_TINT.y - g) * t;
          bl += (SHIFT_TINT.z - bl) * t;
        }
      }
      colors[ci++] = r;
      colors[ci++] = g;
      colors[ci++] = bl;
    }
    const base = i * 4;
    // pick the diagonal that interpolates AO smoothly (the classic fix for
    // anisotropic corner darkening)
    if (f.ao[0] + f.ao[2] >= f.ao[1] + f.ao[3]) {
      indices[ii++] = base + 0;
      indices[ii++] = base + 1;
      indices[ii++] = base + 2;
      indices[ii++] = base + 0;
      indices[ii++] = base + 2;
      indices[ii++] = base + 3;
    } else {
      indices[ii++] = base + 0;
      indices[ii++] = base + 1;
      indices[ii++] = base + 3;
      indices[ii++] = base + 1;
      indices[ii++] = base + 2;
      indices[ii++] = base + 3;
    }
    triKey[i * 2] = f.key;
    triKey[i * 2 + 1] = f.key;
  }

  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return triKey;
}

/** Line-segment geometry outlining each quad's border. */
export function buildOutlineGeometry(
  faces: ReadonlyArray<{ verts: readonly Vec3[] }>,
  geometry: THREE.BufferGeometry,
): void {
  const positions = new Float32Array(faces.length * 8 * 3);
  let pi = 0;
  for (const f of faces) {
    for (let k = 0; k < 4; k++) {
      const a = f.verts[k];
      const b = f.verts[(k + 1) % 4];
      positions[pi++] = a.x;
      positions[pi++] = a.y;
      positions[pi++] = a.z;
      positions[pi++] = b.x;
      positions[pi++] = b.y;
      positions[pi++] = b.z;
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
}

/** The derived volume-boundary mesh plus picking support (tri → face key). */
export class VolMesh {
  readonly geometry = new THREE.BufferGeometry();
  readonly mesh: THREE.Mesh;
  private triKey: string[] = [];

  constructor(material: THREE.Material) {
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  rebuild(faces: readonly VolFace[], tintShifts?: ReadonlyMap<string, Vec3>): void {
    this.triKey = buildVolGeometry(faces, this.geometry, tintShifts);
  }

  keyAt(intersection: THREE.Intersection): string | null {
    const idx = intersection.faceIndex;
    if (idx == null) return null;
    return this.triKey[idx] ?? null;
  }
}
