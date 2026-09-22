// The first thing a new player sees after clicking "Play online" and
// before their lobby fills: previously nothing but the game's canvas
// (plain black) with two small connection chips in the bottom-left
// corner -- no game name, no sense of what mode they're about to play,
// no idea what the controls even are. This gives that wait a deliberate,
// restrained composition instead: name, mode, a live countdown to match
// start, one plain-language line explaining bots fill empty seats so a
// match always starts, a "Start now" control for the impatient, and the
// control-hint line demoted below all of that. It sits above the (still
// black) canvas and below the small connection chips, which keep their
// own always-on positions for every other connection state.
//
// 2026-09-13: real players from the first outside traffic (a Lemmy post)
// were quitting within seconds of reaching this screen -- production logs
// showed endReason "abandoned_by_humans" with duration 0.0s/0.0s/21.2s/
// 54.8s and the human never eliminated. The old screen showed only name,
// mode and "1 / 20 players" with no countdown and no explanation, which
// reads as an empty, broken server to a first-time visitor. This is the
// fix: an honest countdown (falls back to an indeterminate state if the
// server hasn't told us a deadline yet, never a fake timer), the bots/
// other-humans explanation, and Start now.
import { copyToClipboard } from '../join-link.ts';

export class WaitingScreen {
  // 3-2-1-GO, not 5-4-3-2-1 as the player literally asked for: a casual
  // browser match should not make someone wait out a five-second ritual
  // every single lobby. 3 whole seconds of big digits is enough to be
  // unmistakable without feeling slow.
  private static readonly FINAL_COUNTDOWN_SECONDS = 3;
  readonly root: HTMLDivElement;
  private readonly modeLine: HTMLDivElement;
  private readonly countdownLine: HTMLDivElement;
  private readonly countLine: HTMLDivElement;
  private readonly startBtn: HTMLButtonElement;
  // Ticks remaining as of the last server lobby message, and the local
  // wall-clock time (Date.now()) that message was received at. Between
  // messages we keep the countdown display live by subtracting elapsed
  // real time from this baseline, rather than freezing on a stale number
  // until the next broadcast (server only re-broadcasts every ~1s, or on
  // the next join/elimination) -- see server/src/rooms.ts's displayTicker.
  private lastServerTicks = -1;
  private lastServerAt = 0;
  private tickHandle: number | null = null;
  // True between "Play online" being clicked and the server's first
  // lobby message. See showConnecting().
  private connecting = false;
  private spectating = false;

  constructor(parent: HTMLElement, touchCapable: boolean, onStartNow: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'waiting-screen hidden';
    this.root.id = 'waiting-screen';
    // Found in the phone-width pass, 2026-09-12: this line always read
    // the keyboard bindings ("Move with A/D...") even when forceTouch (or
    // a real touch device) meant the player has no keyboard at all and
    // will only ever see the on-screen stick/buttons -- instructions for
    // controls that cannot be pressed. Same touchCapable check main.ts
    // already uses to decide whether to show TouchControls at all.
    const hint = touchCapable
      ? 'Move with the on-screen stick, attack, special and shield with the buttons beside it.'
      : 'Move with A/D, jump with Space, attack with F, special with G, shield with LShift. Press M any time for the full move list.';
    this.root.innerHTML = `
      <div class="waiting-wordmark">BASH FIGHTER</div>
      <div class="waiting-mode" id="waiting-mode"></div>
      <div class="waiting-countdown" id="waiting-countdown">Waiting for players&hellip;</div>
      <div class="waiting-count" id="waiting-count"></div>
      <div class="waiting-explain" id="waiting-explain">Empty seats fill with bots, so a match always starts. Other players join this same lobby when they're around.</div>
      <div class="waiting-share hidden" id="waiting-share">
        <div class="waiting-share-label">Send this link to your friends</div>
        <div class="waiting-share-row">
          <span class="waiting-share-link" id="waiting-share-link"></span>
          <button type="button" class="btn btn-plain" id="waiting-share-copy">Copy link</button>
        </div>
        <div class="waiting-explain">Waiting for friends. Bots fill the rest in 60 seconds.</div>
      </div>
      <button type="button" class="waiting-start-btn" id="waiting-start-btn">Start now</button>
      <div class="waiting-hint" id="waiting-hint"></div>
    `;
    parent.appendChild(this.root);
    this.modeLine = this.root.querySelector('#waiting-mode') as HTMLDivElement;
    this.countdownLine = this.root.querySelector('#waiting-countdown') as HTMLDivElement;
    this.countLine = this.root.querySelector('#waiting-count') as HTMLDivElement;
    this.startBtn = this.root.querySelector('#waiting-start-btn') as HTMLButtonElement;
    // textContent, not innerHTML -- consistent with every other
    // player-facing string in this file even though this one is static.
    (this.root.querySelector('#waiting-hint') as HTMLDivElement).textContent = hint;
    const shareCopyBtn = this.root.querySelector('#waiting-share-copy') as HTMLButtonElement;
    shareCopyBtn.addEventListener('click', () => {
      const link = (this.root.querySelector('#waiting-share-link') as HTMLSpanElement).textContent ?? '';
      void copyToClipboard(link).then((ok) => {
        if (!ok) return;
        shareCopyBtn.textContent = 'Copied';
        window.setTimeout(() => {
          shareCopyBtn.textContent = 'Copy link';
        }, 2000);
      });
    });
    this.startBtn.addEventListener('click', () => {
      // Disabled, not hidden, right after the click: the server may take
      // a tick or two to actually start the match, and repeat clicks must
      // stay harmless (the server-side handler is idempotent too), but a
      // player who just clicked should see it registered immediately
      // rather than being able to mash it.
      this.startBtn.disabled = true;
      onStartNow();
    });
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.startBtn.disabled = false;
    if (this.spectating) this.startBtn.classList.add('hidden');
    if (this.tickHandle === null) {
      this.tickHandle = window.setInterval(() => this.renderCountdown(), 250);
    }
  }

