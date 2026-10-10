# dsh-pharos M1 实现契约（v0.4.0）

> 本文件是 M1（host 桥）团队共享的**单一事实源**：帧契约、路由契约、配置 Schema、文件职责、行为规则、运行时事实。任何成员实现前先读完本文档与 docs/functional-architecture.md §3-§4。冲突以本文档为准。
> 总设计见 docs/functional-architecture.md；四仓库实现细节见 docs/research/。

## 0. 这一版做/不做

**做（M1 范围）**：
1. host 半实装：订阅 host 事件 → 归一定类 → 构造 PharosEvent 帧 → 双通道（SSE 广播 + webhook 推送）。
2. webServer 同源路由（prefix `/pharos/api`）：SSE stream / trigger / config GET·PUT / webhooks GET。
3. 浏览器半：保留 v0.3 全部能力；新增消费 SSE 帧（done/error/interrupted/limit/job/remote）；新音型与新文案；quiet hours；子代理过滤；DOM toast 兜底；跨标签页去重（Web Locks）；测试按钮扩展。
4. 设置页：`settings.section` 顶级分区（React 视图，React 获取方式见 §7 冲刺项）。
   - **2026-10-05 修订**：原定为 `settings.plugins.tab`（「内置插件」分区内标签页），已迁移，理由见 §10。
5. 测试：test/smoke.mjs 扩展 + 新增 test/host.test.mjs。

**不做（明确排除）**：宿主原生 osascript 通知（hostNotify 配置位预留但默认关，不进本轮实现）、IM 推送、自定义音效上传、M2 统计、workflow 级细分、per-session 标记"已读"联动。

## 1. 文件职责（写作用户：各成员只动自己 scope）

```
lib/index.js          ← host 半入口（替换现有 no-op；scope: pharos-host）
lib/host.js           ← host 半 apply() 组装：订阅、路由、webhook、配置存储（scope: pharos-host）
lib/host/frames.js    ← 事件归一定类 + PharosEvent 构造（纯函数，可单测）（scope: pharos-host）
lib/host/routes.js    ← webServer.register（SSE/trigger/config/webhooks）（scope: pharos-host）
lib/host/webhook.js   ← 适配器 + 加签 + 重试 + 失败缓冲（scope: pharos-host）
lib/host/store.js     ← 配置/Webhooks 持久化 JSON（scope: pharos-host）
lib/client.js         ← 浏览器半（v0.3 演进；scope: pharos-client）
lib/settings-view.js  ← 设置页视图 + 配置表单（scope: pharos-settings）
test/smoke.mjs        ← 浏览器半状态机冒烟（scope: pharos-tests）
test/host.test.mjs    ← host 半单测（stub ctx/webServer/fetch）（scope: pharos-tests）
package.json / README / cordis.patch.yml  ← 仅 Integrator(Lead) 改
```

## 2. PharosEvent 帧（双方共用；SSE 载荷 = 帧 JSON）

```ts
interface PharosEvent {
  id: string;                       // crypto.randomUUID()(host) / client 自增
  kind: 'done' | 'error' | 'interrupted' | 'limit' | 'job' | 'remote' | 'test';
  severity: 'info' | 'warn' | 'error';      // done/remote/test=info；interrupted=warn；error/limit=error；job 按状态
  sessionId: string; sessionTitle: string;
  agentType: 'root' | 'subagent';           // host 尽力判定；未知→'root'
  note: string;                     // 渲染正文（含耗时/tokens 插值，host 组装）
  toolName?: string; reason?: string;       // 需要你的上下文（本轮仅浏览器侧使用）
  failure?: { code?: string; message: string }; // error/limit
  ts: number;                       // host 权威时钟 Date.now()
  durationMs?: number; tokens?: number;     // host 计量（turn 内 assistant/message usage 四桶合计）
  source: 'host' | 'remote' | 'browser';
  dedupeKey: string;                // 见 §6
}
```
SSE 约定：事件名 `pharos`，`data: <帧 JSON>`；心跳 `: ping` 每 25s；断线重连 client 默认 retry（EventSource 内建，~3s backoff）。

