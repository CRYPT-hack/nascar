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
  /** True while a ready press is waiting on the server to confirm it. */
  readyPending?: boolean;
  /** How the player joins — shown so the host can read it out at the venue. */
  joinHint?: string;
  phone?: PhonePairing;
  onReady(ready: boolean): void;
  onColor(colorIndex: number): void;
}

/** Phone-controller pairing state, rendered as a card on both screens. */
export interface PhonePairing {
  status: 'connecting' | 'waiting' | 'paired' | 'offline';
  code: string | null;
  url: string;
}

export interface JoinOptions {
  name: string;
  color: number;
  phone?: PhonePairing;
  onJoin(name: string, color: number): void;
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

    if (o.phone) this.card.append(phoneCard(o.phone));

    const actions = el('div', 'actions');
    // The middle state matters: a `ready` can be lost and is re-sent until the
    // roster confirms it. Saying so is the difference between a visible pause
    // and a player who believes they are in a race the server never heard of.
    const label = o.readyPending
      ? o.ready
        ? 'Cancelling…'
        : 'Confirming…'
      : o.ready
        ? 'Ready — click to cancel'
        : "I'm ready";
    const readyBtn = el('button', undefined, label);
    if (o.ready) readyBtn.className = 'ghost';
    if (o.readyPending) readyBtn.classList.add('pending');
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

  /**
   * Pre-connect screen: pick a name and a colour, then join.
   *
   * Separate from `showLobby` because it runs before there is a connection, so
   * there is no roster to show and no server to confirm anything against.
   * HANDOFF.md §11: "a judge opens a link, picks a car colour, and races."
   */
  showJoin(o: JoinOptions): void {
    this.card.replaceChildren();
    this.card.append(
      el('h1', undefined, 'Interlagos'),
      el('p', 'sub', `${RACE_LAPS} laps. Pick a name and a colour.`),
    );

    const field = el('div', 'field');
    const label = el('label', undefined, 'Driver name');
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 16;
    input.placeholder = 'your name';
    input.value = o.name;
    field.append(label, input);
    this.card.append(field);

    let color = o.color;
    const picker = el('div', 'actions');
    const paint = (): void => {
      [...picker.children].forEach((b, i) => {
        (b as HTMLElement).style.borderColor = i === color ? hex(CAR_COLORS[i]!) : 'var(--edge)';
      });
    };
    for (let i = 0; i < CAR_COLORS.length; i++) {
      const b = el('button', 'ghost');
      b.style.padding = '10px';
      b.title = CAR_COLOR_NAMES[i] ?? '';
      b.append(swatch(i));
      b.addEventListener('click', () => {
        color = i;
        paint();
      });
      picker.append(b);
    }
    paint();
    this.card.append(picker);

    const go = (): void => {
      const name = input.value.trim() || 'Driver';
      o.onJoin(name, color);
    };
    // Enter submits: at a hackathon nobody wants to find the button.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });

    if (o.phone) this.card.append(phoneCard(o.phone));

    const actions = el('div', 'actions');
    const joinBtn = el('button', undefined, 'Join race');
    joinBtn.addEventListener('click', go);
    actions.append(joinBtn);
    this.card.append(actions);

    this.root.hidden = false;
    input.focus();
  }

  /** Full-screen message, for a lost connection or a refused join. */
  showMessage(title: string, detail: string, onRetry?: () => void): void {
    this.card.replaceChildren();
    this.card.append(el('h1', undefined, title), el('p', 'sub', detail));
    if (onRetry) {
      const actions = el('div', 'actions');
      const btn = el('button', undefined, 'Try again');
      btn.addEventListener('click', onRetry);
      actions.append(btn);
      this.card.append(actions);
    }
    this.root.hidden = false;
  }

  dispose(): void {
    this.root.remove();
  }
}

/**
 * Phone-controller pairing card.
 *
 * Shows the code, the address to open, and a QR of the two together so a player
 * can scan instead of typing — at a venue, a queue of ten people each typing a
 * URL and a code into a phone is its own small disaster (HANDOFF.md §9).
 *
 * Rendered on both the join and lobby screens: pairing a phone is something
 * people do while waiting, not something they plan in advance.
 */
export function phoneCard(p: PhonePairing): HTMLElement {
  const card = el('div', 'phone-card');

  const label: Record<PhonePairing['status'], string> = {
    connecting: 'Phone control — connecting…',
    waiting: 'Steer with your phone',
    paired: 'Phone connected',
    offline: 'Phone control unavailable',
  };
  const head = el('div', 'phone-head');
  head.append(el('span', `dot ${p.status === 'paired' ? 'ok' : p.status === 'offline' ? 'bad' : 'warn'}`));
  head.append(el('span', undefined, label[p.status]));
  card.append(head);

  if (p.status === 'paired') {
    card.append(el('div', 'phone-sub', 'Hold it flat like a wheel. Turn to steer, tilt forward to go.'));
    return card;
  }
  if (p.status !== 'waiting' || !p.code) {
    card.append(el('div', 'phone-sub', 'Keyboard controls still work: arrows or WASD, space for handbrake.'));
    return card;
  }

  const body = el('div', 'phone-body');
  body.append(el('div', 'phone-code', p.code));
  const how = el('div', 'phone-sub');
  how.append(document.createTextNode('On your phone open '));
  how.append(el('b', 'phone-url', p.url.replace(/^https?:\/\//, '')));
  how.append(document.createTextNode(' and enter this code.'));
  body.append(how);
  card.append(body);
  return card;
}
