/**
 * Standalone track viewer.  `npm run dev` then open /preview.html
 *
 * Instance B's verification harness. The track has to be judged from a driver's
 * eye at speed, not from a plan view — a corner that reads fine in the build
 * SVG can still arrive blind or leave you with nothing to aim at. This runs
 * without any of the netcode, so the environment can be checked while Instance
 * A's game loop is still being built.
 *
 *   orbit    drag / wheel
 *   L        fly a lap from the driver's eye
 *   G        toggle grid markers
 *   H        toggle the HUD
 *   K / J    lobby / results screen, with placeholder drivers
 *   1 / 2    interlagos / oval
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { RACE_LAPS } from '../../shared/constants';
import type { PlayerInfo, ResultEntry } from '../../shared/protocol';
import type { TrackData } from '../../shared/track-schema';
import { validateTrack } from '../../shared/track-schema';
import { TrackSampler } from '../../track/src/sampler';
import { Hud, initialHudState } from './hud/hud';
import { Screens } from './hud/screens';
import { createSceneRig, FOG_FAR, FOG_NEAR, type SceneRig } from './render/scene';
import { createGridMarkers, createGroundPlane, createTrackView, type TrackView } from './render/track-view';

/** Metres per second for the lap fly-through. 55 m/s is about 200 km/h. */
const LAP_SPEED = 55;
/** How far ahead the lap camera looks. Too short and every corner is a surprise. */
const LOOK_AHEAD = 28;
const EYE_HEIGHT = 1.15;

const info = document.getElementById('info') as HTMLDivElement;

interface Bounds {
  centre: THREE.Vector3;
  extent: number;
}

function boundsOf(track: TrackData): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const w of track.waypoints) {
    minX = Math.min(minX, w.p[0]);
    maxX = Math.max(maxX, w.p[0]);
    minZ = Math.min(minZ, w.p[2]);
    maxZ = Math.max(maxZ, w.p[2]);
    minY = Math.min(minY, w.p[1]);
    maxY = Math.max(maxY, w.p[1]);
  }
  return {
    centre: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
    extent: Math.max(maxX - minX, maxZ - minZ) / 2,
  };
}

async function loadTrack(name: string): Promise<TrackData> {
  const res = await fetch(`/track/${name}.json`);
  if (!res.ok) throw new Error(`cannot load track "${name}": ${res.status}`);
  const track = (await res.json()) as TrackData;
  const errs = validateTrack(track);
  if (errs.length) throw new Error(`track "${name}" failed validation:\n  ${errs.join('\n  ')}`);
  return track;
}

let rig: SceneRig | null = null;
let view: TrackView | null = null;
let controls: OrbitControls | null = null;
let sampler: TrackSampler | null = null;
let markers: THREE.Group | null = null;
let ground: THREE.Mesh | null = null;

let lapMode = false;
let lapDistance = 0;
let currentName = '';
let trackExtent = 500;

// --- HUD -------------------------------------------------------------------
// Driven here from the fly-through so the overlay can be checked against a
// moving track rather than a static mock. Instance A drives it from snapshots.

const hud = new Hud();
const screens = new Screens();
const hudState = initialHudState(RACE_LAPS, 10);
hudState.raceState = 'racing';
hudState.position = 3;

/** Placeholder drivers for checking the lobby and results layouts. Invented names. */
const DEMO_PLAYERS: PlayerInfo[] = [
  { id: 1, name: 'Aurora', color: 0, ready: true, ai: false },
  { id: 2, name: 'Vex', color: 1, ready: true, ai: false },
  { id: 3, name: 'You', color: 2, ready: false, ai: false },
  { id: 4, name: 'Marrow', color: 3, ready: true, ai: false },
  { id: 5, name: 'Pilot 5', color: 4, ready: true, ai: true },
  { id: 6, name: 'Pilot 6', color: 5, ready: true, ai: true },
];

const DEMO_RESULTS: ResultEntry[] = DEMO_PLAYERS.map((p, i) => ({
  id: p.id,
  name: p.name,
  color: p.color,
  position: i + 1,
  laps: i === DEMO_PLAYERS.length - 1 ? 2 : RACE_LAPS,
  totalMs: i === DEMO_PLAYERS.length - 1 ? null : 214_320 + i * 1830,
  bestLapMs: 70_140 + i * 610,
  ai: p.ai,
}));

