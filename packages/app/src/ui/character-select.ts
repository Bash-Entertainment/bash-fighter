// Character-select grid: one card per entry in @bash-fighter/content's
// roster. Deliberately generic -- it iterates ALL_CHARACTERS rather than
// switching on known ids, so a third character becomes selectable the
// moment it's added to that package's roster, with no change here.
import { ALL_CHARACTERS } from '@bash-fighter/content';
import { renderCharacterIcon } from '@bash-fighter/render';
import { moveReferenceFor } from '../move-reference-data.ts';

// Deterministic per-id color, used both as the card's tint and as the fill
// colour handed to renderCharacterIcon -- the icon is the character's own
// FighterSprite silhouette (see packages/render/src/character-icon.ts), not
// a stand-in asset, so this screen shows exactly what a fighter looks like
// in a match, just recoloured per id like every other player slot.
const SWATCH_PALETTE = ['#e8b23c', '#4fa3c4', '#8a5fd1', '#5fd18a', '#d75f8a', '#d7593f', '#3fbfa0'];

function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return SWATCH_PALETTE[h % SWATCH_PALETTE.length] as string;
}

export class CharacterSelect {
  readonly root: HTMLDivElement;
  private selectedId: string;
  private readonly cards = new Map<string, HTMLButtonElement>();
  private readonly previewTitleEl: HTMLDivElement;
  private readonly previewListEl: HTMLDivElement;

  constructor(parent: HTMLElement, defaultId: string, onChange: (id: string) => void) {
    this.root = document.createElement('div');
    this.root.className = 'roster-select';
    this.root.id = 'character-select';

    const row = document.createElement('div');
    row.className = 'roster-row';

    // Moveset preview: shows the moves of whichever card was most
    // recently hovered/focused, falling back to the current selection, so
    // a player can see what a character does before picking them without
    // leaving this screen. Reuses the same data source and row shape as
    // the in-match move reference panel (move-reference-data.ts) instead
    // of duplicating move copy here.
    const preview = document.createElement('div');
    preview.className = 'roster-preview';
    preview.innerHTML = `
      <div class="roster-preview-title"></div>
      <div class="roster-preview-list"></div>
    `;
    this.previewTitleEl = preview.querySelector('.roster-preview-title') as HTMLDivElement;
    this.previewListEl = preview.querySelector('.roster-preview-list') as HTMLDivElement;

    for (const entry of ALL_CHARACTERS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'roster-card';
      card.dataset.characterId = entry.id;

      const swatch = document.createElement('div');
      swatch.className = 'roster-swatch';
      swatch.style.background = 'transparent';
      const icon = document.createElement('img');
      icon.className = 'roster-icon';
      icon.alt = `${entry.character.name} silhouette`;
      swatch.appendChild(icon);
      const tint = Number.parseInt(colorForId(entry.id).slice(1), 16);
      renderCharacterIcon(entry.character.name, tint).then((url) => {
        icon.src = url;
      });

      const name = document.createElement('div');
      name.className = 'roster-name';
      name.textContent = entry.character.name;

      const blurb = document.createElement('div');
      blurb.className = 'roster-blurb';
      blurb.textContent = entry.character.blurb ?? '';

      const weight = document.createElement('div');
      weight.className = 'roster-weight';
      weight.textContent = `weight ${Math.round(entry.character.weight / 65536)}`;

      card.append(swatch, name, blurb, weight);
      card.setAttribute(
        'aria-label',
        entry.character.blurb
          ? `${entry.character.name}: ${entry.character.blurb}`
          : entry.character.name,
      );
      card.addEventListener('click', () => this.select(entry.id, onChange));
      // Preview updates on hover/keyboard-focus without changing the pick,
      // so a player can flip through movesets before committing. Falls
      // back to the selected character on mouseleave/blur rather than
      // going blank.
      card.addEventListener('mouseenter', () => this.renderPreview(entry.id));
      card.addEventListener('focus', () => this.renderPreview(entry.id));
      card.addEventListener('mouseleave', () => this.renderPreview(this.selectedId));
      card.addEventListener('blur', () => this.renderPreview(this.selectedId));
      this.cards.set(entry.id, card);
      row.appendChild(card);
    }

    this.root.append(row, preview);
    parent.appendChild(this.root);
    // Fall back to the first roster entry if defaultId isn't known (e.g.
    // roster changed), so there is always a valid selection to start with.
    const initial = this.cards.has(defaultId) ? defaultId : (ALL_CHARACTERS[0]?.id ?? defaultId);
    this.selectedId = initial;
    this.applySelectionStyles();
    this.renderPreview(initial);
  }

  private select(id: string, onChange: (id: string) => void): void {
    if (id !== this.selectedId) {
      this.selectedId = id;
      this.applySelectionStyles();
      onChange(id);
    }
    this.renderPreview(id);
  }

  private applySelectionStyles(): void {
    for (const [cid, card] of this.cards) card.classList.toggle('selected', cid === this.selectedId);
  }

  private renderPreview(id: string): void {
    const entry = ALL_CHARACTERS.find((e) => e.id === id);
    if (!entry) return;
    this.previewTitleEl.textContent = `${entry.character.name} — moves`;
    const moves = moveReferenceFor(entry.character);
    this.previewListEl.innerHTML = '';
    for (const move of moves) {
      const row = document.createElement('div');
      row.className = 'roster-preview-row';
      row.innerHTML = `
        <div class="roster-preview-name">${move.name}</div>
        <div class="roster-preview-input">${move.input}</div>
        <div class="roster-preview-desc">${move.description}</div>
      `;
      this.previewListEl.appendChild(row);
    }
  }

  get value(): string {
    return this.selectedId;
  }
}
