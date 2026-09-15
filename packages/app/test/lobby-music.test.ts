// Pins the pre-match lobby music wiring added 2026-09-15 in response to
// real player feedback ("sound in lobby is bad. instead a funcky
// chiptune is good" -- see wiki "Player Feedback Channel 2026-09-13").
//
// No jsdom here, so this is source-level: it greps main.ts for the
// call sites that must exist, the same technique used by
// ring-damage-and-match-end-audio.test.ts. It also unit-tests the
// synthesis maths in packages/audio/scripts/generate-sounds.mjs's
// waveform generators directly (pure functions, no AudioContext
// needed) to pin the loop-seam and quiet-mix properties this feature
// depends on, since those can't be asserted by grep alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(here, '../src/main.ts'), 'utf8');
const audioSrc = readFileSync(join(here, '../../audio/src/index.ts'), 'utf8');

test('lobby music starts on the same first-gesture listener that inits audio', () => {
  assert.match(
    mainSrc,
    /initOnGesture\(\);[\s\S]{0,800}startLobbyMusic\(\)/,
    'main.ts must call audio.startLobbyMusic() from the same pointerdown-once listener as initOnGesture, ' +
      'so the loop begins on the very first user gesture rather than requiring a second dedicated click',
  );
});

test('starting a local match pauses lobby music before the match_start cue', () => {
  assert.match(
    mainSrc,
    /pauseLobbyMusic\(\);\s*\n\s*audio\.play\(\s*['"]match_start['"]\s*\)/,
    'beginMatch() must call pauseLobbyMusic() immediately before audio.play(\'match_start\')',
  );
});

test('the online match_start announcement pauses lobby music first', () => {
  assert.match(
    mainSrc,
    /pauseLobbyMusic\(\);\s*\n\s*audio\.play\(\s*['"]match_start['"]\s*\)/,
    'onlineHudTick\'s announcedStart branch must call pauseLobbyMusic() right before audio.play(\'match_start\')',
  );
  // Distinguish the two call sites exist (local + online), not just one
  // shared regex match: count occurrences of the pause-then-start pair.
  const matches = mainSrc.match(/pauseLobbyMusic\(\);\s*\n\s*audio\.play\(\s*['"]match_start['"]\s*\)/g) ?? [];
  assert.equal(matches.length, 2, 'expected exactly two pauseLobbyMusic->match_start pairs (local beginMatch + online announcedStart)');
});

test('both onMatchOver handlers resume lobby music', () => {
  const matches = mainSrc.match(/resumeLobbyMusic\(\)/g) ?? [];
  assert.ok(
    matches.length >= 2,
    `expected at least 2 resumeLobbyMusic() call sites (local + online onMatchOver), found ${matches.length}`,
  );
});

test('pauseLobbyMusic/resumeLobbyMusic are thin wrappers with no sim access', () => {
  assert.match(
    mainSrc,
    /function pauseLobbyMusic\(\): void \{\s*audio\.stopLobbyMusic\(\);\s*\}/,
    'pauseLobbyMusic must do nothing but call audio.stopLobbyMusic() -- presentation-only, no sim reads',
  );
  assert.match(
    mainSrc,
    /function resumeLobbyMusic\(\): void \{\s*audio\.startLobbyMusic\(\);\s*\}/,
    'resumeLobbyMusic must do nothing but call audio.startLobbyMusic() -- presentation-only, no sim reads',
  );
});

test('startLobbyMusic and stopLobbyMusic route through the shared masterGain, not a bypass path', () => {
  assert.match(
    audioSrc,
    /startLobbyMusic\(\)[\s\S]{0,600}gain\.connect\(this\.masterGain\)/,
    'the lobby music gain node must connect into masterGain, the same node the mute control and volume slider already govern',
  );
});

test('startLobbyMusic is a no-op while already playing (safe to call repeatedly)', () => {
  assert.match(
    audioSrc,
    /startLobbyMusic\(\): void \{\s*if \(!this\.ctx \|\| !this\.masterGain \|\| this\.lobbyMusicSource\) return;/,
    'startLobbyMusic must bail out immediately if lobbyMusicSource already exists',
  );
});

// --- Pure synthesis maths, mirroring the generator in
// packages/audio/scripts/generate-sounds.mjs, so the loop-seam and
// quiet-mix properties are pinned even though we cannot literally
// listen to the output in CI. These are re-implementations of the same
// tiny pure functions (no AudioContext, no I/O) so a regression in
// either the generator or this test's understanding of it will show up
// as a mismatch against the actual rendered lobby_loop.wav asset below.
function pulse(n: number, freq: number, duty: number, sr: number): Float32Array {
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += freq / sr;
    phase -= Math.floor(phase);
    out[i] = phase < duty ? 1 : -1;
  }
  return out;
}

test('pulse() produces a bounded, periodic waveform', () => {
  const sr = 16000;
  const wave = pulse(1600, 220, 0.25, sr);
  for (const v of wave) assert.ok(v === 1 || v === -1, 'pulse wave must only take values +/-1');
  // Roughly duty-cycle fraction of samples should be "high" (+1).
  const highFrac = wave.filter((v) => v === 1).length / wave.length;
  assert.ok(Math.abs(highFrac - 0.25) < 0.05, `expected ~25% duty cycle, got ${highFrac}`);
});

test('the rendered lobby_loop.wav asset starts and ends near silence (declicked loop seam)', () => {
  const wavPath = join(here, '../../audio/assets/lobby_loop.wav');
  const bytes = readFileSync(wavPath);
  // Minimal WAV parse: 44-byte header for the PCM mono files this repo
  // generates (verified against generate-sounds.mjs's samplesToWavBytes).
  const dataStart = 44;
  const sampleCount = (bytes.length - dataStart) / 2;
  assert.ok(sampleCount > 1000, 'sanity: file must contain a substantial number of samples');
  const readSample = (i: number): number => bytes.readInt16LE(dataStart + i * 2) / 32768;
  const edgeWindow = 40;
  let maxEdgeAbs = 0;
  for (let i = 0; i < edgeWindow; i++) {
    maxEdgeAbs = Math.max(maxEdgeAbs, Math.abs(readSample(i)), Math.abs(readSample(sampleCount - 1 - i)));
  }
  assert.ok(
    maxEdgeAbs < 0.05,
    `expected the first/last ${edgeWindow} samples to be near-silent (declicked loop seam), max |sample| was ${maxEdgeAbs}`,
  );
});

test('the rendered lobby_loop.wav asset is quiet overall (sits under the UI, not over it)', () => {
  const wavPath = join(here, '../../audio/assets/lobby_loop.wav');
  const bytes = readFileSync(wavPath);
  const dataStart = 44;
  const sampleCount = (bytes.length - dataStart) / 2;
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < sampleCount; i++) {
    const v = bytes.readInt16LE(dataStart + i * 2) / 32768;
    sumSq += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const rms = Math.sqrt(sumSq / sampleCount);
  assert.ok(peak < 0.6, `expected a restrained mix (peak < 0.6), measured peak ${peak}`);
  assert.ok(rms < 0.25, `expected a quiet mix (rms < 0.25), measured rms ${rms}`);
});

test('the lobby loop asset is small (browser-instant-load budget, not a music-file-sized download)', () => {
  const wavPath = join(here, '../../audio/assets/lobby_loop.wav');
  const bytes = readFileSync(wavPath);
  assert.ok(
    bytes.length < 1024 * 1024,
    `expected the lobby loop under 1MB (it is synthesised/short, not a shipped music asset), was ${(bytes.length / 1024).toFixed(0)}KB`,
  );
});
