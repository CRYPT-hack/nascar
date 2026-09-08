/**
 * Driver photos: fetching them, and turning them into textures.
 *
 * Every player's photo has to reach every player, and there is no way to
 * announce one on the frozen game protocol. So the server keeps them and
 * publishes a tiny manifest of `{ carId: version }`; clients poll that and
 * fetch only what changed. A few dozen bytes every couple of seconds, and no
 * image ever touches the 30 Hz snapshot socket.
 *
 * Polling rather than pushing because a photo is taken once, in the lobby, and
 * being a second late to see it costs nothing.
 */

import * as THREE from 'three';

/** How often the manifest is checked. Photos are a lobby-time event. */
const POLL_MS = 2000;

export class AvatarStore {
  private readonly textures = new Map<number, THREE.Texture>();
  /** Version last fetched per car, so an unchanged photo is never refetched. */
  private readonly versions = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  /** Called when a car's photo first arrives or is replaced. */
  onPhoto: ((id: number, texture: THREE.Texture) => void) | null = null;

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  textureFor(id: number): THREE.Texture | null {
    return this.textures.get(id) ?? null;
  }

  private async poll(): Promise<void> {
    // One request at a time: a slow network must not stack them up.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const res = await fetch(avatarManifestUrl(), { cache: 'no-store' });
      if (!res.ok) return;
      const manifest = (await res.json()) as Record<string, number>;
      for (const [key, version] of Object.entries(manifest)) {
        const id = Number(key);
        if (this.versions.get(id) === version) continue;
        this.versions.set(id, version);
        await this.load(id, version);
      }
    } catch {
      // The server may not be up yet, or may not have this route. Either way
      // the next tick tries again and the cars stay plain until then.
    } finally {
      this.inFlight = false;
    }
  }

  private async load(id: number, version: number): Promise<void> {
    // The version in the query string is what makes a replaced photo a new URL,
    // which is why the image itself can be served immutable.
    const texture = await new Promise<THREE.Texture | null>((resolve) => {
      new THREE.TextureLoader().load(
        `${avatarUrl(id)}?v=${version}`,
        (t) => resolve(t),
        undefined,
        () => resolve(null),
      );
    });
    if (!texture) return;
    texture.colorSpace = THREE.SRGBColorSpace;
    // The quad is small on screen and the source is already tiny; mipmaps only
    // soften it.
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    this.textures.get(id)?.dispose();
    this.textures.set(id, texture);
    this.onPhoto?.(id, texture);
  }

  dispose(): void {
    this.stop();
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
  }
}

/**
 * Photos live on the game server, which is where the pages are served from in
 * the built demo and on :8080 during `npm run dev`.
 */
export function avatarUrl(id: number): string {
  return `${avatarBase()}/avatar/${id}`;
}

export function avatarManifestUrl(): string {
  return `${avatarBase()}/avatars`;
}

function avatarBase(): string {
  if (typeof location === 'undefined') return 'http://localhost:8080';
  const port = location.port === '5173' ? '8080' : location.port;
  return `${location.protocol}//${location.hostname}${port ? `:${port}` : ''}`;
}
