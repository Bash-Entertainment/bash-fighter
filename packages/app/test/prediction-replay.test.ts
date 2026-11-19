// Online, the local fighter is predicted: on each snapshot the client loads
// the server's state and replays its own inputs newer than the server's ack.
// The old replay only covered ticks after the snapshot's tick, which skipped
// every input still in flight to the server -- so each snapshot rewound the
// fighter by about one round trip of movement (measured in a browser at
// 80 ms RTT: 2-3 snap-backs of ~12 units per short press). This drives a
// latency-modelled server and checks the prediction never rewinds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed, makeInputFrame, type InputFrame } from '@bash-fighter/sim';
import { PLACEHOLDER_CHARACTER, createMatchSim, pickArenaId } from '@bash-fighter/content';
import { reconcilePrediction } from '../src/prediction-replay.ts';

const SEED = 4242;
const FIGHTERS = 2;
const SLOT = 0;
const SNAPSHOT_EVERY = 3;
const HOLD_FROM = 60; // fighters have landed and settled by then
const HOLD_TO = 120;

const newSim = () => createMatchSim(SEED, FIGHTERS, {}, [PLACEHOLDER_CHARACTER, PLACEHOLDER_CHARACTER], pickArenaId(SEED));
const localInputAt = (tick: number): InputFrame =>
  tick >= HOLD_FROM && tick < HOLD_TO ? makeInputFrame(0, fixed.ONE, 0) : makeInputFrame();

function offlineXs(ticks: number): number[] {
  const sim = newSim();
  const xs: number[] = [];
  for (let t = 1; t <= ticks; t++) {
    const inputs = [makeInputFrame(), makeInputFrame()];
    inputs[SLOT] = localInputAt(t);
    sim.advance(inputs);
    xs.push(sim.getFighter(SLOT).posX);
  }
  return xs;
}

/** Client tick loop against a server `oneWayTicks` away that applies one
 * client frame per tick, in order, and acks the last one it applied. */
function predictedXs(ticks: number, oneWayTicks: number): number[] {
  const server = newSim();
  const client = newSim();
  const history = new Map<number, InputFrame>();
  const toServer: { arrive: number; tick: number; input: InputFrame }[] = [];
  const toClient: { arrive: number; state: Int32Array; ack: number }[] = [];
  const serverQueue: { tick: number; input: InputFrame }[] = [];
  let serverInput = makeInputFrame();
  let ack = 0;
  const xs: number[] = [];

  for (let now = 1; now <= ticks; now++) {
    while (toServer.length && toServer[0]!.arrive <= now) serverQueue.push(toServer.shift()!);
    const next = serverQueue.shift();
    if (next) {
      serverInput = next.input;
      ack = next.tick;
    }
    server.advance([serverInput, makeInputFrame()]);
    if (now % SNAPSHOT_EVERY === 0) {
      const state = server.createStateBuffer();
      server.saveState(state);
      toClient.push({ arrive: now + oneWayTicks, state, ack });
    }

    while (toClient.length && toClient[0]!.arrive <= now) {
      const snap = toClient.shift()!;
      reconcilePrediction(client, snap.state, history, snap.ack, SLOT, FIGHTERS);
    }
    const input = localInputAt(now);
    history.set(now, input);
    toServer.push({ arrive: now + oneWayTicks, tick: now, input });
    client.advance([input, makeInputFrame()]);
    xs.push(client.getFighter(SLOT).posX);
  }
  return xs;
}

for (const oneWayTicks of [0, 3, 6]) {
  test(`holding right moves the predicted fighter exactly as offline, ${oneWayTicks}-tick one-way delay`, () => {
    const expected = offlineXs(HOLD_TO + 30);
    const predicted = predictedXs(HOLD_TO + 30, oneWayTicks);
    for (let t = HOLD_FROM; t < expected.length; t++) {
      assert.equal(predicted[t], expected[t], `tick ${t + 1}`);
      assert.ok(predicted[t]! >= predicted[t - 1]!, `rewound at tick ${t + 1}`);
    }
    assert.ok(expected[HOLD_TO]! > expected[HOLD_FROM]!, 'the hold actually moved the fighter');
  });
}

test('spectators (slot -1) only adopt the snapshot and replay nothing', () => {
  const server = newSim();
  for (let t = 0; t < 10; t++) server.advance([makeInputFrame(), makeInputFrame()]);
  const state = server.createStateBuffer();
  server.saveState(state);
  const client = newSim();
  const history = new Map([[11, makeInputFrame(0, fixed.ONE, 0)]]);
  reconcilePrediction(client, state, history, 0, -1, FIGHTERS);
  assert.equal(client.getTick(), server.getTick());
});
