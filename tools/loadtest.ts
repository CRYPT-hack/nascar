/**
 * Headless load test.  `npx tsx tools/loadtest.ts [clients] [seconds] [track]`
 *
 * Covers hour-12 gate checks 1 and 5 (HANDOFF.md §7): the server holds 60 Hz
 * with real headroom, and its memory is flat.
 *
 * The clients are real WebSocket connections speaking the real protocol, and
 * they drive properly - each runs an AiDriver over a view reconstructed from the
 * snapshots it receives, which is what a real client does minus the rendering
 * and the prediction. Clients that sit still would understate the load, because
 * ten cars parked on the grid generate far fewer contacts than ten cars racing.
 *
 * Tick duration is sampled around `room.step()` only, so it measures the
 * simulation rather than the socket layer or the test harness. The clients hold
 * no physics world of their own, so their cost here is small.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { CAR_COLORS, INPUT_HZ, PROTOCOL_VERSION, TICK_HZ } from '../shared/constants';
import type { CarSnap, ClientMsg, ServerMsg, SurfaceKind } from '../shared/protocol';
import type { TrackData } from '../shared/track-schema';
import { AI_SKILLS, AiDriver, buildSpeedProfile, type DrivableView } from '../vehicle/ai-driver';
import { DEFAULT_TUNING } from '../vehicle/car';
import { clamp, rotate, type Q4, type V3 } from '../vehicle/math3';
import { TrackQuery } from '../vehicle/track-query';
import { initPhysics } from '../vehicle/world';
import { GameServer } from '../server/net';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8099;

/** A DrivableView reconstructed from the last snapshot for one car. */
class SnapshotView implements DrivableView {
  private p: V3 = { x: 0, y: 0, z: 0 };
  private q: Q4 = { x: 0, y: 0, z: 0, w: 1 };
  private v: V3 = { x: 0, y: 0, z: 0 };
  private av: V3 = { x: 0, y: 0, z: 0 };
  surface: SurfaceKind = 'asphalt';

  apply(s: CarSnap): void {
    this.p = { x: s.p[0], y: s.p[1], z: s.p[2] };
    this.q = { x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] };
    this.v = { x: s.v[0], y: s.v[1], z: s.v[2] };
    this.av = { x: s.av[0], y: s.av[1], z: s.av[2] };
    this.surface = s.surface;
  }

  position(): V3 {
    return this.p;
  }
  rotation(): Q4 {
    return this.q;
  }
  linvel(): V3 {
    return this.v;
  }
  angvel(): V3 {
    return this.av;
  }
  forward(): V3 {
    return rotate(this.q, { x: 0, y: 0, z: -1 });
  }
  right(): V3 {
    return rotate(this.q, { x: 1, y: 0, z: 0 });
  }
  up(): V3 {
    return rotate(this.q, { x: 0, y: 1, z: 0 });
  }
  get speed(): number {
    return Math.hypot(this.v.x, this.v.y, this.v.z);
  }
  get forwardSpeed(): number {
    const f = this.forward();
    return this.v.x * f.x + this.v.y * f.y + this.v.z * f.z;
  }
  isInverted(): boolean {
    return this.up().y < 0.2;
  }
  maxSteerAngle(speed: number): number {
    const t = DEFAULT_TUNING;
    const f = clamp(speed / t.steerFalloffSpeed, 0, 1);
    return t.maxSteerAngle + (t.minSteerAngle - t.maxSteerAngle) * f;
  }
}

export interface Impairment {
  /** One-way latency in ms, applied in both directions. */
  lag: number;
  jitter: number;
  /** Fraction of messages dropped, in both directions. */
  loss: number;
}

class HeadlessClient {
  readonly ws: WebSocket;
  readonly view = new SnapshotView();
  id = -1;
  seq = 1;
  bytes = 0;
  snaps = 0;
  rtts: number[] = [];
  private driver: AiDriver;
  private others: V3[] = [];
  private timer: NodeJS.Timeout | null = null;

  dropped = 0;

