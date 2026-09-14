#!/usr/bin/env node
// Zips packages/app/dist-itch into dist-itch.zip at the repo root, with
// index.html at the zip's root -- the layout itch.io's HTML5 uploads
// require. Run via `npm run build:itch` (builds first) or standalone
// after a build. See docs/ITCH_BUILD.md.
//
// Uses Node's built-in zlib/archiving primitives via a tiny manual ZIP
// writer would be overkill; instead we shell out to Python's zipfile
// module, which is present in this container and on most CI images, so
// we don't take on an npm dependency just for zipping a handful of files.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'packages', 'app', 'dist-itch');
const zipPath = join(repoRoot, 'dist-itch.zip');

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(
    `Missing ${join(distDir, 'index.html')}. Run "npm run build:itch -w @bash-fighter/app" first.`,
  );
  process.exit(1);
}

if (existsSync(zipPath)) rmSync(zipPath);

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const files = listFiles(distDir).map((f) => relative(distDir, f));

const script = `
import zipfile, sys, os
dist_dir = sys.argv[1]
zip_path = sys.argv[2]
files = sys.argv[3:]
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for f in files:
        zf.write(os.path.join(dist_dir, f), f)
`;

execFileSync('python3', ['-c', script, distDir, zipPath, ...files], { stdio: 'inherit' });

console.log(`Wrote ${zipPath} (${files.length} files)`);
