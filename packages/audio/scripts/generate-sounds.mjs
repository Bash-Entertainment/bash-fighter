#!/usr/bin/env node
// Synthesises every SFX/ambient asset used by @bash-fighter/audio as small
// mono 16-bit PCM WAV files, from scratch, with zero dependencies and zero
// third-party audio. Run: `node packages/audio/scripts/generate-sounds.mjs`
// to regenerate after tweaking a sound's shape below.
//
// Design language: dark/austere/physical, not cartoonish. Hits are shaped
// noise bursts with a short tonal thump underneath (a "thud", not a
// "boing"); UI/item sounds are short clean tones so they read as
// information, not decoration.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'assets');
mkdirSync(OUT_DIR, { recursive: true });

const SR = 22050; // sample rate -- plenty for short percussive SFX, keeps files small

/** Seeded PRNG so regeneration is deterministic (mulberry32). */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function samplesToWavBytes(samples, sampleRate) {
  const numSamples = samples.length;
  const byteRate = sampleRate * 2;
  const blockAlign = 2;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

function seconds(n) {
  return Math.round(n * SR);
}

function envLinear(i, n, from, to) {
  return from + ((to - from) * i) / Math.max(1, n - 1);
}

function expDecay(i, n, k = 6) {
  return Math.exp((-k * i) / n);
}

/** White noise shaped by an amplitude envelope, optionally low-pass
 * filtered (one-pole) so it reads as a "thud" instead of "hiss". */
function noiseBurst(n, rng, { lowpass = 0.3, ampFn }) {
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const white = rng() * 2 - 1;
    prev = prev + lowpass * (white - prev);
    out[i] = prev * ampFn(i, n);
  }
  return out;
}

function tone(n, freqFn, ampFn, shape = 'sine') {
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = freqFn(i, n);
    phase += (2 * Math.PI * f) / SR;
    let v;
    if (shape === 'square') v = Math.sign(Math.sin(phase));
    else v = Math.sin(phase);
    out[i] = v * ampFn(i, n);
  }
  return out;
}

function mix(...layers) {
  const n = Math.max(...layers.map((l) => l.length));
  const out = new Float32Array(n);
  for (const layer of layers) {
    for (let i = 0; i < layer.length; i++) out[i] += layer[i];
  }
  return out;
}

function normalize(samples, peak = 0.9) {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max < 1e-6) return samples;
  const g = peak / max;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g;
  return out;
}

