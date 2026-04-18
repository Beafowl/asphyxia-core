#!/usr/bin/env node
// Sync plugins/ into dist/plugins/ for `npm run dev`.
//
// The asphyxia launcher loads plugins from `<cwd>/plugins/`, and `npm run dev`
// starts node with cwd=dist/. tsc doesn't touch the plugins tree, so without
// this step edits to plugins/ don't take effect on the next dev run — a
// stale hand-copied dist/plugins/ persists and drifts indefinitely.
//
// Skips .git and node_modules so each plugin's own git working tree isn't
// duplicated into dist (and so in-use git pack files don't block the copy).

const fs   = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const src  = path.join(repoRoot, 'plugins');
const dest = path.join(repoRoot, 'dist', 'plugins');

const SKIP_NAMES = new Set(['.git', 'node_modules']);

if (!fs.existsSync(src)) {
  console.error(`sync-plugins: source does not exist: ${src}`);
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });

try {
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (srcPath) => !SKIP_NAMES.has(path.basename(srcPath)),
  });
  console.log(`sync-plugins: copied ${src} -> ${dest}`);
} catch (err) {
  console.error(`sync-plugins failed: ${err.message}`);
  process.exit(1);
}
