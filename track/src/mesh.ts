/**
 * Waypoints -> geometry. Plain typed arrays, no three.js: the server imports
 * this to feed Rapier a trimesh and must not pull a renderer in with it. The
 * client wraps the same output in BufferGeometry (client/track-view.ts).
 *
 * Both sides building from the same waypoints is the point — see DECISION-LOG
 * "Track meshes are procedural, not GLB". There is no exporter and no importer,
 * so there is no way for server collision and client visuals to disagree.
 *
 * HANDOFF.md §5.3 requires collision to be a *separate, simplified* trimesh.
 * It is: a coarser longitudinal stride, no centre column, and none of the
 * decorative geometry.
 */

import type { SurfaceKind } from '../../shared/protocol';
import type { TrackData } from '../../shared/track-schema';
import {
  BARRIER_HEIGHT,
  KERB_WIDTH,
  outerHalfWidth,
  planSection,
  sectionRise,
  stations,
  type SectionPlan,
} from './section';

/** Positions and indices only — all Rapier needs for a trimesh collider. */
export interface CollisionData {
  vertices: Float32Array;
  indices: Uint32Array;
}

/** A renderable group. One material per group; creases between groups are sharp. */
export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface TrackMeshes {
  /** Drivable surface: asphalt, kerbs and run-off, as one simplified trimesh. */
  collision: CollisionData;
  /** Barrier walls. Separate so they can take GROUP.BARRIER. */
  barrierCollision: CollisionData;
  visual: Record<'asphalt' | 'kerb' | 'grass' | 'gravel' | 'barrier' | 'startLine', MeshData>;
  /** Cross-section plan, reused by the sampler so it is computed once. */
  section: SectionPlan;
}

export interface MeshOptions {
  /**
   * Waypoints per collision ring. 2 at the default 3 m spacing is a 6 m chord,
   * which cuts 0.22 m off the inside of the tightest corner on the circuit
   * (20.7 m radius) — under 2% of track width, and it halves the triangle count.
   */
  collisionStride?: number;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

type V3 = [number, number, number];

/** Orthonormal frame at a waypoint, with banking rolled in. */
export interface Frame {
  p: V3;
  right: V3;
  up: V3;
  /** Arc length from the start/finish line, metres. Used for UVs. */
  s: number;
  width: number;
  /** Run-off width off each edge here, metres. Varies with corner radius. */
  runoffL: number;
  runoffR: number;
}

/**
 * Orthonormal frames along the centreline, banking included.
 *
 * Exported because trackside scenery has to sit on the same frames as the road
 * or it leans against it — and because the banking roll is fiddly enough that a
 * second copy of it would drift.
 */
export function buildFrames(track: TrackData, plan: SectionPlan): Frame[] {
  const n = track.waypoints.length;
  const frames: Frame[] = new Array(n);
  let s = 0;

  for (let i = 0; i < n; i++) {
    const w = track.waypoints[i]!;
    const prev = track.waypoints[(i - 1 + n) % n]!.p;
    const next = track.waypoints[(i + 1) % n]!.p;

    // Central difference: a forward difference kinks the frame at every
    // waypoint on a tight corner, which shows up as banding on the road.
    let fx = next[0] - prev[0];
    let fy = next[1] - prev[1];
    let fz = next[2] - prev[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;

    // right0 = normalize(forward x worldUp), horizontal by construction.
    let rx = -fz;
    const ry = 0;
    let rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;

    // up0 = right0 x forward
    const ux = ry * fz - 0 * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    // Roll the frame by the banking angle about the forward axis.
    //
    // Positive banking LOWERS the right-hand edge. The sine is negated because
    // `up` here is right x forward, whereas vehicle/track-collision.ts rolls
    // about forward x right — the opposite sense. The physics builder defines
    // the convention, because the car drives on its surface; this renderer has
    // to match it or the visible road leans one way while the surface under the
    // wheels leans the other. See CHANGELOG-SHARED.md 2026-09-07T21:05Z.
    const cb = Math.cos(w.banking);
    const sb = -Math.sin(w.banking);
    const right: V3 = [rx * cb + ux * sb, ry * cb + uy * sb, rz * cb + uz * sb];
    const up: V3 = [ux * cb - rx * sb, uy * cb - ry * sb, uz * cb - rz * sb];

    frames[i] = {
      p: [w.p[0], w.p[1], w.p[2]],
      right,
      up,
      s,
      width: w.width,
      runoffL: plan.leftWidth[i]!,
      runoffR: plan.rightWidth[i]!,
    };

    const nx = track.waypoints[(i + 1) % n]!.p;
    s += Math.hypot(nx[0] - w.p[0], nx[1] - w.p[1], nx[2] - w.p[2]);
  }
  return frames;
}

/** Point on the section at signed lateral offset `d`. */
function sectionPoint(f: Frame, d: number): V3 {
  const rise = sectionRise(d, f.width, d < 0 ? f.runoffL : f.runoffR);
  return [
    f.p[0] + f.right[0] * d + f.up[0] * rise,
    f.p[1] + f.right[1] * d + f.up[1] * rise,
    f.p[2] + f.right[2] * d + f.up[2] * rise,
  ];
}

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

/**
 * Collects triangles for one material group.
 *
 * Quads are emitted as (a,b,c),(b,d,c) with `b` to the right of `a` and `c`
 * ahead of `a`, which makes the winding counter-clockwise seen from above and
 * the normal +up. Getting this backwards renders the road invisible from the
 * cockpit and is not obvious from a plan view, so it is asserted by the
 * face-normal check in build.ts rather than eyeballed.
 */
class Group {
  private pos: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];

  vertex(p: V3, u: number, v: number): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.uv.push(u, v);
    return i;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, b, d, c);
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /** Area-weighted vertex normals. Groups are separate meshes, so creases between them stay sharp. */
  finish(): MeshData {
    const positions = new Float32Array(this.pos);
    const indices = new Uint32Array(this.idx);
    const normals = new Float32Array(positions.length);

    for (let t = 0; t < indices.length; t += 3) {
      const ia = indices[t]! * 3;
      const ib = indices[t + 1]! * 3;
      const ic = indices[t + 2]! * 3;
      const ax = positions[ia]!;
      const ay = positions[ia + 1]!;
      const az = positions[ia + 2]!;
      const ux = positions[ib]! - ax;
      const uy = positions[ib + 1]! - ay;
      const uz = positions[ib + 2]! - az;
      const vx = positions[ic]! - ax;
      const vy = positions[ic + 1]! - ay;
      const vz = positions[ic + 2]! - az;
      // Un-normalised cross product, so larger triangles carry more weight.
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const i of [ia, ib, ic]) {
        normals[i] = normals[i]! + nx;
        normals[i + 1] = normals[i + 1]! + ny;
        normals[i + 2] = normals[i + 2]! + nz;
      }
    }

