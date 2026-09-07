/**
 * "Where on the track is this point?"
 *
 * Backs several things that must all agree:
 *   - CarSnap.surface on the wire (shared/protocol.ts)
 *   - the friction and drag the server applies, and that client prediction
 *     replays — if these two differ the car creeps sideways under rollback and
 *     it looks like a netcode bug (HANDOFF.md §10)
 *   - race position ordering, from lap fraction
 *   - the HUD minimap
 *
 * Pure and deterministic: same track JSON in, same answer out, on both sides.
 * No three.js — the server imports this.
 */

import type { SurfaceKind } from '../../shared/protocol';
import type { SurfaceProps, TrackData } from '../../shared/track-schema';
import { outerHalfWidth, planSection, sectionRise, surfaceAt, type SectionPlan } from './section';

export interface TrackQuery {
  /** Nearest waypoint index. */
  i: number;
  /** Arc length from the start/finish line, metres. */
  s: number;
  /** Lap fraction, 0..1 from the start/finish line. */
  u: number;
  /** Signed lateral offset from the centreline, metres, positive to the right. */
  lateral: number;
  surface: SurfaceKind;
  /** Height of the track surface directly below/above the query point. */
  groundY: number;
  /** Full track width here, metres. */
  width: number;
  /** False once the point is outside the barrier line. */
  onTrack: boolean;
}

/**
 * Grid cell size, metres. Set to the registration radius so a waypoint spans at
 * most 3x3 cells and a query is a single cell lookup.
 */
const CELL = 26;

export class TrackSampler {
  readonly track: TrackData;
  readonly section: SectionPlan;
  readonly lapLength: number;

  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly zs: Float64Array;
  /** Cumulative arc length at each waypoint. */
  private readonly cum: Float64Array;
  private readonly grid = new Map<number, number[]>();

  constructor(track: TrackData, section?: SectionPlan) {
    this.track = track;
    // Reuse the plan from buildTrackMeshes when the caller already has one, so
    // geometry and queries are guaranteed to be reading the same section.
    this.section = section ?? planSection(track);

    const n = track.waypoints.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.zs = new Float64Array(n);
    this.cum = new Float64Array(n);

    let s = 0;
    for (let i = 0; i < n; i++) {
      const p = track.waypoints[i]!.p;
      this.xs[i] = p[0];
      this.ys[i] = p[1];
      this.zs[i] = p[2];
      this.cum[i] = s;
      const q = track.waypoints[(i + 1) % n]!.p;
      s += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    }
    this.lapLength = s;

    // Register each waypoint into every cell within CELL metres, so any point
    // within CELL of the centreline is found without probing neighbours.
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(this.xs[i]! / CELL);
      const cz = Math.floor(this.zs[i]! / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = this.key(cx + dx, cz + dz);
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          list.push(i);
        }
      }
    }
  }

  private key(cx: number, cz: number): number {
    // Cantor-ish pack; cells are small integers for any plausible circuit.
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  /** Nearest waypoint index to (x, z). Falls back to a scan when far off-circuit. */
  private nearest(x: number, z: number): number {
    const list = this.grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    let best = -1;
    let bestD = Infinity;

    if (list) {
      for (const i of list) {
        const dx = this.xs[i]! - x;
        const dz = this.zs[i]! - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best >= 0) return best;

    for (let i = 0; i < this.xs.length; i++) {
      const dx = this.xs[i]! - x;
      const dz = this.zs[i]! - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  query(x: number, z: number): TrackQuery {
    const n = this.xs.length;
    const i = this.nearest(x, z);

    // Refine against both segments meeting at the nearest waypoint: the nearest
    // *vertex* is not necessarily on the nearest *segment*.
    let bestPerp = Infinity;
    let seg = i;
    let t = 0;
    for (const a of [(i - 1 + n) % n, i]) {
      const b = (a + 1) % n;
      const ex = this.xs[b]! - this.xs[a]!;
      const ez = this.zs[b]! - this.zs[a]!;
      const len2 = ex * ex + ez * ez;
      if (len2 < 1e-12) continue;
      const raw = ((x - this.xs[a]!) * ex + (z - this.zs[a]!) * ez) / len2;
      const tc = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const px = this.xs[a]! + ex * tc;
      const pz = this.zs[a]! + ez * tc;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < bestPerp) {
        bestPerp = d;
        seg = a;
        t = tc;
      }
    }

    const a = seg;
    const b = (a + 1) % n;
    const ex = this.xs[b]! - this.xs[a]!;
    const ez = this.zs[b]! - this.zs[a]!;
    const el = Math.hypot(ex, ez) || 1;
    // right = forward x up, normalised, in the XZ plane
    const rx = -ez / el;
    const rz = ex / el;
    const lateral = (x - (this.xs[a]! + ex * t)) * rx + (z - (this.zs[a]! + ez * t)) * rz;

    const wa = this.track.waypoints[a]!;
    const wb = this.track.waypoints[b]!;
    const width = wa.width + (wb.width - wa.width) * t;
    const banking = wa.banking + (wb.banking - wa.banking) * t;
    const centreY = this.ys[a]! + (this.ys[b]! - this.ys[a]!) * t;

    const s = this.cum[a]! + el * t;
    const near = t < 0.5 ? a : b;
    const left = lateral < 0;
    const runoffKind = left ? this.section.leftKind[near]! : this.section.rightKind[near]!;
    const runoffWidth = left ? this.section.leftWidth[near]! : this.section.rightWidth[near]!;

    return {
      i: near,
      s,
      u: s / this.lapLength,
      lateral,
      surface: surfaceAt(lateral, width, runoffKind),
      // Negated to match the banking convention: positive banking lowers the
      // right-hand edge. See mesh.ts buildFrames and CHANGELOG-SHARED.md.
      groundY: centreY - lateral * Math.sin(banking) + sectionRise(lateral, width, runoffWidth),
      width,
      onTrack: Math.abs(lateral) <= outerHalfWidth(width, runoffWidth),
    };
  }

  /** Convenience for the server's per-tick surface lookup. */
  surfaceAt(x: number, z: number): SurfaceKind {
    return this.query(x, z).surface;
  }

  /** Friction and drag for a surface, straight from the track's own table. */
  props(kind: SurfaceKind): SurfaceProps {
    return this.track.surfaces[kind];
  }

  /**
   * Centreline pose at a given arc length. For AI waypoint following (fallback
   * Tier 2, HANDOFF.md §8) and for placing the camera on a replay.
   */
  poseAt(s: number): { p: [number, number, number]; heading: number; width: number } {
    const n = this.xs.length;
    let d = ((s % this.lapLength) + this.lapLength) % this.lapLength;
    let a = 0;
    // Linear walk is fine: callers step forward in small increments.
    while (a < n - 1 && this.cum[a + 1]! <= d) a++;
    const b = (a + 1) % n;
    const segLen = (b === 0 ? this.lapLength : this.cum[b]!) - this.cum[a]!;
    const t = segLen > 1e-9 ? (d - this.cum[a]!) / segLen : 0;
    const ex = this.xs[b]! - this.xs[a]!;
    const ez = this.zs[b]! - this.zs[a]!;
    return {
      p: [this.xs[a]! + ex * t, this.ys[a]! + (this.ys[b]! - this.ys[a]!) * t, this.zs[a]! + ez * t],
      // Measured from -Z, matching the spawn convention in HANDOFF.md §5.1.
      heading: Math.atan2(ex, -ez),
      width: this.track.waypoints[a]!.width,
    };
  }
}
