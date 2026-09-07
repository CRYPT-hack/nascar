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

Server environment: `PORT`, `TRACK`, `LAPS`, `AI_FILL` (fill the grid with AI).

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
npx tsx tools/drivetest.ts interlagos      # vehicle: accel, braking, grip, drop, contact
npx tsx tools/laptest.ts interlagos 10 3   # 10 AI cars, 3 laps: is the track drivable
npx tsx tools/loadtest.ts 10 600           # gate 1 and 5: tick rate, headroom, memory
npx tsx tools/netcheck.ts 100 20 0.02 90   # gate 2 and 3: prediction error, smoothness
```

`netcheck` takes `lagMs jitterMs loss seconds` and runs the real client modules
against the real server over a real socket. It cannot be run in a browser:
`requestAnimationFrame` is throttled when the tab is hidden, so an automated
browser session measures the harness rather than the netcode.

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
