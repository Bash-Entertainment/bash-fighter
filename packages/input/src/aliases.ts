// Additive alternative keys for online play, where one human drives slot 0
// and there is no second local player to give the arrow keys to. The
// player's own binding always wins: an alias is dropped for a slot when
// that slot has bound the same code to any action, so a remap onto an alias
// key never fires two actions.
import type { BindingField, KeyBinding } from './bindings.ts';
import { BINDING_FIELDS } from './bindings.ts';

/** Pseudo key code held while the primary mouse button is down on the game canvas. */
export const MOUSE_ATTACK_CODE = 'Mouse0';

export type KeyAliases = Partial<Record<BindingField, readonly string[]>>;

export const ONLINE_ALIASES: KeyAliases = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  jump: ['ArrowUp'],
  attack: ['KeyJ', 'KeyZ', MOUSE_ATTACK_CODE],
  special: ['KeyK', 'KeyX'],
};

/** Every key code that triggers `field`: the primary binding first, then
 * any alias not claimed by one of the binding's own actions. */
export function codesForField(binding: KeyBinding, aliases: KeyAliases | undefined, field: BindingField): string[] {
  const codes = [binding[field]];
  const claimed = new Set(BINDING_FIELDS.map((f) => binding[f]));
  for (const code of aliases?.[field] ?? []) {
    if (!claimed.has(code)) codes.push(code);
  }
  return codes;
}
