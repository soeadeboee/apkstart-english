'use strict';
/**
 * 底座: 网易 MuMu emulator 12 (玩家版 / 多开)
 *
 * 为什么choose它做第一个「第三方底座」实测对象: 
 *  - 官方带一个命令行管理工具 MuMuManager.exe (info / control / adb / sh / setting)，
 *    端口, 窗口句柄, 开关机状态全部是结构化 JSON，不用猜; 
 *  - 渲染窗口是Standard的 Qt 顶层窗口 (Qt5156QWindowIcon)，和自带 emulator 同源，
 *    SetParent 嵌入这条链路是现成的; 
 *  - 它自带 ARM 兼容层 (红果这类 arm64-only App可直接跑)。
 *
 * 用到的 MuMuManager 子命令 (都在它自己的 --help 里): 
 *   info -v <index>                       → { adb_port, main_wnd, render_wnd, pid, player_state, ... }
 *   control -v <index> launch|shutdown    → 开机 / 关机
 *   control -v <index> show_window        → 把设备窗口显示出来
 *   control -v <index> layout_window ...  → 摆位置/尺寸
 *   control -v <index> app install -apk   → 装包
 *   control -v <index> app info -i        → Installed apps清单
 *   control -v <index> app launch -pkg    → 启动App
 *
 * 重要限制 (实测，写在这里免得以后踩): 
 *  - MuMu 的多开实例之间是隔离的; 这里只接管「索引 0」那一台。
 *  - 窗口句柄会在设备进程重启后失效，每次用都要重新 info 一次。
 *  - 不能把已经隐藏的设备窗口 SetParent 进去: MuMu 自己会把它再压下去
 *     (Windows 在 SetParent 时会隐式清掉 WS_VISIBLE，MuMu 的 Qt 侧不会补回来)，
 *    所以注入前必须OK窗口当前是可见的，必要时先 show_window。
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Backend, CAPS } = require('./base');

/** 常见安装位置 (按命中率排序)。用户在Settings里填的路径优先。 */
const CANDIDATE_ROOTS = [
  'D:\\MuMu Player 12',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell',
  'C:\\Program Files\\Netease\\MuMu Player 12',
  'D:\\Program Files\\Netease\\MuMuPlayer-12.0',
  'E:\\MuMu Player 12',
  'F:\\MuMu Player 12',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portAlive(port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

/** 从注册表里读 MuMu 的安装目录 (比猜路径可靠) */
function rootFromRegistry() {
  if (process.platform !== 'win32') return [];
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer-12.0',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer-12.0',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer-12.0',
  ];
  const out = [];
  for (const key of keys) {
    const r = spawnSyncSafe('reg', ['query', key, '/v', 'UninstallString']);
    if (!r) continue;
    const m = /"([^"]+)"/.exec(r) || /([A-Z]:\\[^\r\n]+\.exe)/i.exec(r);
    if (m) out.push(path.dirname(m[1]));
  }
  return out;
}

function spawnSyncSafe(cmd, args) {
  try {
    const { execFileSync } = require('child_process');
    return String(execFileSync(cmd, args, { windowsHide: true, timeout: 4000, encoding: 'utf8' }) || '');
  } catch (_) {
    return '';
  }
}

class MumuBackend extends Backend {
  static get id() { return 'mumu'; }

  static get label() { return 'MuMu Player 12 (reuse the installed NetEase emulator)'; }

  static get summary() {
    return 'Downloads no Android image: it drives the MuMu Player 12 already installed on your PC,'
      + 'Turns it into the ApkStart runtime. Ships an ARM compatibility layer, cold boot takes about 10-20 seconds.';
  }

  static get embedCapable() { return true; }

  constructor(appRoot, deps = {}) {
    super(appRoot, deps);
    /** 用户可在Settings里指定 MuMu 安装目录 */
    this.root = '';
    this.index = 0;
    this._info = null;
    this._infoAt = 0;
  }

