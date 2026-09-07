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
server/     Authoritative simulation + room management
client/     three.js rendering, input, prediction, camera, HUD
vehicle/    Car physics, shared by server and client
track/      Track generator (source); output lands in public/track/
public/     Static assets served by Vite; generated track JSON
tools/      Load test harness and dev utilities
```

## Running

```bash
npm install
npm run track:build   # generates public/track/*.json
npm run dev           # vite on :5173 + game server on :8080
```

Both bind `0.0.0.0` so players on the venue LAN can join by IP.

`npm run track:build` regenerates both circuits, writes a plan-view SVG next to
each, and **fails rather than shipping broken geometry** — it checks winding,
degenerate and NaN vertices, run-off self-overlap, and that the surface query
agrees with the mesh it was built from.

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
