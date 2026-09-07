/**
 * Car models.
 *
 * Ten glTF stock cars live in `public/cars/`. They arrive in their own
 * convention — forward is +Z, the origin sits on the ground, and they are
 * 2.346 m wide against the 1.9 m the physics collider uses — so nothing can be
 * dropped straight into the scene. This module normalises one into something
 * `CarView` can drive:
 *
 *   - scaled so the body matches `CAR.width`, which lands the height on 1.088 m
 *     against `CAR.height` 1.1 without a second fudge factor
 *   - yawed 180 degrees, because cars face **-Z** here (HANDOFF.md §5.1)
 *   - lowered so the tyre contact patch sits where the physics puts it
 *   - split into a body and four wheel pivots, so the front wheels still steer
 *
 * **Draw calls are the budget here, not triangles.** Instance B measured the
 * environment at 17 draw calls; ten cars rendered a primitive at a time would
 * have added ninety more. Every opaque body material in the pack shares the
 * same metalness and roughness (0.12 / 0.52) and differs only in colour, so
 * they merge into one vertex-coloured mesh with *no* visual difference at all.
 * That plus one merged mesh per wheel is six draw calls a car, sixty for a
 * full grid.
 *
 * The merge is why damage is not wired up: it discards the four morph targets
 * (`FrontImpact` and friends) the pack ships. Nothing asked for damage, and
 * sixty draw calls against a hundred is the better trade for a demo that has to
 * survive unknown hardware. Keeping the body primitives unmerged is the switch
 * to flip if that changes.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { CAR, CAR_COLORS } from '../../../shared/constants';

/** One model per entry in `CAR_COLORS`, so a colour choice picks a livery. */
const MODEL_COUNT = CAR_COLORS.length;

/**
 * Where `CarView` rests a wheel centre, in car-local space. The old procedural
 * wheels used this and the ride height was tuned around it; the models are
 * aligned to the same datum so nothing about the stance changes.
 */
export const WHEEL_REST_Y = -0.2;

/** Materials that make up the opaque shell. All share metalness and roughness. */
const BODY_OPAQUE = new Set(['paint', 'accent', 'number', 'grille', 'light']);
/** Materials belonging to a wheel, split four ways by where they sit. */
const WHEEL_PARTS = new Set(['tire', 'wheel', 'brake']);

export interface WheelProto {
  /** Centred on the wheel's own axis, so the pivot can just rotate. */
  readonly geometry: THREE.BufferGeometry;
  readonly position: THREE.Vector3;
  /** Front wheels steer. Forward is -Z, so these are the ones at negative z. */
  readonly steered: boolean;
}

export interface CarModel {
  readonly body: THREE.BufferGeometry;
  readonly glass: THREE.BufferGeometry | null;
  readonly wheels: readonly WheelProto[];
}

/**
 * Shared across every car in the scene. Cloning these per instance would cost
 * memory and buy nothing — a `Mesh` carries its own transform, and neither the
 * geometry nor the material is written to after load.
 */
const bodyMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  metalness: 0.12,
  roughness: 0.52,
});

const glassMaterial = new THREE.MeshStandardMaterial({
  color: new THREE.Color().setRGB(0.045, 0.095, 0.125),
  metalness: 0.12,
  roughness: 0.12,
  transparent: true,
  opacity: 0.62,
  side: THREE.DoubleSide,
});

/**
 * Rubber, rim and brake caliper in one material. Their colours carry the read
 * at any distance a chase camera sees; the rim's metalness (0.75 against the
 * tyre's 0.12) does not survive the merge, so this sits between the two.
 */
const wheelMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  metalness: 0.35,
  roughness: 0.5,
});

export { bodyMaterial, glassMaterial, wheelMaterial };

const models: (CarModel | null)[] = new Array<CarModel | null>(MODEL_COUNT).fill(null);
let loading: Promise<void> | null = null;

/** Paints every vertex one colour, so geometries can be merged and still differ. */
function paint(geometry: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const n = geometry.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * The pack ships **positions only** — no normals on any primitive. A
 * MeshStandardMaterial with no normals renders pure black, which is exactly
 * what the first build did. The geometry is non-indexed by the time this runs,
 * so the computed normals are flat, and faceted is the look these low-poly
 * cars want anyway.
 */
function withNormals(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  return geometry;
}

/**
 * Only position, normal and colour survive. The pack carries morph targets and
 * per-primitive attributes that `mergeGeometries` refuses to combine unless
 * every input agrees, and none of them are used once merged.
 */
function stripped(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', geometry.getAttribute('position').clone());
  const normal = geometry.getAttribute('normal');
  if (normal) out.setAttribute('normal', normal.clone());
  const color = geometry.getAttribute('color');
  if (color) out.setAttribute('color', color.clone());
  return out;
}

/** Triangles whose centroid falls in one (x sign, z sign) quadrant. */
function quadrant(
  geometry: THREE.BufferGeometry,
  left: boolean,
  front: boolean,
): THREE.BufferGeometry | null {
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const col = geometry.getAttribute('color');
  const keep: number[] = [];

  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    // Forward is -Z, so a front wheel is one with a negative centroid z.
    if (cx < 0 === left && cz < 0 === front) keep.push(t, t + 1, t + 2);
  }
  if (keep.length === 0) return null;

  const out = new THREE.BufferGeometry();
  const position = new Float32Array(keep.length * 3);
  const normal = nrm ? new Float32Array(keep.length * 3) : null;
  const color = col ? new Float32Array(keep.length * 3) : null;

  keep.forEach((src, i) => {
    position[i * 3] = pos.getX(src);
    position[i * 3 + 1] = pos.getY(src);
    position[i * 3 + 2] = pos.getZ(src);
    if (normal && nrm) {
      normal[i * 3] = nrm.getX(src);
      normal[i * 3 + 1] = nrm.getY(src);
      normal[i * 3 + 2] = nrm.getZ(src);
    }
    if (color && col) {
      color[i * 3] = col.getX(src);
      color[i * 3 + 1] = col.getY(src);
      color[i * 3 + 2] = col.getZ(src);
    }
  });

  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  if (normal) out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  if (color) out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return out;
}

