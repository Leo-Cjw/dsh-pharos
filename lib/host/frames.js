/**
 * dsh-pharos — host half: event normalization + PharosEvent construction.
 *
 * Pure functions only: no ctx, no I/O, no timers. Every function here is
 * directly importable by tests (including the real test suite that
 * pharos-tests writes in test/host.test.mjs, which drives it with stub
 * ctx/webServer/fetch objects).
 *
 * The frame shape is the contract §2 `PharosEvent`:
 *   { id, kind, severity, sessionId, sessionTitle, agentType, note,
 *     toolName?, reason?, failure?, ts, durationMs?, tokens?,
 *     cacheHitRate?, tps?, subtype?, silent?, childId?,
 *     source, dedupeKey }
 *
 * subtype (M2.5): workflow 子类标记 'phase'|'agent-start'|'agent-end'|'log'。
 *   ⚠️ 职责仅「随帧透出、供 debug 队列与日志辨识」——浏览器半的弹窗/静默分流
 *   实际靠 silent 字段，去重键则由 host handler 用 dedupeKeyOf 预先算好；
 *   subtype 不参与任何决策，勿高估它。
 * silent (M2.5): true = 进 SSE 供调试但不打扰任何渠道（不弹通知、不外发 webhook）。
 *   ⚠️ 去重要用 `dedupeKey` 字段（由 dedupeKeyOf 预先算好）；`interactionKey` 只是
 *   dedupeKeyOf 的第三参，**不是** makeFrame 入参——传了会被解构丢弃。
 *
 * reason.kind → kind mapping (contract §5 + turn-notify REASON_KIND_TO_CATEGORY):
 *   completed → done, error → error, aborted → error, interrupted → interrupted,
 *   blocked → limit, max-tokens → limit, anything else → null (silent);
 *   contract explicitly wants unknown kinds to produce NO frame.
 */

import { randomUUID } from 'node:crypto';

/** All kinds host can produce. 'needs-you' is browser-produced only. */
export const HOST_KINDS = new Set(['done', 'error', 'interrupted', 'limit', 'job', 'remote', 'test', 'workflow']);

/** Severity table (contract §2). job 按状态 handled by callers before kind is fixed. */
const SEVERITY_BY_KIND = {
  done: 'info',
  job: 'info',
  remote: 'info',
  test: 'info',
  workflow: 'info',
  interrupted: 'warn',
  error: 'error',
  limit: 'error',
};

/**
 * reason.kind → PharosEvent kind. `null` means "no frame" (silent drop).
 * Unknown kinds are a documented runtime drift (0.2.0-rc.2 dsh-session self
 * produces `interrupted`/`forked`; agent-loop produces completed/blocked/
 * aborted/error/max-tokens): anything outside the table silently falls
 * through to the fallback signals (agent/error etc.).
 */
export function mapTurnEndReason(kind) {
  switch (kind) {
    case 'completed': return 'done';
    case 'error': return 'error';
    case 'aborted': return 'error';
    case 'interrupted': return 'interrupted';
    case 'blocked': return 'limit';
    case 'max-tokens': return 'limit';
    default: return null;
  }
}

/** Sum the assistant/message usage four buckets into one token count. */
export function usageTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const buckets = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  let total = 0;
  for (const key of buckets) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

/** Humanized duration, e.g. 2m 5s; used in notes and webhook templates. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * Host-assembled rendering text (contract §2 note: 渲染正文，含耗时/tokens 插值).
 * Callers may pass their own `note`; this is the default.
 *
 * M2.5 workflow: 只产**片段**，不含「工作流」前缀 —— 前缀统一由浏览器半的
 * workflowBody 加（host 与 browser 各加一次会渲染成「工作流『工作流…』」）。
 */
export function noteFor(kind, { sessionTitle = '', durationMs, tokens, cacheHitRate, tps, message = '', label = '', detail = '' } = {}) {
  const meta = [];
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
    meta.push(`耗时 ${formatDuration(durationMs)}`);
  }
  if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
    meta.push(`${tokens} tokens`);
  }
  // 缓存命中率：分母 0 → cacheHitRateOf 已返回 null，此处 null/缺失一律不追加
  // （对齐 UI：不显示误导性的「0%」）。
  if (typeof cacheHitRate === 'number' && Number.isFinite(cacheHitRate)) {
    meta.push(`缓存命中 ${Math.round(cacheHitRate * 100)}%`);
  }
  if (typeof tps === 'number' && Number.isFinite(tps) && tps > 0) {
    meta.push(`${tps.toFixed(1)} tok/s`);
  }
  const suffix = meta.length > 0 ? `（${meta.join('，')}）` : '';
  const head = typeof sessionTitle === 'string' && sessionTitle !== '' ? `「${sessionTitle}」` : '会话';
  switch (kind) {
    case 'done': return `任务完成：${head}${suffix}`;
    case 'error': return `出错：${head}${message ? ` ${message}` : ''}${suffix}`;
    case 'interrupted': return `已中断：${head}${suffix}`;
    case 'limit': return `达到上限：${head}${message ? ` ${message}` : ''}${suffix}`;
    case 'job': return `后台任务完成：${message || head}${suffix}`;
    case 'remote': return message || '远程通知';
    case 'test': return `测试通知（${label || 'host'}）`;
    // M2.5 workflow：片段（无「工作流」前缀，前缀由浏览器半加）
    case 'workflow': return detail !== '' ? detail : message;
    default: return message || '';
  }
}

