/**
 * WebSocket transport and static file serving.
 *
 * The room owns the simulation and knows nothing about sockets; this file owns
 * sockets and knows nothing about physics. Everything crossing between them is
 * a `ClientMsg` or a `ServerMsg` from the frozen protocol.
 *
 * It also serves the built client and the track JSON, so at the venue there is
 * one process, one port and one URL to type. HANDOFF.md §9: a join link nobody
 * can mistype is worth more than it sounds.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import { DEFAULT_PORT, PROTOCOL_VERSION, TICK_HZ } from '../shared/constants';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import type { TrackData } from '../shared/track-schema';
import { AvatarStore } from './avatars';
import { RemoteControlHub } from './remote-control';
import { Room, type RoomOptions } from './room';

/**
 * Optional TLS material for phone controllers.
 *
 * Mobile browsers only expose motion sensors in a secure context: Chrome blocks
 * `deviceorientation` outside one, and iOS needs `requestPermission()`, which
 * needs one too. Over plain http on a LAN address the controller page loads and
 * the sensors simply never fire — which at a venue looks like a broken feature
 * rather than a missing certificate.
 *
 * So: if `certs/dev-key.pem` and `certs/dev-cert.pem` exist the server speaks
 * HTTPS and WSS, otherwise it behaves exactly as before. `npm run certs`
 * generates them. Absent certs, the keyboard still works and nothing else
 * changes, so no existing tooling is affected by this file being here.
 */
function readTls(root: string): { key: Buffer; cert: Buffer } | null {
  try {
    return {
      key: readFileSync(resolve(root, 'certs/dev-key.pem')),
      cert: readFileSync(resolve(root, 'certs/dev-cert.pem')),
    };
  } catch {
    return null;
  }
}

/**
 * Transport ping interval. Comfortably under CLIENT_TIMEOUT_MS so a client has
 * to miss several before the room gives up on it.
 */
const HEARTBEAT_MS = 4000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.map': 'application/json; charset=utf-8',
};

export interface ServerOptions extends RoomOptions {
  port?: number;
  /** Directories searched, in order, for static files. */
  staticDirs?: string[];
  trackUrl?: string;
  /** Project root, searched for optional TLS material. Omit to stay on http. */
  tlsRoot?: string;
}

export class GameServer {
  readonly room: Room;
  private readonly wss: WebSocketServer;
  private readonly http: ReturnType<typeof createServer>;
  private readonly sockets = new Map<number, WebSocket>();
  private readonly ids = new WeakMap<WebSocket, number>();
  private readonly port: number;
  private readonly staticDirs: string[];
  private readonly trackUrl: string;
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private recorder: NodeJS.Timeout | null = null;
  /** Set by RECORD=<file>. Absent means every telemetry path is inert. */
  private readonly recordTo = process.env['RECORD'] ?? '';
  private fatalReported = false;
  /** Phone-as-steering-wheel pairing, on the `/pair` path. */
  readonly remote = new RemoteControlHub();
  /** Driver photos, served over HTTP rather than either socket. */
  readonly avatars = new AvatarStore();
  readonly secure: boolean;

