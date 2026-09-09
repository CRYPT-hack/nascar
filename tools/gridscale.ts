/**
 * How simulation cost grows with grid size.  `npx tsx tools/gridscale.ts [maxCars]`
 *
 * Answers one question: how many cars can the server actually race?
 *
 * `cpubench.ts` measures one fixed ten-car workload so a gate result can be
 * checked against the machine it was taken on. This measures the *shape* of the
 * curve instead, which is the thing that decides a grid size — and a ratio
 * between two counts on the same machine survives the thermal throttling that
 * makes an absolute number worthless.
 *
 * Every count is measured on the same world with the same AI, so the only
 * variable is how many cars are in it. Cars are placed on real grid slots and
 * driven by the real AI, because a field parked on the line generates far fewer
 * contacts than a field racing, and contacts are most of what scales.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXED_DT, MAX_PLAYERS, TICK_HZ } from '../shared/constants';
import type { TrackData } from '../shared/track-schema';
import { AI_SKILLS, AiDriver, buildSpeedProfile } from '../vehicle/ai-driver';
import { Car } from '../vehicle/car';
import { createRaceWorld, initPhysics } from '../vehicle/world';

const here = dirname(fileURLToPath(import.meta.url));
const BUDGET_MS = 1000 / TICK_HZ;

/** Long enough for the field to spread out and start making real contacts. */
const WARMUP_STEPS = 900;
const MEASURE_STEPS = 2400;

async function measure(track: TrackData, count: number): Promise<number> {
  const rw = createRaceWorld(track);
  const profile = buildSpeedProfile(rw.query);

  const cars: { car: Car; ai: AiDriver }[] = [];
  for (let i = 0; i < count; i++) {
    const car = new Car(rw.world);
    const s = track.spawnGrid[i % track.spawnGrid.length]!;
    car.reset({ x: s.p[0], y: s.p[1] + 0.2, z: s.p[2] }, s.rotY);
    cars.push({ car, ai: new AiDriver(rw.query, profile, AI_SKILLS[i % AI_SKILLS.length]!) });
  }

  for (let i = 0; i < WARMUP_STEPS; i++) {
    for (const c of cars) c.car.step(c.ai.update(c.car, FIXED_DT, []), FIXED_DT, rw.ctx);
    rw.world.step();
    for (const c of cars) c.car.postStep();
  }

  const t0 = performance.now();
  for (let i = 0; i < MEASURE_STEPS; i++) {
    for (const c of cars) c.car.step(c.ai.update(c.car, FIXED_DT, []), FIXED_DT, rw.ctx);
    rw.world.step();
    for (const c of cars) c.car.postStep();
  }
  const perStep = (performance.now() - t0) / MEASURE_STEPS;

  rw.world.free();
  return perStep;
}

async function main(): Promise<void> {
  await initPhysics();
  const track = JSON.parse(
    readFileSync(resolve(here, '../public/track/interlagos.json'), 'utf8'),
  ) as TrackData;

  const max = Math.min(Number(process.argv[2] ?? MAX_PLAYERS), track.spawnGrid.length);
  const counts = [1, 5, 10, 15, 20, max].filter((n, i, a) => n <= max && a.indexOf(n) === i);

  console.log(`grid scaling on ${track.name}, budget ${BUDGET_MS.toFixed(2)} ms/step\n`);
  console.log('  cars   ms/step   per car   headroom');

  const rows: { cars: number; perStep: number }[] = [];
  for (const n of counts) {
    const perStep = await measure(track, n);
    rows.push({ cars: n, perStep });
    const headroom = (1 - perStep / BUDGET_MS) * 100;
    console.log(
      `  ${String(n).padStart(4)}   ${perStep.toFixed(3).padStart(7)}   ` +
        `${(perStep / n).toFixed(3).padStart(7)}   ${headroom.toFixed(1).padStart(6)}%`,
    );
  }

  // Fixed cost is the world step itself; marginal cost is what each extra car
  // adds. Separating them is what makes the number projectable onto a machine
  // that is not thermally throttled.
  const lo = rows[0]!;
  const hi = rows[rows.length - 1]!;
  const marginal = (hi.perStep - lo.perStep) / (hi.cars - lo.cars);
  const fixed = lo.perStep - marginal * lo.cars;
  console.log(`\n  fixed      ${fixed.toFixed(3)} ms/step`);
  console.log(`  marginal   ${marginal.toFixed(3)} ms per car`);
  console.log(`  cars that fit the budget: ${Math.floor((BUDGET_MS - fixed) / marginal)}`);
  console.log(`  cars at 40% headroom:     ${Math.floor((BUDGET_MS * 0.6 - fixed) / marginal)}`);
  console.log(
    '\n  Run cpubench.ts first. If its ten-car step is far above ~1 ms this machine\n' +
      '  is throttling and these are lower bounds, not limits.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
