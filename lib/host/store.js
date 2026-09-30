/**
 * dsh-pharos — host half: config / webhooks JSON persistence.
 *
 * profileDir 冲刺落实（契约 §7.2）：仿 dshmarket/lib/profile.js——
 *   home = env.DSH_HOME || ~/.dsh（dshmarket home-paths.js resolveDshHome 同式）
 *   file = <home>/profiles/<name>/pharos.json
 *   name  = ctx.get('profileContext')?.launched?.name
 *           ?? ctx.get('profileContext')?.name        ← 运行时已核实：profile-boot 提供
 *                 { name, dir, ... }（dsh/lib/profile-boot-BZ2ZjNWi.js:259），无 launched 字段；
 *                 dshmarket launchedProfile() 同样只读 context.name/context.dir。
 *           ?? 'desktop'
 *   dir   = profileContext.dir（启动器拥有 profile 实际位置，dshmarket 同优先取 explicitDir）
 *           ?? <home>/profiles/<name>
 * 拿不到 profileContext → 回退 <home>/pharos.json（契约 §7.2）。
 *
 * 本机实测（2026-09-30，Desktop 0.2.0-rc.2，无 DSH_HOME 环境变量）：
 *   profileContext = { name: 'desktop', dir: '/Users/mia/.dsh/profiles/desktop', ... }
 *   → pharos.json 落盘路径 = /Users/mia/.dsh/profiles/desktop/pharos.json
 * 原子写：同目录 tmp 文件（含 pid+random 后缀）→ rename。
 */

import { randomUUID } from 'node:crypto';
import { writeFile, rename, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 契约 §4 defaults — PUT/GET 同形；缺省合并 DEFAULT_CONFIG。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  toast: true,
  sound: true,
  volume: 0.5,
  autoFocus: true,
  attentionHiddenOnly: false,
  doneHiddenOnly: true,
  currentQuiet: true,
  minIntervalMs: 6000,
  reAlertMs: 600000,
  blinkFallback: true,
  language: 'auto',
  quietHours: { enabled: false, start: '23:00', end: '08:00' },
  skipSubagents: true,
  jobEvents: true,
  hostNotify: false,
  apiToken: '',
  webhooks: [],
});

/** Secret placeholder returned by GET side (契约 §3：apiToken、webhook.secret → "***"）。 */
export const SECRET_MASK = '***';

/** env.DSH_HOME || ~/.dsh（空白视为未设置，照 home-paths.js）。 */
export function dshHome(env = process.env) {
  const fromEnv = env && typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : null;
  return resolve(fromEnv ?? join(homedir(), '.dsh'));
}

/** profileContext 读取（惰性、永不 throw）。 */
export function readProfileContext(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const value = ctx.get('profileContext', false);
      return value !== null && typeof value === 'object' ? value : null;
    }
  } catch { /* no profileContext service */ }
  return null;
}

/** Resolve pharos.json's absolute path. Exposed for tests + diagnostics. */
export function pharosFilePath(ctx, env = process.env) {
  const pc = readProfileContext(ctx);
  const home = dshHome(env);
  if (pc !== null) {
    const name = typeof pc.launched?.name === 'string' && pc.launched.name !== ''
      ? pc.launched.name
      : typeof pc.name === 'string' && pc.name !== ''
        ? pc.name
        : 'desktop';
    if (typeof pc.dir === 'string' && pc.dir !== '') return join(pc.dir, 'pharos.json');
    return join(home, 'profiles', name, 'pharos.json');
  }
  return join(home, 'pharos.json');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merge: plain objects recurse; arrays/scalars replace. No mutation. */
export function deepMerge(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return isPlainObject(source) ? { ...source } : source;
  }
  const out = { ...target };
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined) continue;
    out[key] = isPlainObject(out[key]) && isPlainObject(value)
      ? deepMerge(out[key], value)
      : isPlainObject(value)
        ? { ...value }
        : Array.isArray(value)
          ? value.map((item) => isPlainObject(item) ? { ...item } : item)
          : value;
  }
  return out;
}

