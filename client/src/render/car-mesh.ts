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
 * sidesteps transparency sorting between ten overlapping cars. The racing
 * numbers are built from segments for the same reason — no texture means no
 * UV unwrap of a lofted surface, and no atlas to load.
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
const TYRE_HALF = 0.135;
const R = CAR.wheelRadius;

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
  { z: -HALF_L, hw: 0.7, bottom: 0.26, top: 0.56 },
  { z: -2.12, hw: 0.84, bottom: 0.17, top: 0.66 },
  { z: -1.9, hw: 0.92, bottom: 0.15, top: 0.74 },
  { z: -1.78, hw: 0.95, bottom: 0.66, top: 0.77 },
  { z: -AXLE_Z, hw: 0.95, bottom: 0.76, top: 0.8 },
  { z: -1.02, hw: 0.95, bottom: 0.66, top: 0.83 },
  { z: -0.9, hw: 0.93, bottom: 0.15, top: 0.84 },
  { z: -0.2, hw: 0.92, bottom: 0.14, top: 0.86 },
  { z: 0.55, hw: 0.92, bottom: 0.14, top: 0.86 },
  { z: 0.9, hw: 0.93, bottom: 0.15, top: 0.85 },
  { z: 1.02, hw: 0.95, bottom: 0.66, top: 0.84 },
  { z: AXLE_Z, hw: 0.95, bottom: 0.76, top: 0.82 },
  { z: 1.78, hw: 0.95, bottom: 0.66, top: 0.8 },
  { z: 1.9, hw: 0.93, bottom: 0.16, top: 0.78 },
  { z: 2.12, hw: 0.87, bottom: 0.18, top: 0.73 },
  { z: HALF_L, hw: 0.74, bottom: 0.26, top: 0.66 },
];

/**
 * The greenhouse. Its underside is buried below the shell's roofline so the
 * two interpenetrate and no seam can open up between them.
 *
 * Raked hard at the front and tapered at the back: an upright box sitting on
 * the shell was the single thing that most made this read as a toy.
 */
