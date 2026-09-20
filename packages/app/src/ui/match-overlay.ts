// Full-screen overlay for the two moments a player must not be left
// guessing what happened or what to do next: elimination ("you're out,
// here's exactly what happens if you click") and a lost connection
// ("here's what happened, here's how to try again"). Replaces a silent
// black canvas or a small corner-chip-only state with something a
// first-time player can actually read and act on.
//
// Deliberately not a takeover of the whole page forever -- callers hide()
// it the moment the situation resolves (reconnected, new match joined).
export interface MatchOverlayAction {
  label: string;
  onClick: () => void;
  /** 'primary' (amber, the expected next click) or 'plain' (quiet text
   * link, an alternative). Defaults to 'primary'. */
  kind?: 'primary' | 'plain';
  /** When set, this action fires on its own after this many seconds and
   * its label counts down so the player can see it coming. Added
   * 2026-09-19: 71% of real sessions end at the player's own
   * elimination, median in-match time 31s, while the button that would
   * have given them another match sat there unpressed. Any other action
   * on the overlay cancels the countdown. */
  autoAfterSec?: number;
}

export interface MatchOverlayContent {
  /** Small label above the title, e.g. "ELIMINATED" or "CONNECTION LOST".
   * Kept short and plain -- not a decorative eyebrow, an actual status
   * word the player needs. */
  kicker?: string;
  title: string;
  message: string;
  actions: MatchOverlayAction[];
  /** 'default' | 'danger' -- danger tints the kicker/accent red for a
   * genuine failure (lost connection) vs the neutral/amber tone used for
   * a normal in-game event (elimination). */
  tone?: 'default' | 'danger';
}

/** Slot label for the winner line in announceWinner, matching the HUD's
 * own '#' + (slot + 1) convention (packages/app/src/ui/hud.ts). */
function slotLabel(slot: number): string {
  return `#${slot + 1}`;
}

/** Pure text logic for announceWinner, split out so it has regression
 * coverage without needing a DOM (see match-overlay.test.ts) -- this is
 * the part that was actually wrong (missing entirely) in the 2026-09-10
 * stranded-spectator bug, not the DOM plumbing around it. */
/** The clause offering to keep watching the match. Once the match has
 * ended that offer is false, so announceWinner strips it back out --
 * which only works if callers use this exact constant to build the
 * message. Seen live on production 2026-09-11: an eliminated player's
 * overlay said "or keep watching this one play out" directly above a
 * single "Play again" button, the Keep spectating action having correctly
 * been removed. */
export const SPECTATE_OFFER = ', or keep watching this one play out';

/** Rewrites an eliminated-player message for a match that has ended:
 * the offer to keep watching no longer applies. Pure, so it is covered
 * by match-overlay.test.ts. */
export function messageAfterMatchEnd(message: string): string {
  if (!message.includes(SPECTATE_OFFER)) return message;
  return message.replace(SPECTATE_OFFER, '');
}

export function winnerAnnouncementLine(
  winnerSlot: number | null,
  localSlot: number | null | undefined,
  nameFor?: (slot: number) => string,
): string {
  if (winnerSlot == null) return 'The match ended with no winner.';
  if (localSlot != null && localSlot === winnerSlot) return 'The match ended -- you won it!';
  const label = nameFor ? nameFor(winnerSlot) : slotLabel(winnerSlot);
  return `The match ended -- ${label} won.`;
}

/** Label for an action that is counting itself down, e.g.
 * "Play again (8)". Pure so the wording has coverage without a DOM. */
export function countdownLabel(base: string, secondsLeft: number): string {
  if (secondsLeft <= 0) return base;
  return `${base} (${secondsLeft})`;
}

