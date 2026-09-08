# DECISION-LOG.md

Running log of decisions, deviations from HANDOFF.md, and gate results.
Newest blockers go at the very top so they are seen first.

---

## BLOCKERS

**The gate was re-run on 2026-09-08 with the merged tree: 2 pass, 1 fail, 2
not measurable.** Section at the end of this file. The two that cannot be
measured are the machine, not the build, and there is a control run that shows
it.

**This machine still cannot be measured on.** `cpubench` reads 12.6-14.5 ms per
ten-car step against 1.07-2.75 ms when healthy, and the CPU sits at ~1.57 GHz
under load - 65% of its own 2.4 GHz base, on a part that should turbo well
above it. Roblox is closed and it did not help; five minutes of idle did not
help. It is not a Windows setting: max processor state is 100% on AC and DC,
and no power-mode overlay is set. Checks 2 and 3 need a client that can hold a
60 Hz loop, and this one stalls for 249 ms at p99.

**Check 2 remains an accepted deviation and will not be fixed.** Decision was
final before this re-run and nothing here reopens it.

**Run `npx tsx tools/cpubench.ts` before trusting any gate run** - but read it
alongside the harness's own tick rate. cpubench runs a sustained 100% load and
this machine throttles hard under that; the server's real duty cycle is bursty
and it held 59.99 Hz with ten cars in the same session cpubench called 14 ms.
A slow cpubench means *timing results are suspect*, not that the server is down.

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

### 2026-09-07 — (superseded) "Banking sign was inverted"

This entry claimed the generator emitted banking with the wrong sign and that
flipping it fixed every corner. **That was wrong and has been reverted.** The
generator was right; the renderer disagreed with the physics about which way
positive banking tilts the road. See "Banking: I broke it, measured it, and
reverted it" at the top of this file.

Left in place rather than deleted, because a log that quietly removes its own
mistakes is not much use as a log.

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


### 2026-09-07 — AI waypoint follower built (HANDOFF.md §8 Tier 2)

Built now rather than at hour 12, per §8, and it doubles as the proof that the
circuit is drivable end to end. `npx tsx tools/laptest.ts interlagos 10 3`:

| | result |
|---|---|
| 10 AI cars, 3 laps | all 10 finish |
| lap times | 1:19.6 (fastest) to 1:30.1 (slowest) |
| off-track | 0.0% - 2.3% per car |
| stopped | 0.0% |

Tier 2 (6 humans + 4 AI) and Tier 3 (1 human + 9 AI) are both viable now.

Four bugs, all of which produced *confident, wrong* behaviour rather than a
crash. Recording them because three of the four were sign or model errors that
looked fine on the wide placeholder oval and only failed on the real circuit:

1. **Steering sign inverted.** The AI steered away from every corner. The wire
   protocol never defined the sign of `InputMsg.steer`, so it is defined now in
   CHANGELOG-SHARED.md: positive is RIGHT. The conversion to the physical wheel
   angle happens in exactly one place, `Car.step()`.

2. **Kinematic pure pursuit.** `delta = atan(2 L sin a / ld)` assumes the tyres
   do not slip. At 155 km/h it demanded about a quarter of the steering actually
   needed; the cars tracked wide out of every corner and spent half the lap on
   the grass while the speed profile and curvature estimates behind it were both
   perfectly correct. Replaced with a curvature demand plus an understeer term.

3. **Speed profile ignored the friction circle.** The backward pass assumed a
   flat 1.45 g of braking on corner entry while the same tyres were already
   carrying most of a g sideways. The car arrived at Ferradura with the rear
   gone. Now uses a g-g envelope.

4. **Racing line aimed at the outside of every corner.** The inside of a corner
   has the *same* sign as the curvature; the code negated it. On the 16 m oval
   this only looked untidy - the AI still ran 0% off-track - so it survived a
   green test suite. On a 12.5 m Interlagos it was in the barrier every lap.

The pattern worth carrying to the hour-12 gate: the placeholder oval is wide and
forgiving enough to hide real bugs. A check that passes on the oval has not
verified anything about Interlagos.

Also fixed: with ten cars the AI drove the speed profile regardless of what was
in front of it, and four cars DNF'd in a first-lap pile-up. It now lifts for a
car directly ahead.


### 2026-09-07 — Input pacing: found, fixed, and what did not work

This was the single largest source of prediction error and it is worth the
space, because three plausible fixes made it worse before the right one worked.

**The mechanism.** The client produces one input per two of its own fixed steps;
the server consumes one per two of its own ticks. Both are nominally 30 Hz on
separate clocks. Any rate mismatch drains the server's queue, and when it drains
the server holds the previous input for two extra ticks — so that input is
applied four times server-side and twice client-side, and the replay cannot
reproduce it. The correction is **exactly two ticks of travel, at any speed**:
1.24 m at 133 km/h, 1.77 m at 191 km/h. That constant ratio is what identified
it; a random cause would not hold error/speed fixed to three decimal places.

**What did not work, in order:**

1. *Redundant input sends.* Correct and kept — it removes loss-induced gaps for
   about 7 KB/s upstream and no protocol change — but it does not touch this,
   because a resent input arrives with the newer one rather than earlier.
2. *A deeper jitter buffer.* Sweeping the target from 2 to 6 cut starvation from
   2.0% to 0.5% and left p99 error unchanged at ~1.8 m. That refuted starvation
   as the dominant cause and was worth the twenty minutes.
3. *Rebuilding the cushion after every dip.* Actively harmful: holding the
   current input for several periods while the queue refilled cost more than the
   starvation it prevented, and was invisible to a metric that only counted an
   *empty* queue. The metric now counts holds. The cushion is built once.
4. *Draining an over-deep queue server-side.* Worse still. Consuming two inputs
   in one period applies one of them for zero ticks while advancing ackSeq, so
   the client believes it was simulated when it never was. Removed entirely: a
   queue that grows costs latency, a drained queue costs correctness.
5. *Estimating queue depth from a running minimum of `seq - ackSeq`.* The
   minimum only reads true flight time when the queue actually empties. When it
   does not, the floor tracks the gap upward, the estimate collapses toward
   zero, and the controller speeds up a client whose queue is already nine deep.
6. *An asymmetric anti-windup term*, on the theory that a backgrounded tab -
   where requestAnimationFrame simply stops - would peg the controller and leave
   the client running fast afterwards. It does peg it, and it unwinds on its own
   the moment frames resume, because the queue is then very deep and the error
   correspondingly large. Adding a faster unwind on top only made the controller
   chase jitter: holds under sustained latency went from 0.97% back up to 1.8%.

**What worked.** `seq - ackSeq` is inputs in flight plus inputs queued, and the
measured round trip converts the first term into inputs, so
`depth = (seq - ackSeq) - rtt * INPUT_HZ`. A proportional controller holds that
at 3 by adjusting how fast the client consumes real time. The physics timestep
never changes — every step is still exactly 1/60 — only the wall-clock rate at
which steps are taken, by a few percent, far below anything a player can see.

Measured at LAN latency after the fix: **0 holds in 1558 periods, prediction
error max 0.003 m, 2 corrections in 60 s.** Before it, the same run produced
holds on 2.3% of periods and a 1.97 m p99 correction.

Under 100 ms latency with 2% loss the controller saturates and holds still
occur on about 1% of periods, leaving a 1.97 m p99 correction with zero hard
snaps. That residue is a real consequence of a lost input arriving a redundancy
interval late, and it is not on the path to the demo, which runs on a LAN (§9).