## 3. Host 路由（webServer.register，prefix `/pharos/api`）

全部先过**同源/回环围栏**：`isLoopback(req)`（remoteAddress ∈ 127.0.0.1/::1/::ffff:127.0.0.1）且 `req.headers.host === 当前 origin host`；不满足一律 403。写接口另加 `content-type: application/json` 校验（405/400 错误语义照 my-notify）。

| 路由 | 方法 | 行为 |
| --- | --- | --- |
| /pharos/api/stream | GET | SSE：握手 200 text/event-stream；广播帧；25s ping；连接关闭清理 |
| /pharos/api/trigger | POST | body `{title?, body, sessionId?}` → 构造 `kind:'remote'` 帧入 bus（SSE+webhook 双通道）；`apiToken` 非空时校验 `x-pharos-token` 头（未校验 401） |
| /pharos/api/config | GET | 返回配置（secret 字段打码：apiToken、webhook.secret → `"***"`） |
| /pharos/api/config | PUT | body=完整配置 → 深合并落盘 → 返回新配置（打码视图） |
| /pharos/api/webhooks | GET | 返回 webhooks 列表（secret 打码） |

## 4. 配置 Schema（PUT/GET 同形；缺省合并 DEFAULT_CONFIG）

```js
const DEFAULT_CONFIG = {
  enabled: true, toast: true, sound: true, volume: 0.5, autoFocus: true,
  attentionHiddenOnly: false, doneHiddenOnly: true, currentQuiet: true,
  minIntervalMs: 6000, reAlertMs: 600000, blinkFallback: true, language: 'auto',
  quietHours: { enabled: false, start: '23:00', end: '08:00' },
  skipSubagents: true, jobEvents: true, hostNotify: false,
  apiToken: '',
  webhooks: [ /* {name,channel,url,secret,events[],enabled,template} */ ]
};
```
- 通道取值：`wecom|feishu|dingtalk|generic`；events 取值：`done|error|interrupted|limit|needs-you|remote`（空 = 全事件）。
- 浏览器偏好层（localStorage `dshPharos.config`）保留 v0.3 语义；**服务端配置存在时以服务端为准**（浏览器 GET /config 一次并缓存；失败/无 host 时回退 localStorage）。
- 持久化：`<profileDir>/pharos.json`（见 §7 的 profileDir 解析）；原子写（tmp+rename）。

## 5. 双半职责与数据流

- **host 订阅**（lib/host/frames.js + 组装处）：
  - `ctx.on('session/event', (session, event) => …)`：`turn/end` → 依 `event.data.reason.kind` 定类（映射表见下）；`assistant/message` 累积 usage 四桶；`turn/start` 起表计时。子代理判定：session/event 的 session 是否为子代理会话（header.origin==='subagent' || delegationDepth>0，照 my-notify isTopLevelAgent 语义；取不到就 'root'）。
  - `ctx.on('agent/error', ({turn, step, error}) => …)` → error（reason.kind 缺失时的兜底）。
  - `ctx.on('agent/turn-stopping', …)` → interrupted（兜底）。
  - `ctx.on('agent/request-error', ({failure}) => …)` → limit/error（兜底；failure.code 含 limit/rate/429/配额语义→limit，否则 error）。
  - `ctx.jobs.events.subscribe({owners:'scope'}, …)`（jobEvents=true 时）：settled 且 `event.awaited!==true` 且 cause!=='teardown' 且 status==='failed'→error、'killed'→interrupted。
  - **reason.kind→kind 映射**：completed→done、error→error、aborted→error、interrupted→interrupted、blocked→limit（阻塞语义贴近上限/配额，正文说明）、max-tokens→limit、未知→不产出帧（静默；下落 agent/error 兜底）。
