# DECISION-LOG.md

Running log of decisions, deviations from HANDOFF.md, and gate results.
Newest blockers go at the very top so they are seen first.

---

## BLOCKERS

### 2026-09-07 — Cannot push to CRYPT-hack/nascar (needs the human)

Commits are landing locally but **nothing is reaching GitHub.** The `gh` CLI on
this machine is authenticated as `kartikeyBishnoi`, which has read-only access:

```
gh api repos/CRYPT-hack/nascar --jq .permissions
{"admin":false,"maintain":false,"pull":true,"triage":false,"push":false}
```

`git push` returns 403. This needs one of:

1. add `kartikeyBishnoi` as a collaborator with write access on the repo, or
2. re-authenticate `gh` as the `CRYPT-hack` account (`gh auth login`), or
3. say the word and I will push to a fork under `kartikeyBishnoi` and open a PR.

Nothing is lost — every step is committed locally on `main` and will push as
soon as access exists. Instance B is continuing to build against local commits
rather than idling. Instance A cannot see any of the track work until this is
resolved.

A repo-local credential helper (`credential.helper = !gh auth git-credential`)
is already configured, so a push will work the moment permissions change. Global
git config was not touched.

---

## Instance A — scope

Per HANDOFF.md §4: `/vehicle/`, `/server/`, and the prediction/interpolation
parts of `/client/`. Car physics, input, camera, authoritative loop, prediction,
reconciliation, remote interpolation, race state machine, lap/checkpoint
validation, car-to-car collision response.

---

## Decisions

### 2026-09-07 — FOR INSTANCE A: track geometry and queries are now available

`track/src/mesh.ts` and `track/src/sampler.ts` are the two entry points. Neither
imports three.js, so the server can use both.

```ts
import { buildTrackMeshes } from '../track/src/mesh';
import { TrackSampler } from '../track/src/sampler';

const meshes = buildTrackMeshes(track);
// meshes.collision        { vertices: Float32Array, indices: Uint32Array }  -> Rapier trimesh, GROUP.TRACK
// meshes.barrierCollision same shape                                        -> Rapier trimesh, GROUP.BARRIER
// meshes.visual.*         positions/normals/uvs/indices per material        -> client only
// meshes.section          run-off plan; pass it to TrackSampler to share the work

const sampler = new TrackSampler(track, meshes.section);
const q = sampler.query(car.x, car.z);
// q.surface   SurfaceKind, straight into CarSnap.surface
// q.u         lap fraction 0..1, for race position ordering
// q.lateral   signed metres from the centreline, + = right
// q.onTrack   false once past the barrier line
// sampler.props(q.surface) -> { friction, drag } from the track's own table
// sampler.poseAt(s)        -> centreline pose, for the Tier 2 AI waypoint follower
```

`query()` is a single hashed-grid cell lookup, not a scan over ~960 waypoints —
safe to call per car per tick, and inside prediction replays.

Collision is 4800 triangles against 13440 visual (Interlagos), from a coarser
longitudinal stride and no centre column, satisfying HANDOFF.md §5.3's
"separate, simplified trimesh".

### 2026-09-07 — Banking sign was inverted; regenerated track JSON has it flipped

**Instance A: if you have already read `banking` from the track JSON, re-read it.**
The values changed sign. The schema and its documented meaning are unchanged
(`positive = banked right`); the generator was emitting the wrong sign for it.

`spline.ts` computes its 2D cross product over `(x, z)`. Read as a plain 2D
plane that makes positive curvature a left turn, but embedded in a Y-up frame it
is the opposite: **positive curvature has the apex on the right.** `generate.ts`
used the plain-2D reading, so every corner came out banked the wrong way — the
inside raised, throwing the car off the road rather than holding it on.

Two consequences, both fixed:

- banking is now `-curvature * BANK_GAIN`; 0 of 330 corners are off-camber
- run-off narrowing and gravel placement in `section.ts` were on the wrong side

The convention is now stated in `section.ts` where it is used, because it is not
derivable by inspection and this is the second thing it has broken.

### 2026-09-07 — Run-off width is bounded by the corner, and the bound is enforced