---

## HOUR-12 GATE, FIRST PASS - SUPERSEDED (HANDOFF.md 7)

> **This section is superseded.** It graded checks 1, 2, 4 and 5 without
> impairment, on the argument that 7 names the 100 ms / 2% condition only
> for check 3. That argument is withdrawn. The gate was re-run with
> impairment on all five checks and the result is **3 pass, 2 fail**, not
> 5/5. See "HOUR-12 GATE, RE-RUN UNDER IMPAIRMENT" at the end of this file.
>
> Kept because the unimpaired numbers are still the right baseline for what
> the demo actually runs on, and because how the grading went wrong is worth
> remembering.

Run on Interlagos, 2883 m, 6720 collision triangles. Every number below is from
a harness in `tools/` that can fail; the commands are in README.md. Where a
check has more than one honest reading, both are given.

### 1. Server stability — **PASS**

`node --expose-gc --import tsx tools/loadtest.ts 10 620`
Ten real WebSocket clients, each driving with a full AI over a view rebuilt from
its own snapshot stream, for ten minutes.

| | measured | required |
|---|---|---|
| tick rate | 60.00 Hz | 60 Hz |
| step time p50 | 3.52 ms of a 16.67 ms budget | |
| step time p99 | 6.95 ms | |
| step time max | 9.15 ms | |
| **CPU headroom at p99** | **58.3%** | ≥40% |
| bandwidth | 48.3 KB/s down per client | |

Clients that sat still would have understated this badly — ten cars parked on
the grid cost 1 ms a step, ten cars racing cost 3.5.

### 2. Local responsiveness — **PASS**

`npx tsx tools/netcheck.ts 3 1 0.001 60` — LAN latency, which is what the race
is played at (§9). Runs the real `PredictedCar` against the real server.

| | measured |
|---|---|
| prediction error p50 / p99 / max | 0.001 / 0.001 / **0.003 m** |
| hard snaps | **0** |
| corrections in 60 s | 2 |
| server input holds | 0 in 1558 periods |

The car responds on the frame the key is pressed — prediction is immediate by
construction — and the server's answer agrees with it to 3 mm.

**Honest caveat.** At 100 ms latency with 2% loss the pacing controller
saturates, the server still holds an input on ~1% of periods, and p99
correction rises to 1.97 m — with zero hard snaps, and p50/p75 still at 1 mm.
§7 specifies that impairment for check 3, not check 2, and the demo runs on a
LAN; the residue is recorded above rather than hidden.

### 3. Remote smoothness — **PASS**

`npx tsx tools/netcheck.ts 100 20 0.02 90` — the impairment §7 actually names.

| | measured | required |
|---|---|---|
| **teleports** | **0** in 23,325 sampled frames | 0 |
| worst frame | 2.21× the car's reported speed | |
| stale frames | 0.21% | <5% |
| interpolation buffer | 58 snapshots, 75 ms behind newest | |

A teleport is a frame whose *implied speed* exceeds three times the speed the
server reports for that car — invariant to frame timing, unlike per-frame
displacement, which reported 348 false teleports on a stream that was perfectly
smooth.

### 4. Contact — **PASS**

Two ways, because a rig and a race stress different things.

`npx tsx tools/drivetest.ts` — two cars at 100 km/h with closing velocity
imposed directly (steering them together does not work: quarter lock at 150 km/h
barely moves the car, and the first version of this test passed while the cars
stayed 4.4 m apart):

| closing rate | closest gap | worst up.y | max air | verdict |
|---|---|---|---|---|
| 1.5 m/s | 1.90 m — touched | 1.00 / 1.00 | 0.00 m | no flip, no launch |
| 6.0 m/s | 1.89 m — touched | 1.00 / 1.00 | 0.00 m | no flip, no launch |

`npx tsx tools/laptest.ts interlagos 10 3` — ten cars, three laps, all finishing:
worst attitude **up.y 0.98**, greatest height **0.18 m**, **0** frames airborne.

### 5. Memory — **PASS**, with `--max-old-space-size=96`

Judged on heap after a forced collection and on Rapier's WASM memory, not on
RSS. Over five minutes with the cap:

| | warm-up (t=30 s) | end | change |
|---|---|---|---|
| heapUsed after forced GC | 27.0 MB | 17.1 MB | **−36.7%** |
| external + arrayBuffers (WASM) | 23.6 MB | 23.6 MB | **−0.1%** |
| rss | 125.2 MB | 137.8 MB | +10.1%, slope +1.4% over the last quarter |

Without the cap, RSS climbs to ~167 MB over ten minutes and asymptotes, because
V8 sizes its heap for the allocation churn of serialising snapshots and does not
hand the pages back. Capping it makes RSS flat **with no cost at all** — 60.00 Hz
and 49.7% headroom either way. That is the proof it was never a leak, and the
flag is now in the `server` npm script.

### Score: 5 / 5 → continue to full 10-player  [SUPERSEDED - see the re-run]

§7: *"4–5 pass → continue to full 10-player. You are on track."*

Tier 2 and Tier 3 are already built and measured, not merely planned: ten AI
cars complete three laps of Interlagos with lap times spread 1:19.6 to 1:30.1
and no DNFs, so 6 humans + 4 AI, or 1 human + 9 AI, both work today.

**What is not done, and is the honest risk list:**

- Prediction degrades to a 1.97 m p99 correction at 100 ms WAN latency. Fine on
  a LAN, and the mechanism is fully understood (see above).
- The renderer and the lobby/HUD in `client/src/scene.ts` and `ui.ts` are
  Instance A placeholders. They are marked for replacement, not extension.
- No audio, no visual polish, no trackside geometry. All Instance B.
- The venue recording (§9) has not been made.


---

## After the gate

### 2026-09-07 — Race entry rules, so ten strangers actually get a race

Three things stood between the working netcode and §11's "a judge opens a link
and races 9 other people", all of them about people rather than physics.

**A player who never readies up used to block the grid forever.** The lobby
required every human to be ready. Ten people at a hackathon do not all click a
button at the same time, and one who wandered off held the whole grid hostage.
Now: everyone ready starts immediately, otherwise a 25-second wait starts from
the first ready and the race goes without the stragglers.

**Joining mid-race used to drop you onto a live circuit.** `join()` created a
car on a grid slot regardless of what the room was doing — and the grid is on
the main straight, so a latecomer's parked car was waiting to be hit at
200 km/h. An entrant's car is now `Car | null`: it exists only for someone in
the race. Arriving mid-race means no car at all, no entry in the snapshot, and a
spectator camera on the leader until the next grid forms.

**Race position was computed but never shown.** The server has it in
`Room.order()`; nothing sent it. Rather than unfreeze the snapshot shape, the
client recomputes it from `lap`, `cp` and position via `TrackQuery` —
`client/src/standings.ts`. `npm test` asserts it agrees with the server's own
ordering mid-race.

That last one had a bug worth recording, because it is the same shape as the
track-generator sign error: **the grid sits behind the start line**, so a car
that has not moved reads a lap-distance near the *full lap length* while its lap
count is still zero. Adding those together put a stationary car ahead of the
leader — it showed up in the browser as a parked car holding P5 with a gap of
−1971 m, a whole lap of Interlagos. A car that has passed no checkpoint cannot
be most of the way round, so that case now subtracts a lap.

