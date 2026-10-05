# dsh-pharos 功能架构雏形

> 版本：draft-1（2026-09-30）｜ 面向运行时：DSH desktop 0.2.0-rc.2（desktop host）
> 本文件是功能与模块架构的第一版草图（"雏形"），用于决策 v0.4 及后续版本做什么、怎么做、可行性依据在哪。所有"可行/不可行"结论均在目标运行时（0.2.0-rc.2）源码上逐一核实过（见 §1），不是 README 转述。

---

## 0. 定位与设计原则

dsh-pharos = 法罗斯灯塔：**在你离开 DSH 时替你守望，任务完成、出错、或模型需要你操作时把你唤回。**

能力演进的原则（对标 4 个社区仓库后沉淀）：

1. **事件驱动，零轮询**：一切提醒都来自订阅（浏览器侧 store 订阅 / host 侧 `ctx.on` 总线），绝不 setInterval 扫描会话状态（唯一例外：标题标记的前缀保活，属渲染兜底）。
2. **双层自洽，host 桥为纲**：浏览器半是唯一"用户可见"层（通知/音效/标题/toast/设置），host 半是唯一"信号丰富"层（agent/error、中断、workflow、token）。两者用**同源 HTTP（SSE + fetch）**通信（my-notify 实测验证的通道），不引入 IPC。
3. **事件帧统一，策略与渠道分离**：所有触发源归一为 `PharosEvent` 帧；去重/节流/静默/免打扰是纯策略层；通知/音效/标题/toast/webhook 是纯渠道层。加渠道不加逻辑，加触发源不改渠道。
4. **零 peer、低门禁优先**：插件市场里 dsh-notify-me 因 peer 门（`dsh-client-locale ^0.1.x` vs 运行时 0.2.0）被启动兼容检查拦下。pharos 坚持：能用服务注入解决的就不声明依赖；必须引入依赖（设置页的 react / schemastery）时只声明与运行时实际版本匹配的范围。
5. **去重节流是契约**：同事件不打扰同一用户两次；"需要你"未处理时二次提醒一次；完成节流；页面加载时的历史状态不补弹。

---

## 1. 运行时能力事实核查（0.2.0-rc.2，全部源码级验证）

