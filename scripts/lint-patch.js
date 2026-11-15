#!/usr/bin/env node
/*
 * Lint the patch without needing the upstream sources (used by CI).
 *
 *   node scripts/lint-patch.js
 *
 * Checks:
 *  - every .js in patch/app parses
 *  - locales/*.tsv rows are well formed, no duplicate keys, balanced ${...}
 *  - English values contain no Chinese
 *  - patch/manifest.json lists exactly the files present in patch/app
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PATCH = path.join(REPO, 'patch');
const LOCALES = path.join(REPO, 'locales');
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const errors = [];
const warnings = [];

function splitPlaceholders(text) {
  const parts = [];
  let i = 0, lit = '';
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      if (lit) { parts.push({ t: 'lit', v: lit }); lit = ''; }
      const start = i;
      i += 2;
      let depth = 1, quote = null;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (quote) {
          if (c === '\\') { i += 2; continue; }
          if (c === quote) quote = null;
          i++; continue;
        }
        if (c === "'" || c === '"' || c === '`') { quote = c; i++; continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      parts.push({ t: 'ph', v: text.slice(start, i) });
      continue;
    }
    lit += text[i];
    i++;
  }
  if (lit) parts.push({ t: 'lit', v: lit });
  return parts;
}
const countPh = (t) => splitPlaceholders(t).filter((p) => p.t === 'ph').length;
const decode = (s) => s.replace(/<NL>/g, '\n');

// ---------------------------------------------------------------- JS syntax
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}

let jsFiles = 0;
for (const f of walk(path.join(PATCH, 'app'))) {
  if (!/\.js$/i.test(f)) continue;
  jsFiles++;
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    errors.push(`syntax error in ${path.relative(REPO, f)}: ${(e.stderr || '').toString().split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------- catalogs
const seen = new Map();
let rows = 0;
for (const name of ['ui.tsv', 'main.tsv', 'core.tsv', 'fixes.tsv']) {
  const file = path.join(LOCALES, name);
  if (!fs.existsSync(file)) {
    errors.push(`missing catalog: locales/${name}`);
    continue;
  }
  const txt = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  let lineNo = 0;
  for (const line of txt.split('\n')) {
    lineNo++;
    if (!line.trim() || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) {
      errors.push(`locales/${name}:${lineNo}: no tab separator`);
      continue;
    }
    const zh = decode(line.slice(0, tab));
    const en = decode(line.slice(tab + 1));
    if (!zh.trim() || !en.trim()) {
      errors.push(`locales/${name}:${lineNo}: empty side`);
      continue;
    }
    // fixes.tsv holds code fragments: mixed Chinese/English and extra
    // placeholders (plural ternaries) are expected there.
    if (name === 'fixes.tsv') continue;
    if (countPh(zh) !== countPh(en)) {
      errors.push(`locales/${name}:${lineNo}: placeholder count ${countPh(zh)} vs ${countPh(en)}: ${zh.slice(0, 60)}`);
    }
    if (CJK.test(en)) {
      errors.push(`locales/${name}:${lineNo}: English text still contains Chinese: ${en.slice(0, 60)}`);
    }
    {
      const key = zh;
      if (seen.has(key)) {
        errors.push(`locales/${name}:${lineNo}: duplicate key also in ${seen.get(key)}: ${zh.slice(0, 60)}`);
      } else {
        seen.set(key, `locales/${name}:${lineNo}`);
      }
      rows++;
    }
  }
}

// ---------------------------------------------------------------- manifest
const manifestFile = path.join(PATCH, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const listed = new Set(Object.keys(manifest.files));
let onDisk = 0;
for (const f of walk(path.join(PATCH, 'app'))) {
  const rel = path.relative(path.join(PATCH, 'app'), f).replace(/\\/g, '/');
  onDisk++;
  if (!listed.has(rel)) errors.push(`not in manifest: ${rel}`);
  else {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    if (hash !== manifest.files[rel].english) errors.push(`hash mismatch: ${rel}`);
  }
}
for (const rel of listed) {
  if (!fs.existsSync(path.join(PATCH, 'app', rel))) errors.push(`manifest lists a missing file: ${rel}`);
}

// ---------------------------------------------------------------- report
console.log(`js files checked: ${jsFiles}`);
console.log(`catalog rows: ${rows} (fixes.tsv excluded)`);
console.log(`patch files: ${onDisk}`);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\nok: patch and catalogs are consistent');
