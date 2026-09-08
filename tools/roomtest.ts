/**
 * Race logic tests.  `npx tsx tools/roomtest.ts`
 *
 * Drives a `Room` directly through its state machine with no sockets and no
 * browser, and asserts the rules that decide whether ten strangers at a
 * hackathon actually get a race: who is on the grid, who waits, when the lights
 * go out, and that a lap only counts when the whole circuit was driven.
 *
 * Fast enough to run after every change to server/room.ts. Exits non-zero on
 * the first failure.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLIENT_TIMEOUT_MS,
  COUNTDOWN_SECONDS,
  RESET_COOLDOWN_SECONDS,
  RESULTS_SECONDS,
  TICK_HZ,
} from '../shared/constants';
import type { ServerMsg } from '../shared/protocol';
import type { TrackData } from '../shared/track-schema';
import { Room, type RoomOptions } from '../server/room';
import { Standings } from '../client/src/standings';
import { initPhysics } from '../vehicle/world';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const RESET_COOLDOWN_TICKS = RESET_COOLDOWN_SECONDS * TICK_HZ + 2;

let checks = 0;

function check(what: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failures++;
    console.log(`  FAIL  ${what}${detail ? `   ${detail}` : ''}`);
  }
}

function eq<T>(what: string, actual: T, expected: T): void {
  check(what, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function makeRoom(track: TrackData, opts: RoomOptions = {}): {
  room: Room;
  sent: ServerMsg[];
} {
  const sent: ServerMsg[] = [];
  const room = new Room(
    track,
    { send: (_id, m) => sent.push(m), broadcast: (m) => sent.push(m) },
    opts,
  );
  return { room, sent };
}

/**
 * Advance the room by `seconds` of simulated time.
 *
 * Entrants are kept alive as we go. The room drops a client that has been
 * silent for CLIENT_TIMEOUT_MS of *wall* time, and this loop runs simulated
 * time far faster than real time - two minutes of racing in a few seconds of
 * wall clock. Without this the human entrant is dropped mid-test, the room
 * empties, resets to lobby, and the assertions fail for a reason that has
 * nothing to do with what they are testing.
 */
function run(room: Room, seconds: number): void {
  const n = Math.round(seconds * TICK_HZ);
  for (let i = 0; i < n; i++) {
    if (i % TICK_HZ === 0) for (const e of room.entrants.values()) room.touch(e.id);
    room.step();
  }
}