- **host 产出**：帧总线（作用域内去重窗 3000ms，key=dedupeKey）→ SSE 广播 + webhook（quietHours 生效期不发 webhook；按 webhook.events 过滤；skipSubagents 时 agentType==='subagent' 帧不发 webhook）。
- **浏览器消费**：
  - v0.3 引擎（uiSession.sessionStatus + sessions）原样保留，产出 needs-you（本会话级）与 done（本地计时补丁）。
  - SSE 帧进同一策略层：去重（帧级 2s 窗口 + Web Locks 跨标签）、quiet hours、子代理过滤（skipSubagents 且 agentType==='subagent' → 丢弃）、渠道路由。
  - 渠道：system-notification / chime（done 双音上行、attention 三音下行、error 重低音、interrupted/limit 中音警示）/ title-marker（🔔 需要你 / ⏳ 闪烁）/ dom-toast（权限 denied/不可用时兜底）。
  - 点击通知：`window.focus()` + `openSession(id)`。v0.6.3 主路径 `uiWorkspace.openSession(id)`（真正切视图），`binding(id)?.session.open()` 降为老宿主兜底。
    - **前置闸门**（对齐官方 `sessionLinkState`，client-ui-schedule/lib/types/client/session-link.js）：`workspaces.state==='error'` / `sessions.phase==='pending'` / `workspaces.phase==='pending'` / `archivedSessionIds` 命中 / **不在 `sessions.ids`**（刻意用 `ids` 而非 `byId`，因 byId 另含本地兜底行）—— 任一命中即不跳。投影不可读（服务缺失）同样不跳：宁可漏跳，不冒险跳进归档。
    - **服务解析**：`ctx.get(name)` **strict 优先**。cordis 的 `strict` 只过滤提供方 fiber 是否 ACTIVE（`_getImpl`：`if (strict && impl.fiber.state !== 2) return`），**与 inject 声明无关**；non-strict 会连未 ACTIVE 的半初始化实例一起返回。解析阶段**不缓存**，仅在 `openSession` 调用成功后回填 —— 否则半初始化实例被永久缓存会导致导航能力永久退化。
    - 所有 kind 一律跳（v0.6.3 去掉了原先仅 attention 跳的限制）。

## 6. 行为规则（去重/节流/静默）

- dedupeKey：`${kind}:${sessionId}`（needs-you 追加交互 key：`needs-you:${sid}:${interactionKey}`）；done 追加 turn 粒度（用 ts 窗口即可，见下）。
- 去重窗口：host 帧级 3000ms（同 key 静默丢弃）；浏览器同 key 2s 窗口 + Web Locks；done 另有会话级节流 `minIntervalMs` 6s（双源共用：SSE done 与 uiSession done 视为同 key）。
- 静默：`currentQuiet`——needs-you 时当前会话 + 页面聚焦 → 只亮标记不弹；`doneHiddenOnly`——done 仅页面隐藏时弹（v0.3 默认）。
- quiet hours：`quietHours.enabled` 时在 [start,end) 区间（跨午夜）静默 on-screen 渠道与 webhook（host 侧读同一配置）。
- 二次提醒：needs-you 挂起 reAlertMs(10min) 补发一次（v0.3 保留；浏览器侧实现）。
- 短回合：本轮不实现 minTurnDurationMs（列入 M2；文档已注明语义）——host 对 turn/end 一律产出，浏览器/去重消化。

## 7. 运行时事实速查（已核实 / 需冲刺核实）

