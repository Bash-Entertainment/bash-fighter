// Rookie series panel on the Timed Brawl end screen (see ../rookie-series.ts).
import {
  bestMatchLine, isComplete, matchLines, progressLine, resultLine, totalKos, type SeriesState,
} from '../rookie-series.ts';

export interface SeriesPanelView {
  heading: string;
  lines: string[];
  footer: string;
}

export function seriesPanelView(state: SeriesState): SeriesPanelView {
  if (isComplete(state)) return { heading: resultLine(state), lines: matchLines(state), footer: bestMatchLine(state) };
  return { heading: `Rookie series \u00b7 ${totalKos(state)} KOs so far`, lines: matchLines(state), footer: progressLine(state) };
}

/** textContent only; null hides the panel. */
export function renderSeriesPanel(el: HTMLElement, view: SeriesPanelView | null): void {
  el.replaceChildren();
  el.classList.toggle('hidden', !view);
  if (!view) return;
  const heading = document.createElement('div');
  heading.className = 'series-heading';
  heading.textContent = view.heading;
  const lines = document.createElement('div');
  lines.className = 'series-lines';
  for (const text of view.lines) {
    const line = document.createElement('span');
    line.textContent = text;
    lines.appendChild(line);
  }
  const footer = document.createElement('div');
  footer.className = 'series-footer';
  footer.textContent = view.footer;
  el.append(heading, lines, footer);
}
