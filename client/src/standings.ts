/**
 * Live race order, computed on the client from the snapshot.
 *
 * HANDOFF.md §11 requires positions to be correct, and the snapshot carries
 * everything needed to work them out: `lap`, the last checkpoint passed, and
 * the car's position, which `TrackQuery` turns into a distance along the lap.
 * Ordering by (laps completed, distance around this lap) is the whole rule.
 *
 * Done here rather than added to the wire because the snapshot shape is frozen
 * (§5.4) and this needs no new field. It agrees with the server's own ordering
 * in `Room.order()` because both sort on the same quantity; the results screen
 * at the end still comes from the server, which is authoritative.
 *
 * The `cp` field is not used for ordering but is checked: a car that has not
 * passed the checkpoints cannot be ahead of one that has, however far around
 * the lap it appears to be.
 */

import type { CarSnap } from '../../shared/protocol';
import type { TrackQuery } from '../../vehicle/track-query';

export interface Standing {
  id: number;
  position: number;
  lap: number;
  /** Distance covered in the race, metres. Used for the gap. */
  raceDistance: number;
  /** Metres behind the car ahead, or 0 for the leader. */
  gapAhead: number;
  /** Metres behind the leader. */
  gapLeader: number;
}

export class Standings {
  private readonly q: TrackQuery;
  /** Last waypoint index per car, so lookups stay local. */
  private readonly hints = new Map<number, number>();
  private latest: Standing[] = [];

  constructor(q: TrackQuery) {
    this.q = q;
  }

  /** Recompute from a snapshot. Cheap enough to run at the snapshot rate. */
  update(cars: CarSnap[]): Standing[] {
    const rows = cars.map((c) => {
      const hint = this.hints.get(c.id);
      const loc = this.q.locate(c.p[0], c.p[1], c.p[2], hint);
      this.hints.set(c.id, loc.index);

      // The grid sits *behind* the start line, so a car that has not moved reads
      // a distance near the full lap length while its lap count is still zero -
      // and naively adding those together puts a parked car ahead of the
      // leader. It showed up as a car on the grid holding P5 with a gap of
      // minus 1971 m, which is a whole lap of Interlagos.
      //
      // A car that has passed no checkpoint yet cannot be most of the way round,
      // so a large distance there means it is before the line, not nearly done.
      // Checkpoint 1 is about a fourteenth of the way round, so half a lap is a
      // wide margin for this test.
      let d = loc.distance;
      if (c.cp === 0 && d > this.q.lapLength * 0.5) d -= this.q.lapLength;

      return { id: c.id, lap: c.lap, cp: c.cp, raceDistance: c.lap * this.q.lapLength + d };
    });

    rows.sort((a, b) => {
      if (a.lap !== b.lap) return b.lap - a.lap;
      if (a.cp !== b.cp) return b.cp - a.cp;
      return b.raceDistance - a.raceDistance;
    });

    const leader = rows[0]?.raceDistance ?? 0;
    this.latest = rows.map((r, i) => ({
      id: r.id,
      position: i + 1,
      lap: r.lap,
      raceDistance: r.raceDistance,
      gapAhead: i === 0 ? 0 : (rows[i - 1]?.raceDistance ?? r.raceDistance) - r.raceDistance,
      gapLeader: leader - r.raceDistance,
    }));

    // Cars that have left are gone from the snapshot; drop their hints so the
    // map does not grow across a long session of races.
    if (this.hints.size > rows.length * 2) {
      const live = new Set(rows.map((r) => r.id));
      for (const id of [...this.hints.keys()]) if (!live.has(id)) this.hints.delete(id);
    }

    return this.latest;
  }

  get all(): Standing[] {
    return this.latest;
  }

  positionOf(id: number): number | null {
    return this.latest.find((s) => s.id === id)?.position ?? null;
  }

  get count(): number {
    return this.latest.length;
  }

  /** The car currently leading, for the spectator camera. */
  leaderId(): number | null {
    return this.latest[0]?.id ?? null;
  }
}
