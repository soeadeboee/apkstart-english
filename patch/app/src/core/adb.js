'use strict';
/**
 * adb 客户端封装
 * 只做 apkstart 需要的那部分: 安装 / 启动 / 停止 / Uninstall / 文件同步 / 截图
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

/**
 * Tablet layout的逻辑密度。
 * 720 宽 ÷ (190/160) = 606dp ≥ 600dp，正好越过 Android 的平板断点; 
 * 320dpi (镜像默认)只有 360dp，是手机排版。
 */
const TABLET_DENSITY = 190;
function tabletDensity() {
  try {
    return (store.getSettings().display || {}).tabletMode !== false ? String(TABLET_DENSITY) : 'reset';
  } catch (_) {
    return String(TABLET_DENSITY);
  }
}

/**
 * 系统里可能存在的 adb 位置。**故意只列 Android SDK 与常见手动安装目录**: 
 * 第三方模拟器自带的 adb (MuMu / 雷电 / 蓝叠)不在这里 —— 用它们的 adb 会连带
 * 继承别人的 server 状态 (端口, 授权, offline 抖动)，与「独立运行」冲突。
 * 自己那份 adb 在Runtime目录里，优先级永远最高 (见 engine.adbPath)。
 */
const COMMON_ADB_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:/Android/platform-tools/adb.exe',
  'C:/adb/adb.exe',
];

/**
 * 把 pm install 的原始失败原因翻译成用户能看懂的中文。
 * 保留原始错误码在末尾，便于搜索排查。
 */
function friendlyInstallError(raw) {
  const code = /INSTALL_[A-Z_]+/.exec(raw);
  const tag = code ? code[0] : '';
  const table = {
    INSTALL_FAILED_NO_MATCHING_ABIS:
      'Installation failed: this app only ships ARM native libraries (common for Chinese apps),'
      + 'the current system image has no ARM translation layer. ApkStart switches to the compatible image with a newer built-in translator and retries.',
    INSTALL_FAILED_OLDER_SDK:
      'Installation failed: the app requires a newer Android version than this runtime provides (a newer system image is needed).',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES:
      'Installation failed: the APK has no valid signature, so it cannot be installed.',
    INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES:
      'Installation failed: signature differs from the installed version; uninstall the old one first.',
    INSTALL_FAILED_VERSION_DOWNGRADE:
      'Installation failed: a newer version is already installed; downgrades are not allowed.',
    INSTALL_FAILED_INSUFFICIENT_STORAGE:
      'Installation failed: not enough disk space in the runtime; free some space and retry.',
    INSTALL_FAILED_INVALID_APK:
      'Installation failed: the APK is corrupt or incomplete (the download may not have finished); get it again.',
    INSTALL_FAILED_INVALID_URI: 'Installation failed: the APK path contains special characters; move the file to a plain ASCII path and retry.',
    INSTALL_FAILED_ALREADY_EXISTS: 'Installation failed: an app with the same name exists with a different signature; uninstall it first.',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Installation failed: signature differs from the installed version; uninstall the old one first.',
    INSTALL_FAILED_DEPRECATED_SDK_VERSION:
      'Installation failed: this app targets a very old Android version (targetSdk too low) and Android 14 blocks it by default.'
      + 'ApkStart retries automatically with the official override flag.',
    INSTALL_FAILED_TEST_ONLY: 'Installation failed: this is a test-only package; retrying automatically with the test-package flag.',
    INSTALL_FAILED_MISSING_SHARED_LIBRARY: 'Installation failed: the app depends on device features (e.g. vendor libraries) that this runtime lacks.',
    INSTALL_FAILED_USER_RESTRICTION: 'Installation failed: the system blocked the install; restart the runtime and retry.',
    INSTALL_FAILED_CONFLICTING_PROVIDER: 'Installation failed: ContentProvider conflict with an existing app; uninstall the conflicting app.',
    INSTALL_FAILED_INTERNAL_ERROR: 'Installation failed: internal system error (often low storage or an unfinished boot); restart the runtime and retry.',
  };
  const msg = table[tag];
  return msg ? `${msg} (${tag})` : `Installation failed: ${raw}`;
}

