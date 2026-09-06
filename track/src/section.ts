/**
 * The track cross-section: the single source of truth for what exists at a
 * given lateral offset from the centreline.
 *
 * Three consumers depend on this agreeing with itself:
 *   - mesh.ts       builds the collision and visual geometry from it
 *   - sampler.ts    answers "what surface is this car on" from it
 *   - the server    applies friction from that answer
 *
 * If the geometry and the surface query disagree, a car visibly on asphalt gets
 * grass friction and it looks exactly like a netcode bug (HANDOFF.md §10). So
 * both are derived here rather than written twice.
 *
 * Lateral offset `d` is signed metres from the centreline, positive to the
 * right of the direction of travel.
 *
 *      barrier                                              barrier
 *         |  <-- runoff -->  |kerb|   asphalt   |kerb|  <-- runoff -->  |
 *      -R2                 -R1  -hw     0     +hw   +R1                +R2
 *
 * Run-off width is per-side and per-waypoint, not a constant: see
 * `safeInnerRunoff` for why a fixed width cannot work.
 */

import type { SurfaceKind } from '../../shared/protocol';
import type { TrackData } from '../../shared/track-schema';
import { curvature, smoothClosed, type P2 } from './spline';

/** Width of the kerb strip on each side of the asphalt, metres. */
export const KERB_WIDTH = 1.1;

/** How far the kerb's outer edge sits above the road plane, metres. */
export const KERB_RISE = 0.06;

/** Run-off width where the geometry allows it, metres. */
export const RUNOFF_WIDTH = 14;

/** Run-off never narrows below this, or the barrier ends up on the kerb. */
export const MIN_RUNOFF = 3;

/** How far the run-off falls away from track level at the barrier, metres. */
export const RUNOFF_DROP = 0.35;

/** Barrier wall height above local ground, metres. */
export const BARRIER_HEIGHT = 1.2;

/**
 * Fraction of the corner radius the inside edge of the run-off may reach.
 *
 * An offset curve taken a distance `o` inside a corner of radius `R` collapses
 * to a point at o = R and turns inside out beyond it. Interlagos has a 20.7 m
 * radius hairpin at Pinheirinho, so a flat 14 m run-off plus half the track
 * width reaches past the centre of the turn: the ribbon folds over itself and
 * the barrier crosses to the far side of the corner.
 *
 * 0.65 keeps the offset curve comfortably short of degenerate rather than
 * merely non-inverted — at 0.95 the inner geometry is technically valid but
 * bunches into near-degenerate slivers that make poor collision triangles.
 */
const INNER_RUNOFF_FRACTION = 0.65;

/**
 * Curvature above which the outside of the corner is gravel rather than grass,
 * in 1/m. 1/110 — anything tighter than a ~110 m radius is a corner a car can
 * actually run wide out of, and a gravel trap there is the difference between a
 * mistake costing time and costing nothing.
 */
const GRAVEL_CURVATURE = 1 / 110;

/**
 * Gravel is extended this many metres past the corner exit. A car that loses it
 * at turn-in arrives at the run-off some way further round, so a trap that stops
 * exactly where the curvature does would be in the wrong place.
 */
const GRAVEL_RUNON_METRES = 45;

/**
 * The finished cross-section for a whole circuit: what surface lies off each
 * edge, and how far it extends before the barrier.
 *
 * Derived from the track JSON alone, so server and client reach an identical
 * plan without either shipping an extra file.
 */
export interface SectionPlan {
  /** Run-off surface off the left edge, per waypoint. */
  leftKind: SurfaceKind[];
  /** Run-off surface off the right edge, per waypoint. */
  rightKind: SurfaceKind[];
  /** Run-off width off the left edge, metres, per waypoint. */
  leftWidth: number[];
  /** Run-off width off the right edge, metres, per waypoint. */
  rightWidth: number[];
}

