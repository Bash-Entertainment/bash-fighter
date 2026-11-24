// Deliberately zero-dependency module (task #28231). resyncLocalTickAfterSnapshot
// is used by net-match.ts's reconciliation step, but net-match.ts transitively
// pulls in packages/render (which uses TS parameter properties, unsupported by
// Node's strip-only loader that `npm test` runs under) -- so this guard lives
// in its own file to stay unit-testable without a browser/DOM.
//
// startMatch() resets the prediction clock (`localTick`) to 0 on every
// matchStart, including a resumed reconnect's -- but a resume's first
// snapshot carries the real, large mid-match server tick. Without resyncing
// forward here, localTick stays permanently behind snap.tick, so the
// countdown and match clock (both read localTick) are wrong for the rest of
// the match. Originally measured with scripts/reconnect-divergence-harness.mjs,
// back when the replay loop also ran from snap.tick+1 to localTick (it now
// replays every input newer than the server's ack; see prediction-replay.ts).
export function resyncLocalTickAfterSnapshot(localTick: number, snapshotTick: number): number {
  return snapshotTick > localTick ? snapshotTick : localTick;
}
