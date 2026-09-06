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

## Conventions

- 1 world unit = 1 metre. Y-up, right-handed. kg / s / N.
- Fixed timestep 1/60 s everywhere. Never variable.
- Rotations are quaternions `[x, y, z, w]` on the wire, never Euler.
- Cars spawn facing −Z; the start/finish line faces −Z.
