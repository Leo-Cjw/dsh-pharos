# Changelog

本文件记录 dsh-pharos 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.6.3] — 2026-10-09

patch 版：修「点击系统通知只把 DSH 拉到前台、不跳到该会话页」。此前该能力从 v0.3 起就从未真正生效。

### ~~根因二：Electron 里 `Notification` 不是 Web API 对象~~（**该结论已被真机数据推翻，勿信**）

> **撤回说明**：本节结论**错误**，保留仅为记录教训。真机 `debug().deliverLog` 显示
> `hasOnclick: true, hasOn: false` —— 渲染进程的 `Notification` **没有** `on`/`show`，
> 即**标准 Web Notifications API**，`onclick` 是正确且唯一的写法。
> 渲染进程配置也印证：`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`
> （app.asar `lib/main.js` 的 webPreferences）。错因：我拿**主进程**（Node 侧）的用法
> `new Notification({…}).once("click").show()` 去推断**渲染进程**，两者是完全不同的类。
>
> `on("click")` / `show()` 的能力探测**保留在代码里**（无害，且宿主若换形态仍可用），
> 但它们**不是**本次修复的原因。真正原因是下节「根因一」。

### 排查过程中确认的一个附带缺陷：同一次完成弹两条通知

真机 `deliverLog` 实测两条 `done` 投递仅相差 ~118ms。原因：`completionUnread` 边沿那条路径
（`lib/client.js` 的 `tick()`）**直连 `notifyDone()`，绕过 `maybeNotifyDone()` 的
`minIntervalMs` 节流**，于是与 SSE done 帧各弹一次。已改为统一走 `maybeNotifyDone`，
双源共用会话级节流 + `lastDoneAt`，同一次完成只剩一条。

### 根因一：导航 API 语义用错

- **点击通知/页内 toast 现在会真正切到对应会话**。
  - 旧实现调 `sessions.binding(id)?.session.open()`，
    但 `session.open()` 不是「切换会话」，只是「首次打开该会话的事件流 + 拉历史尾页」
    （`doOpen()` → `new SessionEventStream(...)`）；而且 `binding(id)` = `scopes.get(id)?.binding`，
    `scopes` 仅在 `retain()` 时 materialize —— **未 retain 的后台会话返回 `undefined`**。
    两者叠加，导致点来自非当前会话的通知时必然空转；外面那层 `try {} catch {}` 把症状彻底掩盖了。
  - **改走 `uiWorkspace.openSession(id)`**（`replaceMain(target, signal, "reveal")`：
    retain mainView + `selection.set({sessionId})` + `layout.selectPanel(null)`），这才是宿主的
    正规导航入口，官方插件同款调用见 dsh-client-ui-chat。
  - 保留 `binding().session.open()` 作为**老宿主兜底**（行为退化为 v0.6.2，不会更差）。
  - **前置闸门对齐官方 `sessionLinkState`**（`dsh-client-ui-schedule/.../session-link.js`）：
    `workspaces.state==='error'` / `sessions.phase==='pending'` / `workspaces.phase==='pending'` /
    `archivedSessionIds` 命中 / **不在 `sessions.ids`** —— 任一命中即不跳。投影不可读（服务缺失）
    同样不跳：宁可漏跳，也不冒险跳进归档。成员判定刻意用 `ids` 而非 `byId` —— 官方注释写明
    byId 另含 live Client generation 的本地兜底行（byId ⊋ ids），宿主列表已丢弃的会话在
    byId 里仍可能有行。workflow 帧的 `sessionId` 是 runId，同样落在这里被拦下。
- **所有 kind 的系统通知都跳会话**。此前只有「需要你」跳，「回复完成/出错/上限」等点开只聚焦窗口
  ——与页内 toast（所有 kind 都跳）行为不一致。
- `uiWorkspace` / `workspaces` **不写进** `dsh.client.inject`（inject 是硬门，宿主缺包会直接 pending
  并触发 web boot 审计失败，notify-me 1.1.5 即因此哑火），改为点击时惰性解析，且
  **strict 优先 + 仅调用成功后回填缓存**。
  - ⚠️ 这里修正了 0.6.3 初版的一处错误推理：cordis `ctx.get` 的 `strict` **与 inject 声明无关**，
    只过滤提供方 fiber 是否 ACTIVE（`_getImpl`：`if (strict && impl.fiber.state !== 2) return`）。
    因此 `strict=false` 会把**已注册但尚未 ACTIVE** 的半初始化实例一起端上来；若在解析阶段就把它
    缓存住，此后每次点击都复用坏实例、抛错被吞 → **永久**退回兜底，正好废掉本次修复。
    服务在 apply/effect 里 provide、state 置 ACTIVE 在其之后的 `_updateState()`，二者之间存在窗口。
