/**
 * The race room: authoritative simulation, race state machine, and the roster.
 *
 * Knows nothing about sockets. `Room` produces `ServerMsg` values and hands them
 * to a transport via the callbacks in `RoomHooks`; net.ts owns the WebSockets.
 * That split is what lets tools/loadtest.ts drive a room at full speed with no
 * network at all, and it is why the hour-12 tick-rate measurement is a
 * measurement of the simulation rather than of Node's socket layer.
 */

import {
  CLIENT_TIMEOUT_MS,
  COUNTDOWN_SECONDS,
  FIXED_DT,
  INPUT_HZ,
  MAX_PLAYERS,
  RACE_LAPS,
  RESULTS_SECONDS,
  TICK_HZ,
  TICKS_PER_SNAPSHOT,
} from '../shared/constants';
import {
  NEUTRAL_INPUT,
  sanitizeInput,
  type CarInput,
  type CarSnap,
  type InputMsg,
  type PlayerInfo,
  type RaceState,
  type ResultEntry,
  type ServerMsg,
} from '../shared/protocol';
import type { TrackData } from '../shared/track-schema';
import { AI_SKILLS, AiDriver, buildSpeedProfile } from '../vehicle/ai-driver';
import { Car } from '../vehicle/car';
import type { V3 } from '../vehicle/math3';
import { createRaceWorld, destroyRaceWorld, type RaceWorld } from '../vehicle/world';
import { LapTracker } from './lap-tracker';

/**
 * Server ticks per client input. Clients send at INPUT_HZ, the server runs at
 * TICK_HZ, so one input covers this many ticks.
 *
 * The client's prediction MUST apply each input for exactly this many steps.
 * If the two disagree the local car drifts from the server by a constant factor
 * and every frame produces a reconciliation correction, which looks precisely
 * like bad netcode and is not.
 */
export const TICKS_PER_INPUT = TICK_HZ / INPUT_HZ;

/** A car is respawned after being stuck or inverted for this long. */
const RESCUE_SECONDS = 5;
/** Race is abandoned if nobody finishes within this long after the leader. */
const FINISH_GRACE_SECONDS = 45;

export interface RoomOptions {
  laps?: number;
  /** Fill the grid to this many cars with AI. 0 disables AI entirely. */
  aiFill?: number;
  maxPlayers?: number;
  /** Skip the lobby and start immediately. Used by the load test. */
  autoStart?: boolean;
}

export interface RoomHooks {
  /** Deliver a message to one entrant. Ignored for AI. */
  send(id: number, msg: ServerMsg): void;
  /** Deliver a message to every human entrant. */
  broadcast(msg: ServerMsg): void;
  /**
   * Deliver a snapshot to every human entrant. Separate from `broadcast`
   * because the payload is identical for everyone except `ackSeq`, so the
   * transport can serialise the car array once and splice per client.
   */
  sendSnapshots?(tick: number, carsJson: string, ackSeqOf: (id: number) => number): void;
}

export interface Entrant {
  id: number;
  name: string;
  color: number;
  ai: boolean;
  ready: boolean;
  car: Car;
  lap: LapTracker;
  driver: AiDriver | null;

  /** Inputs received but not yet consumed, ordered by seq. */
  pending: InputMsg[];
  current: CarInput;
  /** Last seq whose effects are included in the state we broadcast. */
  ackSeq: number;
  /** Highest seq ever seen, so out-of-order duplicates are dropped. */
  highestSeq: number;

  hint: number;
  finished: boolean;
  finishTick: number;
  lastSeenMs: number;
  stuckTicks: number;
  spawnSlot: number;
}

export class Room {
  readonly world: RaceWorld;
  readonly track: TrackData;
  readonly laps: number;
  readonly maxPlayers: number;

  private readonly hooks: RoomHooks;
  private readonly speedProfile: Float64Array;
  private readonly aiFill: number;

  readonly entrants = new Map<number, Entrant>();
  private nextId = 1;

  state: RaceState = 'lobby';
  tick = 0;
  /** Tick the current phase began on. */
  private phaseTick = 0;
  private raceStartTick = 0;
  private leaderFinishTick = -1;

  /** Rolling tick-duration samples in ms, for the hour-12 gate. */
  readonly tickMs: number[] = [];

  constructor(track: TrackData, hooks: RoomHooks, opts: RoomOptions = {}) {
    this.track = track;
    this.hooks = hooks;
    this.laps = opts.laps ?? RACE_LAPS;
    this.maxPlayers = opts.maxPlayers ?? MAX_PLAYERS;
    this.aiFill = opts.aiFill ?? 0;
    this.world = createRaceWorld(track);
    this.speedProfile = buildSpeedProfile(this.world.query);
    if (opts.autoStart) this.setState('grid');
  }

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------