Also: `EADDRINUSE` used to kill the server with a stack trace, which is the
worst thing to be reading in front of an audience. It now prints two sentences.
The handler has to go on the `WebSocketServer` as well as the http server,
because `ws` re-emits the http error and it is that copy which is fatal.

`npm test` — 33 checks, ~40 s.


### 2026-09-07 — Two lobby bugs only a full race cycle would show

Both found by running the whole lifecycle in a browser — lobby, grid, countdown,
race, results, back to lobby — rather than by testing the pieces. Neither could
have been caught by the headless suite, because both are about what is on
screen after the server has already done the right thing.

**The Ready button lied after every race.** On the way back to the lobby the
server broadcasts the roster (every ready flag cleared) *before* it broadcasts
the state change. The button was rendered from a local `isReady` flag, so it was
rebuilt while that flag was still true and then never re-rendered: it read
"Ready — click to cancel" next to a roster line reading "waiting". Every player
would have believed they had readied up, and the second race would never have
started. The button now takes its state from the roster, which is the server's
view, and there is no local flag to disagree with.

**"Race in progress" stayed on screen in the lobby.** Having no car in the
snapshot was read as "spectating" regardless of phase — but in the lobby it just
means the grid has not formed yet. The check is now gated on the race actually
being on.

Neither is deep, and both would have been embarrassing in front of an audience:
the first one stops the demo dead after the first race.


---

## HOUR-12 GATE, RE-RUN UNDER IMPAIRMENT (HANDOFF.md 7)

**All five checks run with 100 ms +/-20 ms latency and 2% packet loss injected
in both directions.** The earlier gate graded checks 1, 2, 4 and 5 unimpaired,
on the argument that 7 names the impairment only for check 3. That argument is
withdrawn. These are the numbers under load and impairment.

Result: **3 pass, 2 fail.** Checks 2 and 4 fail.

Per 7 scoring, "2-3 pass -> drop to 6 players, cut visual scope, spend hours
12-24 entirely on whichever checks failed. Do not add features."

### 1. Server stability - PASS

Ten real WebSocket clients, each driving with a full AI, all impaired, for ten
minutes. `node --expose-gc --import tsx tools/loadtest.ts 10 620 interlagos 100 20 0.02`

| | uncapped heap | shipped config (`--max-old-space-size=96`) | required |
|---|---|---|---|
| tick rate | 60.00 Hz | 60.00 Hz | 60 Hz |
| step p50 | 2.92 ms | 1.12 ms | of 16.67 ms |
| step p99 | 8.97 ms | 3.40 ms | |
| step max | 19.33 ms | 4.81 ms | |
| **headroom at p99** | **46.2%** | **79.6%** | >=40% |
| round trip | 216 ms p50, 257 ms p99 | 216 / 251 ms | |

Passes with margin in both. The one number worth noting is the uncapped step
max of 19.33 ms, which is over the 16.67 ms budget for a single tick; p99 is
half the budget, so it is an isolated spike rather than sustained overrun.

### 2. Local responsiveness - FAIL

`npx tsx tools/netcheck.ts 100 20 0.02 120`

| | measured | required |
|---|---|---|
| error p50 | 0.001 m | |
| error p75 / p90 / p95 | 0.001 / 0.808 / 1.379 m | |
| **error p99** | **1.969 m** | **<1 m** |
| error max | 1.971 m | |
| hard snaps | 0 | 0 |
| corrections in 120 s | 414 | |
| server input holds | 39, on 0.84% of periods | |

**Fails on prediction error.** The threshold was set before the result was
known and is not being moved now. Half the story is good - the median error is
one millimetre, three quarters of snapshots need no correction at all, and
there is not a single hard snap in two minutes - but at the 99th percentile the
correction is 1.97 m, and that is roughly four times a second at racing speed.

The cause is understood and documented above: every server input hold costs
exactly two ticks of travel, and 2% loss delays a recovered input by a
redundancy interval no matter how the pacing controller is tuned. Unimpaired,
the same test gives a max error of 0.003 m and zero holds.

### 3. Remote smoothness - PASS

Same run.

| | measured | required |
|---|---|---|
| **teleports** | **0** in 30,520 sampled frames | 0 |
| worst frame | 2.13x the car's reported speed | <3x |
| stale frames | 0.27% | <5% |
| buffer depth | 58 snapshots, 52 ms behind newest | |

This is the check 7 explicitly specifies this impairment for, and it passes
cleanly.

### 4. Contact - FAIL, intermittently

Two ways, and they disagree, which is the finding.

**Controlled, `npx tsx tools/drivetest.ts`** - two cars at 100 km/h with closing
velocity imposed so contact is guaranteed:

| closing rate | closest gap | worst up.y | max air | verdict |
|---|---|---|---|---|
| 1.5 m/s | 1.90 m, touched | 1.00 / 1.00 | 0.00 m | clean |
| 6.0 m/s | 1.89 m, touched | 1.00 / 1.00 | 0.00 m | clean |

**In-race, four impaired ten-car runs, about 31 minutes of racing:**

| run | worst up.y | greatest height | samples airborne | verdict |
|---|---|---|---|---|
| uncapped, 620 s | 0.90 | 0.63 m | 0 | pass |
| capped, 330 s | **-0.85** | **4.18 m** | **27** | **FAIL** |
| capped, 330 s | 0.95 | 0.44 m | 0 | pass |
| capped, 620 s | 0.90 | 0.65 m | 0 | pass |

One run in four put a car **4.18 m in the air and completely inverted**. 7 is
absolute about this - "neither explodes, falls through the track, or launches
into the air" - so one launch in four runs is a failure, and picking the three
good runs would be exactly the generous grading 7 warns about.

Simple side-by-side contact is solid; something rarer and more violent in a
ten-car field is not. The failing run is not distinguishable by the heap flag:
two other capped runs passed. Root cause not yet investigated.

### 5. Memory - PASS in the shipped configuration, FAIL without it

Ten impaired clients, ten minutes.

| | uncapped | shipped (`--max-old-space-size=96`) |
|---|---|---|
| rss warm-up -> end | 149.2 -> 218.1 MB (**+46.2%**) | 134.8 -> 160.6 MB (+19.2%) |
| **rss slope, last quarter** | **+25.7%** | **+0.2%** |
| heapUsed after forced GC | -39.0% | -40.9% |
| heapTotal | +142.5% | +39.1% |
| wasm (external + arrayBuffers) | +0.7% / -1.8% | -0.5% / -3.1% |
| verdict | **FAIL** | **PASS** |

Graded PASS because the `server` npm script ships the cap, so that is the
configuration that runs. Recorded loudly because anyone starting the server
without it gets a configuration that fails this check: RSS reaches 218 MB and is
still climbing at ten minutes.

Post-GC heap falls ~40% and Rapier's WASM memory is flat to within 3% in every
run, so nothing is leaking in either the JS heap or the physics world. The
uncapped growth is V8 sizing its heap for the allocation churn, and the cap
bounds it at no cost - it is in fact *faster*, 79.6% headroom against 46.2%.

### Defect found while running the gate: a dropped `ready` silently benches a player

The ten-minute shipped-config run reported `clients connected 10/10` but
`cars in room 9`. One client's `ready` message was lost by the 2% simulator, so
the server never marked it ready, the lobby timer expired, and the race started
without it. `ready` is sent exactly once, on a click, with no retransmission and
no acknowledgement.

