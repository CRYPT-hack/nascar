/**
 * Render quality tiers.
 *
 * The build was reported unplayable, and profiling said why: per-frame CPU work
 * is about 2 ms, so the client is not the bottleneck — the GPU is. The browser
 * on the demo machine runs on **Intel UHD Graphics**, an integrated part, and
 * the environment it is being asked to draw was tuned on something else: 150k
 * triangles, ~1400 trees and ~1900 spectators, a 2048² soft-shadow map, MSAA,
 * and a device pixel ratio of up to 2 (four times the pixels of 1).
 *
 * None of that is wrong on a discrete GPU. It is simply not a setting an
 * integrated one can hold at 60 fps, and the game had no way to say so.
 *
 * Order of precedence: `?quality=` in the URL, then a remembered choice, then
 * what the GPU looks like. The URL wins so a tier can be tried in one reload
 * without clearing anything.
 */

export type Quality = 'low' | 'medium' | 'high';

export const QUALITY_ORDER: readonly Quality[] = ['low', 'medium', 'high'];

export interface QualitySettings {
  /** Multiplier on the device pixel ratio. Fill rate is what an iGPU runs out of first. */
  readonly pixelRatio: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  /** MSAA. Needs a new WebGL context, so it only changes on reload. */
  readonly antialias: boolean;
  /** Trees, crowds, tyre stacks: decoration, and the cheapest thing to drop. */
  readonly scenery: boolean;
  /** Metres. Pulling this in culls a large part of the circuit. */
  readonly fogFar: number;
}

export const QUALITY: Record<Quality, QualitySettings> = {
  low: {
    pixelRatio: 0.7,
    shadows: false,
    shadowMapSize: 512,
    antialias: false,
    scenery: false,
    fogFar: 900,
  },
  medium: {
    pixelRatio: 1,
    shadows: true,
    shadowMapSize: 1024,
    antialias: false,
    scenery: true,
    fogFar: 1600,
  },
  high: {
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 2048,
    antialias: true,
    scenery: true,
    fogFar: 2800,
  },
};

const STORAGE_KEY = 'renderQuality';

function isQuality(v: string | null): v is Quality {
  return v === 'low' || v === 'medium' || v === 'high';
}

/**
 * What the GPU string suggests.
 *
 * Deliberately crude. Getting this wrong in the cautious direction costs some
 * scenery; getting it wrong the other way costs the demo.
 */
export function detectQuality(renderer: string): Quality {
  const s = renderer.toLowerCase();
  // Software rasterisers: nothing will save these but the lowest tier.
  if (s.includes('swiftshader') || s.includes('llvmpipe') || s.includes('software')) return 'low';
  // Intel integrated. "Arc" and "Iris Xe" are much stronger than plain UHD/HD.
  if (s.includes('intel')) {
    if (s.includes('arc') || s.includes('iris')) return 'medium';
    if (s.includes('uhd') || s.includes('hd graphics')) return 'low';
    return 'medium';
  }
  // Phone and tablet parts.
  if (s.includes('mali') || s.includes('adreno') || s.includes('powervr')) return 'low';
  // Anything with a discrete name in it.
  if (s.includes('nvidia') || s.includes('geforce') || s.includes('radeon') || s.includes('rtx')) {
    return 'high';
  }
  return 'medium';
}

/** Reads the GPU name without committing to a renderer, so MSAA can be decided first. */
export function probeRenderer(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return '';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}

export function resolveQuality(search: string): { quality: Quality; gpu: string; why: string } {
  const gpu = probeRenderer();

  const asked = new URLSearchParams(search).get('quality');
  if (isQuality(asked)) return { quality: asked, gpu, why: 'from the URL' };

  // The remembered tier is stored against the GPU it was chosen for. Switching
  // a laptop from its integrated chip to its discrete one changes what the
  // machine can do completely, and a tier picked for the weaker one would
  // otherwise stick and hide the upgrade.
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { quality?: string; gpu?: string };
      if (isQuality(saved.quality ?? null)) {
        if (saved.gpu === gpu) {
          return { quality: saved.quality as Quality, gpu, why: 'remembered' };
        }
        // Same browser, different GPU: re-detect rather than trust the old pick.
        const fresh = detectQuality(gpu);
        return { quality: fresh, gpu, why: `GPU changed, re-detected as ${short(gpu)}` };
      }
    }
  } catch {
    /* private window, or something else wrote the key: fall through */
  }

  return { quality: detectQuality(gpu), gpu, why: `detected ${short(gpu)}` };
}

/** The part of a WebGL renderer string worth showing a person. */
export function short(gpu: string): string {
  if (!gpu) return 'an unknown GPU';
  // ANGLE wraps the real name: "ANGLE (Intel, Intel(R) UHD Graphics (0x...)
  // Direct3D11 vs_5_0 ps_5_0, D3D11)". The vendor is the first field and the
  // adapter the second, and the adapter itself contains brackets, so this
  // splits on the comma rather than trying to match balanced parentheses.
  let name = gpu;
  if (name.startsWith('ANGLE (')) {
    const parts = name.slice('ANGLE ('.length, -1).split(', ');
    name = parts[1] ?? parts[0] ?? name;
  }
  return name
    .replace(/\s*\(0x[0-9A-Fa-f]+\)/, '')   // the PCI id
    .replace(/\s+Direct3D.*$/, '')          // the backend suffix
    .replace(/\s+vs_\d.*$/, '')
    .trim();
}

export function rememberQuality(q: Quality): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ quality: q, gpu: probeRenderer() }));
  } catch {
    /* nothing to do, and not worth failing over */
  }
}
