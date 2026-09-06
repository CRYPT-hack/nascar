# DECISION-LOG.md

Running log of decisions, deviations from HANDOFF.md, and gate results.
Newest blockers go at the very top so they are seen first.

---

## BLOCKERS

_None._

---

## Instance A — scope

Per HANDOFF.md §4: `/vehicle/`, `/server/`, and the prediction/interpolation
parts of `/client/`. Car physics, input, camera, authoritative loop, prediction,
reconciliation, remote interpolation, race state machine, lap/checkpoint
validation, car-to-car collision response.

---

## Decisions

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

### 2026-09-07 — Vehicle is all-wheel drive, 40/60 front to rear

Rear-wheel drive was built first and measured: traction-limited off the line to
about 6.2 m/s^2, giving 0-100 km/h in 5.2 s. Four driven wheels gives 2.9 s.

The stronger argument is not the lap time. Ten people who have never played this
are going to mash the throttle at the same green light. A car that snaps into
oversteer on corner exit turns the opening lap into a demolition derby, and the
demo is ten people spinning on the grid.

### 2026-09-07 — Measured vehicle behaviour (baseline)

Recorded so a later change that breaks the car is obvious. `npx tsx
tools/drivetest.ts interlagos`.

| | measured |
|---|---|
| 0-100 km/h | 2.92 s |
| 0-200 km/h | 8.50 s |
| top speed | 227 km/h |
| braking from 227 km/h | 119.7 m, 1.70 g average |
| skidpad, sustained | 1.31 g at 123 m radius |
| drop from 6 m at 126 km/h with spin | recovers upright, does not sink |
| contact at 100 km/h, 1.5 and 6.0 m/s closing | no flip, no launch, both keep running |

Two bugs worth recording because both produced *plausible-looking* output:

1. **Rapier forces are persistent.** `addForce`/`addForceAtPoint` reapply every
   step until `resetForces()`, they are not per-step accumulators. Without the
   reset the suspension force compounded and the car was 50 m in the air within
   two seconds. `Car.step()` now resets forces and torques first.

2. **The first contact test passed while never making contact.** Steering two
   cars together does not work: speed-sensitive steering means quarter lock at
   150 km/h barely moves the car, and the two stayed 4.4 m apart for the whole
   run. The test reported a clean pass. It now imposes closing velocity directly
   and asserts the gap actually fell below the width of a car.

The second is the more dangerous class of bug and is worth remembering at the
hour-12 gate: a check that cannot fail is worse than no check, because it buys
false confidence. Every gate check must be able to distinguish a pass from a
vacuous pass.
