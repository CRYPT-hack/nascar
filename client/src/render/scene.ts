/**
 * Renderer, camera, sky and lighting rig.
 *
 * Instance A owns the chase camera and the car meshes; this module owns the
 * environment they sit in and exposes `followShadow()` so the shadow frustum
 * can track whatever the camera is following.
 *
 * Tuned for a projector (HANDOFF.md §1, §9): projectors crush dark tones and
 * wash out low-contrast mid greys, so the sky is bright, the fog is far enough
 * back not to grey out the mid-distance, and tone mapping keeps the highlights
 * off the clipping point.
 */

import * as THREE from 'three';

/**
 * Metres. Beyond this the circuit fades into haze rather than popping out.
 *
 * Deliberately far: at 260 m the near plane of the fog sat inside the length of
 * the pit straight and greyed out the mid-distance, which on a projector reads
 * as a washed-out screen rather than as atmosphere.
 */
export const FOG_NEAR = 420;
export const FOG_FAR = 2800;

const SKY_TOP = new THREE.Color(0x2d6ecc);
const SKY_HORIZON = new THREE.Color(0xbcd4ea);
const GROUND_BOUNCE = new THREE.Color(0x4a5340);

/**
 * Gradient sky dome. A vertical two-colour ramp on the inside of a large
 * sphere — no cube map, so nothing to load and nothing to ship.
 */
function createSky(radius: number): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: SKY_TOP },
      horizon: { value: SKY_HORIZON },
      // Pulls the gradient's midpoint down so most of the visible dome is the
      // lighter horizon colour, which is what a wide-angle chase camera sees.
      exponent: { value: 0.55 },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform float exponent;
      varying vec3 vWorld;
      void main() {
        float h = normalize(vWorld).y;
        float t = pow(clamp(h, 0.0, 1.0), exponent);
        gl_FragColor = vec4(mix(horizon, top, t), 1.0);
      }
    `,
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
  sky.name = 'sky';
  // The dome is effectively at infinity; never let it cull or cast.
  sky.frustumCulled = false;
  sky.matrixAutoUpdate = false;
  return sky;
}

export interface SceneRig {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  sun: THREE.DirectionalLight;
  /**
   * Move the shadow frustum to cover a point. The shadow map is small and tight
   * rather than large and blurry, so it has to follow the action.
   */
  followShadow(target: THREE.Vector3): void;
  resize(): void;
  dispose(): void;
}

export interface SceneOptions {
  /** Half-extent of the circuit, metres. Sizes the sky dome and shadow camera. */
  extent: number;
  canvas?: HTMLCanvasElement;
  /**
   * Keep the drawing buffer readable after each frame so the canvas can be
   * captured. Costs a little performance, so it is off for the game and on for
   * the preview harness, which needs to produce stills for review and for the
   * fallback recording (HANDOFF.md §9).
   */
  capturable?: boolean;
}

export function createSceneRig({ extent, canvas, capturable = false }: SceneOptions): SceneRig {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: capturable,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // ACES pulls midtones down hard, and a projector pulls them down again.
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(SKY_HORIZON.getHex(), FOG_NEAR, FOG_FAR);

  const skyRadius = Math.max(2000, extent * 3);
  scene.add(createSky(skyRadius));

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, skyRadius * 1.5);

  // Hemisphere fills the shadowed side. Without it the underside of a car and
  // the inside of a barrier go to black, which a projector renders as a hole.
  const hemi = new THREE.HemisphereLight(SKY_HORIZON.getHex(), GROUND_BOUNCE.getHex(), 1.15);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2dd, 2.1);
  sun.position.set(-0.45, 1, 0.35).normalize().multiplyScalar(400);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // A tight frustum that follows the car: covering the whole circuit at this
  // map size would put one shadow texel every 40 cm and the cars would have no
  // recognisable shadow at all.
  const span = 90;
  sun.shadow.camera.left = -span;
  sun.shadow.camera.right = span;
  sun.shadow.camera.top = span;
  sun.shadow.camera.bottom = -span;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 1200;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  const sunOffset = sun.position.clone();

  const resize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  };

  window.addEventListener('resize', resize);

  return {
    scene,
    camera,
    renderer,
    sun,
    followShadow(target: THREE.Vector3): void {
      sun.target.position.copy(target);
      sun.position.copy(target).add(sunOffset);
      sun.target.updateMatrixWorld();
    },
    resize,
    dispose(): void {
      window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}
