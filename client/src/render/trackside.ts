/**
 * Trackside scenery: start/finish gantry, grandstands, marshal posts.
 *
 * HANDOFF.md §11 asks for a *recognisable* Interlagos. A bare ribbon of asphalt
 * in a field reads as a test scene; a gantry over the line and stands along the
 * pit straight are what make it read as a circuit. This is the cheapest
 * geometry that buys that.
 *
 * Everything here is decorative and never collides — the collision mesh is
 * built separately in track/src/mesh.ts and deliberately excludes all of it
 * (HANDOFF.md §5.3). Repeated pieces are instanced to keep draw calls flat.
 *
 * No sponsor, team or driver marks anywhere (HANDOFF.md §10).
 */

import * as THREE from 'three';

import type { TrackData } from '../../../shared/track-schema';
import { buildFrames, type Frame } from '../../../track/src/mesh';
import { outerHalfWidth, type SectionPlan } from '../../../track/src/section';
import { curvature, smoothClosed, type P2 } from '../../../track/src/spline';

/** Straight enough to seat spectators along: radius over 400 m. */
const STRAIGHT_CURVATURE = 1 / 400;
/** Shortest run worth putting a grandstand on, metres. */
const MIN_STAND_LENGTH = 140;
/** How many stands to place, longest straights first. */
const MAX_STANDS = 3;
/** Gap between the barrier and the front of a stand, metres. */
const STAND_SETBACK = 5;
const STAND_SEGMENT = 12;
const STAND_DEPTH = 14;
const STAND_HEIGHT = 9;

const GANTRY_CLEARANCE = 7;

/** Lateral offset of a point on frame `f`, `d` metres right of the centreline. */
function offset(f: Frame, d: number, up = 0): THREE.Vector3 {
  return new THREE.Vector3(
    f.p[0] + f.right[0] * d + f.up[0] * up,
    f.p[1] + f.right[1] * d + f.up[1] * up,
    f.p[2] + f.right[2] * d + f.up[2] * up,
  );
}

function headingOf(f: Frame): number {
  // The frame's right vector is horizontal before banking; deriving heading from
  // it keeps scenery square to the road rather than to the world axes.
  return Math.atan2(f.right[2], f.right[0]);
}

/** Maximal runs of low curvature, as [startIndex, length in metres]. */
function findStraights(track: TrackData): Array<{ start: number; count: number; metres: number }> {
  const n = track.waypoints.length;
  const pts: P2[] = track.waypoints.map((w) => [w.p[0], w.p[2]]);
  const k = smoothClosed(curvature(pts), 8);

  const step = (i: number): number => {
    const a = track.waypoints[i]!.p;
    const b = track.waypoints[(i + 1) % n]!.p;
    return Math.hypot(b[0] - a[0], b[2] - a[2]);
  };

  const runs: Array<{ start: number; count: number; metres: number }> = [];
  let i = 0;
  while (i < n) {
    if (Math.abs(k[i]!) >= STRAIGHT_CURVATURE) {
      i++;
      continue;
    }
    const start = i;
    let metres = 0;
    while (i < n && Math.abs(k[i]!) < STRAIGHT_CURVATURE) {
      metres += step(i);
      i++;
    }
    if (metres >= MIN_STAND_LENGTH) runs.push({ start, count: i - start, metres });
  }
  runs.sort((a, b) => b.metres - a.metres);
  return runs.slice(0, MAX_STANDS);
}

/**
 * Grandstands along the longest straights.
 *
 * Placed on whichever side has more run-off, so a stand never ends up crammed
 * against a barrier on the inside of a corner entry.
 */
function createGrandstands(track: TrackData, frames: Frame[], plan: SectionPlan): THREE.Object3D | null {
  const placements: THREE.Matrix4[] = [];
  const seatPlacements: THREE.Matrix4[] = [];

  for (const run of findStraights(track)) {
    // Seat the stand on whichever side has more run-off, so it never ends up
    // crammed against a barrier on the inside of a corner entry.
    const midIdx = (run.start + Math.floor(run.count / 2)) % frames.length;
    const side: -1 | 1 = plan.leftWidth[midIdx]! > plan.rightWidth[midIdx]! ? -1 : 1;

    const stepIdx = Math.max(1, Math.round(STAND_SEGMENT / (run.metres / run.count)));
    for (let i = run.start; i < run.start + run.count; i += stepIdx) {
      const f = frames[i % frames.length]!;
      const runoff = side < 0 ? plan.leftWidth[i % frames.length]! : plan.rightWidth[i % frames.length]!;
      const d = side * (outerHalfWidth(f.width, runoff) + STAND_SETBACK + STAND_DEPTH / 2);
      const base = offset(f, d);

      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(base.x, base.y + STAND_HEIGHT / 2, base.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -headingOf(f), 0)),
        new THREE.Vector3(STAND_DEPTH, STAND_HEIGHT, STAND_SEGMENT),
      );
      placements.push(m);

      // Seating deck: a thinner slab tilted toward the track, so the stand does
      // not read as a plain wall from the car.
      const seat = new THREE.Matrix4();
      seat.compose(
        new THREE.Vector3(
          base.x - f.right[0] * side * (STAND_DEPTH * 0.28),
          base.y + STAND_HEIGHT * 0.78,
          base.z - f.right[2] * side * (STAND_DEPTH * 0.28),
        ),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -headingOf(f), side * 0.42)),
        new THREE.Vector3(STAND_DEPTH * 0.75, 0.7, STAND_SEGMENT * 0.96),
      );
      seatPlacements.push(seat);
    }
  }

  if (placements.length === 0) return null;

  const group = new THREE.Group();
  group.name = 'grandstands';

  const box = new THREE.BoxGeometry(1, 1, 1);
  const shell = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x8d949c, roughness: 0.95 }),
    placements.length,
  );
  const seats = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x2f4f76, roughness: 0.85 }),
    seatPlacements.length,
  );
  placements.forEach((m, i) => shell.setMatrixAt(i, m));
  seatPlacements.forEach((m, i) => seats.setMatrixAt(i, m));
  shell.instanceMatrix.needsUpdate = true;
  seats.instanceMatrix.needsUpdate = true;
  shell.castShadow = true;
  seats.castShadow = true;
  group.add(shell, seats);
  return group;
}