/** Turns one loaded glTF scene into a `CarModel`. */
function prepare(root: THREE.Object3D, colorIndex: number): CarModel {
  root.updateWorldMatrix(true, true);

  interface Part {
    geometry: THREE.BufferGeometry;
    name: string;
    color: THREE.Color;
  }
  const parts: Part[] = [];

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const material = o.material as THREE.MeshStandardMaterial;
    // toNonIndexed keeps the triangle split below trivial: three consecutive
    // vertices are always one face, with no index table to rebuild.
    const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld).toNonIndexed();
    parts.push({ geometry, name: material.name, color: material.color.clone() });
  });

  // Scale from the shell alone. Including a wing or a mirror in the bounds
  // would shrink the car to keep an appendage inside 1.9 m.
  const bounds = new THREE.Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    if (p.geometry.boundingBox) bounds.union(p.geometry.boundingBox);
  }
  const size = bounds.getSize(new THREE.Vector3());
  const scale = CAR.width / size.x;

  // Tyre bottom to the contact patch the physics uses, after scaling.
  const groundY = WHEEL_REST_Y - CAR.wheelRadius;
  const offsetY = groundY - bounds.min.y * scale;

  const transform = new THREE.Matrix4()
    .makeTranslation(0, offsetY, 0)
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI))
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));

  const bodyParts: THREE.BufferGeometry[] = [];
  const wheelParts: THREE.BufferGeometry[] = [];
  let glass: THREE.BufferGeometry | null = null;

  // The pack ships a distinct paint colour per model; override it so the car
  // matches the swatch the player actually clicked in the lobby.
  const chosen = new THREE.Color().setHex(
    CAR_COLORS[colorIndex % CAR_COLORS.length]!,
    THREE.SRGBColorSpace,
  );

  for (const part of parts) {
    part.geometry.applyMatrix4(transform);
    if (part.name === 'glass') {
      glass = withNormals(stripped(part.geometry));
    } else if (WHEEL_PARTS.has(part.name)) {
      wheelParts.push(stripped(paint(part.geometry, part.color)));
    } else if (BODY_OPAQUE.has(part.name)) {
      const color = part.name === 'paint' ? chosen : part.color;
      bodyParts.push(stripped(paint(part.geometry, color)));
    }
  }

  const body = mergeGeometries(bodyParts, false);
  if (!body) throw new Error('car model: body geometry would not merge');
  withNormals(body);
  body.computeBoundingSphere();

  const merged = mergeGeometries(wheelParts, false);
  if (!merged) throw new Error('car model: wheel geometry would not merge');
  // Before the split, so each quadrant inherits normals rather than needing its
  // own pass over geometry that is about to be cut up anyway.
  withNormals(merged);

  const wheels: WheelProto[] = [];
  for (const [left, front] of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ] as const) {
    const geometry = quadrant(merged, left, front);
    if (!geometry) continue;
    geometry.computeBoundingBox();
    const centre = geometry.boundingBox!.getCenter(new THREE.Vector3());
    // Re-centre on the axis so the pivot's rotation is the wheel's rotation.
    geometry.translate(-centre.x, -centre.y, -centre.z);
    geometry.computeBoundingSphere();
    wheels.push({ geometry, position: centre, steered: front });
  }

  return { body, glass, wheels };
}

/**
 * Fetches all ten models once. Called before the lobby is shown, so `CarView`
 * can stay synchronous — a car can appear the moment a roster arrives, and
 * waiting on a fetch at that point would mean building a placeholder and
 * swapping it later for no gain.
 *
 * Never rejects. A missing or malformed pack leaves `getCarModel` returning
 * null and `CarView` draws its boxes, which is worse-looking and still playable
 * — the demo does not deserve to die over an asset.
 */
export function preloadCarModels(): Promise<void> {
  if (loading) return loading;

  const loader = new GLTFLoader();
  loading = Promise.all(
    Array.from({ length: MODEL_COUNT }, async (_, i) => {
      const file = `/cars/web_stock_car_${String(i + 1).padStart(2, '0')}.gltf`;
      try {
        const gltf = await loader.loadAsync(file);
        models[i] = prepare(gltf.scene, i);
      } catch (err) {
        console.warn(`car model ${file} did not load; falling back to a box`, err);
      }
    }),
  ).then(() => undefined);

  return loading;
}

/** Null until `preloadCarModels()` resolves, and for any model that failed. */
export function getCarModel(colorIndex: number): CarModel | null {
  const n = MODEL_COUNT;
  return models[((colorIndex % n) + n) % n] ?? null;
}
