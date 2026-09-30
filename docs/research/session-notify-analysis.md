# dsh-session-notify 代码级分析报告

> 分析对象：https://github.com/TelosmaYLX/dsh-session-notify
> 默认分支：`master`（`main` 不存在，raw 拉包 404）；浅克隆 commit `b25244c`，tag `v0.1.22`（2026-09-21）
> 包名：`@telosmaylx/dsh-session-notify` v0.1.22（MIT，ESM，私有=false）
> 源码量：`lib/index.js` 721 行（宿主）、`lib/core.js` 470 行（纯逻辑）、`lib/client.js` 3695 行/236KB（浏览器）；另附 `scripts/`（selftest、probe-* 探针、verify-notice）、`cordis.patch.yml`、5 语言 README

---

## 0. 清单速览（package.json + cordis.patch.yml）

- **exports**：`"." → lib/index.js`（宿主）、`"./client" → lib/client.js`、`"./core" → lib/core.js`、`"./package.json"`。
- **dsh 双 manifest**（`package.json` 的 `dsh` 字段）：
  - `dsh.bundle.patch → ./cordis.patch.yml`：`dsh plugin add` 自动挂载的凭证。`cordis.patch.yml` 本体只有一条 `insert`：`{id: dsh-session-notify, name: '@telosmaylx/dsh-session-notify'}`（无 `config`，全部走默认值）。
  - `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"], platform: "web"`：声明 Web 客户端注入，与 client.js 的 `window.__ModuleLoader__.load({id, factory})` bundle 契约对应。
- **peerDependencies**：`cordis >=4.0.0-rc <5`；**engines**：`node >=22`。
- **零运行时依赖**：宿主侧零裸 import，`schemastery`/`zod` 用 `createRequire` 锚定 `~/.dsh/profiles/node_modules` 取宿主同源实例（`lib/index.js:61`）。

---

## 1. 通知类型与各自信号来源

插件有 **3 条推送通道**（README 所谓"三通道"）：
1. **会话内系统消息**：host 把一条 `user/message`（`source: {kind:'plugin', plugin:'dsh-session-notify', form:'notice'}`）追加进会话日志，随 JSONL 落盘、Web UI 渲染为可折叠系统提示行。
2. **浏览器系统通知**：`new Notification(...)`（Web Notification API）。
3. **页内 toast**：右下角浮动卡片（`showToast`，≤3 条、10s 自动消失、点击关闭）。

六类提醒及其信号源（**host 事件 + client 快照双引擎**）：

| 提醒 | host 侧信号（lib/index.js） | client 侧信号（lib/client.js） | 备注 |
|---|---|---|---|
| 完成/出错/中止/阻塞/上限 | `session/event` 火线上的 **`turn/end`**（`event.data.reason.kind ∈ reasons` 白名单，`index.js:459-522`） | 会话列表快照 **`running: true→false` 边沿**（`onSnapshot`，`client.js:243-247`） | 白名单默认 `[completed, aborted, blocked, error, max-tokens]`；`interrupted` 默认不提醒 |
| 提问（"AI 需要你"） | `tool/call` 且 `name === 'ask_user_question'` → 写提问投影（`index.js:373-385`）；`tool/result`/`turn/end` 清空 | 每会话轮询三选一：宿主提问投影 → harness 原生 `pendingInteraction === 'question'|'plan-review'` 兜底（`client.js:270-305`） | 独立通道，不写会话日志；`toolCallId` 空串时回退 `turn:step` id |
| 审批 | `approval/asked` → 写审批投影；`approval/decided`/`turn/end` 清空（`index.js:412-430`） | 三路信号兜底：`uiSession.pendingInteractions`（`ctx.get('uiSession')`）→ 宿主审批投影 → 快照 `pendingInteraction === 'approval'`（`client.js:315-326`） | 同一审批只推一次；文案只含工具名+原因，不含命令参数 |

