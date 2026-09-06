/**
 * Raycast vehicle.
 *
 * Four suspension rays hang off a single rigid body. Each ray that reaches the
 * ground contributes a spring/damper force along the contact normal and a tyre
 * force in the contact plane. There is no wheel spin state and no drivetrain
 * simulation: engine and brake produce a longitudinal force directly, clamped
 * against the lateral force by a friction circle.
 *
 * That choice is deliberate and it is a netcode decision as much as a physics
 * one. The entire vehicle state is the rigid body plus one scalar (the smoothed
 * steering angle), so a rollback is a `restore()` and a re-`step()` - there is
 * no hidden per-wheel integrator to get out of sync between server and client.
 * See DECISION-LOG.md.
 *
 * Everything here is frame-rate independent only at the fixed timestep in
 * shared/constants.ts. Do not call step() with a variable dt.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';

import { CAR, GROUP, interactionGroups } from '../shared/constants';
import type { CarInput, SurfaceKind } from '../shared/protocol';
import {
  add,
  clamp,
  cross,
  dot,
  length,
  normalize,
  quatFromAxis,
  quatMul,
  rotate,
  scale,
  sub,
  type Q4,
  type V3,
} from './math3';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export interface CarTuning {
  /** Suspension travel from full droop to the attachment point, metres. */
  suspensionRest: number;
  suspensionStiffness: number; // N/m
  suspensionDampCompress: number; // N per m/s
  suspensionDampRebound: number; // N per m/s
  maxSuspensionForce: number; // N, per wheel

  /** Anti-roll bar rate, N per metre of left/right compression difference. */
  antiRoll: number;

  /** Peak tractive force at low speed, N. */
  maxDriveForce: number;
  /** Engine power ceiling, W. Above maxDriveForce/P the force tapers as P/v. */
  enginePower: number;
  /** Total braking force at full brake, N, split front/rear. */
  maxBrakeForce: number;
  brakeBiasFront: number; // 0..1
  /** Force applied when coasting with no throttle, N. */
  engineBraking: number;

  maxSteerAngle: number; // radians at a standstill
  minSteerAngle: number; // radians at steerFalloffSpeed and above
  steerFalloffSpeed: number; // m/s
  /** Radians per second the steering angle may change. */
  steerRate: number;

  /** Pacejka-ish lateral stiffness and shape. */
  tireStiffness: number;
  tireShape: number;
  /** Grip multiplier on the rear axle while the handbrake is pulled. */
  handbrakeGripLoss: number;
  handbrakeForce: number;

  /** Aerodynamic drag coefficient: F = dragArea * v^2. */
  dragArea: number;
  /** Downforce coefficient: F = downforce * v^2, applied along -up. */
  downforce: number;
  rollingResistance: number;

  /** Torque gain used to level the car while airborne. */
  airRighting: number;
}

export const DEFAULT_TUNING: CarTuning = {
  suspensionRest: 0.32,
  suspensionStiffness: 46000,
  suspensionDampCompress: 3400,
  suspensionDampRebound: 4600,
  maxSuspensionForce: 26000,

  antiRoll: 14000,

  maxDriveForce: 8200,
  enginePower: 295000,
  maxBrakeForce: 15000,
  brakeBiasFront: 0.62,
  engineBraking: 900,

  maxSteerAngle: 0.56, // ~32 degrees
  minSteerAngle: 0.12, // ~7 degrees
  steerFalloffSpeed: 62,
  steerRate: 4.2,

  tireStiffness: 9.0,
  tireShape: 1.55,
  handbrakeGripLoss: 0.32,
  handbrakeForce: 9000,

  dragArea: 0.88,
  downforce: 1.9,
  rollingResistance: 0.014,

  airRighting: 2.4,
};

// ---------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------

export interface WheelSpec {
  /** Suspension attachment point in chassis-local coordinates. */
  local: V3;
  steered: boolean;
  /** Share of total drive force sent to this wheel. Shares sum to 1. */
  driveShare: number;
  front: boolean;
  /** -1 for the left of the car, +1 for the right. */
  side: -1 | 1;
}

