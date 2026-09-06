/**
 * Closed centripetal Catmull-Rom spline with arc-length resampling.
 *
 * The circuit is authored as a handful of 2D control points (track/src/circuits.ts).
 * Splining them gives tangent continuity for free and, because the loop is closed
 * by construction, we never have to solve a closure problem.
 */

export type P2 = readonly [number, number];

/** Centripetal Catmull-Rom: alpha = 0.5. Avoids the cusps uniform CR produces. */
const ALPHA = 0.5;

function dist(a: P2, b: P2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/**
 * Evaluate one Catmull-Rom segment p1 -> p2 at parameter u in [0, 1].
 * Barry-Goldman formulation so non-uniform knots work.
 */
function segment(p0: P2, p1: P2, p2: P2, p3: P2, u: number): P2 {
  const t0 = 0;
  const t1 = t0 + Math.pow(Math.max(dist(p0, p1), 1e-6), ALPHA);
  const t2 = t1 + Math.pow(Math.max(dist(p1, p2), 1e-6), ALPHA);
  const t3 = t2 + Math.pow(Math.max(dist(p2, p3), 1e-6), ALPHA);

  const t = t1 + u * (t2 - t1);

  const lerp = (a: P2, b: P2, ta: number, tb: number, tt: number): P2 => {
    const w = (tt - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };

  const a1 = lerp(p0, p1, t0, t1, t);
  const a2 = lerp(p1, p2, t1, t2, t);
  const a3 = lerp(p2, p3, t2, t3, t);
  const b1 = lerp(a1, a2, t0, t2, t);
  const b2 = lerp(a2, a3, t1, t3, t);
  return lerp(b1, b2, t1, t2, t);
}

/**
 * Densely sample a closed control polygon. `subdiv` samples per segment.
 * Returns points with no duplicate at the seam.
 */
export function sampleClosed(control: readonly P2[], subdiv = 64): P2[] {
  const n = control.length;
  if (n < 4) throw new Error(`sampleClosed: need >= 4 control points, got ${n}`);
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = control[(i - 1 + n) % n]!;
    const p1 = control[i]!;
    const p2 = control[(i + 1) % n]!;
    const p3 = control[(i + 2) % n]!;
    for (let s = 0; s < subdiv; s++) {
      out.push(segment(p0, p1, p2, p3, s / subdiv));
    }
  }
  return out;
}

/** Cumulative arc length along a closed polyline, plus the total. */
export function arcLengths(pts: readonly P2[]): { cum: number[]; total: number } {
  const cum = new Array<number>(pts.length);
  let d = 0;
  for (let i = 0; i < pts.length; i++) {
    cum[i] = d;
    d += dist(pts[i]!, pts[(i + 1) % pts.length]!);
  }
  return { cum, total: d };
}

/**
 * Resample a closed polyline to points spaced `spacing` metres apart.
 * The final spacing is adjusted so the loop divides evenly — no short seam segment.
 */
export function resampleByArcLength(pts: readonly P2[], spacing: number): P2[] {
  const { cum, total } = arcLengths(pts);
  const count = Math.max(16, Math.round(total / spacing));
  const step = total / count;

  const out: P2[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (j < pts.length - 1 && cum[j + 1]! <= target) j++;
    const a = pts[j]!;
    const b = pts[(j + 1) % pts.length]!;
    const segLen = (j + 1 < pts.length ? cum[j + 1]! : total) - cum[j]!;
    const u = segLen > 1e-9 ? (target - cum[j]!) / segLen : 0;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

/**
 * Signed curvature at each point of a closed polyline, in 1/m.
 * Positive = turning left (counter-clockwise in the XZ plane as we use it).
 * Used to derive banking and to size AI corner speeds.
 */
export function curvature(pts: readonly P2[]): number[] {
  const n = pts.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n]!;
    const b = pts[i]!;
    const c = pts[(i + 1) % n]!;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const cross = ux * vy - uy * vx;
    const la = Math.hypot(ux, uy);
    const lb = Math.hypot(vx, vy);
    const lc = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const denom = la * lb * lc;
    out[i] = denom > 1e-9 ? (2 * cross) / denom : 0;
  }
  return out;
}

/** Box blur over a closed array. Smooths curvature-derived quantities. */
export function smoothClosed(vals: readonly number[], radius: number): number[] {
  const n = vals.length;
  if (radius <= 0) return vals.slice();
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) s += vals[(i + k + n * 4) % n]!;
    out[i] = s / (radius * 2 + 1);
  }
  return out;
}

/** Piecewise-smooth interpolation of keyframes given as [fraction 0..1, value]. */
export function evalKeyframes(keys: readonly (readonly [number, number])[], u: number): number {
  const n = keys.length;
  const x = ((u % 1) + 1) % 1;
  let i = 0;
  while (i < n - 1 && keys[i + 1]![0] <= x) i++;
  const a = keys[i]!;
  const b = keys[(i + 1) % n]!;
  const span = (b[0] - a[0] + 1) % 1 || 1;
  const w = span > 1e-9 ? Math.min(1, Math.max(0, (x - a[0]) / span)) : 0;
  const s = w * w * (3 - 2 * w); // smoothstep
  return a[1] + (b[1] - a[1]) * s;
}