关键机制：
- **host 侧是"原因驱动"**（`turn/end reason.kind` 白名单）；**client 侧是"状态边沿驱动"**（running 位变化），两边互为冗余/兜底，与官方 sidebar 提醒同策略（首次观测只记基线 `primed` 标志，`client.js:212,242`）。"出错/需要你"这类语义**都由 host 事件定名**，client 只做边沿触发，正文再从投影/事件窗口取。
- **不重放**：只处理实时事件；resume/replay 不补发；子代理会话（`header.origin==='subagent'` 或 `delegationDepth>0`，`core.js:153-156`）默认跳过。

---

## 2. Windows 原生通知怎么做的（与 macOS 的差异）

**不是 Electron Notification，也没有任何平台特定代码**——走的是浏览器标准 **Web Notification API**：

- 发送点：`client.js:723-766` `notifyUser()`：`new Notification(title, {body, tag: 'dsh-session-notify:'+Date.now(), icon, image, silent:false})`；每次完成事件用**独立 tag**（互不替换、不折叠）；点击 `window.focus()`+`close()`。
- 权限处理：`default` → 首次完成事件时 `Notification.requestPermission()`（`client.js:746-756`，代码仍保留自动请求尝试，Chromium 非手势下无效，真正的入口是设置面板"请求授权"按钮，`client.js:2440-2441`，用户手势内）；`denied` → 仅 toast；非安全上下文（`http://IP`）`Notification` 不存在 → `typeof Notification === 'undefined'` 兜底 toast。
- **Windows 与 macOS 无代码差异**：通知由浏览器接管后交给各平台通知中心（Windows 通知中心 Toast / macOS 通知中心），插件不感知平台。README 记录的差异全部是浏览器行为：
  - Edge/Chrome 对"不熟悉"站点自动屏蔽通知（需地址栏权限图标 → 网站设置 → 允许）；
  - QQ 浏览器等国产 Chromium 壳把 `Notification` 固定渲染为页内横幅（不经 Windows 通知中心），故提供 `仅页内提示`（toast-only，不再调用 Notification）模式；
  - Firefox 聚焦时显示为页内横幅、失焦才进系统通知中心。
- 通道分流（0.1.21+）：按 `isBlurred()`（`document.visibilityState==='hidden' || !document.hasFocus()`）选择「失焦时」「聚焦时」两个独立模式：`off/dual/system/toast`（`client.js:391-411,1097-1100`）。

---

## 3. 指标统计

