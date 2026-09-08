/**
 * Keyboard and gamepad input.
 *
 * Produces a `CarInput` in the frozen protocol's shape. Positive `steer` is
 * RIGHT (see CHANGELOG-SHARED.md); nothing here negates it, and nothing
 * downstream should either.
 *
 * Keyboard steering is ramped rather than binary. A key is either down or up,
 * but a car whose steering snaps to full lock on keydown is undriveable at
 * speed, and every player at the demo will be on a keyboard.
 */

import type { CarInput } from '../../shared/protocol';
import { clamp } from '../../vehicle/math3';

/** Seconds from centre to full lock when a steering key is held. */
const STEER_ATTACK = 0.22;
/** Seconds from full lock back to centre when released. Faster than attack. */
const STEER_RELEASE = 0.12;
/** Seconds to ramp throttle and brake. Short - these want to feel immediate. */
const PEDAL_ATTACK = 0.08;
const PEDAL_RELEASE = 0.14;

const KEYS = {
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  handbrake: ['Space'],
  reset: ['KeyR'],
  quality: ['KeyQ'],
  camera: ['KeyC'],
} as const;

export class InputSource {
  private readonly down = new Set<string>();
  private steer = 0;
  private throttle = 0;
  private brake = 0;

  /** Set for one frame when the player asks to be respawned. */
  resetRequested = false;
  qualityRequested = false;
  cameraRequested = false;

  /** True while the player is typing into a form, so driving keys are ignored. */
  suspended = false;

  /**
   * Optional external controller, checked ahead of the gamepad.
   *
   * Used by the phone-as-steering-wheel link. Returning null means "not
   * driving", and the keyboard takes over — which is what happens the moment a
   * phone locks its screen or leaves Wi-Fi range.
   */
  external: (() => CarInput | null) | null = null;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.suspended) return;
    if (isTypingTarget(e.target)) return;
    if (this.isGameKey(e.code)) e.preventDefault();
    this.down.add(e.code);
    if (KEYS.reset.includes(e.code as never)) this.resetRequested = true;
    if (KEYS.quality.includes(e.code as never)) this.qualityRequested = true;
    if (KEYS.camera.includes(e.code as never)) this.cameraRequested = true;
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private readonly onBlur = (): void => {
    // Without this, alt-tabbing mid-corner leaves the key latched down and the
    // car drives into a wall while the player is looking at something else.
    this.down.clear();
  };

  constructor(private readonly target: Window = window) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
  }

  private isGameKey(code: string): boolean {
    for (const list of Object.values(KEYS)) if ((list as readonly string[]).includes(code)) return true;
    return false;
  }

  private held(list: readonly string[]): boolean {
    for (const k of list) if (this.down.has(k)) return true;
    return false;
  }

  /** Sample the current input. `dt` is the time since the last sample. */
  sample(dt: number): CarInput {
    const remote = this.external?.() ?? null;
    if (remote) {
      // Mirror into the ramp state so releasing the phone hands over from
      // wherever the wheel actually was, rather than snapping to centre.
      this.steer = remote.steer;
      this.throttle = remote.throttle;
      this.brake = remote.brake;
      return { ...remote, handbrake: remote.handbrake || this.held(KEYS.handbrake) };
    }

    const pad = readGamepad();

    if (pad) {
      this.steer = pad.steer;
      this.throttle = pad.throttle;
      this.brake = pad.brake;
      return { ...pad, handbrake: pad.handbrake || this.held(KEYS.handbrake) };
    }

    const wantSteer = (this.held(KEYS.right) ? 1 : 0) - (this.held(KEYS.left) ? 1 : 0);
    this.steer = ramp(this.steer, wantSteer, dt, STEER_ATTACK, STEER_RELEASE);
    this.throttle = ramp(this.throttle, this.held(KEYS.up) ? 1 : 0, dt, PEDAL_ATTACK, PEDAL_RELEASE);
    this.brake = ramp(this.brake, this.held(KEYS.down) ? 1 : 0, dt, PEDAL_ATTACK, PEDAL_RELEASE);

    return {
      throttle: this.throttle,
      brake: this.brake,
      steer: this.steer,
      handbrake: this.held(KEYS.handbrake),
    };
  }

  takeResetRequest(): boolean {
    const r = this.resetRequested;
    this.resetRequested = false;
    return r;
  }

  takeQualityRequest(): boolean {
    const q = this.qualityRequested;
    this.qualityRequested = false;
    return q;
  }

  takeCameraRequest(): boolean {
    const c = this.cameraRequested;
    this.cameraRequested = false;
    return c;
  }
}

/**
 * Move `current` toward `want`. Returning toward centre uses the release rate,
 * which is faster, so a correction can be unwound quicker than it was applied.
 */
function ramp(current: number, want: number, dt: number, attack: number, release: number): number {
  const returning = Math.abs(want) < Math.abs(current) || Math.sign(want) !== Math.sign(current);
  const rate = dt / (returning ? release : attack);
  const d = want - current;
  return clamp(current + Math.sign(d) * Math.min(Math.abs(d), rate), -1, 1);
}

/** First connected gamepad, mapped to the standard layout. */
function readGamepad(): CarInput | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  for (const gp of navigator.getGamepads()) {
    if (!gp || !gp.connected) continue;
    const axes = gp.axes ?? [];
    const buttons = gp.buttons ?? [];
    const steerRaw = axes[0] ?? 0;
    const steer = Math.abs(steerRaw) < 0.08 ? 0 : clamp(steerRaw, -1, 1); // deadzone
    const throttle = buttons[7]?.value ?? 0;
    const brake = buttons[6]?.value ?? 0;
    const handbrake = (buttons[0]?.pressed ?? false) || (buttons[1]?.pressed ?? false);
    // Ignore a pad that is present but idle, so it does not override keyboard.
    if (steer === 0 && throttle === 0 && brake === 0 && !handbrake) continue;
    return { throttle, brake, steer, handbrake };
  }
  return null;
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}
