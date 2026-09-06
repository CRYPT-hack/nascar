/**
 * Waypoint-following AI driver.
 *
 * HANDOFF.md §8 Tier 2: six humans plus four server-side AI. Written early and
 * unconditionally because it is cheap insurance - the AI has no netcode problem
 * at all, since the server owns these cars outright and never reconciles them.
 * It also fills the grid, which matters more on camera than it should.
 *
 * The driver produces a `CarInput`, exactly the shape a human client sends, so
 * it feeds the identical `Car.step()`. Nothing downstream can tell the
 * difference, which is the point: an AI car cannot diverge from a human car's
 * physics because there is only one physics.
 *
 * Steering is a curvature demand, not a steering angle. See `steerFor()`.
 */

import { CAR } from '../shared/constants';
import type { CarInput, SurfaceKind } from '../shared/protocol';
import { angleDelta, clamp, dot, sub, yawOf, type Q4, type V3 } from './math3';
import type { TrackPoint, TrackQuery } from './track-query';

/**
 * What the driver needs to see. `Car` satisfies this structurally, and so does
 * a view reconstructed from a snapshot - which is how tools/loadtest.ts drives
 * ten headless clients without giving each of them a physics world of its own.
 */
export interface DrivableView {
  position(): V3;
  rotation(): Q4;
  linvel(): V3;
  angvel(): V3;
  forward(): V3;
  right(): V3;
  up(): V3;
  readonly speed: number;
  readonly forwardSpeed: number;
  readonly surface: SurfaceKind;
  isInverted(): boolean;
  maxSteerAngle(speed: number): number;
}

export interface AiSkill {
  /** 0..1. Scales cornering speed, so a slower AI is slower everywhere. */
  pace: number;
  /** Seconds of reaction lag. Higher looks more human and is easier to pass. */
  reaction: number;
  /** Metres of lateral wander, so four AI cars do not drive in one line. */
  lineOffset: number;
}

export const AI_SKILLS: AiSkill[] = [
  { pace: 0.97, reaction: 0.05, lineOffset: -1.4 },
  { pace: 0.93, reaction: 0.08, lineOffset: 1.2 },
  { pace: 0.89, reaction: 0.11, lineOffset: -0.6 },
  { pace: 0.85, reaction: 0.14, lineOffset: 2.0 },
];

/**
 * Cornering limit the speed profile is built against. The car sustains 1.31 g
 * on the skidpad; the profile leaves margin, because a driver aiming at exactly
 * the limit has nothing left when its line is imperfect - and its line is
 * always imperfect.
 */
const LAT_G = 0.95;
/** Grip the steering controller may ask for. Above the profile, so it can correct. */
const STEER_LAT_G = 1.25;
const BRAKE_G = 1.45;
const ACCEL_G = 0.95;
/** Total grip envelope the friction circle is drawn against. */
const TOTAL_G = 1.35;
const TOP_SPEED = 63; // m/s, measured

/**
 * Understeer gradient: radians of extra steering per unit of lateral
 * acceleration. Accounts for the front tyre slip angle the kinematic bicycle
 * model ignores.
 */
const UNDERSTEER = 0.0062;
/** Cross-track feedback, radians per metre at 1 m/s of speed. */
const CTE_GAIN = 0.85;
/** Waypoints either side used for the windowed-max curvature. 5 -> +/- 15 m. */
const CURV_WINDOW = 6;
/** Body slip angle, radians, past which the driver starts catching a slide. */
const SLIP_CATCH = 0.10;

/**
 * Maximum speed at every waypoint, in metres per second.
 *
 * Built in three passes. Curvature alone gives the speed a corner can be taken
 * at, but a car that only obeys curvature arrives at a hairpin at 220 km/h and
 * discovers it should have braked 150 m ago. The backward pass propagates the
 * braking requirement upstream; the forward pass stops the profile demanding
 * acceleration the car does not have.
 */
