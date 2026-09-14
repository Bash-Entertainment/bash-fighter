import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

// Serve the synthesised SFX/ambient WAVs from packages/audio/assets at
// /audio/* via a tiny dev/preview middleware, and copy them into the
// production build's dist/audio -- avoids duplicating the files into
// app/public while keeping one source of truth next to the script that
// generates them (packages/audio/scripts/generate-sounds.mjs).
const audioAssetsDir = fileURLToPath(new URL('../audio/assets', import.meta.url));

function serveAudioAssets(): Plugin {
  const mime: Record<string, string> = { '.wav': 'audio/wav' };
  return {
    name: 'serve-audio-assets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/audio/')) return next();
        try {
          const file = join(audioAssetsDir, req.url.slice('/audio/'.length));
          const data = await readFile(file);
          res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
          res.end(data);
        } catch {
          next();
        }
      });
    },
    async generateBundle() {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(audioAssetsDir);
      for (const f of files) {
        const data = await readFile(join(audioAssetsDir, f));
        this.emitFile({ type: 'asset', fileName: `audio/${f}`, source: data });
      }
    },
  };
}

// itch.io hosts the game in a subdirectory on its own CDN, so asset
// URLs must be relative (`base: './'`), not absolute (`/assets/...`)
// like the production build served from the domain root. See
// docs/ITCH_BUILD.md / `npm run build:itch`.
export default defineConfig({
  root: __dirname,
  base: './',
  build: { outDir: 'dist-itch' },
  define: { __ITCH_BUILD__: true },
  plugins: [serveAudioAssets()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Proxy the match server's WebSocket + health endpoint through the
    // same origin the dev server (and, in the browser preview tunnel,
    // the exposed port) is on, so the client's same-origin WS URL works
    // without exposing a second port.
    proxy: {
      '/socket': { target: 'ws://localhost:8081', ws: true },
      '/api': { target: 'http://localhost:8081' },
    },
    fs: { allow: ['..'] },
  },
  resolve: {
    // Workspace packages ship raw TS source with explicit .ts extensions
    // (Node's type-stripping convention); esbuild/Vite need this hint to
    // resolve those specifiers.
    extensions: ['.ts', '.js', '.mjs', '.json'],
  },
});