export class MatchOverlay {
  readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly kickerEl: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly messageEl: HTMLDivElement;
  private readonly actionsEl: HTMLDivElement;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'match-overlay';
    this.root.className = 'match-overlay hidden';
    this.root.innerHTML = `
      <div class="match-overlay-panel">
        <div class="match-overlay-kicker"></div>
        <div class="match-overlay-title"></div>
        <div class="match-overlay-message"></div>
        <div class="match-overlay-actions"></div>
      </div>
    `;
    this.panel = this.root.querySelector('.match-overlay-panel') as HTMLDivElement;
    this.kickerEl = this.root.querySelector('.match-overlay-kicker') as HTMLDivElement;
    this.titleEl = this.root.querySelector('.match-overlay-title') as HTMLDivElement;
    this.messageEl = this.root.querySelector('.match-overlay-message') as HTMLDivElement;
    this.actionsEl = this.root.querySelector('.match-overlay-actions') as HTMLDivElement;
    parent.appendChild(this.root);
  }

  show(content: MatchOverlayContent): void {
    this.kickerEl.textContent = content.kicker ?? '';
    this.kickerEl.classList.toggle('hidden', !content.kicker);
    this.titleEl.textContent = content.title;
    this.messageEl.textContent = content.message;
    this.panel.dataset.tone = content.tone ?? 'default';
    this.cancelCountdown();
    this.actionsEl.innerHTML = '';
    for (const action of content.actions) {
      const btn = document.createElement('button');
      btn.className = action.kind === 'plain' ? 'btn btn-plain' : 'btn btn-primary';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        this.cancelCountdown();
        action.onClick();
      });
      this.actionsEl.appendChild(btn);
      if (action.autoAfterSec && action.autoAfterSec > 0) {
        this.startCountdown(btn, action);
      }
    }
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.cancelCountdown();
    this.root.classList.add('hidden');
  }

  private startCountdown(btn: HTMLButtonElement, action: MatchOverlayAction): void {
    let left = Math.ceil(action.autoAfterSec as number);
    btn.textContent = countdownLabel(action.label, left);
    this.countdownTimer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        btn.textContent = countdownLabel(action.label, left);
        return;
      }
      this.cancelCountdown();
      btn.textContent = action.label;
      action.onClick();
    }, 1000);
  }

  private cancelCountdown(): void {
    if (this.countdownTimer === null) return;
    clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  /** 2026-09-10: a spectator who was already eliminated (their own
   * placement overlay from onEliminated) must still be told who won once
   * the match genuinely resolves -- "no terminal state may leave the
   * player with nothing to say happened" applies to them too, even if
   * they clicked "Keep spectating" and dismissed the overlay. Appends the
   * winner line to whatever message is already showing (or re-shows the
   * overlay with just the winner line if it had been dismissed) without
   * keeping their "Play again" action and dropping "Keep spectating",
   * which is meaningless once the match is over. Safe to call multiple times. */
  announceWinner(
    winnerSlot: number | null,
    localSlot: number | null | undefined,
    nameFor?: (slot: number) => string,
  ): void {
    const already = this.messageEl.dataset.winnerAnnounced === String(winnerSlot);
    if (already) return;
    const line = winnerAnnouncementLine(winnerSlot, localSlot, nameFor);
    const base = messageAfterMatchEnd(this.messageEl.textContent ?? '');
    this.messageEl.textContent = `${base} ${line}`.trim();
    this.messageEl.dataset.winnerAnnounced = String(winnerSlot);
    // Once the match has genuinely ended there is nothing left to spectate,
    // so a "Keep spectating" action would dismiss the overlay into a frozen
    // final frame with no way back. Drop it and leave "Play again" alone.
    for (const btn of Array.from(this.actionsEl.querySelectorAll('button'))) {
      if (btn.textContent === 'Keep spectating') btn.remove();
    }
    // The match has resolved, so stop any auto-requeue countdown: the
    // action that would have cancelled it ("Keep spectating") has just
    // been removed, and yanking the player out of the winner
    // announcement they cannot opt out of would be a trap.
    this.cancelCountdown();
    for (const btn of Array.from(this.actionsEl.querySelectorAll('button'))) {
      const stripped = btn.textContent?.replace(/\s*\(\d+\)$/, '');
      if (stripped && stripped !== btn.textContent) btn.textContent = stripped;
    }
    this.root.classList.remove('hidden');
  }

  get isVisible(): boolean {
    return !this.root.classList.contains('hidden');
  }
}
