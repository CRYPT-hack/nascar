/**
 * shared/track-schema.ts
 *
 * FROZEN CONTRACT — see HANDOFF.md §3, §5.3.
 * Track generator (/track) produces this. Server and client consume it.
 * Nothing else crosses the boundary.
 */

import type { SurfaceKind, Vec3 } from './protocol';

export interface Waypoint {
  /** Index in the ordered, closed loop. */
  i: number;
  /** Centreline point, metres. */
  p: Vec3;
  /** Full track width at this point, metres. Minimum 12. */
  width: number;
  /** Radians, positive = banked right. */
  banking: number;
  surface: SurfaceKind;
}

export interface Checkpoint {
  /** Index into `waypoints`. */
  idx: number;
  isStartFinish?: boolean;
}

export interface SpawnSlot {
  p: Vec3;
  rotY: number;
}

export interface SurfaceProps {
  friction: number;
  drag: number;
}

export interface TrackData {
  name: string;
  /** Fraction of the real circuit. */
  scale: number;
  lapLengthMeters: number;
  waypoints: Waypoint[];
  checkpoints: Checkpoint[];
  spawnGrid: SpawnSlot[];
  collisionMesh: string;
  visualMesh: string;
  surfaces: Record<SurfaceKind, SurfaceProps>;
}

/** Minimum legal track width — below this, three cars cannot run abreast. */
export const MIN_TRACK_WIDTH = 12;

/**
 * Validate a track JSON blob. Returns a list of problems; empty means valid.
 * Cheap to run at load time on both server and client — do it.
 */
export function validateTrack(t: TrackData): string[] {
  const errs: string[] = [];

  if (!t.waypoints || t.waypoints.length < 16) {
    errs.push('waypoints: need at least 16');
    return errs;
  }

  for (let i = 0; i < t.waypoints.length; i++) {
    const w = t.waypoints[i]!;
    if (w.i !== i) errs.push(`waypoint ${i}: index field is ${w.i}`);
    if (!w.p || w.p.length !== 3 || w.p.some((n) => !Number.isFinite(n))) {
      errs.push(`waypoint ${i}: bad point`);
    }
    if (!(w.width >= MIN_TRACK_WIDTH)) {
      errs.push(`waypoint ${i}: width ${w.width} below minimum ${MIN_TRACK_WIDTH}`);
    }
    if (!t.surfaces[w.surface]) {
      errs.push(`waypoint ${i}: unknown surface "${w.surface}"`);
    }
  }

  const sf = t.checkpoints.filter((c) => c.isStartFinish);
  if (sf.length !== 1) errs.push(`checkpoints: expected exactly 1 isStartFinish, got ${sf.length}`);
  if (t.checkpoints.length < 8) errs.push('checkpoints: need at least 8');

  let prev = -1;
  for (const c of t.checkpoints) {
    if (c.idx < 0 || c.idx >= t.waypoints.length) errs.push(`checkpoint idx ${c.idx} out of range`);
    if (c.idx <= prev) errs.push(`checkpoints must be strictly ascending (${prev} -> ${c.idx})`);
    prev = c.idx;
  }

  if (t.spawnGrid.length < 1) errs.push('spawnGrid: empty');

  if (!(t.lapLengthMeters > 100)) errs.push('lapLengthMeters looks wrong');

  return errs;
}

/** Total centreline length, recomputed from waypoints. */
export function measureLapLength(t: TrackData): number {
  let d = 0;
  const n = t.waypoints.length;
  for (let i = 0; i < n; i++) {
    const a = t.waypoints[i]!.p;
    const b = t.waypoints[(i + 1) % n]!.p;
    d += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return d;
}