  get caps() {
    // 不提供 provision (镜像归 MuMu 管), resetData (会连带清掉用户在 MuMu 里的其他东西，
    // 只做OK后的 shutdown 而不擅自删数据), rotatePanel (走 adb wm，不重启物理面板)
    return new Set([CAPS.priority, CAPS.shutdown, CAPS.sharedHost]);
  }

  /** 解析 MuMu 安装目录 → { root, manager, adb, device } */
  locate() {
    const settings = (this.deps.store && this.deps.store.getSettings) ? this.deps.store.getSettings() : {};
    const configured = String((settings.engine && settings.engine.mumuPath) || '').trim();
    const roots = [];
    if (configured) roots.push(configured);
    roots.push(...rootFromRegistry());
    roots.push(...CANDIDATE_ROOTS);
    for (const root of roots) {
      if (!root) continue;
      const candidates = [
        path.join(root, 'nx_main', 'MuMuManager.exe'),
        path.join(root, 'shell', 'MuMuManager.exe'),
        path.join(root, 'MuMuManager.exe'),
      ];
      const manager = candidates.find((p) => fs.existsSync(p));
      if (!manager) continue;
      const base = path.dirname(path.dirname(manager));
      const adbCandidates = [
        path.join(base, 'shell', 'adb.exe'),
        path.join(base, 'nx_main', 'adb.exe'),
        path.join(base, 'nx_device', '12.0', 'shell', 'adb.exe'),
      ];
      const device = [
        path.join(base, 'nx_device', '12.0', 'shell', 'MuMuNxDevice.exe'),
        path.join(base, 'nx_device', '15.0', 'shell', 'MuMuNxDevice.exe'),
      ].find((p) => fs.existsSync(p)) || '';
      this.root = base;
      return { root: base, manager, adb: adbCandidates.find((p) => fs.existsSync(p)) || '', device };
    }
    this.root = '';
    return null;
  }

