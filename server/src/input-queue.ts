// Per-seat queue of client input frames. The sim consumes exactly one frame
// per tick, so frames that arrive together (several sim ticks in one browser
// frame, or network jitter) are applied in order instead of the newest one
// overwriting the rest -- which used to swallow quick taps and made the
// client's reconciliation replay start from the wrong input.
import { makeInputFrame, type InputFrame } from '@bash-fighter/sim/src/index.ts';

/** Most frames kept waiting. A deeper queue only adds input latency (the
 * client sends at the same 60Hz the server consumes, so a backlog never
 * drains by itself); beyond this the oldest frame is folded into the next
 * one, keeping its buttons so a press inside a burst is never lost. */
export const MAX_INPUT_BACKLOG = 3;

interface QueuedInput {
  input: InputFrame;
  tick: number;
}

export class InputQueue {
  private readonly frames: QueuedInput[] = [];
  private current: InputFrame = makeInputFrame();
  private appliedTick = 0;

  /** Client tick of the newest frame the sim has consumed (0 before any;
   * client ticks start at 1). Snapshots acknowledge this, so the client
   * replays exactly the frames after it. */
  get lastAppliedTick(): number {
    return this.appliedTick;
  }

  push(input: InputFrame, tick: number): void {
    this.frames.push({ input, tick });
    while (this.frames.length > MAX_INPUT_BACKLOG) {
      const oldest = this.frames.shift() as QueuedInput;
      const next = this.frames[0] as QueuedInput;
      next.input = makeInputFrame(next.input.buttons | oldest.input.buttons, next.input.stickX, next.input.stickY);
    }
  }

  /** Input for the next sim tick: the oldest queued frame, or the last one
   * again when nothing new has arrived (a held key stays held). */
  next(): InputFrame {
    const entry = this.frames.shift();
    if (entry) {
      this.current = entry.input;
      this.appliedTick = entry.tick;
    }
    return this.current;
  }

  /** Disconnect: forget queued frames, hold neutral input, and reset the
   * ack -- a resumed client restarts its tick count from 1. */
  clear(): void {
    this.frames.length = 0;
    this.current = makeInputFrame();
    this.appliedTick = 0;
  }
}