    for (let i = 0; i < normals.length; i += 3) {
      const l = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
      normals[i] = normals[i]! / l;
      normals[i + 1] = normals[i + 1]! / l;
      normals[i + 2] = normals[i + 2]! / l;
    }

    return { positions, normals, uvs: new Float32Array(this.uv), indices };
  }
}

/** Positions and indices only. */
class Solid {
  private pos: number[] = [];
  private idx: number[] = [];

  vertex(p: V3): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    return i;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, b, d, c);
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  finish(): CollisionData {
    return { vertices: new Float32Array(this.pos), indices: new Uint32Array(this.idx) };
  }
}

// ---------------------------------------------------------------------------

export function buildTrackMeshes(track: TrackData, opts: MeshOptions = {}): TrackMeshes {
  const stride = Math.max(1, Math.round(opts.collisionStride ?? 2));
  const section = planSection(track);
  const frames = buildFrames(track, section);
  const n = frames.length;

  // --- Collision: coarse rings, drivable surface only ----------------------
  const collision = new Solid();
  const ringIdx: number[] = [];
  for (let i = 0; i < n; i += stride) ringIdx.push(i);

  // Collision drops the centre column: the road is flat across its width, so a
  // single quad from edge to edge is exact and costs two triangles less.
  const collisionLat = (f: Frame): number[] => {
    const st = stations(f.width, f.runoffL, f.runoffR);
    return [st[0]!, st[1]!, st[2]!, st[4]!, st[5]!, st[6]!];
  };

  const collRings: number[][] = ringIdx.map((i) => {
    const f = frames[i]!;
    return collisionLat(f).map((d) => collision.vertex(sectionPoint(f, d)));
  });

  for (let r = 0; r < collRings.length; r++) {
    const a = collRings[r]!;
    const b = collRings[(r + 1) % collRings.length]!;
    for (let j = 0; j < a.length - 1; j++) {
      collision.quad(a[j]!, a[j + 1]!, b[j]!, b[j + 1]!);
    }
  }

  // --- Barriers ------------------------------------------------------------
  const barrierCollision = new Solid();
  const barrierVis = new Group();

  for (const side of [-1, 1] as const) {
    const base: number[] = [];
    const top: number[] = [];
    const vBase: number[] = [];
    const vTop: number[] = [];

    for (let r = 0; r < ringIdx.length; r++) {
      const f = frames[ringIdx[r]!]!;
      const d = side * outerHalfWidth(f.width, side < 0 ? f.runoffL : f.runoffR);
      const g = sectionPoint(f, d);
      const t: V3 = [g[0] + f.up[0] * BARRIER_HEIGHT, g[1] + f.up[1] * BARRIER_HEIGHT, g[2] + f.up[2] * BARRIER_HEIGHT];
      base.push(barrierCollision.vertex(g));
      top.push(barrierCollision.vertex(t));
      vBase.push(barrierVis.vertex(g, f.s, 0));
      vTop.push(barrierVis.vertex(t, f.s, 1));
    }

    for (let r = 0; r < ringIdx.length; r++) {
      const q = (r + 1) % ringIdx.length;
      // Wind so the front face points in toward the track on both sides.
      if (side > 0) {
        barrierCollision.quad(top[r]!, base[r]!, top[q]!, base[q]!);
        barrierVis.quad(vTop[r]!, vBase[r]!, vTop[q]!, vBase[q]!);
      } else {
        barrierCollision.quad(base[r]!, top[r]!, base[q]!, top[q]!);
        barrierVis.quad(vBase[r]!, vTop[r]!, vBase[q]!, vTop[q]!);
      }
    }
  }

  // --- Visual: full resolution, split by material --------------------------
  const asphalt = new Group();
  const kerb = new Group();
  const grass = new Group();
  const gravel = new Group();

  for (let i = 0; i < n; i++) {
    const f = frames[i]!;
    const g = frames[(i + 1) % n]!;
    // At the seam the arc length wraps to 0; keep it running so UVs do not tear.
    const sNext = i + 1 === n ? f.s + Math.hypot(g.p[0] - f.p[0], g.p[1] - f.p[1], g.p[2] - f.p[2]) : g.s;

    const st = stations(f.width, f.runoffL, f.runoffR);
    const sg = stations(g.width, g.runoffL, g.runoffR);

    /**
     * Emit one lateral band between station columns j and j+1 into `target`.
     *
     * `uOf` maps a lateral offset to a texture coordinate. It differs per
     * material because track width varies from 12.5 m to 16 m around the lap:
     * asphalt and kerb normalise across their own width so painted lines and
     * kerb stripes stay put, while grass and gravel use raw metres so their
     * texture tiles at a constant real-world scale instead of stretching.
     */
    const band = (target: Group, j: number, uOf: (d: number, width: number) => number): void => {
      const a = target.vertex(sectionPoint(f, st[j]!), uOf(st[j]!, f.width), f.s);
      const b = target.vertex(sectionPoint(f, st[j + 1]!), uOf(st[j + 1]!, f.width), f.s);
      const c = target.vertex(sectionPoint(g, sg[j]!), uOf(sg[j]!, g.width), sNext);
      const d = target.vertex(sectionPoint(g, sg[j + 1]!), uOf(sg[j + 1]!, g.width), sNext);
      target.quad(a, b, c, d);
    };

    const uAcrossRoad = (d: number, width: number): number => 0.5 + d / width;
    const uAcrossKerb = (d: number, width: number): number => (Math.abs(d) - width / 2) / KERB_WIDTH;
    const uMetres = (d: number): number => d;

    // Columns: 0=-r2 1=-r1 2=-hw 3=0 4=+hw 5=+r1 6=+r2
    band(section.leftKind[i] === 'gravel' ? gravel : grass, 0, uMetres);
    band(kerb, 1, uAcrossKerb);
    band(asphalt, 2, uAcrossRoad);
    band(asphalt, 3, uAcrossRoad);
    band(kerb, 4, uAcrossKerb);
    band(section.rightKind[i] === 'gravel' ? gravel : grass, 5, uMetres);
  }

  // --- Start/finish line ---------------------------------------------------
  // Sits just above the road rather than being cut into it: a 15 mm lift is
  // invisible at any camera angle the game uses and avoids z-fighting without
  // needing a depth-offset material.
  const startLine = new Group();
  {
    const f = frames[0]!;
    const g = frames[1 % n]!;
    const lift = 0.015;
    const hwA = f.width / 2;
    const hwB = g.width / 2;
    const raise = (p: V3, fr: Frame): V3 => [
      p[0] + fr.up[0] * lift,
      p[1] + fr.up[1] * lift,
      p[2] + fr.up[2] * lift,
    ];
    const a = startLine.vertex(raise(sectionPoint(f, -hwA), f), 0, 0);
    const b = startLine.vertex(raise(sectionPoint(f, hwA), f), 1, 0);
    const c = startLine.vertex(raise(sectionPoint(g, -hwB), g), 0, 1);
    const d = startLine.vertex(raise(sectionPoint(g, hwB), g), 1, 1);
    startLine.quad(a, b, c, d);
  }

  return {
    collision: collision.finish(),
    barrierCollision: barrierCollision.finish(),
    visual: {
      asphalt: asphalt.finish(),
      kerb: kerb.finish(),
      grass: grass.finish(),
      gravel: gravel.finish(),
      barrier: barrierVis.finish(),
      startLine: startLine.finish(),
    },
    section,
  };
}

/** Triangle counts, for build-time reporting and for keeping collision honest. */
export function meshStats(m: TrackMeshes): Record<string, number> {
  const tris = (c: CollisionData): number => c.indices.length / 3;
  const vtris = (v: MeshData): number => v.indices.length / 3;
  return {
    collision: tris(m.collision),
    barriers: tris(m.barrierCollision),
    asphalt: vtris(m.visual.asphalt),
    kerb: vtris(m.visual.kerb),
    grass: vtris(m.visual.grass),
    gravel: vtris(m.visual.gravel),
    barrierVisual: vtris(m.visual.barrier),
  };
}

export { KERB_WIDTH, BARRIER_HEIGHT };
export type { SurfaceKind };
