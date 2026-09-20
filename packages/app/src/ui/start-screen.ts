// Start / character-select screen: confirm local key bindings, pick a
// character from the roster, then start a local match. The roster grid
// (CharacterSelect) reads the character list from @bash-fighter/content,
// so adding a third character never requires touching this file.
import { DEFAULT_P1_BINDING, DEFAULT_P2_BINDING, type KeyBinding } from '@bash-fighter/input';
import { DEFAULT_CHARACTER_ID } from '@bash-fighter/content';
import { MAX_NAME_LENGTH } from '@bash-fighter/net/src/protocol.ts';
import { CharacterSelect } from './character-select.ts';

/** localStorage key the chosen display name is persisted under, so a
 *  returning player never has to retype it. Deliberately separate from
 *  the key-binding/reduced-motion persistence keys in main.ts -- this
 *  file owns its own read/write of this one value. */
const NAME_STORAGE_KEY = 'bash-fighter-name';

/** Reads the persisted name, or '' if none was ever saved. Never throws:
 *  localStorage can be unavailable (privacy mode, some embeds), and an
 *  empty name is already a valid, supported choice (see sanitiseName's
 *  fallback-to-slot-label design in packages/net/src/protocol.ts), so
 *  failing closed to '' is exactly the right fallback here too. */
function loadPersistedName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function savePersistedName(name: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Best-effort only -- see loadPersistedName.
  }
}

function bindingLines(b: KeyBinding): string {
  return [
    `move  ${b.left}/${b.right}/${b.up}/${b.down}`,
    `jump  ${b.jump}`,
    `attack  ${b.attack}`,
    `special  ${b.special}`,
    `shield  ${b.shield}`,
  ].join('\n');
}

export class StartScreen {
  readonly root: HTMLDivElement;
  private readonly characterSelect: CharacterSelect;
  private readonly p1BindingsEl: HTMLPreElement;
  private readonly p2BindingsEl: HTMLPreElement;
  private readonly nameInput: HTMLInputElement;

  constructor(parent: HTMLElement, onStart: () => void, onWatchReplay?: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'screen';
    this.root.id = 'start-screen';
    this.root.innerHTML = `
      <div class="hero">
        <div class="wordmark">BASH FIGHTER</div>
        <div class="subtitle">Twenty fighters, a different arena every match, last one standing. Free and open source, plays in your browser.</div>
        <div class="how-to-play">
          <div class="how-to-play-goal">Knock other fighters off the arena — the last one standing wins. Timed Brawl and Stocks score differently, and the in-match HUD always says which.</div>
          <div class="how-to-play-controls">
            <span><b>A/D</b> move</span>
            <span><b>Space</b> jump</span>
            <span><b>F</b> attack</span>
            <span><b>G</b> special</span>
            <span><b>Shift</b> shield</span>
          </div>
          <div class="how-to-play-damage">Damage makes you fly farther, so a damaged fighter is one hit from being knocked out.</div>
        </div>
        <div id="attract-frame">
          <div id="attract-root"></div>
        </div>
        <p class="attract-caption">A live match, played by bots</p>
        <div class="name-entry-row">
          <label class="name-entry-label" for="player-name-input">Your name</label>
          <input
            class="name-entry-input"
            id="player-name-input"
            type="text"
            maxlength="${MAX_NAME_LENGTH}"
            placeholder="Fighter #7"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div id="primary-actions"></div>
      </div>
      <div class="below-fold">
        <section class="fighter-select">
          <h2 class="section-label">Choose your fighter</h2>
          <div id="roster-mount"></div>
          <p class="hint">The arena shrinks as fighters are eliminated. Empty slots are filled by bots so a match always starts.</p>
        </section>
        <button class="btn btn-secondary" id="watch-replay-btn">Watch a replay</button>
        <details class="local-play">
          <summary>Play locally on one keyboard</summary>
          <div class="select-row">
            <div class="select-card p1">
              <h3>Player 1</h3>
              <pre class="bindings p1-bindings">${bindingLines(DEFAULT_P1_BINDING)}</pre>
            </div>
            <div class="select-card p2">
              <h3>Player 2</h3>
              <pre class="bindings p2-bindings">${bindingLines(DEFAULT_P2_BINDING)}</pre>
            </div>
          </div>
          <button class="btn btn-secondary" id="start-btn">Start local match</button>
          <div class="hint">Either player can plug in a gamepad to take over their slot. F3 toggles the debug overlay.</div>
        </details>
      </div>
    `;
    parent.appendChild(this.root);

    this.p1BindingsEl = this.root.querySelector('.p1-bindings') as HTMLPreElement;
    this.p2BindingsEl = this.root.querySelector('.p2-bindings') as HTMLPreElement;

    const rosterMount = this.root.querySelector('#roster-mount') as HTMLDivElement;
    this.characterSelect = new CharacterSelect(rosterMount, DEFAULT_CHARACTER_ID, () => {});

    (this.root.querySelector('#start-btn') as HTMLButtonElement).addEventListener('click', onStart);
    if (onWatchReplay) {
      (this.root.querySelector('#watch-replay-btn') as HTMLButtonElement).addEventListener('click', onWatchReplay);
    }

    this.nameInput = this.root.querySelector('#player-name-input') as HTMLInputElement;
    this.nameInput.value = loadPersistedName();
    this.nameInput.addEventListener('input', () => {
      savePersistedName(this.nameInput.value);
    });
    // Enter in the name field starts the match. Typing a name and pressing
    // Enter is what everyone tries first, and it used to do nothing at all,
    // leaving the player sitting on the start screen with no feedback.
    this.nameInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      this.nameInput.blur();
      // The primary action is "Play online", which main.ts mounts into
      // #primary-actions. onStart is the local-keyboard side door, so it is
      // only the fallback: Enter must not quietly start a two-player local
      // match when the player expected to be matched online.
      const primary = this.root.querySelector<HTMLButtonElement>('#primary-actions button');
      if (primary) primary.click();
      else onStart();
    });
  }

  /** Player 1's chosen character id, from @bash-fighter/content's roster.
   *  Player 2 (and any bot-filled slot) stays the default character --
   *  see main.ts's beginMatch for why that's the deliberately simple
   *  choice for this local 2-player test harness. */
  get selectedCharacterId(): string {
    return this.characterSelect.value;
  }

  /** The player's typed-and-trimmed display name, or '' if they never
   *  typed one -- joining a match in one click must stay possible, so
   *  this is deliberately never forced non-empty here. The server falls
   *  back to the slot label for an empty name (see sanitiseName), and so
   *  does every client-side display of it. Not sanitised here: this is
   *  just what the player typed, and the server is the only boundary
   *  that treats it as untrusted, per the sanitise-at-the-boundary rule
   *  in packages/net/src/protocol.ts. */
  get playerName(): string {
    return this.nameInput.value.trim();
  }

  /** Called by main.ts whenever the player's remapped bindings change, so
   * the "Play locally" hint text stays in sync with reality instead of
   * always showing the hardcoded defaults after a rebind. */
  updateBindings(p1: KeyBinding, p2: KeyBinding): void {
    this.p1BindingsEl.textContent = bindingLines(p1);
    this.p2BindingsEl.textContent = bindingLines(p2);
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}
