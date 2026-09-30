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
  setItem: (k, v) => localStorageStore.set(k, v)
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
window.__ModuleLoader__ = { load: (o) => { captured = o; } };
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
assert(window.__dshPharos?.version === '0.3.0', '控制台 API 更名为 __dshPharos v0.3.0');

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
console.log(failed === 0 ? `\n全部断言通过（通知 ${notifications.length} 条, audioCtx ${audioCtxCreated} 次）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
