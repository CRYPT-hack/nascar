/**
 * AI lap test.  `npx tsx tools/laptest.ts [track] [cars] [laps]`
 *
 * Runs AI cars around the circuit headless and reports lap times. This is the
 * cheapest possible proof that the track is actually drivable end to end - a
 * corner that cannot be taken shows up here as a car stuck in a barrier, not as
 * a confused player at the demo.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXED_DT } from '../shared/constants';
import type { TrackData } from '../shared/track-schema';
import { AI_SKILLS, AiDriver, buildSpeedProfile } from '../vehicle/ai-driver';
import { Car } from '../vehicle/car';
import type { V3 } from '../vehicle/math3';
import { createRaceWorld, initPhysics } from '../vehicle/world';
import { LapTracker } from '../server/lap-tracker';

const here = dirname(fileURLToPath(import.meta.url));

const ms = (n: number) => {
  const s = n / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
};

async function main(): Promise<void> {
  const trackName = process.argv[2] ?? 'interlagos';
  const carCount = Number(process.argv[3] ?? 4);
  const laps = Number(process.argv[4] ?? 3);

  await initPhysics();
  const track = JSON.parse(
    readFileSync(resolve(here, `../public/track/${trackName}.json`), 'utf8'),
  ) as TrackData;
  const rw = createRaceWorld(track);
  const profile = buildSpeedProfile(rw.query);

  const pmin = Math.min(...profile);
  const pmax = Math.max(...profile);
  console.log(`${track.name}: ${track.lapLengthMeters} m, ${rw.triangles} collision triangles`);
  console.log(`speed profile: ${(pmin * 3.6).toFixed(0)}..${(pmax * 3.6).toFixed(0)} km/h`);
  console.log(`${carCount} AI cars, ${laps} laps\n`);

  interface Entry {
    car: Car;
    ai: AiDriver;
    lt: LapTracker;
    name: string;
    finished: boolean;
    hint: number;
    offTrack: number;
    stuck: number;
  }

  const entries: Entry[] = [];
  for (let i = 0; i < carCount; i++) {
    const car = new Car(rw.world);
    const s = track.spawnGrid[i % track.spawnGrid.length]!;
    car.reset({ x: s.p[0], y: s.p[1] + 0.2, z: s.p[2] }, s.rotY);
    const lt = new LapTracker(rw.query);
    const p = car.body.translation();
    lt.seed(rw.query.locate(p.x, p.y, p.z));
    entries.push({
      car,
      ai: new AiDriver(rw.query, profile, AI_SKILLS[i % AI_SKILLS.length]!),
      lt,
      name: `AI-${i + 1}`,
      finished: false,
      hint: 0,
      offTrack: 0,
      stuck: 0,
    });
  }

  // Let the grid settle before the clock starts.
  for (let i = 0; i < 60; i++) {
    for (const e of entries) e.car.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT, rw.ctx);
    rw.world.step();
  }
  for (const e of entries) e.lt.start(0);

  const maxTicks = 60 * 60 * 12; // 12 minutes of simulated time
  let tick = 0;
  let done = 0;

  const positions: V3[] = [];
  while (tick < maxTicks && done < entries.length) {
    const nowMs = tick * FIXED_DT * 1000;

    positions.length = 0;
    for (const e of entries) {
      const p = e.car.body.translation();
      positions.push({ x: p.x, y: p.y, z: p.z });
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.finished) continue;
      const others = positions.filter((_, k) => k !== i);
      const input = e.ai.update(e.car, FIXED_DT, others);
      e.car.step(input, FIXED_DT, rw.ctx);
    }
    rw.world.step();

    for (const e of entries) {
      if (e.finished) continue;
      const p = e.car.body.translation();
      const loc = rw.query.locate(p.x, p.y, p.z, e.hint);
      e.hint = loc.index;
      if (!loc.onTrack) e.offTrack++;
      if (e.car.speed < 1) e.stuck++;

      const ev = e.lt.update(loc, nowMs);
      if (ev) {
        console.log(
          `  ${e.name}  lap ${ev.lap}  ${ms(ev.lapTimeMs)}` +
            `   best ${ms(ev.bestMs)}   avg ${(track.lapLengthMeters / (ev.lapTimeMs / 1000) * 3.6).toFixed(1)} km/h`,
        );
        if (ev.lap >= laps) {
          e.finished = true;
          done++;
        }
      }
    }
    tick++;
  }

  console.log('\nsummary');
  const simSeconds = tick * FIXED_DT;
  for (const e of entries) {
    const best = e.lt.bestMs;
    console.log(
      `  ${e.name}  laps ${e.lt.lap}  best ${best === null ? '-' : ms(best)}` +
        `  off-track ${(e.offTrack / tick * 100).toFixed(1)}%` +
        `  stopped ${(e.stuck / tick * 100).toFixed(1)}%` +
        `  ${e.finished ? 'finished' : `DNF (missing cp ${e.lt.missing().join(',')})`}`,
    );
  }
  console.log(`\n${simSeconds.toFixed(1)} s simulated in ${tick} ticks`);
  if (done < entries.length) {
    console.log('NOT ALL CARS FINISHED - the track or the AI needs work');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
