import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const notifications = [];
let documentTitle = 'DSH';
let pageFocus = true;
let windowFocused = false;
let audioCtxCreated = 0;
let notifPerm = 'granted';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const localStorageStore = new Map();
const localStorage = {
  getItem: (k) => (localStorageStore.has(k) ? localStorageStore.get(k) : null),
  setItem: (k, v) => localStorageStore.set(k, v),
  removeItem: (k) => localStorageStore.delete(k)
};
global.window = {
  localStorage,
  focus: () => { windowFocused = true; },
  AudioContext: class {
    constructor() { audioCtxCreated++; this.currentTime = 0; this.destination = {}; this.state = 'running'; }
    resume() {}
    close() { return Promise.resolve(); }
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, setValueAtTime() {} }, connect() {} }; }
  }
};
global.document = {
  get title() { return documentTitle; },
  set title(v) { documentTitle = v; },
  documentElement: { lang: 'zh' },
  hasFocus: () => pageFocus
};
global.Notification = class {
  constructor(title, opts) { this.title = title; this.opts = opts; this.onclick = null; notifications.push({ n: this, title, body: opts.body, tag: opts.tag }); }
  close() {}
  static get permission() { return notifPerm; }
  static requestPermission() { return Promise.resolve(notifPerm); }
};
let captured = null;

// ================= M1 增补 stub（中性：等价"无 host"，不影响上述 v0.3 断言语义） =================
// EventSource：构造记录 + 手动 dispatch；默认自动 open（贴近真实连接，但不产生任何帧）。
// 命名事件建模（WHATWG SSE 规范）：dispatch(payload, eventName) —— 带 event 名的帧
// 只派发给 addEventListener 注册的同名监听器、绝不进 onmessage；无名帧只进 onmessage。
// namedListeners 同时是契约锁的唯一事实源（client 注册的事件名必须与 host 写出的一致）。
global.EventSource = class FakeEventSource {
  constructor(url, opts) {
    this.url = url; this.opts = opts ?? {};
    this.readyState = 0; this.onopen = this.onmessage = this.onerror = null;
    this.namedListeners = new Map(); // type -> [fn, ...]
    this.closed = false;
    FakeEventSource.instances.push(this);
    if (FakeEventSource.openOnConstruct) queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
  }
  close() { this.closed = true; this.readyState = 2; }
  addEventListener(ev, fn) { const a = this.namedListeners.get(ev) ?? []; a.push(fn); this.namedListeners.set(ev, a); }
  removeEventListener(ev, fn) { this.namedListeners.set(ev, (this.namedListeners.get(ev) ?? []).filter((f) => f !== fn)); }
  dispatch(payload, eventName) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (eventName) { for (const fn of this.namedListeners.get(eventName) ?? []) fn({ data }); return; }
    this.onmessage?.({ data });
  }
  open() { this.readyState = 1; this.onopen?.({}); }
  _error() { this.onerror?.({}); }
  static instances = [];
  static openOnConstruct = true; // 测试组可临时置 false 做重连/关闭断言
};
// navigator：Node 24 的 navigator 是只读 getter，需 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN', locks: { request: async (_name, callback) => callback() } },
  configurable: true,
});
// fetch：可编程；缺省网络失败 → 客户端回退 localStorage（等价无 host）
const fetchCalls = [];
let fetchImpl = null;
global.fetch = async (url, opts = {}) => {
  fetchCalls.push({ url, opts: { ...opts, body: opts.body } });
  if (fetchImpl) return fetchImpl(url, opts);
  throw new TypeError('fetch unavailable (no host)');
};
global.fetchImplSetter = (fn) => { fetchImpl = fn; };
// document.body 最小 DOM stub（toast 兜底用）—— 纯增量，不影响 title/hasFocus 语义
if (!global.document.body) {
  const mkEl = (tag) => ({
    tag, children: [], parent: null, style: {}, className: '', textContent: '', id: '',
    classList: { add() {}, remove() {} },
    listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); },
    removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] ?? []).filter((f) => f !== fn); },
    fire(ev, arg) { for (const fn of this.listeners[ev] ?? []) fn?.(arg ?? {}); },
    appendChild(c) { this.children.push(c); c.parent = this; },
    remove() { const p = this.parent; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); } },
    querySelector: (sel) => findBySel(this.children, sel, false),
    querySelectorAll: (sel) => findBySel(this.children, sel, true),
  });
  const findBySel = (children, sel, all) => {
    const out = [];
    const walk = (nodes) => {
      for (const c of nodes) {
        const hit = sel === '*' || (sel.startsWith('.') && c.className?.split?.(' ')?.includes(sel.slice(1)))
          || (sel.startsWith('#') && c.id === sel.slice(1));
        if (hit) out.push(c);
        if (c.children?.length) walk(c.children);
      }
    };
    walk(children);
    return all ? out : (out[0] ?? null);
  };
  const body = mkEl('body');
  global.document.body = body;
  global.document.createElement = (tag) => mkEl(String(tag));
  global.document.getElementById = (id) => findBySel(body.children, '#' + id, false);
  global.document.queryBody = (sel) => findBySel(body.children, sel, false);
  global.document.bodyChildren = body.children;
  global.DSH_mkEl = mkEl;
}

window.__ModuleLoader__ = { load: (o) => { captured = o; } };
// reload()：M1 组用全新 vm 上下文隔离（每组的 window/document/Notification/Date 独立），
// 返回 { context, bundle, ES, fetchStub, bag, docBody, api }。
function reload(overrides = {}) {
  const bag = {
    notifications: [], audioCtx: 0, opened: [], focused: false,
    notifPerm: 'granted', pageFocus: true, title: 'DSH',
    ...(overrides.bag ?? {})
  };
  const doc = {
    get title() { return bag.title; }, set title(v) { bag.title = v; },
    documentElement: { lang: overrides.lang ?? 'zh-CN' },
    hasFocus: () => bag.pageFocus,
    body: global.document.body, // 复用同一 DOM stub 容器（toast box 同源可查）
    createElement: global.document.createElement,
    getElementById: global.document.getElementById,
    queryBody: global.document.queryBody,
    bodyChildren: global.document.bodyChildren,
    // M2：document 级事件（pharos:stats）——模拟真实 document 的 add/remove/dispatch
    _listeners: new Map(),
    addEventListener(ev, fn) { const a = this._listeners.get(ev) ?? []; a.push(fn); this._listeners.set(ev, a); },
    removeEventListener(ev, fn) { const a = this._listeners.get(ev) ?? []; this._listeners.set(ev, a.filter((f) => f !== fn)); },
    dispatchEvent(ev) { const a = this._listeners.get(ev?.type) ?? []; for (const fn of [...a]) fn(ev); return true; },
  };
  const win = {
    localStorage,
    focus: () => { bag.focused = true; },
    AudioContext: class {
      constructor() { bag.audioCtx++; this.currentTime = 0; this.destination = {}; this.state = 'running'; }
      resume() {}
      close() { return Promise.resolve(); }
      createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    }
  };
  const NotificationCls = class {
    constructor(title, o) { this.title = title; this.opts = o; this.onclick = null; bag.notifications.push({ n: this, title, body: o.body, tag: o.tag }); }
    close() {}
    static get permission() { return bag.notifPerm; }
    static requestPermission() { return Promise.resolve(bag.notifPerm); }
  };
  // 直接复用基类：构造器把实例写入同一 registry（无法重定向），各 group 起始已重置
  const ESCls = global.EventSource;
  const ctxObj = {
    window: win, document: doc, Notification: NotificationCls, EventSource: ESCls,
    fetch: overrides.fetch ?? global.fetch,
    navigator: { language: 'zh-CN', locks: overrides.noLocks ? null : { request: async (_n, cb) => cb() } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Promise, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, WeakMap, WeakSet,
    Uint8Array, TextEncoder, Blob, URL, URLSearchParams,
    Date: overrides.DateCtor ?? Date, crypto,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Event: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  };
  Object.defineProperty(ctxObj, 'globalThis', { value: ctxObj });
  const context = vm.createContext(ctxObj);
  let cap = null;
  context.window.__ModuleLoader__ = { load: (o) => { cap = o; } };
  vm.runInContext(src, context, { filename: 'client.js' });
  const bundle = cap.factory(() => { throw new Error('unexpected require'); });
  return { context, bundle, ES: ESCls, fetchStub: null, bag, docBody: doc.bodyChildren };
}
// 语法错误在这里会抛出裸 SyntaxError，看不出「是 client.js 坏了」还是「测试自身有问题」，
// 且报错栈只到 vm 内部，容易被误读成断言全绿（反向验证时已踩过一次）。
// 包一层：明确指出是 lib/client.js 解析失败，并给出最常见成因与排查命令。
try {
  vm.runInThisContext(src, { filename: 'client.js' });
} catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
  console.error('FAIL: lib/client.js 解析失败（SyntaxError）—— 测试无法开始，所有断言都没跑。');
  console.error(`      位置：${String(error.message).split('\n')[0]}`);
  console.error('      最常见原因：改了 lib/settings-view.js 却没跑 node tools/sync-settings-view.mjs；');
  console.error('      或内联区被手工改坏。排查：node --check lib/client.js');
  process.exit(1);
}
const bundle = captured.factory(() => { throw new Error('unexpected require'); });
const { name, inject, apply } = bundle;

const sessionsRows = { A: { id: 'A', displayTitle: '会话A' }, B: { id: 'B', displayTitle: '会话B' } };
const opened = [];
const sessionsSvc = {
  list: { getSnapshot: () => ({ byId: sessionsRows, ids: Object.keys(sessionsRows), phase: 'ready' }) },
  binding: (id) => ({ session: { open: () => opened.push(id) } })
};
let status = new Map();
const statusSubs = new Set();
let currentKey = 'A';
const uiSessionSvc = {
  current: { value: { get key() { return currentKey; } } },
  sessionStatus: {
    getSnapshot: () => status,
    subscribe: (fn) => { statusSubs.add(fn); return () => statusSubs.delete(fn); }
  }
};
let cleanup = null;
const ctx = {
  get: (svc) => (svc === 'sessions' ? sessionsSvc : svc === 'uiSession' ? uiSessionSvc : undefined),
  sessions: sessionsSvc,
  uiSession: uiSessionSvc,
  effect: (fn) => { fn(); cleanup = fn; }
};
let failed = 0;
const assert = (cond, msg) => { if (!cond) { failed++; console.error('FAIL:', msg); } else console.log('ok  :', msg); };
const tick = () => { for (const s of [...statusSubs]) s(); };
const S = (id, st) => status.set(id, st);
const count = (title) => notifications.filter((x) => x.title === title).length;

apply(ctx);
console.log('bundle name/inject:', name, JSON.stringify(inject));
assert(window.__dshPharos?.version === '0.6.1', '控制台 API 更名为 __dshPharos v0.6.1');

// baseline
assert(notifications.length === 0, '基线不弹');
S('A', { running: true, pendingInteraction: undefined, completionUnread: false });
tick();
assert(notifications.length === 0, '基线运行中不弹');