/** 把启动后的崩溃logs翻译成能看懂的原因 */
function friendlyLaunchError(raw, pkg) {
  const t = String(raw || '');
  if (/DoBadTrampoline|libndk_translation|houdini|SIGABRT.*arm/i.test(t)) {
    return `${pkg || 'App'} crashed after launch: the ARM translator is incompatible with the app’s signal handling.`
      + 'ApkStart switches to the Android 14 compatible image and retries.';
  }
  if (/UnsatisfiedLinkError|dlopen failed|couldn't find "lib|\.so.*not found/i.test(t)) {
    return `${pkg || 'App'} crashed after launch: missing native device libraries (the app may only ship ARM builds).`
      + 'it switches to a compatible image with the ARM translator and retries.';
  }
  if (/ClassNotFoundException|NoClassDefFoundError|AndroidRuntime/i.test(t)) {
    return `${pkg || 'App'} crashes on launch (an internal app error, possibly the emulator environment or missing Google services).`;
  }
  if (/java\.lang\.SecurityException|Permission Denial/i.test(t)) {
    return `${pkg || 'App'} failed to start: the system rejected the request (permissions or signature).`;
  }
  return `${pkg || 'App'} did not start${t ? `: ${t.slice(0, 240)}` : ' (process is not alive)'}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 解析 `adb devices` 里某个 serial 的 state 列。
 * 关键: unauthorized 的设备在 `get-state` 里也会回报 'device'，只有 devices 列表的
 * state 列能区分 authorized / unauthorized / offline —— 开机Probe据此快速自愈。
 */
function parseDeviceState(text, serial) {
  const lines = String(text || '').split(/\r?\n/).slice(1);
  for (const line of lines) {
    const m = /^(\S+)\s+(unauthorized|offline|recovery|sideload|no\s+permissions|device)\b/i.exec(line.trim());
    if (!m) continue;
    if (serial && m[1] !== serial) continue;
    const st = m[2].toLowerCase().replace(/\s+/g, '');
    if (st === 'device') return 'device';
    if (st === 'unauthorized' || st === 'nopermissions') return 'unauthorized';
    return st; // offline / recovery / sideload
  }
  return 'no-device';
}

/** 从「允许 USB 调试」对话框未OK导致的 shell 报错里识别出 unauthorized */
function isUnauthorizedError(raw) {
  return /\bunauthorized\b|no permissions|confirm.*(allow|debug)/i.test(String(raw || ''));
}

/** 从 `pm path <pkg>` 的输出里取出每个 APK 的真实路径 */
function parsePmPaths(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /^package:/.test(l)).map((l) => l.slice(8).trim()).filter(Boolean);
}

/** 已解析过的启动入口 (adbPath|pkg → activity)，10 分钟有效 */
const LAUNCHER_CACHE = new Map();

/**
 * Windows 版 adb 对非 ASCII 路径处理不稳定 (中文用户名/中文下载目录很常见)。
 * 安装前把 APK 复制到纯 ASCII 的临时目录，装完即删。
 */
function stageApk(apkPath) {
  const p = String(apkPath || '');
  if (/^[\x20-\x7e]*$/.test(p) && p.length < 200) return { path: p, staged: false };
  const dir = path.join(os.tmpdir(), 'apkstart-install');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha1').update(p).digest('hex').slice(0, 12)}.apk`;
  const target = path.join(dir, name);
  fs.copyFileSync(p, target);
  return { path: target, staged: true };
}

function unstage(staged) {
  if (!staged) return;
  try { fs.rmSync(staged, { force: true }); } catch (_) { /* ignore */ }
}

/**
 * 把「Activity」拼成 am start -n 需要的完整组件。
 * 两种形式都要支持: 
 *   - 纯类名 (老版本 apps.json 存的是这种): `MainActivity` / `.MainActivity` → `<pkg>/<activity>`
 *   - 完整组件 (`cmd package resolve-activity` 的输出): `com.a.b/.Main` → 原样使用
 * 旧实现无条件拼 `${pkg}/${activity}`，遇到完整组件就变成 `pkg/pkg/class`，
 * am start 直接Cancel (result code=-92)，表现是「点图标只看到安卓桌面」。
 */
function componentArg(pkg, activity) {
  const a = String(activity || '').trim();
  if (!a) return '';
  if (a.includes('/')) return a;
  return `${pkg}/${a}`;
}

/** 从 `cmd package resolve-activity --brief` 的输出里取出属于 pkg 的组件 (容忍尾部空行/priority 行) */
function parseResolvedActivity(pkg, out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^([\w.]+)\/([.\w$]+)$/.exec(lines[i]);
    if (m && m[1] === pkg) return `${m[1]}/${m[2]}`;
  }
  return '';
}

/**
 * adb install 的超时上限本来固定 240s，但 2GB+ 的安装包在慢盘上
 * 「push + 安装 + dexopt」很容易超过 4 分钟: 一旦超时就会被当成Installation failed，
 * 用户看到的就是「Large包装了没反应/失败」。这里按包体放Large，上限 20 分钟。
 */
function installTimeoutMs(bytes) {
  const mb = Math.max(1, Number(bytes || 0) / 1048576);
  return Math.min(1200000, Math.max(240000, Math.round(60000 + mb * 120)));
}

