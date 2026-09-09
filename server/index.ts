/**
 * Server entry point.  `npm run server`
 *
 * Environment:
 *   PORT       listen port, default 8080
 *   TRACK      track name in public/track, default interlagos
 *   CARS       size of the grid, default MAX_PLAYERS (10)
 *   AI_FILL    fill the grid to this many cars with AI, default 0
 *   LAPS       race distance, default RACE_LAPS
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT, MAX_PLAYERS, RACE_LAPS, TICK_HZ } from '../shared/constants';
import { validateTrack, type TrackData } from '../shared/track-schema';
import { initPhysics } from '../vehicle/world';
import { GameServer } from './net';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function loadTrack(name: string): TrackData {
  const path = resolve(root, `public/track/${name}.json`);
  const track = JSON.parse(readFileSync(path, 'utf8')) as TrackData;
  const errs = validateTrack(track);
  if (errs.length) {
    throw new Error(`track "${name}" is invalid:\n  ${errs.join('\n  ')}`);
  }
  return track;
}

/**
 * Read a count from the environment, falling back on anything unusable.
 *
 * A typo in `CARS` at the venue must not produce a zero-car grid or a NaN that
 * quietly disables the race; it produces the default and a running server.
 */
function clampCount(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) {
    console.warn(`ignoring unusable count "${raw}", using ${fallback}`);
    return fallback;
  }
  return Math.min(n, max);
}

/**
 * Tell the host when the grid they chose is too big for the machine they are on.
 *
 * Simulation cost is linear in the number of cars — about 0.68 ms per car on a
 * thermally throttled laptop, nearer a tenth of that on a healthy one — so the
 * largest grid that holds 60 Hz is a property of the hardware, not of the game.
 * A number picked here would be wrong on somebody else's machine.
 *
 * The room already records every tick duration, so this measures the real thing
 * under the real field rather than probing at startup and guessing. Said once,
 * because a warning repeated every ten seconds is a warning nobody reads.
 */
function watchTickBudget(server: GameServer): void {
  const budget = 1000 / TICK_HZ;
  let warned = false;

  const timer = setInterval(() => {
    if (warned) return;
    const recent = server.room.tickMs.slice(-TICK_HZ * 5);
    // Only meaningful once a field is actually running: an idle lobby is cheap
    // whatever the grid size is set to.
    if (recent.length < TICK_HZ * 4 || server.room.carCount < 2) return;

    const sorted = [...recent].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    if (p95 <= budget) return;

    warned = true;
    console.warn(
      `\ntick is overrunning: p95 ${p95.toFixed(1)} ms against a ${budget.toFixed(1)} ms budget ` +
        `with ${server.room.carCount} cars.`,
    );
    console.warn(
      `the race will still run, but the server is no longer holding 60 Hz. ` +
        `restart with a smaller CARS to fix it.`,
    );
  }, 5000);
  timer.unref?.();
}

async function main(): Promise<void> {
  const trackName = process.env['TRACK'] ?? 'interlagos';
  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  const laps = Number(process.env['LAPS'] ?? RACE_LAPS);

  await initPhysics();
  const track = loadTrack(trackName);

  // Grid size. Fewer than ten people is the normal case at a hackathon, and a
  // race that will not start until ten have joined is a race that never starts.
  // Bounded by the spawn grid: there is nowhere to put an eleventh car.
  const slots = track.spawnGrid.length;
  const cars = clampCount(process.env['CARS'], Math.min(MAX_PLAYERS, slots), slots);

  // Never more AI than there are places on the grid. Asking for a fuller grid
  // than the race allows is a contradiction, and silently honouring one of the
  // two would surprise whoever set the other.
  const aiFill = Math.min(clampCount(process.env['AI_FILL'], 0, slots), cars);

  const server = new GameServer(track, {
    port,
    laps,
    aiFill,
    maxPlayers: cars,
    // dist first so a built client wins, then public for the track JSON.
    staticDirs: [resolve(root, 'dist'), resolve(root, 'public')],
    // Serves https when certs/ holds a key pair, so phone controllers can read
    // their motion sensors. Falls back to http silently when it does not.
    tlsRoot: root,
  });

  console.log(`track ${track.name}: ${track.lapLengthMeters} m, ${laps} laps`);
  console.log(`collision geometry: ${server.room.world.triangles} triangles`);
  console.log(`grid: up to ${cars} cars`);
  if (aiFill > 0) console.log(`  filled to ${aiFill} with AI when the race starts`);
  server.start();
  watchTickBudget(server);

  const shutdown = () => {
    console.log('\nshutting down');
    void server.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
