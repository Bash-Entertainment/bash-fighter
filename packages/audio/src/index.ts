// Presentation-only sound layer for Bash Fighter.
//
// Two tiers, both audible-only / never sim-affecting:
//  - Live synthesis (oscillators + short noise bursts) for the events
//    that need to communicate *what just happened* -- hits, shield
//    blocks, eliminations, jumps, and the crowd/match-flow stingers
//    (arena shrink, item spawn/pickup, hazard warning, final two,
//    victory). These are generated at play time from the event's own
//    data (damage, knockback, weight, own-vs-other) so a heavy hit
//    genuinely sounds different from a light one, with small
//    deterministic per-event variation so repetition doesn't grate.
//  - The pre-baked match_start/match_end/ambient beds, which are long
//    or textured enough that a decoded WAV (generated offline by
//    scripts/generate-sounds.mjs, never downloaded/licensed audio) is
//    simpler and cheaper than a live equivalent.
//
// Zero knowledge of the sim: callers (packages/app) decide *when* to
// play a sound by observing sim state, never the other way round. Every
// public method here is a leaf -- it reads its arguments, produces
// sound, and returns. Nothing here reads sim state directly, nothing
// here is called from inside the sim, and nothing here uses
// Math.random() -- per-event variation is derived from the event's own
// numbers via computeHitSoundParams, which is a pure function you can
// unit-test without a real AudioContext.

export type SoundName = 'match_start' | 'match_end';

const SOUND_FILES: Record<SoundName, string> = {
  match_start: 'match_start.wav',
  match_end: 'match_end.wav',
};

const AMBIENT_FILE = 'ambient_loop.wav';

const MUTE_STORAGE_KEY = 'bashfighter.audio.muted';
// Independent from MUTE_STORAGE_KEY on purpose (issue #14): volume at 0
// sounds identical to muted, but the two are separately persisted so
// muting and un-muting never clobbers a player's chosen volume level.
const VOLUME_STORAGE_KEY = 'bashfighter.audio.volume';
const DEFAULT_VOLUME = 1;
// Hard cap across *all* voices (synth + buffer-backed): a 20-fighter FFA
// must never sound like a wall of noise. Bursty arrival (many hits in
// one tick) drops the newest-over-cap voices rather than stealing older
// ones, so the sounds a player already started hearing finish cleanly.
const MAX_VOICES = 14;

export interface PlayOptions {
  gain?: number;
  rate?: number;
}

export function defaultAssetBase(): string {
  // Relative, not absolute: an absolute '/audio/...' resolves against
  // the *origin* root, which breaks when the app is served from a
  // subdirectory (itch.io's HTML5 CDN hosting -- see
  // docs/ITCH_BUILD.md). Deriving it from the current document's own
  // URL keeps bashfighter.com (served from the domain root) and the
  // itch build (served from a subdirectory) both correct without a
  // build-time flag.
  if (typeof document !== 'undefined' && document.baseURI) {
    return new URL('audio/', document.baseURI).toString();
  }
  return '/audio/';
}

// ---------------------------------------------------------------------
// Pure, testable parameter computation. No AudioContext, no side effects.
// ---------------------------------------------------------------------

export interface HitSoundInput {
  /** Damage dealt this hit, in whole-percent-ish units (sim already
   * reports this; see effects-events.ts damageToStrength for the same
   * source data). */
  damage: number;
  /** 0..1 knockback/strength proxy, already normalized by the caller. */
  strength: number;
  /** The struck fighter's weight stat (sim CharacterData.weight, as a
   * plain number -- heavier characters read as heavier hits). Falls
   * back to 100 (the baseline character) if unknown. */
  weight?: number;
  /** True if this was a shield block rather than a landed hit -- gets a
   * distinct metallic/dampened timbre instead of a body-impact one. */
  isShield?: boolean;
  /** True if the fighter hit was the local player. Own hits get a
   * slightly brighter, closer treatment; everyone else's hits are
   * attenuated so a 20-fighter brawl doesn't become a flat wall of
   * noise on every distant scuffle. */
  isOwn?: boolean;
  /** Deterministic seed for per-event pitch/timbre variation -- derive
   * this from event data the caller already has (e.g. a hash of
   * fighterIndex and the sim tick), never from Math.random() or
   * wall-clock time, so replays and multiple clients agree on nothing
   * that matters (it only affects sound, but keeping it seeded from
   * sim-visible numbers keeps the discipline consistent). */
  seed?: number;
}