| # | 能力 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 浏览器半 `uiSession.sessionStatus` | 每会话**仅 3 字段** `{running, pendingInteraction, completionUnread}`，无 error/原因字段 | `dsh-client-ui-session/lib/client.js`（141/352/482 行：状态对象构建与相等性判断） |
| 2 | host 半事件总线（`ctx.on` / `dispatch`） | ✅ **丰富**：agent/status、agent/error、agent/request-error、agent/turn-stopping、approval/request、tools/pre-execute、session/event、workflow/agent-start·agent-end·log·phase、subagent/start·end、goal/changed 等 | 核心包 `lib/index.js` 全量枚举 |
| 3 | `agent/error` 载荷 | `{turn, step, error}`（agent-loop 的 throwError 上报，实时边界） | `dsh-agent-loop/lib/index.js:880` |
| 4 | `agent/turn-stopping`（中断） | `{turn, signal}`（AbortSignal，即"被中断"信号） | `dsh-agent-loop/lib/index.js:999` |
| 5 | `agent/request-error`（请求失败/限流） | `{turn, step, provider, failure, retryPolicy, signal}`（LLM 层失败，含 provider 与失败码） | `dsh-agent-loop/lib/index.js:1124` |
| 6 | 后台任务事件 | `ctx.jobs.events.subscribe({owners:'scope'}, e => …)`，`type: settled/removed`；job.status 枚举 `running/stopping/completed/killed/failed`（failed/killed 即可报"任务失败/被杀"） | `dsh-tool-jobs/lib/index.js`（官方插件即用它做任务完成提醒） |
| 7 | host 半 HTTP 路由 | ✅ **可行**：`ctx.webServer.register({kind:'exact'\|'prefix', path, handler(req,res)})`，挂在 DSH 自身 Web 服务器（GUI 同源、无独立端口）；dshmarket 与 my-notify 均实装 | `dshmarket/lib/routes.js:1441` 起数十处 register；`dsh-my-notify/src/routes.ts` |
| 8 | SSE 广播 | ✅ 同源 EventSource + 25s `: ping` 心跳 + retry（my-notify 实测模式） | dsh-my-notify `parts/stream.ts` |
| 9 | 设置页 | ✅ 两个入口：① host `Config`（schemastery schema）+ `settings.configure`（官方插件通用模式）；② 浏览器 slot **`settings.section`**（顶级设置分区，v0.6 起；`ctx.get('slots',false)` + `slots.register({name,id,order,label}, View)`，官方扩展点） | `dsh-client-ui-settings-general/lib/client.js:338`（渲染）/`:1017-1040`（导航投影）/`:1137-1140`（槽位声明）；`dsh-client-ui-settings-plugins/lib/client.js:203-212`（内置分区壳与 `settings.plugins.tab` 子槽）；notify-me `parts/settings.ts` |
| 10 | 出站 webhook | ✅ host 半 global fetch（Node 24），企微/飞书/钉钉适配 + 加签 + 超时重试（my-notify 实装） | my-notify `webhook/pusher.ts`、`webhook/adapters.ts` |
| 11 | 点击通知跳会话 | ✅ **直接 `sessions.open(id)` 在目标运行时不存在**（notify-me 的写法）；**`sessions.binding(id)?.session.open()` 存在**（`api-session-controller/client.js:3110` binding getter、`:3400` binding.session、`open()` 在 `:1857`；另有 `sessions.sessionOf(id)` 可选），需会话已被 retain（故为 best-effort） | v0.3 `lib/client.js`；`dsh-api-session-controller/lib/client.js` |
| 12 | token 计量 | ✅ `session/event`（assistant/message 的 usage 累加）——**仅 host 半可得** | my-notify `token-meter.ts` |
| 13 | 后端 toast | ❌ 不存在，属浏览器端 DOM 兜底（my-notify 已澄清） | — |
| 14 | 跨标签页去重 | ✅ 浏览器 Web Locks（my-notify 实装） | my-notify `parts/stream.ts` |
| 15 | `session/event` 的 `turn/end` | ✅ 存在且带 `reason.kind`。本运行时（0.2.0-rc.2）`dsh-session` 自产 kind 已见 `interrupted`/`forked`（`dsh-session` 未完整枚举其他 kind）；session-notify 在其运行时读到 `completed/aborted/blocked/error/max-tokens` 白名单逐类判定完成/出错/中止/阻塞/上限。**结论：这是"结果语义"的第一手信号，但 kind 取值集合随运行时版本漂移，实现需兼容降级（缺字段时回退 agent/status + agent/error 组合判定）** | `dsh-session/lib/index.js:791`（`reason:{kind}`）；session-notify `lib/index.js:459-522` |
| 16 | 官方统计投影 | ✅ `tokenUsage`（缓存命中率 cacheRead/(uncached+cacheRead+cacheWrite)）与 `sessionStats`（decodeTokens/decodeMs → TPS）可从 projRegistry 快照读取，与 dsh-web-ui 同口径；耗时/token 聚合在 host 事件层 | session-notify `core.js:189-299`、`index.js:472-479` |
| 17 | `uiSession.pendingInteractions` | ❌ 已在 0.2.0-rc.2 内化删除（notify-me 新宿主路径在此失效）；真相源即 `sessionStatus.{pendingInteraction}`——v0.3 从一开始就接对了源 | notify-me 报告（在 0.2.0-rc.2 逐包交叉验证） |
| 18 | `settings.section` 槽位 | ✅ **本机存在（0.2.0-rc.2）**——原记 ❌ 是查错包：声明方是 `dsh-client-ui-settings-general`（`{kind:"list", scope:"root"}`），而非 `dsh-client-ui-settings`（后者只提供底座与配置表单）。notify-me / turn-notify 的 `settings.section` 写法成立，**不是「旧宿主写法」** | `dsh-client-ui-settings-general/lib/client.js:1137-1140`（声明）/`:1017-1040`（导航）/`:338`（渲染）；`docs/research/notify-me-analysis.md:147-153`；`docs/research/turn-notify-analysis.md:45` |
| 19 | **宿主原生桌面通知** | ✅ host 半可 spawn 平台命令：darwin `osascript display notification`、linux `notify-send`、win32 `powershell` WinRT toast（turn-notify 七通道中的 host 通道）；浏览器在场（长轮询在途 + 2s 认可窗口）时宿主让位、离场补位 | turn-notify `src/core.mjs:505` hostNotifyWanted |
| 20 | 六类结果映射 | ✅ turn-notify 的 `REASON_KIND_TO_CATEGORY`（core.mjs:92-99）：completed→completed、error→error、**aborted→error**、interrupted→interrupted、**blocked→approval**、max-tokens→max-tokens、未知→不通知——与我们的双轨判定同构，可直接复用映射表 | turn-notify `src/core.mjs` |

