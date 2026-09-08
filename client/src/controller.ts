/**
 * Phone controller. Open on a phone; steers the car on a paired laptop.
 *
 * Hold the phone flat in two hands like a wheel:
 *   turn it left/right  ->  steering, proportional to the angle
 *   tilt the far edge down -> throttle, proportional
 *   tilt it back toward you -> brake, and reverse once stopped
 *
 * Sensor handling, in order of what actually bites:
 *
 * 1. Motion sensors need a secure context. Over plain http the page loads and
 *    no event ever fires. The server serves https when certs exist; without
 *    them this page says so rather than sitting silently at zero.
 * 2. iOS needs `DeviceOrientationEvent.requestPermission()` from a real user
 *    gesture, so nothing is read until the player taps Start.
 * 3. `beta`/`gamma` are in *device* axes, which rotate with the phone. Held in
 *    landscape they swap and change sign. They are converted to screen axes
 *    using `screen.orientation.angle`, so the mapping is right in any hold.
 * 4. Neutral is calibrated on Start rather than assumed. Nobody holds a phone
 *    at exactly 0 degrees, and "flat" on a lap is not "flat" standing up.
 */

import './controller.css';

/** Degrees of turn for full lock. A wheel, not a nudge. */
const STEER_RANGE = 38;
/** Degrees of forward tilt for full throttle. Small: wrists do not go far. */
const THROTTLE_RANGE = 22;
/** Degrees of backward tilt for full brake. */
const BRAKE_RANGE = 20;
/** Ignore this much wobble around neutral, degrees. */
const DEADZONE = 3;
/** Control send rate. The client samples input at 30 Hz; matching it is enough. */
const SEND_HZ = 40;
/** Low-pass factor per sample. Hands shake; the front wheels should not. */
const SMOOTHING = 0.35;

interface Angles {
  pitch: number;
  roll: number;
}

/**
 * Device orientation converted to screen axes.
 *
 * `beta` is rotation about the device x axis and `gamma` about device y. In
 * landscape those axes are rotated 90 degrees from the screen the player is
 * looking at, so using them raw makes steering and throttle swap places.
 */
function toScreenAngles(beta: number, gamma: number, angle: number): Angles {
  switch (((angle % 360) + 360) % 360) {
    case 90:
      return { pitch: -gamma, roll: beta };
    case 180:
      return { pitch: -beta, roll: -gamma };
    case 270:
      return { pitch: gamma, roll: -beta };
    default:
      return { pitch: beta, roll: gamma };
  }
}

function screenAngle(): number {
  const so = screen.orientation as ScreenOrientation | undefined;
  if (so && typeof so.angle === 'number') return so.angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Apply a deadzone and rescale so the live range still reaches 1. */
function curve(deg: number, range: number): number {
  const a = Math.abs(deg);
  if (a <= DEADZONE) return 0;
  return Math.sign(deg) * clamp((a - DEADZONE) / (range - DEADZONE), 0, 1);
}

// ---------------------------------------------------------------------------

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const setup = el('setup');
const drive = el('drive');
const codeInput = el<HTMLInputElement>('code');
const startBtn = el<HTMLButtonElement>('start');
const setupMsg = el('setup-msg');
const statusDot = el('status-dot');
const statusText = el('status-text');
const steerFill = el('steer-fill');
const pedalFill = el('pedal-fill');
const readout = el('readout');
const handbrakeBtn = el('handbrake');
const flipBtn = el<HTMLButtonElement>('flip');
const recalBtn = el<HTMLButtonElement>('recal');

let ws: WebSocket | null = null;
let paired = false;

let haveSensor = false;
let raw: Angles = { pitch: 0, roll: 0 };
let neutral: Angles = { pitch: 0, roll: 0 };
let smooth: Angles = { pitch: 0, roll: 0 };
let invert = false;
let handbrake = false;

function pairUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = location.port === '5173' ? '8080' : location.port;
  return `${proto}//${location.hostname}${port ? `:${port}` : ''}/pair`;
}

function setStatus(text: string, kind: 'ok' | 'warn' | 'bad'): void {
  statusText.textContent = text;
  statusDot.className = `dot ${kind}`;
}

// --- Sensors ---------------------------------------------------------------

function onOrientation(e: DeviceOrientationEvent): void {
  if (e.beta === null || e.gamma === null) return;
  haveSensor = true;
  raw = toScreenAngles(e.beta, e.gamma, screenAngle());
}

/**
 * Ask for sensor access. iOS requires this from a user gesture and returns a
 * promise; every other browser has no such call and just starts delivering.
 */
async function requestSensors(): Promise<boolean> {
  if (!window.isSecureContext) {
    setupMsg.textContent =
      'This page must be opened over https for motion sensors to work. Run `npm run certs` on the host laptop, restart the server, and reload this page over https.';
    return false;
  }

  type Requestable = { requestPermission?: () => Promise<PermissionState> };
  const req = (DeviceOrientationEvent as unknown as Requestable).requestPermission;
  if (typeof req === 'function') {
    try {
      const state = await req.call(DeviceOrientationEvent);
      if (state !== 'granted') {
        setupMsg.textContent = 'Motion access was denied. Reload and allow it to steer with the phone.';
        return false;
      }
    } catch {
      setupMsg.textContent = 'Could not request motion access on this device.';
      return false;
    }
  }

  window.addEventListener('deviceorientation', onOrientation);

  // Confirm something actually arrives. A silent sensor is the single most
  // likely failure here and it is indistinguishable from "holding it still".
  await new Promise((r) => setTimeout(r, 700));
  if (!haveSensor) {
    setupMsg.textContent =
      'No motion readings from this phone. Check that motion access is allowed in the browser settings.';
    return false;
  }
  return true;
}

