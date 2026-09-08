/**
 * The game's UI.
 *
 * Was a minimal placeholder owned by Instance A ("replace it; do not extend
 * it"); this is that replacement. It keeps the exact public API `main.ts`
 * already calls, so none of the netcode wiring changes, and renders through
 * client/src/hud/ instead of ad-hoc divs.
 *
 * Behaviour deliberately carried over from the placeholder, because the netcode
 * depends on it and it is not obvious from the API:
 *
 *   - the phase countdown runs down against a *local* clock. `state` messages
 *     only arrive on a transition, so without this the lobby sits on "Starting
 *     in 25s" and the grid countdown freezes on "5", which reads as a hung
 *     server.
 *   - ready has three states, not two. A `ready` can be lost and is re-sent
 *     until the roster confirms it; showing "confirming" is the difference
 *     between a visible pause and a player who thinks they are in a race the
 *     server has never heard of.
 *   - spectating is a real mode. Arriving mid-race means watching this one
 *     rather than being dropped onto a live circuit.
 *
 * This module owns presentation and the phase timer. It owns no race logic:
 * every value here arrives from the server through main.ts.
 */

import { CAR_COLORS, RACE_LAPS } from '../../shared/constants';
import type { PlayerInfo, RaceState, ResultEntry } from '../../shared/protocol';
import { formatLapTime, Hud, initialHudState, type HudState } from './hud/hud';
import { Screens } from './hud/screens';
import type { PhoneLinkStatus } from './phone-link';
import { controllerUrl } from './phone-link';

/** Kept for compatibility: main.ts and the netcode overlay import this. */
export function formatMs(ms: number | null): string {
  return formatLapTime(ms);
}

export class Ui {
  onJoin: ((name: string, color: number) => void) | null = null;
  onReady: ((ready: boolean) => void) | null = null;

  private readonly hud: Hud;
  private readonly screens: Screens;
  private readonly state: HudState = initialHudState(RACE_LAPS, 0);

  private name = localStorage.getItem('driverName') ?? '';
  private chosenColor = Math.floor(Math.random() * CAR_COLORS.length);

  private players: PlayerInfo[] = [];
  private myId = -1;

  private readyIntent = false;
  private readyConfirmed: boolean | null = null;
  private spectating = false;
  /** True once the player has pressed Join, so the join screen is behind us. */
  private joined = false;

  private phoneStatus: PhoneLinkStatus = 'connecting';
  private phoneCode: string | null = null;

  private phase: RaceState = 'lobby';
  /** Local wall-clock deadline for the current phase, or 0 for no timer. */
  private deadline = 0;
  /** When the current lap started, for the running lap clock. 0 = not racing. */
  private lapStart = 0;

  constructor(parent: HTMLElement = document.body) {
    this.hud = new Hud(parent);
    this.screens = new Screens(parent);
    this.hud.setPanelsVisible(false);
  }

  // --- Lobby ---------------------------------------------------------------

  /** Pre-connect. Shown once at startup, before there is a socket. */
  showLobby(): void {
    this.screens.showJoin({
      name: this.name,
      color: this.chosenColor,
      phone: this.phonePairing(),
      onJoin: (name, color) => {
        this.joined = true;
        this.name = name;
        this.chosenColor = color;
        localStorage.setItem('driverName', name);
        this.onJoin?.(name, color);
      },
    });
  }

  /**
   * Pairing state for the phone controller, shown on the join and lobby
   * screens. Repaints only while one of those is up — mid-race a phone
   * reconnecting must not rebuild a card over the track.
   */
  setPhoneLink(status: PhoneLinkStatus, code: string | null): void {
    if (status === this.phoneStatus && code === this.phoneCode) return;
    this.phoneStatus = status;
    this.phoneCode = code;
    if (this.joined) {
      if (this.phase === 'lobby' || this.spectating) this.paintLobby();
    } else {
      this.showLobby();
    }
  }

  private phonePairing(): { status: PhoneLinkStatus; code: string | null; url: string } {
    return { status: this.phoneStatus, code: this.phoneCode, url: controllerUrl() };
  }

  showRoster(players: PlayerInfo[], myId: number): void {
    this.players = players;
    this.myId = myId;
    this.state.fieldSize = players.length;

    const me = players.find((p) => p.id === myId);
    if (me) this.chosenColor = me.color;

    // The roster is the lobby view. During a race it is only shown to a
    // spectator waiting for the next one.
    if (this.phase === 'lobby' || this.spectating) this.paintLobby();
  }

  private paintLobby(): void {
    this.screens.showLobby({
      players: this.players,
      selfId: this.myId,
      selfColor: this.chosenColor,
      phone: this.phonePairing(),
      ready: this.readyIntent,
      readyPending: this.readyConfirmed !== this.readyIntent,
      joinHint: location.host,
      onReady: (ready) => this.onReady?.(ready),
      // Colour is chosen before joining; the server assigns on `hello` and may
      // reassign, so it is not changeable from the lobby.
      onColor: () => undefined,
    });
  }

  setReadyState(intent: boolean, confirmed: boolean | null): void {
    if (intent === this.readyIntent && confirmed === this.readyConfirmed) return;
    this.readyIntent = intent;
    this.readyConfirmed = confirmed;
    if (this.phase === 'lobby' || this.spectating) this.paintLobby();
  }