export interface HitSoundParams {
  /** Base oscillator frequency in Hz. Heavier fighters and shield
   * blocks read lower/duller; light fighters read higher/sharper. */
  freq: number;
  /** Impact envelope length in seconds. Bigger hits ring out longer. */
  duration: number;
  /** 0..1 mix of shaped noise burst vs tonal oscillator. Hits use more
   * noise (a "thud"/"crack" texture); shield blocks are almost pure
   * tone (a "clang"). */
  noiseMix: number;
  /** 0..1 overall output gain before the distance/own attenuation. */
  gain: number;
  /** Small deterministic detune in cents, from the seed -- keeps
   * repeated identical hits from sounding like a looping sample. */
  detuneCents: number;
  /** Oscillator waveform. */
  waveform: OscillatorType;
  /** 0..1 gain of an extra low-frequency sub-thump layered under the
   * main tone/noise mix, giving strong hits physical "weight" without
   * raising overall loudness much -- 0 for weak hits and shield blocks
   * (a shield absorbing a hit shouldn't thud) so twenty fighters
   * trading jabs doesn't turn into a bass rumble. */
  thumpGain: number;
  /** Sub-thump oscillator frequency in Hz. Low and roughly constant --
   * it reads as "impact weight", not a pitched note. */
  thumpFreq: number;
  /** Sub-thump envelope length in seconds. Short: it's a felt punch,
   * not a ringing tone. */
  thumpDuration: number;
}

// Deterministic pseudo-variation from a plain number seed. NOT a PRNG
// used anywhere near the sim -- this is presentation-only jitter, so a
// simple bounded trig hash is enough and never needs re-seeding state.
function seededJitter(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x); // 0..1, deterministic in `seed`
}

/** Pure function: given a hit's data, decide how it should sound. No
 * AudioContext needed, so this is exactly what a unit test asserts on
 * to prove "a heavy hit sounds heavier" without ever hearing it. */
export function computeHitSoundParams(input: HitSoundInput): HitSoundParams {
  const weight = input.weight ?? 100;
  const damage = Math.max(0, input.damage);
  const strength = Math.max(0, Math.min(1, input.strength));
  const jitter = seededJitter(input.seed ?? damage * 1000 + weight);

  if (input.isShield) {
    // Shield blocks: a bright, short, almost-pure metallic clang --
    // clearly distinct from a body hit, and doesn't scale with weight
    // (the shield absorbs the hit; the shield doesn't get heavier).
    return {
      freq: 520 + jitter * 60,
      duration: 0.09 + strength * 0.05,
      noiseMix: 0.15,
      gain: 0.5 + strength * 0.3,
      detuneCents: (jitter - 0.5) * 20,
      waveform: 'triangle',
      thumpGain: 0,
      thumpFreq: 60,
      thumpDuration: 0,
    };
  }

  // Heavier fighters => lower pitch, longer ring; harder hits => louder
  // and noisier (more "crack"). Weight range in the roster is ~65-140;
  // map that onto a felt pitch range without needing per-character
  // tuning tables.
  const weightTerm = Math.max(0, Math.min(1, (weight - 60) / 90)); // 0 light .. 1 heavy
  const freq = 260 - weightTerm * 110 + (jitter - 0.5) * 24; // ~130..280 Hz base
  const duration = 0.05 + strength * 0.12 + weightTerm * 0.05;
  const noiseMix = 0.35 + strength * 0.35;
  const gain = 0.35 + strength * 0.55;
  const waveform: OscillatorType = weightTerm > 0.6 ? 'sine' : 'sawtooth'; // heavy = duller sine, light = brighter sawtooth

  // Sub-thump: only kicks in once a hit has real strength, so a light
  // jab stays a crack/tap and only a meaningfully powerful hit gets the
  // extra low-end weight -- this is what should make a kill-power smash
  // unmistakably different from a weak hit by ear, not just by pitch.
  // Quadratic so the ramp-in is gentle at low strength and pronounced
  // near 1, rather than thumping on every third hit.
  const thumpGain = strength > 0.25 ? Math.min(0.6, (strength - 0.25) ** 2 * 1.1) : 0;
  const thumpFreq = 55 - weightTerm * 15; // heavier fighters thump a touch lower
  const thumpDuration = thumpGain > 0 ? 0.05 + strength * 0.09 : 0;

  return {
    freq: Math.max(70, freq),
    duration: Math.min(0.35, duration),
    noiseMix,
    gain: Math.min(1, gain),
    detuneCents: (jitter - 0.5) * 30,
    waveform,
    thumpGain,
    thumpFreq: Math.max(35, thumpFreq),
    thumpDuration,
  };
}

