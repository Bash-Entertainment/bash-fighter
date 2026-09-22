// In-match HUD: percent + stocks per fighter, plus a survivors-remaining
// count once fighters start getting eliminated. Built as a data-driven
// list (not "left card / right card") so it degrades from two big
// readouts to a compact row/list as fighter count grows toward a
// 20-player FFA, without a structural rewrite — same markup, denser CSS
// class for N>4. Eliminated status is optional per-card input, sourced
// from spectator/types.ts's MatchAdapter once wired up.
import { fixed as fx, FighterStateId, type FighterSnapshot } from '@bash-fighter/sim';
import { PALETTE } from '@bash-fighter/render';
import { survivorsLineText, objectiveLineText, koStandingLineText, eliminationFeedLine, chipDisplayName, sortFeedEntriesNewestFirst, type EliminationFeedEntry } from './hud-text.ts';
import { koStandingInfo, type TimedBrawlScore } from '../timed-brawl.ts';

export interface HudFighterExtra {
  eliminated: boolean;
  placement: number | null;
}

/** Timed Brawl clock/score info for the HUD, or omitted entirely for
 * Battle Royale/'stocks' matches, which keep the original stocks-dots
 * column and no clock line -- see timed-brawl.ts for where clockText is
 * formatted. */
export interface HudTimedBrawlInfo {
  clockText: string;
}

/** Match-status block shown below the chip grid (the space reclaimed
 * 2026-09-14 -- previously permanently empty dead space on every match,
 * see wiki "Camera Framing: Ground Anchor and Jump-Space Bias" era
 * layout history for why the sidebar has full page height to give it).
 * Everything here comes from state the client already tracks -- no new
 * protocol fields. */
export interface HudMatchInfo {
  winCondition: 'battleRoyale' | 'timedKO' | 'stocks';
  /** "0:42" elapsed since match start, or remaining for Timed Brawl --
   * callers pass whichever is more useful for the mode. */
  clockText: string;
}

/** Caps the elimination feed so 20 fighters dying in ~90 seconds never
 * becomes a wall of text (see eliminationFeedLine in hud-text.ts). */
const ELIMINATION_FEED_LIMIT = 4;

const PLAYER_HEX = PALETTE.playerColors.map((c) => `#${c.toString(16).padStart(6, '0')}`);

export class Hud {
  readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private cards: HTMLDivElement[] = [];

