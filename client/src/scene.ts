/**
 * The game's renderer.
 *
 * Was a placeholder owned by Instance A ("replace it wholesale rather than
 * building on it"); this is that replacement. It keeps the exact public API
 * `main.ts` already calls — constructor(canvas), addTrack, resize, add, remove,
 * render, and the `scene`/`renderer` fields — so none of the netcode wiring
 * changes, and swaps the body for the real environment in client/src/render/.
 *
 * `CarView` and `carColor` are Instance A's. Car meshes were assigned to
 * neither instance (STATUS-INSTANCE-B.md §3); Instance A has taken them. The
 * geometry is built in render/car-mesh.ts from the dimensions in
 * shared/constants.ts, so the car drawn is the size of the car that collides.
 * The old boxes stay as a fallback that nothing should now reach.
 */

import * as THREE from 'three';

import { CAR, CAR_COLORS } from '../../shared/constants';
import type { TrackData } from '../../shared/track-schema';
import { configureRenderer, createEnvironment } from './render/scene';
import {
  bodyMaterial,
  getCarModel,
  WHEEL_REST_Y,
  type CarModel,
} from './render/car-mesh';
import { createGroundPlane, createTrackView, type TrackView } from './render/track-view';
import type { Q4, V3 } from '../../vehicle/math3';

export function carColor(index: number): number {
  return CAR_COLORS[((index % CAR_COLORS.length) + CAR_COLORS.length) % CAR_COLORS.length]!;
}

export class CarView {
  readonly group = new THREE.Group();

  /** Steering pivots. 0 and 1 are the front pair; each holds the wheel mesh. */
  private readonly wheels: THREE.Object3D[] = [];
  /** The meshes inside those pivots, spun about X so the wheels look driven. */
  private readonly tyres: THREE.Object3D[] = [];

  private readonly wheelRadius = CAR.wheelRadius;
  private readonly last = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private posed = false;
  private roll = 0;

  constructor(colorIndex: number, isLocal: boolean) {
    const model = getCarModel(colorIndex);
    if (model) this.buildModel(model, isLocal);
    else this.buildBoxes(colorIndex, isLocal);
  }

  /** Geometry built to the physics dimensions by render/car-mesh.ts. */
  private buildModel(model: CarModel, isLocal: boolean): void {
    const body = new THREE.Mesh(model.body, bodyMaterial);
    body.castShadow = true;
    this.group.add(body);

    for (const w of model.wheels) {
      const pivot = new THREE.Object3D();
      pivot.position.copy(w.position);
      const tyre = new THREE.Mesh(w.geometry, bodyMaterial);
      tyre.castShadow = true;
      pivot.add(tyre);
      this.group.add(pivot);
      // Front pair first, so setSteer keeps addressing 0 and 1.
      if (w.steered) {
        this.wheels.unshift(pivot);
        this.tyres.unshift(tyre);
      } else {
        this.wheels.push(pivot);
        this.tyres.push(tyre);
      }
    }

    if (isLocal) this.group.add(localMarker(model.body));
  }