// attention（非当前会话 B）
const approval = { kind: 'approval', key: 'k-approve-1', sessionId: 'B', toolName: 'bash', reason: '需要确认删除' };
S('B', { running: true, pendingInteraction: approval, completionUnread: false });
tick();
assert(count('需要你操作') === 1, '待办出现弹一次');
assert(notifications.some((x) => x.body.includes('bash') && x.body.includes('需要确认删除')), '正文含 toolName·reason');
assert(documentTitle.startsWith('🔔 需要你 · '), '标题标记点亮');
tick();
assert(count('需要你操作') === 1, '同一待办不重复弹');

// 二次提醒（先把 reAlertMs 配置到位，再让新待办出现）
window.__dshPharos.setConfig({ reAlertMs: 90 });
const q2 = { kind: 'question', key: 'k-r1', sessionId: 'B', questions: ['测试二次提醒'] };
S('B', { running: true, pendingInteraction: q2, completionUnread: false });
tick();
const atBase = count('需要你操作');
await wait(200);
assert(count('需要你操作') === atBase + 1, '未处理待办（此处 90ms）后补发一次');
assert(notifications[notifications.length - 1].body.includes('仍未处理'), '补发正文带「仍未处理」');
tick(); // 无新变化不重复
assert(count('需要你操作') === atBase + 1, '补发不重复');

// 清掉待办 → 标记灭 + 定时器撤销（再等 200ms 不再弹）
S('B', { running: true, pendingInteraction: undefined, completionUnread: false });
tick(); tick();
assert(documentTitle === 'DSH', '标记熄灭恢复标题');
const afterClear = notifications.length;
await wait(200);
assert(notifications.length === afterClear, '已处理不再补发');
window.__dshPharos.resetConfig();

// 当前会话 + 前台 → 静默只留标记
const q1 = { kind: 'question', key: 'k-q1', sessionId: 'A', questions: ['选哪个方案？'] };
const beforeCur = count('需要你操作');
S('A', { running: true, pendingInteraction: q1, completionUnread: false });
tick();
assert(count('需要你操作') === beforeCur, '当前会话+前台 静默不弹');
assert(documentTitle.startsWith('🔔 需要你 · '), '静默但保留标记');
S('A', { running: true, pendingInteraction: undefined, completionUnread: false });
tick(); tick();
assert(documentTitle === 'DSH', '标记再恢复');

// 完成（页面隐藏）+ 耗时小结
pageFocus = false;
const sT0 = Date.now();
await wait(1100);
S('A', { running: false, pendingInteraction: undefined, completionUnread: false });
tick();
assert(count('任务已完成') === 1, '页面隐藏时完成弹通知');
const doneN = notifications.filter((x) => x.title === '任务已完成')[0];
assert(doneN.body.includes('耗时') && doneN.body.includes('秒'), '完成正文含耗时小结');
S('A', { running: false, pendingInteraction: undefined, completionUnread: true });
tick();
assert(count('任务已完成') === 2, 'unread 边沿也弹一次');

// 主开关
pageFocus = true;
window.__dshPharos.setConfig({ enabled: false });
const off = notifications.length;
const approval2 = { kind: 'approval', key: 'k-approve-2', sessionId: 'B', toolName: 'bash', reason: 'x' };
S('B', { running: true, pendingInteraction: approval2, completionUnread: false });
tick();
assert(notifications.length === off, '主开关关闭不弹');
assert(!documentTitle.startsWith('🔔'), '主开关关闭不亮标记');
window.__dshPharos.resetConfig();

// 点击通知 → 打开会话
S('B', { running: true, pendingInteraction: approval, completionUnread: false });
tick();
const lastN = notifications[notifications.length - 1];
lastN.n.onclick?.();
assert(opened.includes('B'), '点击待办通知尝试打开会话B');
assert(windowFocused === true, '点通知聚焦窗口');

// 清理当前 pending
S('B', { running: true, pendingInteraction: undefined, completionUnread: false });
tick(); tick();

// ⏳ 闪烁兜底：权限拒绝 + 未聚焦 → 不弹通知，标题闪烁；6.5s 后恢复
notifPerm = 'denied';
pageFocus = false;
const blinkStartTitle = documentTitle; // 'DSH'（无标记）
S('X', { running: true, pendingInteraction: undefined, completionUnread: false });
tick();
const n1 = notifications.length;
S('X', { running: false, pendingInteraction: undefined, completionUnread: false });
tick(); // 完成 → 弹窗被权限拦 → 走闪烁
assert(notifications.length === n1, '权限拒绝时不弹系统通知');
// （闪烁中，不在此处断言——逐拍采样在下一段进行）
// 重新制造一次并逐拍采样确认 ⏳ 前缀
S('X', { running: true, pendingInteraction: undefined, completionUnread: false });
tick();
S('X', { running: false, pendingInteraction: undefined, completionUnread: false });
tick();
const samples = [];
for (let i = 0; i < 6; i++) { await wait(260); samples.push(documentTitle); }
assert(samples.some((t) => t.startsWith('⏳ ')), '闪烁期间标题出现 ⏳ 前缀（采样: ' + samples.join(' | ') + '）');
await wait(5500);
assert(!documentTitle.startsWith('⏳ '), '闪烁结束标题恢复');

// 清理
notifPerm = 'granted';
cleanup?.();

// ============================================================================
// M1 扩展（契约 §8）：SSE 帧消费 / 双源去重 / quiet hours / 子代理过滤 / toast
// 兜底 / 服务端配置优先 / test() 扩展。全部经 reload() 隔离上下文驱动真实 client。
// 能力门：client.js 未实现 SSE（仍 v0.3）时整段跳过，等 pharos-client 落地后自动生效。
// ============================================================================
let m1Failed = 0;
let m1Passed = 0;
const m1a = (cond, msg) => { if (!cond) { m1Failed++; console.error('M1-FAIL:', msg); } else { m1Passed++; console.log('M1 ok :', msg); } };
  // ⚠️ 静态禁令类断言必须在**剥掉注释**后再搜：否则 applyStyle 的注释里写的反例
  //    会被当成违规。多个段（M1-P / M1-Q）共用，故提升到 M1 段作用域。
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // v0.6.1：test() 走 bypass → 强制**页内 toast**；真实事件走**系统通知**。
  // 断言「用户看得见反馈」必须同时认这两条通道，故统一用下面三个辅助。
  const toastBoxOf = (r) => r.docBody?.find?.((c) => c && c.id === 'dsh-pharos-toast-box');
  const toastCount = (r) => toastBoxOf(r)?.children?.length ?? 0;
  const toastText = (el) => [].concat(el?.children ?? []).map((c) => c?.textContent ?? '').join(' | ');
  const lastToastText = (r) => toastText(toastBoxOf(r)?.children?.at?.(-1));
const m1Wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- M1-I: 标记几何防漂移（icon.svg ↔ lib/client.js 的 PHAROS_MARK_*）----
// 标记有两个消费面：① 插件卡片/组件行/组合包详情页读 package.json 的 icon（根目录
// icon.svg，宿主以 <img> 渲染）；② 设置导航那一行读浏览器半里的 PHAROS_MARK_*（宿主
// 的 settings.section 没有 icon 字段，由 installSettingsNavIcon 换节点）。形状必须
// 处处一致 —— 这里是纯静态断言，不依赖沙箱（m1Apply 的 ctx 不含 slots，设置视图不挂载）。
{
  const icon = fs.readFileSync(new URL('../icon.svg', import.meta.url), 'utf8');
  const paths = [...icon.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  const circle = icon.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/);
  m1a(paths.length === 2 && !!circle, `icon.svg 形状数 = 2 路径 + 1 灯头圆（实得 ${paths.length} 路径）`);
  m1a(paths.every((d) => src.includes(`"${d}"`)), 'icon.svg 的两条路径都已内联进 client.js');
  const lamp = src.match(/PHAROS_MARK_LAMP = \{ cx: ([\d.]+), cy: ([\d.]+), r: ([\d.]+) \}/);
  m1a(!!lamp && !!circle && lamp[1] === circle[1] && lamp[2] === circle[2] && lamp[3] === circle[3],
    '灯头几何两处一致（' + (circle ? `${circle[1]}/${circle[2]}/${circle[3]}` : '缺 circle') + '）');
  m1a(/viewBox="0 0 16 16"/.test(icon) && src.includes('PHAROS_MARK_VIEWBOX = "0 0 16 16"'),
    'viewBox 两处一致（16×16，对齐 ui-primitives 的 artwork 网格）');
  // 描边式契约：宿主 artwork 是 fill:none + stroke:currentColor + 1.3 描边，
  // 填色剪影缩到 16px 会糊成竖线（已用栅格化实测）。这里锁住我们没退回去，
  // 并锁住描边权重不在放大时补偿（提到 2.2 会让 36px 卡片糊成墩子）。
  m1a(/fill="none"/.test(icon) && src.includes('svg.setAttribute("fill", "none")')
    && src.includes('svg.setAttribute("stroke", "currentColor")'),
    '描边式契约成立（fill:none + stroke:currentColor）');
  m1a(/stroke-width="1\.3"/.test(icon) && /stroke-width="1\.5"/.test(icon)
    && src.includes('PHAROS_MARK_STROKE = 1.3') && src.includes('PHAROS_MARK_STROKE_HEAVY = 1.5'),
    '描边权重两处一致（塔身 1.3 / 灯台 1.5，不做尺寸补偿）');
}

// ---- M1-J: 设置页标题行的包名/版本 与 package.json 一致 ----
// PKG_VERSION 是编译期常量（settings.section 只投影 id/order/label，没有任何 slot
// 把包版本传给浏览器半；better-sidebar 同样是 bundle 内字面量）。代价是可能与
// package.json 漂移 —— 版本号不同步最难被发现，所以锁在这里。
{
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  m1a(src.includes(`var PKG_NAME = "${pkg.name}";`), `包名与 package.json 一致（${pkg.name}）`);
  m1a(src.includes(`var PKG_VERSION = "${pkg.version}";`), `版本常量与 package.json 一致（${pkg.version}）`);
  // 徽章渲染处必须真的用了这两个常量，而不是又写了一遍字面量。
  m1a(src.includes('h("span", { className: "pharos-pkg" }, PKG_NAME)')
    && src.includes('h("span", { className: "pharos-ver" }, "v" + PKG_VERSION)'),
    '标题行渲染用的是常量而非重复字面量');
}

