/**
 * Physics world construction. Identical on server and client - that is the
 * whole point of it living here rather than in either of them.
 *
 * If server and client ever disagree about the car, check three things in this
 * order before suspecting the netcode (HANDOFF.md §10): the Rapier version is
 * exact-pinned and identical, both are stepping at FIXED_DT, and both built
 * their world through this function.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type { World } from '@dimforge/rapier3d-compat';

import { FIXED_DT, GRAVITY, GROUP, interactionGroups } from '../shared/constants';
import type { SurfaceKind } from '../shared/protocol';
import type { TrackData } from '../shared/track-schema';
import type { CarContext } from './car';
import { buildTrackCollision, triangleCount } from './track-collision';
import { TrackQuery } from './track-query';

let ready = false;

/** Must be awaited once per process before any world is built. */
export async function initPhysics(): Promise<void> {
  if (ready) return;
  await RAPIER.init();
  ready = true;
}

export function physicsReady(): boolean {
  return ready;
}

export interface RaceWorld {
  world: World;
  ctx: CarContext;
  query: TrackQuery;
  track: TrackData;
  /** Triangle count of the collision geometry, for the build budget. */
  triangles: number;
}

/**
 * Build a world containing the track and nothing else. Cars are added by the
 * caller so the same function serves the server room, the client prediction
 * world, and the headless load test.
 */
export function createRaceWorld(track: TrackData): RaceWorld {
  if (!ready) throw new Error('createRaceWorld: call await initPhysics() first');

  const world = new RAPIER.World(GRAVITY);
  world.timestep = FIXED_DT;
  // A racing car under load needs a few solver iterations to stop the
  // suspension breathing. The default is fine; raising substep count is not.
  world.integrationParameters.numSolverIterations = 6;

  const meshes = buildTrackCollision(track);
  const surfaceByHandle = new Map<number, SurfaceKind>();

  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  for (const s of meshes.surfaces) {
    const desc = RAPIER.ColliderDesc.trimesh(s.data.positions, s.data.indices)
      .setFriction(track.surfaces[s.kind]?.friction ?? 1)
      .setRestitution(0)
      .setCollisionGroups(interactionGroups(GROUP.TRACK, GROUP.CAR | GROUP.BARRIER));
    const col = world.createCollider(desc, fixed);
    surfaceByHandle.set(col.handle, s.kind);
  }

  const barrierDesc = RAPIER.ColliderDesc.trimesh(meshes.barriers.positions, meshes.barriers.indices)
    .setFriction(0.25)
    .setRestitution(0.2)
    .setCollisionGroups(interactionGroups(GROUP.BARRIER, GROUP.CAR));
  const barrierCollider = world.createCollider(barrierDesc, fixed);
  surfaceByHandle.set(barrierCollider.handle, 'asphalt');

  const ctx: CarContext = {
    world,
    surfaceOf: (h) => surfaceByHandle.get(h) ?? 'asphalt',
    surfaceProps: track.surfaces,
  };

  return { world, ctx, query: new TrackQuery(track), track, triangles: triangleCount(meshes) };
}

/** Free every Rapier allocation. Rooms are torn down between races. */
export function destroyRaceWorld(rw: RaceWorld): void {
  rw.world.free();
}
