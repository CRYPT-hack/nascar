/**
 * Natural scenery and crowds: trees, spectators, tyre stacks.
 *
 * Purpose is speed, not decoration. A circuit sitting on an empty green plane
 * gives the eye nothing to measure motion against, so 200 km/h reads as a slow
 * drift. Objects passing close to the camera are what make it feel fast, which
 * is why trees come right up to the barrier line rather than sitting politely
 * in the distance.
 *
 * Everything is instanced — the whole forest is one draw call per species — and
 * everything is decorative. None of it collides: the collision mesh comes from
 * track/src/mesh.ts and excludes all of this by construction (HANDOFF.md §5.3).
 *
 * Placement is derived from track geometry and seeded noise, never authored, so
 * it survives any edit to circuits.ts and is identical on every machine.
 *
 * No sponsor, team or driver marks anywhere (HANDOFF.md §10).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { TrackData } from '../../../shared/track-schema';
import type { Frame } from '../../../track/src/mesh';
import { TrackSampler } from '../../../track/src/sampler';
import { outerHalfWidth, type SectionPlan } from '../../../track/src/section';
import { mulberry32, valueNoise } from './rng';
import type { StandPlacement } from './trackside';

/**
 * Trees stay at least this far beyond the barrier line, metres.
 *
 * Deliberately close. Objects passing near the camera are what make speed
 * legible; a polite setback puts the whole treeline on the horizon, where it
 * slides by too slowly to read as motion at all.
 */
const TREE_CLEARANCE = 3.5;
/** How far out from the centreline trees are grown, metres. */
const TREE_REACH = 260;
/** Candidate lattice spacing, metres. */
const TREE_CELL = 17;
/** Scale of the grove/clearing noise, metres. */
const GROVE_SCALE = 120;
/** Hard ceiling on tree instances, so a bigger circuit cannot melt the laptop. */
const MAX_TREES = 2400;
/** Trees are kept this far from a grandstand, metres. */
const STAND_KEEPOUT = 24;

const CROWD_ROWS = 4;
const CROWD_COLUMNS = 7;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Bake a flat colour into a geometry so merged parts keep separate colours. */
function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.toNonIndexed();
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * A tree, built at unit height so an instance matrix can scale it directly.
 * Trunk and canopy are merged into one geometry: two instanced meshes per
 * species would double both the instance bookkeeping and the draw calls.
 */
function treeGeometry(kind: 'broadleaf' | 'pine'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  if (kind === 'broadleaf') {
    const trunk = new THREE.CylinderGeometry(0.055, 0.09, 0.46, 6);
    trunk.translate(0, 0.23, 0);
    parts.push(paint(trunk, 0x4a3728));

    // Two offset lumps read as a canopy from a moving car; a single sphere
    // reads as a lollipop.
    const a = new THREE.IcosahedronGeometry(0.34, 0);
    a.scale(1, 0.82, 1);
    a.translate(0, 0.7, 0);
    parts.push(paint(a, 0x3d6b2e));

    const b = new THREE.IcosahedronGeometry(0.23, 0);
    b.scale(1, 0.8, 1);
    b.translate(0.16, 0.56, -0.1);
    parts.push(paint(b, 0x477a35));
  } else {
    const trunk = new THREE.CylinderGeometry(0.045, 0.075, 0.32, 6);
    trunk.translate(0, 0.16, 0);
    parts.push(paint(trunk, 0x43331f));

    const lower = new THREE.ConeGeometry(0.3, 0.52, 7);
    lower.translate(0, 0.44, 0);
    parts.push(paint(lower, 0x2f5a2c));

    const upper = new THREE.ConeGeometry(0.21, 0.42, 7);
    upper.translate(0, 0.76, 0);
    parts.push(paint(upper, 0x37662f));
  }

  return mergeGeometries(parts, false) ?? parts[0]!;
}