/** Gantry straddling the start/finish line. */
function createGantry(frames: Frame[], plan: SectionPlan): THREE.Group {
  const f = frames[0]!;
  const group = new THREE.Group();
  group.name = 'gantry';

  const halfL = outerHalfWidth(f.width, plan.leftWidth[0]!) * 0.55;
  const halfR = outerHalfWidth(f.width, plan.rightWidth[0]!) * 0.55;
  const postMat = new THREE.MeshStandardMaterial({ color: 0x3d444d, roughness: 0.6, metalness: 0.35 });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.55, metalness: 0.2 });

  for (const [side, half] of [
    [-1, halfL],
    [1, halfR],
  ] as const) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, GANTRY_CLEARANCE, 0.7), postMat);
    const at = offset(f, side * half, GANTRY_CLEARANCE / 2);
    post.position.copy(at);
    post.rotation.y = -headingOf(f);
    post.castShadow = true;
    group.add(post);
  }

  const span = halfL + halfR;
  const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 1.5, 1.1), beamMat);
  const centre = offset(f, (halfR - halfL) / 2, GANTRY_CLEARANCE + 0.75);
  beam.position.copy(centre);
  // The beam runs across the track, so it is aligned to the frame's right axis.
  beam.rotation.y = -headingOf(f) + Math.PI / 2;
  beam.castShadow = true;
  group.add(beam);

  return group;
}

/**
 * Marshal posts on the outside of the tighter corners — the places a car
 * actually arrives at when it lets go, which is also where a spectator's eye
 * goes. Doubles as a distance cue for judging corner entry.
 */
function createMarshalPosts(track: TrackData, frames: Frame[], plan: SectionPlan): THREE.Object3D | null {
  const n = frames.length;
  const pts: P2[] = track.waypoints.map((w) => [w.p[0], w.p[2]]);
  const k = smoothClosed(curvature(pts), 6);

  const mats: THREE.Matrix4[] = [];
  let lastPlaced = -1e9;
  let travelled = 0;

  for (let i = 0; i < n; i++) {
    const a = track.waypoints[i]!.p;
    const b = track.waypoints[(i + 1) % n]!.p;
    travelled += Math.hypot(b[0] - a[0], b[2] - a[2]);

    if (Math.abs(k[i]!) < 1 / 150) continue;
    if (travelled - lastPlaced < 90) continue;
    lastPlaced = travelled;

    // Outside of the corner: positive curvature has its apex on the right, so
    // the outside is the left (see track/src/section.ts).
    const side = k[i]! > 0 ? -1 : 1;
    const f = frames[i]!;
    const runoff = side < 0 ? plan.leftWidth[i]! : plan.rightWidth[i]!;
    const d = side * (outerHalfWidth(f.width, runoff) + 2.4);
    const base = offset(f, d, 1.6);

    const m = new THREE.Matrix4();
    m.compose(
      base,
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -headingOf(f), 0)),
      new THREE.Vector3(1.6, 3.2, 1.6),
    );
    mats.push(m);
  }

  if (mats.length === 0) return null;

  const posts = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xe4e7ea, roughness: 0.8 }),
    mats.length,
  );
  mats.forEach((m, i) => posts.setMatrixAt(i, m));
  posts.instanceMatrix.needsUpdate = true;
  posts.castShadow = true;
  posts.name = 'marshalPosts';
  return posts;
}

export function createTrackside(track: TrackData, plan: SectionPlan): THREE.Group {
  const frames = buildFrames(track, plan);
  const group = new THREE.Group();
  group.name = 'trackside';

  group.add(createGantry(frames, plan));
  const stands = createGrandstands(track, frames, plan);
  if (stands) group.add(stands);
  const posts = createMarshalPosts(track, frames, plan);
  if (posts) group.add(posts);

  return group;
}