/**
 * Subagent判定（照 my-notify isTopLevelAgent 语义；取不到 → 'root'）。
 * Accepts either a dsh-session Session object ({ header }) or a plain
 * meta object ({ origin, delegationDepth, parentSession }).
 */
export function agentTypeOf(meta) {
  const header = meta && meta.header && typeof meta.header === 'object' ? meta.header : meta;
  if (!header || typeof header !== 'object') return 'root';
  if (header.origin === 'subagent') return 'subagent';
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return 'subagent';
  if (header.parentSession !== undefined && header.parentSession !== null) return 'subagent';
  return 'root';
}

/** Best-effort session title: last `session/title` event, then fallback. */
export function sessionTitleOf(session, fallback = '会话') {
  if (session && typeof session === 'object') {
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events;
      if (Array.isArray(events)) {
        for (let i = events.length - 1; i >= 0; i--) {
          const event = events[i];
          if (event && event.type === 'session/title') {
            const title = event.data && event.data.title;
            if (typeof title === 'string' && title !== '') return title;
          }
        }
      }
    } catch { /* snapshot may be unavailable on stub sessions */ }
  }
  return fallback;
}

/** Session id from a Session object or a plain { id, header } stub. */
export function sessionIdOf(session, fallback = '') {
  if (session && typeof session === 'object') {
    if (typeof session.id === 'string' && session.id !== '') return session.id;
    if (session.header && typeof session.header.id === 'string' && session.header.id !== '') return session.header.id;
  }
  return fallback;
}

/** dedupeKey: `${kind}:${sessionId}`；needs-you 追加交互 key（host 不使用）。 */
export function dedupeKeyOf(kind, sessionId, interactionKey) {
  const base = `${kind}:${sessionId || 'unknown'}`;
  return interactionKey === undefined || interactionKey === null
    ? base
    : `${base}:${interactionKey}`;
}

/**
 * Construct one PharosEvent. All fields defaulted so callers only pass what
 * they know; `note` is auto-composed unless provided; `severity` is derived
 * from `kind` unless provided; `dedupeKey` defaults to kind:sessionId.
 * @throws TypeError on a kind outside HOST_KINDS — unknown reason kinds must
 *   be dropped via mapTurnEndReason BEFORE reaching makeFrame.
 */
export function makeFrame(input) {
  if (!input || typeof input !== 'object') throw new TypeError('makeFrame: input object required');
  const {
    kind,
    id = randomUUID(),
    ts = Date.now(),
    sessionId = '',
    sessionTitle = '会话',
    agentType = 'root',
    note,
    toolName,
    reason,
    failure,
    durationMs,
    tokens,
    cacheHitRate,
    tps,
    subtype,
    silent,
    childId,
    source = 'host',
    dedupeKey,
  } = input;
  if (!HOST_KINDS.has(kind)) throw new TypeError(`makeFrame: unknown kind ${JSON.stringify(kind)}`);
  const severity = input.severity ?? SEVERITY_BY_KIND[kind] ?? 'info';
  const normalizedFailure = failure === undefined || failure === null
    ? undefined
    : {
        ...(typeof failure.code === 'string' && failure.code !== '' ? { code: failure.code } : {}),
        message: typeof failure.message === 'string' ? failure.message : String(failure.message ?? ''),
      };
  return {
    id,
    kind,
    severity,
    sessionId,
    sessionTitle,
    agentType,
    note: typeof note === 'string' ? note : noteFor(kind, { sessionTitle, durationMs, tokens, cacheHitRate, tps, message: normalizedFailure?.message }),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(normalizedFailure !== undefined ? { failure: normalizedFailure } : {}),
    ts,
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
    ...(typeof tokens === 'number' && tokens > 0 ? { tokens } : {}),
    ...(typeof cacheHitRate === 'number' && Number.isFinite(cacheHitRate) ? { cacheHitRate } : {}),
    ...(typeof tps === 'number' && Number.isFinite(tps) ? { tps } : {}),
    // M2.5：workflow 子类标记 + 静默标记（仅在显式传入时展开）
    ...(typeof subtype === 'string' && subtype !== '' ? { subtype } : {}),
    ...(silent === true ? { silent: true } : {}),
    // M2.5：子代理的 sessionId 随帧下发，供浏览器半过滤「本地 done 路径」
    // （那条路径由 uiSession 边沿驱动，拿不到 origin/parentSession）。
    ...(typeof childId === 'string' && childId !== '' ? { childId } : {}),
    source,
    dedupeKey: typeof dedupeKey === 'string' ? dedupeKey : dedupeKeyOf(kind, sessionId),
  };
}

/**
 * Quiet-hours predicate (host webhook gate; browser enforces the same window
 * on-screen from the same server config). Cross-midnight aware; start === end
 * means "always quiet" is NOT supported — equal bounds disable the window.
 * @param config - config with quietHours {enabled, start 'HH:mm', end 'HH:mm'}.
 * @param date - injection point for tests; defaults to now.
 * @returns true when quiet hours are active and the instant falls inside.
 */
export function isQuietNow(config, date = new Date()) {
  const quiet = config && config.quietHours && config.quietHours.enabled === true ? config.quietHours : null;
  if (!quiet) return false;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === null || end === null) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // crosses midnight
}

/** 'HH:mm' → minutes-of-day, or null when malformed. */
export function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Whether an agent/request-error failure.code smells like limit/rate/quota. */
export function isLimitFailureCode(code) {
  if (typeof code !== 'string') return false;
  return /(limit|rate|429|quota|配额|限额)/i.test(code);
}