/** Three stacked tyres, merged. */
function tyreStackGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const t = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 10);
    t.translate(0, 0.13 + i * 0.26, 0);
    parts.push(paint(t, i === 2 ? 0x2a2c2f : 0x1e2022));
  }
  return mergeGeometries(parts, false) ?? parts[0]!;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

interface TreeSite {
  x: number;
  z: number;
  y: number;
  scale: number;
  rotation: number;
  pine: boolean;
}

/**
 * Scatter trees over everything outside the barriers, in groves.
 *
 * Rejection-sampled against the track's own surface query, so a tree can never
 * land on the circuit however the layout is edited. Density rises with distance
 * from the road: thick woodland at the edge of the property, thinner near the
 * track where it would block the view of the corner ahead.
 */
function planTrees(
  track: TrackData,
  plan: SectionPlan,
  stands: StandPlacement[],
  sampler: TrackSampler,
): TreeSite[] {
  const rnd = mulberry32(20260907);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const w of track.waypoints) {
    minX = Math.min(minX, w.p[0]);
    maxX = Math.max(maxX, w.p[0]);
    minZ = Math.min(minZ, w.p[2]);
    maxZ = Math.max(maxZ, w.p[2]);
  }
  const pad = TREE_REACH;

  const sites: TreeSite[] = [];
  for (let x = minX - pad; x <= maxX + pad; x += TREE_CELL) {
    for (let z = minZ - pad; z <= maxZ + pad; z += TREE_CELL) {
      const px = x + (rnd() - 0.5) * TREE_CELL * 0.95;
      const pz = z + (rnd() - 0.5) * TREE_CELL * 0.95;

      const q = sampler.query(px, pz);
      const runoff = q.lateral < 0 ? plan.leftWidth[q.i]! : plan.rightWidth[q.i]!;
      const barrier = outerHalfWidth(q.width, runoff);
      const beyond = Math.abs(q.lateral) - barrier;

      if (beyond < TREE_CLEARANCE) continue;
      if (Math.abs(q.lateral) > TREE_REACH) continue;

      // Groves and clearings. Density is highest just behind the barrier and
      // thins with distance: the near band is what the driver actually sees
      // going past, and the far field only has to close off the horizon.
      const grove = valueNoise(px, pz, GROVE_SCALE, 7);
      const fade = 1 - 0.6 * Math.min(1, (beyond - TREE_CLEARANCE) / (TREE_REACH * 0.7));
      if (rnd() > grove * grove * 2.1 * fade) continue;

      let blocked = false;
      for (const s of stands) {
        if ((s.base.x - px) ** 2 + (s.base.z - pz) ** 2 < STAND_KEEPOUT * STAND_KEEPOUT) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      sites.push({
        x: px,
        z: pz,
        // Sit on the local ground rather than y = 0: Interlagos drops 27 m
        // from the pit straight to Junção, and a flat forest would float at
        // one end of the circuit and be buried at the other.
        y: q.groundY - 0.2,
        // A wide spread of heights. A forest of one-size trees reads as a
        // texture; mixed heights read as a canopy.
        scale: 5 + rnd() * rnd() * 13,
        rotation: rnd() * Math.PI * 2,
        pine: rnd() < 0.28,
      });
    }
  }

  // Thin uniformly if over budget rather than stopping the scan early — the
  // lattice is walked in x then z, so an early exit would leave one whole
  // corner of the map bare.
  if (sites.length > MAX_TREES) {
    const keep = MAX_TREES / sites.length;
    return sites.filter(() => rnd() < keep);
  }
  return sites;
}