  private readonly survivorsLine: HTMLDivElement;
  private readonly clockLine: HTMLDivElement;
  private readonly matchStatus: HTMLDivElement;
  private readonly matchModeLine: HTMLDivElement;
  private readonly matchClockLine: HTMLDivElement;
  private readonly koStandingLine: HTMLDivElement;
  private readonly eliminationFeed: HTMLDivElement;
  /** Tracks which slots we have already emitted a feed line for, reset
   * whenever a new match starts (see show()) so a rematch doesn't carry
   * over the previous match's eliminations. */
  private seenEliminated: boolean[] = [];
  /** Every elimination observed this match, kept ordered by true game
   * time (see sortFeedEntriesNewestFirst in hud-text.ts) rather than by
   * the order this client happened to render them in -- fixes a real
   * production bug where a laggy frame batching two deaths, or a
   * mid-match spectator join seeing several already-eliminated
   * fighters at once, rendered the feed in slot order instead of
   * elimination order. Not capped here; capped only at render time so
   * a late-observed-but-actually-older elimination can never displace
   * a genuinely more recent one. */
  private feedEntries: EliminationFeedEntry[] = [];
  private feedObservedCounter = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.className = 'hidden';
    this.clockLine = document.createElement('div');
    this.clockLine.className = 'hud-clock-line';
    this.clockLine.style.display = 'none';
    this.survivorsLine = document.createElement('div');
    this.survivorsLine.className = 'survivors-line';
    this.list = document.createElement('div');
    this.list.className = 'hud-list';
    this.matchStatus = document.createElement('div');
    this.matchStatus.className = 'match-status';
    this.matchModeLine = document.createElement('div');
    this.matchModeLine.className = 'match-status-mode';
    this.matchClockLine = document.createElement('div');
    this.matchClockLine.className = 'match-status-clock';
    this.koStandingLine = document.createElement('div');
    this.koStandingLine.className = 'match-status-ko';
    this.koStandingLine.style.display = 'none';
    this.eliminationFeed = document.createElement('div');
    this.eliminationFeed.className = 'elimination-feed';
    this.matchStatus.appendChild(this.matchModeLine);
    this.matchStatus.appendChild(this.matchClockLine);
    this.matchStatus.appendChild(this.koStandingLine);
    this.matchStatus.appendChild(this.eliminationFeed);
    this.root.appendChild(this.clockLine);
    this.root.appendChild(this.survivorsLine);
    this.root.appendChild(this.list);
    this.root.appendChild(this.matchStatus);
    parent.appendChild(this.root);
  }

  show(): void {
    this.root.classList.remove('hidden');
    // New match: forget the previous match's elimination feed so a
    // rematch starts clean instead of showing stale "X eliminated"
    // lines from the last game.
    this.seenEliminated = [];
    this.feedEntries = [];
    this.feedObservedCounter = 0;
    this.eliminationFeed.replaceChildren();
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  private ensureCards(count: number): void {
    // Two density steps: 'compact' once two big readouts stop fitting,
    // 'dense' once even compact cards would wrap into a screen-covering
    // block at 20-fighter counts -- same markup, just a third, tighter
    // CSS density instead of a different widget, so a 20p match still
    // reads as a HUD, not a page of debug text.
    this.list.classList.toggle('compact', count > 4 && count <= 10);
    this.list.classList.toggle('dense', count > 10);
    while (this.cards.length < count) {
      const card = document.createElement('div');
      card.className = 'hud-card';
      card.innerHTML = '<div class="slot-num"></div><div class="fighter-name"></div><div class="pct">0%</div><div class="stocks"></div>';
      this.cards.push(card);
      this.list.appendChild(card);
    }
    for (let i = count; i < this.cards.length; i++) {
      (this.cards[i] as HTMLDivElement).style.display = 'none';
    }
  }

  update(
    snapshots: readonly FighterSnapshot[],
    extras?: readonly HudFighterExtra[],
    localIndex = -1,
    names?: readonly string[],
    // Timed Brawl only (see HudTimedBrawlInfo above): switches the
    // right-hand column from stocks-remaining dots to a live KO/death
    // score line and shows the countdown clock. Absent (undefined) for
    // Battle Royale and 'stocks', which keep their original HUD exactly.
    timedBrawl?: HudTimedBrawlInfo,
    // Match-status block below the chip grid -- mode, win condition,
    // clock, and a short elimination feed. Optional so existing/future
    // callers that don't have match settings handy degrade to just not
    // showing the block, rather than throwing.
    matchInfo?: HudMatchInfo,
  ): void {
    this.ensureCards(snapshots.length);
    if (timedBrawl) {
      this.clockLine.textContent = timedBrawl.clockText;
      this.clockLine.style.display = '';
    } else {
      this.clockLine.style.display = 'none';
    }
    let survivors = 0;
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i] as FighterSnapshot;
      // extras (spectator-derived elimination status, local-only) take
      // priority when given; online matches have no extras so fall back
      // to the snapshot's own eliminated/placement fields, which the sim
      // fills in directly (see FighterSnapshot in packages/sim/src/sim.ts).
      const extra = extras?.[i];
      const eliminated = extra?.eliminated ?? s.eliminated;
      const placement = extra?.placement ?? (s.placement > 0 ? s.placement : null);
      if (!eliminated) survivors++;
      const card = this.cards[i] as HTMLDivElement;
      card.style.display = '';
      card.classList.toggle('eliminated', eliminated);
      card.classList.toggle('is-you', i === localIndex);
      card.style.borderLeftColor = PLAYER_HEX[i % PLAYER_HEX.length] as string;
      const pctEl = card.querySelector('.pct') as HTMLDivElement;
      const stocksEl = card.querySelector('.stocks') as HTMLDivElement;
      const numEl = card.querySelector('.slot-num') as HTMLDivElement;
      const nameEl = card.querySelector('.fighter-name') as HTMLDivElement;
      numEl.textContent = '#' + String(i + 1);
      // Slot number stays visible unconditionally (existing debug tooling,
      // the journal, and the elimination log are all slot-indexed -- see
      // docs/PROTOCOL.md), the chosen display name (if any) is shown
      // alongside it via textContent only, never innerHTML, so a hostile
      // name is always plain text here regardless of what the server
      // already stripped. names[] and '#N' fallback come from
      // NetMatch.nameFor()/Match's slot labels -- this component just
      // renders whatever it's given.
      const name = names?.[i];
      // Chip column only -- see chipDisplayName's doc comment. World-space
      // labels and the elimination feed below keep the full name.
      nameEl.textContent = name && name.length > 0 ? chipDisplayName(name) : '';
      nameEl.style.display = nameEl.textContent ? '' : 'none';
      const pct = Math.round(fx.toFloat(s.percent));
      pctEl.textContent = `${pct}%`;
      pctEl.style.color = s.state === FighterStateId.DEAD ? '#666' : pct >= 100 ? PALETTE_DANGER_HEX : '';
      if (timedBrawl) {
        // Fighters never carry an 'eliminated'/placement state in Timed
        // Brawl (they respawn instead, see respawnsEnabled in
        // packages/sim/src/match-settings.ts), so this branch always
        // takes over the stocks-dots column with the running score --
        // the thing that actually decides the match in this mode.
        stocksEl.textContent = `${s.koCount} KO${s.deathCount > 0 ? ` · ${s.deathCount} D` : ''}`;
      } else if (eliminated) {
        stocksEl.textContent = placement ? `OUT · ${placement}` : 'OUT';
      } else {
        stocksEl.textContent = '●'.repeat(Math.max(0, s.stocks)) || '—';
      }
    }
    this.survivorsLine.textContent = survivorsLineText(survivors, snapshots.length, Boolean(timedBrawl));
    this.survivorsLine.style.display = this.survivorsLine.textContent ? '' : 'none';
    this.updateMatchStatus(snapshots, extras, names, matchInfo, localIndex);
  }

  /** Renders the mode/win-condition/clock line plus a capped elimination
   * feed, and detects newly-eliminated fighters (transition from not
   * eliminated to eliminated across successive update() calls) to add a
   * feed line -- no separate event stream needed, this is exactly the
   * same eliminated/placement fields the chip grid already renders. */
  private updateMatchStatus(
    snapshots: readonly FighterSnapshot[],
    extras: readonly HudFighterExtra[] | undefined,
    names: readonly string[] | undefined,
    matchInfo: HudMatchInfo | undefined,
    localIndex: number,
  ): void {
    if (!matchInfo) {
      this.matchStatus.style.display = 'none';
      return;
    }
    this.matchStatus.style.display = '';
    this.matchModeLine.textContent = objectiveLineText(matchInfo.winCondition, localIndex < 0);
    this.matchClockLine.textContent = matchInfo.clockText;
    // Timed Brawl already gets the big amber .hud-clock-line at the top
    // of the HUD, so showing the same countdown again here printed the
    // clock twice -- two different sizes, ~95px apart on a 493px-tall
    // phone screen. Keep the prominent one; this line still carries the
    // elapsed time in every other mode, where there is no top clock.
    this.matchClockLine.style.display = matchInfo.winCondition === 'timedKO' ? 'none' : '';
    // Live knockout standing (2026-09-19): Timed Brawl only, since it's
    // the only mode actually decided by KO count -- see koStandingInfo
    // in timed-brawl.ts. Own count/rank + the leader's count, never a
    // full table, so it stays quiet next to the damage sidebar.
    if (matchInfo.winCondition === 'timedKO' && localIndex >= 0 && localIndex < snapshots.length) {
      const scores: TimedBrawlScore[] = snapshots.map((s, i) => ({ slot: i, koCount: s.koCount, deathCount: s.deathCount }));
      const info = koStandingInfo(scores, localIndex);
      if (info) {
        this.koStandingLine.textContent = koStandingLineText(info.ownKo, info.ownRank, info.totalFighters, info.leaderKo);
        this.koStandingLine.style.display = '';
      } else {
        this.koStandingLine.style.display = 'none';
      }
    } else {
      this.koStandingLine.style.display = 'none';
    }
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i] as FighterSnapshot;
      const extra = extras?.[i];
      const eliminated = extra?.eliminated ?? s.eliminated;
      if (!eliminated) continue;
      if (this.seenEliminated[i]) continue;
      this.seenEliminated[i] = true;
      const placement = extra?.placement ?? (s.placement > 0 ? s.placement : null);
      const name = names?.[i] && (names[i] as string).length > 0 ? (names[i] as string) : `#${i + 1}`;
      this.feedEntries.push({ name, placement, observedOrder: this.feedObservedCounter++ });
    }
    // Sort by true elimination order (placement, ascending -- see
    // sortFeedEntriesNewestFirst), not by when we happened to observe
    // it, then keep only the N most recent for both display and
    // storage so the array can't grow unbounded over a long match.
    const ordered = sortFeedEntriesNewestFirst(this.feedEntries).slice(0, ELIMINATION_FEED_LIMIT);
    this.feedEntries = ordered;
    this.eliminationFeed.replaceChildren(
      ...ordered.map((entry) => {
        const row = document.createElement('div');
        row.className = 'elimination-feed-line';
        row.textContent = eliminationFeedLine(entry.name, entry.placement);
        return row;
      }),
    );
  }
}

const PALETTE_DANGER_HEX = `#${PALETTE.danger.toString(16).padStart(6, '0')}`;
