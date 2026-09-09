/**
 * Phone-as-steering-wheel pairing relay.
 *
 * A player holds their phone like a wheel; the laptop drives the car. This is
 * the switchboard that connects the two.
 *
 * It deliberately lives on its own WebSocket path (`/pair`) with its own tiny
 * message set, NOT on the game protocol. `shared/protocol.ts` is frozen
 * (HANDOFF.md §3) and none of this needs to reach the simulation: the phone is
 * an input device, so its output joins the laptop's existing input pipeline and
 * flows to the server as ordinary `input` messages with ordinary sequence
 * numbers. Prediction and reconciliation never learn that a phone is involved.
 *
 * Why not Bluetooth: Web Bluetooth can only drive BLE *peripherals* over GATT,
 * and a phone browser cannot be a peripheral — there is no web API for it, and
 * phones do not expose motion sensors as a GATT service. It would need a native
 * app on every player's phone. Wi-Fi needs nothing installed, and the venue is
 * already running a LAN for the game itself (§9).
 */

import type { WebSocket } from 'ws';

/**
 * Pairing code alphabet. No O/0, I/1/L — a code is read off a laptop screen and
 * typed on a phone, usually by someone standing at an angle in bad lighting.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

/** A host with no phone and no traffic is dropped after this long. */
const HOST_IDLE_MS = 30 * 60_000;

/** Control frames above this rate are dropped. 30 Hz is the input rate. */
const MAX_CONTROL_HZ = 90;

/**
 * Largest driver photo the relay will carry, as a base64 data URL.
 *
 * The phone downscales to 160 px before sending, which lands near 8 KB; this is
 * generous enough for a bad camera and small enough that it cannot be used to
 * push a laptop over on the venue network.
 */
const MAX_PHOTO_CHARS = 96 * 1024;

export interface ControlFrame {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
}

interface Pair {
  code: string;
  host: WebSocket;
  phone: WebSocket | null;
  createdAt: number;
  lastControlAt: number;
  controlCount: number;
  windowStart: number;
}

function clamp(n: unknown, lo: number, hi: number): number {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return x < lo ? lo : x > hi ? hi : x;
}

function send(ws: WebSocket, msg: unknown): void {
  // readyState 1 is OPEN. Guarded because a phone that walks out of range
  // leaves a socket that looks fine until the next write throws.
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* the close handler will clean up */
    }
  }
}

