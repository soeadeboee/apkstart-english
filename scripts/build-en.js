#!/usr/bin/env node
/*
 * ApkStart English build tool
 * ------------------------------------------------------------------
 * Applies the English catalogs in ../locales/*.tsv to an ApkStart
 * "resources/app" source tree and writes an English tree.
 *
 * Usage:
 *   node build-en.js --src "C:\path\to\ApkStart\resources\app" --out .\build\app
 *   node build-en.js --src ... --out ... --no-fixes     (catalog only, for reviewing)
 *
 * The catalogs are plain TSV:  <Chinese source string>\t<English text>
 * Placeholders like ${...} are preserved verbatim; a row is skipped with a
 * warning when the placeholder count does not match.
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const LOCALES = path.join(HERE, '..', 'locales');
const FIXES = path.join(LOCALES, 'fixes.tsv');

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

// Split text into plain text and ${...} placeholders (balanced braces, quote aware).
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

// Make literal text safe inside '...', "..." and `...` without touching placeholders.
function sanitize(text) {
  return splitPlaceholders(text).map((p) => {
    if (p.t === 'ph') return p.v;
    let s = p.v.replace(/'/g, '\u2019');
    let open = true;
    s = s.replace(/"/g, () => { open = !open; return open ? '\u201d' : '\u201c'; });
    return s;
  }).join('');
}

// Ranges of regex literals, so error-matching patterns stay untouched.
function regexRanges(src) {
  const ranges = [];
  let i = 0, prevSig = '';
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '`') {
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') { i++; break; }
        i++;
      }
      prevSig = '`'; continue;
    }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      prevSig = q; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === '/') {
      const allowed = !prevSig || '(,=:[!&|?{};+-*%<>~^'.includes(prevSig) ||
        /^(return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)$/.test(prevSig);
      if (allowed) {
        const start = i;
        let j = i + 1, inClass = false;
        while (j < n) {
          const d = src[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '\n') break;
          if (d === '[') inClass = true; else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          j++;
        }
        let k = j + 1;
        while (k < n && /[a-z]/i.test(src[k])) k++;
        ranges.push([start, k]);
        i = k; prevSig = '/'; continue;
      }
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return ranges;
}

function replaceOutsideRegex(text, raw, val, isJs) {
  if (!isJs) return { text: text.split(raw).join(val), count: text.split(raw).length - 1 };
  const ranges = regexRanges(text);
  if (!ranges.length) return { text: text.split(raw).join(val), count: text.split(raw).length - 1 };
  const segs = [];
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a > pos) segs.push({ t: 'code', v: text.slice(pos, a) });
    segs.push({ t: 'skip', v: text.slice(a, b) });
    pos = b;
  }
  segs.push({ t: 'code', v: text.slice(pos) });
  let count = 0;
  const out = segs.map((s) => {
    if (s.t === 'skip') return s.v;
    const c = s.v.split(raw).length - 1;
    count += c;
    return s.v.split(raw).join(val);
  }).join('');
  return { text: out, count };
}

// A TSV row is one line, so real newlines are stored as the token <NL>.
const decodeNl = (s) => s.replace(/<NL>/g, '\n');

// Escapes allowed in fixes.tsv: \n newline, \t tab, \\ backslash.
function unescapeFix(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[i + 1];
    if (n === 'n') { out += '\n'; i++; }
    else if (n === 't') { out += '\t'; i++; }
    else if (n === '\\') { out += '\\'; i++; }
    else out += c;
  }
  return out;
}

function loadTsv(file) {
  const rows = [];
  if (!fs.existsSync(file)) return rows;
  const txt = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const zh = decodeNl(line.slice(0, tab));
    const en = decodeNl(line.slice(tab + 1));
    if (zh && en) rows.push({ zh, en });
  }
  return rows;
}

// Strip comments so the leftover report only counts user-visible strings.
function stripComments(line) {
  const s = line.trim();
  if (/^(\/\/|\*|\/\*|<!--|#[^!])/.test(s)) return '';
  return line
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/, '');
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.src || !args.out) {
    console.error('usage: node build-en.js --src <ApkStart resources/app> --out <output dir> [--no-fixes]');
    process.exit(2);
  }
  const SRC = path.resolve(args.src);
  const OUT = path.resolve(args.out);
  if (!fs.existsSync(path.join(SRC, 'src', 'main.js'))) {
    console.error(`error: ${SRC} does not look like ApkStart's resources/app (src/main.js missing)`);
    process.exit(2);
  }

  // ---- catalogs
  const rows = [];
  for (const f of ['ui.tsv', 'main.tsv', 'core.tsv']) rows.push(...loadTsv(path.join(LOCALES, f)));
  const map = new Map();
  let skipped = 0;
  for (const r of rows) {
    if (countPh(r.zh) !== countPh(r.en)) { skipped++; continue; }
    map.set(r.zh, r.en);
  }
  const pairs = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
  console.log(`catalogs: ${map.size} entries (${skipped} skipped, placeholder mismatch)`);

  // ---- copy tree, translating code files
  fs.rmSync(OUT, { recursive: true, force: true });
  let translated = 0;
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const isCode = /\.(js|html)$/i.test(file) || rel.startsWith(`src${path.sep}drivers${path.sep}`) && /\.json$/i.test(file);
    if (!isCode || rel.startsWith('..')) { fs.copyFileSync(file, dest); continue; }

    const isJs = /\.js$/i.test(file);
    let text = fs.readFileSync(file, 'utf8');
    for (const [zh, en] of pairs) {
      if (!text.includes(zh)) continue;
      let val = sanitize(en);
      if (zh.includes('\n')) val = val.replace(/\\n/g, '\n');
      const r = replaceOutsideRegex(text, zh, val, isJs);
      text = r.text; translated += r.count;
    }
    fs.writeFileSync(dest, text, 'utf8');
  }
  console.log(`catalog replacements: ${translated}`);

  // ---- manual fixes (version specific quirks, plural forms, locale attributes)
  if (!args['no-fixes'] && fs.existsSync(FIXES)) {
    const txt = fs.readFileSync(FIXES, 'utf8').replace(/\r/g, '');
    let fixed = 0;
    const missing = [];
    for (const line of txt.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const from = unescapeFix(line.slice(0, tab));
      const to = unescapeFix(line.slice(tab + 1));
      let hits = 0;
      for (const file of walk(OUT)) {
        if (!/\.(js|html|ps1)$/i.test(file)) continue;
        const t = fs.readFileSync(file, 'utf8');
        if (!t.includes(from)) continue;
        hits += t.split(from).length - 1;
        fs.writeFileSync(file, t.split(from).join(to), 'utf8');
      }
      if (hits === 0) missing.push(from.slice(0, 80));
      fixed += hits;
    }
    console.log(`manual fixes applied: ${fixed}`);
    if (missing.length) {
      console.log(`fixes with no match: ${missing.length}`);
      for (const m of missing) console.log(`  ${m}`);
    }
  }

  // ---- leftover report: Chinese that is not inside a comment or a regex literal
  // (regexes keep Chinese on purpose: they match error output of localized tools)
  const remaining = [];
  for (const file of walk(OUT)) {
    if (!/\.(js|html)$/i.test(file)) continue;
    const rel = path.relative(OUT, file).replace(/\\/g, '/');
    const original = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
    let scan = original.slice();
    if (/\.js$/i.test(file)) {
      const text = original.join('\n');
      const ranges = regexRanges(text);
      if (ranges.length) {
        const chars = text.split('');
        for (const [a, b] of ranges) for (let i = a; i < b; i++) chars[i] = ' ';
        scan = chars.join('').split('\n');
      }
    }
    scan.forEach((line, i) => {
      if (/[\u4e00-\u9fff]/.test(stripComments(line))) remaining.push(`${rel}: ${original[i].trim().slice(0, 120)}`);
    });
  }

  // ---- report
  const reportFile = path.join(path.dirname(OUT), 'i18n-report.json');
  fs.writeFileSync(reportFile, JSON.stringify({
    source: SRC,
    entries: map.size,
    replacements: translated,
    chineseLeftOutsideComments: remaining,
  }, null, 1), 'utf8');
  console.log(`leftover Chinese lines outside comments: ${remaining.length} (see ${reportFile})`);
  console.log(`output: ${OUT}`);
}

main();
