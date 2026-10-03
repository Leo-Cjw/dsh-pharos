// dsh-pharos — host 半单测（M1，契约 §8）
//
// 覆盖（黑盒经 apply() + stub ctx/webServer/fetch；白盒直接 import lib/host/*）：
//   · reason.kind→kind 全映射（completed/error/aborted/interrupted/blocked/max-tokens → 定类，
//     未知静默）+ 帧字段（kind/severity/sessionId/ts/dedupeKey/note/tokens/source）
//   · usage 四桶计量、耗时计量
//   · 兜底：agent/error、agent/turn-stopping（aborted 守卫）、agent/request-error（limit 语义）、
//     agent/status idle、jobs settled（failed→error / killed→interrupted / completed→job；
//     awaited/teardown/removed 忽略）
//   · 帧总线去重窗（默认 3000ms 常量 + 行为验证）
//   · SSE 广播（event: pharos / data: 帧 JSON；握手 200；25s ping 计划）
//   · trigger 鉴权（无/错/对 token、非 loopback 403、缺 Host 403、content-type 400、坏 JSON 400）
//   · config GET 打码 / PUT 深合并 / 原子落盘（tmp+rename，无残留）/ 默认合并
//   · GET /webhooks 打码列表
//   · webhook 适配器 4 渠道加签（wecom sha256 hex / feishu hmac base64 / dingtalk query / generic
//     透传）+ 重试 3 次指数退避 + 失败环形缓冲 50 上限 + quiet hours 拦 webhook +
//     events/skipSubagents/enabled=false 过滤
//   · quiet hours 跨午夜判定（isQuietNow 白盒）
// 失败一律 process.exit(1)；零新增依赖（node 内置）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

let failed = 0;
let passed = 0;
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('FAIL:', msg); }
  else { passed++; console.log('ok  :', msg); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- host 模块加载（探测形态；契约 §1 以交付为准） ----------
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const importFresh = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let hostMod = null;
try { hostMod = await importFresh('lib/host.js'); }
catch { hostMod = await importFresh('lib/index.js'); }
let frames = null, store = null, webhook = null, routes = null, stats = null;
try { frames = await importFresh('lib/host/frames.js'); } catch { /* optional */ }
try { store = await importFresh('lib/host/store.js'); } catch { /* optional */ }
try { webhook = await importFresh('lib/host/webhook.js'); } catch { /* optional */ }
try { routes = await importFresh('lib/host/routes.js'); } catch { /* optional */ }
try { stats = await importFresh('lib/host/stats.js'); } catch { /* optional */ }

const apply = hostMod.apply ?? hostMod.default?.apply;
console.log('host entry:', Object.keys(hostMod).join(','));
if (typeof apply !== 'function') { console.error('FAIL: host 入口没有 apply'); process.exit(1); }

// ---------- stub fetch ----------
function makeFetchStub() {
  const calls = [];
  let impl = null;
  const stub = async (url, opts = {}) => {
    calls.push({ url, opts: { ...opts, body: opts.body } });
    if (impl) return impl(url, opts);
    throw new TypeError('fetch: no program for ' + url);
  };
  stub.calls = calls;
  stub.setImpl = (fn) => { impl = fn; };
  stub.reset = () => { calls.length = 0; impl = null; };
  stub.okJson = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) });
  return stub;
}

// ---------- node:http 风格 req/res ----------
function makeRes() {
  const chunks = [];
  const state = { status: 0, headers: {}, ended: false, destroyed: false };
  const listeners = {};
  return {
    state, chunks,
    writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers ?? {}); return this; },
    write(chunk) { if (chunk !== undefined && chunk !== null) chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk !== undefined && chunk !== null) chunks.push(String(chunk)); state.ended = true; return this; },
    destroy() { state.destroyed = true; },
    on(ev, fn) { (listeners[ev] ??= []).push(fn); return this; },
    emit(ev) { for (const fn of listeners[ev] ?? []) fn?.(); return this; },
    get body() { return chunks.join(''); },
  };
}
function makeReq({ method = 'GET', url = '/pharos/api/config', headers = {}, remoteAddress = '127.0.0.1', body } = {}) {
  const listeners = {};
  const req = {
    method, url,
    remoteAddress,
    headers: { host: '127.0.0.1:5147', ...headers },
    on(ev, fn) { (listeners[ev] ??= []).push(fn); return this; },
    emit(ev) { for (const fn of listeners[ev] ?? []) fn?.(); return this; },
  };
  // readJsonBody 用 for await —— real IncomingMessage 恒为 async iterable
  req[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield JSON.stringify(body);
  };
  return req;
}

// ---------- stub ctx（on 捕获 / inject 捕获 / get / jobs / webServer） ----------
function makeStubCtx({ webServerExtra = {} } = {}) {
  const handlers = new Map();
  const injects = new Map();       // name[] -> cb
  const routes = [];
  const jobSubs = [];
  const services = new Map();
  const webServer = {
    host: '127.0.0.1',
    port: 5147,
    register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; },
    ...webServerExtra,
  };
  const jobs = {
    events: {
      subscribe(opts, cb) { jobSubs.push({ opts, cb }); return () => { const i = jobSubs.findIndex((e) => e.cb === cb); if (i >= 0) jobSubs.splice(i, 1); }; },
    },
  };
  const ctx = {
    get(name, fresh) {
      if (name === 'jobs') return jobs;
      return services.get(name);
    },
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    inject(name, cb) { const key = Array.isArray(name) ? name[0] : name; injects.set(key, cb); return () => injects.delete(key); },
    effect() { return () => {}; },
    provide(name, value) { services.set(name, value); },
    handlers, injects, routes, jobSubs, jobs, webServer,
  };
  return ctx;
}

// webServer 注入回调实跑（等价于 cordis 注入完成）
function materializeWebServer(ctx) {
  const cb = ctx.injects.get('webServer');
  if (typeof cb === 'function') cb({ webServer: ctx.webServer });
}

// ---------- 帧提取（SSE data 行） ----------
const sseFrames = (res) => res.chunks
  .flatMap((c) => String(c).split(/\r?\n\r?\n/))
  .map((record) => { const m = /^data:\s*(.+)$/m.exec(record); return m ? m[1] : null; })
  .filter(Boolean)
  .map((d) => { try { return JSON.parse(d); } catch { return null; } })
  .filter(Boolean);

