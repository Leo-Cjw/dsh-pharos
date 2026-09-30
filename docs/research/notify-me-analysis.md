# dsh-notify-me 代码级逆向分析报告（供 dsh-pharos 对标）

> 分析对象：https://github.com/chromoany/dsh-notify-me（默认分支 `main`，当前版本 v1.1.8，2026-09-24 发布）
> 分析方式：GitHub raw 源码逐文件读取 + 对**目标运行时 DSH 0.2.0-rc.2** 做 API 交叉验证。
> 结论适用性：dsh-notify-me 的兼容声明只到 0.1.5-rc.2；下面「运行时差异」一节说明它在 0.2.0-rc.2 上两处关键失效点——这是 pharos 对标时最重要的情报。

---

## 1. 仓库文件树与构建骨架

```
.
├── package.json            # dsh 字段：bundle.patch / client.inject / client.platform / compatibility
├── cordis.patch.yml        # 向 web profile 的 cordis 配置插入一条 loader 条目
├── lib/index.js            # host 半（no-op，625 B）
├── lib/client.js           # browser 半（唯一实现，58 KB，CJS factory 形态）
├── README.md / README.en.md / CHANGELOG.md / LICENSE
├── docs/listing.md         # 插件市场收录记录
├── docs/screenshots/notify-toast.png
├── screenshots.json
└── smoke/                  # smoke-test.cjs + cordis-host-test.mjs（离线冒烟 + 真 cordis 宿主端到端）
```

加载链（证据：`cordis.patch.yml` + 运行时 `dsh-client-modules` 包）：

1. 安装时 `dsh plugin --profile web add dsh-notify-me` 把 `cordis.patch.yml` 打进 web profile 的 cordis 配置，插入一行 `{id: notify-me, name: 'dsh-notify-me'}` 普通 loader 条目（host 半）。
2. host 半 `lib/index.js` 的 `exports.name = "dsh-notify-me"` 被 cordis loader 识别；其 `dsh.client` 声明被 `@deepseek-ai/dsh-client-modules` 扫描（`dsh-client-modules` 在 client-modules graph 组装时调 `graphRow(id, rev, fields)`，把 `dsh.client.inject/external` 转成 `__ModuleLoader__` 加载图的行）。
3. 页面拿到 `window.__ModuleLoader__.load({id, factory})` 注册表；`dsh-client-modules` 通过 combo URL `??<ids>/client.js&rev=...`（`comboReference()`）把 `/plugins/dsh-notify-me/client.js` 注入页面。
4. `lib/client.js` 的 factory 体是内联 CJS（`require` 解析到 shell 模块表），`exports.inject` / `exports.apply` 供 client cordis runner 执行——与官方 ui-* 包 tsdown bundle 同构（`dsh-client-ui-session`、`dsh-cordis-client-runner` 的 `client.js` 均为同一 `window.__ModuleLoader__.load` CJS factory 形态，已验证）。

**host 半不做任何事**：`lib/index.js` 全文只有 `export const name` + 空 `apply() {}`。它存在唯一目的就是让 loader 挂上这个包、让 `dsh-client-modules` 拾取 `dsh.client` 声明去服务 `/plugins/dsh-notify-me/client.js`。全部逻辑在浏览器半。

---

## 2. package.json 关键字段

```jsonc
{
  "name": "dsh-notify-me", "version": "1.1.8", "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "files": ["lib/index.js", "lib/client.js", "cordis.patch.yml", "README.md", ...],
  "engines": { "node": ">=18" },                    // 纯静态声明，运行时不强制
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },     // profile 补丁层 → cordis 配置注入条目
    "client": {
      "inject": ["@deepseek-ai/dsh-client-ui-session", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation"],
      "platform": "web"                              // 声明浏览器半接入目标
    },
    "compatibility": { "dshReleases": {
      "0.1.1-rc.2": "compatible", "0.1.2-rc.1": "compatible",
      "0.1.5-rc.1": "compatible", "0.1.5-rc.2": "compatible" } }  // 市场展示矩阵，非运行时门禁
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-client-locale": "^0.1.0-rc.6 || ^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.5-rc.1"
  },
  "peerDependenciesMeta": { "@deepseek-ai/dsh-client-locale": { "optional": true } }
}
```

要点（对 pharos 的 dsh 字段模板）：

