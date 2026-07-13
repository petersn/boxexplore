// Small geometry helpers for UI overlays — flat float arrays for the Rust
// renderer's overlay slots. The volume surface itself is meshed in gfx.rs.

import type { Vec3 } from './vec';

/** Anything with four corners, [bl, br, tr, tl]. */
export interface Quad {
  verts: readonly [Vec3, Vec3, Vec3, Vec3];
}

/** Quads → 12 floats each ([bl,br,tr,tl]·xyz), the gfx_overlay_quads format. */
export function quadsToArray(quads: readonly Quad[]): Float32Array {
  const out = new Float32Array(quads.length * 12);
  let i = 0;
  for (const q of quads) {
    for (const v of q.verts) {
      out[i++] = v.x;
      out[i++] = v.y;
      out[i++] = v.z;
    }
  }
  return out;
}

/** Quads → line-segment points outlining each border (8 points per quad). */
export function quadOutlinePoints(quads: ReadonlyArray<{ verts: readonly Vec3[] }>): Float32Array {
  const out = new Float32Array(quads.length * 8 * 3);
  let i = 0;
  for (const q of quads) {
    for (let k = 0; k < 4; k++) {
      for (const v of [q.verts[k], q.verts[(k + 1) % 4]]) {
        out[i++] = v.x;
        out[i++] = v.y;
        out[i++] = v.z;
      }
    }
  }
  return out;
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