export function buildSpeedProfile(q: TrackQuery): Float64Array {
  const n = q.count;
  const v = new Float64Array(n);
  const ds = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const a = q.track.waypoints[i]!.p;
    const b = q.track.waypoints[(i + 1) % n]!.p;
    ds[i] = Math.max(0.1, Math.hypot(b[0] - a[0], b[2] - a[2]));
  }

  // Curvature, then a windowed maximum over +/- CURV_WINDOW waypoints.
  //
  // The window matters. A steady-state limit derived from the curvature at one
  // point says the Senna S can be taken at 190 km/h, and taken as an isolated
  // corner it can. As a left-right flick it cannot: the car has to reverse its
  // load transfer between the two halves, and it arrives at the second one with
  // the rear already unloaded. Taking the tightest curvature anywhere nearby
  // makes a sequence of corners slower than any one of them alone, which is
  // what a driver actually does.
  const kraw = new Float64Array(n);
  for (let i = 0; i < n; i++) kraw[i] = Math.abs(q.curvatureAt(i, 8));

  // Windowed curvature per waypoint, reused by both propagation passes.
  const kwin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let j = -CURV_WINDOW; j <= CURV_WINDOW; j++) k = Math.max(k, kraw[(i + j + n) % n]!);
    kwin[i] = k;
    v[i] = k > 1e-5 ? Math.min(TOP_SPEED, Math.sqrt((LAT_G * 9.81) / k)) : TOP_SPEED;
  }

  /**
   * Longitudinal grip left over at speed `speed` on curvature `k`.
   *
   * The friction circle is the whole point. Assuming a flat 1.45 g of braking
   * is available on corner entry is wrong, and wrong in the direction that
   * spins the car: the profile happily demanded 1.35 g of braking through the
   * entry to Ferradura while the same tyres were already carrying most of a g
   * sideways, so the car arrived at the corner with the rears gone. The floor
   * keeps a little longitudinal authority even at the lateral limit rather than
   * dividing by zero.
   */
  const longAvail = (speed: number, k: number, budget: number): number => {
    const aMax = TOTAL_G * 9.81;
    const aLat = Math.min(aMax * 0.98, speed * speed * k);
    return Math.max(budget * 9.81 * 0.25, Math.min(budget * 9.81, Math.sqrt(aMax * aMax - aLat * aLat)));
  };

  // Backward: you must already be slow enough to make the corner ahead.
  // Three laps of the loop so the constraint propagates across the seam.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const vn = v[(i + 1) % n]!;
      const a = longAvail(vn, kwin[(i + 1) % n]!, BRAKE_G);
      const limit = Math.sqrt(vn * vn + 2 * a * ds[i]!);
      if (v[i]! > limit) v[i] = limit;
    }
  }

  // Forward: and you cannot accelerate harder than the car can.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      const j = (i - 1 + n) % n;
      const a = longAvail(v[j]!, kwin[j]!, ACCEL_G);
      const limit = Math.sqrt(v[j]! ** 2 + 2 * a * ds[j]!);
      if (v[i]! > limit) v[i] = limit;
    }
  }

  return v;
}

export class AiDriver {
  private readonly q: TrackQuery;
  private readonly profile: Float64Array;
  private readonly skill: AiSkill;

  private hint = 0;
  private held: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private holdTicks = 0;
  private stuckTicks = 0;
  private reverseTicks = 0;

  constructor(q: TrackQuery, profile: Float64Array, skill: AiSkill) {
    this.q = q;
    this.profile = profile;
    this.skill = skill;
  }

  /** Nearest waypoint as of the last update. */
  get waypoint(): number {
    return this.hint;
  }

  update(car: DrivableView, dt: number, others: V3[] = []): CarInput {
    // Reaction lag: hold the previous decision for a few ticks. Without it the
    // AI is inhumanly precise and no player will ever pass one.
    if (this.holdTicks > 0) {
      this.holdTicks--;
      return this.held;
    }
    this.holdTicks = Math.max(0, Math.round(this.skill.reaction / dt) - 1);

    const p = car.position();
    const loc = this.q.locate(p.x, p.y, p.z, this.hint);
    this.hint = loc.index;
    const speed = Math.max(0, car.forwardSpeed);

    const unstick = this.unstick(car, loc);
    if (unstick) return (this.held = unstick);

    const steer = clamp(this.steerFor(car, loc, speed) + this.avoid(car, others, speed), -1, 1);
    const pedals = this.pedalsFor(car, speed, this.gapAhead(car, others));

    this.held = { throttle: pedals.throttle, brake: pedals.brake, steer, handbrake: false };
    return this.held;
  }

  // -------------------------------------------------------------------------