async function main(): Promise<void> {
  await initPhysics();
  const track = JSON.parse(
    readFileSync(resolve(here, '../public/track/interlagos.json'), 'utf8'),
  ) as TrackData;

  // -------------------------------------------------------------------------
  console.log('\nlobby: everyone ready starts immediately');
  {
    const { room } = makeRoom(track);
    const a = room.join('Ayrton', 0);
    const b = room.join('Nelson', 1);
    run(room, 1);
    eq('stays in lobby with nobody ready', room.state, 'lobby');

    room.onReady(a.id, true);
    run(room, 1);
    eq('still lobby with one of two ready', room.state, 'lobby');

    room.onReady(b.id, true);
    run(room, 0.5);
    eq('grid once both are ready', room.state, 'grid');
    room.destroy();
  }

  // -------------------------------------------------------------------------
  console.log('\nlobby: one player who never readies cannot block the grid');
  {
    const { room } = makeRoom(track);
    const a = room.join('Ayrton', 0);
    room.join('Afk', 1);

    room.onReady(a.id, true);
    run(room, 10);
    eq('still waiting after 10 s', room.state, 'lobby');
    run(room, 17);
    eq('starts anyway after the lobby wait', room.state, 'grid');

    const racers = [...room.entrants.values()].filter((e) => room.isRacing(e));
    eq('only the ready player is on the grid', racers.length, 1);
    eq('and it is the right one', racers[0]?.id, a.id);
    room.destroy();
  }

  // -------------------------------------------------------------------------
  console.log('\njoining mid-race waits for the next one');
  {
    const { room } = makeRoom(track);
    const a = room.join('Ayrton', 0);
    room.onReady(a.id, true);
    run(room, 1);
    run(room, 3 + COUNTDOWN_SECONDS + 1);
    eq('race is running', room.state, 'racing');

    const late = room.join('Latecomer', 2);
    eq('latecomer has no car', room.isRacing(late), false);
    check('latecomer is absent from snapshots', !room.snapshotCars().some((c) => c.id === late.id));
    check('latecomer is absent from the order', !room.order().some((e) => e.id === late.id));

    run(room, 2);
    check('the running race is unaffected', room.state === 'racing');
    check('and the racer still has a car', room.isRacing(a));
    room.destroy();
  }

  // -------------------------------------------------------------------------
  console.log('\nAI fills the grid and races');
  {
    const { room } = makeRoom(track, { aiFill: 6, laps: 1 });
    const a = room.join('Ayrton', 0);
    room.onReady(a.id, true);
    run(room, 1 + 3 + COUNTDOWN_SECONDS + 1);
    eq('racing', room.state, 'racing');
    eq('grid filled to 6', room.entrants.size, 6);
    eq('all six have cars', [...room.entrants.values()].filter((e) => room.isRacing(e)).length, 6);
    eq('and all six are in the snapshot', room.snapshotCars().length, 6);

    // Let the AI actually complete the lap.
    run(room, 120);
    const done = [...room.entrants.values()].filter((e) => e.lap.lap >= 1).length;
    check('AI cars complete a lap', done >= 5, `${done} of 6 finished a lap`);

    const results = room.results();
    eq('results cover the whole grid', results.length, 6);
    check('positions are 1..n with no gaps', results.every((r, i) => r.position === i + 1));
    check(
      'finishers are ordered by finish time',
      results
        .filter((r) => r.totalMs !== null)
        .every((r, i, arr) => i === 0 || (arr[i - 1]!.totalMs ?? 0) <= (r.totalMs ?? 0)),
    );

    // A race ends wherever it ends, and the lobby that follows should not be
    // showing the wreckage. Strand the car a quarter of the way round the
    // circuit - upright and on the racing line, so the stuck-car rescue has no
    // reason to fire and cannot be what moves it - and check the return to
    // lobby puts it back on the grid.
    const w = track.waypoints[Math.floor(track.waypoints.length / 4)]!;
    a.car?.reset({ x: w.p[0], y: w.p[1] + 0.6, z: w.p[2] }, 0);
    const strandedFromGrid = Math.min(
      ...track.spawnGrid.map((g) => Math.hypot(g.p[0] - w.p[0], g.p[2] - w.p[2])),
    );
    check(
      'the stranded car really is away from the grid',
      strandedFromGrid > 50,
      `${strandedFromGrid.toFixed(0)} m from the nearest slot`,
    );

    // The room only enters 'finished' once the leader is home and the grace
    // period is up, so wait for the lobby rather than assume a fixed delay.
    for (let i = 0; i < RESULTS_SECONDS + 90 && room.state !== 'lobby'; i++) run(room, 1);
    eq('the room returns to the lobby', room.state, 'lobby');
    const p = a.car?.body.translation();
    const parkedFromGrid = p
      ? Math.min(...track.spawnGrid.map((g) => Math.hypot(g.p[0] - p.x, g.p[2] - p.z)))
      : Infinity;
    check(
      'and parks the stranded car back on the grid',
      parkedFromGrid < 2,
      `${parkedFromGrid.toFixed(1)} m from the nearest slot`,
    );

    room.destroy();
  }

  // -------------------------------------------------------------------------
  console.log('\na lap needs the whole circuit, not just the line');
  {
    const { room } = makeRoom(track, { laps: 3 });
    const a = room.join('Cutter', 0);
    room.onReady(a.id, true);
    run(room, 1 + 3 + COUNTDOWN_SECONDS + 1);

    const e = room.entrants.get(a.id)!;
    const q = room.world.query;

    // Teleport the car back and forth across the line without going round.
    for (let i = 0; i < 5; i++) {
      const before = q.track.waypoints[q.count - 20]!;
      e.car!.reset({ x: before.p[0], y: before.p[1] + 0.5, z: before.p[2] }, q.headingAt(q.count - 20));
      run(room, 0.2);
      const after = q.track.waypoints[20]!;
      e.car!.reset({ x: after.p[0], y: after.p[1] + 0.5, z: after.p[2] }, q.headingAt(20));
      run(room, 0.2);
    }
    eq('crossing the line repeatedly scores no laps', e.lap.lap, 0);
    check('and checkpoints are still outstanding', e.lap.missing().length > 0);
    room.destroy();
  }

  // -------------------------------------------------------------------------
  console.log('\nstandings agree with the server, including on the grid');
  {
    const { room } = makeRoom(track, { aiFill: 5, laps: 3 });
    const a = room.join('Ayrton', 0);
    room.onReady(a.id, true);
    run(room, 1 + 3 + COUNTDOWN_SECONDS + 0.5);

    const st = new Standings(room.world.query);

    // On the grid, before anyone has crossed the line. Every car is *behind*
    // the start/finish line here, which is the case that used to invert the
    // whole order: a parked car read a distance near the full lap length
    // while its lap count was still zero, and held P5 with a gap of -1971 m.
    let rows = st.update(room.snapshotCars());
    eq('everyone is ordered on the grid', rows.length, room.snapshotCars().length);
    check(
      'no car on the grid claims a lap of progress',
      rows.every((r) => Math.abs(r.raceDistance) < room.world.query.lapLength * 0.5),
      `distances ${rows.map((r) => r.raceDistance.toFixed(0)).join(', ')}`,
    );
    check('gaps to the leader are never negative', rows.every((r) => r.gapLeader >= -0.001));

    // Mid-race, against the server's own ordering.
    run(room, 45);
    rows = st.update(room.snapshotCars());
    const serverOrder = room.order().map((e) => e.id);
    const clientOrder = rows.map((r) => r.id);
    eq('client order matches the server', clientOrder.join(','), serverOrder.join(','));
    check('gaps still never negative', rows.every((r) => r.gapLeader >= -0.001));
    check('positions are 1..n', rows.every((r, i) => r.position === i + 1));
    room.destroy();
  }
  // -------------------------------------------------------------------------
  console.log('\nleaving frees the slot and the physics body');
  {
    const { room } = makeRoom(track);
    const a = room.join('Ayrton', 0);
    const b = room.join('Nelson', 1);
    eq('two entrants', room.entrants.size, 2);
    room.leave(a.id);
    eq('one entrant after a leave', room.entrants.size, 1);
    check('the remaining one is intact', room.entrants.has(b.id));
    run(room, 0.5);
    check('the room keeps stepping', room.tick > 0);
    room.destroy();
  }

  // -------------------------------------------------------------------------
  console.log('\na timed-out client is evicted, not left as a ghost');
  {
    const evicted: number[] = [];
    const room = new Room(
      track,
      { send: () => {}, broadcast: () => {}, evict: (id) => evicted.push(id) },
      {},
    );
    const a = room.join('Ghost', 0);
    room.step();
    check('present while it is still being heard from', room.entrants.has(a.id));

    // Reach past the timeout without burning wall time on it.
    a.lastSeenMs = Date.now() - CLIENT_TIMEOUT_MS - 1000;
    room.step();

    check('the entrant is removed', !room.entrants.has(a.id));
    eq('and the transport is told to close the socket', evicted.join(','), String(a.id));

    // This is the whole point. A client whose entrant was gone but whose socket
    // stayed open could not ready, got no roster back, and saw no error - it just
    // sat in a lobby whose Ready button silently did nothing.
    room.onReady(a.id, true);
    check('a ready from the ghost changes nothing', room.state === 'lobby');
    room.destroy();
  }

  // -------------------------------------------------------------------------
  console.log('\nreset puts a car back on the line without gaining ground');
  {
    const { room } = makeRoom(track, { laps: 3 });
    const a = room.join('Spinner', 0);
    room.onReady(a.id, true);
    run(room, 1 + 3 + COUNTDOWN_SECONDS + 1);
    eq('racing', room.state, 'racing');

    // Drive far enough to have real progress to protect, then wreck it:
    // off the road, upside down, pointing backwards.
    room.onInput(a.id, { t: 'input', seq: 1, throttle: 1, brake: 0, steer: 0, handbrake: false });
    run(room, 6);
    const before = a.hint;
    const q = room.world.query;
    const w = q.track.waypoints[before]!;
    a.car!.reset({ x: w.p[0] + 12, y: w.p[1] + 0.4, z: w.p[2] + 12 }, q.headingAt(before) + Math.PI);
    a.car!.body.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true); // on its roof
    run(room, 2);
    check('the car really is inverted first', a.car!.up().y < 0);

    check('the reset is accepted', room.onReset(a.id));
    const p = a.car!.body.translation();
    const loc = q.locate(p.x, p.y, p.z);
    check('it lands back on the track', loc.onTrack, `lateral ${loc.lateral.toFixed(2)} m`);
    check('the right way up', a.car!.up().y > 0.9, `up.y ${a.car!.up().y.toFixed(3)}`);

    // Facing along the track, not against it.
    const heading = q.headingAt(a.hint);
    const fwd = a.car!.forward();
    const want = { x: -Math.sin(heading), z: -Math.cos(heading) };
    const dot = fwd.x * want.x + fwd.z * want.z;
    check('and facing the right way', dot > 0.9, `dot ${dot.toFixed(3)}`);

    check('it is stationary', a.car!.speed < 0.5, `${a.car!.speed.toFixed(2)} m/s`);
    check('no lap progress was granted', a.lap.lap === 0);

    // The cooldown is what stops it being tapped through every corner.
    check('a second press straight away is refused', !room.onReset(a.id));
    run(room, RESET_COOLDOWN_TICKS);
    check('and allowed again once the cooldown passes', room.onReset(a.id));
    room.destroy();
  }

  // -------------------------------------------------------------------------
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
