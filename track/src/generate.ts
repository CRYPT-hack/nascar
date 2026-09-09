/**
 * CircuitSpec -> TrackData (shared/track-schema.ts).
 *
 * Pipeline: spline the control polygon -> resample at fixed spacing -> apply
 * the elevation/width/banking profiles -> rotate so the start/finish waypoint
 * is index 0 -> rigidly transform the whole loop so that waypoint sits at the
 * origin facing -Z (HANDOFF.md 5.1) -> emit checkpoints and the spawn grid.
 *
 * Profiles are authored against control point indices. Those are converted to
 * arc-length positions here, so a profile key stays attached to the geometry it
 * describes no matter how the rest of the layout is edited.
 */

import type { SurfaceKind, Vec3 } from '../../shared/protocol';
import type { Checkpoint, SpawnSlot, TrackData, Waypoint } from '../../shared/track-schema';
import { MAX_PLAYERS } from '../../shared/constants';
import { MIN_TRACK_WIDTH, measureLapLength, validateTrack } from '../../shared/track-schema';
import type { CircuitSpec, ControlKey } from './circuits';
import { arcLengths, curvature, resampleByArcLength, sampleClosed, smoothClosed, type P2 } from './spline';

/** Samples per control-point segment when densifying the spline. */
const SUBDIV = 48;

/** Banking gain: radians of bank per 1/m of curvature. Interlagos is barely banked. */
const BANK_GAIN = 2.2;
const MAX_BANK = 0.09; // ~5 degrees

/**
 * Hard ceiling on gradient. Real circuits top out around 10%; past that a car
 * grounds out on the transitions and the chase camera swings badly. The
 * elevation profile is authored for intent and then clamped to this, so no
 * amount of enthusiasm in circuits.ts can produce a track that cannot be driven.
 */
const MAX_GRADIENT = 0.085;

/** Grid geometry - HANDOFF.md 5.3 spawnGrid. */
const GRID_ROW_GAP = 6; // metres between successive cars, along the centreline
const GRID_LATERAL = 3.2; // metres either side of the centreline
const GRID_SETBACK = 12; // metres behind the line for the pole slot
const GRID_HEIGHT = 0.25; // metres above the surface, so nobody starts intersecting it

export interface Diagnostics {
  lapLength: number;
  minWidth: number;
  maxGradient: number;
  minRadius: number;
  selfIntersections: number;
  minClearance: number;
  elevationRange: [number, number];
  /** [corner name, lap fraction] for the corners named in the spec. */
  corners: [string, number][];
}

export interface GenerateResult {
  track: TrackData;
  diagnostics: Diagnostics;
}