- **`dsh.bundle.patch`**：指向 `cordis.patch.yml`，patch 层 `- insert:` 文档提供插件安装路径（替代手动改 cordis.yml）。
- **`dsh.client.inject`**：⚠️ 这不是插件自身 cordis inject（见 §6 的硬门控坑），而是「把哪些官方 client 包拉进加载图、保证加载顺序」的声明。缺了它插件在旧运行时可能不激活；多了不存在的包则**永远 pending**（1.1.3/1.1.4 踩过的坑，见 CHANGELOG）。
- **peerDependencies 只有一个 optional 的 `dsh-client-locale`**（多版本或门）。它不是「支持最低 DSH 版本的运行时门禁」——真正的兼容矩阵是 `dsh.compatibility.dshReleases`，仅供 DSH-Store/市场决定是否上架，**运行时不强制**。
- `exports` 的 `"./client"` 子路径是约定俗成的：`dsh-client-modules` 挂 `/plugins/<name>/client.js` 时按此读包。

---

## 3. 触发源（逐种通知的触发条件）

全部逻辑在 `lib/client.js`，服务订阅在 `apply(ctx)` 的 effect 里完成：
`inject = ["sessions", "locale", "slots"]`（**注意不含 uiSession**，理由见 §6）。三个订阅：
`ctx.sessions.list.subscribe(onListChanged)` + `rootCtx.sessions.binding(cur)` 的 `session.subscribe`（当前会话 face）+ `uiSession.pendingInteractions` 的 store（仅当可拿到）。

### A.「需要你操作」（attention）—— 两代宿主两条路径

**路径 1（新宿主, ≥0.1.2-alpha.2）：`uiSession.pendingInteractions` store**（`bindUiSession()` / `evalUiPending()`）
- 服务读取方式：`ctx.get("uiSession")`（cordis 4 免 inject 读取通道，`rootCtx.reflect.get()` 与属性读取为兜底；`lookupService()`）。
- 数据形态：`Map<sessionId, interaction>`，`interaction.kind ∈ {approval, plan-review, question}`（由 `dsh-client-ui-approval` / `dsh-client-ui-user-questions` 经 `uiSession.registerPendingInteraction()` 发布）。
- 触发：某 sessionId 出现**新 key** 的 interaction（`uiBaseline[sid].key` 与上轮不同）→ `fireAttention()`；挂载时已存在的等待（无基线）也补一次；同 key 经 `attentionKeysFired` 去重（跨两个 watcher 全局去重）。
- 释放：`snap.forEach` 后对基线里已消失的 sid 调 `unmarkAttention()`（标题标记释放）；`detail` 从 interaction 对象提取：`PendingApproval` 取 `toolName · reason`，`PendingQuestion` 取 `questions[0].question`（`textFromPayload()`，截断 160 字符）。

**路径 2（旧宿主, <0.1.2-alpha.2）：Controller 快照路径**（`bindCurrentFace()` + `evalListRow()`，`evaluateRow()` 统一求值）
- 当前会话 `ConversationSnapshot`：`snap.pending[]` 新增 `{key, kind, payload}` → 提醒；kind 取 `approval / plan-review / question`。
- 其它会话列表摘要：`sum.pendingInteraction` 出现（合成 key `list:<sid>:<kind>`）→ 提醒。
- 该路径在 0.1.2+ 宿主已死（快照不再带 `pending`，见 §7 验证），仅作旧版兜底。

**可见性规则**（`fire()` / `quietedByVisibleSession()`）：
- `attentionHiddenOnly`（默认 false）：页面隐藏时提醒；`config.attentionHiddenOnly && !hidden()` 时静默。
- `currentHiddenOnly`（默认 true）：等待属于**正在看的会话**且页面在前台 → 不弹通知不响铃，只留标题标记，并 `queueQuieted(key, copy)` 暂存；`visibilitychange` → `flushQuieted()` 在转后台瞬间补发；若等待已处理则随 `unmarkAttention` 作废。

### B.「回复完成」（done）—— 同一个 `evaluateRow()` 状态机

`prevById[sid] = {running, pendingKeys, completed, seeded}` 维护每会话基线，三种边沿：
1. **非当前会话 completed 边沿**：`!row.face && row.completed && prev && !prev.completed && prev.seeded` → `fireDone(label, "")`。
2. **running true→false**（face 有辅助文本）：`wasRunning && !runningNow && !hasPendingNow` → `fireDone(label, snippetOfLastAssistant(faceSnap))`——取最后一个 `kind==="assistant"` node 的最后 `kind==="text"` block 前 80 字符。
3. 与 attention 同 tick 去重：`Date.now() - lastAttentionAt < 300ms` 时不发 done。

