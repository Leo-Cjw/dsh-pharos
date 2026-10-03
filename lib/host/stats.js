/**
 * dsh-pharos — host half: per-turn statistics from the official
 * `sessionProjections` registry.
 *
 * 数据源（运行时 0.2.0-rc.2，已逐行核实，见 docs/m2-plan.md 附录）：
 *   ctx.sessionProjections = Service("sessionProjections")
 *   snapshot(session, keys) → { asOfSeq, values: { tokenUsage, sessionStats } }
 *     tokenUsage  = { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
 *     sessionStats = { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
 *
 * 关键口径：投影值是**会话累计**（对整场 log fold），不是「当轮」。做「当轮」
 * 统计必须 turn/start 存基线 + turn/end 做差（diffProjection）。本模块只负责：
 *   - 读取面（readProjectionSnapshot，唯一触碰 ctx 的适配函数，永不 throw）
 *   - 派生面（diffProjection + cacheHitRateOf + tpsOf + totalTokensOf，纯函数）
 *
 * 纯函数约定：无 ctx、无 I/O、无定时器；除 readProjectionSnapshot 外均可被测试
 * 直接用桩快照驱动。所有数值字段缺失按 0 兜底，不产生 NaN。
 */

/** tokenUsage 投影四桶（字段名以运行时为准：uncachedInputTokens 非 inputTokens）。 */
const TOKEN_BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/** 从投影快照里取 tokenUsage 四桶视图（字段缺失按 0）。 */
function tokenUsageView(snap) {
  const tu = snap && snap.values && snap.values.tokenUsage;
  const out = {};
  if (tu && typeof tu === 'object') {
    for (const key of TOKEN_BUCKETS) {
      const v = tu[key];
      out[key] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    }
  } else {
    for (const key of TOKEN_BUCKETS) out[key] = 0;
  }
  return out;
}

/** 从投影快照里取 sessionStats 的 decode 双字段（字段缺失按 0）。 */
function sessionStatsView(snap) {
  const ss = snap && snap.values && snap.values.sessionStats;
  const num = (key) => {
    const v = ss && ss[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  };
  return { decodeTokens: num('decodeTokens'), decodeMs: num('decodeMs') };
}

/** 两快照的 tokenUsage 四桶做差（当轮净增量），负值钳为 0（重复上报鲁棒）。 */
export function diffTokenUsage(baseline, current) {
  const base = tokenUsageView(baseline);
  const cur = tokenUsageView(current);
  const out = {};
  for (const key of TOKEN_BUCKETS) out[key] = Math.max(0, cur[key] - base[key]);
  return out;
}

/** 两快照的 sessionStats decode 双字段做差（当轮净增量），负值钳为 0。 */
export function diffSessionStats(baseline, current) {
  const base = sessionStatsView(baseline);
  const cur = sessionStatsView(current);
  return {
    decodeTokens: Math.max(0, cur.decodeTokens - base.decodeTokens),
    decodeMs: Math.max(0, cur.decodeMs - base.decodeMs),
  };
}

/**
 * 当轮派生值：两快照做差，得到 tokenUsage 四桶 delta 与 sessionStats decode delta。
 * @param baseline - turn/start 时的投影快照（可为 null）。
 * @param current  - turn/end 时的投影快照（可为 null）。
 * @returns { tokenUsage, sessionStats } 各含 delta 字段；任一侧为 null 时返回 null
 *   （表示「无投影可用」→ 静默降级）。
 */
export function diffProjection(baseline, current) {
  if (!baseline || !current) return null;
  const tokenUsage = diffTokenUsage(baseline, current);
  const sessionStats = diffSessionStats(baseline, current);
  return { tokenUsage, sessionStats };
}

/** 当轮缓存命中率 = cacheReadΔ / (uncachedInputΔ + cacheReadΔ + cacheWriteΔ)。
 *  分母 0 → 返回 null（对齐 UI：不显示该段，非「0%」）。 */
export function cacheHitRateOf(tokenUsageDelta) {
  if (!tokenUsageDelta) return null;
  const denom = tokenUsageDelta.uncachedInputTokens + tokenUsageDelta.cacheReadTokens + tokenUsageDelta.cacheWriteTokens;
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return tokenUsageDelta.cacheReadTokens / denom;
}

/** 当轮 TPS = decodeTokensΔ / (decodeMsΔ / 1000)。decodeMsΔ 为 0 → 返回 null。 */
export function tpsOf(sessionStatsDelta) {
  if (!sessionStatsDelta) return null;
  const ms = sessionStatsDelta.decodeMs;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return sessionStatsDelta.decodeTokens / (ms / 1000);
}

/** 当轮总 token = 四桶 delta 之和。 */
export function totalTokensOf(tokenUsageDelta) {
  if (!tokenUsageDelta) return 0;
  return TOKEN_BUCKETS.reduce((sum, key) => sum + (tokenUsageDelta[key] || 0), 0);
}

/**
 * 惰性读取 sessionProjections 的 snapshot（唯一触碰 ctx 的适配函数）。
 * 服务缺失 / snapshot 不可用 / 任何异常 → 返回 null（**永不 throw、不硬门**）。
 * @param ctx - cordis 上下文（host 半 apply 传入）。
 * @param session - 会话对象（仅 session/event 主信号路径有真实 Session）。
 */
export function readProjectionSnapshot(ctx, session) {
  try {
    if (!ctx || typeof ctx.get !== 'function' || !session || typeof session !== 'object') return null;
    const projections = ctx.get('sessionProjections', false);
    if (!projections || typeof projections.snapshot !== 'function') return null;
    const snap = projections.snapshot(session, ['tokenUsage', 'sessionStats']);
    if (!snap || !snap.values || typeof snap.values !== 'object') return null;
    return snap;
  } catch {
    return null;
  }
}