**结论**：上一轮"浏览器半拿不到出错信号 → 不做"的架构判断已过时——host 半事件总线 + webServer 路由在 0.2.0-rc.2 上**全部公开展开**（更准确地说：webServer/settings/jobs 均为服务注入，`ctx.on` 事件对任何宿主插件开放订阅）。v0.4 起从纯浏览器插件升级为 **host 桥 + 浏览器双半**。

---

## 2. 四仓库对标矩阵

| 能力 | 来源仓库 | 参考实现机制 | 我方现状 | 归属 |
| --- | --- | --- | --- | --- |
| 需要你操作（审批/方案/提问）+ 通知 + 音效 | dsh-notify-me / my-notify / turn-notify | 浏览器 pendingInteraction；my-notify 用 host `approval/request` + `tools/pre-execute`(ask_user_question) | ✅ v0.3 已有（pendingInteraction） | M0 已交付 |
| 标题标记（🔔 需要你 · / ⏳ 闪烁） | notify-me / turn-notify | 浏览器 document.title 前缀 | ✅ v0.3 已有 | M0 |
| 未处理二次提醒（10 分钟补发） | turn-notify | 定时器 + 交互仍挂 | ✅ v0.3 已有 | M0 |
| 完成提醒 + 耗时小结 | notify-me/turn-notify/session-notify | v0.3 客户端计时；my-notify host 侧 `agent/status` idle 计时 + token | ✅ v0.3 已有（客户端时钟）；⬆ 升级为 host 侧 `agent/status` idle（含 token） | M1 |
| **出错 / 被中断 / 达到上限 提醒** | turn-notify / session-notify | host `session/event` turn/end `reason.kind`（completed/error/aborted/interrupted/blocked/max-tokens，turn-notify 映射表 `REASON_KIND_TO_CATEGORY`）+ `agent/error` / `agent/turn-stopping` / `agent/request-error` 兜底 + job `failed`/`killed` | ❌ 无（浏览器半拿不到） | **M1 新增** |
| 短回合静默（<5s 不打扰） | turn-notify | host `minTurnDurationMs`（默认 5000）过滤碎轮，仅 turn/end 类；ask/approval 即时送 | ❌ 无 | M1（配置项） |
| 出站 webhook（企微/飞书/钉钉/generic + 加签 + 模板 + 重试） | my-notify | host fetch + 适配器 + 持久化 webhook JSON | ❌ 无 | **M1 新增** |
| 远程触发接口（POST /api/trigger 注入通知） | my-notify | `webServer.register` 同源路由 + 信任围栏 + token 头 | ❌ 无 | **M1 新增** |
| SSE 通知推送（host→browser 统一帧） | my-notify | EventSource + 心跳 | ❌ 无（当前浏览器直接订阅 store） | M1 骨干 |
| 设置页（设置→消息通知） | notify-me / turn-notify / my-notify | slot `settings.section`（顶级分区）或 host Config schema | ❌ 无（console API + localStorage） | **M1 新增**；**2026-10-05 由 `settings.plugins.tab` 迁至 `settings.section`** |
| 静音时段（quiet hours，支持跨午夜） | my-notify | host 策略层拦截 | ❌ 无 | M1 |
| 免打扰/去重强化（服务端 dedupe + 跨标签页 Web Locks） | my-notify | 帧层 dedupe + Web Locks | ⚠️ v0.3 有单页面内去重/节流 | M1 |
| token/TPS/耗时统计与展示 | session-notify / my-notify | **当轮统计**（session-notify 口径：host 起停表计时 + assistant/message usage 聚合 token；缓存命中率走官方 `tokenUsage` 投影、TPS 走 `sessionStats` 投影，与 dsh-web-ui 同口径）；不落累计库，随通知/折叠行展示 | ❌ 无 | **M2**（v0.5，对齐"当轮统计，不建库"） |
| 子代理过滤（subagent 事件不打扰） | my-notify | 帧级 agentType 拦截 | ⚠️ v0.3 按会话过滤；子代理无帧 | M1 |
| Windows 原生推送 + 图片 | session-notify | 平台特定 | N/A（macOS 平台） | 不做/保留 |
| 多皮肤/声音切换 | turn-notify | 渠道配置 | ⚠️ 音效两型已内置 | M2 可选 |

