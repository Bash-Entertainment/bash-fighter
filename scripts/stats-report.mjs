#!/usr/bin/env node
// On-demand, human-readable stats report for Bash Fighter (2026-09-14).
//
// This is the ONLY way these numbers are read: there is no web page and
// no API endpoint. The owner runs this over SSH on the production box
// and pastes the stdout into chat. See docs/MEASUREMENT.md for the full
// privacy stance -- in short, we track sessions, not people: no IPs, no
// user agents, no cookies, no fingerprints, ever.
//
// Primary source: the durable counter file written by
// server/src/stats-store.ts (STATS_LOG_PATH, default
// /srv/bash-fighter/shared/stats.jsonl). It only exists from the moment
// that code shipped -- 2026-09-14 -- so it is NOT retrospective.
//
// Optional secondary source: --extra-log lets you also feed in an older
// journalctl export (raw [sessionEnd]/[matchStart]/matchSummary console
// lines, same as scripts/session-metrics.mjs reads) to recover history
// from before the counter file existed. Anything it contributes is
// clearly marked "(extra-log, historical)" in the output so nobody
// mistakes it for the durable counters.
//
// Usage:
//   node scripts/stats-report.mjs                     # store only
//   node scripts/stats-report.mjs --store /path/to/stats.jsonl
//   node scripts/stats-report.mjs --feedback-log /path/to/feedback.jsonl
//   node scripts/stats-report.mjs --extra-log /path/to/journal-export.log
//   node scripts/stats-report.mjs --since 2026-09-10T00:00:00Z
//   node scripts/stats-report.mjs --json
//
// This is a pure reader: it never touches the running server, the sim,
// or any golden fixture, and a malformed line anywhere is skipped, never
// thrown.
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Mirrors packages/app/src/session-report.ts's NETWORK_HITCH_THRESHOLD_MS
// -- this script is plain .mjs (no build step), so the constant is
// duplicated rather than imported; keep the two in sync if either
// changes.
const NETWORK_HITCH_THRESHOLD_MS = 250;

const MODE_LABELS = {
  battleRoyale: 'Last Fighter Standing',
  timedKO: 'Timed Brawl',
  stocks: 'Stocks',
};

