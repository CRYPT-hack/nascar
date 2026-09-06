/**
 * Lap and checkpoint validation. Authoritative - this runs on the server only.
 *
 * A lap counts when the car crosses the start/finish line having passed every
 * checkpoint in order since the last crossing. That rules out both cutting the
 * infield and reversing back over the line to farm laps, without needing any
 * special-case geometry.
 *
 * Progress is tracked as a continuous distance rather than as "which checkpoint
 * am I nearest", because a car sitting on a checkpoint and twitching would
 * otherwise trigger it repeatedly.
 */

import type { TrackQuery, TrackPoint } from '../vehicle/track-query';

export interface LapEvent {
  lap: number; // lap just completed, 1-based
  lapTimeMs: number;
  bestMs: number;
  totalMs: number;
}

export class LapTracker {
  private readonly q: TrackQuery;
  /** Distance along the lap of each checkpoint. */
  private readonly cpDistance: number[];

  /** Completed laps. */
  lap = 0;
  /** Index of the last checkpoint passed, as sent in the snapshot. */
  cp = 0;
  /** Which checkpoints have been passed on the current lap. */
  private visited: boolean[];
  private lastDistance = 0;
  private started = false;

  lapStartMs = 0;
  bestMs: number | null = null;
  totalMs = 0;
  readonly lapTimes: number[] = [];

  /** Distance covered over the whole race. Used to order cars on track. */
  raceDistance = 0;

  constructor(q: TrackQuery) {
    this.q = q;
    this.cpDistance = q.checkpointWaypoints.map((i) => q.distanceAt(i));
    this.visited = new Array(this.cpDistance.length).fill(false);
  }

  /** Call when the lights go out. */
  start(nowMs: number): void {
    this.lapStartMs = nowMs;
    this.started = true;
    this.visited.fill(false);
    this.visited[0] = true; // the grid is behind the line, so it counts as passed
    this.cp = 0;
  }

  /** Place the car at a known point without generating events. */
  seed(loc: TrackPoint): void {
    this.lastDistance = loc.distance;
    this.raceDistance = loc.distance;
  }

  /**
   * Advance with the car's current position on the lap.
   * Returns a LapEvent on the tick the car completes a lap, otherwise null.
   */
  update(loc: TrackPoint, nowMs: number): LapEvent | null {
    const lapLen = this.q.lapLength;
    const d = loc.distance;
    const prev = this.lastDistance;
    this.lastDistance = d;

    // Detect which way we crossed the seam, if at all.
    let delta = d - prev;
    if (delta < -lapLen / 2) delta += lapLen; // forward over the line
    else if (delta > lapLen / 2) delta -= lapLen; // backwards over the line

    this.raceDistance += delta;

    if (!this.started) return null;

    // Mark every checkpoint the car swept past this tick. Iterating the swept
    // interval rather than testing proximity means a car at 250 km/h, covering
    // 4 m per tick, cannot skip one.
    if (delta > 0) {
      for (let c = 0; c < this.cpDistance.length; c++) {
        if (crossedForward(prev, d, this.cpDistance[c]!, lapLen)) {
          // Only accept it if every earlier checkpoint on this lap is done.
          if (c === 0 || this.visited[c - 1]) {
            this.visited[c] = true;
            this.cp = c;
          }
        }
      }
    }

    // Crossing the line forward completes a lap, but only with a full set.
    if (delta > 0 && crossedForward(prev, d, this.cpDistance[0]!, lapLen)) {
      const all = this.visited.every(Boolean);
      if (all) {
        const lapTimeMs = nowMs - this.lapStartMs;
        this.lap++;
        this.lapTimes.push(lapTimeMs);
        this.totalMs += lapTimeMs;
        if (this.bestMs === null || lapTimeMs < this.bestMs) this.bestMs = lapTimeMs;
        this.lapStartMs = nowMs;
        this.visited.fill(false);
        this.visited[0] = true;
        this.cp = 0;
        return { lap: this.lap, lapTimeMs, bestMs: this.bestMs, totalMs: this.totalMs };
      }
      // Line crossed without the full set: a cut lap. Reset and try again.
      this.visited.fill(false);
      this.visited[0] = true;
      this.cp = 0;
    }

    return null;
  }

  /** Checkpoints still missing on the current lap, for debugging a cut. */
  missing(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.visited.length; i++) if (!this.visited[i]) out.push(i);
    return out;
  }
}

/**
 * Did the interval (prev -> now), travelling forward, pass `mark`?
 * All three are distances along a closed loop of length `lapLen`.
 */
function crossedForward(prev: number, now: number, mark: number, lapLen: number): boolean {
  if (now >= prev) return mark > prev && mark <= now;
  // Wrapped past the seam: the interval is (prev, lapLen] plus [0, now].
  return mark > prev || mark <= now;
}