export function generateTrack(spec: CircuitSpec): GenerateResult {
  // --- 1. Scale the control polygon, then spline and resample --------------
  const scaled: P2[] = spec.control.map(([x, z]) => [x * spec.scale, z * spec.scale] as P2);
  const dense = sampleClosed(scaled, SUBDIV);
  const denseArc = arcLengths(dense);

  /** Arc length along the loop at each control point. */
  const controlS = spec.control.map((_, i) => denseArc.cum[i * SUBDIV]!);
  const total = denseArc.total;

  const pts = resampleByArcLength(dense, spec.spacing);
  const n = pts.length;
  const step = total / n;

  // --- 2. Profiles, evaluated in the unrotated order -----------------------
  const elevKeys = toArcKeys(spec.elevation, controlS);
  const widthKeys = toArcKeys(spec.width, controlS);

  const rawHeights = limitGradient(
    pts.map((_, i) => evalLoopKeys(elevKeys, i * step, total) * spec.scale),
    pts,
    MAX_GRADIENT,
  );
  const rawWidths = pts.map((_, i) => Math.max(MIN_TRACK_WIDTH, evalLoopKeys(widthKeys, i * step, total)));

  const rawCurv = curvature(pts);
  const curv = smoothClosed(rawCurv, Math.max(2, Math.round(6 / spec.spacing) * 2));

  // --- 3. Choose the start/finish waypoint ---------------------------------
  const startTarget: P2 = [spec.startNear[0] * spec.scale, spec.startNear[1] * spec.scale];
  let sf = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(pts[i]![0] - startTarget[0], pts[i]![1] - startTarget[1]);
    if (d < bestD) {
      bestD = d;
      sf = i;
    }
  }
  const rot = <T>(a: T[]): T[] => a.slice(sf).concat(a.slice(0, sf));

  const loop = rot(pts);
  const heights = rot(rawHeights);
  const widths = rot(rawWidths);
  // Positive curvature has its apex on the right (measured; see section.ts),
  // and positive banking LOWERS the right-hand edge (see CHANGELOG-SHARED.md
  // 2026-09-07T21:05Z). So `+k` lowers the inside of a right-hand corner, which
  // is correct camber.
  //
  // Do not "fix" this sign without reading that changelog entry. It was flipped
  // once on the reasoning that positive banking raises the right edge — true of
  // the renderer's own frame at the time, but the opposite of what the physics
  // builder in vehicle/track-collision.ts does, and the physics is what the car
  // drives on. Ten of ten AI cars finished before that change and two of ten
  // after it.
  const banks = rot(curv).map((k) => clamp(k * BANK_GAIN, -MAX_BANK, MAX_BANK));

  // --- 4. Build waypoints in the authoring frame ---------------------------
  const wps: Waypoint[] = loop.map((p, i) => ({
    i,
    p: [p[0], heights[i]!, p[1]] as Vec3,
    width: round(widths[i]!, 3),
    banking: round(banks[i]!, 5),
    surface: 'asphalt' as SurfaceKind,
  }));

  // --- 5. Rigid transform: waypoint 0 at origin, forward tangent = -Z -------
  transformToStartFrame(wps);

  // --- 6. Checkpoints ------------------------------------------------------
  const checkpoints: Checkpoint[] = [];
  for (let c = 0; c < spec.checkpointCount; c++) {
    const idx = Math.round((c * n) / spec.checkpointCount) % n;
    checkpoints.push(c === 0 ? { idx: 0, isStartFinish: true } : { idx });
  }
  for (let c = 1; c < checkpoints.length; c++) {
    if (checkpoints[c]!.idx <= checkpoints[c - 1]!.idx) {
      checkpoints[c]!.idx = checkpoints[c - 1]!.idx + 1;
    }
  }

  const track: TrackData = {
    name: spec.name,
    scale: spec.scale,
    lapLengthMeters: 0,
    waypoints: wps,
    checkpoints,
    spawnGrid: buildSpawnGrid(wps, spec.spacing),
    // Meshes are generated procedurally from these waypoints by track/src/mesh.ts
    // on both server and client rather than shipped as GLB. See CHANGELOG-SHARED.md.
    collisionMesh: 'procedural:collision',
    visualMesh: 'procedural:visual',
    surfaces: {
      asphalt: { friction: 1.0, drag: 0.0 },
      kerb: { friction: 0.9, drag: 0.02 },
      grass: { friction: 0.4, drag: 0.35 },
      gravel: { friction: 0.25, drag: 0.6 },
    },
  };
  track.lapLengthMeters = round(measureLapLength(track), 1);

  const errs = validateTrack(track);
  if (errs.length) {
    throw new Error(`generated track "${spec.name}" is invalid:\n  ${errs.join('\n  ')}`);
  }

  // Corner lap fractions, measured from the start/finish rather than from
  // control point 0, so they line up with what the HUD will report.
  const corners: [string, number][] = spec.corners.map(([ci, name]) => {
    const s = controlS[ci] ?? 0;
    const u = (((s / total) * n - sf + n) % n) / n;
    return [name, round(u, 3)];
  });

  return { track, diagnostics: diagnose(track, curv, corners) };
}

// ---------------------------------------------------------------------------
// Profile evaluation
// ---------------------------------------------------------------------------

