/**
 * Car geometry, built here rather than loaded.
 *
 * The supplied glTF pack was tried first and did not survive being looked at:
 * its side skirts sit outboard of the bodywork as thin detached blades several
 * metres long, the wheels are swallowed by a slab body with no arches cut for
 * them, and the silhouette is a doorstop. Its proportions are also its own —
 * 2.346 m wide against a 1.9 m collider — so any uniform scale that fixed one
 * dimension broke another.
 *
 * Building it means every dimension comes from `shared/constants.ts`, so the
 * car that is drawn is the size of the car that collides: 4.5 m long, 1.9 m
 * wide, wheels on the 2.8 m wheelbase and 1.6 m track, tyres of exactly
 * `CAR.wheelRadius`, sitting at `CAR.rideHeight`.
 *
 * Shading is flat — the geometry is non-indexed and normals are computed per
 * face. That is deliberate: the circuit, trees, stands and barriers are all
 * low-poly and flat-shaded, and a smooth-shaded car sitting in that world
 * looks like it wandered in from another game.
 *
 * Everything opaque merges into one vertex-coloured mesh, so a car is five
 * draw calls: the body and four wheels. Windows are painted into the cabin
 * rather than modelled as transparent glass, which keeps the count down and
 * sidesteps transparency sorting between ten overlapping cars.
 *
 * Author space here is **y measured up from the ground**, which keeps the
 * numbers readable; `GROUND_Y` shifts it into car-local space at the end.
 * Forward is -Z (HANDOFF.md §5.1).
 */

import * as THREE from 'three';

import { CAR, CAR_COLORS } from '../../../shared/constants';

/** Wheel centre height in car-local space; the ride height is tuned around it. */
export const WHEEL_REST_Y = -0.2;
/** Car-local y of the ground plane, i.e. where the tyres touch. */
const GROUND_Y = WHEEL_REST_Y - CAR.wheelRadius;

const HALF_L = CAR.length / 2; // 2.25
const AXLE_Z = CAR.wheelbase / 2; // 1.4
const HUB_X = CAR.track / 2; // 0.8
const TYRE_HALF = 0.13;

/** A lofted station: a rounded-rectangle cross-section at one point along z. */
interface Station {
  z: number;
  /** Half-width of the body at this station. */
  hw: number;
  /** Underside height. Rises over an axle, which is what cuts the wheel arch. */
  bottom: number;
  top: number;
}

/**
 * The shell, nose (-z) to tail (+z).
 *
 * The pairs either side of each axle are what make the arches: the underside
 * jumps from the sill line to above the tyre over a short run of z, so the
 * loft walls itself into an arch and the wheel shows through it.
 */
const BODY: Station[] = [
  { z: -HALF_L, hw: 0.74, bottom: 0.26, top: 0.6 },
  { z: -2.1, hw: 0.86, bottom: 0.17, top: 0.7 },
  { z: -1.9, hw: 0.93, bottom: 0.15, top: 0.76 },
  { z: -1.78, hw: 0.95, bottom: 0.66, top: 0.79 },
  { z: -AXLE_Z, hw: 0.95, bottom: 0.76, top: 0.81 },
  { z: -1.02, hw: 0.95, bottom: 0.66, top: 0.83 },
  { z: -0.9, hw: 0.93, bottom: 0.15, top: 0.84 },
  { z: -0.2, hw: 0.92, bottom: 0.14, top: 0.86 },
  { z: 0.55, hw: 0.92, bottom: 0.14, top: 0.86 },
  { z: 0.9, hw: 0.93, bottom: 0.15, top: 0.85 },
  { z: 1.02, hw: 0.95, bottom: 0.66, top: 0.84 },
  { z: AXLE_Z, hw: 0.95, bottom: 0.76, top: 0.83 },
  { z: 1.78, hw: 0.95, bottom: 0.66, top: 0.81 },
  { z: 1.9, hw: 0.93, bottom: 0.16, top: 0.79 },
  { z: 2.1, hw: 0.88, bottom: 0.18, top: 0.74 },
  { z: HALF_L, hw: 0.76, bottom: 0.26, top: 0.68 },
];

/**
 * The greenhouse. Its underside is buried below the shell's roofline so the
 * two interpenetrate and no seam can open up between them.
 */
