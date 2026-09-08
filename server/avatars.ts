/**
 * Driver photos, in memory, keyed by car id.
 *
 * Players take a photo on their phone in the lobby and it rides above their car
 * for the race, so everyone can see whose car is whose.
 *
 * These go over HTTP rather than either WebSocket. The game socket is frozen
 * (HANDOFF.md §3) and carries 30 Hz snapshots that a 10 KB image would sit in
 * front of; the pairing socket is point to point, and a photo has to reach every
 * player, not just the one who took it. An image is a static blob, and serving
 * static blobs is what the HTTP server is already for.
 *
 * Nothing is written to disk. The photos exist for the life of the process,
 * which is the life of the demo.
 */

/** Generous for a 160 px JPEG, which lands around 8 KB. */
const MAX_BYTES = 48 * 1024;

/** More than a full grid, so reconnects and colour changes have room. */
const MAX_ENTRIES = 32;

interface Avatar {
  bytes: Buffer;
  /** Bumped on every replacement so clients can tell a new photo from a cached one. */
  version: number;
}

export class AvatarStore {
  private readonly byId = new Map<number, Avatar>();
  private counter = 0;

  /**
   * Store a photo for a car. Returns false if it is too large or not a JPEG,
   * which is the only validation worth doing: this listens on a venue LAN, and
   * the failure to prevent is a stray request filling memory.
   */
  set(id: number, bytes: Buffer): boolean {
    if (!Number.isInteger(id) || id < 0 || id > 4096) return false;
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return false;
    // JPEG magic. Enough to reject anything that is not an image at all.
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;

    if (!this.byId.has(id) && this.byId.size >= MAX_ENTRIES) {
      // Drop the oldest rather than refuse: at a venue the newcomer is the
      // person standing in front of you.
      const oldest = this.byId.keys().next();
      if (!oldest.done) this.byId.delete(oldest.value);
    }

    this.byId.set(id, { bytes, version: ++this.counter });
    return true;
  }

  get(id: number): Buffer | null {
    return this.byId.get(id)?.bytes ?? null;
  }

  /**
   * `{ carId: version }` for every photo held.
   *
   * Clients poll this — a few dozen bytes — and fetch only what changed. It
   * exists because there is no way to announce a new photo on the frozen game
   * protocol, and adding one would put image plumbing into the netcode.
   */
  manifest(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const [id, a] of this.byId) out[id] = a.version;
    return out;
  }

  /** Forget one car's photo, when it leaves for good. */
  remove(id: number): void {
    this.byId.delete(id);
  }

  get size(): number {
    return this.byId.size;
  }
}