| 指标 | 口径 | 数据来源（哪层拿到） | 存储 | 展示 |
|---|---|---|---|---|
| **耗时 duration** | `turn/start` 起表 → `turn/end` 结算（`core.js:162-186` createTurnTracker，内存 Map key=`sessionId:turn`） | host：`session/event` 事件（`index.js:453-454,461`） | 不落库；仅当轮内存 | 通知正文/标题 `{duration}`；会话折叠行 |
| **token 用量 usage** | 每轮 `assistant/message` 的 `usage` 逐步累加（`index.js:456-457`），输入 = 未缓存+缓存读+缓存写（`core.js:249-258`）；合并字段 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens`（`core.js:189-199`） | host：`assistant/message` 事件 | 不落库；仅当轮内存；**文本随系统消息进 JSONL** | 通知 `{usage}` |
| **缓存命中率 cache** | 官方口径：`cacheRead / (uncachedInput + cacheRead + cacheWrite)`（`core.js:282-288` officialCacheRate，与 dsh-web-ui 状态栏同源）；本地回退估算 `summarizeCache`（`core.js:265-274`） | host：`projRegistry.snapshot(session).values.tokenUsage`（**官方投影**，`index.js:472-479`） | 官方投影由宿主维护（插件无副本） | 仅自定义模板 `{cache}` |
| **生成速度 tps** | 官方口径：`decodeTokens ÷ decodeMs`（`core.js:296-299` officialTps）；本地回退 `outputTokens/秒`（`core.js:307-311`） | host：投影 `sessionStats` | 同上 | 仅自定义模板 `{tps}` |
| **次数统计** | **不统计** | — | — | 无统计界面；无仪表盘 |

结论：
- 统计的是**当轮**的耗时/token/缓存命中/TPS，不是一个历史累计指标。
- token/耗时在 **host 侧 session/event 层**聚合（tracker 纯内存）；cache/TPS 数据宿主直接**从官方 `tokenUsage`/`sessionStats` 会话投影快照读取**（同 dsh-web-ui 状态栏口径），不可用才退回本地估算。
- **没有独立"指标展示界面"**：数据只在通知/系统消息渲染时被消费。落盘只有两条路——(a) 渲染好的系统消息文本进会话 JSONL（永久保留，回放可见）；(b) `session-complete-notify` 投影单元存"最近一次"（`{kind,text,title,tags}`，stateVersion=3，"最近一条通知正文"，后台会话同享）。
- 投影快照读取失败/数据未就绪时 cache/tps 为空串（标签插了也不显示）。

---

## 4. host 半 vs browser 半分工与通信

**分工**：
- **host（lib/index.js）**：`ctx.on('session/event')` 全量事件订阅（turn 计时/用量累计/turn-end 通知组装/无事件日志）、`ctx.settings.register` 注册设置命名空间（失败 8 次退避重试，`index.js:274-311`）、`ctx.inject(['sessionProjections'])` 注册 **3 个投影单元**（完成通知 / 提问 / 审批，`index.js:321-439`）、`session.append('user/message')` 写系统消息。宿主干所有文案工作（5 语言、模板渲染、标题渲染）。
- **client（lib/client.js）**：会话列表订阅观测 running 边沿、轮询/读取投影、`Notification`+toast 实际弹出、音频播放（Web Audio GainNode）、以及整个**设置面板 UI**（`settings.plugin.item` keyed slot，React）。客户端**零文案逻辑**——标题/正文全部用宿主渲染好的投影值，老宿主缺失时才本地拼兜底文案。

**通信方式**（无任何 IPC/RPC，纯数据面）：
1. **会话日志/JSONL**：host `session.append` → 客户端经 `ctx.sessions.binding(id).session.getSnapshot().nodes` 的事件窗口读 `kind==='context' && form==='notice'` 节点（`client.js:536-558`，落盘后立即可用）。
2. **官方会话投影（sessionProjections 服务）**：host 端 `projectionDef()`（`index.js:560-572`）同时写两代契约字段（旧：`schema`+`view`；新：`stateSchema`+`wire{viewSchema,view}`）注册单元；值经宿主推到客户端会话列表快照的 `s.projectionValues[key]`（`client.js:274,321,515`）。这是**后台会话推送正文的主力通道**（key=`session-complete-notify` 每会话一份）。
3. **settingsScope（设置文档）**：client 端 `ctx.settingsScope.bind({namespace:'session-complete-notify'})` 读（`getSnapshot()`）写（`scope.set(key, value)`）；host 端 `scope.watch` 实时同步内存 `settings`（`index.js:279-282`）。
4. 完成的正文获取优先级：**投影 → 事件窗口 notice → 降级**（`client.js:490-558`；降级 = "详情见会话内系统消息"+工作区 cwd 末段；轮询最长 6s、400ms 间隔）。

**数据 README 未写明的关键设计**：
- append 重入规避：`session/event` 观察者运行在 `turn/end` 那次 append 的发布边界内，同步 append 会被拒（"cannot reenter"），因此 `queueMicrotask` 延迟追加（`index.js:512-520`），卸载时用 `disposed` 标志抑制已调度的微任务（`index.js:533-536`）。
- `{image}{icon}{audio}` 是"媒体开关标签"：host 渲染时剥除不进日志；`mediaTagsOf` 把该原因生效模板里实际插了哪些标签随投影 `tags` 下发，client 据此决定附不附媒体/播不播提示音（`index.js:499,683-690`；`client.js:380-383`；老宿主无 tags 视为三项皆插 `DEFAULT_TAGS`）。
- 提问/审批投影是**瞬时状态**：client 端 `pushedQuestions`/`pushedApprovals`（按 sessionId）去重，信号消失即清除可再弹（`client.js:280-283,331-334`）；置为 `不通知(off)` 的时机**不记去重**（切回另一时机还会提醒），完成属边沿事件静默即不补发（`client.js:286-287,336-338,367-371`）。

---

## 5. 设置/配置：UI、配置项、存储位置

**UI**：有。DSH Web **设置 → 插件 → 会话完成提醒**面板（`client.js:1110-1121` `ctx.slots.inject('settings.plugin.item')`，key=`session-complete-notify`，order=40；React 函数组件 `makeSettingsCard`，样式逐值复刻原生插件卡片）。面板包含：预设（内置"默认"+4 风格预设+自定义预设库）、5 语言、失焦/聚焦通道下拉、音频（音量滑块+最长时长）、通知大图/图标上传（按原因+全局）、标题（全局+按原因）、内容模板（Chip 编辑器）、跳过子代理复选框、通知权限状态区、保存/重置/测试发送。

**配置项与存储**（两层）：
1. **设置文档（settings 命名空间，主配置）**：host 用 `ctx.settings.register('session-complete-notify', schema, {applies:'live'})` 注册（schema 由 `@deepseek-ai/schemastery` 构造，`index.js:200-273`）；持久化在 DSH profile 的 **settings 文档（YAML）**——client 注释明确 `scope.set` 一次 = "取文件锁 + 全量 YAML 解析/渲染/落盘"（`client.js:2670-2673`，该服务由 `@deepseek-ai/dsh-settings` 提供）。字段：`language, templates{6}, titleTemplate, titleTemplates{6}, includeDuration, includeUsage, skipSubagents, pushMode(旧), pushModeBlur, pushModeFocus, imageUrl, iconUrl, imagePreviewUrl, iconPreviewUrl, images{6}, icons{6}, imagePreviews{6}, iconPreviews{6}, audios{6}, volume(0~1，默认0.6), maxDuration(秒，默认0=不限)`（`index.js:79-115` DEFAULT_SETTINGS；保存只写变化字段，序列写，`client.js:2674-2706`）。
2. **自定义预设**：浏览器 `localStorage`，key=`dsh-scn-custom-presets`（`client.js:1464-1473`）；卸载/重装后仍在。
3. **宿主静态 config**（`cordis.patch.yml` INSERT 的 `config`，本仓库发的 patch 为空，默认值即 `reasons:[completed,aborted,blocked,error,max-tokens]`、`skipSubagents:true`、`includeDuration/Usage:true`，`index.js:64-76`）。

**注意事项**：保存后 README 要求刷新页面才生效——host 侧 watcher 是实时的（`index.js:279-282`），但 client 侧设置卡片与通知通道在页面加载时装配；`skipSubagents` 面板值与宿主 config 任一为真即跳过。媒体（图片/图标/音频）以 **data URI** 存进设置文档（图片 canvas 压缩：大图 512 宽 16:9 中心裁切、图标 128×128、另存等比 1024 预览版；音频原样读入不压缩不截断，>512KB 先确认）。

---

## 6. 触发源逐条清单（文件 + API）

**host 平面（lib/index.js）**
- `package.json` → `dsh.bundle.patch` / `dsh.client.inject`（`@deepseek-ai/dsh-client-runtime`，平台 web）——安装挂载触发点。
- `cordis.patch.yml` → INSERT `{id,name}` 进 profile cordis 装配。
- `ctx.on('session/event')`（L445）：`turn/start`（L453）、`assistant/message`（L456）、`turn/end`（L459，白名单+子代理过滤+投影快照+buildNotice+queueMicrotask append）、`approval/asked`/`approval/decided`（L447-452，仅日志，实际处理在投影 apply）。
- `ctx.settings.register(SETTINGS_NS, schema)`（L277）+ `scope.watch`（L279）。
- `ctx.inject(['sessionProjections'])`（L324）+ `ctx.root.get('sessionProjections')` 回退注入实例（L330）→ `register(projectionDef)` × 3（L334, L368, L407，zod schema）。
- `HUB_REQUIRE('@deepseek-ai/schemastery')` / `('zod')`（L201, L322，createRequire 锚 `~/.dsh/profiles/node_modules`）。
- `session.append('user/message', …)`（L651，`{surfaceOp:'append'}`）；`queueMicrotask`（L517）；`ctx.effect()` 重试定时器（L301）。
- 诊断日志 `~/.dsh/session-complete-notify.log`（L696，>512KB 截断）。

**client 平面（lib/client.js）**
- `window.__ModuleLoader__.load({id, factory})`（L14）——官方 client bundle 加载契约。
- `exports.inject = ['sessions','slots','settingsScope']`（L26）。
- `ctx.sessions.list`：`getSnapshot()`+`subscribe(onSnapshot)`（L229, L568）→ running 边沿/`projectionValues`/`pendingInteraction`/`origin`/`displayTitle`/`cwd`。
- `ctx.sessions.binding(id).session.getSnapshot()`（L538）→ 事件窗口 notice 节点（完成正文第 2 优先级）。
- `ctx.get('uiSession')`（L576）→ `pendingInteractions.subscribe`（审批信号 1，可选服务）。
- `ctx.settingsScope.bind({namespace})`（L207, L1131）→ 设置读（`getSnapshot`/`get`）写（`set`）。
- `ctx.slots.inject('settings.plugin.item')` + `ctx.slots.register({name,id,key,order:40}, Card)`（L1114-1115）。
- `ctx.effect(() => cleanup)`（L700）卸载清理（订阅/轮询定时器/调试钩子/toast 容器/AudioContext 与解码缓存）。
- 浏览器 API：`Notification`/`requestPermission`（L731-762, L2440）、`AudioContext/GainNode`+回退 `Audio` 元素（L856-1025）、`window.localStorage`（L1464+）、`FileReader`+`canvas.toDataURL`（L2789-2840）、`document.visibilityState/hasFocus`（L392-398）。
- 调试钩子：`window.__dsch_notify_debug`：`readNotice(id)`/`snapshotDebug(id)`/`alertAudio(action,src,volume,maxSeconds)`/`approvalState()`（L591-659）。

**纯逻辑层（lib/core.js，零依赖，被 host/client 复用/对照）**
- `createTurnTracker`（L162）、`buildNotice`（L356）、`renderTitle`（L49）、`buildQuestionBody`（L322）、`renderTemplate`（L431）、`officialCacheRate`（L282）、`officialTps`（L296）、`formatDuration`（L208）、`summarizeUsage`（L249）、`isSubagentSession`（L153）。
- `scripts/selftest.mjs`：宿主 schema/sanitize、core 纯逻辑、client 纯逻辑+渲染冒烟、音频播放链路、README×5 一致性断言（发布前必跑）。

---

## 7. 版本兼容声明（显式 + 代码内）

**显式声明**：
- `peerDependencies: cordis >=4.0.0-rc <5`；`engines.node >=22`。
- 部署要求：DSH **Web profile**；官方 base bundle 默认含 `@deepseek-ai/dsh-settings`（设置命名空间）与会话投影。
- 浏览器：支持 Web Notification 则有系统通知；不支持/拒绝/被静默由 toast 兜底；`http://IP`（非安全上下文）无 Notification。

