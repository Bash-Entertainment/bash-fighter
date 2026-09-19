// Presentation-only impact feedback: hit flashes, directional impact
// pops/sparks, and screen shake. Everything here is driven by wall-clock
// render time (performance.now()/rAF delta), never sim ticks -- it reads
// sim state but never influences it, and never touches the fixed 60Hz
// advance() cadence. See EffectsLayer.spawnHit/spawnElimination/shake.
import { Container, Graphics } from 'pixi.js';
import { PALETTE } from './palette.ts';

export interface HitEffectInput {
  /** Screen-space contact point (already camera-transformed). */
  x: number;
  y: number;
  /** Unit-ish knockback direction in screen space (y flips like screen
   * coords: caller should pass already screen-oriented dir). */
  dirX: number;
  dirY: number;
  /** 0..1 normalized hit strength, used to scale every visual. */
  strength: number;
  /** 0..1 how much screen shake this specific hit should contribute,
   * decided by the caller from world-space distance between the hit and
   * the local player's own fighter (1 = local player is the victim or
   * right next to it, 0 = far side of a big arena). Flashes/sparks/pops
   * are unaffected -- shake is the one effect that moves the camera for
   * every fighter on screen, so it's the one that needs to care whether
   * the local player was actually involved. Omit (or pass 1) when there
   * is no local player to compare against, e.g. while spectating. */
  shakeAttenuation?: number;
}

interface Particle {
  g: Graphics;
  vx: number;
  vy: number;
  ageMs: number;
  lifeMs: number;
  size: number;
}

interface Pop {
  g: Graphics;
  ageMs: number;
  lifeMs: number;
  baseScale: number;
}

interface TrailSegment {
  g: Graphics;
  ageMs: number;
  lifeMs: number;
}

const SPARK_COLOR = PALETTE.danger;
const POP_COLOR = PALETTE.hud;
const TRAIL_COLOR = PALETTE.hud;

// A fighter has to be moving at least this many screen pixels per
// frame-equivalent (16.6667ms) while in hitstun before it earns a
// launch trail -- normal walking/jumping never crosses this, only a
// real knockback launch does, so the trail reads as "that hit was
// violent" rather than appearing on ordinary movement.
const TRAIL_SPEED_THRESHOLD_PX = 9;
// Legibility pass (2026-09-19, impact-feedback task): at 20-fighter zoom
// (minScale 1.6, see cameraConfig in packages/render/src/index.ts) a
// fighter's own sprite is only ~22px wide on screen, so the original
// 2-5px-thick, 90-150ms trail read as barely-there in a busy brawl.
// Bumped thickness/alpha/lifetime without touching MAX_TRAIL_SEGMENTS --
// same node cap, just each one reads more clearly while it's alive.
// Hard cap on live trail segments across all fighters -- twenty
// fighters all being launched into a lethal blast at once must degrade
// gracefully (fewer/shorter segments), never accumulate unbounded
// Graphics nodes.
const MAX_TRAIL_SEGMENTS = 24;
const MAX_SPARK_PARTICLES = 120;
const MAX_POPS = 40;
// Same reasoning as MAX_TRAIL_SEGMENTS, applied to impact sparks/pops:
// a 20-fighter pile-up can land many simultaneous hits (spawnHit is
// called once per hit, each pushing up to 9 spark particles plus one
// pop), and each live Graphics node has a real per-frame CPU cost
// (transform update, tessellated fill) that a phone's single weak core
// feels far more than this desktop does. Capped so a worst-case brawl
// degrades to fewer/shorter-lived particles instead of accumulating
// Graphics nodes without bound -- normal play (a handful of hits at a
// time) never gets close to these caps, so nothing visible changes there.


// Reduced-motion accessibility switch. Screen shake is the one effect
// here with a real vestibular-discomfort/motion-sickness risk (the
// camera itself moving, not just something on screen), so it's what
// this toggle targets -- hit flashes, sparks and pops are untouched
// since they don't move the camera and carry the actual hit-feedback
// information a player needs. Module-level (not per-EffectsLayer)
// because the app can hold more than one Renderer/EffectsLayer (local
// + online) and a single settings toggle must affect all of them
// without threading the flag through every constructor.
let shakeScale = 1;

/** Scale (or fully silence) screen shake app-wide. Called once from
 * main.ts at startup (from the persisted/OS `prefers-reduced-motion`
 * default) and again whenever the player flips the Settings toggle. */
