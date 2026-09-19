// Deterministic stand-in for Pixi's CanvasTextMetrics, used only in
// tests (no canvas/GL context is available in this Node test runner --
// see character-icon-shared-context.test.ts for the same constraint).
// Production uses the real Pixi measurement (index.ts's
// measureBadgeText); this fake exists so tests exercise real geometry
// -- distinguishing e.g. "Bramble 75%" from "11 40%" by actual character
// composition -- rather than a character *count*, which is exactly the
// bug class this measurer replaced (2026-09-18 live-match garbling:
// "Cinder 6:1910", "Junco 76% 17").
import type { MeasureText } from '../src/badge-layout.ts';

const CHAR_WIDTH_EM: Record<string, number> = {
  ' ': 0.3,
  '%': 0.75,
  ':': 0.3,
};

function charWidthEm(ch: string): number {
  if (CHAR_WIDTH_EM[ch] !== undefined) return CHAR_WIDTH_EM[ch] as number;
  if (ch >= '0' && ch <= '9') return 0.6;
  if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) return 0.65;
  return 0.55;
}

export const fakeMeasureText: MeasureText = (label, fontSize) => {
  let widthEm = 0;
  for (const ch of label) widthEm += charWidthEm(ch);
  return { width: widthEm * fontSize, height: fontSize * 1.15 };
};
