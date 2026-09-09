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
/**
 * Upper bound on send rate. Frames go out on each sensor reading rather than on
 * a timer — a fixed 40 Hz timer added up to 25 ms of pure quantisation delay on
 * top of everything else — so this only exists to stop a fast sensor flooding
 * the relay, which drops anything above 90 Hz anyway.
 */
const MAX_SEND_HZ = 70;

/**
 * Keepalive rate when the phone is perfectly still.
 *
 * Some devices stop emitting orientation events when nothing moves. Without
 * this the laptop sees no frames, decides after 400 ms that the phone is gone,
 * and hands back to the keyboard mid-corner while the player is holding the
 * phone perfectly steady on a straight.
 */
const KEEPALIVE_MS = 60;

/**
 * One Euro filter tuning, in degrees.
 *
 * Fixed exponential smoothing forces a choice between jitter and lag: the old
 * 0.35-per-sample filter took 89 ms to reach 63% of a steering step and 138 ms
 * to reach 90%, measured, against 0.9 ms for the whole network round trip. The
 * filter was the latency.
 *
 * One Euro adapts instead: heavy smoothing while the phone is near still, which
 * is when hand tremor shows and nobody is asking the car to do anything, and a
 * cutoff that rises with movement speed, which is when the player wants the
 * front wheels to follow immediately.
 */
const MIN_CUTOFF = 1.5;
const BETA = 0.1;
const D_CUTOFF = 1.0;

interface Angles {
  pitch: number;
  roll: number;
}

/**
 * One Euro filter for a single axis.
 *
 * Standard formulation: low-pass the signal with a cutoff that rises with the
 * signal's own rate of change, so it is smooth when slow and quick when fast.
 */
class OneEuro {
  private x: number | null = null;
  private dx = 0;

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  filter(value: number, dt: number): number {
    if (this.x === null || !(dt > 0)) {
      this.x = value;
      return value;
    }
    const alphaFor = (cutoff: number): number => {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    };

    const rate = (value - this.x) / dt;
    this.dx += alphaFor(D_CUTOFF) * (rate - this.dx);

    const cutoff = MIN_CUTOFF + BETA * Math.abs(this.dx);
    const a = alphaFor(cutoff);
    this.x += a * (value - this.x);
    return this.x;
  }
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
const photoPanel = el('photo');
const cam = el<HTMLVideoElement>('cam');
const shotCanvas = el<HTMLCanvasElement>('shot-canvas');
const snapBtn = el<HTMLButtonElement>('snap');
const retakeBtn = el<HTMLButtonElement>('retake');
const usePhotoBtn = el<HTMLButtonElement>('usephoto');
const skipPhotoBtn = el<HTMLButtonElement>('skipphoto');
const photoMsg = el('photo-msg');
const flipBtn = el<HTMLButtonElement>('flip');
const recalBtn = el<HTMLButtonElement>('recal');

let ws: WebSocket | null = null;
let paired = false;

let haveSensor = false;
let raw: Angles = { pitch: 0, roll: 0 };
let neutral: Angles = { pitch: 0, roll: 0 };
let invert = false;
let handbrake = false;

const rollFilter = new OneEuro();
const pitchFilter = new OneEuro();
/** Timestamp of the last sensor reading, for the filter's dt. */
let lastSampleAt = 0;
let lastSentAt = 0;

/** Sequence number and outstanding send times, for the round-trip readout. */
let seq = 0;
const inFlight = new Map<number, number>();
const rttSamples: number[] = [];
let rttShown = 0;

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
  // Send on the reading rather than waiting for a timer. A sensor tick is the
  // only moment new information exists, so anything else is added delay.
  emit();
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
  rollFilter.reset();
  pitchFilter.reset();
}

// --- Race photo ------------------------------------------------------------

/**
 * Square edge of the photo sent to the laptop, pixels.
 *
 * It ends up on a small quad above a moving car, so anything larger is detail
 * nobody can see paid for on every other player's network. 160 px JPEG lands
 * near 8 KB.
 */
const PHOTO_SIZE = 160;
const PHOTO_QUALITY = 0.72;

let stream: MediaStream | null = null;
let captured: string | null = null;

/** Show the photo step and start the front camera. */
async function openPhotoStep(): Promise<void> {
  photoPanel.hidden = false;
  drive.hidden = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } },
      audio: false,
    });
    cam.srcObject = stream;
    await cam.play();
  } catch {
    // No camera, or permission refused. Racing without a photo is fine, so this
    // is a message and a skip rather than a dead end.
    photoMsg.textContent = 'No camera available. You can skip — your car just stays plain.';
    snapBtn.disabled = true;
  }
}

function closePhotoStep(): void {
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  cam.srcObject = null;
  photoPanel.hidden = true;
  drive.hidden = false;
}