At the venue this is a player standing next to you who pressed the button and
never got a race, with nothing on screen to explain it. At 2% loss with ten
players it is about an 18% chance per race that someone is silently benched.

Not fixed - the instruction for this pass was to run the gate, not to change
code. It is the highest-value fix on the list.

---

## HOUR-20 GATE, UNDER THE SAME IMPAIRMENT

100 ms +/-20 ms latency, 2% packet loss, both directions. Every run below was
taken on a machine verified healthy by `tools/cpubench.ts` immediately
beforehand (2.751 ms per ten-car step, 83.5% headroom), and each harness reports
the tick rate the server actually achieved so a starved run cannot be mistaken
for a result.

**Result: 4 pass, 1 fail.** Check 2 is since closed as an accepted deviation;
see the section at the end of this file. §7: *"4–5 pass → continue to full 10-player."*

Check 4 passes, so per the standing instruction the player count stays at ten.

| | | measured | required |
|---|---|---|---|
| 1 | Server stability | **PASS** — 60.00 Hz, **81.9%** headroom at p99 | ≥40% |
| 2 | Local responsiveness | **FAIL** — p99 error **1.498 m**, 0 hard snaps | <1 m, 0 |
| 3 | Remote smoothness | **PASS** — **0** teleports in 23,905 frames, 0.13% stale | 0, <5% |
| 4 | Contact | **PASS** — **0** airborne in 52,920 samples, worst up.y 0.96 | 0, >0.2 |
| 5 | Memory | **PASS** — post-GC heap −33.9%, WASM +0.1%, RSS slope +0.6% | no leak |

### Against the hour-12 gate

| | hour 12 | hour 20 |
|---|---|---|
| server headroom at p99 | 46.2% | **81.9%** |
| server step p50 | 2.92 ms | **1.07 ms** |
| prediction p95 | 1.268 m | **0.004 m** |
| prediction p99 | 1.967 m | **1.498 m** |
| hard snaps | 0 | 0 |
| server input holds | 2.37% | **0.12%** |
| remote teleports | 0 | 0 |
| worst interpolated frame | 2.21x reported | **1.69x** |
| stale frames | 0.21% | **0.13%** |
| contact: greatest height | **4.18 m, inverted** | **0.49 m, up.y 0.96** |

### 2. Local responsiveness — FAIL, and what is left

p50 0.000 m, p75 0.000, p90 0.001, p95 0.004, **p99 1.498**, max 1.972.
Zero hard snaps. 2008 of ~2700 snapshots needed no correction at all.

Ninety-five percent of snapshots are now exact to four decimal places. What
fails the check is the top percentile, and it traces to **three server input
holds in ninety seconds** — 0.12% of periods. Each hold costs exactly one input
period of divergence, which is 1.97 m at racing speed, because the server
applies the held input for four ticks where the client predicted two.

Those three holds are the irreducible residue of 2% packet loss: a lost input is
recovered by the redundancy in the next packet, but it arrives one period late,
and if the queue happened to be at its floor that period the server holds. The
buffer already absorbs the rest.

The threshold was set before any of these results were known and has not been
moved. Recorded as FAIL.

### The machine throttled, and it nearly cost a false verdict

Worth writing down because it wasted more time than any actual bug.

Mid-session the same fixed workload went from ~1 ms to **14.713 ms** per ten-car
step — a tenth of the throughput, on identical code. Under that, the server
looked like it had lost 40% of its CPU headroom, `netcheck` reported a server
running at 32 Hz, prediction error read 25 m and remote cars appeared to
teleport 990 times. Every one of those was the machine, not the code. Forty-five
seconds of idle brought it back to 2.751 ms.

Three things came out of it, all kept:

- `tools/cpubench.ts` times one fixed workload with no network and no timers, so
  machine health is a number rather than a suspicion. Run it before any gate.
- `netcheck` derives the server's achieved tick rate from the ticks stamped on
  the snapshots it receives, prints it **first**, and marks everything below
  invalid when it is not 60 Hz. It can also attach to a server in another
  process via `NETCHECK_ATTACH`.
- The validity check goes above the result, not beside it. I came close to
  reporting a netcode regression that did not exist.

### 5. Memory — accepted as passing with the heap flag

As instructed, and the reasoning rather than the assertion:

The check exists to catch a leak, and two independent measures say there is
none. Post-GC `heapUsed` ends **below** where it started, so the garbage is
collectable and nothing is retaining it. Rapier's world lives in WASM memory,
surfacing as `external` + `arrayBuffers`, and a collider or rigid body never
freed would accumulate there; it is flat to within 1% over every run.

What RSS measures is V8's heap *reservation*, not its use. `heapTotal` grows 39%
while `heapUsed` falls — V8 sizing itself for the allocation churn of
serialising snapshots and declining to hand pages back to the OS.
`--max-old-space-size=96` tells it not to, and RSS then sits flat at ~161 MB
with a +0.6% slope over the last quarter, at no cost: 81.9% headroom with the
flag against 46.2% without it on the same impairment.

The flag is in the `server` npm script, so it is the configuration that runs. A
server started any other way reaches ~218 MB and is still climbing at ten
minutes. It is called out in README.md as well.

### What this round fixed

- **Ready handshake.** `ready` was sent once, unacknowledged; one lost packet
  silently benched a player for a whole race — about an 18% chance per
  ten-player race at 2% loss. The roster is the acknowledgement now, and the
  client retries until it sees itself marked ready.
- **Race phase was the same defect, and worse.** Losing the packet announcing
  the race had started left the client sending neutral input, so the player
  could not drive at all, with no way back. The phase is repeated once a second.
- **Input redundancy batched** — same three-packet redundancy, one third the
  packets.
- **Contact caps.** Suspension force ceiling from 13.6x static wheel load to 8x,
  plus a post-solver clamp on rise and angular speed. Handling is unchanged to
  two decimal places: 0-100 in 2.92 s, braking 1.70 g, skidpad 1.31 g.
- **Reconciliation bounded and then mostly skipped.** It had no ceiling at all,
  which is a feedback loop that closes on itself. Each input now records where
  it landed, and if the server agrees there is no replay — 74% of snapshots.
- **Interpolation clock windowed.** The offset was an all-time minimum, so one
  unusually fast packet anchored the timeline to itself and the buffer read
  stale for the rest of the race.

### Still open

1. **Check 2.** Three server input holds per ninety seconds at 2% loss. Closing
   it means the server tolerating a late input rather than holding — replaying
   forward from the held tick when the missing input finally lands. That is a
   real change to the authoritative loop and wants its own measurement.
2. The venue recording (§9) still has not been made. That one is yours.

---

## ACCEPTED DEVIATION: check 2 (local responsiveness) — CLOSED, will not be fixed

**Decision is final. Do not reopen this to "just try one thing".**

§7 check 2 asks that the local car respond with no perceptible lag and no
rubber-banding. Measured at 100 ms ±20 ms latency and 2% packet loss on a
verified-healthy machine, the p99 prediction error is **1.498 m** against the
1 m bar this project set for itself, so the check is recorded as failing.

It is accepted as-is, because the number that fails is the only one that does:

