// Portal builds (itch.io, CrazyGames) run from the portal's own CDN origin,
// not bashfighter.com. These helpers are no-ops in the normal build.
declare const __ITCH_BUILD__: boolean | undefined;
declare const __PORTAL__: string | undefined;

const PRODUCTION_ORIGIN = 'https://bashfighter.com';

/** The portal this build was made for, or undefined for the bashfighter.com build. */
export function portalName(): string | undefined {
  if (typeof __ITCH_BUILD__ === 'undefined' || !__ITCH_BUILD__) return undefined;
  return typeof __PORTAL__ === 'string' && __PORTAL__.length > 0 ? __PORTAL__ : 'itch';
}

export function isOffOrigin(hostname: string): boolean {
  return hostname !== 'bashfighter.com' && !hostname.endsWith('.bashfighter.com');
}

/**
 * Where to send an HTTP API call. Off-origin portal builds post to
 * bashfighter.com as a CORS "simple request" (text/plain, no preflight;
 * a keepalive fetch cannot be preflighted).
 */
export function apiRequest(path: string, hostname = location.hostname): { url: string; contentType: string } {
  if (portalName() !== undefined && isOffOrigin(hostname)) {
    return { url: PRODUCTION_ORIGIN + path, contentType: 'text/plain;charset=UTF-8' };
  }
  return { url: path, contentType: 'application/json' };
}

/** CrazyGames forbids links that send players to other sites. */
export function outboundLinksAllowed(): boolean {
  return portalName() !== 'crazygames';
}