- **新增跳转判定轨迹 `debug().navLog` / `debug().navService`**。「点了通知没跳」是本功能**唯一无法自证成败**的失败模式 —— 失败即静默，用户看不到任何提示。本次排查中我们先后误判了三次（先怪 API 缺失、再怪自己插入的诊断代码、再怀疑 done 路径被单独限制），根源都是手里没有可观测数据。现在每次点击都会留痕：被哪条闸门拦住（`gate-blocked` + 具体原因：`not-in-sessions-ids` / `workspaces-phase-pending` / `archived` / `workspaces-service-missing` …）、走了哪条路径（`navigated` / `fallback-open` / `nav-threw`），外加 `navService` 里 `uiWorkspace` / `workspaces` 的可用性与两个投影的 phase。设置页 Debug 区与控制台 `window.__dshPharos.debug()` 均可直接读取。
  - 轨迹含 **`alreadyCurrent`** 标记。**真机结论：完成通知一直是好的** —— 用户在自己的会话里让 agent 干活，跑完触发「完成」通知，点它 → 正确导航到 `session-9b37f68e…` → 而那正是当前会话，界面当然不动；「需要你」「出错」能跳是因为它们来自**另一个**后台会话。此前轨迹里 `navigated` 与「界面无变化」无法区分，只能靠推理，在真机上为此绕了数轮弯路。现已一眼可辨。

### 测试

- mock 对齐真实运行时语义：`binding()` 只对已 retain 会话有值；`open()` 不是导航；
  **`ctx.get` 忠实还原 strict 只看 fiber ACTIVE**（上一版 mock 声明了 strict 却从不使用，
  把错误前提固化成了假象）。
- M1-G 组扩到 10 项：真路径 / 老宿主兜底正反两面 / runId 拦截 / 归档拦截 / phase 拦截 /
  state 拦截 / byId-ids 分歧 / done 也跳 / 晚激活 / 半初始化实例不被永久缓存 / workspaces 缺失不跳。
- 变异验证 8 处，每处都由对应断言抓住（见下）。其中「半初始化实例」用例最初**测不出缺陷** ——
  它改的是同一实例的方法，缓存下来的旧引用后来照样能用；改为让 cordis 语义下**新实例**接手
  才真正暴露问题。
- 变异验证 8 处全部被对应断言抓住：还原 v0.6.2 的 `openSession` / 还原 `kind === "attention"`
  限制 / 解析阶段即缓存 / 去掉惰性重取 / 读服务而非快照 / byId 取代 ids / 去掉 phase 闸门 /
  去掉 state 闸门 / 去掉归档闸门 / 去掉 binding 兜底。

## [0.6.2] — 2026-10-08

minor 版：重做设置页的「消息格式」与「保存」两处交互，并修一个导致设置页整页打不开的渲染崩溃。

### 新增

- **消息格式三档**（设置页 → 消息通知 → Webhook 行）：**简洁（默认）/ 详细 / 自定义**。
  - 简洁：标题 + 结论 + 统计摘要 + 时间（四行，信息密度最低）
  - 详细：耗时 / tokens / 缓存命中 / 速度**逐项成行**
  - 自定义：展开模板编辑区（即原来的高级模式），可自由排版
  - 档位按**模板内容全等**判定，不新增落盘字段；老配置的自定义模板自然落在「自定义」档。
- **自动保存**：移除底部「保存设置」按钮 —— 按钮在最底下，改完没滚到底就切走会以为
  没生效、配置白改。现在任何改动停止约 **0.8 秒后自动落盘**（连续输入合并为一次写入），
  底部只显示保存状态。host 离线时写入本地偏好层。
- Webhook 模板新增 `{kindLabel}`（kind 的中文标签）与 `{summary}`（统计摘要，无值时为空串，
  可整行隐藏）两个变量。

### 变更

- **Webhook 输出自动去重**：模板里已排了 `{summary}` 或各统计 token 时，`note` 里的统计括号
  会被自动剥掉；已排 `{title}` 时剥掉 `note` 里的会话名。避免同一信息在一条消息里出现两次。
- **渲染时自动补齐硬换行**：钉钉 markdown 的换行规则是「`\n` 前后各两个空格」
  （官方 FAQ 原文：「换行格式： \n 重要 \n前后两个空格」），单换行会被折叠成空格 ——
  裸行、`> ` 引用块逐行都无效，真机三轮才定位到。现由 `renderTemplate` 自动在相邻行
  之间补两尾随空格，**「写了独立一行」就等于「显示为独立一行」**，预设与用户自定义模板
  都不必知道这个隐晦约定。
