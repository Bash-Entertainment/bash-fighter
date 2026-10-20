// Bridges detected EffectEvents to (a) renderer-facing PendingHitEffect/
// PendingEliminationEffect queues in world space, and (b) AudioManager
// playback. One instance per Match/NetMatch. Presentation-only: consumes
// events, never mutates sim state.
import { fixed as fx, type CharacterData, type FighterSnapshot } from '@bash-fighter/sim';
import type { PendingHitEffect, PendingEliminationEffect } from '@bash-fighter/render';
import { AudioManager } from '@bash-fighter/audio';
import type { EffectEvent } from './effects-events.ts';
import { showKoPop } from './ui/ko-pop.ts';

export class EffectsAudioBridge {
  /** One entry per fighter slot, used only to look up weight for "a hit
   * should sound like what it was" -- never read for anything that
   * could affect what's drawn or simulated. Mutable via setContext()
   * because NetMatch doesn't know its character roster or slot until
   * the server confirms them, after this bridge is constructed. */
  private characters: readonly CharacterData[] = [];
  /** Which fighter slot is the local player, for own-vs-other audio
   * treatment. -1 (e.g. a pure spectator) means every event is treated
   * as "other". */
  private localFighterIndex = 0;

  constructor(private readonly audio: AudioManager) {}

  /** Called once the caller knows its character roster / local slot
   * (immediately for a local Match; on server confirmation for
   * NetMatch). Safe to call more than once as the roster/slot change. */
  setContext(characters: readonly CharacterData[], localFighterIndex: number): void {
    this.characters = characters;
    this.localFighterIndex = localFighterIndex;
  }

  private weightOf(fighterIndex: number): number | undefined {
    const c = this.characters[fighterIndex];
    return c ? fx.toFloat(c.weight) : undefined;
  }

  private landedByLocal(attackerIndex: number, victimIndex: number): boolean {
    return this.localFighterIndex >= 0 && attackerIndex === this.localFighterIndex && victimIndex !== this.localFighterIndex;
  }

  private isOwn(fighterIndex: number): boolean {
    return this.localFighterIndex >= 0 && fighterIndex === this.localFighterIndex;
  }

  /** Consumes this tick/snapshot's events against the *current* fighter
   * snapshots (for world position) and returns what the renderer should
   * draw. Also fires the matching sounds, each event exactly once. */
  consume(
    events: readonly EffectEvent[],
    currFighters: readonly FighterSnapshot[],
  ): { hitEffects: PendingHitEffect[]; eliminationEffects: PendingEliminationEffect[] } {
    const hitEffects: PendingHitEffect[] = [];
    const eliminationEffects: PendingEliminationEffect[] = [];

    for (const ev of events) {
      if (ev.type === 'hit') {
        const f = currFighters[ev.fighterIndex];
        if (!f) continue;
        const landed = this.landedByLocal(ev.attackerIndex, ev.fighterIndex);
        hitEffects.push({
          fighterIndex: ev.fighterIndex,
          worldX: fx.toFloat(f.posX),
          worldY: fx.toFloat(f.posY),
          dirX: ev.dirX,
          dirY: ev.dirY,
          strength: ev.strength,
          strong: ev.strong,
          landed,
        });
        this.audio.playHit({
          damage: ev.damage,
          strength: ev.strength,
          weight: this.weightOf(ev.fighterIndex),
          isOwn: this.isOwn(ev.fighterIndex) || landed,
          landed,
          // Deterministic per-event seed from data the sim already gives
          // us (fighter index + this tick's damage), never Math.random().
          seed: ev.fighterIndex * 7919 + ev.damage * 1000,
        });
      } else if (ev.type === 'block') {
        this.audio.playHit({
          damage: 0,
          strength: 0.5,
          isShield: true,
          isOwn: this.isOwn(ev.fighterIndex),
          seed: ev.fighterIndex * 104729,
        });
      } else if (ev.type === 'eliminated') {
        const f = currFighters[ev.fighterIndex];
        if (f) eliminationEffects.push({ worldX: fx.toFloat(f.posX), worldY: fx.toFloat(f.posY) });
        this.audio.playElimination(this.isOwn(ev.fighterIndex));
      } else if (ev.type === 'knockout') {
        if (this.isOwn(ev.fighterIndex)) {
          this.audio.playKnockout();
          showKoPop();
        }
      } else if (ev.type === 'itemPickup') {
        this.audio.playItemPickup(this.isOwn(ev.fighterIndex));
      } else if (ev.type === 'itemUse') {
        this.audio.playItemUse();
      } else if (ev.type === 'jump') {
        this.audio.playJump(this.isOwn(ev.fighterIndex));
      } else if (ev.type === 'finalTwo') {
        this.audio.playFinalTwo();
      } else if (ev.type === 'victory') {
        this.audio.playVictory();
      }
    }

    return { hitEffects, eliminationEffects };
  }
}
