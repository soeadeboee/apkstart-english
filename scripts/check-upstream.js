#!/usr/bin/env node
/*
 * Compare the pinned upstream version with the latest ApkStart release.
 *
 *   node scripts/check-upstream.js           human readable
 *   node scripts/check-upstream.js --json    machine readable
 *
 * Exit code 0 when the patch is up to date, 3 when a newer upstream release
 * exists, 1 on network/API errors.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'patch', 'manifest.json'), 'utf8'));
const current = manifest.upstream.tag;
const API = 'https://api.github.com/repos/RoutineMiku/apkstart/releases/latest';

async function main() {
  const headers = { 'User-Agent': 'apkstart-english', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(API, { headers });
  if (!res.ok) {
    console.error(`GitHub API returned HTTP ${res.status}`);
    process.exit(1);
  }
  const release = await res.json();
  const latest = release.tag_name;
  const upToDate = latest === current;

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ current, latest, upToDate, url: release.html_url }, null, 2));
  } else if (upToDate) {
    console.log(`up to date: patch targets ${current}, upstream latest is ${latest}`);
  } else {
    console.log(`upstream released ${latest}, but the patch targets ${current}.`);
    console.log(`release notes: ${release.html_url}`);
    console.log('Rebuild steps: see CONTRIBUTING.md ("Updating to a new upstream release").');
  }
  process.exit(upToDate ? 0 : 3);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