  constructor(track: TrackData, opts: ServerOptions = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.staticDirs = (opts.staticDirs ?? []).map((d) => resolve(d));
    this.trackUrl = opts.trackUrl ?? `/track/${track.name}.json`;

    this.room = new Room(
      track,
      {
        send: (id, msg) => this.sendTo(id, msg),
        broadcast: (msg) => this.broadcast(msg),
        evict: (id, why) => this.evict(id, why),
        sendSnapshots: (tick, carsJson, ackSeqOf) => {
          // One serialisation of the car array for the whole room; only the
          // ackSeq prefix differs per client.
          const suffix = `,"cars":${carsJson}}`;
          for (const [id, ws] of this.sockets) {
            if (ws.readyState !== 1) continue;
            ws.send(`{"t":"snap","tick":${tick},"ackSeq":${ackSeqOf(id)}${suffix}`);
          }
        },
      },
      opts,
    );

    const tls = opts.tlsRoot ? readTls(opts.tlsRoot) : null;
    this.secure = tls !== null;
    this.http = tls
      ? (createHttpsServer(tls, (req, res) => this.serveStatic(req, res)) as unknown as ReturnType<typeof createServer>)
      : createServer((req, res) => this.serveStatic(req, res));
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (ws, req) => {
      // Phone controllers share the port but not the protocol: they get their
      // own path and their own tiny message set, so shared/protocol.ts stays
      // frozen and the game's message handling is untouched.
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/pair') {
        // Control frames are tiny and frequent, which is exactly the shape
        // Nagle's algorithm holds back waiting for more to send. Node's http
        // server defaults noDelay to true on recent versions, but the cost of
        // being wrong here is tens of milliseconds of steering lag on the venue
        // network, and the cost of setting it anyway is nothing.
        (ws as unknown as { _socket?: { setNoDelay(v: boolean): void } })._socket?.setNoDelay(true);
        this.remote.accept(ws);
      }
      else this.onConnection(ws);
    });
  }

  // -------------------------------------------------------------------------

  start(): void {
    // A port clash is the most likely thing to go wrong at a venue - a server
    // left running from the last demo - and it otherwise surfaces as an
    // unhandled 'error' event and a stack trace, which is the worst possible
    // thing to be reading in front of an audience.
    //
    // The handler goes on both: ws re-emits the http server's errors on the
    // WebSocketServer, and it is that copy which is unhandled and fatal.
    const onFatal = (err: NodeJS.ErrnoException): void => {
      if (this.fatalReported) return;
      this.fatalReported = true;
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${this.port} is already in use.`);
        console.error('Another race server is probably still running. Stop it, or set PORT.');
      } else {
        console.error(`Server failed to start: ${err.message}`);
      }
      process.exit(1);
    };
    this.http.on('error', onFatal);
    this.wss.on('error', onFatal);

    this.remote.start();
    this.http.listen(this.port, '0.0.0.0', () => {
      const scheme = this.secure ? 'https' : 'http';
      console.log(`race server listening on 0.0.0.0:${this.port}`);
      for (const a of localAddresses()) console.log(`  ${scheme}://${a}:${this.port}`);
      if (!this.secure) {
        console.log('  (http: phone controllers cannot read motion sensors — run `npm run certs`)');
      }
      if (this.staticDirs.length === 0) {
        console.log('  (no static dirs configured - run vite separately for the client)');
      }
    });
    this.startLoop();
    this.startHeartbeat();
    this.startRecording();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.recorder) clearInterval(this.recorder);
    this.recorder = null;
    for (const ws of this.sockets.values()) ws.close();
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.remote.stop();
    await new Promise<void>((r) => this.http.close(() => r()));
    this.room.destroy();
  }

  /**
   * Fixed-timestep loop with drift correction.
   *
   * setInterval drifts, and a drifting server tick means the client's fixed
   * step and the server's slowly disagree about how much time a tick is worth.
   * This accumulates against a wall clock instead. If the process stalls badly
   * the backlog is abandoned rather than being simulated all at once, which
   * would otherwise be a death spiral under load.
   */
  private startLoop(): void {
    const stepMs = 1000 / TICK_HZ;
    let next = performance.now();

    const loop = (): void => {
      const now = performance.now();
      if (now - next > 500) next = now; // gave up on the backlog
      let guard = 0;
      while (now >= next && guard++ < 10) {
        this.room.step();
        next += stepMs;
      }
      this.timer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    this.timer = setTimeout(loop, stepMs);
  }

  // -------------------------------------------------------------------------

  /**
   * Drop a client the room has given up on.
   *
   * The room removes the entrant; if the socket stayed open the player would
   * be a ghost - connected, with no entrant, no car and a Ready button that
   * silently does nothing. Closing it puts them on the disconnected screen,
   * which at least says what happened.
   */
  private evict(id: number, why: string): void {
    const ws = this.sockets.get(id);
    if (!ws) return;
    this.sendRaw(ws, { t: 'error', code: 'timeout', message: `dropped: ${why}` });
    this.sockets.delete(id);
    ws.close();
  }

  /**
   * Transport-level heartbeat.
   *
   * The client pings from a `setTimeout` chain, which browsers throttle hard
   * in a hidden tab - to once a minute after a few minutes backgrounded, well
   * past CLIENT_TIMEOUT_MS. A player who alt-tabbed was being dropped from the
   * room for it. A WebSocket ping is answered by the browser itself rather
   * than by page script, so it keeps reporting liveness through any amount of
   * timer throttling, and a genuinely gone client still fails it.
   */
  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      for (const ws of this.sockets.values()) {
        if (ws.readyState !== ws.OPEN) continue;
        ws.ping();
      }
    }, HEARTBEAT_MS);
    // Never hold the process open for a heartbeat.
    this.heartbeat.unref?.();
  }

  /** Append one JSON line. Never throws: a recorder must not break a race. */
  private write(line: Record<string, unknown>): void {
    if (!this.recordTo) return;
    try {
      appendFileSync(this.recordTo, JSON.stringify(line) + '\n');
    } catch {
      /* a full disk is not worth ending the session over */
    }
  }

  /**
   * Session recorder, server half. Off unless RECORD=<file> is set.
   *
   * Samples once a second: what the simulation is doing, and what each human
   * car is doing inside it. The client posts its own half to /telemetry, and
   * both land in the same file against the same wall clock, so a stutter on
   * screen can be lined up against what the server thought was happening.
   */
  private startRecording(): void {
    if (!this.recordTo) return;
    this.write({
      src: 'server',
      kind: 'start',
      at: Date.now(),
      track: this.room.track.name,
      node: process.version,
    });
    this.recorder = setInterval(() => {
      const ms = this.room.tickMs;
      const sorted = [...ms].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
      const humans = [];
      for (const e of this.room.entrants.values()) {
        if (e.ai || !e.car) continue;
        const p = e.car.body.translation();
        humans.push({
          id: e.id,
          name: e.name,
          lap: e.lap.lap,
          cp: e.lap.cp,
          speed: +(e.car.speed * 3.6).toFixed(1),
          surface: e.car.surface,
          offTrack: e.car.offTrackTicks,
          stuck: e.stuckTicks,
          upY: +e.car.up().y.toFixed(3),
          p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
          finished: e.finished,
        });
      }
      this.write({
        src: 'server',
        kind: 'sample',
        at: Date.now(),
        tick: this.room.tick,
        state: this.room.state,
        entrants: this.room.entrants.size,
        stepP50: +at(0.5).toFixed(2),
        stepP99: +at(0.99).toFixed(2),
        rss: Math.round(process.memoryUsage().rss / 1048576),
        humans,
      });
    }, 1000);
    this.recorder.unref?.();
  }

  private onConnection(ws: WebSocket): void {
    // The browser answers this without waking page script, so it survives the
    // timer throttling that a hidden tab imposes on the client's own ping.
    ws.on('pong', () => {
      const id = this.ids.get(ws);
      if (id !== undefined) this.room.touch(id);
    });

    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        this.sendRaw(ws, { t: 'error', code: 'malformed', message: 'not JSON' });
        return;
      }
      this.onMessage(ws, msg);
    });

    ws.on('close', () => {
      const id = this.ids.get(ws);
      if (id !== undefined) {
        this.sockets.delete(id);
        this.room.leave(id);
      }
    });

    ws.on('error', () => ws.close());
  }

  private onMessage(ws: WebSocket, msg: ClientMsg): void {
    if (!msg || typeof msg.t !== 'string') return;
    const id = this.ids.get(ws);

    if (msg.t === 'hello') {
      if (id !== undefined) return; // already greeted
      if (msg.v !== PROTOCOL_VERSION) {
        this.sendRaw(ws, {
          t: 'error',
          code: 'version',
          message: `server speaks protocol ${PROTOCOL_VERSION}, client sent ${msg.v}`,
        });
        ws.close();
        return;
      }
      if (this.room.isFull) {
        this.sendRaw(ws, { t: 'error', code: 'full', message: 'race is full' });
        ws.close();
        return;
      }

      const e = this.room.join(msg.name, msg.color);
      this.ids.set(ws, e.id);
      this.sockets.set(e.id, ws);

      this.sendRaw(ws, {
        t: 'welcome',
        v: PROTOCOL_VERSION,
        id: e.id,
        color: e.color,
        trackUrl: this.trackUrl,
        tick: this.room.tick,
        laps: this.room.laps,
      });
      this.broadcast({
        t: 'join',
        player: { id: e.id, name: e.name, color: e.color, ready: e.ready, ai: false },
        players: this.room.roster(),
      });
      this.sendRaw(ws, {
        t: 'state',
        state: this.room.state,
        timer: null,
        tick: this.room.tick,
      });
      return;
    }

    if (id === undefined) return; // everything else requires a hello first

    switch (msg.t) {
      case 'input':
        this.room.onInput(id, msg);
        break;
      case 'inputs':
        // Oldest first, so a recovered input is applied before the newer ones
        // that would otherwise make the server ignore it.
        if (Array.isArray(msg.a)) {
          for (const one of msg.a) this.room.onInput(id, { t: 'input', ...one });
        }
        break;
      case 'reset':
        this.room.onReset(id);
        break;

      case 'ready':
        this.room.onReady(id, msg.ready === true);
        break;
      case 'ping':
        this.room.touch(id);
        this.sendRaw(ws, { t: 'pong', ts: msg.ts, tick: this.room.tick });
        break;
    }
  }

  private sendTo(id: number, msg: ServerMsg): void {
    const ws = this.sockets.get(id);
    if (ws) this.sendRaw(ws, msg);
  }

  private broadcast(msg: ServerMsg): void {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets.values()) {
      if (ws.readyState === 1) ws.send(text);
    }
  }

  private sendRaw(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // -------------------------------------------------------------------------

  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);

    // The client half of the recorder posts here. Answered even when recording
    // is off, so a page opened with ?rec=1 against a plain server is harmless.
    if (path === '/telemetry' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 65536) req.destroy();
      });
      req.on('end', () => {
        try {
          this.write({ ...(JSON.parse(body) as Record<string, unknown>), at2: Date.now() });
        } catch {
          /* a malformed beacon is not worth a response code */
        }
        res.writeHead(204).end();
      });
      return;
    }

    // --- driver photos ------------------------------------------------------
    // A car's photo, posted by that player's laptop once their phone has taken
    // it, and fetched by every other laptop so the whole grid sees it.
    const avatarMatch = /^\/avatar\/(\d+)$/.exec(path);
    if (avatarMatch) {
      const id = Number(avatarMatch[1]);
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          // Hang up rather than buffer: this listens on a venue LAN and the
          // failure worth preventing is memory, not a bad photo.
          if (size > 64 * 1024) req.destroy();
          else chunks.push(c);
        });
        req.on('end', () => {
          const ok = this.avatars.set(id, Buffer.concat(chunks));
          res.writeHead(ok ? 204 : 400).end();
        });
        return;
      }
      const bytes = this.avatars.get(id);
      if (!bytes) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        // Immutable per version: the URL carries ?v= so a new photo is a new URL.
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(bytes);
      return;
    }

    if (path === '/avatars') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(this.avatars.manifest()));
      return;
    }

    if (path === '/') path = '/index.html';

    // Reject anything that escapes the served root before touching the disk.
    const rel = normalize(path).replace(/^([/\\])+/, '');
    if (rel.includes('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }

    for (const dir of this.staticDirs) {
      const file = join(dir, rel);
      if (!file.startsWith(dir)) continue;
      if (existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        });
        createReadStream(file).pipe(res);
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

/** LAN addresses, so the console prints something players can actually type. */
function localAddresses(): string[] {
  const out: string[] = [];
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
      }
    }
  } catch {
    /* not fatal - it is a convenience */
  }
  return out;
}
