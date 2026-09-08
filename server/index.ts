/**
 * Server entry point.  `npm run server`
 *
 * Environment:
 *   PORT       listen port, default 8080
 *   TRACK      track name in public/track, default interlagos
 *   AI_FILL    fill the grid to this many cars with AI, default 0
 *   LAPS       race distance, default RACE_LAPS
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT, RACE_LAPS } from '../shared/constants';
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

async function main(): Promise<void> {
  const trackName = process.env['TRACK'] ?? 'interlagos';
  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  const aiFill = Number(process.env['AI_FILL'] ?? 0);
  const laps = Number(process.env['LAPS'] ?? RACE_LAPS);

  await initPhysics();
  const track = loadTrack(trackName);

  const server = new GameServer(track, {
    port,
    laps,
    aiFill,
    // dist first so a built client wins, then public for the track JSON.
    staticDirs: [resolve(root, 'dist'), resolve(root, 'public')],
    // Serves https when certs/ holds a key pair, so phone controllers can read
    // their motion sensors. Falls back to http silently when it does not.
    tlsRoot: root,
  });

  console.log(`track ${track.name}: ${track.lapLengthMeters} m, ${laps} laps`);
  console.log(`collision geometry: ${server.room.world.triangles} triangles`);
  if (aiFill > 0) console.log(`grid filled to ${aiFill} cars with AI`);
  server.start();

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
