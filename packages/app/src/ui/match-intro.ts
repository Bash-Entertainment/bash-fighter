/**
 * The first two seconds of a match, explained.
 *
 * Why this exists (2026-09-14): our first real player wrote "the match
 * starting right away without a countdown made finding the arrow pointing to
 * my dude harder than it should" and "took a minute to even find my dude".
 * Lobbies fill continuously and a player can be dropped into a fight already
 * in progress, so there is no natural countdown moment to hang orientation on
 * -- and a real countdown would be a lie for anyone joining late.
 *
 * So instead of faking a start, this names the fighter that belongs to you,
 * shows its colour, points at the on-screen marker, and gets out of the way.
 * It never takes pointer events, so it cannot swallow an input from a player
 * who already knows what they are doing.
 */
export class MatchIntro {
  private readonly root: HTMLDivElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'match-intro hidden';
    parent.appendChild(this.root);
  }

  get isVisible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Visible for the caller's benefit in tests and debugging. */
  get text(): string {
    return this.root.textContent ?? '';
  }

  /**
   * @param name        the local player's display name
   * @param colour      that fighter's colour, as a CSS colour string
   * @param joinedLate  true when the match was already running as we joined
   * @param durationMs  how long to stay up before fading itself out
   */
  show(
    name: string,
    colour: string,
    joinedLate: boolean,
    durationMs = 2600,
  ): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.root.replaceChildren();

    const card = document.createElement('div');
    card.className = 'match-intro-card';

    const who = document.createElement('p');
    who.className = 'match-intro-who';
    const swatch = document.createElement('span');
    swatch.className = 'match-intro-swatch';
    swatch.style.background = colour;
    who.appendChild(swatch);
    who.appendChild(document.createTextNode(`You are ${name}`));
    card.appendChild(who);

    const hint = document.createElement('p');
    hint.className = 'match-intro-hint';
    hint.textContent = joinedLate
      ? 'The fight is already going. The marker on screen follows you.'
      : 'The marker on screen follows you.';
    card.appendChild(hint);

    this.root.appendChild(card);
    this.root.classList.remove('hidden');
    this.timer = setTimeout(() => this.hide(), durationMs);
  }

  hide(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.root.classList.add('hidden');
  }

  destroy(): void {
    this.hide();
    this.root.remove();
  }
}
