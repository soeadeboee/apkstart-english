# Changelog

## v0.5.8-en.1 — 2026-11-18

Rebuilt for ApkStart **v0.5.8**, which added a "This PC checkup" auto-config
section, JSON compatibility drivers (plus three built-in examples), a resource
allocation panel with data-partition expansion, and new pkgname / geometry
modules. The MuMu and FydeOS backends were removed upstream.

**Translation**

- 242 new strings translated for v0.5.8 (232 outstanding literals + 10 built-in
  driver strings); the catalogs now hold 1,507 rows.
- 6,780 replacements across 52 files, plus 9 version-specific fixes.
- New coverage: checkup report items / recommendations / one-click fixes, driver
  list / import / export template and every driver validation message, data
  partition sizing and expansion hints, resource allocation notes, and the three
  example driver JSON files under `src/drivers/`.
- Plural forms fixed (`1 item` / `2 items`, `1 driver` / `2 drivers`, `1 file` /
  `2 files`); the packaged `VERSION.txt` is translated too.
- 0 Chinese characters left outside code comments and regex literals; 0 glued
  fragments.

**Tooling**

- `scripts/build-en.js` now also translates `src/drivers/*.json` (built-in
  example drivers), not just `.js` and `.html`.
- `install-en.ps1` verifies stock v0.5.8 SHA-256 hashes (52 files).
- Release asset: `ApkStart-v0.5.8-win64-portable-en.zip`, the official portable
  build with translated `resources/app` files.

**Verified**

- Rebuilding from the pristine v0.5.8 sources reproduces the shipped English files
  byte for byte (52/52 files).
- `node --check` passes on every translated `.js` file; `lint-patch.js` is clean.
- Smoke screenshots of the main window, every Settings section, the checkup
  report and the driver list show English throughout.

## v0.5.3-en.1 — 2026-11-17

Rebuilt for ApkStart **v0.5.3**, which replaced the single runtime with pluggable
backends (built-in QEMU, MuMu, FydeOS, attach-to-existing) and added key mapping.

**Translation**

- 249 new strings translated for v0.5.3; the catalogs now hold 1,273 rows.
- 6,242 replacements across 46 files, plus 11 version-specific fixes.
- New coverage: runtime backend picker, per-backend setup hints and checks,
  environment self-check panel, keyboard/gamepad key mapping, first-run setup
  guide, splash screen, lightweight container and data-partition growth.
- 0 Chinese characters left outside code comments and regex literals; 0 glued
  fragments where a short key and the next word ran together.

**Tooling**

- Catalogs keep the raw-Chinese-keyed TSV format; whole-sentence keys were
  extracted with an AST pass over the v0.5.3 sources so sentences stay natural.
- `install-en.ps1` now verifies stock v0.5.3 SHA-256 hashes (46 files).
- Release asset: `ApkStart-v0.5.3-win64-portable-en.zip`, the official portable
  build with translated `resources/app` files.

**Verified**

- Rebuilding from the pristine v0.5.3 sources reproduces the shipped English files
  byte for byte (46/46 files).
- `node --check` passes on every translated `.js` file; `lint-patch.js` is clean.
- Smoke screenshots of the main window and every Settings section show English
  throughout.

## v0.4.3-en.1 — 2026-11-15

First release, based on ApkStart **v0.4.3**.

**Translation**

- 1,024 Chinese source strings translated to English (2,315 replacements in 35 files).
- Covered: main window, all Settings tabs, tray menu, in-app toasts, confirm dialogs,
  Windows notifications, install/launch/uninstall flows, environment check, runtime
  diagnostics and hints, diagnostic report, updater, cleanup, networking repair,
  file sharing and shortcut modules.
- Locale details: `<html lang="en">`, `en-US` dates, `en` name sorting, English VC++
  download page.

**Tooling**

- `install-en.ps1` — auto-detects the install, verifies stock v0.4.3 SHA-256 hashes,
  backs up, applies, and supports `-Restore`.
- `restore-zh.ps1` — restore the original Chinese files.
- `scripts/build-en.js` — applies `locales/*.tsv` + `locales/fixes.tsv` to a pristine
  source tree; reports any Chinese left outside comments and regex literals.
- `scripts/make-patch.js` / `scripts/verify-patch.js` — build and check
  `patch/app` + `patch/manifest.json`.
- Release asset: `ApkStart-v0.4.3-win64-portable-en.zip`, the official portable build
  with translated `resources/app` files.

**Verified**

- Rebuilding from the pristine v0.4.3 sources reproduces the shipped English files
  byte for byte (35/35 files, 0 bytes of difference).
- `node --check` passes on every translated `.js` file.
- Smoke screenshots of the main window and Settings show English throughout.
