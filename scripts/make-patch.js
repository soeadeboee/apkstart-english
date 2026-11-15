#!/usr/bin/env node
/*
 * Build patch/app + patch/manifest.json.
 *
 *   node scripts/make-patch.js --src "C:\path\to\ApkStart\resources\app" --built build\app
 *
 * --src   pristine v0.4.3 tree (used for upstream hashes)
 * --built tree produced by scripts/build-en.js
 *
 * Only files whose bytes differ from upstream are shipped in patch/app, so the
 * patch stays small and the installer can tell "pristine" from "translated".
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const REPO = path.join(HERE, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    }
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = (base, f) => path.relative(base, f).replace(/\\/g, '/');

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.src || !args.built) {
    console.error('usage: node make-patch.js --src <pristine resources/app> --built <translated tree>');
    process.exit(2);
  }
  const SRC = path.resolve(args.src);
  const BUILT = path.resolve(args.built);
  const PATCH = path.join(REPO, 'patch');
  const APP = path.join(PATCH, 'app');

  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
  const files = {};
  const shipped = [];

  for (const f of walk(BUILT)) {
    const r = rel(BUILT, f);
    const upstream = path.join(SRC, r);
    if (!fs.existsSync(upstream)) continue;
    const up = sha256(upstream);
    const en = sha256(f);
    if (up === en) continue;
    const dest = path.join(APP, r);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
    files[r] = { upstream: up, english: en, size: fs.statSync(f).size };
    shipped.push(r);
  }

  let catalog = {};
  const reportFile = path.join(path.dirname(BUILT), 'i18n-report.json');
  if (fs.existsSync(reportFile)) {
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    catalog = { entries: report.entries, replacements: report.replacements };
  }

  const manifest = {
    name: 'apkstart-english',
    upstream: {
      repo: 'https://github.com/RoutineMiku/apkstart',
      tag: `v${pkg.version}`,
      version: pkg.version,
    },
    builtWith: 'scripts/build-en.js',
    catalog,
    files,
  };
  fs.mkdirSync(PATCH, { recursive: true });
  fs.writeFileSync(path.join(PATCH, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`patched files: ${shipped.length}`);
  console.log(`manifest: ${path.join(PATCH, 'manifest.json')}`);
}

main();
