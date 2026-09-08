/**
 * Procedural audio: engine, tyres, wind, impacts, countdown.
 *
 * Synthesised in the Web Audio graph rather than played from files. Partly
 * HANDOFF.md §10 — original assets only — and partly §9: a demo that fetches
 * audio is a demo that can fail on a bad network, and engine samples are the
 * heaviest thing a racing game normally loads.
 *
 * Everything here is driven from state the client already has. Nothing new is
 * asked of the server, and nothing here can block a frame: `update()` sets
 * audio parameters and returns.
 *
 * Browsers refuse to start audio without a user gesture, so `resume()` is
 * called from the join and ready clicks. Before that the graph exists but is
 * silent, which is the correct behaviour rather than a bug to work around.
 */

import type { SurfaceKind } from '../../shared/protocol';

/** Idle and redline, in revs. Only the ratio matters; the numbers read well. */
const IDLE_RPM = 900;
const MAX_RPM = 7600;

/**
 * Gear ratios as top speed in km/h per gear. A single speed-to-pitch mapping
 * makes a car sound like a milk float pulling away and a dentist's drill at
 * top end; the rise-and-drop of shifting is most of what makes an engine
 * sound like an engine.
 */
const GEAR_TOPS = [45, 85, 130, 180, 240];

/** Engine harmonics: multiplier and relative level. */
const HARMONICS: [number, number][] = [
  [0.5, 0.55],
  [1, 1],
  [2, 0.42],
  [3, 0.16],
];

export interface SoundState {
  speedKph: number;
  throttle: number;
  brake: number;
  surface: SurfaceKind;
  /** True while the car is off the racing surface enough to scrub. */
  sliding: boolean;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  private engineOscs: OscillatorNode[] = [];
  private engineGains: GainNode[] = [];
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;

  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private tyreGain: GainNode | null = null;
  private tyreFilter: BiquadFilterNode | null = null;

  private noiseBuffer: AudioBuffer | null = null;
  private enabled = true;
  private started = false;

  /** Previous speed, for deriving impacts without a signal from the physics. */
  private lastSpeed = 0;
  private lastImpactAt = 0;

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Build the graph and start the continuous voices.
   *
   * Safe to call repeatedly: browsers only allow a context to start from a
   * gesture, and which gesture that turns out to be varies.
   */
  resume(): void {
    if (!this.enabled) return;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return; // no audio on this device; everything below no-ops
      }
      this.build();
    }
    void this.ctx.resume();
    this.started = true;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
    }
    if (on) this.resume();
  }

  private build(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 1 : 0;
    this.master.connect(ctx.destination);

    // --- one second of white noise, reused by wind and tyres ---------------
    const frames = ctx.sampleRate;
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;

    // --- engine -------------------------------------------------------------
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 0.8;
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    for (const [mult, level] of HARMONICS) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 60 * mult;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g);
      g.connect(this.engineFilter);
      osc.start();
      this.engineOscs.push(osc);
      this.engineGains.push(g);
    }

    // --- wind: rises with speed, and is most of the sense of pace ----------
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 700;
    this.windFilter.Q.value = 0.5;
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    this.loop(buf, this.windFilter);

    // --- tyres: surface texture under the car ------------------------------
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    this.tyreFilter = ctx.createBiquadFilter();
    this.tyreFilter.type = 'bandpass';
    this.tyreFilter.frequency.value = 1600;
    this.tyreFilter.Q.value = 1.1;
    this.tyreFilter.connect(this.tyreGain);
    this.tyreGain.connect(this.master);
    this.loop(buf, this.tyreFilter);
  }

  private loop(buffer: AudioBuffer, dest: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(dest);
    src.start();
  }

  /** Engine revs for a road speed, with a gearbox so it shifts. */
  private revsFor(speedKph: number): number {
    const v = Math.max(0, speedKph);
    let gear = 0;
    while (gear < GEAR_TOPS.length - 1 && v > GEAR_TOPS[gear]!) gear++;
    const bottom = gear === 0 ? 0 : GEAR_TOPS[gear - 1]!;
    const span = Math.max(1, GEAR_TOPS[gear]! - bottom);
    const through = Math.min(1, (v - bottom) / span);
    return IDLE_RPM + through * (MAX_RPM - IDLE_RPM);
  }

  /** Call once per rendered frame while racing. */
  update(s: SoundState): void {
    const ctx = this.ctx;
    if (!ctx || !this.started || !this.enabled) {
      this.lastSpeed = s.speedKph;
      return;
    }
    const t = ctx.currentTime;
    const speed = Math.max(0, s.speedKph);

    // --- engine -------------------------------------------------------------
    const rpm = this.revsFor(speed);
    // 4-stroke firing frequency: revs per second times half the cylinder count.
    const fundamental = (rpm / 60) * 2;
    for (let i = 0; i < this.engineOscs.length; i++) {
      const mult = HARMONICS[i]![0];
      this.engineOscs[i]!.frequency.setTargetAtTime(fundamental * mult, t, 0.02);
    }
    // Load opens the filter: the difference between coasting and pulling.
    const load = Math.min(1, s.throttle * 0.8 + speed / 260);
    this.engineFilter?.frequency.setTargetAtTime(500 + load * 2600, t, 0.05);
    this.engineGain?.gain.setTargetAtTime(0.055 + s.throttle * 0.05, t, 0.05);

    // --- wind ---------------------------------------------------------------
    const windLevel = Math.min(0.14, (speed / 240) ** 2 * 0.16);
    this.windGain?.gain.setTargetAtTime(windLevel, t, 0.12);
    this.windFilter?.frequency.setTargetAtTime(500 + speed * 5, t, 0.12);

    // --- tyres --------------------------------------------------------------
    // Loose surfaces are louder and darker than asphalt; a kerb is a rattle.
    const surfaceLevel: Record<SurfaceKind, number> = {
      asphalt: 0.035,
      kerb: 0.11,
      grass: 0.10,
      gravel: 0.16,
    };
    const surfaceFreq: Record<SurfaceKind, number> = {
      asphalt: 1700,
      kerb: 900,
      grass: 1100,
      gravel: 700,
    };
    const rolling = Math.min(1, speed / 90);
    const slide = s.sliding ? 1.7 : 1;
    this.tyreGain?.gain.setTargetAtTime(surfaceLevel[s.surface] * rolling * slide, t, 0.06);
    this.tyreFilter?.frequency.setTargetAtTime(surfaceFreq[s.surface], t, 0.08);

    // --- impacts ------------------------------------------------------------
    // Derived rather than signalled: the physics does not publish contacts, and
    // a sudden loss of speed is what an impact sounds like from here. The floor
    // is high enough that braking and engine braking never trigger it.
    const drop = this.lastSpeed - speed;
    if (drop > 22 && ctx.currentTime - this.lastImpactAt > 0.25) {
      this.lastImpactAt = ctx.currentTime;
      this.thud(Math.min(1, drop / 70));
    }
    this.lastSpeed = speed;
  }

  /** Impact: a short filtered noise burst. */
  private thud(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer || !this.master) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 260 + strength * 700;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3 * strength + 0.05, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.3);
  }

  /** Countdown pip. `go` is the higher, longer one on lights out. */
  beep(go = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.enabled) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = go ? 880 : 440;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (go ? 0.7 : 0.18));
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + (go ? 0.75 : 0.22));
  }

  dispose(): void {
    for (const o of this.engineOscs) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    }
    this.engineOscs = [];
    void this.ctx?.close();
    this.ctx = null;
  }
}