可见性：`doneHiddenOnly`（默认 true）只在 `document.hidden` 时发。

### C. 首帧基线

`onListChanged()` 首次调用只建 `prevById` 基线（`seeded: true`），避免把「已存在的运行中会话」误判为完成；但「已存在的 pending 等待」在新宿主的 `evalUiPending()` 里仍会提醒一次（store 绑定即播种）。

---

## 4. 输出渠道

1. **系统通知（Toast）**：`new Notification(title, {body, tag: "dsh-notify-me-"+kind, renotify: true, icon: location.origin + "/favicon.svg"})`；`setTimeout 15s` 自动关。权限：首次指针/按键事件（`pointerdown`/`keydown` capture）时 `Notification.requestPermission()`（`unlockOnce()`）。`canToast()` 对 `Notification.permission` 读取抛错做防御（策略禁用时不算故障）。
2. **提示音**：**WebAudio 合成**（`AudioContext || webkitAudioContext`，无音频资源）：attention 三个上行音 `880→1174→1568 Hz`，done 两个音 `659→988 Hz`；`gain.exponentialRampToValueAtTime` 包络，音量 `config.volume`。AudioContext 被浏览器自动播放策略挂起，`unlockAudio()` 在首次手势时 resume。
3. **标签页标题标记**：`document.title` 前缀 `🔔 需要你 · ` / `🔔 Action needed · `。`attentionActive` 计数器 + `attentionKeysMarked` 键集合；**标记归属**：两个 watcher 都可能先看到等待，故「先报到者拿标记、只有它释放」（`markAttention/unmarkAttention`），uiSession 绑定后由其独占（`uiPending` 标志 + `detachUiSession()` 全量释放）。宿主随时可能改写 title，故每次 apply 重新读 base（`cleanBase()` 剥掉自己或上一轮残留的三种前缀，`writtenTitle` 记忆上次写入值）。
4. **事件钩子**：`deliver()` 里 `window.__dshNotifyMe.onEvent(kind, {title, body, sessionId})` 供外部消费（测试 harness 用）。
5. **无 badge API**（未用 `setAppBadge`），桌面端也没有 native 集成——纯浏览器层。

---

## 5. 点通知跳会话

`showToast()` 里 `n.onclick = () => focusSession(sessionId)`：

```js
function focusSession(sessionId) {
  try { window.focus(); } catch (e) {}
  if (!sessionId) return;
  var svc = lookupService("sessions");
  if (!svc || typeof svc.open !== "function") return;   // 守卫：旧宿主无 open() 只做前台聚焦
  var st = listStore && listStore.getSnapshot();
  if (st && st.byId && !st.byId[sessionId] && st.current !== sessionId) return; // 会话已消失不调用
  svc.open(sessionId);
}
```

即：**`window.focus()` + `sessions.open(sessionId)`**（1.1.8 新增，CHANGELOG 明确说 open 对未知 id 会抛错所以要查列表）；`autoFocus` 配置关闭时点击不做任何事。⚠️ 目标运行时 0.2.0-rc.2 的 sessions 服务**没有 `open` 方法**（见 §7），该能力在当前运行时退化为仅 `window.focus()`。

---

## 6. 设置页与配置

### 设置页机制

`apply(ctx)` 里做能力守卫后注册（**React 可选**，核心提醒逻辑零依赖）：

```js
ctx.effect(() => { ctx.locale.register(NS, { zh: UI_zh, en: UI_en }); }, "dsh-notify-me: settings dictionaries");
var t = ctx.locale.bind(NS);
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section", id: "dsh-notify-me", order: 45,
  label: () => t("nav"), locale: NS, inject: () => ({ t })
}, (ownerProps) => React.createElement(NotifySettingsView, { ctx, t })));
```

- **服务**：`settings.section` 槽位 + `slots.register`（官方 `dsh-client-ui-settings-account`、`dsh-client-ui-agent-preset` 用的正是同一 API，已在 0.2.0-rc.2 bundle 里验证；order 45 排在 agent-presets(20) 之后）。`ctx.slots.inject` 每次进入设置页时执行 register。
- **多语言**：`ctx.locale.register(NS, {zh, en})` + `ctx.locale.bind(NS)`；页面内 `React.useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot)` 跟随界面语言。
- **样式**：手写 `<style data-plugin-css>` 注入（`injectStyle()`），CSS 类全部 `dnm-` 前缀防冲突，颜色走 `var(--dsw-alias-*)`。
- 守卫：`React && React.createElement && ctx.slots && ctx.locale.register && ctx.slots.inject` 缺一即跳过（降级为纯提醒，无设置页）；`react` 从 shell 模块表 `require("react")` 拿。