export class RemoteControlHub {
  private readonly pairs = new Map<string, Pair>();
  /** Reverse index so a socket close can find its pair without a scan. */
  private readonly bySocket = new Map<WebSocket, Pair>();
  private sweep: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.sweep ??= setInterval(() => this.dropIdle(), 60_000);
    // Never hold the process open for a housekeeping timer.
    this.sweep.unref?.();
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const p of this.pairs.values()) {
      p.host.close();
      p.phone?.close();
    }
    this.pairs.clear();
    this.bySocket.clear();
  }

  get pairCount(): number {
    return this.pairs.size;
  }

  /** Called by GameServer for every upgrade on the `/pair` path. */
  accept(ws: WebSocket): void {
    ws.on('message', (raw) => this.onMessage(ws, raw));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => this.onClose(ws));
  }

  private onMessage(ws: WebSocket, raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['t']) {
      case 'host':
        this.openHost(ws);
        break;
      case 'phone':
        this.joinPhone(ws, String(msg['code'] ?? '').toUpperCase());
        break;
      case 'ctl':
        this.relayControl(ws, msg);
        break;
      case 'photo':
        // One-shot, lobby-time, and far larger than a control frame — so it is
        // its own message rather than a field on one.
        this.relayPhoto(ws, msg);
        break;
      case 'ack':
        // Latency probe coming back the other way: the laptop echoes the phone's
        // own sequence and timestamp, so the phone can measure round trip
        // against its own clock and never has to trust the laptop's.
        this.relayAck(ws, msg);
        break;
      default:
        break;
    }
  }

  private openHost(ws: WebSocket): void {
    // A reconnecting laptop must not accumulate codes.
    const existing = this.bySocket.get(ws);
    if (existing) {
      send(ws, { t: 'code', code: existing.code });
      return;
    }

    const code = this.freshCode();
    if (code === null) {
      send(ws, { t: 'error', message: 'no pairing codes free' });
      return;
    }

    const now = Date.now();
    const pair: Pair = {
      code,
      host: ws,
      phone: null,
      createdAt: now,
      lastControlAt: now,
      controlCount: 0,
      windowStart: now,
    };
    this.pairs.set(code, pair);
    this.bySocket.set(ws, pair);
    send(ws, { t: 'code', code });
  }

  private joinPhone(ws: WebSocket, code: string): void {
    const pair = this.pairs.get(code);
    if (!pair) {
      send(ws, { t: 'error', message: 'No laptop is waiting on that code.' });
      return;
    }
    if (pair.phone && pair.phone !== ws && pair.phone.readyState === 1) {
      // Last phone in wins. At a venue the usual cause is the same player
      // reloading, and refusing them locks them out of their own car.
      send(pair.phone, { t: 'error', message: 'Another phone took over this car.' });
      this.bySocket.delete(pair.phone);
      pair.phone.close();
    }

    pair.phone = ws;
    this.bySocket.set(ws, pair);
    send(ws, { t: 'paired', code });
    send(pair.host, { t: 'phone', connected: true });
  }

  private relayControl(ws: WebSocket, msg: Record<string, unknown>): void {
    const pair = this.bySocket.get(ws);
    if (!pair || pair.phone !== ws) return;

    const now = Date.now();
    if (now - pair.windowStart >= 1000) {
      pair.windowStart = now;
      pair.controlCount = 0;
    }
    if (++pair.controlCount > MAX_CONTROL_HZ) return;
    pair.lastControlAt = now;

    const frame: ControlFrame = {
      steer: clamp(msg['steer'], -1, 1),
      throttle: clamp(msg['throttle'], 0, 1),
      brake: clamp(msg['brake'], 0, 1),
      handbrake: msg['handbrake'] === true,
    };
    // `s` rides along untouched so the laptop can echo it back for timing.
    send(pair.host, { t: 'ctl', ...frame, s: msg['s'] });
  }

  private relayPhoto(ws: WebSocket, msg: Record<string, unknown>): void {
    const pair = this.bySocket.get(ws);
    if (!pair || pair.phone !== ws) return;
    const data = msg['data'];
    if (typeof data !== 'string' || data.length > MAX_PHOTO_CHARS) return;
    if (!data.startsWith('data:image/jpeg;base64,')) return;
    send(pair.host, { t: 'photo', data });
  }

  private relayAck(ws: WebSocket, msg: Record<string, unknown>): void {
    const pair = this.bySocket.get(ws);
    if (!pair || pair.host !== ws || !pair.phone) return;
    send(pair.phone, { t: 'ack', s: msg['s'] });
  }

  private onClose(ws: WebSocket): void {
    const pair = this.bySocket.get(ws);
    if (!pair) return;
    this.bySocket.delete(ws);

    if (pair.host === ws) {
      // The laptop is gone; the pairing means nothing without it.
      if (pair.phone) {
        send(pair.phone, { t: 'error', message: 'The laptop disconnected.' });
        this.bySocket.delete(pair.phone);
        pair.phone.close();
      }
      this.pairs.delete(pair.code);
      return;
    }

    if (pair.phone === ws) {
      pair.phone = null;
      // Tell the laptop so it can fall back to the keyboard rather than
      // holding the last steering angle into a wall.
      send(pair.host, { t: 'phone', connected: false });
    }
  }

  private freshCode(): string | null {
    for (let attempt = 0; attempt < 200; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      }
      if (!this.pairs.has(code)) return code;
    }
    return null;
  }

  private dropIdle(): void {
    const now = Date.now();
    for (const [code, p] of this.pairs) {
      if (p.phone === null && now - p.createdAt > HOST_IDLE_MS) {
        this.bySocket.delete(p.host);
        p.host.close();
        this.pairs.delete(code);
      }
    }
  }
}
