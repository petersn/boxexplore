// Minimal camera math for projection and picking rays. The renderer builds
// its own matrices in Rust (gfx.rs) from the same inputs — keep conventions
// in sync: column-major, right-handed, WebGPU 0..1 clip z.

import { type Vec3, cross, dot, norm, v3 } from './vec';

export type Mat4 = Float32Array; // 16, column-major

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const r = far / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = r;
  m[11] = -1;
  m[14] = r * near;
  return m;
}

export function lookTo(eye: Vec3, dir: Vec3): Mat4 {
  const f = norm(dir);
  const s = norm(cross(f, v3(0, 1, 0)));
  const u = cross(s, f);
  const m = new Float32Array(16);
  m[0] = s.x;
  m[1] = u.x;
  m[2] = -f.x;
  m[4] = s.y;
  m[5] = u.y;
  m[6] = -f.y;
  m[8] = s.z;
  m[9] = u.z;
  m[10] = -f.z;
  m[12] = -dot(s, eye);
  m[13] = -dot(u, eye);
  m[14] = dot(f, eye);
  m[15] = 1;
  return m;
}

export function matMul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** World point → clip space [x, y, z, w]. */
export function transform(m: Mat4, p: Vec3): [number, number, number, number] {
  return [
    m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
    m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15],
  ];
}

/** Unit ray direction through a canvas pixel (CSS px, top-left origin). */
export function rayDir(
  forward: Vec3,
  fovY: number,
  aspect: number,
  width: number,
  height: number,
  px: number,
  py: number,
): Vec3 {
  const f = norm(forward);
  const s = norm(cross(f, v3(0, 1, 0)));
  const u = cross(s, f);
  const t = Math.tan(fovY / 2);
  const nx = (2 * px) / width - 1;
  const ny = 1 - (2 * py) / height;
  return norm(
    v3(
      f.x + s.x * nx * t * aspect + u.x * ny * t,
      f.y + s.y * nx * t * aspect + u.y * ny * t,
      f.z + s.z * nx * t * aspect + u.z * ny * t,
    ),
  );
}