const CABIN: Station[] = [
  { z: -0.88, hw: 0.5, bottom: 0.78, top: 0.84 },
  { z: -0.54, hw: 0.62, bottom: 0.78, top: 1.06 },
  { z: -0.12, hw: 0.68, bottom: 0.78, top: 1.24 },
  { z: 0.5, hw: 0.68, bottom: 0.78, top: 1.26 },
  { z: 0.92, hw: 0.63, bottom: 0.78, top: 1.12 },
  { z: 1.26, hw: 0.52, bottom: 0.78, top: 0.86 },
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

/** Take a three.js primitive as a flat part, consuming the geometry. */
function shape(g: THREE.BufferGeometry, color: THREE.Color): Part {
  const flat = g.index ? g.toNonIndexed() : g;
  const positions = Array.from(flat.getAttribute('position').array as Float32Array);
  if (flat !== g) flat.dispose();
  g.dispose();
  return { positions, color };
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
  return shape(g, color);
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

// ---------------------------------------------------------------------------
// Racing numbers.

/**
 * Seven-segment rectangles in a unit square, u right and v up. Segments rather
 * than a font because the alternative is a texture, and a texture means UV
 * unwrapping a lofted body for the sake of two digits.
 */
const SEGMENTS: Record<string, [number, number, number, number]> = {
  a: [0.16, 0.84, 0.86, 1.0],
  b: [0.84, 1.0, 0.52, 0.9],
  c: [0.84, 1.0, 0.1, 0.48],
  d: [0.16, 0.84, 0.0, 0.14],
  e: [0.0, 0.16, 0.1, 0.48],
  f: [0.0, 0.16, 0.52, 0.9],
  g: [0.16, 0.84, 0.43, 0.57],
};

const DIGITS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgecd',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abfgcd',
};

/** Maps a unit-square rect onto the car, as an axis-aligned box. */
type Placement = (
  u0: number,
  u1: number,
  v0: number,
  v1: number,
) => [number, number, number, number, number, number];

function digitParts(text: string, place: Placement, color: THREE.Color): Part[] {
  const parts: Part[] = [];
  const n = text.length;
  const gap = 0.14;
  const w = (1 - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const on = DIGITS[text[i]!] ?? '';
    const u0 = i * (w + gap);
    for (const s of on) {
      const [su0, su1, sv0, sv1] = SEGMENTS[s]!;
      parts.push(box(...place(u0 + su0 * w, u0 + su1 * w, sv0, sv1), color));
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------

/** Livery colours derived from the one colour the player actually picked. */
interface Livery {
  paint: THREE.Color;
  /** Contrasts with the paint, so stripes read on light and dark cars alike. */
  accent: THREE.Color;
  /** A darker cast of the paint, for the lower flank. */
  shade: THREE.Color;
  trim: THREE.Color;
  glass: THREE.Color;
  rim: THREE.Color;
  tyre: THREE.Color;
  disc: THREE.Color;
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
    shade: paint.clone().multiplyScalar(0.55),
    trim: new THREE.Color().setRGB(0.035, 0.037, 0.042),
    glass: new THREE.Color().setRGB(0.05, 0.07, 0.09),
    rim: new THREE.Color().setRGB(0.62, 0.64, 0.68),
    tyre: new THREE.Color().setRGB(0.03, 0.03, 0.033),
    disc: new THREE.Color().setRGB(0.28, 0.29, 0.31),
    lamp: new THREE.Color().setRGB(0.95, 0.93, 0.8),
    brake: new THREE.Color().setRGB(0.7, 0.09, 0.07),
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
  metalness: 0.2,
  roughness: 0.42,
});

/** Body, cabin and all the bolt-on detail, as one mesh. */
function buildBody(l: Livery, raceNumber: number): THREE.BufferGeometry {
  const parts: Part[] = [];

  parts.push(
    ...loft(BODY, 0.13, (band) => (band === 'bottom' ? l.trim : l.paint)),
    ...loft(CABIN, 0.1, (band) => (band === 'top' ? l.paint : l.glass)),
  );

  // A darker band along the lower flank. Breaks up what is otherwise one slab
  // of colour from sill to roof, and reads as a shadow line at any distance.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.912, s * 0.938, 0.2, 0.42, -1.68, 1.7, l.shade));
  }

  // Twin bonnet stripes, running back to the base of the windscreen.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.05, s * 0.17, 0.855, 0.872, -1.98, -0.88, l.accent));
  }

  const text = String(raceNumber);

  // Door roundel with the car's number on it. The number is painted in the body
  // colour, which contrasts with the roundel whichever way the accent went.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.918, s * 0.936, 0.3, 0.74, -0.46, 0.4, l.accent));
    parts.push(
      ...digitParts(
        text,
        (u0, u1, v0, v1) => [
          s * 0.936,
          s * 0.95,
          0.34 + v0 * 0.36,
          0.34 + v1 * 0.36,
          // Numbers read nose-first down both flanks, so u runs towards -z on
          // the right of the car and towards +z on the left.
          -s * (-0.4 + u0 * 0.74),
          -s * (-0.4 + u1 * 0.74),
        ],
        l.paint,
      ),
    );
  }

  // Roof number, which is what a chase camera behind and above actually sees.
  parts.push(
    ...digitParts(
      text,
      (u0, u1, v0, v1) => [
        -0.28 + u0 * 0.56,
        -0.28 + u1 * 0.56,
        1.262,
        1.278,
        0.4 - v0 * 0.6,
        0.4 - v1 * 0.6,
      ],
      l.accent,
    ),
  );

  // Sill under the doors, between the two arches only.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.9, s * 0.945, 0.12, 0.2, -0.88, 0.88, l.trim));
  }

  // Splitter, tucked inside the nose rather than hung off it.
  parts.push(box(-0.74, 0.74, 0.11, 0.15, -HALF_L - 0.01, -2.0, l.trim));
  // Narrow enough to leave room for the lamps outboard of it: at full width the
  // lamps sat inside the grille and showed only as smudges through its face.
  parts.push(box(-0.38, 0.38, 0.3, 0.5, -HALF_L - 0.005, -2.16, l.trim));
  // Headlamps either side of it, standing slightly proud.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.42, s * 0.64, 0.36, 0.52, -HALF_L - 0.02, -2.14, l.lamp));
  }
  // Tail lamps.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.24, s * 0.6, 0.42, 0.58, 2.2, HALF_L + 0.02, l.brake));
  }
  // Exhaust tips under the rear valance.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.28, s * 0.42, 0.19, 0.28, 2.18, HALF_L + 0.04, l.rim));
  }

  // Wing mirrors on stalks, at the base of the A-pillar.
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.7, s * 0.82, 0.86, 0.9, -0.64, -0.52, l.trim));
    parts.push(box(s * 0.79, s * 0.88, 0.86, 0.98, -0.66, -0.52, l.accent));
  }

  // Rear spoiler: a blade standing on the trailing edge of the deck.
  parts.push(box(-0.84, 0.84, 0.76, 0.9, 1.98, 2.03, l.accent));
  for (const s of [-1, 1]) {
    parts.push(box(s * 0.78, s * 0.84, 0.72, 0.9, 1.9, 2.03, l.trim));
  }

  return merge(parts);
}

