# dsh-turn-notify 代码级分析（子代理报告整理）

> 仓库：`https://github.com/mzzsfy/dsh-plugin`（唯一分支 `main`，包目录 `packages/dsh-turn-notify/`）
> 版本：`@mzzsfy/dsh-turn-notify@0.12.0`（main HEAD a913c2c）
> 方法：host 半 `src/index.js`（777 行）+ 纯逻辑 `src/core.mjs`（799 行）+ 浏览器半 `src/client.js`（2216 行）逐文件读取；14 个测试清单核对。只读分析，未做运行时黑盒验证。

## 总体机制

- host 半是"单源决策"：观察事件 → 分类/过滤 → 写内存投影（环形 20 条、60s 过期，不落盘）+ 直发 webhook/IM/宿主通知。
- 浏览器半**不以 sessionStatus 为触发源**：只长轮询 `GET /api/turn-notify/projection`（cursor 续传、挂起上限 25s、指数退避重连），经 localStorage 认领锁定"只有一个窗口发声"，再按本地偏好 + 路由名单分发。
- cordis.patch.yml 单行 insert；`dsh.client = { platform:"web", external:["@mzzsfy/dsh-toast/client"] }`（toast 公共依赖可选消费）。

## 六类事件与触发源（全部 host 侧）

`completed / error / interrupted / approval / ask / max-tokens`（core.mjs:5-10）

1. `ctx.on('session/event')`（index.js:324）——回合结束原因由 `turn/end` 的 `event.data.reason.kind` 区分，映射表 `REASON_KIND_TO_CATEGORY`（core.mjs:92-99）：
   - completed→completed、error→error、**aborted→error**（手动停止并入出错）、interrupted→interrupted、**blocked→approval**（审批拦截）、max-tokens→max-tokens；未知 kind → null 不通知。
   - `ask` 来自 `tool/call` 且 `data.name==='ask_user_question'`（core.mjs:106-108）。
2. `ctx.on('approval/request')`（index.js:414）——审批 waterfall 观察者，`next()` 同步放行、通知异步投递。

过滤（host `shouldNotify`，core.mjs:130-138）：六类开关、子代理过滤（`origin==='subagent' || delegationDepth>0`）、**碎轮过滤**（仅 turn/end 类，`durationMs < minTurnDurationMs` 默认 5000ms 不通知；ask/approval 即时送达）。

> 语义要点：非完成事件同样受 minTurnDurationMs 过滤，"非完成必达"不成立。

## 通道（代码 7 通道，README 叙事 6 通道）

`CHANNELS = ['sound','system','toast','blink','webhook','im','host']`（core.mjs:287）

| 通道 | 实现 |
|---|---|
| sound | Web Audio 实时合成 8 种音色 + 上传音效（`/api/turn-notify/sound?id=`），按分类映射 + 分类静音 + 音量；聚焦静默 |
| system | `new Notification`；要求失焦 + granted；点击聚焦并模拟点击侧边栏会话行 |
| blink | system 不可用时 `document.title` ⏳ 前缀闪烁（单条 6s、连环硬顶 30s、返回窗口立停） |
| toast | `@mzzsfy/dsh-toast/client` 的 show()（6s 卡片点击直达）；宿未挂载则 try/require 失败干净禁用 |
| webhook | host 直接 fetch POST，Slack 兼容 JSON + 结构化字段；10s 超时、失败即弃不重试 |
| im | 运行期 `ctx.get('dshIm')` 探测，`dshIm.send(botId,targetId,text)`；IM 目标表 imTargets、开关 imEnabled |
| **host** | 宿主 spawn 平台命令：darwin `osascript display notification`、linux `notify-send`、win32 powershell WinRT toast（带 AUMID）；10s 超时失败即弃；**浏览器在场**（在途长轮询 + 2s 认可窗口 `CLIENT_PRESENCE_WINDOW_MS`）时宿主让位，离场补位（hostNotifyWanted，core.mjs:505） |

事件→渠道路由：host `kindRoutes`（settings.yaml）+ 浏览器 `chooseChannels`（core.mjs 与 client.js 双实现，parity 测试锁定），两层都放行才送达。

## 设置页与配置

- host：`SETTINGS_SCHEMA = z.object({…})`（schemastery，index.js:90-108），`ctx.inject(['settings'], sctx => sctx.settings.register('turn-notify', schema))`（index.js:421-424）——**legacy settings 服务形态**（register/get/update）。
- client：`inject:['slots','sessions','workspaces']`，`ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section', id:'turn-notify', order:41, label:'消息通知'}, …))`（client.js:2205-2209）；导航图标走 `dsh-settings-nav-icons`。
- 配置项：webhookUrl(secret)、minTurnDurationMs(5000)、rootsOnly、suppressSubagentWake、hostNotify/hostNotifyFallback、folderRunningEnabled、enabled{6}、soundMapping{6}、imTargets[]、imEnabled、kindRoutes{}。
- 存储：settings.yaml（命名空间）；音效 `$DSH_HOME/dsh-turn-notify/sounds/`（文件名=内容哈希，index.json 展示名，单文件 2MB/总量 10MB）；本地偏好 localStorage `turn-notify:*`。
- API：`/api/turn-notify/{projection,sounds,upload,sound,mapping,config,test-webhook,test-host,im-targets,test-im}` 10 条，写接口带 Origin/Host 同源守卫 + JSON content-type 校验。

## 数据形状

`buildUnit` → `{ id, category, status, session, workspace, durationMs, tokens, summary, ts, text, routes }`：
- `category` 六枚举为主判；`status` 携带原始 reason.kind（'error' 可能是 'aborted'、'approval' 可能是 'blocked'）。
- webhook payload：`{text, summary, event, category, status, session, workspace, durationMs, tokens, ts}`；tokens 为 assistant 四桶用量（input/output/cacheRead/cacheWrite）合计。

## 版本兼容

- `engines.node>=22`；peer：dsh-session-title >=0.1.2-rc.1、dsh-settings >=0.1.2-alpha.2、schemastery >=3.18.0、react ^18.2.0；dependency `@mzzsfy/dsh-toast ^0.2.0`。
- README 声明 dsh 0.1.2-rc.1 / 0.1.5-rc.3 / 0.1.7-rc.1 通过。
- **风险**：只用 legacy settings 形态；仓库内 `DEVELOPMENT/dsh-api-alignment.md` 称 0.1.7+ 方法面已更换（静态 Config + configEditor）——宿主交换点唯一值得实测的风险。

## 对 pharos 的可借鉴点

1. reason.kind 六类映射表直接复用（§双轨判定主信号）。
2. 宿主原生通知（osascript/notify-send/powershell）+ 浏览器在场让位窗口——"应用最小化/切后台仍能弹"的兜底。
3. minTurnDurationMs 碎轮静默语义。
4. 投影长轮询 + localStorage 认领（单窗口发声）——SSE 之外的备选广播实现。
5. settings 双形态风险 → pharos 设置页主走 browser slot 规避。