'use strict';
/**
 * ApkStart 主进程
 * 职责: 窗口 / 托盘 / 单实例 / 命令行分发 (双击 apk, 桌面快捷方式启动)/ IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, screen, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./core/store');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { drawAppIcon } = require('./core/png');

// 品牌 Logo (build/render-logo.js 生成); 缺失时回退到程序化绘制的旧版图标
const LOGO_DIR = path.join(__dirname, 'ui', 'assets');
const LOGO_FILE = path.join(LOGO_DIR, 'logo.png');
const APPICON_FILE = path.join(LOGO_DIR, 'appicon.ico');
function loadBrandIcon(size) {
  try {
    if (fs.existsSync(LOGO_FILE)) {
      const img = nativeImage.createFromPath(LOGO_FILE);
      return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
    }
  } catch (_) { /* 落到程序化图标 */ }
  return nativeImage.createFromBuffer(drawAppIcon(size || 256));
}

// 托盘用「Small尺寸简化标」: 把 512 主标缩到 16px 会糊成一团，纹理和文字都没了
function loadTrayIcon() {
  try {
    const p = path.join(LOGO_DIR, 'tray-16.png');
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  } catch (_) { /* 回退到程序化图标 */ }
  return nativeImage.createFromBuffer(drawAppIcon(16));
}
const assoc = require('./core/assoc');
const windowctl = require('./core/windowctl');
const display = require('./core/display');
const { WinAgent } = require('./core/agent');
const pointer = require('./core/pointer');
const { KeymapEngine } = require('./core/keymap-engine');
const { PRESETS: KEYMAP_PRESETS } = require('./core/keymap');
const { AppWindow, TITLEBAR_H } = require('./core/appwin');
const { NotifyBridge } = require('./core/notify');
const { AndroidSettings } = require('./core/android');
const { Updater, findUninstaller } = require('./core/updater');
const leftovers = require('./core/leftovers');

// Windows 下窗口被遮挡时 capturePage 会拿到旧帧，Automatic化截图需要禁用遮挡计算
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/**
 * 系统盘快满时，把 Chromium 自己的缓存 (Cache / GPUCache / Local Storage …)
 * 挪到「安卓数据目录」所在的盘。
 * 默认这些缓存写在 %APPDATA%\apkstart 里 —— C 盘只剩几百 MB 时，连启动都可能失败，
 * 而用户往往已经把安卓数据挪到别的盘了，缓存却还在 C 盘上挤。
 * 必须在 app ready 之前Settings，之后改无效。
 */
function relocateUserDataIfCrowded() {
  try {
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(store.DATA_DIR);
    const avd = String(store.getSettings().runtime.avdDir || '').trim();
    if (!avd) return;
    const avdFree = doctor.freeDiskMB(avd);
    if (freeMB >= 2048 || avdFree <= freeMB * 2) return;
    const target = path.join(avd, 'appdata');
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (_) { /* 放不进去就维持默认，不影响启动 */ }
}
relocateUserDataIfCrowded();

// App windows把模拟器以 SetParent 方式嵌进来当子窗口。Chromium 默认用
// DirectComposition 上半透明图层 (Intermediate D3D Window /
// WS_EX_NOREDIRECTIONBITMAP)绘制网页，这层由 DWM 在窗口级别合成，
// 会直接盖住嵌入的子窗口——表现就是"画面全黑但安卓其实在跑"。
// 外壳界面只有一条 38px 标题栏和启动遮罩，走软件合成完全不卡，
// 关掉Hardware acceleration后 Chromium 直接画进 HWND，子窗口层级才真正生效。
// 想对比效果时可以设 APKSTART_HWACCEL=1 启动。
if (process.env.APKSTART_HWACCEL !== '1') app.disableHardwareAcceleration();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

/**
 * 轻量文件logs: 打包后没有控制台，出问题时用户可以把 app.log 发过来。
 * 只记关键节点和异常，正常路径几千行也不会撑爆。
 */
function appLog(line) {
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const limit = store.getSettings().engine.logLimitKB || 2048;
    require('./core/logfile').append(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}`, limit);
  } catch (_) { /* logs失败不能影响主流程 */ }
}
process.on('uncaughtException', (e) => appLog(`UNCAUGHT ${e && (e.stack || e.message)}`));
process.on('unhandledRejection', (e) => appLog(`REJECT ${e && (e.stack || e.message || e)}`));

/**
 * 完整版 (内置Runtime)Automatic接管: 
 * 发行包里 ApkStart.exe 旁边带有 runtime/ (emulator + platform-tools + AEHD + ARM Compatible image)。
 * 首次启动 (settings.json 尚不存在)时直接把 runtime.dir 指向它并开启兼容模式，
 * 用户无需任何下载与Settings，开箱即用。之后用户仍可在Settings里改回在线版。
 */
/**
 * 随安装包带来的Runtime目录 (完整版 exe 旁边的 runtime/, 微软商店 MSIX 的
 * app\resources\runtime)。非空 = 模拟器和镜像都是本地的: 开机动画不该提
 * 「下载」，autoDeploy 也不该联网。
 *
 * 必须在 bootstrapBundledRuntime() 之前声明: 那个函数在模块加载时立刻执行，
 * 用 `let` 声明在它后面会撞上 TDZ (赋值直接抛错，被 catch 吞掉，标志永远为空)。
 */
let bundledRuntimeDir = null;

function bootstrapBundledRuntime() {
  try {
    const exeDir = path.dirname(process.execPath);
    // 便携版把Runtime放在 exe 旁边; electron-builder 的 portable 会把资源解到
    // resources/ 下，进程 exe 和 resources 同级，所以几个候choose位置都看一下。
    const candidates = [
      path.join(exeDir, 'runtime'),
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(process.resourcesPath || '', 'runtime'),
      path.join(process.resourcesPath || '', 'app', 'runtime'),
    ];
    // 内置Runtime只要求「有 emulator + 任意一套完整System images」，不写死 API 版本: 
    // 单文件发行版带的可能是更Small的 AOSP 镜像，写死 API34 会让它误判成没有Runtime。
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // 单文件发行版里的镜像是压缩存放的 (system.img.xz / .gz)，解压在首次启动时做。
            // 这里只认 system.img 会让「包里明明带了镜像」被判成没带，转而去联网下载。
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', 'emulator.exe')) && hasImage(dir));
    if (!bundled) return;

    const s = store.getSettings();
    // 旧版只在 settings.json 不存在时接管: use户先装过在线版再解压完整版，
    // 就会一直走「缺组件」的部署向导。current只要当前Runtimethe folder has no emulator 就接管。
    const explicit = String(s.runtime.dir || '').trim();
    const current = explicit || path.join(store.DATA_DIR, 'runtime');
    const currentExe = path.join(current, 'emulator', 'emulator.exe');
    // 便携版被移动/升级 (解压到新目录)后，settings 里记的还是旧路径: 
    // 必须只认「本次 EXE 所在目录下的 runtime」，否则会一直用旧包里的组件
    //  (实测踩过: 旧包的 emulator 缺 emulator-check → 加速Probe失败 → 退回 TCG Software emulation)。
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // 用户自己挑的目录 (不在 EXE 目录树里，例如 D:\ApkStartRuntime 或别的盘)
    // 一律尊重: 他可能就是为了省 C 盘空间, 或让多个便携版共用一个Runtime。
    // 旧版在这里无条件覆盖成 exe 旁边的 bundled runtime，表现就是
    // 「Settings里改了Runtime数据目录，结果还是下到旧目录 / AppData」 (issue #23)。
    if (explicit && !sameTree && fs.existsSync(currentExe)) {
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // 已有可用Runtime (含在线版)就尊重它: AVD 用户数据就在该目录下，不能悄悄搬走
    if (currentOk) {
      // Runtime就在 EXE 目录树里 = 它是安装包自带的 (完整版 / 商店版)
      bundledRuntimeDir = current;
      // 但仍把Automatic参数Open，旧配置里的硬编码 4G/4核/弃用 GPU 模式不能Continue用
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // 包里带的是 Google Play 镜像才开兼容模式; AOSP 镜像带的是原生 x86_64 库
    let playBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
        }
      }
    } catch (_) { /* 忽略 */ }
    store.saveSettings({
      runtime: { dir: bundled, compatImage: playBundled },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
    bundledRuntimeDir = bundled;
  } catch (_) { /* 接管失败不阻塞启动，走在线引导 */ }
}
bootstrapBundledRuntime();

// 冒烟截图等Automatic化场景下跳过注册表Probe (避免依赖 reg.exe)
const NO_SHELL_PROBE = process.argv.includes('--smoke') || process.env.APKSTART_NO_SHELL_PROBE === '1';
const ICON_PNG = loadBrandIcon().toPNG();

let mainWindow = null;
let tray = null;
let runtime = null;
// 「哪些窗口算我们的」由 whenReady 里赋值 (见 agentScope)。放模块级是因为
// runLaunch / 预热定时器都早于那段代码定义，闭包里的 const 在它们的作用域外看不到。
let armAgent = async () => ({ ok: false });
let installer = null;
let sharer = null;
let quitting = false;
let winAgent = null;
let appWin = null;
let notifier = null;
let androidSet = null;
let updater = null;
let updateBusy = false;
let updateInfo = null;

/**
 * 开机动画窗口的状态放在模块级。
 *
 * 之前是写在 app.whenReady() 的回调里 (const splashWin/splashDone)，而
 * runLaunch() / autoDeploy() 定义在更外层作用域 —— 它们里的
 * `typeof splashDone === 'function'` 永远是 false，于是: 
 *   - 进度文字永远不更新 (一直显示「Preparing…」); 
 *   - 启动成功后 splash 永远不Close，480x360 的 alwaysOnTop 窗口就钉在
 *     屏幕中央, 压在安卓画面上面。
 * 这就是用户反馈的「Open app出现多个窗口」: 管理窗口/splash/App windows同时在场。
 * 提升到模块级之后这些调用才真正生效。
 */
let splashWin = null;
let splashProgress = () => {};
let splashDone = () => {};

// ---------------- 命令行解析 ----------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1).filter((a) => !a.startsWith('--allow-file-access'));
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch') {
      // Electron 会往 argv 里塞自己的开关和 app 路径，只认形如 com.foo.bar 的包名
      const v = args.slice(i + 1).find((x) => x && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(x));
      if (v) { out.launch = v; out.silent = true; }
    } else if (a === '--silent' || a === '--autostart') out.silent = true;
    else if (/\.(apk|xapk|apks)$/i.test(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

/** Chromium 能解 WebP，nativeImage 不能; 用隐藏窗口把 APK 图标转成 PNG */
let decodeWindow = null;
async function decodeIcon(raw) {
  if (!decodeWindow || decodeWindow.isDestroyed()) {
    decodeWindow = new BrowserWindow({ show: false, width: 2, height: 2, skipTaskbar: true });
    await decodeWindow.loadURL('about:blank');
  }
  const mime = /^RIFF/.test(raw.toString('ascii', 0, 4)) ? 'image/webp' : 'image/png';
  const js = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${raw.toString('base64')}';
    await img.decode();
    const s = Math.min(256, Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`;
  const url = await decodeWindow.webContents.executeJavaScript(js);
  return Buffer.from(String(url).split(',')[1] || '', 'base64');
}

/** 开机自启: 默认开启，不需要用户去Settings里勾 */
function applyAutoStart() {
  if (!app.isPackaged) return; // 开发时不写注册表
  const on = !!store.getSettings().autoStart;
  try {
    // 必须显式给 name，否则注册表里的启动项会叫 "electron.app.Electron"
    app.setLoginItemSettings({
      openAtLogin: on,
      name: 'ApkStart',
      path: process.execPath,
      args: ['--autostart'],
    });
    // 清掉旧版本 (没传 name)留下的那条，避免重复启动
    app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  } catch (_) { /* 组策略禁止时忽略 */ }
}

// ---------------- Display mode: 全屏自适应 / Portrait窗口可调 ----------------

function displaySettings() { return store.getSettings().display || {}; }

/**
 * Windows 任务栏 / 通知的身份。
 *
 * 为什么要按App切换: 每个Android app的桌面快捷方式都写了自己的 AUMID
 *  (`RoutineMiku.ApkStart.<包名>`，见 installer.createShortcut)，而且快捷方式的
 * 图标是**那个App自己的图标**。Windows 只有在「运行进程的 AUMID == 快捷方式的
 * AUMID」时，才会把Running的窗口和任务栏固定项合并成同一个按钮, 并沿用快捷方式
 * 的图标。身份对不上就会出现「固定项是App图标, 任务栏上却另起一个 ApkStart 图标」。
 *
 * setAppUserModelId 官方建议只调一次; 实践中对**之后创建**的窗口有效 (VS Code 这类
 * 一个进程跑多个App的壳层就是这么做的)。这里只在开窗口之前切，且全程 try/catch ——
 * 万一某个 Windows 版本忽略它，也只是退化成按 exe 图标显示，不影响功能。
 */
const APP_AUMID = 'RoutineMiku.ApkStart';
function setAumid(id) {
  try { app.setAppUserModelId(String(id || APP_AUMID).slice(0, 128)); } catch (_) { /* 非 Windows 或旧版本忽略 */ }
}

/**
 * 这个App应该用Landscape panel还是Portrait panel？
 *
 * 模拟器的物理面板 (hw.lcd)是画面的「真实形状」，Android 不会为了
 * 一个跟面板方向不一致的App去旋转整块面板 —— 它只会给App一个信箱式的
 * 中间窄条，两侧留黑。所以「铺满窗口」的唯一出路是: 面板方向 = App方向。
 *
 * 优先级: Settings里的强制模式 > 单个App的手动覆盖 > APK 清单解析出的天然方向
 * > Current panel orientation (App声明跟随重力时不折腾重启)。
 */
function wantLandscapeFor(pkg) {
  const ds = displaySettings();
  const mode = ds.orientationMode || 'auto';
  if (mode === 'landscape') return true;
  if (mode === 'portrait') return false;
  const app = pkg ? store.getApp(pkg) : null;
  const override = app && app.orientationOverride;
  if (override === 'landscape') return true;
  if (override === 'portrait') return false;
  const natural = app && app.orientation;
  if (natural === 'landscape') return true;
  if (natural === 'portrait') return false;
  return !!ds.landscape;
}

/**
 * 运行期「学习」App真正的方向。
 *
 * 离线解析 AndroidManifest 对红果这类App够用 (几十个 Activity 写死 portrait)，
 * 但有的App全部声明成 sensor / fullSensor，清单里看不出倾向。这种就等它真的
 * 跑起来后问安卓自己要了一次 (ActivityRecord 的 requestedOrientation 是系统
 * 按App实际请求算出来的最终值)。学到之后写进 apps.json，下次启动就能choose对面板。
 */
async function learnAppOrientation(pkg) {
  const app = store.getApp(pkg);
  if (!app || app.orientation || app.orientationOverride) return null;
  let out = '';
  try {
    out = await runtime.client().shell(
      'dumpsys activity activities | grep -m1 requestedOrientation', { timeout: 8000 });
  } catch (_) { return null; }
  const s = String(out || '');
  let value = null;
  if (/requestedOrientation=SCREEN_ORIENTATION_(PORTRAIT|SENSOR_PORTRAIT|REVERSE_PORTRAIT|USER_PORTRAIT)/.test(s)) value = 'portrait';
  else if (/requestedOrientation=SCREEN_ORIENTATION_(LANDSCAPE|SENSOR_LANDSCAPE|REVERSE_LANDSCAPE|USER_LANDSCAPE)/.test(s)) value = 'landscape';
  if (!value) return null;
  store.upsertApp({ package: pkg, orientation: value });
  appLog(`learned orientation ${pkg} = ${value}`);
  return value;
}

function screenRect() {
  const d = screen.getPrimaryDisplay();
  const a = d.workArea || d.bounds;
  return { x: a.x || 0, y: a.y || 0, w: a.width || 1920, h: a.height || 1080 };
}

let currentAppPkg = null;
let wheelRouter = null;
const deviceSize = { value: null };

/** 滚轮注入需要知道 Android 侧分辨率; 缓存一次，转屏/重启Runtime后失效 */
async function getDeviceSize() {
  if (deviceSize.value) return deviceSize.value;
  try { deviceSize.value = await runtime.client().wmSize(); } catch (_) { /* Runtime还没起来 */ }
  if (!deviceSize.value || !deviceSize.value.width || !deviceSize.value.height) {
    const p = portraitSize();
    deviceSize.value = { width: p.w, height: p.h };
  }
  return deviceSize.value;
}

function portraitSize() {
  const d = displaySettings();
  return display.portraitSize(d.portrait || '540x960');
}

/** Settings页改动Mouse buttons后，立刻按当前窗口焦点同步一次钩子配置 */
function refreshPointerMapping() {
  if (appWin && appWin.isOpen) appWin.refreshPointer();
  else if (winAgent && winAgent.hooked) winAgent.setHook(false).catch(() => {});
}

/**
 * 旋转 = 换物理面板尺寸并重启模拟器。
 *
 * 这是唯一能得到「正立 + 铺满」Landscape的方式 (三种错路都踩过): 
 *   - wm size: 只改逻辑分辨率，物理 LCD 仍是竖的 -> 画面躺倒 90°, 只占左上角一条; 
 *   - wm density: framebuffer 尺寸不变 -> 画面不铺满，Maximize后右侧一Large片空白; 
 *   - adb emu rotate: 只转画面内容，系统里还是Portrait。
 * 只有把 hw.lcd.width/height 换成Landscape并重启，Qt 才会按Landscape panel开窗口, 画面正立铺满。
 */
async function restartForOrientation(landscape, { reloadApp = true } = {}) {
  if (!appWin || !appWin.isOpen) return false;
  const pkg = appWin.pkg;
  store.saveSettings({ display: { landscape: !!landscape } });
  send('runtime:log', landscape ? 'Switching to landscape: restarting the Android runtime…' : 'Switching back to portrait: restarting the Android runtime…');
  try {
    // 先把嵌入窗口摘下来，避免重启过程中在桌面留下黑窗
    try { await appWin.agent.detach(); } catch (_) { /* ignore */ }
    await runtime.stop({ graceful: false }).catch(() => {});
    appLog(`rotate -> landscape=${landscape} restarting runtime`);
    const rt = await runtime.ensure({
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
    });
    if (!rt || !rt.ok) return false;
    await runtime.waitForNetwork({ onLog: () => {}, timeoutMs: 25000 }).catch(() => null);
    // reloadApp=false: 调用方 (runLaunch)自己会把App拉起来，这里别抢着做一遍
    if (reloadApp && pkg) {
      const app = store.getApp(pkg);
      if (app) {
        await rt.client.install(app.apkPath).catch(() => {});
        await rt.client.startApp(app.package, app.activity, {}).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1500));
      await attachAppWindow();
      appWin.scheduleFit(6);
    }
    // 返回新的 rt: beforeStart 拿到后会替换掉旧的 (旧 client 已随 stop 失效)
    return rt;
  } catch (e) {
    appLog(`rotate restart failed: ${e && e.message}`);
    return false;
  }
}

