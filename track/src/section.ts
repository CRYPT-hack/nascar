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
 * The constants below mirror vehicle/track-collision.ts, which builds the
 * surface the car drives on. That file owns them; this one follows.
 */

import type { SurfaceKind } from '../../shared/protocol';
import type { TrackData } from '../../shared/track-schema';
import { curvature, smoothClosed, type P2 } from './spline';

/**
 * Cross-section constants.
 *
 * These MIRROR `vehicle/track-collision.ts`, which builds the surface the car
 * actually drives on. The physics builder owns these numbers; this file follows
 * them. They were independently chosen once and drifted — kerb 1.1 vs 1.2 m,
 * barrier at hw+15.1 vs hw+9 — which put the visible barrier five metres beyond
 * the one the car hits. If you change one file, change both.
 */

/** Width of the kerb strip on each side of the asphalt, metres. */
export const KERB_WIDTH = 1.2;

/**
 * Distance from the track edge to the barrier, metres — kerb included, so the
 * run-off surface itself is `RUNOFF_WIDTH - KERB_WIDTH` wide. Measured from the
 * edge rather than from the kerb because that is how track-collision.ts does it.
 */
export const RUNOFF_WIDTH = 9.0;

/** Kerb height at the track edge. Deliberately small — a big step launches cars. */
export const KERB_LIP = 0.04;

/** Kerb height at its outer edge: slightly below the road, so it sheds outward. */
export const KERB_OUTER = -0.03;

/** How far the run-off has fallen away by the time it reaches the barrier. */
export const RUNOFF_DROP = -0.45;

/** Barrier wall height above local ground, metres. */
export const BARRIER_HEIGHT = 1.3;

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

  }

  dilateForward(leftKind, track, GRAVEL_RUNON_METRES);
  dilateForward(rightKind, track, GRAVEL_RUNON_METRES);

  // Run-off width is deliberately uniform, matching the physics builder.
  //
  // An earlier version narrowed the inside of tight corners so the offset curve
  // could not fold. At a 14 m run-off that mattered; at 9 m nothing folds, and
  // the narrowing only pulled the visible barrier up to 5 m inside the one the
  // car actually hits, at four points on Interlagos. Silently disagreeing with
  // the collision surface is worse than the fold it was guarding against.
  //
  // A real fold is still caught: checks.ts measures whether the built barrier
  // line advances along the lap and fails the build if it does not. If a future
  // circuit trips that, change BOTH this file and vehicle/track-collision.ts —
  // never one alone.

  return { leftKind, rightKind, leftWidth, rightWidth };
}

/** Minimum fraction of the centreline step that the barrier line must advance. */
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
    outerL: hw + runoffL,
    outerR: hw + runoffR,
  };
}

/** Signed lateral offsets of the section's vertex columns, left to right. */
export function stations(width: number, runoffL: number, runoffR: number): number[] {
  const e = edgesAt(width, runoffL, runoffR);
  return [-e.outerL, -e.kerbL, -e.hw, 0, e.hw, e.kerbR, e.outerR];
}

/** Distance from the centreline to the barrier on the given side. */
export function outerHalfWidth(width: number, runoff: number): number {
  return width / 2 + runoff;
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
  const kerbOuter = hw + KERB_WIDTH;
  const barrier = hw + runoff;

  if (a <= hw) return 0;
  // The kerb steps up to a lip at the track edge and falls away outward. The
  // step at `hw` is intentional and matches the physics surface.
  if (a <= kerbOuter) {
    const t = (a - hw) / KERB_WIDTH;
    return KERB_LIP + (KERB_OUTER - KERB_LIP) * t;
  }
  if (a >= barrier) return RUNOFF_DROP;
  const t = (a - kerbOuter) / Math.max(1e-6, barrier - kerbOuter);
  return KERB_OUTER + (RUNOFF_DROP - KERB_OUTER) * t;
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