// ---------- 环境（每个测试独立 ctx；同一 DSH_HOME 临时目录） ----------
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-host-'));
process.env.DSH_HOME = DSH_HOME;
const profileName = 'test';
const profileDir = path.join(DSH_HOME, 'profiles', profileName);
fs.mkdirSync(profileDir, { recursive: true });

function setup({ dedupeMs, profileContext } = {}) {
  // 隔离：每个测试独立 store，落盘文件一律重置（避免前段配置——quietHours/apiToken/
  // jobEvents——泄漏到后段）
  try { fs.rmSync(path.join(profileDir, 'pharos.json'), { force: true }); } catch { /* */ }
  const fetchStub = makeFetchStub();
  globalThis.fetch = fetchStub;
  const ctx = makeStubCtx();
  ctx.provide('profileContext', profileContext ?? { name: profileName });
  const disposer = apply(ctx, { ...(dedupeMs ? { dedupeMs } : {}) });
  materializeWebServer(ctx);
  return { ctx, fetchStub, disposer };
}
function getStreamHandle(ctx) {
  // 单一 prefix '/pharos/api' 分发；取得到该路由的 handler
  const route = ctx.routes.find((r) => r.path === '/pharos/api');
  return route ? route.handler : null;
}
function callApi(ctx, url, { method = 'GET', headers, remoteAddress, body, waitEnd = true } = {}) {
  const handler = getStreamHandle(ctx);
  const res = makeRes();
  const req = makeReq({ method, url, headers, remoteAddress, body });
  let rejected = null;
  try {
    handler(req, res);
  } catch (e) { rejected = e; res.state.threw = e; }
  // routes.js 前缀分发是 fire-and-forget（Promise.resolve(handle(...)).catch(...)，
  // 不返回给调用方）——轮询 res.end 才拿到异步 handler 的最终状态。
  const done = (async () => {
    if (rejected) return res;
    const deadline = Date.now() + (waitEnd ? 500 : 20);
    while (!res.state.ended && Date.now() < deadline) await wait(5);
    return res;
  })();
  return { res, done, url };
}
const putConfig = async (ctx, body) => {
  const c = callApi(ctx, '/pharos/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
  await c.done;
  return c;
};
const getConfig = async (ctx) => {
  const c = callApi(ctx, '/pharos/api/config');
  await c.done;
  return c;
};
const getWebhooks = async (ctx) => {
  const c = callApi(ctx, '/pharos/api/webhooks');
  await c.done;
  return c;
};
const openStream = (ctx) => callApi(ctx, '/pharos/api/stream', { waitEnd: false });
const trigger = async (ctx, opts = {}) => {
  const c = callApi(ctx, '/pharos/api/trigger', { method: 'POST', headers: { 'content-type': 'application/json', ...(opts.extraHeaders ?? {}) }, remoteAddress: opts.remoteAddress, body: opts.body ?? { title: 't', body: '提醒' } });
  await c.done;
  return c;
};

function fireSessionEvent(ctx, { type, reason, session, usage }) {
  const h = ctx.handlers.get('session/event');
  const event = { type, data: { turn: { id: 't1' }, ...(reason ? { reason } : {}), ...(usage !== undefined ? { usage } : {}) } };
  const sess = session ?? { id: 'S1', header: {} };
  h(sess, event);
}
function fireAgentEvent(ctx, name, payload) {
  const h = ctx.handlers.get(name);
  h(payload, undefined); // serial/emit 模式：next 不存在
}

// ---------- Date 冻结（quiet hours 行为用） ----------
const RealDate = globalThis.Date;
function freezeDate(ts) {
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [ts])); } static now() { return ts; } }
  FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
  globalThis.Date = FakeDate;
}
function unfreezeDate() { globalThis.Date = RealDate; }

// ============================================================
// 断言区
// ============================================================

// ---- 1. reason.kind 白盒映射（frames.mapTurnEndReason） ----
if (frames && typeof frames.mapTurnEndReason === 'function') {
  const m = frames.mapTurnEndReason;
  const cases = [
    ['completed', 'done'], ['error', 'error'], ['aborted', 'error'],
    ['interrupted', 'interrupted'], ['blocked', 'limit'], ['max-tokens', 'limit'],
  ];
  for (const [reasonKind, want] of cases) {
    assert(m(reasonKind) === want, `mapTurnEndReason(${reasonKind}) → ${want}`);
  }
  for (const unknown of ['forked', 'user-stopped', 'weird-kind', undefined]) {
    assert(m(unknown) === null || m(unknown) === undefined, `未知 reason.kind(${String(unknown)}) → 静默（null/undefined）`);
  }
} else {
  console.log('skp : frames.mapTurnEndReason 未导出（由黑盒覆盖）');
}

// ---- 2. turn/end → 帧字段（黑盒） ----
{
  const { ctx, disposer } = setup();
  const { res, done } = openStream(ctx);
  await done;
  const before = res.chunks.length;
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: { id: 'S1', header: {} } });
  await wait(60);
  const frames_ = sseFrames(res);
  assert(frames_.length === 1, 'completed turn/end 产出 1 帧（未去重跳过）');
  const f = frames_[0];
  assert(f && f.kind === 'done', 'kind=done');
  assert(f && f.severity === 'info', 'done severity=info');
  assert(f && f.sessionId === 'S1', 'sessionId=S1');
  assert(f && f.dedupeKey === 'done:S1', 'dedupeKey=done:S1');
  assert(f && typeof f.ts === 'number' && f.ts > 0, 'ts 为 host 时钟时间戳');
  assert(f && typeof f.note === 'string' && f.note.includes('完成'), 'note 含完成文案');
  assert(f && f.source === 'host', 'source=host');
  assert(f && f.agentType === 'root', '无会话头信息 agentType=root');
  assert(res.chunks.some((c) => c.includes('event: pharos')), 'SSE 事件名 pharos');
  disposer();
}

// ---- 3. usage 四桶计量 + 耗时计量 ----
{
  const { ctx, disposer } = setup();
  const { res } = openStream(ctx);
  const t0 = Date.now();
  fireSessionEvent(ctx, { type: 'turn/start', session: { id: 'S1', header: {} } });
  fireSessionEvent(ctx, { type: 'assistant/message', session: { id: 'S1' }, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 2, cacheWriteTokens: 3 } });
  fireSessionEvent(ctx, { type: 'assistant/message', session: { id: 'S1' }, usage: { inputTokens: 5, outputTokens: 5 } });
  await wait(50);
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: { id: 'S1', header: {} } });
  await wait(60);
  const f = sseFrames(res)[0];
  assert(f && f.tokens === 45, 'usage 四桶合计=45（10+20+2+3+5+5）');
  assert(f && typeof f.durationMs === 'number' && f.durationMs >= 50, 'durationMs 含耗时（>=50ms）');
  disposer();
}

