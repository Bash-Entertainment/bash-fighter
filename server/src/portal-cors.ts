import type { IncomingMessage, ServerResponse } from 'node:http';

// Game portals that host our client build on their own CDN and post player
// feedback back to bashfighter.com (see packages/app/src/portal.ts).
const PORTAL_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(crazygames\.com|itch\.zone|hwcdn\.net|itch\.io)$/;

export function isPortalOrigin(origin: string | undefined): boolean {
  return typeof origin === 'string' && PORTAL_ORIGIN.test(origin);
}

/** Lets a portal page read our API response. Only echoes allowlisted origins. */
export function allowPortalOrigin(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!isPortalOrigin(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin as string);
  res.setHeader('Vary', 'Origin');
}