const CABIN: Station[] = [
  { z: -0.66, hw: 0.54, bottom: 0.78, top: 0.86 },
  { z: -0.3, hw: 0.64, bottom: 0.78, top: 1.14 },
  { z: 0.1, hw: 0.68, bottom: 0.78, top: 1.26 },
  { z: 0.72, hw: 0.68, bottom: 0.78, top: 1.26 },
  { z: 1.04, hw: 0.62, bottom: 0.78, top: 1.08 },
  { z: 1.22, hw: 0.54, bottom: 0.78, top: 0.88 },
];

/** Which band of the cross-section a ring vertex belongs to. */
type Band = 'top' | 'side' | 'bottom';

interface RingPoint {
  x: number;
  y: number;
  band: Band;
}

/**
 * A rounded rectangle, counter-clockwise in XY viewed from +Z.
 *
 * The winding matters: lofting these nose-to-tail with quads
 * (a[j], a[j+1], b[j+1], b[j]) then puts every face outward. `tools/carmeshtest.ts`
 * checks that by signed volume rather than leaving it to the eye: an inside-out
 * closed mesh has negative volume, and inside-out is invisible in a screenshot
 * until the light happens to catch it.
 */
function ring(hw: number, bottom: number, top: number, r: number): RingPoint[] {
  const h = top - bottom;
  const rr = Math.max(0.001, Math.min(r, hw * 0.6, h * 0.45));
  const cx = hw - rr;
  const cyLo = bottom + rr;
  const cyHi = top - rr;
  const pts: RingPoint[] = [];
  const arc = (ax: number, ay: number, from: number, to: number, band: Band, steps: number) => {
    for (let i = 0; i <= steps; i++) {
      const t = from + ((to - from) * i) / steps;
      pts.push({ x: ax + Math.cos(t) * rr, y: ay + Math.sin(t) * rr, band });
    }
  };
  // Right side up, over the top, down the left, back along the bottom.
  arc(cx, cyLo, -Math.PI / 2, 0, 'side', 2);
  arc(cx, cyHi, 0, Math.PI / 2, 'top', 2);
  arc(-cx, cyHi, Math.PI / 2, Math.PI, 'top', 2);
  arc(-cx, cyLo, Math.PI, Math.PI * 1.5, 'side', 2);
  return pts;
}

/** One triangle's worth of positions, pushed flat. */
function tri(
  out: number[],
  a: THREE.Vector3Like,
  b: THREE.Vector3Like,
  c: THREE.Vector3Like,
): void {
  out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

interface Part {
  positions: number[];
  color: THREE.Color;
}

/**
 * Sweep a rounded-rectangle cross-section along the stations and cap both
 * ends. `bandColor` picks a colour per cross-section band, so an underside can
 * be dark without needing its own mesh.
 */
function loft(
  stations: Station[],
  radius: number,
  bandColor: (band: Band) => THREE.Color,
): Part[] {
  const rings = stations.map((s) =>
    ring(s.hw, s.bottom, s.top, radius).map((p) => ({
      band: p.band,
      v: new THREE.Vector3(p.x, p.y, s.z),
    })),
  );

  const byBand = new Map<Band, number[]>();
  const push = (band: Band): number[] => {
    let a = byBand.get(band);
    if (!a) byBand.set(band, (a = []));
    return a;
  };

  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i]!;
    const b = rings[i + 1]!;
    for (let j = 0; j < a.length; j++) {
      const k = (j + 1) % a.length;
      // The band of the leading edge decides the quad's colour.
      const out = push(a[j]!.band);
      tri(out, a[j]!.v, a[k]!.v, b[k]!.v);
      tri(out, a[j]!.v, b[k]!.v, b[j]!.v);
    }
  }

  // Caps. These are body panels, not underside, so they take the side colour;
  // taking the underside's made the entire tail read as a black wall. The nose
  // faces -Z, so its fan runs the other way round.
  const capColor = push('side');
  const nose = rings[0]!;
  const noseC = centroid(nose.map((p) => p.v));
  for (let j = 0; j < nose.length; j++) {
    const k = (j + 1) % nose.length;
    tri(capColor, noseC, nose[k]!.v, nose[j]!.v);
  }
  const tail = rings[rings.length - 1]!;
  const tailC = centroid(tail.map((p) => p.v));
  for (let j = 0; j < tail.length; j++) {
    const k = (j + 1) % tail.length;
    tri(capColor, tailC, tail[j]!.v, tail[k]!.v);
  }

  return [...byBand.entries()].map(([band, positions]) => ({
    positions,
    color: bandColor(band),
  }));
}

function centroid(v: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const p of v) c.add(p);
  return c.divideScalar(v.length);
}

