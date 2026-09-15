import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

const N = 20;
const TICKS_CEILING = 21600;
const trials = parseInt(process.argv[2] || '6', 10);

for (const entry of ALL_ARENAS) {
  const allEvents = [];
  for (let t = 0; t < trials; t++) {
    const seed = 3000 + t;
    // FIX (see docs/MEASUREMENT.md, wiki "Resolution Guarantee and Harness
    // Trust"): `undefined` silently resolves to moveless DEFAULT_CHARACTER,
    // meaning kos was always 0 here regardless of the classifier below.
    const characters = assignServerCharacters(seed, N);
    const moveless = characters.filter((c) => !c.moves || c.moves.length === 0);
    if (moveless.length > 0) {
      console.error(`FATAL: ${moveless.length}/${N} assigned characters have no moves -- refusing to report a measurement that would silently reproduce the moveless-bot bug.`);
      process.exit(1);
    }
    const sim = new Sim(seed, N, characters, entry.arena);
    const bots = Array.from({ length: N }, (_, i) => new BotController(i, BotDifficulty.EASY, deriveBotSeed(seed, i)));
    let ticks = 0;
    let lastLen = 0;
    while (!sim.isMatchOver() && ticks < TICKS_CEILING) {
      const inputs = bots.map((b) => b.nextInput(sim));
      sim.advance(inputs);
      ticks++;
      const ev = sim.eliminationEvents;
      for (let i = lastLen; i < ev.length; i++) allEvents.push(ev[i]);
      lastLen = ev.length;
    }
  }
  const kos = allEvents.filter((e) => e.cause === 'knockout');
  // FIX: percentAtDeath is a Fixed already encoding the percent value
  // (e.g. 45.0% -> fx value for 45.0), not a 0..1 fraction -- use
  // fx.toFloat directly, as every other script in scripts/ does. The old
  // `/65536*100` here double-scaled by 100x and was masked until now
  // because with moveless bots there were never any 'knockout' events to
  // apply it to.
  const pct = (e) => fx.toFloat(e.percentAtDeath);
  const under40 = kos.filter((e) => pct(e) < 40);
  const under25 = kos.filter((e) => pct(e) < 25);
  console.log(entry.id || entry.arena.name, {
    totalElim: allEvents.length,
    kos: kos.length,
    koShare: (kos.length / Math.max(1, allEvents.length) * 100).toFixed(1) + '%',
    under40pct: under40.length,
    under25pct: under25.length,
    minPct: kos.length ? Math.min(...kos.map(pct)).toFixed(1) : null,
    medianPct: kos.length ? pct(kos.slice().sort((a,b)=>a.percentAtDeath-b.percentAtDeath)[Math.floor(kos.length/2)]).toFixed(1) : null,
  });
}
