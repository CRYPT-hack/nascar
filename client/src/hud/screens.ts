/**
 * Lobby and results screens.
 *
 * Full-screen overlays above the HUD. Like the HUD, these render what they are
 * told and own no race logic — Instance A calls `showLobby()` on a `join` or
 * `roster` message and `showResults()` on `result`, and supplies the callbacks
 * for the ready button and the colour picker.
 *
 * HANDOFF.md §11: a judge opens a link, picks a car colour, and races. That
 * sentence is this file.
 */

import { CAR_COLOR_NAMES, CAR_COLORS, RACE_LAPS } from '../../../shared/constants';
import type { PlayerInfo, ResultEntry } from '../../../shared/protocol';
import { formatLapTime } from './hud';
import './hud.css';

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function swatch(colorIndex: number): HTMLSpanElement {
  const s = el('span', 'swatch');
  s.style.background = hex(CAR_COLORS[colorIndex] ?? 0xffffff);
  return s;
}

export interface LobbyOptions {
  players: PlayerInfo[];
  /** This client's car id, so its row can be highlighted. */
  selfId: number;
  /** Currently selected colour index for this client. */
  selfColor: number;
  ready: boolean;
  /** How the player joins — shown so the host can read it out at the venue. */
  joinHint?: string;
  onReady(ready: boolean): void;
  onColor(colorIndex: number): void;
}

export class Screens {
  readonly root: HTMLDivElement;
  private readonly card: HTMLDivElement;

  constructor(parent: HTMLElement = document.body) {
    this.root = el('div', 'screen');
    this.root.hidden = true;
    this.card = el('div', 'card');
    this.root.append(this.card);
    parent.append(this.root);
  }

  hide(): void {
    this.root.hidden = true;
  }

  showLobby(o: LobbyOptions): void {
    this.card.replaceChildren();
    const waiting = o.players.filter((p) => !p.ai && !p.ready).length;

    this.card.append(
      el('h1', undefined, 'Interlagos — 3 laps'),
      el(
        'p',
        'sub',
        o.joinHint
          ? `${o.players.length} in the room · ${waiting} still choosing · join at ${o.joinHint}`
          : `${o.players.length} in the room · ${waiting} still choosing`,
      ),
    );

    const table = el('table');
    const head = el('tr');
    for (const [label, cls] of [
      ['Driver', ''],
      ['Car', ''],
      ['Status', ''],
    ] as const) {
      head.append(el('th', cls, label));
    }
    const thead = el('thead');
    thead.append(head);
    table.append(thead);

    const body = el('tbody');
    for (const p of o.players) {
      const row = el('tr');
      if (p.id === o.selfId) row.className = 'me';

      const name = el('td');
      name.append(swatch(p.color), document.createTextNode(p.name));
      row.append(name);

      row.append(el('td', undefined, CAR_COLOR_NAMES[p.color] ?? '—'));

      const status = el('td');
      if (p.ai) status.append(el('span', 'pill ai', 'AI'));
      else status.append(el('span', p.ready ? 'pill ready' : 'pill waiting', p.ready ? 'Ready' : 'Waiting'));
      row.append(status);

      body.append(row);
    }
    table.append(body);
    this.card.append(table);

    // Colour picker.
    const picker = el('div', 'actions');
    const taken = new Set(o.players.filter((p) => p.id !== o.selfId).map((p) => p.color));
    for (let i = 0; i < CAR_COLORS.length; i++) {
      const b = el('button', 'ghost');
      b.style.padding = '10px';
      b.style.borderColor = i === o.selfColor ? hex(CAR_COLORS[i]!) : 'var(--edge)';
      b.style.opacity = taken.has(i) ? '0.3' : '1';
      b.disabled = taken.has(i);
      b.title = CAR_COLOR_NAMES[i] ?? '';
      b.append(swatch(i));
      b.addEventListener('click', () => o.onColor(i));
      picker.append(b);
    }
    this.card.append(picker);

    const actions = el('div', 'actions');
    const readyBtn = el('button', undefined, o.ready ? 'Not ready' : "I'm ready");
    if (o.ready) readyBtn.className = 'ghost';
    readyBtn.addEventListener('click', () => o.onReady(!o.ready));
    actions.append(readyBtn, el('span', 'hint', `First to ${RACE_LAPS} laps wins. Race starts when everyone is ready.`));
    this.card.append(actions);

    this.root.hidden = false;
  }

  showResults(results: ResultEntry[], selfId: number, onContinue?: () => void): void {
    this.card.replaceChildren();
    const winner = results.find((r) => r.position === 1);

    this.card.append(
      el('h1', undefined, winner ? `${winner.name} wins` : 'Race over'),
      el('p', 'sub', `${results.length} drivers · ${RACE_LAPS} laps · Interlagos`),
    );

    const table = el('table');
    const head = el('tr');
    head.append(
      el('th', 'num', '#'),
      el('th', undefined, 'Driver'),
      el('th', 'num', 'Laps'),
      el('th', 'num', 'Best lap'),
      el('th', 'num', 'Total'),
    );
    const thead = el('thead');
    thead.append(head);
    table.append(thead);

    const body = el('tbody');
    for (const r of results) {
      const row = el('tr');
      if (r.id === selfId) row.className = 'me';

      row.append(el('td', 'num', String(r.position)));

      const name = el('td');
      name.append(swatch(r.color), document.createTextNode(r.name));
      if (r.ai) name.append(el('span', 'pill ai inline', 'AI'));
      row.append(name);

      row.append(
        el('td', 'num', String(r.laps)),
        el('td', 'num', formatLapTime(r.bestLapMs)),
        // A driver who did not finish has no total time; say so rather than
        // printing a misleading dash that reads like a fast lap.
        el('td', 'num', r.totalMs === null ? 'DNF' : formatLapTime(r.totalMs)),
      );
      body.append(row);
    }
    table.append(body);
    this.card.append(table);

    if (onContinue) {
      const actions = el('div', 'actions');
      const btn = el('button', undefined, 'Back to lobby');
      btn.addEventListener('click', onContinue);
      actions.append(btn);
      this.card.append(actions);
    }

    this.root.hidden = false;
  }

  dispose(): void {
    this.root.remove();
  }
}
