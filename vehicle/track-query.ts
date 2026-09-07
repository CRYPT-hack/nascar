/**
 * Spatial queries over a TrackData centreline.
 *
 * Everything that needs to know "where is this car on the lap" goes through
 * here: checkpoint and lap validation, race position, respawn, the AI driver,
 * and the HUD. One implementation, so the server and the client cannot disagree
 * about who is ahead.
 *
 * Nearest-waypoint lookup uses a uniform grid rather than a scan. At 60 Hz with
 * 10 cars a scan over ~1000 waypoints is 600k distance tests per second for
 * nothing.
 */

import type { TrackData } from '../shared/track-schema';

const CELL = 24; // metres

export interface TrackPoint {
  /** Index of the nearest waypoint. */
  index: number;
  /** Distance along the lap from the start/finish line, metres. */
  distance: number;
  /** Signed lateral offset from the centreline; positive is right of travel. */
  lateral: number;
  /** Height of the centreline at that point. */
  surfaceY: number;
  /** True when the point is between the track edges. */
  onTrack: boolean;
}

export class TrackQuery {
  readonly track: TrackData;
  readonly count: number;
  readonly lapLength: number;

  /** Cumulative centreline distance at each waypoint. */
  private readonly cum: Float64Array;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: Int32Array[];

  /** Checkpoint index -> waypoint index, and the reverse lookup. */
  readonly checkpointWaypoints: number[];

  constructor(track: TrackData) {
    this.track = track;
    this.count = track.waypoints.length;
    this.checkpointWaypoints = track.checkpoints.map((c) => c.idx);

    this.cum = new Float64Array(this.count);
    let d = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      this.cum[i] = d;
      const a = track.waypoints[i]!.p;
      const b = track.waypoints[(i + 1) % this.count]!.p;
      d += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      minX = Math.min(minX, a[0]);
      maxX = Math.max(maxX, a[0]);
      minZ = Math.min(minZ, a[2]);
      maxZ = Math.max(maxZ, a[2]);
    }
    this.lapLength = d;

    // Pad the grid so a car well off the circuit still lands in a real cell.
    const pad = 60;
    this.minX = minX - pad;
    this.minZ = minZ - pad;
    this.cols = Math.max(1, Math.ceil((maxX - minX + pad * 2) / CELL));
    this.rows = Math.max(1, Math.ceil((maxZ - minZ + pad * 2) / CELL));

