// Account-free player feedback (2026-09-13). The owner directive: as an
// agent we lack the human feel for the game, so real players need a
// dead-simple way to tell us what felt off, and it has to land somewhere
// we can actually read -- a plain newline-delimited JSON log next to the
// other production shared state (see [[Hetzner Production Server]] for
// /srv/bash-fighter/shared and match-defaults.ts for the existing
// convention of reading production config from that directory).
//
// Deliberately NOT wired through the websocket/Match machinery: feedback
// can arrive with no match in progress (from the start screen) and must
// never be able to desync or block a live match, so it is a small,
// separate plain-HTTP POST handler with its own body limits and its own
// in-memory rate limiter.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Whole request body cap, comfortably above a maxed-out comment plus
 *  ratings/context JSON overhead, but small enough that nobody can use
 *  this endpoint to push meaningful payloads at the box. */
export const FEEDBACK_MAX_BODY_BYTES = 8 * 1024;
export const FEEDBACK_MAX_COMMENT_LENGTH = 2000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_SUBMISSIONS = 5;

const RATING_KEYS = [
  'combatWeight',
  'cameraReadability',
  'funFactor',
  'touchErgonomics',
  'matchmakingClarity',
] as const;
export type RatingKey = (typeof RATING_KEYS)[number];
export type FeedbackRatings = Partial<Record<RatingKey, number>>;

export interface FeedbackContext {
  matchId?: string;
  arenaId?: string;
  mode?: string;
  placement?: number | string;
  result?: string;
  touchControls?: boolean;
  viewport?: { width?: number; height?: number };
  buildSha?: string;
}

/** The record actually written to the log -- one JSON object per line.
 *  No client address, no request headers, nothing that could identify a
 *  person: just the timestamp and whatever the client volunteered about
 *  the match/UI, already sanitised and clamped. */
export interface StoredFeedback {
  receivedAt: string;
  /** Self-declared ?qa=1 session (our own testing). Kept so the daily
   *  feedback review can tell our smoke tests from a real player's
   *  words -- the same self-declared flag the stats report uses. */
  qa?: boolean;
  comment?: string;
  ratings?: FeedbackRatings;
  context?: FeedbackContext;
}

// Strip C0/C1 control characters but keep \n and \t -- a player's comment
// is free text and may reasonably contain line breaks; JSON.stringify
// escapes those safely into the one-line-per-record log, so keeping them
// in the *value* never breaks the newline-delimited file format.
function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

function clampString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = stripControlChars(value).trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, maxLength);
}

function clampRating(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.round(value);
  if (n < 1 || n > 5) return undefined;
  return n;
}

function sanitiseRatings(value: unknown): FeedbackRatings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const out: FeedbackRatings = {};
  for (const key of RATING_KEYS) {
    const r = clampRating(input[key]);
    if (r !== undefined) out[key] = r;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sanitiseContext(value: unknown): FeedbackContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const out: FeedbackContext = {};
  const matchId = clampString(input.matchId, 200);
  if (matchId) out.matchId = matchId;
  const arenaId = clampString(input.arenaId, 100);
  if (arenaId) out.arenaId = arenaId;
  const mode = clampString(input.mode, 100);
  if (mode) out.mode = mode;
  if (typeof input.placement === 'number' && Number.isFinite(input.placement)) {
    out.placement = clampNumber(input.placement, 0, 999);
  } else {
    const placementStr = clampString(input.placement, 50);
    if (placementStr) out.placement = placementStr;
  }
  const result = clampString(input.result, 50);
  if (result) out.result = result;
  if (typeof input.touchControls === 'boolean') out.touchControls = input.touchControls;
  if (input.viewport && typeof input.viewport === 'object') {
    const v = input.viewport as Record<string, unknown>;
    const width = clampNumber(v.width, 0, 20000);
    const height = clampNumber(v.height, 0, 20000);
    if (width !== undefined || height !== undefined) out.viewport = { width, height };
  }
  const buildSha = clampString(input.buildSha, 64);
  if (buildSha) out.buildSha = buildSha;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Default log path: next to production's existing shared env dir
 *  (/srv/bash-fighter/shared, see match-defaults.ts) but always
 *  overridable via FEEDBACK_LOG_PATH -- e.g. for local dev/tests, which
 *  must never write into a real production directory just by running. */
export function defaultFeedbackLogPath(): string {
  return process.env.FEEDBACK_LOG_PATH ?? '/srv/bash-fighter/shared/feedback.jsonl';
}

/** Appends one JSON line to the log file, creating its directory first.
 *  Never throws: a misconfigured/missing/unwritable path must not take
 *  the request down or the process with it -- fall back to stdout (still
 *  captured by journalctl in production) so a submission is never
 *  silently lost even when the file write fails. */
function appendFeedbackLine(logPath: string, record: StoredFeedback): void {
  const line = JSON.stringify(record);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line + '\n');
  } catch (err) {
    console.log(`[feedback] failed to write ${logPath}, falling back to stdout: ${(err as Error).message}`);
    console.log(`[feedback:fallback] ${line}`);
    return;
  }
  // Always one line per submission in the normal journalctl-tailed log
  // too, regardless of whether the file write succeeded -- see task
  // brief: "emit one [feedback] console line per submission".
  console.log(`[feedback] ${line}`);
}