/**
 * Front is -Z: cars face -Z per HANDOFF.md §5.1.
 *
 * All four wheels are driven, biased 40/60 front to rear. Rear-wheel drive was
 * tried first and is traction-limited off the line to about 6.2 m/s^2 - the
 * rear axle simply cannot put 8 kN down. More to the point, ten people who have
 * never played this are going to mash the throttle at the same green light, and
 * a car that snaps into oversteer on corner exit turns the grid into a
 * demolition derby. Four driven wheels is the forgiving choice.
 */
export function defaultWheels(): WheelSpec[] {
  const hx = CAR.track / 2;
  const hz = CAR.wheelbase / 2;
  const y = 0.1;
  return [
    { local: { x: -hx, y, z: -hz }, steered: true, driveShare: 0.2, front: true, side: -1 },
    { local: { x: hx, y, z: -hz }, steered: true, driveShare: 0.2, front: true, side: 1 },
    { local: { x: -hx, y, z: hz }, steered: false, driveShare: 0.3, front: false, side: -1 },
    { local: { x: hx, y, z: hz }, steered: false, driveShare: 0.3, front: false, side: 1 },
  ];
}

/** Per-wheel output of a step. Purely derived - never fed back into the sim. */
export interface WheelReadout {
  contact: boolean;
  /** Suspension compression, metres. */
  compression: number;
  /** World position of the wheel centre, for rendering. */
  center: V3;
  /** Contact normal, or up when airborne. */
  normal: V3;
  /** Slip angle magnitude, radians. */
  slip: number;
  /** Longitudinal slip proxy: 1 when the tyre is saturated. */
  saturation: number;
  surface: SurfaceKind;
  steerAngle: number;
}

// ---------------------------------------------------------------------------
// Serialisable state
// ---------------------------------------------------------------------------

/**
 * Everything needed to reproduce a car bit-for-bit. This is what prediction
 * saves and restores; if a field is missing here, reconciliation will drift.
 */
export interface CarState {
  p: V3;
  q: Q4;
  v: V3;
  av: V3;
  steer: number;
}

// ---------------------------------------------------------------------------
// Context the car needs from the world
// ---------------------------------------------------------------------------

export interface CarContext {
  world: World;
  /** Collider handle -> surface kind, filled in when the track is built. */
  surfaceOf: (handle: number) => SurfaceKind;
  /** Friction and drag per surface, straight out of the track JSON. */
  surfaceProps: Record<SurfaceKind, { friction: number; drag: number }>;
}

const RAY_GROUPS = interactionGroups(GROUP.CAR, GROUP.TRACK | GROUP.BARRIER);

// ---------------------------------------------------------------------------

export class Car {
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly wheels: WheelSpec[];
  readonly tuning: CarTuning;
  readonly readouts: WheelReadout[];

  /** Smoothed steering angle. Part of the reconciled state. */
  private steerAngle = 0;

  /** Surface under the car, from the wheel that carries the most load. */
  surface: SurfaceKind = 'asphalt';

  /** Fraction of the lap the wheels have been off the asphalt, for penalties. */
  offTrackTicks = 0;

