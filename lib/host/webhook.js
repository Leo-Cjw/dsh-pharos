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

/** Template tokens: {title}/{note}/{kind}/{sessionId}/{sessionTitle}/{tokens}/{duration}/{cache}/{tps}/{time}(本地)/{isoTime}(UTC)/{ts}. */
export function renderTemplate(template, frame) {
  if (typeof template !== 'string' || template === '') return frame && frame.note ? frame.note : '';
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
    .replaceAll('{note}', String(frame?.note ?? ''))
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
    .replaceAll('{time}', localTime)
    .replaceAll('{isoTime}', d.toISOString())
    .replaceAll('{ts}', frame?.ts !== undefined ? String(frame.ts) : '');
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