/**
 * An axis-aligned box. `BoxGeometry` already winds outward.
 *
 * The extents are sorted because every part that appears on both sides is
 * written `box(s * a, s * b, ...)`, and for `s === -1` that arrives reversed.
 * A negative extent mirrors `BoxGeometry`, turning it inside out: the left
 * headlamps, sills and door panels all rendered as dark slivers while the
 * right-hand ones were fine.
 */
function box(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  color: THREE.Color,
): Part {
  [x0, x1] = x0 <= x1 ? [x0, x1] : [x1, x0];
  [y0, y1] = y0 <= y1 ? [y0, y1] : [y1, y0];
  [z0, z1] = z0 <= z1 ? [z0, z1] : [z1, z0];
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const flat = g.toNonIndexed();
  const positions = Array.from(flat.getAttribute('position').array as Float32Array);
  g.dispose();
  flat.dispose();
  return { positions, color };
}

/** Merge parts into one flat-shaded, vertex-coloured geometry. */
function merge(parts: Part[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.positions.length;
  const position = new Float32Array(n);
  const color = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    position.set(p.positions, o);
    for (let i = 0; i < p.positions.length; i += 3) {
      color[o + i] = p.color.r;
      color[o + i + 1] = p.color.g;
      color[o + i + 2] = p.color.b;
    }
    o += p.positions.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.translate(0, GROUND_Y, 0);
  g.computeVertexNormals(); // flat: the geometry is non-indexed
  g.computeBoundingSphere();
  return g;
}

/** Livery colours derived from the one colour the player actually picked. */
interface Livery {
  paint: THREE.Color;
  accent: THREE.Color;
  trim: THREE.Color;
  glass: THREE.Color;
  rim: THREE.Color;
  tyre: THREE.Color;
  lamp: THREE.Color;
  brake: THREE.Color;
}

function liveryFor(hex: number): Livery {
  const paint = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  // Relative luminance, so a light car gets a dark stripe and vice versa.
  const lum = paint.r * 0.2126 + paint.g * 0.7152 + paint.b * 0.0722;
  const accent =
    lum > 0.35
      ? new THREE.Color().setRGB(0.05, 0.05, 0.06)
      : new THREE.Color().setRGB(0.92, 0.92, 0.9);
  return {
    paint,
    accent,
    trim: new THREE.Color().setRGB(0.035, 0.037, 0.042),
    glass: new THREE.Color().setRGB(0.055, 0.075, 0.095),
    rim: new THREE.Color().setRGB(0.5, 0.52, 0.55),
    tyre: new THREE.Color().setRGB(0.03, 0.03, 0.033),
    lamp: new THREE.Color().setRGB(0.95, 0.93, 0.8),
    brake: new THREE.Color().setRGB(0.65, 0.08, 0.06),
  };
}

export interface WheelProto {
  readonly geometry: THREE.BufferGeometry;
  readonly position: THREE.Vector3;
  readonly steered: boolean;
}

export interface CarModel {
  readonly body: THREE.BufferGeometry;
  readonly wheels: readonly WheelProto[];
}

/** One shared material: every car differs only in its vertex colours. */
export const bodyMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  metalness: 0.15,
  roughness: 0.45,
});

/** Body, cabin and all the bolt-on detail, as one mesh. */
function buildBody(l: Livery): THREE.BufferGeometry {
  const parts: Part[] = [];

  parts.push(
    ...loft(BODY, 0.13, (band) => (band === 'bottom' ? l.trim : l.paint)),
    ...loft(CABIN, 0.1, (band) => (band === 'top' ? l.paint : l.glass)),
  );

  // Bonnet and roof stripe, in one run over the top of the car.
  parts.push(box(-0.15, 0.15, 0.855, 0.875, -1.95, -0.66, l.accent));
  parts.push(box(-0.13, 0.13, 1.255, 1.272, -0.2, 0.74, l.accent));

  // Door roundels, proud of the flank so they never z-fight with it.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.925, s * 0.945, 0.34, 0.72, -0.42, 0.36, l.accent));
  }

  // Sill under the doors, between the two arches only.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.9, s * 0.945, 0.12, 0.2, -0.88, 0.88, l.trim));
  }

  // Splitter and grille.
  parts.push(box(-0.78, 0.78, 0.11, 0.15, -HALF_L - 0.01, -2.0, l.trim));
  // Narrow enough to leave room for the lamps outboard of it: at full width the
  // lamps sat inside the grille and showed only as smudges through its face.
  parts.push(box(-0.4, 0.4, 0.3, 0.5, -HALF_L - 0.005, -2.16, l.trim));
  // Headlamps either side of it, standing slightly proud.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.44, s * 0.7, 0.36, 0.52, -HALF_L - 0.02, -2.14, l.lamp));
  }
  // Tail lamps.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.24, s * 0.62, 0.42, 0.58, 2.2, HALF_L + 0.02, l.brake));
  }

  // Rear spoiler: a blade standing on the trailing edge of the deck.
  parts.push(box(-0.84, 0.84, 0.76, 0.9, 1.98, 2.03, l.accent));

  return merge(parts);
}