function parseArgs(argv) {
  const args = { store: null, extraLog: null, feedbackLog: null, since: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--store') args.store = argv[++i];
    else if (a === '--extra-log') args.extraLog = argv[++i];
    else if (a === '--feedback-log') args.feedbackLog = argv[++i];
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function readLines(pathOrNull) {
  if (!pathOrNull) return [];
  if (!existsSync(pathOrNull)) return [];
  const rl = createInterface({ input: createReadStream(pathOrNull), crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return lines;
}

function parseStoreLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const record = JSON.parse(trimmed);
    if (record && typeof record === 'object' && (record.type === 'matchEnd' || record.type === 'sessionEnd')) {
      return record;
    }
  } catch {
    // Malformed line -- skip, never throw. A production log is messy.
  }
  return null;
}

/** Recovers historical matchEnd/sessionEnd-shaped records from a raw
 *  journalctl export -- the same [sessionEnd]/matchSummary console
 *  lines scripts/session-metrics.mjs already knows how to read. Marked
 *  separately in the report; never merged silently. */
function parseExtraLogLine(line) {
  const sessionIdx = line.indexOf('[sessionEnd] ');
  if (sessionIdx >= 0) {
    try {
      const record = JSON.parse(line.slice(sessionIdx + '[sessionEnd] '.length).trim());
      return { type: 'sessionEnd', ...record };
    } catch {
      return null;
    }
  }
  // matchSummary lines are plain JSON with an "evt" field, no prefix.
  const trimmed = line.trim();
  try {
    const record = JSON.parse(trimmed);
    if (record && record.evt === 'matchSummary') {
      return {
        type: 'matchEnd',
        ts: null,
        matchId: record.matchId,
        arenaId: record.arenaId,
        winCondition: record.winCondition,
        endReason: record.endReason,
        durationSec: Number(record.durationSec),
        totalSeats: record.totalSeats,
        humanSeats: record.humanSeats,
        totalKOs: record.totalKOs,
        maxKoCount: record.maxKoCount,
      };
    }
  } catch {
    // not JSON at all (log prefix, systemd metadata, etc.) -- skip
  }
  return null;
}

/** Classifies a sessionEnd record's self-declared QA hint. `qa === true`
 *  means the client sent `?qa=1`; `qa === false` means it explicitly did
 *  not; `undefined` means the record predates this field (or came from
 *  --extra-log, which never carries it) and must be reported as
 *  "unknown", never silently folded into "not QA" -- see
 *  docs/MEASUREMENT.md and the task that added this. */
function classifySessionQa(r) {
  if (r.qa === true) return 'qa';
  if (r.qa === false) return 'notQa';
  return 'unknown';
}

/** Classifies a matchEnd record by its qaSeats count: undefined means the
 *  record predates the field (unknown), 0 means no seat in that match
 *  self-declared as QA, >0 means at least one did. This is a hint about
 *  the match, not proof any given seat in it was a real player. */
function classifyMatchQa(r) {
  if (typeof r.qaSeats !== 'number') return 'unknown';
  return r.qaSeats > 0 ? 'hasQaSeats' : 'noQaSeats';
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[idx];
}

function fmt(n, digits = 1) {
  return n === null || n === undefined || Number.isNaN(n) ? 'n/a' : n.toFixed(digits);
}

function pct(n, total) {
  return total > 0 ? `${((n / total) * 100).toFixed(0)}%` : 'n/a';
}

// "Survived past the opening seconds" -- the same rough definition used
// throughout the project's own play accounts (see e.g. [[Opening-Seconds
// Knockouts on Battle Royale 20: 2026-09-11]] and [[Beginner First-Match
// Experience Re-Examined 2026-09-11]]): a session that lasted at least
// 15 real seconds. This is a chosen threshold, not a measured fact --
// it is documented here so the number can be recomputed differently
// later without ambiguity.
const OPENING_SECONDS_THRESHOLD = 15;
// Below this many total slow frames in a group, any per-bucket fraction
// is noise, not a finding -- printed but explicitly flagged (2026-09-15,
// see docs/MEASUREMENT.md "Slow-frame attribution"). Chosen as a plain,
// low bar (not a statistical test) given how few real sessions we have;
// the report says so honestly rather than implying more confidence than
// the sample supports.
const MIN_SLOW_FRAMES_FOR_CLUSTERING = 30;

function buildReport({ storeLines, extraLines, feedbackCount, since }) {
  const sinceDate = since ? new Date(since) : null;

  const storeRecords = storeLines.map(parseStoreLine).filter(Boolean);
  const extraRecords = extraLines.map(parseExtraLogLine).filter(Boolean);

  const inWindow = (r) => {
    if (!sinceDate) return true;
    if (!r.ts) return true; // extra-log records often have no timestamp; never drop them for a --since filter, just can't confirm they're in range
    return new Date(r.ts) >= sinceDate;
  };

  const tag = (r, src) => ({ ...r, __source: src });
  const matchesFromStore = storeRecords.filter((r) => r.type === 'matchEnd' && inWindow(r)).map((r) => tag(r, 'store'));
  const sessionsFromStore = storeRecords.filter((r) => r.type === 'sessionEnd' && inWindow(r)).map((r) => tag(r, 'store'));
  const matchesFromExtra = extraRecords.filter((r) => r.type === 'matchEnd' && inWindow(r)).map((r) => tag(r, 'extra'));
  const sessionsFromExtra = extraRecords.filter((r) => r.type === 'sessionEnd' && inWindow(r)).map((r) => tag(r, 'extra'));

  const matches = [...matchesFromStore, ...matchesFromExtra];
  const sessions = [...sessionsFromStore, ...sessionsFromExtra];

  const firstStoreTs = storeRecords.map((r) => r.ts).filter(Boolean).sort()[0] ?? null;

  const byMode = {};
  for (const modeKey of Object.keys(MODE_LABELS)) {
    const inMode = matches.filter((m) => m.winCondition === modeKey);
    const durations = inMode.map((m) => m.durationSec).filter((v) => typeof v === 'number' && !Number.isNaN(v));
    byMode[modeKey] = {
      label: MODE_LABELS[modeKey],
      count: inMode.length,
      avgDurationSec: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    };
  }
  const unknownMode = matches.filter((m) => !Object.hasOwn(MODE_LABELS, m.winCondition));

  // Self-declared QA grouping (2026-09-14, see docs/MEASUREMENT.md): a
  // HINT, not proof. A real player could set ?qa=1 by accident and a
  // tester could forget it, so this never drops anything from the
  // "all sessions" totals -- it only adds two more groupings on top.
  const sessionsByQa = { all: sessions, notQa: [], qa: [], unknown: [] };
  for (const s of sessions) sessionsByQa[classifySessionQa(s)].push(s);

  function sessionGroupStats(group) {
    const durations = group.map((s) => s.sessionDurationSec).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    const pastOpeningSeconds = group.filter((s) => typeof s.sessionDurationSec === 'number' && s.sessionDurationSec >= OPENING_SECONDS_THRESHOLD).length;
    const pressedControl = group.filter((s) => typeof s.inputTicks === 'number' && s.inputTicks > 0).length;
    const knownInputTicks = group.filter((s) => typeof s.inputTicks === 'number').length;
    const eliminated = group.filter((s) => s.eliminated === true).length;
    const leftWhileAlive = group.filter((s) => s.eliminated === false).length;
    const touchCount = group.filter((s) => s.touchActive === true).length;
    const keyboardCount = group.filter((s) => s.touchActive === false).length;
    const touchKnown = touchCount + keyboardCount;

    // Observed input-device *usage* (2026-09-14, see docs/MEASUREMENT.md
    // "Capability vs usage") -- attribute each session to whichever
    // source actually produced the most ticks this match, from the
    // client-counted keyboardInputTicks/touchInputTicks/gamepadInputTicks.
    // Deliberately NOT the same thing as `touch` above (built from
    // touchActive, a static capability check): a touch-capable laptop
    // played with a keyboard shows up as "keyboard" here and "touch"
    // there, on purpose -- that mismatch is exactly the bug this exists
    // to catch. A session only counts toward a denominator once it has
    // at least one of the three fields present.
    let usageKeyboard = 0;
    let usageTouch = 0;
    let usageGamepad = 0;
    let usageKnown = 0;
    let usageMixed = 0; // more than one source used non-trivially this match
    for (const s of group) {
      const kb = typeof s.keyboardInputTicks === 'number' ? s.keyboardInputTicks : null;
      const tc = typeof s.touchInputTicks === 'number' ? s.touchInputTicks : null;
      const gp = typeof s.gamepadInputTicks === 'number' ? s.gamepadInputTicks : null;
      if (kb === null && tc === null && gp === null) continue;
      usageKnown += 1;
      const counts = { keyboard: kb ?? 0, touch: tc ?? 0, gamepad: gp ?? 0 };
      const usedSources = Object.values(counts).filter((v) => v > 0).length;
      if (usedSources > 1) usageMixed += 1;
      const winner = Object.entries(counts).sort((a, b2) => b2[1] - a[1])[0][0];
      if (counts[winner] === 0) continue; // tracked but zero ticks either way (e.g. spectator edge case)
      if (winner === 'keyboard') usageKeyboard += 1;
      else if (winner === 'touch') usageTouch += 1;
      else usageGamepad += 1;
    }
    const frameMedians = group.map((s) => s.frameMedianMs).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);
    const frameP95s = group.map((s) => s.frameP95Ms).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);
    // Device-capability tag distributions (2026-09-14, see
    // docs/MEASUREMENT.md) -- each bucket already coarse and public
    // API, so a simple count-per-bucket is safe to print as-is.
    function bucketCounts(field) {
      const counts = {};
      let known = 0;
      for (const s of group) {
        const v = s[field];
        if (typeof v !== 'number') continue;
        known += 1;
        counts[v] = (counts[v] ?? 0) + 1;
      }
      return { counts, known };
    }
    const hwConcurrency = bucketCounts('hwConcurrencyBucket');
    const deviceMemory = bucketCounts('deviceMemoryBucket');
    const dpr = bucketCounts('dprBucket');
    const screenWidth = bucketCounts('screenWidthBucket');
    const screenHeight = bucketCounts('screenHeightBucket');
    // uaFamily is a fixed string enum, not a number -- same counting
    // idea as bucketCounts but keyed on the string value directly.
    function stringCounts(field) {
      const counts = {};
      let known = 0;
      for (const s of group) {
        const v = s[field];
        if (typeof v !== 'string') continue;
        known += 1;
        counts[v] = (counts[v] ?? 0) + 1;
      }
      return { counts, known };
    }
    const uaFamily = stringCounts('uaFamily');

    // Frame-time histogram (2026-09-14): summed across every session in
    // this group, bucket-by-bucket, in the same fixed order as
    // packages/net/src/protocol.ts's FRAME_HISTOGRAM_BOUNDARIES_MS
    // ([<20, 20-33, 33-50, 50-100, 100-250, >250]ms) -- this is the
    // field that can tell a steady 14fps session apart from a smooth
    // session with a few huge stalls, which frameMedianMs/frameP95Ms
    // alone cannot.
    const frameHistogramSum = [0, 0, 0, 0, 0, 0];
    let frameHistogramSessions = 0;
    for (const s of group) {
      if (!Array.isArray(s.frameHistogram) || s.frameHistogram.length !== 6) continue;
      frameHistogramSessions += 1;
      for (let i = 0; i < 6; i += 1) {
        const v = s.frameHistogram[i];
        if (typeof v === 'number') frameHistogramSum[i] += v;
      }
    }
    const frameHistogramTotal = frameHistogramSum.reduce((a, b) => a + b, 0);

    // Hidden/backgrounded frames and network hitches (2026-09-14): the
    // two signals that separate "this device/browser is slow" from
    // "this player alt-tabbed" and "the network stalled", respectively.
    const hiddenFramesKnown = group.filter((s) => typeof s.hiddenFrames === 'number');
    const sessionsWithHiddenFrames = hiddenFramesKnown.filter((s) => s.hiddenFrames > 0).length;
    const totalHiddenFrames = hiddenFramesKnown.reduce((sum, s) => sum + s.hiddenFrames, 0);
    const hitchesKnown = group.filter((s) => typeof s.networkHitchCount === 'number');
    const sessionsWithNetworkHitches = hitchesKnown.filter((s) => s.networkHitchCount > 0).length;
    const totalNetworkHitches = hitchesKnown.reduce((sum, s) => sum + s.networkHitchCount, 0);

    // Slow-frame attribution (2026-09-15, see docs/MEASUREMENT.md
    // "Slow-frame attribution"): for every session that reported
    // slowFrameCount, sum its conditional histograms so this group's
    // slow frames can be split by which fighter-count/effects-load
    // bucket they happened in, and by how many coincided with a
    // network hitch or a match-transition effect. `known` here is
    // "sessions that had this field at all", not "sessions with a slow
    // frame" -- a session with slowFrameCount: 0 is real, useful
    // signal (a smooth session), not a hole in the data.
    const slowFrameKnown = group.filter((s) => typeof s.slowFrameCount === 'number');
    const totalSlowFrames = slowFrameKnown.reduce((sum, s) => sum + s.slowFrameCount, 0);
    const sessionsWithAnySlowFrame = slowFrameKnown.filter((s) => s.slowFrameCount > 0).length;
    function sumBuckets(field) {
      const sum = [0, 0, 0, 0];
      let sessionsReported = 0;
      for (const s of group) {
        const b = s[field];
        if (!Array.isArray(b) || b.length !== 4) continue;
        sessionsReported += 1;
        for (let i = 0; i < 4; i += 1) if (typeof b[i] === 'number') sum[i] += b[i];
      }
      return { buckets: sum, total: sum.reduce((a, b2) => a + b2, 0), sessionsReported };
    }
    const slowFrameHitchCoincidentKnown = group.filter((s) => typeof s.slowFrameHitchCoincidentCount === 'number');
    const slowFrameHitchCoincidentTotal = slowFrameHitchCoincidentKnown.reduce((sum, s) => sum + s.slowFrameHitchCoincidentCount, 0);
    const slowFrameTransitionCoincidentKnown = group.filter((s) => typeof s.slowFrameTransitionCoincidentCount === 'number');
    const slowFrameTransitionCoincidentTotal = slowFrameTransitionCoincidentKnown.reduce((sum, s) => sum + s.slowFrameTransitionCoincidentCount, 0);

    // "Actually playing" duration (2026-09-15, see docs/MEASUREMENT.md
    // "Actually-playing session duration") -- server-derived activePlayMs
    // (time as a live fighter, tick-based, cannot be spoofed by a client)
    // alongside raw tab-open sessionDurationSec above. Never replaces the
    // raw figure -- the owner's North Star wants both, since the gap
    // between them is itself the finding (an idle tab vs real play).
    const activePlaySec = group
      .map((s) => (typeof s.activePlayMs === 'number' ? s.activePlayMs / 1000 : null))
      .filter((v) => typeof v === 'number')
      .sort((a, b) => a - b);
    const spectatingSec = group
      .map((s) => (typeof s.spectatingMs === 'number' ? s.spectatingMs / 1000 : null))
      .filter((v) => typeof v === 'number');
    const visibleSecKnown = group
      .map((s) => (typeof s.visibleMs === 'number' ? s.visibleMs / 1000 : null))
      .filter((v) => typeof v === 'number')
      .sort((a, b) => a - b);
    const hiddenSecKnown = group
      .map((s) => (typeof s.hiddenMs === 'number' ? s.hiddenMs / 1000 : null))
      .filter((v) => typeof v === 'number');
    const matchAgeKnown = group
      .map((s) => (typeof s.matchAgeAtLeaveSec === 'number' ? s.matchAgeAtLeaveSec : null))
      .filter((v) => typeof v === 'number')
      .sort((a, b) => a - b);

    // Drop-off shape: where in a session's life it ended, one bucket
    // each, every session in the group falls into exactly one.
    let dropoffNeverStarted = 0; // left before the match ever reached 'playing' (lobby/countdown)
    let dropoffFirstTenSeconds = 0; // left within the first 10s of match time
    let dropoffDuringFirstMatchBeforeElim = 0; // left later than 10s in, still alive, before anyone was eliminated
    let dropoffAfterOwnElimination = 0; // this seat itself was eliminated, then the session ended (spectating or left)
    let dropoffStayedToEnd = 0; // matchEnded, not eliminated -- watched/played it out
    let dropoffUnknown = 0; // no matchAgeAtLeaveSec at all (predates this field)
    for (const s of group) {
      if (typeof s.matchAgeAtLeaveSec !== 'number') {
        // Distinguish "field present but null" (modern record, left
        // during lobby/countdown before the match started) from "field
        // absent" (record predates this feature, genuinely unknown).
        if (Object.hasOwn(s, 'matchAgeAtLeaveSec')) dropoffNeverStarted += 1;
        else dropoffUnknown += 1;
        continue;
      }
      if (s.eliminated === true) {
        dropoffAfterOwnElimination += 1;
      } else if (s.endReason === 'matchEnded') {
        dropoffStayedToEnd += 1;
      } else if (s.matchAgeAtLeaveSec < 10) {
        dropoffFirstTenSeconds += 1;
      } else if (s.leftBeforeFirstElimination === true) {
        dropoffDuringFirstMatchBeforeElim += 1;
      } else {
        // left alive, after the match's first elimination, but not their own
        dropoffDuringFirstMatchBeforeElim += 1;
      }
    }

    return {
      total: group.length,
      fromStore: group.filter((s) => s.__source === 'store').length,
      fromExtraLog: group.filter((s) => s.__source === 'extra').length,
      pastOpeningSecondsThresholdSec: OPENING_SECONDS_THRESHOLD,
      pastOpeningSeconds,
      pressedControl,
      pressedControlKnownDenominator: knownInputTicks,
      eliminated,
      leftWhileAlive,
      durationSec: {
        min: durations[0] ?? null,
        median: percentile(durations, 50),
        p95: percentile(durations, 95),
        max: durations[durations.length - 1] ?? null,
        n: durations.length,
      },
      touch: { touch: touchCount, keyboard: keyboardCount, knownDenominator: touchKnown },
      inputUsage: {
        keyboard: usageKeyboard,
        touch: usageTouch,
        gamepad: usageGamepad,
        mixed: usageMixed,
        knownDenominator: usageKnown,
      },
      frameTimeMs: {
        medianOfMedians: percentile(frameMedians, 50),
        p95OfP95s: percentile(frameP95s, 95),
        n: frameMedians.length,
      },
      deviceCapability: {
        hwConcurrencyBucket: hwConcurrency,
        deviceMemoryBucket: deviceMemory,
        dprBucket: dpr,
        screenWidthBucket: screenWidth,
        screenHeightBucket: screenHeight,
        uaFamily,
      },
      frameHistogram: {
        buckets: frameHistogramSum,
        total: frameHistogramTotal,
        sessions: frameHistogramSessions,
      },
      hiddenFrames: {
        sessionsWithAny: sessionsWithHiddenFrames,
        knownDenominator: hiddenFramesKnown.length,
        total: totalHiddenFrames,
      },
      networkHitches: {
        sessionsWithAny: sessionsWithNetworkHitches,
        knownDenominator: hitchesKnown.length,
        total: totalNetworkHitches,
      },
      slowFrames: {
        // "sessions with the field at all" -- includes sessions that
        // reported 0 slow frames, which is real signal, not a gap.
        knownDenominator: slowFrameKnown.length,
        sessionsWithAny: sessionsWithAnySlowFrame,
        total: totalSlowFrames,
        fightersAliveBuckets: sumBuckets('slowFrameFightersAliveBuckets'),
        fightersOnScreenBuckets: sumBuckets('slowFrameFightersOnScreenBuckets'),
        effectsLoadBuckets: sumBuckets('slowFrameEffectsLoadBuckets'),
        hitchCoincident: { total: slowFrameHitchCoincidentTotal, knownDenominator: slowFrameHitchCoincidentKnown.length },
        transitionCoincident: { total: slowFrameTransitionCoincidentTotal, knownDenominator: slowFrameTransitionCoincidentKnown.length },
      },
      actuallyPlaying: {
        activePlaySec: {
          min: activePlaySec[0] ?? null,
          median: percentile(activePlaySec, 50),
          p95: percentile(activePlaySec, 95),
          max: activePlaySec[activePlaySec.length - 1] ?? null,
          n: activePlaySec.length,
        },
        spectatingSec: {
          avg: spectatingSec.length ? spectatingSec.reduce((a, b2) => a + b2, 0) / spectatingSec.length : null,
          n: spectatingSec.length,
        },
        visibleSec: {
          median: percentile(visibleSecKnown, 50),
          n: visibleSecKnown.length,
        },
        hiddenSec: {
          avg: hiddenSecKnown.length ? hiddenSecKnown.reduce((a, b2) => a + b2, 0) / hiddenSecKnown.length : null,
          n: hiddenSecKnown.length,
        },
        matchAgeAtLeaveSec: {
          median: percentile(matchAgeKnown, 50),
          n: matchAgeKnown.length,
        },
        dropoff: {
          neverStarted: dropoffNeverStarted,
          firstTenSeconds: dropoffFirstTenSeconds,
          duringFirstMatchBeforeElimination: dropoffDuringFirstMatchBeforeElim,
          afterOwnElimination: dropoffAfterOwnElimination,
          stayedToEnd: dropoffStayedToEnd,
          unknown: dropoffUnknown,
          knownDenominator: group.length - dropoffUnknown,
        },
      },
    };
  }

  const humanSessionsByQa = {
    all: sessionGroupStats(sessionsByQa.all),
    notQa: sessionGroupStats(sessionsByQa.notQa),
    qa: sessionGroupStats(sessionsByQa.qa),
    unknownCount: sessionsByQa.unknown.length,
  };

  // matchEnd's per-match qaSeats count (server/src/match.ts), grouped the
  // same honest way: unknown for records written before the field
  // existed, never folded into "no QA seats".
  const matchesByQa = { all: matches, hasQaSeats: [], noQaSeats: [], unknown: [] };
  for (const m of matches) {
    const cls = classifyMatchQa(m);
    if (cls === 'hasQaSeats') matchesByQa.hasQaSeats.push(m);
    else if (cls === 'noQaSeats') matchesByQa.noQaSeats.push(m);
    else matchesByQa.unknown.push(m);
  }
  const qaSeatsTotalKnown = matches
    .map((m) => m.qaSeats)
    .filter((v) => typeof v === 'number')
    .reduce((sum, n) => sum + n, 0);

  return {
    generatedAt: new Date().toISOString(),
    since: since ?? null,
    countersStartedAt: firstStoreTs,
    retrospective: extraRecords.length > 0,
    ownTrafficNote:
      'Sessions/matches can be self-declared as QA via ?qa=1 (see docs/MEASUREMENT.md). ' +
      'This is a HINT, not proof: a real player could set it by accident, and a tester ' +
      'could forget it, so unmarked QA traffic is still possible. The totals below always ' +
      'include every session/match; the QA breakdown only adds groupings on top, it never ' +
      'drops anything.',
    identityNote:
      'These are session counts, not people. We deliberately collect no IPs, no user agents, ' +
      'no cookies, and no device fingerprints, so a returning player and a new player are ' +
      'indistinguishable here -- there is no honest "unique visitors" number to report.',
    matches: {
      total: matches.length,
      fromStore: matchesFromStore.length,
      fromExtraLog: matchesFromExtra.length,
      byMode,
      unknownModeCount: unknownMode.length,
      // Self-declared QA seat count carried on each matchEnd record (see
      // server/src/match.ts's Seat.qa / MatchSummary.qaSeats). A hint,
      // not proof -- a match with 0 known QA seats can still have had an
      // unmarked tester in it.
      qa: {
        matchesWithQaSeats: matchesByQa.hasQaSeats.length,
        matchesWithNoQaSeats: matchesByQa.noQaSeats.length,
        matchesUnknown: matchesByQa.unknown.length,
        totalQaSeatsKnown: qaSeatsTotalKnown,
      },
    },
    humanSessions: humanSessionsByQa,
    feedbackSubmissions: feedbackCount,
  };
}

