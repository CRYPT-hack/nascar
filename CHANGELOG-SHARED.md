# CHANGELOG-SHARED.md

Every change to anything under `/shared/` is appended here with a timestamp, and
the other instance is told immediately. Silent edits to `/shared/` are the single
most likely way this project fails (HANDOFF.md §3).

Format: `## <ISO timestamp> — <file> — <what changed and why>`

---

## 2026-09-07T00:00Z — shared/{constants,protocol,track-schema}.ts — initial freeze

Contract established from HANDOFF.md §5. Contents:

- `constants.ts` — fixed timestep 1/60, 60 Hz tick, 30 Hz snapshots, 100 ms
  interpolation delay, car reference dimensions (§5.2), collision groups,
  race constants, car colour palette.
- `protocol.ts` — `ClientMsg` / `ServerMsg` unions per §5.4, plus `hello`,
  `ready`, `ping`/`pong`, `roster`, `lap` which §5.4 implies but did not spell
  out. `sanitizeInput()` lives here because both server and the AI driver need
  identical clamping.
- `track-schema.ts` — `TrackData` per §5.3, plus `validateTrack()` and
  `measureLapLength()` so both sides can fail loudly at load time.

Additions beyond the letter of §5.4 (`hello`, `ready`, `roster`, `lap`, `pong`,
`error`) are new message types, not modifications to `input`/`snap`/`state`/
`result`. The wire shapes given in §5.4 are byte-for-byte as specified.

## 2026-09-07T01:10Z — shared/track-schema.ts — no change; semantic note on mesh fields

`collisionMesh` and `visualMesh` now carry `"procedural:collision"` and
`"procedural:visual"` rather than `.glb` filenames. The field types and the
schema are untouched — this is a change in what the strings mean, not in the
contract's shape. Both sides build meshes from the waypoints via
`buildTrackMeshes()`. Rationale in DECISION-LOG.md.

## 2026-09-07T02:40Z — shared/protocol.ts — no change; steering sign defined

`InputMsg.steer` is `-1..1` per §5.4, but the sign was never specified and both
halves of the build need to agree. Defined now as:

**positive `steer` turns the car RIGHT**, matching a steering wheel turned
clockwise. Negative turns left.

No field, type or wire shape changes. The conversion to the physical wheel angle
(which is positive to the *left*, because rotating the chassis forward vector
about +Y by a positive angle takes -Z toward -X) happens in exactly one place,
`Car.step()` in vehicle/car.ts. If a wheel mesh appears to steer the wrong way,
fix it in the renderer, not by adding a second negation.

## 2026-09-07T14:20Z — shared/protocol.ts — added `InputBatchMsg` (`t: "inputs"`)

**Addition, not a modification.** `InputMsg` is untouched and the server still
accepts it; `ClientMsg` gains one member.

```ts
export interface InputBatchMsg {
  t: 'inputs';
  a: Omit<InputMsg, 't'>[];   // oldest first
}
```

Why: redundancy against packet loss. Each input is carried in three consecutive
packets, so losing any one packet still delivers it. That was already being done
by sending the same three inputs as three separate `input` messages, which gives
identical redundancy at three times the packet count — 90 messages per second
upstream per client instead of 30.

The server ignores any `seq` at or below the highest it has seen, so duplicates
cost nothing and a recovered input is applied as if it had never gone missing.
Order within `a` matters: oldest first, or a recovered input arrives after the
newer ones and is discarded.

## 2026-09-07T21:05Z — shared/track-schema.ts — no change; banking sign defined

`Waypoint.banking` is documented as "radians, positive = banked right". That
phrase does not say which way the surface actually tilts, and the two instances
read it in opposite directions. Defined now, matching the physics:

**Positive `banking` LOWERS the right-hand edge of the track.**

Equivalently: the frame is rolled about the forward axis toward `forward x
right`. Positive banking is therefore correct camber for a right-hand corner,
whose inside is the right.