- **空壳行清理**：模板变量无值时留下的「只剩图标/符号」的行会被移除（`⏱ `、`**`、`> ` 等），
  但 markdown 分段空行与 `---` 分隔线**保留**（它们是有效内容）；连续空行折叠成单个。

### 修复

- **设置页整页打不开**（真机 `slot entry crashed in 'settings.section'`，React #137）：
  视图的 `h()` 辅助函数无子节点时仍把 children 作为第三参传给 `createElement`，传的是**空数组**，
  而 React 判定「第三参存在 = 有 children」→ `input` 是 void 元素，直接抛
  「input is a void element tag and must neither have children」。此前所有 `input` 都走显式两参
  `createElement`，本次新增的模板预设 radio 是首个走 `h()` 的无子节点 `input`，故首次触发。
- **简洁档出现两行重复**（真机钉钉截图）：「完成」（`{kindLabel}`）与「任务完成」（`{note}`）
  语义重叠。简洁档不再排 `{kindLabel}`（`note` 本身已是结论）；该变量保留给自定义模板使用。
- **「自定义」档切不回去**：档位按内容全等判定，而点「自定义」那一刻内容仍等于某个预设 →
  立刻被判回该档 → 界面弹回，永远进不去。新增只记 UI 意图的 `customRows` 标记（不落盘），
  切回简洁/详细时清除。
- **「详细」与「自定义」看不出区别**：切到自定义时沿用当前模板当种子，从详细切过去就与详细
  逐字相同。改为填入**专属起手式**（字段更全、结构明显不同）；若用户本次会话里写过自定义模板，
  则优先恢复该草稿（切去预设看一眼再切回来不丢稿）。
- **apiToken 可能被静默清空**：令牌模式选「设置新 Token」但尚未输入时，载荷 `apiToken=""`
  会被 host 理解为**清除**。改为留空即保持原值（对齐字段一直以来的提示文案）。
- **旧预设模板不会自动升级**：模板是插件维护的，改了预设后老配置仍持有旧原文 ——
  既会被判成「自定义」（radio 显示错档），又继续按旧的折叠写法推送。现按**归一化比对**
  （去掉引用前缀、折叠空行）识别历代写法并自动升级；用户自己写的内容绝不改动。
  迁移只在内存发生后由初载**回写一次**（否则 host 落盘的仍是旧模板）。

### 测试

smoke M1 133 → **210**，host 241 → **317**。新增覆盖：模板预设三档与内容裁剪、
空壳行清理（含分隔线/空行豁免）、**硬换行自动补齐**（渲染结果里每个相邻行都必须有尾随两空格，
并含「去掉尾随空格必须被判缺」的非空自检）、旧预设的**归一化识别与自动升级**（历代写法
逐个验证 + 「用户自定义内容不得被改写」的反向断言）、**void 元素 children 契约**
（用模拟 React 语义的桩实跑 `client.js` 里真实的 `h()` 源码，含桩自检）、
自定义档可进可退与草稿还原的状态机、自动保存的入口完整性（**按花括号配平精确截函数体**，
不用字符窗口）与 debounce 合并语义。
另新增两层「测试自身失效」门禁：`client.js` 语法错误时必须显式报错退出，以及
`m1Ready` 为假时不得静默跳过整段 M1（此前会把「代码坏了」伪装成「全部通过」）。
预设常量与判定逻辑改为**整块提取源码后执行真实实现**，不再在测试里另抄副本
（抄本会与实现漂移，本轮实测踩到）。
所有新断言均经反向验证（破坏实现后对应断言必须失败：6 / 8 / 12 处命中）。

[0.6.2]: https://github.com/Leo-Cjw/dsh-pharos/compare/v0.6.1...v0.6.2

## [0.6.1] — 2026-10-07

patch 版：修三个真机暴露的缺陷（自动化测试全绿但真机不可用），并把「完成」提醒从二档扩为三档。

### 修复

- **Webhook 模板 `{time}` 返回 UTC**（实测钉钉收到「2026-10-07T13:01:33.217Z」，本地实为 21:01，
  东八区差 8 小时）。改为 `YYYY-MM-DD HH:mm:ss` **本地时间**；另新增 `{isoTime}` token 给
  确需 UTC 的场景（如与外部系统对时）。
- **设置页 Debug 区时间戳是 UTC**（同源问题）——改用 `getHours()/getMinutes()` 本地时间。
- **页内 toast 完全不显示**（v0.4 起潜伏）：`el.style = {...}` 在真实 DOM 中静默失败
  （`el.style` 是只读的 `CSSStyleDeclaration`），toast 被创建、append 但**毫无样式** →
  透明、无固定定位，表现为「点了测试按钮什么都没出现」。新增 `applyStyle()` 逐条
  `setProperty`。⚠️ 该缺陷使**通知权限被拒的用户**页内兜底通道也完全失效。