/**
 * 把安卓画面接到用户眼前。两种模式: 
 *   - 嵌入 (默认): SetParent 进我们自己的窗口，观感统一; 
 *   - 独立窗口: 让模拟器开原生窗口，绕开嵌入固有的一整串问题
 *      (黑边, 坐标错位, 铺不满, Qt 面板方向打架)。由Settings display.windowEmbed 控制。
 */
async function attachAppWindow() {
  if (!appWin || !appWin.isOpen) return false;
  const embedMode = displaySettings().windowEmbed !== false;
  if (!embedMode) {
    // 独立窗口不需要标题栏里那块区域了，直接让模拟器窗口自己露出来
    return appWin.openDetached().catch(() => false);
  }
  const ok = await appWin.embed().catch(() => false);
  if (!ok) {
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 1500);
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 4000);
  }
  return ok;
}

/**
 * Open (或复用)那个「一个App一个干净窗口」。
 *
 * 切换App时必须先把**上一个**App真正关掉，否则会出现用户反馈的
 * 「点开第二个App，第一个没响应 / ANR」: 
 *   - appWin.open() 里对旧窗口用的是 close({keepApp:true})，它只收窗口, 
 *     **不调 endApp**，于是旧App进程既没被 force-stop，也留在
 *     runtime._activeApps 里; 
 *   - 新App beginApp 时 `first = _activeApps.size === 0` 因此判断错误，
 *     优先级 / 快照逻辑全乱; 
 *   - 两个App同时抢同一个模拟器的前台 → 旧的卡死弹 ANR。
 * 所以这里先 await 把旧App停干净，再开新窗口。
 */
async function openAppWindow(pkg, tip) {
  // 只有「切到另一个App」才需要关旧的; 重复点同一个走复用路径，不打断。
  if (currentAppPkg && currentAppPkg !== pkg && appWin && appWin.isOpen) {
    const prev = currentAppPkg;
    try {
      // 先摘画面再停进程: 独立窗口模式下模拟器原生窗口是用户正看着的那扇，
      // park 把它藏好，避免销毁宿主时在桌面留下黑窗。
      await appWin.close({ keepApp: true });
      await runtime.endApp(prev, { onIdle: onContainerActive }).catch(() => {});
      appLog(`switch: closed ${prev} before launching ${pkg}`);
    } catch (e) {
      appLog(`switch close ${prev} failed: ${e && e.message}`);
    }
  } else if (currentAppPkg && currentAppPkg !== pkg) {
    // 窗口已经不在了，但进程可能还挂在 _activeApps 里，同样要收尾。
    await runtime.endApp(currentAppPkg).catch(() => {});
  }
  const rec = store.getApp(pkg);
  const land = wantLandscapeFor(pkg);
  const p0 = portraitSize();
  const detached = displaySettings().windowEmbed === false;
  // 面板方向和App方向不一致 → beforeStart 会重启一次Runtime (约 40 秒)。
  const willRestart = land !== !!displaySettings().landscape;
  // 独立窗口模式下壳窗口平时不显示，但**等待期间**必须给用户一个可见的交代: 
  //   - 有开机动画 (首次启动)时由动画负责; 
  //   - 没有动画 (切换App)时必须把壳窗口显示出来，否则桌面上 40 秒什么都没有，
  //     用户会以为程序崩了。
  const splashVisible = !!(splashWin && !splashWin.isDestroyed());
  const label = (rec && rec.label) || pkg;
  // 先把这个App的身份切过去，再开窗口: 任务栏才会沿用快捷方式里那个App的图标
  setAumid(`${APP_AUMID}.${pkg}`);
  appWin.open({
    pkg,
    label,
    iconPath: rec && rec.icoPath,
    // Landscape时窗口按横比例开，否则竖窗口里塞横画面会留出Large片黑边
    portrait: land ? { w: p0.h, h: p0.w } : p0,
    // 全屏有两种来路: 显式choose了「全屏」模式，或者勾了「启动时Auto full screen」。
    // 后者以前是个死开关 (只在默认Settings里声明，没有任何代码读它)，这里补上。
    fullscreen: displaySettings().mode === 'fullscreen'
      || displaySettings().autoFullscreenOnLaunch === true,
    detached,
    showWhileWaiting: detached && !splashVisible,
  });
  appWin.setIcon(rec && rec.icoPath);
  // Open时按Saved的方向初始化 (物理面板方向在 doctor.lcdFor 里决定)
  appWin.setState({
    // 需要重启换面板时，直接把「为什么慢」写在提示里，别让用户对着 40 秒空屏猜
    tip: willRestart
      ? `Switching ${String(label).slice(0, 20)} to ${land ? 'landscape' : 'portrait'} (restarting the Android environment, about 40 seconds, only once)…`
      : (tip || 'Starting the Android runtime…'),
    ready: false,
    landscape: land,
  });
  currentAppPkg = pkg;
}

async function toggleDisplayMode() {
  const next = store.saveSettings({
    display: { mode: displaySettings().mode === 'fullscreen' ? 'window' : 'fullscreen' },
  });
  const full = next.display.mode === 'fullscreen';
  if (appWin && appWin.isOpen) {
    // 独立窗口模式下画面在模拟器原生窗口里，maximize 壳窗口毫无视觉效果，
    // 走 appWin.toggleMaximize 才会把模拟器窗口铺满/还原。
    if (displaySettings().windowEmbed === false) {
      appWin.toggleMaximize().catch(() => {});
    } else if (full) appWin.win.maximize();
    else appWin.win.unmaximize();
    appWin.scheduleFit(6);
    // 注意: 这里**不再**顺手把面板方向也切了。
    // 全屏和Landscape是两件事: 面板方向current由「App自己声明的方向」决定
    //  (见 wantLandscapeFor)。以前 F11 会连带重启Runtime切Landscape，结果PortraitApp
    // 被塞进Landscape panel → 两侧黑边 → 用户以为「全屏没生效」。
  }
  return next.display.mode;
}

/** 首次运行把 adb / emulator / System images一次装完，不再分 1~5 步 */
let deploying = false;
async function autoDeploy({ force = false } = {}) {
  if (deploying || !store.getSettings().autoDeploy) return { ok: false, error: 'skipped' };
  // 下载失败冷却: 以前只要 checkEnv() 还缺组件，每次启动 ApkStart 都会重新
  // 拉一遍 1.5GB 的Runtime包，用户看到的就是「一直重复下载」。
  // 失败后记一个时间戳，30 分钟内不再Automatic重试; 用户手动点「一键部署」时
  // force=true 可以立刻重试。成功或人为强制都清掉冷却。
  const COOLDOWN_MS = 30 * 60 * 1000;
  const lastFail = Number(store.getSettings().runtime.deployFailedAt || 0);
  if (!force && lastFail && Date.now() - lastFail < COOLDOWN_MS) {
    appLog(`autoDeploy cooling down (last failure at ${new Date(lastFail).toISOString()}), skipping the automatic retry`);
    return { ok: false, error: 'cooldown', cooldown: true, until: lastFail + COOLDOWN_MS };
  }
  deploying = true;
  const progress = (p) => {
    send('provision:progress', { ...p, component: p.component || 'all' });
    // 同步推送到开机动画窗口
    if (typeof splashProgress === 'function') splashProgress(p);
  };
  let succeeded = false;
  try {
    const env = await runtime.provisioner.checkEnv();
    const needEngine = !env.emulator.ok || !env.sysimg.ok;
    // 随包自带Runtime (完整版安装包 / 微软商店版): **一律不联网**。
    // 镜像已经在包里 (压缩形态)，第一次开机由 engine.ensure() 就地展开; 
    // 这里再下一套 1.5GB 纯属浪费，也正是用户抱怨的「装完还在下镜像」。
    if (bundledRuntimeDir && env.adb.ok && env.emulator.ok && env.sysimg.ok) {
      appLog(`autoDeploy skipped: the runtime is bundled (${bundledRuntimeDir}), no network needed`
        + (env.needsExtract ? ', the image expands locally on first boot' : ''));
      return { ok: true, source: 'bundled', needsExtract: !!env.needsExtract };
    }
    if (bundledRuntimeDir && !env.emulator.ok) {
      appLog(`autoDeploy skipping the network download: the runtime directory is bundled (${bundledRuntimeDir}), handing over to diagnostics`);
      return { ok: false, error: 'bundled', bundled: true };
    }
    // 轻量版优先用「本项目 GitHub 的Runtime full package」: 一个文件搞定 emulator + System images，
    // 下载源和更新源统一在 GitHub 上 (国内比 dl.google.com 稳得多)。
    // 整包拿不到 (没网 / 还没发过该资产 / 被限流)再逐个从官方源装。
    if (needEngine && store.getSettings().runtime.preferGithubRuntime !== false) {
      try {
        progress({ message: 'Downloading the runtime from GitHub…' });
        await runtime.provisioner.installRuntimePack(progress);
        const afterPack = await runtime.provisioner.checkEnv();
        if (afterPack.emulator.ok && afterPack.sysimg.ok) {
          succeeded = true;
          return { ok: true, source: 'github' };
        }
        progress({ message: 'The runtime package is incomplete, filling it in from the official source…' });
      } catch (e) {
        progress({ message: `GitHub runtime unavailable (${e.message}), switching to the official source…` });
      }
    }
    if (!env.adb.ok) {
      progress({ message: 'Preparing adb…' });
      await runtime.provisioner.installAdb(progress);
    }
    if (!env.emulator.ok) {
      progress({ message: 'Preparing the Android runtime…' });
      await runtime.provisioner.installEmulator(progress);
    }
    if (!env.sysimg.ok) {
      progress({ message: 'Preparing the Android system image…' });
      await runtime.provisioner.installSystemImage(progress);
    }
    const after = await runtime.provisioner.checkEnv();
    succeeded = !!(after.adb.ok && after.emulator.ok && after.sysimg.ok);
    return { ok: succeeded };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // 只有「真失败」才进冷却; 部署成功要把旧失败记录清掉。
    try {
      store.saveSettings({ runtime: { deployFailedAt: succeeded ? 0 : Date.now() } });
    } catch (_) { /* Settings写不进去不影响本次结果 */ }
    deploying = false;
  }
}

function launcherInfo() {
  if (app.isPackaged) {
    return { target: process.execPath, args: '', cwd: path.dirname(process.execPath) };
  }
  return { target: process.execPath, args: `"${APP_ROOT}"`, cwd: APP_ROOT };
}

/** 递归复制目录内容 (best-effort，不删源; 用于共享目录改路径时一次性搬迁旧文件) */
function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) copyDirContents(s, d);
      else fs.copyFileSync(s, d);
    } catch (_) { /* 单文件失败不影响其余 */ }
  }
}

