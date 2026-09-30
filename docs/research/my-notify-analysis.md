# dsh-my-notify 代码级分析（子代理报告整理）

> 仓库：`https://github.com/baosfeng/my-dsh-plugins`（默认分支 main，目录 `plugins/dsh-my-notify/`）
> 版本：0.4.0（2026-09-17，CHANGELOG 引入 quiet hours）
> 方法：克隆仓库逐文件读取（host `src/*.ts` + browser `src/client/parts/*.ts` + 依赖契约 `plugins/dsh-shared/src/*`）。

## 架构与通信（本插件是"host 桥"范式的完整样板）

- **host 半**（`lib/index.js`）：inject `['webServer']`；事件监听、通知帧构造、SSE 广播、webhook 推送、`/notify/api` 路由、配置持久化。纯事件订阅，无轮询。
- **browser 半**（`lib/client.js`，1599 行单包）：`window.__ModuleLoader__.load({id:'dsh-my-notify', factory})`；EventSource 订阅、系统通知/beep/toast、点击跳会话（`ctx.get('sessions', false)`）、设置页（`ctx.get('slots', false)`）。
- **通信：纯同源 HTTP**：host→browser 走 **SSE**（`GET /notify/api/stream`，帧 `{type:'notice',kind,sessionId,title,note,toolName,agentType,time,tokens,duration,sessionUrl,question,questions}`，25s `: ping` 心跳，retry:3000 自动重连）；browser→host 走 fetch REST。无 IPC。

## 触发源（四类事件）

- `ctx.on('agent/status')` status==='idle' → kind 'end'（带 token 计量与耗时、sessionUrl）
- `ctx.on('tools/pre-execute')` 且 name==='ask_user_question' 且顶层 → kind 'ask'（透传 next()）
- `ctx.on('approval/request')` 且顶层 → kind 'approval'（透传 next()）
- `ctx.on('session/event')` 仅 token 计量（assistant/message 的 usage 累加，非通知源）
- 子代理过滤：isTopLevelAgent 三标记（origin==='subagent' / delegationDepth>0 / options.subagentDepth>0 / parentSession 非空）；emitNotice 出口统一拦截（除非 subagentEnd:true）
- 去重：服务端 dedupeMs（默认 3000ms，按 kind:sessionId）+ 客户端 2000ms 窗口 + **Web Locks 跨标签页互斥**
- 免打扰：isQuietNow（支持跨午夜），出口拦截双通道

## 出站 webhook

- 触发：与 SSE 共用出口 `emitNotice`，任何事件异步 `dispatchWebhooks`。
- 发送：host 半 global fetch，POST JSON，5s 超时（AbortController），失败重试 3 次指数退避（1/2/4s），最终失败入内存环形缓冲（50 条）。
- 适配（webhook/adapters.ts）：wecom `{msgtype:'text'|'markdown'}`；feishu `{msg_type:'text'|'post'}`；dingtalk `{msgtype:'text'|'markdown'}`；generic 原样透传。加签：wecom sha256 hex 放 URL query；feishu hmac_sha256 base64 放 body；dingtalk 同算法放 query。模板变量 `{title}{kind}{note}{tokens}{question}{sessionUrl}{time}`。
- 配置：对象数组无法 YAML 子集表达 → 独立 JSON `$DSH_HOME/profiles/<profile>/notify-webhooks.json`（atomicWriteJson force）；应用层 config.webhooks 优先。

## 远程触发接口（存在）

- **注册**：`inject:['webServer']` → `ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/notify/api', handler}))`（routes.ts:42-50），挂在 DSH Web 服务器既有 host:port（GUI 同源），**不开独立端口**。
- 路由：GET `/notify/api/stream`（SSE）、POST `/notify/api/trigger`、GET `/notify/api/info`、GET/PUT `/notify/api/config`、GET `/notify/api/webhooks`。
- 事件注入：trigger → `emitNotice({kind:'remote', sessionId, title, note})` → 与内建事件共用 bus。
- 安全：全部路由先过 loopback 信任围栏（host 须 loopback 或 `webRuntime.trustedHosts` 白名单 + sec-fetch-site/origin 同源）；apiToken 非空时 trigger 校验 `x-notify-token` 头。

## toast 兜底（注意：浏览器端 DOM，非后端 toast）

- dispatchByPermission：granted → 系统通知；default → 先请求权限、期间立即 toast+beep、授权后补系统通知；denied / 不可用 / 开关关 → 页内 toast。
- 实现：`document.body` 下 `#dsh-my-notify-toast-box`，命令式 DOM，textContent 防 XSS，6s 自动消失，点击跳会话，上限 4 条；系统通知构造抛异常也降级 toast。

## 设置页

- `attachSettingsTab`（parts/settings.ts:308-341）：`ctx.get('slots', false)` → `slots.inject('settings.plugins.tab', …)` + `slots.register({name:'settings.plugins.tab', id:'notify-settings', order:91, label:'通知提醒'}, NotifySettingsView)`——官方 slots 扩展点（issue #27）。
- 数据流：GET/PUT `/notify/api/config`、GET `/notify/api/webhooks`。

## 配置与存储

- 全集：end/ask/approval/subagentEnd、askMode(full|summary)、webBaseUrl、apiToken、dedupeMs(3000)、webhooks[]、quietHours{enabled,start,end}（默认关 23:00-08:00）。
- 持久化：写 `cordis.patch.yml` 的 config 块（watchUserPatches 热重载即生效；quietHours 展开为扁平字段）；webhooks 单独 JSON；浏览器偏好 localStorage（`dsh-notify:notify/sound/toast/volume`）。

## 版本兼容

- engines node>=22；peerDeps：cordis ^4.0.0-rc.10(optional)、react ^18.2.0||^19.3.0、dsh-session-title ^0.1.5-rc.2(optional)；deps：dsh-shared ^0.1.4、tmp ^0.2.7。`dsh.client.platform='web'`、`dsh.bundle.patch=cordis.patch.yml`。

## 对 pharos 的可借鉴点

1. `ctx.webServer.register` 前缀路由 + 同源 SSE/fetch——M1 host 桥的通信管道照此实现。
2. 触发源用 `agent/status`(idle) / `tools/pre-execute`(ask) / `approval/request` / `session/event`(token)——与我们的 reason.kind 双轨判定互补。
3. webhook 适配器 + 加签 + 重试 + 失败环形缓冲——M1 webhook 直接移植该结构。
4. 信任围栏 + apiToken + Web Locks + quiet hours——安全与去重的现成语义。