  get humanCount(): number {
    let n = 0;
    for (const e of this.entrants.values()) if (!e.ai) n++;
    return n;
  }

  get isFull(): boolean {
    return this.humanCount >= this.maxPlayers;
  }

  join(name: string, colorWanted: number, ai = false): Entrant {
    const id = this.nextId++;
    const slot = this.freeSpawnSlot();
    const car = new Car(this.world.world);
    const spawn = this.track.spawnGrid[slot % this.track.spawnGrid.length]!;
    car.reset({ x: spawn.p[0], y: spawn.p[1], z: spawn.p[2] }, spawn.rotY);

    const lap = new LapTracker(this.world.query);
    const p = car.body.translation();
    lap.seed(this.world.query.locate(p.x, p.y, p.z));

    const e: Entrant = {
      id,
      name: sanitizeName(name, id),
      color: this.freeColor(colorWanted),
      ai,
      ready: ai,
      car,
      lap,
      driver: ai
        ? new AiDriver(this.world.query, this.speedProfile, AI_SKILLS[id % AI_SKILLS.length]!)
        : null,
      pending: [],
      current: { ...NEUTRAL_INPUT },
      ackSeq: 0,
      highestSeq: 0,
      hint: 0,
      finished: false,
      finishTick: -1,
      lastSeenMs: Date.now(),
      stuckTicks: 0,
      spawnSlot: slot,
    };
    this.entrants.set(id, e);
    return e;
  }

  leave(id: number): void {
    const e = this.entrants.get(id);
    if (!e) return;
    this.world.world.removeRigidBody(e.car.body);
    this.entrants.delete(id);
    this.hooks.broadcast({ t: 'leave', id, players: this.roster() });
    if (this.humanCount === 0) this.reset();
  }

  roster(): PlayerInfo[] {
    return [...this.entrants.values()].map((e) => ({
      id: e.id,
      name: e.name,
      color: e.color,
      ready: e.ready,
      ai: e.ai,
    }));
  }

  private freeColor(wanted: number): number {
    const taken = new Set([...this.entrants.values()].map((e) => e.color));
    if (Number.isInteger(wanted) && wanted >= 0 && wanted < 10 && !taken.has(wanted)) return wanted;
    for (let c = 0; c < 10; c++) if (!taken.has(c)) return c;
    return 0;
  }

