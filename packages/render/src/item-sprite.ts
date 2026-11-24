// Item silhouettes (this task): every item type must read distinctly at a
// glance even zoomed out for 20 fighters, so each type gets its own shape,
// not just a colour swap of the same box. World units, same convention as
// FighterSprite: the root is scaled by the camera's pixels-per-unit factor.
import { Graphics } from 'pixi.js';
import { PALETTE } from './palette.ts';

// Mirrors packages/sim/src/items/types.ts ItemTypeId. Kept as a local
// literal union (not imported) because packages/sim does not export this
// table from its package index yet; the numeric ids are the sim's stable
// wire/storage values, documented there.
export const RenderItemTypeId = {
  THROWN: 0,
  BAT: 1,
  BOMB: 2,
  HEAL: 3,
} as const;

export interface ItemVisualState {
  typeId: number;
  held: boolean;
  facing: 1 | -1;
  /** 'armed' explosive: fuse counting down, used to pulse the warning. */
  armed: boolean;
  fuseTicks: number;
}

// A little bigger than a fighter's head, small enough to read as "a small
// pickup" rather than another fighter.
const SIZE = 9;

export class ItemSprite {
  readonly root = new Graphics();

  draw(state: ItemVisualState): void {
    const g = this.root;
    g.clear();

    switch (state.typeId) {
      case RenderItemTypeId.BAT:
        this.drawBat(g, state);
        break;
      case RenderItemTypeId.BOMB:
        this.drawBomb(g, state);
        break;
      case RenderItemTypeId.HEAL:
        this.drawHeal(g);
        break;
      default:
        this.drawRock(g);
        break;
    }
  }

  // Debug Rock: an irregular blocky polygon so it doesn't read as a
  // generic circle/box like everything else.
  private drawRock(g: Graphics): void {
    const s = SIZE * 0.6;
    g.poly([-s, s * 0.4, -s * 0.5, -s, s * 0.3, -s * 0.9, s, -s * 0.1, s * 0.6, s, -s * 0.2, s * 0.8]);
    g.fill({ color: PALETTE.itemThrown });
    g.stroke({ color: PALETTE.itemOutline, width: 1.5 });
  }

  // Bat: a long thin handle+barrel, oriented along facing so it reads as
  // a melee weapon rather than a pickup blob.
  private drawBat(g: Graphics, state: ItemVisualState): void {
    // A held bat is drawn bigger with an amber halo: it is the player's
    // weapon (Weapon Drop), so it has to read at 20-fighter zoom.
    const k = state.held ? 1.7 : 1;
    const len = SIZE * 2.1 * k;
    const w = SIZE * k;
    const f = state.facing;
    const outline = (): void => {
      g.moveTo(-len * 0.35 * f, w * 0.35);
      g.lineTo(len * 0.65 * f, w * 0.12);
      g.lineTo(len * 0.65 * f, -w * 0.12);
      g.lineTo(-len * 0.35 * f, -w * 0.35);
      g.closePath();
    };
    if (state.held) {
      outline();
      g.stroke({ color: PALETTE.itemBatGlow, width: 6, alpha: 0.45 });
    }
    outline();
    g.fill({ color: PALETTE.itemBat });
    g.stroke({ color: PALETTE.itemOutline, width: 1.5 });
  }

  // Bomb: round shell with a fuse tick and a warning stripe once armed —
  // it must be obvious an armed bomb is about to go off, not just sitting.
  private drawBomb(g: Graphics, state: ItemVisualState): void {
    const r = SIZE * 0.6;
    g.circle(0, 0, r);
    g.fill({ color: PALETTE.itemBomb });
    g.stroke({ color: PALETTE.itemOutline, width: 1.5 });
    // Fuse stub.
    g.moveTo(0, -r);
    g.lineTo(r * 0.3, -r * 1.6);
    g.stroke({ color: PALETTE.hudDim, width: 1.5 });
    if (state.armed) {
      // Blink faster as the fuse runs down: alternate stripe visibility
      // based on fuseTicks parity bucketed to be visible per-frame.
      const blinkOn = Math.floor(state.fuseTicks / 6) % 2 === 0;
      if (blinkOn) {
        g.circle(0, 0, r * 1.35);
        g.stroke({ color: PALETTE.hazardWarning, width: 2 });
      }
    }
  }

  // Heal: a plain cross, the one shape in the set with no aggressive
  // connotation at all.
  private drawHeal(g: Graphics): void {
    const s = SIZE * 0.55;
    const t = SIZE * 0.28;
    g.roundRect(-t / 2, -s, t, s * 2, 2);
    g.fill({ color: PALETTE.itemHeal });
    g.roundRect(-s, -t / 2, s * 2, t, 2);
    g.fill({ color: PALETTE.itemHeal });
    g.stroke({ color: PALETTE.itemOutline, width: 1.5 });
  }
}
