// Shareable lobby links (see wiki "Shareable lobby links"): a client-
// generated 4-character code that turns the address bar itself into the
// thing a player sends a friend. Uses the exact alphabet/length the
// server already validates hello.joinCode against (packages/net/src/
// protocol.ts) -- this file must never define a second alphabet or a
// second validator.
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH } from '@bash-fighter/net';

/** A fresh, uniformly-random join code. crypto.getRandomValues, not
 *  Math.random: this is exposed in a URL a stranger might guess, so it
 *  should be as unpredictable as the browser can make it even though
 *  the space (32^4 = ~1M) is small by design -- a short code is the
 *  point, not a security boundary. */
export function generateJoinCode(): string {
  const bytes = new Uint8Array(JOIN_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[(bytes[i] as number) % JOIN_CODE_ALPHABET.length];
  }
  return code;
}

/** The link a host sends a friend: always built from the page's actual
 *  origin, never a hardcoded domain -- so it works the same on
 *  localhost, a preview deploy, and production. */
export function buildShareLink(origin: string, code: string): string {
  return `${origin}/?join=${code}`;
}

/** Copies text to the clipboard, calling back with whether it worked.
 *  navigator.clipboard is unavailable over plain http and in some
 *  embedded contexts, so this falls back to a hidden, selected textarea
 *  and document.execCommand('copy') rather than doing nothing. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback below
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
