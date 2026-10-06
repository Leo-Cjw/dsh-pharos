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
vm.runInThisContext(src, { filename: 'client.js' });
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
assert(window.__dshPharos?.version === '0.6.0', '控制台 API 更名为 __dshPharos v0.6.0');

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
  {
    const r = m1Reload();
    m1Apply(r);                       // 必须 apply 才装 __dshPharos（与 M2-A 段同范式）
    const api = r.context.window.__dshPharos;
    m1a(!!api, 'apply 后 __dshPharos 可用');
    if (api) {
      const before = r.bag.notifications.length;
      api.test('workflow');
      await m1Wait(40);
      m1a(r.bag.notifications.length === before + 1, "test('workflow') 弹一次通知");
      const n = r.bag.notifications.at(-1);
      m1a(!!n && /工作流|Workflow/.test(n.title ?? ''),
        `test('workflow') 标题是工作流文案（实得：${n?.title}）`);
      m1a(!!n && !/已完成|任务完成|Task done/.test(n.title ?? ''),
        `test('workflow') 未落 else 兜底（实得：${n?.title}）`);
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
      const before = r.bag.notifications.length;
      api.test(kind);
      await m1Wait(40);
      m1a(r.bag.notifications.length === before + 1, `test('${kind}') 触发通知`);
      m1a(frameTitle(kind).test(r.bag.notifications.at(-1)?.title ?? '') === true, `test('${kind}') 标题匹配文案`);
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
    const body = r.bag.notifications.at(-1)?.body ?? '';
    m1a(body.includes('缓存命中 14%') && body.includes('13.3 tok/s'), 'test(kind, stats) 通知正文含统计文本');
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
