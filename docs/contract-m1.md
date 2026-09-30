# dsh-pharos M1 实现契约（v0.4.0）

> 本文件是 M1（host 桥）团队共享的**单一事实源**：帧契约、路由契约、配置 Schema、文件职责、行为规则、运行时事实。任何成员实现前先读完本文档与 docs/functional-architecture.md §3-§4。冲突以本文档为准。
> 总设计见 docs/functional-architecture.md；四仓库实现细节见 docs/research/。

## 0. 这一版做/不做

**做（M1 范围）**：
1. host 半实装：订阅 host 事件 → 归一定类 → 构造 PharosEvent 帧 → 双通道（SSE 广播 + webhook 推送）。
2. webServer 同源路由（prefix `/pharos/api`）：SSE stream / trigger / config GET·PUT / webhooks GET。
3. 浏览器半：保留 v0.3 全部能力；新增消费 SSE 帧（done/error/interrupted/limit/job/remote）；新音型与新文案；quiet hours；子代理过滤；DOM toast 兜底；跨标签页去重（Web Locks）；测试按钮扩展。
4. 设置页：`settings.plugins.tab` 槽位（React 视图，React 获取方式见 §7 冲刺项）。
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
  - 点击通知：`window.focus()` + `sessions.binding(id)?.session.open()`（best-effort，v0.3 行为保留）。

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
- 设置页槽位：**`settings.plugins.tab`** 本机存在（dsh-client-ui-settings-plugins 渲染 per-plugin row）；`settings.section` 不存在。
- 跳会话：`sessions.binding(id)?.session.open()` 存在（api-session-controller client.js:1857/3110/3400）；`sessions.open(id)` 不存在。
- 服务注入：host `ctx.inject(['webServer'], cb)`、`ctx.get(name, false)` 惰性查；client `ctx.get('slots', false)`。

**需冲刺核实（实现成员开工前 30-60min 内查源码定案）**：
1. **React 获取（pharos-settings）**：在浏览器 bundle 里怎么拿到 react？查 `/Users/mia/.dsh/profiles/desktop/node_modules/dshmarket/client/client.js`（其设置视图用的 React import 方式）与 `/tmp/dsh-checkout/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`（slots.register 契约：返回 React element 还是别的）。结论三选一：(a) `require('react')` 可用 → 直接 import；(b) runner 提供全局 React → 用之；(c) 都不行 → 视图用纯 DOM 构造并确认 register 能收非 React 渲染产物，否则把设置页降级标记 M1.5。**最终以 (a) 优先——dshmarket 设置页即 React（peer 声明 react ^18||^19 无 @deepseek-ai 门禁）。**
2. **profileDir（pharos-host）**：仿 dshmarket/lib/profile.js 的解析：`env.DSH_HOME || ~/.dsh` + `/profiles/<name>/`；profile name 取 `ctx.get('profileContext')`（launched.name 优先，回退 'desktop'）；落盘 `<profileDir>/pharos.json`。若 profileContext 拿不到 → 回退 `~/.dsh/pharos.json`。实现时给出你在本机验证到的实际路径。
3. **slot id 与「设置→插件」行的匹配（pharos-settings）**：照 my-notify `slots.register({name:'settings.plugins.tab', id:'pharos-settings', order:60, label:'消息通知'})`；id 是否须为条目 id 待实测（风险项已在架构文档 §7 列出，本轮以 my-notify 同名写法为准）。

## 8. 测试

- `node test/smoke.mjs`（浏览器半）：保留 27 断言（v0.3 回归），新增：SSE 帧消费（done/error/interrupted/limit）、双源 done 去重、quiet hours、子代理帧丢弃、toast 兜底、trigger 帧、config 合并。EventSource/fetch/Web Locks/Navigator 全部 stub（smoke 已用 vm 驱动真实 client.js，扩展同法）。
- `node test/host.test.mjs`（host 半）：stub ctx（on 捕获、inject 回调、webServer.register 捕获、get）、stub fetch；断言：turn/end 各 reason.kind → 正确帧字段；agent/error 兜底；未知 kind 静默；webhook 适配器（wecom/feishu/dingtalk/generic 各 1 例 + 加签）；SSE 广播；trigger 鉴权（无 token / 错 token / 对 token）；config GET 打码、PUT 深合并、原子落盘；quiet hours 拦住 webhook。
- 全部零新增依赖（node 内置 + 现有 stub 手法）。冒烟/主机测试都要 `process.exit(非0失败)`。

## 9. 集成（Integrator/Lead 执行，成员不碰）

版本 0.3.0→0.4.0；package.json 增补 exports/files（含 lib/host* 若拆分）、peerDependencies `react: "^18.2.0 || ^19.3.0"`（仅设置页需要时）、scripts.test 跑两个测试；README 更新；同步 `local-plugins/dsh-pharos` 与 `node_modules/dsh-pharos`；提交；提示用户重启验证。