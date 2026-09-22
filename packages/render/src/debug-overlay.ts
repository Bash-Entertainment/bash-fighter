// Toggleable debug view: hitboxes/hurtboxes color-coded by owner and active
// state, plus a text readout of state machine state, frame-window index,
// percent, sim tick, and state hash. Reads sim/content data only — never
// mutates it.
import { Graphics, Text, TextStyle } from 'pixi.js';
import {
  fixed as fx,
  findMove,
  windowAtFrame,
  FighterStateId,
  type CharacterData,
  type FighterStateValue,
} from '@bash-fighter/sim';
import type { CameraView } from './camera.ts';
import { worldToScreen } from './camera.ts';
import { PALETTE, FONT_FAMILY } from './palette.ts';

const STATE_NAMES: Record<number, string> = {
  [FighterStateId.IDLE]: 'IDLE',
  [FighterStateId.RUN]: 'RUN',
  [FighterStateId.JUMP]: 'JUMP',
  [FighterStateId.AIRBORNE]: 'AIRBORNE',
  [FighterStateId.ATTACK]: 'ATTACK',
  [FighterStateId.HITSTUN]: 'HITSTUN',
  [FighterStateId.SHIELD]: 'SHIELD',
  [FighterStateId.LEDGE]: 'LEDGE',
  [FighterStateId.DEAD]: 'DEAD',
  [FighterStateId.RESPAWN]: 'RESPAWN',
};

export interface DebugFighterInput {
  x: number;
  y: number; // world floats
  facing: 1 | -1;
  state: FighterStateValue;
  moveId: number;
  moveFrame: number;
  percent: number;
  character: CharacterData;
}

function drawBoxWorld(
  g: Graphics,
  minXf: number,
  minYf: number,
  maxXf: number,
  maxYf: number,
  color: number,
  cam: CameraView,
  vw: number,
  vh: number,
  alpha: number,
): void {
  const p0 = worldToScreen(minXf, maxYf, cam, vw, vh);
  const p1 = worldToScreen(maxXf, minYf, cam, vw, vh);
  g.rect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
  g.fill({ color, alpha: alpha * 0.25 });
  g.stroke({ color, width: 2, alpha });
}

export function drawDebugBoxes(
  g: Graphics,
  fighters: readonly DebugFighterInput[],
  cam: CameraView,
  vw: number,
  vh: number,
): void {
  g.clear();
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i] as DebugFighterInput;
    const hurtColor = PALETTE.hurtbox[i % PALETTE.hurtbox.length] as number;
    const hw = fx.toFloat(f.character.hurtboxWidth);
    const hh = fx.toFloat(f.character.hurtboxHeight);
    drawBoxWorld(g, f.x - hw / 2, f.y - hh / 2, f.x + hw / 2, f.y + hh / 2, hurtColor, cam, vw, vh, 0.9);

    if (f.state !== FighterStateId.ATTACK || f.moveId < 0) continue;
    const move = findMove(f.character, f.moveId as never);
    if (!move) continue;
    // Match sim.ts resolveHitsFor: moveFrame was already incremented for
    // this tick before hit resolution, so the window that was actually
    // active is at (moveFrame - 1), not moveFrame.
    const located = windowAtFrame(move, f.moveFrame - 1);
    if (!located || located.window.kind !== 'active') continue;
    for (const hb of located.window.hitboxes) {
      const offX = f.facing < 0 ? -fx.toFloat(hb.offsetX) : fx.toFloat(hb.offsetX);
      const cx = f.x + offX;
      const cy = f.y + fx.toFloat(hb.offsetY);
      const w = fx.toFloat(hb.width);
      const h = fx.toFloat(hb.height);
      drawBoxWorld(g, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, PALETTE.hitbox, cam, vw, vh, 1);
    }
  }
}

const textStyle = new TextStyle({
  fontFamily: FONT_FAMILY,
  fontSize: 12,
  fill: PALETTE.debugText,
  lineHeight: 15,
});

export function makeDebugText(): Text {
  return new Text({ text: '', style: textStyle });
}

export function formatDebugText(
  fighters: readonly DebugFighterInput[],
  tick: number,
  hash: string,
  resolution: number,
  downgrades: number,
): string {
  const lines: string[] = [
    `tick ${tick}  hash ${hash}`,
    `res ${resolution}x  downgrades ${downgrades}`,
  ];
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i] as DebugFighterInput;
    const move = f.moveId >= 0 ? findMove(f.character, f.moveId as never) : undefined;
    const win = move ? windowAtFrame(move, f.moveFrame - 1) : null;
    const winDesc = win ? `${win.window.kind}:${win.frameInWindow}/${win.window.duration}` : '-';
    lines.push(
      `P${i + 1} ${STATE_NAMES[f.state] ?? `STATE${f.state}`}  move=${move ? move.name : '-'} win=${winDesc}  pct=${(f.percent / 65536).toFixed(1)}`,
    );
  }
  return lines.join('\n');
}