export function planSection(track: TrackData): SectionPlan {
  const n = track.waypoints.length;
  const pts: P2[] = track.waypoints.map((w) => [w.p[0], w.p[2]]);

  // Smooth before use: raw per-waypoint curvature at 3 m spacing is noisy
  // enough to produce single-waypoint gravel islands and a ragged barrier line.
  const k = smoothClosed(curvature(pts), 6);

  const leftKind = new Array<SurfaceKind>(n).fill('grass');
  const rightKind = new Array<SurfaceKind>(n).fill('grass');
  const leftWidth = new Array<number>(n).fill(RUNOFF_WIDTH);
  const rightWidth = new Array<number>(n).fill(RUNOFF_WIDTH);

  for (let i = 0; i < n; i++) {
    const hw = track.waypoints[i]!.width / 2;
    const curv = k[i]!;

    // Sign convention, established by measurement rather than derivation (the
    // 2D cross product in spline.ts is taken over (x, z), which flips relative
    // to the usual reading when embedded in a Y-up frame):
    //
    //   curvature > 0  ->  the inside of the corner is the RIGHT-hand side
    //   curvature < 0  ->  the inside of the corner is the LEFT-hand side
    //
    // Gravel belongs on the outside, where a car that runs wide ends up.
    // The run-off that has to be narrowed is the one on the inside, where the
    // offset curve shortens.
    if (curv > GRAVEL_CURVATURE) leftKind[i] = 'gravel';
    else if (curv < -GRAVEL_CURVATURE) rightKind[i] = 'gravel';

    const limit = safeInnerRunoff(curv, hw);
    if (curv > 0) rightWidth[i] = Math.min(RUNOFF_WIDTH, limit);
    else if (curv < 0) leftWidth[i] = Math.min(RUNOFF_WIDTH, limit);
  }

  dilateForward(leftKind, track, GRAVEL_RUNON_METRES);
  dilateForward(rightKind, track, GRAVEL_RUNON_METRES);

  // Smooth the barrier line: one that steps in and out waypoint by waypoint
  // reads as broken and makes poor collision triangles.
  const smoothL = smoothClosed(leftWidth, 8);
  const smoothR = smoothClosed(rightWidth, 8);
  for (let i = 0; i < n; i++) {
    leftWidth[i] = Math.min(smoothL[i]!, leftWidth[i]!);
    rightWidth[i] = Math.min(smoothR[i]!, rightWidth[i]!);
  }

  // The curvature limit above is an estimate — it reads a smoothed curvature,
  // which under-reports the tightest radius in a corner and so lets the inside
  // edge reach slightly too far. Rather than tuning that model, enforce the
  // property we actually need directly on the resulting barrier line, the same
  // way generate.ts clamps gradient rather than hand-tuning elevation keys.
  enforceNoFold(track, leftWidth, -1);
  enforceNoFold(track, rightWidth, 1);

  return { leftKind, rightKind, leftWidth, rightWidth };
}

/** Minimum fraction of the centreline step that the barrier line must advance. */
const MIN_EDGE_ADVANCE = 0.15;

/**
 * Shrink run-off until the barrier line advances along the lap everywhere.
 *
 * Where the offset curve on the inside of a corner doubles back, the ribbon
 * folds over itself: the visual surface inverts and the collision mesh gains
 * triangles facing into the track. Pulling the two ends of any reversed step
 * inward removes it. MIN_RUNOFF is reachable at every corner on both circuits,
 * so this always terminates with the property satisfied.
 */
function enforceNoFold(track: TrackData, widths: number[], side: -1 | 1): void {
  const n = widths.length;

  for (let iter = 0; iter < 400; iter++) {
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = barrierXZ(track, widths, side, i);
      const b = barrierXZ(track, widths, side, j);
      const fx = track.waypoints[j]!.p[0] - track.waypoints[i]!.p[0];
      const fz = track.waypoints[j]!.p[2] - track.waypoints[i]!.p[2];
      const len2 = fx * fx + fz * fz;
      if (len2 < 1e-12) continue;

      const advance = ((b[0] - a[0]) * fx + (b[1] - a[1]) * fz) / len2;
      if (advance >= MIN_EDGE_ADVANCE) continue;

      worst = Math.max(worst, MIN_EDGE_ADVANCE - advance);
      widths[i] = Math.max(MIN_RUNOFF, widths[i]! - 0.05);
      widths[j] = Math.max(MIN_RUNOFF, widths[j]! - 0.05);
    }
    if (worst < 1e-6) break;
  }
}

