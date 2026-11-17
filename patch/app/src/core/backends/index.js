'use strict';
/**
 * 底座注册表: id → 实现
 *
 * 新增一个底座只要三步: 
 *   1. 在 backends/ 下写一个继承 Backend 的类; 
 *   2. 在下面 REGISTRY 里登记; 
 *   3. Settings页的「Engine mode」下拉加一个choose项 (src/ui/index.html)。
 *
 * 这一层还负责「Automatic挑choose」: use户没指定底座时，按优先级Probe本机能用的那个，
 * 全都探不到才回落到自带Runtime。
 */

const { Backend, CAPS } = require('./base');
const { BuiltinBackend } = require('./builtin');
const { MumuBackend } = require('./mumu');
const { FydeosBackend } = require('./fydeos');

const REGISTRY = [
  BuiltinBackend,
  MumuBackend,
  FydeosBackend,
];

/**
 * Automatic挑choose时的顺序 (越靠前越优先)。
 *
 * **自带Runtime在 Windows 上必须排第一**。原因: use户机器上很可能装着 MuMu / 雷电 /
 * 蓝叠，早期版本把 mumu 放在最前面，结果 ApkStart 悄悄接管了「别人家的模拟器」: 
 *   - 我们找不到自己那份 QEMU 窗口，嵌入/多窗口/旋转全部按错的底座走; 
 *   - 用户点开 ApkStart 却发现跑的是 MuMu，数据, 存档, 镜像都不在自己以为的地方; 
 *   - MuMu 一升级或换端口，ApkStart 就直接失效。
 * 所以第三方底座一律改成「只有用户在Settings里显式choose了才用」。
 *
 * 非 Windows (FydeOS / Linux)另当别论: 那边根本没有 emulator.exe，
 * 自带Runtime跑不起来，系统自带的安卓子系统才是唯一合理的choose择。
 */
const AUTO_ORDER = process.platform === 'win32'
  ? ['builtin', 'mumu']
  : ['fydeos', 'builtin'];

function byId(id) {
  return REGISTRY.find((B) => B.id === id) || null;
}

/** 给界面用的描述清单 (只留静态信息，能安全序列化) */
function describe() {
  return REGISTRY.map((B) => ({
    id: B.id,
    label: B.label,
    summary: B.summary,
    embedCapable: B.embedCapable,
  }));
}

/**
 * 按Settings创建一个底座实例。
 * @param {object} o { appRoot, settings, runtime, store, log }
 * @returns {{ backend: Backend, Cls: Function, id: string }}
 */
function create({ appRoot, settings, runtime, store, log }) {
  const engine = (settings && settings.engine) || {};
  let id = String(engine.mode || 'builtin');
  // 兼容老版本: mode 以前只有 builtin / attach 两种值
  if (id === 'attach') id = 'builtin';
  const Cls = byId(id) || BuiltinBackend;
  const backend = new Cls(appRoot, { runtime, store, log });
  return { backend, Cls, id: Cls.id };
}

/**
 * Automatic挑choose一个已经装好的底座 (不启动任何东西，纯Probe)。
 * 返回第一个 probe 命中的 id; 全都不命中返回 'builtin'。
 */
async function autoPick({ appRoot, store, log } = {}) {
  for (const id of AUTO_ORDER) {
    const Cls = byId(id);
    if (!Cls) continue;
    // 自带Runtime始终可choose，不需要Probe (Probe它反而要读一堆路径)
    if (id === 'builtin') return { id, reason: 'fallback' };
    try {
      // eslint-disable-next-line no-await-in-loop
      const inst = new Cls(appRoot, { store, log });
      // eslint-disable-next-line no-await-in-loop
      const r = await inst.probe();
      if (r && r.found) return { id, reason: 'detected', detail: r.detail || '' };
    } catch (_) { /* Probe失败就当没有 */ }
  }
  return { id: 'builtin', reason: 'fallback' };
}

module.exports = {
  REGISTRY, AUTO_ORDER, CAPS, byId, describe, create, autoPick, Backend,
};
