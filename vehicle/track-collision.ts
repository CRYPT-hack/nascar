/**
 * TrackData -> collision geometry.
 *
 * Owned by Instance A: this is physics input, not presentation. Instance B owns
 * the visual mesh in /track/. Both are generated from the same waypoints, so
 * they cannot drift apart the way a hand-exported GLB pair would.
 *
 * HANDOFF.md §5.3 requires the collision mesh be a separate, simplified trimesh.
 * It is: `COLLISION_STEP` waypoints per station instead of every one, no
 * decorative geometry, and one trimesh per surface type so a suspension raycast
 * learns what it is standing on from the collider it hit rather than from a
 * per-triangle lookup.
 *
 * Cross-section, from the left barrier to the right barrier:
 *
 *   barrier | grass/gravel run-off | kerb | ASPHALT | kerb | run-off | barrier
 *           ^ -0.45 m               ^ +0.04 m at the track edge
 */

import type { SurfaceKind } from '../shared/protocol';
import type { TrackData } from '../shared/track-schema';

/** Waypoints per collision station. 2 -> a station every 6 m at 3 m spacing. */
export const COLLISION_STEP = 2;

const KERB_WIDTH = 1.2;
const RUNOFF_WIDTH = 9.0;
const BARRIER_HEIGHT = 1.3;

/** Kerb lip height above the asphalt. Deliberately small - a big step launches cars. */
const KERB_LIP = 0.04;
const KERB_OUTER = -0.03;
const RUNOFF_DROP = -0.45;

/** |banking| above this means the corner is quick enough to warrant gravel. */
const GRAVEL_BANK = 0.035;

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface SurfaceMesh {
  kind: SurfaceKind;
  data: MeshData;
}

export interface TrackMeshes {
  /** One trimesh per surface type. Empty surfaces are omitted. */
  surfaces: SurfaceMesh[];
  /** Left and right barrier walls as one trimesh. */
  barriers: MeshData;
  /** Station count actually emitted. */
  stations: number;
}

interface Band {
  kind: SurfaceKind;
  /** Lateral offset from the centreline at the left and right edge of the band. */
  from: (hw: number) => number;
  to: (hw: number) => number;
  /** Vertical offset relative to the road surface at each edge. */
  vFrom: number;
  vTo: number;
}

/**
 * The cross-section, left to right. Kerb and run-off appear twice because the
 * two sides are independently classified - only the outside of a corner gets
 * gravel.
 */
function bands(bankingLeftIsOutside: boolean, banking: number): Band[] {
  // banking is positive when the surface leans right, which happens in a right
  // -hand corner, whose outside is the left. See generate.ts BANK_GAIN.
  const outsideIsLeft = banking > GRAVEL_BANK;
  const outsideIsRight = banking < -GRAVEL_BANK;
  void bankingLeftIsOutside;

  const leftRunoff: SurfaceKind = outsideIsLeft ? 'gravel' : 'grass';
  const rightRunoff: SurfaceKind = outsideIsRight ? 'gravel' : 'grass';

  return [
    {
      kind: leftRunoff,
      from: (hw) => -(hw + RUNOFF_WIDTH),
      to: (hw) => -(hw + KERB_WIDTH),
      vFrom: RUNOFF_DROP,
      vTo: KERB_OUTER,
    },
    {
      kind: 'kerb',
      from: (hw) => -(hw + KERB_WIDTH),
      to: (hw) => -hw,
      vFrom: KERB_OUTER,
      vTo: KERB_LIP,
    },
    {
      kind: 'asphalt',
      from: (hw) => -hw,
      to: (hw) => hw,
      vFrom: 0,
      vTo: 0,
    },
    {
      kind: 'kerb',
      from: (hw) => hw,
      to: (hw) => hw + KERB_WIDTH,
      vFrom: KERB_LIP,
      vTo: KERB_OUTER,
    },
    {
      kind: rightRunoff,
      from: (hw) => hw + KERB_WIDTH,
      to: (hw) => hw + RUNOFF_WIDTH,
      vFrom: KERB_OUTER,
      vTo: RUNOFF_DROP,
    },
  ];
}

/** Orthonormal frame at a waypoint, with banking already applied. */
export interface Frame {
  /** Centreline point. */
  cx: number;
  cy: number;
  cz: number;
  /** Unit vector pointing right of travel, rotated by the local banking. */
  rx: number;
  ry: number;
  rz: number;
  /** Unit surface normal. */
  nx: number;
  ny: number;
  nz: number;
  /** Unit forward vector. */
  fx: number;
  fy: number;
  fz: number;
  halfWidth: number;
  banking: number;
}

/**
 * Build the frame at waypoint `i`. Exported because the AI driver, the spawn
 * logic and the debug renderer all need the same basis, and computing it two
 * different ways is how left and right end up swapped in one of them.
 */
