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

## HOUR-12 GATE (HANDOFF.md §7)

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

### Score: 5 / 5 → continue to full 10-player

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
