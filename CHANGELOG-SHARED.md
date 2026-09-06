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
