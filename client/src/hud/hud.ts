/**
 * In-race HUD overlay: position, lap, lap times, speed, draft.
 *
 * DOM rather than canvas — text stays crisp at any resolution, costs no draw
 * calls, and the styling lives in hud.css where it can be adjusted for the
 * projector without touching code.
 *
 * Instance A drives this. It renders what it is told and owns no race logic:
 * call `update()` once per frame with a plain snapshot of what to display.
 * Everything is diffed against the last frame before touching the DOM, so a
 * 60 Hz update loop does not thrash layout.
 */

import { CAR_COLORS } from '../../../shared/constants';
import './hud.css';

export interface HudState {
  /** 1-based race position, or null before the race is running. */
  position: number | null;
  fieldSize: number;
  /** 1-based current lap. */
  lap: number;
  totalLaps: number;
  /** Elapsed time on the current lap, milliseconds. */
  lapTimeMs: number;
  lastLapMs: number | null;
  bestLapMs: number | null;
  /** Whether the last completed lap was a personal best. */
  lastWasBest: boolean;
  speedKph: number;
  drafting: boolean;
}

/** One row of the live leaderboard. */
export interface StandingRow {
  id: number;
  position: number;
  name: string;
  /** Index into CAR_COLORS. */
  color: number;
  lap: number;
  /** Metres behind the leader; 0 for the leader itself. */
  gapLeader: number;
  isSelf: boolean;
}

export function initialHudState(totalLaps: number, fieldSize: number): HudState {
  return {
    position: null,
    fieldSize,
    lap: 1,
    totalLaps,
    lapTimeMs: 0,
    lastLapMs: null,
    bestLapMs: null,
    lastWasBest: false,
    speedKph: 0,
    drafting: false,
  };
}