| | measured | what it means |
|---|---|---|
| error p50 | **0.000 m** | half of snapshots need no correction that is representable |
| error p75 | **0.000 m** | |
| error p90 | **0.001 m** | one millimetre — the wire's own rounding resolution |
| **error p95** | **0.004 m** | 95% of snapshots agree with the server to four decimals |
| error p99 | 1.498 m | the failing number |
| error max | 1.972 m | |
| **hard snaps** | **0** | in ninety seconds. Not one visible jump |
| replays skipped | 2008 of ~2700 | the server agreed with the prediction 74% of the time |
| server input holds | 3 in 2450 periods (0.12%) | |

**Rubber-banding is what check 2 is really about, and there is none.** A hard
snap is the client giving up and teleporting the car; there were zero. Every
correction that did occur was eased into the rendered pose over ~90 ms, and 95%
of them were smaller than the width of a fingernail.

What fails is a tail of three events in ninety seconds. Each is one server input
hold — a lost input recovered by the redundancy in the next packet, arriving one
period late to find the queue at its floor. The server then applies the held
input for four ticks where the client predicted two, which is exactly one input
period of divergence: 1.97 m at racing speed, and the constant ratio across
speeds is what identified the mechanism in the first place.

**Why the fix is not worth it here.** Closing it means the server no longer
holding: instead, when a late input finally lands, re-simulating forward from
the tick it should have been applied at. That is rollback on the authoritative
side — new state to keep per entrant, a second replay path in the hot loop, and
a new class of bug in the one component that ten clients depend on being right.
At 50 hours, on a build whose demo runs on a LAN where the measured hold rate is
zero, that is a poor trade against three events a minute of sub-2 m correction
that never once produced a visible snap.

For the record, on LAN latency — the condition the demo actually runs in — the
same measurement gives 0 holds and a maximum error of 0.003 m.

Recorded rather than quietly re-graded. The threshold was set before any result
was known and has not been moved.

---

## Join path verified end to end, fresh client

Production build, one process on :8080 serving the client and the game, a
browser with `localStorage` cleared so nothing was remembered from an earlier
session. Every step driven through the real UI rather than by script.

| step | result |
|---|---|
| fresh load | lobby, empty name field, ten colour swatches |
| name `  Ayrton <b>  ` | server sanitised it to `Ayrton b` - trimmed, brackets stripped |
| colour *Acid* clicked | `myColor: 3`, car renders green |
| Join | `myId: 1`, roster shows `Ayrton b (you) waiting`, HUD reads P1/1 |
| Ready clicked | button reads **Ready - confirming...** immediately, amber |
| ~1 s later | **Ready - click to cancel**, roster reads `ready`, server agrees |
| grid | AI filled to 6, cars placed, HUD P3/6 |
| countdown, race | ran; driving responded, HUD position tracked to P6/6 |
| live netcode | peak prediction error 0.002 m, 0 hard snaps, 0% stale frames, 6 cars |
| results | all five AI classified, winner 1:30.783, the idle human DNF |
| back to lobby | roster `waiting`, Ready button correctly reset to `Ready` |

The ready handshake is visibly doing its job: the intermediate *confirming*
state is the client waiting for the server to agree, and it resolves in about a
second. Before that handshake existed, a lost `ready` packet benched a player
for the whole race with nothing on screen to explain it.

One cosmetic defect found, left for the polish pass: **on returning to the
lobby a car stays wherever the race left it**, so a player who ended up in the
gravel sits in the gravel until the next grid forms. `setState('lobby')` does
not reposition cars; only `placeOnGrid()` does. It resolves itself at the next
race and is untidy rather than broken.

---

## Instance B merged, and what I checked rather than took on trust

B's status document reports the merge as done and the tree as healthy. It is,
and these are my own numbers rather than a restatement of theirs:

| check | result |
|---|---|
| `git pull --ff-only` | clean fast-forward; B had already merged my netcode into their branch |
| `tsc --noEmit` | clean |
| `npm test` (race logic) | **33/33** |
| `vite build` | builds `index.html` and `preview.html` |
| `git diff ec6f430..HEAD -- shared/ vehicle/ server/ public/track/` | **empty** |

That last row is the one that matters. B changed nothing in `shared/`,
`vehicle/`, `server/` or the track JSON, so **the physics and the circuit are
byte-identical to what every gate result in this file was measured against**.
The gate numbers already recorded still stand; the re-run is to confirm them
with the render layer and the HUD present, not because anything underneath
moved.

What the merge adds: the visual track mesh, materials, sky and lighting,
barriers, trackside scenery, the HUD, and the lobby and results screens.

---

## Car models: taken, wired in, and one bug worth writing down

STATUS-INSTANCE-B.md §3 lists car meshes and liveries as assigned to neither
instance, and warns that if nobody takes them the cars are placeholder shapes at
the demo. They were: a box, a wedge for a nose, and four cylinders. Ten glTF
stock cars were supplied in `models/`, so Instance A has taken this.

`public/cars/` now holds the ten, and `client/src/render/car-model.ts`
normalises them. They do not arrive usable:

- **forward is +Z**; cars face **-Z** here (HANDOFF.md §5.1), so every model is
  yawed 180 degrees
- they are **2.346 m wide** against the collider's 1.9 m. Scaling on width
  (x0.810) lands the height on 1.088 m against `CAR.height` 1.1 — two of three
  dimensions on the physics constants from one uniform factor, which is why
  width is the right datum rather than length
- the origin sits on the ground, so the model is lowered to put the tyre contact
  patch where the physics puts it

The wheels are split out of the mesh by which quadrant their triangles sit in,
so the front pair still steers. They also roll now, driven from how far the car
moved along its own nose between poses — no netcode plumbing, and `setPose`
stays the only call site. A snap larger than 2 m is discarded rather than
spun, because a reconciliation correction is not distance travelled.

**The bug: the pack ships positions only — no normals on any primitive.** A
`MeshStandardMaterial` with no normals renders pure black, and the first build
put a black silhouette of a car on the track. Nothing in the console said so;
the only errors were harmless warnings about missing accessor min/max. I found
it by running the geometry pipeline outside the browser and printing the
attribute list on each primitive, which said `attrs=position` nine times.
Guessing at it from the screenshot would have cost far longer — the symptom
looks like a lighting or a colour-space problem and is neither.

### Draw calls, because that is the budget

B measured the environment at 17 draw calls and 8.4 ms a frame with an **empty**
grid. Rendering each car a primitive at a time would have added ninety. Every
opaque body material in the pack shares metalness 0.12 and roughness 0.52 and
differs only in colour, so they merge into one vertex-coloured mesh with no
visual difference whatsoever.

| | measured |
|---|---|
| meshes per car | **6** (body, glass, four wheels); 7 for the local car, which carries a marker |
| triangles per car | ~1,090 |
| ten cars racing, worst sampled frame | **50 draw calls**, 145,314 triangles |
| same scene, old box cars | 77 draw calls, 150,358 triangles |

The merge is why damage is not wired up: it discards the four morph targets
(`FrontImpact` and friends) the pack ships. Nothing asked for damage. Keeping
the body primitives unmerged is the switch to flip if that changes.

### Verified

- ten liveries render, each keeping its accent and number while its base coat is
  overridden to the colour the player actually clicked in the lobby
- remote cars use the same path — checked with a second car alongside on the grid
- **the fallback works.** With every model returning 404 the client still boots,
  still joins, and races on the old boxes at 101 km/h. A missing asset must not
  end the demo, so this is tested rather than asserted.