class AdbError extends Error {
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * 解析 `find -exec stat -c '%Y|%s|%n'` 的输出。
 * 返回 null 表示输出不像 stat 结果 (设备不支持)。
 */
function parseStatList(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  for (const l of lines) {
    const m = /^(\d{9,})\|(\d+)\|(.+)$/.exec(l);
    if (!m) continue;
    const rel = m[3].replace(/^\.\//, '');
    if (!rel || rel.endsWith('/')) continue;
    rows.push({ rel, size: Number(m[2]), mtime: Number(m[1]) * 1000 });
  }
  // 有输出但一行都解析不出来 → 说明不是 stat 格式
  if (!rows.length) return null;
  return rows;
}

class AdbClient {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath || 'adb';
    this.serial = serial || '';
    this._input = null;        // 常驻 `adb shell` 进程
    this._inputSeq = 0;
    this._waiters = new Map(); // id -> { resolve, reject, timer, token }
  }

  static resolveAdb(explicit, appRoot) {
    const candidates = [
      explicit,
      appRoot && path.join(appRoot, 'tools', 'platform-tools', 'adb.exe'),
      ...COMMON_ADB_PATHS,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
    return 'adb'; // 交给 PATH
  }

  _args(args, withSerial = true) {
    const a = [];
    if (withSerial && this.serial) a.push('-s', this.serial);
    return a.concat(args);
  }

  _adbEnv() {
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044' };
    // Play 商店镜像会强制 ADB 授权: host 的 adb server 与 guest 的 adbd 必须用同一把
    // adbkey。官方做法是 adb/emulator 共用 %USERPROFILE%\.android\adbkey{,.pub}，
    // emulator 启动时把 adbkey.pub 烤进 guest 的 /data/misc/adb/adb_keys。
    // 显式告诉 adb server 去哪里找公钥: 某些环境 ANDROID_SDK_HOME / 绿色版Runtime
    // 会让 adb 在别处找 key，于是每次cold boot都弹「允许 USB 调试」→ device unauthorized。
    if (!env.ADB_VENDOR_KEYS) {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const keyDir = path.join(home, '.android');
      try { if (home && fs.existsSync(keyDir)) env.ADB_VENDOR_KEYS = keyDir; } catch (_) { /* ignore */ }
    }
    return env;
  }

  exec(args, { timeout = 30000, withSerial = true, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const finalArgs = this._args(args, withSerial);
      execFile(this.adbPath, finalArgs, {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        windowsHide: true,
        // 与Runtime模拟器共用专用 adb server 端口 (默认 5044)，与 5037 上的
        // WSA / 第三方模拟器 adb 隔离，避免注册被反复踢掉导致设备 offline
        env: this._adbEnv(),
      }, (err, stdout, stderr) => {
        if (err) {
          // adb install 的失败原因写在 stdout 且Quit码非 0; 
          // 旧版只看 stderr，导致用户永远只看到一句空泛的「失败」。
          const text = [stdout, stderr, err.message].filter(Boolean).join('\n').trim();
          const e = new AdbError(`adb ${finalArgs.join(' ')} failed: ${text}`, stderr, err.code);
          e.stdout = stdout;
          e.raw = text;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async shell(cmd, opts = {}) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return typeof stdout === 'string' ? stdout.trim() : stdout;
  }

  /**
   * 常驻输入通道。
   * 滚轮/返回是高频输入: 每格滚轮都 execFile 一个 adb 会起一堆进程，
   * 桌面会明显发顿。这里复用一条 `adb shell`，每行一条命令，并在末尾
   * echo 一个结束标记 —— 既知道命令何时真正跑完，也天然形成背压，
   * 不会让滑动命令在 shell 里排成一长队。
   */
  _inputSession() {
    const old = this._input;
    if (old && old.exitCode === null && !old.killed && old.stdin && old.stdin.writable) return old;
    if (old) this.disposeInput();

    const p = spawn(this.adbPath, this._args(['shell'], true), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this._adbEnv(),
    });
    this._input = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        for (const [id, w] of this._waiters) {
          // 必须整行等于标记: 某些 shell 会把整条命令行回显出来，
          // 用 contains 会把「刚写进去」误判成「已执行完」，滑动就会堆积。
          if (line === w.token) {
            this._waiters.delete(id);
            clearTimeout(w.timer);
            w.resolve(true);
            break;
          }
        }
      }
    });
    p.stderr.on('data', () => { /* 忽略: 设备离线等信息由调用方兜底 */ });
    p.stdin.on('error', () => { /* 断开时由 exit 统一清理 */ });
    p.on('error', () => { this._failWaiters(new Error('failed to start adb shell')); });
    p.on('exit', () => {
      if (this._input === p) this._input = null;
      this._failWaiters(new Error('adb shell exited'));
    });
    return p;
  }

  _failWaiters(err) {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }

  /** 执行一条白名单内的 input 命令; 失败会回收会话，调用方可回退到一次性 adb */
  async input(cmd, { timeout = 4000 } = {}) {
    const { isInputCommand } = require('./pointer');
    if (!isInputCommand(cmd)) throw new Error('invalid input command');
    const p = this._inputSession();
    const id = ++this._inputSeq;
    const token = `__APKSTART_${id}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        this.disposeInput();
        reject(new Error('input command timed out'));
      }, timeout);
      this._waiters.set(id, { resolve, reject, timer, token });
      try {
        p.stdin.write(`${cmd}; echo ${token}\n`);
      } catch (e) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  disposeInput() {
    const p = this._input;
    this._input = null;
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('input channel closed'));
    }
    this._waiters.clear();
    if (p) {
      try { p.stdin.end(); } catch (_) { /* ignore */ }
      try { p.kill(); } catch (_) { /* ignore */ }
    }
  }

  async version() {
    const { stdout } = await this.exec(['version'], { withSerial: false });
    const m = /version\s+([\d.]+)/i.exec(stdout);
    return m ? m[1] : stdout.trim();
  }

  async connect() {
    if (!this.serial.includes(':')) return true;
    try {
      await this.exec(['connect', this.serial], { withSerial: false, timeout: 15000 });
    } catch (_) { /* 可能已连接 */ }
    return this.isOnline();
  }

  async isOnline() {
    try {
      const { stdout } = await this.exec(['get-state'], { timeout: 8000 });
      return stdout.trim() === 'device';
    } catch (_) {
      // get-state 在未指定 serial 时不可用，退化用 devices 列表
      try {
        const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
        return stdout.split('\n').some((l) => l.startsWith(this.serial) && l.includes('device'));
      } catch (_) {
        return false;
      }
    }
  }

  /**
   * 读取本 serial 在 `adb devices` 里的真实状态: device / unauthorized / offline / no-device。
   * isOnline() 用的 get-state 无法区分 authorized 与 unauthorized (两者都是 'device')，
   * 开机Probe靠这个方法来识别「授权对话框卡住」并快速自愈。
   */
  async deviceState() {
    try {
      const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
      return parseDeviceState(stdout, this.serial);
    } catch (_) {
      return 'no-device';
    }
  }

  async devices() {
    const { stdout } = await this.exec(['devices', '-l'], { withSerial: false });
    return stdout.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l && l.includes('device') && !l.startsWith('*'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { serial: parts[0], state: parts[1], model: (l.match(/model:(\S+)/) || [])[1] || '' };
      })
      .filter((d) => d.state === 'device');
  }

  /**
   * 安装单个 APK，带Automatic降级: 
   *  - 默认去掉 -g (Automatic授予全部权限在部分镜像上会让 PermissionController 崩掉); 
   *  - 带 --bypass-low-target-sdk-block，解决 Android 14 拒绝安装老 targetSdk App; 
   *  - adb 版本不认该参数 / 中文路径 / 传输错误时Automatic换写法重试; 
   *  - NO_MATCHING_ABIS 抛带 code 的错误，交给上层Automatic切换Compatible image。
   */
  async install(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(`APK not found: ${apkPath}`);
    const staged = stageApk(apkPath);
    const file = staged.path;
    const variants = [
      // -g Automatic授予Runtime权限，省掉App里的授权弹窗; 部分镜像不支持则Automatic降级去掉
      ['install', '-r', '-t', '-g', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', file],
      ['install', '-r', file],
    ];
    let last = '';
    let timeout = 240000;
    try { timeout = installTimeoutMs(fs.statSync(file).size); } catch (_) { /* 取不到LargeSmall就用默认值 */ }
    try {
      for (const args of variants) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(args, { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) {
            throw new Error(String(stdout).trim());
          }
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          last = raw;
          const tag = (/INSTALL_[A-Z_]+/.exec(raw) || [])[0] || '';

          if (tag === 'INSTALL_FAILED_NO_MATCHING_ABIS') {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            err.raw = raw;
            throw err;
          }
          // 老 adb 不认新参数 / 测试包标记 → 换一种写法
          if (/Unknown option|unrecognized option|Unknown command/i.test(raw)) continue;
          if (tag === 'INSTALL_FAILED_TEST_ONLY' || tag === 'INSTALL_FAILED_DEPRECATED_SDK_VERSION') continue;
          // 传输类错误 (设备掉线, adb server 重启)重试一次
          if (/device (not found|offline)|closed|protocol fault|no devices/i.test(raw)) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(1500);
            continue;
          }
          if (tag) {
            const err = new Error(friendlyInstallError(raw));
            err.code = tag;
            err.raw = raw;
            throw err;
          }
          // 没拿到明确错误码: 最后一种写法再试
        }
      }
      const err = new Error(friendlyInstallError(last || 'Installation failed without a clear reason'));
      err.code = (/INSTALL_[A-Z_]+/.exec(last) || [])[0] || 'INSTALL_UNKNOWN';
      err.raw = last;
      throw err;
    } finally {
      unstage(staged.staged ? file : null);
    }
  }

  /** 拆分 APK (.apks / .xapk 解出来的多个分片)走 install-multiple */
  async installMultiple(apkPaths) {
    if (!apkPaths || !apkPaths.length) throw new Error('no split APKs to install');
    const staged = apkPaths.map((p) => stageApk(p));
    const files = staged.map((s) => s.path);
    const totalBytes = staged.reduce((n, s) => n + (fs.existsSync(s.path) ? fs.statSync(s.path).size : 0), 0);
    const timeout = installTimeoutMs(totalBytes);
    try {
      for (const extra of [['-r', '-t', '--bypass-low-target-sdk-block'], ['-r', '-t']]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(['install-multiple', ...extra, ...files], { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) throw new Error(stdout);
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          if (/Unknown option|unrecognized option/i.test(raw)) continue;
          if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(raw)) {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            throw err;
          }
          throw new Error(friendlyInstallError(raw));
        }
      }
      throw new Error('split APK installation failed');
    } finally {
      staged.forEach((s) => unstage(s.staged ? s.path : null));
    }
  }

  async uninstall(pkg) {
    try {
      await this.exec(['uninstall', pkg], { timeout: 60000 });
    } catch (e) {
      // 部分设备需要指定 user
      await this.exec(['shell', 'pm', 'uninstall', '--user', '0', pkg], { timeout: 60000 });
    }
  }

  /**
   * 是否真的装好了 —— 不轻信 PackageManager 的一句话。
   *
   * 快照与数据分区不一致时，`pm path` 会因 packages.xml 里还留着记录而返回
   * `package:/data/app/.../base.apk` (installed=true)，但那个 APK 文件其实已经被
   * 回滚掉了。Continue `am start` 只会失败。所以用 `test -f/-s` 逐个核对 pm 报出来的
   * 路径，文件不在 (或空文件)就判定为「未真正安装」，交给上层Automatic重装。
   *
   * @returns {Promise<boolean>}
   */
  async isInstalled(pkg) {
    const out = await this.shell(`pm path ${pkg}`);
    const paths = parsePmPaths(out);
    if (!paths.length) return false;
    // 分片 APK 全部要在; 任一片丢了都启动不了。合并成一条 shell，省一次 adb 往返。
    const checks = paths.map((p) => `[ -s "${p}" ]`).join(' && ');
    const probe = await this.shell(`${checks} && echo __APKSTART_PRESENT__`, { timeout: 10000 }).catch(() => '');
    return /__APKSTART_PRESENT__/.test(String(probe));
  }

  async listPackages() {
    const out = await this.shell('pm list packages -3');
    return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
  }

  /** 从系统解析真正的启动 Activity (清单里解析不出来时的兜底) */
  /** App升级后入口可能变，解析前先把这个包从缓存里摘掉 */
  clearLauncherCache(pkg) {
    if (!pkg) { LAUNCHER_CACHE.clear(); return; }
    LAUNCHER_CACHE.delete(`${this.adbPath}|${pkg}`);
  }

  async resolveLauncher(pkg) {
    // 解析入口 Activity 要一次 adb 往返 (~200-400ms)，而它在一个启动会话里不会变。
    // 缓存起来，第二次点同一个App直接跳过; 10 分钟后自然失效，重装App也不会用错入口。
    const key = `${this.adbPath}|${pkg}`;
    const hit = LAUNCHER_CACHE.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    try {
      const out = await this.shell(
        `cmd package resolve-activity --brief ${pkg}`, { timeout: 10000 },
      );
      const comp = parseResolvedActivity(pkg, out);
      if (comp) {
        LAUNCHER_CACHE.set(key, { value: comp, at: Date.now() });
        return comp;
      }
    } catch (_) { /* 落到 monkey */ }
    return null;
  }

  /** App是否真的活着: am start 返回成功 ≠ 进程没崩 */
  async waitAppAlive(pkg, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const pid = await this.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
      if (String(pid).trim()) return { ok: true };
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    let crash = '';
    try {
      crash = await this.shell(
        `logcat -d -t 250 -v brief AndroidRuntime:E DEBUG:E libc:E 2>/dev/null | `
        + `grep -i -E '${pkg}|FATAL|ndk_translation|SIGABRT|SIGSEGV|UnsatisfiedLink' | tail -n 30`,
        { timeout: 12000 },
      );
    } catch (_) { /* ignore */ }
    const text = String(crash || '').trim();
    // 没有崩溃logs时不能断言失败: 部分Large型App首次启动要 20-40 秒
    return { ok: false, crash: text, uncertain: !text };
  }

  /**
   * 启动App，带三级降级: 
   *   freeform 独立窗口 → 普通全屏 → monkey 兜底; 
   * 每次都验证进程是否存活，崩溃时抓 logcat 并抛带 code 的错误供上层Automatic切镜像。
   */
  async startApp(pkg, activity, { freeform = true, bounds = null, forceStop = false } = {}) {
    if (forceStop) await this.forceStop(pkg);
    // 必须用系统解析出来的 LAUNCHER 入口，不能只用 APK 里解析到的主 Activity: 
    // 很多App (红果短剧等)的启动页才做真正的初始化，直接进主 Activity 会
    // 抛 "had you called RpcService.init"，表现为点开闪一下就没了。
    const resolved = (await this.resolveLauncher(pkg).catch(() => '')) || activity;
    // resolved 可能是完整组件 (pkg/class)，也可能只是类名 (老 apps.json); 
    // 这里统一成 am start -n 要的完整组件，避免 pkg/pkg/class 被系统Cancel。
    const comp = componentArg(pkg, resolved);
    const intent = comp
      ? ['-n', comp]
      : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg];
    const modes = freeform
      ? [['--windowingMode', '5'], []]
      : [[]];
    let lastError = '';

    for (const mode of modes) {
      const parts = ['am', 'start', ...mode, '--activity-clear-top', ...intent];
      let out = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await this.shell(parts.join(' '), { timeout: 20000 });
      } catch (e) {
        lastError = String(e.message || e);
        continue;
      }
      if (/Error|Exception/i.test(out)) { lastError = out; continue; }

      if (bounds) this.resizeTaskOfPackage(pkg, bounds).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const alive = await this.waitAppAlive(pkg, 6000);
      if (alive.ok) return out;
      if (alive.uncertain) return `${out}\n(the app is still loading)`;
      lastError = alive.crash || lastError;
      // 崩溃logs明确指向 ARM 翻译层时不再重试，直接交给上层切换Compatible image
      if (/DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|dlopen failed/i.test(alive.crash || '')) {
        const err = new Error(friendlyLaunchError(alive.crash, pkg));
        err.code = 'APP_CRASHED';
        err.crash = alive.crash;
        throw err;
      }
    }

    // monkey 兜底: 部分镜像的 am start -a/-c/-p 解析不到 launcher
    try {
      const out = await this.shell(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 },
      );
      const alive = await this.waitAppAlive(pkg, 12000);
      if (alive.ok || alive.uncertain) return out;
      lastError = alive.crash || lastError;
    } catch (e) {
      // 有明确崩溃信息时优先用它，否则保留原始启动错误
      if (!lastError) lastError = String(e.message || e);
    }

    if (!lastError) return 'started';
    const err = new Error(friendlyLaunchError(lastError, pkg));
    err.code = 'APP_CRASHED';
    err.crash = lastError;
    throw err;
  }

  async forceStop(pkg) {
    try { await this.shell(`am force-stop ${pkg}`); } catch (_) { /* ignore */ }
  }

  async runningPackages() {
    try {
      const out = await this.shell('dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity"');
      const pkgs = [...out.matchAll(/([a-zA-Z][\w.]+\/[.\w$]+)/g)].map((m) => m[1].split('/')[0]);
      return [...new Set(pkgs)];
    } catch (_) {
      return [];
    }
  }

  async taskIdOfPackage(pkg) {
    try {
      const out = await this.shell('dumpsys activity recents');
      const blocks = out.split('Recent #');
      for (const b of blocks) {
        if (!b.includes(pkg)) continue;
        const m = /taskId=(\d+)/.exec(b) || /^\d+/.exec(b);
        if (m) return Number(m[1] || m[0]);
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async resizeTaskOfPackage(pkg, bounds) {
    const id = await this.taskIdOfPackage(pkg);
    if (!id) return false;
    await this.shell(`am task resize ${id} ${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}`);
    return true;
  }

  /** 开启 freeform (独立窗口)支持，失败不影响主流程 */
  async ensureFreeform() {
    // 合成为一次 adb shell: 4 次独立 execFile 在 Windows 上要 600ms+，
    // 而这段正好在「点开App」的等待里。
    const out = await this.shell(
      'settings put global enable_freeform_support 1 ; '
      + 'settings put global force_resizable_activities 1 ; '
      + 'settings put global development_settings_enabled 1 ; '
      + 'settings get global enable_freeform_support',
      { timeout: 12000 },
    ).catch(() => '0');
    return String(out).trim().split(/\r?\n/).pop().trim() === '1';
  }

  async wmSize() {
    const out = await this.shell('wm size');
    const m = /(\d+)x(\d+)/.exec(out.split('\n').pop() || out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  async androidVersion() {
    return (await this.shell('getprop ro.build.version.release').catch(() => '')).trim();
  }

  async sdkInt() {
    const v = await this.shell('getprop ro.build.version.sdk').catch(() => '0');
    return Number(v.trim()) || 0;
  }

  async screenshot() {
    const { stdout } = await this.exec(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async push(local, remote) {
    await this.exec(['push', local, remote], { timeout: 180000 });
  }

  async pull(remote, local) {
    await this.exec(['pull', remote, local], { timeout: 180000 });
  }

  async shellMkdir(remote) {
    await this.shell(`mkdir -p "${remote}"`);
  }

  async listRemote(remote) {
    const out = await this.shell(`ls -l "${remote}" 2>/dev/null`);
    return String(out).split('\n').map((line) => {
      const l = line.trim();
      if (!l || l.startsWith('total ')) return null;
      // Android 的 ls -l 有「含 group」和「不含 group」两种格式，日期可能是
      // "2026-11-12 18:52" 或 "Nov 12 18:52"，用固定正则会全解析不出来。
      // 权限位之后的第 2 个数字即文件LargeSmall，最后一段即文件名。
      const parts = l.split(/\s+/);
      if (parts.length < 6 || !/^[\-dl]/.test(parts[0])) return null;
      const sizeIdx = parts.findIndex((p, i) => i >= 2 && /^\d+$/.test(p)
        && /(\d{4}-\d{2}-\d{2}|^[A-Za-z]{3}$)/.test(parts[i + 1] || ''));
      if (sizeIdx < 0) return null;
      const size = Number(parts[sizeIdx]);
      // 文件名在「时:分」token 之后 (日期段 2-3 个 token，不固定)
      const timeIdx = parts.findIndex((p, i) => i > sizeIdx && /^\d{1,2}:\d{2}(:\d{2})?$/.test(p));
      const name = parts.slice((timeIdx >= 0 ? timeIdx : sizeIdx + 2) + 1).join(' ');
      return name ? { isDir: parts[0][0] === 'd', size, name } : null;
    }).filter(Boolean);
  }

  /**
   * 带真实 mtime 的远端列表 (toybox stat)。
   * ls -l 的日期是「月 日 时:分」，无法可靠换算，会导致同步误判为「每次都变了」。
   * 返回 null 表示设备不支持 stat，调用方应退回 listRemote。
   */
  async listRemoteStat(remote) {
    let out = '';
    try {
      out = await this.shell(`cd "${remote}" 2>/dev/null && find . -type f -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`);
    } catch (_) {
      return null;
    }
    const rows = parseStatList(out);
    if (!rows) return null;
    return rows;
  }

  /** Clear app data */
  async clearData(pkg) {
    await this.shell(`pm clear ${pkg}`);
  }

  /** 导出App数据 (Windows/调试版可用 run-as; 否则走 adb backup 兜底) */
  async exportAppData(pkg, localTarPath) {
    const remote = `/sdcard/apkstart-tmp-${pkg}.tar`;
    const cmd = `run-as ${pkg} tar -cf ${remote} . 2>/dev/null || (cd /data/data/${pkg} && tar -cf ${remote} .)`;
    await this.shell(cmd);
    await this.pull(remote, localTarPath);
    await this.shell(`rm -f ${remote}`).catch(() => {});
    return localTarPath;
  }

  async batteryOptimizeOff(pkg) {
    try { await this.shell(`dumpsys deviceidle whitelist +${pkg}`); } catch (_) { /* ignore */ }
  }

  /**
   * 把App申请的Runtime权限一次性授掉。
   * 不授会有两个后果: ① 首次启动弹系统授权框，用户看到的是「App没Open」; 
   * ② 清过数据 (pm clear)之后权限会掉，App起来就卡在授权页。
   */
  async grantRuntimePermissions(pkg) {
    let dump = '';
    try {
      dump = await this.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    } catch (_) {
      return [];
    }
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const denied = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break; // 离开 runtime permissions 段
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m && m[2] === 'false') denied.push(m[1]);
    }
    const granted = [];
    // 授权一次发完: pm grant 每条一次进程在 Windows 上要 150ms+，
    // 四五个权限就是 1 秒，而这些命令本身没有任何依赖关系。
    const cmds = [];
    for (const p of denied) cmds.push(`pm grant ${pkg} ${p}`);
    // 特殊权限走 appops，否则仍然会弹窗
    const ops = ['MANAGE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'REQUEST_INSTALL_PACKAGES', 'WRITE_SETTINGS'];
    for (const op of ops) cmds.push(`cmd appops set ${pkg} ${op} allow`);
    if (cmds.length) {
      await this.shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
      granted.push(...denied);
    }
    return granted;
  }

  /**
   * 进入「就是这个App」的状态: 
   *  - 收起锁屏，避免开机后停在锁屏挡住App; 
   *  - 隐藏状态栏 (保留底部导航键，鼠标不在手边时还能点返回/主页); 
   *  - 关掉System animations，低配机器上体感差别非常Large。
   * 全部是 settings 级命令，一次几百毫秒，重复调用无害。
   */
  async prepareForeground() {
    // 以前是 7 条命令串行发，每条都要新起一个 adb 进程 (Windows 上 150~250ms)，
    // 合计 1~1.7 秒，全压在「点开App」的等待里。合成一条 shell 后只剩一次往返。
    const cmds = [
      'wm dismiss-keyguard',
      'settings put global policy_control immersive.status=*',
      'settings put secure immersive_mode_confirmations confirmed',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put system screen_off_timeout 2147483647',
      // 联网验证: 安卓默认拿 connectivitycheck.gstatic.com 判断「是否真能上网」，
      // 国内连不上它，系统就一直给网络打「!」标记 (已连接但无法访问互联网)，
      // 部分App据此自我判定离线, 拒绝加载内容。换成国内返回 204 的端点。
      // 每次启动都写一次 (幂等, 单条 shell 里，几乎零成本)，这样即使从旧快照
      // 恢复, 或用户手动改过系统Settings，也能Automatic纠正回来。
      'settings put global captive_portal_http_url http://connect.rom.miui.com/generate_204',
      'settings put global captive_portal_https_url https://connect.rom.miui.com/generate_204',
      'settings put global captive_portal_mode 0',
      // 注意: 这里不要再写 wm user-rotation / accelerometer_rotation。
      // 方向由 setOrientation / resetDisplayOverrides 按当前横Portrait状态统一定，
      // 在这里写死 lock 0 会把Landscape方向覆盖回Portrait (画面躺倒)。
    ];
    await this.shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => {});
    return true;
  }

  /** 鼠标右键 / 侧键 / 快捷键映射: 走常驻输入通道，右键返回不再有 100ms 级延迟 */
  async _key(code) {
    try {
      await this.input(`input keyevent ${code}`);
    } catch (_) {
      // Runtime刚重启, 常驻 shell 还没连上时，退回一次性 adb，不能把这次点击丢掉
      await this.shell(`input keyevent ${code}`, { timeout: 6000 }).catch(() => {});
    }
  }

  async keyBack() { return this._key(4); }
  async keyForward() { return this._key(125); }

  /**
   * 切换「手机排版 / Tablet layout」。
   *
   * 关键: **绝不改 wm size**。改 wm size 会改变 guest framebuffer 的物理尺寸
   *  (720x1280 -> 1280x720)，而嵌入的 Qt 窗口仍是原来的尺寸/方向，于是画面被
   * 压扁或整体躺倒 90°，鼠标坐标映射也跟着错乱。更糟的是 wm size 覆盖会持久化
   * 在 /data 里，重启后仍然生效 —— 这就是用户反复看到「黑边 / 未填满 / 点不动」
   * 的根源。
   *
   * current只改逻辑密度 (wm density)，framebuffer 始终是 720x1280 正立: 
   *   - 320dpi -> smallestWidth 360dp -> 手机排版
   *   - 190dpi -> smallestWidth 606dp (>=600dp)-> 平板 / 分栏排版
   * 尺寸, 方向, 点击映射全部不变，因此不会躺倒, 不会有黑边, 点击永远对应。
   */
  async setOrientation(landscape) {
    try {
      // Automatic旋转必须关掉 (否则传感器会乱转)。
      await this.shell('settings put system accelerometer_rotation 0; wm size reset', { timeout: 15000 });
      // 方向锁 **0** (不是 1)。物理面板的方向已经由 hw.lcd.width/height 决定
      //  (见 doctor.lcdFor)，这里再锁 1 等于把横面板又转成竖逻辑空间，
      // 结果就是画面躺倒 90° —— 这正是「Landscape没弄好」的直接原因。
      await this.shell('wm user-rotation lock 0', { timeout: 15000 });
      // 关键一步: 红果这类App自己声明了 portrait，系统会照办，于是
      // init=1280x720 的横面板被转成 cur=720x1280 的竖逻辑空间，画面又躺下。
      // Open「忽略App的Screen orientation请求」，系统才会按面板方向排版。
      // Portrait模式下必须显式关掉，否则上一次Landscape留下的 true 会让Portrait panel里
      // 显示Landscape排版。API < 31 没有这个命令，失败忽略即可。
      await this.shell(`wm set-ignore-orientation-request ${landscape ? 'true' : 'false'}`, { timeout: 15000 });
      // Open freeform / 忽略方向请求后，安卓会弹一次「See and do more」的引导框
      //  ("Double-tap outside an app to reposition it…")。它盖在App上面，
      // 用户以为程序坏了。这里预先把它标记为已OK，再兜底按一次返回。
      await this.shell('settings put secure freeform_mode_confirmations confirmed', { timeout: 10000 });
      if (landscape) await this.shell('input keyevent KEYCODE_BACK', { timeout: 8000 });
      await this.shell(`wm density ${tabletDensity()}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 启动时清掉旧版本残留的 wm size / density 覆盖 (持久化在 /data，会一直躺倒) */
  async resetDisplayOverrides(landscape = false) {
    try {
      // density 必须**在App启动之前**就设好。
      // 之前这里无条件 `wm density reset`，然后由 _healOrientation (App起来
      // 1.8 秒后 / 每 60 秒巡检)补回 190 —— 那是一次「AppRunning」的配置变更。
      // 缓存了 DisplayMetrics 的App (墨读就是)会按旧密度算一遍 dp，画面缩成
      // 左上角一Small块, 右边一Large片空白，也就是用户说的「墨读没有填满窗口」。
      // current在这里连同 size 一起重设，启动路径上不再有中途改密度。
      await this.shell(`wm size reset; wm density ${tabletDensity()}`, { timeout: 15000 });
      await this.shell('settings put system accelerometer_rotation 0', { timeout: 15000 });
      // 与 setOrientation 保持一致: 面板方向说了算，逻辑方向锁 0。
      await this.shell('wm user-rotation lock 0', { timeout: 15000 });
      await this.shell(`wm set-ignore-orientation-request ${landscape ? 'true' : 'false'}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 保证 guest 里有一套能打中文的输入法。
   *
   * System images (Google Play 版)只带 LatinIME (英文键盘)，Gboard 的中文语言包又要
   * 联网下载, 在模拟器里极不可靠。所以随包带一个 AOSP 谷歌拼音输入法
   *  (assets/PinyinIME.apk，含 x86_64 原生库)，开机后静默装好并启用。
   *
   * 幂等: 已安装就跳过，用户手动换掉默认输入法后不强行改回去。
   *
   * @param {string} apkPath PinyinIME.apk 的绝对路径
   * @param {object} [o] { setDefault } 是否设为默认输入法 (默认 true)
   * @returns {Promise<{ok:boolean, installed?:boolean, ime?:string, reason?:string}>}
   */
  async ensureChineseIme(apkPath, { setDefault = true } = {}) {
    const IME_PKG = 'com.android.inputmethod.pinyin';
    const IME_ID = IME_PKG + '/.PinyinIME';
    // 组件名写死但校验存在: ime list -s 只列**已启用**的输入法，用它判断
    // 「装没装」会在刚安装完时误判为「服务未注册」，于是永远走不到 ime enable。
    // 正确做法是用 pkg 是否已安装来判断，组件名用 ime list -a 交叉OK。
    const pkgInstalled = async () => {
      const out = await this.shell(`pm list packages ${IME_PKG}`, { timeout: 10000 }).catch(() => '');
      return String(out).indexOf('package:' + IME_PKG) >= 0;
    };
    const findEnabledIme = async () => {
      const out = await this.shell('ime list -s', { timeout: 10000 }).catch(() => '');
      return String(out).split('\n').map((s) => s.trim()).find((s) => s.indexOf(IME_PKG) === 0) || '';
    };
    try {
      let installed = await pkgInstalled();
      let justInstalled = false;
      if (!installed) {
        if (!apkPath || !fs.existsSync(apkPath)) {
          return { ok: false, reason: 'IME APK missing' };
        }
        await this.install(apkPath);
        installed = true;
        justInstalled = true;
        // 装完等包管理器扫到这个包
        for (let i = 0; i < 6; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          installed = await pkgInstalled();
          if (installed) break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      if (!installed) return { ok: false, justInstalled, reason: 'IME package not registered' };
      // 启用 + 设为默认 (secure settings 可写，不需要 root)。
      // 每次都执行: 从旧快照恢复时 enabled 标记可能丢失，或用户手动换过默认输入法。
      const cmds = [`ime enable ${IME_ID}`];
      if (setDefault) cmds.push(`settings put secure default_input_method ${IME_ID}`);
      await this.shell(cmds.join(' ; '), { timeout: 12000 }).catch(() => '');
      const ime = await findEnabledIme();
      return { ok: !!ime, installed: justInstalled, ime: ime || IME_ID };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * 保证System language是简体中文。
   * persist.sys.locale 是 SELinux 保护的只读属性，Runtime改不了 (会报
   * "Failed to set property")，真正生效靠 emulator 启动时的 -prop 注入。
   * 这里做的是能做的部分: 把App级 locale 和时区设好，让界面立刻中文, 时间正确。
   */
  async ensureChineseLocale(locale = 'zh-CN') {
    const cmds = [
      'settings put system system_locales ' + locale,
      'setprop persist.sys.timezone Asia/Shanghai',
      // 24 Small时制 + 中文常见的日期格式
      'settings put system time_12_24 24',
    ];
    await this.shell(cmds.join(' ; '), { timeout: 12000 }).catch(() => '');
    return true;
  }

  /** 当前逻辑分辨率 (Landscape切换后窗口要按它算宽高比) */
  async displaySize() {
    try {
      const out = await this.shell('wm size', { timeout: 8000 });
      const o = /Override size:\s*(\d+)x(\d+)/.exec(out);
      if (o) return { w: Number(o[1]), h: Number(o[2]) };
      const p = /Physical size:\s*(\d+)x(\d+)/.exec(out);
      if (p) return { w: Number(p[1]), h: Number(p[2]) };
    } catch (_) { /* ignore */ }
    return null;
  }

  /** 授权框还挂在最前面时 (用户不在电脑前也能自愈)，按返回键收掉 */
  async dismissPermissionDialog() {    try {
      const top = await this.shell('dumpsys activity activities', { timeout: 12000 });
      if (/GrantPermissionsActivity|permissioncontroller/i.test(String(top))) {
        await this.shell('input keyevent 4', { timeout: 6000 }).catch(() => {});
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  /**
   * 显示适配: 全屏时把 Android 分辨率改成显示器尺寸 (内容Automatic铺满)，
   * 窗口模式时恢复Portrait预设。wm 命令是Runtime生效的，不需要重启 Android。
   */
  async setDisplaySize(width, height, density) {
    const w = Math.max(320, Math.round(Number(width) || 0));
    const h = Math.max(480, Math.round(Number(height) || 0));
    await this.shell(`wm size ${w}x${h}`);
    if (density) await this.shell(`wm density ${Math.max(120, Math.min(640, Math.round(density)))}`);
    return { w, h };
  }

  async resetDisplaySize() {
    await this.shell('wm size reset').catch(() => {});
    await this.shell('wm density reset').catch(() => {});
  }
}

module.exports = {
  AdbClient, AdbError, parseStatList, friendlyInstallError, friendlyLaunchError,
  componentArg, parseResolvedActivity, parseDeviceState, isUnauthorizedError, parsePmPaths,
};
