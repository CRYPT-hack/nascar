/**
 * Car-to-car collision measurement.  `npx tsx tools/collisiontest.ts`
 *
 * Contact between cars is the thing ten people at a demo will spend the whole
 * race doing, and until now nothing measured it beyond "did anyone end up in
 * the air". This stages the four impacts that actually happen in a race and
 * reports what came out.
 *
 * It runs the server's loop exactly: `step` every car, `world.step()`, then
 * `postStep` every car. `tools/drivetest.ts` omits that last part, so its
 * contact numbers describe a simulation nobody runs.
 *
 * The headline number is **penetration**: how far the two hulls overlapped at
 * the worst moment, by separating-axis on the two oriented boxes. Cars visibly
 * inside one another is the single most broken-looking thing a physics build
 * can do, and it is invisible to a check that only asks whether a car left the
 * ground.
 */

import RAPIER from '@dimforge/rapier3d-compat';

import { CAR, FIXED_DT, GRAVITY, GROUP, interactionGroups } from '../shared/constants';
import type { CarInput } from '../shared/protocol';
import { Car, type CarContext } from '../vehicle/car';
import { initPhysics, tuneSolver } from '../vehicle/world';
import { yawOf } from '../vehicle/math3';

const IN = (o: Partial<CarInput> = {}): CarInput => ({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  ...o,
});

const SURFACES = {
  asphalt: { friction: 1, drag: 0 },
  kerb: { friction: 0.9, drag: 0.02 },
  grass: { friction: 0.4, drag: 0.35 },
  gravel: { friction: 0.25, drag: 0.6 },
};

function flatWorld(): { world: RAPIER.World; ctx: CarContext } {
  const world = new RAPIER.World(GRAVITY);
  // The same settings the game runs, from the same function.
  tuneSolver(world);
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(20000, 1, 20000)
      .setTranslation(0, -1, 0)
      .setFriction(1)
      .setRestitution(0)
      // Matches the track: Min, so the car's car-to-car restitution never
      // makes the road itself springy.
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setCollisionGroups(interactionGroups(GROUP.TRACK, GROUP.CAR | GROUP.BARRIER)),
    ground,
  );
  return { world, ctx: { world, surfaceOf: () => 'asphalt', surfaceProps: SURFACES } };
}

/**
 * Overlap depth of two oriented rectangles in the ground plane, by separating
 * axis. Zero when they are apart; otherwise the smallest push needed to part
 * them, which is what a viewer sees as one car inside another.
 */
function penetration(a: Car, b: Car): number {
  const boxes = [a, b].map((c) => {
    const p = c.body.translation();
    const yaw = yawOf(c.body.rotation());
    return {
      cx: p.x,
      cz: p.z,
      hx: CAR.width / 2,
      hz: CAR.length / 2,
      // Local axes in the ground plane.
      ux: { x: Math.cos(yaw), z: -Math.sin(yaw) },
      uz: { x: Math.sin(yaw), z: Math.cos(yaw) },
    };
  });
  const [A, B] = boxes as [(typeof boxes)[0], (typeof boxes)[0]];
  const dx = B.cx - A.cx;
  const dz = B.cz - A.cz;

  // Signed: positive is overlap depth, negative is clearance. Returning a
  // clearance rather than a flat zero lets a caller notice a near miss, which
  // is the only way a head-on that CCD stops dead registers as contact at all.
  let deepest = Infinity;
  let widestGap = -Infinity;
  for (const axis of [A.ux, A.uz, B.ux, B.uz]) {
    const proj = (box: typeof A) =>
      Math.abs(box.ux.x * axis.x + box.ux.z * axis.z) * box.hx +
      Math.abs(box.uz.x * axis.x + box.uz.z * axis.z) * box.hz;
    const gap = Math.abs(dx * axis.x + dz * axis.z) - (proj(A) + proj(B));
    widestGap = Math.max(widestGap, gap);
    deepest = Math.min(deepest, -gap);
  }
  return widestGap > 0 ? -widestGap : deepest;
}

interface Result {
  penetration: number;
  height: number;
  worstUpY: number;
  yawRate: number;
  speeds: [number, number];
  finalGap: number;
}

class Rig {
  readonly world: RAPIER.World;
  readonly ctx: CarContext;
  readonly cars: Car[] = [];

  constructor() {
    const f = flatWorld();
    this.world = f.world;
    this.ctx = f.ctx;
  }

  add(x: number, z: number, yaw = 0): Car {
    const c = new Car(this.world);
    c.reset({ x, y: 0.6, z }, yaw);
    this.cars.push(c);
    return c;
  }

