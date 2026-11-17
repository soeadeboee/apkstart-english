# Changelog

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
