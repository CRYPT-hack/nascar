/**
 * PLACEHOLDER RENDERER — Instance B owns presentation (HANDOFF.md §4).
 *
 * This exists so the car is drivable and the netcode is verifiable before the
 * real visuals land. It draws the track straight from the same generator the
 * physics uses, at a finer step, plus box cars. Nothing here is meant to
 * survive; replace it wholesale rather than building on it.
 *
 * The one thing worth keeping is `carColor()` and the wheel placement, which
 * read from the frozen constants and the vehicle module rather than from
 * hard-coded numbers.
 */

import * as THREE from 'three';

import { CAR, CAR_COLORS } from '../../shared/constants';
import type { SurfaceKind } from '../../shared/protocol';
import type { TrackData } from '../../shared/track-schema';
import { buildTrackCollision } from '../../vehicle/track-collision';
import type { Q4, V3 } from '../../vehicle/math3';

const SURFACE_COLOR: Record<SurfaceKind, number> = {
  asphalt: 0x35383d,
  kerb: 0xb5453f,
  grass: 0x33502f,
  gravel: 0x8a7a5c,
};

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

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.scene.background = new THREE.Color(0x0f1420);
    this.scene.fog = new THREE.Fog(0x0f1420, 220, 900);

    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x2a2a20, 1.15);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2dc, 1.5);
    sun.position.set(180, 320, -140);
    this.scene.add(sun);
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
  }

  /**
   * Build the track from the same generator the physics uses, at every
   * waypoint rather than every other one. Same source, so what you drive on is
   * what you see - a mismatch between the two is the sort of bug that gets
   * blamed on the netcode for a full day.
   */
  addTrack(track: TrackData): void {
    const meshes = buildTrackCollision(track, 1);

    for (const s of meshes.surfaces) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(s.data.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(s.data.indices, 1));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: SURFACE_COLOR[s.kind],
        roughness: s.kind === 'asphalt' ? 0.95 : 1,
        side: THREE.DoubleSide,
      });
      this.scene.add(new THREE.Mesh(geo, mat));
    }

    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(meshes.barriers.positions, 3));
    bg.setIndex(new THREE.BufferAttribute(meshes.barriers.indices, 1));
    bg.computeVertexNormals();
    this.scene.add(
      new THREE.Mesh(
        bg,
        new THREE.MeshStandardMaterial({ color: 0xdfe3ea, roughness: 0.8, side: THREE.DoubleSide }),
      ),
    );

    this.addStartLine(track);
  }

  /** A visible start/finish line, so lap timing is legible on camera. */
  private addStartLine(track: TrackData): void {
    const w0 = track.waypoints[0]!;
    const w1 = track.waypoints[1]!;
    const fx = w1.p[0] - w0.p[0];
    const fz = w1.p[2] - w0.p[2];
    const fl = Math.hypot(fx, fz) || 1;
    const geo = new THREE.PlaneGeometry(w0.width, 1.6);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xf2f2f7, roughness: 0.7 }),
    );
    mesh.position.set(w0.p[0], w0.p[1] + 0.03, w0.p[2]);
    mesh.rotation.y = Math.atan2(fx / fl, -(fz / fl));
    this.scene.add(mesh);
  }

  add(o: THREE.Object3D): void {
    this.scene.add(o);
  }

  remove(o: THREE.Object3D): void {
    this.scene.remove(o);
  }

  render(camera: THREE.Camera): void {
    this.renderer.render(this.scene, camera);
  }
}