  /**
   * Steering.
   *
   * Pure pursuit gives a desired path *curvature*, kappa = 2 sin(a) / ld. The
   * mistake worth not repeating is turning that into a steering angle with the
   * kinematic bicycle model, delta = atan(2 L sin a / ld). That model assumes
   * the tyres do not slip. They do, and at 155 km/h it asked for roughly a
   * quarter of the angle actually needed: the cars tracked wide out of every
   * corner and spent half the lap on the grass, while the speed profile and the
   * curvature estimates behind it were both perfectly correct.
   *
   * So: the kinematic term, plus an understeer term proportional to the lateral
   * acceleration the corner demands, plus cross-track feedback so a small error
   * is corrected rather than accumulated.
   */
  private steerFor(car: DrivableView, loc: TrackPoint, speed: number): number {
    // Look further ahead the faster you are going. A short lookahead oscillates
    // on a straight; a long one cuts the apex and understeers on entry.
    const lookahead = clamp(7 + speed * 0.5, 9, 42);
    const steps = Math.max(2, Math.round(lookahead / 3));
    const target = this.pointOnLine((this.hint + steps) % this.q.count);

    const p = car.position();
    const toTarget = sub(target, { x: p.x, y: p.y, z: p.z });
    const ld = Math.max(3, Math.hypot(toTarget.x, toTarget.z));
    const alpha = angleDelta(Math.atan2(toTarget.x, -toTarget.z), yawOf(car.rotation()));

    // Do not ask for more curvature than the tyres can deliver at this speed.
    const kappaMax = speed > 4 ? (STEER_LAT_G * 9.81) / (speed * speed) : 1;
    const k = clamp((2 * Math.sin(alpha)) / ld, -kappaMax, kappaMax);

    const deltaKin = CAR.wheelbase * k;
    const deltaSlip = UNDERSTEER * k * speed * speed;

    const cte = loc.lateral - this.lineOffsetAt(this.hint);
    const deltaCte = (-CTE_GAIN * cte) / Math.max(8, speed);

    let steer = (deltaKin + deltaSlip + deltaCte) / car.maxSteerAngle(speed);

    // A little yaw damping. Positive angvel.y rotates -Z toward -X, which is a
    // LEFT turn and so decreases the yaw measured by yawOf(); countering it
    // means steering right, which is a positive input. Hence +=, not -=.
    steer += clamp(car.angvel().y * 0.05, -0.15, 0.15);

    // Catch a slide. Body slip is the angle between where the car is pointing
    // and where it is actually going; positive means the velocity is to the
    // right of the nose, which is the car rotating left out from under itself,
    // and the correction is to steer right.
    const beta = this.bodySlip(car, speed);
    if (Math.abs(beta) > SLIP_CATCH) {
      steer += clamp((beta - Math.sign(beta) * SLIP_CATCH) * 2.6, -0.9, 0.9);
    }

    return clamp(steer, -1, 1);
  }

  /**
   * Throttle and brake against the speed profile.
   *
   * The limit is the tightest constraint anywhere in the braking window ahead,
   * not the value at one lookahead point: sampling a single point walks
   * straight past the apex of a hairpin on the way into it.
   */
  /**
   * Angle between the car's heading and its actual direction of travel.
   * Zero when tracking straight, large when sliding.
   */
  private bodySlip(car: DrivableView, speed: number): number {
    if (speed < 6) return 0;
    const v = car.linvel();
    return angleDelta(Math.atan2(v.x, -v.z), yawOf(car.rotation()));
  }

  /**
   * Distance to the nearest car directly ahead, or Infinity. Only counts cars
   * roughly in this one's path - a car alongside is not something to lift for.
   */
  private gapAhead(car: DrivableView, others: V3[]): number {
    if (others.length === 0) return Infinity;
    const p = car.position();
    const fwd = car.forward();
    const right = car.right();
    let best = Infinity;
    for (const o of others) {
      const d = sub(o, { x: p.x, y: p.y, z: p.z });
      const ahead = dot(d, fwd);
      if (ahead <= 0 || ahead > 30) continue;
      if (Math.abs(dot(d, right)) > 2.4) continue;
      if (ahead < best) best = ahead;
    }
    return best;
  }

