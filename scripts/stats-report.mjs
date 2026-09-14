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
    const frameMedians = group.map((s) => s.frameMedianMs).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);
    const frameP95s = group.map((s) => s.frameP95Ms).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);
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
      frameTimeMs: {
        medianOfMedians: percentile(frameMedians, 50),
        p95OfP95s: percentile(frameP95s, 95),
        n: frameMedians.length,
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
    w(`  session duration (s): min ${fmt(hs.durationSec.min)}  median ${fmt(hs.durationSec.median)}  p95 ${fmt(hs.durationSec.p95)}  max ${fmt(hs.durationSec.max)}  (n=${hs.durationSec.n})`);
    w(`  input device: touch ${hs.touch.touch}, keyboard ${hs.touch.keyboard} (of ${hs.touch.knownDenominator} known; ${pct(hs.touch.touch, hs.touch.knownDenominator)} touch)`);
    w(`  client frame time (ms): median-of-medians ${fmt(hs.frameTimeMs.medianOfMedians)}  p95-of-p95s ${fmt(hs.frameTimeMs.p95OfP95s)}  (n=${hs.frameTimeMs.n})`);
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
