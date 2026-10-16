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
  doneHiddenOnly: true, // 向后兼容字段（v0.6.1 起由 doneNotifyMode 取代，读取时映射）
  // v0.6.1：「任务完成」提醒时机三档（对齐竞品 VS Code / Codex / ChatGPT 的默认语义）。
  //   'off'    —— 从不提醒
  //   'hidden' —— 仅页面隐藏/未聚焦时提醒（**默认**，同五家竞品一致）
  //   'always' —— 始终提醒（含你正盯着页面时）
  doneNotifyMode: 'hidden',
  currentQuiet: true,
  minIntervalMs: 6000,
  reAlertMs: 600000,
  blinkFallback: true,
  language: 'auto',
  quietHours: { enabled: false, start: '23:00', end: '08:00' },
  skipSubagents: true,
  jobEvents: true,
  // M2.5 workflow 提醒：默认全关。
  //   workflowEvents —— 订阅 workflow/phase·agent-start·agent-end（默认关）
  //   workflowLog    —— 额外订阅高频的 workflow/log（默认关；开启后 5s/rund 采样 + silent）
  // ⚠️ 两者都是**启动时**读配置订阅 → 开启需重启 DSH 生效；关闭即时生效（回调门）。
  workflowEvents: false,
  workflowLog: false,
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
 * 稳定行标识：secret 是掩码时靠它回填，**不再依赖数组下标**。
 * 历史数据（无 id）在加载时补发一次；此后每行恒有 id，位置漂移不再影响回填（issue #10）。
 */
function ensureWebhookId(row) {
  if (!isPlainObject(row)) return null; // 调用方过滤：契约是「对象数组」，不给非对象留位
  return typeof row.id === 'string' && row.id !== '' ? row : { ...row, id: randomUUID() };
}

/**
 * webhooks 恒为「对象数组」：非数组 → []；数组内的非对象元素（手改配置 / 旧畸形数据）→ 丢弃。
 * 重复 id 只保留首个 —— 两行同 id 会共享同一把密钥，且客户端 _key 碰撞会导致
 * 「删一行删两行」（PR #34 评审 D4 / D5）。
 */
function normalizeWebhooks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    const withId = ensureWebhookId(row);
    if (withId === null || seen.has(withId.id)) continue;
    seen.add(withId.id);
    out.push(withId);
  }
  return out;
}

/**
 * 类型归一：磁盘上的手改数据同样不得破坏类型契约。
 *   - apiToken **不强制转成字符串**：非字符串值原样保留，交给 routes 的守卫**拒绝**请求
 *     （fail closed）。早期写法把它悄悄归一成 ''，等于把「已配置 token」变成「无需鉴权」，
 *     是一个不可见的降级（PR #34 评审 D3）。
 *   - webhooks 非数组 → []，非对象元素 → 丢弃（否则迭代时抛错打哑 webhook 出口，见 issue #13）。
 */
export function normalizeConfig(config) {
  const out = isPlainObject(config) ? { ...config } : {}; // 不改动入参（调用方可能仍持有旧快照）
  out.webhooks = normalizeWebhooks(out.webhooks);
  return out;
}

/**
 * PUT /config semantics (pharos-settings 掩码约定，集成硬性要求)：
 *   - 字段值为 SECRET_MASK("***") → 保留原值不覆盖（设置页未编辑字段默认回传 "***"）
 *   - 字段值为 "" → 清除（落盘为空字符串）
 *   - 其它字符串 → 设为新值
 * 普通字段仍走 deepMerge 深合并；webhooks 整体替换，secret 逐条按上述规则。
 *
 * 类型校验（issue #9 / #10）：apiToken 只接受字符串，webhooks 只接受数组 ——
 * 非法类型一律**保持原值**，绝不落盘成会让下游守卫 / 迭代失效的畸形态。
 */
