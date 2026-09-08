/**
 * Laptop half of the phone-as-steering-wheel link.
 *
 * Connects to the pairing relay, holds a short code for the player to type on
 * their phone, and exposes the latest control frame. It produces a `CarInput`
 * and nothing else: `InputSource` treats it exactly like a gamepad, so the
 * phone joins the existing input pipeline and everything downstream —
 * sequence numbers, prediction, reconciliation — is unchanged and unaware.
 *
 * Deliberately not on the game socket. `shared/protocol.ts` is frozen, and a
 * phone is a peripheral, not a peer.
 */

import type { CarInput } from '../../shared/protocol';

/**
 * A frame older than this is ignored and the keyboard takes back over.
 *
 * The failure this prevents is specific: a phone that goes out of range, locks
 * its screen or has its browser backgrounded stops sending, and without this
 * the car holds the last steering angle and drives into a wall on its own.
 */
const STALE_MS = 400;

/** Reconnect backoff bounds, milliseconds. */
const RETRY_MIN = 500;
const RETRY_MAX = 5000;

export type PhoneLinkStatus = 'connecting' | 'waiting' | 'paired' | 'offline';

export class PhoneLink {
  /** Pairing code to show the player, or null before the relay assigns one. */
  code: string | null = null;
  status: PhoneLinkStatus = 'connecting';
  /** Called whenever `code` or `status` changes, so the UI can repaint. */
  onChange: (() => void) | null = null;
  /** Called once when the player takes their race photo, with a JPEG data URL. */
  onPhoto: ((dataUrl: string) => void) | null = null;

  private ws: WebSocket | null = null;
  private frame: CarInput | null = null;
  private frameAt = 0;
  private retry = RETRY_MIN;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly url = defaultPairUrl()) {
    this.open();
  }

  /**
   * Latest control frame, or null when there is no live phone. Null means "not
   * driving": the caller falls back to the keyboard rather than coasting.
   */
  current(): CarInput | null {
    if (!this.frame) return null;
    if (performance.now() - this.frameAt > STALE_MS) return null;
    return this.frame;
  }

  get connected(): boolean {
    return this.status === 'paired' && this.current() !== null;
  }

  dispose(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }

  private set(status: PhoneLinkStatus, code: string | null = this.code): void {
    if (status === this.status && code === this.code) return;
    this.status = status;
    this.code = code;
    this.onChange?.();
  }

  private open(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = RETRY_MIN;
      ws.send(JSON.stringify({ t: 'host' }));
      this.set('waiting', null);
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg['t']) {
        case 'code':
          this.set('waiting', String(msg['code']));
          break;
        case 'phone':
          if (msg['connected'] === true) {
            this.set('paired');
          } else {
            this.frame = null;
            this.set('waiting');
          }
          break;
        case 'photo':
          if (typeof msg['data'] === 'string') this.onPhoto?.(msg['data']);
          break;
        case 'ctl':
          // Echo the sequence straight back so the phone can time the round
          // trip. Done before anything else in this branch: the point is to
          // measure the link, not the work that follows it.
          if (msg['s'] !== undefined && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: 'ack', s: msg['s'] }));
          }
          this.frame = {
            throttle: num(msg['throttle']),
            brake: num(msg['brake']),
            steer: num(msg['steer']),
            handbrake: msg['handbrake'] === true,
          };
          this.frameAt = performance.now();
          if (this.status !== 'paired') this.set('paired');
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      this.frame = null;
      this.ws = null;
      this.set('offline', null);
      this.scheduleRetry();
    };

    // An error is always followed by a close; let that path do the work.
    ws.onerror = () => undefined;
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, this.retry);
    this.retry = Math.min(this.retry * 2, RETRY_MAX);
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * The relay lives on the game server, so the phone and the laptop reach it at
 * the same host and port the game is already served from — one address for the
 * host to read out at the venue (HANDOFF.md §9).
 */
export function defaultPairUrl(): string {
  if (typeof location === 'undefined') return 'ws://localhost:8080/pair';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = location.port === '5173' ? '8080' : location.port;
  return `${proto}//${location.hostname}${port ? `:${port}` : ''}/pair`;
}

/** Where the player should point their phone browser. */
export function controllerUrl(): string {
  if (typeof location === 'undefined') return '';
  const port = location.port === '5173' ? '8080' : location.port;
  return `${location.protocol}//${location.hostname}${port ? `:${port}` : ''}/controller.html`;
}