  /** 调 MuMuManager; 返回解析后的 JSON (失败给 null) */
  manager(args, { timeout = 20000 } = {}) {
    const loc = this.locate();
    if (!loc) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(loc.manager, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const text = String(stdout || '').trim();
        if (!text) { resolve(null); return; }
        try { resolve(JSON.parse(text)); } catch (_) { resolve(text); }
      });
    });
  }

  /** 读取实例信息 (带 1.2s 缓存: 调用方经常连读好几项) */
  async info({ fresh = false } = {}) {
    if (!fresh && this._info && Date.now() - this._infoAt < 1200) return this._info;
    const r = await this.manager(['info', '-v', String(this.index)], { timeout: 12000 });
    if (r && typeof r === 'object' && r.adb_port) {
      this._info = r;
      this._infoAt = Date.now();
    } else if (r && typeof r === 'object' && r.index !== undefined && r.adb_port === undefined) {
      this._info = r; // 关机状态下没有 adb_port，也要缓存下来
      this._infoAt = Date.now();
    }
    return this._info;
  }

  async probe() {
    const loc = this.locate();
    if (!loc) return { ok: true, found: false, detail: 'MuMuManager.exe not found' };
    const info = await this.manager(['version'], { timeout: 8000 });
    return {
      ok: true, found: true, path: loc.manager, detail: (info && info.version) || '', root: loc.root,
    };
  }

  async check() {
    const loc = this.locate();
    if (!loc) return { ok: false, reason: 'MuMu emulator not found (set its install directory in Settings)', needs: 'mumu' };
    if (!loc.adb) return { ok: false, reason: 'adb.exe not found in the MuMu directory', needs: 'mumu' };
    return { ok: true, path: loc.manager };
  }

  async resolveAdb() {
    const loc = this.locate();
    return loc && loc.adb ? loc.adb : '';
  }

  running() {
    // 有 adb 端口在监听，就认为虚拟机在跑 (MuMuManager 的 info 要 300ms+，这个更快)
    return !!(this._info && this._info.is_process_started && !this._stoppedByUs);
  }

  /** 轮询等 Android 真正起来 */
  async waitReady({ timeoutMs = 120000, onLog = () => {} } = {}) {
    const t0 = Date.now();
    let lastNotice = 0;
    while (Date.now() - t0 < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const info = await this.info({ fresh: true });
      if (info && info.is_android_started && info.adb_port) return info;
      if (Date.now() - lastNotice > 8000) {
        lastNotice = Date.now();
        const st = (info && info.player_state) || 'starting';
        onLog(`MuMu emulator starting… ${st} ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(1500);
    }
    return null;
  }

  async ensure({ onLog = () => {} } = {}) {
    const loc = this.locate();
    if (!loc) {
      return { ok: false, error: 'MuMu emulator not found. Install NetEase MuMu Player 12 first, or set its install directory in Settings.' };
    }
    let info = await this.info({ fresh: true });
    const wasRunning = !!(info && info.is_android_started);
    if (!wasRunning) {
      onLog(info && info.is_process_started ? 'The MuMu emulator is booting…' : 'Starting the MuMu emulator…');
      await this.manager(['control', 'launch', '-v', String(this.index)], { timeout: 30000 });
      this._stoppedByUs = false;
      info = await this.waitReady({ onLog });
      if (!info) return { ok: false, error: 'MuMu emulator start timed out (did not reach the Android home screen in 120 seconds)' };
    }
    this.serial = `${info.adb_host_ip || '127.0.0.1'}:${info.adb_port}`;
    this.adbPath = loc.adb;
    // MuMu 的 adb 端口不是 emulator-* 的Automatic注册设备，要先 connect。
    // 用「全局 adb」还是「MuMu 自带 adb」都行，这里统一用调用方给的 adb (上层会传自带的)，
    // 拿不到才退回 MuMu 自带的。
    const adb = this.adbPath;
    await new Promise((resolve) => {
      execFile(adb, ['connect', this.serial], { windowsHide: true, timeout: 10000 }, () => resolve());
    });
    return {
      ok: true, serial: this.serial, adbPath: adb, reused: wasRunning, engine: 'mumu', info,
    };
  }

  /**
   * 给 WinAgent 的候choose HWND。
   *
   * 实测结论: MuMu 的 main_wnd (Qt5156QWindowIcon，标题=实例名)是整个设备窗口，
   * 里面包含安卓画面 + MuMu 自带的顶部工具条。render_wnd 是嵌在 main_wnd 里的
   * 画面子窗 (标题 = "MuMuNxDevice")。
   * 嵌入 main_wnd 时工具条会一起进来; 嵌入 render_wnd 更干净但坐标要先换算。
   * 这里优先给 render_wnd: 外壳会把多出来的部分裁在标题栏下面。
   */
  async windowTargets() {
    const info = await this.info({ fresh: true });
    if (!info) return [];
    // 关键: 不能直接用 info 里报的 main_wnd。
    // MuMu 12 的设备窗口每次 relaunch/换分辨率都会重建，info 报的那个句柄经常
    // 已经失效 (IsWindow=false)，而 adb 是好的, player_state 也还是 start_finished，
    // 于是「看起来一切正常但就是嵌不进去」。
    // 这里按进程名现找: 设备进程 MuMuNxDevice 创建的 Qt 顶层窗口里，
    // 面积最Large的那个就是画面窗口 (主窗 Qt5156QWindowIcon，其它是工具条/缩略图)。
    const live = findDeviceWindows();
    if (live.length) {
      const ordered = [info.render_wnd, info.main_wnd]
        .map((raw) => hwndOf(raw))
        .filter((h) => h && live.some((w) => w.hwnd === h));
      const rest = live.filter((w) => !ordered.some((h) => w.hwnd === h));
      const all = [...ordered.map((h) => live.find((w) => w.hwnd === h)), ...rest.sort((a, b) => b.area - a.area)]
        .filter(Boolean);
      this._win = all[0] || null;
      return all.map((w) => w.hwnd);
    }
    // 兜底: 进程还没建窗口 (刚开机那几秒)就退回 info 报的句柄
    const out = [info.render_wnd, info.main_wnd].map((raw) => hwndOf(raw)).filter(Boolean);
    this._win = null;
    return out;
  }

  /** 设备画面窗口current的几何 (像素)，拿不到返回 null */
  windowGeometry() {
    return this._win ? this._win.geometry() : null;
  }

  /** 让 MuMu 自己把设备窗口显示出来 (隐藏状态下的窗口 SetParent 进去不会显示) */
  async showWindow() {
    const r = await this.manager(['control', '-v', String(this.index), 'show_window'], { timeout: 10000 });
    return !!(r && (r.errcode === 0 || r === true));
  }

  async layoutWindow({ x = 0, y = 0, w = 540, h = 960 } = {}) {
    return this.manager([
      'control', '-v', String(this.index), 'layout_window',
      '-px', String(Math.round(x)), '-py', String(Math.round(y)),
      '-sw', String(Math.round(w)), '-sh', String(Math.round(h)),
    ], { timeout: 10000 });
  }

  /**
   * Ready门禁。
   *
   * 坑 (实测): Windows 的 SetParent 会隐式清掉子窗口的 WS_VISIBLE。
   * 如果趁 MuMu 的设备窗口还处于隐藏状态 (刚开机, 或被我们藏起来过)就 SetParent，
   * 之后它永远不会自己再显示出来 —— 宿主窗口里是一片黑，而且 MuMuManager 报的
   * main_wnd 还是同一个句柄，看起来「一切正常」。
   *
   * 所以嵌入前必须先 show_window 把窗口显示出来，等它真的可见了再动手。
   */
  async windowReady({ isEmbedded } = {}) {
    if (typeof isEmbedded === 'function' && isEmbedded()) return { ok: true, already: true };
    const info = await this.info({ fresh: true });
    if (!info || !info.main_wnd) return { ok: false, reason: 'no-window' };
    if (info.player_state !== 'start_finished') return { ok: false, reason: `muMu:${info.player_state}` };
    await this.showWindow();
    return { ok: true, shown: true };
  }

  async stop({ graceful = true } = {}) {
    const r = await this.manager(['control', '-v', String(this.index), 'shutdown'], { timeout: 30000 });
    this._stoppedByUs = true;
    return { ok: !!(r && (r.errcode === 0 || r === true)) };
  }

  usage() {
    const info = this._info;
    return {
      total: info && info.disk_size_bytes ? info.disk_size_bytes : 0,
      items: [{ label: 'MuMu instance disk', bytes: info && info.disk_size_bytes ? info.disk_size_bytes : 0 }],
      note: 'MuMu manages its own images; apkstart neither downloads nor cleans them. Uninstall apps from the MuMu interface.',
    };
  }

  dataInfo() {
    const info = this._info;
    return {
      ok: !!(info && info.disk_size_bytes),
      dataMB: info && info.disk_size_bytes ? Math.round(info.disk_size_bytes / (1024 * 1024)) : 0,
      note: 'MuMu manages the data partition; change its size in MuMu settings.',
    };
  }

  dispose() {
    // 绝不因为 ApkStart Quit就关掉用户的模拟器
  }

  diagnose() {
    const loc = this.locate();
    return {
      backend: 'mumu',
      root: loc ? loc.root : '',
      manager: loc ? loc.manager : '',
      adb: loc ? loc.adb : '',
      index: this.index,
      serial: this.serial,
      info: this._info,
    };
  }
}

/** Probe用的辅助: 某个端口是否已经有人监听 (上层用来判断「要不要等」) */
MumuBackend.portAlive = portAlive;

module.exports = { MumuBackend, CANDIDATE_ROOTS };
