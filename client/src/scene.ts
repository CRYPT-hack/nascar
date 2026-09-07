/**
 * The game's renderer.
 *
 * Was a placeholder owned by Instance A ("replace it wholesale rather than
 * building on it"); this is that replacement. It keeps the exact public API
 * `main.ts` already calls — constructor(canvas), addTrack, resize, add, remove,
 * render, and the `scene`/`renderer` fields — so none of the netcode wiring
 * changes, and swaps the body for the real environment in client/src/render/.
 *
 * `CarView` and `carColor` are Instance A's and are kept as they were: car
 * meshes are assigned to neither instance (see STATUS-INSTANCE-B.md §3).
 */

import * as THREE from 'three';

import { CAR, CAR_COLORS } from '../../shared/constants';
import type { TrackData } from '../../shared/track-schema';
import { configureRenderer, createEnvironment } from './render/scene';
import { createGroundPlane, createTrackView, type TrackView } from './render/track-view';
import type { Q4, V3 } from '../../vehicle/math3';

export function carColor(index: number): number {
  return CAR_COLORS[((index % CAR_COLORS.length) + CAR_COLORS.length) % CAR_COLORS.length]!;
}

export class CarView {
  readonly group = new THREE.Group();
  private readonly wheels: THREE.Mesh[] = [];

  constructor(colorIndex: number, isLocal: boolean) {
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
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(x, -0.2, z);
      this.wheels.push(w);
      this.group.add(w);
    }
  }

  setPose(p: V3, q: Q4): void {
    this.group.position.set(p.x, p.y, p.z);
    this.group.quaternion.set(q.x, q.y, q.z, q.w);
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
