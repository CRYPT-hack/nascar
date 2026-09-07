# STATUS — Instance B (track, environment, presentation)

Scope is HANDOFF.md §4: `/track/`, `/assets/`, and the visual/HUD parts of
`/client/`. Instance A owns `/vehicle/`, `/server/`, and prediction/interpolation.

Last updated 2026-09-07. Written by Instance B.

---

## 1. BLOCKER — nothing has reached GitHub

**8 commits are sitting on local `main`. None of them are pushed.**

The `gh` CLI on this machine is authenticated as `kartikeyBishnoi`, which has
read-only access to `CRYPT-hack/nascar`:

```
$ gh api repos/CRYPT-hack/nascar --jq .permissions
{"admin":false,"maintain":false,"pull":true,"triage":false,"push":false}

$ git push origin main
remote: Permission to CRYPT-hack/nascar.git denied to kartikeyBishnoi.
fatal: ... 403
```

Needs one of:

1. add `kartikeyBishnoi` as a collaborator with **write** access, or
2. re-authenticate `gh` as the `CRYPT-hack` account (`gh auth login`), or
3. say so, and I will push to a fork under `kartikeyBishnoi` and open a PR.

A repo-local credential helper (`credential.helper = !gh auth git-credential`)
is already configured, so a push will succeed the moment permissions change.
Global git config was not touched.

**Consequence:** Instance A cannot see any track work — including the mesh and
sampler API its server needs, and the banking sign correction.

---

## 2. Done

### §4 scope

| Item | State |
|---|---|
| Track generator: waypoints → visual mesh + collision mesh | done |
| Interlagos centreline, widths, elevation, banking | done |
| Surface types (asphalt / kerb / grass / gravel) with friction tags | done |
| Skybox, barriers, run-off areas, basic trackside geometry | done |
| HUD: position, lap counter, lap time, speed, draft indicator | done |
| Lobby / results screen | done |

### §6 hour-by-hour plan

Every Instance B row is complete except the last, which is the push blocker:

| Hour | Task | State |
|---|---|---|
| 0–1 | Read `/shared/`, confirm schema, scaffold `/track/` | done |
| 1–3 | Waypoints → ribbon mesh + collision trimesh | done |
| 3–5 | Placeholder oval in the real schema | done |
| 5–7 | Interlagos centreline, corners approximated | done |
| 7–9 | Elevation, surface tagging, barriers | done |
| 9–11 | Kerbs, run-off, basic HUD | done |
| 11–12 | Hand the first real Interlagos JSON to A | **blocked on §1** |

### Current numbers

Interlagos, from `npm run track:build`:

```
lap length     2883.3 m       min width      12.5 m
min radius     20.7 m         max gradient   8.5%
elevation      -26.99 .. 0.93 m
self-crossings 0              min clearance  86.5 m
collision      4800 tris (0.357 of visual)
barriers       1920 tris      visual         13442 tris
gravel run-off 11.7% of edges
sampler error  0 m lateral, 0 m height
```

Rendering, measured in the browser: **148k triangles, 17 draw calls, 8.4 ms
median frame** on Interlagos (7.1 ms on the oval). Scenery is ~1400 trees,
~1900 spectators in stands, ~1000 along the barriers, all instanced.

### Files

```
track/src/    spline circuits generate mesh section sampler checks build
client/src/render/   scene materials track-view trackside scenery rng
client/src/hud/      hud screens hud.css
client/src/preview.ts
preview.html
```

~4700 lines. `/shared/` is **untouched** — verified with
`git diff c20d45d HEAD -- shared/`, which is empty.

---

## 3. What Instance A needs to know

### 3.1 The track API

`track/src/mesh.ts` and `track/src/sampler.ts`. Neither imports three.js, so the
server can use both.

```ts
import { buildTrackMeshes } from '../track/src/mesh';
import { TrackSampler }     from '../track/src/sampler';

const meshes = buildTrackMeshes(track);
// meshes.collision         -> Rapier trimesh, GROUP.TRACK    (4800 tris)
// meshes.barrierCollision  -> Rapier trimesh, GROUP.BARRIER  (1920 tris)
// meshes.visual.*          -> per-material geometry, client only
// meshes.section           -> run-off plan; pass to TrackSampler to share it

const sampler = new TrackSampler(track, meshes.section);
const q = sampler.query(car.x, car.z);
// q.surface  -> straight into CarSnap.surface
// q.u        -> lap fraction 0..1, for race position ordering
// q.lateral  -> signed metres from centreline, + is right
// q.onTrack  -> false once past the barrier line
// sampler.props(q.surface) -> { friction, drag } from the track's own table
// sampler.poseAt(s)        -> centreline pose, for the Tier 2 AI follower (§8)
```