// ---- 4. error/aborted/interrupted/blocked/max-tokens 定类（黑盒） ----
{
  const specs = [
    ['error', 'error', 'error'], ['aborted', 'error', 'error'],
    ['interrupted', 'interrupted', 'warn'], ['blocked', 'limit', 'error'],
    ['max-tokens', 'limit', 'error'],
  ];
  for (const [reasonKind, wantKind, wantSev] of specs) {
    const { ctx, disposer } = setup();
    const { res } = openStream(ctx);
    fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: reasonKind }, session: { id: 'S' + reasonKind } });
    await wait(60);
    const f = sseFrames(res)[0];
    assert(f && f.kind === wantKind, `turn/end ${reasonKind} → ${wantKind}`);
    assert(f && f.severity === wantSev, `turn/end ${reasonKind} severity=${wantSev}`);
    disposer();
  }
}

// ---- 5. 未知 kind 静默（黑盒） ----
{
  const { ctx, disposer } = setup();
  const { res } = openStream(ctx);
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'forked' }, session: { id: 'S1' } });
  await wait(60);
  assert(sseFrames(res).length === 0, '未知 reason.kind（forked）→ 不产出帧');
  disposer();
}

// ---- 6. 兜底信号 ----
{
  // agent/error → error
  const { ctx, disposer } = setup();
  const { res } = openStream(ctx);
  fireSessionEvent(ctx, { type: 'turn/start', session: { id: 'S1', header: {} } });
  fireAgentEvent(ctx, 'agent/error', { turn: { id: 't1' }, step: 0, error: new Error('boom') });
  await wait(60);
  let f = sseFrames(res)[0];
  assert(f && f.kind === 'error' && f.severity === 'error', 'agent/error → error 帧');
  assert(f && f.failure && String(f.failure.message).includes('boom'), 'agent/error 带 failure.message');
  disposer();

  // agent/turn-stopping：signal.aborted=false → 静默（守卫）；true → interrupted
  {
    const { ctx: ctx2, disposer: d2 } = setup();
    const { res: res2 } = openStream(ctx2);
    fireAgentEvent(ctx2, 'agent/turn-stopping', { turn: { id: 't1' }, signal: new AbortController().signal });
    await wait(40);
    assert(sseFrames(res2).length === 0, 'turn-stopping 非 aborted → 静默（防正常收尾误报）');
    const aborted = new AbortController(); aborted.abort();
    fireAgentEvent(ctx2, 'agent/turn-stopping', { turn: { id: 't1' }, signal: aborted.signal });
    await wait(40);
    f = sseFrames(res2)[0];
    assert(f && f.kind === 'interrupted', 'turn-stopping aborted=true → interrupted 帧');
    d2();
  }

  // agent/request-error：limit 语义
  {
    const limitCodes = ['rate_limit', '429 Too Many Requests', 'max_tokens quota', 'quota_exceeded'];
    for (const code of limitCodes) {
      const { ctx: c3, disposer: d3 } = setup();
      const { res: r3 } = openStream(c3);
      fireAgentEvent(c3, 'agent/request-error', { turn: { id: 't' }, step: 0, provider: 'deepseek', failure: { code, message: 'rate hit' }, retryPolicy: {}, signal: new AbortController().signal });
      await wait(40);
      const g = sseFrames(r3)[0];
      assert(g && g.kind === 'limit', `request-error code=${code} → limit`);
      d3();
    }
    const { ctx: c4, disposer: d4 } = setup();
    const { res: r4 } = openStream(c4);
    fireAgentEvent(c4, 'agent/request-error', { turn: { id: 't' }, step: 0, provider: 'deepseek', failure: { code: 'auth_error', message: 'bad key' }, retryPolicy: {}, signal: new AbortController().signal });
    await wait(40);
    const g = sseFrames(r4)[0];
    assert(g && g.kind === 'error', 'request-error 非 limit 码 → error');
    d4();
  }

  // agent/status idle → done（turn/end 被错过时，record 仍在）
  {
    const { ctx: c5, disposer: d5 } = setup();
    const { res: r5 } = openStream(c5);
    fireSessionEvent(c5, { type: 'turn/start', session: { id: 'S1', header: {} } });
    fireSessionEvent(c5, { type: 'assistant/message', session: { id: 'S1' }, usage: { outputTokens: 7 } });
    fireAgentEvent(c5, 'agent/status', { status: 'idle', agent: { session: { id: 'S1' } } });
    await wait(60);
    const g = sseFrames(r5)[0];
    assert(g && g.kind === 'done' && g.tokens === 7, 'agent/status idle 兜底 done（带 tokens）');
    // 无 record 时（turn/end 正常处理过）→ 不重复
    const c6 = setup().ctx; const { res: r6 } = openStream(c6);
    fireSessionEvent(c6, { type: 'turn/end', reason: { kind: 'completed' }, session: { id: 'S1' } });
    await wait(40);
    fireAgentEvent(c6, 'agent/status', { status: 'idle', agent: { session: { id: 'S1' } } });
    await wait(40);
    assert(sseFrames(r6).filter((x) => x.kind === 'done').length === 1, 'record 已消费 → idle 不重复 done');
    d5();
  }
}

