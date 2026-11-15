# Contributing

Thanks for helping! There are three useful kinds of contributions.

## 1. Report or fix a translation

Open an issue with:

- the window or situation (for example "Settings → Performance & resources"),
- the English text you saw,
- what it should say.

To fix it yourself:

1. Edit the matching row in `locales/ui.tsv`, `locales/main.tsv` or `locales/core.tsv`
   (first column = Chinese source, second column = English).
2. Rebuild and check:

```powershell
node scripts\build-en.js --src "C:\path\to\pristine\resources\app" --out build\app
node scripts\make-patch.js --src "C:\path\to\pristine\resources\app" --built build\app
node scripts\lint-patch.js
```

Rules for catalog rows:

- Keep every `${...}` placeholder exactly as it is; do not translate variable names.
- Never put Chinese in the English column (CI fails on it).
- A real newline in the source string is written as `<NL>`; a tab is not allowed.
- Do not edit `patch/app` by hand: it is generated from the catalogs.
- If a string cannot be expressed as a plain replacement (mixed Chinese/English,
  plural forms, `<html lang>`), add a row to `locales/fixes.tsv` instead.

## 2. Updating to a new upstream release

The patch is pinned to one upstream version on purpose: the installer verifies
SHA-256 hashes before touching anything.

1. Download the new official portable build and extract `resources\app`.
2. Apply the existing catalogs:

   ```powershell
   node scripts\build-en.js --src "C:\path\to\new\resources\app" --out build\app
   ```

3. Read `build\i18n-report.json`. Every entry in `chineseLeftOutsideComments`
   is a new or changed string that still needs a translation. Add it to the right
   catalog. Also check strings whose meaning changed but which still match an old
   line.
4. Regenerate the patch and verify:

   ```powershell
   node scripts\make-patch.js --src "C:\path\to\new\resources\app" --built build\app
   node scripts\verify-patch.js --src "C:\path\to\new\resources\app"
   ```

5. Run the app in English (`--smoke` screenshots are enough) and check the main
   window plus Settings.
6. Commit, then publish a release named `<upstream version>-en.1` with the rebuilt
   portable zip attached.

A scheduled workflow (`.github/workflows/upstream-watch.yml`) opens an issue when
a new upstream release appears, so this checklist does not get forgotten.

## 3. Upstream contributions

The upstream project requires Chinese UI text and Chinese comments
(`CONTRIBUTING.md` upstream), so a 35-file English patch cannot be merged as is.

The compatible route is a **build-time locale catalog**:

- keep every Chinese string and comment unchanged,
- add an opt-in catalog (for example `locales/en.tsv`) plus a small script that
  writes a translated build,
- document `npm run build:en` in the README.

If you want to pursue this, open a discussion/issue upstream first with a
screenshot and the rebuild command, and keep the PR small. Do not rename the
product or present the translation as official.

## Code of conduct

Be polite, assume good faith, and keep discussions about the translation, not the
people using it. The upstream author is not responsible for this repository.