/** Convert [controlIndex, value] keys to [arcLength, value], sorted. */
function toArcKeys(keys: ControlKey[], controlS: number[]): [number, number][] {
  const out = keys.map(([ci, v]) => [controlS[ci] ?? 0, v] as [number, number]);
  out.sort((a, b) => a[0] - b[0]);
  if (out.length === 0) throw new Error('profile has no keys');
  return out;
}

/**
 * Smoothstep interpolation between sparse keys around a closed loop.
 * Zero derivative at each key, so profile changes ease in and out rather than
 * putting a crease in the road surface.
 */
function evalLoopKeys(keys: [number, number][], s: number, total: number): number {
  const m = keys.length;
  if (m === 1) return keys[0]![1];

  let i = m - 1;
  for (let k = 0; k < m; k++) {
    if (keys[k]![0] <= s) i = k;
    else break;
  }
  const a = keys[i]!;
  const b = keys[(i + 1) % m]!;
  let span = b[0] - a[0];
  if (span <= 0) span += total; // wrapped past the seam
  let d = s - a[0];
  if (d < 0) d += total;
  const w = span > 1e-9 ? clamp(d / span, 0, 1) : 0;
  return a[1] + (b[1] - a[1]) * (w * w * (3 - 2 * w));
}

/**
 * Clamp the gradient of a closed height profile to `maxGrad` by Gauss-Seidel
 * relaxation: wherever a step is too steep, pull its two endpoints together by
 * half the excess each. Mean height is preserved, so the profile sags toward
 * its own average rather than drifting. Converges in well under the iteration
 * budget for anything an author would plausibly write.
 */
function limitGradient(h: number[], pts: P2[], maxGrad: number): number[] {
  const n = h.length;
  const out = h.slice();
  const ds = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    ds[i] = Math.max(1e-3, Math.hypot(b[0] - a[0], b[1] - a[1]));
  }

  for (let iter = 0; iter < 20000; iter++) {
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const maxDy = maxGrad * ds[i]!;
      const dy = out[j]! - out[i]!;
      const over = Math.abs(dy) - maxDy;
      if (over > 1e-9) {
        const fix = (over / 2) * Math.sign(dy);
        out[i] = out[i]! + fix;
        out[j] = out[j]! - fix;
        worst = Math.max(worst, over);
      }
    }
    if (worst < 1e-4) break;
  }
  return out;
}

// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/**
 * Translate + rotate about Y so waypoint 0 is at the origin with its forward
 * tangent pointing along -Z. Elevation is shifted so waypoint 0 sits at y = 0.
 */
function transformToStartFrame(wps: Waypoint[]): void {
  const n = wps.length;
  const o: Vec3 = [wps[0]!.p[0], wps[0]!.p[1], wps[0]!.p[2]];
  const nx = wps[1]!.p;

  const heading = Math.atan2(nx[0] - o[0], -(nx[2] - o[2])); // angle from -Z toward +X
  const c = Math.cos(-heading);
  const s = Math.sin(-heading);

  for (let i = 0; i < n; i++) {
    const p = wps[i]!.p;
    const x = p[0] - o[0];
    const y = p[1] - o[1];
    const z = p[2] - o[2];
    wps[i]!.p = [round(x * c + z * s, 4), round(y, 4), round(-x * s + z * c, 4)];
  }
}

function buildSpawnGrid(wps: Waypoint[], spacing: number): SpawnSlot[] {
  const n = wps.length;
  const slots: SpawnSlot[] = [];
  const stepsPerRow = GRID_ROW_GAP / spacing;
  const setbackSteps = GRID_SETBACK / spacing;

  for (let i = 0; i < MAX_PLAYERS; i++) {
    // Walk backwards along the centreline from the start/finish line.
    const back = setbackSteps + i * stepsPerRow;
    const idx = ((Math.round(-back) % n) + n) % n;
    const here = wps[idx]!;
    const next = wps[(idx + 1) % n]!;

    const fx = next.p[0] - here.p[0];
    const fz = next.p[2] - here.p[2];
    const fl = Math.hypot(fx, fz) || 1;
    // right = forward x up  ->  (-fz, 0, fx), normalised
    const rx = -fz / fl;
    const rz = fx / fl;

    const side = i % 2 === 0 ? -1 : 1;
    slots.push({
      p: [
        round(here.p[0] + rx * GRID_LATERAL * side, 3),
        round(here.p[1] + GRID_HEIGHT, 3),
        round(here.p[2] + rz * GRID_LATERAL * side, 3),
      ],
      // rotY is measured from -Z, matching the spawn convention in 5.1.
      rotY: round(Math.atan2(fx, -fz), 5),
    });
  }
  return slots;
}

