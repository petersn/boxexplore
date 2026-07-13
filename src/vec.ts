// Plain-object vectors used by the document model (kept separate from THREE for
// clean serialization and cheap deep copies).

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const c2 = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });
export const c3 = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const mul = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : v3();
};

/** Rotate point `p` around the line through `pivot` with unit direction `axis` (Rodrigues). */
export function rotateAround(p: Vec3, pivot: Vec3, axis: Vec3, angle: number): Vec3 {
  const d = sub(p, pivot);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const term1 = mul(d, cosA);
  const term2 = mul(cross(axis, d), sinA);
  const term3 = mul(axis, dot(axis, d) * (1 - cosA));
  return add(pivot, add(add(term1, term2), term3));
}

/** Quantized key for welding / dedupe (≈1/1024 unit resolution). */
export const vkey = (a: Vec3): string =>
  `${Math.round(a.x * 1024)},${Math.round(a.y * 1024)},${Math.round(a.z * 1024)}`;

export const snap = (value: number, step: number): number => Math.round(value / step) * step;

/** Mutable vector with the small three.js-style API the camera rig uses. */
export class MVec {
  x = 0;
  y = 0;
  z = 0;

  constructor(x = 0, y = 0, z = 0) {
    this.set(x, y, z);
  }

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(o: Vec3): this {
    return this.set(o.x, o.y, o.z);
  }

  clone(): MVec {
    return new MVec(this.x, this.y, this.z);
  }

  add(o: Vec3): this {
    return this.set(this.x + o.x, this.y + o.y, this.z + o.z);
  }

  addScaled(o: Vec3, s: number): this {
    return this.set(this.x + o.x * s, this.y + o.y * s, this.z + o.z * s);
  }

  lerp(o: Vec3, t: number): this {
    return this.set(
      this.x + (o.x - this.x) * t,
      this.y + (o.y - this.y) * t,
      this.z + (o.z - this.z) * t,
    );
  }
}

/** sRGB display color (0xRRGGBB) → linear RGB triple for the renderer. */
export function srgbHex(hex: number): [number, number, number] {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)];
}