export function frameAt(t: TrackData, i: number): Frame {
  const n = t.waypoints.length;
  const a = t.waypoints[((i % n) + n) % n]!;
  const b = t.waypoints[(((i + 1) % n) + n) % n]!;

  let fx = b.p[0] - a.p[0];
  let fy = b.p[1] - a.p[1];
  let fz = b.p[2] - a.p[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;

  // right = forward x up, which for up = (0,1,0) is (-fz, 0, fx).
  let rx = -fz;
  let ry = 0;
  let rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;

  // Rotate `right` about `forward` by the banking angle. Positive banking puts
  // the right-hand edge lower, which is what helps a right-hand corner.
  const cb = Math.cos(a.banking);
  const sb = Math.sin(a.banking);
  // forward x right
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;
  const brx = rx * cb + ux * sb;
  const bry = ry * cb + uy * sb;
  const brz = rz * cb + uz * sb;

  // normal = right x forward
  const nx = bry * fz - brz * fy;
  const ny = brz * fx - brx * fz;
  const nz = brx * fy - bry * fx;
  const nl = Math.hypot(nx, ny, nz) || 1;

  return {
    cx: a.p[0],
    cy: a.p[1],
    cz: a.p[2],
    rx: brx,
    ry: bry,
    rz: brz,
    nx: nx / nl,
    ny: ny / nl,
    nz: nz / nl,
    fx,
    fy,
    fz,
    halfWidth: a.width / 2,
    banking: a.banking,
  };
}

/** Point at lateral offset `o` and height `v` above the surface at waypoint i. */
export function pointOnSection(f: Frame, o: number, v: number): [number, number, number] {
  return [f.cx + f.rx * o + f.nx * v, f.cy + f.ry * o + f.ny * v, f.cz + f.rz * o + f.nz * v];
}

export function buildTrackCollision(t: TrackData, step = COLLISION_STEP): TrackMeshes {
  const n = t.waypoints.length;
  const stationIdx: number[] = [];
  for (let i = 0; i < n; i += step) stationIdx.push(i);
  const s = stationIdx.length;

  const frames = stationIdx.map((i) => frameAt(t, i));

  // One accumulator per surface kind. Bands of the same kind on both sides of
  // the track share a trimesh; a raycast only needs to know the kind.
  const acc = new Map<SurfaceKind, { pos: number[]; idx: number[] }>();
  const get = (k: SurfaceKind) => {
    let a = acc.get(k);
    if (!a) {
      a = { pos: [], idx: [] };
      acc.set(k, a);
    }
    return a;
  };

  for (let si = 0; si < s; si++) {
    const f0 = frames[si]!;
    const f1 = frames[(si + 1) % s]!;
    const b0 = bands(true, f0.banking);
    const b1 = bands(true, f1.banking);

    for (let bi = 0; bi < b0.length; bi++) {
      const band0 = b0[bi]!;
      const band1 = b1[bi]!;
      // If the two ends disagree on surface kind (gravel starting mid-corner)
      // the quad is assigned to the entering end, so the boundary is crisp.
      const a = get(band0.kind);
      const base = a.pos.length / 3;

      const p00 = pointOnSection(f0, band0.from(f0.halfWidth), band0.vFrom);
      const p01 = pointOnSection(f0, band0.to(f0.halfWidth), band0.vTo);
      const p10 = pointOnSection(f1, band1.from(f1.halfWidth), band1.vFrom);
      const p11 = pointOnSection(f1, band1.to(f1.halfWidth), band1.vTo);

      a.pos.push(...p00, ...p01, ...p10, ...p11);
      // Wind counter-clockwise seen from above so the normals point up.
      a.idx.push(base + 0, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }

  const surfaces: SurfaceMesh[] = [];
  for (const [kind, a] of acc) {
    if (a.idx.length === 0) continue;
    surfaces.push({
      kind,
      data: { positions: new Float32Array(a.pos), indices: new Uint32Array(a.idx) },
    });
  }

  return { surfaces, barriers: buildBarriers(frames), stations: s };
}

/**
 * Vertical walls at the outer edge of the run-off, both sides. These are the
 * only track geometry a car body actually makes contact with; everything else
 * is held up by suspension raycasts.
 */
function buildBarriers(frames: Frame[]): MeshData {
  const pos: number[] = [];
  const idx: number[] = [];
  const s = frames.length;

  for (const side of [-1, 1] as const) {
    const base0 = pos.length / 3;
    for (let si = 0; si < s; si++) {
      const f = frames[si]!;
      const o = side * (f.halfWidth + RUNOFF_WIDTH);
      const foot = pointOnSection(f, o, RUNOFF_DROP);
      pos.push(foot[0], foot[1], foot[2]);
      pos.push(foot[0], foot[1] + BARRIER_HEIGHT, foot[2]);
    }
    for (let si = 0; si < s; si++) {
      const a = base0 + si * 2;
      const b = base0 + ((si + 1) % s) * 2;
      // Two triangles per panel, wound so the face points at the track.
      if (side < 0) {
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      } else {
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Total triangle count, for the build-time budget check. */
export function triangleCount(m: TrackMeshes): number {
  let n = m.barriers.indices.length / 3;
  for (const s of m.surfaces) n += s.data.indices.length / 3;
  return n;
}
