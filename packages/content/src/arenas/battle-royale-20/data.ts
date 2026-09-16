// 20-player battle-royale arena (this task's item 4): multiple flat
// platforms at varied heights spread across a wide span, with a generous
// blast zone sized for a 20-fighter FFA — the sim's arena-shrink schedule
// (packages/sim/src/arena-shrink.ts) closes this down as the field thins,
// so the starting geometry can afford to be this large.
import * as fx from '../../../../sim/src/math/fixed.ts';
import type { ArenaData } from '../../../../sim/src/arena/types.ts';

export const BATTLE_ROYALE_20_ARENA: ArenaData = {
  name: 'Bash Colosseum (20p)',
  // Neutral stone-grey accent: the balanced, original stage -- no strong
  // personality, everything else is judged against it.
  accentColor: 0x9aa0a8,
  platforms: [
    // Wide main ground -- solid: this is the stage's floor, you cannot
    // fall through it, matching every other stage's ground.
    { minX: fx.fromInt(-480), maxX: fx.fromInt(480), y: fx.fromInt(0) },
    // A ring of mid-height platforms for vertical play and to break up
    // line-of-sight/spacing at 20 fighters. All 'pass-through': jump up
    // into them from below and land on top as before, but now a fighter
    // standing on one can hold down+jump to drop through deliberately
    // instead of only being able to leave by walking off the edge or
    // being knocked off -- the primitive this stage was missing.
    { minX: fx.fromInt(-360), maxX: fx.fromInt(-220), y: fx.fromInt(70), kind: 'pass-through' },
    { minX: fx.fromInt(220), maxX: fx.fromInt(360), y: fx.fromInt(70), kind: 'pass-through' },
    { minX: fx.fromInt(-70), maxX: fx.fromInt(70), y: fx.fromInt(110), kind: 'pass-through' },
    // SPAWN-OVERLAP SHELF (2026-09-15, see wiki "Spawn Overlap Fix
    // 2026-09-15"): a low, wide, pass-through shelf added purely so half
    // of the 20 match-start spawns can stand one row up instead of all
    // twenty sharing a single y=0 line -- see the spawnPoints comment
    // below for why. y=60 is deliberately the *lowest* usable height:
    // computeSafeExtents' fixed ceiling margin (see
    // scripts/spawn-clearance-audit.mjs) is set by this stage's tallest
    // platform (the y=160 perches), giving a live ceiling of y=180
    // regardless of this shelf -- so a spawn here still clears the
    // >=1.15x vertical safety factor (120 units clearance / 85.1-unit
    // worst-case upward arc = 1.41x) with margin, where the existing
    // y=110/160 platforms would not (0.82x and 0.24x respectively --
    // verified by spawn-clearance-audit.mjs, not assumed).
    { minX: fx.fromInt(-235), maxX: fx.fromInt(235), y: fx.fromInt(60), kind: 'pass-through' },
    // Two small high perches near center for king-of-the-hill skirmishes
    // -- also pass-through, so a camper can be forced off by an opponent
    // who takes the perch, or can bail downward on their own terms
    // instead of only sideways into open air.
    { minX: fx.fromInt(-180), maxX: fx.fromInt(-100), y: fx.fromInt(160), kind: 'pass-through' },
    { minX: fx.fromInt(100), maxX: fx.fromInt(180), y: fx.fromInt(160), kind: 'pass-through' },
  ],
  blastMinX: fx.fromInt(-620),
  blastMaxX: fx.fromInt(620),
  blastMinY: fx.fromInt(-260),
  blastMaxY: fx.fromInt(520),
  // 20 spawn points spread across the main platform, alternating sides so
  // adjacent fighter indices don't start adjacent on stage.
  //
  // BUG FIX (this task's stage audit): the previous formula used
  // `i % 10` as the slot, which repeats every 10 indices -- fighters 0
  // and 10, 1 and 11, ... 9 and 19 were all assigned the exact same (x, y)
  // spawn point, i.e. 20 "spawn points" that were really only 10 unique
  // positions, each stacked with two fighters on top of each other at
  // match start. `Math.floor(i / 2)` makes every one of the 20 positions
  // distinct while keeping the alternating-sides property.
  // PACING REWORK 2026-09-10 (see wiki dated "Match Pacing Rework"): production
  // journalctl evidence showed the 20-fighter opening was a single dense scrum
  // -- every fighter within immediate melee reach of several neighbours at
  // tick 0, so almost the whole field traded kills inside each bot's very
  // first AI decision, before any middle game could develop. Per-slot spacing
  // widened from 40 to 45 units (adjacent same-side gap 80->90, nearest
  // cross-side gap 40->45, and total span 400->439 each way, still inside
  // the 480 solid-ground edge) so the opening spreads fighters into separated
  // skirmishes instead of one shared brawl; still comfortably inside the
  // +-480 solid-ground span and the +-620 blast bounds.
  //
  // HUMAN-SURVIVAL FIX (2026-09-10, see wiki "Bot Difficulty Correction and
  // Human-Survival Fix 2026-09-10"): human seats are always addSeat'd
  // before bots fill the lobby (server/src/rooms.ts), so a human always
  // lands on the *lowest* fighter index. The old `slot = floor(i / 2)`
  // formula put the lowest indices at the smallest |x| -- literally the
  // exact centre of the whole spread, the single most crowded spot on
  // the stage at tick 0. A production sample showed the human 3rd-of-20
  // eliminated inside 30s despite active play, while the match otherwise
  // ran a healthy multi-phase match around them. Reversing the slot walk
  // (`9 - floor(i / 2)`) keeps every property of the spacing fix (still
  // distinct, still alternating sides, same span/gaps) but makes the
  // *lowest* indices land at the *outer* edge of the spread instead --
  // so a solo human's spawn is now the least crowded point on the stage,
  // not the most. Multiple humans in one lobby get the two next-most-open
  // points, and so on inward. Bot-only harnesses/fixtures are unaffected
  // in aggregate (it's the same 20 points, just relabelled), but any
  // fixture keyed to a specific fighter index's exact spawn position
  // needs regenerating -- see scripts/regen-golden.mjs.
  // OPENING-SECONDS KNOCKOUT FIX (2026-09-11, see wiki "Opening-Seconds
  // Knockouts on Battle Royale 20: 2026-09-11"): the outermost spawn slot
  // (34 + 9*45 = 439) sat only ~79 units from the live boundary
  // (computeGroundHalfExtents's 8% margin puts it at 480+38.4=518.4 while
  // the whole field is alive). Measured: Anchor's Forward Tilt (13 dmg,
  // base 13.0/1.0 growth) against a fresh 0%-damage fighter launches an
  // unstunted horizontal arc of ~108-136 units even scaled down by the
  // early-match knockback dampener -- comfortably past that 79-unit gap,
  // producing sub-15%-damage knockouts in the first 4 seconds on this,
  // the default and most-played stage. Widening the live boundary itself
  // (a per-stage standingMarginX override) was tried first and rejected:
  // it restored the full 140-unit authored blast clearance but slowed
  // this stage's own combat-driven match resolution enough to make
  // server/test/reconnect.test.ts's "match already ended" scenario time
  // out (reproduced 3/3 runs at quiet load; passed 2/2 without the
  // change) -- the same failure mode the 2026-09-10 margin work already
  // flagged for global margin increases. Compressing the spawn spacing
  // from 45 to 37 units per slot instead moves the outermost spawn to
  // 34 + 9*37 = 367, giving ~151 units of clearance (> the ~136-unit
  // worst measured arc, with headroom) without touching the boundary or
  // its shrink timeline at all, so match-resolution speed is unaffected.
  // Trade-off accepted and not fully resolved: this also tightens the
  // same-side adjacent-spawn gap from 45 to 37, partially walking back
  // the anti-scrum spacing widened for the "Bot Difficulty Correction"
  // pass on 2026-09-10 (see [[Character Roster]] history) for this stage
  // only. No dense-scrum regression was observed in the crowd20 checks
  // run for this fix, but it was not exhaustively re-verified.
  // EMPTY-SKY-AT-20 SPAWN TIGHTENING (2026-09-15, owner-approved
  // simulation change, see wiki "Empty-Sky-at-20 Camera Fix"): the
  // opening-seconds boundary-clearance fix above compressed spacing to
  // 34/37 purely to buy horizontal distance from the live boundary --
  // it never claimed 37 was the *minimum* safe spacing, and the ground
  // platform (+-480) was never the actual constraint (outer spawn sits
  // hundreds of units inside it either way). Tightened further to
  // 22/24 (base=22, per-slot=24; outer spawn now +-238, total fighter
  // spread ~734 units down from the platform's full 960) to shrink the
  // fought-over footprint the camera has to fit (helps every viewport,
  // worst on narrow phones) while *increasing* boundary clearance,
  // since the boundary is derived from the unchanged ground width, not
  // from spawn spacing (re-verified: scripts/spawn-clearance-audit.mjs,
  // outer slot clearance grew from 151.4 (1.40x) to 280.4 (2.59x) --
  // every slot on every stage still clears the required >=1.15x
  // safety factor by a wide margin). Adjacent same-side gap 37->24,
  // cross-side gap 34->22: re-checked against
  // scripts/opening-milestone-metrics.mjs at production's real EASY bot
  // difficulty for a denser-scrum regression (the exact failure mode
  // the original 40->45 anti-scrum widening was chasing) over 30 seeds
  // -- t15 (first 5 eliminations) median went from 36.7s to 40.9s
  // (slightly slower, not faster); nobody eliminated in the true
  // opening seconds either way.
  spawnPoints: Array.from({ length: 20 }, (_, i) => {
    const pairIdx = Math.floor(i / 2);
    const slot = 9 - pairIdx;
    const side = i % 2 === 0 ? 1 : -1;
    const x = side * fx.fromInt(22 + slot * 24);
    // SPAWN-OVERLAP FIX (2026-09-15, owner-approved, see wiki "Spawn
    // Overlap Fix 2026-09-15"): production play showed 6-8 fighters
    // visibly piled into one indistinguishable clump at match start on
    // this, the default stage. Root cause: the 2026-09-15 camera-zoom
    // spacing tightening (22/24, see history above) put same-/cross-side
    // neighbours closer together on the ground than a fighter's own
    // rendered width (~36 world units, see
    // packages/render/src/fighter-shape-placeholder.ts's BODY_WIDTH and
    // its 1.3x legibility factor in index.ts) -- they were always going
    // to overlap on screen laid out along one line, regardless of how
    // much horizontal room the camera framed. Splitting the field across
    // two rows (alternating every *pair* of indices onto the new y=60
    // shelf above, added for exactly this) fixes it without touching a
    // single x coordinate or the horizontal footprint the camera zoom
    // gain depends on: this is the same 10 x-magnitudes, same span, just
    // half of them relabelled to stand one row up. Measured (see
    // scripts/overlap-metrics.mjs): 18 overlapping screen pairs / 20
    // fighters involved -> 0 overlapping pairs at both 1280x720 and
    // 390x844, all 20 still on screen, opening-milestone-metrics.mjs
    // shows no regression at EASY (production) difficulty over 30 seeds.
    const y = fx.fromInt(pairIdx % 2 === 0 ? 0 : 60);
    return { x, y };
  }),
};
