/**
 * Client-side prediction and reconciliation for the local car.
 *
 * The local car is simulated immediately from local input, so the car responds
 * on the frame the key is pressed rather than a round trip later. The server is
 * still authoritative: every snapshot carries `ackSeq`, the last input whose
 * effects are included in that state, and anything sent after it is replayed on
 * top of the corrected state.
 *
 * Two rules make this work, and breaking either produces symptoms that look
 * like a broken network rather than a broken client:
 *
 *  1. Each input is applied for exactly `TICKS_PER_INPUT` steps, matching the
 *     server. Clients send at 30 Hz and the server runs at 60.
 *  2. Corrections move the *physics* car instantly and the *rendered* car
 *     gradually. Snapping the rendered car is what rubber-banding actually is.
 */

import { FIXED_DT, INPUT_HZ, MAX_PENDING_INPUTS } from '../../shared/constants';
import type { CarInput, CarSnap } from '../../shared/protocol';
import { Car, type CarState } from '../../vehicle/car';
import { add, clamp, lerpV3, scale, slerp, sub, type Q4, type V3 } from '../../vehicle/math3';
import type { RaceWorld } from '../../vehicle/world';
import { TICKS_PER_INPUT } from '../../server/room';

/**
 * Position error past which the correction is applied as a hard reset rather
 * than being blended away. Below it the car is close enough that easing the
 * render position across is invisible; above it, easing would show the car
 * sliding sideways for a quarter second.
 */
const HARD_SNAP_METRES = 4.0;

/** Time constant for easing a correction into the rendered pose, seconds. */
const SMOOTH_TAU = 0.09;

/**
 * How many recent inputs are re-sent alongside each new one.
 *
 * A lost input is not a lost frame - the server holds the previous input for
 * those two ticks while the client predicted the new one, and the two diverge
 * until the next correction pulls them back. At 2% loss that was worth about
 * 2 m of p99 prediction error.
 *
 * The fix costs nothing on the wire shape, which is frozen (§5.4): the last few
 * inputs are simply sent again as ordinary `input` messages, oldest first. The
 * server already ignores any seq it has already seen, so a duplicate that
 * arrives after its original is dropped for free, and one that arrives after
 * its original was lost is applied exactly as if it had never gone missing.
 */
export const INPUT_REDUNDANCY = 3;

/**
 * Adaptive input pacing.
 *
 * The client and the server each produce and consume one input per two of their
 * own ticks, on separate clocks. Any rate mismatch drains the server's queue;
 * when it drains the server holds the previous input for two extra ticks, so
 * that input is applied four times server-side and twice here. The replay
 * cannot reproduce it, and the result is a correction of exactly two ticks of
 * travel - 1.24 m at 133 km/h, 1.77 m at 191 km/h. That constant is what
 * identified the mechanism.
 *
 * The fix is to keep the server's queue at a small target depth, which the
 * client can do with no protocol change and no RTT estimate.
 *
 * `seq - ackSeq` is the number of inputs in flight plus the number sitting in
 * the server's queue, and the round trip converts the first term into inputs:
 * `depth = (seq - ackSeq) - rtt * INPUT_HZ`. From there it is an ordinary
 * proportional controller.
 *
 * Deriving the flight term from a running minimum of `seq - ackSeq` instead was
 * tried and does not work. The minimum only reads the true flight time when the
 * queue actually empties; when it does not, the floor tracks the gap upward,
 * the estimated depth collapses toward zero, and the controller speeds up a
 * client whose queue was already nine deep.
 *
 * The correction is applied to how fast real time is consumed. The physics
 * timestep is untouched: every step is still exactly FIXED_DT, so nothing about
 * the simulation changes. Only the wall-clock rate at which steps are taken
 * moves, by a few percent at most, well below anything a player can see.
 */
/** Inputs the server should have queued. Roughly 80 ms of cushion. */
const TARGET_DEPTH = 3;
/** Pace change per input of depth error, per snapshot. */
const PACE_GAIN = 0.0006;
/**
 * Bound on the pace adjustment either way. Generous: 2% packet loss delays a
 * recovered input by a redundancy interval, which drains the queue in a way a
 * few percent cannot refill.
 */
const PACE_MAX = 0.09;
/** Depth is only trusted once a round-trip measurement exists. */
const MIN_RTT_SAMPLES = 1;

interface Pending {
  seq: number;
  input: CarInput;
  /** Fixed steps this input has actually been applied for. */
  steps: number;
  /**
   * Smoothed steering angle immediately before this input was first applied.
   *
   * The snapshot carries position, rotation and velocity but not the steering
   * angle - §5.4 fixes that shape and it is not worth unfreezing. So the client
   * has to reconstruct it, and reconstructing it wrongly is expensive: the
   * steering rate limiter moves at 4.2 rad/s, which is more than full lock
   * inside one replay window, so starting a replay with the steering angle from
   * the client's *current* time instead of from the acknowledged time produced
   * roughly 2 m of p99 correction on a car doing 210 km/h.
   *
   * Because the angle is a pure function of the input history and that history
   * is identical on both sides, the value recorded here at input N is exactly
   * what the server's car had after it finished applying input N.
   */
  steerBefore: number;
}