// ---- M1-K: M2.5 workflow 静态契约锁（防 host/client 两侧漂移）----
// 与 M1-H（host 写帧事件名 ↔ client 监听名）同范式：这些是**纯静态**的跨文件一致性断言，
// 不依赖沙箱。它们锁的是「四轮评审反复抓到的两类漂移」：
//   ① host 产出的 kind 若没在 client 的 SSE_KINDS 登记 → 帧被静默丢弃（用户啥也收不到）
//   ② TEXT.zh / TEXT.en 的 key 集合若不一致 → 漏 en 表会渲染 undefined
{
  // ① HOST_KINDS ⊆ SSE_KINDS
  const hostFrames = fs.readFileSync(new URL('../lib/host/frames.js', import.meta.url), 'utf8');
  const hostKindBody = hostFrames.match(/export const HOST_KINDS = new Set\(\[([^\]]+)\]/)?.[1] ?? '';
  const hostKinds = [...hostKindBody.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const sseKindsBlock = src.match(/const SSE_KINDS = \{([^}]+)\}/)?.[1] ?? '';
  const sseKinds = [...sseKindsBlock.matchAll(/(\w+):\s*1/g)].map((m) => m[1]);
  m1a(hostKinds.length > 0 && sseKinds.length > 0,
    `解析出 host ${hostKinds.length} 个 kind / client ${sseKinds.length} 个 SSE kind`);
  const missing = hostKinds.filter((k) => !sseKinds.includes(k));
  m1a(missing.length === 0,
    `契约：host HOST_KINDS ⊆ client SSE_KINDS${missing.length ? `（缺 ${missing.join(',')}）` : ''}`);
  m1a(sseKinds.includes('workflow'), 'SSE_KINDS 已登记 workflow（M2.5 致命项，不登记则帧被丢弃）');

  // ② TEXT.zh / TEXT.en key 集合一致（漏 en 表 → 渲染 undefined）
  // client.js 的 TEXT 是 3-tab 缩进：const TEXT = { \n\t\t\tzh: { ... \n\t\t\t}, \n\t\t\ten: { ... \n\t\t\t} }
  const textBlock = (lang) => {
    const start = src.indexOf(`\n\t\t\t${lang}: {`);
    if (start < 0) return '';
    // 该语言块的结束 = 下一个 `\n\t\t\t},` 或 `\n\t\t\t}` （缩进与 lang 同级）
    const rest = src.slice(start + 1);
    const end = rest.search(/\n\t\t\t\},?\s*$/m);
    return end < 0 ? rest : rest.slice(0, end);
  };
  const keySet = (block) => new Set([...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
  const zhKeys = keySet(textBlock('zh'));
  const enKeys = keySet(textBlock('en'));
  zhKeys.delete('zh');
  enKeys.delete('en');
  m1a(zhKeys.size > 0 && enKeys.size > 0, `解析出 TEXT.zh ${zhKeys.size} key / TEXT.en ${enKeys.size} key`);
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
  m1a(onlyZh.length === 0 && onlyEn.length === 0,
    `契约：TEXT.zh 与 TEXT.en key 集合一致${onlyZh.length || onlyEn.length
      ? `（仅 zh 有 ${onlyZh.join(',') || '无'}；仅 en 有 ${onlyEn.join(',') || '无'}）` : ''}`);
  m1a(zhKeys.has('workflowTitle') && zhKeys.has('workflowBody'), 'TEXT.zh 含 workflow 文案');
  m1a(enKeys.has('workflowTitle') && enKeys.has('workflowBody'), 'TEXT.en 含 workflow 文案（漏则渲染 undefined）');

  // ③ workflow 正文无「工作流『工作流』」双前缀：host 产片段、前缀只在 client 加
  const wfBodyZh = src.match(/workflowBody: \(sessionTitle, note\) =>\s*\n?\s*`([^`]*)`/)?.[1] ?? '';
  m1a(wfBodyZh.includes('工作流') && !/工作流[^`]*工作流/.test(wfBodyZh),
    `workflowBody 单前缀（实得：${wfBodyZh.trim().slice(0, 40)}）`);

  // ④ silent 通路三处齐全：SSE_KINDS 之后早退 + debug 队列 + EVENTS 含 workflow
  m1a(/if \(frame\.silent === true\) return;/.test(src),
    'onSseFrame 遇 silent 帧 → return（不弹通知，全渠道静默）');
  m1a(src.includes('recentFrames: [...debugFrameRing]'), 'debug() 暴露 recentFrames 环形队列');
  m1a(/const DEBUG_FRAME_RING = 20;/.test(src), 'debug 队列容量常量为 20');
  // ⚠️ 入队点必须早于 enabled/quietHours/kind 三道早退 —— 否则「提醒没来」
  // 这类最该排查的场景（开关关 / 静默期 / kind 未登记）恰好什么都看不到。
  // ⚠️ 必须在 onSseFrame 函数**区间内**比较：这两个早退串在文件别处（deliver/notify）
  // 也出现过，直接 indexOf 会命中更早的位置导致假失败。
  const onSse = src.slice(src.indexOf('function onSseFrame'), src.indexOf('function connectSse'));
  const sseCall = onSse.indexOf('pushDebugFrame(frame);');
  m1a(sseCall > 0, 'onSseFrame 内有 pushDebugFrame 调用点');
  m1a(sseCall < onSse.indexOf('if (!cfg.enabled) return;'),
    'pushDebugFrame 调用在 enabled 早退之前（enabled 关时也能观察到帧）');
  m1a(sseCall < onSse.indexOf('if (quietHoursActive()) return;'),
    'pushDebugFrame 调用在 quietHours 早退之前（静默期也能观察到帧）');
  m1a(sseCall < onSse.indexOf('SSE_KINDS, frame.kind)'),
    'pushDebugFrame 调用在 kind 闸门之前（kind 未登记时也能观察到帧）');
  // ⚠️ 缺陷回归：设置页 TEST_KINDS 的每个取值都必须登记在 ALL_TEST_KINDS，
  // 否则「测试通知」选到未登记的 kind 会落 else 分支、弹出别的文案（按钮骗人）。
  const testKindsBlock = src.match(/var TEST_KINDS = \[([\s\S]*?)\n\s*\];/)?.[1] ?? '';
  const testKinds = [...testKindsBlock.matchAll(/value: "(\w+)"/g)].map((m) => m[1]);
  const allTestBlock = src.match(/const ALL_TEST_KINDS = \{([^}]+)\}/)?.[1] ?? '';
  const allTestKinds = [...allTestBlock.matchAll(/(\w+):\s*1/g)].map((m) => m[1]);
  m1a(testKinds.length > 0 && allTestKinds.length > 0,
    `解析出 TEST_KINDS ${testKinds.length} 项 / ALL_TEST_KINDS ${allTestKinds.length} 项`);
  const unregistered = testKinds.filter((k) => !allTestKinds.includes(k));
  m1a(unregistered.length === 0,
    `契约：设置页 TEST_KINDS ⊆ ALL_TEST_KINDS${unregistered.length ? `（缺 ${unregistered.join(',')}）` : ''}`);
  m1a(allTestKinds.includes('workflow'), 'ALL_TEST_KINDS 已登记 workflow（否则测试按钮弹「完成」）');
  const eventsBlock = src.match(/var EVENTS = \[([\s\S]*?)\n\s*\];/)?.[1] ?? '';
  m1a(eventsBlock.includes('value: "workflow"'), 'EVENTS（webhook 事件清单）含 workflow');}

// group 隔离：fresh reload + apply（每个 group 独立 bundle/状态）
function m1Reload(opts = {}) {
  return reload(opts);
}
function m1Apply(r, { extraRows = {} } = {}) {
  const rows = { A: { id: 'A', displayTitle: '会话A' }, B: { id: 'B', displayTitle: '会话B' }, D2: { id: 'D2', displayTitle: '双源' }, E1: { id: 'E1', displayTitle: 'SSE' }, ...extraRows };
  const sessions = {
    list: { getSnapshot: () => ({ byId: rows, ids: Object.keys(rows), phase: 'ready' }) },
    binding: (id) => ({ session: { open: () => r.bag.opened.push(id) } })
  };
  const status = new Map();
  const subs = new Set();
  const uiSession = {
    current: { value: { get key() { return 'A'; } } },
    sessionStatus: { getSnapshot: () => status, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } }
  };
  const ctxObj = {
    get: (s) => (s === 'sessions' ? sessions : s === 'uiSession' ? uiSession : undefined),
    sessions, uiSession, effect: () => {}
  };
  r.bundle.apply(ctxObj);
  return { sessions, status, subs: [...subs], tick: () => { for (const s of [...subs]) s(); } };
}
const m1Frame = (kind, sessionId, note, extra = {}) => ({
  kind, severity: { done: 'info', error: 'error', interrupted: 'warn', limit: 'error', job: 'info', remote: 'info', test: 'info' }[kind],
  sessionId, agentType: 'root', note, ts: Date.now(), dedupeKey: `${kind}:${sessionId}`, source: 'host', ...extra,
});
const frameTitle = (kind) => {
  // 与 TEXT 文案松耦合的标题模式（含 v0.4 新文案；按契约语义匹配）
  if (kind === 'done') return /完成/;
  if (kind === 'error') return /出错|错误|异常/;
  if (kind === 'interrupted') return /中断|终止/;
  if (kind === 'limit') return /上限|限额/;
  if (kind === 'job') return /任务/;
  if (kind === 'remote') return /远程/;
  if (kind === 'test') return /测试/;
  return null;
};

const m1Ready = global.EventSource.instances.length > 0 && typeof window.__dshPharos === 'object'
  && typeof window.__dshPharos.test === 'function';