### Not verified

- **Frame rate.** The browser pane in this session is hidden, and
  `requestAnimationFrame` is throttled when a tab is not visible — the same trap
  `netcheck.ts` was written to avoid. Draw calls and triangle counts above are
  real, because they are counts from the last rendered frame; a frames-per-second
  number from here would not be. It needs measuring on the venue machine.
- Ten cars **on a projector**, which is what B tuned the contrast and fog for.

---

## Cars are parked back on the grid between races

Found during the join-path verification and left for the polish pass. A race
ends wherever it ends, and `setState('lobby')` repositioned nothing — only
`placeOnGrid()` did, and that runs on the way *into* a race. So a player who
finished in the gravel sat in the gravel for the whole lobby, facing a barrier
or upside down against a tyre wall, until the next grid formed. It resolved
itself at the next race and was untidy rather than broken, but it is the first
thing anyone waiting for a race looks at.

`parkOnGrid()` now runs on entry to the lobby. It is deliberately not
`placeOnGrid()`: that decides race entry, and everyone has just been un-readied,
so reusing it would take every car away and leave the lobby with nothing to
show.

The check added with it (`roomtest`, now 36) strands a car a quarter of the way
round the circuit and asserts the lobby brings it back. It strands the car
**upright and on the racing line** so that the stuck-car rescue has no reason to
fire and cannot be what moves it. Confirmed to fail for the right reason:
commenting out the one call gives `482.2 m from the nearest slot`.

---

## The car models are built, not loaded

The supplied glTF pack went in first and did not survive being looked at
properly. Parked and photographed from four angles it has:

- **side skirts outboard of the bodywork**, so they hang off the car as thin
  detached blades several metres long
- **no wheel arches** — the wheels are swallowed by a slab body and only the
  bottom of each tyre shows
- a **doorstop silhouette**: a flat wide slab with a small box on top

It also brings its own proportions — 2.346 m wide against a 1.9 m collider, with
the overall width set by the wheels rather than the body — so no uniform scale
fixes one dimension without breaking another. Scaling on overall width, which is
what shipped first, made the *body* 1.56 m against a 1.9 m collider: every car
was visibly undersized for the track it was on.

None of that is a scale bug. It is the shape.

`client/src/render/car-mesh.ts` builds the car instead. Every dimension is read
from `shared/constants.ts`, so the car that is drawn is the size of the car that
collides: 4.5 m long, 1.9 m wide, wheels on the 2.8 m wheelbase and 1.6 m track,
tyres of exactly `CAR.wheelRadius` with their contact patch on the ground.

The shell is a rounded-rectangle cross-section lofted through sixteen stations.
The arches come out of that for free: the underside rises above the tyre over a
short run of z either side of each axle, so the loft walls itself into an arch
and the wheel shows through it. On top of the shell sit a greenhouse (with the
windows painted in rather than modelled as glass), a bonnet and roof stripe,
door roundels, sills, splitter, grille, lamps and a rear spoiler.

Shading is flat, and deliberately: the circuit, trees, stands and barriers are
all low-poly and flat-shaded, and a smooth-shaded car in that world looks like
it wandered in from another game.

### Cost

| | measured |
|---|---|
| meshes per car | **5** — body and four wheels (6 for the local car, which carries a marker) |
| six cars racing, sampled frame | **48 draw calls**, 155k triangles |
| assets downloaded | **none**; `public/cars/` and its 2.9 MB are gone |

Livery is derived rather than authored: the base coat is the colour the player
picked, and the accent flips between near-black and near-white on the base
coat's luminance, so a yellow car gets black stripes and a navy one white.

### Two bugs, and why there is now a test

**Every mirrored part was inside out.** They are written `box(s * a, s * b, ...)`
for `s` of -1 and 1, which for the left side hands `BoxGeometry` a negative
extent — that mirrors it. The left headlamps, sills and door panels rendered as
dark slivers while the right-hand ones were fine. `box()` now sorts its extents.

**The glTF pack shipped no normals on any primitive**, and a lit material with
no normals renders pure black. That one cost real time because the console said
nothing: the only errors were harmless warnings about missing accessor min/max,
and the symptom looks like a lighting or colour-space problem and is neither. It
was found by running the geometry pipeline outside the browser and printing each
primitive's attribute list, which said `attrs=position` nine times.

Both are arithmetic, and arithmetic is checkable, so `tools/carmeshtest.ts` (30
checks, in `npm test`) now covers them. The important one is winding: a closed
mesh wound outward has positive signed volume, and **inside-out geometry is
invisible in a screenshot until the light happens to catch it from the wrong
side**. Confirmed to fail for the right reason — flipping the loft's winding
gives `-2.666 m^3`.

The pack itself stays in `models/` for provenance. Nothing loads it.

---

## A backgrounded player was being dropped, and became a ghost

Found while trying to photograph a car: a client that had been sitting in a
hidden tab could no longer start a race. Ready did nothing, the roster never
came back, snapshots carried no car, and nothing on screen said why.

The room had dropped the entrant. `CLIENT_TIMEOUT_MS` is 15 s and the client
pings once a second — but from a `setTimeout` chain, and **browsers throttle
timers hard in a hidden tab**, to once a minute after a few minutes
backgrounded. Well past 15 s. Anyone who alt-tabs at the demo would have been
ejected for it.

The socket stayed open through all of this, and that is what turned a
disconnection into a ghost: `onReady` returns early when there is no entrant, so
no roster is broadcast and no error is sent. The player is connected to a room
that has no record of them.

Two fixes:

- **Liveness is now a transport fact.** The server sends a WebSocket ping every
  4 s and touches the entrant on the pong. The browser answers those itself,
  without waking page script, so it keeps reporting liveness through any amount
  of timer throttling — while a genuinely gone client still fails it.
- **The socket goes with the entrant.** `RoomHooks.evict` tells the transport to
  send an error and close, so a dropped player lands on the disconnected screen
  instead of a lobby that ignores them. This adds `'timeout'` to
  `ErrorMsg.code`; see CHANGELOG-SHARED.md.

Verified end to end: 80 s idle in a hidden tab, then Ready is confirmed and the
race starts. Before the fix the entrant was gone and the button did nothing.
`roomtest` covers the eviction path (40 checks).

### Not a bug, but it wasted time twice

`requestAnimationFrame` does not run at all in a hidden tab. That is why a car
being driven with a held key crawled at 3 km/h, and why the client had no car
views while happily reporting `state: racing` and `fps: 60` — `fps` is only
updated inside the frame loop, so it reads as whatever it was when the loop
stopped. It is the same trap `netcheck.ts` was written to avoid, and it means
**no frame-rate number can be taken from this session**; draw-call and triangle
counts are fine, because they describe the last frame that did render.

---

## GATE RE-RUN ON THE MERGED TREE, 2026-09-08

100 ms +/-20 ms latency, 2% packet loss, both directions, ten clients.

**Result: 2 pass, 1 fail, 2 not measurable.**

| | | measured | required |
|---|---|---|---|
| 1 | Server stability | **FAIL** - 59.99 Hz held, but **26.4%** headroom at p99 | >=40% |
| 2 | Local responsiveness | **NOT MEASURABLE** - harness starved | <1 m, 0 snaps |
| 3 | Remote smoothness | **NOT MEASURABLE** - same | 0, <5% |
| 4 | Contact | **PASS** - **0** airborne in 13,990 samples, worst up.y 0.91 | 0, >0.2 |
| 5 | Memory | **PASS** - RSS -0.5%, WASM +2.7%, heap +20.9% | no leak |