**代码内逐级兼容（大量针对"老宿主"的分支）**：
1. **投影注册双契约**（`index.js:560-572`）：`schema`+`view` 给旧宿主（dsh-session-projection 0.1.0-rc），`stateSchema`+`wire{viewSchema,view}` 给新宿主（0.1.1+，缺 wire 的单元是 host-only、值到不了客户端）；只写新契约会让旧宿主在 restore/checkpoint 走 `undefined.parse` 崩溃（0.1.19 修复的回归）。
2. **投影注册目标双轨**：`ctx.root.get('sessionProjections')` 优先，回退注入实例（`index.js:330`）——只注册进注入实例时客户端可能读不到，推送正文走降级路径（尽力而为）。
3. **提问三条腿**：投影（含 `title`/`body` 字段，0.1.17+；老宿主缺 title/body 时客户端本地拼接兜底，`client.js:291-294`）→ `pendingInteraction==='question'` harness 原生标记（0.1.18 加，修 dsh 0.1.2 投影不达用户端）→ 无。
4. **审批三信号**：`uiSession.pendingInteractions`（部分宿主提供）→ 审批投影（0.1.20+）→ 快照 `pendingInteraction==='approval'`；`uiSession` 用 `ctx.get` 可选查找而非 `inject`（硬依赖会导致整个 client fiber 永久 park，`client.js:22-26`）。
5. **旧字段迁移**：`pushModeBlur/pushModeFocus` 未设置时沿用旧 `pushMode`（`legacyModeOf`，`client.js:1092-1100`）；投影旧版字符串值兼容（`client.js:517`）；老宿主缺 `tags` → `DEFAULT_TAGS` 三项皆插（`client.js:1041-1043`）；`{label}` 占位符已废弃但渲染/保存时兼容剥除；`ctx.effect` 缺失（极老环境）回退裸 `setTimeout` + ctx 已拆除兜底捕获（`index.js:298-311`）。
6. 客户端注入面：`exports.inject=['sessions','slots','settingsScope']` 全为官方动态客户端服务；`window.__ModuleLoader__` 由 `@deepseek-ai/dsh-client-runtime` 提供。