- **设置页「测试」按钮点了没反应**：`test()` 原复用真实投递链路，会被 `quietHours` /
  `doneHiddenOnly` 静默，且反馈走系统通知（不在页面上）。现 `deliver()` 支持 `bypass`：
  无视静默策略 + 强制页内 toast，并回显实际触发的 kind。

### 新增

- **「完成」提醒时机三档**（对齐竞品 VS Code `windowNotFocused` / Codex `unfocused` /
  ChatGPT `only while in background`）：`关闭` / `仅页面隐藏时提醒（默认）` / `始终提醒`。
  旧字段 `doneHiddenOnly` 保留并自动映射（`true`→hidden、`false`→always），老配置行为不变。
- 新增 webhook token `{isoTime}`；设置页补全模板变量与事件类型清单。

### 测试

smoke M1 124 → **133**（新增 M1-P 本地时间/无 `el.style` 赋值契约锁、M1-Q 三档与向后兼容
含后台对照组）、host 234 → **241**（新增 `{time}` 本地格式 7 条）。三处新改动均经反向验证。

[0.6.1]: https://github.com/Leo-Cjw/dsh-pharos/compare/v0.6.0...v0.6.1

## [0.6.0] — 2026-10-06

工作流提醒（M2.5 里程碑）。经 5 轮方案评审（draft-3 → draft-7）共 29 条修订 / 19 条风险，
实施期又抓出并修复 3 个「方案写了但门禁没覆盖」的缺陷。

### 新增

- **工作流提醒**（`workflowEvents`，**默认关闭**）：订阅 `workflow/phase` · `agent-start` · `agent-end`，
  在多 agent 工作流进入新阶段、子 agent 启动/结束时弹系统通知（标题统一「工作流进展」，
  正文带工作流名）。开启需重启 DSH（订阅在插件加载时建立），关闭即时生效。
- **工作流日志**（`workflowLog`，**默认关闭**，与上一项**互相独立**）：订阅高频的 `workflow/log`，
  5s/run 限流采样后进 `debug().recentFrames` 环形队列，**不弹通知、不外发 webhook**。
- **Webhook 模板** 新增 `{cache}`（缓存命中率 ×100 取整）与 `{tps}`（1 位小数）两个 token，
  语义与既有 token 一致：有值才填、无值空串。
- `debug().recentFrames` 环形队列（20 条）：记录**所有** SSE 帧，入队点早于
  enabled/quietHours/kind 三道早退 —— 「提醒没来」这类最该排查的场景也能看到帧。
- 文档：`docs/sop-workflow-events.md`（效果与排查 SOP）、
  `docs/sop-verify-workflow-prompt.md`（验证用多 agent 工作流 prompt）、
  `docs/workflow-log-analyzer.js`（控制台分析器）、`docs/m2.5-plan.md`（完整方案与评审记录）。

### 修复

- **`skipSubagents` 对「本地 done 路径」无效**（v0.3 起存在的既有缺口，多 agent 场景首次暴露）：
  该判定原先只在 SSE 路径生效，而由 `uiSession` 边沿驱动的本地 done 路径无判定，
  导致子代理完成通知混进「任务已完成」。现由 host 在 `agent-start` 帧捎带 `childId`、
  浏览器半登记后据此过滤。
- **工作流阶段名显示裸 id**：`onSseFrame` 现在把 `frame.sessionTitle` 透传给
  `notificationFor`，复用已有字段而非新增 `title`。
- `client.js` 内嵌版本号长期与 `package.json` 不同步（徽章可能显示错版本）——现四处统一。

### 决策：`hostNotify` 不实现

`hostNotify`（v0.4 起预留）需要 `child_process` 调起 `osascript` 发 macOS 原生通知，
但本插件向 awesome-dsh-plugin 投稿的评审清单明确要求「**无 install 脚本 / 无 child_process·eval·vm**」。
二者直接冲突，故**确认不实现**，配置项保留仅为向后兼容（读得到、不生效）。
跨设备接收请用 Webhook（企微/飞书/钉钉/通用）。

### 已知限制

- 「跳过子代理事件」对**工作流帧本身**无效（`agentType` 恒为 `root`，否则默认开关会吞掉整组）；
  子代理会话自己的完成通知会被正确过滤。
- 该过滤判据覆盖 workflow 子 agent 与普通 subagent 委派（v0.6.1 起两类都覆盖）。
- 点击工作流通知只聚焦窗口，不跳转会话。
- 同名阶段 3 秒内去重；工作流提醒复用默认提示音型。
- 实时提醒依赖 DSH 页面保持打开（与其它提醒类型一致）。

[0.6.0]: https://github.com/Leo-Cjw/dsh-pharos/releases/tag/v0.6.0