**已核实（0.2.0-rc.2，详见 docs/functional-architecture.md §1）**：
- `ctx.webServer.register({kind:'exact'|'prefix', path, handler(req,res)})`（dshmarket/lib/routes.js 实装；node http 风格，`res.writeHead/end/write`）。
- `session/event`：`ctx.on('session/event', (session, event) => …)`；`turn/end event.data = {turn, reason:{kind}}`（dsh-session:791 产出；本运行时已见 kind∈{interrupted,forked}，complete/error 等由 agent-loop 的 turn/end 补充——**实现时对未知 kind 静默降级**）。
- `agent/error {turn,step,error}`、`agent/turn-stopping {turn,signal}`、`agent/request-error {turn,step,provider,failure,retryPolicy,signal}`（dsh-agent-loop）。
- job 事件：`ctx.jobs.events.subscribe({owners:'scope'}, e => …)`；e.type∈settled/removed；job.status∈running/stopping/completed/killed/failed（dsh-tool-jobs）。
- 设置页槽位：`settings.section`（顶级分区）与 `settings.plugins.tab`（「内置插件」分区内标签页）**两个槽本机都存在**。
  - **原记「`settings.section` 不存在」有误（2026-10-05 复核）**：查错了包 —— 槽位声明方是 `@deepseek-ai/dsh-client-ui-settings-general/lib/client.js:1137-1140`（`"settings.section": { kind: "list", scope: "root" }`），导航投影在同文件 `:1017-1040`（`slots.entries("settings.section")` → `sort(order)`）、渲染在 `:338`（`renderSlot("settings.section", { close }, { only: active })`）。`dsh-client-ui-settings` 只提供底座与配置表单，本身不声明该槽。详见 §10。
- 跳会话：**导航入口是 `uiWorkspace.openSession(id)`**（dsh-client-ui-workspace client.js:821 → `replaceMain(target, signal, "reveal")`：retain mainView + selection.set + layout.selectPanel(null)）。⚠️ `session.open()`（api-session-controller client.js:1857）**不是导航**，只是拉事件流/历史尾页；`binding(id)`（:3407）= `scopes.get(id)?.binding`，而 `scopes` 只在 `retain()` 时 materialize（:3473）→ 未 retain 的后台会话拿不到 binding。`sessions.open(id)` 不存在。UI 主区渲染谁由 `uiSession.current` 按 `retainedBy.mainView > 0` 挑（dsh-client-ui-session client.js:283/:340）。
- 服务注入：host `ctx.inject(['webServer'], cb)`、`ctx.get(name, false)` 惰性查；client 插件**必须把读取的服务全部声明进 inject**——cordis 上下文代理对未声明服务的直接属性读（`ctx.sessions` / `ctx.uiSession` / `ctx.slots`）抛 `cannot get property X without inject`（0.2.0-rc.2 实测，dsh-notify-me lib/client.js:20-21 同款教训）；本插件声明 `["sessions", "uiSession", "slots"]`，且 apply 永不外抛（避免 cordis 上报 `web boot: … did not activate` 触发 fail-loud 恢复流程重写 profile 补丁）。服务按树序激活可能晚于本条目，apply 用 500ms×60 重试延迟接管（照 dsh-notify-me）。

**需冲刺核实（实现成员开工前 30-60min 内查源码定案）**：
1. **React 获取（pharos-settings）**：在浏览器 bundle 里怎么拿到 react？查 `/Users/mia/.dsh/profiles/desktop/node_modules/dshmarket/client/client.js`（其设置视图用的 React import 方式）与 `/tmp/dsh-checkout/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`（slots.register 契约：返回 React element 还是别的）。结论三选一：(a) `require('react')` 可用 → 直接 import；(b) runner 提供全局 React → 用之；(c) 都不行 → 视图用纯 DOM 构造并确认 register 能收非 React 渲染产物，否则把设置页降级标记 M1.5。**最终以 (a) 优先——dshmarket 设置页即 React（peer 声明 react ^18||^19 无 @deepseek-ai 门禁）。**
2. **profileDir（pharos-host）**：仿 dshmarket/lib/profile.js 的解析：`env.DSH_HOME || ~/.dsh` + `/profiles/<name>/`；profile name 取 `ctx.get('profileContext')`（launched.name 优先，回退 'desktop'）；落盘 `<profileDir>/pharos.json`。若 profileContext 拿不到 → 回退 `~/.dsh/pharos.json`。实现时给出你在本机验证到的实际路径。
3. ~~**slot id 与「设置→插件」行的匹配（pharos-settings）**~~ —— **2026-10-05 已定案，见 §10**：改用顶级 `settings.section`；`id` 无需等于插件条目 id（实测自由 id：dshmarket `market`、官方 inventory `all`、turn-notify `turn-notify`）。