/** `m:ss.mmm`. Dashes when there is no time yet, so the layout never jumps. */
export function formatLapTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—:——.———';
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export class Hud {
  readonly root: HTMLDivElement;

  private readonly positionValue: HTMLDivElement;
  private readonly lapValue: HTMLDivElement;
  private readonly times: HTMLDivElement;
  private readonly currentTime: HTMLDivElement;
  private readonly lastTime: HTMLElement;
  private readonly bestTime: HTMLElement;
  private readonly speedValue: HTMLDivElement;
  private readonly draft: HTMLDivElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly notice: HTMLDivElement;
  private noticeTimer = 0;
  private readonly banner: HTMLDivElement;
  private readonly board: HTMLDivElement;
  private readonly muteButton: HTMLButtonElement;
  private muted = false;
  /** Called with the new enabled state when the player toggles sound. */
  onMute: ((enabled: boolean) => void) | null = null;
  /** Live row elements by car id, so a 30 Hz update does not rebuild the list. */
  private readonly boardRows = new Map<
    number,
    { row: HTMLElement; pos: HTMLElement; name: HTMLElement; gap: HTMLElement }
  >();

  /** Last rendered values, so update() only touches the DOM on change. */
  private prev: Partial<Record<string, string | boolean>> = {};

  /** Called when the player asks to be put back on the track. */
  onReset: (() => void) | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.root = el('div', 'hud');

    const position = el('div', 'hud-panel hud-position');
    position.append(el('div', 'hud-label', 'Position'));
    this.positionValue = el('div', 'value');
    position.append(this.positionValue);

    const lap = el('div', 'hud-panel hud-lap');
    lap.append(el('div', 'hud-label', 'Lap'));
    this.lapValue = el('div', 'value');
    lap.append(this.lapValue);

    this.times = el('div', 'hud-panel hud-times');
    this.times.append(el('div', 'hud-label', 'Current lap'));
    this.currentTime = el('div', 'current');
    this.times.append(this.currentTime);
    const rows = el('div', 'rows');
    this.lastTime = el('span');
    this.bestTime = el('span');
    rows.append(this.lastTime, this.bestTime);
    this.times.append(rows);

    const speed = el('div', 'hud-panel hud-speed');
    this.speedValue = el('div', 'value');
    speed.append(this.speedValue, el('div', 'unit', 'KM/H'));

    this.draft = el('div', 'hud-draft', 'DRAFT');
    this.banner = el('div', 'hud-banner');

    // Recovery button. A player who has spun into the gravel facing backwards
    // has no way out on a keyboard they are still learning, and the automatic
    // rescue only fires for a car that is inverted or already stationary.
    this.resetButton = document.createElement('button');
    this.resetButton.className = 'hud-reset';
    this.resetButton.type = 'button';
    this.resetButton.textContent = 'Reset car  (R)';
    this.resetButton.addEventListener('click', () => {
      this.onReset?.();
      // The canvas has the keyboard; keeping focus on the button would swallow
      // the next steering input.
      this.resetButton.blur();
    });

    this.notice = el('div', 'hud-notice');

    this.muteButton = el('button', 'hud-mute', 'SOUND ON');
    this.muteButton.type = 'button';
    this.muteButton.addEventListener('click', () => {
      this.muted = !this.muted;
      this.muteButton.textContent = this.muted ? 'SOUND OFF' : 'SOUND ON';
      this.muteButton.classList.toggle('off', this.muted);
      this.onMute?.(!this.muted);
    });

    this.board = el('div', 'hud-panel hud-board');
    this.board.append(el('div', 'hud-label', 'Running order'));
    this.board.hidden = true;

    this.root.append(
      position,
      lap,
      this.times,
      speed,
      this.draft,
      this.resetButton,
      this.notice,
      this.banner,
      this.board,
      this.muteButton,
    );
    parent.append(this.root);
  }

  /** Set `text` on `node` only if it changed since the last frame. */
  private set(key: string, node: HTMLElement, text: string): void {
    if (this.prev[key] === text) return;
    this.prev[key] = text;
    node.textContent = text;
  }

  private toggle(key: string, node: HTMLElement, cls: string, on: boolean): void {
    const k = `${key}:${cls}`;
    if (this.prev[k] === on) return;
    this.prev[k] = on;
    node.classList.toggle(cls, on);
  }

  update(s: HudState): void {
    if (s.position !== null) {
      this.set('pos', this.positionValue, `P${s.position}`);
      // Rebuilt as HTML because the "/ 10" is styled differently; guarded by
      // the same diff so it still only runs when the value changes.
      const of = `${s.position}/${s.fieldSize}`;
      if (this.prev['posOf'] !== of) {
        this.prev['posOf'] = of;
        this.positionValue.innerHTML = `P${s.position}<span class="of"> / ${s.fieldSize}</span>`;
      }
    } else {
      this.set('pos', this.positionValue, '—');
      this.prev['posOf'] = undefined;
    }

    const lapKey = `${s.lap}/${s.totalLaps}`;
    if (this.prev['lap'] !== lapKey) {
      this.prev['lap'] = lapKey;
      this.lapValue.innerHTML = `${Math.min(s.lap, s.totalLaps)}<span class="of"> / ${s.totalLaps}</span>`;
    }

    this.set('cur', this.currentTime, formatLapTime(s.lapTimeMs));
    this.set('last', this.lastTime, `LAST ${formatLapTime(s.lastLapMs)}`);
    this.set('best', this.bestTime, `BEST ${formatLapTime(s.bestLapMs)}`);
    this.toggle('times', this.times, 'is-best', s.lastWasBest);

    this.set('speed', this.speedValue, String(Math.max(0, Math.round(s.speedKph))));
    this.toggle('draft', this.draft, 'on', s.drafting);

  }

  /**
   * Live running order.
   *
   * Rows are kept and mutated rather than rebuilt: this arrives at snapshot
   * rate, and replacing ten rows of DOM thirty times a second is a layout
   * thrash that shows up as stutter on the car, not on the list.
   */
  setStandings(rows: StandingRow[]): void {
    const seen = new Set<number>();

    for (const r of rows) {
      seen.add(r.id);
      let cells = this.boardRows.get(r.id);
      if (!cells) {
        const row = el('div', 'board-row');
        const pos = el('span', 'board-pos');
        const swatch = el('span', 'board-swatch');
        swatch.style.background = `#${(CAR_COLORS[r.color] ?? 0xffffff).toString(16).padStart(6, '0')}`;
        const name = el('span', 'board-name');
        const gap = el('span', 'board-gap');
        row.append(pos, swatch, name, gap);
        cells = { row, pos, name, gap };
        this.boardRows.set(r.id, cells);
        this.board.append(row);
      }
      this.set(`bp${r.id}`, cells.pos, String(r.position));
      this.set(`bn${r.id}`, cells.name, r.name);
      // The leader shows its lap; everyone else shows how far back they are.
      // A gap in metres needs no reference speed to be true.
      this.set(
        `bg${r.id}`,
        cells.gap,
        // `lap` counts laps *completed*, like LapMsg, so the lap being driven
        // is one more — matching the lap counter in the corner.
        r.position === 1
          ? `L${r.lap + 1}`
          : `+${r.gapLeader < 1000 ? Math.round(r.gapLeader) : Math.round(r.gapLeader / 100) / 10 + 'k'}m`,
      );
      this.toggle(`bs${r.id}`, cells.row, 'me', r.isSelf);
      // Order is set by the position, so a car that gains a place slides up
      // without the list being rebuilt around it.
      const order = String(r.position);
      if (this.prev[`bo${r.id}`] !== order) {
        this.prev[`bo${r.id}`] = order;
        cells.row.style.order = order;
      }
    }

    for (const [id, cells] of this.boardRows) {
      if (seen.has(id)) continue;
      cells.row.remove();
      this.boardRows.delete(id);
    }
    this.board.hidden = rows.length === 0;
    // Past a dozen cars the list is long enough that row height matters more
    // than legibility of any single row.
    this.toggle('boardDense', this.board, 'dense', rows.length > 12);
  }

  /**
   * Centre banner: countdown digits, "GO", phase messages, spectator notice.
   *
   * Set explicitly rather than derived from the race state. The caller already
   * owns the phase machine and has to run the countdown down against a local
   * clock — `state` messages only arrive on a transition — so deriving the text
   * here would mean a second, lagging copy of that logic.
   */
  setBanner(text: string, go = false): void {
    this.set('banner', this.banner, text);
    this.toggle('banner', this.banner, 'on', text !== '');
    this.toggle('banner', this.banner, 'go', go);
  }

  /** Hide the racing readouts but keep the banner, for the lobby and spectating. */
  /** A short message that fades itself, for things like a graphics change. */
  setNotice(text: string): void {
    this.notice.textContent = text;
    this.notice.classList.add('on');
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.classList.remove('on'), 4000) as unknown as number;
  }

  /** Shown only while there is a car to recover. */
  setResetVisible(visible: boolean): void {
    this.toggle('reset', this.resetButton, 'on', visible);
  }

  /** Briefly acknowledge, or refuse, a press. */
  flashReset(accepted: boolean): void {
    this.resetButton.classList.remove('accepted', 'refused');
    // Restart the animation rather than letting a second press be swallowed.
    void this.resetButton.offsetWidth;
    this.resetButton.classList.add(accepted ? 'accepted' : 'refused');
  }

  setPanelsVisible(visible: boolean): void {
    this.toggle('panels', this.root, 'panels-hidden', !visible);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  dispose(): void {
    this.root.remove();
  }
}
