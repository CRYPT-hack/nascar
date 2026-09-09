# Interlagos Racer

Browser-based multiplayer racing. Ten players, three laps, a scaled Autódromo
José Carlos Pace. Server-authoritative simulation with client prediction.

Original assets only. No real sponsors, teams, drivers, or liveries.

## Stack

| Layer | Choice |
|---|---|
| Rendering | three.js (client only) |
| Physics | Rapier `@dimforge/rapier3d-compat` **0.14.0**, exact-pinned, server + client |
| Transport | WebSocket, JSON payloads |
| Server | Node 20+, TypeScript, authoritative |
| Build | Vite |

Rapier is pinned with no caret and no tilde. Server/client physics divergence
from a minor bump produces bugs that look like netcode bugs.

## Layout

```
shared/     Contract: constants, protocol, track schema. Frozen — see CHANGELOG-SHARED.md
server/     Authoritative simulation, race state machine, WebSocket transport
client/     Prediction, interpolation, input, camera, placeholder renderer and UI
vehicle/    Car physics, collision geometry, track queries, AI driver
track/      Track generator (source); output lands in public/track/
public/     Static assets served by Vite; generated track JSON
tools/      Measurement harnesses — see below
```

Instance A owns `vehicle/`, `server/`, and the netcode half of `client/`.
Instance B owns `track/`, `assets/`, and presentation. `client/src/scene.ts` and
`client/src/ui.ts` are placeholders marked for replacement, not extension.

## Running

```bash
npm install
npm run track:build   # generates public/track/*.json and review SVGs
npm run dev           # vite on :5173 + game server on :8080
```

Both bind `0.0.0.0` so players on the venue LAN can join by IP. For the demo,
`npm run build` then `npm run server` serves the built client and the track JSON
from the game server itself — one process, one port, one URL to type (§9).

Server environment: `PORT`, `TRACK`, `LAPS`, `CARS`, `AI_FILL`.

`CARS` is the size of the grid: **any number from 1 to 25**. It caps how many can
join and is itself capped by the spawn slots the track provides. `AI_FILL` tops
the grid up with AI when the race starts, and is clamped to `CARS` so the two
settings cannot contradict each other.

```bash
CARS=6 npm run server               # a six-car race, humans only
CARS=6 AI_FILL=6 npm run server     # four people show up, two AI fill the grid
CARS=25 AI_FILL=25 npm run server   # a full grid, if the machine can hold it
```

Anything unusable in either falls back to the default with a warning rather than
producing a zero-car grid.

### How many cars this machine can actually race

The ceiling is the hardware, not the code, so nothing is hardcoded to one number.
Simulation cost is **linear** in the car count — Rapier's broad-phase is not the
problem — at roughly 0.28 ms fixed plus a per-car cost that depends entirely on
the machine.

```bash
npx tsx tools/cpubench.ts     # is this machine throttling? run this first
npx tsx tools/gridscale.ts    # the cost curve, and the largest grid that fits
```

`gridscale` prints ms/step at several grid sizes and the largest that fits the
16.67 ms budget. On a thermally throttled laptop measuring 7.06 ms for a ten-car
step — against the ~1 ms a healthy machine gives — the marginal cost was 0.68 ms
per car and 23 cars fit; scaled to a machine that is not throttling, 25 sits
well inside budget.

You do not have to run either. The server watches its own tick and says so once
if the grid you chose does not hold 60 Hz on the machine you are on:

```
tick is overrunning: p95 20.8 ms against a 16.7 ms budget with 25 cars.
the race will still run, but the server is no longer holding 60 Hz.
restart with a smaller CARS to fix it.
```

The `server` script passes `--max-old-space-size=96`. Without it V8 grows its
heap to absorb snapshot serialisation and RSS climbs to ~167 MB before
asymptoting; with it RSS is flat at ~138 MB, and the tick rate and CPU headroom
are identical either way. See the hour-12 gate in DECISION-LOG.md.

Client query parameters: `?track=oval`, `?server=ws://host:8080`, and the
network simulator `?lag=100&jitter=20&loss=0.02`. **F3** toggles the netcode
overlay.

## Measurement

Nothing here asserts; everything prints numbers you are expected to read. The
hour-12 gate (HANDOFF.md §7) is graded from these.

