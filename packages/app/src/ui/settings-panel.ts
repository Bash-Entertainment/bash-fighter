// Key-remapping settings UI (repo issue #9). Lets a player rebind either
// local slot's keyboard controls (movement, jump, attack, special,
// shield), takes effect immediately for whichever InputManager(s) are
// currently live (local Match and/or online NetMatch), and persists the
// choice in localStorage so it survives a reload -- see
// packages/input/src/bindings.ts for the storage format and the
// "load once at startup, apply to every InputManager created after"
// wiring in main.ts.
//
// Visual language deliberately reuses the move-reference-panel's modal
// treatment (same overlay, same .move-reference-inner-shaped card, same
// row/label typography) rather than inventing a second settings look --
// see style.css's shared `.settings-panel` rules, which mirror
// `.move-reference-panel` almost exactly on purpose.
import {
  BINDING_FIELDS,
  BINDING_FIELD_LABELS,
  cloneBinding,
  DEFAULT_P1_BINDING,
  DEFAULT_P2_BINDING,
  type BindingField,
  type KeyBinding,
} from '@bash-fighter/input';
// Reduced-motion camera damping (issue #24): the existing "Reduce screen
// shake" toggle only reached packages/render's shake effect; extend the
// same toggle to also dampen the camera's own pan/zoom rate. Imported
// directly from the camera module (not the package's index barrel)
// since this settings panel is the only file this task touches that
// wires the setting through.
import { setCameraReducedMotion } from '@bash-fighter/render/src/camera.ts';

// Browser KeyboardEvent.code values are things like "KeyW", "ArrowLeft",
// "Space", "ShiftLeft". Most are already readable; a few common ones get
// a friendlier label so the rebind list doesn't read like raw API dump.
const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Slash: '/',
  Comma: ',',
  Period: '.',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
  Enter: 'Enter',
  Escape: 'Esc',
  Backquote: '`',
};

export function codeLabel(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code;
}

export interface SettingsPanelHost {
  /** Called whenever a binding is changed (including reset to defaults),
   * so the caller can push the new binding into whichever InputManager
   * instances are currently active. slot 0 is P1, slot 1 is P2. */
  onBindingChange: (slot: 0 | 1, binding: KeyBinding) => void;
  /** Called when the reduced-motion toggle changes. */
  onReducedMotionChange: (reduced: boolean) => void;
  /** Called when the volume slider changes, 0..1 (issue #14). */
  onVolumeChange: (volume: number) => void;
}

export class SettingsPanel {
  readonly root: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly bindings: [KeyBinding, KeyBinding];
  private capturing: { slot: 0 | 1; field: BindingField } | null = null;
  private readonly keydownHandler = (e: KeyboardEvent) => this.handleCapture(e);
  /** Escape closes the panel, but only when no rebind capture is in
   * flight -- during a capture Escape means "cancel this rebind", which
   * handleCapture owns. Registered only while the panel is open. */
  private readonly dismissHandler = (e: KeyboardEvent) => {
    if (e.code !== 'Escape' || this.capturing) return;
    e.preventDefault();
    this.hide();
  };
  // Rebinding a key already used by another action on the same slot
  // silently steals it (see handleCapture), which used to leave that
  // other action's button reading "--" with no explanation -- a player
  // could lose e.g. Move right and not notice until mid-match. Surface
  // it as a one-line notice under the list instead.
  private unboundNotice: string | null = null;

  private reducedMotion: boolean;
  private volume: number;
  private readonly host: SettingsPanelHost;
  private readonly reducedMotionCheckbox: HTMLInputElement;
  private readonly volumeSlider: HTMLInputElement;
  private readonly volumeValueEl: HTMLSpanElement;
  private readonly noticeEl: HTMLDivElement;

