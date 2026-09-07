/**
 * MINIMAL UI — Instance B owns the lobby, HUD and results screen (HANDOFF.md §4).
 *
 * This is the smallest thing that lets a person type a name, join, see who else
 * is here, and read a result. It exists so the netcode can be tested by an
 * actual human on an actual second machine, which is the only way gate checks 2
 * and 3 can be graded honestly. Replace it; do not extend it.
 */

import { CAR_COLORS, CAR_COLOR_NAMES } from '../../shared/constants';
import type { PlayerInfo, RaceState, ResultEntry } from '../../shared/protocol';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
}

export class Ui {
  onJoin: ((name: string, color: number) => void) | null = null;
  onReady: ((ready: boolean) => void) | null = null;

  private readonly lobby: HTMLElement;
  private readonly roster: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly results: HTMLElement;
  private readonly nameInput: HTMLInputElement;

  private chosenColor = Math.floor(Math.random() * CAR_COLORS.length);
  private isReady = false;

  constructor(private readonly root: HTMLElement = document.body) {
    this.lobby = el('div', 'panel lobby');
    this.roster = el('div', 'roster');
    this.banner = el('div', 'banner');
    this.hud = el('div', 'hud');
    this.results = el('div', 'panel results');

    this.nameInput = document.createElement('input');
    this.nameInput.maxLength = 16;
    this.nameInput.placeholder = 'your name';
    this.nameInput.value = localStorage.getItem('driverName') ?? '';

    this.buildLobby();
    root.append(this.lobby, this.roster, this.banner, this.hud, this.results);
    this.roster.style.display = 'none';
    this.banner.style.display = 'none';
    this.hud.style.display = 'none';
    this.results.style.display = 'none';
  }

  private buildLobby(): void {
    const title = el('h1');
    title.textContent = 'Interlagos';
    const sub = el('p', 'sub');
    sub.textContent = 'Three laps. Arrows or WASD to drive, space for handbrake, R to recover.';

    const swatches = el('div', 'swatches');
    CAR_COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = hex(c);
      b.title = CAR_COLOR_NAMES[i] ?? '';
      b.setAttribute('aria-label', CAR_COLOR_NAMES[i] ?? `colour ${i}`);
      if (i === this.chosenColor) b.classList.add('on');
      b.addEventListener('click', () => {
        this.chosenColor = i;
        for (const s of swatches.children) s.classList.remove('on');
        b.classList.add('on');
      });
      swatches.appendChild(b);
    });

    const join = document.createElement('button');
    join.className = 'primary';
    join.textContent = 'Join race';
    const go = () => {
      const name = this.nameInput.value.trim() || 'Driver';
      localStorage.setItem('driverName', name);
      this.onJoin?.(name, this.chosenColor);
      this.lobby.style.display = 'none';
      this.roster.style.display = 'block';
      this.hud.style.display = 'block';
    };
    join.addEventListener('click', go);
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });

    this.lobby.append(title, sub, this.nameInput, swatches, join);
  }

  showLobby(): void {
    this.lobby.style.display = 'block';
  }

  showRoster(players: PlayerInfo[], myId: number): void {
    this.roster.replaceChildren();
    const head = el('div', 'roster-head');
    head.textContent = `Drivers (${players.length})`;
    this.roster.appendChild(head);

    for (const p of players) {
      const row = el('div', 'roster-row');
      const dot = el('span', 'dot');
      dot.style.background = hex(CAR_COLORS[p.color % CAR_COLORS.length]!);
      const nm = el('span', 'nm');
      nm.textContent = p.name + (p.id === myId ? ' (you)' : '') + (p.ai ? ' [CPU]' : '');
      const st = el('span', 'st');
      st.textContent = p.ai ? '' : p.ready ? 'ready' : 'waiting';
      row.append(dot, nm, st);
      this.roster.appendChild(row);
    }

    const btn = document.createElement('button');
    btn.className = 'ready';
    btn.textContent = this.isReady ? "Ready — click to cancel" : 'Ready';
    btn.addEventListener('click', () => {
      this.isReady = !this.isReady;
      this.onReady?.(this.isReady);
      btn.textContent = this.isReady ? "Ready — click to cancel" : 'Ready';
    });
    this.roster.appendChild(btn);
  }

  setState(state: RaceState, timer: number | null): void {
    const show = (text: string) => {
      this.banner.textContent = text;
      this.banner.style.display = 'block';
    };
    switch (state) {
      case 'lobby':
        this.banner.style.display = 'none';
        this.results.style.display = 'none';
        this.isReady = false;
        break;
      case 'grid':
        show('Form up on the grid');
        this.roster.style.display = 'none';
        this.results.style.display = 'none';
        break;
      case 'countdown':
        show(timer === null ? 'Get ready' : `${Math.ceil(timer)}`);
        break;
      case 'racing':
        show('GO');
        setTimeout(() => {
          if (this.banner.textContent === 'GO') this.banner.style.display = 'none';
        }, 1200);
        break;
      case 'finished':
        this.banner.style.display = 'none';
        break;
    }
  }

  setLap(lap: number, total: number, lapMs: number, bestMs: number): void {
    const l = this.hud.querySelector('.lap');
    if (l) l.textContent = `Lap ${Math.min(lap + 1, total)}/${total}   last ${formatMs(lapMs)}   best ${formatMs(bestMs)}`;
  }

  setSpeed(kmh: number): void {
    let s = this.hud.querySelector('.speed');
    if (!s) {
      this.hud.append(el('div', 'lap'), el('div', 'speed'));
      s = this.hud.querySelector('.speed');
    }
    if (s) s.textContent = `${Math.round(kmh)} km/h`;
  }

  showResults(results: ResultEntry[], myId: number): void {
    this.results.replaceChildren();
    const h = el('h2');
    h.textContent = 'Result';
    this.results.appendChild(h);

    const table = el('div', 'table');
    for (const r of results) {
      const row = el('div', `row${r.id === myId ? ' me' : ''}`);
      const pos = el('span', 'pos');
      pos.textContent = String(r.position);
      const dot = el('span', 'dot');
      dot.style.background = hex(CAR_COLORS[r.color % CAR_COLORS.length]!);
      const nm = el('span', 'nm');
      nm.textContent = r.name + (r.ai ? ' [CPU]' : '');
      const laps = el('span', 'st');
      laps.textContent = `${r.laps} laps`;
      const best = el('span', 'st');
      best.textContent = `best ${formatMs(r.bestLapMs)}`;
      const total = el('span', 'st');
      total.textContent = r.totalMs === null ? 'DNF' : formatMs(r.totalMs);
      row.append(pos, dot, nm, laps, best, total);
      table.appendChild(row);
    }
    this.results.appendChild(table);
    this.results.style.display = 'block';
    this.roster.style.display = 'block';
  }

  showDisconnected(reason: string): void {
    this.banner.textContent = `Disconnected: ${reason}`;
    this.banner.style.display = 'block';
  }
}

function el(tag: string, cls = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
