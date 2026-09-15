import './style.css';
import { Match, STAGE_BOUNDS } from './match.ts';
import { StartScreen } from './ui/start-screen.ts';
import { ReplayScreen } from './ui/replay-screen.ts';
import { WinScreen } from './ui/win-screen.ts';
import { TimedBrawlEndScreen } from './ui/timed-brawl-end-screen.ts';
import { isTimedBrawl, formatClock, ticksRemaining } from './timed-brawl.ts';
import { type MatchSettings } from '@bash-fighter/sim';
import { Hud } from './ui/hud.ts';
import { SpectatorBanner } from './ui/spectator-banner.ts';
import { SimMatchAdapter } from './spectator/sim-adapter.ts';
import { SpectatorController } from './spectator/controller.ts';
import { NetMatch, type ConnectionState } from './net-match.ts';
import { SpectateChip } from './ui/spectate-chip.ts';
import { MatchIntro } from './ui/match-intro.ts';
import { MatchOverlay, SPECTATE_OFFER, type MatchOverlayContent } from './ui/match-overlay.ts';
import { ControlsHint } from './ui/controls-hint.ts';
import { MoveReferencePanel } from './ui/move-reference-panel.ts';
import { SettingsPanel } from './ui/settings-panel.ts';
import { FeedbackPanel } from './ui/feedback-panel.ts';
import { TouchControls } from './ui/touch-controls.ts';
import { WaitingScreen } from './ui/waiting-screen.ts';
import { AttractMode } from './attract-mode.ts';
import {
  isTouchCapable,
  loadPersistedBindings,
  savePersistedBindings,
  DEFAULT_P1_BINDING,
  DEFAULT_P2_BINDING,
  shouldIgnoreKeydown,
} from '@bash-fighter/input';
import { PLACEHOLDER_CHARACTER, resolveCharacterId, ALL_CHARACTERS, isKnownArenaId } from '@bash-fighter/content';
import { setReducedMotion, PALETTE, type ArenaBounds } from '@bash-fighter/render';
import { AudioManager } from '@bash-fighter/audio';

// This local build has no networking, so "the local player" is just
// whichever slot we choose to watch from. Slot 0 (P1) is the one that,
// when eliminated, triggers the spectator experience — the mechanism is
// the same one a real client will use once matches have real players.
const LOCAL_SLOT = 0;

const STATIC_ARENA: ArenaBounds = {
  minX: STAGE_BOUNDS.blastMinX,
  maxX: STAGE_BOUNDS.blastMaxX,
  minY: STAGE_BOUNDS.blastMinY,
  maxY: STAGE_BOUNDS.blastMaxY,
};

const appRoot = document.getElementById('app') as HTMLDivElement;

const canvasRoot = document.createElement('div');
canvasRoot.id = 'canvas-root';
appRoot.appendChild(canvasRoot);

// Keyboard-only shortcuts (F3/TAB/O) are meaningless on touch devices, and
// this hint's bottom-right position collides with the touch attack/special
// button cluster (also bottom-right) on phones. Skip it on touch devices.
if (!isTouchCapable()) {
  const debugHint = document.createElement('div');
  debugHint.className = 'debug-hint';
  debugHint.textContent = 'F3 debug · TAB cycle survivors · O overview';
  appRoot.appendChild(debugHint);
}

let match: Match | null = null;
let adapter: SimMatchAdapter | null = null;
let spectator: SpectatorController | null = null;
let matchGeneration = 0;
let lastFrameTimeMs: number | null = null;
// Tracks which mode the most recently finished match was so the shared
// win screen's "Rematch" button starts another match of the *same* kind
// instead of always dropping back into the local two-player harness --
// see the comment on winScreen below for the bug this fixes.
let lastMatchWasOnline = false;

// One AudioManager for the whole app -- both local Match and NetMatch
// play through it, so the mute control and voice cap are global rather
// than per-match. Initialized lazily on the first user gesture anywhere
// on the page (autoplay policy); safe to call init multiple times.
const audio = new AudioManager();
window.addEventListener(
  'pointerdown',
  () => {
    audio.initOnGesture();
    audio.startAmbient();
  },
  { once: true },
);

// Every fixed top-right overlay control (sound, and later the in-match
// Controls/Moves buttons) lives in this one flex row instead of each
// picking its own hardcoded `right` offset -- hardcoded offsets are what
// let the Moves button and this mute button land exactly on top of each
// other before. The row lays its children out left-to-right and wraps
// if it ever runs out of width, so nothing can collide at any viewport
// size.
const topRightControls = document.createElement('div');
topRightControls.id = 'top-right-controls';
appRoot.appendChild(topRightControls);

const muteButton = document.createElement('button');
muteButton.id = 'mute-btn';
muteButton.className = 'mute-btn';
function refreshMuteLabel(): void {
  muteButton.textContent = audio.isMuted ? 'Sound off' : 'Sound on';
  muteButton.dataset.muted = String(audio.isMuted);
}
refreshMuteLabel();
muteButton.addEventListener('click', () => {
  audio.initOnGesture();
  audio.toggleMuted();
  refreshMuteLabel();
});
topRightControls.appendChild(muteButton);

const hud = new Hud(appRoot);
const spectatorBanner = new SpectatorBanner(appRoot);
const matchOverlay = new MatchOverlay(appRoot);

// WebGL context loss (2026-09-14): a lost context is a normal browser
// event (GPU switch, phone backgrounding the tab, driver reset, a
// second live context competing for GPU memory), not a crash -- but
// left unhandled it used to turn the whole canvas into a permanently
// black rectangle with no explanation and no way out. Shared between
// the online (NetMatch) and local (Match) wiring below: both fire the
// exact same onContextLost/onContextRestored events for the exact same
// reason. Reload is the honest primary action -- see
// Renderer.onContextRestored's doc comment for what recovery is and
// is not attempted automatically.
function showContextLostOverlay(): void {
  matchOverlay.show({
    // Deliberately no eyebrow label. An uppercase micro-caps line above a heading is
    // exactly the generic-template look this project's design language
    // rules out, and this is the first and only caller that would use one.
    // The heading carries the message on its own.
    title: 'The game stopped drawing',
    message:
      "Your browser dropped this tab's graphics, usually because memory ran " +
      'short or the device switched graphics chips. Reload to carry on.',
    tone: 'danger',
    actions: [{ label: 'Reload', onClick: () => location.reload() }],
  });
}

