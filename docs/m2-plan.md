# dsh-pharos — M2 里程碑完整规划（v0.5.0）

> 版本：draft-3（2026-10-03，两轮评审修订）｜ 面向运行时：DSH desktop 0.2.0-rc.2
> 本文是 M2「统计与定制」的落地级规划：范围 / 现状 / 技术路径 / 风险 / 验收标准。
> 关键数据源（`sessionProjections` / `tokenUsage` / `sessionStats`）已在本运行时
> 打包产物（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`）里**逐行核实**，
> 非文档转述。核实见 §附录。
>
> **draft-2 修订记录**（评审发现并已消化，见 §附录 B）：
> 1. 🔴 修正核心口径偏差：投影值是**会话累计**，不是「当轮」——改为 `turn/start` 存基线 +
>    `turn/end` 做差，得到真实当轮派生值（§3.4 已重写）。
> 2. B 组工作量重估：`renderTemplate` 已在 M1 落地（9 个变量），B-1 仅剩 `{cache}{tps}`（`{sessionUrl}` 已闭环删除）。
> 3. 命中率展示语义对齐 UI：分母 0 → 段不追加（非「0%」）。
> 4. 设置页数据机制定案：`stats()` 访问器 + `pharos:stats` CustomEvent + localStorage 兜底。
> 5. 回归门禁 #5 改法：`test(kind, stats)` 支持可选统计参。
> 6. 版本号同步面：`client.js:698` + `smoke.mjs` 断言语义。

---

## 0. 一句话目标

把「当轮统计」（token 用量 / 缓存命中率 / TPS / 耗时）与「webhook 模板定制」补进 pharos，
让提醒从「告诉你发生了什么」升级为「告诉你这一轮花了多少、多快」，且 webhook 出站消息可自定义内容。

---

## 1. 范围（三个子项，明确边界）

### A. 统计（核心，本轮必做）

| # | 子项 | 内容 | 归属层 |
| --- | --- | --- | --- |
| A-1 | 当轮统计投影 | 在 `turn/end` 帧里附加**派生值**：缓存命中率、TPS（当轮 delta 口径，见 §3.4 step 2）；`tokens` 用投影 delta | host |
| A-2 | 通知正文统计插值 | `noteFor` 的 meta 段支持 `{duration}{tokens}{cache}{tps}` 占位符；done/error/limit 都能带上 | host（纯函数） |
| A-3 | 设置页统计卡片 | 设置页「消息通知」标签新增「当轮统计」卡片，展示最近一轮的耗时/tokens/缓存命中/TPS | browser |
| A-4 | Debug 面板统计栏 | Debug 面板新增当轮统计只读栏（复用 A-3 数据，零额外端点） | browser |

### B. Webhook 模板定制（**已大幅缩水**，见修订记录 #2）

> ⚠️ M1 已落地 `renderTemplate`（`lib/host/webhook.js:29-42`），支持 9 个变量：
> `{title}{sessionTitle}{note}{kind}{sessionId}{tokens}{duration}{time}{ts}`，
> 设置页每行已有模板 textarea，host 测试已覆盖（`host.test.mjs`）。B-1 剩余工作量很小。

| # | 子项 | 内容 |
| --- | --- | --- |
| B-1 | 模板变量补全 | 新增 `{cache}`（缓存命中率）、`{tps}`（每秒 token）两 token |
| B-2 | 手动重放（**拆出单独评估**） | 失败环形缓冲已具备（50 条）；「手动重放」需新增路由 + 设置页按钮，是**新接口面**，建议不随本轮做，单独立项 |

### C. 明确不做（范围外，防止蔓延）

- **workflow 级通知细分**（phase/agent-start/agent-end 卡片）——**延后到 M2.5 / v0.6**，本轮不碰。
- **累计统计库 / 历史图表**——坚持 session-notify 的「当轮统计、不落累计库」口径，只随通知/卡片展示当轮，不建库。
- **错误严重度分级音效**——已有 error 重低音三音 + interrupted/limit 中音警示，不重做。
- **Windows 原生推送**——N/A（macOS 平台）。

---

## 2. 现状盘点（数据链路已就位到什么程度）

### 已具备（M1 已交付）

| 资产 | 状态 | 位置 |
| --- | --- | --- |
| host `turnState` 计量 | ✅ 已在记 `startedAt` + `tokens`（`assistant/message` usage 四桶累加） | `lib/host.js:119-130, 162-165` |
| `emitTurnFrame` 带 `durationMs`/`tokens` | ✅ 已塞进帧 + 渲染「耗时 X · N tokens」 | `lib/host.js:132-152` |
| `usageTokensOf`（四桶求和） | ✅ 已有，含单测 | `lib/host/frames.js:55-64` |
| `noteFor` 耗时/tokens 插值 | ✅ 已支持 `{durationMs}{tokens}` 两元 | `lib/host/frames.js:83-103` |
| SSE 帧通道 | ✅ 已通，帧已承载 `durationMs`/`tokens` | `lib/host/routes.js:144-156` |
| 设置页（React slot） | ✅ 882 行，无统计痕迹 | `lib/settings-view.js` |
| 官方投影服务 | ✅ 运行时内置 `ctx.sessionProjections`，已注册 `tokenUsage`/`sessionStats` 两单元 | 运行时 `dsh-session-projection` / `dsh-token-meter` / `dsh-session-stats` |

### 缺口（本轮要补的）

| 缺口 | 现状 | 说明 |
| --- | --- | --- |
| ① 缓存命中率 | ❌ 未算 | 需从 `tokenUsage` 投影读 `cacheReadTokens`/`cacheWriteTokens`/`uncachedInputTokens` |
| ② TPS | ❌ 未算 | 需从 `sessionStats` 投影读 `decodeTokens`/`decodeMs` |
| ③ 统计展示 | ❌ 无卡片 | 设置页 + Debug 面板无当轮统计 |
| ④ webhook 模板 | ⚠️ 已部分落地 | `renderTemplate` 已支持 9 变量（`webhook.js:29-42`）；缺 `{cache}` `{tps}` 两 token（B-1） |
| ⑤ 投影函数测试 | ❌ 无 | `usageTokensOf` 有单测，但投影读取/命中率/TPS 无测试 |

### 关键事实：官方投影「已经替我们算好了」

**这是 M2 增量小的根本原因。** 运行时 `dsh-token-meter` 与 `dsh-session-stats` 已经是两个
**投影单元**（projection units），注册在 `ctx.sessionProjections` 上，由框架**订阅 `session/event`
并惰性 fold** 全量会话事件——也就是说 token 计数、缓存命中、耗时、TPS 这些「统计」**框架自己
在算**，且与 dsh-web-ui 展示完全同口径。**投影可用时以官方投影做差为准；`turnState` 累加保留
作降级兜底与交叉验证**（见 §3.4 step 2/4 与 DoD 一致性断言）。

---

## 3. 技术路径（已核实，非推测）

### 3.1 数据源：`ctx.sessionProjections`（官方投影注册表）

```js
// 运行时事实（dsh-session-projection/lib/index.js）：
//   ctx.sessionProjections = Service("sessionProjections")
//   它已订阅 session/event，惰性 fold 每个已注册投影单元。