An offset curve taken a distance `o` inside a corner of radius `R` collapses at
`o = R` and inverts beyond it. A flat 14 m run-off plus half the track width
reaches past the centre of Pinheirinho (20.7 m radius), so the ribbon folded
over itself and the barrier crossed to the far side of the corner.

Run-off width is therefore per-side and per-waypoint. A curvature-derived limit
sets the shape, and then `enforceNoFold()` relaxes the widths until the barrier
line provably advances along the lap everywhere — authored intent, then a hard
constraint, the same structure as the gradient limiter.

Nothing was authored by hand: no edit to `circuits.ts` can produce a folded
ribbon, on this circuit or a future one.

### 2026-09-07 — Geometry is checked at build time, by checks that cannot share the bug

`npm run track:build` now fails rather than writing geometry that is wrong. The
checks target failures that are expensive to diagnose from inside the game:
inverted winding (road invisible from the cockpit — reads as a culling bug),
mesh/sampler disagreement (car on visible asphalt gets grass friction — reads as
a netcode bug), NaN vertices (Rapier silently builds no collider and cars fall
through the world), and ribbon self-overlap.

One lesson worth keeping: the first version of the fold check re-derived "which
side is the inside" the same way `section.ts` did, so when that convention was
backwards **the check agreed with the bug and passed**. It was the winding
check — which measures the built triangles instead of re-deriving intent — that
caught it. The fold check now measures whether the barrier line actually
advances, and shares no assumption with the code it validates.

### 2026-09-07 — Track generator landed before role assignment

The `/track/` generator, both circuits, and the generated JSON were written in a
single-instance session before the A/B split was made. It is committed as-is
rather than thrown away. Instance B owns `/track/` from here.

Both circuits validate and build:

| | oval (placeholder) | interlagos |
|---|---|---|
| lap length | 1786 m | 2883 m |
| min width | 16 m | 12.5 m |
| min radius | 107 m | 20.7 m |
| max gradient | 1.7% | 8.5% |
| self-crossings | 0 | 0 |
| min clearance | 88 m | 86.5 m |

So Instance A is **not** blocked waiting on a track (HANDOFF.md §6). Development
uses the oval first because its geometry is trivially verifiable; Interlagos is
switched in once the vehicle is stable.

### 2026-09-07 — Track meshes are procedural, not GLB

**Deviation from HANDOFF.md §5.3.** The schema fields `collisionMesh` and
`visualMesh` are kept, but carry `"procedural:collision"` / `"procedural:visual"`
instead of a `.glb` filename. Both server and client call the same
`buildTrackMeshes(trackData)` on the waypoints they already have.

Why: a GLB pipeline needs an exporter, an importer, and a rule that the two stay
in sync. Generating from the waypoints removes the whole class of "server
collision does not match client visual" bugs, which look exactly like netcode
bugs and would burn hours to diagnose (§10). §5.3's actual requirement — that
collision is a *separate simplified trimesh*, not the decorative geometry — is
still honoured: the generator emits collision at a coarser step than visual.

Cost if this is wrong: swapping back to GLB means writing a loader and pointing
these two fields at real files. The schema does not have to change.

### 2026-09-07 — Elevation profile is clamped, not hand-tuned

Interlagos as authored produced a 15% gradient at Junção, which is not drivable.
Rather than hand-tuning elevation keys until it looked right, `generate.ts` runs
a Gauss-Seidel slope limiter that clamps the closed height profile to 8.5%.
Authored elevation is intent; the limiter is the constraint. No plausible edit to
`circuits.ts` can now produce a track that cannot be driven.

### 2026-09-07 — Custom raycast vehicle rather than Rapier's built-in

Rapier 0.14.0 ships `DynamicRayCastVehicleController`. Not used. A hand-written
raycast vehicle in `/vehicle/` is ~300 lines and gives direct control over the
tyre slip curves, which is what determines whether the car is fun to drive and
whether two cars can touch at 100 km/h without launching (gate check 4).

The built-in controller's tyre model is a Bullet port whose behaviour is tuned
through opaque parameters; getting a specific feel out of it is guesswork.
More importantly for this build, prediction replays the same step function many
times per frame, and a vehicle whose entire state lives in the rigid body plus
an explicit struct is far easier to reason about under rollback than one with
hidden internal state.

Cost if this is wrong: the built-in controller is a drop-in for `stepVehicle()`.
