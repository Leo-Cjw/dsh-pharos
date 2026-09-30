/**
 * dsh-pharos — host half entry (v0.4.0, replaces the v0.3 no-op).
 *
 * Loader surface kept minimal for cordis 门控安全：inject 保持 []，全部服务
 * （webServer / jobs / profileContext）一律在 apply() 内通过 ctx.inject /
 * ctx.get(name, false) 惰性获取 —— 硬门只在显式 inject 列表上生效。
 *
 * Browser half (lib/client.js) is unchanged from v0.3 and keeps serving the
 * DSH client bundle; this host half adds the SSE bridge + webhook + config
 * API that the browser half consumes in M1.
 */

import { apply as applyHost } from './host.js';

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-pharos';

/** 空 inject：不声明任何服务依赖，避免 cordis 启动兼容检查门控。 */
export const inject = [];

/**
 * Host loader entry: mount subscriptions, routes, and webhook pushing.
 * @param ctx - host cordis context.
 * @param config - optional plugin config overrides (e.g. dedupeMs).
 * @returns a disposer that removes every listener/route/connection.
 */
export function apply(ctx, config) {
  return applyHost(ctx, config);
}