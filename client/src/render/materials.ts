/**
 * Procedural surface materials.
 *
 * Every texture here is drawn into a canvas at load time. Nothing is fetched.
 * That is partly HANDOFF.md §10 (original assets only — no real sponsors,
 * liveries or team marks anywhere) and partly venue risk (§9): a demo that
 * needs to pull image files is a demo that can fail on a bad network.
 *
 * UV convention, set by track/src/mesh.ts:
 *   asphalt    u across the road, 0..1 edge to edge   v arc length in metres
 *   kerb       u across the kerb, 0..1                v arc length in metres
 *   grass      u lateral metres                       v arc length in metres
 *   gravel     u lateral metres                       v arc length in metres
 *   barrier    u arc length in metres                 v 0..1 up the wall
 *   startLine  u across the road, 0..1                v 0..1 along the line
 *
 * So `repeat` is set in metres-per-tile below, and asphalt/kerb clamp across
 * their width — the track is 12.5 m wide at Pinheirinho and 16 m on the pit
 * straight, and a painted line has to stay at the edge of both.
 */

import * as THREE from 'three';

/**
 * Deterministic PRNG. The noise is baked once at load; seeding it means two
 * machines side by side at the venue render the identical surface, and a
 * screenshot comparison is meaningful.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  return [c, ctx];
}

/** Speckle the canvas with per-pixel luminance noise. */
function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, seed: number): void {
  const rnd = mulberry32(seed);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    d[i] = clamp255(d[i]! + n);
    d[i + 1] = clamp255(d[i + 1]! + n);
    d[i + 2] = clamp255(d[i + 2]! + n);
  }
  ctx.putImageData(img, 0, 0);
}

function clamp255(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

function texture(c: HTMLCanvasElement, wrapS: THREE.Wrapping, wrapT: THREE.Wrapping): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = wrapS;
  t.wrapT = wrapT;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const CLAMP = THREE.ClampToEdgeWrapping;
const REPEAT = THREE.RepeatWrapping;

// ---------------------------------------------------------------------------

/**
 * Asphalt with painted edge lines.
 *
 * The canvas is wide because the line is narrow relative to the road: a 120 mm
 * line on a 14 m track is under 1% of the width, so at a low resolution it
 * either disappears or aliases into a crawling dashed edge under motion.
 */
function asphaltTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 256;
  const [c, ctx] = canvas(W, H);

  // Lighter than asphalt looks in a photograph. Under ACES tone mapping, with
  // only two lights and no environment map, a photographic #3a3d42 lands near
  // #262728 on screen — a black hole on a projector rather than a road.
  ctx.fillStyle = '#5b6066';
  ctx.fillRect(0, 0, W, H);
  speckle(ctx, W, H, 26, 1);

  // A slightly darker racing line down the middle: reads as rubber laid down,
  // and gives the eye something to judge road position against on a projector.
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.16)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const line = Math.max(3, Math.round(W * 0.009));
  ctx.fillStyle = '#e8e8e6';
  ctx.fillRect(0, 0, line, H);
  ctx.fillRect(W - line, 0, line, H);

  const t = texture(c, CLAMP, REPEAT);
  t.repeat.set(1, 1 / 8); // one tile per 8 m along the track
  return t;
}

/** Red/white kerb, alternating along the direction of travel. */
function kerbTexture(): THREE.CanvasTexture {
  const W = 32;
  const H = 128;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#d8d8d4';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(0, 0, W, H / 2);
  speckle(ctx, W, H, 14, 7);

  const t = texture(c, CLAMP, REPEAT);
  t.repeat.set(1, 1 / 2); // 1 m of red then 1 m of white
  return t;
}

function grassTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 256;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#3f6b32';
  ctx.fillRect(0, 0, W, H);

  // Mown bands, as at a real circuit. Broad enough to read from the air.
  const rnd = mulberry32(11);
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  for (let y = 0; y < H; y += 32) if (rnd() > 0.5) ctx.fillRect(0, y, W, 16);
  speckle(ctx, W, H, 30, 3);

  const t = texture(c, REPEAT, REPEAT);
  t.repeat.set(1 / 6, 1 / 6); // 6 m tile
  return t;
}

function gravelTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 256;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#b09a72';
  ctx.fillRect(0, 0, W, H);
  speckle(ctx, W, H, 46, 5);

  // Coarse stones on top of the fine speckle, so it does not read as sand.
  const rnd = mulberry32(23);
  for (let i = 0; i < 900; i++) {
    const g = 150 + Math.floor(rnd() * 70);
    ctx.fillStyle = `rgb(${g},${g - 14},${g - 40})`;
    ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
  }

  const t = texture(c, REPEAT, REPEAT);
  t.repeat.set(1 / 4, 1 / 4); // 4 m tile
  return t;
}

/**
 * Barrier panels. Invented markings only — alternating plain colour blocks and
 * a dark kickplate. No sponsor, team or driver marks anywhere (HANDOFF.md §10).
 */
function barrierTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 64;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#e6e6e6';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(0, 0, W / 2, H);
  // Kickplate along the bottom: v = 0 is the ground.
  ctx.fillStyle = '#2b2f36';
  ctx.fillRect(0, 0, W, H * 0.22);
  speckle(ctx, W, H, 12, 13);

  const t = texture(c, REPEAT, CLAMP);
  t.repeat.set(1 / 8, 1); // 4 m of red then 4 m of white
  return t;
}

/** Start/finish chequer. */
function startLineTexture(): THREE.CanvasTexture {
  const N = 128;
  const [c, ctx] = canvas(N, N);
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, N, N);
  ctx.fillStyle = '#17181a';
  const cells = 16;
  const s = N / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if ((x + y) % 2 === 0) ctx.fillRect(x * s, y * s, s, s);
    }
  }
  return texture(c, CLAMP, CLAMP);
}

// ---------------------------------------------------------------------------

export type SurfaceMaterialKey = 'asphalt' | 'kerb' | 'grass' | 'gravel' | 'barrier' | 'startLine';

export type SurfaceMaterials = Record<SurfaceMaterialKey, THREE.Material>;

/**
 * Build the material set. Call once — textures are canvases and there is no
 * reason to redraw them per track.
 */
export function createSurfaceMaterials(): SurfaceMaterials {
  const standard = (map: THREE.Texture, roughness: number, metalness = 0): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ map, roughness, metalness });

  return {
    asphalt: standard(asphaltTexture(), 0.92),
    kerb: standard(kerbTexture(), 0.7),
    grass: standard(grassTexture(), 1),
    gravel: standard(gravelTexture(), 1),
    // Barriers are seen from both sides at the hairpins, where the track doubles
    // back on itself and you look across the infield at the far side.
    barrier: new THREE.MeshStandardMaterial({
      map: barrierTexture(),
      roughness: 0.6,
      side: THREE.DoubleSide,
    }),
    startLine: standard(startLineTexture(), 0.85),
  };
}

export function disposeSurfaceMaterials(m: SurfaceMaterials): void {
  for (const mat of Object.values(m)) {
    const withMap = mat as THREE.Material & { map?: THREE.Texture | null };
    withMap.map?.dispose();
    mat.dispose();
  }
}