/**
 * Deep clone that masks any non-empty secret field with SECRET_MASK.
 * 空值（'' / 未设置）保持原样返回——设置页按真值显示「已设置/未设置」，
 * 也避免「清除为 ''」的配置被 GET 再次伪装成已设置。
 */
export function maskConfig(config) {
  if (!isPlainObject(config)) return config ?? {};
  const out = { ...config };
  for (const key of Object.keys(out)) out[key] = cloneSecretSafe(out[key]);
  out.apiToken = config.apiToken && config.apiToken !== '' ? SECRET_MASK : '';
  if (Array.isArray(out.webhooks)) {
    out.webhooks = out.webhooks.map((webhook) =>
      isPlainObject(webhook)
        ? { ...webhook, secret: webhook.secret && webhook.secret !== '' ? SECRET_MASK : '' }
        : webhook);
  }
  return out;
}

function cloneSecretSafe(value) {
  if (Array.isArray(value)) return value.map((item) => isPlainObject(item) ? { ...item } : item);
  if (isPlainObject(value)) return { ...value };
  return value;
}

/**
 * PUT /config semantics (pharos-settings 掩码约定，集成硬性要求)：
 *   - 字段值为 SECRET_MASK("***") → 保留原值不覆盖（设置页未编辑字段默认回传 "***"）
 *   - 字段值为 "" → 清除（落盘为空字符串）
 *   - 其它字符串 → 设为新值
 * 普通字段仍走 deepMerge 深合并；webhooks 数组整体按索引替换，secret 逐条按上述规则。
 */
export function applyPutBody(current, body) {
  const merged = deepMerge(current, body && typeof body === 'object' ? body : {});
  if (body && body.apiToken === SECRET_MASK) merged.apiToken = current.apiToken;
  if (Array.isArray(body && body.webhooks) && Array.isArray(current.webhooks)) {
    merged.webhooks = body.webhooks.map((webhook, index) => {
      if (isPlainObject(webhook) && webhook.secret === SECRET_MASK && isPlainObject(current.webhooks[index])) {
        return { ...webhook, secret: current.webhooks[index].secret };
      }
      return isPlainObject(webhook) ? { ...webhook } : webhook;
    });
  }
  return merged;
}

/** Load + merge with DEFAULT_CONFIG. Malformed/absent file → defaults. */
export async function loadFromDisk(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const stored = JSON.parse(raw);
    if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
      return deepMerge(DEFAULT_CONFIG, stored);
    }
  } catch { /* absent or malformed */ }
  return deepMerge(DEFAULT_CONFIG, {});
}

/** Atomic write: tmp in the same directory then rename over the target. */
export async function writeAtomic(file, config) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** Sync variant of loadFromDisk for the construction-time snapshot. */
export function loadFromDiskSync(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    const stored = JSON.parse(raw);
    if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
      return deepMerge(DEFAULT_CONFIG, stored);
    }
  } catch { /* absent or malformed */ }
  return deepMerge(DEFAULT_CONFIG, {});
}

/**
 * The config store; one instance per plugin apply().
 * Reads are SYNCHRONOUS (tiny JSON snapshot loaded once at construction);
 * writes are async but atomic (tmp + rename).
 * - getConfig() —— 同步返回当前配置（事件热路径不阻塞）
 * - getPath()   —— 解析到的文件路径（报告给 lead 用）
 * - update(body)—— applyPutBody 深合并 → 原子落盘 → 返回新配置
 * - dispose()   —— 清缓存（测试可重用）
 */
export function createStore(ctx, env = process.env) {
  const file = pharosFilePath(ctx, env);
  let cache = loadFromDiskSync(file);
  return {
    getPath: () => file,
    getConfig: () => cache,
    async update(body) {
      const next = applyPutBody(cache, body);
      await writeAtomic(file, next);
      cache = next;
      return next;
    },
    async setConfig(next) {
      await writeAtomic(file, next);
      cache = next;
      return next;
    },
    dispose() {
      cache = null;
    },
  };
}