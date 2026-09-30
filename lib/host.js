/**
 * dsh-pharos — host half apply(): event subscriptions → normalize → frame bus
 * → SSE broadcast + webhook push. Glue between frames/store/webhook/routes.
 *
 * 订阅（contract §5 双轨判定）：
 *   主信号  session/event：turn/start 起表、assistant/message 累积 usage 四桶、
 *           turn/end 依 reason.kind 定类（未知 kind 静默，不产出帧）。
 *   兜底    agent/error → error；agent/turn-stopping → interrupted（带 signal.aborted 守卫，
 *           见下方代码事实说明）；agent/request-error → limit/error（failure.code 判定）；
 *           agent/status idle → done（仅当 turn 记录仍在——即 turn/end 被错过时）。
 *   jobs    ctx.get('jobs', false)?.events.subscribe({owners:'scope'})（jobEvents=true 时，
 *           且只有 subscribe 是函数才订阅）：settled 且 !awaited 且 cause!=='teardown'
 *           → failed→error / killed→interrupted / completed→job。
 *
 * 产出：帧总线（dedupeKey 去重窗 3000ms）→ SSE 广播 + webhook（quietHours / events /
 * skipSubagents 过滤在 webhook 出口）。
 *
 * cordis 门控：模块顶层 inject 保持 []，webServer 一律 ctx.inject(['webServer'], cb)，
 * 可选服务（jobs/profileContext）用 ctx.get(name, false) 惰性查。
 */

import { createStore } from './host/store.js';
import { createWebhookSender } from './host/webhook.js';
import { registerRoutes } from './host/routes.js';
import {
  agentTypeOf, isQuietNow, mapTurnEndReason, makeFrame, noteFor,
  sessionTitleOf, sessionIdOf, usageTokensOf, isLimitFailureCode,
} from './host/frames.js';

export const HOST_DEDUPE_MS = 3000;
const TURN_STATE_STALE_MS = 60 * 60 * 1000;

function noop() {}

/** 帧总线：同 dedupeKey 在 dedupeMs 窗口内静默丢弃第二次（契约 §6）。 */
export function createFrameBus({ dedupeMs = HOST_DEDUPE_MS } = {}) {
  const seen = new Map();   // dedupeKey → last ts
  const listeners = new Set();
  const prune = (now) => {
    if (seen.size <= 500) return;
    for (const [key, ts] of seen) if (now - ts > dedupeMs * 10) seen.delete(key);
  };
  return {
    emit(frame) {
      const now = Date.now();
      const key = frame.dedupeKey;
      const previous = seen.get(key);
      if (previous !== undefined && now - previous < dedupeMs) return false;
      seen.set(key, now);
      prune(now);
      for (const listener of [...listeners]) {
        try { listener(frame); } catch { /* contained */ }
      }
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    size: () => seen.size,
  };
}

function loggerOf(ctx) {
  const target = ctx && ctx.logger;
  if (target && typeof target.warn === 'function') return (message) => target.warn(`[dsh-pharos] ${message}`);
  return noop;
}

/** 取可选服务；不存在/已死返回 undefined（strict=false 免硬门）。 */
function getService(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name, false);
  } catch { /* service unavailable */ }
  return undefined;
}

const JOB_STATUS_TEXT = {
  failed: '失败',
  killed: '被终止',
  completed: '完成',
};

/**
 * Host 半入口。返回 disposer；apply() 由 lib/index.js 转发。
 */