// ---- 7. jobs settled ----
{
  const { ctx, disposer } = setup();
  // jobEvents 默认 true → 订阅应建立
  assert(ctx.jobSubs.length === 1, 'jobEvents=true 时订阅 jobs.events（owners=scope）');
  assert(ctx.jobSubs[0]?.opts?.owners === 'scope', 'jobs subscribe owners=scope');
  const cb = ctx.jobSubs[0].cb;
  const cases = [
    [{ type: 'settled', job: { id: 'j1', status: 'failed', owner: 'root' }, awaited: false }, 'error'],
    [{ type: 'settled', job: { id: 'j2', status: 'killed', owner: 'root' }, awaited: false }, 'interrupted'],
    [{ type: 'settled', job: { id: 'j3', status: 'completed', owner: 'root', label: '下载' }, awaited: false }, 'job'],
  ];
  const ignore = [
    { type: 'settled', job: { id: 'j4', status: 'failed', owner: 'root' }, awaited: true },
    { type: 'settled', job: { id: 'j5', status: 'failed', owner: 'root' }, cause: 'teardown', awaited: false },
    { type: 'removed', job: { id: 'j6', status: 'killed' } },
    { type: 'settled', job: { id: 'j7', status: 'running', owner: 'root' }, awaited: false },
  ];
  for (const [ev, wantKind] of cases) {
    const { res } = openStream(ctx);
    cb(ev);
    await wait(50);
    const f = sseFrames(res)[0];
    assert(f && f.kind === wantKind, `job settled ${ev.job.status} → ${wantKind}`);
  }
  const { res } = openStream(ctx);
  const n0 = res.chunks.length;
  for (const ev of ignore) { cb(ev); }
  await wait(50);
  assert(res.chunks.length === n0, 'awaited/teardown/removed/running 不产出帧');
  disposer();
}
{
  // jobEvents=false → 不订阅、不产出
  const { ctx, disposer } = setup();
  const pc = { name: profileName };
  ctx.provide('profileContext', pc);
  const apply2 = apply; // 同一 apply
  globalThis.fetch = makeFetchStub();
  const c = makeStubCtx();
  c.provide('profileContext', pc);
  const d = apply2(c);
  // 先把 jobEvents 置 false（PUT /config）再验证…… apply 时已读默认 true 并订阅了。
  // 此处验证配置化关闭：重新 apply 前预写 pharos.json jobEvents=false
  void d;
  // 预写磁盘 → 新 ctx
  const cfgFile = path.join(profileDir, 'pharos.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ jobEvents: false }));
  const c2 = makeStubCtx();
  c2.provide('profileContext', { name: profileName });
  const d2 = apply2(c2);
  assert(c2.jobSubs.length === 0, 'jobEvents=false → 不订阅 jobs');
  d2();
  disposer();
}

// ---- 8. 帧总线去重（默认窗口常量 + 行为） ----
{
  assert(hostMod.HOST_DEDUPE_MS === 3000, 'HOST_DEDUPE_MS 默认 3000ms（契约 §6）');
  // 快速行为验证：小窗口
  const { ctx, disposer } = setup({ dedupeMs: 50 });
  const { res } = openStream(ctx);
  const emit = () => fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: { id: 'DEDUPE' } });
  emit(); await wait(30);
  emit(); await wait(30);
  assert(sseFrames(res).length === 1, '窗口内同 dedupeKey 第二次静默丢弃');
  await wait(60);
  emit(); await wait(30);
  assert(sseFrames(res).length === 2, '窗口过后同 dedupeKey 重新产出');
  // 不同 session 不受影响
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: { id: 'OTHER' } });
  await wait(30);
  assert(sseFrames(res).length === 3, '不同 dedupeKey 正常产出');
  disposer();
}

// ---- 9. SSE 广播 + 25s ping ----
{
  const realSI = globalThis.setInterval;
  const intervals = [];
  globalThis.setInterval = (fn, ms, ...a) => { intervals.push(ms); return realSI(fn, ms, ...a); };
  let ds = null;
  try {
    const { ctx, disposer } = setup();
    ds = disposer;
    const { res, done } = openStream(ctx);
    await done;
    assert(res.state.status === 200, 'SSE 握手 200');
    assert(String(res.state.headers['content-type']).includes('text/event-stream'), 'SSE content-type text/event-stream');
    assert(res.chunks.some((c) => c.includes(': connected')), 'SSE 连接即握手注释');
    assert(intervals.includes(25000), 'SSE 客户端建立后存在 25s ping 计划（setInterval 25000）');
    // 广播
    fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: { id: 'S1' } });
    await wait(60);
    const f = sseFrames(res)[0];
    assert(f && f.kind === 'done' && f.sessionId === 'S1', 'SSE 客户端收到广播帧');
    // 两个客户端各收一份
    const res2 = (await openStream(ctx)).res;
    fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'error' }, session: { id: 'S2' } });
    await wait(60);
    assert(sseFrames(res2).length === 1 && sseFrames(res).some((x) => x.kind === 'error'), '多客户端广播');
  } finally {
    globalThis.setInterval = realSI;
    ds?.();
  }
}

// ---- 10. trigger 鉴权 ----
{
  // 无 apiToken：200 + remote 帧广播（SSE）
  const { ctx, disposer } = setup();
  const { res: sseRes } = openStream(ctx);
  const t = await trigger(ctx);
  assert(t.res.state.status === 200, '无 apiToken 时 trigger 200');
  await wait(60);
  const fr = sseFrames(sseRes).find((f) => f.kind === 'remote');
  assert(fr && fr.source === 'remote', 'trigger 产出 remote 帧（source=remote）');
  assert(fr && fr.note === '提醒', 'remote 帧 note=body');
  disposer();
}
{
  // apiToken 非空 → 401/401/200；非 loopback → 403；缺 Host → 403（DNS rebinding 防）
  const { ctx, disposer } = setup();
  // 通过 PUT 配置 apiToken
  const p = await putConfig(ctx, { apiToken: 'pharos-secret' });
  assert(p.res.state.status === 200, 'PUT /config 设 apiToken 成功');
  const tryTrigger = async (extraHeaders = {}, remoteAddress = '127.0.0.1', host = '127.0.0.1:5147') => {
    const c = callApi(ctx, '/pharos/api/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders, host },
      remoteAddress,
      body: { title: 'x', body: 'y' },
    });
    await c.done;
    return c.res.state.status;
  };
  assert(await tryTrigger({}) === 401, '有 apiToken 无 x-pharos-token → 401');
  assert(await tryTrigger({ 'x-pharos-token': 'wrong' }) === 401, '错误 token → 401');
  assert(await tryTrigger({ 'x-pharos-token': 'pharos-secret' }) === 200, '正确 token → 200');
  assert(await tryTrigger({ 'x-pharos-token': 'pharos-secret' }, '10.9.9.9') === 403, '非 loopback remoteAddress → 403');
  assert(await tryTrigger({ 'x-pharos-token': 'pharos-secret' }, '::ffff:10.9.9.9') === 403, 'IPv4-mapped 非 loopback → 403');
  assert(await tryTrigger({ 'x-pharos-token': 'pharos-secret' }, '::1') === 200, '::1 loopback → 200');
  // 缺 Host → 拒（手动构造无 Host 头的 req）
  const resNoHost2 = makeRes();
  const reqNoHost = makeReq({ method: 'POST', url: '/pharos/api/trigger', headers: { 'content-type': 'application/json', 'x-pharos-token': 'pharos-secret' }, body: { title: 'x', body: 'y' } });
  delete reqNoHost.headers.host;
  getStreamHandle(ctx)(reqNoHost, resNoHost2);
  await wait(30);
  assert(resNoHost2.state.status === 403, '缺 Host 头 → 403');
  // content-type 非 JSON → 400
  const resCT = (await callApi(ctx, '/pharos/api/trigger', {
    method: 'POST', headers: { 'content-type': 'text/plain', 'x-pharos-token': 'pharos-secret' }, body: { body: 'y' },
  })).res;
  assert(resCT.state.status === 400, 'content-type 非 JSON → 400');
  // 坏 JSON → 400
  const resBad = makeRes();
  const reqBad = makeReq({ method: 'POST', url: '/pharos/api/trigger', headers: { 'content-type': 'application/json', 'x-pharos-token': 'pharos-secret' } });
  reqBad[Symbol.asyncIterator] = async function* () { yield 'not-json{'; };
  getStreamHandle(ctx)(reqBad, resBad);
  await wait(30);
  assert(resBad.state.status === 400, '坏 JSON body → 400');
  // 缺 body.body → 400
  const cNoBody = callApi(ctx, '/pharos/api/trigger', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pharos-token': 'pharos-secret' }, body: { title: 'x' },
  });
  await cNoBody.done;
  assert(cNoBody.res.state.status === 400, '缺 body.body → 400');
  disposer();
}