> 注：四仓库均已逐文件级分析（子代理报告见 §附 证据清单），本节矩阵为其合订本。

---

## 3. 目标架构总览（双层：host 事件层 → 帧总线 → 策略 → 浏览器渠道）

```
┌──────────────────────────────────────── 浏览器半（用户可见） ──────────────────────────────────────────┐
│                                                                                                      │
│  渠道层   System Notification │ WebAudio chime │ document.title 标记 │ DOM toast(兜底) │ 跳会话        │
│              ▲                    ▲                  ▲                    ▲                            │
│  策略层   enabled / quietHours / dedupe(帧级+跨标签) / 节流 / currentQuiet / 合并 / 子代理过滤          │
│              ▲                                                                                        │
│  消费层   PharosEvent 帧（统一形状） ◀── EventSource(SSE) ◀─── fetch REST ◀─┐                          │
│              ▲                                                              │                          │
│  浏览器触发源 uiSession.status {running,pendingInteraction,completionUnread} │  设置页 slot             │
│              sessions（标题/跳转）                                            │  settings.section      │
└──────────────┼───────────────────────────────────────────────────────────────┼─────────────────────────┘
               ▲                                                               │
               │ 同源 HTTP（DSH webServer，无独立端口）                          │
               ▼                                                               ▼
┌───────────── host 半（信号丰富层） ───────────────────────────────────────────┐
│  帧总线    emitNotice(clone 后的 PharosEvent)                                  │
│  触发源    ctx.on: agent/status·agent/error·turn-stopping·request-error       │
│             tools/pre-execute·approval/request·session/event·workflow/*·jobs  │
│  路由      ctx.webServer.register(/pharos/api/*): trigger/config/webhooks/stat│
│  渠道      webhook pusher（wecom/feishu/dingtalk/generic）· SSE 广播           │
│  配置      webhooks JSON + patch config + metrics 计量（session/event usage）  │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 统一事件帧 `PharosEvent`（浏览器与 host、SSE 与 webhook 共用）

```ts
interface PharosEvent {
  id: string;                     // uuid
  kind: 'needs-you' | 'done' | 'error' | 'interrupted' | 'limit'
      | 'workflow' | 'job' | 'remote' | 'test';
  severity: 'info' | 'warn' | 'error';
  sessionId: string; sessionTitle: string;
  agentType: 'root' | 'subagent';
  note: string;                   // 渲染正文（含 durationMs / tokens 插值）
  toolName?: string; reason?: string;       // needs-you 上下文
  question?: string; questions?: string[];  // 提问内容
  failure?: { code?: string; message: string }; // error/limit 上下文
  ts: number;                     // 事件发生时刻（host 侧权威时钟）
  durationMs?: number; tokens?: number;      // 统计字段（host 计量）
  source: 'browser' | 'host' | 'remote';
  dedupeKey: string;              // kind:sessionId[:interaction-key]
}
```

### 3.2 触发源归一（谁产出什么 kind）

| 触发源（层） | 信号 | kind |
| --- | --- | --- |
| browser | `pendingInteraction` 出现（approval/plan-review/question） | needs-you |
| browser | `running` true→false / `completionUnread` 边沿（页面非前台） | done（客户端计时） |
| host | `session/event` 的 `turn/end`：`reason.kind` ∈ {aborted, blocked, error, max-tokens, …}（kind 集合随运行时漂移） | error / interrupted / limit |
| host | `session/event` 的 `turn/end`：`reason.kind`=completed（或缺失时按 `agent/status` idle 判定） | done（host 计时 + tokens） |
| host | `agent/status` → idle（根 agent） | done 兜底（host 计时 + tokens） |
| host | `agent/error` | error 兜底 |
| host | `agent/turn-stopping` | interrupted 兜底 |
| host | `agent/request-error`（failure.code 判定限流/配额） | limit 兜底 |
| host | `ctx.jobs.events` settled + status='failed'｜'killed' | error / interrupted（job 附注） |
| host | `workflow/agent-end` / `workflow/log`（级联事件） | workflow（M2 细粒度） |
| host | `approval/request`、`tools/pre-execute`(ask_user_question) | needs-you（host 路径，与 browser 路径互为冗余） |
| host | POST `/pharos/api/trigger`（同源 + apiToken） | remote |
| both | 测试按钮 | test |

> host 侧"结果语义"采用**主信号 + 兜底信号**双轨（session-notify 的兼容性做法）：优先 `session/event` turn/end 的 `reason.kind` 定类；字段缺失/版本差异时回退 `agent/status`(idle) + `agent/error` + `jobs` 组合判定，保证 0.2.0-rc.2 到更新的运行时行为一致。

### 3.3 策略层（v0.4 规则表）

- **全局**：`enabled` 主开关（关闭则全渠道静默）；`quietHours{enabled,start,end}`（策略层统一拦截，跨午夜支持）。
- **去重**：帧级 `dedupeKey + ts` 窗口（host 侧 dedupeMs=3000 防事件洪峰）；浏览器侧 2s 窗口 + Web Locks 跨标签页互斥。
- **节流**：done 同会话 `minIntervalMs`（默认 6s）；needs-you 同交互只提醒一次。
- **静默**：`currentQuiet`：needs-you 时若该会话是当前会话且文档在前台 → 只亮标题标记不弹窗（v0.3 行为保留）。
- **二次提醒**：needs-you 挂起 10 分钟后补发一次（`reAlertMs`），交互消失即撤销。
- **兜底**：Notification 权限 denied/不可用 → DOM toast；标题闪烁 ⏳ 6s（权限拒绝且未聚焦时）。
- **过滤**：subagent 事件默认不打扰（M1 起 host 帧带 agentType）。

### 3.4 渠道层（M1 起可配置路由：kind × 渠道）

| 渠道 | 载体 | 状态 |
| --- | --- | --- |
| system-notification | `new Notification`（浏览器半） | ✅ v0.3 |
| chime | WebAudio（done/attention 两型） | ✅ v0.3 |
| title-marker | document.title 前缀（🔔 / ⏳） | ✅ v0.3 |
| dom-toast | #dsh-pharos-toast-box（兜底） | 🔜 M1 |
| webhook | host fetch → wecom/feishu/dingtalk/generic | 🔜 M1 |
| sse | host → browser 事件流（骨干，也承载 remote/error 帧） | 🔜 M1 |
| host-notify | host spawn `osascript`/`notify-send`（浏览器离场补位） | 🔜 M1（可选，turn-notify 模式） |

---

## 4. 里程碑

### M0 — 已交付（v0.3.0）
浏览器半：需要你 + 完成 + 二次提醒 + 标题标记/闪烁 + 耗时小结 + 点击跳会话 + console 配置 API。零 peer、零依赖。

### M1 — host 桥（v0.4.0，本次雏形的落地目标）
1. **host 半实装**：`ctx.on` 订阅 `session/event`（turn/end reason.kind 主信号）、`agent/status`、`agent/error`、`agent/turn-stopping`、`agent/request-error`、`jobs settled`（双轨兜底）；构造 PharosEvent；SSE 广播 + webhook 推送双通道。
2. **webServer 路由**：`kind:'prefix', path:'/pharos/api'`，提供 `GET /stream`（SSE）、`POST /trigger`（远程触发 + `x-pharos-token` 校验 + loopback 信任围栏）、`GET/PUT /config`、`GET /webhooks`。
3. **设置页**：`ctx.get('slots',false)` + `slots.register({name:'settings.section', id:'pharos-notifications', order:30, label:'消息通知'}, PharosSettingsView)`（顶级「设置 → 消息通知」分区）；表单经 `/config` GET/PUT 持久化（cordis.patch.yml 或独立 JSON），浏览器偏好仍可走 localStorage。
   - **依赖决策点**：slot 视图需 react（peer 声明 `react ^18 || ^19`，与运行时一致）；若希望保持零 peer，可先上"配置页只读 + 控制台编辑"降级档，M2 再上表单。**倾向：直接上 slot tab（react peer 门在本运行时能过）。**
4. **错误/中断/限流提醒**：error（红/重音）、interrupted、limit 各配文案与音型；与 needs-you/done 共用策略与去重。
5. **子代理过滤 + quiet hours + 跨标签页去重**。
6. **回归**：v0.3 全部能力保留（浏览器直接订阅仍为首选路径，SSE 作为 host 事件补充通道，二者在策略层汇合）。

### M2 — 统计与定制（v0.5.0，按需）

**A 组（统计）已落地（v0.5.0，2026-10-03）**，落地细节见 [m2-plan.md](m2-plan.md)：
- **当轮统计投影**（`lib/host/stats.js`）：`turn/start` 存基线 snapshot → `turn/end` 做差，得到
  当轮缓存命中率（`cacheReadΔ/(uncachedΔ+cacheReadΔ+cacheWriteΔ)`）、TPS（`decodeTokensΔ/decodeMsΔ`）、
  tokens（投影 delta 优先、`turnState` 兜底）。命中率/TPS 分母 0 → null（不显示「0%」）。
- **帧扩展**：`PharosEvent` 增 `cacheHitRate`/`tps` 可选字段；`noteFor` 支持统计插值。
- **浏览器展示**：`installApi().stats()` + `pharos:stats` CustomEvent + `localStorage['dshPharos.stats']` 兜底；
  设置页「当轮统计」卡片 + Debug 统计栏；`test(kind, stats)` 扩展。
- **降级**：`sessionProjections` 不可用 / 基线缺失 → 静默降级 v0.4（仅耗时+tokens）。

**B 组（webhook 模板定制）**：`renderTemplate` 已在 M1 落地（9 变量），B-1 剩 `{cache}{tps}` 两 token
（`{sessionUrl}` 已核实无会话路由、删除），B-2「手动重放」拆出单独评估——**均未在本轮落地**。

**C 组（不做）**：workflow 级通知细分、累计统计库、错误严重度分级音效——延后。

---

## 5. 目标仓库结构（v0.4 落地后的布局）

```
dsh-pharos/
  package.json            # dsh.bundle.patch + dsh.client；exports：./lib/host.js、./client
  cordis.patch.yml
  lib/host.js             # host 半（M1：事件订阅 + 帧总线 + 路由 + webhook + 配置持久化）
  lib/host/               # （若拆分） events.js / frames.js / routes.js / webhook.js / store.js
  lib/client.js           # browser 半（v0.3 511 行演进：策略 + 渠道 + 设置 slot + SSE 消费）
  test/smoke.mjs          # 状态机冒烟（现有 27 断言，随帧/策略扩展）
  docs/functional-architecture.md   # 本文档（随实现演进修订）
