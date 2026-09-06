/**
 * Geometry self-checks, run as part of `npm run track:build`.
 *
 * These exist because the server consumes this geometry and the other instance
 * cannot reasonably be asked to debug it. Every check here corresponds to a
 * failure that is expensive to diagnose from inside the game:
 *
 *   - inverted winding      road is invisible from the cockpit, looks like a
 *                           camera or culling bug
 *   - mesh/sampler drift    car on visible asphalt gets grass friction, looks
 *                           like a netcode bug (HANDOFF.md §10)
 *   - NaN in a vertex       Rapier silently produces no collider and cars fall
 *                           through the world
 *   - ribbon overlap        two parts of the lap share space; a car clips into
 *                           geometry from a different corner
 */

import type { TrackData } from '../../shared/track-schema';
import { minSelfClearance } from './generate';
import { buildTrackMeshes, type CollisionData, type MeshData, type TrackMeshes } from './mesh';
import { TrackSampler } from './sampler';
import { KERB_WIDTH, outerHalfWidth, type SectionPlan } from './section';

/**
 * Barrier line position in the XZ plane, on one side, at waypoint `i`.
 * Banking is ignored: this is a plan-view question about whether the offset
 * curve doubles back, and the vertical component cannot affect that.
 */
function barrierPoint(
  track: TrackData,
  plan: SectionPlan,
  side: 'leftWidth' | 'rightWidth',
  i: number,
): [number, number] {
  const n = track.waypoints.length;
  const w = track.waypoints[i]!;
  const prev = track.waypoints[(i - 1 + n) % n]!.p;
  const next = track.waypoints[(i + 1) % n]!.p;
  const fx = next[0] - prev[0];
  const fz = next[2] - prev[2];
  const fl = Math.hypot(fx, fz) || 1;
  const rx = -fz / fl;
  const rz = fx / fl;
  const d = (side === 'leftWidth' ? -1 : 1) * outerHalfWidth(w.width, plan[side][i]!);
  return [w.p[0] + rx * d, w.p[2] + rz * d];
}

export interface CheckResult {
  problems: string[];
  stats: Record<string, number>;
}

function isFiniteArray(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return false;
  return true;
}

function indicesInRange(indices: Uint32Array, vertexCount: number): boolean {
  for (let i = 0; i < indices.length; i++) if (indices[i]! >= vertexCount) return false;
  return true;
}

/** Fraction of triangles whose geometric normal points upward, or null if empty. */
function upwardFraction(m: MeshData): number | null {
  const { positions, indices } = m;
  let up = 0;
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]! * 3;
    const ib = indices[t + 1]! * 3;
    const ic = indices[t + 2]! * 3;
    const ux = positions[ib]! - positions[ia]!;
    const uy = positions[ib + 1]! - positions[ia + 1]!;
    const uz = positions[ib + 2]! - positions[ia + 2]!;
    const vx = positions[ic]! - positions[ia]!;
    const vy = positions[ic + 1]! - positions[ia + 1]!;
    const vz = positions[ic + 2]! - positions[ia + 2]!;
    const ny = uz * vx - ux * vz;
    const nx = uy * vz - uz * vy;
    const nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) < 1e-9) continue;
    total++;
    if (ny > 0) up++;
  }
  // A circuit with no tight corners has no gravel and therefore no gravel mesh.
  // That is legitimate, not an inverted one.
  return total === 0 ? null : up / total;
}

function degenerateCount(m: MeshData | CollisionData): number {
  const positions = 'positions' in m ? m.positions : m.vertices;
  const { indices } = m;
  let bad = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]! * 3;
    const ib = indices[t + 1]! * 3;
    const ic = indices[t + 2]! * 3;
    const ux = positions[ib]! - positions[ia]!;
    const uy = positions[ib + 1]! - positions[ia + 1]!;
    const uz = positions[ib + 2]! - positions[ia + 2]!;
    const vx = positions[ic]! - positions[ia]!;
    const vy = positions[ic + 1]! - positions[ia + 1]!;
    const vz = positions[ic + 2]! - positions[ia + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    // Half the cross-product magnitude is the area; 1 cm^2 is well below
    // anything the generator should produce at 3 m spacing.
    if (0.5 * Math.hypot(nx, ny, nz) < 1e-4) bad++;
  }
  return bad;
}

