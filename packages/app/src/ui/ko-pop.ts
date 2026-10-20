// Brief centred "KO!" text pop when the local player knocks someone out.
// Presentation-only DOM overlay; flat, austere, amber accent.
const POP_MS = 700;

export function showKoPop(): void {
  if (typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.className = 'ko-pop';
  el.textContent = 'KO!';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), POP_MS);
}