function diagnose(t: TrackData, curv: number[], corners: [string, number][]): Diagnostics {
  const n = t.waypoints.length;
  let minWidth = Infinity;
  let maxGrad = 0;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const w = t.waypoints[i]!;
    minWidth = Math.min(minWidth, w.width);
    minY = Math.min(minY, w.p[1]);
    maxY = Math.max(maxY, w.p[1]);
    const b = t.waypoints[(i + 1) % n]!;
    const run = Math.hypot(b.p[0] - w.p[0], b.p[2] - w.p[2]);
    if (run > 1e-6) maxGrad = Math.max(maxGrad, Math.abs(b.p[1] - w.p[1]) / run);
  }

  const maxCurv = curv.reduce((m, k) => Math.max(m, Math.abs(k)), 0);

  return {
    lapLength: t.lapLengthMeters,
    minWidth: round(minWidth, 2),
    maxGradient: round(maxGrad, 4),
    minRadius: maxCurv > 1e-6 ? round(1 / maxCurv, 1) : Infinity,
    selfIntersections: countSelfIntersections(t),
    minClearance: round(minSelfClearance(t), 1),
    elevationRange: [round(minY, 2), round(maxY, 2)],
    corners,
  };
}

/**
 * Count crossings between non-adjacent centreline segments. A track that
 * crosses itself is a generator bug, not a design choice - this must be 0.
 */
export function countSelfIntersections(t: TrackData): number {
  const n = t.waypoints.length;
  const p = t.waypoints.map((w) => [w.p[0], w.p[2]] as P2);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const a1 = p[i]!;
    const a2 = p[(i + 1) % n]!;
    for (let j = i + 4; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // shares the seam vertex
      if (segmentsCross(a1, a2, p[j]!, p[(j + 1) % n]!)) hits++;
    }
  }
  return hits;
}

function segmentsCross(a1: P2, a2: P2, b1: P2, b2: P2): boolean {
  const d = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/**
 * Minimum centreline distance between parts of the loop that are far apart
 * along the lap. If this drops below the local track width the ribbons overlap
 * even though the centrelines never actually cross.
 */
export function minSelfClearance(t: TrackData): number {
  const n = t.waypoints.length;
  const p = t.waypoints.map((w) => [w.p[0], w.p[2]] as P2);
  let best = Infinity;
  const gap = Math.max(20, Math.round(n * 0.05));
  for (let i = 0; i < n; i++) {
    for (let j = i + gap; j < n; j++) {
      if (n - (j - i) < gap) continue; // still adjacent going the other way round
      const d = Math.hypot(p[i]![0] - p[j]![0], p[i]![1] - p[j]![1]);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Where the tightest pinch is, for build-time reporting. */
export function tightestPinch(t: TrackData): { d: number; a: number; b: number } {
  const n = t.waypoints.length;
  const p = t.waypoints.map((w) => [w.p[0], w.p[2]] as P2);
  let best = { d: Infinity, a: 0, b: 0 };
  const gap = Math.max(20, Math.round(n * 0.05));
  for (let i = 0; i < n; i++) {
    for (let j = i + gap; j < n; j++) {
      if (n - (j - i) < gap) continue;
      const d = Math.hypot(p[i]![0] - p[j]![0], p[i]![1] - p[j]![1]);
      if (d < best.d) best = { d, a: i, b: j };
    }
  }
  return best;
}
