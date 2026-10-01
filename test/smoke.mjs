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
assert(window.__dshPharos?.version === '0.4.1', '控制台 API 更名为 __dshPharos v0.4.1');

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
}

console.log(failed + m1Failed === 0
  ? `\n全部断言通过（v0.3 ${notifications.length} 条通知 / audioCtx ${audioCtxCreated}；M1 ${m1Passed} 项）`
  : `\n${failed} 项失败（v0.3）+ ${m1Failed} 项失败（M1）`);
const totalFailed = failed + m1Failed;
process.exit(totalFailed === 0 ? 0 : 1);