function write(name, samples) {
  const bytes = samplesToWavBytes(normalize(samples), SR);
  writeFileSync(join(OUT_DIR, name), bytes);
  console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KB`);
}

// ---- hit_light: quick, small thump ----
{
  const rng = makeRng(1);
  const n = seconds(0.09);
  const noise = noiseBurst(n, rng, { lowpass: 0.5, ampFn: (i, n2) => expDecay(i, n2, 10) * 0.5 });
  const thump = tone(n, () => 260, (i, n2) => expDecay(i, n2, 14) * 0.6, 'sine');
  write('hit_light.wav', mix(noise, thump));
}

// ---- hit_medium ----
{
  const rng = makeRng(2);
  const n = seconds(0.14);
  const noise = noiseBurst(n, rng, { lowpass: 0.35, ampFn: (i, n2) => expDecay(i, n2, 8) * 0.7 });
  const thump = tone(n, (i, n2) => envLinear(i, n2, 170, 110), (i, n2) => expDecay(i, n2, 9) * 0.8, 'sine');
  write('hit_medium.wav', mix(noise, thump));
}

// ---- hit_heavy: bigger, lower, longer tail ----
{
  const rng = makeRng(3);
  const n = seconds(0.22);
  const noise = noiseBurst(n, rng, { lowpass: 0.22, ampFn: (i, n2) => expDecay(i, n2, 6) * 0.9 });
  const thump = tone(n, (i, n2) => envLinear(i, n2, 120, 55), (i, n2) => expDecay(i, n2, 5.5) * 1.0, 'sine');
  write('hit_heavy.wav', mix(noise, thump));
}

// ---- shield_block: short metallic click + muted thud, reads as "blocked" not "hurt" ----
{
  const rng = makeRng(4);
  const n = seconds(0.1);
  const click = tone(seconds(0.02), () => 1200, (i, n2) => expDecay(i, n2, 12) * 0.35, 'square');
  const thud = noiseBurst(n, rng, { lowpass: 0.15, ampFn: (i, n2) => expDecay(i, n2, 10) * 0.45 });
  write('shield_block.wav', mix(click, thud));
}

// ---- jump: short rising sweep ----
{
  const n = seconds(0.12);
  const sweep = tone(n, (i, n2) => envLinear(i, n2, 260, 520), (i, n2) => Math.sin((Math.PI * i) / n2) * 0.5, 'sine');
  write('jump.wav', sweep);
}

// ---- item_pickup: two-note rising chime, clean and informational ----
{
  const n1 = seconds(0.08);
  const n2 = seconds(0.1);
  const a = tone(n1, () => 520, (i, n) => Math.sin((Math.PI * i) / n) * 0.4, 'sine');
  const b = tone(n2, () => 780, (i, n) => Math.sin((Math.PI * i) / n) * 0.4, 'sine');
  const gap = new Float32Array(seconds(0.02));
  write('item_pickup.wav', mix(a, [...gap, ...b].reduce((acc, v, i) => (acc[i] = v, acc), new Float32Array(gap.length + b.length))));
}

// ---- item_use_explosion: bigger noise burst with a falling sub sweep ----
{
  const rng = makeRng(5);
  const n = seconds(0.32);
  const noise = noiseBurst(n, rng, { lowpass: 0.4, ampFn: (i, n2) => expDecay(i, n2, 4.5) });
  const sub = tone(n, (i, n2) => envLinear(i, n2, 140, 40), (i, n2) => expDecay(i, n2, 4) * 0.9, 'sine');
  write('item_use_explosion.wav', mix(noise, sub));
}

// ---- elimination: dramatic descending tone with a noise tail ----
{
  const rng = makeRng(6);
  const n = seconds(0.42);
  const drop = tone(n, (i, n2) => envLinear(i, n2, 480, 70), (i, n2) => expDecay(i, n2, 3.2) * 0.85, 'sine');
  const tail = noiseBurst(n, rng, { lowpass: 0.25, ampFn: (i, n2) => (i > n2 * 0.4 ? expDecay(i - n2 * 0.4, n2 * 0.6, 4) * 0.4 : 0) });
  write('elimination.wav', mix(drop, tail));
}

// ---- match_start: short rising two-tone stinger ----
{
  const n = seconds(0.3);
  const low = tone(n, () => 220, (i, n2) => expDecay(n2 - i, n2, 3) * 0.35, 'sine');
  const high = tone(n, (i, n2) => envLinear(i, n2, 330, 440), (i, n2) => (i > n2 * 0.15 ? expDecay(i - n2 * 0.15, n2, 3) * 0.4 : 0), 'sine');
  write('match_start.wav', mix(low, high));
}

// ---- match_end: falling resolve, calmer than elimination ----
{
  const n = seconds(0.4);
  const a = tone(n, (i, n2) => envLinear(i, n2, 330, 220), (i, n2) => expDecay(i, n2, 3.5) * 0.45, 'sine');
  const b = tone(n, (i, n2) => envLinear(i, n2, 440, 165), (i, n2) => expDecay(i, n2, 3) * 0.3, 'sine');
  write('match_end.wav', mix(a, b));
}

// ---- lobby_loop: short chiptune loop for the pre-match lobby (start
// screen + waiting screen). Replaces the earlier two-tone drone after
// real player feedback called it out by name ("sound in lobby is bad.
// instead a funcky chiptune is good" -- Player Feedback Channel,
// 2026-09-14 submission). Two voices only: a triangle bassline (walks
// root/fifth/subdominant in A minor, the same austere-but-warm key as
// the rest of the SFX) and a 25%-duty pulse lead playing a short
// syncopated pentatonic motif, plus a very quiet noise "tick" on the
// off-beat for rhythmic bite without turning busy. Deliberately mixed
// quiet (peak ~0.32 after mix, well under the 0.9 peak used for SFX)
// because this must sit under the UI, not compete with it, and the
// caller (AudioManager.startLobbyMusic) applies its own further
// attenuation on top.
//
// Loop seam: every note has its own short attack/decay envelope so
// nothing is still sounding at the buffer boundary, and an explicit
// 8ms fade at the very start/end of the whole buffer removes any
// residual DC/rounding click when AudioBufferSourceNode.loop wraps it.
{
  const LOOP_SR = 16000;
  const bpm = 108;
  const stepSec = 60 / bpm / 2; // 8th notes
  const stepsPerBar = 8;
  const bars = 4;
  const totalSteps = stepsPerBar * bars;
  const stepN = Math.round(stepSec * LOOP_SR);
  const totalN = stepN * totalSteps;

  const REST = 0;
  // A-minor pentatonic-ish bassline, 8 steps, repeated every bar with the
  // 4th bar dipping to the subdominant for a touch of movement instead of
  // static repetition.
  const A2 = 110, C3 = 130.81, D3 = 146.83, E3 = 164.81, F3 = 174.61, G3 = 196.0;
  const bassBars = [
    [A2, REST, A2, C3, REST, A2, E3, REST],
    [A2, REST, A2, C3, REST, A2, E3, REST],
    [F3, REST, F3, A2, REST, F3, D3, REST],
    [G3, REST, G3, A2, REST, F3, E3, REST],
  ];
  // Lead motif: syncopated, deliberately not a straight ascending/
  // descending arpeggio -- it hits off the beat (rest on strong beat 0
  // of bars 2/4) which is what makes a chiptune loop read as "funky"
  // rather than decorative.
  const A3 = 220, C4 = 261.63, D4 = 293.66, E4 = 329.63, G4 = 392.0, A4 = 440.0;
  const leadBars = [
    [REST, C4, D4, REST, C4, A3, REST, E4],
    [REST, C4, D4, REST, A4, G4, E4, REST],
    [REST, C4, D4, REST, C4, A3, REST, D4],
    [REST, D4, C4, A3, REST, G4, E4, REST],
  ];

  function pulse(n, freq, duty) {
    const out = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      phase += freq / LOOP_SR;
      phase -= Math.floor(phase);
      out[i] = phase < duty ? 1 : -1;
    }
    return out;
  }

  function triangleWave(n, freq) {
    const out = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      phase += freq / LOOP_SR;
      phase -= Math.floor(phase);
      out[i] = 1 - 4 * Math.abs(Math.round(phase - 0.25) - (phase - 0.25));
    }
    return out;
  }

  function noteEnvelope(n, sustain = 0.55) {
    const out = new Float32Array(n);
    const attackN = Math.max(1, Math.round(n * 0.03));
    for (let i = 0; i < n; i++) {
      if (i < attackN) out[i] = i / attackN;
      else out[i] = sustain ** ((i - attackN) / Math.max(1, n - attackN));
    }
    return out;
  }

  const out = new Float32Array(totalN);
  const bassRng = makeRng(7);
  for (let bar = 0; bar < bars; bar++) {
    for (let step = 0; step < stepsPerBar; step++) {
      const idx = bar * stepsPerBar + step;
      const base = idx * stepN;

      const bassFreq = bassBars[bar][step];
      if (bassFreq > 0) {
        const wave = triangleWave(stepN, bassFreq);
        const env = noteEnvelope(stepN, 0.7);
        for (let i = 0; i < stepN; i++) out[base + i] += wave[i] * env[i] * 0.22;
      }

      const leadFreq = leadBars[bar][step];
      if (leadFreq > 0) {
        const wave = pulse(stepN, leadFreq, 0.25);
        const env = noteEnvelope(stepN, 0.35);
        for (let i = 0; i < stepN; i++) out[base + i] += wave[i] * env[i] * 0.16;
      } else {
        // Quiet off-beat tick: a couple milliseconds of filtered noise,
        // barely audible, giving the rest its own rhythmic texture
        // rather than a dead gap.
        const tickN = Math.min(stepN, Math.round(LOOP_SR * 0.012));
        let prev = 0;
        for (let i = 0; i < tickN; i++) {
          const white = bassRng() * 2 - 1;
          prev = prev + 0.4 * (white - prev);
          out[base + i] += prev * expDecay(i, tickN, 10) * 0.05;
        }
      }
    }
  }

  // Explicit declick fade at the loop boundary -- belt-and-braces on top
  // of the per-note envelopes above.
  const fadeN = Math.round(LOOP_SR * 0.008);
  for (let i = 0; i < fadeN; i++) {
    out[i] *= i / fadeN;
    out[totalN - 1 - i] *= i / fadeN;
  }

  const bytes = samplesToWavBytes(out, LOOP_SR);
  writeFileSync(join(OUT_DIR, 'lobby_loop.wav'), bytes);
  console.log(`lobby_loop.wav: ${(bytes.length / 1024).toFixed(1)} KB, ${(totalN / LOOP_SR).toFixed(2)}s`);
}

console.log('Done.');
