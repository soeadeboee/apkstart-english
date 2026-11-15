#!/usr/bin/env node
/*
 * Verify that patch/app matches patch/manifest.json.
 *
 *   node scripts/verify-patch.js
 *   node scripts/verify-patch.js --src "C:\path\to\ApkStart\resources\app"
 *
 * With --src the pristine upstream hashes are checked too, which proves the
 * patch was generated from stock v0.4.3 sources.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const PATCH = path.join(REPO, 'patch');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(fs.readFileSync(path.join(PATCH, 'manifest.json'), 'utf8'));
let bad = 0;

for (const [rel, info] of Object.entries(manifest.files)) {
  const en = path.join(PATCH, 'app', rel);
  if (!fs.existsSync(en)) {
    console.error(`missing: ${rel}`);
    bad++;
  } else if (sha256(en) !== info.english) {
    console.error(`english hash mismatch: ${rel}`);
    bad++;
  }
  if (args.src) {
    const up = path.join(path.resolve(args.src), rel);
    if (!fs.existsSync(up)) {
      console.error(`missing upstream file: ${rel}`);
      bad++;
    } else if (sha256(up) !== info.upstream) {
      console.error(`upstream hash mismatch: ${rel}`);
      bad++;
    }
  }
}

if (bad) {
  console.error(`\n${bad} problem(s) found`);
  process.exit(1);
}
console.log(`ok: ${Object.keys(manifest.files).length} patched files verified`);
