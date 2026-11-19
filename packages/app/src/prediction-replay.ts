// Client-side reconciliation for the local fighter. A snapshot's state
// already includes this client's inputs up to `ackedTick` (the client tick
// of the last frame the server applied), and nothing after. So the predicted
// state is: authoritative state, plus every buffered input newer than the
// ack, replayed in order. Kept DOM-free so it is unit-testable under Node.
import { makeInputFrame, type InputFrame, type Sim, type StateBuffer } from '@bash-fighter/sim';

/** Rebuilds `sim` from `snapshotState` and replays the unacked inputs for
 * `slot` (-1 when spectating: no replay). Drops acked entries from
 * `history` in place. Other fighters get neutral input -- they are drawn
 * from snapshots, never from this sim. */
export function reconcilePrediction(
  sim: Sim,
  snapshotState: StateBuffer,
  history: Map<number, InputFrame>,
  ackedTick: number,
  slot: number,
  numFighters: number,
): void {
  sim.loadState(snapshotState);
  for (const tick of Array.from(history.keys())) {
    if (tick <= ackedTick) history.delete(tick);
  }
  if (slot < 0) return;
  const inputs: InputFrame[] = Array.from({ length: numFighters }, () => makeInputFrame());
  const ticks = Array.from(history.keys()).sort((a, b) => a - b);
  for (const tick of ticks) {
    inputs[slot] = history.get(tick) as InputFrame;
    sim.advance(inputs);
  }
}
