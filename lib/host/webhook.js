/**
 * dsh-pharos — host half: outbound webhook adapter (wecom / feishu /
 * dingtalk / generic) with signing, timeout, exponential backoff retry and
 * an in-memory failure ring buffer.
 *
 * 加签照 my-notify 分析（webhook/adapters.ts）：
 *   wecom     sha256(`${timestamp}\n${secret}`) hex → query `timestamp=&sign=`
 *   feishu    hmac_sha256(`${timestamp}\n${secret}`) base64 → body `{timestamp, sign}`
 *   dingtalk  同 feishu 算法 → query `timestamp=&sign=`（dingtalk timestamp 用毫秒）
 *   generic   帧原样透传（body = PharosEvent JSON）
 * 5s 超时（AbortController）、失败指数退避重试 3 次（1s/2s/4s）、
 * 最终失败入内存环形缓冲（50 条）。
 *
 * 零新增依赖：fetch 用全局 globalThis.fetch（可在 createWebhookSender 注入以测试）。
 */

import { createHash, createHmac } from 'node:crypto';
import { isQuietNow, formatDuration } from './frames.js';

export const WEBHOOK_TIMEOUT_MS = 5000;
export const WEBHOOK_MAX_RETRIES = 3; // retries AFTER the first attempt
export const WEBHOOK_BACKOFF_BASE_MS = 1000;
export const WEBHOOK_FAILURE_RING_SIZE = 50;

/** 契约 §4：events 取值（空数组 = 全事件）。 */
export const WEBHOOK_EVENT_KINDS = new Set(['done', 'error', 'interrupted', 'limit', 'needs-you', 'remote']);

/** Template tokens: {title}/{note}/{kind}/{kindLabel}/{sessionId}/{sessionTitle}/{tokens}/{duration}/{cache}/{tps}/{summary}/{time}(本地)/{isoTime}(UTC)/{ts}. */
/** kind → 中文标签（{kindLabel}）。未知 kind 原样输出，避免静默丢信息。 */
const KIND_LABELS = {
  done: '完成', error: '出错', interrupted: '中断', limit: '达到上限',
  job: '后台任务', remote: '远程', test: '测试', workflow: '工作流进展',
  needs_you: '需要你', attention: '需要你', agents: '子代理登记',
};

/**
 * 该行是否是「空壳行」—— 只有空白 / markdown 标记 / 图标 / 装饰符，没有任何实义字符。
 * 例：`"> "`、`"⏱ "`、`"🔢 "`、`"**"`、`"--- "` 都算；`"💾 缓存 "` 不算（含「缓存」二字）。
 */
