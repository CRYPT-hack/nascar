/**
 * Netcode measurement.  `npx tsx tools/netcheck.ts [lagMs] [jitterMs] [loss] [seconds]`
 *
 * Hour-12 gate checks 2 and 3 (HANDOFF.md §7) ask whether the local car feels
 * responsive and whether remote cars stay smooth under 100 ms latency and 2%
 * loss. "Looks fine to me" is not a grade, and it is especially not a grade on
 * a LAN where neither condition exists.
 *
 * This runs the real client modules - the same PredictedCar and RemoteCars the
 * browser uses - against the real server over a real socket, with latency and
 * loss imposed on that socket, and reports:
 *
 *   check 2  prediction error between what the client drew and what the server
 *            said, in metres. Small and stable means the local car is showing
 *            the player the truth without waiting for a round trip.
 *
 *   check 3  per-frame motion of remote cars sampled at 60 Hz. A teleport is a
 *            frame whose displacement is far out of line with its neighbours;
 *            that is precisely what §5.5 warns about and what the 100 ms
 *            interpolation buffer exists to prevent.
 *
 * The browser cannot be used for this: requestAnimationFrame is throttled when
 * the tab is not visible, so an automated browser session measures the harness
 * rather than the netcode.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { FIXED_DT, PROTOCOL_VERSION, TICK_HZ } from '../shared/constants';
import type { CarInput, ClientMsg, InputMsg, ServerMsg, SnapMsg } from '../shared/protocol';
import type { TrackData } from '../shared/track-schema';
import { AI_SKILLS, AiDriver, buildSpeedProfile } from '../vehicle/ai-driver';
import { yawOf, type V3 } from '../vehicle/math3';
import { createRaceWorld, initPhysics } from '../vehicle/world';
import { GameServer } from '../server/net';
import { INPUT_REDUNDANCY, PredictedCar } from '../client/src/prediction';
import { RemoteCars } from '../client/src/remote';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8098;

interface Sim {
  lag: number;
  jitter: number;
  loss: number;
}

/**
 * Per-remote-car motion samples, used for the smoothness verdict.
 *
 * Displacement per frame is the wrong quantity to threshold. This harness does
 * not render at a fixed rate - a long frame moves an interpolated car further
 * for entirely legitimate reasons, and the first version of this metric counted
 * 348 of those as teleports on a stream that was in fact perfectly smooth.
 *
 * What is measured instead is *implied speed*: displacement divided by the real
 * elapsed time, compared against the speed the server actually reports for that
 * car. A car interpolating correctly moves at its own speed no matter how the
 * frames fall. A car that jumps does not.
 */
class MotionTrack {
  private last: V3 | null = null;
  /** Implied speed each frame, m/s. */
  readonly speeds: number[] = [];
  /** Ratio of implied speed to the car's reported speed. */
  readonly ratios: number[] = [];
  maxRatio = 0;
  maxImplied = 0;

  sample(p: V3, dt: number, reportedSpeed: number): void {
    if (this.last && dt > 1e-4) {
      const d = Math.hypot(p.x - this.last.x, p.y - this.last.y, p.z - this.last.z);
      const implied = d / dt;
      this.speeds.push(implied);
      // Below walking pace the ratio is meaningless noise, so it is floored.
      const ref = Math.max(3, reportedSpeed);
      const ratio = implied / ref;
      this.ratios.push(ratio);
      if (ratio > this.maxRatio) this.maxRatio = ratio;
      if (implied > this.maxImplied) this.maxImplied = implied;
    }
    this.last = { x: p.x, y: p.y, z: p.z };
  }

  /**
   * Frames where the car appeared to move far faster than it actually was.
   * A jump on a late or lost packet shows up here; fast driving does not,
   * because the reference speed rises with it.
   */
  teleports(factor = 3): number {
    let n = 0;
    for (const r of this.ratios) if (r > factor) n++;
    return n;
  }

  medianSpeed(): number {
    if (this.speeds.length === 0) return 0;
    const s = [...this.speeds].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }
}

class SimClient {
  readonly prediction: PredictedCar;
  readonly remote: RemoteCars;
  private readonly ws: WebSocket;
  private readonly driver: AiDriver;
  private readonly sim: Sim;

  id = -1;
  state = 'lobby';
  private others: V3[] = [];
  private spawned = false;
  dropped = 0;

  /** Prediction error samples, metres. */
  readonly errors: number[] = [];
  readonly replays: number[] = [];
  readonly motion = new Map<number, MotionTrack>();
  readonly frameDts: number[] = [];
  readonly spikes: string[] = [];

