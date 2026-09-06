/**
 * Headless vehicle test.  `npx tsx tools/drivetest.ts [track]`
 *
 * Checks the car is drivable before anything is built on top of it. Every
 * number printed is measured, not asserted - read them.
 *
 * Straight-line, drop and contact tests run on a flat plane rather than on the
 * track. Run them on the oval and the car drives off the outside of Turn 1
 * partway through, and the figure you get back is measuring the barrier rather
 * than the thing you meant to test.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import RAPIER from '@dimforge/rapier3d-compat';

import { FIXED_DT, GRAVITY, GROUP, interactionGroups } from '../shared/constants';
import type { CarInput } from '../shared/protocol';
import type { TrackData } from '../shared/track-schema';
import { Car, type CarContext } from '../vehicle/car';
import { createRaceWorld, initPhysics, type RaceWorld } from '../vehicle/world';

const here = dirname(fileURLToPath(import.meta.url));

function loadTrack(name: string): TrackData {
  return JSON.parse(readFileSync(resolve(here, `../public/track/${name}.json`), 'utf8')) as TrackData;
}

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

const kmh = (ms: number) => ms * 3.6;
const f2 = (n: number) => n.toFixed(2);
const ok = (pass: boolean) => (pass ? 'ok' : 'FAIL');

/** A 40 km flat plane, large enough that 30 s at top speed stays on it. */
function flatWorld(): { world: RAPIER.World; ctx: CarContext } {
  const world = new RAPIER.World(GRAVITY);
  world.timestep = FIXED_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(20000, 1, 20000)
      .setTranslation(0, -1, 0)
      .setFriction(1)
      .setCollisionGroups(interactionGroups(GROUP.TRACK, GROUP.CAR | GROUP.BARRIER)),
    ground,
  );
  return { world, ctx: { world, surfaceOf: () => 'asphalt', surfaceProps: SURFACES } };
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

  step(inputs: CarInput[], ticks: number, cb?: (i: number) => void): void {
    for (let i = 0; i < ticks; i++) {
      for (let k = 0; k < this.cars.length; k++) {
        this.cars[k]!.step(inputs[k] ?? IN(), FIXED_DT, this.ctx);
      }
      this.world.step();
      cb?.(i);
    }
  }

  free(): void {
    this.world.free();
  }
}

// ---------------------------------------------------------------------------

function straightLine(): void {
  const rig = new Rig();
  const car = rig.add(0, 0);

  rig.step([IN()], 90);
  let t100 = -1;
  let t200 = -1;
  let peak = 0;
  rig.step([IN({ throttle: 1 })], 60 * 30, (i) => {
    const v = kmh(car.forwardSpeed);
    peak = Math.max(peak, v);
    if (t100 < 0 && v >= 100) t100 = i * FIXED_DT;
    if (t200 < 0 && v >= 200) t200 = i * FIXED_DT;
  });

  console.log('\nstraight line');
  console.log(`  0-100 km/h     ${t100 < 0 ? 'never' : `${f2(t100)} s`}`);
  console.log(`  0-200 km/h     ${t200 < 0 ? 'never' : `${f2(t200)} s`}`);
  console.log(`  top speed      ${f2(peak)} km/h`);

  // Braking distance is measured along the car's own path and frozen the moment
  // it is slow enough. Past that point reverse gear engages and a naive
  // displacement reading starts counting backwards.
  const v0 = car.forwardSpeed;
  const p0 = car.body.translation();
  let stopDist = -1;
  rig.step([IN({ brake: 1 })], 60 * 12, () => {
    if (stopDist < 0 && car.forwardSpeed < 0.5) {
      const p = car.body.translation();
      stopDist = Math.hypot(p.x - p0.x, p.z - p0.z);
    }
  });
  console.log('\nbraking');
  console.log(`  from           ${f2(kmh(v0))} km/h`);
  console.log(`  distance       ${stopDist < 0 ? 'never stopped' : `${f2(stopDist)} m`}`);
  console.log(
    `  average decel  ${stopDist > 0 ? `${f2((v0 * v0) / (2 * stopDist) / 9.81)} g` : 'n/a'}`,
  );
  rig.free();
}

function skidpad(): void {
  const rig = new Rig();
  const car = rig.add(0, 0);
  rig.step([IN()], 60);
  rig.step([IN({ throttle: 1 })], 60 * 8);

  // Steady state only. Yaw rate spikes on turn-in, so a peak reading reports a
  // cornering force the car cannot actually sustain.
  let sumG = 0;
  let sumR = 0;
  let n = 0;
  rig.step([IN({ throttle: 0.45, steer: 0.5 })], 60 * 10, (i) => {
    if (i < 60 * 7) return;
    const yaw = Math.abs(car.body.angvel().y);
    const v = Math.abs(car.forwardSpeed);
    if (yaw > 0.02) {
      sumG += (yaw * v) / 9.81;
      sumR += v / yaw;
      n++;
    }
  });
  console.log('\nskidpad (half lock, steady state)');
  console.log(`  sustained      ${n ? f2(sumG / n) : 'n/a'} g`);
  console.log(`  radius         ${n ? f2(sumR / n) : 'n/a'} m at ${f2(kmh(Math.abs(car.forwardSpeed)))} km/h`);
  console.log(`  did not spin   ${ok(car.forwardSpeed > 2)}`);
  rig.free();
}