## 8. 测试

- `node test/smoke.mjs`（浏览器半）：保留 27 断言（v0.3 回归），新增：SSE 帧消费（done/error/interrupted/limit）、双源 done 去重、quiet hours、子代理帧丢弃、toast 兜底、trigger 帧、config 合并。EventSource/fetch/Web Locks/Navigator 全部 stub（smoke 已用 vm 驱动真实 client.js，扩展同法）。
- `node test/host.test.mjs`（host 半）：stub ctx（on 捕获、inject 回调、webServer.register 捕获、get）、stub fetch；断言：turn/end 各 reason.kind → 正确帧字段；agent/error 兜底；未知 kind 静默；webhook 适配器（wecom/feishu/dingtalk/generic 各 1 例 + 加签）；SSE 广播；trigger 鉴权（无 token / 错 token / 对 token）；config GET 打码、PUT 深合并、原子落盘；quiet hours 拦住 webhook。
- 全部零新增依赖（node 内置 + 现有 stub 手法）。冒烟/主机测试都要 `process.exit(非0失败)`。

## 9. 集成（Integrator/Lead 执行，成员不碰）

版本 0.3.0→0.4.0；package.json 增补 exports/files（含 lib/host* 若拆分）、peerDependencies `react: "^18.2.0 || ^19.3.0"`（仅设置页需要时）、scripts.test 跑两个测试；README 更新；同步 `local-plugins/dsh-pharos` 与 `node_modules/dsh-pharos`；提交；提示用户重启验证。

## 10. 修订（2026-10-05）：设置页从 `settings.plugins.tab` 迁到 `settings.section`

### 10.1 起因：M1 的槽位判定查错了包

M1 认定「`settings.section` 不存在」，据此选了 `settings.plugins.tab` 并在 §7 记为已核实事实。复核（0.2.0-rc.2 运行时源码）表明该判定有误 —— 当时查的是 `@deepseek-ai/dsh-client-ui-settings`，而该槽的**声明方是 `@deepseek-ai/dsh-client-ui-settings-general`**：

| 事实 | 位置 |
|---|---|
| 槽位声明 `{ kind: "list", scope: "root" }` | `dsh-client-ui-settings-general/lib/client.js:1137-1140` |
| 导航投影（`slots.entries("settings.section")` → `sort(order)`） | 同文件 `:1017-1040` |
| 分区渲染（`renderSlot("settings.section", { close }, { only: active })`） | 同文件 `:338` |
| 「内置插件」壳：注册 `settings.section`(id `plugins`, order 15) + 声明子槽 `settings.plugins.tab` | `dsh-client-ui-settings-plugins/lib/client.js:203-212` |

**注意：本项目自己的调研早已给出正确答案，却被相反的结论覆盖** ——
- `docs/research/notify-me-analysis.md:147-153`：dsh-notify-me 用 `settings.section`，id `dsh-notify-me`，order 45，并写明「官方 dsh-client-ui-settings-account、dsh-client-ui-agent-preset 用的正是同一 API，**已在 0.2.0-rc.2 bundle 里验证**」。
- `docs/research/turn-notify-analysis.md:45`：dsh-turn-notify 用 `settings.section`，id `turn-notify`，order 41。
- 另有 `docs/research/session-notify-analysis.md:95`：session-notify 用 keyed slot `settings.plugin.item`（更早宿主线）。