function calibrate(): void {
  neutral = { ...raw };
  smooth = { pitch: 0, roll: 0 };
}

// --- Connection ------------------------------------------------------------

function connect(code: string): void {
  ws = new WebSocket(pairUrl());
  setStatus('connecting…', 'warn');

  ws.onopen = () => ws?.send(JSON.stringify({ t: 'phone', code }));

  ws.onmessage = (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg['t'] === 'paired') {
      paired = true;
      setStatus(`driving — ${String(msg['code'])}`, 'ok');
      setup.hidden = true;
      drive.hidden = false;
      calibrate();
      void keepAwake();
    } else if (msg['t'] === 'error') {
      paired = false;
      const text = String(msg['message'] ?? 'disconnected');
      setStatus(text, 'bad');
      setupMsg.textContent = text;
      setup.hidden = false;
      drive.hidden = true;
    }
  };

  ws.onclose = () => {
    paired = false;
    setStatus('disconnected', 'bad');
    setup.hidden = false;
    drive.hidden = true;
    setupMsg.textContent = 'Connection lost. Enter the code again.';
  };
}

/** Stop the screen sleeping mid-race, which stops the sensors with it. */
async function keepAwake(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<unknown> } };
    await nav.wakeLock?.request('screen');
  } catch {
    /* not supported, or refused; the player can raise their screen timeout */
  }
}

// --- Control loop ----------------------------------------------------------

function tick(): void {
  const dRoll = raw.roll - neutral.roll;
  const dPitch = (raw.pitch - neutral.pitch) * (invert ? -1 : 1);

  smooth.roll += (dRoll - smooth.roll) * SMOOTHING;
  smooth.pitch += (dPitch - smooth.pitch) * SMOOTHING;

  const steer = curve(smooth.roll, STEER_RANGE);
  // Forward tilt is throttle, backward is brake. Brake doubles as reverse once
  // the car has stopped, which is how vehicle/car.ts already works.
  const forward = -smooth.pitch;
  const throttle = forward > 0 ? curve(forward, THROTTLE_RANGE) : 0;
  const brake = forward < 0 ? curve(-forward, BRAKE_RANGE) : 0;

  if (paired && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'ctl', steer, throttle, brake, handbrake }));
  }

  steerFill.style.transform = `translateX(${(steer * 50).toFixed(1)}%)`;
  pedalFill.style.height = `${(Math.max(throttle, brake) * 100).toFixed(0)}%`;
  pedalFill.className = brake > 0 ? 'pedal-fill braking' : 'pedal-fill';
  readout.textContent =
    `steer ${steer >= 0 ? '+' : ''}${steer.toFixed(2)}   ` +
    `${brake > 0 ? `brake ${brake.toFixed(2)}` : `throttle ${throttle.toFixed(2)}`}`;
}

// --- Wiring ----------------------------------------------------------------

startBtn.addEventListener('click', () => {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length < 4) {
    setupMsg.textContent = 'Enter the four-character code shown on the laptop.';
    return;
  }
  setupMsg.textContent = 'Requesting motion access…';
  startBtn.disabled = true;
  void requestSensors().then((ok) => {
    startBtn.disabled = false;
    if (!ok) return;
    setupMsg.textContent = '';
    connect(code);
  });
});

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});

// Pointer events rather than click: a handbrake has to release when the thumb
// lifts, and it must keep working if the thumb slides off the button.
const pressHandbrake = (on: boolean) => () => {
  handbrake = on;
  handbrakeBtn.classList.toggle('on', on);
};
handbrakeBtn.addEventListener('pointerdown', pressHandbrake(true));
handbrakeBtn.addEventListener('pointerup', pressHandbrake(false));
handbrakeBtn.addEventListener('pointercancel', pressHandbrake(false));
handbrakeBtn.addEventListener('pointerleave', pressHandbrake(false));

flipBtn.addEventListener('click', () => {
  invert = !invert;
  flipBtn.textContent = invert ? 'Tilt: flipped' : 'Tilt: normal';
});

recalBtn.addEventListener('click', calibrate);

// Re-calibrating on rotation avoids the car lurching when a phone flips from
// landscape-left to landscape-right in someone's hands mid-race.
screen.orientation?.addEventListener('change', () => setTimeout(calibrate, 250));

// A code can be carried in the URL, so the laptop can show a QR that skips
// typing entirely.
const fromUrl = new URLSearchParams(location.search).get('code');
if (fromUrl) codeInput.value = fromUrl.toUpperCase().slice(0, 4);

if (!window.isSecureContext) {
  setupMsg.textContent =
    'Opened over http. Motion sensors need https — run `npm run certs` on the laptop and reload over https.';
}

setInterval(tick, 1000 / SEND_HZ);
