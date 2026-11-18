# NOTICE

## Upstream project

ApkStart — a Windows launcher for Android APKs
Copyright (c) 2026 ApkStart contributors
Licensed under the MIT License.
<https://github.com/RoutineMiku/apkstart>

This repository is an **unofficial English translation** of ApkStart v0.5.8. It is
not affiliated with, endorsed by, or supported by the upstream author.

## What this repository contains

- `patch/app/` — modified copies of 52 files from ApkStart v0.5.8. Only user-facing
  Chinese strings were changed; program logic, identifiers and comments are
  untouched. Every file's upstream and English SHA-256 is recorded in
  `patch/manifest.json`.
- `locales/` — translation catalogs written for this project.
- `scripts/`, `install-en.ps1`, `restore-zh.ps1` — original tooling, MIT licensed.

The MIT license and copyright notice of the upstream project apply to the files in
`patch/app/`, and are reproduced in `LICENSE`.

## What this repository does NOT contain

No Android system images, emulator or QEMU binaries, adb platform-tools, or Google
components are distributed here. ApkStart downloads those from their respective
vendors at runtime, on the user's machine, exactly like the official build.

## Trademarks

Android and Google Play are trademarks of Google LLC. Windows is a trademark of
Microsoft Corporation. Any other names are the property of their respective owners.
