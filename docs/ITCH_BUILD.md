# Building and publishing the itch.io HTML5 upload

itch.io hosts the game from its own CDN, in a subdirectory, at a different
origin than bashfighter.com. That needs two things the normal
`npm run build` output doesn't have:

- relative asset URLs (itch 404s on absolute `/assets/...` paths served
  from a subdirectory)
- a match-server URL that points at `wss://bashfighter.com/socket`
  instead of the page's own origin (there is no game server on itch's
  CDN)

## What produces the build

- `packages/app/vite.config.itch.ts` — same app config as
  `vite.config.ts`, with `base: './'` and `outDir: 'dist-itch'`, plus
  `define: { __ITCH_BUILD__: true }`.
- `packages/app/src/itch-bootstrap.ts` — loaded before `main.ts` in
  `index.html`. It is a no-op unless `__ITCH_BUILD__` is set (so it
  never affects local dev or the bashfighter.com build). When active,
  and the page is not served from bashfighter.com, it rewrites the
  page's query string to add `?server=wss://bashfighter.com/socket`
  before `main.ts` reads `location.search` — `main.ts`'s existing
  `serverUrl()` already supports that override, unchanged.
- `scripts/package-itch-zip.mjs` — zips `packages/app/dist-itch/*` into
  `dist-itch.zip` at the repo root with `index.html` at the zip root
  (itch's required layout), using Python's `zipfile` module so we don't
  add an npm dependency just to zip a handful of files.

## Producing the zip

```
npm run build:itch
```

This runs `vite build --config vite.config.itch.ts` in `packages/app`
and then the zip script. Output: `dist-itch.zip` at the repo root.

## Uploading to itch.io

1. Go to the project's edit page: https://bashfighter.itch.io/bash-fighter/edit
2. "Kind of project" → HTML.
3. Uploads → upload `dist-itch.zip`, check "This file will be played in
   the browser".
4. Embed options: viewport 1280x720 (the game's default resolution),
   "Enable fullscreen button" checked, "Automatically start on page
   load" off (bots fill the lobby, so leaving it on the start screen
   until the visitor clicks is the honest default).
5. Save, then reload the public page **logged out** and play a match to
   confirm.

## Local verification before uploading

```
npm run build:itch
cd packages/app/dist-itch && python3 -m http.server 8099
```

Serve that port through the browser preview tunnel (see the
`local_testing` skill) and click through to a live match against
**production** (`bashfighter.com`) — the same cross-origin path a real
itch visitor takes. Confirm no 404s in the network panel (relative
asset paths) and that the websocket connects to
`wss://bashfighter.com/socket` (not `ws://localhost:.../socket`, which
would mean the bootstrap override didn't fire).

## Known limitation

`itch-bootstrap.ts`'s override only fires when nothing has already set
a `server` query param, and only until nginx/the match server's origin
policy on bashfighter.com changes. Confirmed on 2026-09-14: neither
`deploy/nginx*.conf` nor the match server checks the WebSocket
`Origin` header, so the itch origin is accepted as-is. If that ever
changes, this build needs a matching change or it will silently fail to
connect.

## Standing rule: re-upload after every player-facing change

The itch.io build is a manual zip upload and is **not** part of `deploy.sh`, so
it drifts silently. On 2026-09-19 the embed was a week behind production and was
serving players an older game than bashfighter.com — including the start-screen
how-to-play block added to answer "I don't understand how to win".

Whenever a player-facing change is deployed, run `npm run build:itch`, upload
`dist-itch.zip` on the itch project's Edit game page, keep "This file will be
played in the browser" ticked, save, then load the public page and click Run
game to confirm the change is actually there.
