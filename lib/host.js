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
  sessionTitleOf, sessionIdOf, usageTokensOf, isLimitFailureCode, dedupeKeyOf,
} from './host/frames.js';
import {
  readProjectionSnapshot, diffProjection, cacheHitRateOf, tpsOf, totalTokensOf,
} from './host/stats.js';

export const HOST_DEDUPE_MS = 3000;
const TURN_STATE_STALE_MS = 60 * 60 * 1000;

/** M2.5：workflow/log 是脚本旁白，密度极高 —— 开启后按 run 限流采样（5s 一帧）。 */
const WORKFLOW_LOG_SAMPLE_MS = 5000;
/** lastLogAt 修剪阈值（与 TURN_STATE_STALE_MS 同量级）。 */
const WORKFLOW_LOG_STALE_MS = 60 * 60 * 1000;

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
    // M2.5：silent 帧进 SSE 供调试，但不打扰任何渠道 —— 含 webhook 外发。
    // 放在最前早退：否则 log 帧虽不弹通知，仍会刷屏企微/飞书/钉钉（generic 还透传整帧）。
    if (frame && frame.silent === true) return;
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

  // ---- turn 计量状态（sessionId → { startedAt, tokens, baseline }）----
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

  /**
   * 当轮统计：投影 delta 优先、turnState 累加兜底（契约 M2）。
   * record.baseline 为 turn/start 时的投影快照；turn/end 时读 current 做差。
   * 基线缺失（插件中途启用 / 投影不可用）→ 返回 null，静默降级 v0.4（仅耗时+tokens）。
   */
  const deriveTurnStats = (session, record) => {
    if (!record || !record.baseline || !session) return null;
    const current = readProjectionSnapshot(ctx, session);
    const delta = diffProjection(record.baseline, current);
    if (!delta) return null;
    const hitRate = cacheHitRateOf(delta.tokenUsage);
    const tps = tpsOf(delta.sessionStats);
    const projectionTokens = totalTokensOf(delta.tokenUsage);
    return {
      cacheHitRate: hitRate,           // null 时 noteFor 不追加该段
      tps,                             // null 时 noteFor 不追加该段
      // tokens：投影 delta 优先，0 时回退 turnState 累加（兜底 + 交叉验证）
      tokens: projectionTokens > 0 ? projectionTokens : (record.tokens || 0),
    };
  };

  const emitTurnFrame = (kind, { session, sid, reason, record, stats }) => {
    const now = Date.now();
    const rawMessage = failureMessageOf(reason);
    const tokens = stats && typeof stats.tokens === 'number' && stats.tokens > 0
      ? stats.tokens
      : (record ? record.tokens : undefined);
    const durationMs = record ? now - record.startedAt : undefined;
    const cacheHitRate = stats ? stats.cacheHitRate : undefined;
    const tps = stats ? stats.tps : undefined;
    return dispatch({
      kind,
      sessionId: sid,
      sessionTitle: sessionTitleOf(session),
      agentType: agentTypeOf(session),
      durationMs,
      tokens,
      cacheHitRate,
      tps,
      failure: kind === 'error' || kind === 'limit'
        ? { ...(reason && reason.kind ? { code: String(reason.kind) } : {}), message: rawMessage }
        : undefined,
      note: noteFor(kind, {
        sessionTitle: sessionTitleOf(session),
        durationMs,
        tokens,
        cacheHitRate,
        tps,
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
        turnState.set(sid || 'unknown', {
          startedAt: Date.now(),
          tokens: 0,
          baseline: readProjectionSnapshot(ctx, session),
        });
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
        const stats = deriveTurnStats(session, record);
        emitTurnFrame(kind, { session, sid, reason, record, stats });
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

  // ---- M2.5 workflow 提醒（workflow/* 是 ctx.on 顶层 emit 事件，签名二元）----
  //
  // ⚠️ 签名与 agent/* 的 (payload, meta, next) **完全不同**：
  //   workflow/phase(info: WorkflowRunInfo, title: string)
  //   workflow/log(info: WorkflowRunInfo, message: string)
  //   workflow/agent-start(info: WorkflowRunInfo, agent: WorkflowAgentInfo)
  //   workflow/agent-end(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo)
  // 类型（app.asar 内 TS 声明原文）：
  //   WorkflowRunInfo = { id: WorkflowRunId; meta: WorkflowMeta }
  //   WorkflowMeta = { name; description; whenToUse?; phases? }
  //   WorkflowAgentInfo = { seq; label; phase?; childId: SessionId }
  //   WorkflowAgentEndInfo extends WorkflowAgentInfo + { outcome }
  // ⚠️ 双门不对称（同 jobEvents）：订阅门在 apply() 时读配置 → 「开」需重启才生效；
  //   回调门每次事件判 → 「关」即时生效。设置页提示须写明这个方向差异。

  /** workflow/* 的 emit 包装：异常隔离（不能因一个 handler 抛错打断事件链）。 */
  const onWorkflowEvent = (handler) => (info, arg) => {
    try { handler(info, arg); } catch (error) { log(`workflow event: ${String(error)}`); }
  };

  /**
   * 工作流名（人类可读）→ 帧的 sessionTitle。
   * ⚠️ 兜底返回空串而非「工作流」：浏览器半 notificationFor 的 workflowBody 会加
   * 「工作流『…』」前缀，兜底若也填「工作流」会渲染成「工作流『工作流』进入阶段：x」。
   * 空串时前缀退化为「工作流」单层，语义仍正确。
   */
  const workflowNameOf = (info) => {
    const name = info && info.meta && typeof info.meta.name === 'string' ? info.meta.name : '';
    return name;
  };

  // ⚠️ agentType 恒 'root'（本组四个 handler）：workflow/agent-* 语义上就是子 agent，
  //   若标 'subagent'，浏览器半 skipSubagents（默认 true）会把这组帧**整体吞掉**，
  //   导致「开了 workflowEvents 却什么都收不到」。标 'root' 是刻意取舍：
  //   ① 组能提醒（默认配置下）② 已有 workflowEvents 开关承担用户意图 ③ 再加一层
  //   「工作流子代理」过滤属新功能面，不在本轮范围。
  //   代价：设置页「跳过子代理事件」对 workflow 帧**无效**（口子已写进 README 已知限制）。
  //
  //   注：WorkflowAgentInfo.childId 是子 agent 的真实 SessionId，但 agentType 表达的是
  //   「这条通知算不算子代理打扰」，与 sessionId 语义无关，故仍取 root。

  /** workflow/phase → 'workflow' 帧（进入阶段）。 */
  const onWorkflowPhase = (info, title) => {
    if (store.getConfig().workflowEvents !== true) return;
    const sid = String(info?.id ?? 'workflow');
    const stage = typeof title === 'string' ? title : '';
    dispatch({
      kind: 'workflow',
      subtype: 'phase',
      sessionId: sid,
      sessionTitle: workflowNameOf(info),
      agentType: 'root',
      note: noteFor('workflow', { detail: stage !== '' ? `进入阶段：${stage}` : '进入新阶段' }),
      // ⚠️ interactionKey 只是 dedupeKeyOf 的第三参，**不是** makeFrame 入参 ——
      //    必须先算好再作为 dedupeKey 字段传（传错名字会被解构丢弃、回落默认 key）。
      dedupeKey: dedupeKeyOf('workflow', sid, `phase:${stage}`),
    });
  };

  /** workflow/agent-start → 'workflow' 帧（启动子 agent）。 */
  const onWorkflowAgentStart = (info, agent) => {
    if (store.getConfig().workflowEvents !== true) return;
    const sid = agent && typeof agent.childId === 'string' ? agent.childId : String(info?.id ?? 'workflow');
    const label = agent && typeof agent.label === 'string' ? agent.label : '';
    const seq = agent && typeof agent.seq === 'number' ? agent.seq : 0;
    dispatch({
      kind: 'workflow',
      subtype: 'agent-start',
      sessionId: sid,
      sessionTitle: workflowNameOf(info),
      agentType: 'root',
      // childId 随帧下发：浏览器半的「本地 done 路径」（uiSession running→false 边沿）
      // 拿不到子代理信息（uiSession 仅 3 字段、sessions.list 行无 origin/parentSession），
      // 故由 host 在此捎带子代理 sessionId，浏览器半存进 Set 后用于过滤。
      // ⚠️ 这是「workflow 场景的子代理」判据；普通 subagent 委派（不经 workflow）
      //    仍无法识别 —— 见 docs/sop-workflow-events.md「已知限制」（v0.6.1 再补该判据）。
      ...(typeof agent?.childId === 'string' && agent.childId !== '' ? { childId: agent.childId } : {}),
      note: noteFor('workflow', { detail: label !== '' ? `启动 agent ${label}（第 ${seq} 个）` : `启动第 ${seq} 个 agent` }),
      dedupeKey: dedupeKeyOf('workflow', sid, `agent-start:${seq}`),
    });
  };

  /** workflow/agent-end → 'workflow' 帧（子 agent 结束，带 outcome）。 */
  const onWorkflowAgentEnd = (info, agent) => {
    if (store.getConfig().workflowEvents !== true) return;
    const sid = agent && typeof agent.childId === 'string' ? agent.childId : String(info?.id ?? 'workflow');
    const label = agent && typeof agent.label === 'string' ? agent.label : '';
    const seq = agent && typeof agent.seq === 'number' ? agent.seq : 0;
    const outcome = agent && typeof agent.outcome === 'string' ? agent.outcome : '';
    dispatch({
      kind: 'workflow',
      subtype: 'agent-end',
      sessionId: sid,
      sessionTitle: workflowNameOf(info),
      agentType: 'root',
      note: noteFor('workflow', {
        detail: label !== ''
          ? `agent ${label} 结束（${outcome || '已结束'}）`
          : `agent 结束（${outcome || '已结束'}）`,
      }),
      dedupeKey: dedupeKeyOf('workflow', sid, `agent-end:${seq}`),
    });
  };

  /**
   * workflow/log → 'workflow' 帧 + silent。
   * 三层防护（§3.9）：① 默认不订阅（零开销，见下方 subscribe 门）② 开启时 5s/rund 限流
   * ③ silent 标记兜底（不弹通知、不外发 webhook）。
   */
  const lastLogAt = new Map(); // runId → ts
  const pruneLog = () => {
    const now = Date.now();
    for (const [runId, ts] of lastLogAt) {
      if (now - ts > WORKFLOW_LOG_STALE_MS) lastLogAt.delete(runId);
    }
  };
  const onWorkflowLog = (info, message) => {
    if (store.getConfig().workflowLog !== true) return;
    const sid = String(info?.id ?? 'workflow');
    const now = Date.now();
    pruneLog();
    if (now - (lastLogAt.get(sid) ?? 0) < WORKFLOW_LOG_SAMPLE_MS) return;
    lastLogAt.set(sid, now);
    const text = typeof message === 'string' ? message : '';
    dispatch({
      kind: 'workflow',
      subtype: 'log',
      silent: true,
      sessionId: sid,
      sessionTitle: workflowNameOf(info),
      agentType: 'root',
      note: noteFor('workflow', { detail: text }),
      dedupeKey: dedupeKeyOf('workflow', sid, 'log'),
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

  // M2.5 workflow 事件：双门（对齐 jobEvents 范式）。
  //   订阅门（此处，启动时读配置）→ 「开」需重启 DSH 才生效
  //   回调门（各 handler 开头）  → 「关」即时生效
  // ⚠️ workflowLog **独立于** workflowEvents 订阅（不嵌套）：两个 checkbox 视觉独立，
  //   若嵌套则「只勾日志」会静默无效果、零提示。log 帧带 silent=true，即只进 SSE/Debug
  //   供观察，不打扰任何渠道 —— 这是「独立开启」仍然安全的原因。
  if (store.getConfig().workflowEvents === true) {
    subscribe('workflow/agent-start', onWorkflowEvent(onWorkflowAgentStart));
    subscribe('workflow/agent-end', onWorkflowEvent(onWorkflowAgentEnd));
    subscribe('workflow/phase', onWorkflowEvent(onWorkflowPhase));
  }
  // log 密度极高，单独一门：默认不订阅 = 零开销
  if (store.getConfig().workflowLog === true) {
    subscribe('workflow/log', onWorkflowEvent(onWorkflowLog));
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