### 配置项全集与存储

- 存储：**`localStorage`**，键名 **`dshNotifyMe.config`**（JSON），与其它第三方浏览器插件一样 origin 级。
- 键与默认值（`DEFAULTS`）：`enabled: true`（总开关）、`language: "auto"`（`auto|zh|en`）、`attentionHiddenOnly: false`、`currentHiddenOnly: true`、`doneHiddenOnly: true`、`toast: true`、`sound: true`、`volume: 0.5`、`autoFocus: true`。
- 全局控制 API：`window.__dshNotifyMe` = `{config(getter), version, setConfig(patch), resetConfig(), test("attention"|"done"), debug(), onEvent}`。测试提醒绕过可见性规则但受总开关约束；「需要你」测试的标题标记 6s 后自动释放。

---

## 7. 目标运行时（0.2.0-rc.2）交叉验证 —— pharos 最关键情报

我把 app.asar 里 `dsh/node_modules/@deepseek-ai/*` 的 client bundle 解包逐条核对，dsh-notify-me 依赖的 API 在当前运行时有**两处失效**：

| dsh-notify-me 依赖 | 0.2.0-rc.2 实际 | 后果 |
|---|---|---|
| `uiSession.pendingInteractions`（含 `getSnapshot`/`subscribe`） | **不存在**。`UiSession` 类（`dsh-client-ui-session/lib/client.js`）只有内部 `pendingSnapshot: Map` 字段；对外发布改为 **`sessionStatus` store**：`getSnapshot()` 返回 `Map<sessionId, {running, pendingInteraction, completionUnread}>`，`subscribe(listener)` 存在（`publishStatus()` 每次把 list/running/pendingSnapshot/completionUnread 合流成新 Map 后 notify） | `bindUiSession()` 的守卫 `!store || typeof store.getSnapshot !== "function"` 命中 → 记 `uiSessionNote: "uiSession has no pendingInteractions store"`，退回旧路径；而旧路径的 `snap.pending`（`buildSnapshot()` 已无 `pending` 字段，只剩 `pendingSubmissions/running/…`）与 `sum.pendingInteraction`（已删）同样不存在 → **「需要你操作」提醒在当前运行时完全哑火** |
| `sessions.open(id)` | SessionController（`dsh-api-session-controller/lib/client.js`，经 `rootCtx.reflect.provide("sessions", this, void 0)` 提供）**没有 `open` 方法**（有 `binding(id)/get(id)/retain/using/create/fork/rename/search`） | `focusSession()` 守卫 `typeof svc.open !== "function"` 直接 return → 点通知只 `window.focus()`，不能切会话 |

仍正常的部分：
- cordis 4 语义完全成立：`ctx.get(name)`（`reflect.get(name, strict=true)`）免 inject 读服务；属性读未声明服务名抛 `cannot get property "uiSession" without inject`（`cordis/lib/index.js:676`）——这正是 1.1.5 哑火的根因、1.1.6 用 `ctx.get()` 修复的点。
- `settings.section` 槽位 + `slots.register` 机制与 dsh-notify-me 用法一致（官方 settings-account/agent-preset 同款）。
- `locale.getLocale().active`（值为 `"zh"|"en"`）、`locale.register/bind` 存在。
- `sessions.list.getSnapshot()` 返回含 `byId`（每项有 `displayTitle`）的会话表，`sessions.binding(id)` 存在——dsh-notify-me 的会话表/watch 路径可用。
- `window.__ModuleLoader__.load({id, factory})` CJS 表机制与 `/plugins/<name>/client.js` 服务路径成立。
- 0.2.0-rc.2 上 pending 交互的**正确**监听源是 `uiSession.sessionStatus`（Map 值带 `pendingInteraction`，即 `PendingApproval/PendingQuestion` 实例）——**不是** 0.1.x 的 `pendingInteractions`。这一点对 pharos 直接可用（任务描述里猜的 `uiSession.sessionStatus` 就是对的）。

---

## 8. 运行时能力下限（supports 视角）

