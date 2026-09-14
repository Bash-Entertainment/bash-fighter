// Loaded before main.ts, only relevant to the itch.io build (see
// vite.config.itch.ts / npm run build:itch, docs/ITCH_BUILD.md).
//
// itch.io serves the game from its own CDN origin (a subdomain of
// itch.zone / hwcdn.net for the embedded iframe), not from
// bashfighter.com. main.ts's serverUrl() already supports an explicit
// override via a `?server=` query param (see packages/app/src/main.ts);
// this file supplies that override automatically when the page is not
// being served from our own origin, so a player never has to type a
// query param by hand. It does nothing (no-op) when the page is already
// on bashfighter.com or when a `server` param is already present -- an
// explicit override always wins.
//
// This only rewrites the *query string* the already-loaded main.ts will
// read via `location.search`; it does not navigate or reload the page.
declare const __ITCH_BUILD__: boolean | undefined;

(function bootstrapItchServerOverride(): void {
  // Only active in the itch.io build (set via `define` in
  // vite.config.itch.ts) -- a no-op import in the normal dev server and
  // production build, so this can never affect other agents' local dev
  // or the bashfighter.com deploy.
  if (typeof __ITCH_BUILD__ === 'undefined' || !__ITCH_BUILD__) return;

  const PRODUCTION_HOST = 'bashfighter.com';
  const PRODUCTION_WS = 'wss://bashfighter.com/socket';

  const host = location.hostname;
  const isProductionOrigin = host === PRODUCTION_HOST || host.endsWith(`.${PRODUCTION_HOST}`);
  if (isProductionOrigin) return;

  const params = new URLSearchParams(location.search);
  if (params.get('server')) return; // explicit override already present

  params.set('server', PRODUCTION_WS);
  const newSearch = params.toString();
  const newUrl = `${location.pathname}?${newSearch}${location.hash}`;
  history.replaceState(history.state, '', newUrl);
})();
