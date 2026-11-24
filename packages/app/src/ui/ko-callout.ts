// Short centre-top callout when the local player is knocked out ("KO'd by
// Rook" in the attacker's slot colour, or "Fell off") and when they get
// revenge. Presentation-only DOM overlay; sits above the touch controls.
import { PALETTE } from '@bash-fighter/render';

const CALLOUT_MS = 2000;
const REVENGE_COLOUR = '#e8b23c';

let current: HTMLElement | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | undefined;

function show(text: string, colour: string): void {
  if (typeof document === 'undefined') return;
  clearTimeout(dismissTimer);
  current?.remove();
  const el = document.createElement('div');
  el.className = 'ko-callout';
  el.textContent = text;
  el.style.color = colour;
  el.setAttribute('role', 'status');
  document.body.appendChild(el);
  current = el;
  dismissTimer = setTimeout(() => {
    el.remove();
    if (current === el) current = null;
  }, CALLOUT_MS);
}

export function showKoedBy(name: string, attackerSlot: number): void {
  const colour = PALETTE.playerColors[attackerSlot % PALETTE.playerColors.length] as number;
  show(`KO'd by ${name}`, `#${colour.toString(16).padStart(6, '0')}`);
}

export function showFellOff(): void {
  show('Fell off', '#e8e6df');
}

export function showRevenge(): void {
  show('Revenge!', REVENGE_COLOUR);
}