- Node ≥18（引擎声明，静态）；host 半零 API 依赖。
- 浏览器半最低能力集合：`localStorage`、`Notification`、`AudioContext`/`webkitAudioContext`、`document.hidden/visibilityState`、`window.__ModuleLoader__.load`、cordis `ctx.get()`/`ctx.effect`/`ctx.slots`/`ctx.locale`、服务 `sessions`（list/binding）、`uiSession.sessionStatus`（0.2.0+ 形态）。
- 官方 peer 依赖只需 `@deepseek-ai/dsh-client-locale`（optional）；`react`、`slots`、`locale` 只作用于设置页，缺失自动降级。
- 版本门实际是**软门**：声明里只有 `dsh.compatibility.dshReleases` 市场矩阵，无运行时强制；实现上靠「注入包是否存在 + 服务惰性查找」自适应两代宿主。

---

## 9. 对 dsh-pharos 的对标建议（按优先级）

1. **触发源直接接 `uiSession.sessionStatus`**（0.2.0-rc.2 当前真相源，Map 值 `{running, pendingInteraction, completionUnread}`），别再走 `pendingInteractions`（已被重命名/内化）或快照 `pending`（已删除）；可同时保留 `sessions.list`/`binding` 的 running/completed 边沿做「回复完成」与后台会话完成。
2. **复制它的 cordis 门控教训**：`dsh.client.inject` 只列**当前运行时存在**的包（`dsh-client-ui-session`、`dsh-client-locale`、`dsh-client-ui-conversation` 在 0.2.0-rc.2 均在）；插件自身 cordis inject（`["sessions","locale","slots"]`）才是硬门——凡缺失必 pending 且 web boot 审计失败。要兼容老宿主就用 `ctx.get()` 惰性查 `uiSession`，绝不写进 inject。
3. **设置页抄它的槽位配方**：`settings.section` + `slots.register({name, id, order, label: ()=>t("nav"), locale, inject})` + `locale.register/bind`——这是官方与第三方一致的注册形态（order 45 是它占的位，pharos 选别的 order）。
4. **输出通道**：WebAudio 合成音（免资源）、`Notification` toast（`tag`/`renotify`/自动 15s 关闭）、`document.title` 前缀标记（注意宿主也可能改 title，需每次重读 base + `writtenTitle` 记忆去环）、`window.focus()` + 会话切换（0.2.0-rc.2 无 `sessions.open`，可考虑 `uiSession.current` binding 或 `sessionStatus` 侧的会话激活 API；若 pharos 需要「点击通知切会话」得先在运行时找到等价能力，或对旧 API 做能力探测再降级）。
5. **配置**：`localStorage` 单键 JSON + `window.__dshNotifyMe` 全局 API（`config/setConfig/resetConfig/test/debug/onEvent`）是其可测性/可调试性的来源——pharos 的 debug 入口值得同样补上。
6. 别被它「无 peer 依赖也能跑」误导：它的提醒核心确实零依赖，但**设置页与语言跟随依赖 `slots`/`locale`/`react`**；pharos 如要强依赖某个能力，应按「硬门 vs 惰性」二分设计并写进 CHANGELOG 式兼容矩阵。

---

### 附：证据文件索引

- host no-op：`lib/index.js`（`apply() {}`）
- 全部实现：`lib/client.js`（`bindUiSession`/`evalUiPending`/`evaluateRow`/`fireAttention`/`fireDone`/`focusSession`/`showToast`/`tone`/`applyTitle`/`markAttention`/`flushQuieted`/`NotifySettingsView`/`apply`）
- 补丁层：`cordis.patch.yml`（`- insert: {id: notify-me, name: dsh-notify-me}`）
- 版本演进与踩坑史：`CHANGELOG.md`（1.1.3~1.1.8 逐条）
- 运行时交叉验证（0.2.0-rc.2）：
  - `@deepseek-ai/dsh-client-ui-session/lib/client.js` — `UiSession` 类：`pendingSnapshot` 内部字段、`sessionStatus` store（`publishStatus()` 的 Map 形态）、`registerPendingInteraction(precedence)` 域
  - `@deepseek-ai/dsh-api-session-controller/lib/client.js` — `rootCtx.reflect.provide("sessions", …)`、`buildSnapshot()` 无 `pending`、`binding(id)` 存在、无 `open()`
  - `@deepseek-ai/cordis/lib/index.js:676` — `cannot get property "X" without inject`
  - `@deepseek-ai/dsh-client-modules/lib/index.js` — `dsh.client` 校验（`platform`/`inject`/`external`）、`/plugins/<id>/client.js`、`__ModuleLoader__`、`orderByModuleGraph`
  - `@deepseek-ai/dsh-client-ui-settings-account`、`dsh-client-ui-agent-preset` — `settings.section` 槽位官方用法同款