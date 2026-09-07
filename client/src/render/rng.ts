/**
 * Deterministic randomness for scenery placement.
 *
 * Seeded, so two machines side by side at the venue grow the identical forest
 * and a screenshot comparison stays meaningful. Nothing here is used by the
 * simulation — placement is decorative and never reaches the server.
 */

/** Small, fast, well-distributed PRNG. Returns values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of an integer lattice point to [0, 1). */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Bilinear value noise over a grid of side `scale` metres, in [0, 1].
 *
 * Used to modulate tree density. A uniform scatter reads as wallpaper; real
 * parkland has groves and clearings, and at 200 km/h it is the variation in
 * density that gives the eye something to measure speed against.
 */
export function valueNoise(x: number, y: number, scale: number, seed = 1): number {
  const fx = x / scale;
  const fy = y / scale;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  // Smoothstep the interpolant so the field has no visible grid creases.
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);

  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);

  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