/** 以管理员权限启用一个 Windows 可choose功能 (如 VirtualMachinePlatform / HypervisorPlatform) */
/**
 * 提权开启一个 Windows 可choose功能。
 *
 * 返回 { ok, cancelled, code, feature }: 
 *   cancelled 用 1223 (ERROR_CANCELLED)区分「用户在 UAC 里点了否」和「真的失败」——
 *   以前两者都是 ok:false，UI 只能笼统说「Could not enable it」，用户完全不知道自己点了Cancel。
 */
function enableWindowsFeature(feature) {
  return new Promise((resolve) => {
    const inner = `Enable-WindowsOptionalFeature -Online -FeatureName '${feature}' -NoRestart -All`;
    const ps = `try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru `
      + `-ArgumentList @('-NoProfile','-NonInteractive','-Command',${JSON.stringify(inner)}); exit $p.ExitCode } `
      + 'catch { exit 1223 }';
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('exit', (code) => resolve({
      ok: code === 0, cancelled: code === 1223, restart: true, code, feature,
    }));
    proc.on('error', () => resolve({ ok: false, feature, error: 'Could not start PowerShell' }));
  });
}

/**
 * 开启系统自带的 WHPX (Windows Hypervisor Platform)。
 *
 * 注意: 真正让 Android 模拟器用上 WHPX 的功能叫
 * **「Windows 虚拟机监控程序平台」(HypervisorPlatform)**; 
 * 「虚拟机平台」(VirtualMachinePlatform) 是 WSL2 用的，单独开它 WHPX 仍然不可用。
 * 两个都开一次，覆盖不同机器上的差异 (顺序上先开真正需要的那个)。
 *
 * 也不再拿 WinHvPlatform.dll 是否存在当开关: 那个 DLL 在现代 Windows 上本来就在
 *  (实测本机 WinHvPlatform.dll 存在，但跑的是 AEHD)——用它判断「能不能开 WHPX」
 * 只会把真正需要开的机器挡在门外。
 */
async function enableWhpxFeatures() {
  const steps = [];
  for (const f of ['HypervisorPlatform', 'VirtualMachinePlatform']) {
    // eslint-disable-next-line no-await-in-loop
    steps.push(await enableWindowsFeature(f));
  }
  return { ok: steps.some((s) => s.ok), cancelled: steps.every((s) => s.cancelled), steps };
}

/** 商店版专用的手动引导文案: MSIX 包固定 mediumIL，提权通常拿不到 */
const MSIX_ACCEL_HINT = 'Store builds cannot elevate themselves. Enable it manually once:'
  + 'Press Win+R → type optionalfeatures → tick Windows Hypervisor Platform'
  + '(HypervisorPlatform, the one WHPX actually needs), then restart the PC.';

// ---------------- 主窗口 ----------------

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: Number(process.env.APKSTART_WIN_W) || 1140,
    height: Number(process.env.APKSTART_WIN_H) || 740,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f8fa', symbolColor: '#2b3138', height: 44 },
    icon: nativeImage.createFromBuffer(ICON_PNG),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());

  // 冒烟测试时把渲染进程的报错打到 stdout: 界面空白, 按钮点了没反应，
  // 十有八九是 app.js 里某个 id 改动后抛了异常，正常运行看不到。
  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${message} (${String(source).split('/').pop()}:${line})`);
    });
  }

  // 外链一律交给系统Browse器 (公众号/GitHub 等)，绝不把App windows导航走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    notify('ApkStart is still running in the background', 'Click the tray icon to reopen it; right-click the tray icon to quit.');
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

function showWindow() {
  // 回到管理窗口 = 回到 ApkStart 自己的身份 (不然任务栏会沿用上一个App的图标)
  setAumid(APP_AUMID);
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title, body) {
  if (store.getSettings().notifyOnInstall === false) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: nativeImage.createFromBuffer(ICON_PNG) }).show();
  } catch (_) { /* ignore */ }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------- 托盘 ----------------

function buildTray() {
  const icon = loadTrayIcon();
  try {
    tray = new Tray(icon);
  } catch (_) {
    return;
  }
  const refresh = () => {
    const apps = store.getApps().slice(0, 8);
    // 独立窗口模式主界面是隐藏的，托盘就成了唯一随时reachable的入口 ——
    // 「Close current app」必须放这里，否则用户根本没法关掉正在跑的App。
    // 判断「有没有App在跑」要同时看 currentAppPkg 和 runtime.activeApps: 
    // endApp 会从 activeApps 里删掉包名，所以关掉后这里Automatic变 false。
    // 但 currentAppPkg 可能还指着上一个App (endApp 不清它)，所以要双重判断。
    const hasRunning = currentAppPkg && runtime && runtime.activeApps
      ? runtime.activeApps.includes(currentAppPkg)
      : false;
    const runningLabel = currentAppPkg
      ? ((store.getApp(currentAppPkg) || {}).label || currentAppPkg)
      : '';
    const menu = Menu.buildFromTemplate([
      { label: 'Open ApkStart', click: () => showWindow() },
      { type: 'separator' },
      ...(apps.length
        ? apps.map((a) => ({ label: a.label, click: () => runLaunch(a.package) }))
        : [{ label: 'No apps installed yet', enabled: false }]),
      { type: 'separator' },
      {
        label: hasRunning ? `Close the current app (${runningLabel})` : 'Close current app',
        enabled: !!hasRunning,
        click: () => {
          const pkg = currentAppPkg;
          if (!pkg) return;
          // 复用 app:stop 的同一条路径，不在两处写同样的逻辑
          stopApp(pkg).then(() => refresh());
        },
      },
      {
        label: displaySettings().landscape ? 'Switch back to portrait (runtime restart needed)' : 'Switch to landscape (runtime restart needed)',
        enabled: !!currentAppPkg,
        click: () => { restartForOrientation(!displaySettings().landscape).catch(() => {}); },
      },
      {
        label: displaySettings().mode === 'fullscreen' ? 'Switch back to portrait window' : 'Fullscreen (adapts to the screen)',
        click: () => { toggleDisplayMode(); },
      },
      { label: 'Rebuild desktop/Start Menu shortcuts', click: () => { installer.ensureShortcuts().catch(() => {}); } },
      { label: 'Sync shared folder', click: () => sharer.sync() },
      { label: 'Settings', click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      {
        label: updateInfo && updateInfo.hasUpdate ? `New version ${updateInfo.tag}` : 'Check for updates',
        click: async () => {
          showWindow();
          send('ui:navigate', 'settings');
          const info = await updater.check().catch(() => null);
          if (info) { updateInfo = info; send('update:state', info); }
          if (info && info.hasUpdate && info.asset) {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
              type: 'question',
              title: 'New version available',
              message: `ApkStart ${info.tag} has been released, you are on v${app.getVersion()}. Update now?`,
              detail: (info.notes || '').slice(0, 600),
              buttons: ['Update now', 'Later'],
              defaultId: 0,
              cancelId: 1,
            });
            if (r.response === 0) runUpdate();
          } else if (info && !info.hasUpdate) {
            notify('You are on the latest version', `ApkStart v${app.getVersion()}`);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: async () => {
          try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip('ApkStart — Android app runner');
  // Windows 托盘的惯例是单击就Open主窗口 (双击当然也可以)。
  // 之前只绑了 double-click，用户单击没反应，会以为托盘图标坏了。
  // 右键才出菜单，所以这里单击直接 showWindow 不会和菜单冲突。
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  refresh();
  setInterval(refresh, 5000).unref?.();
}

// ---------------- 核心动作 ----------------

let installBusy = null;   // 正在安装的文件路径: 双击 APK 连点会走 second-instance，不能并发装
let lastInstallErr = { msg: '', at: 0 };

async function runInstall(filePath) {
  showWindow();
  // 同一个包正在装 (用户连点了几次图标 / 拖了好几次)→ 只提示一次，别重复跑一遍安装
  if (installBusy) {
    if (installBusy === filePath) {
      send('toast', { type: 'info', message: 'This APK is already installing, please wait…' });
      return { ok: false, error: 'Installing' };
    }
    send('toast', { type: 'info', message: 'Another installation is running, wait for it to finish.' });
    return { ok: false, error: 'An installation is already running' };
  }
  installBusy = filePath;
  send('install:start', { file: filePath });
  try {
    const result = await installer.install(filePath, (p) => send('install:progress', p));
    send('install:done', result);
    // 新建的桌面图标要让资源管理器立刻Refresh，否则用户会以为「没创建快捷方式」
    windowctl.refreshShell().catch(() => {});
    notify('Installed', `${result.app.label} installed${result.app.shortcutPath ? ', desktop shortcut created' : ''}`);
    return result;
  } catch (e) {
    send('install:error', { message: e.message, file: filePath });
    if (e.needsSetup) send('ui:navigate', 'setup');
    // 同一条错误 8 秒内只弹一次系统通知: 连续重试时不会在右下角刷屏
    const now = Date.now();
    if (e.message !== lastInstallErr.msg || now - lastInstallErr.at > 8000) {
      lastInstallErr = { msg: e.message, at: now };
      // 窗口在前台时用户已经看到界面里的提示，不必再弹系统通知
      if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        notify('Installation failed', e.message.slice(0, 120));
      }
    }
    throw e;
  } finally {
    installBusy = null;
  }
}

/**
 * 下载并安装新版本，然后由 update-apply 脚本接管「替换 + 重启」。
 * 界面与托盘菜单共用这一条路径。
 */
async function runUpdate() {
  if (updateBusy) return { ok: false, error: 'Updating' };
  // 商店 (MSIX)版不能自更新: 安装目录 C:\Program Files\WindowsApps 是只读的，
  // 覆盖 exe 不仅会失败，还可能让包完整性校验失效, App直接起不来。
  // 更新走 Microsoft Store (ms-windows-store: 协议)。
  if (store.STORE_BUILD) {
    shell.openExternal('ms-windows-store://downloadsandupdates').catch(() => {});
    return { ok: false, error: 'Store builds update through Microsoft Store; opened Downloads and updates', manual: true };
  }
  updateBusy = true;
  const sendProgress = (p) => send('update:progress', p);
  try {
    const info = updateInfo && updateInfo.hasUpdate ? updateInfo : await updater.check();
    updateInfo = info;
    if (!info.hasUpdate) return { ok: false, error: 'Already up to date' };
    if (!info.asset) {
      shell.openExternal(info.htmlUrl || Updater.repoUrl()).catch(() => {});
      return { ok: false, error: 'This release has no installable package, the GitHub release page was opened', manual: true };
    }
    sendProgress({ stage: 'download', percent: 0, message: 'Preparing download…' });
    const job = await updater.prepare(info);
    sendProgress({ stage: 'apply', percent: 100, message: 'Replacing the program and restarting…' });
    updater.apply(job);
    // 给界面一点时间显示「即将重启」，然后走exited normally流程 (before-quit 会把模拟器窗口藏好)
    setTimeout(() => { quitting = true; app.quit(); }, 900);
    return { ok: true, version: info.version, mode: job.mode };
  } catch (e) {
    sendProgress({ stage: 'error', percent: 0, message: e.message });
    return { ok: false, error: e.message };
  } finally {
    updateBusy = false;
  }
}

/**
 * 启动串行化。
 *
 * 一次启动最长要 80 秒 (换面板重启 + cold boot)。这期间用户完全可能再点一个App, 
 * 或者双击同一个图标两次, 或者托盘菜单里点一下 —— 以前这些都会真的并发跑第二遍: 
 * openAppWindow 会把正在启动的那个App关掉 (close + endApp)，而虚拟机正在重启，
 * 结果两边一起失败，logs里是 `cmd: Can't find service: activity` / `device not found`，
 * 用户看到的是「点了没反应，然后弹回主界面」。
 *
 * current: 同一个App → 直接复用进行中的那次 (连点等于一次); 换App → 等前一次
 * 收尾再开始，而不是把它的Runtime抽走。
 */
let launchInFlight = null;
// 「Software emulation」提醒每个进程只弹一次，避免每次切App都来一条系统通知
let accelWarned = false;

async function runLaunch(pkg) {
  if (launchInFlight) {
    if (launchInFlight.pkg === pkg) {
      appLog(`launch reused in-flight ${pkg}`);
      return launchInFlight.promise;
    }
    appLog(`launch queued ${pkg} (waiting for ${launchInFlight.pkg} to finish launching)`);
    await launchInFlight.promise.catch(() => {});
  }
  const entry = { pkg };
  entry.promise = launchOne(pkg).finally(() => {
    if (launchInFlight === entry) launchInFlight = null;
  });
  launchInFlight = entry;
  return entry.promise;
}