// True only while the context-lost overlay (not some other overlay --
// elimination, disconnect, etc.) is the thing on screen, so restoration
// never blindly hides a message it didn't put up itself.
let contextLostOverlayShowing = false;

function onRendererContextLost(): void {
  contextLostOverlayShowing = true;
  showContextLostOverlay();
}

function onRendererContextRestored(): void {
  if (contextLostOverlayShowing) {
    matchOverlay.hide();
    contextLostOverlayShowing = false;
  }
}

// Covers the other half of the same symptom (2026-09-14, see wiki): a
// renderer that never becomes able to draw at all -- no webglcontextlost
// event ever fires for onContextLost to catch, because from the
// renderer's own point of view nothing is wrong. There is no restore
// counterpart to this one: a renderer that has not drawn a single frame
// in several seconds is not "lost", it never worked, so Reload is the
// only honest action either way. Guarded against ever stacking a second
// overlay on top of an already-shown context-lost one for the same
// underlying failure.
function onRendererRenderStalled(): void {
  if (contextLostOverlayShowing) return;
  contextLostOverlayShowing = true;
  showContextLostOverlay();
}

/** How long a renderer gets to become able to draw before we stop waiting.
 * Observed on production: `app.init()` can simply never settle when the
 * browser has no context left to give, so neither a rejection nor the
 * frames-presented watchdog (which is only armed once a match starts) ever
 * fires, and the player sits in front of a permanently black page. Eight
 * seconds is far longer than a cold init on a slow phone. */
const RENDERER_INIT_TIMEOUT_MS = 8000;