// ---- 11. config GET 打码 / PUT 深合并 / 原子落盘 ----
{
  const { ctx, disposer } = setup();
  const cfgFile = path.join(profileDir, 'pharos.json');
  const putBody = {
    apiToken: 'secret-token',
    quietHours: { enabled: true, start: '22:00', end: '07:00' },
    webhooks: [{ name: 'w1', channel: 'wecom', url: 'https://example.invalid/hook', secret: 'hook-secret', events: [], enabled: true }],
    skipSubagents: false,
  };
  const p = await putConfig(ctx, putBody);
  assert(p.res.state.status === 200, 'PUT /config 200');
  const view = JSON.parse(p.res.body);
  assert(view.apiToken === '***', 'GET/PUT 响应 apiToken 打码 ***');
  assert(view.webhooks[0].secret === '***', 'GET/PUT 响应 webhook.secret 打码 ***');
  assert(view.webhooks[0].url === 'https://example.invalid/hook', '打码不影响非 secret 字段');
  assert(view.quietHours.enabled === true, '深合并保留 quietHours（覆盖默认值）');
  assert(view.skipSubagents === false, '深合并覆盖 skipSubagents');
  assert(view.enabled === true, '缺省字段合并 DEFAULT_CONFIG（enabled 保持 true）');

  const g = await getConfig(ctx);
  assert(g.res.state.status === 200, 'GET /config 200');
  const gv = JSON.parse(g.res.body);
  assert(gv.apiToken === '***' && gv.webhooks[0].secret === '***', 'GET 独立请求也打码');

  const w = await getWebhooks(ctx);
  assert(w.res.state.status === 200, 'GET /webhooks 200');
  const wv = JSON.parse(w.res.body);
  assert(wv.length === 1 && wv[0].secret === '***', 'GET /webhooks 列表带打码 secret');

  const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert(onDisk.apiToken === 'secret-token', '落盘保留明文 apiToken');
  assert(onDisk.webhooks[0].secret === 'hook-secret', '落盘保留明文 webhook secret');
  const partials = fs.readdirSync(profileDir).filter((f) => f.includes('.tmp-'));
  assert(partials.length === 0, '原子写无残留 tmp 文件');
  assert(!fs.existsSync(path.join(os.homedir(), '.dsh', 'pharos.json')), '未写真实 ~/.dsh/pharos.json');
  disposer();
}

// ---- 12. store 路径解析单元 ----
if (store) {
  {
    const ctxHome = { get: () => ({ name: 'desktop' }) };
    const p = store.pharosFilePath(ctxHome, { DSH_HOME: '/x/home' });
    assert(p === path.join('/x/home', 'profiles', 'desktop', 'pharos.json'), 'DSH_HOME+profiles/name 解析');
  }
  {
    const ctxDir = { get: () => ({ name: 'desktop', dir: '/custom/dir' }) };
    const p = store.pharosFilePath(ctxDir, { DSH_HOME: '/x/home' });
    assert(p === path.join('/custom/dir', 'pharos.json'), 'profileContext.dir 优先');
  }
  {
    const p = store.pharosFilePath({ get: () => null }, { DSH_HOME: '/x/home' });
    assert(p === path.join('/x/home', 'pharos.json'), '无 profileContext 回退 <home>/pharos.json');
  }
  {
    const merged = store.deepMerge(store.DEFAULT_CONFIG, { quietHours: { start: '20:00' } });
    assert(merged.quietHours.start === '20:00' && merged.quietHours.end === '08:00' && merged.enabled === true, 'deepMerge 递归合并保留默认');
  }
  {
    const s = store.createStore({ get: () => null }, { DSH_HOME: DSH_HOME });
    assert(s.getPath() === path.join(DSH_HOME, 'pharos.json'), 'createStore 路径解析');
    s.dispose();
  }
}

