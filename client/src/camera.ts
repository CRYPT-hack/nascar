/**
 * Chase camera.
 *
 * Follows the car's *velocity* rather than its heading once moving. A camera
 * rigidly bolted to the chassis yaw swings violently the moment the car steps
 * out of line, which is exactly when the player most needs to see where they
 * are going. Blending toward the direction of travel keeps the horizon steady
 * through a slide and still points down the road on a straight.
 *
 * Instance B owns presentation; this exists so the car is drivable before the
 * real one lands, and because camera feel is inseparable from how responsive
 * the controls seem.
 */

import * as THREE from 'three';

import { clamp, type Q4, type V3 } from '../../vehicle/math3';

export interface CameraTuning {
  /** Metres behind the car at rest. */
  distance: number;
  /** Extra metres of trail per m/s of speed. */
  distancePerSpeed: number;
  height: number;
  /** Metres ahead of the car the camera looks. */
  lookAhead: number;
  /** Position smoothing time constant, seconds. */
  posTau: number;
  /** Direction smoothing time constant, seconds. */
  dirTau: number;
  /** Field of view at rest, degrees, and how much it opens with speed. */
  fov: number;
  fovPerSpeed: number;
}

export const CHASE: CameraTuning = {
  distance: 7.2,
  distancePerSpeed: 0.055,
  height: 2.9,
  lookAhead: 9,
  posTau: 0.1,
  dirTau: 0.16,
  fov: 66,
  fovPerSpeed: 0.22,
};

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private readonly tuning: CameraTuning;

  private smoothedDir = new THREE.Vector3(0, 0, -1);
  private smoothedPos = new THREE.Vector3();
  private target = new THREE.Vector3();
  private started = false;

  constructor(aspect: number, tuning: CameraTuning = CHASE) {
    this.tuning = tuning;
    this.camera = new THREE.PerspectiveCamera(tuning.fov, aspect, 0.25, 4000);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Snap to the car without smoothing. Use on spawn and after a respawn. */
  reset(): void {
    this.started = false;
  }

  update(dt: number, p: V3, q: Q4, velocity: V3): void {
    const t = this.tuning;

    const heading = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(q.x, q.y, q.z, q.w),
    );
    heading.y = 0;
    if (heading.lengthSq() < 1e-6) heading.set(0, 0, -1);
    heading.normalize();

    const speed = Math.hypot(velocity.x, velocity.z);
    const travel = new THREE.Vector3(velocity.x, 0, velocity.z);
    // Below walking pace the velocity direction is noise; above it, blend
    // toward it so a slide does not whip the camera around.
    const blend = clamp((speed - 2) / 12, 0, 1) * 0.65;
    const desiredDir =
      travel.lengthSq() > 1e-6
        ? heading.clone().lerp(travel.normalize(), blend).normalize()
        : heading.clone();

    if (!this.started) {
      this.smoothedDir.copy(desiredDir);
      this.started = true;
    } else {
      const kDir = 1 - Math.exp(-dt / t.dirTau);
      this.smoothedDir.lerp(desiredDir, kDir).normalize();
    }

    const back = t.distance + speed * t.distancePerSpeed;
    const desiredPos = new THREE.Vector3(p.x, p.y, p.z)
      .addScaledVector(this.smoothedDir, -back)
      .add(new THREE.Vector3(0, t.height, 0));

    if (this.smoothedPos.lengthSq() === 0) this.smoothedPos.copy(desiredPos);
    const kPos = 1 - Math.exp(-dt / t.posTau);
    this.smoothedPos.lerp(desiredPos, kPos);

    this.camera.position.copy(this.smoothedPos);

    this.target
      .set(p.x, p.y + 0.8, p.z)
      .addScaledVector(this.smoothedDir, t.lookAhead);
    this.camera.lookAt(this.target);

    const fov = t.fov + speed * t.fovPerSpeed;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
