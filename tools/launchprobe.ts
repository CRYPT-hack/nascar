/**
 * Check-4 root cause probe.  `npx tsx tools/launchprobe.ts [minutes] [cars]`
 *
 * Gate check 4 fails intermittently: about one impaired ten-car race in four
 * puts a car metres into the air and inverts it, while the controlled two-car
 * contact test is clean every time. This runs the same ten-car field headless,
 * with no network at all, and captures the context around every launch instead
 * of only the fact that one happened.
 *
 * No network, because the launch is measured on the server's own cars and the
 * server has no reconciliation - if it still fires here, the cause is in the
 * physics or the race logic, not the netcode.
 *
 * For each incident it records what the car was doing in the ticks before it
 * left the ground: speed, attitude, distance to the nearest other car, whether
 * it had just been rescued, and how far it was from the racing line.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TICK_HZ } from '../shared/constants';
import type { TrackData } from '../shared/track-schema';
import { Room } from '../server/room';
import { initPhysics } from '../vehicle/world';

const here = dirname(fileURLToPath(import.meta.url));

/** Height above the local road surface, in metres, that counts as airborne. */
const AIR_THRESHOLD = 1.1;
/** Ticks of history kept per car, so an incident can be looked at backwards. */
const HISTORY = 90;

interface Frame {
  tick: number;
  speed: number;
  upY: number;
  air: number;
  lateral: number;
  nearest: number;
  nearestId: number;
  vy: number;
  angVel: number;
  rescuedTicksAgo: number;
}

interface Incident {
  id: number;
  name: string;
  tick: number;
  peakAir: number;
  worstUp: number;
  history: Frame[];
}

async function main(): Promise<void> {
  const minutes = Number(process.argv[2] ?? 12);
  const cars = Number(process.argv[3] ?? 10);

  await initPhysics();
  const track = JSON.parse(
    readFileSync(resolve(here, '../public/track/interlagos.json'), 'utf8'),
  ) as TrackData;

  const room = new Room(track, { send: () => {}, broadcast: () => {} }, { aiFill: cars, laps: 9999 });
  // Every entrant is AI, so the field races itself with no clients involved.
  const a = room.join('Probe', 0);
  room.onReady(a.id, true);
  for (let i = 0; i < TICK_HZ * 10; i++) room.step();

  const q = room.world.query;
  const hints = new Map<number, number>();
  const history = new Map<number, Frame[]>();
  const lastRescueTick = new Map<number, number>();
  const incidents: Incident[] = [];
  const active = new Map<number, Incident>();

  // Watch for the rescue teleport, which is the leading suspect: it drops a car
  // at a waypoint without checking whether that waypoint is occupied.
  const seenStuck = new Map<number, number>();

  const total = Math.round(minutes * 60 * TICK_HZ);
  for (let t = 0; t < total; t++) {
    // Detect a rescue by watching stuckTicks reset from a high value.
    for (const e of room.entrants.values()) {
      const prev = seenStuck.get(e.id) ?? 0;
      if (prev > 0 && e.stuckTicks === 0 && prev >= 5 * TICK_HZ - 2) {
        lastRescueTick.set(e.id, room.tick);
      }
      seenStuck.set(e.id, e.stuckTicks);
    }

    room.step();
    if (room.state !== 'racing') continue;

    const cars2 = [...room.entrants.values()].filter((e) => e.car);
    for (const e of cars2) {
      const car = e.car!;
      const p = car.body.translation();
      const loc = q.locate(p.x, p.y, p.z, hints.get(e.id));
      hints.set(e.id, loc.index);

      let nearest = Infinity;
      let nearestId = -1;
      for (const o of cars2) {
        if (o.id === e.id) continue;
        const op = o.car!.body.translation();
        const d = Math.hypot(p.x - op.x, p.y - op.y, p.z - op.z);
        if (d < nearest) {
          nearest = d;
          nearestId = o.id;
        }
      }

      const av = car.body.angvel();
      const frame: Frame = {
        tick: room.tick,
        speed: car.speed * 3.6,
        upY: car.up().y,
        air: p.y - loc.surfaceY - 0.52,
        lateral: loc.lateral,
        nearest,
        nearestId,
        vy: car.body.linvel().y,
        angVel: Math.hypot(av.x, av.y, av.z),
        rescuedTicksAgo: room.tick - (lastRescueTick.get(e.id) ?? -1e9),
      };

      let h = history.get(e.id);
      if (!h) {
        h = [];
        history.set(e.id, h);
      }
      h.push(frame);
      if (h.length > HISTORY) h.shift();

      const airborne = frame.air > AIR_THRESHOLD;
      const inc = active.get(e.id);
      if (airborne && !inc) {
        const started: Incident = {
          id: e.id,
          name: e.name,
          tick: room.tick,
          peakAir: frame.air,
          worstUp: frame.upY,
          history: [...h],
        };
        active.set(e.id, started);
        incidents.push(started);
      } else if (inc) {
        inc.peakAir = Math.max(inc.peakAir, frame.air);
        inc.worstUp = Math.min(inc.worstUp, frame.upY);
        if (!airborne && frame.air < 0.4) active.delete(e.id);
      }
    }
  }

  const f2 = (n: number) => n.toFixed(2);
  console.log(`\n${minutes} min of ${cars}-car racing, ${total} ticks`);
  console.log(`incidents above ${AIR_THRESHOLD} m: ${incidents.length}\n`);

  for (const inc of incidents.slice(0, 6)) {
    console.log(
      `--- car ${inc.id} (${inc.name}) at tick ${inc.tick}: peak ${f2(inc.peakAir)} m, worst up.y ${f2(inc.worstUp)}`,
    );
    console.log('      tick   speed   up.y     air   lat   nearest(id)     vy   |angvel|  rescued');
    const from = Math.max(0, inc.history.length - 30);
    for (const fr of inc.history.slice(from)) {
      const resc = fr.rescuedTicksAgo < 300 ? `${fr.rescuedTicksAgo}t ago` : '-';
      console.log(
        `  ${String(fr.tick).padStart(8)}  ${f2(fr.speed).padStart(6)}  ${f2(fr.upY).padStart(5)}  ` +
          `${f2(fr.air).padStart(6)}  ${f2(fr.lateral).padStart(5)}  ` +
          `${(fr.nearest === Infinity ? '-' : f2(fr.nearest)).padStart(6)}(${String(fr.nearestId).padStart(2)})  ` +
          `${f2(fr.vy).padStart(6)}  ${f2(fr.angVel).padStart(7)}  ${resc}`,
      );
    }
    console.log('');
  }

  // Summarise what the incidents have in common.
  if (incidents.length > 0) {
    const closeContact = incidents.filter((i) => {
      const last = i.history[i.history.length - 1];
      return last !== undefined && last.nearest < 3.0;
    }).length;
    const afterRescue = incidents.filter((i) => {
      const last = i.history[i.history.length - 1];
      return last !== undefined && last.rescuedTicksAgo < 120;
    }).length;
    console.log('summary');
    console.log(`  incidents                ${incidents.length}`);
    console.log(`  with a car within 3 m    ${closeContact}`);
    console.log(`  within 2 s of a rescue   ${afterRescue}`);
    console.log(`  peak height              ${f2(Math.max(...incidents.map((i) => i.peakAir)))} m`);
    console.log(`  worst attitude           up.y ${f2(Math.min(...incidents.map((i) => i.worstUp)))}`);
  }

  room.destroy();
}


main().catch((e) => {
  console.error(e);
  process.exit(1);
});