async function launchOne(pkg) {
  const t0 = Date.now();
  const mark = (s) => appLog(`launch ${pkg} ${s} +${Date.now() - t0}ms`);
  // 「提前接画面」的状态: 进程一出现就接，但最终成败要等回调回来才知道。
  // 放在函数作用域，供后面的最终判定使用。
  let attachDoneEarly = false;
  let earlyAttachOk = false;
  appLog(`launch start ${pkg}`);
  try {
    // 0) 先把管理窗口收起来，再去开App windows。
    // 顺序很重要: 以前是 openAppWindow() 之后, armAgent() 之后才 hide()，
    // 而 armAgent 要等窗口代理cold boot (300~600ms)，这段里「管理窗口 +
    // App windows(+ 开机动画)」是同时在屏幕上的 —— 用户看到的就是多个窗口乱飞。
    if (mainWindow && mainWindow.isVisible() && !IS_DEV) mainWindow.hide();
    // 1) 再把「App windows」Open显示启动动画: 整个过程看不到安卓桌面，也看不到模拟器窗口
    await openAppWindow(pkg, 'Starting the Android runtime…');
    // 开机阶段把模拟器主窗 + qemu / netsimd 的控制台黑窗藏起来，避免任何闪现。
    // 压制是常驻的 (embed 后它会Automatic跳过被嵌入的那一个窗口，见 appwin.embed)。
    // 这里必须 await: 不等压制生效就往下走，黑窗会在启动瞬间露出来。
    if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }

    const r = await installer.launch(pkg, {
      onLog: (m) => {
        send('runtime:log', m); appLog(`  rt ${m}`);
        // 同步到开机动画
        if (typeof splashProgress === 'function') splashProgress({ message: m });
      },
      onMark: mark,
      // App进程一出现就把画面接上去，不等后面那 4 秒的「OK不会崩」观察期。
      // 那 4 秒对稳定性有意义，但用户看到的是「点了没反应」; 先让他看到App在加载，
      // 观感差别很Large (实测点开到出画面 7.2s → 约 3s)。
      // 这里故意不 await: 接画面和存活判定并行，谁先Finish都不影响另一边。
      onAppUp: () => {
        attachDoneEarly = true;
        mark('app up (attaching the screen early)');
        attachAppWindow()
          .then((ok) => {
            earlyAttachOk = ok;
            mark(`early attach=${ok}`);
            // 画面已接到用户眼前 → 开机动画可以淡出了。
            // 放在这里而不是 launch ok 之后，是因为 early attach 时模拟器窗口
            // 已经 show 出来了; 如果等 launch ok (还要再等 4 秒存活OK)，
            // splash 和模拟器窗口会同时可见好几秒，用户看到 splash 被「顶上去」。
            if (ok && typeof splashDone === 'function') splashDone();
          })
          .catch(() => { earlyAttachOk = false; });
        // App刚起来时 Activity 还在重建，会按自己声明的方向 (portrait)再转一次，
        // 把刚锁好的方向覆盖掉 —— 这就是「平板/Landscape模式下画面总是 90 度躺着」。
        // 等它稳定后补一次方向自愈 (读 init/cur，只有真躺倒才写)。
        setTimeout(() => {
          runtime._healOrientation?.().catch(() => {});
          // 顺带记下这个App真正的方向 (清单里全是 sensor 的App只能这样学)
          learnAppOrientation(pkg).catch(() => {});
        }, 1800);
      },
      // 启动前先把面板方向校正到Settings要求的那个。
      // Landscape只能靠物理面板 (hw.lcd.width/height 互换)+ 重启实现，而这一项是在
      // 开机时写进 config.ini 的。如果用户改了「Landscape」Settings, 但虚拟机还以Portrait panel
      // 跑着 (预热的场景很常见)，光靠 wm size / wm user-rotation 只会让画面躺倒。
      // 所以这里发现不一致就先重启一次，reloadApp=false 让下面照常启动App。
      beforeStart: async (rt) => {
        mark('engine ready');
        // 面板方向必须和App自己的声明方向一致，否则 Android 只会给一个信箱式
        // 窄条 (两侧全黑)。wantLandscapeFor 会把「Settings里的强制模式 / 单App覆盖 /
        // APK 清单解析出的方向」合起来算，见函数注释。
        const wantLand = wantLandscapeFor(pkg);
        const cur = runtime.emulator && typeof runtime.emulator.panelLandscape === 'function'
          ? runtime.emulator.panelLandscape()
          : null;
        if (cur !== null && cur !== wantLand) {
          mark(`orientation mismatch (panel=${cur ? 'landscape' : 'portrait'}, want=${wantLand}), restarting to correct`);
          appWin.setState({ tip: wantLand ? 'Switching to landscape…' : 'Switching to portrait…' });
          // restartForOrientation 重启Runtime后返回新的 rt (旧 client 已失效)。
          // 把它返回给 installer.launch，后续的 resetDisplayOverrides / startApp
          // 都用新 client，否则全部静默失败 (catch 吞掉，App起不来画面)。
          const newRt = await restartForOrientation(wantLand, { reloadApp: false }).catch(() => null);
          mark('orientation fixed');
          if (newRt && newRt.ok) return newRt;
        }
        appWin.setState({ tip: 'Opening the app…' });
        // 沉浸式 + 关动画 + 收起锁屏: 只做一次，之后每次启动都秒进
        await rt.client.prepareForeground().catch(() => {});
        mark('foreground ready');
        // 没有重启就返回 null (installer 用原来的 rt)
        return null;
      },
    });
    mark('app started');

    // 2) App真的活下来了，才把画面接到用户眼前 (否则用户会看到闪一下的桌面/崩溃页)
    // 但如果 onAppUp 已经把画面接上了 (提前接管)，这里只做一次「OK」，不重复接 ——
    // 重复接在独立窗口模式下会把刚摆好的窗口再隐藏/显示一遍，画面会闪。
    let embedded;
    if (attachDoneEarly) {
      embedded = !!earlyAttachOk;
      mark(`early attached already (${embedded})`);
    } else {
      embedded = await attachAppWindow();
    }
    // logs措辞要分清两种模式: 独立窗口模式下 embedded=true 的意思是
    // 「画面已经接到用户眼前 (在模拟器原生窗口里)」，而不是「嵌进我们的窗口」。
    // 否则看logs的人会以为Settings没生效。
    const attachMode = displaySettings().windowEmbed === false ? 'detached' : 'embed';
    if (!embedded) appLog(`attach failed (${attachMode}): ${appWin.lastEmbedError || 'unknown'}`);
    mark(`${attachMode}=${embedded}`);
    // 嵌入Finish后把窗口从别的窗口底下抬出来。否则上层窗口 (Browse器等)会盖住安卓画面，
    // 用户看到的是「黑屏 / 画面没填满」，鼠标也点不到App (全被上层窗口吃掉)。
    // 短暂 topmost 再立刻撤销，只借用一次置顶把 Z 序抬到最前，不会长期霸占顶层。
    // 独立窗口模式跳过: 那时画面在模拟器自己的窗口里，把空壳窗口显示出来只会挡住它。
    const detachedMode = displaySettings().windowEmbed === false;
    if (appWin.isOpen && !detachedMode) {
      try {
        appWin.win.show();
        appWin.win.setAlwaysOnTop(true);
        appWin.win.moveTop();
        appWin.win.focus();
        setTimeout(() => {
          if (appWin.isOpen) {
            try { appWin.win.setAlwaysOnTop(false); } catch (_) { /* 窗口已关 */ }
          }
        }, 700);
      } catch (_) { /* 窗口可能刚Close */ }
    }
    appWin.setState({ ready: true, tip: '' });
    // 容器会话: 环境已经Ready，这里只做「按App裁剪 + Open后台轮询」，
    // 不再为这个 App 重新引导一遍 Android。Mouse buttons钩子由窗口 focus 事件
    // 按Settings决定，失焦即Uninstall。
    deviceSize.value = null;
    appWin.refreshPointer();
    await runtime.beginApp(pkg, { onActive: onContainerActive }).catch(() => {});
    // 游戏/低延迟模式: 让窗口代理降频扫描，减少全桌面 EnumWindows 造成的整机卡顿
    if (winAgent) {
      const game = store.getSettings().engine?.priorityMode === 'game';
      winAgent.setPerformanceMode(game).catch(() => {});
    }
    send('app:launched', { package: pkg, engine: r.engine });
    appLog(`launch ok ${pkg} ${attachMode}=${embedded}`);
    // Software emulation下第一次启动App时提醒一次: 这时候用户已经开始等了，横幅/自检项
    // 都在Settings里，很可能压根没看到。系统通知能盖在App windows上面，是最有效的告知点。
    if (!accelWarned) {
      runtime.provisioner.emulatorAccel().then((a) => {
        if (!a || a.ok) return;
        accelWarned = true;
        notify('Running in software emulation (very slow)', store.STORE_BUILD
          ? 'Enabling Windows Hypervisor Platform and restarting once can make it 5-10 times faster.'
            + 'Settings → Environment check → Repair opens that window directly.'
          : 'Settings → Environment check → Repair turns it on in one click (needs administrator approval), then restart once.');
      }).catch(() => {});
    }
    // 兜底: 如果 early attach 没触发 splashDone (比如嵌入模式)，这里补一次
    if (typeof splashDone === 'function') splashDone();
    return { ok: true, embedded };
  } catch (e) {
    appLog(`launch failed ${pkg}: ${e && (e.stack || e.message)}`);
    try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
    // Launch failed也把模拟器窗口Continue压住 (不要让它以「独立的模拟器窗口」形式露出来)，
    // 下次点App还是走同一条隐藏 → embed 的路径。
    if (winAgent) armAgent(winAgent).catch(() => {});
    showWindow();
    send('toast', { type: 'error', message: `start failed: ${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * 容器有/无App windows时的后台任务开关。
 * 文件同步每 8 秒要遍历共享目录并走一次 adb find/stat，通知桥也在轮询; 
 * 以前从 ApkStart 一启动就无条件开跑，哪怕一个 Android apps都没Open。
 * current只在容器里真的有App时才开，关掉最后一个窗口立刻停。
 */
function onContainerActive(on) {
  if (on) {
    sharer?.start(8000);
    startNotifier();
  } else {
    sharer?.stop();
    notifier?.stop();
  }
}

/**
 * 关掉一个Running的Android app —— 托盘菜单和右键菜单共用这一条路径。
 *
 * 做了三件事: 
 *  1. forceStop App进程 (endApp 的停放逻辑也在这步之后)
 *  2. 收掉画面: 嵌入模式关壳窗口; 独立模式先把模拟器窗口藏了再关壳
 *      (顺序很重要: 先销毁壳窗口会让模拟器窗口在桌面闪一下再被 park)
 *  3. 清 currentAppPkg，让托盘菜单的「Close current app」立刻变灰
 *
 * @param {string} pkg 要Close的App包名
 * @param {object} [opts] { keepWindow } keepWindow=true 时不收窗口
 * @returns {Promise<{ok:boolean, pkg?:string, error?:string}>}
 */
async function stopApp(pkg, opts = {}) {
  const target = pkg || currentAppPkg;
  if (!target) return { ok: false, error: 'No app is running' };
  const detached = displaySettings().windowEmbed === false;
  try {
    await runtime.endApp(target, { onIdle: (idle) => onContainerActive(idle) }).catch(() => {});
    appLog(`stop ${target}`);

    if (!opts.keepWindow) {
      // 独立窗口模式: 先把模拟器窗口藏掉，再关壳窗口。
      // 反过来会在桌面留下一个闪了闪又消失的模拟器窗口。
      if (detached && appWin && appWin.isOpen) {
        try { await appWin.agent.hide(); } catch (_) { /* ignore */ }
      }
      if (appWin && appWin.isOpen) {
        appWin.close({ keepApp: true });
      }
    }

    // 清掉当前App标记: 托盘菜单, 右键菜单的「Close app」都据此变灰
    if (currentAppPkg === target) currentAppPkg = null;

    try { send('apps:changed'); } catch (_) { /* ignore */ }
    return { ok: true, pkg: target };
  } catch (e) {
    appLog(`stop failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** 通知桥: 只在有App windows时轮询，关掉窗口就停，避免空转 */
function startNotifier() {
  if (!notifier) {
    notifier = new NotifyBridge({
      getClient: () => runtime.client(),
      getAppLabel: (pkg) => (store.getApp(pkg) || {}).label || pkg,
      getAppIcon: (pkg) => (store.getApp(pkg) || {}).icoPath || '',
      onOpen: (pkg) => {
        if (appWin && appWin.isOpen && appWin.pkg === pkg) {
          appWin.win.show();
          appWin.win.focus();
        } else {
          runLaunch(pkg).catch(() => {});
        }
      },
    });
  }
  notifier.start();
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    runtimeDir: runtime.provisioner.paths().root,
    diskFreeMB: (() => {
      try { return require('./core/doctor').freeDiskMB(runtime.provisioner.paths().root); } catch (_) { return 0; }
    })(),
    exe: process.execPath,
    packaged: app.isPackaged,
  }));

  // 启动方式 (开机自启 / 双击Open): 欢迎卡据此决定是否Automatic弹出
  ipcMain.handle('app:startupInfo', () => {
    const a = parseArgs(process.argv);
    return {
      autostart: process.argv.includes('--autostart') || !!a.silent,
      launch: a.launch || null,
      smoke: process.argv.includes('--smoke'),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    };
  });

  // choose文件夹 (用于把Runtime/镜像/Installed apps挪到非系统盘)
  ipcMain.handle('dialog:openDir', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a data folder',
      defaultPath: defaultPath || store.DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('apps:list', async () => {
    const apps = store.getApps();
    const settings = store.getSettings();
    let running = [];
    try {
      const c = runtime.client();
      if (await c.isOnline()) running = await c.runningPackages();
    } catch (_) { /* Runtime not started时忽略 */ }
    return apps
      .map((a) => ({
        ...a,
        running: running.includes(a.package),
        iconUrl: a.iconPath && fs.existsSync(a.iconPath)
          ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
          : null,
        shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
      }))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'en'));
  });

  ipcMain.handle('apk:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the APK to install',
      filters: [{ name: 'Android apps', extensions: ['apk', 'apks', 'xapk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  ipcMain.handle('apk:parse', async (_e, filePath) => parseApk(filePath));

  ipcMain.handle('apk:install', async (_e, filePath) => {
    const r = await runInstall(filePath);
    return { ok: true, app: r.app, warnings: r.warnings };
  });

  ipcMain.handle('app:launch', async (_e, pkg) => runLaunch(pkg));

  /**
   * 关掉一个Running的Android app。
   *
   * 以前根本没有这个入口: endApp 只在「App windows被Close」时触发，而独立窗口模式下
   * 那个窗口是隐藏的, 永远不会被关，所以App一旦起来就关不掉，
   * 用户只能退到托盘Quit整个 ApkStart (连虚拟机一起没了)。
   */
  ipcMain.handle('app:stop', async (_e, pkg, opts = {}) => stopApp(pkg, opts));

  ipcMain.handle('app:uninstall', async (_e, pkg) => {
    await installer.uninstall(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error('App not found');
    const p = installer.createShortcut(appRecord);
    store.upsertApp({ package: pkg, shortcutPath: p });
    return { ok: true, path: p };
  });

  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) throw new Error(rt.error);
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:pin', async (_e, { pkg, pinned }) => {
    store.upsertApp({ package: pkg, pinned: !!pinned });
    return { ok: true };
  });

  ipcMain.handle('app:revealApk', async (_e, pkg) => {
    const a = store.getApp(pkg);
    if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
  });

  ipcMain.handle('apk:reveal', async () => {
    fs.mkdirSync(store.APK_DIR, { recursive: true });
    shell.openPath(store.APK_DIR);
  });

  /**
   * 内存 / CPU / 数据分区这几项会直接决定虚拟机怎么开, 能装多Large的游戏，
   * 保存前统一收敛一次: 手改 settings.json, 旧版本残留的离谱值都在这里被拉回来，
   * 免得开机时 qemu 因为 -memory 32 直接Quit，或者分区填到比磁盘还Large。
   */
  const sanitizeResourcePatch = (patch) => {
    if (!patch || !patch.engine) return patch;
    const res = require('./core/resources');
    const host = res.hostProfile();
    const eng = { ...patch.engine };
    if ('memoryMB' in eng) {
      const c = res.clampMemoryMB(eng.memoryMB, host.totalMB);
      eng.memoryMB = c.mb;
      if (c.mb > 0) eng.autoMemory = false;
    }
    if ('cores' in eng) eng.cores = res.clampCores(eng.cores, host.cores).cores;
    if ('dataPartitionGB' in eng) {
      eng.dataPartitionGB = Math.max(0, Math.min(256, Number(eng.dataPartitionGB) || 0));
    }
    return { ...patch, engine: eng };
  };

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, rawPatch) => {
    const patch = sanitizeResourcePatch(rawPatch);
    const next = store.saveSettings(patch);
    if (patch && patch.autoStart !== undefined) applyAutoStart();
    if (patch && patch.display && appWin && appWin.isOpen) {
      // Portrait基准尺寸变了: 只影响后续Open的窗口LargeSmall，不打断正在跑的App
      appWin.portrait = portraitSize();
    }
    // Open「开始菜单快捷方式」时立刻补齐，不用等下次安装
    if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
      installer.ensureShortcuts().catch(() => {});
    }
    // Mouse buttons变了: 立刻按当前焦点重装/Uninstall钩子，不用等下次切窗口
    if (patch && patch.engine && (
      'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
    )) {
      refreshPointerMapping();
    }
    // 换了更新源 / 镜像前缀 / 整包地址: 之前那套「谁最快」的结论不再成立，清掉测速缓存; 
    // Runtime full package / Engine / 镜像的地址还缓存在 provisioner._cache 里，不清掉就要重启进程才生效。
    if (patch && patch.runtime && (
      'sourcePreference' in patch.runtime || 'mirrorPrefix' in patch.runtime
      || 'autoMirror' in patch.runtime || 'runtimePackUrl' in patch.runtime
      || 'emulatorUrl' in patch.runtime || 'sysimgUrl' in patch.runtime
    )) {
      try {
        updater?.sources?.reset();
        runtime?.provisioner?.sources?.reset();
        runtime?.provisioner?.invalidateEnvCache?.();
      } catch (_) { /* ignore */ }
    }
    return next;
  });

  /**
   * 修改Host shared folder: 把旧目录里已有的文件一次性迁到新目录 (best-effort，不删旧文件)，
   * 再保存Settings。Sharer 每次同步都动态读 store.getSettings().sharedDir，无需重启即可生效。
   */
  ipcMain.handle('settings:setSharedDir', async (_e, dir) => {
    if (!dir || !dir.trim()) return { ok: false, error: 'Folder cannot be empty' };
    const newDir = dir.trim();
    const oldDir = store.getSettings().sharedDir;
    try {
      if (oldDir && oldDir !== newDir) copyDirContents(oldDir, newDir);
      fs.mkdirSync(newDir, { recursive: true });
      store.saveSettings({ sharedDir: newDir });
      return { ok: true, oldDir, newDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Display mode / 快捷方式 / 一键部署 ----------------

  ipcMain.handle('display:state', () => ({
    ...displaySettings(),
    screen: screenRect(),
    current: currentAppPkg,
  }));

  ipcMain.handle('display:set', async (_e, patch) => {
    const next = store.saveSettings({ display: patch || {} });
    if (appWin && appWin.isOpen) {
      appWin.portrait = portraitSize();
      const full = next.display.mode === 'fullscreen';
      if (full && !appWin.win.isMaximized()) appWin.win.maximize();
      if (!full && appWin.win.isMaximized()) appWin.win.unmaximize();
      // 全屏 = 平板Landscape排版 (见 toggleDisplayMode 的说明)
      appWin.setLandscape(full).catch(() => {});
      appWin.scheduleFit();
    }
    return next.display;
  });

  ipcMain.handle('display:toggle', () => toggleDisplayMode());

  ipcMain.handle('shortcut:rebuild', async () => ({ ok: true, fixed: await installer.ensureShortcuts() }));
  // 用户手动点「一键部署」时强制重试，绕过失败冷却
  ipcMain.handle('runtime:autoDeploy', (_e, opts = {}) => autoDeploy({ force: !!opts.force }));
  // Close「深度裁剪」时把被 pm disable-user 的系统包恢复回来
  ipcMain.handle('settings:restoreSystem', async () => runtime.restoreSystemApps());
  // Mouse buttons改变: 只同步配置，不再无条件Uninstall (右键返回/滚轮可能仍需要钩子)
  ipcMain.handle('settings:refreshPointer', async () => { refreshPointerMapping(); return true; });
  // 兼容旧界面: 语义已改为「按Settings重新同步」
  ipcMain.handle('settings:unhook', async () => { refreshPointerMapping(); return true; });

  // ---------------- 本机体检 / Automatic配置 ----------------
  // Probe能Automatic做的 (内存, 核心, 画质, 渲染后端)就Automatic做; 
  // 必须管理员权限的 (开 Windows 功能, 装 AEHD)给按钮; 只能进 BIOS 的说清楚怎么改。

  ipcMain.handle('preflight:run', async () => {
    const preflight = require('./core/preflight');
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* Runtime还没部署 */ }
    const hw = await preflight.collect({ accel });
    const edition = store.STORE_BUILD ? 'store' : 'installer';
    const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
    return { ok: true, hw, report, edition };
  });

  /**
   * App体检推荐: 写Settings + 把这台机器的补丁落成一份驱动。
   * 只写 preflight 明确列出的几个安全项 (内存 / 核心 / 画质 / 渲染后端 / 是否锁Software emulation)。
   */
  ipcMain.handle('preflight:apply', async () => {
    const preflight = require('./core/preflight');
    const drv = require('./core/drivers');
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* ignore */ }
    const hw = await preflight.collect({ accel });
    const edition = store.STORE_BUILD ? 'store' : 'installer';
    const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
    const patch = sanitizeResourcePatch(report.patch);
    const next = store.saveSettings(patch);

    // 把这台机器的参数固化成驱动: 以后每次开机都按它来，不用重复体检。
    // 校验一遍再落盘 —— 体检生成的内容同样不能绕过白名单。
    let driverFile = '';
    let driverError = '';
    try {
      const v = drv.validateDriver(report.driver);
      if (!v.ok) throw new Error(v.errors.join('; '));
      const dir = drv.userDir(store);
      fs.mkdirSync(dir, { recursive: true });
      driverFile = path.join(dir, `${v.driver.id}.json`);
      fs.writeFileSync(driverFile, `${JSON.stringify(report.driver, null, 2)}\n`, 'utf8');
      const prev = (next.drivers && next.drivers.state) || {};
      store.saveSettings({ drivers: { state: { ...prev, [v.driver.id]: true } } });
    } catch (e) {
      driverError = e.message;
    }

    appLog(`Checkup auto-config: ${JSON.stringify(patch.engine)} driver=${driverFile || '(not written)'}`);
    return {
      ok: true,
      settings: store.getSettings(),
      driverFile,
      driverError,
      summary: report.summary,
      recommended: report.recommended,
    };
  });

  // ---------------- 驱动 (兼容补丁) ----------------
  // 一个驱动就是一份 JSON: 声明「匹配哪些机器」+「命中后改哪些启动参数」。
  // 这里只做「读目录 / 校验 / 匹配 / 导入 / 导出模板 / 开关」，run no code at all。

  /** 组装当前机器画像 + 全部驱动 + 匹配结果 (给Settings页用) */
  async function driverOverview() {
    const drv = require('./core/drivers');
    const doctor = require('./core/doctor');
    const os = require('os');
    const s = store.getSettings();
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* 没装Runtime */ }
    let emulatorVersion = '';
    try { emulatorVersion = (await runtime.provisioner.emulatorVersion()).version || ''; } catch (_) { /* ignore */ }
    let osBuild = 0;
    try {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* ignore */ }
    const host = drv.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (os.cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const dirs = { user: drv.userDir(store), bundled: drv.bundledDir(APP_ROOT) };
    const loaded = drv.loadAll([dirs.bundled, dirs.user]);
    const resolved = drv.resolve({ drivers: loaded.drivers, host, state, disabled });
    const hit = new Map(resolved.applied.map((d) => [d.id, d]));
    return {
      host,
      dirs,
      errors: loaded.errors,
      effect: resolved.effect,
      drivers: loaded.drivers.map((d) => {
        const forced = typeof state[d.id] === 'boolean' ? state[d.id] : null;
        return {
          id: d.id,
          name: d.name,
          version: d.version,
          author: d.author,
          description: d.description,
          priority: d.priority,
          builtin: d.dir === dirs.bundled,
          file: d.file,
          enabled: forced !== null ? forced : d.enabled !== false,
          matched: hit.has(d.id),
          hits: (hit.get(d.id) || {}).hits || [],
        };
      }),
    };
  }

  ipcMain.handle('drivers:list', () => driverOverview());

  ipcMain.handle('drivers:openFolder', async () => {
    const dir = require('./core/drivers').userDir(store);
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true, dir };
  });

  ipcMain.handle('drivers:import', async () => {
    const drv = require('./core/drivers');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a driver file (.json)',
      filters: [{ name: 'Driver JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const out = drv.importDriver(r.filePaths[0], drv.userDir(store));
    if (out.ok) {
      // 导入即启用: use户特意导入的补丁，默认应该立刻生效
      const s = store.getSettings();
      store.saveSettings({ drivers: { state: { ...(s.drivers.state || {}), [out.driver.id]: true } } });
      send('runtime:log', `Driver imported: ${out.driver.name} v${out.driver.version}`);
    }
    return { ...out, overview: await driverOverview() };
  });

  ipcMain.handle('drivers:exportTemplate', async () => {
    const drv = require('./core/drivers');
    const overview = await driverOverview();
    const tpl = drv.templateFromHost(overview.host);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Export this PC driver template',
      defaultPath: path.join(drv.userDir(store), `${tpl.id}.json`),
      filters: [{ name: 'Driver JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
    fs.writeFileSync(r.filePath, `${JSON.stringify(tpl, null, 2)}\n`, 'utf8');
    return { ok: true, file: r.filePath, template: tpl };
  });

  ipcMain.handle('drivers:setEnabled', async (_e, { id, enabled } = {}) => {
    const did = String(id || '');
    if (!did) return { ok: false, error: 'Missing driver id' };
    const s = store.getSettings();
    const prev = (s.drivers && s.drivers.state) || {};
    store.saveSettings({ drivers: { state: { ...prev, [did]: !!enabled } } });
    return { ok: true, overview: await driverOverview() };
  });

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:probe', async () => runtime.probe());
  ipcMain.handle('runtime:start', async () => {
    const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
    return r.ok ? { ok: true, engine: r.engine } : { ok: false, error: r.error, needsSetup: r.needsSetup };
  });
  ipcMain.handle('runtime:stop', async () => {
    await runtime.stop();
    return { ok: true };
  });
  ipcMain.handle('runtime:log', () => runtime.bootLog);

  // ---------------- 诊断 / 瘦身 ----------------

  ipcMain.handle('doctor:profile', async () => {
    const doctor = require('./core/doctor');
    // 已经开机就用实跑参数; 没开机也要按「真实Engine版本 + 真实加速状态」推导，
    // 否则Settings页会显示已弃用的 swiftshader_indirect / Software emulation，和实跑不一致。
    let p = runtime.emulator.profile;
    if (!p) {
      const env = await runtime.provisioner.checkEnv();
      p = doctor.autoProfile({
        settings: store.getSettings(),
        accel: env.accel,
        emulatorVersion: env.emulator.version || '',
        diskMB: doctor.freeDiskMB(store.DATA_DIR),
      });
    }
    return { profile: p, text: doctor.describeProfile(p) };
  });

  ipcMain.handle('doctor:report', async () => {
    const r = await runtime.diagnostics();
    shell.showItemInFolder(r.file);
    return r;
  });

  /**
   * 系统问题Automatic校验: 启动前/RunningAutomatic检查常见导致「装不上, 起不来」的根因，
   * 并给出可操作的Fix建议 (在首页横幅 + Settings面板里展示，按问题一键Fix)。
   */
  ipcMain.handle('doctor:selfCheck', async () => {
    const doctor = require('./core/doctor');
    const issues = [];
    // 这两个值在 try 内赋值, 在 try 外返回，必须在作用域外声明
    let accel = { ok: false };
    let free = 0;
    try {
      if (!doctor.vcRedistOk()) {
        issues.push({
          code: 'vcRedist', severity: 'error', title: 'VC++ runtime (x64) is missing',
          hint: 'The Android runtime needs Microsoft VC++ 2015-2022; without it the emulator fails to start (0xc0000135).', fix: 'vcRedist',
        });
      }
      accel = await runtime.provisioner.emulatorAccel().catch(() => ({ ok: false }));
      if (!accel.ok) {
        // 商店版和安装版的补救路径完全不同，提示必须分开写: 
        //   - 商店 (MSIX)版不能装内核驱动, 也通常拿不到管理员授权 → 只能引导用户
        //     自己去「启用或Close Windows 功能」里勾「Windows 虚拟机监控程序平台」; 
        //   - 安装版/便携版可以一键提权开启 (失败还能退 AEHD 驱动)。
        // 以前两种版本共用一句话，商店用户看到的是「建议安装 AEHD 驱动」——
        // 而商店版根本装不了驱动，等于指了一条死路。
        issues.push(store.STORE_BUILD
          ? {
            code: 'accel',
            severity: 'error',
            title: 'Windows Hypervisor Platform must be enabled',
            hint: 'Without it everything runs in pure software emulation and boot takes minutes.'
              + MSIX_ACCEL_HINT
              + '(Store builds cannot elevate for you; do it manually once, then restart.)',
            fix: 'virtualization',
          }
          : {
            code: 'accel',
            severity: 'warn',
            title: 'Hardware acceleration not enabled',
            hint: `${accel.note || 'It will fall back to software emulation (runs, but very slowly).'}`
              + ' Repair on the right enables it automatically (needs administrator approval, may require one restart); '
              + 'If that fails, the AEHD driver is installed instead.',
            fix: 'virtualization',
          });
      }
      free = doctor.freeDiskMB(runtime.provisioner.paths().root);
      if (free && free < 8192) {
        issues.push({
          code: 'disk', severity: free < 2048 ? 'error' : 'warn', title: 'Runtime disk space is low',
          hint: `The drive holding “${runtime.provisioner.paths().root}“ has only ${free} MB left; the runtime and images may fill it up.`, fix: 'disk',
        });
      }
      const rtDir = runtime.provisioner.paths().root;
      if (!doctor.isAsciiPath(rtDir)) {
        issues.push({
          code: 'pathRuntime', severity: 'warn', title: 'Runtime folder contains non-ASCII characters',
          hint: 'Some runtime components are sensitive to non-ASCII paths and may fail to start. Consider a plain ASCII folder.', fix: 'path',
        });
      }
      const env = await runtime.provisioner.checkEnv().catch(() => ({}));
      if (!env.adb || !env.adb.ok) {
        issues.push({ code: 'adb', severity: 'error', title: 'adb toolchain missing', hint: 'Cannot connect to the Android runtime.', fix: 'deploy' });
      }
      if (!env.emulator || !env.emulator.ok) {
        issues.push({ code: 'emulator', severity: 'error', title: 'Runtime engine not installed', hint: 'The runtime engine must be deployed first (~440 MB).', fix: 'deploy' });
      }
      if (!env.sysimg || !env.sysimg.ok) {
        issues.push({ code: 'sysimg', severity: 'warn', title: 'System image not ready', hint: 'The Android system image must be downloaded first (~1.5 GB).', fix: 'deploy' });
      }
      // 残留锁文件: 会让下一次启动被判定为「AVD 已被占用」而 FATAL
      const avdHome = runtime.provisioner.paths().avdHome;
      let locked = false;
      try { for (const f of fs.readdirSync(avdHome)) { if (/\.lock$/i.test(f)) { locked = true; break; } } } catch (_) { /* ignore */ }
      if (locked) {
        issues.push({ code: 'lock', severity: 'warn', title: 'Leftover lock file from a previous run detected', hint: 'It may make the next start fail with “AVD already in use”.', fix: 'lock' });
      }
    } catch (_) { /* 自检失败不阻断使用 */ }
    return { issues, accel, free };
  });

  // 微软 VC++ 2015-2022 x64 运行库: 安卓模拟器 (Qt6)与 qemu 都依赖它。
  // 缺了在「其他电脑」上会直接起不来 (0xc0000135 / MSVCP140 缺失)。
  function vcRedistInstaller() {
    const p = runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }
  ipcMain.handle('runtime:vcRedist', () => {
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
  });
  ipcMain.handle('runtime:installVcRedist', async () => {
    const file = vcRedistInstaller();
    if (!file) return { ok: false, reason: 'no-installer' };
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      // 用 RunAs 提权安装 (VC++ 是系统级组件，需要管理员); /quiet 静默 /norestart 不重启
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`],
      { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk() };
  });

  ipcMain.handle('runtime:usage', () => runtime.usage());

  // 通用OK框 (渲染层统一走这里，避免各处自己拼 dialog 文案)
  ipcMain.handle('app:confirm', async (_e, opts = {}) => {
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: opts.type || 'question',
      title: opts.title || 'OK',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: ['Cancel', opts.okLabel || 'OK'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return { response };
  });

  /**
   * 资源分配总览: 宿主上限, 当前分配, 数据盘余量。
   * 由Runtime自己的 resources() 回答，界面只认这个结构。
   */
  ipcMain.handle('engine:resources', async () => {
    try {
      const backend = runtime.backend;
      if (backend && typeof backend.resources === 'function') return await backend.resources();
      return { backend: backend ? backend.id : '', ok: false, note: 'The runtime is not ready yet; resource allocation is unavailable' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * 就地扩容做不到时 (quickboot 差量盘)走这条: 按目标容量重建 /data。
   * 会清空Installed apps与存档 —— 调用方必须已经让用户明确OK过。
   */
  ipcMain.handle('runtime:resetAndResize', async (_e, gb) => {
    const res = require('./core/resources');
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(runtime.provisioner.paths().root);
    const want = res.clampDataGB(gb, freeMB).gb;
    if (!want) return { ok: false, error: 'Invalid target capacity' };
    store.saveSettings({ engine: { dataPartitionGB: want } });
    await runtime.stop().catch(() => {});
    const r = await runtime.resetAndroidData().catch((e) => ({ ok: false, error: e.message }));
    appLog(`reset+resize -> ${want}GB: ${JSON.stringify(r)}`);
    return { ok: !!(r && r.ok), wantGB: want, ...r };
  });

  // 数据分区 (/data)容量: App, 游戏与它们的更新包都装在这里。
  // 「游戏更新提示空间不足」几乎都是这一项太Small，扩容是就地做的，不丢数据。
  ipcMain.handle('runtime:dataInfo', () => {
    const doctor = require('./core/doctor');
    const b = runtime.backend;
    const info = (b && typeof b.dataInfo === 'function') ? (b.dataInfo() || {}) : {};
    const freeDiskMB = Number(info.freeMB) || Number(info.freeDiskMB)
      || doctor.freeDiskMB(runtime.provisioner.paths().root);
    return { ...info, freeDiskMB };
  });

  ipcMain.handle('runtime:setDataSize', async (_e, gb) => {
    const res = require('./core/resources');
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(runtime.provisioner.paths().root);
    const clamped = res.clampDataGB(gb, freeMB);
    const want = clamped.gb;
    store.saveSettings({ engine: { dataPartitionGB: want } });
    if (!want) {
      const info = runtime.emulator.dataInfo();
      return { ok: true, auto: true, ...info };
    }
    const mb = Math.round(want * 1024);
    // 镜像正被 qemu 占着时不能改，先停容器 (App会跟着Quit，属于预期)
    let stopped = false;
    try {
      const online = await runtime.client().isOnline().catch(() => false);
      if (runtime.emulator.running() || online) {
        await runtime.stop().catch(() => {});
        stopped = true;
      }
    } catch (_) { /* ignore */ }
    try {
      const r = runtime.emulator.resizeDataPartition(mb);
      appLog(`data partition -> ${want}GB: ${JSON.stringify(r)}`);
      if (r && r.ok) notify('Data partition resized', `About ${want} GB free in Android${stopped ? ' (runtime restarted)' : ''}`);
      return { ok: !!(r && r.ok), stopped, ...r, ...runtime.emulator.dataInfo() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:cleanup', async (_e, opts = {}) => {
    // 明确两次OK: 先给清单，用户OK后才真正删; 且只清理 ApkStart 自己的Runtime目录
    const pass = { apply: false, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots };
    if (!opts.apply) return runtime.cleanup(pass);
    const preview = await runtime.cleanup(pass);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', `Clean ${preview.candidates.length} items`],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirm runtime cache cleanup',
      message: `Will free about ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
      detail: (opts.includeSnapshots
        ? 'The runtime is stopped first, then old images, the current AVD’s quick-boot snapshot, lock files and inactive AVD caches are deleted. Installed apps are kept (only snapshots are cleared),'
        : 'Only old images, old snapshots, lock files and inactive AVD caches are deleted; installed apps are kept.')
        + 'This cannot be undone; exporting a diagnostic report first is recommended.',
    });
    if (response !== 1) return { ...preview, cancelled: true };
    return runtime.cleanup({ apply: true, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots });
  });

  // 彻底Reset Android data: 清空 /data 用户分区 + Installed apps + 快速启动快照，
  // AVD 还原成「刚装好系统」的干净状态。会真实删除数 GB 数据，UI 必须二次OK。
  ipcMain.handle('runtime:resetData', async () => {
    try {
      const r = await runtime.resetAndroidData();
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Fix虚拟机网络: 重置 /data (保留App清单，点开App会Automatic重装)。
  // 典型场景: 安卓里所有联网页面一直黑屏，其实是 wlan0 没起来, 没有默认路由。
  ipcMain.handle('runtime:repairNetwork', async () => {
    try {
      const r = await runtime.repairNetwork({
        onLog: (m) => send('toast', { message: m, kind: 'info', timeout: 6000 }),
      });
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 只做网络体检，不动任何数据 (Settings页用来显示当前状态)
  ipcMain.handle('runtime:checkNetwork', async () => {
    try {
      const network = await runtime.emulator.checkNetwork(runtime.adbPath());
      return { ok: !!network.ok, network };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- 旧版本残留 ----------------

  /** 只扫描, 不删除: 先把「能找到什么」原样给界面，由用户决定 */
  ipcMain.handle('leftovers:scan', () => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const dataDir = store.DATA_DIR;
      let avdHome = '';
      try { avdHome = runtime.provisioner.paths().avdHome; } catch (_) { avdHome = ''; }
      return { ok: true, ...leftovers.scan({ installDir, dataDir, avdHome }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('leftovers:clean', (_e, items) => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const r = leftovers.clean(Array.isArray(items) ? items : [], { installDir });
      appLog(`leftovers cleaned: ${r.removed.length} removed, ${r.failed.length} failed`);
      return { ok: true, ...r, freedMB: Math.round(r.freedBytes / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Runtime自举 ----------------

  ipcMain.handle('provision:installEmulator', async () => {
    try {
      const r = await runtime.provisioner.installEmulator(
        (p) => send('provision:progress', { ...p, component: 'emulator' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installSysimg', async () => {
    try {
      const r = await runtime.provisioner.installSystemImage(
        (p) => send('provision:progress', { ...p, component: 'sysimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installPlayImage', async () => {
    try {
      const r = await runtime.provisioner.installPlayImage(
        (p) => send('provision:progress', { ...p, component: 'playimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAehd', async () => {
    try {
      const r = await runtime.provisioner.installAehd(
        (p) => send('provision:progress', { ...p, component: 'aehd' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 提权安装 AEHD 驱动: 弹出 UAC，用户OK后静默安装 */
  ipcMain.handle('provision:enableAccel', async () => {
    try {
      const p = runtime.provisioner.paths();
      const bat = path.join(p.aehdDir, 'silent_install.bat');
      if (!fs.existsSync(bat)) {
        const r = await runtime.provisioner.installAehd(
          (x) => send('provision:progress', { ...x, component: 'aehd' }),
        );
        if (!fs.existsSync(bat)) throw new Error(r.error || 'AEHD driver package not ready');
      }

      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Administrator approval was cancelled (you must click “Yes” to install the driver)' : `Driver installation failed (exit code ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });

      const accel = await runtime.provisioner.emulatorAccel();
      return { ok: accel.ok, accel, error: accel.ok ? '' : accel.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Automatic开启虚拟化: use户无需手动去「Windows 功能」面板。
   * 优先启用系统自带的「虚拟机平台」 (WHPX)功能; 若该 DLL 都不存在 (老系统)，
   * 退而安装并启用 Google 的 AEHD 驱动。两种方式都需要管理员提权。
   */
  ipcMain.handle('provision:enableVirtualization', async () => {
    try {
      const accel = await runtime.provisioner.emulatorAccel();
      if (accel.ok) return { ok: true, already: true, accel, note: 'Hardware acceleration is already available, nothing to do' };

      // ---------------- 商店 (MSIX)版: 只能走系统自带的 WHPX ----------------
      // MSIX 包由 AppX 部署模型拉起，固定 mediumIL，既不能装内核驱动 (AEHD)，
      // 通常也拿不到管理员授权。所以这里只尝试 WHPX，拿不到就退回「手动开启」
      // 的引导 —— 以前的实现直接用 Start-Process -Verb RunAs，商店用户点了
      // 注定失败，横幅上的「Hardware acceleration not enabled」永远消不掉。
      if (store.STORE_BUILD) {
        const whpx = await enableWhpxFeatures();
        runtime.provisioner.invalidateEnvCache?.();
        if (whpx.ok) {
          return {
            ok: true, restartNeeded: true, steps: whpx.steps,
            accel: await runtime.provisioner.emulatorAccel().catch(() => accel),
            note: 'Requested Windows Hypervisor Platform; hardware acceleration takes effect after a restart',
          };
        }
        return {
          ok: false,
          manual: true,
          settingsUri: 'ms-settings:optionalfeatures',
          steps: whpx.steps,
          accel,
          note: MSIX_ACCEL_HINT,
        };
      }

      // ---------------- 安装版 / 便携版 ----------------
      // 先试 WHPX (系统自带，无需下载); 失败 (用户点了否 / 系统不支持)再退 AEHD 驱动。
      // AEHD 需要联网拿驱动包，所以放在后面。
      const whpx = await enableWhpxFeatures();
      runtime.provisioner.invalidateEnvCache?.();
      if (whpx.ok) {
        return {
          ok: true, restartNeeded: true, steps: whpx.steps,
          accel: await runtime.provisioner.emulatorAccel().catch(() => accel),
          note: whpx.steps.some((s) => s.cancelled)
            ? 'Enabled Windows Hypervisor Platform; takes effect after a restart'
            : 'Enabled Windows Hypervisor Platform; takes effect after a restart',
        };
      }
      if (whpx.cancelled) {
        return {
          ok: false,
          cancelled: true,
          error: 'You cancelled the administrator prompt, so hardware acceleration is unchanged. Click Repair again, or enable Windows Hypervisor Platform manually.',
        };
      }

      // WHPX 开不起来: 改用 Google 的 AEHD 驱动 (装完即用，不用重启)
      const ae = await runtime.provisioner.installAehd(
        (x) => send('provision:progress', { ...x, component: 'aehd' }),
      ).catch((e) => ({ ok: false, error: e.message }));
      if (!ae.ok) return { ok: false, error: ae.error || 'Failed to prepare the AEHD driver package' };
      const bat = path.join(runtime.provisioner.paths().aehdDir, 'silent_install.bat');
      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Administrator approval was cancelled (you must click “Yes” to install the driver)' : `Driver installation failed (exit code ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });
      runtime.provisioner.invalidateEnvCache?.();
      const after = await runtime.provisioner.emulatorAccel();
      return { ok: after.ok, accel: after, note: after.ok ? 'AEHD hardware acceleration enabled' : after.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAdb', async () => {
    try {
      const r = await runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installQemu', async () => {
    try {
      const r = await runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:downloadIso', async () => {
    try {
      const r = await runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:createDisk', async (_e, sizeGB) => {
    try {
      const r = await runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
        (p) => send('provision:progress', { ...p, component: 'disk' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importIso', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an Android-x86 / Bliss OS system image',
      filters: [{ name: 'System images', extensions: ['iso', 'img'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...runtime.provisioner.importIso(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importDisk', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the virtual disk with Android installed',
      filters: [{ name: 'Virtual disks', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      const info = runtime.provisioner.importDisk(r.filePaths[0]);
      store.saveSettings({ runtime: { installed: true } });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:check', async () => runtime.provisioner.checkEnv());
  ipcMain.handle('provision:probeSources', async () => runtime.provisioner.probeSources());

  ipcMain.handle('runtime:startInstaller', async () => {
    try {
      await runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:markInstalled', async () => {
    await runtime.markInstalled();
    return { ok: true };
  });

  ipcMain.handle('runtime:resetInstall', async () => {
    store.saveSettings({ runtime: { installed: false } });
    return { ok: true };
  });

  ipcMain.handle('assoc:status', () => {
    // 冒烟/无 shell 环境: 不Probe注册表 (reg.exe 可能被策略拦截)
    if (NO_SHELL_PROBE) return { registered: false, skipped: true };
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
      return { registered: out.includes(assoc.PROGID) };
    } catch (_) {
      return { registered: false };
    }
  });

  ipcMain.handle('assoc:register', () => {
    const l = launcherInfo();
    const icoPath = path.join(store.ICON_DIR, 'apkstart.ico');
    if (!fs.existsSync(icoPath)) {
      // 优先用随包分发的多尺寸品牌 ICO，缺失时从 Logo PNG 现算
      if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
      else {
        const { pngToIco } = require('./core/shortcut');
        const ico = pngToIco(ICON_PNG);
        if (ico) fs.writeFileSync(icoPath, ico);
      }
    }
    return assoc.registerAssociation(l.target, icoPath, l.args);
  });

  ipcMain.handle('assoc:unregister', () => assoc.unregisterAssociation());

  ipcMain.handle('share:sync', async () => sharer.sync({ onLog: (m) => send('runtime:log', m) }));
  ipcMain.handle('share:open', async () => {
    const dir = store.getSettings().sharedDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  /** 清理上次残留的 AVD 锁文件: 会让下次启动被误判为「AVD 已被占用」而 FATAL */
  ipcMain.handle('app:clearLocks', async () => {
    try {
      const avdHome = runtime.provisioner.paths().avdHome;
      let removed = 0;
      for (const f of fs.readdirSync(avdHome)) {
        if (/\.lock$/i.test(f)) {
          try { fs.rmSync(path.join(avdHome, f), { force: true }); removed++; } catch (_) { /* ignore */ }
        }
      }
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * 一键Uninstall ApkStart 本体: 
   * 1) 先Cancel .apk 文件关联 (避免Uninstall后双击 APK 指向已删除的程序)
   * 2) 安装版: 启动 NSIS Uninstall程序 (它会自行请求管理员/OK)，随后Quit本程序
   * 3) 便携版 (旁加载 / 免安装): 没有 uninstaller.exe，返回提示让用户手动删除程序与数据目录
   */
  ipcMain.handle('app:removeSelf', async () => {
    try {
      try { await assoc.unregisterAssociation(); } catch (_) { /* Cancel关联失败不影响Uninstall */ }
      const exeDir = path.dirname(process.execPath);
      // 和 updater.flavor 用同一套识别规则: electron-builder 生成的是
      // "Uninstall ApkStart.exe"，旧代码只找 "uninstaller.exe"，
      // 导致安装版点「One-click uninstall」被误判成便携版, 只弹提示不真Uninstall (issue #51)。
      const unName = findUninstaller(exeDir);
      if (!unName) {
        return { ok: true, portable: true, dataDir: store.DATA_DIR, exeDir };
      }
      const uninstaller = path.join(exeDir, unName);
      const { spawn } = require('child_process');
      // Uninstall前先收掉常驻的模拟器: qemu 会锁住 resources\runtime 里的 exe/dll，
      // NSIS 删不掉就会留下半个安装目录。这里只针对「真的在Uninstall」，不影响日常Quit。
      try { await runtime?.emulator?.killOrphanProcesses(); } catch (_) { /* ignore */ }
      // 先让本程序Quit，再由一个独立进程延迟 2 秒拉起Uninstall器: 
      // Running的 exe 会锁住安装目录里的文件，直接拉起Uninstall器容易删不干净。
      const cmd = `ping 127.0.0.1 -n 3 >nul & start "" "${uninstaller}"`;
      spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.quit(), 300);
      return { ok: true, portable: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

  /**
   * Open「启用或Close Windows 功能」对话框。
   *
   * 为什么不用 ms-settings:optionalfeatures: Win11 那个页面是「可choose功能」列表，
   * 里面**没有**「Windows 虚拟机监控程序平台」，用户会白找一圈。经典对话框
   * optionalfeatures.exe 才有那一项 (WHPX 真正需要的功能)。
   * Open它本身不需要管理员权限，点「OK」时才 UAC。
   */
  ipcMain.handle('provision:openWindowsFeatures', () => {
    try {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'optionalfeatures.exe');
      const { spawn } = require('child_process');
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (e) {
      // 极少见: 被组策略挡住 / 文件缺失。退到Settings页，至少给用户一个入口
      shell.openExternal('ms-settings:optionalfeatures').catch(() => {});
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:hide', () => mainWindow?.hide());

  // ---------------- App windows (只有 旋转 / Minimize / Maximize / Close) ----------------

  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('shell:state', () => ({ ...appWin.state, iconUrl: appWin.iconUrl || '' }));
  // 独立窗口模式下画面在模拟器原生窗口里，壳窗口是隐藏的 —— 按钮必须作用到真正
  // 可见的那一扇。统一交给 appWin 判断模式处理，避免对隐藏窗口 maximize/minimize。
  ipcMain.handle('shell:minimize', () => appWin.minimize());
  ipcMain.handle('shell:maximize', () => appWin.toggleMaximize());
  // Close必须走 appWin.close(): 它会先把模拟器窗口从宿主上摘下来, 再停掉Android app。
  // 老实现直接 win.close()，绕过了这段收尾 —— 窗口是没了，但安卓侧的进程还在跑，
  // 就是用户说的「点Close关不掉App」。
  ipcMain.handle('shell:close', () => {
    if (appWin && appWin.isOpen) { appWin.close(); return { ok: true }; }
    return { ok: false };
  });
  // 标题栏的旋转按钮 = 「这个App我要横着/竖着用」。
  // 以前它只是把全局 landscape 翻一下，于是点红果的旋转按钮会把**所有**App
  // 都带到Landscape panel上去，红果自己反而被信箱化。current写成该App自己的覆盖值，
  // 别的App不受影响 (Settings里的「强制」模式仍然优先)。
  ipcMain.handle('shell:rotate', () => {
    const pkg = appWin && appWin.pkg;
    // 以「面板实际方向」为基准取反，而不是 appWin.state.landscape
    // (后者是「期望方向」，在启动切换面板的过程中可能还没落地)。
    const next = !displaySettings().landscape;
    if (pkg) {
      store.upsertApp({ package: pkg, orientationOverride: next ? 'landscape' : 'portrait' });
      appLog(`orientation override ${pkg} = ${next ? 'landscape' : 'portrait'}`);
    }
    return appWin.rotate(restartForOrientation);
  });

  ipcMain.handle('shell:back', async () => { await runtime.client().keyBack(); });
  ipcMain.handle('shell:forward', async () => { await runtime.client().keyForward(); });

  // ---------------- Android system settings (without entering the Android desktop) ----------------

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await androidSet.status()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:set', async (_e, { key, value }) => {
    try {
      switch (key) {
        case 'wifi': return { ok: true, ...(await androidSet.setWifi(!!value)) };
        case 'airplane': return { ok: true, ...(await androidSet.setAirplane(!!value)) };
        case 'volume': return { ok: true, ...(await androidSet.setVolume(value)) };
        case 'animations': return { ok: true, ...(await androidSet.setAnimations(!!value)) };
        case 'fontScale': return { ok: true, ...(await androidSet.setFontScale(value)) };
        case 'density': return { ok: true, ...(await androidSet.setDensity(value)) };
        default: return { ok: false, error: `Unknown setting ${key}` };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:open', async (_e, action) => {
    try { return { ok: true, ...(await androidSet.open(action)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:tune', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.tune({ pkg })) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:permissions', async (_e, pkg) => {
    try { return { ok: true, rows: await androidSet.permissions(pkg) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:grantAll', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.grantAll(pkg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:foreground', () => {
    if (appWin && appWin.isOpen) { appWin.win.show(); appWin.win.focus(); return true; }
    return false;
  });

  // ---- 按键映射 ----
  ipcMain.handle('shell:keyEvent', async (_e, key) => {
    if (!keymapEngine || !keymapEngine.enabled) return false;
    const pkg = currentAppPkg;
    if (!pkg) return false;
    return keymapEngine.handleKey(key, pkg);
  });
  ipcMain.handle('keymap:getPresets', () => {
    return Object.entries(KEYMAP_PRESETS).map(([id, p]) => ({ id, label: p.label, desc: p.desc }));
  });
  ipcMain.handle('keymap:getMap', (_e, pkg) => keymapEngine ? keymapEngine.getMap(pkg) : []);
  ipcMain.handle('keymap:setMap', (_e, pkg, mappings) => {
    if (!keymapEngine) return { ok: false };
    keymapEngine.setMap(pkg, mappings);
    // 持久化到Settings
    const maps = { ...(store.getSettings().engine.keymaps || {}) };
    if (mappings && mappings.length) maps[pkg] = mappings;
    else delete maps[pkg];
    store.saveSettings({ engine: { keymaps: maps } });
    return { ok: true };
  });
  ipcMain.handle('keymap:setEnabled', (_e, on) => {
    if (keymapEngine) keymapEngine.enable(!!on);
    store.saveSettings({ engine: { keymapEnabled: !!on } });
    return { ok: true };
  });
  ipcMain.handle('keymap:isEnabled', () => keymapEngine ? keymapEngine.enabled : false);
  ipcMain.handle('keymap:applyPreset', (_e, pkg, presetId) => {
    if (!keymapEngine || !KEYMAP_PRESETS[presetId]) return { ok: false };
    const mappings = KEYMAP_PRESETS[presetId].mappings;
    keymapEngine.setMap(pkg, mappings);
    const maps = { ...(store.getSettings().engine.keymaps || {}) };
    maps[pkg] = mappings;
    store.saveSettings({ engine: { keymaps: maps } });
    return { ok: true, mappings };
  });

  // ---------------- 在线更新 ----------------

  ipcMain.handle('app:updateCheck', async (_e, opts = {}) => {
    try {
      // 用户主动点「Check for updates」→ 跳过缓存，必定重新问一次两个源
      const info = await updater.check({ force: opts.force !== false });
      updateInfo = info;
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message, current: app.getVersion() };
    }
  });

  ipcMain.handle('app:updateOpen', (_e, url) => {
    // GitHub 和 Gitee 的发布页都允许直接Open: Check for updates failed时界面就是靠这个
    // 让用户手动去下载，只放行 github.com 会把国内用户挡在门外。
    const raw = String(url || '');
    const ok = /^https:\/\/(github\.com|gitee\.com)\//i.test(raw);
    const target = ok ? raw : Updater.repoUrl();
    shell.openExternal(target).catch(() => {});
    return { ok: true, target };
  });

  ipcMain.handle('app:updateApply', () => runUpdate());

  ipcMain.handle('app:updateCancel', () => { updateBusy = false; return { ok: true }; });

  ipcMain.handle('app:restart', () => {
    setTimeout(() => { quitting = true; app.quit(); }, 200);
    return { ok: true };
  });
}

// ---------------- 生命周期 ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const args = parseArgs(argv);
    if (args.launch) { runLaunch(args.launch); return; }
    if (args.apk) { runInstall(args.apk).catch(() => {}); return; }
    showWindow();
  });

  app.whenReady().then(async () => {
    store.ensureDirs();
    // Windows 任务栏身份 (AppUserModelID)
    // 不设的话 Windows 只能按 exe 路径猜身份: 任务栏固定项, 跳转列表, 通知来源
    // 都会落到 "Electron" 上 —— 用户看到的就是「图标/名字是默认的那个」。
    // 注意这里是「当前进程」的身份，切到某个Android app时会换成那个App自己的
    // AUMID (见 openAppWindow)，否则任务栏固定项和Running的窗口对不上，
    // 固定项显示的还是 ApkStart 的图标。
    setAumid(APP_AUMID);
    runtime = new Runtime(APP_ROOT);
    // 启动即留一行痕迹: 出问题时用户把 app.log 发过来就能看到版本与数据目录
    appLog(`start v${app.getVersion()} data=${store.DATA_DIR} pid=${process.pid}`);

    // ---- 开机动画窗口 ----
    // 仿抖音 DSH 风格: Logo 渐显 + 进度条 + 状态文字。
    // 首次安装时额外显示配置步骤介绍; 非首次只显示精简动画。
    // 安卓环境Ready后淡出Close，App秒进。
    const isFirstRun = !store.getSettings().runtime.installed;
    try {
      // 屏幕居中
      const { screen: electronScreen } = require('electron');
      const disp = electronScreen.getPrimaryDisplay();
      const sw = disp.workAreaSize.width;
      const sh = disp.workAreaSize.height;
      const splashW = 480, splashH = 360;
      splashWin = new BrowserWindow({
        width: splashW, height: splashH,
        x: Math.round((sw - splashW) / 2),
        y: Math.round((sh - splashH) / 2),
        frame: false, transparent: false, resizable: false,
        alwaysOnTop: true, skipTaskbar: true,
        backgroundColor: '#0b0c0e',
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'splash-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false,
        },
      });
      // 用 screen-saver 级别确保不被模拟器窗口盖住 (之前 alwaysOnTop 默认 level
      // 和 agent 的 SetForegroundWindow 抢 z-order，导致 splash 被顶到后面)
      splashWin.setAlwaysOnTop(true, 'screen-saver');
      splashWin.loadFile(path.join(__dirname, 'ui', 'splash.html'));
      splashWin.once('ready-to-show', () => splashWin.show());
      // IPC: 版本号, 首次运行标记, Close
      ipcMain.handle('splash:version', () => app.getVersion());
      ipcMain.handle('splash:isFirstRun', () => isFirstRun);
      // 组件是否随包自带: 开机动画据此换文案，别对已经内置镜像的用户说「正在下载」
      ipcMain.handle('splash:bundled', () => !!bundledRuntimeDir);
      ipcMain.on('splash:close', () => {
        if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        splashWin = null;
      });
    } catch (e) {
      appLog(`splash window failed: ${e.message}`);
      splashWin = null;
    }
    // 向 splash 推送进度 / Finish信号 (模块级变量，见文件顶部说明)
    splashProgress = (p) => {
      if (splashWin && !splashWin.isDestroyed()) splashWin.webContents.send('splash:progress', p);
    };
    // 淡出信号只发一次; 同时挂一个「保险丝」: splash 自己 2.5 秒内没关掉
    //  (渲染进程卡住 / IPC 丢失)就由主进程强关，绝不把启动画面留在桌面上。
    let splashDoneSent = false;
    splashDone = () => {
      if (splashDoneSent) return;
      splashDoneSent = true;
      if (!splashWin || splashWin.isDestroyed()) return;
      try { splashWin.webContents.send('splash:done'); } catch (_) { /* ignore */ }
      setTimeout(() => {
        try {
          if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        } catch (_) { /* ignore */ }
        splashWin = null;
      }, 2500).unref?.();
    };
    // 兜底超时: 任何路径都没触发 splashDone (例如Launch failed卡住)也要收掉，
    // 否则 splash 会一直悬在屏幕中央 —— 这就是「多个窗口」最刺眼的一幕。
    setTimeout(() => { if (!splashDoneSent) splashDone(); }, 180000).unref?.();

    const l = launcherInfo();
    installer = new Installer(runtime, {
      launcherTarget: l.target,
      launcherArgs: l.args,
      cwd: l.cwd,
      isDev: IS_DEV,
      desktopDir: app.getPath('desktop'),
      // Windows 搜索索引的是开始菜单里的 .lnk，只放桌面会「搜不到App」; 
      // Linux 那边对应的是 freedesktop 的App菜单目录。
      startMenuDir: process.platform === 'win32'
        ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
        : path.join(process.env.HOME || app.getPath('home'), '.local', 'share', 'applications'),
      decodeIcon,
    });
    sharer = new Sharer(runtime);
    androidSet = new AndroidSettings(runtime);

    // ---- 按键映射Engine ----
    const keymapEngine = new KeymapEngine({
      execInput: (cmd) => runtime.client().shell(cmd, { timeout: 4000 }),
      getSize: () => {
        // 用当前面板尺寸 (Landscape 1280x720 / Portrait 720x1280)
        const land = !!(store.getSettings().display || {}).landscape;
        return land ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
      },
    });
    // 从Settings里加载每App的映射表
    const savedMaps = (store.getSettings().engine || {}).keymaps || {};
    for (const [pkg, mappings] of Object.entries(savedMaps)) {
      if (Array.isArray(mappings) && mappings.length) keymapEngine.setMap(pkg, mappings);
    }
    // 默认启用 (用户可在Settings里关)
    keymapEngine.enable(store.getSettings().engine.keymapEnabled !== false);

    updater = new Updater({
      currentVersion: app.getVersion(),
      exePath: process.execPath,
      isPackaged: app.isPackaged,
      dataDir: store.DATA_DIR,
      // 让更新器能读到「只走 GitHub / 只走 Gitee / Automaticchoose快」和镜像前缀Settings
      settings: () => store.getSettings(),
      onProgress: (p) => send('update:progress', p),
    });

    // 滚轮合并器: 一个时间窗内的滚动只注入一条 input swipe，走常驻 adb shell。
    wheelRouter = new pointer.WheelRouter({
      getSize: getDeviceSize,
      inject: (cmd) => runtime.client().input(cmd),
    });

    // 窗口代理: 只负责内嵌模拟器窗口。全局鼠标钩子只在App windows前台时按配置安装。
    winAgent = new WinAgent();
    appWin = new AppWindow({
      agent: winAgent,
      // 旋转要改 Android 的逻辑分辨率，交给 adb 客户端做
      setOrientation: async (landscape) => {
        deviceSize.value = null;
        return runtime.client().setOrientation(landscape);
      },
      // 传 getter: Settings页改了键位，下一次窗口 focus / Refresh就生效，不用重启
      pointerConfig: () => pointer.pointerOptions(store.getSettings()),
      // 画面窗口由窗口代理按进程作用域自己找 (自带 emulator 的窗口就是我们拉起来的)
      windowTargets: () => null,
    });
    appWin.onCloseApp((pkg) => {
      // 关窗口 = 停这个App; 最后一个窗口关掉时容器停放 (降优先级, 停轮询)，
      // 但 Android 环境留着，下次点开是秒进而非重新cold boot。
      runtime?.endApp(pkg, { onIdle: onContainerActive }).catch(() => {});
      // 外部Close (Alt+F4 / 任务栏Close)也要清当前App标记，否则托盘菜单
      // 还显示「Close current app (xxx)」但点了没反应 (App已经停了)。
      if (currentAppPkg === pkg) currentAppPkg = null;
      try { send('apps:changed'); } catch (_) { /* ignore */ }
    });

    // 「哪些窗口才算我们的」= Runtime目录 + 随包的 engine 目录。
    // 窗口代理只允许碰这些进程创建的窗口 —— 别的 Qt App (微信 4.x 就是 Qt6，
    // 窗口类名和模拟器一模一样)一个都不许动，见 agent.ps1 的 SetScope。
    const agentScope = () => {
      const dirs = [];
      try { dirs.push(runtime.provisioner.root); } catch (_) { /* ignore */ }
      try { dirs.push(path.join(APP_ROOT, 'engine')); } catch (_) { /* ignore */ }
      return dirs.filter(Boolean);
    };
    // 范围存在代理进程的内存里，代理一重建就没了 —— 所以每次开机压制前都重发一次。
    armAgent = async (agent) => {
      if (!agent) return { ok: false };
      const dirs = agentScope();
      // 第二个参数是本进程 pid: 代理据此拒绝把窗口嵌进「不是我们的」窗口
      await agent.scope(dirs, process.pid).catch(() => null);
      if (!dirs.length) appLog('agent scope is empty: no windows suppressed (avoids affecting other software)');
      return agent.bootHide().catch(() => ({ ok: false }));
    };

    // 代理进程意外Quit后会重建，事件监听必须一起重新挂上 (旧版会在这里丢掉
    // 右键返回与滚轮，表现是「用一会儿就没反应了」)。
    const attachAgentEvents = (agent) => {
      agent.on('back', () => { runtime.client().keyBack().catch(() => {}); });
      agent.on('forward', () => { runtime.client().keyForward().catch(() => {}); });
      agent.on('wheel', (m) => {
        if (pointer.pointerOptions(store.getSettings()).wheel === 'smooth') wheelRouter.push(m);
      });
      agent.on('exit', () => {
        const next = new WinAgent();
        winAgent = next;
        appWin.agent = next;
        attachAgentEvents(next);
        // 新代理没有范围信息，不补这一下它就什么窗口都不敢碰
        armAgent(next).catch(() => {});
      });
    };
    attachAgentEvents(winAgent);

    // 命令窗压制的「闸门」必须在模拟器进程创建之前Open。
    // 旧实现是「等 ApkStart 起来 4 秒后再藏」，而模拟器在这之前就已经把
    // qemu 控制台窗口创建出来了 —— 用户看到的就是一次一闪而过的黑框。
    runtime.emulator.onBeforeSpawn = async () => {
      if (!winAgent) return;
      await armAgent(winAgent);
    };
    // 窗口代理是个 PowerShell 常驻进程，cold boot约 300~600ms。
    // 提前拉起，别等到真正要藏窗口的那一刻才开始等。
    winAgent.ensure().then(() => armAgent(winAgent)).catch(() => {});

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent });
    buildTray();
    applyAutoStart();

    // 老版本安装的App没有 orientation 字段 (那时还没这个功能)。
    // 不补的话「跟随App」对它们只能退回「Current panel orientation」，红果这类PortraitApp
    // 在Landscape panel下依旧是两侧黑边。这里用随包的离线 APK 清单解析补一次，
    // 只读中央目录 + AndroidManifest，几百毫秒且只跑一次。
    try {
      const { parseApk } = require('./core/apk');
      const filled = [];
      for (const app of store.getApps()) {
        if (app.orientation || !app.apkPath) continue;
        if (!fs.existsSync(app.apkPath)) continue;
        try {
          const meta = parseApk(app.apkPath);
          if (meta.orientation) {
            store.upsertApp({ package: app.package, orientation: meta.orientation });
            filled.push(`${app.label}=${meta.orientation}`);
          }
        } catch (_) { /* 解析失败的App跳过，不影响启动 */ }
      }
      if (filled.length) appLog(`orientation backfill: ${filled.join(', ')}`);
    } catch (_) { /* ignore */ }

    // 磁盘余量: Small于 3GB 时安卓根本起不来 (写镜像/快照都会失败)。
    // 与其让用户看着「打不开」不明所以，不如开门见山告诉他往哪儿改。
    {
      const doctor = require('./core/doctor');
      const freeMB = doctor.freeDiskMB(store.DATA_DIR);
      if (freeMB && freeMB < 3072) {
        appLog(`LOW_DISK free=${freeMB}MB dir=${store.DATA_DIR}`);
        setTimeout(() => {
          notify('Not enough disk space', `Only ${(freeMB / 1024).toFixed(1)} GB left. Move the Android data folder / runtime folder to another drive in Settings → System integration, or free up disk space.`);
          send('toast', { type: 'error', message: `Only ${(freeMB / 1024).toFixed(1)} GB left on disk, Android may fail to start (change the drive in Settings → System integration)` });
        }, 3000).unref?.();
      }
    }

    // 老版本只建过桌面快捷方式 / 图标是 null: 启动即Automatic补齐，不用用户操作
    installer.ensureShortcuts().then((fixed) => {
      if (fixed && fixed.length) {
        windowctl.refreshShell().catch(() => {});
        notify('Shortcuts restored', fixed.join(', '));
      }
    }).catch(() => {});

    // F11 全屏 / 窗口切换; 全局快捷键只在 ApkStart 活着时有效
    try {
      globalShortcut.register('F11', () => { toggleDisplayMode(); });
    } catch (_) { /* ignore */ }

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) await runLaunch(args.launch);
    else {
      // 没有直接启动App: splash 在主窗口 ready 后淡出
      if (typeof splashDone === 'function') {
        setTimeout(() => splashDone(), 800);
      }
    }

    // 预热: 像 WSA / App宝电脑版那样把安卓环境常驻。
    // Open ApkStart 时就在后台把它引导好 (窗口全程隐藏)，之后点App只剩一次 am start。
    // 只有「已经装过App + 有可用Runtime」才预热，避免第一次使用/纯管理场景白占内存。
    const prewarmEnabled = store.getSettings().engine.prewarm !== false;
    if (prewarmEnabled && !args.launch && store.getApps().length > 0) {
      // 1.2 秒就够窗口画完第一帧了。以前等 4 秒，用户这时已经点了App，
      // 结果「点开」和「预热」抢同一个 AVD 锁，反而更慢。
      setTimeout(async () => {
        try {
          const env = await runtime.provisioner.checkEnv();
          if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
            appLog(`prewarm skipped: not ready (adb=${env.adb.ok} emu=${env.emulator.ok} img=${env.sysimg.ok})`);
            return;
          }
          // 开机阶段把模拟器窗口与 qemu 控制台藏起来，用户不该看到任何窗
          // 注意要 await: 不等它生效就去 spawn，黑窗一定会露出来。
          if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
          const t0 = Date.now();
          appLog('prewarm start');
          const r = await runtime.prewarm({ onLog: (m) => appLog(`prewarm ${m}`) });
          if (r && r.ok) appLog(`prewarm ready in ${Date.now() - t0}ms`);
          else {
            appLog(`prewarm failed: ${r && (r.error || r.skipped)}`);
            // 预热失败也Continue压住模拟器窗口: 它可能只是慢，过一会儿就起来了，
            // 用户不该因为「预热失败」在桌面上看到一台模拟器。
            if (winAgent) armAgent(winAgent).catch(() => {});
          }
        } catch (e) { appLog(`prewarm error: ${e && e.message}`); /* 预热失败不影响后续正常Open */ }
      }, 1200).unref?.();
    } else {
      appLog(`prewarm off (enabled=${prewarmEnabled} launch=${!!args.launch} apps=${store.getApps().length})`);
    }

    // 首次运行的组件部署延后 20 秒: cold boot那段时间磁盘/CPU 已经打满，
    // 再并发下载解压只会让桌面更卡。真有App要Open时 ensure() 自会准备。
    setTimeout(() => {
      autoDeploy().then((r) => {
        if (r && r.ok) send('toast', { type: 'ok', message: 'The runtime was prepared automatically' });
      }).catch(() => {});
    }, 20000).unref?.();

    // 启动 8 秒后静默查一次新版本 (打包后才有意义)。New version available只提示，
    // 绝不Automatic下载 —— 更新是用户点「Update now」才做的事。
    // 商店 (MSIX)版跳过: 安装目录是只读的 WindowsApps，自更新既写不进去也不
    // 合规，更新统一由 Microsoft Store 负责。
    if (app.isPackaged && !store.STORE_BUILD) {
      // issue #98: 先检查「上次已下载解压, 但替换/重启没落地的更新」。
      // 命中就直接用本地载荷重放替换+重启，绝不再下一遍包——这是更新死循环的根治。
      // 放在查新版本之前，避免 resumable 与新一轮 check 抢进度条。
      let resuming = false;
      try {
        const job = updater.findResumableJob();
        if (job) {
          resuming = true;
          appLog(`resuming pending update ${job.version} from cached payload`);
          send('update:progress', { stage: 'apply', percent: 100, message: 'Finishing the update that did not complete last time…' });
          updater.apply(job);
          setTimeout(() => { quitting = true; app.quit(); }, 900);
        }
      } catch (e) { appLog(`resume check failed: ${e.message}`); }
      // 命中续做就不再并行发起新一轮查新版本; 但不能用 return 跳出整个启动回调。
      if (!resuming) setTimeout(() => {
        updater.check().then((info) => {
          updateInfo = info;
          send('update:state', info);
          if (info.hasUpdate) {
            appLog(`update available ${info.tag} (current v${app.getVersion()}, asset=${info.asset ? info.asset.name : 'none'})`);
            // 不再单独弹系统通知: 启动时的提醒统一收到App内的「欢迎卡」里，
            // 避免开机自启时又冒一个右下角气泡 (用户反馈的「Small弹窗」之一)。
          }
        }).catch((e) => appLog(`update check failed: ${e.message}`));
      }, 8000).unref?.();
    }

    // 文件同步 / 通知轮询不再无条件常驻: 只在容器里真的有App windows时才跑
    //  (见 onContainerActive)。

    // 冒烟测试: 截图后Quit，用于Automatic化验证界面是否正常渲染
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes('--setup')) {
              // Runtime面板已并入Settings: --setup 与 --settings 等价，直接Open settings截图
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btnSettings').click(); true;",
              );
              await new Promise((r) => setTimeout(r, 2500));
            }
            if (process.argv.includes('--settings')) {
              const opened = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('btnSettings').click();
                  for (let i = 0; i < 50; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (document.getElementById('settingsMask').classList.contains('on')) return true;
                  }
                  return false;
                })()
              `);
              console.log('[smoke] settings opened =', opened);
              await new Promise((r) => setTimeout(r, 600));
              const dbg = await mainWindow.webContents.executeJavaScript(
                "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent, note: (document.getElementById('setupNote')||{}).textContent })",
              );
              console.log('[smoke] dom =', dbg);
            }
            // 窗口可能被遮挡导致拿到旧帧: 强制重绘 + 连拍两帧取后一帧
            const snap = async (file) => {
              mainWindow.webContents.invalidate();
              await mainWindow.webContents.capturePage().catch(() => null);
              await new Promise((r) => setTimeout(r, 400));
              const im = await mainWindow.webContents.capturePage();
              fs.writeFileSync(file, im.toPNG());
              console.log('[smoke] saved', file);
            };
            await snap(out);
            if (process.argv.includes('--perf')) {
              // 拍一张「Performance & resources」区 (Settings页里控件最多的一块)
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('perfGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-perf.png'));
            }
            if (process.argv.includes('--download')) {
              // 拍一张「Download & update sources」区
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('downloadGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-download.png'));
            }
            if (process.argv.includes('--settings')) {
              // 再拍一张「About」区 (二维码 / GitHub / Powered by)
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-about.png'));
            }
          } catch (e) {
            console.error('[smoke] screenshot failed', e);
          }
          quitting = true;
          app.quit();
        }, 6500);
      });
    }

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // 正常Close窗口时只隐藏到托盘 (close 事件已拦截)，
    // 走到这里说明是真正要Quit，必须放行，否则进程会残留并占住单实例锁。
    if (quitting) app.exit(0);
  });

  let quitReady = false;
  app.on('before-quit', (e) => {
    quitting = true;
    // Quit前必须先让窗口代理把模拟器窗口「摘下 + 藏好」。这一步是异步的
    //  (要等代理回包)，所以第一次 before-quit 先拦下来，收尾Finish再真正Quit。
    // 少了这一步，宿主窗口一销毁，Windows 会把模拟器子窗口重挂到桌面并显示出来——
    // 表现就是「关掉 ApkStart 之后，桌面上还留着一个 Android Emulator 黑窗」。
    if (!quitReady) {
      e.preventDefault();
      quitReady = true;
      sharer?.stop();
      notifier?.stop();
      try { appWin?.close({ keepApp: true }); } catch (_) { /* ignore */ }
      const finish = () => {
        try { winAgent?.dispose(); } catch (_) { /* ignore */ }
        try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
        runtime?.dispose();
        // 隐藏的图标解码窗口也算一个窗口，不关掉会让 window-all-closed 永远不触发
        try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
        app.quit();
      };
      setTimeout(finish, 400);
      return;
    }
    try { winAgent?.dispose(); } catch (_) { /* ignore */ }
    try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
    runtime?.dispose();
    try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
  });
}