/** Tyre, rim and hub as one mesh, centred on the wheel's own axis. */
function buildWheel(l: Livery): THREE.BufferGeometry {
  const parts: Part[] = [];
  const R = CAR.wheelRadius;

  const cyl = new THREE.CylinderGeometry(R, R, TYRE_HALF * 2, 16, 1, true);
  cyl.rotateZ(Math.PI / 2);
  const tread = cyl.toNonIndexed();
  parts.push({
    positions: Array.from(tread.getAttribute('position').array as Float32Array),
    color: l.tyre,
  });
  cyl.dispose();
  tread.dispose();

  // Open-ended above, so each face is a disc: rim outside, sidewall inside.
  for (const s of [-1, 1]) {
    const face = new THREE.CircleGeometry(R * 0.62, 16);
    // A CircleGeometry faces +Z; turn it to face out along its own axis.
    face.rotateY((s * Math.PI) / 2);
    face.translate(s * (TYRE_HALF + 0.004), 0, 0);
    const flat = face.toNonIndexed();
    parts.push({
      positions: Array.from(flat.getAttribute('position').array as Float32Array),
      color: l.rim,
    });
    face.dispose();
    flat.dispose();

    const wall = new THREE.RingGeometry(R * 0.62, R, 16);
    wall.rotateY((s * Math.PI) / 2);
    wall.translate(s * TYRE_HALF, 0, 0);
    const wallFlat = wall.toNonIndexed();
    parts.push({
      positions: Array.from(wallFlat.getAttribute('position').array as Float32Array),
      color: l.tyre,
    });
    wall.dispose();
    wallFlat.dispose();

    const hub = new THREE.CircleGeometry(R * 0.2, 10);
    hub.rotateY((s * Math.PI) / 2);
    hub.translate(s * (TYRE_HALF + 0.008), 0, 0);
    const hubFlat = hub.toNonIndexed();
    parts.push({
      positions: Array.from(hubFlat.getAttribute('position').array as Float32Array),
      color: l.trim,
    });
    hub.dispose();
    hubFlat.dispose();
  }

  // merge() shifts into car-local space; a wheel is already centred on its own
  // axis, so undo that here rather than giving merge a second mode.
  const g = merge(parts);
  g.translate(0, -GROUND_Y, 0);
  g.computeBoundingSphere();
  return g;
}

/** Build one car. Cheap enough that ten of them is not worth deferring. */
export function buildCarModel(colorHex: number): CarModel {
  const l = liveryFor(colorHex);
  const body = buildBody(l);
  const wheel = buildWheel(l);

  const wheels: WheelProto[] = [];
  // Front pair first, so `setSteer` keeps addressing 0 and 1.
  for (const [z, steered] of [
    [-AXLE_Z, true],
    [AXLE_Z, false],
  ] as const) {
    for (const s of [-1, 1]) {
      wheels.push({
        // One geometry, four meshes: nothing writes to it after this.
        geometry: wheel,
        position: new THREE.Vector3(s * HUB_X, WHEEL_REST_Y, z),
        steered,
      });
    }
  }
  // Order is FL, FR, RL, RR.
  return { body, wheels };
}

// ---------------------------------------------------------------------------
// One model per entry in CAR_COLORS, so picking a colour picks a livery.

const models: CarModel[] = [];

/**
 * Build all ten up front.
 *
 * Kept async, and called alongside the track fetch, because that is the shape
 * the boot already had when the models were downloaded. Nothing is fetched now
 * — ten cars take a few milliseconds — but building them here rather than on
 * first sight of a car keeps the hitch out of the first corner.
 */
export function preloadCarModels(): Promise<void> {
  if (models.length === 0) {
    for (const hex of CAR_COLORS) models.push(buildCarModel(hex));
  }
  return Promise.resolve();
}

export function getCarModel(colorIndex: number): CarModel | null {
  if (models.length === 0) preloadCarModels();
  const n = models.length;
  return models[((colorIndex % n) + n) % n] ?? null;
}
