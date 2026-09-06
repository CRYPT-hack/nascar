/**
 * Minimal vector and quaternion helpers.
 *
 * Deliberately not three.js: this module runs on the server, and the server has
 * no business importing a renderer. Plain objects rather than classes so the
 * shapes match Rapier's `Vector` and `Rotation` directly and no conversion is
 * needed at the call site.
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Q4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const length = (a: V3): number => Math.hypot(a.x, a.y, a.z);

export function normalize(a: V3): V3 {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}

/** Rotate a vector by a unit quaternion. */
export function rotate(q: Q4, v: V3): V3 {
  // t = 2 * (q.xyz x v); result = v + q.w * t + q.xyz x t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Rotate a vector by the inverse of a unit quaternion. */
export function rotateInv(q: Q4, v: V3): V3 {
  return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
}

/** Quaternion for a rotation of `angle` radians about the Y axis. */
export function quatFromY(angle: number): Q4 {
  const h = angle / 2;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

/** Quaternion for a rotation of `angle` radians about an arbitrary unit axis. */
export function quatFromAxis(axis: V3, angle: number): Q4 {
  const h = angle / 2;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}

export function quatMul(a: Q4, b: Q4): Q4 {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatNormalize(q: Q4): Q4 {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

/**
 * Shortest-arc spherical interpolation. Used by remote interpolation, where the
 * two samples can be on opposite sides of the hypersphere.
 */
export function slerp(a: Q4, b: Q4, t: number): Q4 {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let d = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (d < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    d = -d;
  }
  if (d > 0.9995) {
    return quatNormalize({
      x: a.x + (bx - a.x) * t,
      y: a.y + (by - a.y) * t,
      z: a.z + (bz - a.z) * t,
      w: a.w + (bw - a.w) * t,
    });
  }
  const theta = Math.acos(d);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const lerpV3 = (a: V3, b: V3, t: number): V3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Yaw angle measured from -Z toward +X, which is the convention in HANDOFF §5.1. */
export function yawOf(q: Q4): number {
  const f = rotate(q, { x: 0, y: 0, z: -1 });
  return Math.atan2(f.x, -f.z);
}

/** Smallest signed difference between two angles, in (-pi, pi]. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