// ---- 13. webhook 适配器 + 加签（白盒 buildWebhookRequest） ----
if (webhook) {
  const frame = { kind: 'done', sessionId: 'S1', sessionTitle: '会话A', note: '任务完成：会话A', ts: 1700000000000, source: 'host', dedupeKey: 'done:S1' };
  const now = 1700000000000;
  // wecom：sha256(`${ts}\n${secret}`) hex → query
  {
    const r = webhook.buildWebhookRequest({ channel: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc', secret: 'sk' }, frame, { now });
    const u = new URL(r.url);
    const sign = u.searchParams.get('sign');
    const ts = u.searchParams.get('timestamp');
    const expect = crypto.createHash('sha256').update(`${ts}\nsk`).digest('hex');
    assert(/^[0-9a-f]{64}$/.test(sign), 'wecom sign 为 64 位 hex');
    assert(sign === expect, 'wecom 加签 = sha256(ts\\nsecret) hex（独立复核）');
    assert(ts === '1700000000', 'wecom timestamp 秒级');
    assert(r.body.msgtype === 'markdown', 'wecom 载荷 msgtype=markdown');
  }
  // feishu：hmac sha256 base64 → body
  {
    const r = webhook.buildWebhookRequest({ channel: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', secret: 'sk2' }, frame, { now });
    const b = r.body;
    const expect = crypto.createHmac('sha256', 'sk2').update(`${b.timestamp}\nsk2`).digest('base64');
    assert(b.sign === expect, 'feishu 加签 = hmac_sha256(ts\\nsecret) base64（独立复核）');
    assert(b.msg_type === 'text' && typeof b.content?.text === 'string', 'feishu 载荷 msg_type=text');
  }
  // dingtalk：hmac base64 → query（毫秒时间戳）
  {
    const r = webhook.buildWebhookRequest({ channel: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=abc', secret: 'sk3' }, frame, { now });
    const u = new URL(r.url);
    const ts = u.searchParams.get('timestamp');
    const sign = u.searchParams.get('sign');
    const expect = crypto.createHmac('sha256', 'sk3').update(`${ts}\nsk3`).digest('base64');
    assert(ts === '1700000000000', 'dingtalk timestamp 毫秒');
    assert(sign === expect, 'dingtalk 加签 = hmac base64（独立复核）');
    assert(r.body.msgtype === 'markdown', 'dingtalk 载荷 msgtype=markdown');
  }
  // generic：帧透传
  {
    const r = webhook.buildWebhookRequest({ channel: 'generic', url: 'https://example.invalid/hook' }, frame, { now });
    assert(r.url === 'https://example.invalid/hook', 'generic url 原样');
    assert(JSON.stringify(r.body) === JSON.stringify(frame), 'generic body=帧透传');
  }
  // 模板变量（renderTemplate 直测；feishu 渠道体内也走渲染）
  {
    const rendered = webhook.renderTemplate('{kind}/{note}/{tokens}/{duration}/{title}/{time}',
      { ...frame, tokens: 12, durationMs: 5000 });
    assert(rendered.startsWith('done/') && rendered.includes('任务完成') && rendered.includes('/12/') && rendered.includes('/5s/') && rendered.includes('/会话A/'), '模板变量 {kind}{note}{tokens}{duration}{title}{time}');
    const feishuBody = webhook.buildWebhookRequest({ channel: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', secret: 'sk', template: '【{kind}】{note} {tokens}t' }, { ...frame, tokens: 9 }, { now }).body;
    assert(feishuBody.content.text.includes('【done】') && feishuBody.content.text.includes('9t'), 'feishu 内容走模板渲染');
  }
  // 重试 + 指数退避（注入 fast backoff）
  {
    const timings = [];
    let fail = true;
    const sender = webhook.createWebhookSender({
      fetchImpl: async (url, opts) => { timings.push(Date.now()); if (fail) { fail = !(timings.length === 3); throw new Error('boom'); } return { ok: true, status: 200, text: async () => '', json: async () => ({}) }; },
      maxRetries: 3, backoffMs: 20, timeoutMs: 500,
    });
    const out = await sender.send({ channel: 'generic', url: 'https://x/h' }, frame, {});
    assert(out.status === 'sent' && out.attempts === 4, '失败→重试 3 次后成功（attempts=4）');
    const gaps = timings.slice(1).map((t, i) => t - timings[i]);
    assert(gaps.length === 3 && gaps[0] <= gaps[1] && gaps[1] <= gaps[2] && gaps[2] > 0, `退避间隔递增（${gaps.join('/')}ms ≈ 20/40/80 指数）`);
  }
  // 全部失败 → 入环形缓冲（50 上限）
  {
    const sender = webhook.createWebhookSender({
      fetchImpl: async () => { throw new Error('down'); },
      maxRetries: 0, backoffMs: 1, timeoutMs: 100, ringSize: 50,
    });
    for (let i = 0; i < 55; i++) {
      await sender.send({ channel: 'generic', url: 'https://x/h' }, { ...frame, id: 'f' + i }, {});
    }
    const list = sender.listFailures();
    assert(list.length === 50, '失败缓冲上限 50（现 ' + list.length + '）');
    assert(list[0].frame.id === 'f5', '环形缓冲淘汰最旧（首条 f5）');
    assert(list[49].frame.id === 'f54', '最新失败在缓冲尾（f54）');
  }
  // 常量契约：默认重试 3 次（1/2/4s）
  {
    assert(webhook.WEBHOOK_MAX_RETRIES === 3, 'WEBHOOK_MAX_RETRIES=3（重试 3 次）');
    assert(webhook.WEBHOOK_BACKOFF_BASE_MS === 1000, 'WEBHOOK_BACKOFF_BASE_MS=1000（1/2/4s 退避）');
    assert(webhook.WEBHOOK_FAILURE_RING_SIZE === 50, 'WEBHOOK_FAILURE_RING_SIZE=50');
  }
}

// ---- 14. webhook 集成出口（经 apply）：Happy path + 过滤 ----
{
  // 配置 wecom webhook，completed 事件 → fetch 一次，URL 带 sign
  const { ctx, fetchStub, disposer } = setup();
  await putConfig(ctx, { webhooks: [{ name: 'w', channel: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc', secret: 'sk', events: [], enabled: true }] });
  fetchStub.reset();
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: { id: 'S1' } });
  await wait(120);
  const call = fetchStub.calls[0];
  assert(call !== undefined, 'webhook 集成：completed 触发 fetch');
  if (call) {
    const u = new URL(call.url);
    assert(u.searchParams.has('sign') && /^[0-9a-f]{64}$/.test(u.searchParams.get('sign')), '集成链路 wecom 加签生效');
  }
  disposer();
}
{
  // events 过滤 + enabled=false + 子代理过滤
  const { ctx, fetchStub, disposer } = setup();
  await putConfig(ctx, { webhooks: [
    { name: 'err-only', channel: 'generic', url: 'https://x.invalid/err', secret: '', events: ['error'], enabled: true },
    { name: 'disabled', channel: 'generic', url: 'https://x.invalid/dis', secret: '', events: [], enabled: false },
  ] });
  fetchStub.reset();
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: { id: 'S1' } });
  await wait(80);
  assert(fetchStub.calls.length === 0, 'events=[error] 不推 done；enabled=false 不推');
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'error' }, session: { id: 'S2' } });
  await wait(80);
  assert(fetchStub.calls.length === 1 && fetchStub.calls[0].url.includes('/err'), 'events=[error] 收 error');
  // skipSubagents 默认 true：子代理帧不推
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'error' }, session: { id: 'SUB', header: { origin: 'subagent' } } });
  await wait(80);
  assert(fetchStub.calls.length === 1, 'skipSubagents=true 子代理帧不推 webhook');
  // 关闭 skipSubagents → 推
  await putConfig(ctx, { skipSubagents: false });
  fetchStub.reset();
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'error' }, session: { id: 'SUB2', header: { origin: 'subagent' } } });
  await wait(80);
  assert(fetchStub.calls.length === 1, 'skipSubagents=false 子代理帧推 webhook');
  disposer();
}
{
  // 单条 webhook enabled=false → 该条跳过（§5 出口过滤）
  const { ctx, fetchStub, disposer } = setup();
  await putConfig(ctx, { webhooks: [
    { name: 'on', channel: 'generic', url: 'https://x.invalid/on', secret: '', events: [], enabled: true },
    { name: 'off', channel: 'generic', url: 'https://x.invalid/off', secret: '', events: [], enabled: false },
  ] });
  fetchStub.reset();
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: { id: 'S1' } });
  await wait(80);
  assert(fetchStub.calls.length === 1 && fetchStub.calls[0].url.includes('/on'), 'enabled=false 的 webhook 跳过，enabled=true 推送');
  disposer();
}