export function applyPutBody(current, body) {
  const incoming = isPlainObject(body) ? body : {};
  const merged = deepMerge(current, incoming);

  if ('apiToken' in incoming) {
    // 掩码 → 保留旧值；字符串 → 新值；非字符串入参 → 也保留旧值（不落盘畸形）。
    // 注意这里**原样保留** current 的旧值：若它本身是畸形的非字符串，不能被"洗"成 ''
    // —— 那等于悄悄把「已配置」降级为「无需鉴权」（PR #34 评审 D3）。
    merged.apiToken = incoming.apiToken === SECRET_MASK || typeof incoming.apiToken !== 'string'
      ? current.apiToken
      : incoming.apiToken;
  }

  if ('webhooks' in incoming) {
    merged.webhooks = Array.isArray(incoming.webhooks)
      ? restoreWebhookSecrets(incoming.webhooks, current.webhooks)
      : normalizeWebhooks(current.webhooks);
  }

  return merged;
}

/**
 * 逐行还原被打码的 secret（issue #10）：
 *   - 非掩码 → 用户填了新值（含显式清空 ""），原样接受；
 *   - 掩码   → 有 id 时按**稳定 id** 找回旧值（位置漂移不再串台）；
 *              无 id 时退回**下标**匹配 —— 这是修复前的语义，保留给未升级的
 *              客户端与直接调 PUT /config 的脚本，避免它们「掩码被丢弃」而丢密钥。
 *   两者都匹配不到 → **丢弃该字段**：既不串用别的行，也不把字面量 "***" 当真密钥落盘
 *   （打码后会与「已设置」无法区分）。
 * 行本身始终保留并补发 id，故「匹配不到」只会清掉密钥，不会丢配置。
 */
function restoreWebhookSecrets(incomingRows, currentRows) {
  const previous = Array.isArray(currentRows) ? currentRows : [];
  return incomingRows.map((row, index) => {
    if (!isPlainObject(row)) return null; // 与 normalizeWebhooks 一致：非对象不进配置
    if (row.secret !== SECRET_MASK) return ensureWebhookId(row);
    const hasId = typeof row.id === 'string' && row.id !== '';
    const match = hasId
      ? previous.find((prev) => isPlainObject(prev) && prev.id === row.id)
      : (isPlainObject(previous[index]) ? previous[index] : undefined);
    const next = { ...row };
    if (isPlainObject(match) && typeof match.secret === 'string') {
      next.secret = match.secret;                      // 命中：回填真正的旧值
    } else if (previous.length === 0) {
      delete next.secret;                              // 全新配置：丢弃掩码，别把 "***" 当真密钥落盘
    }
    // 有旧行但匹配不到：**既不猜也不静默清空**，保留掩码原样落盘 ——
    // 旧实现在这里 delete，会让密钥无声消失（PR #34 评审 D2）。
    return ensureWebhookId(next);
  }).filter((row) => row !== null);
}

/** Load + merge with DEFAULT_CONFIG. Malformed/absent file → defaults. */
export async function loadFromDisk(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const stored = JSON.parse(raw);
    if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
      return normalizeConfig(deepMerge(DEFAULT_CONFIG, stored));
    }
  } catch { /* absent or malformed */ }
  return normalizeConfig(deepMerge(DEFAULT_CONFIG, {}));
}

/** Atomic write: tmp in the same directory then rename over the target.
 *
 * 0o600: the config holds webhook URLs and their signing secrets. Creating the
 * tmp file with owner-only permissions carries over to the rename target, so an
 * already-existing 0644 file is tightened on the next write as well. On Windows
 * the mode is ignored beyond the read-only bit, so this is a no-op there.
 */
export async function writeAtomic(file, config) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

/** Sync variant of loadFromDisk for the construction-time snapshot. */
export function loadFromDiskSync(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    const stored = JSON.parse(raw);
    if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
      return normalizeConfig(deepMerge(DEFAULT_CONFIG, stored));
    }
  } catch { /* absent or malformed */ }
  return normalizeConfig(deepMerge(DEFAULT_CONFIG, {}));
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