  // --- Phase ---------------------------------------------------------------

  setState(state: RaceState, timer: number | null): void {
    this.phase = state;
    this.deadline = timer === null ? 0 : Date.now() + timer * 1000;

    switch (state) {
      case 'lobby':
        this.spectating = false;
        this.joined = true;
        this.readyIntent = false;
        this.readyConfirmed = false;
        this.lapStart = 0;
        this.resetLapTimes();
        this.hud.setPanelsVisible(false);
        this.hud.setBanner('');
        this.paintLobby();
        break;

      case 'grid':
        this.spectating = false;
        this.screens.hide();
        this.hud.setPanelsVisible(true);
        this.hud.setBanner('FORM UP');
        break;

      case 'countdown':
        this.screens.hide();
        this.hud.setPanelsVisible(true);
        this.hud.setBanner(timer === null ? 'GET READY' : String(Math.ceil(timer)));
        break;

      case 'racing':
        this.screens.hide();
        this.hud.setPanelsVisible(true);
        this.hud.setBanner('GO', true);
        this.lapStart = Date.now();
        // Clear it rather than leaving "GO" over the first corner.
        setTimeout(() => {
          if (this.phase === 'racing') this.hud.setBanner('');
        }, 1200);
        break;

      case 'finished':
        this.hud.setBanner('');
        this.lapStart = 0;
        break;
    }
  }

  /**
   * Refresh the phase deadline without re-running the transition.
   *
   * The server repeats the current state once a second so a lost transition
   * heals itself. Re-running setState on those repeats would restart the "GO"
   * banner every second; the timer is still worth taking, because it re-anchors
   * a countdown that has been running off a local clock.
   */
  syncTimer(state: RaceState, timer: number | null): void {
    if (state !== this.phase) return;
    this.deadline = timer === null ? 0 : Date.now() + timer * 1000;
  }

  /** Run the phase countdown and the lap clock. Call once per rendered frame. */
  tick(): void {
    if (this.lapStart > 0 && this.phase === 'racing') {
      this.state.lapTimeMs = Date.now() - this.lapStart;
    }
    this.hud.update(this.state);

    if (this.deadline === 0 || this.spectating) return;
    const left = Math.max(0, (this.deadline - Date.now()) / 1000);

    if (this.phase === 'countdown') {
      this.hud.setBanner(left > 0.05 ? String(Math.ceil(left)) : 'GO', left <= 0.05);
    } else if (this.phase === 'lobby') {
      this.hud.setBanner('');
      if (left <= 0) this.deadline = 0;
    }
  }

  // --- Race readouts -------------------------------------------------------

  setPosition(position: number | null, of: number): void {
    this.state.position = position;
    this.state.fieldSize = of;
  }

  /**
   * Shown when the server is running a race this client is not in. Arriving
   * mid-race, or not readying up in time, means watching this one — which is a
   * far better experience than being dropped onto a live circuit.
   */
  setSpectating(on: boolean, cars: number): void {
    if (on === this.spectating) return;
    this.spectating = on;
    if (on) {
      this.hud.setPanelsVisible(false);
      this.hud.setBanner('');
      this.screens.showMessage(
        'Race in progress',
        `${cars} cars on track. You are in the next one — ready up and watch.`,
      );
    } else {
      this.screens.hide();
      this.hud.setPanelsVisible(true);
    }
  }

  /**
   * `lap` is the lap just completed, 0-based, matching LapMsg. The HUD shows
   * the lap now being driven, which is one more, clamped to the race distance.
   */
  setLap(lap: number, total: number, lapMs: number, bestMs: number): void {
    this.state.lap = Math.min(lap + 1, total);
    this.state.totalLaps = total;
    this.state.lastLapMs = lapMs;
    this.state.lastWasBest = Number.isFinite(bestMs) && lapMs <= bestMs;
    this.state.bestLapMs = Number.isFinite(bestMs) ? bestMs : null;
    this.lapStart = Date.now();
  }

  /** Wired by main.ts; also reachable from the R key. */
  set onReset(fn: (() => void) | null) {
    this.hud.onReset = fn;
  }

  setResetVisible(on: boolean): void {
    this.hud.setResetVisible(on);
  }

  flashReset(accepted: boolean): void {
    this.hud.flashReset(accepted);
  }

  setSpeed(kmh: number): void {
    this.state.speedKph = kmh;
  }

  /** Set by main.ts when a slipstream is detected. Optional; defaults off. */
  setDrafting(on: boolean): void {
    this.state.drafting = on;
  }

  private resetLapTimes(): void {
    this.state.lap = 1;
    this.state.lapTimeMs = 0;
    this.state.lastLapMs = null;
    this.state.bestLapMs = null;
    this.state.lastWasBest = false;
    this.state.position = null;
  }

  // --- End states ----------------------------------------------------------

  showResults(results: ResultEntry[], myId: number): void {
    this.hud.setPanelsVisible(false);
    this.hud.setBanner('');
    this.screens.showResults(results, myId);
  }

  showDisconnected(reason: string): void {
    this.hud.setPanelsVisible(false);
    this.hud.setBanner('');
    this.screens.showMessage('Disconnected', reason, () => location.reload());
  }
}