export function setReducedMotion(reduced: boolean): void {
  shakeScale = reduced ? 0 : 1;
}

export function isReducedMotion(): boolean {
  return shakeScale === 0;
}

/** How long (ms) and how strongly a fighter's body should stay tinted
 * after taking a hit -- read by the app/renderer per fighter index. */
const FLASH_BASE_MS = 90;
const FLASH_STRONG_MS = 170;

export class EffectsLayer {
  readonly root = new Container();
  private readonly particleLayer = new Container();
  private readonly popLayer = new Container();
  private readonly trailLayer = new Container();
  private particles: Particle[] = [];
  private pops: Pop[] = [];
  private trails: TrailSegment[] = [];

  /** Live spark particle + pop + trail-segment count right now
   *  (2026-09-15, see docs/MEASUREMENT.md "Slow-frame attribution") -- a
   *  plain length read on three arrays this class already holds, no
   *  allocation. Only ever called by the app layer's telemetry when it
   *  has already decided a frame is worth attributing (see
   *  SlowFrameTracker in packages/app/src/session-report.ts), never once
   *  per frame unconditionally, so this getter itself cannot be the
   *  thing that makes a frame slow. */
  getLiveEffectsLoad(): number {
    return this.particles.length + this.pops.length + this.trails.length;
  }
  // Last known screen position per fighter index, used only to measure
  // frame-to-frame screen-space speed for the launch trail -- never
  // read from or fed back into sim state.
  private lastTrailPos = new Map<number, { x: number; y: number }>();

  // Per-fighter-index flash timers (index -> remaining ms + total ms for
  // fraction). Cleared automatically as they decay; a fighter that never
  // gets hit again just never appears here.
  private flashRemainingMs = new Map<number, number>();
  private flashTotalMs = new Map<number, number>();

  // Screen shake state: an offset applied by the caller to the world
  // container's position. Multiple hits in the same short window are
  // damped (added in quadrature-ish, capped) rather than summed linearly,
  // so a busy 20-fighter brawl does not vibrate permanently.
  private shakeMagnitude = 0; // current px amplitude
  private shakeDecayPerMs = 0.012; // amplitude lost per ms
  private shakeSeed = 1;

  constructor() {
    this.root.addChild(this.trailLayer);
    this.root.addChild(this.particleLayer);
    this.root.addChild(this.popLayer);
  }

  /** Register (or refresh) a hit flash for a fighter. `strong` picks the
   * longer of the two flash durations -- called with the same boolean the
   * audio layer uses to pick hit_heavy vs hit_light/medium, so visual and
   * audio weight always agree. */
  flashFighter(fighterIndex: number, strong: boolean): void {
    const ms = strong ? FLASH_STRONG_MS : FLASH_BASE_MS;
    this.flashRemainingMs.set(fighterIndex, ms);
    this.flashTotalMs.set(fighterIndex, ms);
  }

  /** 0..1, how "flashed" this fighter currently is (1 = just hit, 0 =
   * normal colour). Renderer multiplies this into the sprite's tint. */
  flashAmount(fighterIndex: number): number {
    const remaining = this.flashRemainingMs.get(fighterIndex);
    const total = this.flashTotalMs.get(fighterIndex);
    if (!remaining || !total) return 0;
    return Math.max(0, remaining / total);
  }