interface RateLimiter {
  /** Returns true if this address is allowed to submit right now. Does
   *  not itself record the attempt -- only a validated, accepted
   *  submission should count against the limit, so record() is called
   *  separately once every other check has passed. */
  check(address: string, now: number): boolean;
  record(address: string, now: number): void;
}

/** Simple in-memory sliding-window limiter: keeps a timestamp list per
 *  address and counts how many fall within the trailing window. Fine for
 *  this endpoint's tiny expected volume, and deliberately not
 *  shared/durable across restarts -- a restart clearing everyone's rate
 *  limit is a harmless failure mode for a feedback box. */
function createRateLimiter(windowMs: number, maxHits: number): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    check(address, now) {
      const list = hits.get(address);
      if (!list) return true;
      const recent = list.filter((t) => now - t < windowMs);
      hits.set(address, recent);
      return recent.length < maxHits;
    },
    record(address, now) {
      const list = hits.get(address) ?? [];
      list.push(now);
      hits.set(
        address,
        list.filter((t) => now - t < windowMs),
      );
    },
  };
}

export interface FeedbackHandlerOptions {
  logPath?: string;
  now?: () => number;
  maxBodyBytes?: number;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/** Builds the POST /api/feedback request handler. Kept as a factory
 *  (rather than one module-scope handler) so tests can point it at a
 *  scratch log path and a fake clock instead of touching the real
 *  filesystem/wall clock or production's rate-limit state. */
export function createFeedbackHandler(options: FeedbackHandlerOptions = {}) {
  const logPath = options.logPath ?? defaultFeedbackLogPath();
  const now = options.now ?? Date.now;
  const maxBodyBytes = options.maxBodyBytes ?? FEEDBACK_MAX_BODY_BYTES;
  const limiter = createRateLimiter(
    options.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS,
    options.rateLimitMax ?? RATE_LIMIT_MAX_SUBMISSIONS,
  );

  return function handleFeedback(req: IncomingMessage, res: ServerResponse): void {
    // Used for rate limiting only, per the task brief -- never written to
    // the log record. req.socket.remoteAddress is whatever Node/the OS
    // sees (loopback behind any proxy in this deploy, see [[Hetzner
    // Production Server]]); good enough for "don't let one client spam
    // this", not meant to be a real per-user identity.
    const address = req.socket.remoteAddress ?? 'unknown';

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    if (!limiter.check(address, now())) {
      sendJson(res, 429, { ok: false, error: 'too many submissions, try again later' });
      return;
    }

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      sendJson(res, 400, { ok: false, error: 'expected application/json' });
      return;
    }

    const declaredLength = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      sendJson(res, 413, { ok: false, error: 'body too large' });
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;

    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > maxBodyBytes) {
        tooLarge = true;
        sendJson(res, 413, { ok: false, error: 'body too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      // A client that aborts mid-upload never gets a response written to
      // a destroyed socket -- just stop, nothing to log.
    });

    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON' });
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { ok: false, error: 'invalid JSON' });
        return;
      }
      const body = parsed as Record<string, unknown>;
      const comment = clampString(body.comment, FEEDBACK_MAX_COMMENT_LENGTH);
      const ratings = sanitiseRatings(body.ratings);
      const context = sanitiseContext(body.context);

      if (!comment && !ratings) {
        sendJson(res, 400, { ok: false, error: 'comment or ratings required' });
        return;
      }

      const record: StoredFeedback = { receivedAt: new Date(now()).toISOString() };
      if (body.qa === true) record.qa = true;
      if (comment) record.comment = comment;
      if (ratings) record.ratings = ratings;
      if (context) record.context = context;

      limiter.record(address, now());
      appendFeedbackLine(logPath, record);
      sendJson(res, 200, { ok: true });
    });
  };
}