function isResidualLine(line) {
  const t = String(line).trim();
  if (t === '') return false;              // 纯空行保留（markdown 分段）
  // 分隔线 / 标题线是**有效内容**，不能当空壳删掉
  if (/^(?:[-*_]\s*){3,}$/.test(t) || /^#{1,6}\s*$/.test(t)) return false;
  // 去掉 markdown 标记、emoji/符号、几何字符、空白后若为空 → 空壳行
  return /^[\s>*#\-–—_~`|$\[\](){}!?.:;,'"^=+*\/·•—…「」【】《》\u2000-\u2BFF\uFE0F\u{1F000}-\u{1FAFF}]*$/u.test(t);
}

/** 从 note 里剥掉末尾的「（耗时 …，…）」统计括号（note 已带统计且模板另行排版时用）。 */
function stripNoteStats(note, frame) {
  const stats = summaryOf(frame);
  if (stats === '') return note;
  // noteFor 产出的形态：`（耗时 24s，10505 tokens，缓存命中 99%，7.9 tok/s）`
  return note.replace(/（[^（）]*）\s*$/, '').trimEnd();
}

/**
 * 从 note 里剥掉「「会话名」」（首行已由 {title} 列出时用）。
 * ⚠️ 剥完必须收掉悬空的冒号/空格 —— 否则留下「任务完成：」这种半截句。
 *   noteFor 产出的形态：`任务完成：「你好」（…）` / `出错：「上传插件」 Connection error.`
 */
function stripNoteTitle(note, frame) {
  const title = frame && typeof frame.sessionTitle === 'string' ? frame.sessionTitle : '';
  if (title === '') return note;
  return note
    .replace(`「${title}」`, '')
    .replace(/：\s*\n\s*$/, '')   // 行尾只剩冒号 → 去掉（含换行）
    .replace(/：\s+/g, ' ')       // 冒号后多空格 → 单空格（出错： + Connection）
    .replace(/：\s*$/, '')          // 行尾只剩冒号 → 去掉
    .trim();
}

/** 帧的统计摘要（{summary}）——仅含存在的项，无值则整段为空（不留「··」残渣）。 */
function summaryOf(frame) {
  const parts = [];
  if (typeof frame?.durationMs === 'number' && Number.isFinite(frame.durationMs) && frame.durationMs > 0) {
    parts.push(formatDuration(frame.durationMs));
  }
  if (typeof frame?.tokens === 'number' && Number.isFinite(frame.tokens) && frame.tokens > 0) {
    parts.push(`${frame.tokens} tokens`);
  }
  if (typeof frame?.cacheHitRate === 'number' && Number.isFinite(frame.cacheHitRate)) {
    parts.push(`缓存命中 ${Math.round(frame.cacheHitRate * 100)}%`);
  }
  if (typeof frame?.tps === 'number' && Number.isFinite(frame.tps) && frame.tps > 0) {
    parts.push(`${frame.tps.toFixed(1)} tok/s`);
  }
  return parts.join(' · ');
}

export function renderTemplate(template, frame) {
  if (typeof template !== 'string' || template === '') return frame && frame.note ? frame.note : '';
  // 防重复：模板里既排了统计（{summary} 或各统计 token）、又用 {note} 时，
  // note 里的「会话名 + 统计括号」会与之重复两份。故按模板内容自动裁剪 note：
  //   · 含 {summary}          → note 去掉统计括号（omitStats）
  //   · 含 {title}           → note 去掉「会话名」（omitTitle，否则首行已列会话名）
  // 两者都默认 false，故未用这些 token 的既有模板行为完全不变。
  const hasSummary = template.includes('{summary}');
  const hasDetail = /\{duration\}|\{tokens\}|\{cache\}|\{tps\}/.test(template);
  const hasTitle = template.includes('{title}') || template.includes('{sessionTitle}');
  let note = frame && typeof frame.note === 'string' ? frame.note : '';
  if (note !== '' && (hasSummary || hasDetail)) {
    note = stripNoteStats(note, frame);
  }
  if (note !== '' && hasTitle) {
    note = stripNoteTitle(note, frame);
  }
  // ⚠️ {time} 必须是**本地**时间。toISOString() 返回 UTC（东八区差 8 小时），
  // 用户看到「时间：2026-10-07T13:01:33.217Z」而实际是 21:01 —— 无法用来核对事件。
  // 保留一个 {isoTime} token 给确实需要 UTC 的场景（如与外部系统对时）。
  const d = new Date(frame && frame.ts ? frame.ts : Date.now());
  const pad = (v) => String(v).padStart(2, '0');
  const localTime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return template
    .replaceAll('{title}', String(frame?.sessionTitle ?? ''))
    .replaceAll('{sessionTitle}', String(frame?.sessionTitle ?? ''))
    .replaceAll('{note}', note)   // 已按模板内容裁剪过（见上方防重复逻辑）
    .replaceAll('{kind}', String(frame?.kind ?? ''))
    .replaceAll('{sessionId}', String(frame?.sessionId ?? ''))
    .replaceAll('{tokens}', frame?.tokens !== undefined && frame.tokens !== null ? String(frame.tokens) : '')
    .replaceAll('{duration}', frame?.durationMs !== undefined ? formatDuration(frame.durationMs) : '')
    // {cache} 缓存命中率：0~1 小数 → 百分数取整（展示口径对齐 noteFor）。
    // {tps} 每秒 token：1 位小数。两者均「有值才填」，无值空串（不出现 undefined/NaN）。
    .replaceAll('{cache}', typeof frame?.cacheHitRate === 'number' && Number.isFinite(frame.cacheHitRate)
      ? `${Math.round(frame.cacheHitRate * 100)}%` : '')
    .replaceAll('{tps}', typeof frame?.tps === 'number' && Number.isFinite(frame.tps)
      ? `${frame.tps.toFixed(1)} tok/s` : '')
    // v0.6.1：{summary} 统计摘要（无任何统计时为空串，可整行隐藏）；{kindLabel} kind 的中文
    .replaceAll('{summary}', summaryOf(frame))
    .replaceAll('{kindLabel}', KIND_LABELS[String(frame?.kind ?? '')] ?? String(frame?.kind ?? ''))
    .replaceAll('{time}', localTime)
    .replaceAll('{isoTime}', d.toISOString())
    .replaceAll('{ts}', frame?.ts !== undefined ? String(frame.ts) : '')
    // 清理「残留空壳行」：token 无值时会留下裸的 "> "、"⏱ "、"🔢 " 之类，markdown 里
    // 渲染成空引用块 / 空列表项。判定：该行去掉 markdown 标记后只剩空白/图标/常见装饰符。
    // ⚠️ **不做整行 trim、不动纯空行** —— markdown 靠空行分段，误删会让整块挤成一段。
    .split('\n')
    .filter((line) => !isResidualLine(line))
    // 🔑 钉钉 markdown 的换行规则（官方 FAQ 原文）：
    //    「换行格式： \n 重要 \n前后两个空格」——即**行尾必须有两个空格**才是硬换行；
    //    否则单个 \n 会被折叠成空格。真机三轮实测：裸行、`> ` 引用块逐行都救不了，
    //    只有行尾两空格有效。
    //    这里**自动补齐**，让「写了独立一行」就等于「显示为独立一行」，
    //    预设与用户自定义模板都不必知道这个隐晦约定（用户也记不住）。
    .map((line, i, arr) => {
      const next = arr[i + 1];
      if (next === undefined || line.trim() === '' || next.trim() === '') return line;
      return / {2}$/.test(line) ? line : `${line}  `;
    })
    .join('\n')
    // 空壳行被删后会留下连续空行（如某档 4 个统计项全空）。markdown 本就会把它们合并成
    // 一个段落分隔，故视觉无差异；这里折叠成单个空行，让载荷与测试断言都更好读。
    .replace(/\n{3,}/g, '\n\n');
}

function hmacBase64(secret, content) {
  return createHmac('sha256', String(secret)).update(content).digest('base64');
}

/**
 * Pure adapter: decide the outbound HTTP request for one webhook × frame.
 * Returns { url, method, headers, body } — fully inspectable by tests.
 */
export function buildWebhookRequest(webhook, frame, { now = Date.now() } = {}) {
  const channel = typeof webhook?.channel === 'string' ? webhook.channel : 'generic';
  const content = renderTemplate(webhook?.template, frame);
  const contentType = { 'content-type': 'application/json; charset=utf-8' };

  switch (channel) {
    case 'wecom': {
      const timestamp = Math.floor(now / 1000);
      const sign = createHash('sha256').update(`${timestamp}\n${webhook.secret ?? ''}`).digest('hex');
      const separator = webhook.url.includes('?') ? '&' : '?';
      return {
        url: `${webhook.url}${separator}timestamp=${timestamp}&sign=${sign}`,
        method: 'POST',
        headers: contentType,
        body: { msgtype: 'markdown', markdown: { content } },
      };
    }
    case 'feishu': {
      const timestamp = Math.floor(now / 1000);
      const sign = hmacBase64(webhook.secret ?? '', `${timestamp}\n${webhook.secret ?? ''}`);
      return {
        url: webhook.url,
        method: 'POST',
        headers: contentType,
        body: {
          msg_type: 'text',
          content: { text: content },
          timestamp: String(timestamp),
          sign,
        },
      };
    }
    case 'dingtalk': {
      const timestamp = Math.floor(now); // DingTalk uses milliseconds
      const sign = hmacBase64(webhook.secret ?? '', `${timestamp}\n${webhook.secret ?? ''}`);
      const separator = webhook.url.includes('?') ? '&' : '?';
      return {
        url: `${webhook.url}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`,
        method: 'POST',
        headers: contentType,
        body: { msgtype: 'markdown', markdown: { title: frame?.sessionTitle ?? 'dsh-pharos', text: content } },
      };
    }
    case 'generic':
    default: {
      return {
        url: webhook.url,
        method: 'POST',
        headers: contentType,
        body: { ...frame }, // 帧透传
      };
    }
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function responseSummary(res) {
  try {
    const text = await res.text();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return '';
  }
}

/**
 * Webhook sender factory. Options injectable for tests:
 *   fetchImpl  — default globalThis.fetch
 *   timeoutMs  — per-attempt AbortController timeout (default 5000)
 *   maxRetries — retries after the first attempt (default 3)
 *   backoffMs  — base of 1s/2s/4s exponential backoff (default 1000; tests pass 1)
 *   ringSize   — failure ring buffer capacity (default 50)
 *   now        — clock injection for quiet-hours checks
 * Returns { send, listFailures }.
 */
export function createWebhookSender(opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = WEBHOOK_TIMEOUT_MS,
    maxRetries = WEBHOOK_MAX_RETRIES,
    backoffMs = WEBHOOK_BACKOFF_BASE_MS,
    ringSize = WEBHOOK_FAILURE_RING_SIZE,
    log = () => {},
  } = opts;

  /** In-memory failure ring buffer (oldest evicted). */
  const failures = [];
  const pushFailure = (entry) => {
    failures.push(entry);
    if (failures.length > ringSize) failures.shift();
  };

  /**
   * Push one frame through one webhook.
   * @param webhook {name, channel, url, secret?, events?, enabled?, template?}
   * @param frame PharosEvent
   * @param scope {config?} — config used for the quiet-hours gate.
   * @returns {status: 'quiet'|'sent'|'failed', attempts?, error?, failures?}
   */
  const send = async (webhook, frame, scope = {}) => {
    const timestamp = scope.now ?? Date.now();
    if (isQuietNow(scope.config, new Date(timestamp))) {
      return { status: 'quiet', skipped: true, attempts: 0 };
    }
    const request = buildWebhookRequest(webhook, frame, { now: timestamp });
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await delay(backoffMs * 2 ** (attempt - 1));
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchImpl(request.url, {
            method: request.method,
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal,
          });
          if (res && res.ok === true) {
            return { status: 'sent', attempts: attempt + 1 };
          }
          const status = res ? res.status : 0;
          const detail = res ? await responseSummary(res) : '';
          lastError = new Error(`webhook ${channelName(webhook)} HTTP ${status}${detail ? `: ${detail}` : ''}`);
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        log(`webhook ${channelName(webhook)} attempt ${attempt + 1} failed: ${lastError.message}`);
      }
    }
    const entry = {
      ts: Date.now(),
      channel: channelName(webhook),
      url: request.url,
      error: lastError ? String(lastError.message ?? lastError) : 'webhook failed',
      frame: frame ? { id: frame.id, kind: frame.kind, sessionId: frame.sessionId } : undefined,
    };
    pushFailure(entry);
    return { status: 'failed', attempts: maxRetries + 1, error: lastError, failures: [...failures] };
  };

  return {
    send,
    listFailures: () => [...failures],
  };
}

function channelName(webhook) {
  return typeof webhook?.channel === 'string' ? webhook.channel : 'generic';
}