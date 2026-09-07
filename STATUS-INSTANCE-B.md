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

### Not started, in my scope

| Item | Notes |
|---|---|
| Audio | `/assets/` is mine per §4, but audio is in neither the §4 bullets nor the §6 plan. Unclaimed by either instance. A silent racing game demos noticeably worse. |
| Car visuals and liveries | Ownership ambiguous. A owns `/vehicle/` physics; car *meshes and liveries* are assigned to nobody. `CAR_COLORS` already sits in `/shared/`. If nobody takes it, the cars are placeholder shapes at the demo. |

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
- A live ten-car grid: positions render correctly through the HUD (P6/10,
  updating as the field moves), and the frame budget holds at **6.9 ms median,
  7.7 ms p95** with ten cars, prediction and interpolation — inside 16.67 ms.

**Not verified:**

- Nobody has driven a full three-lap race to a results screen by hand. The
  lobby → grid → countdown → racing path is verified; `finished` and the results
  table have only been seen with placeholder data.
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