  /**
   * Fallback for a pack that did not load. Deliberately kept: a car that is a
   * box still races, and a missing asset should not end the demo.
   */
  private buildBoxes(colorIndex: number, isLocal: boolean): void {
    const color = carColor(colorIndex);

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(CAR.width, 0.68, CAR.length),
      new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.25 }),
    );
    body.position.y = 0;
    body.castShadow = true;
    this.group.add(body);

    // A wedge on top, so the front of the car is obvious at a glance. Players
    // spin, and a symmetric box gives no clue which way it is now pointing.
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(CAR.width * 0.62, 0.34, CAR.length * 0.3),
      new THREE.MeshStandardMaterial({
        color: isLocal ? 0xffffff : 0x101114,
        roughness: 0.6,
      }),
    );
    nose.position.set(0, 0.44, -CAR.length * 0.22);
    this.group.add(nose);

    const wheelGeo = new THREE.CylinderGeometry(CAR.wheelRadius, CAR.wheelRadius, 0.3, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9 });
    const hx = CAR.track / 2;
    const hz = CAR.wheelbase / 2;
    for (const [x, z] of [
      [-hx, -hz],
      [hx, -hz],
      [-hx, hz],
      [hx, hz],
    ] as const) {
      const pivot = new THREE.Object3D();
      pivot.position.set(x, WHEEL_REST_Y, z);
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      pivot.add(w);
      this.wheels.push(pivot);
      this.tyres.push(w);
      this.group.add(pivot);
    }
  }

  setPose(p: V3, q: Q4): void {
    this.group.position.set(p.x, p.y, p.z);
    this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.spin(p, q);
  }

  /**
   * Rolls the wheels from how far the car actually moved along its own nose,
   * rather than plumbing speed in from the netcode. Everything needed is
   * already in the pose, and it keeps `setPose` the only call site.
   */
  private spin(p: V3, q: Q4): void {
    if (!this.posed) {
      this.last.set(p.x, p.y, p.z);
      this.posed = true;
      return;
    }
    this.delta.set(p.x - this.last.x, p.y - this.last.y, p.z - this.last.z);
    this.last.set(p.x, p.y, p.z);

    // Forward is -Z (HANDOFF.md §5.1).
    this.forward.set(0, 0, -1).applyQuaternion(this.group.quaternion);
    const travelled = this.delta.dot(this.forward);
    // A reconciliation snap or a respawn is not distance travelled; a wheel
    // that whirls on a correction reads as a glitch.
    if (Math.abs(travelled) > 2) return;

    // Positive rotation about X carries the top of the wheel towards +Z, which
    // is backwards, so driving forwards winds the angle down.
    this.roll -= travelled / this.wheelRadius;
    for (const t of this.tyres) t.rotation.x = this.roll;
  }

  /** Steering angle is the physical wheel angle: positive is LEFT (see car.ts). */
  setSteer(angle: number): void {
    this.wheels[0]?.rotation.set(0, angle, 0);
    this.wheels[1]?.rotation.set(0, angle, 0);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}

/**
 * A blade above the local car's roof. The chase camera and the HUD both say
 * which car is yours until the moment you are in a pack of ten and the camera
 * is looking at six of them; this is for that moment.
 */
function localMarker(body: THREE.BufferGeometry): THREE.Mesh {
  body.computeBoundingBox();
  const top = body.boundingBox ? body.boundingBox.max.y : 0.5;
  const marker = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.34, 4),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x606060, roughness: 0.5 }),
  );
  marker.position.set(0, top + 0.32, 0);
  marker.rotation.x = Math.PI; // point down at the roof
  marker.castShadow = false;
  return marker;
}

export class Scene {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;

  private view: TrackView | null = null;
  private followShadow: ((t: THREE.Vector3) => void) | null = null;
  private readonly shadowTarget = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    configureRenderer(this.renderer);
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
  }

  /**
   * Build the world. Geometry comes from track/src/mesh.ts, which is generated
   * from the same waypoints the physics colliders are built from, so what you
   * drive on is what you see.
   *
   * Lighting and sky are added here rather than in the constructor because the
   * sky dome and shadow frustum are sized from the circuit, which is not known
   * until now. `main.ts` calls this immediately after constructing.
   */
  addTrack(track: TrackData): void {
    const env = createEnvironment(this.scene, extentOf(track));
    this.followShadow = env.followShadow;

    this.view = createTrackView(track);
    this.scene.add(this.view.root, createGroundPlane(track));
  }

  add(o: THREE.Object3D): void {
    this.scene.add(o);
  }

  remove(o: THREE.Object3D): void {
    this.scene.remove(o);
  }

  render(camera: THREE.Camera): void {
    // Drag the shadow frustum along with the camera. It is only 180 m across —
    // tight enough to give a car a real shadow, which means it has to follow
    // the action. The chase camera sits just behind the local car, so its
    // position is the right thing to track and needs nothing from main.ts.
    if (this.followShadow) {
      camera.getWorldPosition(this.shadowTarget);
      this.followShadow(this.shadowTarget);
    }
    this.renderer.render(this.scene, camera);
  }

  dispose(): void {
    this.view?.dispose();
  }
}

/** Half the larger horizontal span of the circuit, metres. */
function extentOf(track: TrackData): number {
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
  return Math.max(maxX - minX, maxZ - minZ) / 2;
}