export interface PredictionStats {
  /** Distance between prediction and the server's answer, at the last snapshot. */
  lastError: number;
  /** Rolling maximum over the last few seconds. */
  peakError: number;
  /** Steps re-simulated at the last reconciliation. */
  lastReplay: number;
  /** Inputs sent but not yet acknowledged. */
  pending: number;
  corrections: number;
  hardSnaps: number;
  /** Set by reconcile() so a harness can inspect what produced a correction. */
  lastAckSeq: number;
  lastPending: number;
}

export class PredictedCar {
  readonly car: Car;
  private readonly rw: RaceWorld;

  private pending: Pending[] = [];
  private seq = 0;
  private stepIndex = 0;

  /**
   * Difference between where the car is drawn and where the physics says it is.
   * Decays to zero. This is the entire anti-rubber-banding mechanism.
   */
  private posOffset: V3 = { x: 0, y: 0, z: 0 };
  private rotOffset = 0; // blend factor, 1 = fully at the pre-correction pose
  private preCorrectionRot: Q4 = { x: 0, y: 0, z: 0, w: 1 };

  readonly stats: PredictionStats = {
    lastError: 0,
    peakError: 0,
    lastReplay: 0,
    pending: 0,
    corrections: 0,
    hardSnaps: 0,
    lastAckSeq: 0,
    lastPending: 0,
  };
  private peakDecayAt = 0;

  /** `tick - TICKS_PER_INPUT * ackSeq` on the first snapshot; the baseline. */
  private driftBase: number | null = null;
  private lastDrift = 0;
  private paceBoost = 0;
  /** Smoothed round trip in ms, supplied by the transport. */
  private rttMs = 0;
  private rttSamples = 0;
  /** Estimated inputs sitting in the server's queue. */
  queueDepth = 0;

  /**
   * Multiplier on how fast the client consumes real time. 1 is nominal; above
   * 1 means run slightly fast to keep the server's input queue fed.
   */
  paceScale = 1;
  /** Server holds observed since connect. Diagnostic. */
  serverHolds = 0;

  constructor(rw: RaceWorld) {
    this.rw = rw;
    this.car = new Car(rw.world);
  }

  get currentSeq(): number {
    return this.seq;
  }

  /** Latest round-trip measurement, in ms. Feeds the pacing controller. */
  setRtt(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.rttMs = this.rttSamples === 0 ? ms : this.rttMs * 0.8 + ms * 0.2;
    this.rttSamples++;
  }

  spawn(p: V3, yaw: number): void {
    this.car.reset(p, yaw);
    this.pending.length = 0;
    this.posOffset = { x: 0, y: 0, z: 0 };
    this.rotOffset = 0;
  }

  /**
   * Advance one fixed step.
   *
   * `sample` is called only on the steps that begin a new input, so the caller
   * samples at the send rate rather than the tick rate. It returns the input to
   * use and is expected to transmit it.
   */
  fixedStep(sample: (seq: number) => CarInput): void {
    if (this.stepIndex % TICKS_PER_INPUT === 0) {
      const seq = ++this.seq;
      const steerBefore = this.car.readState().steer;
      this.pending.push({ seq, input: sample(seq), steps: 0, steerBefore });
      if (this.pending.length > MAX_PENDING_INPUTS) this.pending.shift();
    }

    const cur = this.pending[this.pending.length - 1];
    if (cur) {
      this.car.step(cur.input, FIXED_DT, this.rw.ctx);
      cur.steps++;
    }
    this.rw.world.step();
    this.car.postStep();
    this.stepIndex++;
    this.stats.pending = this.pending.length;
  }

