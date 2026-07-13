// Small geometry helpers for UI overlays (ghosts, selection highlights).
// The volume surface itself is meshed in Rust — see render.ts / world.ts.

import * as THREE from 'three';
import type { Vec3 } from './vec';

/** Anything with four corners, [bl, br, tr, tl]. */
export interface Quad {
  verts: readonly [Vec3, Vec3, Vec3, Vec3];
}

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

/** Line-segment geometry outlining each quad's border. */
export function buildOutlineGeometry(
  quads: ReadonlyArray<{ verts: readonly Vec3[] }>,
  geometry: THREE.BufferGeometry,
): void {
  const positions = new Float32Array(quads.length * 8 * 3);
  let pi = 0;
  for (const f of quads) {
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

/** Quad from a wasm face-quad buffer (12 floats, [bl,br,tr,tl]·xyz). */
export function quadFromBuffer(q: Float32Array): Quad {
  return {
    verts: [
      { x: q[0], y: q[1], z: q[2] },
      { x: q[3], y: q[4], z: q[5] },
      { x: q[6], y: q[7], z: q[8] },
      { x: q[9], y: q[10], z: q[11] },
    ],
  };
}