  constructor(
    parent: HTMLElement,
    initial: { p1: KeyBinding; p2: KeyBinding; reducedMotion: boolean; volume: number },
    host: SettingsPanelHost,
  ) {
    this.host = host;
    this.bindings = [cloneBinding(initial.p1), cloneBinding(initial.p2)];
    this.reducedMotion = initial.reducedMotion;
    setCameraReducedMotion(this.reducedMotion);
    this.volume = Math.max(0, Math.min(1, initial.volume));
    this.root = document.createElement('div');
    this.root.id = 'settings-panel';
    this.root.className = 'settings-panel move-reference-panel hidden';
    this.root.innerHTML = `
      <div class="move-reference-inner settings-inner">
        <div class="move-reference-header">
          <div class="move-reference-title">Controls</div>
          <button type="button" class="move-reference-close" aria-label="Close">Close</button>
        </div>
        <div class="settings-hint">Click a key, then press the new key you want. Esc cancels.</div>
        <div class="settings-unbound-notice hidden"></div>
        <div class="settings-list"></div>
        <button type="button" class="btn btn-plain settings-reset-btn">Reset all settings</button>
        <div class="settings-group settings-accessibility-group">
          <div class="settings-group-title">Accessibility</div>
          <label class="settings-row settings-checkbox-row">
            <span class="settings-row-label">Reduce screen shake</span>
            <input type="checkbox" class="settings-reduced-motion-checkbox" aria-label="Reduce screen shake">
          </label>
        </div>
        <div class="settings-group settings-audio-group">
          <div class="settings-group-title">Audio</div>
          <label class="settings-row settings-volume-row">
            <span class="settings-row-label">Volume</span>
            <input type="range" class="settings-volume-slider" min="0" max="100" step="1" aria-label="Volume">
            <span class="settings-volume-value"></span>
          </label>
        </div>
      </div>
    `;
    this.listEl = this.root.querySelector('.settings-list') as HTMLDivElement;
    this.noticeEl = this.root.querySelector('.settings-unbound-notice') as HTMLDivElement;
    (this.root.querySelector('.move-reference-close') as HTMLButtonElement).addEventListener('click', () =>
      this.hide(),
    );
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.hide();
    });
    (this.root.querySelector('.settings-reset-btn') as HTMLButtonElement).addEventListener('click', () =>
      this.resetToDefaults(),
    );
    this.reducedMotionCheckbox = this.root.querySelector('.settings-reduced-motion-checkbox') as HTMLInputElement;
    this.reducedMotionCheckbox.checked = this.reducedMotion;
    this.reducedMotionCheckbox.addEventListener('change', () => {
      this.reducedMotion = this.reducedMotionCheckbox.checked;
      setCameraReducedMotion(this.reducedMotion);
      this.host.onReducedMotionChange(this.reducedMotion);
    });
    this.volumeSlider = this.root.querySelector('.settings-volume-slider') as HTMLInputElement;
    this.volumeValueEl = this.root.querySelector('.settings-volume-value') as HTMLSpanElement;
    const volumePercent = () => Math.round(this.volume * 100);
    this.volumeSlider.value = String(volumePercent());
    this.volumeValueEl.textContent = `${volumePercent()}%`;
    this.volumeSlider.addEventListener('input', () => {
      this.volume = Math.max(0, Math.min(1, Number(this.volumeSlider.value) / 100));
      this.volumeValueEl.textContent = `${Math.round(this.volume * 100)}%`;
      this.host.onVolumeChange(this.volume);
    });
    parent.appendChild(this.root);
    this.render();
  }

  show(): void {
    this.render();
    this.root.classList.remove('hidden');
    window.addEventListener('keydown', this.dismissHandler);
  }

  hide(): void {
    this.cancelCapture();
    this.root.classList.add('hidden');
    window.removeEventListener('keydown', this.dismissHandler);
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Current bindings, for the caller to persist or hand to a freshly
   * created InputManager (e.g. when a new Match/NetMatch starts). */
  current(): { p1: KeyBinding; p2: KeyBinding } {
    return { p1: cloneBinding(this.bindings[0]), p2: cloneBinding(this.bindings[1]) };
  }

  /** Resets everything this panel controls -- key bindings, reduced
   * motion, and volume -- back to defaults. Previously this button (then
   * labelled "Reset to defaults") only reset key bindings, silently
   * leaving the Accessibility and Audio groups it sits right above
   * untouched, so a player using it to get back to a known-good state
   * would still be left with whatever volume/motion settings they'd
   * fiddled with. Volume default is full (1); reduced-motion default is
   * off, matching DEFAULT_P1_BINDING/DEFAULT_P2_BINDING's "defaults" for
   * bindings (note this intentionally does not re-derive from the OS
   * prefers-reduced-motion query the way first-visit does -- "reset"
   * means back to the game's own defaults, not back to autodetection). */
  private resetToDefaults(): void {
    this.cancelCapture();
    this.unboundNotice = null;
    this.bindings[0] = cloneBinding(DEFAULT_P1_BINDING);
    this.bindings[1] = cloneBinding(DEFAULT_P2_BINDING);
    this.host.onBindingChange(0, this.bindings[0]);
    this.host.onBindingChange(1, this.bindings[1]);

    this.reducedMotion = false;
    this.reducedMotionCheckbox.checked = false;
    setCameraReducedMotion(this.reducedMotion);
    this.host.onReducedMotionChange(this.reducedMotion);

    this.volume = 1;
    this.volumeSlider.value = '100';
    this.volumeValueEl.textContent = '100%';
    this.host.onVolumeChange(this.volume);

    this.render();
  }

  private beginCapture(slot: 0 | 1, field: BindingField): void {
    this.cancelCapture();
    this.unboundNotice = null;
    this.capturing = { slot, field };
    window.addEventListener('keydown', this.keydownHandler, true);
    this.render();
  }

  private cancelCapture(): void {
    if (!this.capturing) return;
    this.capturing = null;
    window.removeEventListener('keydown', this.keydownHandler, true);
  }

  private handleCapture(e: KeyboardEvent): void {
    const capture = this.capturing;
    if (!capture) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') {
      this.cancelCapture();
      this.render();
      return;
    }
    const binding = this.bindings[capture.slot];
    // Same key can't map to two different actions for the same player --
    // silently swap it off whichever other field currently holds it so
    // rebinding never leaves a slot with an ambiguous duplicate key. The
    // swapped-off action is now genuinely unbound (no key fires it), so
    // tell the player which one, instead of leaving them to discover it
    // mid-match.
    this.unboundNotice = null;
    for (const f of BINDING_FIELDS) {
      if (f !== capture.field && binding[f] === e.code) {
        (binding as Record<BindingField, string>)[f] = '';
        const slotLabel = capture.slot === 0 ? 'Player 1' : 'Player 2';
        this.unboundNotice = `${slotLabel}: ${BINDING_FIELD_LABELS[f]} is now unbound -- pick a new key for it.`;
      }
    }
    (binding as Record<BindingField, string>)[capture.field] = e.code;
    this.capturing = null;
    window.removeEventListener('keydown', this.keydownHandler, true);
    this.host.onBindingChange(capture.slot, binding);
    this.render();
  }

  private render(): void {
    if (this.unboundNotice) {
      this.noticeEl.textContent = this.unboundNotice;
      this.noticeEl.classList.remove('hidden');
    } else {
      this.noticeEl.classList.add('hidden');
    }
    this.listEl.innerHTML = '';
    ([0, 1] as const).forEach((slot) => {
      const group = document.createElement('div');
      group.className = 'settings-group';
      const heading = document.createElement('div');
      heading.className = 'settings-group-title';
      heading.textContent = slot === 0 ? 'Player 1' : 'Player 2 (local only)';
      group.appendChild(heading);
      for (const field of BINDING_FIELDS) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        const label = document.createElement('div');
        label.className = 'settings-row-label';
        label.textContent = BINDING_FIELD_LABELS[field];
        const key = this.bindings[slot][field];
        const isCapturing = this.capturing?.slot === slot && this.capturing?.field === field;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-key-btn';
        if (isCapturing) button.classList.add('capturing');
        button.textContent = isCapturing ? 'Press a key…' : key ? codeLabel(key) : '—';
        button.addEventListener('click', () => this.beginCapture(slot, field));
        row.appendChild(label);
        row.appendChild(button);
        group.appendChild(row);
      }
      this.listEl.appendChild(group);
    });
  }
}