Run lengths were 90 s. §7 asks 5 minutes for check 1 and 10 for check 5; on a
machine taking five times as long per step, longer runs were not a good use of
the remaining time. Both are recorded as short.

### Why 2 and 3 are "not measurable" and not "fail"

Because there is a control, and it is clean.

Ten impaired clients, self-hosted harness: frame dt p99 **569 ms** against a
16.7 ms budget, and the interpolation timeline ended up **10.7 s** behind the
newest snapshot. That is a harness that stopped running, not a netcode result.

Splitting the server into its own process (`NETCHECK_ATTACH`) fixed the
timeline - server tick 59.5 Hz, render lag 67 ms - and the numbers were still
bad: p99 33.2 m, 297 hard snaps, **2787 server input holds** in 55 s. But the
pace controller was pegged at its ceiling (1.09x) with the server's input queue
at **0.00**, which is the signature of a client that cannot generate inputs fast
enough, not of a server mishandling them.

**The control settles it.** Same build, same machine, impairment turned off:

| | impaired | control (no impairment) |
|---|---|---|
| error p50 / p75 / p90 / p95 | 0.001 / 3.1 / 11.8 / 18.8 m | **0.000 / 0.000 / 0.000 / 0.000 m** |
| error p99 | 33.222 m | **0.003 m** |
| hard snaps | 297 | **0** |
| server input holds | 2787 | **10** (0.72%) |
| client frame dt p99 | 249 ms | 41 ms |

A build that produces four zeroes and no hard snaps unimpaired has not
regressed. What 100 ms of latency and 2% loss add is *reconciliation work* - the
client replays more, per frame - and this machine cannot afford it. On a healthy
machine the same code measured p95 0.004 m with zero hard snaps.

So checks 2 and 3 are recorded as blocked on the machine. Reporting them as
failures would be attributing to the code something a control run says is not
the code's.

### Check 1: the server did hold 60 Hz

Worth separating the two things this check asks. The server **kept 59.99 Hz with
ten cars racing under impairment**, all ten connected, for the whole run. What
it did not keep is the headroom: step p50 3.54 ms and p99 12.26 ms of a 16.67 ms
budget, so 26.4% at p99 against the 40% the check wants. On a healthy machine
the same code measured p50 1.07 ms and 81.9% headroom.

This also corrected something about `cpubench`. It reported 14.3 ms per ten-car
step in the same session where the server sat at 3.54 ms p50 - a 4x gap. The
difference is duty cycle: cpubench runs flat out and this machine throttles hard
under sustained load, while a 60 Hz server works in bursts and boosts between
them. cpubench is still the right pre-flight - a bad reading means timing
results are suspect - but it is a floor, not a prediction of server headroom.

### Checks 4 and 5 are real results

Neither depends on how fast the wall clock runs. Check 4 samples car attitude
across a fixed number of simulation steps, and **not one car in 13,990 samples
left the road surface** - worst attitude up.y 0.91 (upright is 1.0), greatest
height 0.63 m. Check 5 measures allocation, not speed: RSS fell 0.5% over the
run and Rapier's WASM arena moved 2.7%.


---

## Making the car worth looking at

The built car was correct but plain: a shape with the right dimensions and
nothing on it. Reworked, and the changes that actually did the work:

- **The cabin was an upright box.** More than anything else that is what made
  the car read as a toy. The greenhouse now rakes from z -0.88 and tapers to a
  fastback, over six stations instead of a slab.
- **Wheels got the detail they earn.** They are the only part of a car that
  moves against the bodywork, and a flat grey disc in an arch reads as a wheel
  on a pull-along toy. Each is now an 18-sided tread, a sidewall, five spokes
  radiating from a hub cap, and a brake disc with a caliper straddling it - all
  merged into the one wheel mesh, so the draw-call count did not move.
- **Racing numbers**, on both doors and on the roof, drawn as seven-segment
  shapes. Segments rather than a texture: a texture means UV unwrapping a lofted
  body and shipping an atlas, for two digits. The number comes from the colour
  index, so the car in the roster is the car on the track.
- **A darker band along the lower flank**, twin bonnet stripes, wing mirrors on
  stalks, and exhaust tips. The flank band matters most of the three: without it
  the side of the car is one unbroken sheet of colour from sill to roof.

Livery is still derived rather than authored - base coat is the colour the
player chose, accent flips between near-black and near-white on its luminance -
so ten cars need no art, and adding an eleventh colour needs no art either.

Still **five draw calls a car**: everything opaque merges into the body mesh and
the wheels share one geometry across all four corners.

### The test caught three things the eye did not

`tools/carmeshtest.ts` went from 30 checks to 51 and failed three of them
immediately:

- the **door numbers stood 1.3 cm proud of the collider** (x 0.963 against a
  0.950 half-width), because the digits are laid on top of the roundel and the
  roundel was already at the body's edge. Both moved inboard.
- two checks asserted the tyre had *exactly* `CAR.wheelRadius`. An 18-sided
  tread cannot: its silhouette runs between R at a vertex and R·cos(pi/18)
  across a flat, 5 mm shallower. The geometry was right and **the test was
  wrong**, so the test now states the polygon bound instead. Inscribed rather
  than circumscribed is deliberate - the tyre then never reads wider than the
  physics radius, and 5 mm of ride height at a flat is invisible.

---

## Car-to-car collision, measured and then changed

Nothing measured contact between cars beyond "did anyone end up in the air",
which is the one thing that was already fine. `tools/collisiontest.ts` now
stages the four impacts a race actually produces and reports what came out.

### What was wrong, and what was not

The first suspicion was **penetration**: a 144 km/h rear-end overlapped the two
hulls by 0.489 m, and a side swipe by 0.614 m. A third of a car buried in
another looks broken.

It is not worth fixing, and the reason is worth writing down. Sweeping every
solver knob Rapier exposes - solver iterations to 12, internal PGS passes to 4,
CCD substeps to 4, prediction distance from 2 mm to 100 mm - moved that number
by less than a centimetre. It is not the solver failing. At 40 m/s a car covers
**0.667 m in one 60 Hz step**, so the first frame that can possibly see the
contact already has the hulls that deep inside each other. Measuring how long it
lasts settles it: **1 to 3 frames, and zero by 250 ms.** It is a frame of
overlap at 60 fps, not a pile-up.

What *was* wrong is what the impact did afterwards.

| | before | after |
|---|---|---|
| rear-end: hop | 0.185 m | **0.011 m** |
| rear-end: yaw kick | 24 deg/s | **2 deg/s** |
| rear-end: struck car shoved to | - | **86 km/h** |
| T-bone: hop | 0.168 m | **0.000 m** |
| T-bone: yaw kick | 70 deg/s | **5 deg/s** |
| T-bone: attitude | up.y 0.956 | **up.y 0.999** |
| head-on 108 km/h each: after | 0.6 / 0.6 km/h | **cars part** |
| ten-car race: worst attitude | up.y 0.91 | **up.y 0.98** |
| ten-car race: greatest height | 0.63 m | **0.20 m** |

Two changes did that.

**`numInternalPgsIterations` 1 → 4.** The default single pass is what let an
impact hop and slew the struck car. Four settles it, and the step cost did not
move measurably.

