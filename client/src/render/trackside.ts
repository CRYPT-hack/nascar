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
import { createScenery } from './scenery';

/** Straight enough to seat spectators along: radius over 400 m. */
const STRAIGHT_CURVATURE = 1 / 400;
/** Shortest run worth putting a grandstand on, metres. */
const MIN_STAND_LENGTH = 140;
/** How many stands to place, longest straights first. */
const MAX_STANDS = 3;
/** Gap between the barrier and the front of a stand, metres. */
const STAND_SETBACK = 5;
export const STAND_SEGMENT = 12;
export const STAND_DEPTH = 14;
/** Height of the solid substructure. Seating sits on top of this, not inside it. */
export const STAND_HEIGHT = 9;
/** Height of the seating deck above the substructure, metres. */
export const SEAT_DECK_RISE = 0.4;
/** Height of the roof above the substructure, metres. */
export const ROOF_RISE = 5.2;

/**
 * One grandstand segment, in world space.
 *
 * Exposed because the crowd has to sit on the decks. Computing the seating
 * positions from the same placements the shells were built from is the only way
 * the spectators end up on the stands rather than beside them.
 */
export interface StandPlacement {
  /** Centre of the segment, at ground level. */
  base: THREE.Vector3;
  /** Unit vector along the track. */
  forward: THREE.Vector3;
  /** Unit vector to the right of the direction of travel. */
  right: THREE.Vector3;
  /** Which side of the track this stand is on. */
  side: -1 | 1;
  heading: number;
}

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
 * Where the grandstands go: along the longest straights, on whichever side has
 * more run-off so one never ends up crammed against a barrier at a corner entry.
 */
function planGrandstands(track: TrackData, frames: Frame[], plan: SectionPlan): StandPlacement[] {
  const out: StandPlacement[] = [];

  for (const run of findStraights(track)) {
    const midIdx = (run.start + Math.floor(run.count / 2)) % frames.length;
    const side: -1 | 1 = plan.leftWidth[midIdx]! > plan.rightWidth[midIdx]! ? -1 : 1;

    const stepIdx = Math.max(1, Math.round(STAND_SEGMENT / (run.metres / run.count)));
    for (let i = run.start; i < run.start + run.count; i += stepIdx) {
      const idx = i % frames.length;
      const f = frames[idx]!;
      const runoff = side < 0 ? plan.leftWidth[idx]! : plan.rightWidth[idx]!;
      const d = side * (outerHalfWidth(f.width, runoff) + STAND_SETBACK + STAND_DEPTH / 2);

      const right = new THREE.Vector3(f.right[0], f.right[1], f.right[2]);
      const up = new THREE.Vector3(f.up[0], f.up[1], f.up[2]);
      // right = forward x up, so forward = up x right.
      const forward = new THREE.Vector3().crossVectors(up, right).normalize();

      out.push({ base: offset(f, d), forward, right, side, heading: headingOf(f) });
    }
  }
  return out;
}

function buildGrandstands(placements: StandPlacement[]): THREE.Object3D | null {
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
    placements.length,
  );
  // A roof is what separates a grandstand from a grey box at a glance.
  const roof = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0xd7dbe0, roughness: 0.7, metalness: 0.15 }),
    placements.length,
  );

  const m = new THREE.Matrix4();
  placements.forEach((s, i) => {
    m.compose(
      new THREE.Vector3(s.base.x, s.base.y + STAND_HEIGHT / 2, s.base.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -s.heading, 0)),
      new THREE.Vector3(STAND_DEPTH, STAND_HEIGHT, STAND_SEGMENT),
    );
    shell.setMatrixAt(i, m);

    // Seating deck, raked toward the track. It sits *on top* of the shell:
    // the shell is the substructure, and anything placed inside its height is
    // simply invisible — which is where the deck and the whole crowd used to be.
    m.compose(
      new THREE.Vector3(
        s.base.x - s.right.x * s.side * (STAND_DEPTH * 0.28),
        s.base.y + STAND_HEIGHT + SEAT_DECK_RISE,
        s.base.z - s.right.z * s.side * (STAND_DEPTH * 0.28),
      ),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -s.heading, s.side * 0.42)),
      new THREE.Vector3(STAND_DEPTH * 0.8, 0.7, STAND_SEGMENT * 0.96),
    );
    seats.setMatrixAt(i, m);

    // Cantilevered out over the seating, toward the track, and high enough to
    // clear the back row rather than sitting on their heads.
    m.compose(
      new THREE.Vector3(
        s.base.x - s.right.x * s.side * (STAND_DEPTH * 0.18),
        s.base.y + STAND_HEIGHT + ROOF_RISE,
        s.base.z - s.right.z * s.side * (STAND_DEPTH * 0.18),
      ),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -s.heading, s.side * 0.12)),
      new THREE.Vector3(STAND_DEPTH * 1.05, 0.45, STAND_SEGMENT),
    );
    roof.setMatrixAt(i, m);
  });

  shell.instanceMatrix.needsUpdate = true;
  seats.instanceMatrix.needsUpdate = true;
  roof.instanceMatrix.needsUpdate = true;
  shell.castShadow = true;
  seats.castShadow = true;
  roof.castShadow = true;
  group.add(shell, seats, roof);
  return group;
}

/** Gantry straddling the start/finish line. */
function createGantry(frames: Frame[], plan: SectionPlan): THREE.Group {
  const f = frames[0]!;
  const group = new THREE.Group();
  group.name = 'gantry';

  // Posts stand on the barrier line, which is where a real gantry's legs go.
  //
  // Previously a fraction of the footprint, which only worked while the
  // footprint was much wider than the road. When the run-off was narrowed to
  // match the physics builder (hw+9 rather than hw+15.1) that fraction put the
  // legs 0.5 m outside the track edge on the 16 m pit straight — a pillar
  // standing on the kerb, directly ahead of the grid.
  const halfL = outerHalfWidth(f.width, plan.leftWidth[0]!);
  const halfR = outerHalfWidth(f.width, plan.rightWidth[0]!);
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

  const standPlacements = planGrandstands(track, frames, plan);
  const stands = buildGrandstands(standPlacements);
  if (stands) group.add(stands);

  const posts = createMarshalPosts(track, frames, plan);
  if (posts) group.add(posts);

  // Trees, spectators and tyre stacks. Given the stand placements so the crowd
  // sits on the decks rather than beside them.
  group.add(
    createScenery(track, plan, frames, standPlacements, {
      standLength: STAND_SEGMENT,
      standDepth: STAND_DEPTH,
      standHeight: STAND_HEIGHT,
    }),
  );

  return group;
}