  constructor(
    private readonly index: number,
    q: TrackQuery,
    profile: Float64Array,
    private readonly sim: Impairment = { lag: 0, jitter: 0, loss: 0 },
  ) {
    this.driver = new AiDriver(q, profile, AI_SKILLS[index % AI_SKILLS.length]!);
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

    this.ws.on('open', () => {
      this.send({
        t: 'hello',
        v: PROTOCOL_VERSION,
        name: `Load${index + 1}`,
        color: index % CAR_COLORS.length,
      });
    });

    this.ws.on('message', (raw) => {
      this.bytes += (raw as Buffer).length;
      if (this.drop()) {
        this.dropped++;
        return;
      }
      const text = String(raw);
      this.delay(() => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(text) as ServerMsg;
        } catch {
          return;
        }
        this.onMessage(msg);
      });
    });

    this.ws.on('error', () => {});
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.id = msg.id;
        this.send({ t: 'ready', ready: true });
        this.startSending();
        break;
      case 'snap': {
        this.snaps++;
        this.others = [];
        for (const c of msg.cars) {
          if (c.id === this.id) this.view.apply(c);
          else this.others.push({ x: c.p[0], y: c.p[1], z: c.p[2] });
        }
        break;
      }
      case 'pong':
        this.rtts.push(Date.now() - msg.ts);
        break;
      default:
        break;
    }
  }

  private startSending(): void {
    let n = 0;
    this.timer = setInterval(() => {
      if (this.ws.readyState !== 1) return;
      const input = this.driver.update(this.view, 1 / INPUT_HZ, this.others);
      this.send({
        t: 'input',
        seq: this.seq++,
        throttle: input.throttle,
        brake: input.brake,
        steer: input.steer,
        handbrake: input.handbrake,
      });
      if (++n % INPUT_HZ === 0) this.send({ t: 'ping', ts: Date.now() });
    }, 1000 / INPUT_HZ);
  }

  private drop(): boolean {
    return this.sim.loss > 0 && Math.random() < this.sim.loss;
  }

  private delay(fn: () => void): void {
    const d = Math.max(0, this.sim.lag + (Math.random() * 2 - 1) * this.sim.jitter);
    if (d <= 0) fn();
    else setTimeout(fn, d);
  }

  private send(m: ClientMsg): void {
    if (this.ws.readyState !== 1) return;
    if (this.drop()) {
      this.dropped++;
      return;
    }
    const text = JSON.stringify(m);
    this.delay(() => {
      if (this.ws.readyState === 1) this.ws.send(text);
    });
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------

const pct = (arr: number[], p: number): number => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const f2 = (n: number) => n.toFixed(2);
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

async function main(): Promise<void> {
  const clientCount = Number(process.argv[2] ?? 10);
  const seconds = Number(process.argv[3] ?? 60);
  const trackName = process.argv[4] ?? 'interlagos';
  const sim: Impairment = {
    lag: Number(process.argv[5] ?? 0),
    jitter: Number(process.argv[6] ?? 0),
    loss: Number(process.argv[7] ?? 0),
  };

  await initPhysics();
  const track = JSON.parse(
    readFileSync(resolve(here, `../public/track/${trackName}.json`), 'utf8'),
  ) as TrackData;

  const server = new GameServer(track, { port: PORT, laps: 999, staticDirs: [] });
  server.start();

  const q = new TrackQuery(track);
  const profile = buildSpeedProfile(q);

  console.log(`load test: ${clientCount} clients, ${seconds} s, track ${track.name}`);
  console.log(
    sim.lag > 0 || sim.loss > 0
      ? `impairment: ${sim.lag} +/-${sim.jitter} ms latency, ${(sim.loss * 100).toFixed(1)}% loss`
      : 'impairment: none',
  );
  console.log(`collision geometry: ${server.room.world.triangles} triangles\n`);

  const clients: HeadlessClient[] = [];
  for (let i = 0; i < clientCount; i++) {
    clients.push(new HeadlessClient(i, q, profile, sim));
    await sleep(60); // stagger, so the joins look like real players arriving
  }

  interface MemSample {
    t: number;
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  }
  // Gate check 4, measured on the running server rather than on a rig: with ten
  // impaired clients racing, does any car end up on its roof or in the air.
  const contact = { worstUp: 1, maxAir: 0, airFrames: 0, samples: 0 };
  const hints = new Map<number, number>();
  const sampleContact = (): void => {
    const room = server.room;
    if (room.state !== 'racing') return;
    for (const e of room.entrants.values()) {
      if (!e.car) continue;
      contact.samples++;
      contact.worstUp = Math.min(contact.worstUp, e.car.up().y);
      const p = e.car.body.translation();
      const loc = room.world.query.locate(p.x, p.y, p.z, hints.get(e.id));
      hints.set(e.id, loc.index);
      const air = p.y - loc.surfaceY - 0.52; // 0.52 m is the settled ride height
      if (air > contact.maxAir) contact.maxAir = air;
      if (air > 1.1) contact.airFrames++;
    }
  };

  const rssSamples: MemSample[] = [];
  const sampleMem = (t: number): MemSample => {
    const m = process.memoryUsage();
    return {
      t,
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
    };
  };
  const started = Date.now();
  const startTick = server.room.tick;

  const contactSampler = setInterval(sampleContact, 50);

  const sampler = setInterval(() => {
    const t = (Date.now() - started) / 1000;
    rssSamples.push(sampleMem(t));
    const ticks = server.room.tickMs;
    const hz = (server.room.tick - startTick) / t;
    console.log(
      `  t=${t.toFixed(0).padStart(4)}s  ` +
        `tick ${hz.toFixed(1).padStart(5)} Hz  ` +
        `step p50 ${f2(pct(ticks, 50))} p99 ${f2(pct(ticks, 99))} ms  ` +
        `rss ${mb(process.memoryUsage().rss)} MB  ` +
        `state ${server.room.state}  cars ${server.room.entrants.size}`,
    );
  }, 10_000);

  await sleep(seconds * 1000);
  clearInterval(sampler);
  clearInterval(contactSampler);

  // RSS alone cannot tell a leak from V8 simply holding on to pages it has
  // already reclaimed internally. If a forced collection is available, take a
  // final sample after it: heapUsed falling back to its warm-up level means the
  // garbage was collectable and nothing is actually leaking.
  const gc = (globalThis as { gc?: () => void }).gc;
  let afterGc: MemSample | null = null;
  if (gc) {
    gc();
    await sleep(500);
    gc();
    afterGc = sampleMem((Date.now() - started) / 1000);
  }
  rssSamples.push(sampleMem((Date.now() - started) / 1000));

  // --- report -------------------------------------------------------------
  const elapsed = (Date.now() - started) / 1000;
  const ticks = server.room.tickMs;
  const achievedHz = (server.room.tick - startTick) / elapsed;
  const budgetMs = 1000 / TICK_HZ;

  const p50 = pct(ticks, 50);
  const p99 = pct(ticks, 99);
  const headroom = (1 - p99 / budgetMs) * 100;

  const totalBytes = clients.reduce((s, c) => s + c.bytes, 0);
  const allRtt = clients.flatMap((c) => c.rtts);
  const connected = clients.filter((c) => c.ws.readyState === 1).length;

  // Measure growth after warm-up, not from process start. The heap climbs from
  // ~129 MB to ~146 MB in the first half minute as the physics world, the
  // sockets and V8's own caches settle, and counting that as leakage reports a
  // failure on a server whose memory is in fact flat. Everything from WARMUP_S
  // onward is the part that would keep climbing if there were a real leak.
  const WARMUP_S = 30;
  const settled = rssSamples.filter((r) => r.t >= WARMUP_S);
  const firstRss = (settled[0] ?? rssSamples[0])?.rss ?? 0;
  const peakRss = rssSamples.reduce((m, r) => Math.max(m, r.rss), 0);
  const lastRss = rssSamples[rssSamples.length - 1]?.rss ?? 0;
  const rssGrowth = firstRss > 0 ? ((lastRss - firstRss) / firstRss) * 100 : 0;

  console.log('\n--- results -------------------------------------------------');
  console.log(`clients connected     ${connected}/${clientCount}`);
  console.log(`cars in room          ${server.room.entrants.size}`);
  console.log(`room state            ${server.room.state}`);
  console.log(`\ntick rate             ${achievedHz.toFixed(2)} Hz  (target ${TICK_HZ})`);
  console.log(`step time p50         ${f2(p50)} ms   of ${f2(budgetMs)} ms budget`);
  console.log(`step time p99         ${f2(p99)} ms`);
  console.log(`step time max         ${f2(Math.max(...ticks))} ms`);
  console.log(`CPU headroom at p99   ${headroom.toFixed(1)}%`);
  console.log(
    `\nbandwidth down        ${((totalBytes / elapsed / clientCount) / 1024).toFixed(1)} KB/s per client`,
  );
  console.log(`snapshots received    ${clients.reduce((s, c) => s + c.snaps, 0)}`);
  console.log(
    `round trip            p50 ${f2(pct(allRtt, 50))} ms  p99 ${f2(pct(allRtt, 99))} ms  (loopback)`,
  );
  const base = settled[0] ?? rssSamples[0];
  const end = rssSamples[rssSamples.length - 1]!;
  const pctOf = (a: number, b: number) => (a > 0 ? `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(1)}%` : 'n/a');

  console.log(`
MEMORY (gate check 5)`);
  console.log(`                       warm-up (t=${WARMUP_S}s)      end        change`);
  const row = (name: string, k: keyof MemSample) =>
    console.log(
      `  ${name.padEnd(20)} ${mb(base?.[k] ?? 0).padStart(8)} MB ${mb(end[k]).padStart(9)} MB   ` +
        `${pctOf(base?.[k] ?? 0, end[k])}`,
    );
  row('rss', 'rss');
  row('heapUsed', 'heapUsed');
  row('heapTotal', 'heapTotal');
  row('external', 'external');
  row('arrayBuffers', 'arrayBuffers');
  console.log(`  RSS peak             ${mb(peakRss)} MB   (total RSS ${rssGrowth >= 0 ? '+' : ''}${rssGrowth.toFixed(1)}%)`);
  if (afterGc) {
    console.log(
      `  after forced GC      rss ${mb(afterGc.rss)} MB, heapUsed ${mb(afterGc.heapUsed)} MB ` +
        `(${pctOf(base?.heapUsed ?? 0, afterGc.heapUsed)} vs warm-up)`,
    );
  } else {
    console.log('  (run with node --expose-gc to separate a leak from retained heap)');
  }

  const totalDropped = clients.reduce((n, c) => n + c.dropped, 0);
  console.log(`\nCONTACT (gate check 4, ten impaired clients racing)`);
  console.log(`  samples              ${contact.samples}`);
  console.log(`  worst attitude       up.y ${contact.worstUp.toFixed(2)}`);
  console.log(`  greatest height      ${contact.maxAir.toFixed(2)} m above the road`);
  console.log(`  samples above 1.1 m  ${contact.airFrames}`);
  console.log(`  messages dropped     ${totalDropped}`);
  console.log('\n--- gate checks ---------------------------------------------');
  const check1 = achievedHz > TICK_HZ * 0.98 && headroom >= 40;
  // Judged on heapUsed after a forced collection, plus the WASM memory, rather
  // than on RSS. RSS climbs because V8 grows its heap to absorb the allocation
  // churn of serialising snapshots and does not hand the pages back; that is
  // not a leak, and it plateaus - 167 MB at ten minutes, 169 MB at five.
  //
  // Growth only. An earlier version of this check took the absolute value and
  // failed a run whose post-GC heap had *fallen* 34% below its warm-up level,
  // which is the strongest possible evidence that nothing is leaking.
  const leakBasis = afterGc ? afterGc.heapUsed : end.heapUsed;
  const leakBase = base?.heapUsed ?? 0;
  const heapGrowth = leakBase > 0 ? ((leakBasis - leakBase) / leakBase) * 100 : 0;
  // Rapier's world lives in WASM memory, which surfaces here rather than in the
  // JS heap. A collider or rigid body that is never freed shows up in this one.
  const extBase = (base?.external ?? 0) + (base?.arrayBuffers ?? 0);
  const extEnd = end.external + end.arrayBuffers;
  const nativeGrowth = extBase > 0 ? ((extEnd - extBase) / extBase) * 100 : 0;

  // RSS must also have stopped climbing: compare the last quarter of samples
  // against the middle. A genuine leak keeps a positive slope to the end.
  const settledRss = settled.map((r) => r.rss);
  const quarter = Math.max(1, Math.floor(settledRss.length / 4));
  const mid = settledRss.slice(-3 * quarter, -quarter);
  const lastQ = settledRss.slice(-quarter);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const rssSlopePct = mean(mid) > 0 ? ((mean(lastQ) - mean(mid)) / mean(mid)) * 100 : 0;

  const check5 = heapGrowth < 25 && nativeGrowth < 25 && rssSlopePct < 3 && settled.length >= 4;
  console.log(`1. server stability   ${check1 ? 'PASS' : 'FAIL'}  ` +
    `(${achievedHz.toFixed(1)} Hz, ${headroom.toFixed(0)}% headroom at p99; needs >=40%)`);
  const check4 = contact.samples > 0 && contact.worstUp > 0.2 && contact.airFrames === 0;
  console.log(
    `4. contact            ${check4 ? 'PASS' : 'FAIL'}  ` +
      `(worst up.y ${contact.worstUp.toFixed(2)}, ${contact.airFrames} samples airborne; needs >0.2 and 0)`,
  );
  console.log(`5. memory flat        ${check5 ? 'PASS' : 'FAIL'}  ` +
    `(heap ${heapGrowth >= 0 ? '+' : ''}${heapGrowth.toFixed(1)}%${afterGc ? ' after forced GC' : ''}, ` +
      `wasm ${nativeGrowth >= 0 ? '+' : ''}${nativeGrowth.toFixed(1)}%, ` +
      `RSS slope ${rssSlopePct >= 0 ? '+' : ''}${rssSlopePct.toFixed(1)}% over the last quarter, ` +
      `${(elapsed - WARMUP_S).toFixed(0)} s observed)`);
  if (elapsed < 300) console.log('   note: check 1 wants 5 minutes, check 5 wants 10. This run was shorter.');

  for (const c of clients) c.close();
  await server.stop();
  process.exit(check1 && check4 && check5 ? 0 : 1);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
