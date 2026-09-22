// Online play: connects to the authoritative server, predicts only the
// local fighter between snapshots, reconciles it against server state on
// every snapshot, and interpolates every remote fighter between the last
// two received snapshots. See docs/PROTOCOL.md for the wire format this
// implements against.
import {
  Sim,
  fixed as fx,
  makeInputFrame,
  MAX_ITEMS,
  MAX_HAZARDS,
  DEFAULT_ARENA,
  resolveMatchSettings,
  type FighterSnapshot,
  type InputFrame,
  type MatchSettings,
} from '@bash-fighter/sim';
import { PLACEHOLDER_CHARACTER, createMatchSim, resolveCharacterId, DEFAULT_CHARACTER_ID } from '@bash-fighter/content';
import type { CharacterData } from '@bash-fighter/sim';
import { InputManager, isTouchCapable } from '@bash-fighter/input';
import { buildClientProfile, buildSessionReportMessage, InputActivityTracker, InputUsageTracker, FrameTimeTracker, NetworkHitchTracker, SlowFrameTracker, SLOW_FRAME_THRESHOLD_MS } from './session-report.ts';
import { readBuildSha } from './ui/feedback-panel.ts';
import {
  Renderer,
  arenaDataToStageBounds,
  computeEdgeDangerFrac,
  type RenderFighterState,
  type RenderItemState,
  type RenderHazardState,
  type RenderFrame,
  type StageBounds,
} from '@bash-fighter/render';
import { currentArenaBounds, previewArenaBounds } from './arena-preview.ts';
import { resyncLocalTickAfterSnapshot } from './reconnect-resync.ts';

// See packages/app/src/match.ts for why these mirror the sim's private
// ItemState enum and the stylized hazard marker size instead of importing
// them from @bash-fighter/sim (not part of its public surface).
const NET_ITEM_STATE_HELD = 1;
const NET_ITEM_STATE_ARMED = 3;
const NET_HAZARD_MARKER_HALF_WIDTH = 11;
import {
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  encodeInput,
  SnapshotStreamDecoder,
  type ServerControlMessage,
} from '@bash-fighter/net';
import { FixedTimestepLoop } from './loop.ts';
import { hashStateBuffer } from '@bash-fighter/sim';
import { AudioManager } from '@bash-fighter/audio';
import { detectFighterEvents, detectItemEvents } from './effects-events.ts';
import { EffectsAudioBridge } from './effects-audio.ts';
import type { PendingHitEffect, PendingEliminationEffect } from '@bash-fighter/render';

// Placeholder used only until the real match arena is known (see
// startMatch, which calls renderer.setStageBounds(...) with the actual
// arena from createMatchSim as soon as the local prediction Sim exists).
export const STAGE_BOUNDS: StageBounds = arenaDataToStageBounds(DEFAULT_ARENA);

export type ConnectionState =
  | 'connecting'
  | 'waiting'
  | 'in-match'
  | 'spectating'
  | 'match-complete'
  | 'disconnected'
  | 'reconnecting'
  | 'error';

// Resume-token storage: sessionStorage, not localStorage, so a token never
// outlives the browser tab -- a stale token surviving into a brand new tab
// would be a seat nobody is coming back for. One slot is enough (a tab
// plays at most one match at a time).
const RESUME_TOKEN_KEY = 'bash-fighter:resumeToken';
function loadResumeToken(): string | null {
  try {
    return sessionStorage.getItem(RESUME_TOKEN_KEY);
  } catch {
    return null; // sessionStorage unavailable (privacy mode, SSR, etc.)
  }
}
/**
 *  Throw away any stored resume token.
 *
 *  Used by the shareable-lobby-link entry paths: a player who played a
 *  few minutes ago still holds a resume token, and the server honours a
 *  resume over anything else in the hello, so clicking a friend's
 *  ?join=CODE link silently dropped them back into their OWN old match
 *  instead of the friend's lobby (observed on production 2026-09-22,
 *  `resume_succeeded` where a `[codedLobby] joined` was expected).
 *  Following an invite link is an explicit request to go somewhere new,
 *  so the link wins over the old seat.
 */
export function clearStoredResumeToken(): void {
  saveResumeToken(null);
}

function saveResumeToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(RESUME_TOKEN_KEY, token);
    else sessionStorage.removeItem(RESUME_TOKEN_KEY);
  } catch {
    // best-effort only
  }
}

export interface NetMatchEvents {
  onStateChange?(state: ConnectionState, detail?: string): void;
  onLobby?(players: number, capacity: number, countdownTicks: number, modeName?: string): void;
  /** Fired once, the moment a 'welcome' arrives -- carries the coded
   *  lobby's actual join code (see WelcomeMessage.joinCode), or undefined
   *  for an ordinary uncoded public lobby. The host must display THIS
   *  value, not the code it asked for: a stale/expired code lands the
   *  joiner in a fresh coded lobby under the same code, so echoing back
   *  is the only truthful source for what a friend link should say. */
  onJoinCode?(joinCode: string | undefined): void;
  /** leaderboard is slots best-to-worst (server's authoritative
   * sim.getLeaderboard()) and settings is this match's resolved
   * MatchSettings -- both needed to tell a Timed Brawl finish from a
   * Battle Royale one and render the right end screen. */
  onMatchOver?(winnerIndex: number | null, resolved: boolean, leaderboard?: readonly number[], settings?: MatchSettings): void;
  /** Fired once, the moment the local player is eliminated online.
   * placement is 1-based finish position (e.g. 17 of 20). Lets the UI show
   * a specific "you placed Nth" + play-again offer instead of leaving the
   * player in an unexplained spectate view. */
  onEliminated?(placement: number, totalFighters: number): void;
  /** Fired once per match, the moment this client has a seat and a real sim
   *  to play. Exists because a player dropped into a filling lobby gets no
   *  countdown moment of their own, and our first real player reported
   *  taking "a minute to even find my dude". joinedLate is true when we
   *  never saw a lobby countdown, i.e. play began as far as we can tell
   *  without any run-up. */
  onMatchBegan?(slot: number, name: string, joinedLate: boolean): void;
  /** Fired once when the canvas's WebGL context is lost (see
   * packages/render/src/index.ts's Renderer.onContextLost). The match
   * keeps running server-side regardless -- this is presentation-only,
   * same contract as Match's identical event in match.ts. */
  onContextLost?(): void;
  /** Fired once if/when the browser restores the context. */
  onContextRestored?(): void;
  /** Fired once if, a few seconds after this match starts running, the
   * renderer has not genuinely presented a single frame -- same
   * contract as Match's identical event in match.ts. Never fires if
   * onContextLost already did for the same underlying failure. */
  onRenderStalled?(): void;
}

const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function snapshotToRenderFighter(s: FighterSnapshot): RenderFighterState {
  return {
    x: fx.toFloat(s.posX),
    y: fx.toFloat(s.posY),
    facing: s.facing,
    state: s.state,
    moveId: s.moveId,
    moveFrame: s.moveFrame,
    percent: s.percent,
    stocks: s.stocks,
    shieldHealth: s.shieldHealth,
    hitstun: s.hitstun,
    eliminated: s.eliminated,
    inRingDanger: s.inRingDanger,
  } as RenderFighterState;
}