  /** Spawn the contact-point spark + directional pop for a hit. Strength
   * (0..1, already computed by the caller from knockback magnitude)
   * scales particle count, size, and travel distance so a heavy hit is
   * unmistakably bigger than a jab. */
  spawnHit(input: HitEffectInput): void {
    const strength = Math.max(0, Math.min(1, input.strength));
    const sparkCount = 3 + Math.round(strength * 6);
    for (let i = 0; i < sparkCount; i++) {
      if (this.particles.length >= MAX_SPARK_PARTICLES) {
        // Same degrade-gracefully rule as MAX_TRAIL_SEGMENTS: drop the
        // oldest (closest to fading anyway) rather than skip the new
        // hit's spark, so the pile-up that's actually happening right
        // now stays visible instead of the oldest leftover from a
        // moment ago.
        const oldest = this.particles.shift();
        oldest?.g.destroy();
      }
      const g = new Graphics();
      const size = 1.5 + strength * 2.5 + Math.random() * 1.5;
      g.circle(0, 0, size);
      g.fill({ color: SPARK_COLOR });
      g.position.set(input.x, input.y);
      this.particleLayer.addChild(g);
      const spread = (Math.random() - 0.5) * 1.4;
      const speed = (2 + strength * 6) * (0.6 + Math.random() * 0.8);
      const dx = input.dirX + spread;
      const dy = input.dirY + spread;
      const len = Math.hypot(dx, dy) || 1;
      this.particles.push({
        g,
        vx: (dx / len) * speed,
        vy: (dy / len) * speed,
        ageMs: 0,
        lifeMs: 160 + strength * 140,
        size,
      });
    }

    // Directional "smear" pop: a short stretched shape along the
    // knockback direction, bigger/longer for stronger hits.
    const pop = new Graphics();
    const len = 8 + strength * 28;
    const thickness = 3 + strength * 4;
    const angle = Math.atan2(input.dirY, input.dirX);
    pop.roundRect(-len / 2, -thickness / 2, len, thickness, thickness / 2);
    pop.fill({ color: POP_COLOR, alpha: 0.85 });
    pop.position.set(input.x, input.y);
    pop.rotation = angle;
    if (this.pops.length >= MAX_POPS) {
      const oldest = this.pops.shift();
      oldest?.g.destroy();
    }
    this.popLayer.addChild(pop);
    this.pops.push({ g: pop, ageMs: 0, lifeMs: 120 + strength * 80, baseScale: 1 });

    this.addShake(strength, 1, input.shakeAttenuation ?? 1);
  }

