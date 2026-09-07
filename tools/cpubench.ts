/**
 * Physics throughput benchmark.  `npx tsx tools/cpubench.ts`
 *
 * One fixed workload, no network, no timers: how many full simulation steps of
 * a ten-car race this machine manages per second. Exists so that a timing
 * result from the gate can be checked against the machine it was taken on,
 * rather than being attributed to a code change that did not cause it.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXED_DT, TICK_HZ } from '../shared/constants';
import type { TrackData } from '../shared/track-schema';
import { AI_SKILLS, AiDriver, buildSpeedProfile } from '../vehicle/ai-driver';
import { Car } from '../vehicle/car';
import { createRaceWorld, initPhysics } from '../vehicle/world';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  await initPhysics();
  const track = JSON.parse(
    readFileSync(resolve(here, '../public/track/interlagos.json'), 'utf8'),
  ) as TrackData;
  const rw = createRaceWorld(track);
  const profile = buildSpeedProfile(rw.query);

  const cars: { car: Car; ai: AiDriver }[] = [];
  for (let i = 0; i < 10; i++) {
    const car = new Car(rw.world);
    const s = track.spawnGrid[i % track.spawnGrid.length]!;
    car.reset({ x: s.p[0], y: s.p[1] + 0.2, z: s.p[2] }, s.rotY);
    cars.push({ car, ai: new AiDriver(rw.query, profile, AI_SKILLS[i % AI_SKILLS.length]!) });
  }

  const STEPS = 6000; // 100 s of simulated racing
  for (let i = 0; i < 600; i++) {
    for (const c of cars) c.car.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT, rw.ctx);
    rw.world.step();
  }

  const t0 = performance.now();
  for (let i = 0; i < STEPS; i++) {
    for (const c of cars) c.car.step(c.ai.update(c.car, FIXED_DT, []), FIXED_DT, rw.ctx);
    rw.world.step();
    for (const c of cars) c.car.postStep();
  }
  const ms = performance.now() - t0;

  const perStep = ms / STEPS;
  const rate = STEPS / (ms / 1000);
  console.log(`ten-car simulation steps: ${STEPS} in ${ms.toFixed(0)} ms`);
  console.log(`  per step        ${perStep.toFixed(3)} ms   (budget ${(1000 / TICK_HZ).toFixed(2)} ms)`);
  console.log(`  throughput      ${rate.toFixed(0)} steps/s   (${(rate / TICK_HZ).toFixed(1)}x realtime)`);
  console.log(`  implied headroom ${((1 - perStep / (1000 / TICK_HZ)) * 100).toFixed(1)}%`);
  rw.world.free();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
