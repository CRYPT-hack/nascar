/**
 * WebSocket connection to the race server, with an optional network simulator.
 *
 * The simulator is not a debug toy: hour-12 gate check 3 requires remote cars to
 * stay smooth under 100 ms of latency and 2% packet loss, and on a LAN there is
 * no natural way to produce either. It is enabled from the query string, so the
 * check can be run against the real client in a real browser:
 *
 *   ?lag=100&jitter=20&loss=0.02
 *
 * Loss is applied in both directions. Dropping only inbound would be a much
 * kinder test than reality: a lost input is a tick the server fills by holding
 * the previous input, which is exactly the case reconciliation has to survive.
 */

import { PROTOCOL_VERSION } from '../../shared/constants';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';

export interface NetSim {
  /** One-way latency in ms, applied to each direction. */
  lag: number;
  /** Random extra latency, +/- this many ms. */
  jitter: number;
  /** Fraction of messages dropped, 0..1. */
  loss: number;
}

export const NO_SIM: NetSim = { lag: 0, jitter: 0, loss: 0 };

export function netSimFromQuery(search: string): NetSim {
  const q = new URLSearchParams(search);
  const n = (k: string, d: number) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return { lag: n('lag', 0), jitter: n('jitter', 0), loss: Math.min(1, n('loss', 0)) };
}

export interface ConnectionHandlers {
  onMessage(msg: ServerMsg): void;
  onOpen?(): void;
  onClose?(reason: string): void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private readonly handlers: ConnectionHandlers;
  readonly sim: NetSim;

  /** Round-trip time in ms, from the ping/pong pair. */
  rtt = 0;
  private rttSamples: number[] = [];

  /** Bytes received since the connection opened. */
  bytesIn = 0;
  /** Messages the simulator dropped, so the HUD can show the test is live. */
  dropped = 0;

  constructor(handlers: ConnectionHandlers, sim: NetSim = NO_SIM) {
    this.handlers = handlers;
    this.sim = sim;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(url: string, name: string, color: number): void {
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.send({ t: 'hello', v: PROTOCOL_VERSION, name, color });
      this.handlers.onOpen?.();
      this.startPinging();
    });

    ws.addEventListener('message', (ev) => {
      const text = String(ev.data);
      this.bytesIn += text.length;
      if (this.drop()) {
        this.dropped++;
        return;
      }
      let msg: ServerMsg;
      try {
        msg = JSON.parse(text) as ServerMsg;
      } catch {
        return;
      }
      this.afterDelay(() => this.receive(msg));
    });

    ws.addEventListener('close', () => this.handlers.onClose?.('closed'));
    ws.addEventListener('error', () => this.handlers.onClose?.('error'));
  }

  private receive(msg: ServerMsg): void {
    if (msg.t === 'pong') {
      const sample = Date.now() - msg.ts;
      this.rttSamples.push(sample);
      if (this.rttSamples.length > 20) this.rttSamples.shift();
      const sorted = [...this.rttSamples].sort((a, b) => a - b);
      this.rtt = sorted[Math.floor(sorted.length / 2)] ?? sample;
      return;
    }
    this.handlers.onMessage(msg);
  }

  send(msg: ClientMsg): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.drop()) {
      this.dropped++;
      return;
    }
    const text = JSON.stringify(msg);
    this.afterDelay(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  // -------------------------------------------------------------------------

  private drop(): boolean {
    return this.sim.loss > 0 && Math.random() < this.sim.loss;
  }

  private afterDelay(fn: () => void): void {
    const { lag, jitter } = this.sim;
    if (lag <= 0 && jitter <= 0) {
      fn();
      return;
    }
    const d = Math.max(0, lag + (Math.random() * 2 - 1) * jitter);
    setTimeout(fn, d);
  }

  private startPinging(): void {
    const tick = () => {
      if (!this.connected) return;
      this.send({ t: 'ping', ts: Date.now() });
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 500);
  }
}

/** Default server URL: same host as the page, on the game port. */
export function defaultServerUrl(): string {
  if (typeof location === 'undefined') return 'ws://localhost:8080';
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Served by the game server itself: same origin. Served by vite on 5173:
  // the game server is on 8080 of the same host.
  const port = location.port === '5173' ? '8080' : location.port;
  return `${proto}//${location.hostname}${port ? `:${port}` : ''}`;
}