```bash
npx tsx tools/cpubench.ts                  # is this machine fast enough to trust a gate run
npm test                                   # race logic: lobby, grid entry, laps, standings
npx tsx tools/drivetest.ts interlagos      # vehicle: accel, braking, grip, drop, contact
npx tsx tools/laptest.ts interlagos 10 3   # 10 AI cars, 3 laps: is the track drivable
npx tsx tools/loadtest.ts 10 600           # gate 1 and 5: tick rate, headroom, memory
npx tsx tools/netcheck.ts 100 20 0.02 90   # gate 2 and 3: prediction error, smoothness
```

`npm test` is the fast one (~40 s) and the one to run after any change to
`server/room.ts`. It drives a `Room` through its state machine with no sockets
and asserts the rules that decide whether ten strangers actually get a race.

**Run `cpubench.ts` before any gate run.** It times one fixed workload - 6000
ten-car simulation steps - and prints the cost per step against the 16.67 ms
budget. If it does not read close to 1 ms, the machine is throttling and every
timing-sensitive result is worthless. This was learned the hard way: a mid-session
slowdown to 14.7 ms per step made the server look like it had lost 40% of its CPU
headroom and the netcode look broken, when neither had changed.

`netcheck` takes `lagMs jitterMs loss seconds` and runs the real client modules
against the real server over a real socket. It prints the server's achieved tick
rate first, derived from the ticks stamped on the snapshots it receives, and
marks everything below it invalid when that is not 60 Hz - because it hosts the
server in its own process and a client under load will starve it. Set
`NETCHECK_ATTACH=ws://host:port` to measure against a server running elsewhere. It cannot be run in a browser:
`requestAnimationFrame` is throttled when the tab is hidden, so an automated
browser session measures the harness rather than the netcode.

`npm run track:build` regenerates both circuits, writes a plan-view SVG next to
each, and **fails rather than shipping broken geometry** — it checks winding,
degenerate and NaN vertices, run-off self-overlap, and that the surface query
agrees with the mesh it was built from.

## Phone as steering wheel

A player can steer with their phone instead of the keyboard. Hold it flat in two
hands like a wheel: turn to steer, tilt the far edge down to accelerate, tilt it
back to brake, and keep tilting back once stopped to reverse.

```bash
npm run certs     # once per machine — see below
npm run build && npm run server
```

The lobby shows a four-character code and an address. The player opens that
address on their phone, types the code, and taps Start. Ten laptops each pair
with their own phone; the code is what keeps them apart.

**`npm run certs` is not optional if you want this to work.** Mobile browsers
only expose motion sensors in a secure context: Chrome blocks
`deviceorientation` outside one and iOS needs `requestPermission()`, which needs
one too. Over plain http the controller page loads perfectly and then receives
no sensor readings at all — which looks like a broken feature rather than a
missing certificate. With certs present the server serves https and wss; without
them it serves http exactly as before and nothing else changes. The certificate
is self-signed, so each phone shows a warning once and the player taps through.

Not Bluetooth: Web Bluetooth only drives BLE *peripherals* over GATT, and a
phone browser cannot be a peripheral — there is no web API for it, and phones do
not expose motion sensors as a GATT service. It would need a native app on every
player's phone. Wi-Fi needs nothing installed, and the venue is already running
a LAN for the game (§9).

The phone rides on the game server's port under the path `/pair`, with its own
small message set. `shared/protocol.ts` is untouched: a phone frame joins the
laptop's existing input pipeline exactly like a gamepad, so prediction and
reconciliation never learn it exists. If the phone locks its screen, drops off
Wi-Fi or is backgrounded, frames stop, the link goes stale within 400 ms, and
the keyboard takes over — the car does not hold the last steering angle.

### Race photos

Each player takes a photo on their phone in the lobby, and it rides on a square
above their car for the whole race, so everyone can see whose car is whose. No
camera, or permission refused, is a skip — that car just stays plain.

Photos go over HTTP, never over either WebSocket: the game protocol is frozen
and carries 30 Hz snapshots that a 10 KB image would sit in front of, and the
pairing socket only reaches one phone. The server holds them in memory, publishes
a `{ carId: version }` manifest, and clients poll it and fetch only what changed.

Uploads are bounded on purpose — 64 KB, JPEG magic bytes required, a few dozen
entries with the oldest evicted. This listens on a venue LAN.

### Latency

Measured, because the guess would have been wrong. The transport is not the
problem: phone to relay to laptop and back is **0.9 ms mean, 2.0 ms p95** on a
loopback LAN, and every control frame carries a sequence the laptop echoes, so
the phone shows its own live round trip next to the steering readout.

