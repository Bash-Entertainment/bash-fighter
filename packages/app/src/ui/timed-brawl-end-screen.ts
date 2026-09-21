// End-of-match screen for Timed Brawl: standings by score, not the
// placement/"last one standing" language WinScreen uses for Battle
// Royale. Kept as a separate component rather than branching inside
// WinScreen -- the two modes end matches on fundamentally different
// axes (elimination order vs running score) and forcing one component
// to speak both makes neither reading clear. Same voice, same "screen"
// shell, same one-button way forward as WinScreen and MatchOverlay.
import { PALETTE } from '@bash-fighter/render';
import { AutoContinue } from './auto-continue.ts';
import { buildStandings, placementOf, tiedHeadline, type TimedBrawlScore } from '../timed-brawl.ts';

const PLAYER_HEX = PALETTE.playerColors.map((c) => `#${c.toString(16).padStart(6, '0')}`);

export class TimedBrawlEndScreen {
  readonly root: HTMLDivElement;
  private readonly headline: HTMLDivElement;
  private readonly winnerSwatch: HTMLSpanElement;
  private readonly subtitle: HTMLDivElement;
  private readonly list: HTMLDivElement;

  /** Set by main.ts: only an online match should roll into another one
   * on its own; the local harness is something the player chose to open. */
  autoContinueEnabled = false;
  private readonly autoContinue!: AutoContinue;
  private readonly onRematch: () => void;
  private lastResult: 'won' | 'lost' | 'tied' = 'tied';

  // Same feedback block as WinScreen (see feedback-panel.ts, 2026-09-13):
  // this is the Timed Brawl equivalent of "the moment a player has an
  // opinion", so it gets the identical prominent-but-not-pushy treatment.
  constructor(parent: HTMLElement, onRematch: () => void, onOpenFeedback?: (result: string) => void) {
    this.root = document.createElement('div');
    this.root.className = 'screen hidden';
    this.root.id = 'timed-brawl-end-screen';
    this.root.innerHTML = `
      <div class="win-headline"><span class="tb-winner-swatch" id="tb-winner-swatch"></span><span id="tb-headline">&mdash;</span></div>
      <div class="subtitle" id="tb-subtitle">Time's up.</div>
      <div class="tb-standings" id="tb-standings"></div>
      <button class="btn btn-primary" id="tb-rematch-btn">Play again</button>
      <div class="feedback-end-screen-block">
        <div class="feedback-end-screen-copy">Got a minute? Tell us what felt off.</div>
        <button type="button" class="feedback-link-btn" id="tb-feedback-btn">Feedback</button>
      </div>
    `;
    parent.appendChild(this.root);
    this.headline = this.root.querySelector('#tb-headline') as HTMLDivElement;
    this.winnerSwatch = this.root.querySelector('#tb-winner-swatch') as HTMLSpanElement;
    this.subtitle = this.root.querySelector('#tb-subtitle') as HTMLDivElement;
    this.list = this.root.querySelector('#tb-standings') as HTMLDivElement;
    const rematchBtn = this.root.querySelector('#tb-rematch-btn') as HTMLButtonElement;
    rematchBtn.addEventListener('click', () => {
      this.autoContinue.cancel();
      onRematch();
    });
    this.autoContinue = new AutoContinue(this.root, rematchBtn);
    this.onRematch = onRematch;
    (this.root.querySelector('#tb-feedback-btn') as HTMLButtonElement).addEventListener('click', () =>
      onOpenFeedback?.(this.lastResult),
    );
  }

  /**
   * @param winnerSlot slot of the highest-scoring fighter, or null for a
   *   genuine tie at the top (see Sim.getWinner's 'timedKO' branch).
   * @param leaderboard slots best-to-worst, from the sim/server -- the
   *   single source of truth for placement (see buildStandings).
   * @param scores every fighter's final koCount/deathCount.
   * @param localSlot the slot this client played, when known.
   */
  show(
    winnerSlot: number | null,
    leaderboard: readonly number[],
    scores: readonly TimedBrawlScore[],
    localSlot?: number,
    nameFor?: (slot: number) => string,
  ): void {
    const standings = buildStandings(leaderboard, scores);
    const won = localSlot !== undefined && localSlot !== null && localSlot >= 0 && localSlot === winnerSlot;
    // Deliberately no per-fighter colour on the headline itself -- keep
    // the normal neutral-ink/accent-border treatment .win-headline
    // already has (see style.css) rather than a huge block of whatever
    // colour the winner happens to be, which can land on something as
    // loud as magenta. Winner identity is instead signalled with a
    // small colour swatch next to their name, same idea as the thin
    // per-fighter left border on every standings row.
    this.headline.style.color = '';
    this.headline.style.borderBottomColor = '';
    this.winnerSwatch.style.display = 'none';
    if (winnerSlot === null) {
      // Naming the tied leaders matters: playing this at phone width I
      // finished 20th of 20 with no knockouts and the headline still
      // read "tied for first", which at a glance says I tied for first.
      // The subtitle below corrects it, but the biggest text on the
      // screen should never be the wrong answer to "how did I do?".
      this.headline.textContent = tiedHeadline(standings, localSlot, nameFor);
    } else {
      const colour = PLAYER_HEX[winnerSlot % PLAYER_HEX.length] as string;
      const label = nameFor ? nameFor(winnerSlot) : `#${winnerSlot + 1}`;
      this.headline.textContent = won ? 'You win' : `${label} won`;
      this.winnerSwatch.style.background = colour;
      this.winnerSwatch.style.display = 'inline-block';
    }
    const myPlacement = localSlot !== undefined && localSlot !== null && localSlot >= 0 ? placementOf(standings, localSlot) : null;
    this.subtitle.textContent =
      myPlacement !== null ? `You finished ${myPlacement} of ${standings.length} on knockouts.` : 'Highest knockout count wins.';
    this.lastResult = winnerSlot === null ? 'tied' : won ? 'won' : 'lost';

    this.list.innerHTML = '';
    for (const row of standings) {
      const el = document.createElement('div');
      el.className = 'tb-standing-row';
      el.classList.toggle('is-you', row.slot === localSlot);
      el.style.borderLeftColor = PLAYER_HEX[row.slot % PLAYER_HEX.length] as string;
      const label = nameFor ? nameFor(row.slot) : '';
      // textContent, never innerHTML, for the name -- same rule as
      // hud.ts -- a player-chosen display name must never be interpreted
      // as markup here regardless of what the server already sanitised
      // (see Player Names on the wiki).
      const placeEl = document.createElement('span');
      placeEl.className = 'tb-place';
      placeEl.textContent = String(row.place);
      const nameEl = document.createElement('span');
      nameEl.className = 'tb-name';
      nameEl.textContent = label && label.length > 0 ? label : `#${row.slot + 1}`;
      const scoreEl = document.createElement('span');
      scoreEl.className = 'tb-score';
      scoreEl.textContent = `${row.koCount} KO · ${row.deathCount} D`;
      el.appendChild(placeEl);
      el.appendChild(nameEl);
      el.appendChild(scoreEl);
      this.list.appendChild(el);
    }
    this.root.classList.remove('hidden');
    if (this.autoContinueEnabled) this.autoContinue.start(this.onRematch);
    document.body.classList.add('end-screen-open');
  }

  hide(): void {
    this.autoContinue.cancel();
    this.root.classList.add('hidden');
    document.body.classList.remove('end-screen-open');
  }

  get isVisible(): boolean {
    return !this.root.classList.contains('hidden');
  }
}