```

---

## 6. 明确不做（范围外）

- **后端 toast**：本运行时不存在该能力（浏览器 DOM toast 才是兜底）。
- **独立端口 HTTP 服务**：一律走 `webServer.register` 同源挂载，安全边界沿用 DSH 的 loopback/trusted-hosts 围栏。
- **Windows 原生推送**：目标平台为 macOS；渠道层留接口，不做平台特定实现。
- **侵入 host 核心**：不改 asar、不加原生产物（dshmarket 也仅依赖"恰好可注入"的服务，我们同样如此）。
- **peer 门禁之外的包**：不引入 dsh-client-locale 这类与运行时版本强耦合的 peer（notify-me 的教训）。

---

## 7. 风险与待验证项（实施时逐项打勾）

1. [ ] `webServer.register` 对非官方插件的可用性已由 dshmarket/my-notify 实证，但需过目标运行时 preflight（无 peer 冲突即过）。
2. [x] **已定案（2026-10-05）**：`slots.register` 的 `id` **无需**等于插件条目 id —— 实测各插件均用自由 id（dshmarket `market`、官方 inventory `all`、turn-notify `turn-notify`、notify-me `dsh-notify-me`）。order 为整数升序；**同值退化为注册先后（`Array.sort` 稳定性），契约未规定 tie-break**。本插件改用顶级 `settings.section`，id `pharos-notifications`、order 30。（session-notify 用 keyed slot `settings.plugin.item`，属更早宿主线。）
3. [ ] react peer 的引入对「零 peer」承诺的影响面（可选：设置页视图用 slot 但内部纯 DOM render 规避 react import？需实测 runner 的 slot 契约）。session-notify 是 3695 行手写单体 bundle 实现设置面板（无打包器），可维护性差——我们的 browser 半也应避免单体膨胀，M1 起按 §5 拆宿主目录。
4. [ ] `reason.kind` 取值集合随运行时漂移（0.2.0-rc.2 仅确认 interrupted/forked）：host 侧必须做"主信号 + 兜底信号"双轨判定（§3.2），并对未知 kind 静默降级为 done。
5. [ ] `agent/status` idle 与浏览器 `running→false` 的先后/重复（帧级去重覆盖）。
6. [ ] SSE 在桌面 host 上的持久性与断线重连（my-notify 已用，待实测集成）。
7. [ ] 远程触发的信任围栏细节（`sec-fetch-site`、origin、`x-pharos-token`）。
8. [ ] Web Locks 在 Electron 单窗口下的实际收益（多标签页场景较少，保留但标注为防御性）。
9. [ ] **cordis 门控坑（notify-me 两度踩坑，必抄进兼容设计）**：① `dsh.client.inject` 是硬门——列出运行时已不存在的包会让条目永久 pending 且 web boot 审计失败（M1 若 inject `remote`/`slots`，需逐一核对目标运行时清单）；② cordis 插件自身 `inject` 也是硬门，属性读未声明服务名会抛 `cannot get property X without inject`——host 半对 `webServer`/`settings` 用 `ctx.inject`，对可选服务用 `ctx.get(name, false)` 惰性查（v0.3 的 uiSession 已是此写法）。
10. [x] **已定案（2026-10-05）**：**两个槽在 0.2.0-rc.2 都存在**。原记 `settings.plugins.tab` ✅ / `settings.section` ❌（「不存在」「notify-me 旧宿主写法」）系查错包所致 —— 声明方是 `dsh-client-ui-settings-general:1137-1140`，不是 `dsh-client-ui-settings`。本插件采用 `settings.section`（顶级分区）；`slots` 仍按行 9 的门控规则声明依赖。
11. [ ] **settings 服务双形态**：turn-notify 用 legacy `settings.register(ns, schema)`（0.1.7+ 已更替为 Config 派生）；0.2.0-rc.2 用 `settings.configure`/Config 模型（dshmarket 已实证）。pharos 设置页主走 browser slot，**不依赖 host settings 写法**，规避该风险。
12. [ ] **短回合语义**：minTurnDurationMs 过滤只在 turn/end 类生效，ask/approval 即时送达（turn-notify 语义）；补发/去重规则需与之协同。
13. [ ] host-notify（osascript）仅在浏览器离场时补位（presence 让位窗口 ~2s），避免双弹（turn-notify 语义）。

---

## 附：证据清单（本会话运行时核查）

- browser sessionStatus 三字段：`@deepseek-ai/dsh-client-ui-session/lib/client.js`
- host 事件总览：`@deepseek-ai/*/lib/index.js` 的 `ctx.on("…")` 全量枚举
- `agent/error|turn-stopping|request-error` 载荷：`@deepseek-ai/dsh-agent-loop/lib/index.js`
- `session/event` turn/end `reason.kind`：`@deepseek-ai/dsh-session/lib/index.js`（791/806/905/932）
- job 事件与 status 枚举：`@deepseek-ai/dsh-tool-jobs/lib/index.js`
- `webServer.register` 路由：`dshmarket/lib/routes.js`、dsh-my-notify `src/routes.ts`
- 设置页双入口：`@deepseek-ai/dsh-client-ui-settings/lib/index.js`、`dsh-client-ui-settings-plugins/lib/client.js`
- 四仓库实现细节：[docs/research/notify-me-analysis.md](research/notify-me-analysis.md) + [docs/research/turn-notify-analysis.md](research/turn-notify-analysis.md) + [docs/research/my-notify-analysis.md](research/my-notify-analysis.md) + [docs/research/session-notify-analysis.md](research/session-notify-analysis.md)（子代理逐文件报告整理）