  /** 2026-09-14, found by playing production: clicking "Play online"
   * left a COMPLETELY black screen -- no wordmark, no words, nothing but
   * a 12px "Connecting..." chip in the far bottom-left corner -- until
   * the server's first lobby message arrived. The composed waiting screen
   * only appeared on state 'waiting', so the one second a first-time
   * player is most likely to read as "this is broken" was the one second
   * we showed them nothing. Now the same composition appears immediately,
   * honestly labelled: no player count and no "Start now" (there is no
   * lobby to start yet), and no invented countdown. */
  showConnecting(): void {
    this.connecting = true;
    this.countLine.textContent = '';
    this.startBtn.classList.add('hidden');
    this.setMode(undefined);
    this.show();
  }

  hide(): void {
    this.connecting = false;
    this.root.classList.add('hidden');
    if (this.tickHandle !== null) {
      window.clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** modeName is the same plain-language string the lobby chip already
   * shows (e.g. "Battle Royale — last fighter standing wins"). */
  /** Shows the share-link panel in place of the normal bots-fill-in
   *  explanation, for the host of a "Play with a friend" lobby -- link
   *  is null to hide it again (e.g. a later match that was not started
   *  via a friend link). */
  setShareLink(link: string | null): void {
    const share = this.root.querySelector('#waiting-share') as HTMLDivElement;
    const explain = this.root.querySelector('#waiting-explain') as HTMLDivElement;
    if (link) {
      (this.root.querySelector('#waiting-share-link') as HTMLSpanElement).textContent = link;
      share.classList.remove('hidden');
      explain.classList.add('hidden');
    } else {
      share.classList.add('hidden');
      explain.classList.remove('hidden');
    }
  }

  /** A spectator (?watch=CODE, welcome.slot < 0) holds no seat, so the
   *  host-only parts of this screen are wrong for them: found on
   *  production 2026-09-22, a watcher was shown the share link, "Copy
   *  link" and a "Start now" button that would have started someone
   *  else's match. They get an honest "Spectating" line instead, and no
   *  controls at all. */
  setSpectating(spectating: boolean): void {
    this.spectating = spectating;
    if (!spectating) return;
    this.setShareLink(null);
    (this.root.querySelector('#waiting-explain') as HTMLDivElement).textContent =
      'Spectating. The match begins when the lobby fills or its host starts it.';
    this.startBtn.classList.add('hidden');
  }

  setMode(modeName: string | undefined): void {
    this.modeLine.textContent = modeName ?? '';
    this.modeLine.classList.toggle('hidden', !modeName);
  }

  /** countdownTicks is the server's `lobby` message field: ticks (60/s)
   *  until the match starts anyway, covering both the post-minimum
   *  countdown and the lone-player bot-fill grace period (whichever is
   *  sooner), or -1 if the server hasn't told us a deadline yet. -1 is
   *  shown as an honest indeterminate "waiting" state, never a fake
   *  timer -- a deadline the server will not actually honour must never
   *  be invented client-side. */
  setCount(players: number, capacity: number, countdownTicks: number): void {
    // The first lobby message ends the connecting state: there is a real
    // lobby now, so the count and "Start now" become meaningful again.
    this.connecting = false;
    if (!this.spectating) this.startBtn.classList.remove('hidden');
    this.countLine.textContent = `${players} / ${capacity} players`;
    this.lastServerTicks = countdownTicks;
    this.lastServerAt = Date.now();
    this.renderCountdown();
  }

  private renderCountdown(): void {
    if (this.connecting) {
      this.countdownLine.textContent = 'Connecting to the match server\u2026';
      this.countdownLine.classList.remove('waiting-countdown-active', 'waiting-countdown-big');
      return;
    }
    if (this.lastServerTicks < 0) {
      this.countdownLine.textContent = 'Waiting for players\u2026';
      this.countdownLine.classList.remove('waiting-countdown-active', 'waiting-countdown-big');
      return;
    }
    const elapsedTicks = ((Date.now() - this.lastServerAt) / 1000) * 60;
    const ticksLeft = Math.max(0, this.lastServerTicks - elapsedTicks);
    const secondsLeft = Math.ceil(ticksLeft / 60);
    // 2026-09-15, prompted by two real players independently asking for
    // a "3 2 1 GO" at match start: the last few seconds are the one
    // moment worth making visually dominant rather than a text line
    // among other text lines. FINAL_COUNTDOWN_SECONDS caps how long that
    // big-digit state can show -- a five-second wait before a casual
    // browser match reads as slow, so this is deliberately shorter than
    // the player's own suggestion of 5-4-3-2-1. Still entirely driven by
    // the server's real countdownTicks; ticksLeft hitting 0 here means
    // the server is about to actually start the match, not that a
    // client-invented timer ran out.
    if (secondsLeft > 0 && secondsLeft <= WaitingScreen.FINAL_COUNTDOWN_SECONDS) {
      this.countdownLine.textContent = String(secondsLeft);
      this.countdownLine.classList.add('waiting-countdown-active', 'waiting-countdown-big');
      return;
    }
    if (secondsLeft <= 0) {
      this.countdownLine.textContent = 'GO';
      this.countdownLine.classList.add('waiting-countdown-active', 'waiting-countdown-big');
      return;
    }
    this.countdownLine.textContent = `Match starts in ${secondsLeft}s`;
    this.countdownLine.classList.remove('waiting-countdown-big');
    this.countdownLine.classList.add('waiting-countdown-active');
  }
}
