import test from 'node:test';
import assert from 'node:assert/strict';
import { installErrorBuffer, recentErrors } from '../src/error-buffer.ts';

// A stand-in for window that records the handlers the buffer registers, so a
// test can fire them directly without a DOM.
type Handler = (event: unknown) => void;
const handlers: Record<string, Handler> = {};
installErrorBuffer({
  addEventListener(type: string, handler: Handler) { handlers[type] = handler; },
} as unknown as Window);

const fire = (type: string, event: unknown) => {
  const handler = handlers[type];
  assert.ok(handler, `installErrorBuffer registered no ${type} handler`);
  handler(event);
};
const fireError = (message: string) => fire('error', { message });
const fireRejection = (reason: unknown) => fire('unhandledrejection', { reason });

// The buffer is module-level and shared by every test, so each test checks the
// newest entry or fills the buffer with fresh messages first. Test order never
// matters.
const newest = () => recentErrors().at(-1);

test('an error event stores its message', () => {
  fireError('boom');
  assert.equal(newest(), 'boom');
});

test('an error event with an empty message is stored as "error"', () => {
  fireError('');
  assert.equal(newest(), 'error');
});

test('an unhandled rejection is stored with an "unhandled:" prefix', () => {
  fireRejection('socket closed');
  assert.equal(newest(), 'unhandled: socket closed');
  fireRejection(new Error('timeout'));
  assert.equal(newest(), 'unhandled: Error: timeout');
});

test('messages longer than 300 characters are cut to 300', () => {
  fireError('x'.repeat(301));
  assert.equal(newest(), 'x'.repeat(300));
  fireError('y'.repeat(300));
  assert.equal(newest(), 'y'.repeat(300));
});

test('only the 5 newest errors are kept, the oldest dropped first', () => {
  for (let i = 1; i <= 7; i++) fireError(`cap ${i}`);
  assert.deepEqual(recentErrors(), ['cap 3', 'cap 4', 'cap 5', 'cap 6', 'cap 7']);
});

test('recentErrors returns a copy the caller cannot use to change the buffer', () => {
  for (let i = 1; i <= 5; i++) fireError(`copy ${i}`);
  const copy = recentErrors();
  copy.length = 0;
  copy.push('tampered');
  assert.deepEqual(recentErrors(), ['copy 1', 'copy 2', 'copy 3', 'copy 4', 'copy 5']);
});
