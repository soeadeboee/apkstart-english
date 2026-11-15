'use strict';
/**
 * Clean old version leftovers。
 *
 * 用户升级 ApkStart 常出现「装过好几个版本、Uninstall不干净」：便携版每换一次版本就多一个
 * ApkStart-vX.Y.Z-win64-portable 目录；NSIS 安装版升级后可能留下指向已删除目录的
 * Uninstall项；更新过程还会在数据目录里留下一堆临时包。
 *
 * 这里只做**可证明安全**的清理：
 *   - 只认「目录里确实有 ApkStart.exe」的旧版本目录，且绝不碰当前Running的那个；
 *   - 只删除「InstallLocation 已经不存在」的注册表Uninstall项（那个本来就已经是死条目）；
 *   - 只删自己更新缓存里的临时文件与指向不存在目标的开始菜单/桌面快捷方式。
 * 任何一步拿不准就跳过，并把原因如实返回给界面。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = 'ApkStart.exe';

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      } catch (_) { /* 占用/无权限，跳过 */ }
    }
  };
  walk(p);
  return n;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

/** 在若干「可能放程序的」目录里找旧版本目录 */
function candidateRoots(installDir) {
  const roots = new Set();
  const parent = path.dirname(installDir);
  if (parent) roots.add(parent);
  const local = process.env.LOCALAPPDATA;
  if (local) roots.add(path.join(local, 'Programs'));
  const pf = process.env.ProgramFiles;
  if (pf) roots.add(pf);
  return [...roots];
}

/** 旧版本程序目录：形如 ApkStart*，且里面有 ApkStart.exe，且不是当前安装目录 */
function scanDirs(installDir) {
  const out = [];
  const cur = norm(installDir);
  for (const root of candidateRoots(installDir)) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (!/^ApkStart/i.test(e.name)) continue;
      const full = path.join(root, e.name);
      if (norm(full) === cur) continue;
      // 必须是「真的是 ApkStart」的目录，避免误删同名文件夹
      if (!fs.existsSync(path.join(full, EXE))) continue;
      out.push({
        kind: 'dir',
        path: full,
        size: dirSize(full),
        note: 'old program folder (contains ' + EXE + '）',
      });
    }
  }
  return out;
}

/** 注册表里指向已不存在目录的Uninstall项 */
function scanRegistry() {
  const out = [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'ApkStart', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    } catch (_) { continue; }
    // reg query 输出是分块的「键 → 值」，这里按块切
    const blocks = String(text).split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
      if (!key) continue;
      if (!/\\ApkStart/i.test(key)) continue;
      const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const install = (loc || '').trim().replace(/^"|"$/g, '');
      const uninsPath = (unins || '').trim().replace(/^"|"$/g, '');
      const installMissing = install ? !fs.existsSync(install) : false;
      // 只处理「明明已经没装、却还挂在App列表里」的死条目
      const deadUninstaller = uninsPath && !fs.existsSync(uninsPath.split('"')[0]);
      if (!installMissing && !deadUninstaller) continue;
      out.push({
        kind: 'registry',
        path: key,
        size: 0,
        note: `stale uninstall entry${disp ? `: ${String(disp).trim()}` : ''}`,
      });
    }
  }
  return out;
}

/** 更新缓存 / 临时包 */
function scanTemp(dataDir) {
  const out = [];
  const dirs = [path.join(dataDir, 'update'), os.tmpdir()];
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const name = e.name;
      const isOurs = /^ApkStart.*\.(zip|exe|part\d*|tmp)$/i.test(name)
        || /^ApkStart-.*\.part\d+$/i.test(name);
      if (!isOurs) continue;
      const full = path.join(d, name);
      let size = 0;
      try { size = e.isDirectory() ? dirSize(full) : fs.statSync(full).size; } catch (_) { /* ignore */ }
      out.push({ kind: 'temp', path: full, size, note: 'temporary update download files' });
    }
  }
  return out;
}

/** 旧/废弃的快速启动快照：default_boot 是早期版本留下的（一份 ram.img 约 3GB），
 *  *.stale-* 是「删不掉就改名」的残留。当前快照名是 apkstart，绝不碰。 */
function scanSnapshots(avdHome) {
  const out = [];
  if (!avdHome) return out;
  const snapDir = path.join(avdHome, 'apkstart.avd', 'snapshots');
  let list = [];
  try { list = fs.readdirSync(snapDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === 'apkstart') continue;   // 当前在用的快照
    const full = path.join(snapDir, e.name);
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: e.name.startsWith('default_boot') ? 'quick-boot snapshots left by an older version' : 'abandoned snapshot leftovers',
    });
  }
  return out;
}

function scan({ installDir, dataDir, avdHome }) {
  const items = [];
  const push = (list) => { for (const x of list) items.push(x); };
  push(scanDirs(installDir));
  push(scanRegistry());
  push(scanTemp(dataDir));
  push(scanSnapshots(avdHome));
  const total = items.reduce((n, x) => n + (x.size || 0), 0);
  return { items, totalBytes: total };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir }) {
  const cur = norm(installDir);
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        // 双保险：绝不删当前Running的目录
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: 'this is the running version' }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: 'the folder has no ' + EXE }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'file in use (a window may still be open)' });
      } else if (it.kind === 'registry') {
        const r = execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        void r;
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'file in use' });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: 'delete failed' });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