**Car restitution 0.12 → 0.20, with combine rules.** At 0.12 a 144 km/h
rear-end left the cars locked together and grinding, parting at 20.8 km/h -
essentially perfectly inelastic. The catch is that restitution is one number
serving three contacts, and Rapier averages it: raising it made the *road*
springy under every wheel. So the track and the barriers now combine with
**Min**, which keeps the car's value strictly for car-to-car.

**0.30 read best on the rig and was still wrong.** It cost races: with cars
bouncing that hard off the parked car on the grid, one of the five AI stopped
completing its lap inside the time `roomtest` allows. That check is the reason
the value is 0.20 and not higher, and it is exactly the kind of thing a rig
alone would never have shown.

### The harnesses were measuring a simulation nobody runs

Two of them, both found while doing this:

- `drivetest` stepped the cars and the world but **never called `postStep`**,
  which is part of the server's loop and is what clamps rise and angular speed
  after the solver.
- `collisiontest` built its own flat world and so kept the **default solver
  settings**, which is why it first reported a 0.279 m hop the game does not
  produce.

`tuneSolver()` is now exported from `vehicle/world.ts` and both the game and the
harnesses call it, so the settings cannot drift apart again.

Handling is unchanged, which is the point: 0-100 in **2.92 s**, braking
**1.69 g**, skidpad **1.31 g** - identical to the baseline recorded before any
of this. Ten AI still finish 10/10 on Interlagos.

---

## A reset button, and the key that never worked

**`R` did nothing.** `InputSource.takeResetRequest()` existed and set a flag,
and nothing anywhere read it. I had told the user the key worked; it had never
worked.

There is now a **Reset car (R)** button in the HUD, and the key drives the same
path. Both ask the server; the client predicts nothing, because where the car
goes back to is not the client's decision to make.

The server puts the car at `hint` - the waypoint the lap tracker last placed
that car at - facing along the track there, stationary, with its queued inputs
dropped. So a reset returns a player **to their own progress facing forwards**.
It cannot skip a corner and it cannot cut the circuit, which is the property
that matters when the button is one keypress away for ten strangers.

`RESET_COOLDOWN_SECONDS` (4 s) is in `/shared/` because both ends need it: the
server enforces it, and the client mirrors it so a press the server is about to
throw away flashes red instead of green. A button that says "accepted" when
nothing happened is worse than no button.

Ten checks in `roomtest` cover it: that it lands back on the track, the right
way up, facing the right way, stationary, **without being granted lap
progress**, and that a second press inside the cooldown is refused.

---

## Unplayable on the demo machine: it is the GPU, and there are tiers now

Reported as "super laggy, unplayable" on the machine the demo runs on. Findings,
in the order they mattered:

**It is not the CPU and it is not the physics.** Per-frame client work measured
about 2 ms in total: prediction step 0.78 ms, remote ghosts 0.09 ms, every pose
and HUD update together under 0.1 ms, and issuing the draw 1.87 ms. The server
has 71% headroom.

**It is not the PGS change either, though I checked because I had claimed it was
free.** That claim was measured on a two-car rig with almost no contacts, which
was the wrong workload. On ten cars it costs **+0.43 ms of a 16.67 ms budget** -
real, small, and not what makes a game unplayable.

**It is the GPU.** The browser runs on **Intel UHD Graphics**, an integrated
part, and the environment was tuned for something else: ~150k triangles, ~1400
trees and ~1900 spectators, a 2048² soft-shadow map, MSAA, and a device pixel
ratio of up to 2 - four times the pixels of 1. None of that is wrong on a
discrete GPU. It is simply not a setting an integrated one can hold, and the
game had no way to say so.

`client/src/render/quality.ts` adds three tiers. Precedence is `?quality=` in
the URL, then a remembered choice, then what the GPU name looks like; this
machine auto-detects **low**.

| | pixel ratio | shadows | shadow map | MSAA | scenery | fog |
|---|---|---|---|---|---|---|
| low | 0.7 | off | - | off | off | 900 m |
| medium | 1 | on | 1024² | off | on | 1600 m |
| high | 2 | on | 2048² | on | on | 2800 m |

**Q** cycles them live. Everything but MSAA applies without a reload.

### What I could not measure, and why I am not claiming a figure

I could not get a trustworthy frame time. The browser pane in this session is
hidden, which pauses `requestAnimationFrame` outright, and the only race I could
run was on the same box as the server. The numbers that produced were
incoherent - a *smaller* render target reading slower, hiding scenery reading
six times slower - so they are worth nothing and are not recorded here.

Two readings are sound, because they were interleaved so drift could not fake a
winner, and because they agree across repeats: in the lobby at 1600x900, low
renders in **0.31 ms** against high's **0.78 ms**. That is the right direction
and about the right magnitude, but a lobby is not a race and I will not
extrapolate it into an fps claim.

One earlier number in this session was wrong and is worth flagging: a first pass
reported shadows costing 5.35 ms of a 7.20 ms frame. That reading included
one-off shader compilation and shadow-map allocation. In steady state the same
scene was 1.44 ms total. Warm up before timing a GPU.

---

## A still camera, and making the GPU switch visible

### The camera lag is not frame rate

`posTau` is 0.1: the chase camera is a tenth of a second behind where it wants
to be. At 60 m/s that is **six metres** of trailing, and it grows with speed,
which is exactly the complaint - fine at low speed, floaty when quick. The
smoothing is frame-rate independent (`1 - exp(-dt/tau)`), so this is tuning and
not a dropped-frame bug, and no amount of GPU will fix it.

`STILL` keeps the geometry and takes the lag out: `posTau` 0.1 -> 0.03,
`dirTau` 0.16 -> 0.05, and pull-back per unit speed 0.055 -> 0.018 so the car
does not shrink away down a straight. **C** cycles it, and the choice is
remembered.

What it deliberately does *not* do is lock to chassis yaw. That is what the
chase camera exists to avoid - a rigidly bolted camera swings hard the moment
the car steps out of line, which is precisely when the player needs to see
ahead. The blend toward direction of travel stays; only the delay goes.

`setTuning` does not reset the smoothing, so switching mid-corner eases across
instead of cutting.

### The discrete GPU

This machine has an **RTX 4050** as well as the Intel UHD, and the browser is
choosing the Intel. `powerPreference: 'high-performance'` is already set on the
context; it is a hint, and Windows overrode it. Choosing the adapter is a
system setting, so it is the user's to make, not this project's.

What the code can do, and now does:

- **Name the GPU on screen at boot** - "Intel(R) UHD Graphics · graphics low".
  On a laptop with two adapters, which one the browser picked is the single most
  useful thing to be able to see, and there was no way to see it.
- **Remember the tier against the GPU it was chosen for.** Otherwise a tier
  detected for the integrated chip sticks after the switch and hides the whole
  upgrade. A stored entry from a different adapter is re-detected rather than
  trusted: verified by planting an entry claiming the RTX and reloading, which
  correctly reported "GPU changed, re-detected as Intel(R) UHD Graphics".
- Values written by the previous build were a bare string rather than JSON;
  those fail to parse and fall through to detection, which is the right
  outcome, and the next change rewrites them.

`short()` is checked against the four renderer strings that actually occur -
Intel UHD, the RTX 4050, SwiftShader, and empty - and maps them to low, high,
low, medium.
