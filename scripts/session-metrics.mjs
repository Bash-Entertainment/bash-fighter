#!/usr/bin/env node
// Reads [sessionEnd] JSON log lines (see docs/MEASUREMENT.md for exactly
// what they contain and how they're produced -- server/src/session-telemetry.ts)
// and prints a readable summary table. Usage:
//
//   ssh root@<host> "journalctl -u bash-fighter --no-pager" | node scripts/session-metrics.mjs
//   node scripts/session-metrics.mjs /path/to/bash-fighter.log
//   cat some.log | node scripts/session-metrics.mjs
//
// This is a pure reader: it does not touch the server, the sim, or any
// golden fixture. A line that isn't a [sessionEnd] line, or one that is
// but has malformed JSON after the prefix, is silently skipped -- this
// must never crash on a real, messy production log.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const PREFIX = '[sessionEnd] ';

function parseLine(line) {
  const idx = line.indexOf(PREFIX);
  if (idx < 0) return null;
  const jsonText = line.slice(idx + PREFIX.length).trim();
  try {
    const record = JSON.parse(jsonText);
    if (record && typeof record === 'object') return record;
  } catch {
    // Malformed line in a real log -- skip it, never throw.
  }
  return null;
}

async function readRecords(input) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const records = [];
  for await (const line of rl) {
    const record = parseLine(line);
    if (record) records.push(record);
  }
  return records;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[idx];
}

function fmt(n, digits = 1) {
  return n === null || n === undefined ? 'n/a' : n.toFixed(digits);
}

function summarise(records) {
  const count = records.length;
  const durations = records.map((r) => r.sessionDurationSec).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const endReasonCounts = {};
  for (const r of records) endReasonCounts[r.endReason ?? 'unknown'] = (endReasonCounts[r.endReason ?? 'unknown'] ?? 0) + 1;

  const neverPressed = records.filter((r) => r.firstInputMs === null || r.firstInputMs === undefined).length;
  const touchCount = records.filter((r) => r.touchActive === true).length;
  const touchKnown = records.filter((r) => r.touchActive === true || r.touchActive === false).length;

  const frameMedians = records.map((r) => r.frameMedianMs).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);
  const frameP95s = records.map((r) => r.frameP95Ms).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);

  // The specific slice the task exists to isolate: alive, never eliminated,
  // and the connection just went away (not a normal match end).
  const leftEarlyAlive = records.filter((r) => r.endReason === 'disconnected' && r.eliminated === false);
  const leftEarlyNeverPressed = leftEarlyAlive.filter((r) => r.firstInputMs === null || r.firstInputMs === undefined).length;
  const leftEarlyTouch = leftEarlyAlive.filter((r) => r.touchActive === true).length;
  const leftEarlyPlayedAnyway = leftEarlyAlive.filter((r) => typeof r.inputTicks === 'number' && r.inputTicks > 0).length;

  return {
    count,
    endReasonCounts,
    durations,
    neverPressed,
    touchCount,
    touchKnown,
    frameMedians,
    frameP95s,
    leftEarlyAlive,
    leftEarlyNeverPressed,
    leftEarlyTouch,
    leftEarlyPlayedAnyway,
  };
}

function printSummary(s) {
  console.log(`sessionEnd records: ${s.count}`);
  if (s.count === 0) {
    console.log('(no [sessionEnd] lines found in input)');
    return;
  }

  console.log('\nendReason breakdown:');
  for (const [reason, n] of Object.entries(s.endReasonCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(14)} ${n}`);
  }

  console.log('\nsession duration (seconds):');
  console.log(`  median ${fmt(percentile(s.durations, 50))}  p25 ${fmt(percentile(s.durations, 25))}  p75 ${fmt(percentile(s.durations, 75))}  min ${fmt(s.durations[0] ?? null)}  max ${fmt(s.durations[s.durations.length - 1] ?? null)}`);

  const pct = (n) => (s.count > 0 ? `${((n / s.count) * 100).toFixed(0)}%` : 'n/a');
  console.log('\nclient profile:');
  console.log(`  never pressed a key: ${s.neverPressed}/${s.count} (${pct(s.neverPressed)})`);
  console.log(`  on touch input: ${s.touchCount}/${s.touchKnown || s.count} known (${s.touchKnown ? pct(s.touchCount) : 'n/a'})`);

  console.log('\nclient frame time (ms), sessions with a report:');
  console.log(`  median-of-medians ${fmt(percentile(s.frameMedians, 50))}  p95-of-p95s ${fmt(percentile(s.frameP95s, 95))} (n=${s.frameMedians.length})`);

  console.log(`\nleft alive, never eliminated, connection just closed (the case this exists to isolate): ${s.leftEarlyAlive.length}/${s.count}`);
  if (s.leftEarlyAlive.length > 0) {
    console.log(`  of those: never pressed a key ${s.leftEarlyNeverPressed}, on touch ${s.leftEarlyTouch}, played but left anyway ${s.leftEarlyPlayedAnyway}`);
  }
}

async function main() {
  const arg = process.argv[2];
  const input = arg ? createReadStream(arg) : process.stdin;
  const records = await readRecords(input);
  printSummary(summarise(records));
}

main().catch((err) => {
  console.error(`session-metrics: ${err.message}`);
  process.exitCode = 1;
});
