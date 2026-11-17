# Publishing notes

Everything below is for the repo owner; users only need the README.

## Suggested repository settings

- **Name:** `apkstart-english`
- **Description:** `English UI patch + portable build for ApkStart v0.5.3 (Windows APK runner)`
- **Topics:** `apkstart`, `android`, `apk`, `windows`, `english`, `translation`, `portable`, `emulator`
- **License:** MIT
- **Website:** leave empty, or point at the upstream project

## What to upload

Upload the contents of this folder (not the folder itself):

```
README.md  README.id.md  LICENSE  NOTICE.md  CHANGELOG.md  CONTRIBUTING.md
install-en.ps1  restore-zh.ps1
locales/  scripts/  patch/  docs/  .github/
.gitignore  .gitattributes
```

`build/` and `dist/` are generated and ignored by git. Do **not** commit them.

## Release

1. Tag: `v0.5.3-en.1`
2. Title: `ApkStart v0.5.3 — English UI`
3. Attach the release asset: `dist/ApkStart-v0.5.3-win64-portable-en.zip`
4. Paste the release notes from `CHANGELOG.md`.

## Pushing with git

```powershell
git init
git add .
git commit -m "feat: English UI for ApkStart v0.5.3"
git branch -M main
git remote add origin https://github.com/<user>/apkstart-english.git
git push -u origin main
```

The repository can be created beforehand on github.com (empty, no README), or with
`gh repo create apkstart-english --public --source . --push` if GitHub CLI is installed.