/** Pure function: the actual gain applied to the master gain node given
 * the current mute/volume state. Muted always wins (0), independent of
 * whatever volume is set to, matching "setting volume to 0 has the same
 * audible effect as muting, but is a separate control" (issue #14). No
 * AudioContext needed, so this is directly unit-testable. */
export function computeEffectiveGain(muted: boolean, volume: number): number {
  if (muted) return 0;
  return Math.max(0, Math.min(1, volume));
}

// ---------------------------------------------------------------------
// AudioManager: owns the AudioContext and plays both synth and
// buffer-backed sounds through the same voice cap and mute control.
// ---------------------------------------------------------------------

type ActiveVoice = { stop: () => void; endsAt: number };

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loadPromises = new Map<string, Promise<AudioBuffer | null>>();
  private activeVoices: ActiveVoice[] = [];
  private muted: boolean;
  private volume: number;
  private ambientSource: AudioBufferSourceNode | null = null;
  private ambientGain: GainNode | null = null;
  private readonly assetBase: string;
  private initialized = false;
  // Shared, short-lived noise buffer reused by every noise-mixed hit
  // instead of allocating a new Float32Array per event -- built once on
  // init, never touched on the hot path.
  private noiseBuffer: AudioBuffer | null = null;
  // Per-cue event log for __bashTestAudio (2026-09-11, see wiki "Client
  // Gaps Closed 2026-09-11"): the only way this game's audio will ever
  // be checked is a script asserting that the *right* cue fired for a
  // given sim event, since nobody here can listen. Every public play*
  // method below records its own name and the AudioContext time it
  // fired (or performance.now() before ctx exists) into this bounded
  // ring buffer. Recorded even while muted -- muting zeroes gain, it
  // does not skip cue dispatch -- so a test can assert both "the cue
  // fired" and "it was inaudible" (masterGain.gain.value === 0)
  // independently, matching how mute is actually implemented.
  private cueLog: { name: string; t: number }[] = [];
  private static readonly CUE_LOG_CAP = 200;

  constructor(assetBase: string = defaultAssetBase()) {
    this.assetBase = assetBase;
    let storedMuted = false;
    try {
      storedMuted = localStorage.getItem(MUTE_STORAGE_KEY) === '1';
    } catch {
      // localStorage unavailable (e.g. privacy mode) -- default unmuted.
    }
    this.muted = storedMuted;
    let storedVolume = DEFAULT_VOLUME;
    try {
      const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
      if (raw !== null) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) storedVolume = Math.max(0, Math.min(1, parsed));
      }
    } catch {
      // localStorage unavailable (e.g. privacy mode) -- default full volume.
    }
    this.volume = storedVolume;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get volumeLevel(): number {
    return this.volume;
  }

  /** Number of voices currently sounding -- exposed for tests/dev
   * overlay to confirm the cap is holding and voices aren't leaking. */
  get activeVoiceCount(): number {
    this.pruneFinishedVoices();
    return this.activeVoices.length;
  }

  /** Test-only (see __bashTestAudio hook in packages/app/src/main.ts):
   * every cue fired so far, oldest first. */
  getCueLog(): { name: string; t: number }[] {
    return this.cueLog.slice();
  }

  /** Test-only: reset the log between assertions/scenarios. */
  clearCueLog(): void {
    this.cueLog = [];
  }

  private logCue(name: string): void {
    this.cueLog.push({ name, t: this.ctx ? this.ctx.currentTime : performance.now() / 1000 });
    if (this.cueLog.length > AudioManager.CUE_LOG_CAP) this.cueLog.shift();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain) this.masterGain.gain.value = computeEffectiveGain(this.muted, this.volume);
    try {
      localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // ignore
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** 0..1, default 1. Scales all synthesized and buffer-backed playback
   * gain, persisted independently of `muted` (issue #14). */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) this.masterGain.gain.value = computeEffectiveGain(this.muted, this.volume);
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, String(this.volume));
    } catch {
      // ignore
    }
  }

  /** Must be called from within a user-gesture event handler (click/
   * keydown), per browser autoplay policy. Safe to call more than once. */
  initOnGesture(): void {
    if (this.initialized) {
      void this.ctx?.resume();
      return;
    }
    this.initialized = true;
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // no Web Audio support -- audio is best-effort, never blocks gameplay
    const ctx = new Ctor();
    this.ctx = ctx;
    const gain = ctx.createGain();
    gain.gain.value = computeEffectiveGain(this.muted, this.volume);
    gain.connect(ctx.destination);
    this.masterGain = gain;
    this.noiseBuffer = this.buildNoiseBuffer(ctx);
    for (const name of Object.keys(SOUND_FILES) as SoundName[]) void this.load(name);
  }

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    // 0.4s of white noise is enough to be sliced (via playbackRate/stop)
    // for every noise-mixed hit; built once, deterministic length, never
    // regenerated on the hot path.
    const len = Math.floor(ctx.sampleRate * 0.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Deterministic noise (not Math.random()): a cheap fixed LCG seeded
    // with a constant. It never needs to vary run-to-run -- it's a
    // texture source, not an event's identity -- so determinism here is
    // a nice-to-have for reproducible builds, not a sim requirement.
    let s = 0x2f6e2b1;
    for (let i = 0; i < len; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (s / 0x7fffffff) * 2 - 1;
    }
    return buf;
  }

  private async load(name: SoundName): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(name);
    if (cached) return cached;
    const pending = this.loadPromises.get(name);
    if (pending) return pending;
    const promise = this.fetchAndDecode(SOUND_FILES[name]);
    this.loadPromises.set(name, promise);
    const buf = await promise;
    if (buf) this.buffers.set(name, buf);
    return buf;
  }

  private async fetchAndDecode(fileName: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    try {
      const res = await fetch(`${this.assetBase}${fileName}`);
      if (!res.ok) return null;
      const arr = await res.arrayBuffer();
      return await this.ctx.decodeAudioData(arr);
    } catch {
      return null;
    }
  }

  private pruneFinishedVoices(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.activeVoices = this.activeVoices.filter((v) => v.endsAt > now);
  }

  private hasVoiceRoom(): boolean {
    this.pruneFinishedVoices();
    return this.activeVoices.length < MAX_VOICES;
  }

  /** Distance/own attenuation applied uniformly across every event type
   * below: the local player's own events read clearly; the other
   * nineteen fighters' events are quieter so a crowded match doesn't
   * collapse into one flat wall of noise. */
  private ownGain(isOwn: boolean | undefined): number {
    return isOwn === false ? 0.4 : 1;
  }

  // -- Synthesized hit / block --------------------------------------

  /** A hit that sounds like what it was: weight, damage, and shield-vs-
   * body all audible, with small deterministic variation. */
  playHit(input: HitSoundInput): void {
    this.logCue('playHit');
    if (!this.ctx || !this.masterGain || !this.hasVoiceRoom()) return;
    const p = computeHitSoundParams(input);
    const gainMul = this.ownGain(input.isOwn);
    this.playImpactVoice(p, gainMul);
  }

  private playImpactVoice(p: HitSoundParams, gainMul: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.masterGain!);

    // Tonal component.
    const osc = ctx.createOscillator();
    osc.type = p.waveform;
    osc.frequency.value = p.freq;
    osc.detune.value = p.detuneCents;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 1 - p.noiseMix;
    osc.connect(oscGain);
    oscGain.connect(out);

    // Noise component (shared buffer, short-lived source node).
    let noise: AudioBufferSourceNode | null = null;
    if (this.noiseBuffer && p.noiseMix > 0) {
      noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = p.noiseMix;
      // A quick lowpass keeps the noise as a "thud" texture, not hiss.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 400 + (1 - p.noiseMix) * 800;
      noise.connect(lp);
      lp.connect(noiseGain);
      noiseGain.connect(out);
    }

    // Percussive envelope: fast attack, exponential-ish decay over the
    // event's own duration. Bigger hits get a slightly slower attack
    // too (a heavy swing lands with more "thud", not just longer tail).
    const attack = 0.005 + (1 - p.noiseMix) * 0.01;
    out.gain.linearRampToValueAtTime(p.gain * gainMul, now + attack);
    out.gain.exponentialRampToValueAtTime(0.001, now + attack + p.duration);

    osc.start(now);
    osc.stop(now + attack + p.duration + 0.02);
    noise?.start(now);
    noise?.stop(now + attack + p.duration + 0.02);

    // Sub-thump: a short, separately-gained low sine layered under the
    // main hit voice, only for hits strong enough to warrant it
    // (thumpGain is 0 below that threshold, so this whole block is a
    // no-op for jabs and shield blocks -- no extra nodes, no extra
    // voice-count pressure). Own gain node so it can decay on its own,
    // shorter, envelope rather than riding the main one.
    let thumpOsc: OscillatorNode | null = null;
    if (p.thumpGain > 0 && p.thumpDuration > 0) {
      thumpOsc = ctx.createOscillator();
      thumpOsc.type = 'sine';
      thumpOsc.frequency.value = p.thumpFreq;
      const thumpOut = ctx.createGain();
      thumpOut.gain.value = 0;
      thumpOsc.connect(thumpOut);
      thumpOut.connect(this.masterGain!);
      const thumpAttack = 0.004;
      thumpOut.gain.linearRampToValueAtTime(p.thumpGain * gainMul, now + thumpAttack);
      thumpOut.gain.exponentialRampToValueAtTime(0.001, now + thumpAttack + p.thumpDuration);
      thumpOsc.start(now);
      thumpOsc.stop(now + thumpAttack + p.thumpDuration + 0.02);
    }

    const endsAt = now + attack + p.duration + 0.03;
    this.activeVoices.push({
      stop: () => {
        try {
          osc.stop();
          noise?.stop();
          thumpOsc?.stop();
        } catch {
          // already stopped
        }
      },
      endsAt,
    });
  }

  // -- Short synthesized stingers -----------------------------------

  private playTone(freq: number, duration: number, gain: number, isOwn: boolean | undefined, waveform: OscillatorType = 'sine'): void {
    if (!this.ctx || !this.masterGain || !this.hasVoiceRoom()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = waveform;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0;
    osc.connect(g);
    g.connect(this.masterGain);
    const gainMul = this.ownGain(isOwn);
    g.gain.linearRampToValueAtTime(gain * gainMul, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.start(now);
    osc.stop(now + duration + 0.02);
    this.activeVoices.push({ stop: () => { try { osc.stop(); } catch { /* noop */ } }, endsAt: now + duration + 0.03 });
  }

  /** Two-note descending or ascending chirp -- cheap way to make an
   * up/down or a positive/negative event feel distinct from a single
   * tone. `rising` true = good news (item spawn, victory build); false
   * = bad news (elimination, hazard incoming). */
  private playChirp(baseFreq: number, rising: boolean, duration: number, gain: number, isOwn?: boolean): void {
    if (!this.ctx || !this.masterGain || !this.hasVoiceRoom()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const f0 = rising ? baseFreq : baseFreq * 1.5;
    const f1 = rising ? baseFreq * 1.5 : baseFreq;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.linearRampToValueAtTime(f1, now + duration);
    const g = ctx.createGain();
    g.gain.value = 0;
    osc.connect(g);
    g.connect(this.masterGain);
    const gainMul = this.ownGain(isOwn);
    g.gain.linearRampToValueAtTime(gain * gainMul, now + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.start(now);
    osc.stop(now + duration + 0.02);
    this.activeVoices.push({ stop: () => { try { osc.stop(); } catch { /* noop */ } }, endsAt: now + duration + 0.03 });
  }

  /** Own elimination: a longer, lower descending chirp. Someone else's:
   * a shorter, quieter one -- the player still learns "a fighter just
   * went out" without it fighting for attention against their own game. */
  playElimination(isOwn: boolean): void {
    this.logCue('playElimination');
    if (isOwn) this.playChirp(220, false, 0.5, 0.65);
    else this.playChirp(300, false, 0.28, 0.3, false);
  }

  /** Arena boundary shrinking -- a slow, ominous rising drone. Played
   * once per shrink-warning crossing (caller debounces), not continuously. */
  playArenaShrink(): void {
    this.logCue('playArenaShrink');
    this.playTone(90, 0.9, 0.35, undefined, 'sawtooth');
  }

  /** An item has appeared on stage. */
  playItemSpawn(): void {
    this.logCue('playItemSpawn');
    this.playChirp(500, true, 0.18, 0.35);
  }

  /** An item was picked up (distinct from spawn: quicker, higher). */
  playItemPickup(isOwn?: boolean): void {
    this.logCue('playItemPickup');
    this.playChirp(700, true, 0.12, 0.4, isOwn);
  }

  /** An item was used/detonated. */
  playItemUse(isOwn?: boolean): void {
    this.logCue('playItemUse');
    this.playHit({ damage: 12, strength: 0.8, weight: 100, isOwn });
  }

  /** A hazard is about to land -- sharp, urgent, attention-grabbing.
   * Always played at full own-gain regardless of isOwn since a hazard
   * warning that's easy to miss defeats its purpose; distance
   * attenuation still applies to *other* fighters' warnings so the
   * player's own incoming danger is never buried by everyone else's. */
  playHazardWarning(isOwn: boolean): void {
    this.logCue('playHazardWarning');
    this.playChirp(650, false, 0.15, isOwn ? 0.55 : 0.2, isOwn);
  }

  /** Repeating low, harsh pulse for actually taking ring (out-of-bounds) damage, distinct from
   * the single rising playHazardWarning chirp that announces crossing into danger. Caller
   * throttles how often this fires (roughly once per 0.3s while inRingDanger stays true) so it
   * reads as a damage-over-time alarm, not a continuous drone. */
  playRingDamage(isOwn: boolean): void {
    this.logCue('playRingDamage');
    this.playTone(140, 0.12, isOwn ? 0.5 : 0.15, isOwn, 'sawtooth');
  }

  /** Down to the final two fighters -- a distinct rising two-note cue,
   * played once. */
  playFinalTwo(): void {
    this.logCue('playFinalTwo');
    this.playChirp(440, true, 0.35, 0.5);
  }

  /** Victory -- a bright ascending flourish (three quick tones). */
  playVictory(): void {
    this.logCue('playVictory');
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    [440, 550, 660].forEach((freq, i) => {
      const t = now + i * 0.09;
      if (!this.hasVoiceRoom()) return;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g);
      g.connect(this.masterGain!);
      g.gain.linearRampToValueAtTime(0.5, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t);
      osc.stop(t + 0.4);
      this.activeVoices.push({ stop: () => { try { osc.stop(); } catch { /* noop */ } }, endsAt: t + 0.4 });
    });
  }

  playJump(isOwn?: boolean): void {
    this.logCue('playJump');
    this.playChirp(380, true, 0.08, 0.3, isOwn);
  }

  playBlock(isOwn?: boolean): void {
    this.logCue('playBlock');
    this.playHit({ damage: 0, strength: 0.5, isShield: true, isOwn });
  }

  // -- Buffer-backed long/textured sounds ----------------------------

  /** Play a one-shot decoded WAV (match_start/match_end only -- see the
   * file header for why these two stay pre-baked). */
  play(name: SoundName, opts: PlayOptions = {}): void {
    this.logCue(name);
    if (!this.ctx || !this.masterGain || !this.hasVoiceRoom()) return;
    const buf = this.buffers.get(name);
    if (!buf) {
      void this.load(name);
      return;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const gain = this.ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, opts.gain ?? 1));
    src.connect(gain);
    gain.connect(this.masterGain);
    const now = this.ctx.currentTime;
    const endsAt = now + buf.duration / (opts.rate ?? 1) + 0.05;
    src.addEventListener('ended', () => {
      const idx = this.activeVoices.findIndex((v) => v.endsAt === endsAt);
      if (idx >= 0) this.activeVoices.splice(idx, 1);
    });
    src.start();
    this.activeVoices.push({ stop: () => { try { src.stop(); } catch { /* noop */ } }, endsAt });
  }

  startAmbient(): void {
    if (!this.ctx || !this.masterGain || this.ambientSource) return;
    void (async () => {
      if (!this.ctx || this.ambientSource) return;
      const buf = await this.fetchAndDecode(AMBIENT_FILE);
      if (!buf || !this.ctx || !this.masterGain || this.ambientSource) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.35;
      src.connect(gain);
      gain.connect(this.masterGain);
      src.start();
      this.ambientSource = src;
      this.ambientGain = gain;
    })();
  }

  stopAmbient(): void {
    this.ambientSource?.stop();
    this.ambientSource = null;
    this.ambientGain = null;
  }
}