function dropTest(): void {
  const rig = new Rig();
  const car = rig.add(0, 0);
  car.reset({ x: 0, y: 6, z: 0 }, 0);
  car.body.setLinvel({ x: 0, y: 0, z: -35 }, true);
  car.body.setAngvel({ x: 0.6, y: 1.2, z: 0.4 }, true);

  let worstUp = 1;
  let deepest = 0;
  rig.step([IN({ throttle: 0.3 })], 60 * 8, () => {
    worstUp = Math.min(worstUp, car.up().y);
    deepest = Math.min(deepest, car.body.translation().y);
  });
  console.log('\ndrop from 6 m at 126 km/h with spin');
  console.log(`  worst attitude up.y = ${f2(worstUp)}`);
  console.log(`  recovered      ${ok(car.up().y > 0.9)}  (up.y=${f2(car.up().y)})`);
  console.log(`  lowest y       ${f2(deepest)} m`);
  console.log(`  did not sink   ${ok(deepest > -0.5)}`);
  rig.free();
}

/**
 * Gate check 4: two cars touching at 100 km/h.
 *
 * Steering them together does not work - speed-sensitive steering means a
 * quarter-lock input at 150 km/h barely moves the car, and an earlier version
 * of this test reported a pass while the two cars stayed 4.4 m apart and never
 * touched at all. The closing velocity is imposed directly so contact is
 * guaranteed, and the test asserts the gap actually closed.
 */
function contactTest(closeRate: number, label: string): void {
  const rig = new Rig();
  const a = rig.add(-1.6, 0);
  const b = rig.add(1.6, 0);

  rig.step([IN(), IN()], 60);
  // Accelerate to about 100 km/h.
  let ticks = 0;
  while (a.forwardSpeed < 27.8 && ticks < 60 * 20) {
    rig.step([IN({ throttle: 1 }), IN({ throttle: 1 })], 1);
    ticks++;
  }
  const closing = a.forwardSpeed;

  // Impose lateral closing velocity: a moves right, b moves left.
  const va = a.body.linvel();
  const vb = b.body.linvel();
  a.body.setLinvel({ x: va.x + closeRate, y: va.y, z: va.z }, true);
  b.body.setLinvel({ x: vb.x - closeRate, y: vb.y, z: vb.z }, true);

  let worstA = 1;
  let worstB = 1;
  let maxAir = 0;
  let minGap = Infinity;
  let maxYaw = 0;
  rig.step([IN({ throttle: 0.7 }), IN({ throttle: 0.7 })], 60 * 5, () => {
    worstA = Math.min(worstA, a.up().y);
    worstB = Math.min(worstB, b.up().y);
    maxAir = Math.max(maxAir, a.body.translation().y - 0.53, b.body.translation().y - 0.53);
    maxYaw = Math.max(maxYaw, Math.abs(a.body.angvel().y), Math.abs(b.body.angvel().y));
    const pa = a.body.translation();
    const pb = b.body.translation();
    minGap = Math.min(minGap, Math.hypot(pa.x - pb.x, pa.z - pb.z));
  });

  // Cars are 1.9 m wide, so centres closer than 1.95 m means they touched.
  const touched = minGap < 1.95;
  console.log(`\ncontact: ${label}`);
  console.log(`  speed           ${f2(kmh(closing))} km/h, closing at ${f2(closeRate)} m/s`);
  console.log(`  closest gap     ${f2(minGap)} m   ${touched ? 'touched' : 'NEVER TOUCHED - test is vacuous'}`);
  console.log(`  worst up.y      A ${f2(worstA)}  B ${f2(worstB)}`);
  console.log(`  max air         ${f2(maxAir)} m`);
  console.log(`  peak yaw rate   ${f2(maxYaw)} rad/s`);
  console.log(`  they did touch  ${ok(touched)}`);
  console.log(`  neither flipped ${ok(worstA > 0.2 && worstB > 0.2)}`);
  console.log(`  not launched    ${ok(maxAir < 1.0)}`);
  console.log(`  both still run  ${ok(a.speed > 1 && b.speed > 1)}`);
  rig.free();
}

/** The car must sit correctly on the real track, not just on a plane. */
function trackSettle(rw: RaceWorld): void {
  const car = new Car(rw.world);
  const s = rw.track.spawnGrid[0]!;
  car.reset({ x: s.p[0], y: s.p[1] + 0.4, z: s.p[2] }, s.rotY);
  for (let i = 0; i < 180; i++) {
    car.step(IN(), FIXED_DT, rw.ctx);
    rw.world.step();
  }
  const p = car.body.translation();
  const loc = rw.query.locate(p.x, p.y, p.z);
  console.log('\nsettle on the grid');
  console.log(`  ride height    ${f2(p.y - loc.surfaceY)} m above centreline`);
  console.log(`  residual speed ${f2(car.speed)} m/s   ${ok(car.speed < 0.1)}`);
  console.log(`  upright        ${ok(car.up().y > 0.99)}`);
  console.log(`  on track       ${ok(loc.onTrack)}   surface ${car.surface}`);
  console.log(`  lateral offset ${f2(loc.lateral)} m from centreline`);
}

async function main(): Promise<void> {
  const trackName = process.argv[2] ?? 'oval';
  await initPhysics();
  const track = loadTrack(trackName);
  const rw = createRaceWorld(track);

  console.log(`track ${track.name}: ${track.lapLengthMeters} m, ${track.waypoints.length} waypoints`);
  console.log(`collision geometry: ${rw.triangles} triangles`);

  trackSettle(rw);
  straightLine();
  skidpad();
  dropTest();
  contactTest(1.5, 'a light rub');
  contactTest(6.0, 'a hard lunge');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
