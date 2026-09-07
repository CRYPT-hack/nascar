/**
 * Session recorder, client half.
 *
 * Off unless the page is opened with `?rec=1`, so nothing here runs at the
 * venue. When it is on, it posts one line a second to the server's
 * `/telemetry` endpoint, plus a line for every uncaught error.
 *
 * This exists because the interesting failures live on the client and nowhere
 * else: prediction error, hard snaps, dropped packets, the frame rate actually
 * achieved, and any exception that fires once and vanishes into a console
 * nobody had open. The server can see none of it. Posting it back means one
 * file holds both halves of the session, timestamped against the same clock.
 */

interface Sampler {
  (): Record<string, unknown>;
}

const ENDPOINT = '/telemetry';

/** Fire-and-forget. A recorder must never be able to break the thing it records. */
function post(body: unknown): void {
  try {
    const text = JSON.stringify(body);
    // keepalive so the last line still lands if the tab is closing.
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

export function recordingRequested(search: string): boolean {
  return new URLSearchParams(search).get('rec') === '1';
}

/**
 * Start recording. `sample` is called once a second and its result is posted
 * as-is, so the caller decides what is worth keeping.
 */
export function startRecording(sample: Sampler): void {
  const started = Date.now();

  post({ src: 'client', kind: 'start', at: started, ua: navigator.userAgent });

  addEventListener('error', (e) => {
    post({
      src: 'client',
      kind: 'error',
      at: Date.now(),
      message: String(e.message),
      where: `${e.filename}:${e.lineno}:${e.colno}`,
      stack: e.error instanceof Error ? String(e.error.stack).slice(0, 1200) : null,
    });
  });

  addEventListener('unhandledrejection', (e) => {
    post({
      src: 'client',
      kind: 'error',
      at: Date.now(),
      message: 'unhandled rejection',
      stack: String((e as PromiseRejectionEvent).reason).slice(0, 1200),
    });
  });

  // A plain interval rather than the frame loop: a hidden tab pauses
  // requestAnimationFrame entirely, and a recorder that stops when the player
  // alt-tabs would hide exactly the stretch worth looking at.
  setInterval(() => {
    try {
      post({ src: 'client', kind: 'sample', at: Date.now(), ...sample() });
    } catch {
      /* ignore */
    }
  }, 1000);

  addEventListener('pagehide', () => {
    post({ src: 'client', kind: 'end', at: Date.now() });
  });
}