// ---- 15. quiet hours：webhook 出口拦截 + isQuietNow 白盒 ----
if (frames) {
  // 白盒：跨午夜
  const qh = { enabled: true, start: '23:00', end: '08:00' };
  const at = (h, m) => new Date(2026, 0, 1, h, m, 0);
  assert(frames.isQuietNow({ quietHours: qh }, at(23, 30)) === true, '23:30 ∈ [23:00,08:00) quiet');
  assert(frames.isQuietNow({ quietHours: qh }, at(1, 0)) === true, '01:00（跨午夜）quiet');
  assert(frames.isQuietNow({ quietHours: qh }, at(10, 0)) === false, '10:00 不在窗口');
  assert(frames.isQuietNow({ quietHours: qh }, at(8, 0)) === false, '08:00 = end 不 quiet（半开区间）');
  assert(frames.isQuietNow({ quietHours: { enabled: false, start: '23:00', end: '08:00' } }, at(23, 30)) === false, 'enabled=false 不静默');
}
{
  // 黑盒：冻结时钟 23:30，配置 quietHours 23:00-08:00 → 触发 done → 无 fetch
  freezeDate(new Date(2026, 0, 1, 23, 30, 0).getTime());
  try {
    const { ctx, fetchStub, disposer } = setup();
    await putConfig(ctx, { quietHours: { enabled: true, start: '23:00', end: '08:00' }, webhooks: [{ name: 'w', channel: 'generic', url: 'https://x.invalid/h', secret: '', events: [], enabled: true }] });
    fetchStub.reset();
    fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: { id: 'S1' } });
    await wait(100);
    assert(fetchStub.calls.length === 0, 'quiet hours 生效期不推 webhook');
    disposer();
  } finally { unfreezeDate(); }
}

// ---- 16. M2 stats：投影做差 / 命中率 / TPS / 读取降级 ----
if (!stats) {
  console.log('skip : lib/host/stats.js 未加载，跳过 M2 stats 白盒断言');
} else {
  const snap = (tu, ss) => ({ values: { tokenUsage: tu, sessionStats: ss } });
  const tu = (u, o, cr, cw) => ({ uncachedInputTokens: u, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw });

  // diffProjection：四桶 + decode 做差，负值钳 0
  const base = snap(tu(100, 50, 20, 10), { decodeTokens: 50, decodeMs: 5000 });
  const cur = snap(tu(200, 150, 40, 30), { decodeTokens: 150, decodeMs: 12500 });
  const delta = stats.diffProjection(base, cur);
  assert(delta !== null, 'diffProjection 基线+当前 → 非 null');
  assert(delta.tokenUsage.uncachedInputTokens === 100, '当轮 uncachedInputTokens delta=100');
  assert(delta.tokenUsage.outputTokens === 100, '当轮 outputTokens delta=100');
  assert(delta.tokenUsage.cacheReadTokens === 20, '当轮 cacheReadTokens delta=20');
  assert(delta.tokenUsage.cacheWriteTokens === 20, '当轮 cacheWriteTokens delta=20');
  assert(delta.sessionStats.decodeTokens === 100, '当轮 decodeTokens delta=100');
  assert(delta.sessionStats.decodeMs === 7500, '当轮 decodeMs delta=7500');

  // 负值钳 0（重复上报鲁棒：current 某桶小于 baseline）
  const neg = stats.diffProjection(base, snap(tu(90, 40, 10, 5), { decodeTokens: 30, decodeMs: 3000 }));
  assert(neg.tokenUsage.uncachedInputTokens === 0, '负增量钳 0（uncachedInput）');
  assert(neg.sessionStats.decodeTokens === 0, '负增量钳 0（decodeTokens）');

  // 基线/当前任一为 null → null（静默降级）
  assert(stats.diffProjection(null, cur) === null, '基线 null → diffProjection 返回 null');
  assert(stats.diffProjection(base, null) === null, '当前 null → diffProjection 返回 null');

  // cacheHitRateOf：cacheReadΔ / (uncachedΔ+cacheReadΔ+cacheWriteΔ)；分母 0 → null
  const hit = stats.cacheHitRateOf(delta.tokenUsage);
  assert(Math.abs(hit - (20 / (100 + 20 + 20))) < 1e-9, '命中率 = 20/140（当轮 delta 口径）');
  assert(stats.cacheHitRateOf(tu(0, 0, 0, 0)) === null, '分母 0 → 命中率 null（不显示 0%）');
  assert(stats.cacheHitRateOf(null) === null, 'tokenUsage null → 命中率 null');

  // tpsOf：decodeTokensΔ / (decodeMsΔ/1000)；decodeMs 0 → null
  const tps = stats.tpsOf(delta.sessionStats);
  assert(Math.abs(tps - (100 / 7.5)) < 1e-9, 'TPS = 100/(7500/1000)（当轮 delta 口径）');
  assert(stats.tpsOf({ decodeTokens: 100, decodeMs: 0 }) === null, 'decodeMs 0 → TPS null');
  assert(stats.tpsOf(null) === null, 'sessionStats null → TPS null');

  // totalTokensOf：四桶 delta 之和
  assert(stats.totalTokensOf(delta.tokenUsage) === 240, '当轮总 token = 100+100+20+20=240');

  // 一致性：投影 delta 四桶和 = frames.usageTokensOf 的同形累加（交叉验证 A-1）
  // （两者同公式：都是四桶求和；此处用同一份 delta 验证 totalTokensOf 与手算一致）
  const manual = delta.tokenUsage.uncachedInputTokens + delta.tokenUsage.outputTokens + delta.tokenUsage.cacheReadTokens + delta.tokenUsage.cacheWriteTokens;
  assert(stats.totalTokensOf(delta.tokenUsage) === manual, 'totalTokensOf 与手算四桶和一致（交叉验证）');

  // readProjectionSnapshot：service 缺失 / snapshot 缺失 / session 缺失 → null（永不 throw）
  assert(stats.readProjectionSnapshot({ get: () => undefined }, { id: 'S' }) === null, 'sessionProjections 缺失 → null');
  assert(stats.readProjectionSnapshot({ get: (n, f) => ({}) }, { id: 'S' }) === null, 'snapshot 非函数 → null');
  assert(stats.readProjectionSnapshot({ get: (n, f) => ({ snapshot: () => null }) }, { id: 'S' }) === null, 'snapshot 返回 null → null');
  assert(stats.readProjectionSnapshot({ get: () => ({ snapshot: () => snap(tu(1, 2, 3, 4), {}) }) }, null) === null, 'session null → null');
  // 正常路径：返回 snapshot 原值
  const proj = { snapshot: () => ({ values: { tokenUsage: tu(1, 2, 3, 4), sessionStats: {} } }) };
  const got = stats.readProjectionSnapshot({ get: (n, f) => proj }, { id: 'S' });
  assert(got !== null && got.values.tokenUsage.uncachedInputTokens === 1, 'readProjectionSnapshot 正常读取');
  // get 抛异常 → null（不 throw）
  assert(stats.readProjectionSnapshot({ get: () => { throw new Error('boom'); } }, { id: 'S' }) === null, 'ctx.get 抛异常 → null');
}