async function initWithTimeout(init: Promise<void>, where: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`renderer init did not settle within ${RENDERER_INIT_TIMEOUT_MS}ms`)),
      RENDERER_INIT_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([init, timeout]);
    return true;
  } catch (error) {
    onRendererInitFailed(where, error);
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// A renderer that never gets off the ground at all: `Renderer.init()`
// rejects, usually because the browser refused or immediately lost the
// WebGL context. Before this, the rejection propagated out of the match
// start and the player was left looking at an empty #canvas-root -- a
// black screen with no canvas in it, no event to catch and nothing said.
// Observed on production 2026-09-14. Same overlay, same honest Reload.
function onRendererInitFailed(where: string, error: unknown): void {
  console.error(`renderer init failed (${where})`, error);
  if (contextLostOverlayShowing) return;
  contextLostOverlayShowing = true;
  showContextLostOverlay();
}
const spectateChip = new SpectateChip(appRoot, () => void beginOnlineMatch());
const matchIntro = new MatchIntro(appRoot);
/** The 20-slot FFA palette entry for a seat, as a CSS colour -- the same
 *  colour the renderer fills that fighter with, so the intro's swatch and
 *  the fighter on screen are recognisably the same thing. */
function localPlayerColour(slot: number): string {
  const colours = PALETTE.playerColors;
  const c = colours[((slot % colours.length) + colours.length) % colours.length] ?? 0xe8b23c;
  return `#${c.toString(16).padStart(6, '0')}`;
}
const controlsHint = new ControlsHint(appRoot);

const touchControls = new TouchControls(appRoot);
const touchCapable = isTouchCapable();

// Test-only hook: lets an automated harness (dispatching real PointerEvents
// at the touch controls) read the live sim state to assert the fighter
// actually moved/acted, rather than merely that a handler fired. Only
// wired up when the touch-capability override is in effect (see
// packages/input/src/touch.ts), so it never exists for real users.
if (new URLSearchParams(window.location.search).get('bashTest') === '1') {
  (window as unknown as { __bashTestMatch?: () => Match | null }).__bashTestMatch = () => match;
  (window as unknown as { __bashTestTouch?: () => TouchControls }).__bashTestTouch = () => touchControls;
}

// Test-only hook: exposes the AudioManager so an automated audit can
// assert on the Web Audio graph (context state, active voice count,
// mute/volume) without a human ever listening -- see
// packages/audio/src/index.ts for what's exposed. Same bashTest=1 gate
// as the touch hook above.
if (new URLSearchParams(window.location.search).get('bashTest') === '1') {
  (window as unknown as { __bashTestAudio?: () => AudioManager }).__bashTestAudio = () => audio;
}

const startScreen = new StartScreen(
  appRoot,
  () => {
    void beginMatch();
  },
  () => {
    startScreen.hide();
    startScreenActive = false;
    attractMode.stop();
    replayScreen.show();
  },
);

const replayScreen = new ReplayScreen(appRoot, () => {
  startScreen.show();
  startScreenActive = true;
  refreshAttractMode();
});

// Online mode is additive: a second button on the same start screen, and a
// small always-visible status line so connection state is never a silent
// blank screen. Local-match mode above is untouched and remains the
// offline/dev test harness.
const netStatus = document.createElement('div');
netStatus.id = 'net-status';
netStatus.className = 'hidden';
appRoot.appendChild(netStatus);

// Mode line (2026-09-11, Timed Brawl mode rotation): shown alongside the
// waiting-lobby status so a player knows which mode they are about to
// play before it matters -- see server/src/mode-rotation.ts's
// modeDisplayName, whose plain-language text (never the internal
// 'timedKO'/'battleRoyale' identifier) is broadcast in LobbyMessage.modeName
// and rendered here verbatim.
const netModeLine = document.createElement('div');
netModeLine.id = 'net-mode-line';
netModeLine.className = 'hidden';
appRoot.appendChild(netModeLine);

const waitingScreen = new WaitingScreen(appRoot, touchCapable, () => netMatch?.requestStartNow());

function setNetStatus(state: ConnectionState, detail?: string): void {
  netStatus.classList.remove('hidden');
  const label: Record<ConnectionState, string> = {
    connecting: 'Connecting…',
    waiting: 'Waiting for players…',
    'in-match': 'In match',
    spectating: 'Spectating',
    'match-complete': 'Match complete',
    disconnected: 'Disconnected',
    reconnecting: 'Reconnecting…',
    error: 'Connection error',
  };
  netStatus.textContent = detail ? `${label[state]} — ${detail}` : label[state];
  netStatus.dataset.state = state;
}

const onlineButton = document.createElement('button');
onlineButton.className = 'btn btn-primary';
onlineButton.id = 'online-btn';
onlineButton.textContent = 'Play online';
// Mounted in the start screen's primary-action slot: online play is the
// game, and local two-player is the side door. It used to be appended to
// the end of the screen, below the local key bindings and off the bottom
// of most viewports.
(startScreen.root.querySelector('#primary-actions') ?? startScreen.root).appendChild(onlineButton);

// Move reference (repo issue #5): reachable from the start screen at any
// time, and from inside a match (bound below) without ending it.
const movesPanel = new MoveReferencePanel(appRoot);

// Account-free player feedback (2026-09-13, owner directive -- see
// feedback-panel.ts and wiki "Bash Entertainment Overview"). One shared
// panel instance; every entry point below just calls .show() with
// whatever context it has. touchCapable is read once at load (same as
// TouchControls itself), which is what lets a `?forceTouch=1` test see
// the touch-ergonomics question.
const feedbackPanel = new FeedbackPanel(appRoot, () => touchCapable);

const feedbackButton = document.createElement('button');
feedbackButton.className = 'btn btn-plain';
feedbackButton.id = 'feedback-btn';
feedbackButton.textContent = 'Feedback';
feedbackButton.addEventListener('click', () => feedbackPanel.show());
(startScreen.root.querySelector('#primary-actions') ?? startScreen.root).appendChild(feedbackButton);

// In-match entry point lives in the same wrap-safe row as the mute and
// (once shown) Controls/Moves buttons -- see the comment on
// topRightControls above about why this row exists at all, and
// feedback-panel.test.ts for the measured non-overlap proof at 1280x720
// and 390px.
const inMatchFeedbackButton = document.createElement('button');
inMatchFeedbackButton.id = 'in-match-feedback-btn';
inMatchFeedbackButton.className = 'in-match-moves-btn feedback-link-btn hidden';
inMatchFeedbackButton.textContent = 'Feedback';
inMatchFeedbackButton.addEventListener('click', () => feedbackPanel.show());
topRightControls.appendChild(inMatchFeedbackButton);

// Key-remapping settings (repo issue #9). Bindings live here at module
// scope -- one source of truth applied to whichever InputManager(s) are
// currently live (local Match, online NetMatch, or both if a player
// somehow has one of each queued up) -- rather than each match owning
// its own copy that would silently diverge from what the panel shows.
const persisted = loadPersistedBindings();
const currentBindings = {
  p1: persisted ? persisted.p1 : DEFAULT_P1_BINDING,
  p2: persisted ? persisted.p2 : DEFAULT_P2_BINDING,
};

// Reduced motion (accessibility, repo issue-shaped gap): persisted
// explicitly so a choice survives reload, but defaults to the OS-level
// `prefers-reduced-motion` media query the first time a player visits
// with nothing saved yet -- someone who has already told their system
// they get motion sickness from UI animation shouldn't have to also
// find and flip an in-game toggle before their first match.
const REDUCED_MOTION_KEY = 'bash-fighter-reduced-motion';
function loadReducedMotionPref(): boolean {
  const stored = localStorage.getItem(REDUCED_MOTION_KEY);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
let reducedMotionPref = loadReducedMotionPref();
setReducedMotion(reducedMotionPref);

const settingsPanel = new SettingsPanel(
  appRoot,
  { ...currentBindings, reducedMotion: reducedMotionPref, volume: audio.volumeLevel },
  {
    onBindingChange: (slot, binding) => {
      if (slot === 0) currentBindings.p1 = binding;
      else currentBindings.p2 = binding;
      savePersistedBindings(currentBindings.p1, currentBindings.p2);
      // Apply immediately to whichever match is currently in progress, so
      // a rebind takes effect without needing to restart the match.
      match?.input.setBinding(slot, binding);
      netMatch?.input.setBinding(slot, binding);
      startScreen.updateBindings(currentBindings.p1, currentBindings.p2);
    },
    onReducedMotionChange: (reduced) => {
      reducedMotionPref = reduced;
      localStorage.setItem(REDUCED_MOTION_KEY, String(reduced));
      setReducedMotion(reduced);
      // Attract mode reads reducedMotionPref only when it (re)spawns a
      // match, not every frame -- force a respawn now so flipping this
      // setting while the start screen's demo is already running takes
      // effect immediately instead of on the next match resolution.
      attractMode.stop();
      refreshAttractMode();
    },
    // Volume slider (repo issue #14): a separate, independently persisted
    // control from mute/unmute -- setting it to 0 sounds identical to
    // muting but doesn't touch the `muted` flag or its own button label.
    onVolumeChange: (volume) => {
      audio.setVolume(volume);
    },
  },
);
startScreen.updateBindings(currentBindings.p1, currentBindings.p2);

// Attract mode: a silent, self-running bot match in its own framed
// window on the start screen, directly below the pitch line (see
// #attract-frame in start-screen.ts/style.css and attract-mode.ts). It
// is not a background layer under the hero text, so nothing else on
// the page needs special contrast handling for it.
const attractRoot = startScreen.root.querySelector('#attract-root') as HTMLDivElement;
const attractMode = new AttractMode(attractRoot, () => reducedMotionPref);
let startScreenActive = true;

function refreshAttractMode(): void {
  const shouldRun = startScreenActive && !document.hidden && !AttractMode.isNarrowViewport();
  if (shouldRun) void attractMode.start();
  else attractMode.stop();
}

document.addEventListener('visibilitychange', refreshAttractMode);
window.addEventListener('resize', refreshAttractMode);
// Fires once at boot too, since startScreenActive starts true and the
// start screen is the first thing shown.
refreshAttractMode();

const settingsButton = document.createElement('button');
settingsButton.className = 'btn btn-plain';
settingsButton.id = 'settings-btn';
settingsButton.textContent = 'Controls';
settingsButton.addEventListener('click', () => settingsPanel.show());
(startScreen.root.querySelector('#primary-actions') ?? startScreen.root).appendChild(settingsButton);

const inMatchSettingsButton = document.createElement('button');
inMatchSettingsButton.id = 'in-match-settings-btn';
inMatchSettingsButton.className = 'in-match-moves-btn hidden';
inMatchSettingsButton.textContent = 'Controls (C)';
inMatchSettingsButton.addEventListener('click', () => settingsPanel.show());
topRightControls.appendChild(inMatchSettingsButton);

/** True when a keystroke belongs to whatever the player is typing into, so
 * no global shortcut may act on it.
 *
 * From real player feedback, 2026-09-14: "Writing on the feedback form
 * still toggles the (C)ontrol window". Typing "camera" into the feedback
 * box opened the Controls panel on the c, and an m opened the move
 * reference -- while the player was in the middle of telling us what was
 * wrong with the game. The fighter's own inputs already knew to stand
 * aside for text entry (`shouldIgnoreKeydown`); these window-level
 * shortcuts did not. */
function isTypingKeystroke(e: KeyboardEvent): boolean {
  return shouldIgnoreKeydown(e.target, e.code);
}
window.addEventListener('keydown', (e) => {
  if (isTypingKeystroke(e)) return;
  if (e.key === 'c' || e.key === 'C') {
    if (settingsPanel.isOpen) settingsPanel.hide();
    else settingsPanel.show();
  }
});

const movesButton = document.createElement('button');
movesButton.className = 'btn btn-plain';
movesButton.id = 'moves-btn';
movesButton.textContent = 'Move reference';
movesButton.addEventListener('click', () => movesPanel.show(startScreen.selectedCharacterId));
(startScreen.root.querySelector('#primary-actions') ?? startScreen.root).appendChild(movesButton);

const inMatchMovesButton = document.createElement('button');
inMatchMovesButton.id = 'in-match-moves-btn';
inMatchMovesButton.className = 'in-match-moves-btn hidden';
inMatchMovesButton.textContent = 'Moves (M)';
inMatchMovesButton.addEventListener('click', () => movesPanel.show());
topRightControls.appendChild(inMatchMovesButton);
window.addEventListener('keydown', (e) => {
  if (isTypingKeystroke(e)) return;
  if (e.key === 'm' || e.key === 'M') {
    if (movesPanel.isOpen) movesPanel.hide();
    else movesPanel.show();
  }
});

onlineButton.addEventListener('click', () => {
  void beginOnlineMatch();
});

let netMatch: NetMatch | null = null;
// Set the moment our own seat is eliminated online, cleared at the start
// of each new online match. Distinguishes "the match ended for everyone,
// I was still playing" from "I was already out and spectating" so
// onMatchOver (below) doesn't clobber the honest placement screen a
// player already saw with a global win/loss overlay for a match they
// were no longer part of -- see the doc comment on that handler.
let eliminatedThisOnlineMatch = false;
// 2026-09-10: the most common path into onMatchOver is a human eliminated
// early, watching the remaining bots fight it out, then dismissing their
// placement overlay via "Keep spectating". The server almost always
// tears that down with resolved: false (isAbandonedByHumans, no human
// seats left) rather than a genuine resolution -- and the branch below
// used to do nothing at all in that case, on the theory that an
// unresolved end is "noise" once the player already has their placement
// screen. That left a real, reproducible dead end live in production: a
// frozen last frame, a plain (non-interactive) "Match complete" corner
// chip, and zero controls -- verified by playing a full match to
// elimination, choosing "Keep spectating", and watching the match get
// torn down with no way back. Remember what the placement overlay said
// so we can put the player's own "Play again" control back in front of
// them if they dismissed it and nothing else ever will.
let lastEliminationContent: MatchOverlayContent | null = null;

// Safety net for the spectator-stall dead end (2026-09-11, see wiki
// "Client Gaps Closed 2026-09-11"): if our own seat is eliminated and we
// choose to keep watching, the ONLY thing that ever brings a control back
// is a later 'matchEnd' arriving through onMatchOver. If the match never
// resolves server-side (or the message is lost to a superseded socket --
// see the comment in net-match.ts's message listener), no such message
// ever comes and the player is left on a frozen last frame forever with
// nothing to click, even though lastEliminationContent already exists.
// This timer guarantees an escape hatch regardless of the root cause on
// the server side: if no matchEnd shows up within SPECTATE_STALL_MS of
// our own elimination, a small 'Play again' chip appears and stays.
// 2026-09-12: it used to re-show the whole placement overlay, repeatedly,
// which threw a panel over the fight a player had explicitly asked to keep
// watching -- and made a click aimed at the game land on a button that had
// just reappeared. The chip keeps the guarantee without the interruption.
const SPECTATE_STALL_MS = 25_000;
let spectateStallTimer: ReturnType<typeof setInterval> | null = null;
function clearSpectateStallTimer(): void {
  if (spectateStallTimer !== null) {
    clearInterval(spectateStallTimer);
    spectateStallTimer = null;
  }
}

// Opt-in QA hint: ?qa=1 marks this session's hello.profile.qa so the
// private stats report (scripts/stats-report.mjs) can break out our own
// testing traffic from real players. Self-declared only -- see
// docs/MEASUREMENT.md; nobody, including us, is forced to set it, and a
// real player could set it too, so the report never treats it as proof.
function isQaSession(): boolean {
  return new URLSearchParams(location.search).get('qa') === '1';
}

function serverUrl(): string {
  const params = new URLSearchParams(location.search);
  if (params.get('server')) return params.get('server') as string;
  // Same-origin by default: the vite dev server (and the exposed preview
  // tunnel) proxies /socket to the match server, so this works without a
  // second exposed port. Production build's static host will need the
  // same proxy rule (or a direct wss:// URL) — see docs/PROTOCOL.md.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/socket`;
}

async function beginOnlineMatch(): Promise<void> {
  lastMatchWasOnline = true;
  eliminatedThisOnlineMatch = false;
  lastEliminationContent = null;
  clearSpectateStallTimer();
  spectateChip.hide();
  startScreen.hide();
  startScreenActive = false;
  attractMode.stop();
  winScreen.hide();
  timedBrawlEndScreen.hide();
  spectatorBanner.hide();
  matchOverlay.hide();
  matchIntro.hide();
  hud.hide();
      inMatchMovesButton.classList.add('hidden');
      inMatchSettingsButton.classList.add('hidden');
      inMatchFeedbackButton.classList.add('hidden');
  touchControls.hide();
  const generation = ++matchGeneration;

  if (match) {
    match.stop();
    match.renderer.destroy();
    match = null;
  }
  if (netMatch) {
    netMatch.stop();
    netMatch.renderer.destroy();
    netMatch = null;
  }
  canvasRoot.innerHTML = '';

  // Whatever the player typed on the start screen (persisted to
  // localStorage there), or '' if they never typed one -- an empty
  // name is a first-class, supported choice: joining a match must stay
  // a single click, and the server/every display falls back to the
  // slot label for an empty name rather than forcing a placeholder.
  const name = startScreen.playerName;
  const characterId = startScreen.selectedCharacterId;
  const net = new NetMatch(serverUrl(), {
    onStateChange: (state, detail) => {
      setNetStatus(state, detail);
      if (state !== 'waiting') netModeLine.classList.add('hidden');
      // The composed waiting screen (packages/app/src/ui/waiting-screen.ts)
      // owns this same moment: show it exactly while 'waiting', hide it for
      // every other state (connecting, in-match, disconnected, etc.) so it
      // never sits on top of the actual match once it starts.
      // 'connecting' shows the same composition in an honest
      // connecting state (see WaitingScreen.showConnecting) rather than
      // leaving a black screen; every other state hides it so it never
      // sits on top of the actual match once it starts.
      if (state === 'waiting') waitingScreen.show();
      else if (state === 'connecting') waitingScreen.showConnecting();
      else waitingScreen.hide();
      if (state === 'disconnected' || state === 'error') {
        matchOverlay.show({
          title: state === 'error' ? 'Could not reach the match server' : 'Disconnected from the match',
          message: 'The connection dropped and could not be resumed automatically. Your last match is over, but you can jump straight back into a new one.',
          tone: 'danger',
          actions: [{ label: 'Retry', onClick: () => void beginOnlineMatch() }],
        });
      } else if (state === 'reconnecting') {
        matchOverlay.show({
          title: 'Connection dropped, reconnecting…',
          message: 'Trying to get you back into your match. This usually takes a few seconds.',
          tone: 'danger',
          actions: [{ label: 'Give up and start a new match', onClick: () => void beginOnlineMatch(), kind: 'plain' }],
        });
      } else {
        matchOverlay.hide();
      }
    },
    onLobby: (players, capacity, countdownTicks, modeName) => {
      const countdown = countdownTicks >= 0 ? ` — starting in ${Math.ceil(countdownTicks / 60)}s` : '';
      setNetStatus('waiting', `${players}/${capacity} players${countdown}`);
      if (modeName) {
        netModeLine.textContent = modeName;
        netModeLine.classList.remove('hidden');
      } else {
        netModeLine.classList.add('hidden');
      }
      waitingScreen.setMode(modeName);
      waitingScreen.setCount(players, capacity, countdownTicks);
      waitingScreen.show();
    },
    onMatchOver: (winnerIndex, resolved, leaderboard, settings) => {
      clearSpectateStallTimer();
      hud.hide();
      inMatchMovesButton.classList.add('hidden');
      inMatchSettingsButton.classList.add('hidden');
      inMatchFeedbackButton.classList.add('hidden');
      touchControls.hide();
      setNetStatus('match-complete');
      // 2026-09-09, round 3 (see wiki "Match-End Client Bugs and Session
      // Wrap"): the player's own elimination is the ONLY source of truth
      // for their own result, and nothing that happens to the match
      // afterwards may take that screen away. onEliminated (below) shows
      // it the instant the local seat is eliminated; this handler must
      // never call matchOverlay.hide() on that path. The previous version
      // hid matchOverlay unconditionally before checking `resolved`,
      // which wiped the honest placement screen the instant the common
      // solo-human-among-bots path hit the server's isAbandonedByHumans
      // teardown (resolved: false) right after elimination -- leaving
      // the player with nothing on screen at all.
      if (eliminatedThisOnlineMatch) {
        // Already eliminated. An unresolved/abandoned end is noise about
        // a match they're no longer part of -- their own placement
        // overlay (from onEliminated, with its own Play again button)
        // stays exactly as it is.
        //
        // A genuine resolution is NOT noise: they were watching the match
        // play out and the rule ("a still-watching player must be told
        // who won") applies to them too. 2026-09-10: this branch used to
        // return unconditionally here, which meant a spectator who
        // watched a real match resolve got no winner announcement at
        // all -- their placement screen just sat there forever with no
        // update, indistinguishable from a client that had silently
        // stopped tracking the match. Update the same placement overlay
        // with the winner appended instead of replacing it -- the player
        // keeps their own placement, "Play again" and "Keep spectating"
        // controls, and now also learns who won.
        if (resolved) {
          spectateChip.hide();
          matchOverlay.announceWinner(winnerIndex, netMatch?.localSlot(), netMatch ? (slot) => netMatch!.nameFor(slot) : undefined);
        } else if (!matchOverlay.isVisible && lastEliminationContent) {
          // Genuinely unresolved teardown (no human seats left) while the
          // player had dismissed their placement screen to keep watching.
          // Nothing else will ever bring a control back on screen, so put
          // their own placement overlay back up rather than leave a
          // frozen frame behind a non-interactive "Match complete" chip.
          matchOverlay.show(lastEliminationContent);
        }
        return;
      }
      if (!resolved) {
        // Not eliminated, but the match ended without resolving (e.g. an
        // abandoned-teardown edge case reached before our own elimination
        // event fired). No winner to announce, but the player must still
        // get a way forward -- never leave a dead frame with no control.
        spectateChip.hide();
        matchOverlay.show({
          title: 'Match ended',
          message: 'This match ended before it finished. You can jump straight into a new one.',
          actions: [{ label: 'Play again', onClick: () => void beginOnlineMatch() }],
        });
        return;
      }
      // Still alive and the match genuinely resolved: tell them who won.
      matchOverlay.hide();
      spectateChip.hide();
      audio.play('match_end');
      if (isTimedBrawl(settings) && leaderboard) {
        // Timed Brawl never eliminates (fighters respawn -- see
        // eliminatedThisOnlineMatch above, which this mode never sets),
        // so every finish for a still-connected player takes this
        // branch. Score is read from currentSnapshots() right now --
        // FighterSnapshot already carries koCount/deathCount
        // (packages/sim/src/sim.ts).
        const scores = (netMatch?.currentSnapshots() ?? []).map((s, slot) => ({
          slot,
          koCount: s.koCount,
          deathCount: s.deathCount,
        }));
        timedBrawlEndScreen.show(winnerIndex, leaderboard, scores, netMatch?.localSlot(), netMatch ? (slot) => netMatch!.nameFor(slot) : undefined);
      } else {
        winScreen.show(winnerIndex, netMatch?.localSlot(), netMatch ? (slot) => netMatch!.nameFor(slot) : undefined);
      }
    },
    onMatchBegan: (slot, name, joinedLate) => {
      // Names the fighter that belongs to this player for the opening
      // couple of seconds. See ui/match-intro.ts for why.
      matchIntro.show(name, localPlayerColour(slot), joinedLate);
      // Dims every other fighter and enlarges the local pointer for the
      // first ~1.8s (Renderer.announceLocalPlayer), fresh join or a
      // mid-match join alike -- both are the first moment THIS client
      // can see the arena, so both deserve the same emphasis. Render-side
      // only; does not touch sim state.
      netMatch?.renderer.announceLocalPlayer();
    },
    onEliminated: (placement, totalFighters) => {
      matchIntro.hide();
      eliminatedThisOnlineMatch = true;
      touchControls.hide();
      lastEliminationContent = {
        title: `You finished ${placement} of ${totalFighters}`,
        message: `You can jump straight into a new match${SPECTATE_OFFER}.`,
        actions: [
          { label: 'Play again', onClick: () => void beginOnlineMatch() },
          {
            label: 'Keep spectating',
            onClick: () => {
              matchOverlay.hide();
              spectateChip.show();
            },
            kind: 'plain',
          },
          // In a 20-player free-for-all, 19 of every 20 players end their
          // match on THIS overlay, not the win screen -- so the win
          // screen's feedback route (see winScreen below) was reaching
          // almost nobody. Elimination is also the moment a player has
          // the sharpest opinion about how the fight felt.
          {
            label: 'Say what felt wrong',
            onClick: () =>
              feedbackPanel.show({
                mode: netModeLine.textContent || 'online',
                result: `eliminated ${placement} of ${totalFighters}`,
              }),
            kind: 'plain',
          },
        ],
      };
      matchOverlay.show(lastEliminationContent);
      clearSpectateStallTimer();
      // Recurring, not one-shot: the player may dismiss this re-shown
      // overlay again ("Keep spectating") and the match may still never
      // resolve, so keep checking every SPECTATE_STALL_MS rather than
      // giving up the escape hatch after a single check.
      spectateStallTimer = setInterval(() => {
        if (eliminatedThisOnlineMatch && lastEliminationContent && !matchOverlay.isVisible) {
          spectateChip.show();
        }
      }, SPECTATE_STALL_MS);
    },
    onContextLost: onRendererContextLost,
    onContextRestored: onRendererContextRestored,
    onRenderStalled: onRendererRenderStalled,
  }, audio, isQaSession());
  netMatch = net;
  net.input.setBinding(0, currentBindings.p1);
  net.input.setBinding(1, currentBindings.p2);
  if (!(await initWithTimeout(net.init(canvasRoot), 'online match'))) return;
  net.connect(name, characterId);
  if (touchCapable) net.input.setTouchSource(LOCAL_SLOT, touchControls.source);

  // Same HUD widget the local match uses (packages/app/src/ui/hud.ts),
  // fed from NetMatch.currentSnapshots() -- see that method's comment for
  // why it is a safe drop-in for Match.currentSnapshots(). Shown once a
  // match has actually started so it never shows fighter cards over the
  // waiting-for-players screen.
  let announcedStart = false;
  const onlineHudTick = (): void => {
    if (generation !== matchGeneration) return;
    if (netMatch && netMatch.hasStarted() && !netMatch.isOver()) {
      if (!announcedStart) {
        announcedStart = true;
        audio.play('match_start');
        controlsHint.maybeShow();
      }
      hud.show();
      inMatchMovesButton.classList.remove('hidden');
      inMatchSettingsButton.classList.remove('hidden');
      inMatchFeedbackButton.classList.remove('hidden');
      if (touchCapable) touchControls.show();
      const onlineSettings = netMatch.getMatchSettings();
      hud.update(
        netMatch.currentSnapshots(),
        undefined,
        netMatch.localSlot(),
        netMatch.displayNames(),
        isTimedBrawl(onlineSettings) && onlineSettings
          ? { clockText: formatClock(ticksRemaining(netMatch.currentTick, onlineSettings)) }
          : undefined,
        onlineSettings
          ? {
              winCondition: onlineSettings.winCondition,
              clockText: isTimedBrawl(onlineSettings)
                ? formatClock(ticksRemaining(netMatch.currentTick, onlineSettings))
                : formatClock(netMatch.currentTick),
            }
          : undefined,
      );
    } else {
      hud.hide();
      inMatchMovesButton.classList.add('hidden');
      inMatchSettingsButton.classList.add('hidden');
      inMatchFeedbackButton.classList.add('hidden');
      touchControls.hide();
    }
    requestAnimationFrame(onlineHudTick);
  };
  requestAnimationFrame(onlineHudTick);
}

// Shared between local and online modes -- rematch must restart *the mode
// that was actually being played*, not unconditionally the local
// two-player harness (that was a real bug: winning/finishing an online
// match and clicking Rematch silently dropped you into local play).
const winScreen = new WinScreen(
  appRoot,
  () => {
    if (lastMatchWasOnline) {
      void beginOnlineMatch();
    } else {
      void beginMatch();
    }
  },
  (result) =>
    feedbackPanel.show({
      mode: netModeLine.textContent || (lastMatchWasOnline ? 'online' : 'local'),
      result,
    }),
);

// Timed Brawl's own end screen (score standings, not "N of 20" placement
// language) -- see timed-brawl-end-screen.ts. Same rematch routing as
// winScreen: whichever mode was actually being played.
const timedBrawlEndScreen = new TimedBrawlEndScreen(
  appRoot,
  () => {
    if (lastMatchWasOnline) {
      void beginOnlineMatch();
    } else {
      void beginMatch();
    }
  },
  (result) =>
    feedbackPanel.show({
      mode: netModeLine.textContent || (lastMatchWasOnline ? 'online' : 'local'),
      result,
    }),
);

async function beginMatch(): Promise<void> {
  lastMatchWasOnline = false;
  winScreen.hide();
  timedBrawlEndScreen.hide();
  startScreen.hide();
  startScreenActive = false;
  attractMode.stop();
  spectatorBanner.hide();
  matchOverlay.hide();
  hud.show();
      inMatchMovesButton.classList.remove('hidden');
      inMatchSettingsButton.classList.remove('hidden');
      inMatchFeedbackButton.classList.remove('hidden');
  if (touchCapable) touchControls.show();
  controlsHint.maybeShow();
  const generation = ++matchGeneration;
  lastFrameTimeMs = null;

  if (match) {
    match.stop();
    match.renderer.destroy();
    canvasRoot.innerHTML = '';
  }

  audio.play('match_start');
  // Player 1 (the local slot) gets the chosen character; slot 1 stays the
  // default placeholder -- this local harness is 2 human-controlled slots,
  // not bot-filled, so there is no bot roster to randomize here.
  // Dev/QA helper only: ?crowd20=1 fills local (offline, single-device)
  // practice mode with all 8 characters cycled to fill 20 slots, so a
  // crowded match can be screenshotted without needing 20 real
  // connections. Local practice mode never touches the netcode, so this
  // has no effect on real online matches.
  const __DEBUG_CROWD = new URLSearchParams(location.search).get('crowd20') === '1';
  const localCharacters = __DEBUG_CROWD
    ? Array.from({ length: 20 }, (_, i) => (ALL_CHARACTERS[i % ALL_CHARACTERS.length] as (typeof ALL_CHARACTERS)[number]).character)
    : [resolveCharacterId(startScreen.selectedCharacterId), PLACEHOLDER_CHARACTER];
  // Dev/QA helper: ?seed=<n> makes a crowd20 (or ordinary local) match
  // reproducible run to run -- default falls back to the wall clock like
  // before. ?arena=<id> pins the stage instead of deriving it from the
  // seed (see issue #19); an unknown/absent id leaves arena selection
  // exactly as before (seed-derived), so this is invisible to a normal
  // player who never sets these params. See docs/LOCAL_CROWD_TESTING.md.
  const __DEBUG_PARAMS = new URLSearchParams(location.search);
  const __DEBUG_SEED_PARAM = __DEBUG_PARAMS.get('seed');
  const localSeed = __DEBUG_SEED_PARAM !== null && Number.isFinite(Number(__DEBUG_SEED_PARAM))
    ? Number(__DEBUG_SEED_PARAM) & 0xffffffff
    : Date.now() & 0xffffffff;
  const __DEBUG_ARENA_PARAM = __DEBUG_PARAMS.get('arena');
  const localArenaOverride = isKnownArenaId(__DEBUG_ARENA_PARAM) ? __DEBUG_ARENA_PARAM : null;
  const localHumanSlotCount = __DEBUG_CROWD ? 2 : 2;
  // Dev/QA helper: ?mode=timedKO drives the local (offline) harness --
  // including ?crowd20=1 -- through Timed Brawl instead of Battle
  // Royale, the only way to see the Timed Brawl HUD/end screen with a
  // real 20-fighter crowd, since the preview tunnel used for browser
  // verification doesn't proxy the websocket upgrade a real online
  // match needs (see docs/LOCAL_CROWD_TESTING.md). ?timeLimit=<seconds>
  // shortens the match for faster QA loops; both are no-ops for a normal
  // player, who never sets either param, and Battle Royale stays the
  // unconditional default with neither present.
  const __DEBUG_MODE_PARAM = __DEBUG_PARAMS.get('mode');
  const __DEBUG_TIME_LIMIT_PARAM = __DEBUG_PARAMS.get('timeLimit');
  // ?mode=stocks&stocks=<n> drives the same local harness through Stocks
  // instead -- see docs/LOCAL_CROWD_TESTING.md. ?stocks=<n> overrides the
  // starting life count (default: the sim's own stocks default, 2).
  const __DEBUG_STOCKS_PARAM = __DEBUG_PARAMS.get('stocks');
  const localSettingsOverride: Partial<MatchSettings> | undefined =
    __DEBUG_MODE_PARAM === 'timedKO'
      ? {
          winCondition: 'timedKO',
          ...(Number.isFinite(Number(__DEBUG_TIME_LIMIT_PARAM))
            ? { timeLimitTicks: Math.round(Number(__DEBUG_TIME_LIMIT_PARAM) * 60) }
            : {}),
        }
      : __DEBUG_MODE_PARAM === 'stocks'
        ? {
            winCondition: 'stocks',
            ...(Number.isFinite(Number(__DEBUG_STOCKS_PARAM))
              ? { startingStocks: Math.round(Number(__DEBUG_STOCKS_PARAM)) }
              : {}),
          }
        : undefined;
  const localMatch: Match = new Match(canvasRoot, localCharacters, localSeed, {
    onMatchOver: (winnerIndex, leaderboard, settings) => {
      hud.hide();
      inMatchMovesButton.classList.add('hidden');
      inMatchSettingsButton.classList.add('hidden');
      inMatchFeedbackButton.classList.add('hidden');
      touchControls.hide();
      audio.play('match_end');
      if (isTimedBrawl(settings) && leaderboard) {
        const scores = localMatch.currentSnapshots().map((s, slot) => ({ slot, koCount: s.koCount, deathCount: s.deathCount }));
        timedBrawlEndScreen.show(winnerIndex, leaderboard, scores, 0, (slot) => localMatch.nameFor(slot));
      } else {
        winScreen.show(winnerIndex, 0, (slot) => localMatch.nameFor(slot));
      }
      match?.stop();
    },
    transformFrame: (frame) => {
      const currentAdapter = adapter;
      const currentSpectator = spectator;
      if (!currentAdapter || !currentSpectator) return frame;
      currentAdapter.update();

      const fighters = frame.fighters.map((f, i) => ({ ...f, eliminated: currentAdapter.status(i).eliminated }));

      if (currentAdapter.status(LOCAL_SLOT).eliminated && !currentSpectator.isActive) {
        currentSpectator.activate();
        const status = currentAdapter.status(LOCAL_SLOT);
        spectatorBanner.show(status.placement ?? currentAdapter.fighterCount, currentAdapter.fighterCount);
      }

      if (!currentSpectator.isActive) {
        return { ...frame, fighters, localPlayerIndex: LOCAL_SLOT };
      }

      const now = performance.now();
      const dtSeconds = lastFrameTimeMs === null ? 1 / 60 : Math.min(0.1, (now - lastFrameTimeMs) / 1000);
      lastFrameTimeMs = now;

      const { width, height } = localMatch.renderer.viewSize;
      const arena = currentAdapter.liveArenaBounds() ?? STATIC_ARENA;
      const cameraOverride = currentSpectator.update({
        positions: fighters.map((f) => ({ x: f.x, y: f.y })),
        viewWidth: width,
        viewHeight: height,
        arena,
        dtSeconds,
      });

      return { ...frame, fighters, liveArenaBounds: arena, cameraOverride, localPlayerIndex: LOCAL_SLOT };
    },
    onContextLost: onRendererContextLost,
    onContextRestored: onRendererContextRestored,
    onRenderStalled: onRendererRenderStalled,
  }, undefined, audio, localHumanSlotCount, localArenaOverride, localSettingsOverride);
  match = localMatch;
  localMatch.input.setBinding(0, currentBindings.p1);
  localMatch.input.setBinding(1, currentBindings.p2);
  adapter = new SimMatchAdapter(localMatch);
  spectator = new SpectatorController(adapter, LOCAL_SLOT, {
    centerX: (STATIC_ARENA.minX + STATIC_ARENA.maxX) / 2,
    centerY: (STATIC_ARENA.minY + STATIC_ARENA.maxY) / 2,
    scale: 3,
  });

  if (!(await initWithTimeout(localMatch.init(canvasRoot), 'local match'))) return;
  localMatch.start();
  // Local two-player harness: touch, if available, always drives slot 0
  // (the local human) same as online mode -- P2 stays keyboard/gamepad
  // only, matching the existing "second local player has no on-screen
  // affordance" state of this dev harness.
  if (touchCapable) localMatch.input.setTouchSource(LOCAL_SLOT, touchControls.source);

  const hudTick = (): void => {
    if (generation !== matchGeneration) return;
    if (match && adapter && !match.isOver()) {
      const extras = Array.from({ length: adapter.fighterCount }, (_, i) => {
        const status = (adapter as SimMatchAdapter).status(i);
        return { eliminated: status.eliminated, placement: status.placement };
      });
      const localSettings = localMatch.getMatchSettings();
      hud.update(
        match.currentSnapshots(),
        extras,
        0,
        localMatch.displayNames(),
        isTimedBrawl(localSettings) && localSettings
          ? { clockText: formatClock(ticksRemaining(localMatch.currentTick, localSettings)) }
          : undefined,
        localSettings
          ? {
              winCondition: localSettings.winCondition,
              clockText: isTimedBrawl(localSettings)
                ? formatClock(ticksRemaining(localMatch.currentTick, localSettings))
                : formatClock(localMatch.currentTick),
            }
          : undefined,
      );
    }
    requestAnimationFrame(hudTick);
  };
  requestAnimationFrame(hudTick);
}

window.addEventListener('keydown', (e) => {
  if (isTypingKeystroke(e)) return;
  if (e.code === 'F3') {
    e.preventDefault();
    match?.toggleDebug();
    netMatch?.toggleDebug();
  } else if (e.code === 'Tab' && spectator?.isActive) {
    e.preventDefault();
    spectator.cycleNext();
  } else if (e.code === 'KeyO' && spectator?.isActive) {
    e.preventDefault();
    spectator.toggleOverview();
  }
});
