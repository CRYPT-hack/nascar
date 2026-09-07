/**
 * Netcode diagnostics overlay.
 *
 * Instance B owns the race HUD (position, lap, lap time, speed, draft). This is
 * a different thing: the numbers hour-12 gate checks 2 and 3 are graded on.
 *
 * "Remote cars look smooth" is not a measurement. Prediction error in metres,
 * replay depth, stale-frame rate and the interpolation buffer depth are, and
 * they are what distinguishes netcode that works from netcode that happens to
 * look acceptable on a LAN with one other player.
 *
 * Toggle with F3. Hidden by default so it never ends up in the demo footage.
 */

import type { NetSim } from './connection';
import type { PredictionStats } from './prediction';
import type { RemoteStats } from './remote';

export interface StatsInput {
  fps: number;
  rtt: number;
  sim: NetSim;
  dropped: number;
  prediction: PredictionStats;
  remote: RemoteStats;
  speedKmh: number;
  state: string;
  cars: number;
}

export class NetStats {
  private readonly el: HTMLElement;
  private visible = false;
  private lastPaint = 0;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.id = 'netstats';
    this.el.style.cssText = [
      'position:fixed',
      'top:10px',
      'left:10px',
      'z-index:50',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'color:#cfe3ff',
      'background:rgba(8,12,20,0.82)',
      'border:1px solid rgba(120,160,220,0.28)',
      'border-radius:6px',
      'padding:8px 10px',
      'white-space:pre',
      'pointer-events:none',
      'display:none',
    ].join(';');
    parent.appendChild(this.el);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  show(): void {
    this.visible = true;
    this.el.style.display = 'block';
  }

  update(s: StatsInput): void {
    if (!this.visible) return;
    // Repainting text at 144 Hz is its own performance problem.
    const now = performance.now();
    if (now - this.lastPaint < 100) return;
    this.lastPaint = now;

    const p = s.prediction;
    const r = s.remote;
    const simOn = s.sim.lag > 0 || s.sim.loss > 0 || s.sim.jitter > 0;

    const rows = [
      `fps            ${s.fps.toFixed(0).padStart(6)}`,
      `state          ${s.state.padStart(6)}   cars ${s.cars}`,
      `speed          ${s.speedKmh.toFixed(0).padStart(6)} km/h`,
      '',
      `rtt            ${s.rtt.toFixed(0).padStart(6)} ms`,
      simOn
        ? `netsim         lag ${s.sim.lag} +/-${s.sim.jitter} ms, loss ${(s.sim.loss * 100).toFixed(1)}%`
        : 'netsim         off',
      simOn ? `dropped        ${s.dropped.toString().padStart(6)} msgs` : '',
      '',
      'PREDICTION (local car)',
      `  error now    ${p.lastError.toFixed(3).padStart(6)} m`,
      `  error peak3s ${p.peakError.toFixed(3).padStart(6)} m`,
      `  replay       ${p.lastReplay.toString().padStart(6)} steps`,
      `  unacked      ${p.pending.toString().padStart(6)} inputs`,
      `  corrections  ${p.corrections.toString().padStart(6)}`,
      `  hard snaps   ${p.hardSnaps.toString().padStart(6)}`,
      '',
      'INTERPOLATION (remote cars)',
      `  buffered     ${r.buffered.toString().padStart(6)} snaps`,
      `  render lag   ${r.behindMs.toFixed(0).padStart(6)} ms behind newest`,
      `  arrival gap  ${r.arrivalGapMs.toFixed(1).padStart(6)} ms`,
      `  stale frames ${(r.staleRate * 100).toFixed(1).padStart(6)} %`,
    ];

    this.el.textContent = rows.filter((x) => x !== '').join('\n');
  }
}