// ---- 16b. M2 黑盒：apply() 经 sessionProjections 驱动当轮统计（deriveTurnStats → 帧）----
{
  // 脚本化投影 stub：turn/start 读到基线（累计 100），turn/end 前把累计推到 240，
  // 断言帧带当轮 delta 派生的 cacheHitRate/tps/tokens 与 note 统计文本。
  let cumulative = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, decodeTokens: 50, decodeMs: 5000 };
  const projections = {
    snapshot: () => ({
      values: {
        tokenUsage: { uncachedInputTokens: cumulative.uncachedInputTokens, outputTokens: cumulative.outputTokens, cacheReadTokens: cumulative.cacheReadTokens, cacheWriteTokens: cumulative.cacheWriteTokens },
        sessionStats: { decodeTokens: cumulative.decodeTokens, decodeMs: cumulative.decodeMs },
      },
    }),
  };
  const { ctx, disposer } = setup();
  ctx.provide('sessionProjections', projections);
  const { res, done } = openStream(ctx);
  await done;
  const sess = { id: 'S1', header: {} };
  fireSessionEvent(ctx, { type: 'turn/start', session: sess });
  // turn/end 前推进累计：当轮 delta = uncachedInput +100 / output +100 / cacheRead +20 / cacheWrite +20 / decodeTokens +100 / decodeMs +7500
  cumulative = { uncachedInputTokens: 200, outputTokens: 150, cacheReadTokens: 40, cacheWriteTokens: 30, decodeTokens: 150, decodeMs: 12500 };
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: sess });
  await wait(60);
  const fs_ = sseFrames(res);
  assert(fs_.length >= 1, '带投影的 completed turn/end 产出帧');
  const f = fs_.find((x) => x.kind === 'done');
  assert(!!f, '找到 done 帧');
  if (f) {
    // 当轮 delta：uncachedInput 100 / output 100 / cacheRead 20 / cacheWrite 20 → 命中率 20/(100+20+20)=1/7；tokens=240
    assert(typeof f.cacheHitRate === 'number' && Math.abs(f.cacheHitRate - (20 / 140)) < 1e-9, '帧 cacheHitRate = 当轮 delta 命中率 20/140');
    assert(typeof f.tps === 'number' && Math.abs(f.tps - (100 / 7.5)) < 1e-9, '帧 tps = 当轮 delta 100/(7500/1000)');
    assert(f.tokens === 240, '帧 tokens = 当轮 delta 四桶和 240');
    assert(typeof f.note === 'string' && f.note.includes('缓存命中') && f.note.includes('tok/s'), 'note 含统计文本（缓存命中 + tok/s）');
  }
  disposer();
}

// ---- 16c. M2 黑盒：基线缺失 → 帧无统计字段（静默降级）----
{
  // 不提供 sessionProjections（或 snapshot 不可用）：turn/start 基线为 null → 帧无 cacheHitRate/tps
  const { ctx, disposer } = setup();
  const { res, done } = openStream(ctx);
  await done;
  const sess = { id: 'S2', header: {} };
  fireSessionEvent(ctx, { type: 'turn/start', session: sess });
  fireSessionEvent(ctx, { type: 'turn/end', reason: { kind: 'completed' }, session: sess });
  await wait(60);
  const fs_ = sseFrames(res);
  const f = fs_.find((x) => x.kind === 'done' && x.sessionId === 'S2');
  assert(!!f, '无投影时 completed turn/end 仍产出 done 帧');
  if (f) {
    assert(!('cacheHitRate' in f), '基线缺失 → 帧无 cacheHitRate');
    assert(!('tps' in f), '基线缺失 → 帧无 tps');
  }
  disposer();
}

// ---- 17. rate limit 常量 + host 默认 ----
{
  assert(hostMod.HOST_DEDUPE_MS === 3000, 'host 导出 HOST_DEDUPE_MS=3000');
}

console.log(failed === 0
  ? `\nhost.test: 全部断言通过（${passed} 项）`
  : `\nhost.test: ${failed} 项失败 / ${passed} 项通过`);
process.exit(failed === 0 ? 0 : 1);