export function apply(ctx, pluginConfig = {}) {
  const log = loggerOf(ctx);
  const store = createStore(ctx);
  const webhookSender = createWebhookSender({ log });
  const bus = createFrameBus({ dedupeMs: pluginConfig.dedupeMs ?? HOST_DEDUPE_MS });
  const disposers = [];

  /** 主事件 → 帧总线 → webhook 出口。返回帧（去重丢弃时为 null）。 */
  const dispatch = (parts) => {
    const frame = makeFrame({ source: 'host', ...parts });
    if (!bus.emit(frame)) return null;
    emitWebhooks(frame, store.getConfig());
    return frame;
  };

  const emitWebhooks = (frame, config) => {
    const cfg = config;
    if (!cfg) return;
    if (cfg.skipSubagents === true && frame.agentType === 'subagent') return;
    if (isQuietNow(cfg, new Date())) return;
    for (const webhook of cfg.webhooks ?? []) {
      if (webhook && webhook.enabled === false) continue;
      if (!webhook || typeof webhook.url !== 'string' || webhook.url === '') continue;
      const events = webhook.events;
      if (Array.isArray(events) && events.length > 0 && !events.includes(frame.kind)) continue;
      webhookSender.send(webhook, frame, { config: cfg }).catch((error) => {
        log(`webhook sender rejected: ${String(error)}`);
      });
    }
  };

  // ---- turn 计量状态（sessionId → { startedAt, tokens }）----
  const turnState = new Map();
  const takeTurn = (sid) => {
    const record = turnState.get(sid);
    turnState.delete(sid);
    return record;
  };
  const pruneTurns = () => {
    const now = Date.now();
    for (const [sid, record] of turnState) {
      if (now - record.startedAt > TURN_STATE_STALE_MS) turnState.delete(sid);
    }
  };

  const emitTurnFrame = (kind, { session, sid, reason, record }) => {
    const now = Date.now();
    const rawMessage = failureMessageOf(reason);
    return dispatch({
      kind,
      sessionId: sid,
      sessionTitle: sessionTitleOf(session),
      agentType: agentTypeOf(session),
      durationMs: record ? now - record.startedAt : undefined,
      tokens: record ? record.tokens : undefined,
      failure: kind === 'error' || kind === 'limit'
        ? { ...(reason && reason.kind ? { code: String(reason.kind) } : {}), message: rawMessage }
        : undefined,
      note: noteFor(kind, {
        sessionTitle: sessionTitleOf(session),
        durationMs: record ? now - record.startedAt : undefined,
        tokens: record ? record.tokens : undefined,
        message: rawMessage,
      }),
    });
  };

  /** 主信号：session/event。 */
  const onSessionEvent = (session, event) => {
    if (!event || typeof event.type !== 'string') return;
    const sid = sessionIdOf(session);
    switch (event.type) {
      case 'turn/start':
        turnState.set(sid || 'unknown', { startedAt: Date.now(), tokens: 0 });
        break;
      case 'assistant/message': {
        const record = turnState.get(sid);
        if (record) record.tokens += usageTokensOf(event.data && event.data.usage);
        break;
      }
      case 'turn/end': {
        pruneTurns();
        const reason = event.data && event.data.reason;
        const kind = mapTurnEndReason(reason && reason.kind);
        const record = takeTurn(sid);
        if (kind === null) return; // 未知 kind → 静默，由兜底信号接管
        emitTurnFrame(kind, { session, sid, reason, record });
        break;
      }
      default: break;
    }
  };

  const agentContextOf = (payload, meta) => {
    // 运行时事实（0.2.0-rc.2 dsh-agent-loop）：agent/error｜turn-stopping｜
    // request-error 载荷为 { turn(回合号), step, ... / signal / failure }，
    // agent/status 仅 { status } —— 都**不带**会话对象（emit 无 options/meta）。
    // 因此兜底帧的会话归属尽力而为：先查载荷，再查未来可能出现的
    // meta.session / turn.session，全无则退化为 'unknown'（帧仍照发，正文带
    // 错误信息，浏览器侧按未知会话弹提醒；主信号 session/event 不受影响）。
    const agent = payload && payload.agent;
    const turn = payload && payload.turn;
    const session =
      (agent && agent.session) ||
      (turn && typeof turn === 'object' && (turn.session ?? turn.owner)) ||
      (meta && meta.session) ||
      undefined;
    const sid = sessionIdOf(session) || (agent && typeof agent.id === 'string' ? agent.id : '');
    return { agent, session, sid };
  };

  /** 兜底：agent/error → error（turn/end 缺失 reason 时）。 */
  const onAgentError = (payload, meta) => {
    const { session, sid } = agentContextOf(payload, meta);
    const error = payload && payload.error;
    const message = error && (error.message || String(error));
    const record = turnState.get(sid);
    dispatch({
      kind: 'error',
      sessionId: sid || 'unknown',
      sessionTitle: sessionTitleOf(session),
      agentType: agentTypeOf(session),
      failure: { code: error && error.code ? String(error.code) : 'UNKNOWN', message: message || 'agent error' },
      durationMs: record ? Date.now() - record.startedAt : undefined,
      tokens: record ? record.tokens : undefined,
    });
  };

  /**
   * 兜底：agent/turn-stopping → interrupted。
   * 运行时事实（dsh-agent-loop turn()）：turnEnds 就绪且无后续 step 时才派发本事件；
   * 在 0.2.0-rc.2 上它同时覆盖 completed/max-tokens 的普通收尾，而真正的中断
   * （用户 stop）会先被 `signal.throwIfAborted()` 短路、改走 turn/end 'aborted'。
   * 因此这里加 `signal.aborted === true` 守卫：仅在明确中止时才产出 interrupted，
   * 防止每次正常完成的回合都被误报为"已中断"。
   */
  const onTurnStopping = (payload, meta) => {
    if (!payload || payload.signal === undefined || payload.signal === null || payload.signal.aborted !== true) return;
    const { session, sid } = agentContextOf(payload, meta);
    const record = turnState.get(sid);
    dispatch({
      kind: 'interrupted',
      sessionId: sid || 'unknown',
      sessionTitle: sessionTitleOf(session),
      agentType: agentTypeOf(session),
      durationMs: record ? Date.now() - record.startedAt : undefined,
      tokens: record ? record.tokens : undefined,
    });
  };

  /** 兜底：agent/request-error → limit/error（failure.code 判定）。 */
  const onRequestError = (payload, meta) => {
    const failure = payload && payload.failure;
    const code = failure && typeof failure.code === 'string' ? failure.code : '';
    const { session, sid } = agentContextOf(payload, meta);
    const record = turnState.get(sid);
    dispatch({
      kind: isLimitFailureCode(code) ? 'limit' : 'error',
      sessionId: sid || 'unknown',
      sessionTitle: sessionTitleOf(session),
      agentType: agentTypeOf(session),
      failure: {
        ...(code !== '' ? { code } : {}),
        message: failure && failure.message ? String(failure.message) : 'request failed',
      },
      durationMs: record ? Date.now() - record.startedAt : undefined,
      tokens: record ? record.tokens : undefined,
    });
  };

  /** 兜底：agent/status idle → done（仅当 turn 记录仍在：turn/end 被错过时）。 */
  const onAgentStatus = (payload, meta) => {
    if (!payload || payload.status !== 'idle') return;
    const { session, sid } = agentContextOf(payload, meta);
    const record = turnState.get(sid);
    if (!record) return; // turn/end 已正常处理
    turnState.delete(sid);
    dispatch({
      kind: 'done',
      sessionId: sid || 'unknown',
      sessionTitle: sessionTitleOf(session),
      agentType: agentTypeOf(session),
      durationMs: Date.now() - record.startedAt,
      tokens: record.tokens,
    });
  };

  /** jobs settled（jobEvents=true 时；subscribe 存在才订阅）。 */
  const onJobEvent = (event) => {
    if (store.getConfig().jobEvents !== true) return;
    if (!event || event.type !== 'settled') return;
    if (event.awaited === true) return;
    if (event.cause === 'teardown') return;
    const job = event.job && typeof event.job === 'object' ? event.job : {};
    const status = job.status;
    let kind;
    if (status === 'failed') kind = 'error';
    else if (status === 'killed') kind = 'interrupted';
    else if (status === 'completed') kind = 'job';
    else return;
    const label = typeof job.label === 'string' && job.label !== '' ? job.label : String(job.id ?? 'job');
    const sid = typeof job.sessionId === 'string' ? job.sessionId : (typeof job.owner === 'string' ? job.owner : 'job');
    dispatch({
      kind,
      sessionId: sid,
      sessionTitle: label,
      agentType: 'root', // job.owner 可指向子代理但无会话头可查；保守取 root
      note: noteFor(kind, {
        sessionTitle: label,
        durationMs: typeof job.startedAt === 'number' && typeof job.finishedAt === 'number'
          ? job.finishedAt - job.startedAt
          : undefined,
        message: JOB_STATUS_TEXT[status] || status,
      }),
      tokens: undefined,
      ts: typeof job.finishedAt === 'number' ? job.finishedAt : Date.now(),
    });
  };

  const subscribe = (name, listener) => {
    try {
      const dispose = ctx.on(name, listener);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      log(`subscribe ${name} failed: ${String(error)}`);
    }
  };

  subscribe('session/event', (session, event) => {
    try { onSessionEvent(session, event); } catch (error) { log(`session/event: ${String(error)}`); }
  });
  // 所有 agent/* 事件统一签名 (payload, meta, next)：emit/serial 模式 meta 为
  // {}、next 为 undefined；waterfall（agent/request-error）必须放行 next()，
  // 否则会 veto 官方重试链。
  const onAgentEvent = (handler) => (payload, meta, next) => {
    try { handler(payload, meta); } catch (error) { log(`agent event: ${String(error)}`); }
    return typeof next === 'function' ? next() : undefined;
  };
  subscribe('agent/error', onAgentEvent(onAgentError));
  subscribe('agent/turn-stopping', onAgentEvent(onTurnStopping));
  subscribe('agent/request-error', onAgentEvent(onRequestError));
  subscribe('agent/status', onAgentEvent(onAgentStatus));

  // jobs 事件：可选服务，subscribe 存在 + jobEvents=true 才订。
  const jobsService = getService(ctx, 'jobs');
  if (jobsService && jobsService.events && typeof jobsService.events.subscribe === 'function') {
    if (store.getConfig().jobEvents === true) {
      try {
        const dispose = jobsService.events.subscribe({ owners: 'scope' }, (event) => {
          try { onJobEvent(event); } catch (error) { log(`jobs event: ${String(error)}`); }
        });
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        log(`jobs subscribe failed: ${String(error)}`);
      }
    }
  }

  // webServer 路由（优雅降级：注入不可用则仅保留 bus + webhook）。
  if (ctx && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (hostCtx) => {
        const webServer = hostCtx && hostCtx.webServer;
        if (!webServer || typeof webServer.register !== 'function') return;
        const origin = typeof webServer.host === 'string' && typeof webServer.port === 'number'
          ? `${webServer.host}:${webServer.port}`
          : null;
        try {
          const dispose = registerRoutes({ webServer, store, bus, dispatch, log, origin });
          disposers.push(dispose);
        } catch (error) {
          log(`routes register failed: ${String(error)}`);
        }
      });
    } catch (error) {
      log(`webServer inject failed: ${String(error)}`);
    }
  }

  return () => {
    for (const dispose of [...disposers].reverse()) {
      try { dispose(); } catch { /* already disposed */ }
    }
    store.dispose();
  };
}

/** guest appearance: session/event reason 里的 error 详情文本化（尽力而为），
 *  仅取真实错误文本；reason.kind 本身不算消息。 */
function failureMessageOf(reason) {
  if (!reason) return '';
  if (typeof reason === 'string') return reason;
  const error = reason && (reason.error ?? reason.reason);
  if (typeof error === 'string' && error !== '') return error;
  const message = error && error.message;
  if (typeof message === 'string' && message !== '') return message;
  if (typeof reason.message === 'string' && reason.message !== '') return reason.message;
  return '';
}