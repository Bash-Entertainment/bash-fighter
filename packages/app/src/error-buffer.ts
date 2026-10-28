// Keeps the last few uncaught errors so feedback and bug reports can carry
// them. Messages only, no stack traces or URLs with query strings.
const MAX = 5;
const errors: string[] = [];

function push(message: string): void {
  errors.push(message.slice(0, 300));
  if (errors.length > MAX) errors.shift();
}

export function installErrorBuffer(target: Window = window): void {
  target.addEventListener('error', (e) => push(String(e.message || 'error')));
  target.addEventListener('unhandledrejection', (e) => push(`unhandled: ${String((e as PromiseRejectionEvent).reason)}`));
}

export function recentErrors(): string[] {
  return [...errors];
}