  /**
   * Fold the server's answer for this car into the prediction.
   * `snap` is the authoritative state; `ackSeq` is the last input it includes.
   */
  reconcile(snap: CarSnap, ackSeq: number, serverTick?: number): void {
    if (serverTick !== undefined) this.updatePacing(serverTick, ackSeq);
    // Everything up to ackSeq is now history.
    while (this.pending.length > 0 && this.pending[0]!.seq <= ackSeq) this.pending.shift();

    const predicted = this.car.readState();
    const authoritative: CarState = {
      p: { x: snap.p[0], y: snap.p[1], z: snap.p[2] },
      q: { x: snap.q[0], y: snap.q[1], z: snap.q[2], w: snap.q[3] },
      v: { x: snap.v[0], y: snap.v[1], z: snap.v[2] },
      av: { x: snap.av[0], y: snap.av[1], z: snap.av[2] },
      // Steering angle is not on the wire, so it is reconstructed rather than
      // carried over from the client's current time. See Pending.steerBefore.
      // With no unacknowledged input left there is nothing to replay and the
      // current value is already the right one.
      steer: this.pending.length > 0 ? this.pending[0]!.steerBefore : predicted.steer,
    };

    // Where the car is currently *drawn*, so the correction can preserve it.
    const drawnPos = add(predicted.p, this.posOffset);
    const drawnRot = this.renderRotation(predicted.q);

    this.car.writeState(authoritative);

    // Replay every input the server has not seen yet, for exactly as many
    // steps as it was originally applied for.
    let replayed = 0;
    for (const p of this.pending) {
      for (let s = 0; s < p.steps; s++) {
        this.car.step(p.input, FIXED_DT, this.rw.ctx);
        this.rw.world.step();
        this.car.postStep();
        replayed++;
      }
    }

    const after = this.car.readState();
    const err = dist(predicted.p, after.p);

    this.stats.lastError = err;
    this.stats.lastReplay = replayed;
    this.stats.lastAckSeq = ackSeq;
    this.stats.lastPending = this.pending.length;
    this.stats.peakError = Math.max(this.stats.peakError, err);
    if (err > 0.01) this.stats.corrections++;

    if (err > HARD_SNAP_METRES) {
      // Too far to hide. Take the correction visibly rather than sliding the
      // car across the track for a quarter of a second.
      this.posOffset = { x: 0, y: 0, z: 0 };
      this.rotOffset = 0;
      this.stats.hardSnaps++;
      return;
    }

    // Keep the drawn pose exactly where it was and let it converge.
    this.posOffset = sub(drawnPos, after.p);
    this.preCorrectionRot = drawnRot;
    this.rotOffset = 1;
  }

  /**
   * Track how far the server has fallen behind the input stream and adjust the
   * pace. See PACE_GAIN.
   */
  private updatePacing(serverTick: number, ackSeq: number): void {
    const raw = serverTick - TICKS_PER_INPUT * ackSeq;
    if (this.driftBase === null) {
      this.driftBase = raw;
      this.lastDrift = 0;
      return;
    }
    const drift = raw - this.driftBase;
    if (drift > this.lastDrift) {
      this.serverHolds += Math.round((drift - this.lastDrift) / TICKS_PER_INPUT);
    }
    this.lastDrift = drift;

    if (this.rttSamples < MIN_RTT_SAMPLES) return; // no depth estimate yet

    const gap = this.seq - ackSeq;
    const inFlight = (this.rttMs / 1000) * INPUT_HZ;
    this.queueDepth = Math.max(0, gap - inFlight);

    // Integral control on the depth error.
    //
    // No asymmetric anti-windup term. One was tried, on the theory that a
    // stalled client loop - a backgrounded tab, where requestAnimationFrame
    // simply stops - would drive this to its limit and leave the client running
    // fast afterwards. It does drive it to the limit, but it unwinds on its own
    // the moment frames resume, because the queue is then very deep and the
    // error correspondingly large and negative. Adding a faster unwind on top
    // of that only made the controller chase jitter, and holds under sustained
    // latency went from 0.97% back up to 1.8%.
    const err = TARGET_DEPTH - this.queueDepth;
    this.paceBoost = clamp(this.paceBoost + err * PACE_GAIN, -PACE_MAX, PACE_MAX);
    this.paceScale = 1 + this.paceBoost;
  }

  /** Decay the visual correction. Call once per rendered frame. */
  updateVisual(dt: number): void {
    const k = Math.exp(-dt / SMOOTH_TAU);
    this.posOffset = scale(this.posOffset, k);
    this.rotOffset *= k;
    if (Math.abs(this.posOffset.x) + Math.abs(this.posOffset.y) + Math.abs(this.posOffset.z) < 1e-4) {
      this.posOffset = { x: 0, y: 0, z: 0 };
    }
    if (this.rotOffset < 1e-3) this.rotOffset = 0;

    const now = performance.now();
    if (now - this.peakDecayAt > 3000) {
      this.peakDecayAt = now;
      this.stats.peakError = 0;
    }
  }

  /** Where the car should be drawn this frame. */
  renderPosition(): V3 {
    const p = this.car.body.translation();
    return add({ x: p.x, y: p.y, z: p.z }, this.posOffset);
  }

  renderRotation(physics?: Q4): Q4 {
    const q = physics ?? this.car.body.rotation();
    const cur: Q4 = { x: q.x, y: q.y, z: q.z, w: q.w };
    if (this.rotOffset <= 0) return cur;
    return slerp(cur, this.preCorrectionRot, this.rotOffset);
  }

  /** Interpolate between fixed steps so rendering is smooth above 60 fps. */
  renderPositionSmoothed(prev: V3, alpha: number): V3 {
    return lerpV3(prev, this.renderPosition(), alpha);
  }
}

function dist(a: V3, b: V3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