  private freeSpawnSlot(): number {
    const taken = new Set([...this.entrants.values()].map((e) => e.spawnSlot));
    for (let s = 0; s < this.track.spawnGrid.length; s++) if (!taken.has(s)) return s;
    return this.entrants.size;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  onInput(id: number, msg: InputMsg): void {
    const e = this.entrants.get(id);
    if (!e || e.ai) return;
    e.lastSeenMs = Date.now();

    // Drop replays and reorderings. seq is monotonic and never resets (§5.4).
    if (!Number.isFinite(msg.seq) || msg.seq <= e.highestSeq) return;
    e.highestSeq = msg.seq;

    // Cap the queue. A client that floods, or one whose connection stalled and
    // then dumped a second of backlog, must not be able to make the server
    // simulate its past for it.
    e.pending.push(msg);
    if (e.pending.length > INPUT_HZ) e.pending.splice(0, e.pending.length - INPUT_HZ);
  }

  onReady(id: number, ready: boolean): void {
    const e = this.entrants.get(id);
    if (!e) return;
    e.ready = ready;
    e.lastSeenMs = Date.now();
    this.hooks.broadcast({ t: 'roster', players: this.roster() });
  }

  touch(id: number): void {
    const e = this.entrants.get(id);
    if (e) e.lastSeenMs = Date.now();
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  private setState(s: RaceState): void {
    this.state = s;
    this.phaseTick = this.tick;

    if (s === 'grid') {
      this.fillWithAi();
      this.placeOnGrid();
    }
    if (s === 'racing') {
      this.raceStartTick = this.tick;
      const now = 0;
      for (const e of this.entrants.values()) e.lap.start(now);
    }
    if (s === 'finished') {
      this.hooks.broadcast({ t: 'result', results: this.results() });
    }
    if (s === 'lobby') {
      this.removeAi();
      for (const e of this.entrants.values()) e.ready = false;
      this.hooks.broadcast({ t: 'roster', players: this.roster() });
    }

    this.hooks.broadcast({ t: 'state', state: s, timer: this.phaseTimer(), tick: this.tick });
  }

  /** Seconds remaining in the current phase, or null if it has no timer. */
  private phaseTimer(): number | null {
    const elapsed = (this.tick - this.phaseTick) / TICK_HZ;
    if (this.state === 'countdown') return Math.max(0, COUNTDOWN_SECONDS - elapsed);
    if (this.state === 'grid') return Math.max(0, 3 - elapsed);
    if (this.state === 'finished') return Math.max(0, RESULTS_SECONDS - elapsed);
    return null;
  }

  private placeOnGrid(): void {
    let slot = 0;
    for (const e of this.entrants.values()) {
      const s = this.track.spawnGrid[slot % this.track.spawnGrid.length]!;
      e.spawnSlot = slot++;
      e.car.reset({ x: s.p[0], y: s.p[1], z: s.p[2] }, s.rotY);
      e.finished = false;
      e.finishTick = -1;
      e.stuckTicks = 0;
      e.pending.length = 0;
      e.current = { ...NEUTRAL_INPUT };
      e.lap = new LapTracker(this.world.query);
      const p = e.car.body.translation();
      const loc = this.world.query.locate(p.x, p.y, p.z);
      e.lap.seed(loc);
      e.hint = loc.index;
    }
  }

  private fillWithAi(): void {
    if (this.aiFill <= 0) return;
    let n = this.entrants.size;
    let k = 1;
    while (n < this.aiFill && n < this.track.spawnGrid.length) {
      this.join(`CPU ${k++}`, -1, true);
      n++;
    }
    this.hooks.broadcast({ t: 'roster', players: this.roster() });
  }

  private removeAi(): void {
    for (const e of [...this.entrants.values()]) {
      if (e.ai) {
        this.world.world.removeRigidBody(e.car.body);
        this.entrants.delete(e.id);
      }
    }
  }

  /** Wipe back to an empty lobby. */
  reset(): void {
    this.removeAi();
    this.state = 'lobby';
    this.phaseTick = this.tick;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /** One fixed step. Call at exactly TICK_HZ. */
  step(): void {
    const t0 = performance.now();

    this.dropTimedOutClients();
    this.advanceStateMachine();

    const frozen = this.state !== 'racing';

    // Consume one queued input every TICKS_PER_INPUT ticks.
    if (this.tick % TICKS_PER_INPUT === 0) {
      for (const e of this.entrants.values()) {
        const next = e.pending.shift();
        if (next) {
          e.current = sanitizeInput(next);
          e.ackSeq = next.seq;
        }
        // If nothing arrived, e.current is held. The client predicted with its
        // own input, so this shows up as a reconciliation correction rather
        // than as a stall - which is the right trade.
      }
    }

    const positions: V3[] = [];
    if (!frozen) {
      for (const e of this.entrants.values()) {
        const p = e.car.body.translation();
        positions.push({ x: p.x, y: p.y, z: p.z });
      }
    }

    let i = 0;
    for (const e of this.entrants.values()) {
      let input: CarInput;
      if (frozen || e.finished) {
        input = NEUTRAL_INPUT;
      } else if (e.driver) {
        const others = positions.filter((_, k) => k !== i);
        input = e.driver.update(e.car, FIXED_DT, others);
      } else {
        input = e.current;
      }
      e.car.step(input, FIXED_DT, this.world.ctx);
      i++;
    }

    this.world.world.step();
    this.tick++;

    if (this.state === 'racing') this.updateProgress();
    this.rescueStuck(frozen);

    if (this.tick % TICKS_PER_SNAPSHOT === 0) this.broadcastSnapshots();

    const dt = performance.now() - t0;
    this.tickMs.push(dt);
    if (this.tickMs.length > TICK_HZ * 60) this.tickMs.shift();
  }

  private advanceStateMachine(): void {
    const elapsed = (this.tick - this.phaseTick) / TICK_HZ;

    switch (this.state) {
      case 'lobby': {
        const humans = [...this.entrants.values()].filter((e) => !e.ai);
        if (humans.length > 0 && humans.every((e) => e.ready)) this.setState('grid');
        break;
      }
      case 'grid':
        if (elapsed >= 3) this.setState('countdown');
        break;
      case 'countdown':
        if (elapsed >= COUNTDOWN_SECONDS) this.setState('racing');
        break;
      case 'racing': {
        const all = [...this.entrants.values()];
        if (all.length > 0 && all.every((e) => e.finished)) {
          this.setState('finished');
        } else if (
          this.leaderFinishTick >= 0 &&
          (this.tick - this.leaderFinishTick) / TICK_HZ > FINISH_GRACE_SECONDS
        ) {
          this.setState('finished');
        }
        break;
      }
      case 'finished':
        if (elapsed >= RESULTS_SECONDS) this.setState('lobby');
        break;
    }
  }

  private updateProgress(): void {
    const nowMs = ((this.tick - this.raceStartTick) / TICK_HZ) * 1000;
    for (const e of this.entrants.values()) {
      if (e.finished) continue;
      const p = e.car.body.translation();
      const loc = this.world.query.locate(p.x, p.y, p.z, e.hint);
      e.hint = loc.index;

      const ev = e.lap.update(loc, nowMs);
      if (!ev) continue;

      this.hooks.broadcast({
        t: 'lap',
        id: e.id,
        lap: ev.lap,
        lapTimeMs: Math.round(ev.lapTimeMs),
        bestMs: Math.round(ev.bestMs),
        totalMs: Math.round(ev.totalMs),
      });

      if (ev.lap >= this.laps) {
        e.finished = true;
        e.finishTick = this.tick;
        if (this.leaderFinishTick < 0) this.leaderFinishTick = this.tick;
      }
    }
  }

  /**
   * Put a car back on the road if it is upside down or has been stationary off
   * the racing line. Without this one bad crash removes a player from the race
   * for good, and at a demo that player is standing next to you.
   */
  private rescueStuck(frozen: boolean): void {
    if (frozen) return;
    const limit = RESCUE_SECONDS * TICK_HZ;
    for (const e of this.entrants.values()) {
      if (e.finished) continue;
      const bad = e.car.isInverted() || (e.car.speed < 1.5 && e.car.offTrackTicks > 30);
      e.stuckTicks = bad ? e.stuckTicks + 1 : 0;
      if (e.stuckTicks < limit) continue;

      e.stuckTicks = 0;
      const q = this.world.query;
      const idx = e.hint;
      const w = q.track.waypoints[idx]!;
      e.car.reset({ x: w.p[0], y: w.p[1] + 0.6, z: w.p[2] }, q.headingAt(idx));
    }
  }

  private dropTimedOutClients(): void {
    const now = Date.now();
    for (const e of [...this.entrants.values()]) {
      if (e.ai) continue;
      if (now - e.lastSeenMs > CLIENT_TIMEOUT_MS) this.leave(e.id);
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots and results
  // -------------------------------------------------------------------------

  snapshotCars(): CarSnap[] {
    const cars: CarSnap[] = [];
    for (const e of this.entrants.values()) {
      const p = e.car.body.translation();
      const q = e.car.body.rotation();
      const v = e.car.body.linvel();
      const av = e.car.body.angvel();
      cars.push({
        id: e.id,
        p: [r3(p.x), r3(p.y), r3(p.z)],
        q: [r4(q.x), r4(q.y), r4(q.z), r4(q.w)],
        v: [r3(v.x), r3(v.y), r3(v.z)],
        av: [r3(av.x), r3(av.y), r3(av.z)],
        lap: e.lap.lap,
        cp: e.lap.cp,
        surface: e.car.surface,
      });
    }
    return cars;
  }

  private broadcastSnapshots(): void {
    if (this.hooks.sendSnapshots) {
      this.hooks.sendSnapshots(this.tick, this.serializedCars(), (id) => this.entrants.get(id)?.ackSeq ?? 0);
      return;
    }
    const cars = this.snapshotCars();
    for (const e of this.entrants.values()) {
      if (e.ai) continue;
      this.hooks.send(e.id, { t: 'snap', tick: this.tick, ackSeq: e.ackSeq, cars });
    }
  }

  /**
   * The car array serialised once per snapshot.
   *
   * Snapshots differ between clients only in `ackSeq`, so stringifying the
   * whole message once per client serialises the same ten cars ten times. The
   * transport uses this to build each client's message by concatenation
   * instead. At 30 Hz with ten clients that is the single largest source of
   * garbage the server produces.
   */
  serializedCars(): string {
    return JSON.stringify(this.snapshotCars());
  }

  /** Race order: most distance covered first, finishers ahead of everyone. */
  order(): Entrant[] {
    return [...this.entrants.values()].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTick - b.finishTick;
      return b.lap.raceDistance - a.lap.raceDistance;
    });
  }

  results(): ResultEntry[] {
    return this.order().map((e, i) => ({
      id: e.id,
      name: e.name,
      color: e.color,
      position: i + 1,
      laps: e.lap.lap,
      totalMs: e.finished ? Math.round(e.lap.totalMs) : null,
      bestLapMs: e.lap.bestMs === null ? null : Math.round(e.lap.bestMs),
      ai: e.ai,
    }));
  }

  destroy(): void {
    destroyRaceWorld(this.world);
    this.entrants.clear();
  }
}

// ---------------------------------------------------------------------------

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Never trust a client-supplied display name. */
function sanitizeName(name: string, id: number): string {
  const clean = String(name ?? '')
    .replace(/[ -<>]/g, '')
    .trim()
    .slice(0, 16);
  return clean.length > 0 ? clean : `Driver ${id}`;
}