  /** Called once per fighter per render frame with its current screen
   * position and whether it's currently in hitstun. Presentation-only:
   * reads screen coordinates the renderer already computed from sim
   * state, never sim velocity/PRNG, and never writes anything back.
   * When the fighter is moving fast enough while in hitstun, drops a
   * short fading streak behind it so a big launch reads as violent
   * motion rather than a silent teleport-slide. Capped so 20
   * simultaneous launches degrade to fewer/shorter segments instead of
   * piling up Graphics nodes. */
  trailFighter(fighterIndex: number, x: number, y: number, inHitstun: boolean): void {
    const prev = this.lastTrailPos.get(fighterIndex);
    this.lastTrailPos.set(fighterIndex, { x, y });
    if (!prev || !inHitstun) return;
    const dx = x - prev.x;
    const dy = y - prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist < TRAIL_SPEED_THRESHOLD_PX) return;
    if (this.trails.length >= MAX_TRAIL_SEGMENTS) {
      // Drop the oldest segment rather than skip the new one -- under
      // heavy load this keeps the *most recent* hits visible, which is
      // what a player is looking at, instead of starving them in favour
      // of older trails that are about to expire anyway.
      const oldest = this.trails.shift();
      oldest?.g.destroy();
    }
    const speedFrac = Math.min(1, (dist - TRAIL_SPEED_THRESHOLD_PX) / 40);
    const thickness = 3 + speedFrac * 4;
    const g = new Graphics();
    g.moveTo(prev.x, prev.y);
    g.lineTo(x, y);
    g.stroke({ color: TRAIL_COLOR, width: thickness, alpha: 0.5 + speedFrac * 0.3 });
    this.trailLayer.addChild(g);
    this.trails.push({ g, ageMs: 0, lifeMs: 110 + speedFrac * 80 });
  }

  /** Drop tracked position state for a fighter that's no longer live
   * (eliminated / respawned) so a stale huge jump doesn't get read as a
   * trail-worthy "speed" on its next appearance. */
  resetTrail(fighterIndex: number): void {
    this.lastTrailPos.delete(fighterIndex);
  }

  /** A bigger, screen-anchored moment for an elimination: a bright ring
   * pop at the fighter's last position and a stronger shake. Kept flat
   * and geometric -- no glow/bloom -- per the project's visual language. */
  spawnElimination(x: number, y: number, shakeAttenuation = 1): void {
    const ring = new Graphics();
    ring.circle(0, 0, 6);
    ring.stroke({ color: PALETTE.danger, width: 4 });
    ring.position.set(x, y);
    if (this.pops.length >= MAX_POPS) {
      const oldest = this.pops.shift();
      oldest?.g.destroy();
    }
    this.popLayer.addChild(ring);
    this.pops.push({ g: ring, ageMs: 0, lifeMs: 380, baseScale: 1 });
    this.addShake(1, /* eliminationBoost */ 1.5, shakeAttenuation);
  }

  /** Quadrature-ish combine so simultaneous hits (common with 20
   * fighters) approach a cap instead of summing linearly into nausea.
   * `distanceAttenuation` (0..1) is decided by the caller from how far
   * the hit was from the local player's own fighter -- a hit on the far
   * side of a 20-fighter arena that the local player had nothing to do
   * with should not shake their whole screen, so it scales the
   * contribution down to (and including) zero rather than being an
   * all-or-nothing cutoff, which reads more like natural falloff than a
   * hard pop in/out. */
  private addShake(strength: number, boost = 1, distanceAttenuation = 1): void {
    if (shakeScale === 0) return;
    const atten = Math.max(0, Math.min(1, distanceAttenuation));
    if (atten <= 0) return;
    const add = (3 + strength * 10) * boost * shakeScale * atten;
    this.shakeMagnitude = Math.min(22, Math.sqrt(this.shakeMagnitude * this.shakeMagnitude + add * add));
  }

  /** Advance all timers/particles by `dtMs` of wall-clock render time.
   * Returns the current shake offset to apply to the world container.
   *
   * Dev-only capture aid: if `window.__debugEffectTimeScale` is set to a
   * number, dtMs is scaled by it before anything ages (e.g. 0.02 makes a
   * ~200ms burst take ~10s of real time to fade). Screenshot round-trips
   * in browser automation lag the live canvas by 1-2s, longer than any
   * of these effects live, so this is how a weak-hit and a strong-hit
   * frame get captured side by side for review. Defaults to 1 (no
   * change) whenever the flag isn't set, so it costs nothing in
   * production and can't accidentally ship slow. Left behind (not
   * deleted after use) because it is generically useful for reviewing
   * any future impact-effect tuning the same way. */
  update(dtMs: number): { x: number; y: number } {
    const timeScale =
      typeof window !== 'undefined' && typeof (window as unknown as Record<string, unknown>).__debugEffectTimeScale === 'number'
        ? ((window as unknown as Record<string, unknown>).__debugEffectTimeScale as number)
        : 1;
    dtMs *= timeScale;
    for (const [idx, remaining] of this.flashRemainingMs) {
      const next = remaining - dtMs;
      if (next <= 0) this.flashRemainingMs.delete(idx);
      else this.flashRemainingMs.set(idx, next);
    }

    this.particles = this.particles.filter((p) => {
      p.ageMs += dtMs;
      if (p.ageMs >= p.lifeMs) {
        p.g.destroy();
        return false;
      }
      const t = p.ageMs / p.lifeMs;
      p.g.x += p.vx * (dtMs / 16.6667);
      p.g.y += p.vy * (dtMs / 16.6667);
      p.g.alpha = 1 - t;
      p.g.scale.set(1 - 0.4 * t);
      return true;
    });

    this.pops = this.pops.filter((p) => {
      p.ageMs += dtMs;
      if (p.ageMs >= p.lifeMs) {
        p.g.destroy();
        return false;
      }
      const t = p.ageMs / p.lifeMs;
      p.g.alpha = (1 - t) * 0.9;
      p.g.scale.set(p.baseScale * (1 + t * 1.6));
      return true;
    });

    this.trails = this.trails.filter((seg) => {
      seg.ageMs += dtMs;
      if (seg.ageMs >= seg.lifeMs) {
        seg.g.destroy();
        return false;
      }
      seg.g.alpha *= 1 - dtMs / seg.lifeMs;
      return true;
    });

    if (this.shakeMagnitude > 0.05) {
      this.shakeMagnitude = Math.max(0, this.shakeMagnitude - this.shakeDecayPerMs * dtMs * 60);
    } else {
      this.shakeMagnitude = 0;
    }

    if (this.shakeMagnitude <= 0) return { x: 0, y: 0 };
    // Cheap deterministic-ish jitter (visual only -- does not need to be
    // reproducible/synced across clients).
    this.shakeSeed = (this.shakeSeed * 1103515245 + 12345) & 0x7fffffff;
    const r1 = (this.shakeSeed % 1000) / 1000 - 0.5;
    this.shakeSeed = (this.shakeSeed * 1103515245 + 12345) & 0x7fffffff;
    const r2 = (this.shakeSeed % 1000) / 1000 - 0.5;
    return { x: r1 * 2 * this.shakeMagnitude, y: r2 * 2 * this.shakeMagnitude };
  }
}