  private pedalsFor(car: DrivableView, speed: number, gapAhead = Infinity): { throttle: number; brake: number } {
    const spacing = 3;
    const brakeDist = (speed * speed) / (2 * BRAKE_G * 9.81);
    const window = Math.max(4, Math.round(brakeDist / spacing) + 6);

    let targetV = this.profile[this.hint]!;
    for (let k = 0; k <= window; k++) {
      const i = (this.hint + k) % this.q.count;
      // The speed we may be doing now and still slow to profile[i] by then.
      const allowed = Math.sqrt(this.profile[i]! ** 2 + 2 * BRAKE_G * 9.81 * k * spacing);
      if (allowed < targetV) targetV = allowed;
    }
    targetV *= this.skill.pace;

    // Off the racing surface the profile is a lie.
    if (car.surface === 'grass' || car.surface === 'gravel') targetV *= 0.55;

    // Lift for a car directly ahead. Without this the AI drives the speed
    // profile regardless of what is in front of it, and a ten-car grid turns
    // the run to the first corner into a pile-up: four cars DNF'd on lap one
    // before this existed. Two car lengths of headway, scaled with speed.
    if (gapAhead < Infinity) {
      const safe = 9 + speed * 0.45;
      if (gapAhead < safe) targetV = Math.min(targetV, speed * clamp(gapAhead / safe, 0.25, 1));
    }

    const err = targetV - speed;
    let throttle = 0;
    let brake = 0;
    if (err > 0.5) throttle = clamp(err * 0.4, 0, 1);
    else if (err < -1.0) brake = clamp(-err * 0.3, 0, 1);
    else throttle = clamp(0.3 + err * 0.2, 0, 0.5);

    // Never add power mid-slide, and never brake mid-slide either - both make
    // it worse. Let the car straighten first.
    const beta = Math.abs(this.bodySlip(car, speed));
    if (beta > SLIP_CATCH) {
      const ease = clamp(1 - (beta - SLIP_CATCH) * 3.5, 0.1, 1);
      throttle *= ease;
      brake *= ease;
    }

    return { throttle, brake };
  }

  /** Reverse out of a barrier rather than grinding along it. */
  private unstick(car: DrivableView, loc: TrackPoint): CarInput | null {
    if (this.reverseTicks > 0) {
      this.reverseTicks--;
      // Steer back toward the centreline while reversing.
      const back = clamp(-Math.sign(loc.lateral) || 1, -1, 1);
      return { throttle: 0, brake: 1, steer: back, handbrake: false };
    }
    const stuck = car.speed < 1.2 || car.isInverted();
    this.stuckTicks = stuck ? this.stuckTicks + 1 : 0;
    if (this.stuckTicks > 120) {
      this.stuckTicks = 0;
      this.reverseTicks = 70;
      return { throttle: 0, brake: 1, steer: 0, handbrake: false };
    }
    return null;
  }

  /**
   * Lateral offset of this driver's line from the centreline at `idx`.
   * Biased toward the inside of the corner, because a driver who tracks the
   * centreline exactly is slower than one who does not, and looks like a train.
   */
  private lineOffsetAt(idx: number): number {
    const w = this.q.track.waypoints[idx]!;
    const k = this.q.curvatureAt(idx, 8);
    // Inside of the corner has the SAME sign as the curvature: a left-hander
    // has negative curvature and its inside is at negative lateral offset. This
    // was negated once, which aimed every driver at the *outside* of every
    // corner. On the 16 m oval that only looked untidy; on a 12.5 m Interlagos
    // it put them in the barrier at Ferradura every lap.
    const inside = Math.sign(k) * Math.min(1, Math.abs(k) * 220) * (w.width / 2 - CAR.width);
    const room = w.width / 2 - 1.6;
    return clamp(inside + this.skill.lineOffset, -room, room);
  }

  private pointOnLine(idx: number): V3 {
    const n = this.q.count;
    const a = this.q.track.waypoints[idx]!;
    const b = this.q.track.waypoints[(idx + 1) % n]!;
    const fx = b.p[0] - a.p[0];
    const fz = b.p[2] - a.p[2];
    const fl = Math.hypot(fx, fz) || 1;
    const off = this.lineOffsetAt(idx);
    return { x: a.p[0] + (-fz / fl) * off, y: a.p[1], z: a.p[2] + (fx / fl) * off };
  }

  /**
   * A steering nudge away from any car close ahead or alongside. Deliberately
   * weak: the AI is scenery, and one that defends its line aggressively will
   * spoil more races than it improves.
   */
  private avoid(car: DrivableView, others: V3[], speed: number): number {
    if (others.length === 0) return 0;
    const p = car.position();
    const fwd = car.forward();
    const right = car.right();
    let nudge = 0;

    for (const o of others) {
      const d = sub(o, { x: p.x, y: p.y, z: p.z });
      const ahead = dot(d, fwd);
      const side = dot(d, right);
      const range = 4 + speed * 0.3;
      if (ahead < 0.5 || ahead > range) continue;
      if (Math.abs(side) > 3.5) continue;
      const urgency = (1 - ahead / range) * (1 - Math.abs(side) / 3.5);
      nudge -= Math.sign(side || 1) * urgency * 0.45;
    }
    return clamp(nudge, -0.45, 0.45);
  }
}
