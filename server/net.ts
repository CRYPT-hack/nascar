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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import { DEFAULT_PORT, PROTOCOL_VERSION, TICK_HZ } from '../shared/constants';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import type { TrackData } from '../shared/track-schema';
import { Room, type RoomOptions } from './room';

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
  private fatalReported = false;

  constructor(track: TrackData, opts: ServerOptions = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.staticDirs = (opts.staticDirs ?? []).map((d) => resolve(d));
    this.trackUrl = opts.trackUrl ?? `/track/${track.name}.json`;

    this.room = new Room(
      track,
      {
        send: (id, msg) => this.sendTo(id, msg),
        broadcast: (msg) => this.broadcast(msg),
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

    this.http = createServer((req, res) => this.serveStatic(req, res));
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (ws) => this.onConnection(ws));
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

    this.http.listen(this.port, '0.0.0.0', () => {
      console.log(`race server listening on 0.0.0.0:${this.port}`);
      for (const a of localAddresses()) console.log(`  http://${a}:${this.port}`);
      if (this.staticDirs.length === 0) {
        console.log('  (no static dirs configured - run vite separately for the client)');
      }
    });
    this.startLoop();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const ws of this.sockets.values()) ws.close();
    await new Promise<void>((r) => this.wss.close(() => r()));
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

  private onConnection(ws: WebSocket): void {
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