/** Grab the current frame, centre-cropped square and downscaled. */
function capture(): void {
  const w = cam.videoWidth;
  const h = cam.videoHeight;
  if (!w || !h) {
    photoMsg.textContent = 'Camera is not ready yet.';
    return;
  }
  const side = Math.min(w, h);
  shotCanvas.width = PHOTO_SIZE;
  shotCanvas.height = PHOTO_SIZE;
  const ctx = shotCanvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(cam, (w - side) / 2, (h - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  captured = shotCanvas.toDataURL('image/jpeg', PHOTO_QUALITY);

  shotCanvas.hidden = false;
  cam.hidden = true;
  snapBtn.hidden = true;
  retakeBtn.hidden = false;
  usePhotoBtn.hidden = false;
  photoMsg.textContent = '';
}

function retake(): void {
  captured = null;
  shotCanvas.hidden = true;
  cam.hidden = false;
  snapBtn.hidden = false;
  retakeBtn.hidden = true;
  usePhotoBtn.hidden = true;
}

snapBtn.addEventListener('click', capture);
retakeBtn.addEventListener('click', retake);
skipPhotoBtn.addEventListener('click', closePhotoStep);
usePhotoBtn.addEventListener('click', () => {
  if (captured && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'photo', data: captured }));
  }
  closePhotoStep();
});

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
    if (msg['t'] === 'ack') {
      const at = inFlight.get(msg['s'] as number);
      if (at !== undefined) {
        rttSamples.push(performance.now() - at);
        inFlight.delete(msg['s'] as number);
      }
      return;
    }
    if (msg['t'] === 'paired') {
      paired = true;
      setStatus(`driving — ${String(msg['code'])}`, 'ok');
      setup.hidden = true;
      calibrate();
      void keepAwake();
      // The photo step comes first, in the lobby, before anyone is driving.
      void openPhotoStep();
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

/**
 * Filter the latest reading and send it.
 *
 * Called from the sensor event, and from a keepalive timer when the phone is
 * still enough that the sensor stops reporting.
 */
function emit(): void {
  const now = performance.now();
  if (now - lastSentAt < 1000 / MAX_SEND_HZ) return;

  const dt = lastSampleAt === 0 ? 1 / 60 : Math.min(0.25, (now - lastSampleAt) / 1000);
  lastSampleAt = now;
  lastSentAt = now;

  const dRoll = rollFilter.filter(raw.roll - neutral.roll, dt);
  const dPitch = pitchFilter.filter((raw.pitch - neutral.pitch) * (invert ? -1 : 1), dt);

  const steer = curve(dRoll, STEER_RANGE);
  // Forward tilt is throttle, backward is brake. Brake doubles as reverse once
  // the car has stopped, which is how vehicle/car.ts already works.
  const forward = -dPitch;
  const throttle = forward > 0 ? curve(forward, THROTTLE_RANGE) : 0;
  const brake = forward < 0 ? curve(-forward, BRAKE_RANGE) : 0;

  if (paired && ws?.readyState === WebSocket.OPEN) {
    const s = seq++;
    inFlight.set(s, now);
    // Bound the map if acks stop coming back, so a dead link cannot leak.
    if (inFlight.size > 256) inFlight.delete(inFlight.keys().next().value as number);
    ws.send(JSON.stringify({ t: 'ctl', steer, throttle, brake, handbrake, s }));
  }

  steerFill.style.transform = `translateX(${(steer * 50).toFixed(1)}%)`;
  pedalFill.style.height = `${(Math.max(throttle, brake) * 100).toFixed(0)}%`;
  pedalFill.className = brake > 0 ? 'pedal-fill braking' : 'pedal-fill';

  const lag = rttShown > 0 ? `   ${rttShown.toFixed(0)} ms` : '';
  readout.textContent =
    `steer ${steer >= 0 ? '+' : ''}${steer.toFixed(2)}   ` +
    `${brake > 0 ? `brake ${brake.toFixed(2)}` : `throttle ${throttle.toFixed(2)}`}${lag}`;
}

/** Median round trip over the recent window, shown so a bad link is visible. */
function updateRtt(): void {
  if (rttSamples.length === 0) return;
  const sorted = [...rttSamples].sort((a, b) => a - b);
  rttShown = sorted[Math.floor(sorted.length / 2)]!;
  rttSamples.length = 0;
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
// typing entirely. When present, auto-submit so the player just scans and goes.
const fromUrl = new URLSearchParams(location.search).get('code');
if (fromUrl) {
  codeInput.value = fromUrl.toUpperCase().slice(0, 4);
  // Defer slightly so the page has fully rendered before triggering sensors.
  setTimeout(() => startBtn.click(), 300);
}

if (!window.isSecureContext) {
  setupMsg.textContent =
    'Opened over http. Motion sensors need https — run `npm run certs` on the laptop and reload over https.';
}

// Keepalive: a phone lying perfectly still may stop emitting sensor events,
// and silence is indistinguishable from a phone that has left the network.
setInterval(emit, KEEPALIVE_MS);
setInterval(updateRtt, 1000);