  constructor(world: World, tuning: CarTuning = DEFAULT_TUNING, wheels = defaultWheels()) {
    this.tuning = tuning;
    this.wheels = wheels;

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setLinearDamping(0.02)
      .setAngularDamping(0.6)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(desc);

    const half = { x: CAR.width / 2, y: 0.34, z: CAR.length / 2 };
    const cd = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setFriction(0.22) // low: sliding along a barrier should not spin the car
      .setRestitution(0.12)
      .setDensity(0) // mass comes from setAdditionalMassProperties below
      .setCollisionGroups(interactionGroups(GROUP.CAR, GROUP.CAR | GROUP.BARRIER | GROUP.TRACK))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.collider = world.createCollider(cd, this.body);

    // Centre of mass below the geometric centre, and yaw inertia below what a
    // uniform box would give, so the car rotates willingly but does not roll.
    this.body.setAdditionalMassProperties(
      CAR.mass,
      { x: 0, y: -0.16, z: 0 },
      { x: 1250, y: 900, z: 420 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    this.readouts = wheels.map(() => ({
      contact: false,
      compression: 0,
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      slip: 0,
      saturation: 0,
      surface: 'asphalt' as SurfaceKind,
      steerAngle: 0,
    }));
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  readState(): CarState {
    const p = this.body.translation();
    const q = this.body.rotation();
    const v = this.body.linvel();
    const av = this.body.angvel();
    return {
      p: { x: p.x, y: p.y, z: p.z },
      q: { x: q.x, y: q.y, z: q.z, w: q.w },
      v: { x: v.x, y: v.y, z: v.z },
      av: { x: av.x, y: av.y, z: av.z },
      steer: this.steerAngle,
    };
  }

  writeState(s: CarState): void {
    this.body.setTranslation(s.p, true);
    this.body.setRotation(s.q, true);
    this.body.setLinvel(s.v, true);
    this.body.setAngvel(s.av, true);
    this.steerAngle = s.steer;
  }

  /** Place the car on the grid, or respawn it. Clears all momentum. */
  reset(p: V3, yaw: number): void {
    const h = yaw / 2;
    this.body.setTranslation(p, true);
    this.body.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.offTrackTicks = 0;
  }

  get speed(): number {
    return length(this.body.linvel());
  }

  /** Signed forward speed, m/s. Negative when reversing. */
  get forwardSpeed(): number {
    return dot(this.body.linvel(), this.forward());
  }

  /**
   * Steering lock available at a given speed, radians. Exposed so a controller
   * can convert a geometric steering angle into the -1..1 input the car takes,
   * instead of guessing a gain.
   */
  maxSteerAngle(speed: number): number {
    const t = this.tuning;
    const f = clamp(speed / t.steerFalloffSpeed, 0, 1);
    return t.maxSteerAngle + (t.minSteerAngle - t.maxSteerAngle) * f;
  }

  /** DrivableView: the AI driver reads a car through these. */
  position(): V3 {
    const p = this.body.translation();
    return { x: p.x, y: p.y, z: p.z };
  }

  rotation(): Q4 {
    const q = this.body.rotation();
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  }

  linvel(): V3 {
    const v = this.body.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }

  angvel(): V3 {
    const a = this.body.angvel();
    return { x: a.x, y: a.y, z: a.z };
  }

  forward(): V3 {
    return rotate(this.body.rotation(), { x: 0, y: 0, z: -1 });
  }

  up(): V3 {
    return rotate(this.body.rotation(), { x: 0, y: 1, z: 0 });
  }

  right(): V3 {
    return rotate(this.body.rotation(), { x: 1, y: 0, z: 0 });
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * Accumulate one step of forces. Call once per fixed timestep, before
   * `world.step()`. Rapier clears accumulated forces after each step, so this
   * must not be called twice for the same step.
   */
  step(input: CarInput, dt: number, ctx: CarContext): void {
    const t = this.tuning;
    const body = this.body;

    // Rapier forces are persistent: addForce keeps applying every step until
    // reset, it is not a per-step accumulator. Without this the suspension
    // force compounds and the car is launched off the map within two seconds.
    body.resetForces(false);
    body.resetTorques(false);

    const rot = body.rotation();
    const pos = body.translation();
    const linvel = body.linvel();
    const angvel = body.angvel();
    const com = body.worldCom();

    const up = rotate(rot, { x: 0, y: 1, z: 0 });
    const fwd = rotate(rot, { x: 0, y: 0, z: -1 });

    const speed = length(linvel);
    const fwdSpeed = dot(linvel, fwd);

    // --- Steering: speed-sensitive, and rate-limited so a keyboard tap does
    // --- not snap the wheels to full lock in one tick.
    const lockFrac = clamp(speed / t.steerFalloffSpeed, 0, 1);
    const maxSteer = t.maxSteerAngle + (t.minSteerAngle - t.maxSteerAngle) * lockFrac;
    // STEER SIGN: input.steer is positive to the RIGHT, matching a steering
    // wheel turned clockwise. `steerAngle` below is the physical wheel angle,
    // which is positive to the LEFT because rotating the chassis forward vector
    // about +Y by a positive angle takes -Z toward -X. The negation here is the
    // single place those two conventions meet - do not add a second one.
    const targetSteer = -input.steer * maxSteer;
    const maxDelta = t.steerRate * dt;
    this.steerAngle += clamp(targetSteer - this.steerAngle, -maxDelta, maxDelta);

    // --- Suspension pass. Compression is needed for the anti-roll bar before
    // --- any tyre force is applied, so the wheels are raycast first.
    const n = this.wheels.length;
    const contacts: (WheelContact | null)[] = new Array(n).fill(null);
    let groundedCount = 0;
    let bestLoad = -1;

    for (let i = 0; i < n; i++) {
      const c = this.castWheel(i, pos, rot, up, ctx);
      contacts[i] = c;
      const r = this.readouts[i]!;
      if (c) {
        groundedCount++;
        r.contact = true;
        r.compression = c.compression;
        r.center = c.wheelCenter;
        r.normal = c.normal;
        r.surface = c.surface;
      } else {
        r.contact = false;
        r.compression = 0;
        r.normal = up;
        r.center = add(add(pos, rotate(rot, this.wheels[i]!.local)), scale(up, -t.suspensionRest));
        r.slip = 0;
        r.saturation = 0;
      }
      r.steerAngle = this.wheels[i]!.steered ? this.steerAngle : 0;
    }

    // --- Anti-roll bar, per axle -------------------------------------------
    const arb = new Float64Array(n);
    for (const front of [true, false]) {
      const li = this.wheels.findIndex((w) => w.front === front && w.side === -1);
      const ri = this.wheels.findIndex((w) => w.front === front && w.side === 1);
      if (li < 0 || ri < 0) continue;
      const cl = contacts[li]?.compression ?? 0;
      const cr = contacts[ri]?.compression ?? 0;
      const f = clamp((cl - cr) * t.antiRoll, -t.maxSuspensionForce * 0.5, t.maxSuspensionForce * 0.5);
      arb[li] = -f;
      arb[ri] = f;
    }

    // --- Longitudinal demand, shared across the driven wheels ---------------
    const powerForce = t.enginePower / Math.max(6, Math.abs(fwdSpeed));
    const driveForce = input.throttle * Math.min(t.maxDriveForce, powerForce);

    // Reverse: below walking pace with brake held and no throttle, brake
    // becomes reverse gear. Without this a car that spins is stuck forever.
    const reversing = input.brake > 0.1 && input.throttle < 0.05 && fwdSpeed < 1.5;
    const reverseForce = reversing ? -input.brake * t.maxDriveForce * 0.4 : 0;

    for (let i = 0; i < n; i++) {
      const c = contacts[i];
      const w = this.wheels[i]!;
      const r = this.readouts[i]!;
      if (!c) continue;

      const props = ctx.surfaceProps[c.surface] ?? { friction: 1, drag: 0 };

      // Suspension: spring plus a damper that uses the contact-point velocity
      // rather than d(compression)/dt, so no per-wheel history is carried.
      const attachVel = pointVelocity(linvel, angvel, c.attach, com);
      const normalVel = dot(attachVel, c.normal);
      const damp = normalVel < 0 ? t.suspensionDampCompress : t.suspensionDampRebound;
      let fn = c.compression * t.suspensionStiffness - normalVel * damp + arb[i]!;
      fn = clamp(fn, 0, t.maxSuspensionForce);

      body.addForceAtPoint(scale(c.normal, fn), c.contactPoint, true);

      // Tyre basis, projected into the contact plane.
      let wheelFwd = fwd;
      if (w.steered && Math.abs(this.steerAngle) > 1e-5) {
        wheelFwd = rotate(quatMul(quatFromAxis(up, this.steerAngle), rot), { x: 0, y: 0, z: -1 });
      }
      const fwdDir = normalize(sub(wheelFwd, scale(c.normal, dot(wheelFwd, c.normal))));
      const sideDir = cross(c.normal, fwdDir);

      const cv = pointVelocity(linvel, angvel, c.contactPoint, com);
      const vLong = dot(cv, fwdDir);
      const vLat = dot(cv, sideDir);

      const handbrakeRear = input.handbrake && !w.front;
      const gripMul = handbrakeRear ? t.handbrakeGripLoss : 1;
      const grip = fn * props.friction * gripMul;

      // Lateral: a Pacejka-shaped curve on slip angle. The +1.2 keeps the slip
      // angle finite at a standstill instead of snapping to +/- pi/2.
      const slip = Math.atan2(vLat, Math.abs(vLong) + 1.2);
      const latMag = Math.sin(t.tireShape * Math.atan(t.tireStiffness * slip));
      let fLat = -grip * latMag;

      // Longitudinal.
      let fLong = 0;
      fLong += (driveForce + reverseForce) * w.driveShare;
      if (!reversing && input.brake > 0.01) {
        const bias = w.front ? t.brakeBiasFront : 1 - t.brakeBiasFront;
        const bf = input.brake * t.maxBrakeForce * bias * 0.5;
        fLong -= Math.sign(vLong) * bf;
      }
      if (handbrakeRear) fLong -= Math.sign(vLong) * t.handbrakeForce * 0.5;
      if (input.throttle < 0.02 && input.brake < 0.02 && !input.handbrake) {
        fLong -= Math.sign(vLong) * t.engineBraking * 0.25;
      }
      // Rolling resistance and off-surface drag.
      fLong -= Math.sign(vLong) * fn * (t.rollingResistance + props.drag);

      // Friction circle. Lateral wins ties: a car that will not turn feels
      // broken, a car that will not accelerate merely feels slow.
      const mag = Math.hypot(fLong, fLat);
      if (mag > grip && mag > 1e-6) {
        const k = grip / mag;
        fLong *= k;
        fLat *= k;
      }

      const force = add(scale(fwdDir, fLong), scale(sideDir, fLat));
      body.addForceAtPoint(force, c.contactPoint, true);

      r.slip = Math.abs(slip);
      r.saturation = grip > 1e-6 ? Math.min(1, mag / grip) : 0;

      if (fn > bestLoad) {
        bestLoad = fn;
        this.surface = c.surface;
      }
    }

    // --- Aerodynamics -------------------------------------------------------
    if (speed > 0.5) {
      const dragMag = t.dragArea * speed * speed;
      body.addForce(scale(normalize(linvel), -dragMag), true);
    }
    if (groundedCount > 0) {
      const df = t.downforce * speed * speed;
      body.addForce(scale(up, -df), true);
    }

    // --- Airborne righting --------------------------------------------------
    // Without this a car that gets launched tumbles until it lands on its roof,
    // which is the single ugliest thing that can happen on camera.
    if (groundedCount === 0) {
      const tilt = cross(up, { x: 0, y: 1, z: 0 });
      const gain = t.airRighting * CAR.mass;
      body.addTorque(
        {
          x: tilt.x * gain - angvel.x * gain * 0.28,
          y: -angvel.y * gain * 0.06,
          z: tilt.z * gain - angvel.z * gain * 0.28,
        },
        true,
      );
    }

    // Track how long the car has been off the racing surface.
    if (this.surface === 'grass' || this.surface === 'gravel') this.offTrackTicks++;
    else this.offTrackTicks = 0;
  }

  /** True when the car is resting on its roof or side. */
  isInverted(): boolean {
    return this.up().y < 0.2;
  }

  private castWheel(i: number, pos: V3, rot: Q4, up: V3, ctx: CarContext): WheelContact | null {
    const w = this.wheels[i]!;
    const t = this.tuning;
    const attach = add(pos, rotate(rot, w.local));
    const dir = scale(up, -1);
    const maxToi = t.suspensionRest + CAR.wheelRadius;

    const ray = new RAPIER.Ray(attach, dir);
    const hit = ctx.world.castRayAndGetNormal(
      ray,
      maxToi,
      true,
      undefined,
      RAY_GROUPS,
      undefined,
      this.body,
    );
    if (!hit) return null;

    const toi = hit.timeOfImpact;
    const contactPoint = add(attach, scale(dir, toi));

    let normal = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
    // Trimesh normals can face either way depending on winding; force it upward.
    if (dot(normal, up) < 0) normal = scale(normal, -1);
    normal = normalize(normal);
    if (normal.y < 0.15) return null; // a wall, not a road surface

    const suspensionLength = Math.max(0, toi - CAR.wheelRadius);
    const compression = clamp(t.suspensionRest - suspensionLength, 0, t.suspensionRest);

    return {
      attach,
      contactPoint,
      normal,
      compression,
      wheelCenter: add(attach, scale(dir, suspensionLength)),
      surface: ctx.surfaceOf(hit.collider.handle),
    };
  }
}

interface WheelContact {
  attach: V3;
  contactPoint: V3;
  normal: V3;
  compression: number;
  wheelCenter: V3;
  surface: SurfaceKind;
}

/** Velocity of a world-space point on a rigid body. */
function pointVelocity(linvel: V3, angvel: V3, point: V3, com: V3): V3 {
  return add(linvel, cross(angvel, sub(point, com)));
}