/** Owns the WebSocket connection, the local-prediction sim, and rendering
 * for one online match. Mirrors Match (local-match.ts's local mode) in
 * shape so main.ts can switch between the two without them knowing about
 * each other. */
export class NetMatch {
  private snapshotDecoder = new SnapshotStreamDecoder();
  readonly renderer: Renderer;
  readonly input = new InputManager();
  private ws: WebSocket | null = null;
  private loop: FixedTimestepLoop | null = null;
  private name = '';
  // Set from every 'welcome' for a real seat (never for a pure spectator).
  // Persisted to sessionStorage (not localStorage) so it survives a page
  // reload within the same tab -- a refresh is treated the same as any
  // other drop, and the server still honours the token within
  // RECONNECT_GRACE_MS regardless of which socket presents it -- but never
  // outlives the tab, so a seat can't be reclaimed from a stale token left
  // lying around after the tab is closed.
  private resumeToken: string | null = loadResumeToken();
  // Set for exactly one tick: the moment a 'welcome' arrives with
  // resumed === true and resumeToken === null. That specific combination
  // is unique to the server's resume-into-ended path (server/src/index.ts,
  // handleResume: `match.phase === 'ended'` branch) -- a normal fresh join
  // sends resumed: false, and a real resumed-into-a-live-match welcome
  // always carries a real (non-null) token. The 'matchEnd' that follows
  // immediately after is the server informing us of an outcome for a seat
  // we are no longer meaningfully part of, not a real result to show.
  private resumedIntoEndedMatch = false;
  private setResumeToken(token: string | null): void {
    this.resumeToken = token;
    saveResumeToken(token);
  }
  // True once stop() is called deliberately (leaving the match / navigating
  // away): close/error handlers must not try to auto-reconnect after that.
  private readonly sessionDevicePixelRatio: number | undefined = (() => {
    const value = typeof window !== 'undefined' ? window.devicePixelRatio : undefined;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : undefined;
  })();
  // True when this match was entered by clicking "Play again" on the
  // elimination/match-end overlay or win screen, rather than the start
  // screen -- see main.ts's beginOnlineMatch(requeued) callers. Fixed at
  // construction, like sessionDevicePixelRatio above, since it describes
  // how THIS session began, not anything that can change mid-match.
  private readonly requeued: boolean;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private localSim: Sim | null = null;
  private renderSim: Sim | null = null; // scratch sim used only to decode remote snapshot buffers
  // This match's resolved MatchSettings, from matchStart.settings (see
  // startMatch). null until the match has actually started. Used to gate
  // every Timed-Brawl-only client affordance (HUD clock/score, end
  // screen) via isTimedBrawl() in timed-brawl.ts.
  private matchSettings: MatchSettings | null = null;
  private numFighters = 0;
  private characterId = DEFAULT_CHARACTER_ID;
  private characters: CharacterData[] = [];
  private mySlot = -1;
  // Per-slot display names as broadcast by the server (lobby + matchStart).
  // Presentation/networking metadata only -- never touches localSim/renderSim
  // or anything determinism-hashed. An empty string means that seat's
  // player never chose a name; nameFor() below is the single place that
  // turns that into the '#N' slot-label fallback every display uses.
  private names: string[] = [];
  private ringDamageAudioCooldownTicks = 0;
  private edgeDangerSounding = false;
  private spectating = false;
  private matchStarted = false;
  /** Whether this client actually watched a lobby countdown before play
   *  began. Presentation only: it decides whether the match-start intro
   *  says the fight is already going. */
  private sawCountdown = false;
  private over = false;

  private localTick = 0;
  private readonly inputHistory = new Map<number, InputFrame>();

  private prevSnapState: Int32Array | null = null;
  private currSnapState: Int32Array | null = null;
  private currSnapAt = 0;
  private currSnapTick = 0;
  // Hash of the last-applied authoritative snapshot, shown in the F3
  // debug overlay (formatDebugText) so a live cross-reference against the
  // server's own state is possible at a glance -- see "Client-Server
  // Match Divergence 2026-09-10" in the wiki for why this matters: the
  // client previously had no way to show it was still tracking the
  // server's authoritative state at all.
  private currSnapHash = '';
  // Wall-clock time of the last console.warn for a stalled snapshot
  // stream, so the warning repeats at most once every STALL_WARN_MS while
  // the condition persists instead of spamming every frame.
  private lastStallWarnAt = 0;
  // Measured wall-clock gap between the last two received snapshots, used
  // as the interpolation denominator instead of the fixed SNAPSHOT_HZ
  // constant. A spectator connection is throttled server-side to a lower
  // snapshot rate than a live player's (see server/src/index.ts), so a
  // client that always divided by the live-player interval would clamp
  // its interpolation alpha to 1 partway through each gap and sit frozen
  // for the remainder of it -- exactly the choppiness the brief warns
  // about. Measuring the real gap makes interpolation correct at whatever
  // rate this connection is actually being sent, live or spectating, with
  // no protocol change needed. Seeded to SNAPSHOT_INTERVAL_MS and clamped
  // (see handleBinary) so one dropped/delayed packet can't produce a wild
  // denominator.
  private snapIntervalMs = SNAPSHOT_INTERVAL_MS;

  readonly audio: AudioManager;
  private readonly effectsBridge: EffectsAudioBridge;
  // Set once per received snapshot (handleBinary), consumed once by the
  // next render() call. This is the ONLY source of hit/elimination
  // effects for online play -- deliberately driven off confirmed server
  // snapshots (20Hz), never off localSim's per-tick prediction/replay in
  // tick()/handleBinary's reconciliation loop, so a mispredicted hit that
  // gets rolled back on reconciliation never plays a phantom sound: it
  // was never observed here in the first place.
  private pendingHitEffects: PendingHitEffect[] = [];
  private pendingEliminationEffects: PendingEliminationEffect[] = [];

  private readonly url: string;
  private readonly events: NetMatchEvents;
  // Self-declared QA hint from `?qa=1` (see docs/MEASUREMENT.md), set once
  // per NetMatch instance and carried on every hello (including a
  // reconnect's fresh hello) via buildClientProfile. Never inferred --
  // only ever what the caller (main.ts, reading the URL) passed in.
  private readonly qaMode: boolean;
  // Dev-only stage pin from `?arena=<id>` (issue #19 -- see
  // HelloMessage.arena), same "caller reads the URL, NetMatch just
  // carries it" convention as qaMode. Sent on the hello only when
  // import.meta.env.DEV says this is a dev build, so a production build
  // never sends it regardless of the URL; the server independently
  // ignores it unless it opted in via MATCH_ARENA_OVERRIDE=1.
  private readonly arenaRequest?: string;

  // Shareable-lobby-link join code (see join-link.ts): either freshly
  // generated by "Play with a friend" (host) or read from a friend's
  // ?join=CODE link (joiner). Sent once on the initial hello only -- a
  // resume/reconnect reattaches to the existing seat by resume token, not
  // by join code, so it is never resent on a later openSocket() call.
  private readonly joinCodeRequest?: string;