The delay was in the phone's own filter. Fixed exponential smoothing at 0.35 per
sample took **89 ms to reach 63%** of a steering step and **138 ms to reach
90%** — a hundred times the network cost. It has been replaced with a One Euro
filter, which raises its cutoff with the speed of movement:

| | fixed smoothing | One Euro |
|---|---|---|
| step to 63% | 89 ms | **17 ms** |
| step to 90% | 138 ms | **33 ms** |
| steering from ±0.4° hand tremor | — | **0.000** |

So it is both quicker when you turn and still dead when you are holding it.
Frames are also sent on each sensor reading rather than on a 40 Hz timer, which
removed up to 25 ms of pure quantisation, and `noDelay` is set on the pairing
sockets so Nagle cannot batch small control frames on the venue network.

Tuning lives at the top of `client/src/controller.ts`: `MIN_CUTOFF` for how
still it is when still, `BETA` for how fast it reacts when moving.

The whole chain from tilting the phone to the car turning on screen:

| stage | cost |
|---|---|
| One Euro filter on the phone | 17 ms to 63%, 33 ms to 90% |
| phone → relay → laptop | ~1–2 ms on a LAN |
| client input cadence (`INPUT_HZ` 30) | 0–33 ms, 17 ms average |
| prediction applies it | immediate — the local car is not waiting on the server |

So roughly **35 ms typical**, down from about 155 ms. The input cadence is the
largest remaining term and belongs to the netcode rather than to this feature;
it is tied to `TICKS_PER_INPUT` and to how prediction replays, and moving it
would change results the hour-12 and hour-20 gates were measured against.

To exercise the whole path without a phone in your hand — it also prints the
round trip every five seconds:

```bash
npx tsx tools/phonetest.ts <CODE> weave
```

### Track preview

```bash
npm run dev   # then open http://localhost:5173/preview.html
```

Standalone viewer for the track and environment, with no netcode. `L` flies a
lap from the driver's eye, `G` toggles grid markers, `H` the HUD, `K`/`J` the
lobby and results screens, `1`/`2` switch circuits. A corner has to be judged at
eye level at speed — the build SVG will not tell you it arrives blind.

## Track API

`/track` produces the geometry and the queries; `/server` and `/client` both
consume them. Neither module imports three.js, so the server can use both.

```ts
import { buildTrackMeshes } from './track/src/mesh';
import { TrackSampler } from './track/src/sampler';

const meshes = buildTrackMeshes(track);
// meshes.collision        -> Rapier trimesh (GROUP.TRACK), simplified
// meshes.barrierCollision -> Rapier trimesh (GROUP.BARRIER)
// meshes.visual.*         -> per-material geometry, client only
// meshes.section          -> run-off plan; pass to TrackSampler to share it

const sampler = new TrackSampler(track, meshes.section);
const q = sampler.query(x, z);
// q.surface  -> CarSnap.surface        q.u        -> lap fraction, for position
// q.lateral  -> metres, + is right     q.onTrack  -> false past the barrier
// sampler.props(q.surface) -> { friction, drag }
// sampler.poseAt(s)        -> centreline pose, for the AI waypoint follower
```

`query()` is a single hashed-grid lookup rather than a scan over ~960
waypoints, so it is safe per car per tick and inside prediction replays.

Both server and client build meshes from the same waypoints instead of loading a
GLB, which removes the class of bug where server collision and client visuals
disagree. See DECISION-LOG.md.

## Conventions

- 1 world unit = 1 metre. Y-up, right-handed. kg / s / N.
- Fixed timestep 1/60 s everywhere. Never variable.
- Rotations are quaternions `[x, y, z, w]` on the wire, never Euler.
- Cars spawn facing −Z; the start/finish line faces −Z.
- **Positive `steer` turns right.** The single conversion to the physical wheel
  angle (positive left) lives in `Car.step()`. Do not add a second one.
- One client input covers exactly `TICKS_PER_INPUT` (2) server ticks. Client
  prediction must replay each input for the same count or the local car drifts
  from the server by a constant factor.

## When something looks like a netcode bug

Check these first, in order (§10):

1. Rapier is the same exact version on both sides — it is pinned, but check.
2. Both sides are stepping at `FIXED_DT`, never a variable dt.
3. Both built their world through `createRaceWorld()`.
4. Run `tools/netcheck.ts` with zero lag and zero loss. If prediction error is
   not ~0.001 m there, the problem is not the network.