→ 故 `functional-architecture.md` 曾记的「notify-me 的 settings.section 是旧宿主写法」不成立，已一并更正。

### 10.2 层级依据（为什么顶级而不是分区内标签页）

- `settings.section` = **功能/产品域**设置（账号 · 通用 · 模型 · Agent 预设 · 插件市场 · 侧边卡片）。
- `plugins.*` = **插件管理域**（清单 · 组合包 · 行 · 包自身配置）。
- 本插件设置页配的是**通知行为**（音效 · 免打扰 · 过滤 · Webhook 渠道），属前者。
- **同域先例**：`dsh-better-sidebar`（第三方功能型插件，order 100）只注册 `settings.section` 一个座位。
- **不注册第二个座位**：`plugins.bundle.config`（键 = 组合包名）是官方给「组合包自己的配置」的座位；本插件没有包自身运维内容（版本 / 更新通道 / 线路 / 卸载），故不注册。对照 dshmarket 多占座位，是因为它的卡片内容**正是**包自身运维。

### 10.3 落地参数

| 项 | 值 |
|---|---|
| `SLOT_NAME` | `settings.section` |
| `SLOT_ID` | `pharos-notifications` |
| `SLOT_ORDER` | `30` |
| `SLOT_LABEL` | `消息通知` |

order 实测占用：general `0` / models `10` / plugins `15` / agent-presets `20` / market `40` / better-sidebar `100`（在野：turn-notify `41`、notify-me `45`）—— `30` 与全部现有值不冲突。
视图新增自绘标题 `.pharos-title`（16px / weight 500 / line-height 24，对齐 `ui-settings-models` 的 `.title` 与 dshmarket 的 `.title`）：**顶级分区的壳不画标题**（对照官方 `PluginsSettingsSection` 自绘 `<h2>`），而标签页形态下标题由分区壳 + 标签提供。

### 10.4 图标（2026-10-05 已落地，v0.5.1）

标记：**三形状灯塔**（实心灯头 + 灯台横条 + 收分空心塔身），不画光束（发丝细条在 16px 下会糊成脏点）。配色：灯头琥珀 `#F59E0B` + 塔身 DSH 蓝 `#3B7BF6`。

**形状语言必须与宿主一致**（第一版栽在这里，实测返工）：`@deepseek-ai/dsh-client-ui-primitives` 的 artwork 统一是 `viewBox="0 0 16 16"` + `fill="none"` + 每形状 `stroke="currentColor"`，导航取 `ICON_MEDIUM_STROKE = 1.3`，`strokeLinecap/Linejoin = round`。故标记也按 **16 网格描边**绘制，灯头仍为实心（16px 下 1.3 描边圆的心孔会塌成亚像素、糊成一坨）。灯台横条用 1.5 略重以在 16px 下压得住。

第一版（36 网格 + 填色剪影 + 不设 `fill`）有两处缺陷，均由截图证实：
1. **没设 `fill`** → SVG 默认填黑 → 深色主题下几乎不可见（浅色下是一团黑斑）。
2. **填色式剪影**与邻座轮廓图标语言不搭，且缩到 16px 后三块糊成一条 4px 宽的竖线。

**几何验证方式**：不靠"看一眼"，改用**栅格化数值验证**（按 SVG 真实渲染模型填充/描边，超采样后输出 ASCII 覆盖率图，4×4 超采样）。据此淘汰了收腰塔身（像花瓶）与圆顶灯室（顶部糊成一团）。放大侧结论：纯等比放大、**描边权重不做补偿**时 36px 下结构依然清晰；试过提到 2.2，灯头与灯台会粘在一起、整块糊成墩子 —— 故权重固定 1.3/1.5。

宿主实测的图标面（`ui-plugin-manager` 的 `PackageArtwork`，`object-fit: contain`，不裁切）：