  /** The server's order: step, solve, clamp. */
  step(inputs: CarInput[], ticks: number, each?: () => void): void {
    for (let i = 0; i < ticks; i++) {
      for (let k = 0; k < this.cars.length; k++) {
        this.cars[k]!.step(inputs[k] ?? IN(), FIXED_DT, this.ctx);
      }
      this.world.step();
      for (const c of this.cars) c.postStep();
      each?.();
    }
  }

  free(): void {
    this.world.free();
  }
}

/** Let the suspension settle so an impact is not measured against a bouncing car. */
function settle(rig: Rig): void {
  rig.step([], 90);
}

function measure(rig: Rig, ticks: number, inputs: CarInput[] = []): Result {
  const [a, b] = rig.cars as [Car, Car];
  const rest = a.body.translation().y;
  let pen = 0;
  let height = 0;
  let worstUpY = 1;
  let yawRate = 0;

  // Peak speed after first contact, not speed at the end: three seconds later
  // the tyres have scrubbed a sideways slide back to nothing, which made a
  // 126 km/h T-bone read as if it had shoved the struck car by 0.1 km/h.
  let touched = false;
  const peakAfter: [number, number] = [0, 0];

  rig.step(inputs, ticks, () => {
    const p = penetration(a, b);
    pen = Math.max(pen, p);
    // Within 5 cm counts: a head-on that CCD arrests never actually overlaps.
    if (p > -0.05) touched = true;
    if (touched) {
      peakAfter[0] = Math.max(peakAfter[0], groundSpeed(a));
      peakAfter[1] = Math.max(peakAfter[1], groundSpeed(b));
    }
    for (const c of rig.cars) {
      height = Math.max(height, c.body.translation().y - rest);
      worstUpY = Math.min(worstUpY, c.up().y);
      yawRate = Math.max(yawRate, Math.abs(c.body.angvel().y));
    }
  });

  return {
    penetration: pen,
    height,
    worstUpY,
    yawRate: (yawRate * 180) / Math.PI,
    speeds: peakAfter,
    finalGap: -penetration(a, b),
  };
}

function report(label: string, r: Result): void {
  console.log(`\n${label}`);
  console.log(`  peak overlap        ${r.penetration.toFixed(3)} m`);
  console.log(`  greatest height     ${r.height.toFixed(3)} m`);
  console.log(`  worst attitude      up.y ${r.worstUpY.toFixed(3)}`);
  console.log(`  peak yaw rate       ${r.yawRate.toFixed(0)} deg/s`);
  console.log(
    `  peak speed on hit   ${(r.speeds[0] * 3.6).toFixed(1)} / ${(r.speeds[1] * 3.6).toFixed(1)} km/h`,
  );
}

/** Speed over the ground, whatever direction the car happens to be facing. */
function groundSpeed(c: Car): number {
  const v = c.body.linvel();
  return Math.hypot(v.x, v.z);
}

/** Drive one body at a chosen speed along its own nose. */
function launch(c: Car, speed: number): void {
  const f = c.forward();
  c.body.setLinvel({ x: f.x * speed, y: 0, z: f.z * speed }, true);
}

async function main(): Promise<void> {
  await initPhysics();

  // -- rear-end: the commonest contact in a pack ----------------------------
  {
    const rig = new Rig();
    const a = rig.add(0, 8); // behind, facing -z
    const b = rig.add(0, 0);
    settle(rig);
    launch(a, 40);
    report('rear-end at 144 km/h into a stationary car', measure(rig, 180));
    rig.free();
  }

  // -- side swipe: wheel-to-wheel, the one that decides a race --------------
  {
    const rig = new Rig();
    const a = rig.add(-2.4, 0);
    const b = rig.add(0, 0);
    settle(rig);
    launch(a, 45);
    launch(b, 45);
    // Steer the outside car into its neighbour.
    report(
      'side swipe, both at 162 km/h, one steering in',
      measure(rig, 180, [IN({ throttle: 1, steer: 0.25 }), IN({ throttle: 1 })]),
    );
    rig.free();
  }

  // -- T-bone: a spun car collected side-on --------------------------------
  {
    const rig = new Rig();
    const a = rig.add(0, 7);
    const b = rig.add(0, 0, Math.PI / 2); // across the road
    settle(rig);
    launch(a, 35);
    report('T-bone at 126 km/h into a car lying across the road', measure(rig, 180));
    rig.free();
  }

  // -- head-on: the worst case the barrier lets happen ----------------------
  {
    const rig = new Rig();
    const a = rig.add(0, 12);
    const b = rig.add(0, 0, Math.PI);
    settle(rig);
    launch(a, 30);
    launch(b, 30);
    report('head-on, 108 km/h each', measure(rig, 180));
    rig.free();
  }

  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