/** Barrier line position in plan view. Banking cannot affect whether it folds. */
function barrierXZ(track: TrackData, widths: number[], side: -1 | 1, i: number): [number, number] {
  const n = widths.length;
  const w = track.waypoints[i]!;
  const prev = track.waypoints[(i - 1 + n) % n]!.p;
  const next = track.waypoints[(i + 1) % n]!.p;
  const fx = next[0] - prev[0];
  const fz = next[2] - prev[2];
  const fl = Math.hypot(fx, fz) || 1;
  const d = side * outerHalfWidth(w.width, widths[i]!);
  return [w.p[0] + (-fz / fl) * d, w.p[2] + (fx / fl) * d];
}

/**
 * Widest run-off the inside of a corner can carry without the offset curve
 * folding over itself. `curv` is signed curvature in 1/m, `hw` half the track
 * width. Returns RUNOFF_WIDTH on anything straight enough not to matter.
 */
export function safeInnerRunoff(curv: number, hw: number): number {
  const a = Math.abs(curv);
  if (a < 1e-6) return RUNOFF_WIDTH;
  const radius = 1 / a;
  return Math.max(MIN_RUNOFF, INNER_RUNOFF_FRACTION * radius - hw - KERB_WIDTH);
}

/** Extend every gravel run forward along the lap by `metres`. */
function dilateForward(side: SurfaceKind[], track: TrackData, metres: number): void {
  const n = side.length;
  const src = side.slice();
  for (let i = 0; i < n; i++) {
    if (src[i] !== 'gravel') continue;
    let run = 0;
    let j = i;
    while (run < metres) {
      const a = track.waypoints[j % n]!.p;
      const b = track.waypoints[(j + 1) % n]!.p;
      run += Math.hypot(b[0] - a[0], b[2] - a[2]);
      j++;
      side[j % n] = 'gravel';
    }
  }
}

// ---------------------------------------------------------------------------
// Lateral stations
// ---------------------------------------------------------------------------

/** The four run-off/kerb offsets for one waypoint, as absolute lateral offsets. */
export interface Edges {
  hw: number;
  /** Outer edge of the kerb, both sides. */
  kerbL: number;
  kerbR: number;
  /** Barrier line, both sides. */
  outerL: number;
  outerR: number;
}

export function edgesAt(width: number, runoffL: number, runoffR: number): Edges {
  const hw = width / 2;
  return {
    hw,
    kerbL: hw + KERB_WIDTH,
    kerbR: hw + KERB_WIDTH,
    outerL: hw + KERB_WIDTH + runoffL,
    outerR: hw + KERB_WIDTH + runoffR,
  };
}

/** Signed lateral offsets of the section's vertex columns, left to right. */
export function stations(width: number, runoffL: number, runoffR: number): number[] {
  const e = edgesAt(width, runoffL, runoffR);
  return [-e.outerL, -e.kerbL, -e.hw, 0, e.hw, e.kerbR, e.outerR];
}

/** Distance from the centreline to the barrier on the given side. */
export function outerHalfWidth(width: number, runoff: number): number {
  return width / 2 + KERB_WIDTH + runoff;
}

/**
 * Height of the section above the road plane at lateral offset `d`.
 *
 * The road itself is flat across its width — banking is applied by rotating the
 * whole section, not by shaping it. This is only the kerb rise and the run-off
 * fall, both measured perpendicular to the banked plane.
 */
export function sectionRise(d: number, width: number, runoff: number): number {
  const a = Math.abs(d);
  const hw = width / 2;
  const r1 = hw + KERB_WIDTH;
  const r2 = r1 + runoff;

  if (a <= hw) return 0;
  if (a <= r1) return ((a - hw) / KERB_WIDTH) * KERB_RISE;
  if (a >= r2) return KERB_RISE - RUNOFF_DROP;
  return KERB_RISE - ((a - r1) / Math.max(1e-6, runoff)) * RUNOFF_DROP;
}

/**
 * Surface at lateral offset `d`.
 *
 * `runoffKind` is the run-off surface for the side `d` falls on. Beyond the
 * barrier the answer is still that kind: a car that has left the circuit
 * entirely should not suddenly regain asphalt grip.
 */
export function surfaceAt(d: number, width: number, runoffKind: SurfaceKind): SurfaceKind {
  const a = Math.abs(d);
  const hw = width / 2;
  if (a <= hw) return 'asphalt';
  if (a <= hw + KERB_WIDTH) return 'kerb';
  return runoffKind;
}