`query()` is a single hashed-grid cell lookup, not a scan over ~960 waypoints —
safe per car per tick and inside prediction replays.

### 3.2 Banking values changed sign — re-read the track JSON

`spline.ts` takes its cross product over `(x, z)`, which reverses the usual
reading once embedded in a Y-up frame: **positive curvature has its apex on the
right, not the left.** Every corner was banked inside-up, i.e. off-camber.

Fixed; 0 of 330 corners are now off-camber. The schema and its documented
meaning are unchanged (`positive = banked right`) — only the generated values
moved. **If you already read `banking`, read it again.**

### 3.3 Things left deliberately for A

- `index.html` and `client/src/main.ts` do not exist. I did not create them so as
  not to squat on the game entry. `vite build` currently points at
  `preview.html`; add `index.html` alongside it in `vite.config.ts` when the game
  entry lands.
- The HUD and screens own **no** race logic. Call `hud.update(state)` per frame
  with a plain `HudState`, and `screens.showLobby()` / `showResults()` on the
  matching server messages. The race state machine stays entirely yours.
- `drafting` on `HudState` is rendered but never computed — that is a physics
  question, so it is your call to set.

---

## 4. Left to do

### Blocked

- **Push access** (§1). Everything else below is downstream of this.
- Hand the Interlagos JSON to A and confirm the server builds a Rapier world
  from `meshes.collision`. Cannot be done until A has the code.

### Not started, in my scope

| Item | Notes |
|---|---|
| Audio | `/assets/` is mine per §4, but audio is not in the §4 bullet list. Engine/tyre/ambient sound is unclaimed by either instance. Flagging rather than assuming. |
| Car visuals and liveries | Ownership ambiguous — see §5. |

### Needs A before it can be finished

- Wiring HUD/screens into the real game entry and driving them from snapshots.
- Verifying the HUD against real lap and position data. It has only ever been
  driven by the preview fly-through.

### Deliberately not built

- GLB export pipeline — meshes are procedural on both sides by design
  (DECISION-LOG). Nothing needs it.
- Minimap — not in the §4 HUD list. `sampler.query().u` makes it cheap if wanted.
- Catch fencing above the barriers — characteristic, but needs transparency
  sorting for marginal gain.

---

## 5. Open questions (only the human can settle)

1. **Who renders the cars?** §4 gives A `/vehicle/` and gives me "the visual
   parts of `/client/`". Car *physics* is clearly A's; car *meshes and liveries*
   are not assigned. `CAR_COLORS` already sits in `/shared/`. If nobody claims
   this, the cars will be untextured boxes at the demo. I can take it — say the
   word.
2. **Is audio in scope at all?** It is not in the §4 bullets and not in the §6
   plan. A silent racing game demos noticeably worse.

---

## 6. What is verified, and what is not

Being explicit, because §7 warns that a generous self-grade costs the demo.

**Verified:**

- `npm run track:build` passes all geometry checks on both circuits, and
  **fails the build** rather than shipping bad geometry. It checks winding,
  degenerate and NaN vertices, index bounds, run-off self-overlap, that
  collision is simpler than visual, and that the sampler agrees with the mesh
  it was built from (0 m lateral and height error).
- `tsc --noEmit` clean; `vite build` succeeds.
- Renders in-browser: 17 draw calls, 148k tris, 8.4 ms median frame.
- 0 trees or spectators inside the barrier line, checked against the sampler.
- HUD values, lobby roster and results table read correctly from the DOM;
  no panel overlap at 664 px wide.
- Both circuits load, switch and rebuild scenery without error.

**Not verified:**

- Never run against a real server, real snapshots, or any netcode. None exists yet.
- Never tested in Safari. §9 warns its WebGL and audio differ enough to bite.
- Never tested on a projector, which is what the contrast and fog were tuned for.
- No load test, and no test with 10 cars in the scene — the 8.4 ms frame budget
  has not been measured with A's cars and physics on top.
- Frame timings are from this machine only.

---

## 7. Two bugs worth remembering

Both were found by measuring output, not by reading code.

**The fold check agreed with the bug.** My first run-off fold check re-derived
"which side is the inside" the same way `section.ts` did. When that convention
turned out to be backwards, the check inherited the same mistake and passed.
What caught it was the *winding* check, which measures the built triangles
instead of re-deriving intent. The fold check now measures whether the barrier
line actually advances along the lap, and shares no assumption with the code it
validates.

**The entire crowd was invisible.** All 1898 spectators and the seating deck
were positioned inside the grandstand's 9 m solid substructure. Nothing in the
type system or the tests could catch it; it took a screenshot. Worth keeping in
mind for the rest of the visual work — look at it, do not reason about it.