  constructor(track: TrackData, sim: Sim, skillIndex = 0) {
    this.sim = sim;
    const rw = createRaceWorld(track);
    this.prediction = new PredictedCar(rw);
    this.remote = new RemoteCars(rw);
    this.driver = new AiDriver(rw.query, buildSpeedProfile(rw.query), AI_SKILLS[skillIndex]!);

    const spawn = track.spawnGrid[0]!;
    this.prediction.spawn({ x: spawn.p[0], y: spawn.p[1], z: spawn.p[2] }, spawn.rotY);

    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    this.ws.on('open', () => {
      this.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Netcheck', color: 0 });
    });
    this.ws.on('message', (raw) => {
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

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.id = msg.id;
        this.send({ t: 'ready', ready: true });
        break;
      case 'state':
        this.state = msg.state;
        if (msg.state === 'grid') this.spawned = false;
        break;
      case 'snap':
        this.onSnapshot(msg);
        break;
      default:
        break;
    }
  }

  private onSnapshot(msg: SnapMsg): void {
    this.remote.push(msg, performance.now());
    this.others = msg.cars.filter((c) => c.id !== this.id).map((c) => ({ x: c.p[0], y: c.p[1], z: c.p[2] }));

    const mine = msg.cars.find((c) => c.id === this.id);
    if (!mine) return;

    if (!this.spawned) {
      this.prediction.spawn(
        { x: mine.p[0], y: mine.p[1], z: mine.p[2] },
        yawOf({ x: mine.q[0], y: mine.q[1], z: mine.q[2], w: mine.q[3] }),
      );
      this.spawned = true;
      return;
    }

    this.prediction.reconcile(mine, msg.ackSeq);
    if (this.state === 'racing') {
      const st = this.prediction.stats;
      this.errors.push(st.lastError);
      this.replays.push(st.lastReplay);
      if (st.lastError > 1 && this.spikes.length < 20) {
        this.spikes.push(
          `err=${st.lastError.toFixed(2)}m ack=${st.lastAckSeq} seq=${this.prediction.currentSeq} ` +
            `pending=${st.lastPending} replay=${st.lastReplay} tick=${msg.tick} ` +
            `speed=${(this.prediction.car.speed * 3.6).toFixed(0)}km/h surf=${mine.surface}`,
        );
      }
    }
  }

  private readonly recent: InputMsg[] = [];

  /** One fixed physics step, plus input transmission on the send boundary. */
  fixedStep(): void {
    this.prediction.fixedStep((seq) => {
      const input: CarInput =
        this.state !== 'racing'
          ? { throttle: 0, brake: 0, steer: 0, handbrake: false }
          : process.env['CONST_INPUT']
            ? { throttle: 1, brake: 0, steer: 0, handbrake: false }
            : this.driver.update(this.prediction.car, FIXED_DT * 2, this.others);

      const msg: InputMsg = { t: 'input', seq, ...input };
      this.recent.push(msg);
      if (this.recent.length > INPUT_REDUNDANCY) this.recent.shift();
      // Oldest first: the server keeps only seqs above the highest it has seen,
      // so a recovered input must arrive before the newer ones that follow it.
      for (const m of this.recent) this.send(m);

      return input;
    });
  }

  /** One rendered frame: interpolate remote cars and record how far each moved. */
  renderFrame(now: number, dt: number): void {
    this.remote.updateGhosts(now, this.id);
    this.prediction.updateVisual(dt);
    this.frameDts.push(dt);
    if (this.state !== 'racing') return;
    for (const id of this.remote.ids()) {
      if (id === this.id) continue;
      const pose = this.remote.poseOf(id, now);
      if (!pose) continue;
      let m = this.motion.get(id);
      if (!m) {
        m = new MotionTrack();
        this.motion.set(id, m);
      }
      m.sample(pose.p, dt, Math.hypot(pose.v.x, pose.v.y, pose.v.z));
    }
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------

const pct = (a: number[], p: number): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const f3 = (n: number) => n.toFixed(3);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const lag = Number(process.argv[2] ?? 100);
  const jitter = Number(process.argv[3] ?? 20);
  const loss = Number(process.argv[4] ?? 0.02);
  const seconds = Number(process.argv[5] ?? 60);
  const trackName = process.env['TRACK'] ?? 'interlagos';

  await initPhysics();
  const track = JSON.parse(
    readFileSync(resolve(here, `../public/track/${trackName}.json`), 'utf8'),
  ) as TrackData;

  // AI fills the grid so there are remote cars actually racing to measure.
  const aiFill = Number(process.env['AI_FILL'] ?? 6);
  const server = new GameServer(track, { port: PORT, laps: 999, aiFill, staticDirs: [] });
  server.start();

  console.log(`netcheck: ${lag} +/-${jitter} ms latency, ${(loss * 100).toFixed(1)}% loss, ${seconds} s`);
  console.log(`track ${track.name}, 1 measured client + AI grid\n`);

  const client = new SimClient(track, { lag, jitter, loss });

  // Client loop: fixed steps at TICK_HZ, render sampling at 60 Hz. Driven off
  // one timer so the two stay in the relationship the browser has.
  const stepMs = 1000 / TICK_HZ;
  let next = performance.now();
  let lastFrame = performance.now();
  let running = true;

  const loop = (): void => {
    if (!running) return;
    const now = performance.now();
    if (now - next > 500) next = now;
    let guard = 0;
    while (now >= next && guard++ < 8) {
      client.fixedStep();
      next += stepMs;
    }
    client.renderFrame(now, (now - lastFrame) / 1000);
    lastFrame = now;
    setTimeout(loop, Math.max(0, next - performance.now()));
  };
  setTimeout(loop, stepMs);

  const report = setInterval(() => {
    console.log(
      `  state ${client.state.padEnd(9)} err p50 ${f3(pct(client.errors, 50))} ` +
        `p99 ${f3(pct(client.errors, 99))} m   replay p99 ${pct(client.replays, 99)} steps   ` +
        `snaps ${client.prediction.stats.hardSnaps}   dropped ${client.dropped}`,
    );
  }, 10_000);

  await sleep(seconds * 1000);
  running = false;
  clearInterval(report);

  // --- report -------------------------------------------------------------
  const e50 = pct(client.errors, 50);
  const e99 = pct(client.errors, 99);
  const eMax = client.errors.length ? Math.max(...client.errors) : 0;
  const r99 = pct(client.replays, 99);

  let totalTeleports = 0;
  let worstRatio = 0;
  let medSpeed = 0;
  let tracked = 0;
  for (const m of client.motion.values()) {
    if (m.speeds.length < 60) continue;
    tracked++;
    totalTeleports += m.teleports();
    worstRatio = Math.max(worstRatio, m.maxRatio);
    medSpeed = Math.max(medSpeed, m.medianSpeed());
  }
  const frames = [...client.motion.values()].reduce((s, m) => s + m.speeds.length, 0);
  const staleRate = client.remote.stats.staleRate;
  const dtMs = client.frameDts.map((d) => d * 1000);

  console.log('\n--- results -------------------------------------------------');
  const h = server.room.inputHealth;
  console.log(`inputs dropped by sim  ${client.dropped}`);
  console.log(
    `server input queue     held ${h.held}/${h.samples} periods ` +
      `(${((h.held / Math.max(1, h.samples)) * 100).toFixed(2)}%), ` +
      `starved ${h.starved}, overflowed ${h.overflowed}, ` +
      `mean depth ${(h.queueDepthSum / Math.max(1, h.samples)).toFixed(2)}`,
  );
  console.log(`\nPREDICTION (gate check 2)`);
  console.log(`  error p50            ${f3(e50)} m`);
  console.log(`  error p75/p90/p95    ${f3(pct(client.errors, 75))} / ${f3(pct(client.errors, 90))} / ${f3(pct(client.errors, 95))} m`);
  console.log(`  error p99            ${f3(e99)} m`);
  console.log(`  error max            ${f3(eMax)} m`);
  console.log(`  replay depth p99     ${r99} steps`);
  console.log(`  hard snaps           ${client.prediction.stats.hardSnaps}`);
  console.log(`  corrections          ${client.prediction.stats.corrections}`);
  if (client.spikes.length) {
    console.log('  first corrections over 1 m:');
    for (const l of client.spikes) console.log(`    ${l}`);
  }

  console.log(`\nINTERPOLATION (gate check 3)`);
  console.log(`  remote cars tracked  ${tracked}`);
  console.log(`  frames sampled       ${frames}`);
  console.log(`  frame dt p50/p99     ${f3(pct(dtMs, 50))} / ${f3(pct(dtMs, 99))} ms`);
  console.log(`  median implied speed ${f3(medSpeed)} m/s`);
  console.log(`  worst speed ratio    ${f3(worstRatio)}x reported`);
  console.log(`  teleports            ${totalTeleports}  (frames above 3x reported speed)`);
  console.log(`  stale frames         ${(staleRate * 100).toFixed(2)}%`);
  console.log(`  buffer depth         ${client.remote.stats.buffered} snapshots`);
  console.log(`  render lag           ${client.remote.stats.behindMs.toFixed(0)} ms behind newest`);

  console.log('\n--- gate checks ---------------------------------------------');
  const check2 = e99 < 1.0 && client.prediction.stats.hardSnaps === 0;
  const check3 = tracked > 0 && totalTeleports === 0 && staleRate < 0.05;
  console.log(
    `2. local responsiveness  ${check2 ? 'PASS' : 'FAIL'}  ` +
      `(p99 error ${f3(e99)} m, ${client.prediction.stats.hardSnaps} hard snaps; needs <1 m and 0)`,
  );
  console.log(
    `3. remote smoothness     ${check3 ? 'PASS' : 'FAIL'}  ` +
      `(${totalTeleports} teleports, ${(staleRate * 100).toFixed(2)}% stale; needs 0 and <5%)`,
  );

  client.close();
  await server.stop();
  process.exit(check2 && check3 ? 0 : 1);
}


main().catch((e) => {
  console.error(e);
  process.exit(1);
});