---

## 8. 其他要点

- **无自我循环**：插件写入 `user/message`（source.kind='plugin'），自身只监听 `turn/*` 等事件类型，不相交（`index.js:12-15`）；投影 apply 只匹配 `source.plugin === 'dsh-session-notify'` 的 user/message（`index.js:345-346`）。
- **零构建**：`scripts/build.sh` 只是 `node --check` 语法校验；无打包器，client bundle 直接以 `__ModuleLoader__` 契约交付。
- **隐私**：审批文案绝不包含命令参数；`{error}` 单行化截断（正文 80/默认 40 字符、summary 120 字符）；提问正文在非提问原因模板中会替换为空串防字面量泄漏。
- **调试**：host 日志 `~/.dsh/session-complete-notify.log`；client console `[dsh-session-notify-client]`；`window.__dsch_notify_debug` 4 个探针。
- **已知细微矛盾**：README（0.1.6 起）声明"不再自动请求通知权限"，但 `notifyUser` 在 `permission==='default'` 且本页未请求过时仍会调用一次 `Notification.requestPermission()`（`client.js:746-756`）——Chromium 非手势下此调用无效（resolve 回 default），实际入口仍是设置面板按钮；可视为尽力而为的残留逻辑。

---

## 附：一句话总结

这是典型的**"宿主管文案 + 浏览器管呈现"**双平面插件：无平台代码，完全依赖 Web Notification + toast；host 在 `session/event`（turn/end、tool/call、approval/asked）上组装多语言通知并写入投影+系统消息，client 以会话列表 running 边沿和投影轮询为双引擎做"边沿+瞬时状态"推送；指标（耗时/token/缓存命中/TPS）只在通知渲染时消费，不落统计库、无仪表盘；所有持久化状态 = 设置文档（profile YAML）+ localStorage 预设 + 会话 JSONL。