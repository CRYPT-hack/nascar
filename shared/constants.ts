/**
 * shared/constants.ts
 *
 * FROZEN CONTRACT — see HANDOFF.md §3.
 * Any change here must be appended to CHANGELOG-SHARED.md with a timestamp.
 *
 * Units: 1 world unit = 1 metre. Y-up, right-handed. kg / s / N.
 */

// ---------------------------------------------------------------------------
// Simulation timing
// ---------------------------------------------------------------------------

/** Fixed physics timestep. Never variable. Server and client both use this. */
export const FIXED_DT = 1 / 60;

/** Server physics tick rate (Hz). */
export const TICK_HZ = 60;

/** Snapshot broadcast rate (Hz). Server sends every Nth tick. */
export const SNAPSHOT_HZ = 30;

/** Ticks between snapshot broadcasts. */
export const TICKS_PER_SNAPSHOT = TICK_HZ / SNAPSHOT_HZ;

/** Client input send rate (Hz). */
export const INPUT_HZ = 30;

/**
 * Remote cars are rendered this far in the past, interpolating between the two
 * most recent snapshots. Not optional — without it remote cars teleport.
 */
export const INTERP_DELAY_MS = 100;

/** Client keeps at most this many unacknowledged inputs for reconciliation. */
export const MAX_PENDING_INPUTS = 180; // 3 s at 60 Hz

// ---------------------------------------------------------------------------
// Car reference dimensions — HANDOFF.md §5.2
// ---------------------------------------------------------------------------

export const CAR = {
  length: 4.5,
  width: 1.9,
  height: 1.1,
  wheelbase: 2.8,
  /** Lateral distance between left and right wheel centres. */
  track: 1.6,
  mass: 780,
  rideHeight: 0.12,
  wheelRadius: 0.34,
} as const;

// ---------------------------------------------------------------------------
// Race
// ---------------------------------------------------------------------------

export const MAX_PLAYERS = 10;
export const RACE_LAPS = 3;

/** Countdown duration once the grid is formed, in seconds. */
export const COUNTDOWN_SECONDS = 5;

/** Seconds the results screen is held before the room returns to lobby. */
export const RESULTS_SECONDS = 20;

/**
 * A client is dropped if no message arrives for this long.
 * Generous — hackathon wifi.
 */
export const CLIENT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Physics world
// ---------------------------------------------------------------------------

export const GRAVITY = { x: 0, y: -9.81, z: 0 };

/** Collision groups. Rapier packs these as (membership << 16) | filter. */
export const GROUP = {
  TRACK: 0x0001,
  CAR: 0x0002,
  BARRIER: 0x0004,
} as const;

export function interactionGroups(membership: number, filter: number): number {
  return (membership << 16) | filter;
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 8080;

/** Protocol version. Client and server must agree or the connection is refused. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Player-selectable car colours (hex). Invented liveries only — no real teams. */
export const CAR_COLORS = [
  0xff3b30, // ember
  0x0a84ff, // cobalt
  0xffd60a, // sulphur
  0x30d158, // acid
  0xbf5af2, // orchid
  0xff9f0a, // amber
  0x64d2ff, // ice
  0xff375f, // magenta
  0xf2f2f7, // bone
  0x1c1c1e, // graphite
] as const;

export const CAR_COLOR_NAMES = [
  'Ember',
  'Cobalt',
  'Sulphur',
  'Acid',
  'Orchid',
  'Amber',
  'Ice',
  'Magenta',
  'Bone',
  'Graphite',
] as const;
