/**
 * Stand-in for a phone controller.  `npx tsx tools/phonetest.ts <CODE> [pattern]`
 *
 * Connects to the pairing relay exactly as controller.html does and sends the
 * same control frames, so the whole path — relay, laptop link, input pipeline,
 * prediction, server — can be exercised without a phone in your hand.
 *
 * Two reasons this exists rather than "just test it on a phone":
 *
 *   - Motion sensors need https, so testing the phone page properly needs the
 *     certs generated and a real device on the LAN. This needs neither, which
 *     makes it the thing to reach for when the question is "is the plumbing
 *     connected" rather than "does the tilt feel right".
 *   - Two browser tabs on one machine cannot both be foreground, and a
 *     backgrounded tab has its timers throttled to about 1 Hz. That is below
 *     the staleness threshold in phone-link.ts, so the laptop correctly decides
 *     the phone is gone. A node process has no such throttling.
 *
 * Patterns:
 *   throttle   full throttle, straight        (default)
 *   weave      full throttle, steering sweep
 *   brake      brake held; becomes reverse once stopped
 *   idle       neutral, to confirm the link without moving
 *
 * Every frame carries a sequence number that the laptop echoes back, so this
 * also reports the round trip phone -> relay -> laptop -> relay -> phone. That
 * is the controllable part of the delay between tilting a phone and the car
 * responding; the rest is the game's own input and simulation cadence.
 */

import { WebSocket } from 'ws';

import { DEFAULT_PORT } from '../shared/constants';

const code = (process.argv[2] ?? '').toUpperCase();
const pattern = process.argv[3] ?? 'throttle';
const host = process.env['HOST'] ?? 'localhost';
const port = process.env['PORT'] ?? String(DEFAULT_PORT);

if (!code) {
  console.error('usage: npx tsx tools/phonetest.ts <CODE> [throttle|weave|brake|idle]');
  console.error('the code is shown on the laptop lobby screen');
  process.exit(1);
}

// The server speaks TLS when certs/ exists, so follow it. The certificate is
// self-signed, which is fine for a test client on the same LAN.
const secure = process.env['SECURE'] === '1';
const url = `${secure ? 'wss' : 'ws'}://${host}:${port}/pair`;
const ws = new WebSocket(url, secure ? { rejectUnauthorized: false } : undefined);
const started = Date.now();

/** Matches the controller's send rate. */
const SEND_HZ = 40;

function frame(t: number): { steer: number; throttle: number; brake: number; handbrake: boolean } {
  switch (pattern) {
    case 'weave':
      return { steer: Math.sin(t * 0.6) * 0.5, throttle: 1, brake: 0, handbrake: false };
    case 'brake':
      return { steer: 0, throttle: 0, brake: 1, handbrake: false };
    case 'idle':
      return { steer: 0, throttle: 0, brake: 0, handbrake: false };
    default:
      return { steer: 0, throttle: 1, brake: 0, handbrake: false };
  }
}

ws.on('open', () => {
  console.log(`connected to ${url}, pairing with ${code}`);
  ws.send(JSON.stringify({ t: 'phone', code }));
});

/** Send time of each outstanding frame, by sequence number. */
const sent = new Map<number, number>();
const rtt: number[] = [];
let seq = 0;

function report(): void {
  if (rtt.length === 0) {
    console.log('round trip: no acks yet');
    return;
  }
  const s = [...rtt].sort((a, b) => a - b);
  const at = (p: number): string => s[Math.min(s.length - 1, Math.floor(s.length * p))]!.toFixed(1);
  const mean = (s.reduce((a, b) => a + b, 0) / s.length).toFixed(1);
  console.log(
    `round trip over ${s.length} frames: mean ${mean} ms, median ${at(0.5)} ms, ` +
      `p95 ${at(0.95)} ms, max ${s[s.length - 1]!.toFixed(1)} ms`,
  );
  rtt.length = 0;
}

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw)) as Record<string, unknown>;
  if (msg['t'] === 'paired') {
    console.log(`paired. sending "${pattern}" at ${SEND_HZ} Hz — ctrl-c to stop`);
    const timer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return clearInterval(timer);
      const t = (Date.now() - started) / 1000;
      const s = seq++;
      sent.set(s, performance.now());
      ws.send(JSON.stringify({ t: 'ctl', ...frame(t), s }));
    }, 1000 / SEND_HZ);
    setInterval(report, 5000).unref?.();
  } else if (msg['t'] === 'ack') {
    const at = sent.get(msg['s'] as number);
    if (at !== undefined) {
      rtt.push(performance.now() - at);
      sent.delete(msg['s'] as number);
    }
  } else if (msg['t'] === 'error') {
    console.error(`relay: ${String(msg['message'])}`);
    process.exit(1);
  }
});

ws.on('error', (e) => {
  console.error(`cannot reach ${url}: ${e.message}`);
  process.exit(1);
});

ws.on('close', () => {
  console.log('relay closed the connection');
  process.exit(0);
});
