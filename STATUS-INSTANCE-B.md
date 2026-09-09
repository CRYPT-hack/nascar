# STATUS — Instance B (track, environment, presentation)

Scope is HANDOFF.md §4: `/track/`, `/assets/`, and the visual/HUD parts of
`/client/`. Instance A owns `/vehicle/`, `/server/`, and prediction/interpolation.

Last updated 2026-09-07, after merging with Instance A's work.

---

## 1. Current state

Push access was granted, and Instance B's 8 commits are merged with Instance A's
16. **The tree builds, all of A's tests pass, and the physics is byte-identical
to what A's gates were run against.**

| Check | Result |
|---|---|
| `npm test` (A's race logic) | 33/33 pass |
| `npm run track:build` geometry checks | pass, both circuits |
| `tsc --noEmit` | clean |
| `vite build` | builds `index.html` **and** `preview.html` |
| `tools/laptest.ts interlagos 10 3` | 10/10 finish, identical lap times to A's baseline |
| `public/track/*.json` vs `origin/main` | byte-identical |

There is no open blocker.

---

## 2. Done

### §4 scope

| Item | State |
|---|---|
| Track generator: waypoints → visual mesh + collision mesh | done |
| Interlagos centreline, widths, elevation, banking | done |
| Surface types (asphalt / kerb / grass / gravel) with friction tags | done |
| Skybox, barriers, run-off areas, basic trackside geometry | done |
| HUD: position, lap counter, lap time, speed, draft indicator | done, **in the game** |
| Lobby / results screen | done, **in the game** |

### Numbers

Interlagos: 2883.3 m lap, 12.5 m minimum width, 20.7 m minimum radius, 8.5 %
maximum gradient, 0 self-crossings. Collision 4800 tris against 13442 visual.

Rendering: **148k triangles, 17 draw calls, 8.4 ms median frame** (7.1 ms on the
oval). Scenery is ~1400 trees, ~1900 spectators in stands, ~1000 along the
barriers, ~66 tyre stacks — all instanced, all decorative, none colliding.

### Files

```
track/src/          spline circuits generate mesh section sampler checks build
client/src/render/  scene materials track-view trackside scenery rng
client/src/hud/     hud screens hud.css
client/src/preview.ts + preview.html      standalone track/environment viewer
```

`/shared/` has no Instance B edits. Two semantic clarifications were appended to
CHANGELOG-SHARED.md; neither changes a field, type or wire shape.

---

## 3. Left to do

### ~~Integration with Instance A~~ — done

Instance A's `client/src/scene.ts` and `client/src/ui.ts` were placeholders
marked for replacement. Both are now replaced, keeping the exact public API
`main.ts` calls, so no netcode wiring changed. The game entry (`index.html`)
draws the real environment and HUD; `/preview.html` remains as the harness.

Verified by playing it: join, roster, ready, FORM UP, countdown, GO, the banner
clearing itself, and the lap clock running against the live server.

Still open in the same area, and both are Instance A's:

- `setDrafting()` exists on `Ui` but nothing calls it, so the draft indicator
  stays dark. Slipstream detection is a physics question.
- Nothing sets a spectator camera; `setSpectating()` shows the notice, but the
  view stays where the local car would be.

### ~~Cross-section constants disagree~~ — done

`track/src/section.ts` now mirrors `vehicle/track-collision.ts` exactly. Verified
analytically against A's own band table over every waypoint on both circuits:
worst height difference 0.00000 m, worst barrier offset difference 0.0000 m.

The physics builder owns those numbers. If they ever change, change both files.

### ~~Phone as steering wheel~~ — done

Players can steer with a phone's motion sensors over Wi-Fi. Pairing relay on
`/pair`, controller page at `/controller.html`, code shown in the lobby.

Bluetooth was ruled out, not skipped: Web Bluetooth only drives BLE peripherals
over GATT and a phone browser cannot be one, so it would need a native app.

`shared/protocol.ts` is untouched — a phone frame joins the laptop's input
pipeline like a gamepad, so the netcode never learns it exists.

`npm run certs` is required for it: mobile browsers only expose motion sensors
in a secure context, and over plain http the page loads and no event ever fires.
Without certs the server serves http exactly as before.

Latency was measured rather than guessed, and the guess would have been wrong.
The transport is 0.9 ms mean round trip; the delay was the phone's own smoothing
filter, at 89 ms to 63% of a steering step and 138 ms to 90%. A One Euro filter
took that to 17 ms and 33 ms while still rejecting hand tremor completely.
Frames now go out on each sensor reading rather than on a 40 Hz timer.

### ~~Audio~~ — done

Synthesised in the Web Audio graph, no files: engine through a five-speed
gearbox, wind by speed, tyre noise coloured by the surface under the car,
countdown pips, and impacts derived from a sudden loss of speed. Starts on the
join or ready click, because browsers refuse otherwise, and there is a SOUND
toggle in the HUD.

### ~~Live leaderboard~~ — done

The standings were already computed from every snapshot and discarded. They are
now a live running order: place, colour, name, metres to the leader, local car
picked out. Rows are mutated rather than rebuilt, so a 30 Hz update does not
thrash layout.

### ~~Car visuals~~ — Instance A took this

A landed a car model ("Give the car a face"), so the ownership question in
earlier versions of this document is settled.

### ~~Race photos~~ — done

Captured on the phone in the lobby, relayed to the laptop, uploaded over HTTP,
polled by every client, and drawn billboarded above the car. `shared/protocol.ts`
untouched.

### ~~Grid size~~ — done, and raised to 25

`CARS` sets how many cars race — any number from 1 to 25. `AI_FILL` is clamped
to it so the two cannot contradict.

`MAX_PLAYERS` went from 10 to 25, which is a change to the frozen
`shared/constants.ts` and is logged in CHANGELOG-SHARED.md. The colour list grew
to match, and the spawn grid is now generated to `MAX_PLAYERS` slots.

The ceiling is the machine, not the code: cost is linear at ~0.68 ms per car on
a throttled laptop and around a seventh of that on a healthy one. Rather than
hardcode a number that would be wrong elsewhere, `tools/gridscale.ts` measures
the curve and the server warns once if the chosen grid does not hold 60 Hz on
the machine it is running on.

### Not started, in my scope

Nothing outstanding.

### Deliberately not built

- GLB pipeline — meshes are procedural on both sides by design.
- Minimap — not in the §4 HUD list. `sampler.query().u` makes it cheap if wanted.
- Catch fencing above the barriers — needs transparency sorting for marginal gain.

---

## 4. What is verified, and what is not

**Verified:**

- Everything in the table in §1.
- `track:build` **fails** rather than shipping bad geometry: winding, degenerate
  and NaN vertices, index bounds, run-off self-overlap, collision simpler than
  visual, and sampler/mesh agreement (0 m lateral and height error).
- The renderer's banking now matches the physics builder's to **0.07 mm** of
  road-edge height, cross-checked against `frameAt()` across the circuit.
- 0 trees or spectators inside the barrier line, checked against the sampler.
- HUD values, lobby roster and results table read correctly from the DOM.
- Both circuits load, switch and rebuild scenery without error.
- A full race run to completion against a live server with a phone driving:
  lobby → grid → countdown → racing → finished → results, with real data
  ("CPU 1 wins", correct order, formatted lap times, DNF for the car that spent
  the race in a barrier) and back to the lobby. Zero console errors.
- Live running order tracking positions and gaps through a race; engine pitch
  following road speed across the gearbox; countdown pips firing once each.
- All seven HUD elements checked for pairwise overlap: none.
- Phone control latency: 0.9 ms mean / 2.0 ms p95 transport round trip, and a
  steering step reaching 90% in 33 ms after the filter change, down from 138 ms.
  Hand tremor of ±0.4° still produces exactly zero steering.
- Phone control end to end: a simulated phone drove the car from 0 to 77 km/h
  over the relay, and killing it mid-drive released the throttle immediately
  rather than holding the last input. Angle mapping checked against hand
  calculations at several tilts. HTTPS and WSS verified with generated certs.
- A 25-car field: 25 of 25 AI finish a lap, contact clean (worst attitude 0.98,
  greatest height 0.21 m, zero frames above 1.1 m), all 25 spawn slots on asphalt
  with 4.8 m to the road edge, 25 leaderboard rows scrolling in dense mode, and
  25 colour choices offered. The tick-budget warning fires correctly at that size
  on this machine.
- A live ten-car grid: positions render correctly through the HUD (P6/10,
  updating as the field moves), and the frame budget holds at **6.9 ms median,
  7.7 ms p95** with ten cars, prediction and interpolation — inside 16.67 ms.

**Not verified:**

- Frame timings and latency figures are from this machine only, and this machine
  is thermally throttled: `cpubench` reads 7.06 ms for a ten-car step against the
  ~1 ms a healthy machine gives. Every absolute timing here is a lower bound.
- **A 25-car field has never been seen rendered.** The browser pane stopped
  compositing (`document.hidden`, zero rAF frames), so the server side, the
  leaderboard and the contact behaviour were all verified at 25 but the drawn
  scene and the client frame rate at that size were not.
- **The controller has never run on a real phone.** Everything was verified with
  synthetic `deviceorientation` events on desktop and a node client. The tilt
  ranges, the deadzone and the smoothing are reasoned defaults, not tuned
  against a hand — expect to adjust `STEER_RANGE`, `THROTTLE_RANGE` and
  `BRAKE_RANGE` in `client/src/controller.ts` after one lap on real hardware.
  The forward-tilt direction has a "Tilt: normal/flipped" toggle on the phone
  precisely because that sign is the most likely thing to be wrong per device.
- Never tested in Safari (§9 warns its WebGL and audio differ).
- Never tested on a projector, which is what the contrast and fog were tuned for.
- Frame timings are from this machine only.

---

## 5. One known cosmetic defect

The barrier line doubles back by about 0.66 m over three waypoints on the inside
of Bico de Pato. It is in the shared cross-section, not in one half of it: A's
collision mesh contains the same fold as one inverted triangle out of 4800.

Left alone deliberately. Narrowing the run-off in `section.ts` alone would only
move the visible barrier away from the real one, and changing
`vehicle/track-collision.ts` would invalidate gate results for one triangle at a
corner where ten AI cars already run 0.0–2.3% off-track. `npm run track:build`
reports it as a note.

---

## 6. The mistake worth keeping

I flipped the generator's banking sign, believing every corner was banked
off-camber. It was not, and the flip put **eight of ten AI cars off the road**.

`Waypoint.banking` is documented as "positive = banked right", which never says
which way the surface tilts. `vehicle/track-collision.ts` rolls the frame one
way and `track/src/mesh.ts` rolled it the other. Each half was internally
consistent, so the generator plus the physics builder had been producing correct
camber all along — only the *rendered* road leaned wrong. I read the renderer's
convention, concluded the generator was wrong, and changed the wrong thing.

| | before | after the flip |
|---|---|---|
| finishers | 10 / 10 | 2 / 10 |
| off-track | 0.0–2.3 % | 65–90 % |

Reverted; the renderer was changed to match the physics instead, and the
convention is now written down in CHANGELOG-SHARED.md.

Two things to carry forward. **Reasoning about a sign convention from one side of
a boundary is not evidence about the system** — both readings looked right in
isolation, and only running the car settled it. And **the check that caught it
was behavioural**, ten cars driving three laps, not a geometry assertion. My
build-time geometry checks passed happily throughout, because the geometry was
internally consistent the whole time. They could not have caught this, and no
stricter version of them would have.

This is the second time a convention error in this area cost real time — the
first put the run-off fold check in agreement with the bug it was meant to
catch. Both were caught by measuring behaviour, never by reading code.