// 读取 API（全同步、惰性 fold、返回同日志位置的快照）：
const projections = ctx.get('sessionProjections', false); // 惰性获取，不硬门
if (projections && typeof projections.snapshot === 'function') {
  const snap = projections.snapshot(session, ['tokenUsage', 'sessionStats']);
  // snap.values.tokenUsage  = { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
  // snap.values.sessionStats = { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}
```

### 3.2 两个投影单元的精确字段（已逐行核实）

**`tokenUsage`**（`dsh-token-meter`，stateVersion 2，view 输出 `state.totals`）：

```
{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
```
> ⚠️ 字段名是 `uncachedInputTokens`，**不是** `inputTokens`（架构文档 §1 行 16 的缓存命中率
> 公式正确，但字段名以本条为准）。四桶严格模式，全 int、nonnegative。

**`sessionStats`**（`dsh-session-stats`，stateVersion 1）：

```
{ turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
```

### 3.3 派生指标公式

| 指标 | 公式（输入均为 `diffProjection` 后的**当轮 delta**） | 说明 |
| --- | --- | --- |
| 缓存命中率 | `cacheReadΔ / (uncachedInputΔ + cacheReadΔ + cacheWriteΔ)` | 官方 `tokenUsage` 投影口径；**分母为 0 时返回 `null`（不显示该段，非「0%」）**，部分命中不四舍五入成 100% |
| TPS | `decodeTokensΔ / (decodeMsΔ / 1000)` | 官方 `sessionStats` 投影口径；`decodeMsΔ` 为 0 时返回 `null` |
| 当轮总 token | `uncachedInputΔ + outputΔ + cacheReadΔ + cacheWriteΔ`（投影 delta） | 与现有 `usageTokensOf` 一致；投影 delta 优先、`turnState` 兜底 |

> 口径对齐依据（本轮核实）：UI 消费端 `billedInputTokens = uncached + cacheRead + cacheWrite`
> （`dsh-client-ui-chat/lib/client.js:6993`），命中率展示分母 0 → null 不显示、不四舍五入
> （`ui-chat.js:6305-6326`）。

### 3.4 落点设计（含 🔴 当轮口径修正）

**核心修正：投影值是会话累计，不是「当轮」。** 官方投影单元对整场会话的 log 做 fold：

- `tokenUsage` 的 `apply` 对新 turn 的 usage 做 `totals` 累加（`addReplacing` 只在同一
  turn+step 内去重替换，token-meter:414-434）→ `snapshot` 读出来是**整场会话四桶总和**；
- `sessionStats` 的 `turns/steps/llmMs/decodeMs/decodeTokens` 全部跨整个 log 累计
  （fold 无 turn 重置）。

所以「在 turn/end 时调一次 snapshot」读到的会是**累计值**，而非「最近一轮」。修正为
**基线快照做差**：

1. **新增模块 `lib/host/stats.js`**（四个纯函数 + 一个 ctx 适配读函数）：
   - `cacheHitRateOf(tokenUsage)` → 0~1（分母 0 → 返回 null，见修订 #3）
   - `tpsOf(sessionStats)` → number（`decodeMs` 0 → null）
   - `totalTokensOf(tokenUsage)` → number
   - `diffProjection(baseline, current)` → 两快照的 `tokenUsage` 四桶与 `sessionStats`
     的 `decodeTokens/decodeMs` 做差，得到**当轮**派生值（纯函数，无 ctx）
   - `readProjectionSnapshot(ctx, session)` → 惰性取 `sessionProjections` 并 `snapshot`，
     异常/缺失返回 `null`（**永不 throw、不硬门**；唯一触碰 ctx 的适配函数）

2. **`turn/start` 存基线，`turn/end` 做差**：
   - `turn/start` 时 `readProjectionSnapshot(ctx, session)` 存进 `turnState` 的 `baseline`
   - `turn/end` 时再读一次 current，`diffProjection(baseline, current)` 得到当轮四桶
     delta 与 decode delta → 派生出「当轮缓存命中率 + 当轮 TPS」
   - **基线缺失**（插件中途启用 / 投影不可用）→ 静默降级 v0.4（仅耗时，无统计），不报错

3. **帧扩展**：`makeFrame` 增加可选 `cacheHitRate` / `tps` 字段（缺省不破坏现有断言）。
   `emitTurnFrame` 塞进当轮派生值。

4. **frame.tokens 数据源定案**（修订 #5）：**投影 delta 优先，`turnState` 累加兜底**。
   因投影 delta 与现有 `turnState` 四桶累加同公式，测试可断言二者相等，顺带验证 A-1 正确性。

5. **`noteFor` 扩展**：meta 段支持 `{duration}{tokens}{cache}{tps}` 插值；**命中率分母 0
   时该段不追加**（对齐 UI：返回 null 不显示，不显示误导性的「0%」）。

6. **浏览器统计展示**（修订 #4）：SSE 帧带统计字段，浏览器半缓存当轮统计；
   - `installApi()` 增 `stats()` 访问器（读最近一轮统计）
   - 统计更新时 `document.dispatchEvent(new CustomEvent('pharos:stats', {detail}))`
   - 设置页挂载时读一次 `__dshPharos.stats()`，收到 `pharos:stats` 事件时重读
   - `localStorage['dshPharos.stats']` 兜底页面刷新
   - **不新增端点**，复用 SSE 帧

7. **webhook 模板**（子项 B）：`renderTemplate` 增 `{cache}` `{tps}` 两 token
   （`{sessionUrl}` 已核实**无会话路由、造不出可点深链**，删除，见附录 B.2）。

---

## 4. 风险与待验证项（实施时逐项打勾）

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| 1 | `sessionProjections` 服务在本运行时**可能未挂载**（取决于 profile 是否装了 token-meter / session-stats 包） | 中 | `ctx.get('sessionProjections', false)` 惰性获取；拿不到 → 静默降级为「仅耗时+tokens」的 v0.4 行为，**不硬门、不崩** |
| 2 | `snapshot(session, keys)` 需要传**会话对象**；兜底帧（`agent/error` 等）的会话归属是「尽力而为」（`sid='unknown'`，无真实 Session 对象） | 中 | 只在 `session/event` 主信号路径（有真实 session）做投影；兜底帧不投影（保持现状）。已核实：投影按 Session 对象同一性建 cell（WeakMap），`unknown` 字符串无 cell，无法投影 |
| 3 | `tokenUsage` 字段名是 `uncachedInputTokens` 非 `inputTokens`，写错会读到 undefined | 高 | 已核实，见 §3.2；`stats.js` 用解构 + 默认 0 兜底，字段缺失不 NaN |
| 4 | `makeFrame` 扩展字段破坏现有 55 条 M1 + 130 条 host 断言 | 中 | 新字段全 `...(... !== undefined ? {...} : {})` 可选展开；跑全量测试回归（已核实现有断言只验存在性、不验键集） |
| 5 | 🔴 **累计 vs 当轮口径**：直读 `snapshot` 得到整场会话累计，非「最近一轮」 | 高 | 已修正为「`turn/start` 存基线 + `turn/end` 做差」（§3.4）；投影读取从「只在 turn/end 一次」改为「turn/start + turn/end 各一次」，均为 O(1)（cell 已物化，advanceCell 为 no-op + 一次 schema parse） |
| 6 | 设置页统计卡片需读「最近一轮」数据，但浏览器半可能错过帧 | 低 | `stats()` 访问器 + `pharos:stats` CustomEvent + `localStorage['dshPharos.stats']` 兜底（§3.4 step 6） |
| 7 | ~~webhook 模板变量注入（`{sessionUrl}`）~~ ✅ **已闭环删除** | — | `{sessionUrl}` 已核实无会话路由、造不出可点深链（见附录 B.2），直接从 B-1 删除，不再引入该 token |
| 8 | ~~`{sessionUrl}` 无现成 URL 构造方案~~ ✅ **已闭环删除** | — | 同上，随 #7 一并关闭 |
| 9 | 版本号同步遗漏（`client.js:698` `version: "0.4.2"` + `smoke.mjs` 断言语义） | 低 | 升版时同步改 `client.js` 内嵌版本串 + `smoke.mjs` 相关断言 |

---

## 5. 验收标准（DoD）

### A 组（统计，必过）

- [ ] `lib/host/stats.js` 四个纯函数（`cacheHitRateOf`/`tpsOf`/`totalTokensOf`/`diffProjection`）+ `readProjectionSnapshot`，含单测（命中率/TPS/边界：分母 0→null、字段缺失→null、service 缺失→null）
- [ ] `turn/start` 收集基线 snapshot；`turn/end` 做差得到当轮派生值；**基线缺失 → 无统计、静默降级**（有断言）
- [ ] **一致性断言**：帧 `tokens`（投影 delta）= `turnState` 四桶累加（二者同公式，交叉验证 A-1）；**命中率/TPS 的分子分母同样锁在投影 delta 口径**（`turnState` 无缓存分桶，仅能比 tokens）
- [ ] `makeFrame` 支持 `cacheHitRate` / `tps` 可选字段，缺省不破坏现有断言
- [ ] `noteFor` 支持统计插值（有值才追加；命中率分母 0 时该段不追加，非「0%」）
- [ ] 设置页出现「当轮统计」卡片；Debug 面板出现「当轮统计」栏；**读取机制（`stats()` + `pharos:stats` CustomEvent + localStorage）有 smoke 断言**
- [ ] `service` 缺失时静默降级为 v0.4 行为（不崩、不报错）

### B 组（webhook 模板，已缩水，本轮可选）

- [ ] `renderTemplate` 新增 `{cache}` `{tps}` 两 token（`{sessionUrl}` 已删除）
- [ ] 模板只做纯文本替换（无 eval/exec）

### 回归门禁（全部必过，沿用现有交付链路）

- [ ] `node test/smoke.mjs` 全绿（v0.3 6 + audioCtx 7 + M1 55 + 新增 M2 断言）
- [ ] `node test/host.test.mjs` 全绿（130 + 新增 stats 断言）
- [ ] `tools/sync-settings-view.mjs` 幂等（`lib/client.js` md5 不变）
- [ ] 安装副本 `~/.dsh/profiles/desktop/local-plugins/dsh-pharos` 的 lib/ 逐文件 md5 与 repo 一致
- [ ] **`test(kind, stats)` 扩展**：`window.__dshPharos.test("done", { stats })` 能弹出正文含统计的通知（smoke 里确定性验证，无需真实完成一轮）

---

## 6. 交付链路（照 MEMORY.md 约定）

1. 改 `lib/settings-view.js` 后跑 `node tools/sync-settings-view.mjs` 内联进 `lib/client.js`（改 client.js 本体后也要跑一次验证幂等）
2. 同步安装副本 → 两端 `lib/client.js` md5 一致
3. 双测全绿 → 升版本 0.5.0 →（可选 npm publish）→ git push
4. **版本号同步面（易漏）**：升 0.5.0 时除 `package.json`，还要同步：
   - `lib/client.js:698` 的 `version: "0.4.2"`（`installApi` 内）
   - `test/smoke.mjs` 里绑版本语义的断言（约 :212）

---

## 附录：运行时源码核实记录（2026-10-03）

通过 `@electron/asar` 解包 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`，
逐行核实以下事实（文件行号引用打包产物）：

- `dsh-session-projection/lib/index.js`：
  - `SessionProjectionRegistry extends Service`，构造器 `super(ctx, "sessionProjections")`，`ctx.on("session/event", (s,e)=>this.drive(s,e))`（:44-66）
  - 读取面：`stateOf(session, key)`（:127）、`snapshot(session, keys) → { asOfSeq, values }`（:142-156）、`cachedSnapshot`（:165）、`checkpoint`（:196）、`restore`（:287）、`hydrate`（:330）
  - 注册面：`register(definition)`（:68），key 冲突按 stateVersion 校验（:91）
- `dsh-token-meter/lib/index.js`：
  - `tokenUsageProjectionDefinition` key=`"tokenUsage"` stateVersion=2（:413-415）
  - 四桶：`uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`（:340-345, 359-364）
  - `wire.view = state => state.totals`（:442-445）
- `dsh-session-stats/lib/index.js`：
  - `sessionStatsProjectionDefinition` key=`"sessionStats"` stateVersion=1（:66-67）
  - view 字段 `turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens`（:28-37, 161-170）
  - TPS 分子 `decodeTokens` 来自 `usage.outputTokens` 累加（:119-123），分母 `decodeMs` 是首 token → 组装完成墙钟
  - 插件 `name="session-stats"`、`inject=["sessionProjections"]`（:186-188）

**结论**：官方投影是 M2 统计的首选数据源，读取面 `snapshot(session, ['tokenUsage','sessionStats'])`
在 host 半可直接调用，无需自建计量，无需 peer 声明（`ctx.get` 惰性获取）。

> ⚠️ 但注意：投影值是**会话累计**（对整场 log fold），做「当轮」统计必须 `turn/start` 存基线 +
> `turn/end` 做差（§3.4）。这是 draft-2 的核心修正。

---

## 附录 B：评审修订记录（draft-1 → draft-2）

评审结论：文档源码级事实可信（15+ 处行号引用属实），但存在 **1 个导致「错误数字」的设计
偏差 + 6 个开工前需定案细节**。本附录记录修订后的定案，作为实施基准。

### B.1 🔴 核心偏差：累计 vs 当轮（已修）

- **问题**：§3.4 原写「turn/end 时调一次 snapshot」——但投影是累计值，读出来是整场会话总和，
  非「最近一轮」。
- **修正**：`turn/start` 存基线 snapshot → `turn/end` 再读一次 → 四桶与 decode 做差。
  基线缺失（插件中途启用/投影不可用）→ 静默降级 v0.4。
- **附带收益**：投影 delta 与现有 `turnState` 四桶累加同公式，测试可断言二者相等，交叉验证 A-1。

### B.2 B 组工作量重估 + `{sessionUrl}` 闭环删除（已修）

- 评审指出 `renderTemplate` 已在 M1 落地。核实属实：`lib/host/webhook.js:29-42` 支持 **9 个变量**
  （评审说 8 个，实际多一个 `{sessionTitle}` 别名）：`{title}{sessionTitle}{note}{kind}{sessionId}{tokens}{duration}{time}{ts}`。
- 设置页已有模板 textarea，host 测试已覆盖。
- ⇒ B-1 原剩 `{cache}{tps}{sessionUrl}` 三 token；续评**闭环删除了 `{sessionUrl}`**（证据链三级）：
  1. `dsh-web-app lib/index.js:94-99` 权威 URL 就是 `http://127.0.0.1:${webServer.port}`；
  2. 前端 `index-*.js`（633KB）全量扫描仅见 `location.href`，零 `location.hash`、零 `/session/` 路径、零 `?session=`；
  3. `dsh-client-ui-open-in-app` / `dsh-host-open-in-app` 均无自定义 scheme 注册。
  ⇒ GUI 无路由抽象，`{sessionUrl}` 造不出可点深链。**B-1 最终仅剩 `{cache}` + `{tps}` 两 token。**
- B-2「手动重放」拆出单独评估（新接口面）。

### B.3 命中率展示语义（已修）

- UI 消费端分母 0 时返回 null（不显示），部分命中不四舍五入成 100%（`ui-chat.js:6305-6326`）。
- 原文档「分母 0 返回 0」会显示误导性「0%」→ 改为「分母 0 → 该段不追加」。

### B.4 设置页数据机制（已定案）

- `client.js` 与 `settings-view.js` 是独立闭包，只能经 `globalScope.__dshPharos` 通信。
- 定案：`installApi()` 增 `stats()` 访问器 + 统计更新时派发 `pharos:stats` CustomEvent +
  `localStorage['dshPharos.stats']` 兜底页面刷新。设置页挂载读一次、收到事件重读。

### B.5 回归门禁 #5 改法（已定案）

- 原「`test('done')` 带统计弹出」不可行（`test(kind)` 是浏览器半本地合成，不经 SSE、无统计）。
- 定案：`installApi().test(kind, stats)` 支持可选统计参，smoke 里确定性验证。

### B.6 frame.tokens 数据源（已定案）

- 原为 `turnState` 累加；切投影后「投影 delta 优先、`turnState` 兜底」，测试断言二者相等。

### B.7 版本号同步面（已补）

- 除 `package.json`，还需同步 `lib/client.js:698` 的 `version: "0.4.2"` 与 `test/smoke.mjs`
  绑版本语义的断言（约 :212）。

### B.8 实施范围建议（已采纳）

- A 组照做（含 per-turn 基线快照修正），工作量比原预估略增（每轮多一次 O(1) 基线读），幅度很小。
- B 组：B-1 是两 token（`{cache}` `{tps}`）小活，可 A 完成后顺手做；B-2 手动重放拆出单独评估。
