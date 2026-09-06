/**
 * shared/protocol.ts
 *
 * FROZEN CONTRACT — see HANDOFF.md §3, §5.4.
 * Any change here must be appended to CHANGELOG-SHARED.md with a timestamp.
 *
 * JSON on the wire. Rotations are quaternions [x, y, z, w], never Euler.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** Race state machine — HANDOFF.md §4. */
export type RaceState = 'lobby' | 'grid' | 'countdown' | 'racing' | 'finished';

export type SurfaceKind = 'asphalt' | 'kerb' | 'grass' | 'gravel';

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** First message a client sends. Server replies with `welcome` or `error`. */
export interface HelloMsg {
  t: 'hello';
  v: number; // PROTOCOL_VERSION
  name: string; // display name, <= 16 chars, sanitised server-side
  color: number; // requested index into CAR_COLORS; server may reassign
}

/** Sent at INPUT_HZ while connected. */
export interface InputMsg {
  t: 'input';
  seq: number; // monotonic, never reset
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1..1
  handbrake: boolean;
}

/** Player signals readiness in the lobby. */
export interface ReadyMsg {
  t: 'ready';
  ready: boolean;
}

/** Keepalive / RTT probe. Server echoes as `pong`. */
export interface PingMsg {
  t: 'ping';
  ts: number; // client clock, ms
}

export type ClientMsg = HelloMsg | InputMsg | ReadyMsg | PingMsg;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface WelcomeMsg {
  t: 'welcome';
  v: number;
  id: number; // this client's car id
  color: number; // assigned colour index
  trackUrl: string; // where to fetch the track JSON
  tick: number; // server tick at time of welcome
  laps: number;
}

/** Per-car state inside a snapshot. */
export interface CarSnap {
  id: number;
  p: Vec3;
  q: Quat;
  v: Vec3;
  av: Vec3;
  lap: number;
  cp: number; // last checkpoint index passed
  surface: SurfaceKind;
}

/** Broadcast at SNAPSHOT_HZ. */
export interface SnapMsg {
  t: 'snap';
  tick: number;
  ackSeq: number; // last input seq this client's state includes
  cars: CarSnap[];
}

export interface PlayerInfo {
  id: number;
  name: string;
  color: number;
  ready: boolean;
  ai: boolean;
}

export interface JoinMsg {
  t: 'join';
  player: PlayerInfo;
  players: PlayerInfo[]; // full roster, so late joiners are consistent
}

export interface LeaveMsg {
  t: 'leave';
  id: number;
  players: PlayerInfo[];
}

/** Roster changed without a join/leave (ready flags, AI fill). */
export interface RosterMsg {
  t: 'roster';
  players: PlayerInfo[];
}

export interface StateMsg {
  t: 'state';
  state: RaceState;
  /** Seconds remaining in this phase, or null if the phase has no timer. */
  timer: number | null;
  tick: number;
}

/** A car crossed the start/finish line and completed a lap. */
export interface LapMsg {
  t: 'lap';
  id: number;
  lap: number; // lap just completed (1-based)
  lapTimeMs: number;
  bestMs: number;
  totalMs: number;
}

export interface ResultEntry {
  id: number;
  name: string;
  color: number;
  position: number; // 1-based
  laps: number;
  totalMs: number | null; // null if did not finish
  bestLapMs: number | null;
  ai: boolean;
}

export interface ResultMsg {
  t: 'result';
  results: ResultEntry[];
}

export interface PongMsg {
  t: 'pong';
  ts: number; // echoed client clock
  tick: number;
}

export interface ErrorMsg {
  t: 'error';
  code: 'version' | 'full' | 'malformed';
  message: string;
}

export type ServerMsg =
  | WelcomeMsg
  | SnapMsg
  | JoinMsg
  | LeaveMsg
  | RosterMsg
  | StateMsg
  | LapMsg
  | ResultMsg
  | PongMsg
  | ErrorMsg;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface CarInput {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

export const NEUTRAL_INPUT: CarInput = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
};

/** Clamp and sanitise an untrusted input message. Never trust the client. */
export function sanitizeInput(m: InputMsg): CarInput {
  const c = (n: unknown, lo: number, hi: number): number => {
    const x = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    return x < lo ? lo : x > hi ? hi : x;
  };
  return {
    throttle: c(m.throttle, 0, 1),
    brake: c(m.brake, 0, 1),
    steer: c(m.steer, -1, 1),
    handbrake: m.handbrake === true,
  };
}