  // Spectate-by-link (see [[Spectate by link]], ?watch=CODE, main.ts):
  // true means this hello asks the server to attach as a pure
  // spectator -- never addSeat/joinLobby -- watching the coded match
  // named by joinCodeRequest, or the current public match if that code
  // is unknown/ended or absent. Never combined with a resume.
  private readonly spectateRequest: boolean;

  // Engagement telemetry only (see docs/MEASUREMENT.md) -- presentation/
  // reporting, never read by tick()'s sim advance and never part of
  // localSim/renderSim state. Reset at the start of every match so a
  // resumed/second match starts a fresh reading rather than carrying over
  // the previous one.
  private inputActivity = new InputActivityTracker();
  // Observed input-device usage for this match, keyed by real source --
  // see InputUsageTracker and docs/MEASUREMENT.md "Capability vs usage".
  private inputUsage = new InputUsageTracker();
  private frameTimeTracker = new FrameTimeTracker();
  // See NetworkHitchTracker's doc comment (session-report.ts) -- counts
  // gaps between received server snapshots big enough to be a network
  // stall rather than render jitter, so sessionReport can tell the two
  // apart. Reset per-match alongside the other telemetry trackers.
  private networkHitchTracker = new NetworkHitchTracker();
  // See SlowFrameTracker's doc comment (session-report.ts) -- correlates
  // slow render frames with fighter/effects load and recent hitches/
  // transitions (2026-09-15, see docs/MEASUREMENT.md "Slow-frame
  // attribution").
  private slowFrameTracker = new SlowFrameTracker();
  // Wall-clock time an elimination/match-transition effect was last
  // queued, for SlowFrameTracker's transitionRecent check. null means
  // "none yet this match".
  private lastTransitionEffectAtMs: number | null = null;
  // Count of webglcontextlost events, sent in sessionReport (see
  // docs/MEASUREMENT.md and protocol.ts's SessionReportMessage.
  // contextLostCount). Reset per-match alongside the other telemetry
  // trackers below, same rationale: a reconnect/resume starts counting
  // fresh rather than carrying over a previous match's reading.
  private contextLostCount = 0;
  // True once the render watchdog has fired for this match (see
  // armRenderWatchdog) -- a boolean, not a count, since by definition it
  // can only legitimately happen once per match: either frames start
  // presenting (this stays false forever) or the match is unplayable and
  // the player is shown the reload overlay immediately.
  private renderStalled = false;
  private matchStartAtMs = 0;
  private lastRenderAtMs: number | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private readonly REPORT_INTERVAL_MS = 5000;
  // performance.now() of the most recent visibility change, or null if
  // the tab has never been hidden or shown since this match began. Used
  // to discard the snapshot gap that straddles a background period --
  // see the network-hitch guard in applySnapshot.
  private visibilityChangedAtMs: number | null = null;
  private readonly visibilityHandler = (): void => {
    this.visibilityChangedAtMs = performance.now();
    if (document.hidden) this.sendSessionReport();
  };

  // Not a TS parameter-property constructor: this class is imported
  // directly (not through vite) by a plain `node --test` regression test
  // (net-match-stale-socket.test.ts) for the stale-socket-message guard,
  // and Node's built-in type-stripping loader does not support parameter
  // properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) -- vite/tsc handle them
  // fine, but that test file needs to run outside that build pipeline.
  constructor(
    url: string,
    events: NetMatchEvents = {},
    audio: AudioManager = new AudioManager(),
    qaMode = false,
    arenaRequest?: string,
    requeued = false,
    joinCodeRequest?: string,
    spectateRequest = false,
  ) {
    this.url = url;
    this.events = events;
    this.renderer = new Renderer(STAGE_BOUNDS);
    this.audio = audio;
    this.effectsBridge = new EffectsAudioBridge(audio);
    this.qaMode = qaMode;
    this.arenaRequest = arenaRequest;
    this.requeued = requeued;
    this.joinCodeRequest = joinCodeRequest;
    this.spectateRequest = spectateRequest;
  }

