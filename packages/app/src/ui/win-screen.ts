// Win screen: names the winner and offers one obvious way back into a
// match. Deliberately written in the same voice as the elimination
// overlay -- a player who has just lost and a player who has just won
// should not feel like they are looking at two different games.
import { PALETTE } from '@bash-fighter/render';
import { AutoContinue } from './auto-continue.ts';
import { copyToClipboard } from '../join-link.ts';

const PLAYER_HEX = PALETTE.playerColors.map((c) => `#${c.toString(16).padStart(6, '0')}`);

export class WinScreen {
  readonly root: HTMLDivElement;
  private readonly headline: HTMLDivElement;
  private readonly subtitle: HTMLDivElement;
  /** Set by main.ts: only an online match should roll into another one
   * on its own; the local harness is something the player chose to open. */
  autoContinueEnabled = false;
  private readonly autoContinue!: AutoContinue;
  private readonly onRematch: () => void;
  private lastResult: 'won' | 'eliminated' | 'no_survivor' = 'no_survivor';
  private inviteLink: string | null = null;
  private onInviteCopied: (() => void) | undefined;

  /** Same shareable-lobby-link code as the waiting screen (see
   *  join-link.ts) -- lets a group stay together into their next match.
   *  null hides the button (this match was not a coded lobby). */
  setInviteLink(link: string | null, onCopy?: () => void): void {
    this.inviteLink = link;
    // Only a real copy commits this client to the private lobby behind the
    // link -- see nextMatchInviteLink in main.ts.
    this.onInviteCopied = onCopy;
    (this.root.querySelector('#win-invite-btn') as HTMLButtonElement).classList.toggle('hidden', !link);
  }

  // Feedback block for the moment a player has just formed an opinion
  // (2026-09-13, see feedback-panel.ts) -- prominent but not pushy: a
  // plain text line under the existing Play again button, not a second
  // modal popped over the result.
  constructor(parent: HTMLElement, onRematch: () => void, onOpenFeedback?: (result: string) => void) {
    this.root = document.createElement('div');
    this.root.className = 'screen hidden';
    this.root.id = 'win-screen';
    this.root.innerHTML = `
      <div class="win-headline" id="win-headline">&mdash;</div>
      <div class="subtitle" id="win-subtitle">Match over.</div>
      <button class="btn btn-primary" id="rematch-btn">Play again</button>
      <div class="feedback-end-screen-block">
        <div class="feedback-end-screen-copy">Got a minute? Tell us what felt off.</div>
        <button type="button" class="feedback-link-btn" id="win-feedback-btn">Feedback</button>
      </div>
      <button type="button" class="btn btn-plain hidden" id="win-invite-btn">Copy invite link</button>
    `;
    parent.appendChild(this.root);
    this.headline = this.root.querySelector('#win-headline') as HTMLDivElement;
    this.subtitle = this.root.querySelector('#win-subtitle') as HTMLDivElement;
    const rematchBtn = this.root.querySelector('#rematch-btn') as HTMLButtonElement;
    rematchBtn.addEventListener('click', () => {
      this.autoContinue.cancel();
      onRematch();
    });
    this.autoContinue = new AutoContinue(this.root, rematchBtn);
    this.onRematch = onRematch;
    (this.root.querySelector('#win-feedback-btn') as HTMLButtonElement).addEventListener('click', () =>
      onOpenFeedback?.(this.lastResult),
    );
      const inviteBtn = this.root.querySelector('#win-invite-btn') as HTMLButtonElement;
    inviteBtn.addEventListener('click', () => {
      if (!this.inviteLink) return;
      this.onInviteCopied?.();
      void copyToClipboard(this.inviteLink).then((ok) => {
        if (!ok) return;
        inviteBtn.textContent = 'Copied';
        window.setTimeout(() => {
          inviteBtn.textContent = 'Copy invite link';
        }, 2000);
      });
    });
  }

  /**
   * @param winnerIndex slot of the winning fighter, or null when the match
   *   ended with no survivor (a simultaneous double knockout).
   * @param localSlot the slot this client was playing, when known, so the
   *   winner is told they won rather than reading their own slot number.
   */
  show(winnerIndex: number | null, localSlot?: number, nameFor?: (slot: number) => string): void {
    if (winnerIndex === null) {
      this.headline.textContent = 'Nobody survived';
      this.headline.style.color = '';
      this.headline.style.borderBottomColor = '#666';
      this.subtitle.textContent = 'Everyone went out on the same frame.';
    } else {
      const won = localSlot !== undefined && localSlot >= 0 && localSlot === winnerIndex;
      const colour = PLAYER_HEX[winnerIndex % PLAYER_HEX.length] as string;
      const label = nameFor ? nameFor(winnerIndex) : `Fighter ${winnerIndex + 1}`;
      // The winner's colour identifies them, but at headline size a whole
      // sentence in one fighter's hue reads as decoration and fails contrast
      // for the darker slots. Same rule as the Timed Brawl standings: the
      // colour is a small marker, the words stay neutral.
      this.headline.textContent = '';
      const dot = document.createElement('span');
      dot.className = 'winner-dot';
      dot.style.background = colour;
      this.headline.appendChild(dot);
      this.headline.appendChild(document.createTextNode(won ? 'You win' : `${label} won`));
      this.headline.style.color = '';
      this.headline.style.borderBottomColor = colour;
      this.subtitle.textContent = won
        ? 'Last one standing out of twenty.'
        : 'Last one standing. Another match starts as soon as you are ready.';
      this.lastResult = won ? 'won' : 'eliminated';
    }
    if (winnerIndex === null) this.lastResult = 'no_survivor';
    this.root.classList.remove('hidden');
    if (this.autoContinueEnabled) this.autoContinue.start(this.onRematch);
    document.body.classList.add('end-screen-open');
  }

  hide(): void {
    this.autoContinue.cancel();
    this.root.classList.add('hidden');
    document.body.classList.remove('end-screen-open');
  }
}