export function checkTrackGeometry(track: TrackData): CheckResult {
  const problems: string[] = [];
  const meshes: TrackMeshes = buildTrackMeshes(track);
  const sampler = new TrackSampler(track, meshes.section);
  const n = track.waypoints.length;

  // --- Structural ---------------------------------------------------------
  const groups: [string, MeshData][] = Object.entries(meshes.visual);
  for (const [name, g] of groups) {
    if (!isFiniteArray(g.positions)) problems.push(`visual.${name}: non-finite position`);
    if (!isFiniteArray(g.normals)) problems.push(`visual.${name}: non-finite normal`);
    if (!indicesInRange(g.indices, g.positions.length / 3)) problems.push(`visual.${name}: index out of range`);
    const deg = degenerateCount(g);
    if (deg > 0) problems.push(`visual.${name}: ${deg} degenerate triangles`);
  }

  for (const [name, c] of [
    ['collision', meshes.collision],
    ['barrierCollision', meshes.barrierCollision],
  ] as [string, CollisionData][]) {
    if (!isFiniteArray(c.vertices)) problems.push(`${name}: non-finite vertex`);
    if (!indicesInRange(c.indices, c.vertices.length / 3)) problems.push(`${name}: index out of range`);
    if (c.indices.length === 0) problems.push(`${name}: empty`);
  }

  // --- Winding ------------------------------------------------------------
  // Road surfaces must face up or they are invisible from the car.
  for (const name of ['asphalt', 'kerb', 'grass', 'gravel'] as const) {
    const f = upwardFraction(meshes.visual[name]);
    if (f !== null && f < 0.999) {
      problems.push(`visual.${name}: ${((1 - f) * 100).toFixed(1)}% of triangles wound downward`);
    }
  }

  // --- Collision is simpler than visual (HANDOFF.md §5.3) -----------------
  const visualTris = groups.reduce((s, [, g]) => s + g.indices.length / 3, 0);
  const collisionTris = meshes.collision.indices.length / 3;
  if (collisionTris >= visualTris) {
    problems.push(`collision (${collisionTris} tris) is not simpler than visual (${visualTris} tris)`);
  }

  // --- Sampler agrees with the geometry it was built from -----------------
  let maxCentreLateral = 0;
  let maxHeightErr = 0;
  for (let i = 0; i < n; i++) {
    const w = track.waypoints[i]!;
    const q = sampler.query(w.p[0], w.p[2]);
    maxCentreLateral = Math.max(maxCentreLateral, Math.abs(q.lateral));
    maxHeightErr = Math.max(maxHeightErr, Math.abs(q.groundY - w.p[1]));
    if (q.surface !== 'asphalt') {
      problems.push(`sampler: centreline of waypoint ${i} reports "${q.surface}"`);
      break;
    }
  }
  if (maxCentreLateral > 0.05) problems.push(`sampler: centreline lateral error up to ${maxCentreLateral.toFixed(3)} m`);
  if (maxHeightErr > 0.01) problems.push(`sampler: centreline height error up to ${maxHeightErr.toFixed(4)} m`);

  // --- Surface bands land where the geometry puts them --------------------
  // Walk out sideways from a spread of waypoints and confirm the transitions.
  const probe = (i: number, frac: number): string => {
    const w = track.waypoints[i]!;
    const nb = track.waypoints[(i + 1) % n]!;
    const ex = nb.p[0] - w.p[0];
    const ez = nb.p[2] - w.p[2];
    const el = Math.hypot(ex, ez) || 1;
    const rx = -ez / el;
    const rz = ex / el;
    const d = frac;
    return sampler.query(w.p[0] + rx * d, w.p[2] + rz * d).surface;
  };

  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 40))) {
    const hw = track.waypoints[i]!.width / 2;
    const inner = probe(i, hw * 0.9);
    const onKerb = probe(i, hw + KERB_WIDTH * 0.5);
    const offTrack = probe(i, hw + KERB_WIDTH + 3);
    if (inner !== 'asphalt') problems.push(`surface band: ${hw * 0.9} m from centre at wp ${i} is "${inner}"`);
    if (onKerb !== 'kerb') problems.push(`surface band: kerb strip at wp ${i} is "${onKerb}"`);
    if (offTrack !== 'grass' && offTrack !== 'gravel') {
      problems.push(`surface band: run-off at wp ${i} is "${offTrack}"`);
    }
  }

  // --- Run-off must not fold over itself on the inside of a corner --------
  //
  // Deliberately measured from the built geometry rather than re-derived from
  // the curvature sign. An earlier version of this check recomputed "which side
  // is the inside" the same way section.ts did, so when that convention was
  // backwards the check agreed with the bug and passed. Asking instead whether
  // the barrier line actually advances along the lap cannot share that mistake.
  let worstReversal = 0;
  for (const side of ['leftWidth', 'rightWidth'] as const) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = barrierPoint(track, meshes.section, side, i);
      const b = barrierPoint(track, meshes.section, side, j);
      const fx = track.waypoints[j]!.p[0] - track.waypoints[i]!.p[0];
      const fz = track.waypoints[j]!.p[2] - track.waypoints[i]!.p[2];
      const dot = (b[0] - a[0]) * fx + (b[1] - a[1]) * fz;
      if (dot < 0) worstReversal = Math.max(worstReversal, -dot);
    }
  }
  if (worstReversal > 1e-9) {
    problems.push(`barrier line runs backwards against the centreline (worst ${worstReversal.toFixed(2)}) — run-off folds`);
  }

  // --- The ribbon must not overlap itself ---------------------------------
  let footprint = 0;
  for (let i = 0; i < n; i++) {
    const w = track.waypoints[i]!.width;
    footprint = Math.max(
      footprint,
      outerHalfWidth(w, meshes.section.leftWidth[i]!),
      outerHalfWidth(w, meshes.section.rightWidth[i]!),
    );
  }
  const clearance = minSelfClearance(track);
  if (footprint * 2 > clearance) {
    problems.push(
      `run-off overlaps itself: footprint 2x${footprint.toFixed(1)} m vs clearance ${clearance.toFixed(1)} m`,
    );
  }

  // --- Gravel is placed, but has not eaten the circuit --------------------
  const gravelWaypoints =
    meshes.section.leftKind.filter((s) => s === 'gravel').length +
    meshes.section.rightKind.filter((s) => s === 'gravel').length;
  const gravelFrac = gravelWaypoints / (n * 2);

  return {
    problems,
    stats: {
      collisionTris,
      barrierTris: meshes.barrierCollision.indices.length / 3,
      visualTris,
      collisionRatio: Number((collisionTris / visualTris).toFixed(3)),
      gravelPercent: Number((gravelFrac * 100).toFixed(1)),
      footprintHalfWidth: Number(footprint.toFixed(1)),
      maxCentreLateral: Number(maxCentreLateral.toFixed(4)),
      maxHeightErr: Number(maxHeightErr.toFixed(5)),
    },
  };
}
