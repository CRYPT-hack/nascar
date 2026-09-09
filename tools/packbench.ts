/**
 * Simulation cost with cars in a pack.  `npx tsx tools/packbench.ts`
 *
 * Every timing in this project so far was taken with the cars spread around the
 * circuit, and the player's complaint is the opposite case: it hitches "when
 * cars come close to each other and when they collide". Contact solving scales
 * with the number of contact pairs, so a spread-out benchmark understates the
 * packed case by however many pairs are touching — which at ten cars nose to
 * tail is a lot.
 *
 * This measures the same ten cars twice, spread and packed, and sweeps the
 * solver's internal PGS iteration count, because that setting multiplies
 * per-contact work and was raised from 1 to 4 to settle car-to-car impacts.
 *
 * The number that matters is p99, not the mean: a hitch is a single frame that
 * blew the budget, and a mean hides it.
 */

import RAPIER from '@dimforge/rapier3d-compat';

import { CAR, FIXED_DT, GRAVITY, GROUP, interactionGroups } from '../shared/constants';
import type { CarInput } from '../shared/protocol';
import { Car, type CarContext } from '../vehicle/car';
import { initPhysics, tuneSolver } from '../vehicle/world';

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

function world(pgs: number): { world: RAPIER.World; ctx: CarContext } {
  const w = new RAPIER.World(GRAVITY);
  tuneSolver(w);
  // Override only the knob under test, so everything else matches the game.
  (w.integrationParameters as unknown as Record<string, number>)['numInternalPgsIterations'] = pgs;
  const ground = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  w.createCollider(
    RAPIER.ColliderDesc.cuboid(20000, 1, 20000)
      .setTranslation(0, -1, 0)
      .setFriction(1)
      .setRestitution(0)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setCollisionGroups(interactionGroups(GROUP.TRACK, GROUP.CAR | GROUP.BARRIER)),
    ground,
  );
  return { world: w, ctx: { world: w, surfaceOf: () => 'asphalt', surfaceProps: SURFACES } };
}

interface Layout {
  readonly name: string;
  /** Grid offsets, metres, relative to the pack centre. */
  at(i: number): { x: number; z: number };
}

const SPREAD: Layout = {
  name: 'spread (60 m apart)',
  at: (i) => ({ x: 0, z: i * 60 }),
};

/** Two columns, half a car-length apart: what a restart or a slow corner looks like. */
const PACK: Layout = {
  name: 'packed (2 abreast, 0.6 m gaps)',
  at: (i) => ({
    x: (i % 2) * (CAR.width + 0.6) - (CAR.width + 0.6) / 2,
    z: Math.floor(i / 2) * (CAR.length + 0.6),
  }),
};

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

interface Row {
  p50: number;
  p99: number;
  max: number;
  contacts: number;
}

function run(pgs: number, layout: Layout, squeeze: boolean, ticks = 600): Row {
  const { world: w, ctx } = world(pgs);
  const cars: Car[] = [];
  for (let i = 0; i < 10; i++) {
    const { x, z } = layout.at(i);
    const c = new Car(w);
    c.reset({ x, y: 0.6, z }, 0);
    cars.push(c);
  }

  const tick = (input: CarInput[]): void => {
    for (let k = 0; k < cars.length; k++) cars[k]!.step(input[k] ?? IN(), FIXED_DT, ctx);
    w.step();
    for (const c of cars) c.postStep();
  };

  for (let i = 0; i < 90; i++) tick([]); // settle

  // Squeeze: everyone on the throttle, the front of the pack braking, so the
  // whole field piles into itself and stays in contact for the measurement.
  const inputs = cars.map((_, i) =>
    squeeze ? (i < 2 ? IN({ brake: 1 }) : IN({ throttle: 1 })) : IN({ throttle: 0.4 }),
  );

  const samples: number[] = [];
  let contacts = 0;
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    tick(inputs);
    samples.push(performance.now() - t0);
    if (i % 30 === 0) {
      // Count touching pairs, so the cost can be read against how packed it is.
      let n = 0;
      for (let a = 0; a < cars.length; a++) {
        for (let b = a + 1; b < cars.length; b++) {
          const pa = cars[a]!.body.translation();
          const pb = cars[b]!.body.translation();
          if (Math.hypot(pa.x - pb.x, pa.z - pb.z) < CAR.length + 0.4) n++;
        }
      }
      contacts = Math.max(contacts, n);
    }
  }
  w.free();

  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    contacts,
  };
}

async function main(): Promise<void> {
  await initPhysics();

  console.log('ten cars, one world.step() plus per-car step and postStep');
  console.log('budget is 16.67 ms; p99 is what a hitch looks like\n');
  console.log('  pgs  layout                            p50      p99      max      near pairs');

  for (const pgs of [1, 2, 4]) {
    for (const [layout, squeeze] of [
      [SPREAD, false],
      [PACK, false],
      [PACK, true],
    ] as const) {
      const r = run(pgs, layout, squeeze);
      const label = `${layout.name}${squeeze ? ' + piling in' : ''}`;
      console.log(
        `  ${String(pgs).padEnd(4)} ${label.padEnd(34)} ` +
          `${r.p50.toFixed(2).padStart(6)}   ${r.p99.toFixed(2).padStart(6)}   ` +
          `${r.max.toFixed(2).padStart(6)}   ${String(r.contacts).padStart(3)}`,
      );
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