| 消费面 | 尺寸 | 机制 | 状态 |
|---|---|---|---|
| 侧栏「插件」页 组合包卡片 | 36 | `pkg.meta.icon` ← `package.json` 的 `icon` | ✅ 根目录 `icon.svg` |
| 组合包详情页顶部 | 36 | 同上 | ✅ 同上 |
| 组合包内组件行 | 30 | `row.meta.icon`（解析到同一包 package.json） | ✅ 同上 |
| 设置导航「消息通知」 | 16 | `settings.section` **无 icon 字段** | ✅ `installSettingsNavIcon()` |
| 设置 → 内置插件 →「插件列表」卡片 | — | **不渲染图标**（该包 0 处 icon） | 无需处理 |
| 插件市场（dshmarket）已安装列表 | — | 不读 `meta.icon`，用市场自己的 catalog 资源 | 控不了 |

同机先例：`dsh-better-sidebar`（`"./icon.svg"`）、`dsh-context` / `dsh-client-ui-skill-explorer`（`"icon.svg"`）都是「根目录 svg + `files` 列出 + `package.json.icon` 指向」。故照此办理，`files` 已加 `icon.svg`（`npm pack --dry-run` 确认入包）。

导航图标的实现与 dshmarket 不同：它注一张 CSS 样式表、用 `::before` + `mask` 画；本插件**直接换节点** —— `currentColor` 由外壳 `.navCell` 的 `color` 继承，插入的 svg 无需自带颜色，少一个 `<style>` 注入点。认领方式是按 `.navLabel` 文本比对（外壳的 nav 按钮没有 id/data 属性可挂），配一个只订阅 `childList` 的 `MutationObserver` 补挂（设置对话框按需打开）。DOM 结构若变导致找不到 svg，则**保持齿轮不换**（宁可不换，不破坏外壳）。

**防漂移**：几何的唯一真源是 `icon.svg`，`lib/settings-view.js` 的 `PHAROS_MARK_*` 是其副本，`test/smoke.mjs` 的 M1-I 段有 **6 条**静态断言锁住（形状数 / 两条路径内联 / 灯头几何 / viewBox 16 网格 / 描边式契约 / 描边权重）。已两次反向验证：改坏路径、把权重改回 2.2，都精确报 1 项失败。

> ⚠️ `package.json` 由宿主在插件加载时读，**改 `icon` 字段需要重启 DSH** 才生效（浏览器半的导航图标只需刷新页面）。

### 10.5 验收记录

`node tools/sync-settings-view.mjs` 幂等（连跑两次 md5 一致）；`test/smoke.mjs` M1 102 项（v0.6.0 实测；含 M1-I 图标防漂移 6 条、M1-K 跨文件静态契约锁 19 条：HOST_KINDS ⊆ SSE_KINDS、TEXT.zh/en key 集合一致、TEST_KINDS ⊆ ALL_TEST_KINDS、pushDebugFrame 入队早于三道早退等）、`test/host.test.mjs` 220 项全绿；`node --check` 通过；`npm pack --dry-run` 确认 `icon.svg` 入包；`local-plugins/dsh-pharos` 的 `lib/client.js` / `lib/settings-view.js` / `package.json` / `icon.svg` 与仓库 md5 一致。

**版本**：0.5.0 → **0.5.1**。用户可见行为变更（设置入口从「内置插件」分区内标签页升为顶级分区 + 新增灯塔图标），无新功能，故走 patch 位；`0.6.0` 留给 M2.5（`docs/m2.5-plan.md`）。`package.json` 的 description 同步改为「…a settings page in the Settings sidebar.」（原为 "a settings tab"，与新位置不符）。

**待办**：README 截图 `screenshot-3/4/5-settings-*.png` 与 `screenshot-2-overview.png` 仍显示旧位置与宿主通用插画，需在重启 DSH 后重拍（拍图须先关系统专注模式）。