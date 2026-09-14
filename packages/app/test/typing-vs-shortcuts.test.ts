// From real player feedback, 2026-09-14: "Writing on the feedback form
// still toggles the (C)ontrol window, you have to disable those hotkeys
// while the form is open." Typing "camera" into the feedback box opened
// the Controls panel; an m opened the move reference. Source-level, as
// there is no jsdom in this repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('every window-level keydown listener stands aside for text entry', () => {
  const listeners = MAIN.split("window.addEventListener('keydown'").slice(1);
  assert.ok(listeners.length >= 3, 'expected the shortcut listeners to still be here');
  for (const [i, listener] of listeners.entries()) {
    const head = listener.slice(0, 220);
    assert.match(
      head,
      /isTypingKeystroke\(e\)\) return;/,
      `window keydown listener #${i + 1} acts on keystrokes meant for a text field`,
    );
  }
});

test('the guard defers to the input package rather than reimplementing it', () => {
  const fn = MAIN.slice(MAIN.indexOf('function isTypingKeystroke'));
  assert.match(fn.slice(0, 200), /shouldIgnoreKeydown\(e\.target, e\.code\)/);
  assert.match(MAIN, /shouldIgnoreKeydown,/);
});