/**
 * Tyre, rim, spokes, brake disc and caliper as one mesh, centred on the
 * wheel's own axis.
 *
 * The wheels earn the detail: they are the only part of the car that moves
 * against the bodywork, and a flat grey disc sitting in a wheel arch is a large
 * part of what made the first attempt read as a toy.
 */
function buildWheel(l: Livery): THREE.BufferGeometry {
  const parts: Part[] = [];
  const RIM = R * 0.62;

  const tread = new THREE.CylinderGeometry(R, R, TYRE_HALF * 2, 18, 1, true);
  tread.rotateZ(Math.PI / 2);
  parts.push(shape(tread, l.tyre));

  // The barrel behind the spokes, so the wheel is not see-through.
  const barrel = new THREE.CylinderGeometry(RIM, RIM, TYRE_HALF * 1.9, 14, 1, true);
  barrel.rotateZ(Math.PI / 2);
  parts.push(shape(barrel, l.trim));

  for (const s of [-1, 1]) {
    const face = s * TYRE_HALF;

    // Sidewall: the annulus between tread and rim.
    const wall = new THREE.RingGeometry(RIM, R, 18);
    wall.rotateY((s * Math.PI) / 2);
    wall.translate(face, 0, 0);
    parts.push(shape(wall, l.tyre));

    // Brake disc, set inboard so it shows between the spokes.
    const disc = new THREE.CircleGeometry(RIM * 0.86, 14);
    disc.rotateY((s * Math.PI) / 2);
    disc.translate(face - s * 0.055, 0, 0);
    parts.push(shape(disc, l.disc));

    // Caliper straddling the top of the disc.
    parts.push(
      box(face - s * 0.085, face - s * 0.025, RIM * 0.5, RIM * 0.92, -0.035, 0.035, l.brake),
    );

    // Five spokes. Each is a box lifted to the rim's mid-radius and then
    // rotated about the axle, so they radiate rather than sit in a row.
    for (let i = 0; i < 5; i++) {
      const spoke = new THREE.BoxGeometry(0.022, RIM * 0.92, 0.055);
      spoke.translate(0, RIM * 0.48, 0);
      spoke.rotateX((i * Math.PI * 2) / 5);
      spoke.translate(face - s * 0.006, 0, 0);
      parts.push(shape(spoke, l.rim));
    }

    // Hub cap over the middle of them.
    const hub = new THREE.CylinderGeometry(RIM * 0.3, RIM * 0.3, 0.03, 10);
    hub.rotateZ(Math.PI / 2);
    hub.translate(face + s * 0.006, 0, 0);
    parts.push(shape(hub, l.rim));
  }

  // merge() shifts into car-local space; a wheel is already centred on its own
  // axis, so undo that here rather than giving merge a second mode.
  const g = merge(parts);
  g.translate(0, -GROUND_Y, 0);
  g.computeBoundingSphere();
  return g;
}

/**
 * Build one car. `colorIndex` picks both the paint from `CAR_COLORS` and the
 * racing number, so the number on the door identifies the car in the roster.
 */
export function buildCarModel(colorIndex: number): CarModel {
  const n = CAR_COLORS.length;
  const i = ((colorIndex % n) + n) % n;
  const l = liveryFor(CAR_COLORS[i]!);
  const body = buildBody(l, i + 1);
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
    for (let i = 0; i < CAR_COLORS.length; i++) models.push(buildCarModel(i));
  }
  return Promise.resolve();
}

export function getCarModel(colorIndex: number): CarModel | null {
  if (models.length === 0) preloadCarModels();
  const n = models.length;
  return models[((colorIndex % n) + n) % n] ?? null;
}