    const buckets: number[][] = Array.from({ length: this.cols * this.rows }, () => []);
    for (let i = 0; i < this.count; i++) {
      const p = track.waypoints[i]!.p;
      const c = this.cellOf(p[0], p[2]);
      buckets[c]!.push(i);
    }
    this.cells = buckets.map((b) => Int32Array.from(b));
  }

  private cellOf(x: number, z: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / CELL)));
    const cz = Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.minZ) / CELL)));
    return cz * this.cols + cx;
  }

  /**
   * Nearest waypoint index. Searches outward in rings of cells and stops as
   * soon as the next ring cannot beat the best distance found so far.
   */
  nearestIndex(x: number, z: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / CELL)));
    const cz = Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.minZ) / CELL)));

    let best = -1;
    let bestD = Infinity;

    for (let ring = 0; ring < Math.max(this.cols, this.rows); ring++) {
      // Once a hit is closer than the nearest edge of this ring, stop.
      if (best >= 0 && bestD < ((ring - 1) * CELL) ** 2) break;

      let touched = false;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const gx = cx + dx;
          const gz = cz + dz;
          if (gx < 0 || gz < 0 || gx >= this.cols || gz >= this.rows) continue;
          touched = true;
          for (const i of this.cells[gz * this.cols + gx]!) {
            const p = this.track.waypoints[i]!.p;
            const d = (p[0] - x) ** 2 + (p[2] - z) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      if (!touched && ring > Math.max(this.cols, this.rows)) break;
    }

    return best < 0 ? 0 : best;
  }

  /**
   * Nearest waypoint, searching only near `hint`. Cars move a few metres per
   * tick, so the previous index is almost always within a handful of steps.
   * Falls back to the grid when the hint turns out to be wrong - after a
   * respawn or a big correction from the server.
   */
  nearestIndexNear(x: number, z: number, hint: number, window = 40): number {
    const n = this.count;
    let best = hint;
    let bestD = Infinity;
    for (let k = -window; k <= window; k++) {
      const i = ((hint + k) % n + n) % n;
      const p = this.track.waypoints[i]!.p;
      const d = (p[0] - x) ** 2 + (p[2] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // If the best is at the edge of the window the hint was stale.
    const drift = Math.min(Math.abs(best - hint), n - Math.abs(best - hint));
    if (drift >= window) return this.nearestIndex(x, z);
    return best;
  }

  /**
   * Locate a world position on the lap. `hint` is the previous index for this
   * car, if there is one.
   */
  locate(x: number, y: number, z: number, hint?: number): TrackPoint {
    const n = this.count;
    const i = hint === undefined ? this.nearestIndex(x, z) : this.nearestIndexNear(x, z, hint);

    // Project onto whichever of the two adjacent segments actually contains it.
    const prev = (i - 1 + n) % n;
    const a = this.projectSegment(x, z, prev);
    const b = this.projectSegment(x, z, i);
    const use = a.d2 <= b.d2 ? a : b;
    const seg = a.d2 <= b.d2 ? prev : i;

    const wp = this.track.waypoints[seg]!;
    const nextWp = this.track.waypoints[(seg + 1) % n]!;
    const segLen = Math.hypot(nextWp.p[0] - wp.p[0], nextWp.p[2] - wp.p[2]) || 1;

    const distance = this.cum[seg]! + use.t * segLen;
    const halfWidth = (wp.width + (nextWp.width - wp.width) * use.t) / 2;
    const surfaceY = wp.p[1] + (nextWp.p[1] - wp.p[1]) * use.t;
    void y;

    return {
      index: i,
      distance,
      lateral: use.lateral,
      surfaceY,
      onTrack: Math.abs(use.lateral) <= halfWidth,
    };
  }

  /** Project onto segment `si` -> `si+1`, in the XZ plane. */
  private projectSegment(x: number, z: number, si: number): { t: number; d2: number; lateral: number } {
    const n = this.count;
    const a = this.track.waypoints[si]!.p;
    const b = this.track.waypoints[(si + 1) % n]!.p;
    const ex = b[0] - a[0];
    const ez = b[2] - a[2];
    const len2 = ex * ex + ez * ez || 1;
    let t = ((x - a[0]) * ex + (z - a[2]) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a[0] + ex * t;
    const pz = a[2] + ez * t;
    const dx = x - px;
    const dz = z - pz;
    // right = (-ez, ex) normalised; positive lateral means right of travel.
    const l = Math.sqrt(len2);
    const lateral = (dx * -ez + dz * ex) / l;
    return { t, d2: dx * dx + dz * dz, lateral };
  }

  /** Forward heading at a waypoint, as an angle measured from -Z toward +X. */
  headingAt(i: number): number {
    const n = this.count;
    const a = this.track.waypoints[((i % n) + n) % n]!.p;
    const b = this.track.waypoints[(((i + 1) % n) + n) % n]!.p;
    return Math.atan2(b[0] - a[0], -(b[2] - a[2]));
  }

  /** Cumulative distance from the start/finish line to a waypoint. */
  distanceAt(i: number): number {
    return this.cum[((i % this.count) + this.count) % this.count]!;
  }

  /**
   * Signed curvature at a waypoint, 1/m, smoothed over `span` waypoints.
   * Negative is a left-hand corner. The AI uses this to pick corner speeds.
   */
  curvatureAt(i: number, span = 6): number {
    const n = this.count;
    const a = this.track.waypoints[((i - span) % n + n) % n]!.p;
    const b = this.track.waypoints[((i % n) + n) % n]!.p;
    const c = this.track.waypoints[((i + span) % n + n) % n]!.p;
    const ux = b[0] - a[0];
    const uz = b[2] - a[2];
    const vx = c[0] - b[0];
    const vz = c[2] - b[2];
    const cross = ux * vz - uz * vx;
    const la = Math.hypot(ux, uz);
    const lb = Math.hypot(vx, vz);
    const lc = Math.hypot(c[0] - a[0], c[2] - a[2]);
    const denom = la * lb * lc;
    return denom > 1e-9 ? (2 * cross) / denom : 0;
  }
}
