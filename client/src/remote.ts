/**
 * Remote car interpolation.
 *
 * Remote cars are rendered INTERP_DELAY_MS in the past, interpolated between
 * the two snapshots that bracket that moment. HANDOFF.md §5.5 calls this not
 * optional, and it is not: snapshots arrive at 30 Hz, the screen refreshes at
 * 60 or 144, and drawing the newest snapshot directly makes every remote car
 * visibly step twice per frame at speed. The 100 ms buffer is what a dropped or
 * late packet is spent out of.
 *
 * The timeline is built from the server tick each snapshot carries, mapped onto
 * the local clock by an offset estimated from the least-delayed packet seen.
 * Arrival order is not tick order once there is jitter, so arrival time cannot
 * be used to decide which two snapshots bracket a moment.
 *
 * Each remote car also gets a kinematic body in the local physics world, moved
 * to its interpolated pose every frame. That is what lets the predicted local
 * car actually hit other cars on this machine instead of driving through them
 * until the server disagrees.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type { RigidBody } from '@dimforge/rapier3d-compat';

import { CAR, GROUP, INTERP_DELAY_MS, TICK_HZ, interactionGroups } from '../../shared/constants';
import type { CarSnap, SnapMsg, SurfaceKind } from '../../shared/protocol';
import { lerpV3, slerp, type Q4, type V3 } from '../../vehicle/math3';
import type { RaceWorld } from '../../vehicle/world';

/** Snapshots older than this are dropped. Well past the interpolation delay. */
const BUFFER_MS = 2000;

export interface RemotePose {
  p: V3;
  q: Q4;
  v: V3;
  lap: number;
  cp: number;
  surface: SurfaceKind;
  /** True when the pose is held at the newest sample because nothing newer arrived. */
  stale: boolean;
}

interface Sample {
  /** Local receive time, ms. Used only to estimate the clock offset. */
  recv: number;
  /** Position on the local timeline, derived from the server tick. */
  t: number;
  tick: number;
  cars: Map<number, CarSnap>;
}

export interface RemoteStats {
  /** Snapshots currently buffered. */
  buffered: number;
  /** How far behind the newest snapshot the render time is, ms. */
  behindMs: number;
  /** Fraction of frames served from a held (stale) sample. */
  staleRate: number;
  /** Measured gap between consecutive snapshot arrivals, ms. */
  arrivalGapMs: number;
}

export class RemoteCars {
  private samples: Sample[] = [];
  private readonly ghosts = new Map<number, RigidBody>();
  private readonly rw: RaceWorld;
  private lastArrival = 0;
  /** Local clock minus server tick clock, ms. Established from the first snapshot. */
  private offset: number | null = null;
  private staleFrames = 0;
  private totalFrames = 0;

  readonly stats: RemoteStats = { buffered: 0, behindMs: 0, staleRate: 0, arrivalGapMs: 0 };

  constructor(rw: RaceWorld) {
    this.rw = rw;
  }

  /**
   * Ingest a snapshot. `now` is the local clock at receipt.
   *
   * The timeline a snapshot is placed on comes from its server tick, not from
   * when it happened to arrive. Arrival time is not monotonic in tick order
   * once there is any jitter, and an earlier version of this buffer sorted by
   * tick while searching by arrival time - which silently picked the wrong pair
   * of samples to interpolate between and made remote cars jump.
   *
   * The offset between the two clocks is estimated from the least-delayed
   * snapshot seen recently, then allowed to drift upward slowly so a single
   * unusually fast packet cannot pull the whole timeline forward for good.
   */
  push(snap: SnapMsg, now: number): void {
    const cars = new Map<number, CarSnap>();
    for (const c of snap.cars) cars.set(c.id, c);

    const tickMs = snap.tick * (1000 / TICK_HZ);
    const observed = now - tickMs;
    if (this.offset === null) this.offset = observed;
    else if (observed < this.offset) this.offset = observed; // a faster packet
    else this.offset += (observed - this.offset) * 0.002; // slow drift correction

    const s: Sample = { recv: now, t: this.offset + tickMs, tick: snap.tick, cars };

    let i = this.samples.length;
    while (i > 0 && this.samples[i - 1]!.tick > s.tick) i--;
    if (i < this.samples.length && this.samples[i]!.tick === s.tick) return; // duplicate
    this.samples.splice(i, 0, s);

    if (this.lastArrival > 0) {
      const gap = now - this.lastArrival;
      this.stats.arrivalGapMs = this.stats.arrivalGapMs * 0.9 + gap * 0.1;
    }
    this.lastArrival = now;

    const cutoff = now - BUFFER_MS;
    while (this.samples.length > 2 && this.samples[0]!.recv < cutoff) this.samples.shift();
    this.stats.buffered = this.samples.length;
  }

