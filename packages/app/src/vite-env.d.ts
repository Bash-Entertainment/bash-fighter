// Ambient types for vite-injected globals (issue #19): this package's
// hello path reads import.meta.env.DEV to gate the dev-only `?arena=<id>`
// stage pin (see NetMatch.openSocket). Vite injects these types at build
// time, but the repo's single root tsconfig (types: ["node"]) has no
// vite/client reference, so the reference lives here where the root
// tsconfig's include picks it up. Only build-time constants are used --
// no import.meta.env fields beyond DEV, keeping the surface tiny.
/// <reference types="vite/client" />
