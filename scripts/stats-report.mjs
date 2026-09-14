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

  const matchesFromStore = storeRecords.filter((r) => r.type === 'matchEnd' && inWindow(r));
  const sessionsFromStore = storeRecords.filter((r) => r.type === 'sessionEnd' && inWindow(r));
  const matchesFromExtra = extraRecords.filter((r) => r.type === 'matchEnd' && inWindow(r));
  const sessionsFromExtra = extraRecords.filter((r) => r.type === 'sessionEnd' && inWindow(r));

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

  const durations = sessions.map((s) => s.sessionDurationSec).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const pastOpeningSeconds = sessions.filter((s) => typeof s.sessionDurationSec === 'number' && s.sessionDurationSec >= OPENING_SECONDS_THRESHOLD).length;
  const pressedControl = sessions.filter((s) => typeof s.inputTicks === 'number' && s.inputTicks > 0).length;
  const knownInputTicks = sessions.filter((s) => typeof s.inputTicks === 'number').length;
  const eliminated = sessions.filter((s) => s.eliminated === true).length;
  const leftWhileAlive = sessions.filter((s) => s.eliminated === false).length;
  const touchCount = sessions.filter((s) => s.touchActive === true).length;
  const keyboardCount = sessions.filter((s) => s.touchActive === false).length;
  const touchKnown = touchCount + keyboardCount;
  const frameMedians = sessions.map((s) => s.frameMedianMs).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);
  const frameP95s = sessions.map((s) => s.frameP95Ms).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);

  return {
    generatedAt: new Date().toISOString(),
    since: since ?? null,
    countersStartedAt: firstStoreTs,
    retrospective: extraRecords.length > 0,
    ownTrafficNote:
      'This box cannot distinguish our own QA/testing traffic from real player traffic -- ' +
      'no separate flag is recorded for either. Every count below may include both.',
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
    },
    humanSessions: {
      total: sessions.length,
      fromStore: sessionsFromStore.length,
      fromExtraLog: sessionsFromExtra.length,
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
    },
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
    w(`  ${mode.label.padEnd(24)} count ${String(mode.count).padEnd(6)} avg duration ${fmt(mode.avgDurationSec)}s`);
  }
  if (report.matches.unknownModeCount > 0) w(`  (${report.matches.unknownModeCount} match(es) with an unrecognised mode label)`);
  w();
  const hs = report.humanSessions;
  w('human seat sessions (sessions, not people -- see note above)');
  w(`  total: ${hs.total} (store: ${hs.fromStore}, extra-log/historical: ${hs.fromExtraLog})`);
  w(`  past the opening ${hs.pastOpeningSecondsThresholdSec}s: ${hs.pastOpeningSeconds}/${hs.total} (${pct(hs.pastOpeningSeconds, hs.total)})`);
  w(`  pressed a control at all: ${hs.pressedControl}/${hs.pressedControlKnownDenominator || hs.total} known (${pct(hs.pressedControl, hs.pressedControlKnownDenominator || hs.total)})`);
  w(`  eliminated: ${hs.eliminated} (${pct(hs.eliminated, hs.total)})  left while still alive: ${hs.leftWhileAlive} (${pct(hs.leftWhileAlive, hs.total)})`);
  w(`  session duration (s): min ${fmt(hs.durationSec.min)}  median ${fmt(hs.durationSec.median)}  p95 ${fmt(hs.durationSec.p95)}  max ${fmt(hs.durationSec.max)}  (n=${hs.durationSec.n})`);
  w(`  input device: touch ${hs.touch.touch}, keyboard ${hs.touch.keyboard} (of ${hs.touch.knownDenominator} known; ${pct(hs.touch.touch, hs.touch.knownDenominator)} touch)`);
  w(`  client frame time (ms): median-of-medians ${fmt(hs.frameTimeMs.medianOfMedians)}  p95-of-p95s ${fmt(hs.frameTimeMs.p95OfP95s)}  (n=${hs.frameTimeMs.n})`);
  w();
  w(`feedback submissions (count only, text is never surfaced here): ${report.feedbackSubmissions}`);
  w();
  w('what this report cannot tell us: unique people/visitors (not tracked, by design);');
  w('our own QA traffic separated from real players (not flagged); anything before the');
  w('counters started unless you pass --extra-log with an older journal export.');
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

main().catch((err) => {
  console.error(`stats-report: ${err.message}`);
  process.exitCode = 1;
});