async function show(name: string): Promise<void> {
  currentName = name;
  const track = await loadTrack(name);

  if (view) {
    rig?.scene.remove(view.root);
    view.dispose();
  }
  if (ground) rig?.scene.remove(ground);
  if (markers) rig?.scene.remove(markers);

  const bounds = boundsOf(track);
  trackExtent = bounds.extent;

  if (!rig) {
    rig = createSceneRig({ extent: bounds.extent, capturable: true });
    document.body.appendChild(rig.renderer.domElement);
    // Debug handle for the harness only. The game entry does not do this.
    (window as unknown as { __preview: unknown }).__preview = { get rig() { return rig; }, get view() { return view; } };
    controls = new OrbitControls(rig.camera, rig.renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.495; // never drop below the horizon
  }

  view = createTrackView(track);
  ground = createGroundPlane(track);
  markers = createGridMarkers(track);
  rig.scene.add(view.root, ground, markers);
  sampler = new TrackSampler(track, view.meshes.section);

  // Frame the whole circuit on open. The two circuits differ by roughly a
  // factor of two in extent, so this is derived rather than a fixed position.
  const d = bounds.extent * 1.9;
  rig.camera.position.set(bounds.centre.x + d * 0.55, bounds.centre.y + d * 0.8, bounds.centre.z + d * 0.75);
  controls?.target.copy(bounds.centre);
  controls?.update();

  const tris = Object.values(view.meshes.visual).reduce((s, m) => s + m.indices.length / 3, 0);
  const collisionTris = view.meshes.collision.indices.length / 3;
  info.innerHTML =
    `<b>${track.name}</b> — ${track.lapLengthMeters} m, ${track.waypoints.length} waypoints<br>` +
    `visual ${tris} tris · collision ${collisionTris} tris · barriers ${view.meshes.barrierCollision.indices.length / 3} tris<br>` +
    `<span class="k">drag</span> orbit · <span class="k">L</span> lap · <span class="k">G</span> grid · <span class="k">H</span> hud · <span class="k">K</span>/<span class="k">J</span> lobby/results · <span class="k">1</span>/<span class="k">2</span> circuit`;
}

const clock = new THREE.Clock();

function frame(): void {
  requestAnimationFrame(frame);
  if (!rig || !sampler) return;
  const dt = Math.min(clock.getDelta(), 0.1);

  // Fog is tuned for the racing view, where it reads as aerial perspective. In
  // the overhead framing the whole circuit sits past FOG_FAR and the review
  // artefact turns into a grey rectangle, so push it back while orbiting.
  const fog = rig.scene.fog as THREE.Fog | null;
  if (fog) {
    fog.near = lapMode ? FOG_NEAR : trackExtent * 2;
    fog.far = lapMode ? FOG_FAR : trackExtent * 14;
  }

  if (lapMode) {
    const before = lapDistance;
    lapDistance = (lapDistance + LAP_SPEED * dt) % sampler.lapLength;
    const here = sampler.poseAt(lapDistance);
    const ahead = sampler.poseAt(lapDistance + LOOK_AHEAD);
    rig.camera.position.set(here.p[0], here.p[1] + EYE_HEIGHT, here.p[2]);
    rig.camera.lookAt(ahead.p[0], ahead.p[1] + EYE_HEIGHT * 0.8, ahead.p[2]);
    rig.followShadow(new THREE.Vector3(here.p[0], here.p[1], here.p[2]));

    // Feed the HUD from the fly-through, so the overlay is checked against a
    // moving track rather than a static mock. Crossing the seam is a new lap.
    hudState.lapTimeMs += dt * 1000;
    if (lapDistance < before) {
      hudState.lastLapMs = hudState.lapTimeMs;
      hudState.lastWasBest = hudState.bestLapMs === null || hudState.lapTimeMs < hudState.bestLapMs;
      if (hudState.lastWasBest) hudState.bestLapMs = hudState.lapTimeMs;
      hudState.lapTimeMs = 0;
      hudState.lap = (hudState.lap % RACE_LAPS) + 1;
    }
    hudState.speedKph = LAP_SPEED * 3.6;
    // Stand-in for a real draft check: the long straights are where it matters.
    hudState.drafting = Math.sin(lapDistance / 90) > 0.6;
  } else {
    controls?.update();
    rig.followShadow(controls ? controls.target : new THREE.Vector3());
    hudState.speedKph = 0;
    hudState.drafting = false;
  }

  hud.update(hudState);
  rig.renderer.render(rig.scene, rig.camera);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'l' || e.key === 'L') {
    lapMode = !lapMode;
    if (controls) controls.enabled = !lapMode;
  }
  if (e.key === 'g' || e.key === 'G') if (markers) markers.visible = !markers.visible;
  if (e.key === 'h' || e.key === 'H') hud.setVisible(hud.root.hidden);
  if (e.key === 'k' || e.key === 'K') {
    screens.showLobby({
      players: DEMO_PLAYERS,
      selfId: 3,
      selfColor: 2,
      ready: false,
      joinHint: `${location.hostname}:5173`,
      onReady: () => screens.hide(),
      onColor: () => undefined,
    });
  }
  if (e.key === 'j' || e.key === 'J') screens.showResults(DEMO_RESULTS, 3, () => screens.hide());
  if (e.key === 'Escape') screens.hide();
  if (e.key === '1' && currentName !== 'interlagos') void show('interlagos');
  if (e.key === '2' && currentName !== 'oval') void show('oval');
});

show(new URLSearchParams(location.search).get('track') ?? 'interlagos')
  .then(frame)
  .catch((err: unknown) => {
    info.innerHTML = `<b style="color:#ff6b6b">${String(err)}</b>`;
    console.error(err);
  });