function buildTrees(sites: TreeSite[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'trees';

  for (const pine of [false, true]) {
    const mine = sites.filter((s) => s.pine === pine);
    if (mine.length === 0) continue;

    const mesh = new THREE.InstancedMesh(
      treeGeometry(pine ? 'pine' : 'broadleaf'),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94 }),
      mine.length,
    );
    mesh.name = pine ? 'trees:pine' : 'trees:broadleaf';

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const tint = new THREE.Color();

    mine.forEach((s, i) => {
      pos.set(s.x, s.y, s.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rotation);
      // Slight width variation so a row of trees does not look cloned.
      scale.set(s.scale * (0.8 + (i % 5) * 0.06), s.scale, s.scale * (0.8 + (i % 3) * 0.08));
      m.compose(pos, q, scale);
      mesh.setMatrixAt(i, m);

      // Multiplies the baked vertex colours, so trunks stay brown while the
      // canopies vary. A single green over a whole forest reads as one flat
      // mass, so brightness and warmth are both varied — some trees olive,
      // some deep green — while staying close enough to 1 not to tint trunks.
      const v = 0.72 + ((i * 37) % 100) / 100 * 0.52;
      const warm = 0.86 + ((i * 61) % 100) / 100 * 0.3;
      tint.setRGB(v * warm, v, v * (1.12 - warm * 0.28));
      mesh.setColorAt(i, tint);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Deliberately no shadows. An InstancedMesh culls as a single unit, so the
    // whole forest would be redrawn into the shadow map every frame for
    // shadows that fall almost entirely outside the 90 m shadow frustum.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------------------
// Distant hills
// ---------------------------------------------------------------------------

/**
 * A ring of low hills around the circuit.
 *
 * Without them the world is a flat plane meeting the sky in a hard line, and
 * the whole scene reads as a model on a table. Hills give the horizon a profile
 * and the fog something to act on, which is most of what makes distance feel
 * like distance.
 *
 * One mesh, a few thousand triangles, no textures — it is almost entirely
 * swallowed by fog, so detail here would be invisible.
 */
function buildHills(track: TrackData): THREE.Mesh {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  for (const w of track.waypoints) {
    minX = Math.min(minX, w.p[0]);
    maxX = Math.max(maxX, w.p[0]);
    minZ = Math.min(minZ, w.p[2]);
    maxZ = Math.max(maxZ, w.p[2]);
    minY = Math.min(minY, w.p[1]);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const radius = Math.max(maxX - minX, maxZ - minZ) / 2;

  // Kept inside the ground plane (createGroundPlane spans 4x the circuit), so
  // the hills never overhang the edge of the world.
  const inner = radius + 240;
  const outer = radius + Math.min(1000, radius * 2.4);
  const SEG = 128;
  const BANDS = 6;

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const low = new THREE.Color(0x4a6b3c);
  const high = new THREE.Color(0x6f8496);

  for (let b = 0; b <= BANDS; b++) {
    const t = b / BANDS;
    const r = inner + (outer - inner) * t;
    for (let a = 0; a < SEG; a++) {
      const th = (a / SEG) * Math.PI * 2;
      const x = cx + Math.cos(th) * r;
      const z = cz + Math.sin(th) * r;

      // Two octaves of world-space noise so the ridge line is not periodic.
      const nA = valueNoise(x, z, 620, 3);
      const nB = valueNoise(x, z, 210, 9);
      const ramp = Math.pow(t, 0.7);
      const h = ramp * (26 + (nA * 0.75 + nB * 0.25) * 130);

      positions.push(x, minY - 2 + h, z);
      // Aerial perspective: distant high ground reads bluer than near green.
      const c = low.clone().lerp(high, Math.min(1, (h / 120) * 0.85));
      colors.push(c.r, c.g, c.b);
    }
  }

  for (let b = 0; b < BANDS; b++) {
    for (let a = 0; a < SEG; a++) {
      const a2 = (a + 1) % SEG;
      const r0 = b * SEG;
      const r1 = (b + 1) * SEG;
      indices.push(r0 + a, r0 + a2, r1 + a, r0 + a2, r1 + a2, r1 + a);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }),
  );
  mesh.name = 'hills';
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

// ---------------------------------------------------------------------------
// Crowd
// ---------------------------------------------------------------------------

/** Bright, saturated clothing. Invented palette — no team colours. */
const CROWD_COLORS = [
  0xe8453c, 0xf5a623, 0xf8e71c, 0x4a90e2, 0x50e3c2, 0xbd10e0, 0xffffff, 0x2b3a55, 0xff7ab6, 0x7ed321,
];

/**
 * Spectators on the grandstand decks.
 *
 * Boxes, not figures: at the distance a driver ever sees them, a 12-triangle
 * box with a bright colour reads as a person, and a detailed model would cost
 * a hundred times the geometry to look identical.
 */
function buildCrowd(stands: StandPlacement[], standLength: number, standDepth: number, standHeight: number): THREE.Object3D | null {
  if (stands.length === 0) return null;

  const rnd = mulberry32(31337);
  const matrices: THREE.Matrix4[] = [];
  const colors: THREE.Color[] = [];

  const m = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);

  for (const s of stands) {
    for (let row = 0; row < CROWD_ROWS; row++) {
      const t = row / (CROWD_ROWS - 1);
      // Deck rises and steps back as it goes away from the track. Heights are
      // measured from the *top* of the substructure — spectators placed within
      // standHeight are sealed inside the solid shell and never seen.
      const depth = (-0.3 + t * 0.62) * standDepth;
      const height = standHeight + 1.1 + t * 2.1;

      for (let col = 0; col < CROWD_COLUMNS; col++) {
        if (rnd() < 0.18) continue; // gaps, so it does not read as a barcode
        const along = (col / (CROWD_COLUMNS - 1) - 0.5) * standLength * 0.92;

        const x = s.base.x + s.forward.x * along + s.right.x * s.side * depth;
        const z = s.base.z + s.forward.z * along + s.right.z * s.side * depth;
        const y = s.base.y + height + (rnd() - 0.5) * 0.12;

        quat.setFromAxisAngle(up, -s.heading);
        m.compose(
          new THREE.Vector3(x, y, z),
          quat,
          new THREE.Vector3(0.42, 0.95 + rnd() * 0.25, 0.36),
        );
        matrices.push(m.clone());
        colors.push(new THREE.Color(CROWD_COLORS[Math.floor(rnd() * CROWD_COLORS.length)]!));
      }
    }
  }

  if (matrices.length === 0) return null;

  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    matrices.length,
  );
  mesh.name = 'crowd';
  matrices.forEach((mat, i) => {
    mesh.setMatrixAt(i, mat);
    mesh.setColorAt(i, colors[i]!);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  return mesh;
}

/**
 * Spectators packed along the barriers.
 *
 * The grandstand crowd is always some way off; these are the people a driver
 * passes within a car's length of. From the cockpit the 1.2 m barrier hides
 * them from the waist down, which is exactly how a circuit looks from a car.
 *
 * Clustered rather than spread evenly — a continuous ribbon of spectators the
 * whole way round reads as wallpaper and costs thousands of instances for it.
 */
function buildTrackFans(
  track: TrackData,
  frames: Frame[],
  plan: SectionPlan,
  sampler: TrackSampler,
): THREE.Object3D | null {
  const n = frames.length;
  const rnd = mulberry32(90210);
  const matrices: THREE.Matrix4[] = [];
  const colors: THREE.Color[] = [];

  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion();
  const m = new THREE.Matrix4();

  let travelled = 0;
  let lastCluster = -1e9;

  for (let i = 0; i < n; i++) {
    const a = track.waypoints[i]!.p;
    const b = track.waypoints[(i + 1) % n]!.p;
    travelled += Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (travelled - lastCluster < 95) continue;
    lastCluster = travelled;

    const f = frames[i]!;
    // Whichever side has more room behind the barrier.
    const side: -1 | 1 = plan.leftWidth[i]! > plan.rightWidth[i]! ? -1 : 1;
    const runoff = side < 0 ? plan.leftWidth[i]! : plan.rightWidth[i]!;
    const barrier = outerHalfWidth(f.width, runoff);

    const forward = new THREE.Vector3().crossVectors(
      new THREE.Vector3(f.up[0], f.up[1], f.up[2]),
      new THREE.Vector3(f.right[0], f.right[1], f.right[2]),
    ).normalize();

    const count = 22 + Math.floor(rnd() * 26);
    for (let k = 0; k < count; k++) {
      const along = (rnd() - 0.5) * 34;
      const back = 1.6 + rnd() * rnd() * 9;
      const d = side * (barrier + back);

      const x = f.p[0] + f.right[0] * d + forward.x * along;
      const z = f.p[2] + f.right[2] * d + forward.z * along;
      const ground = sampler.query(x, z).groundY;

      quat.setFromAxisAngle(up, rnd() * Math.PI * 2);
      m.compose(
        new THREE.Vector3(x, ground + 0.85, z),
        quat,
        new THREE.Vector3(0.45, 1.65 + rnd() * 0.2, 0.34),
      );
      matrices.push(m.clone());
      colors.push(new THREE.Color(CROWD_COLORS[Math.floor(rnd() * CROWD_COLORS.length)]!));
    }
  }

  if (matrices.length === 0) return null;

  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    matrices.length,
  );
  mesh.name = 'trackFans';
  matrices.forEach((mat, i) => {
    mesh.setMatrixAt(i, mat);
    mesh.setColorAt(i, colors[i]!);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Tyre stacks
// ---------------------------------------------------------------------------

/**
 * Tyre stacks against the barrier through the corners — where they exist on a
 * real circuit, and where they are close enough to the car to be seen.
 */
function buildTyreStacks(track: TrackData, frames: Frame[], plan: SectionPlan): THREE.Object3D | null {
  const n = frames.length;
  const rnd = mulberry32(4242);
  const matrices: THREE.Matrix4[] = [];

  let travelled = 0;
  let lastPlaced = -1e9;

  for (let i = 0; i < n; i++) {
    const a = track.waypoints[i]!.p;
    const b = track.waypoints[(i + 1) % n]!.p;
    travelled += Math.hypot(b[0] - a[0], b[2] - a[2]);

    // Only through corners, and only every 14 m or so.
    const turn = Math.abs(track.waypoints[i]!.banking);
    if (turn < 0.02) continue;
    if (travelled - lastPlaced < 14) continue;
    lastPlaced = travelled;

    for (const side of [-1, 1] as const) {
      const runoff = side < 0 ? plan.leftWidth[i]! : plan.rightWidth[i]!;
      const f = frames[i]!;
      // Straddling the barrier line, so the stacks read as bolted to the wall
      // and only ~0.25 m of each protrudes into the run-off. These are
      // decorative and do not collide, so anything further inboard would let a
      // car slide visibly through them on the way to the barrier.
      const d = side * (outerHalfWidth(f.width, runoff) - 0.25);
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(
          f.p[0] + f.right[0] * d,
          f.p[1] + f.right[1] * d - 0.1,
          f.p[2] + f.right[2] * d,
        ),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI),
        new THREE.Vector3(1, 1, 1),
      );
      matrices.push(m);
    }
  }

  if (matrices.length === 0) return null;

  const mesh = new THREE.InstancedMesh(
    tyreStackGeometry(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
    matrices.length,
  );
  mesh.name = 'tyreStacks';
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------

export interface SceneryDimensions {
  standLength: number;
  standDepth: number;
  standHeight: number;
}

export function createScenery(
  track: TrackData,
  plan: SectionPlan,
  frames: Frame[],
  stands: StandPlacement[],
  dims: SceneryDimensions,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'scenery';

  // One sampler for every placement pass: it builds a spatial grid up front, so
  // constructing a second one per feature would be pure waste.
  const sampler = new TrackSampler(track, plan);

  group.add(buildHills(track));
  group.add(buildTrees(planTrees(track, plan, stands, sampler)));

  const crowd = buildCrowd(stands, dims.standLength, dims.standDepth, dims.standHeight);
  if (crowd) group.add(crowd);

  const fans = buildTrackFans(track, frames, plan, sampler);
  if (fans) group.add(fans);

  const tyres = buildTyreStacks(track, frames, plan);
  if (tyres) group.add(tyres);

  return group;
}