function printReport(report) {
  const w = (s = '') => console.log(s);
  w('Bash Fighter -- private stats report');
  w(`generated: ${report.generatedAt}`);
  w(`counters started: ${report.countersStartedAt ?? 'no records yet'} (not retrospective${report.retrospective ? '; an --extra-log added older history, marked below' : ''})`);
  if (report.since) w(`filtered to records since: ${report.since}`);
  w();
  w(report.identityNote);
  w(report.ownTrafficNote);
  w();
  w('matches played');
  w(`  total: ${report.matches.total} (store: ${report.matches.fromStore}, extra-log/historical: ${report.matches.fromExtraLog})`);
  for (const mode of Object.values(report.matches.byMode)) {
    // A mode with no matches has no average, and "n/as" is not a unit.
    const avg = mode.count > 0 ? `${fmt(mode.avgDurationSec)}s` : 'no matches yet';
    w(`  ${mode.label.padEnd(24)} count ${String(mode.count).padEnd(6)} avg duration ${avg}`);
  }
  if (report.matches.unknownModeCount > 0) w(`  (${report.matches.unknownModeCount} match(es) with an unrecognised mode label)`);
  w(`  QA seats (self-declared, see note above): ${report.matches.qa.matchesWithQaSeats} match(es) had >=1 QA-marked seat, ` +
    `${report.matches.qa.matchesWithNoQaSeats} had none known, total QA seats ${report.matches.qa.totalQaSeatsKnown}` +
    (report.matches.qa.matchesUnknown > 0 ? `, ${report.matches.qa.matchesUnknown} match(es) predate this field (unknown)` : ''));
  w();

  function printSessionGroup(label, hs) {
    w(label);
    w(`  total: ${hs.total} (store: ${hs.fromStore}, extra-log/historical: ${hs.fromExtraLog})`);
    if (hs.total === 0) {
      w('  (no sessions in this group)');
      return;
    }
    w(`  past the opening ${hs.pastOpeningSecondsThresholdSec}s: ${hs.pastOpeningSeconds}/${hs.total} (${pct(hs.pastOpeningSeconds, hs.total)})`);
    w(`  pressed a control at all: ${hs.pressedControl}/${hs.pressedControlKnownDenominator || hs.total} known (${pct(hs.pressedControl, hs.pressedControlKnownDenominator || hs.total)})`);
    w(`  eliminated: ${hs.eliminated} (${pct(hs.eliminated, hs.total)})  left while still alive: ${hs.leftWhileAlive} (${pct(hs.leftWhileAlive, hs.total)})`);
    w(`  session duration (s), TAB-OPEN wall clock: min ${fmt(hs.durationSec.min)}  median ${fmt(hs.durationSec.median)}  p95 ${fmt(hs.durationSec.p95)}  max ${fmt(hs.durationSec.max)}  (n=${hs.durationSec.n})`);
    // "Actually playing" duration (2026-09-15) -- see docs/MEASUREMENT.md
    // "Actually-playing session duration". Server-derived, alongside the
    // tab-open figure above, never instead of it: the gap between the
    // two IS the finding (a tab left open vs someone really playing).
    const ap = hs.actuallyPlaying;
    const MIN_N_FOR_DURATION = 5;
    if (ap.activePlaySec.n === 0) {
      w('  session duration, ACTUALLY PLAYING (as a live fighter): no sessions with this field yet (older client/server build)');
    } else if (ap.activePlaySec.n < MIN_N_FOR_DURATION) {
      w(`  session duration, ACTUALLY PLAYING (as a live fighter): only n=${ap.activePlaySec.n} known -- too few to report a percentile, values were [${fmt(ap.activePlaySec.min)}s .. ${fmt(ap.activePlaySec.max)}s]`);
    } else {
      w(`  session duration, ACTUALLY PLAYING (as a live fighter, s): min ${fmt(ap.activePlaySec.min)}  median ${fmt(ap.activePlaySec.median)}  p95 ${fmt(ap.activePlaySec.p95)}  max ${fmt(ap.activePlaySec.max)}  (n=${ap.activePlaySec.n})`);
    }
    if (ap.spectatingSec.n > 0) {
      w(`  time spent spectating after own elimination (s): avg ${fmt(ap.spectatingSec.avg)}  (n=${ap.spectatingSec.n})`);
    }
    if (ap.visibleSec.n > 0 || ap.hiddenSec.n > 0) {
      w(`  tab focus this match: visible median ${fmt(ap.visibleSec.median)}s (n=${ap.visibleSec.n})  backgrounded avg ${fmt(ap.hiddenSec.avg)}s (n=${ap.hiddenSec.n})`);
    } else {
      w('  tab focus this match: no sessions with visibleMs/hiddenMs yet (older client build)');
    }
    if (ap.matchAgeAtLeaveSec.n > 0) {
      w(`  how far into the match a session lasted, median (s): ${fmt(ap.matchAgeAtLeaveSec.median)}  (n=${ap.matchAgeAtLeaveSec.n})`);
    }
    const dr = ap.dropoff;
    if (dr.knownDenominator === 0) {
      w('  drop-off shape: no sessions with this field yet (older client/server build)');
    } else if (dr.knownDenominator < MIN_N_FOR_DURATION) {
      w(`  drop-off shape: only n=${dr.knownDenominator} known -- too few to report a breakdown as a finding, raw counts only: never-started(lobby) ${dr.neverStarted}, first 10s ${dr.firstTenSeconds}, during first match before their own elimination ${dr.duringFirstMatchBeforeElimination}, after own elimination ${dr.afterOwnElimination}, stayed to match end ${dr.stayedToEnd}`);
    } else {
      w(`  drop-off shape (of ${dr.knownDenominator} known, ${dr.unknown} unknown/predate field):`);
      w(`    left before match started (lobby/countdown): ${dr.neverStarted} (${pct(dr.neverStarted, dr.knownDenominator)})`);
      w(`    left within first 10s of match: ${dr.firstTenSeconds} (${pct(dr.firstTenSeconds, dr.knownDenominator)})`);
      w(`    left later, still alive, before own elimination: ${dr.duringFirstMatchBeforeElimination} (${pct(dr.duringFirstMatchBeforeElimination, dr.knownDenominator)})`);
      w(`    left/disconnected after own elimination: ${dr.afterOwnElimination} (${pct(dr.afterOwnElimination, dr.knownDenominator)})`);
      w(`    stayed until the match ended: ${dr.stayedToEnd} (${pct(dr.stayedToEnd, dr.knownDenominator)})`);
    }
    const iu = hs.inputUsage;
    if (iu.knownDenominator > 0) {
      w(`  input device BY OBSERVED USAGE (headline; of ${iu.knownDenominator} known): keyboard ${iu.keyboard} (${pct(iu.keyboard, iu.knownDenominator)}), touch ${iu.touch} (${pct(iu.touch, iu.knownDenominator)}), gamepad ${iu.gamepad} (${pct(iu.gamepad, iu.knownDenominator)})  [${iu.mixed} session(s) used more than one source]`);
    } else {
      w('  input device by observed usage: no sessions with usage counters yet (older client build)');
    }
    w(`  input device by CAPABILITY ONLY (navigator.maxTouchPoints, NOT usage -- do not read as "played on"): touch-capable ${hs.touch.touch}, not touch-capable ${hs.touch.keyboard} (of ${hs.touch.knownDenominator} known; ${pct(hs.touch.touch, hs.touch.knownDenominator)} touch-capable)`);
    w(`  client frame time (ms): median-of-medians ${fmt(hs.frameTimeMs.medianOfMedians)}  p95-of-p95s ${fmt(hs.frameTimeMs.p95OfP95s)}  (n=${hs.frameTimeMs.n})`);
    const fh = hs.frameHistogram;
    if (fh.sessions > 0) {
      const labels = ['<20ms', '20-33ms', '33-50ms', '50-100ms', '100-250ms', '>250ms'];
      const parts = fh.buckets.map((v, i) => `${labels[i]} ${pct(v, fh.total)}`);
      w(`  frame time histogram (${fh.sessions} sessions, ${fh.total} frames): ${parts.join('  ')}`);
    }
    const hf = hs.hiddenFrames;
    if (hf.knownDenominator > 0) {
      w(`  sessions with hidden/backgrounded frames: ${hf.sessionsWithAny}/${hf.knownDenominator} known (${pct(hf.sessionsWithAny, hf.knownDenominator)}), ${hf.total} hidden frames total`);
    }
    const nh = hs.networkHitches;
    if (nh.knownDenominator > 0) {
      w(`  sessions with a network hitch (>${NETWORK_HITCH_THRESHOLD_MS}ms gap): ${nh.sessionsWithAny}/${nh.knownDenominator} known (${pct(nh.sessionsWithAny, nh.knownDenominator)}), ${nh.total} hitches total`);
    }
    const dc = hs.deviceCapability;
    const bucketLine = (name, b) => {
      if (b.known === 0) return null;
      const entries = Object.keys(b.counts).map(Number).sort((a, b2) => a - b2);
      const parts = entries.map((k) => `${k}: ${b.counts[k]}`);
      return `  ${name} (n=${b.known} known): ${parts.join(', ')}`;
    };
    for (const [name, b] of [['hardwareConcurrency bucket', dc.hwConcurrencyBucket], ['deviceMemory bucket (GB)', dc.deviceMemoryBucket], ['devicePixelRatio bucket', dc.dprBucket], ['screen width bucket (px)', dc.screenWidthBucket], ['screen height bucket (px)', dc.screenHeightBucket]]) {
      const line = bucketLine(name, b);
      if (line) w(line);
    }
    if (dc.uaFamily.known > 0) {
      const parts = Object.entries(dc.uaFamily.counts).map(([k, v]) => `${k}: ${v}`);
      w(`  browser family (n=${dc.uaFamily.known} known): ${parts.join(', ')}`);
    }

    // Slow-frame attribution (2026-09-15, see docs/MEASUREMENT.md
    // "Slow-frame attribution") -- this is the section that answers the
    // actual question the instrumentation exists for: which conditions
    // do slow frames cluster under. Printed as a plain "fraction of
    // known slow frames in each bucket" -- NOT a p95, because the
    // headline p95 above already exists and answers a different
    // question ("how bad is the worst frame"), not "what did it happen
    // during".
    const sf = hs.slowFrames;
    if (sf.knownDenominator === 0) {
      w('  slow-frame attribution: no sessions with this field yet (older client build)');
    } else {
      w(`  slow-frame attribution (${sf.knownDenominator} session(s) reporting, ${sf.sessionsWithAny} had >=1 slow frame, ${sf.total} slow frames total):`);
      if (sf.total < MIN_SLOW_FRAMES_FOR_CLUSTERING) {
        w(`    too few slow frames (${sf.total} < ${MIN_SLOW_FRAMES_FOR_CLUSTERING}) to say anything about clustering -- printing raw counts only, do not read fractions below as a finding.`);
      }
      const bucketLabels = ['0-5', '6-10', '11-15', '16-20'];
      const printBucketDist = (name, b) => {
        if (b.total === 0) {
          w(`    ${name}: no slow frames reported in this group's ${b.sessionsReported} reporting session(s)`);
          return;
        }
        const parts = b.buckets.map((v, i) => `${bucketLabels[i]} fighters: ${v} (${pct(v, b.total)})`);
        w(`    ${name} (${b.sessionsReported} session(s), ${b.total} frames): ${parts.join('  ')}`);
      };
      printBucketDist('by fighters alive', sf.fightersAliveBuckets);
      printBucketDist('by fighters on screen', sf.fightersOnScreenBuckets);
      const effectsLabels = ['0-20', '21-60', '61-120', '121+'];
      const el = sf.effectsLoadBuckets;
      if (el.total > 0) {
        const parts = el.buckets.map((v, i) => `${effectsLabels[i]} effects: ${v} (${pct(v, el.total)})`);
        w(`    by live effects load (${el.sessionsReported} session(s), ${el.total} frames): ${parts.join('  ')}`);
      } else if (el.sessionsReported > 0) {
        w(`    by live effects load: no slow frames reported in this group's ${el.sessionsReported} reporting session(s)`);
      }
      const hc = sf.hitchCoincident;
      if (hc.knownDenominator > 0 && sf.total > 0) {
        w(`    coincided with a network hitch (<1s before): ${hc.total}/${sf.total} of slow frames (${pct(hc.total, sf.total)})`);
      }
      const tc = sf.transitionCoincident;
      if (tc.knownDenominator > 0 && sf.total > 0) {
        w(`    coincided with a match-transition effect (<1s before): ${tc.total}/${sf.total} of slow frames (${pct(tc.total, sf.total)})`);
      }
    }
  }

  w('human seat sessions (sessions, not people -- see note above)');
  w('QA marker is self-declared (?qa=1) -- a hint, not proof. Unmarked QA traffic is still possible.');
  w();
  printSessionGroup('all sessions', report.humanSessions.all);
  w();
  printSessionGroup('sessions NOT marked QA', report.humanSessions.notQa);
  w();
  printSessionGroup('sessions marked QA (?qa=1)', report.humanSessions.qa);
  if (report.humanSessions.unknownCount > 0) {
    w();
    w(`  ${report.humanSessions.unknownCount} session(s) predate the QA field and are counted as unknown -- ` +
      'not assumed to be real players, not assumed to be QA.');
  }
  w();
  w(`feedback submissions (count only, text is never surfaced here): ${report.feedbackSubmissions}`);
  w();
  w('what this report cannot tell us: unique people/visitors (not tracked, by design);');
  w('whether an unmarked session was really a real player or a tester who forgot ?qa=1;');
  w('anything before the counters started unless you pass --extra-log with an older journal export.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/stats-report.mjs [--store path] [--extra-log path] [--feedback-log path] [--since ISO] [--json]');
    return;
  }
  const storePath = args.store ?? process.env.STATS_LOG_PATH ?? '/srv/bash-fighter/shared/stats.jsonl';
  const feedbackPath = args.feedbackLog ?? process.env.FEEDBACK_LOG_PATH ?? '/srv/bash-fighter/shared/feedback.jsonl';

  const storeLines = await readLines(storePath);
  const extraLines = await readLines(args.extraLog);
  const feedbackLines = await readLines(feedbackPath);
  const feedbackCount = feedbackLines.filter((l) => l.trim().length > 0).length;

  const report = buildReport({ storeLines, extraLines, feedbackCount, since: args.since });

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}

// Exported for scripts/test/stats-report.test.ts. Guarding main() below
// means importing this module (for tests) never runs the CLI or touches
// the filesystem on its own.
export { buildReport, printReport, classifySessionQa, classifyMatchQa };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`stats-report: ${err.message}`);
    process.exitCode = 1;
  });
}