  async init(parent: HTMLElement): Promise<void> {
    this.renderer.onContextLost = () => {
      this.contextLostCount += 1;
      this.events.onContextLost?.();
    };
    this.renderer.onContextRestored = () => this.events.onContextRestored?.();
    await this.renderer.init(parent);
    // QA/automation hook only, mirrors the existing window.__debug*
    // convention in packages/render -- lets a browser-automation pass
    // force/verify a real webglcontextlost/restored round trip via
    // Renderer.debugForceContextLoss/Restore. Inert for a real player:
    // nothing in this codebase reads this global on its own.
    if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__debugRenderer = this.renderer;
    this.input.attach(window);
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /** Sends the small, infrequent sessionReport (see docs/MEASUREMENT.md).
   *  Best-effort: a closed/absent socket is simply skipped, never queued
   *  or retried -- this is presentation/reporting only, so losing one is
   *  fine, and it must never affect the sim or reconnection. */
  private sendSessionReport(): void {
    if (!this.matchStarted || this.spectating || this.mySlot < 0) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const report = buildSessionReportMessage({
      firstInputMs: this.inputActivity.getFirstInputMs(),
      inputTicks: this.inputActivity.getInputTicks(),
      frameMedianMs: this.frameTimeTracker.getMedianMs(),
      frameP95Ms: this.frameTimeTracker.getP95Ms(),
      devicePixelRatio: this.sessionDevicePixelRatio,
      requeued: this.requeued,
      contextLostCount: this.contextLostCount,
      renderStalled: this.renderStalled,
      frameHistogram: this.frameTimeTracker.getHistogram(),
      hiddenFrames: this.frameTimeTracker.getHiddenFrames(),
      networkHitchCount: this.networkHitchTracker.getCount(),
      keyboardInputTicks: this.inputUsage.getKeyboardTicks(),
      touchInputTicks: this.inputUsage.getTouchTicks(),
      gamepadInputTicks: this.inputUsage.getGamepadTicks(),
      slowFrameCount: this.slowFrameTracker.getCount(),
      slowFrameFightersAliveBuckets: this.slowFrameTracker.getFightersAliveBuckets(),
      slowFrameFightersOnScreenBuckets: this.slowFrameTracker.getFightersOnScreenBuckets(),
      slowFrameEffectsLoadBuckets: this.slowFrameTracker.getEffectsLoadBuckets(),
      slowFrameHitchCoincidentCount: this.slowFrameTracker.getHitchCoincidentCount(),
      slowFrameTransitionCoincidentCount: this.slowFrameTracker.getTransitionCoincidentCount(),
      visibleMs: this.frameTimeTracker.getVisibleMs(),
      hiddenMs: this.frameTimeTracker.getHiddenMs(),
      renderResolution: this.renderer?.currentResolution,
      resolutionDowngrades: this.renderer?.adaptiveResolutionCounters.downgrades,
    });
    ws.send(JSON.stringify(report));
  }

  /** Sends the "Start now" request from the waiting screen's button: the
   *  server fills the rest of this lobby with bots and starts right away
   *  instead of waiting out the countdown/bot-fill grace period. Only
   *  meaningful while sitting in a lobby with an open socket; a no-op
   *  otherwise (server also validates seat + phase independently, so this
   *  is just avoiding sending into a dead or pre-hello socket). */
  requestStartNow(): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'startNow' }));
    }
  }

  connect(name: string, characterId: string = DEFAULT_CHARACTER_ID): void {
    this.name = name;
    this.characterId = characterId;
    this.stopped = false;
    this.reconnectAttempt = 0;
    // Offering a stored resumeToken here is deliberate and must stay: it is
    // what lets an accidental browser refresh mid-match drop the player
    // straight back into the live match they were winning, instead of a
    // fresh lobby. The problem was never the token itself -- it was a
    // *stale* token pointing at a match that had already ended by the time
    // it got offered (server logs that exact case as
    // `[matchEnd] {"path":"resume-into-ended"}`). That case is handled where
    // it actually surfaces, in handleControl's 'matchEnd' case below: it
    // clears the token and transparently opens a fresh connection instead
    // of showing a result screen for a match the player is not part of any
    // more. See handleControl for the detection (welcome.resumed === true
    // with welcome.resumeToken === null -- the one combination the server
    // only ever sends on the resume-into-ended path; server/src/index.ts).
    this.events.onStateChange?.('connecting');
    this.openSocket();
  }

  /** (Re)opens the websocket and sends either a fresh 'hello' or, if we
   * hold a resume token from a previous session, 'hello' with `resume`
   * set so the server reattaches us to our existing fighter slot instead
   * of putting us in a new lobby. Either way the client does NOT try to
   * keep playing from local state across the gap: startMatch() always
   * rebuilds localSim/renderSim from scratch and waits for the next
   * authoritative snapshot, so a resumed session is byte-for-byte
   * indistinguishable from a fresh join except which slot it lands in. */
  private openSocket(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    // Fresh connection (including a resumed reconnect) -- the server's own
    // per-connection encoder also resets on a new socket, so the very
    // first snapshot it sends will be a full keyframe. Resetting the
    // client decoder in lockstep just means it never tries to apply a
    // delta against a baseline from a dead connection.
    this.snapshotDecoder = new SnapshotStreamDecoder();
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      const hello: Record<string, unknown> = { t: 'hello', protocolVersion: PROTOCOL_VERSION, name: this.name };
      if (this.resumeToken) hello.resume = this.resumeToken;
      if (this.characterId) hello.characterId = this.characterId;
      // Stated at join as well as in the end report: an auto-requeued player
      // may never unload the page, so the report can be missing.
      if (this.requeued) hello.requeued = true;
      // Dev-only stage pin (issue #19 -- see HelloMessage.arena).
      // import.meta.env.DEV is statically false in a production vite
      // build, so a normal player's client never sends this however the
      // URL is mangled; `?.` keeps the plain node --test import of this
      // file (outside vite, no env object) from throwing.
      if (this.arenaRequest && import.meta.env?.DEV) hello.arena = this.arenaRequest;
      // Shareable-lobby-link join code -- only on the fresh hello, never
      // alongside a resume (see joinCodeRequest's doc comment above).
      if (this.joinCodeRequest && !this.resumeToken) hello.joinCode = this.joinCodeRequest;
      if (this.spectateRequest && !this.resumeToken) hello.spectate = true;
      // Engagement telemetry only (see docs/MEASUREMENT.md) -- small,
      // non-identifying environment snapshot, sent once per connection.
      hello.profile = buildClientProfile({
        touchActive: isTouchCapable(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        buildSha: readBuildSha() ?? null,
        qa: this.qaMode,
        // Coarse device-capability tags (see docs/MEASUREMENT.md,
        // 2026-09-14) -- already-public, non-identifying browser APIs,
        // bucketed by buildClientProfile before sending. `deviceMemory`
        // is missing on browsers without the Device Memory API (e.g.
        // Safari); reading it via an untyped cast keeps this file free
        // of a project-wide lib.dom.d.ts patch for one experimental
        // field.
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
        devicePixelRatio: window.devicePixelRatio,
        // Slow-frame attribution (2026-09-15, see docs/MEASUREMENT.md
        // "Slow-frame attribution"): canvas is already mounted by the
        // time hello is sent (init() runs before connect(), see
        // main.ts), so its real device-pixel backing-store size is
        // available here. `screen.width`/`.height` and `userAgent` are
        // reduced to coarse buckets/a family by buildClientProfile
        // before anything is sent -- see its doc comments.
        canvasWidthPx: this.renderer.getCanvasPixelSize().widthPx,
        canvasHeightPx: this.renderer.getCanvasPixelSize().heightPx,
        screenWidth: window.screen?.width,
        screenHeight: window.screen?.height,
        userAgent: navigator.userAgent,
      });
      ws.send(JSON.stringify(hello));
    });
    ws.addEventListener('message', (ev) => {
      // Guard against a message arriving on a socket we've already
      // superseded. openSocket() replaces this.ws with a new WebSocket on
      // every (re)connect attempt, but the *old* socket object's own
      // listeners stay registered until its close event actually fires --
      // browsers do not guarantee that happens before the new socket's
      // open/message events do, especially through a flaky or
      // rapid-reconnect-cycling connection (see wiki "Off-Box Load Test
      // Re-run 2026-09-09"). Without this check, a late reply meant for an
      // abandoned connection attempt -- e.g. a resume_after_match_ended
      // matchEnd for whichever match that stale attempt happened to
      // resolve to -- gets applied on top of a perfectly healthy newer
      // connection that is mid-match in a *different* match, which is
      // exactly what froze the client on a "Match complete" chip while the
      // server's own logs showed the real match still running (2026-09-09,
      // see wiki "End-of-Match Screen Missing Entirely" and its follow-up).
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') {
        this.handleControl(JSON.parse(ev.data) as ServerControlMessage);
      } else {
        this.handleBinary(new Uint8Array(ev.data as ArrayBuffer));
      }
    });
    ws.addEventListener('close', () => {
      // A socket this connection has already moved on from (e.g. matchEnd's
      // resume-into-ended handling below opens a brand-new one immediately,
      // while this one is still finishing its own close) must not report
      // state for a connection nobody cares about any more.
      if (ws !== this.ws) return;
      this.loop?.stop();
      if (this.stopped) return;
      // Mid-match drop with a resume token in hand: try to get back in
      // automatically instead of dumping the player to an error screen.
      // A drop before ever reaching an in-progress match (still in lobby,
      // or never got a token) has nothing useful to resume -- surface it
      // as a plain disconnect instead of retrying forever.
      if (this.resumeToken && this.matchStarted && !this.over) {
        this.scheduleReconnect();
      } else {
        this.events.onStateChange?.('disconnected');
      }
    });
    ws.addEventListener('error', () => {
      if (ws !== this.ws) return;
      if (!this.resumeToken || !this.matchStarted || this.over) {
        this.events.onStateChange?.('error', 'connection error');
      }
    });
  }

  /** Exponential backoff (1s, 2s, 4s, 8s, capped at 10s) up to the
   * server's RECONNECT_GRACE_MS window, so a brief wifi blip retries fast
   * while a longer outage doesn't hammer the server. Shows the
   * 'reconnecting' banner for the whole window; a successful 'welcome'
   * with resumed=true clears it (see handleControl). */
  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    this.events.onStateChange?.('reconnecting', `attempt ${this.reconnectAttempt}`);
    const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), 10_000);
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return;
      this.openSocket();
    }, delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    // Best-effort final sessionReport (see docs/MEASUREMENT.md) before the
    // socket closes -- a deliberate stop() (leaving the match) is exactly
    // the case a periodic-only report would most often miss.
    this.sendSessionReport();
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.loop?.stop();
    this.input.detach(window);
    this.ws?.close();
    if (this.renderWatchdogTimer !== null) {
      clearTimeout(this.renderWatchdogTimer);
      this.renderWatchdogTimer = null;
    }
  }

  toggleDebug(): void {
    this.renderer.setDebug(!this.renderer.isDebug());
  }

  private handleControl(msg: ServerControlMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.events.onJoinCode?.(msg.joinCode);
        this.mySlot = msg.slot;
        this.spectating = msg.slot < 0;
        this.resumedIntoEndedMatch = msg.resumed === true && (msg.resumeToken ?? null) === null;
        this.setResumeToken(msg.resumeToken ?? null);
        this.reconnectAttempt = 0;
        if (msg.resumed) {
          // Reattached to our old slot; matchStart follows immediately
          // (or, if the match already ended, matchEnd does) and rebuilds
          // sim state from scratch either way -- see startMatch/handleControl.
          this.events.onStateChange?.(this.spectating ? 'spectating' : 'in-match', 'reconnected');
        } else {
          this.events.onStateChange?.(this.spectating ? 'spectating' : 'waiting');
        }
        break;
      case 'lobby':
        this.names = msg.names ?? [];
        if (msg.countdownTicks > 0) this.sawCountdown = true;
        this.events.onLobby?.(msg.players, msg.capacity, msg.countdownTicks, msg.modeName);
        break;
      case 'matchStart':
        this.startMatch(msg.numFighters, msg.seed, msg.slot, msg.characterIds, msg.arenaId, msg.names, msg.settings);
        break;
      case 'eliminated':
        if (msg.slot === this.mySlot && !this.spectating) {
          this.spectating = true;
          // Once we're eliminated there is nothing left for *this* seat to
          // resume into -- the match plays on for everyone else, but our
          // token now only reclaims a spectator view of a match we're about
          // to leave. Clicking "Play again" from the elimination overlay
          // opens a brand new NetMatch; without clearing this here, its
          // initial `hello` replays the stale token, the server correctly
          // rejects it (the seat is gone), and the player lands on a
          // disconnected screen instead of a fresh lobby. Same fix as
          // matchEnd below, just triggered earlier.
          this.setResumeToken(null);
          this.events.onStateChange?.('spectating', `placement ${msg.placement}`);
          this.events.onEliminated?.(msg.placement, this.numFighters);
        }
        break;
      case 'matchEnd':
        // The match is finished -- there is nothing left to resume into, so
        // drop any saved token now rather than leaving it in sessionStorage
        // to be replayed by the *next* NetMatch's initial `hello`. Without
        // this, clicking "Play again"/"Rematch" right after a match ends
        // opened a fresh socket, sent the stale token, got a legitimate
        // resume_invalid back from the server, and dead-ended on the
        // disconnected screen instead of just starting the new match.
        this.setResumeToken(null);
        if (this.resumedIntoEndedMatch) {
          // We only got here because a stale token (a refresh, or an
          // automatic reconnect after a drop) pointed at a seat in a match
          // that had already ended by the time the server looked it up.
          // The player asked to play, not to be told the score of a match
          // they are no longer part of -- open a brand-new connection into
          // a live or forming lobby instead of surfacing this as a result.
          this.resumedIntoEndedMatch = false;
          this.ws?.close();
          this.connect(this.name, this.characterId);
          return;
        }
        this.over = true;
        this.events.onMatchOver?.(msg.winner, msg.resolved, msg.leaderboard, this.matchSettings ?? undefined);
        break;
      case 'error':
        if (msg.code === 'resume_invalid' || msg.code === 'resume_expired') {
          // Our token no longer gets us back in (grace period lapsed, or
          // someone/something else already reclaimed the seat) -- stop
          // retrying that seat and surface a plain disconnect rather than
          // looping on a token that will never work again.
          this.setResumeToken(null);
        }
        this.events.onStateChange?.('error', `${msg.code}: ${msg.message}`);
        this.ws?.close();
        break;
      default:
        break;
    }
  }

  private startMatch(
    numFighters: number,
    seed: number,
    slot: number,
    characterIds?: string[],
    arenaId?: string,
    names?: string[],
    settings?: unknown,
  ): void {
    this.numFighters = numFighters;
    if (names) this.names = names;
    this.mySlot = slot;
    this.spectating = slot < 0;
    this.matchStarted = true;
    // Per-seat characters as resolved server-side (characterIds is a
    // parallel array to slot index). Falls back to placeholder-for-all if
    // an older server ever omits the field, matching createMatchSim's own
    // default. Must match the server's construction exactly, or
    // prediction silently diverges from authority -- see createMatchSim.
    this.characters = (characterIds ?? []).map((id) => resolveCharacterId(id));
    if (this.characters.length !== numFighters) {
      this.characters = new Array(numFighters).fill(PLACEHOLDER_CHARACTER);
    }
    this.effectsBridge.setContext(this.characters, this.mySlot);
    // The server's matchStart.settings (2026-09-11, Timed Brawl) carries
    // the full resolved MatchSettings it built its own authoritative Sim
    // with (see server/src/match.ts's getClientSettings). Both of this
    // client's Sims (localSim for prediction, renderSim for decoding
    // remote snapshots) MUST be built with the exact same settings or
    // they silently diverge from authority the moment the mode isn't
    // plain battleRoyale -- e.g. a Timed Brawl fighter would never
    // respawn locally while the server keeps respawning it, permanently
    // desyncing prediction. Falls back to resolveMatchSettings({}) (=
    // battleRoyale) for any older server that still sends an empty
    // settings stub, which is what every client already assumed before
    // this field carried real data.
    this.matchSettings = resolveMatchSettings((settings as Partial<MatchSettings>) ?? {});
    this.localSim = createMatchSim(seed, numFighters, this.matchSettings, this.characters, arenaId);
    this.renderSim = createMatchSim(seed, numFighters, this.matchSettings, this.characters, arenaId);
    // The server always builds matches via createMatchSim too (see
    // server/src/*), so this.localSim.getArena() is the arena actually
    // being played on -- feed the renderer that, not a default guess.
    this.renderer.setStageBounds(arenaDataToStageBounds(this.localSim.getArena()));
    this.localTick = 0;
    this.inputHistory.clear();
    this.events.onStateChange?.(this.spectating ? 'spectating' : 'in-match');

    // Engagement telemetry only (see docs/MEASUREMENT.md) -- fresh
    // trackers per match so a reconnect/resume doesn't carry over a
    // previous match's readings, and a periodic report so the server
    // still learns something useful even if the tab is closed abruptly
    // and no final report gets out.
    this.inputActivity = new InputActivityTracker();
    this.inputUsage = new InputUsageTracker();
    this.frameTimeTracker = new FrameTimeTracker();
    this.networkHitchTracker = new NetworkHitchTracker();
    this.visibilityChangedAtMs = null;
    this.slowFrameTracker = new SlowFrameTracker();
    this.lastTransitionEffectAtMs = null;
    this.contextLostCount = 0;
    this.renderStalled = false;
    this.matchStartAtMs = performance.now();
    this.lastRenderAtMs = null;
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = setInterval(() => this.sendSessionReport(), this.REPORT_INTERVAL_MS);

    this.loop = new FixedTimestepLoop(
      () => this.tick(),
      () => this.render(),
    );
    this.loop.start();
    this.armRenderWatchdog();
    if (this.mySlot >= 0 && !this.spectating) {
      this.events.onMatchBegan?.(this.mySlot, this.nameFor(this.mySlot), !this.sawCountdown);
    }
    this.sawCountdown = false;
  }

  // See Match.start()'s identical watchdog in match.ts for the full
  // rationale: a renderer that never becomes able to draw at all (dead or
  // blocklisted GPU context, WebGL exhausted after a prior match's
  // context died -- observed live: black canvas, isContextLost() false,
  // canvas stuck at Pixi's 800x600 default) fires no webglcontextlost
  // event for onContextLost to catch. Zero frames genuinely presented a
  // few seconds after this match starts running is treated the same way.
  private static readonly RENDER_WATCHDOG_MS = 6000;
  private renderWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

  private armRenderWatchdog(): void {
    if (this.renderWatchdogTimer !== null) clearTimeout(this.renderWatchdogTimer);
    this.renderWatchdogTimer = setTimeout(() => {
      this.renderWatchdogTimer = null;
      if (this.stopped) return;
      if (this.renderer.isContextLost()) return;
      if (this.renderer.getFramesPresented() === 0) {
        this.renderStalled = true;
        this.events.onRenderStalled?.();
      }
    }, NetMatch.RENDER_WATCHDOG_MS);
  }

  private tick(): void {
    if (this.over || !this.localSim) return;
    this.localTick++;
    const inputs: InputFrame[] = new Array(this.numFighters).fill(null).map(() => makeInputFrame());
    if (!this.spectating && this.mySlot >= 0) {
      const local = this.input.poll()[0] ?? makeInputFrame();
      inputs[this.mySlot] = local;
      this.inputHistory.set(this.localTick, local);
      // Engagement telemetry only (see docs/MEASUREMENT.md) -- reads the
      // same local input frame already computed above for the sim, never
      // adds a poll or touches the sim's inputs array.
      const hadInput = local.buttons !== 0 || local.stickX !== 0 || local.stickY !== 0;
      this.inputActivity.recordTick(hadInput, performance.now() - this.matchStartAtMs);
      // Same tick's real source (see InputManager.lastSourceForSlot) --
      // observed usage, not capability. this.mySlot indexes the same
      // InputManager slot local was just polled from above.
      this.inputUsage.recordTick(hadInput, this.input.lastSourceForSlot(0));
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          encodeInput({
            tick: this.localTick,
            buttons: local.buttons,
            stickX: local.stickX,
            stickY: local.stickY,
          }),
        );
      }
    }
    // Only the local fighter is predicted; every other slot advances with
    // neutral input in this local sim. That is fine because remote
    // fighters are never rendered from this sim — see render().
    this.localSim.advance(inputs);
  }

  private handleBinary(bytes: Uint8Array): void {
    const snap = this.snapshotDecoder.decode(bytes);
    if (!snap || !this.localSim) return;

    const previousSnapState = this.currSnapState;
    const previousSnapAt = this.currSnapAt;
    this.prevSnapState = this.currSnapState;
    this.currSnapState = snap.state;
    this.currSnapAt = performance.now();
    this.currSnapTick = snap.tick;
    if (previousSnapState) {
      // Clamp to [0.5x, 4x] of the live-player interval: covers the 20Hz
      // live rate, the ~10Hz spectator rate (2x), and ordinary jitter,
      // while refusing to let a single stalled/coalesced message (a
      // background tab, a GC pause) blow the denominator out to seconds
      // and produce a visible snap on the next real snapshot.
      const measured = this.currSnapAt - previousSnapAt;
      this.snapIntervalMs = Math.min(Math.max(measured, SNAPSHOT_INTERVAL_MS * 0.5), SNAPSHOT_INTERVAL_MS * 4);
      // Network-hitch signal only when the tab was actually visible: a
      // backgrounded tab coalescing/delaying messages (see comment
      // above) is the same "tab was hidden" case FrameTimeTracker
      // already excludes, not a network problem -- counting it here
      // would misattribute a background pause as a network stall.
      // The first snapshot after the tab comes back to the foreground
      // measures a gap that spans the whole background period, and
      // document.hidden is already false by then, so the plain check
      // below used to count one phantom hitch per tab switch. A real
      // player's 2026-09-19 session reported eleven "network hitches"
      // across 34s of backgrounded time on an idle server -- all of them
      // this artefact. Discard any gap that a visibility change falls
      // inside.
      const straddledBackground =
        this.visibilityChangedAtMs !== null && this.visibilityChangedAtMs >= previousSnapAt;
      if (!document.hidden && !straddledBackground) {
        this.networkHitchTracker.record(measured, this.currSnapAt);
      }
    }

    // Confirmed-state-only event detection (see field comment above): both
    // sides of this diff come from decoded server snapshots via
    // renderSim, never from localSim's prediction.
    if (this.renderSim) {
      this.renderSim.loadState(snap.state);
      this.currSnapHash = hashStateBuffer(snap.state);
      const currF: FighterSnapshot[] = [];
      const currItems = [];
      for (let i = 0; i < this.numFighters; i++) currF.push(this.renderSim.getFighter(i));
      for (let i = 0; i < MAX_ITEMS; i++) currItems.push(this.renderSim.getItem(i));

      if (previousSnapState) {
        this.renderSim.loadState(previousSnapState);
        const prevF: FighterSnapshot[] = [];
        const prevItems = [];
        for (let i = 0; i < this.numFighters; i++) prevF.push(this.renderSim.getFighter(i));
        for (let i = 0; i < MAX_ITEMS; i++) prevItems.push(this.renderSim.getItem(i));

        const fighterEvents = detectFighterEvents(prevF, currF, this.numFighters);
        const itemEvents = detectItemEvents(prevItems, currItems, MAX_ITEMS);
        const { hitEffects, eliminationEffects } = this.effectsBridge.consume(
          [...fighterEvents, ...itemEvents],
          currF,
        );
        this.pendingHitEffects.push(...hitEffects);
        this.pendingEliminationEffects.push(...eliminationEffects);
        // Slow-frame attribution (2026-09-15, see docs/MEASUREMENT.md):
        // remember when a match-transition effect was last queued, so a
        // slow frame shortly after can be flagged as possibly caused by
        // an elimination/stage-transition burst rather than a steady
        // per-frame cost problem.
        if (eliminationEffects.length > 0) this.lastTransitionEffectAtMs = performance.now();
      }
      // Ring pressure (2026-09-10): alarm for the local player actually taking accumulating
      // out-of-bounds damage. Throttled the same way as the local-match adapter so it reads as
      // a damage pulse, not a drone.
      if (this.mySlot >= 0) {
        const mySnap = currF[this.mySlot];
        if (this.ringDamageAudioCooldownTicks > 0) this.ringDamageAudioCooldownTicks -= 1;
        if (mySnap && !mySnap.eliminated && mySnap.inRingDanger && this.ringDamageAudioCooldownTicks <= 0) {
          this.audio.playRingDamage(true);
          this.ringDamageAudioCooldownTicks = 18;
        }

        // Edge/boundary danger cue (mirrors the local-match adapter in
        // match.ts -- this was previously wired up there only, so every
        // online match, which is what production actually serves, never
        // played the "you're now near the closing boundary" chirp at all.
        // Debounced on the threshold crossing, not continuous.
        if (mySnap && !mySnap.eliminated) {
          const liveBounds = currentArenaBounds(this.renderSim.getCurrentBlastRect());
          const danger = computeEdgeDangerFrac(fx.toFloat(mySnap.posX), fx.toFloat(mySnap.posY), {
            platforms: [],
            blastMinX: liveBounds.minX,
            blastMaxX: liveBounds.maxX,
            blastMinY: liveBounds.minY,
            blastMaxY: liveBounds.maxY,
          });
          const inDanger = danger > 0.6;
          if (inDanger && !this.edgeDangerSounding) this.audio.playHazardWarning(true);
          this.edgeDangerSounding = inDanger;
        }
      }

      this.renderSim.loadState(snap.state); // leave renderSim pointed at latest, as callers below expect
    }

    // Reconciliation: adopt the authoritative state, then replay every
    // locally-buffered input newer than what the server has acked, so the
    // local fighter's predicted position stays correct instead of
    // snapping backwards every time a snapshot arrives.
    //
    // Resync guard (task #28231): startMatch() resets this.localTick to 0
    // unconditionally, including on a resumed reconnect -- but a resume's
    // first snapshot carries the real, large mid-match server tick. Without
    // this guard, this.localTick (small, counting ticks-since-resume) stays
    // permanently far behind snap.tick, so the loop below (`t <=
    // this.localTick`) never executes again for the rest of the match: the
    // local player's own prediction goes silently dead after any reconnect,
    // and gets worse with every subsequent one. Found via
    // scripts/reconnect-divergence-harness.mjs, which showed the replay
    // window drifting to -52, -123, -192 ticks over three reconnect cycles
    // with this guard absent, and pinned at 0 with it present. This does not
    // touch remote fighters or eliminations (those always come straight
    // from the authoritative snapshot via renderSim, never localSim), so it
    // is a prediction/responsiveness regression, not the survivor-list
    // divergence from the original report -- but it is real and it is a
    // genuine consequence of the reconnect path the prior pass didn't
    // exercise.
    this.localTick = resyncLocalTickAfterSnapshot(this.localTick, snap.tick);
    this.localSim.loadState(snap.state);
    for (const tick of Array.from(this.inputHistory.keys())) {
      if (tick <= snap.ackedInputTick) this.inputHistory.delete(tick);
    }
    const replayInputs: InputFrame[] = new Array(this.numFighters).fill(null).map(() => makeInputFrame());
    for (let t = snap.tick + 1; t <= this.localTick; t++) {
      const recorded = this.inputHistory.get(t);
      if (!this.spectating && this.mySlot >= 0 && recorded) replayInputs[this.mySlot] = recorded;
      else if (!this.spectating && this.mySlot >= 0) replayInputs[this.mySlot] = makeInputFrame();
      this.localSim.advance(replayInputs);
    }
  }

  /** FighterSnapshots for the HUD -- same shape as Match.currentSnapshots()
   * so main.ts can drive Hud.update() identically for local and online
   * matches. Mirrors render()'s fighter resolution: predicted local sim
   * for the local slot, decoded latest snapshot for everyone else, falling
   * back to localSim before any snapshot has arrived. eliminated/placement
   * come straight from the sim's own FighterSnapshot fields -- no separate
   * bookkeeping needed. */
  /** True once startMatch() has run and there is a real sim/arena to show a
   * HUD for -- guards main.ts from showing fighter cards during lobby wait. */
  /** Index of this client's own fighter, or -1 while unassigned/spectating.
   * Used by the HUD to mark the local player's card distinctly. */
  localSlot(): number {
    return !this.spectating && this.mySlot >= 0 ? this.mySlot : -1;
  }

  /** Per-slot display names as last broadcast by the server (lobby, then
   *  matchStart). Presentation-only, never simulation state -- see the
   *  field comment. Callers should use nameFor() rather than indexing this
   *  directly so the '#N' slot-label fallback for an unnamed seat is
   *  applied consistently everywhere. */
  displayNames(): readonly string[] {
    return this.names;
  }

  /** A slot's display name, or its slot label ('#N', 1-based) if that
   *  seat's player never chose a name. The one place every display of a
   *  fighter's identity (HUD, in-world badge, win screen, placement
   *  overlay) should go through, so the fallback rule lives in exactly
   *  one place. */
  nameFor(slot: number): string {
    const n = this.names[slot];
    return n && n.length > 0 ? n : `#${slot + 1}`;
  }

  hasStarted(): boolean {
    return this.localSim !== null;
  }

  /** True once the server's matchEnd control message has been processed
   * (see handleControl's 'matchEnd' case). The HUD tick loop in main.ts
   * must stop re-showing the HUD once this flips -- see the "stale
   * survivor counter at match end" fix: onMatchOver's hud.hide() was
   * being undone on the very next animation frame because the tick loop
   * only ever checked hasStarted(), which never goes back to false. */
  isOver(): boolean {
    return this.over;
  }

  /** This match's resolved settings once matchStart has arrived, or null
   * before that / for the pre-match lobby screens. */
  getMatchSettings(): MatchSettings | null {
    return this.matchSettings;
  }

  /** Sim ticks elapsed in this match, for a live countdown clock (see
   * timed-brawl.ts's ticksRemaining/formatClock). Mirrors localTick, which
   * this class already advances once per confirmed local tick. */
  get currentTick(): number {
    return this.localTick;
  }

  currentSnapshots(): readonly FighterSnapshot[] {
    if (!this.localSim) return [];
    const out: FighterSnapshot[] = new Array(this.numFighters);
    const source = this.currSnapState && this.renderSim ? this.renderSim : this.localSim;
    if (this.currSnapState && this.renderSim) this.renderSim.loadState(this.currSnapState);
    for (let i = 0; i < this.numFighters; i++) out[i] = source.getFighter(i);
    if (!this.spectating && this.mySlot >= 0) out[this.mySlot] = this.localSim.getFighter(this.mySlot);
    return out;
  }

  private static readonly STALL_THRESHOLD_MS = SNAPSHOT_INTERVAL_MS * 8;

  private checkSnapshotStall(): void {
    if (this.over || !this.currSnapState) return;
    const staleMs = performance.now() - this.currSnapAt;
    if (staleMs < NetMatch.STALL_THRESHOLD_MS) return;
    const now = performance.now();
    if (now - this.lastStallWarnAt < NetMatch.STALL_THRESHOLD_MS) return;
    this.lastStallWarnAt = now;
    console.warn(
      '[net-match] snapshot stream stalled: ' + Math.round(staleMs) + 'ms since last authoritative snapshot ' +
        '(last tick ' + this.currSnapTick + ', hash ' + (this.currSnapHash || '(none)') + '). ' +
        'See wiki: Client-Server Match Divergence 2026-09-10.',
    );
  }

  private render(): void {
    if (!this.localSim || !this.renderSim) return;
    // Engagement telemetry only (see docs/MEASUREMENT.md) -- client frame
    // time between rAF-driven render() calls. Presentation/reporting
    // only; never read by tick()'s sim advance.
    const nowMs = performance.now();
    const frameDeltaMs = this.lastRenderAtMs !== null ? nowMs - this.lastRenderAtMs : null;
    if (frameDeltaMs !== null) this.frameTimeTracker.record(frameDeltaMs, document.hidden);
    this.lastRenderAtMs = nowMs;
    this.checkSnapshotStall();
    const fighters: RenderFighterState[] = new Array(this.numFighters);

    // Remote fighters: interpolate between the last two received snapshots.
    if (this.currSnapState) {
      const alpha = Math.min(1, Math.max(0, (performance.now() - this.currSnapAt) / this.snapIntervalMs));
      this.renderSim.loadState(this.currSnapState);
      const currF: FighterSnapshot[] = [];
      for (let i = 0; i < this.numFighters; i++) currF.push(this.renderSim.getFighter(i));

      let prevF: FighterSnapshot[] = currF;
      if (this.prevSnapState) {
        this.renderSim.loadState(this.prevSnapState);
        prevF = [];
        for (let i = 0; i < this.numFighters; i++) prevF.push(this.renderSim.getFighter(i));
        this.renderSim.loadState(this.currSnapState); // leave renderSim pointed at latest
      }

      for (let i = 0; i < this.numFighters; i++) {
        const c = currF[i] as FighterSnapshot;
        const p = prevF[i] as FighterSnapshot;
        fighters[i] = {
          ...snapshotToRenderFighter(c),
          x: lerp(fx.toFloat(p.posX), fx.toFloat(c.posX), alpha),
          y: lerp(fx.toFloat(p.posY), fx.toFloat(c.posY), alpha),
        };
      }
    } else {
      for (let i = 0; i < this.numFighters; i++) fighters[i] = snapshotToRenderFighter(this.localSim.getFighter(i));
    }

    // Local fighter: predicted position from localSim overrides the
    // interpolated/authoritative one above.
    if (!this.spectating && this.mySlot >= 0) {
      fighters[this.mySlot] = snapshotToRenderFighter(this.localSim.getFighter(this.mySlot));
    }

    // Items/hazards: read straight from renderSim's decoded snapshot, no
    // separate prev/curr interpolation like fighters get -- renderSim is
    // left pointed at the latest snapshot above. This is a simplification
    // versus the local-match path (see match.ts): between snapshots these
    // will hold their last-known position rather than smoothly
    // interpolating, same coarseness the un-interpolated fallback fighter
    // path already has when no snapshot has arrived yet.
    const items: RenderItemState[] = [];
    const hazards: RenderHazardState[] = [];
    if (this.currSnapState) {
      for (let i = 0; i < MAX_ITEMS; i++) {
        const it = this.renderSim.getItem(i);
        if (!it.active) {
          items.push({ active: false, typeId: 0, x: 0, y: 0, held: false, holderFacing: 1, armed: false, fuseTicks: 0 });
          continue;
        }
        const held = it.state === NET_ITEM_STATE_HELD;
        let x = fx.toFloat(it.posX);
        let y = fx.toFloat(it.posY);
        let holderFacing: 1 | -1 = 1;
        if (held && it.holder >= 0 && it.holder < this.numFighters) {
          const hf = fighters[it.holder] as RenderFighterState;
          x = hf.x;
          y = hf.y;
          holderFacing = hf.facing;
        }
        items.push({
          active: true,
          typeId: it.typeId,
          x,
          y,
          held,
          holderFacing,
          armed: it.state === NET_ITEM_STATE_ARMED,
          fuseTicks: it.fuse,
        });
      }
      for (let i = 0; i < MAX_HAZARDS; i++) {
        const hz = this.renderSim.getHazard(i);
        hazards.push({
          active: hz.active,
          x: fx.toFloat(hz.posX),
          y: fx.toFloat(hz.posY),
          halfWidth: NET_HAZARD_MARKER_HALF_WIDTH,
        });
      }
    }

    const frame: RenderFrame = {
      fighters,
      characters:
        this.characters.length === this.numFighters
          ? this.characters
          : new Array(this.numFighters).fill(PLACEHOLDER_CHARACTER),
      items,
      hazards,
      tick: this.currSnapTick,
      hash: this.currSnapHash,
      hitEffects: this.pendingHitEffects,
      eliminationEffects: this.pendingEliminationEffects,
      localPlayerIndex: !this.spectating && this.mySlot >= 0 ? this.mySlot : undefined,
      names: this.names,
      liveArenaBounds: currentArenaBounds(this.renderSim.getCurrentBlastRect()),
      previewArenaBounds: previewArenaBounds(
        this.renderSim.getArena(),
        this.currSnapTick,
        fighters.filter((f) => !f.eliminated).length,
        this.numFighters,
        this.renderSim.getMatchSettings(),
      ),
    };
    this.pendingHitEffects = [];
    this.pendingEliminationEffects = [];
    this.renderer.render(frame);
    // Slow-frame attribution (2026-09-15, see docs/MEASUREMENT.md
    // "Slow-frame attribution"): a single comparison on the hot path --
    // the more expensive counter reads below only ever run on frames
    // that are already slow, never on the 60fps common case.
    if (frameDeltaMs !== null && frameDeltaMs >= SLOW_FRAME_THRESHOLD_MS && !document.hidden) {
      const { alive, onScreen } = this.renderer.getLastFrameFighterCounts();
      const effectsLoad = this.renderer.getLiveEffectsLoad();
      const hitchAtMs = this.networkHitchTracker.getLastHitchAtMs();
      const hitchRecent = hitchAtMs !== null && nowMs - hitchAtMs < 1000;
      const transitionRecent = this.lastTransitionEffectAtMs !== null && nowMs - this.lastTransitionEffectAtMs < 1000;
      this.slowFrameTracker.record(frameDeltaMs, {
        fightersAlive: alive,
        fightersOnScreen: onScreen,
        effectsLoad,
        hitchRecent,
        transitionRecent,
      });
    }
  }
}