if (!m1Ready) {
  // v0.3 起 client.js 必然注册 __dshPharos —— 走到这里只有一种可能：文件语法错误 /
  // 内联区未同步，导致 sandbox 里 evaluate 失败。此前这个分支只打印 skip 并以 0 退出，
  // 反向验证时「破坏代码 → 整段 M1 被静默跳过 → 摘要仍显示全绿」，假阴性极难察觉。
  // 故改为硬失败，并把「源码里根本没有 SSE 消费实现」这一唯一合法豁免单独放行。
  const srcRaw = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const hasImpl = /__dshPharos/.test(srcRaw);
  console.error('FAIL: M1 浏览器扩展组未能加载 —— client.js 已包含实现却不注册 __dshPharos。');
  console.error('      最常见原因：lib/settings-view.js 改后未跑 node tools/sync-settings-view.mjs，');
  console.error('      或内联区被手工改坏导致 lib/client.js 语法错误（先跑 node --check lib/client.js）。');
  console.error(`      源码是否含实现：${hasImpl ? '含（→ 是加载失败）' : '不含（→ 尚未实现，可豁免）'}`);
  if (hasImpl) {
    m1Failed++;
    console.log(`\n${failed} 项失败（v0.3）+ ${m1Failed} 项失败（M1）`);
    process.exit(1);
  }
  console.log('skip : M1 浏览器扩展组暂跳过 —— client.js 尚未实现 SSE/新 kind（仍为 v0.3），等 pharos-client 交付后自动生效');
  console.log('skip : 覆盖项：SSE 帧消费(done/error/interrupted/limit/job/remote) / 双源 done 去重 / quiet hours / 子代理过滤 / toast 兜底 / 服务端配置优先 / test() 扩展');
} else {
  // ---- M1-A: SSE 帧消费 → 对应通知 + 音效 ----
  {
    localStorage.removeItem('dshPharos.config');
    const r = m1Reload({ bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    r.context.document.bodyChildren.length = 0;
    m1Apply(r);
    const es = r.ES.instances.at(-1);
    m1a(es !== undefined, 'apply 后建立 EventSource 连接');
    if (es) m1a(es.url === '/pharos/api/stream', 'EventSource 指向 /pharos/api/stream');
    if (es) {
      // done/error/interrupted/limit/job/remote 各弹一次，正文含帧 note
      const kinds = ['done', 'error', 'interrupted', 'limit', 'job', 'remote'];
      for (const kind of kinds) {
        const note = `SSE-${kind}-正文-XYZ`;
        const beforeNotif = r.bag.notifications.length;
        const beforeAudio = r.bag.audioCtx;
        es.dispatch(m1Frame(kind, kind.toUpperCase(), note), 'pharos');
        await m1Wait(40);
        m1a(r.bag.notifications.length === beforeNotif + 1, `SSE ${kind} 帧 → 弹一次通知`);
        m1a(r.bag.notifications.at(-1)?.body.includes(note), `SSE ${kind} 通知正文含帧 note`);
        m1a(frameTitle(kind) === null || frameTitle(kind).test(r.bag.notifications.at(-1)?.title ?? '') === true, `SSE ${kind} 标题匹配文案（${r.bag.notifications.at(-1)?.title}）`);
        m1a(r.bag.audioCtx > beforeAudio, `SSE ${kind} 帧 → 有音效尝试（音型区分）`);
      }
    }
  }

  // ---- M1-L: test(kind) 覆盖 workflow（缺陷回归：ALL_TEST_KINDS 漏 workflow 时，
  // 设置页「测试通知」选「工作流」会落 else 分支弹出「完成」——按钮骗人）----
  // ⚠️ v0.6.1：test() 走 bypass → 强制**页内 toast**（系统通知不在页面上、可能被横幅吞掉），
  //    故断言对象从 bag.notifications 改为 docBody（toast 容器）。这是「用户点按钮能看见反馈」
  //    的真正契约 —— 之前只查系统通知，恰恰漏掉了用户实际看到的那条通道。
  {
    const r = m1Reload();
    m1Apply(r);                       // 必须 apply 才装 __dshPharos（与 M2-A 段同范式）
    const api = r.context.window.__dshPharos;
    m1a(!!api, 'apply 后 __dshPharos 可用');
    if (api) {
      // m1Reload 已给全新 vm 上下文（body 是新的），这里只记基线；toast 计数在断言时现取。
      const sysBefore = r.bag.notifications.length;
      const boxBefore = r.docBody?.find?.((c) => c && c.id === 'dsh-pharos-toast-box');
      const toastBefore = boxBefore?.children?.length ?? 0;
      const ret = api.test('workflow');
      await m1Wait(40);
      m1a(ret === 'workflow', `test('workflow') 回显实际 kind（实得：${ret}）`);
      // 差值断言（对累积免疫）：toast box 由 toastBoxEl 惰性创建，取 box 的 children 数
      const toastBoxEl2 = r.docBody?.find?.((c) => c && c.id === 'dsh-pharos-toast-box')
        ?? r.docBody?.[0];
      const toastCount = toastBoxEl2?.children?.length ?? 0;
      m1a(toastCount - toastBefore === 1,
        `test('workflow') 产出一条页内反馈（bypass 通道，delta=${toastCount - toastBefore}）`);
      m1a(r.bag.notifications.length === sysBefore,
        'test() 不再走系统通知（bypass 固定页内，避免「点了像没反应」）');
      // toast 容器是 append 到 body 的 #dsh-pharos-toast-box（body.children[0]），
      // 真正的 toast 在它的 children 里；每个 toast 的文案在其子元素上（[0]=标题/[1]=正文）。
      const toastBox = r.docBody?.[0];
      const firstToast = toastBox?.children?.[0];
      const toastText = (el) => [].concat(el?.children ?? []).map((c) => c?.textContent ?? '').join(' | ');
      const dom = toastText(firstToast);
      m1a(/工作流|Workflow/.test(dom),
        `test('workflow') 页内反馈是工作流文案（实得：${dom.slice(0, 40)}）`);
      m1a(!/已完成|任务完成|Task done/.test(dom),
        `test('workflow') 未落 else 兜底（实得：${dom.slice(0, 40)}）`);
    }
  }

  // ---- M1-M: workflow 子代理的 done 被过滤（skipSubagents 作用于「本地 done 路径」）----
  // 缺陷回归：skipSubagents 原本只在 onSseFrame 生效，而 uiSession 边沿驱动的
  // 本地 done 路径（maybeNotifyDone / completionUnread → notifyDone）无判定 →
  // 多 agent 工作流时子代理完成会混进「任务已完成」通知。
  // 修法：host 在 agent-start 帧捎带 childId → 浏览器半存 childAgentIds →
  //      notifyDone 判定该 Set（下到最内层，覆盖绕过 maybeNotifyDone 的路径）。
  {
    localStorage.removeItem('dshPharos.config');
    const r = m1Reload({ bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    const ui = m1Apply(r);   // 返回 { sessions, status, tick }
    const setUi = (id, st) => { ui.status.set(id, st); ui.tick(); };
    const doneTitles = (from) => r.bag.notifications.slice(from)
      .filter((n) => /已完成|finished|Task done/.test(n.title ?? ''));

    // ① 先收到 agent-start 帧（带 childId）→ 浏览器半登记子代理
    const es = r.ES.instances.at(-1);
    if (es) {
      es.dispatch(m1Frame('workflow', 'RUN-1', '启动 agent 读取员（第 1 个）',
        { subtype: 'agent-start', childId: 'CHILD-1', sessionTitle: 'wf' }), 'pharos');
      await m1Wait(40);
    }
    m1a(true, 'agent-start 帧（带 childId）已投递');

    // ② 子代理会话 running true→false → 本地 done 路径 → 应被 skipSubagents 过滤
    let before = r.bag.notifications.length;
    setUi('CHILD-1', { running: true, pendingInteraction: undefined, completionUnread: false });
    setUi('CHILD-1', { running: false, pendingInteraction: undefined, completionUnread: false });
    await m1Wait(60);
    m1a(doneTitles(before).length === 0,
      `子代理完成 → 不弹「任务已完成」（实得 ${doneTitles(before).length} 条）`);

    // ③ 对照：非子代理会话完成 → 照常弹（证明不是一刀切）
    before = r.bag.notifications.length;
    setUi('ROOT-1', { running: true, pendingInteraction: undefined, completionUnread: false });
    setUi('ROOT-1', { running: false, pendingInteraction: undefined, completionUnread: false });
    await m1Wait(60);
    m1a(doneTitles(before).length === 1,
      `非子代理完成 → 照常弹一次（对照组，实得 ${doneTitles(before).length} 条）`);

    // ④ 关掉 skipSubagents → 子代理完成应恢复提醒（开关真的生效，非硬编码）
    // 用另一个 childId：② 已给 CHILD-1 记过 lastDoneAt，minIntervalMs(6s) 会节流掉重复通知
    r.context.window.__dshPharos.setConfig({ skipSubagents: false });
    before = r.bag.notifications.length;
    es.dispatch(m1Frame('workflow', 'RUN-1', '启动 agent 分析员（第 2 个）',
      { subtype: 'agent-start', childId: 'CHILD-2', sessionTitle: 'wf' }), 'pharos');
    await m1Wait(40);
    setUi('CHILD-2', { running: true, pendingInteraction: undefined, completionUnread: false });
    setUi('CHILD-2', { running: false, pendingInteraction: undefined, completionUnread: false });
    await m1Wait(60);
    m1a(doneTitles(before).length === 1,
      `关掉 skipSubagents → 子代理完成恢复提醒（开关生效，实得 ${doneTitles(before).length} 条）`);
  }

  // ---- M1-N: 设置页「测试」按钮契约锁（静态）----
  // 缺陷背景：用户点「完成」没反应。根因排查发现设置视图在 sandbox 里不挂载，
  // 无法做点击模拟；而 data-pharos-test 此前**零测试覆盖** —— 按钮掉了 onClick
  // 也不会有任何断言失败。故用静态契约锁住「按钮结构完整 + onClick 真的绑到 onTest」，
  // 配合 M1-L/M1-G 的行为断言（test() 走 bypass 产页内反馈）构成两道防线。
  {
    // ① 按钮由 TEST_KINDS 渲染，每项都带 data-pharos-test + onClick
    const btnBlock = src.match(/TEST_KINDS\.map\(function \(k\) \{([\s\S]*?)\}\)/)?.[1] ?? '';
    m1a(btnBlock.length > 0, '设置页测试按钮由 TEST_KINDS.map 渲染（找到渲染块）');
    m1a(btnBlock.includes('onClick: function () { onTest(k.value); }'),
      '每个测试按钮的 onClick 绑定到 onTest(k.value)（防 onClick 丢失）');
    m1a(btnBlock.includes('"data-pharos-test": k.value'),
      '每个测试按钮带 data-pharos-test（供 e2e / 手工定位）');
    // ② onTest 成功与失败两条分支都要写 debug —— 否则「点了没反应」无从排查
    const onTestBlock = src.slice(src.indexOf('function onTest(kind)'), src.indexOf('function onDebugRefresh'));
    m1a(onTestBlock.length > 0 && onTestBlock.includes('debugLog("test(" + kind'),
      'onTest 首行写 debugLog（点按钮必有第一行记录）');
    m1a(onTestBlock.includes('configApi.test 不可用'),
      'onTest 有「api 不可用」兜底分支并写 debug（不留静默失败）');
    m1a(onTestBlock.includes('实际 kind='),
      'onTest 回显实际触发的 kind（v0.6.1：点完能看到到底触发了什么）');
    // ③ test() 必须传 bypass —— 缺了就会被 quietHours / doneHiddenOnly 静默
    const testImpl = src.slice(src.indexOf('test: (kind, stats)'), src.indexOf('debug: () =>'));
    m1a(testImpl.includes('bypass: true'),
      'test() 传 bypass: true（测试不受静默策略影响，且强制页内反馈）');
    // ④ deliver 的 bypass 分支必须置 toasting —— 否则页内 toast 会弹两条
    const deliverBlock = src.slice(src.indexOf('function deliver('), src.indexOf('// ---- tracking state ----'));
    m1a(/if \(bypass\) \{[\s\S]*?toasting = true;/.test(deliverBlock),
      'deliver 的 bypass 分支置 toasting=true（防页内 toast 重复弹两条）');
  }

  // ---- M1-O: agents 元信息帧 → 过滤**普通** subagent 的本地 done（v0.6.1）----
  // 缺陷背景：v0.6.0 只能用 workflow/agent-start 帧的 childId 识别子代理，
  // 而普通 subagent 委派（agent/* 工具派生，不经 workflow）不产 workflow 帧 →
  // 浏览器半永远识别不了，子代理完成通知会混进「任务已完成」。
  // 修法：host 判出 agentTypeOf==='subagent' → agents 帧下发 subagentSessionIds。
  {
    localStorage.removeItem('dshPharos.config');
    const r = m1Reload({ bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    const ui = m1Apply(r);
    const setUi = (id, st) => { ui.status.set(id, st); ui.tick(); };
    const es = r.ES.instances.at(-1);
    const doneCount = (from) => r.bag.notifications.slice(from)
      .filter((n) => /已完成|finished|Task done/.test(n.title ?? '')).length;

    // ① host 下发 agents 帧（子代理 G-1）
    if (es) {
      es.dispatch(m1Frame('agents', 'agents', '子代理登记',
        { subagentSessionIds: ['G-1'], silent: true }), 'pharos');
      await m1Wait(40);
    }
    // ② 该子代理的会话跑完 → 本地 done 路径 → 应被过滤
    let before = r.bag.notifications.length;
    setUi('G-1', { running: true, pendingInteraction: undefined, completionUnread: false });
    setUi('G-1', { running: false, pendingInteraction: undefined, completionUnread: false });
    await m1Wait(60);
    m1a(doneCount(before) === 0,
      `agents 帧登记的子代理完成 → 不弹「任务已完成」（实得 ${doneCount(before)} 条）`);

    // ③ 对照：未登记的会话完成 → 照常弹（证明不是一刀切）
    before = r.bag.notifications.length;
    setUi('G-2', { running: true, pendingInteraction: undefined, completionUnread: false });
    setUi('G-2', { running: false, pendingInteraction: undefined, completionUnread: false });
    await m1Wait(60);
    m1a(doneCount(before) === 1,
      `未登记的会话完成 → 照常弹（对照组，实得 ${doneCount(before)} 条）`);

    // ④ agents 帧累积多个 id（host 每次新增子代理都下发全量）
    if (es) {
      es.dispatch(m1Frame('agents', 'agents', '子代理登记',
        { subagentSessionIds: ['G-1', 'G-2', 'G-3'], silent: true }), 'pharos');
      await m1Wait(40);
      before = r.bag.notifications.length;
      setUi('G-3', { running: true, pendingInteraction: undefined, completionUnread: false });
      setUi('G-3', { running: false, pendingInteraction: undefined, completionUnread: false });
      await m1Wait(60);
      m1a(doneCount(before) === 0,
        `agents 列表扩充后新子代理也被过滤（实得 ${doneCount(before)} 条）`);
    }
  }

  // ---- M1-P: v0.6.1 契约锁：本地时间戳 + 不用 el.style 对象赋值 ----
  // 两条都来自真机暴露的缺陷（自动化测试全绿但真机不可用）：
  {
    // ① debugLog 必须用**本地**时间：toISOString() 是 UTC，东八区差 8 小时
    const logBlock = codeOnly.slice(codeOnly.indexOf('function debugLog'), codeOnly.indexOf('function traceError'));
    m1a(!logBlock.includes('toISOString()'),
      'debugLog 不用 toISOString（那是 UTC，会比本地时间差一个时区）');
    m1a(logBlock.includes('getHours()') && logBlock.includes('getMinutes()'),
      'debugLog 用 getHours/getMinutes 取本地时间');
    // ② 禁止 el.style = {...}：真实 DOM 里 el.style 是只读 CSSStyleDeclaration，
    //    非严格模式下赋值**静默失败** → 元素创建了却无样式（透明、无固定定位），
    //    表现为「点了测试按钮什么都没出现」。测试桩是普通对象（style 可写）故测不出。
    // 排除 applyStyle 函数体自身（它的 fallback 分支就是给测试桩用的。真机有 setProperty 分支，
    // 且 assignInside 断言会再锁一次「setProperty 分支在赋值分支之前」）。
    const applyStyleStart = codeOnly.indexOf('function applyStyle(');
    const applyStyleEnd = codeOnly.indexOf('function toastBoxEl(', applyStyleStart);
    const outsideApplyStyle = codeOnly.slice(0, applyStyleStart) + codeOnly.slice(applyStyleEnd);
    const styleAssigns = outsideApplyStyle.match(/\w+\.style = \{/g) ?? [];
    m1a(styleAssigns.length === 0,
      `applyStyle 之外无 \w+.style = { 赋值（真实 DOM 静默失败；实得 ${styleAssigns.length} 处）`);
    const applyStyleBody = codeOnly.slice(applyStyleStart, applyStyleEnd);
    m1a(applyStyleBody.indexOf('setProperty') < applyStyleBody.indexOf('el.style ='),
      'applyStyle 里 setProperty 分支在对象赋值分支**之前**（真机优先走对的那条）');
    m1a(codeOnly.includes('function applyStyle('), '有 applyStyle 辅助（逐条 setProperty）');
    m1a(/if \(el\.style && typeof el\.style\.setProperty === "function"\)/.test(codeOnly),
      'applyStyle 优先用 setProperty（真实 CSSStyleDeclaration 路径）');
  }

  // ---- M1-Q: v0.6.1「完成」提醒三档（off / hidden / always + 向后兼容映射）----
  // 背景：原设计只有二档 checkbox（doneHiddenOnly 布尔），无法表达「关」与「始终」两端。
  // 竞品（VS Code windowNotFocused / Codex unfocused / ChatGPT background）均为三档且
  // 默认 hidden。v0.6.1 加 doneNotifyMode，旧字段按布尔映射以保证老配置行为不变。
  {
    localStorage.removeItem('dshPharos.config');
    const r = m1Reload({ bag: { pageFocus: true } });   // 页面在前台
    global.EventSource.instances.length = 0;
    const ui = m1Apply(r);
    const api = r.context.window.__dshPharos;
    const setUi = (id, st) => { ui.status.set(id, st); ui.tick(); };
    const runDone = async (sid) => {
      const before = r.bag.notifications.length;
      setUi(sid, { running: true, pendingInteraction: undefined, completionUnread: false });
      setUi(sid, { running: false, pendingInteraction: undefined, completionUnread: false });
      await m1Wait(60);
      return r.bag.notifications.length - before;
    };

    // ① 默认 hidden：页面前台 → 不提醒
    let n = await runDone('D1');
    m1a(n === 0, `默认档（hidden）页面在前台 → 不提醒（实得 ${n} 条）`);

    // ② always：页面前台 → 提醒
    api.setConfig({ doneNotifyMode: 'always', doneHiddenOnly: false });
    n = await runDone('D2');
    m1a(n === 1, `always 档页面在前台 → 提醒（实得 ${n} 条）`);

    // ③ off：页面**在前台**也不提醒（只测 hidden 会漏掉这条独立判定）
    api.setConfig({ doneNotifyMode: 'off', doneHiddenOnly: true });
    n = await runDone('D3');
    m1a(n === 0, `off 档页面在前台 → 不提醒（实得 ${n} 条）`);

    // ③b off：**页面隐藏时也不提醒** —— 这是 off 与 hidden 的唯一区别，
    //      若实现里 off 落到 hidden 分支，这里会误报 1 条。
    r.bag.pageFocus = false;                       // 切到后台
    n = await runDone('D3b');
    m1a(n === 0, `off 档页面在后台 → 也不提醒（off 与 hidden 的区别，实得 ${n} 条）`);
    r.bag.pageFocus = true;                        // 复位

    // ③c hidden 在后台**要**提醒（与 ③b 构成对照，证明 hidden 档没被误关）
    api.setConfig({ doneNotifyMode: 'hidden', doneHiddenOnly: true });
    r.bag.pageFocus = false;
    n = await runDone('D3c');
    m1a(n === 1, `hidden 档页面在后台 → 提醒（对照组，实得 ${n} 条）`);
    r.bag.pageFocus = true;

    // ④ 向后兼容：只有旧字段 doneHiddenOnly=false（老 0.6.0 配置）→ 等价 always
    api.setConfig({ doneNotifyMode: undefined, doneHiddenOnly: false });
    n = await runDone('D4');
    m1a(n === 1, `旧配置 doneHiddenOnly=false → 映射 always（实得 ${n} 条）`);

    // ⑤ 向后兼容：旧配置 doneHiddenOnly=true → 等价 hidden
    api.setConfig({ doneNotifyMode: undefined, doneHiddenOnly: true });
    n = await runDone('D5');
    m1a(n === 0, `旧配置 doneHiddenOnly=true → 映射 hidden（实得 ${n} 条）`);

    // ⑥ 设置页下拉存在且三档齐全（静态锁，防 UI 漏一档）
    m1a(/value: "off"[\s\S]*value: "hidden"[\s\S]*value: "always"/.test(codeOnly),
      '设置页「完成」提醒时机下拉含 off/hidden/always 三档');
    m1a(codeOnly.includes('patchConfig({ doneNotifyMode: v, doneHiddenOnly: v !== "always" })'),
      '下拉同时写 doneHiddenOnly（旧主机侧/旧版本仍能读）');
  }

  // ---- M1-R: 设置页布局契约锁（v0.6.1 真机截图暴露：标签被 select 挤成竖排）----
  // .pharos-field 是 display:flex，控件（尤其 option 文案长的 select，如三档下拉的
  // 「仅页面隐藏时提醒（默认）」）会撑大并把左侧标签压成逐字竖排、互相重叠。
  // 修法：给首个 span 与 select 都加 flex-shrink 保护。
  {
    m1a(/\.pharos-field>span:first-child\{flex:0 0 auto\}/.test(codeOnly),
      '首个 span 标签有 flex 收缩保护（不被控件挤压）');
    m1a(/\.pharos-field select\{flex:0 0 auto;max-width:100%\}/.test(codeOnly),
      'select 有 flex:0 0 auto + max-width（不撑破容器、不无限挤压标签）');
    // 三档下拉的 option 文案较长，是触发该 bug 的直接原因 —— 锁住它不会变长
    m1a(codeOnly.includes('仅页面隐藏时提醒（默认）'),
      '三档下拉的最长 option 文案存在（回归时会再次触发挤压）');
  }

  // ---- M1-S: 模板预设三档 UI（v0.6.2）----
  // 设置视图在 sandbox 不挂载，无法点击模拟 → 用静态契约锁住「预设档齐全 + 仅自定义展开编辑区」。
  {
    m1a(codeOnly.includes('var TEMPLATE_PRESET_CONCISE ='), '内置「简洁」预设常量');
    m1a(codeOnly.includes('var TEMPLATE_PRESET_DETAIL ='), '内置「详细」预设常量');
    m1a(codeOnly.includes('function templatePresetOf(tpl)'), '有 templatePresetOf 判定（按内容全等，不新增字段）');
    m1a(/\{ id: "concise"/.test(codeOnly) && /\{ id: "detail"/.test(codeOnly) && /\{ id: "custom"/.test(codeOnly),
      '预设三档：concise / detail / custom');
    m1a(codeOnly.includes('name: "pharos-tpl-" + row._key'),
      'radio 的 name 按行隔离（多行 webhook 互不串档）');
    // 编辑区只在 custom 档渲染 —— 断言「条件表达式在、且确实包着 textarea」，
    // 不能只 includes 那个字符串（去掉条件后字符串仍留在文件里，会假通过）。
    const tplBlock = codeOnly.slice(codeOnly.indexOf('className: "pharos-template-block"'));
    const editGuard = tplBlock.slice(0, tplBlock.indexOf('"data-pharos-field": "template"'));
    m1a(/preset === "custom"\s*\?\s*h\("div"/.test(editGuard),
      '模板编辑区受 preset === "custom" 条件守卫（简洁/详细不显示 textarea）');
    m1a(/preset === "custom"\s*\?\s*h\("p"/.test(tplBlock),
      '变量清单同样只在自定义档显示');

    // ---- void 元素 children 契约（#137 真机崩溃的门禁）----
    // 真机报 React #137「input is a void element tag and must neither have children」，
    // 整页设置打不开。根因：h() 无条件把 children 作为第三参传给 createElement ——
    // 无子节点时传的是**空数组**，React 仍判定「有 children」→ void 元素直接抛。
    // 静态断言（"有没有 if children.length === 0"）只能锁形状、锁不住语义，
    // 故这里用**模拟 React 真实判定**的迷你 createElement 实跑一遍 h()。
    {
      const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'track', 'area', 'base', 'embed', 'param', 'col', 'wbr']);
      // 与 React 一致：第三参为 undefined 表示无 children；空数组视为有 children
      const fakeCreateElement = (type, props, ...kids) => {
        const hasKids = kids.length > 0 && kids[0] !== undefined;
        if (VOID_TAGS.has(String(type).toLowerCase()) && hasKids) {
          throw new Error(`${type} is a void element tag and must neither have \`children\` nor use \`dangerouslySetInnerHTML\`.`);
        }
        return { type, props: props ?? null, kids };
      };
      // 从源码里抽出 h() 的真实实现来跑，避免「测的是重写版、不是线上那版」。
      // 用花括号配平截取函数体（按行/缩进截会切错：函数内有 if/嵌套块）。
      const hStart = src.indexOf('function h(tag, props) {');
      let depth = 0, hEnd = -1;
      for (let i = src.indexOf('{', hStart); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { hEnd = i + 1; break; } }
      }
      m1a(hStart >= 0 && hEnd > hStart, '能从 client.js 定位并截取 h() 源码（门禁桩的前提）');
      const h = new Function('React', `${src.slice(hStart, hEnd)}; return h;`)({ createElement: fakeCreateElement });

      let voidOk = true, voidMsg = '';
      try { h('input', { type: 'radio', name: 'x' }); } catch (e) { voidOk = false; voidMsg = e.message; }
      m1a(voidOk, 'h() 渲染无子节点的 input（模板预设 radio）不抛 #137 —— ' + (voidOk ? '' : voidMsg));

      let spanOk = true;
      try { h('span', null, '标签'); } catch (e) { spanOk = false; }
      m1a(spanOk, 'h() 传单个子节点仍正常（有 children 的元素不受影响）');

      let twoOk = true;
      try { h('div', null, 'a', 'b'); } catch (e) { twoOk = false; }
      m1a(twoOk, 'h() 传多个子节点仍正常');

      // 反向自检：把 children 无条件传出的写法塞进去，必须抛 —— 证明上面那个桩真能抓
      let probeThrew = false;
      try { fakeCreateElement('input', null, []); } catch (e) { probeThrew = true; }
      m1a(probeThrew, '门禁桩自身有效：空数组 children 会让 void 元素抛错（非空断言）');
    }

    // ---- 「自定义」档可进可退（真机 bug：点自定义后立刻弹回，永远进不去）----
    // 根因：templatePresetOf 按**内容全等**判档，而「切到自定义」那一刻内容仍等于
    // 某个预设 → 判回该预设 → 界面弹回。修法是 customRows 记录 UI 意图（不落盘）。
    // 这里实跑状态机：复刻 markPreset + preset 判定，走完整「简洁→自定义→详细→自定义」序列。
    {
      // ⚠️ 常量与判定函数必须**从 client.js 提取真实实现**，测试内自抄副本会与实现漂移
      //    （此前副本的 templateOfPreset 缺 custom 分支、切档逻辑也已过期，却一直"通过"）。
      // 按花括号配平截函数体后执行（不能按行/缩进截）
      const braceEnd = (fromIdx) => {
        let depth = 0;
        for (let i = src.indexOf('{', fromIdx); i >= 0 && i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
        }
        return -1;
      };
      // ⚠️ 判定逻辑现在依赖「归一化 + 历史表」多个声明，逐个注入太脆（漏一个就 ReferenceError，
      //    整个 smoke 直接崩而不是断言失败）。改为**整块提取**：从第一个预设常量到
      //    templateOfPreset 结束，一次性求值，只注入它唯一的外部依赖 asArray。
      const blockStart = src.indexOf('var TEMPLATE_PRESET_CONCISE =');
      const blockEnd = braceEnd(src.indexOf('function templateOfPreset(p) {'));
      m1a(blockStart > 0 && blockEnd > blockStart, '能定位「预设常量 + 归一化 + 判定」整块代码');
      const asArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
      const P = new Function('asArray', `${src.slice(blockStart, blockEnd)};
        return { presetKindOf, migrateTemplate, templatePresetOf, templateOfPreset, hasLegacyTemplate };`)(asArray);
      const { templatePresetOf, templateOfPreset } = P;
      const TPL_C = templateOfPreset('concise');
      const TPL_D = templateOfPreset('detail');
      const TPL_S = templateOfPreset('custom');
      m1a(TPL_C && TPL_D && TPL_S && typeof templatePresetOf === 'function',
        '能从 client.js 整块提取并执行真实预设实现（三个常量 + 判定函数）');

      // 旧预设原文不能被误判成「自定义」（否则老配置的 radio 显示错档、也不再自动升级）
      for (const [old, kind] of [
        ['### {title}\n\n**{kindLabel}**\n\n{note}\n\n> {summary}\n> {time}', 'concise'],
        ['### {title}\n\n**{note}**\n\n> {summary}\n> {time}', 'concise'],
        ['### {title}\n\n**{note}**\n\n---\n\n> ⏱ {duration}\n> 🔢 {tokens}\n> 💾 {cache}\n> ⚡ {tps}\n> 🕐 {time}', 'detail'],
      ]) {
        m1a(templatePresetOf(old) === kind, `旧写法仍判为 ${kind}（不是 custom）`);
        m1a(P.migrateTemplate(old) === templateOfPreset(kind), `旧写法升级为当前 ${kind} 原文`);
        m1a(P.presetKindOf(P.migrateTemplate(old)) === kind, '升级后仍判同档（迁移幂等）');
      }
      // 用户自己写的模板绝不能被改写
      m1a(P.migrateTemplate('{note} 我自己写的') === '{note} 我自己写的',
        '用户自定义模板不被迁移改写');

      let marks = {};                                   // 等价 customRows
      let draft = {};                                   // 等价 customDraft
      let tpl = TPL_C;                                  // 等价 row.template
      const markPreset = (id) => {
        const n = {};
        for (const k in marks) n[k] = marks[k];
        if (id === 'custom') n.r1 = 'custom'; else delete n.r1;
        marks = n;
      };
      // 复刻设置视图里的判定表达式（与静态断言锁的那行一致）
      const currentPreset = () => (marks.r1 === 'custom' ? 'custom' : templatePresetOf(tpl));
      // 复刻 textarea onChange：改内容同时记草稿
      const editTemplate = (v) => { tpl = v; draft.r1 = v; };
      // 复刻 radio onChange：切自定义时的内容来源优先级 草稿 → 当前 → 起手式
      const clickRadio = (id) => {
        if (id === 'custom') {
          const cur = String(tpl || '').trim();
          // 与实现一致：用归一化归类判断「是不是某档预设原文」（比逐个比对常量更耐改）
          const isPresetText = cur === '' || P.presetKindOf(cur) !== 'custom';
          const d = draft.r1;
          tpl = (typeof d === 'string' && d !== '')
            ? d
            : (isPresetText ? TPL_S : tpl);
          markPreset('custom');
        } else {
          tpl = templateOfPreset(id);
          markPreset(id);
        }
      };

      clickRadio('custom');
      m1a(currentPreset() === 'custom', '点「自定义」后停在 custom 档（不再被内容判定弹回）');
      m1a(tpl.trim() !== '', '切自定义时模板内容已填充（textarea 不空）');
      m1a(tpl === TPL_S, '从预设切到自定义 → 内容换成专属起手式（不再与详细逐字相同）');

      clickRadio('detail');
      m1a(currentPreset() === 'detail', '从自定义切回「详细」生效（标记已清）');

      clickRadio('custom');
      m1a(currentPreset() === 'custom', '再次点「自定义」仍能进（双向可切）');
      m1a(tpl === TPL_S, '再次切自定义仍得到起手式（详细原文 → 起手式）');

      clickRadio('concise');
      m1a(currentPreset() === 'concise', '切回「简洁」生效');

      // 用户已写的自定义内容切档往返后必须原样保留（不丢稿）
      clickRadio('custom');
      editTemplate('{note} 我的自定义');
      clickRadio('detail');
      clickRadio('custom');
      m1a(tpl === '{note} 我的自定义', '用户已写的自定义内容：切走再切回不丢稿（恢复草稿）');

      // 用户真改了模板后，内容判定应接管（标记不能永久粘住）
      editTemplate('{note} 自定义写法');
      m1a(templatePresetOf(tpl) === 'custom', '模板内容真被改后按内容判为 custom（不依赖标记）');

      // 反向自检：还原成「只看内容」的旧判定，点自定义确实会弹回 → 证明断言非空
      const naive = templatePresetOf(tpl = TPL_C);
      m1a(naive === 'concise', '门禁非空：旧的无标记判定在同场景下会判回 concise（即原 bug）');
      m1a(templateOfPreset('custom') === TPL_S && templateOfPreset('detail') === TPL_D
        && templateOfPreset('concise') === TPL_C, 'templateOfPreset 三档各自返回正确的模板');

      m1a(codeOnly.includes('customRows[row._key] === "custom" ? "custom" : templatePresetOf(row.template)'),
        '设置视图用 customRows 标记优先判 custom');
      m1a(/function markPreset\(id\)/.test(codeOnly) && /delete n\[row\._key\]/.test(codeOnly),
        '切回简洁/详细时清掉 custom 标记（否则粘在 custom）');

      // v0.6.2：切到自定义时换成**专属起手式**，否则内容与刚离开的预设逐字相同 →
      // 用户切完发现「详细和自定义没区别」（真机反馈）。且只在内容是预设原文时才替换，
      // 用户已写的自定义内容必须原样保留（反复切档不丢稿）。
      m1a(codeOnly.includes('var TEMPLATE_PRESET_CUSTOM_SEED ='),
        '有自定义档专属起手式常量（与两个预设都不同）');
      m1a(/var isPresetText = cur === "" \|\| presetKindOf\(cur\) !== "custom";/.test(codeOnly),
        '用归一化归类判断「当前内容是否预设原文」（比逐个比对常量更耐改）');
      m1a(/isPresetText \? TEMPLATE_PRESET_CUSTOM_SEED : row\.template/.test(codeOnly),
        '自定义内容来源：非预设原文时保留用户已写内容（不套用起手式）');
      m1a(codeOnly.includes('var [customDraft, setCustomDraft] = useState({})'),
        '有 customDraft 草稿状态（切去预设再切回自定义不丢稿）');
      // 切自定义的内容来源必须真的读 customDraft —— 不能用「含某段字符」的宽正则，
      // 那种写法在把来源换成 undefined 后仍会匹配（本轮实测假通过）。
      // 改为按花括号截出 custom 分支，逐项校验数据流。
      {
        const at = codeOnly.indexOf('if (p.id === "custom") {');
        let depth = 0, end = -1;
        for (let i = codeOnly.indexOf('{', at); at >= 0 && i < codeOnly.length; i++) {
          if (codeOnly[i] === '{') depth++;
          else if (codeOnly[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        const branch = end < 0 ? '' : codeOnly.slice(at, end + 1);
        m1a(branch.includes('customDraft[row._key]'), '切自定义时读取该行的 customDraft 草稿');
        m1a(branch.includes('isPresetText ? TEMPLATE_PRESET_CUSTOM_SEED : row.template'),
          '草稿为空时才回落到「起手式 / 保留当前内容」');
        m1a(/updateRow\(row\._key, \{ template: next \}\);/.test(branch), '自定义分支最终写入 next');
        m1a(!/if \(isPresetText\) updateRow\(row\._key, \{ template: TEMPLATE_PRESET_CUSTOM_SEED \}\);/.test(branch)
          || branch.includes('customDraft[row._key]'),
          '不再是无条件套用起手式（草稿优先）');
      }
      m1a(/setCustomDraft\(function \(m\)/.test(codeOnly), '编辑模板时记录草稿');
      m1a(codeOnly.includes('templateOfPreset(p.id)') && /function templateOfPreset\(p\)[\s\S]{0,300}?TEMPLATE_PRESET_CUSTOM_SEED/.test(codeOnly),
        'templateOfPreset 认识 custom 分支');
      // 「简洁」恢复按钮已按用户要求移除
      m1a(!/debugLog\("已恢复简洁预设"\)/.test(codeOnly), '模板编辑区的「简洁」按钮已移除');
    }
    m1a(codeOnly.includes('"data-pharos-preset": p.id'), '每档带 data-pharos-preset（便于定位/测试）');
    // 切预设时写入对应模板常量
    m1a(codeOnly.includes('updateRow(row._key, { template: templateOfPreset(p.id) })'),
      '切预设档即写入对应模板内容（单一数据源，无双份状态）');
    m1a(codeOnly.includes('.pharos-radio-row{'), '有 radio 行的 CSS（三档横排）');
  }

  // ---- M1-T: 自动保存（v0.6.2，底部「保存设置」按钮已移除）----
  // 用户反馈：按钮在最底下，改完没滚到底就切走，以为没生效/配置丢了。
  // 改为「改动即存」。这里实跑状态机（复刻 scheduleSave + persist 的判重与计时语义），
  // 锁住三个最容易写错的点：① 回填不自触发 ② debounce 合并 ③ 卸载后不写回。
  {
    m1a(!/onClick: onSave/.test(codeOnly), '底部「保存设置」按钮已移除');
    m1a(!/"data-pharos-save"/.test(codeOnly), '不再有 data-pharos-save 元素');
    m1a(codeOnly.includes('"data-pharos-autosave"'), '有自动保存状态指示区');
    m1a(codeOnly.includes('var AUTO_SAVE_MS = 800;'), '有 800ms debounce 常量');

    // 静态：所有用户改动入口都必须接 scheduleSave，漏一个就会「改了不存」。
    // ⚠️ 不能用「起始位置起 N 字符窗口」判定 —— 窗口会越界到下一个函数的
    //    scheduleSave()，导致删掉本函数的调用后断言仍通过（假阴性，已实测）。
    //    必须按花括号配平**精确截出该函数体**再判定。
    const fnBodyAt = (marker) => {
      const at = codeOnly.indexOf(marker);
      if (at < 0) return null;
      let depth = 0, end = -1;
      for (let i = codeOnly.indexOf('{', at); i < codeOnly.length; i++) {
        if (codeOnly[i] === '{') depth++;
        else if (codeOnly[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      return end < 0 ? null : codeOnly.slice(at, end + 1);
    };
    const saveCallSites = ['function patchConfig(patch) {', 'function updateRow(key, partial) {',
      'function removeRow(key) {', 'function addRow() {', 'function onReset() {'];
    for (const site of saveCallSites) {
      const body = fnBodyAt(site);
      const name = site.replace('function ', '').replace(' {', '');
      m1a(body !== null, `能按花括号配平截出 ${name} 函数体`);
      if (body !== null) {
        m1a(body.includes('scheduleSave()'), `${name} 函数体内已接 scheduleSave()`);
      }
    }
    m1a(/onClick: function \(\) \{[\s\S]{0,300}?scheduleSave\(\);/.test(codeOnly), '「全部启用」已接 scheduleSave');
    m1a(/setTokenMode\(e\.target\.value\)[\s\S]{0,120}?scheduleSave\(\);/.test(codeOnly), 'token 模式切换已接 scheduleSave');
    m1a(/setTokenDraft\(e\.target\.value\); scheduleSave\(\);/.test(codeOnly), 'token 输入已接 scheduleSave');

    // 实跑：用 client.js 里的真实 scheduleSave/persist 语义做等价的微型状态机
    {
      let saved = [];            // 每次真正落盘记录一次
      let dirty = false, timer = null;
      const flush = () => { dirty = false; saved.push('write'); };
      const scheduleSave = (ms) => {
        dirty = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; if (!dirty) return; flush(); }, ms);
      };

      // ① 连续改动只在停手后落盘一次（debounce 合并）
      scheduleSave(0); scheduleSave(0); scheduleSave(0);
      await m1Wait(20);
      m1a(saved.length === 1, 'debounce：连改 3 次只落盘 1 次（实际 ' + saved.length + '）');

      // ② 保存成功后服务端回填 → 若回填也置脏就会无限循环；此处回填不调 scheduleSave
      saved = [];
      // 模拟回填：只改状态，不调 scheduleSave（真实实现里 setCfg/setWebhooks 不置脏）
      await m1Wait(20);
      m1a(saved.length === 0, '回填不触发保存（无自循环）');

      // ③ 内部 800ms 常量与实现一致
      const msMatch = codeOnly.match(/var AUTO_SAVE_MS = (\d+);/);
      m1a(msMatch && Number(msMatch[1]) === 800, 'AUTO_SAVE_MS 确实是 800');

      // ④ 门禁非空自检：若把「回填也置脏」的写法放进去，必须能观察到多余落盘
      saved = [];
      scheduleSave(0);            // 用户改一次
      scheduleSave(0);            // 等价于「回填又置脏」
      await m1Wait(20);
      m1a(saved.length >= 1, '门禁非空：置脏确实会落盘（断言真能观察到写入）');
    }

    // token 隐患：mode=set 但未输入时不得清空已存 token
    m1a(/function tokenValueOf\(cfgV, mode, draft\)/.test(codeOnly), '有 tokenValueOf 纯函数');
    m1a(/if \(mode === "set"\) return draft !== "" \? draft : \(cfgV\.apiToken \|\| ""\);/.test(codeOnly),
      'mode=set 但输入为空时保持原 token（不再静默清空）');
  }

  // ---- M1-B: 双源 done 去重（SSE done 与 uiSession done 同 key 只弹一次） ----
  {
    localStorage.removeItem('dshPharos.config');
    const r = m1Reload({ bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    const d = m1Apply(r);
    r.context.window.__dshPharos.setConfig({ doneHiddenOnly: false, minIntervalMs: 6000 });
    const es = r.ES.instances.at(-1);
    // ① uiSession 边沿 done
    const doneTitle = /完成/.test(r.bag.notifications.at(-1)?.title ?? '') ? null : null;
    d.status.set('D2', { running: true, pendingInteraction: undefined, completionUnread: false });
    d.tick();
    d.status.set('D2', { running: false, pendingInteraction: undefined, completionUnread: false });
    d.tick();
    const n1 = r.bag.notifications.length;
    m1a(n1 === 1, 'uiSession running→false 边沿 done 弹一次（总数 ' + n1 + '）');
    // ② 同 session 的 SSE done 帧（去重窗内）→ 不新增
    es.dispatch(m1Frame('done', 'D2', 'host方完成同会话'), 'pharos');
    await m1Wait(60);
    m1a(r.bag.notifications.length === n1, '双源 done 同 key（SSE + uiSession）只弹一次');
    // ③ 对照：不同 session 的 SSE done 正常弹
    es.dispatch(m1Frame('done', 'E1', '其他会话完成'), 'pharos');
    await m1Wait(60);
    m1a(r.bag.notifications.length === n1 + 1, '不同 session 的 SSE done 正常弹出');
    void doneTitle;
  }

  // ---- M1-C: quiet hours 命中不弹 + 窗口外恢复 ----
  {
    const frozenNight = class FDate extends Date { constructor(...a) { super(...(a.length ? a : [new Date(2026, 0, 1, 23, 30, 0).getTime()])); } static now() { return new Date(2026, 0, 1, 23, 30, 0).getTime(); } };
    const r = m1Reload({ DateCtor: frozenNight, bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    localStorage.setItem('dshPharos.config', JSON.stringify({
      quietHours: { enabled: true, start: '23:00', end: '08:00' }, doneHiddenOnly: false,
    }));
    m1Apply(r);
    const es = r.ES.instances.at(-1);
    es.dispatch(m1Frame('done', 'Q1', 'quiet正文'), 'pharos');
    await m1Wait(60);
    m1a(r.bag.notifications.length === 0, 'quiet hours 生效期（23:30∈23:00-08:00）不弹');
    m1a(!r.bag.title.startsWith('🔔'), 'quiet hours 生效期不亮标记');
  }
  {
    const frozenDay = class FDate extends Date { constructor(...a) { super(...(a.length ? a : [new Date(2026, 0, 1, 10, 0, 0).getTime()])); } static now() { return new Date(2026, 0, 1, 10, 0, 0).getTime(); } };
    const r = m1Reload({ DateCtor: frozenDay, bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    localStorage.setItem('dshPharos.config', JSON.stringify({
      quietHours: { enabled: true, start: '23:00', end: '08:00' }, doneHiddenOnly: false,
    }));
    m1Apply(r);
    const es = r.ES.instances.at(-1);
    es.dispatch(m1Frame('done', 'Q2', 'quiet正文2'), 'pharos');
    await m1Wait(60);
    m1a(r.bag.notifications.length === 1, 'quiet hours 窗口外（10:00）恢复通知');
  }

  // ---- M1-D: 子代理过滤 ----
  {
    localStorage.removeItem('dshPharos.config');
    const r = m1Reload({ bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    m1Apply(r);
    const es = r.ES.instances.at(-1);
    // 默认 skipSubagents=true
    es.dispatch(m1Frame('done', 'D1', '子代理完成', { agentType: 'subagent' }), 'pharos');
    await m1Wait(60);
    m1a(r.bag.notifications.length === 0, 'skipSubagents 默认丢弃子代理 done 帧');
    es.dispatch(m1Frame('done', 'D2', '顶层完成', { agentType: 'root' }), 'pharos');
    await m1Wait(60);
    m1a(r.bag.notifications.length === 1, 'root done 帧正常弹出');
    r.context.window.__dshPharos.setConfig({ skipSubagents: false });
    es.dispatch(m1Frame('done', 'D1', '子代理再完成', { agentType: 'subagent', dedupeKey: 'done:D1b' }), 'pharos');
    await m1Wait(60);
    m1a(r.bag.notifications.length === 2, 'skipSubagents=false 时子代理帧恢复弹出');
  }

  // ---- M1-E: toast 兜底（权限 denied） ----
  {
    localStorage.removeItem('dshPharos.config');
    const r = m1Reload({ bag: { pageFocus: false, notifPerm: 'denied' } });
    global.EventSource.instances.length = 0;
    r.context.document.bodyChildren.length = 0;
    const d = m1Apply(r);
    const es = r.ES.instances.at(-1);
    es.dispatch(m1Frame('done', 'T1', 'TOAST-1'), 'pharos');
    await m1Wait(60);
    m1a(r.bag.notifications.length === 0, '权限 denied 不弹系统通知');
    const box = r.context.document.getElementById('dsh-pharos-toast-box') ?? r.context.document.queryBody('.dsh-pharos-toast-box');
    m1a(box !== null, '权限 denied 时 DOM 出现 #dsh-pharos-toast-box');
    const toastEls = () => (box ? box.children.filter((el) => el.className.includes('toast')) : []);
    m1a(toastEls().length >= 1, 'toast 容器内有 toast 元素');
    // 点击 toast → 尝试打开会话
    toastEls()[0]?.fire?.('click');
    m1a(r.bag.opened.includes('T1') || r.bag.opened.length > 0, '点击 toast 尝试打开会话');
    // 上限 4 条：连续 5 个不同事件
    for (let i = 2; i <= 6; i++) {
      es.dispatch(m1Frame('done', 'T' + i, 'TOAST-' + i), 'pharos');
    }
    await m1Wait(80);
    m1a(toastEls().length <= 4, 'toast 上限 4 条（当前 ' + toastEls().length + '）');
    // 6s 自动消失
    await m1Wait(6000);
    m1a(toastEls().length === 0, 'toast 6s 后自动消失');
    void d;
  }

  // ---- M1-F: 服务端配置优先 + 失败回退 ----
  {
    // ① 服务端 enabled=false 覆盖 localStorage enabled=true
    localStorage.setItem('dshPharos.config', JSON.stringify({ enabled: true, doneHiddenOnly: false }));
    const r = m1Reload({
      bag: { pageFocus: false },
      fetch: async (url) => (String(url).includes('/pharos/api/config')
        ? { ok: true, status: 200, json: async () => ({ enabled: false, doneHiddenOnly: false }) }
        : { ok: false, status: 404 }),
    });
    global.EventSource.instances.length = 0;
    m1Apply(r);
    // fetch GET /config 是异步合并：轮询等服务端配置落定（上限 300ms）再断言
    const api = r.context.window.__dshPharos;
    const deadlineF = Date.now() + 300;
    while (typeof api === 'object' && api.config && api.config().enabled !== false && Date.now() < deadlineF) {
      await m1Wait(10);
    }
    m1a(typeof api === 'object' && typeof api.config === 'function' && api.config().enabled === false, '服务端配置缓存覆盖 localStorage（enabled=false）');
    const es = r.ES.instances.at(-1);
    es.dispatch(m1Frame('done', 'S1', '服务端关闭'), 'pharos');
    await m1Wait(60);
    m1a(r.bag.notifications.length === 0, '服务端 enabled=false 时不发通知');
  }
  {
    // ② 服务端不可达 → 回退 localStorage
    localStorage.setItem('dshPharos.config', JSON.stringify({ enabled: true, doneHiddenOnly: false }));
    const r = m1Reload({ bag: { pageFocus: false }, fetch: async () => { throw new TypeError('no host'); } });
    global.EventSource.instances.length = 0;
    m1Apply(r);
    m1a(r.context.window.__dshPharos.config().enabled === true, '服务端不可达回退 localStorage（enabled=true）');
    const es = r.ES.instances.at(-1);
    es.dispatch(m1Frame('done', 'S2', '本地回退'), 'pharos');
    await m1Wait(60);
    m1a(r.bag.notifications.length === 1, '回退 localStorage 后通知照发');
  }

  // ---- M1-G: test('error'|'interrupted'|'limit') 扩展 ----
  {
    localStorage.removeItem('dshPharos.config');
    const r = m1Reload({ bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    m1Apply(r);
    const api = r.context.window.__dshPharos;
    for (const kind of ['error', 'interrupted', 'limit']) {
      const sysBefore = r.bag.notifications.length;
      const toastBefore = toastCount(r);
      api.test(kind);
      await m1Wait(40);
      m1a(toastCount(r) - toastBefore === 1, `test('${kind}') 产出一条页内反馈（delta=${toastCount(r) - toastBefore}）`);
      m1a(r.bag.notifications.length === sysBefore, `test('${kind}') 不发系统通知（bypass 固定页内）`);
      m1a(frameTitle(kind).test(lastToastText(r)) === true,
        `test('${kind}') 标题匹配文案（实得：${lastToastText(r).slice(0, 30)}）`);
    }
  }

  // ---- M1-H: SSE 命名/无名路由契约（R1 回归 + 契约锁） ----
  {
    localStorage.removeItem('dshPharos.config');
    const r = m1Reload({ bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    m1Apply(r);
    const es = r.ES.instances.at(-1);
    // ① 命名帧 → 弹通知，且绝不进 onmessage 注册的处理器（WHATWG SSE 路由）
    let onmessageCalls = 0;
    const origOnmessage = es.onmessage;
    es.onmessage = (ev) => { onmessageCalls += 1; origOnmessage?.(ev); };
    es.dispatch(m1Frame('remote', 'H1', '命名帧路由'), 'pharos');
    await m1Wait(40);
    m1a(r.bag.notifications.at(-1)?.body.includes('命名帧路由') === true, '命名帧（event:pharos）→ 弹通知');
    m1a(onmessageCalls === 0, '命名帧绝不触发 onmessage 处理器');
    // ② 无名帧 → onmessage 兼容路（client 故意保留，防宿主未来发无名帧）
    const before = r.bag.notifications.length;
    es.dispatch(m1Frame('remote', 'H2', '无名帧兼容'));
    await m1Wait(40);
    m1a(r.bag.notifications.length === before + 1, '无名帧走 onmessage 兼容路 → 弹通知');
    // ③ 契约锁：client 注册的事件名与 host 写出的一致（routes.js 全局唯一 event: 命中）
    const hostSrc = fs.readFileSync(new URL('../lib/host/routes.js', import.meta.url), 'utf8');
    const wireEvent = /event:\s*([A-Za-z0-9_-]+)/.exec(hostSrc)?.[1];
    m1a(typeof wireEvent === 'string' && es?.namedListeners?.has(wireEvent), `契约锁：client 注册的事件名与 host 写出的一致（${wireEvent}）`);
  }

  // ---- M2-A: test(kind, stats) 扩展 + stats() 访问器 + localStorage 兜底 ----
  {
    localStorage.removeItem('dshPharos.config');
    localStorage.removeItem('dshPharos.stats');
    const r = m1Reload({ bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    m1Apply(r);
    const api = r.context.window.__dshPharos;
    m1a(typeof api.stats === 'function', 'installApi 暴露 stats() 访问器');
    m1a(api.stats() === null, '初始无统计 → stats() 返回 null');
    // test('done', { stats }) 传入可选统计 → stats() 可读 + localStorage 兜底
    api.test('done', { tokens: 240, durationMs: 12345, cacheHitRate: 0.142, tps: 13.3 });
    await m1Wait(40);
    const st = api.stats();
    m1a(st !== null && typeof st === 'object', 'test(kind, stats) 后 stats() 非 null');
    m1a(st && st.tokens === 240, 'stats().tokens 透传（投影 delta）');
    m1a(st && Math.abs(st.cacheHitRate - 0.142) < 1e-9, 'stats().cacheHitRate 透传');
    m1a(st && Math.abs(st.tps - 13.3) < 1e-9, 'stats().tps 透传');
    const persisted = JSON.parse(localStorage.getItem('dshPharos.stats') || 'null');
    m1a(persisted && persisted.tokens === 240, 'localStorage dshPharos.stats 兜底已写');
    // P1-1：通知正文含统计文本（test 路径 done 分支把 statsSummaryOf 织进 summary）
    const body = lastToastText(r);   // v0.6.1：test() 走页内 toast
    m1a(body.includes('缓存命中 14%') && body.includes('13.3 tok/s'),
      `test(kind, stats) 反馈正文含统计文本（实得：${body.slice(0, 60)}）`);
  }

  // ---- M2-B: SSE 帧带统计字段 → stats 更新 + pharos:stats 事件 ----
  {
    localStorage.removeItem('dshPharos.config');
    localStorage.removeItem('dshPharos.stats');
    const r = m1Reload({ bag: { pageFocus: false } });
    global.EventSource.instances.length = 0;
    m1Apply(r);
    const es = r.ES.instances.at(-1);
    const api = r.context.window.__dshPharos;
    let statEvent = null;
    r.context.document.addEventListener('pharos:stats', (ev) => { statEvent = ev.detail; });
    es.dispatch(m1Frame('done', 'S1', '', { tokens: 300, durationMs: 8000, cacheHitRate: 0.5, tps: 25 }), 'pharos');
    await m1Wait(40);
    const st = api.stats();
    m1a(st && st.tokens === 300, 'SSE 帧带 tokens → stats().tokens 更新');
    m1a(st && Math.abs(st.cacheHitRate - 0.5) < 1e-9, 'SSE 帧带 cacheHitRate → stats().cacheHitRate 更新');
    m1a(statEvent && statEvent.tokens === 300, 'SSE 帧带统计 → 派发 pharos:stats CustomEvent');
  }
}

console.log(failed + m1Failed === 0
  ? `\n全部断言通过（v0.3 ${notifications.length} 条通知 / audioCtx ${audioCtxCreated}；M1 ${m1Passed} 项）`
  : `\n${failed} 项失败（v0.3）+ ${m1Failed} 项失败（M1）`);
const totalFailed = failed + m1Failed;
process.exit(totalFailed === 0 ? 0 : 1);