  /** Every car id present in the newest snapshot. */
  ids(): number[] {
    const newest = this.samples[this.samples.length - 1];
    return newest ? [...newest.cars.keys()] : [];
  }

  /**
   * Interpolated pose for one car at `now - INTERP_DELAY_MS`.
   * Returns null if the car is not in the buffer at all.
   */
  poseOf(id: number, now: number): RemotePose | null {
    const target = now - INTERP_DELAY_MS;
    const n = this.samples.length;
    if (n === 0) return null;

    const newest = this.samples[n - 1]!;
    this.stats.behindMs = newest.t - target;

    // Nothing new enough: hold at the newest sample rather than extrapolating.
    // Extrapolation looks fine for one frame and awful for five, and the whole
    // point of the delay buffer is that this should be rare.
    if (target >= newest.t) {
      const c = newest.cars.get(id);
      return c ? poseFrom(c, true) : null;
    }

    const oldest = this.samples[0]!;
    if (target <= oldest.t) {
      const c = oldest.cars.get(id);
      return c ? poseFrom(c, true) : null;
    }

    let hi = 1;
    while (hi < n && this.samples[hi]!.t < target) hi++;
    const b = this.samples[Math.min(hi, n - 1)]!;
    const a = this.samples[Math.max(0, hi - 1)]!;

    const ca = a.cars.get(id);
    const cb = b.cars.get(id);
    if (!ca && !cb) return null;
    if (!ca) return poseFrom(cb!, false);
    if (!cb) return poseFrom(ca, true);

    const span = b.t - a.t;
    const u = span > 1e-3 ? Math.min(1, Math.max(0, (target - a.t) / span)) : 0;

    return {
      p: lerpV3(v(ca.p), v(cb.p), u),
      q: slerp(qq(ca.q), qq(cb.q), u),
      v: lerpV3(v(ca.v), v(cb.v), u),
      lap: u < 0.5 ? ca.lap : cb.lap,
      cp: u < 0.5 ? ca.cp : cb.cp,
      surface: u < 0.5 ? ca.surface : cb.surface,
      stale: false,
    };
  }

  /**
   * Move each remote car's kinematic body to its interpolated pose.
   * `exclude` is the local car, which is simulated rather than interpolated.
   */
  updateGhosts(now: number, exclude: number): void {
    this.totalFrames++;
    let anyStale = false;
    const live = new Set<number>();

    for (const id of this.ids()) {
      if (id === exclude) continue;
      const pose = this.poseOf(id, now);
      if (!pose) continue;
      live.add(id);
      if (pose.stale) anyStale = true;

      let body = this.ghosts.get(id);
      if (!body) {
        body = this.createGhost();
        this.ghosts.set(id, body);
      }
      body.setNextKinematicTranslation(pose.p);
      body.setNextKinematicRotation(pose.q);
    }

    // Drop bodies for cars that have left.
    for (const [id, body] of [...this.ghosts]) {
      if (live.has(id)) continue;
      this.rw.world.removeRigidBody(body);
      this.ghosts.delete(id);
    }

    if (anyStale) this.staleFrames++;
    this.stats.staleRate = this.totalFrames > 0 ? this.staleFrames / this.totalFrames : 0;
  }

  /**
   * A kinematic stand-in so the predicted local car has something solid to hit.
   * Kinematic rather than dynamic: its pose comes from the server by way of the
   * interpolator, and nothing local should be able to push it around.
   */
  private createGhost(): RigidBody {
    const body = this.rw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const desc = RAPIER.ColliderDesc.cuboid(CAR.width / 2, 0.34, CAR.length / 2)
      .setFriction(0.22)
      .setRestitution(0.12)
      .setCollisionGroups(interactionGroups(GROUP.CAR, GROUP.CAR));
    this.rw.world.createCollider(desc, body);
    return body;
  }

  /** Reset counters between races so the stale rate reflects the current run. */
  resetStats(): void {
    this.staleFrames = 0;
    this.totalFrames = 0;
  }

  clear(): void {
    for (const body of this.ghosts.values()) this.rw.world.removeRigidBody(body);
    this.ghosts.clear();
    this.samples.length = 0;
    this.offset = null;
  }
}

const v = (a: readonly [number, number, number]): V3 => ({ x: a[0], y: a[1], z: a[2] });
const qq = (a: readonly [number, number, number, number]): Q4 => ({
  x: a[0],
  y: a[1],
  z: a[2],
  w: a[3],
});

function poseFrom(c: CarSnap, stale: boolean): RemotePose {
  return {
    p: v(c.p),
    q: qq(c.q),
    v: v(c.v),
    lap: c.lap,
    cp: c.cp,
    surface: c.surface,
    stale,
  };
}