No field, type or wire shape changes.

Why this needed writing down: `vehicle/track-collision.ts` rolled one way and
`track/src/mesh.ts` rolled the other, so the same number produced opposite
camber in the physics and the visuals. Nothing caught it, because each half was
self-consistent. Instance B then "corrected" the generator's sign to match the
renderer, which put every corner off-camber in the collision mesh the car
actually drives on: **ten of ten AI cars finished a three-lap race before that
change and two of ten after it.** Reverted, and the renderer now matches the
physics instead.

The physics builder owns this convention. If a banked corner ever looks wrong in
the renderer, fix the renderer — do not flip the generator.

## 2026-09-07 — Instance A — `ErrorMsg.code` gains `'timeout'`

Additive: one new member of an existing union. No field, type or wire shape
changes, and no existing code is affected.

The server now closes the socket when it drops a client for inactivity, and
sends this first so the client can say why. Previously the entrant was removed
and the socket left open, which left the player connected to a room that had no
entrant for them: `onReady` returned early, no roster came back, snapshots
carried no car, and the lobby's Ready button silently did nothing.

Clients that do not recognise the code should treat it like any other error and
show the message.

## 2026-09-08 — Instance A — `ResetMsg`, and `RESET_COOLDOWN_SECONDS`

Additive: one new client message and one new constant. No existing field, type
or wire shape changes.

`ClientMsg` gains `{ t: 'reset' }`. It carries nothing on purpose — where a car
goes back to is the server's decision, taken from the last checkpoint that car
actually reached, so the message cannot be used to gain track position.

`RESET_COOLDOWN_SECONDS` (4) is shared because both ends need it: the server
enforces the gap between resets, and the client mirrors it so the button can
refuse a press honestly rather than flashing "accepted" at a request the server
is about to discard.

## 2026-09-09 — shared/constants.ts — MAX_PLAYERS 10 -> 25, CAR_COLORS 10 -> 25

**Instance A: this raises the grid size ceiling. Your gate runs were measured at
ten cars and are still valid for ten; they say nothing about twenty-five.**

`MAX_PLAYERS` is 25. `CAR_COLORS` and `CAR_COLOR_NAMES` grew to 25 entries to
match, since a colour index is now allowed to reach 24. Both arrays were already
the same length and still are.

No type, field or wire shape changed. `MAX_PLAYERS` was already only a default:
`Room` takes `opts.maxPlayers`, and the server entry now passes `CARS` from the
environment, so the running grid is chosen per race and defaults to the ceiling.

The spawn grid is generated to `MAX_PLAYERS` slots, so `public/track/*.json` has
25 entries where it had 10. Everything that reads it already bounds itself by
`track.spawnGrid.length`, so a shorter track file is still safe.

### Why 25, and what it costs

Measured with `tools/gridscale.ts`, added for this. Simulation cost is **linear**
in the number of cars — Rapier's broad-phase is not the problem — at roughly
0.68 ms per car plus 0.28 ms fixed **on a thermally throttled laptop** whose
`cpubench` ten-car step reads 7.06 ms against the ~1 ms a healthy machine gives.

So on that throttled machine 25 cars needs 17.4 ms against a 16.67 ms budget,
and 23 fit. Scaled to a machine that is not throttling, the same linear cost puts
25 cars near 2.5 ms and well inside budget. The ceiling is the hardware, not the
code, which is why it is not hardcoded to one number:

`server/index.ts` now watches `room.tickMs` and warns the host once, with the
measured p95 and the car count, when the grid they chose does not hold 60 Hz on
the machine they are on. Verified — it fired at 25 cars on this laptop with
"p95 20.8 ms against a 16.7 ms budget".

Pick `CARS` for the venue machine. `npx tsx tools/gridscale.ts` prints the curve
and the largest grid that fits, and `cpubench.ts` first says whether to believe it.
