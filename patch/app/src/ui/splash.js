'use strict';
/* ApkStart 开机动画脚本: 接收主进程的进度更新，控制淡出 */

const api = window.apkstartSplash;
if (!api) { /* preload 未注入时静默Quit */ }

const $ = (id) => document.getElementById(id);

// 版本号
api?.version?.().then((v) => { if ($('ver')) $('ver').textContent = v || ''; }).catch(() => {});

// 首次安装标记 + 组件是否随包自带
Promise.all([
  api?.isFirstRun?.().catch(() => false),
  api?.bundled?.().catch(() => false),
]).then(([first, bundled]) => {
  if (!first || !$('firstRun')) return;
  $('firstRun').hidden = false;
  // 内置Runtime (完整版安装包 / 微软商店 MSIX 版): 一个字都不该提「下载」。
  // 用户抱怨的就是「装了 850MB 还在下镜像」，实际那只是把包里的压缩镜像
  // 展开到用户目录，不需要联网。
  if (bundled) {
    if ($('firstRunTitle')) $('firstRunTitle').textContent = 'First run · preparing locally (no network needed)';
    if ($('firstRunList')) {
      $('firstRunList').innerHTML = [
        '<li>Runtime components are bundled with the installer, nothing is downloaded</li>',
        '<li>Expand the system image into your user folder (about 1 minute, only once)</li>',
        '<li>Prepare hardware acceleration and the Chinese IME</li>',
        '<li>After that, double-click an APK or desktop icon to open apps instantly</li>',
      ].join('');
    }
  }
}).catch(() => {});

// 进度更新
api?.onProgress?.((p) => {
  if (!p) return;
  if (p.percent != null && $('progressBar')) {
    $('progressBar').style.width = Math.min(100, Math.max(0, p.percent)) + '%';
  }
  if (p.message && $('status')) {
    $('status').textContent = p.message;
  }
});

// Finish → 淡出
api?.onDone?.(() => {
  const splash = $('splash');
  if (splash) {
    splash.classList.add('out');
    setTimeout(() => { api?.close?.(); }, 520);
  }
});
