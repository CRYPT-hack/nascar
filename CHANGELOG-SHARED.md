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
