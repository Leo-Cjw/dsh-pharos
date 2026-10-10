# 复盘：v0.6.3「点击通知不跳转会话」

> 时间：2026-10-09。影响面：从 v0.3 起，「点击系统通知跳转到对应会话」**从未真正生效过**。
> 代码修复本身只有几十行，但这轮排查花了六轮往返、犯六次错。本文记录的是**方法论**，不是代码。

## 1. 结论速览

| 项 | 内容 |
|---|---|
| 真根因 | 导航 API 语义用错：`session.open()` 是「拉事件流」不是「切视图」；`binding(id)` 对未 retain 的会话返回 `undefined` |
| 正确入口 | `uiWorkspace.openSession(id)` → `replaceMain(target, signal, "reveal")` |
| 次要修复 | 系统通知原先只对 `attention` 跳；同一次完成弹两条通知 |
| 社区对标 | notify-me / session-notify / turn-notify / my-notify 在当前运行时**同样跳不了**（详见 §5） |
| 核心教训 | **静默失败模式必须自带可观测性**，否则排查成本是修复成本的数十倍 |

## 2. 现象与「为什么它难以定位」

用户报告：点系统通知 → DSH 被拉到前台 → 会话页不变。

这个失败模式的恶劣之处在于**它没有任何失败信号**：

- 通知横幅正常弹出（看起来成功）；
- 点击被系统接收、窗口被激活（看起来成功）；
- 界面不动，**且不报错、不留痕**。

于是「成功」与「静默失败」在外部观察上完全同形。唯一能区分的，是**代码内部有没有走到**。

## 3. 六次错误（全部同类）

排查过程中我错了六次，**每一次都是同一个模式**：拿推理代替观测，且越错越笃定。

| # | 错误结论 | 错因 | 被什么打脸 |
|---|---|---|---|
| 1 | `session.open()` 不可用，得找新 API | 只读了签名与注释，没读实现（`doOpen()` → `SessionEventStream`） | 读 `app.asar` 源码 |
| 2 | cordis `strict=false` 是拿服务的**必要**条件 | 把 `impl.fiber.state !== 2`（fiber 是否 ACTIVE）误读成「是否声明了 inject」 | `ReflectService.get` 的 docstring 原文 |
| 3 | 插入诊断代码后跳转失败 = 代码有问题 | 诊断代码本身可能干扰；且**没等干净构建就让你验证** | 你重启后一切正常 |
| 4 | `done` 帧的 sessionId 是空串，host 取 id 与取 title 不同源 | 让你去查一个**我从未记录的字段**（`pushDebugFrame` 只存 6 个摘要字段，不含 sessionId） | `allKeys` 输出与代码逐字吻合 |
| 5 | 完成通知一直是好的（你点的是当前会话） | 单次采样 + 我已有的假设恰好能解释它 → 把巧合当因果 | 你描述的操作序列推翻了它 |
| 6 | Electron 里 `Notification` 不是 Web API，`onclick` 无效 | 拿**主进程**（Node 侧）的用法 `new Notification({…}).once("click").show()` 去推断**渲染进程** | 真机 `hasOn: false`；且 `contextIsolation:true / nodeIntegration:false / sandbox:true` |

第 4、6 次尤其值得记：**它们都伪装成了「有证据支撑的推论」**——第 4 次引用了真实的代码行号，第 6 次引用了 app.asar 里真实存在的代码。两者的错误都在于**证据是真的，但推论跨了边界**（前者跨到了未记录字段，后者跨到了另一个 JS 上下文）。

> ⚠️ 反面教材：注释写得越详尽、语气越笃定，越容易把未核实的假设固化成「设计前提」，
> 让后续维护者（包括我自己）继续沿错误前提推理。#2 的那条错误注释，直接导致了缺陷 1 的
> 设计（把半初始化实例永久缓存）。

## 4. 真正解决问题的两步

### 第一步：把「静默失败」变成「可观测失败」

新增 `window.__dshPharos.debug()` 的四个字段（**建议长期保留**）：

| 字段 | 作用 |
|---|---|
| `deliverLog` | 每次投递走哪条渠道（`system-notification` / `dom-toast` / `dom-toast(fallback)`）、发了什么、是否挂了 `onclick` |
| `navLog` | 每次点击的判定：`outcome`（navigated / gate-blocked / fallback-open …）、`from`（点击来源渠道）、`via`（导航路径）、`alreadyCurrent`、`currentAtClick`、`detail`（被哪条闸门拦住） |
| `navService` | `uiWorkspace` / `workspaces` 可用性与是否已缓存、两个投影的 `phase`、`sessions.ids` 数量 |
| `recentFrames[].sessionId` | 帧归属的第一手证据（**此前漏记**，直接导致错误 #4） |

关键是 `navLog` 的存在让「点击有没有到达 `openSession`」成为**一行可查的事实**——
`openSession` 入口第一行就记录，能进函数必留痕。`navLog` 为空 ⟹ 点击根本没进来。
这个事实如果在第一次排查时就建立，后面五轮都不会发生。

### 第二步：把 mock 对齐真实宿主语义

测试 mock 照抄了 Web Notifications API（带 `onclick`、无 `on`/`show`），
于是「只挂 `onclick`」的实现在测试里永远「正常」。现改为**双形态**：

- 默认形态：有 `on`/`once`/`show`，点击**只**派发 `on('click')`、**不回落** `onclick`；
- `notificationStyle:'web'`：标准 Web API，只有 `onclick`。

生产代码对两种宿主形态都做能力探测后挂载，任一路径被删都有用例抓住。
**双形态的价值不在于「Electron 很特殊」，而在于实现不押注任何单一宿主形态。**

（附注：真机最终证明渲染进程就是标准 Web API，双形态中的 Electron 那一路并未被触发。
但保留它是对的——宿主形态不由插件决定。）

### 变异验证

修复不是「测试绿了就算数」。每个修复点都单独还原成坏实现，确认对应断言会红：

| 变异 | 捕获 |
|---|---|
| `openSession` 还原 v0.6.2（`binding().session.open()`） | 4 项 |
| 解析阶段即缓存 uiWorkspace（缺陷 1） | 半初始化实例回归 |
| 读服务而非快照（三道闸门静默失效） | 3 项 |
| `byId` 取代 `ids` | byId-ids 分歧 |
| 去 phase / state / 归档闸门 | 各 1 项 |
| 只写 `onclick`、不挂 `on()` | 16 项 |
| 恢复 `kind === "attention"` 限制 | 15 项 |
| `completionUnread` 边沿直连 `notifyDone` | 3 项 |

其中有一处**测试自身也曾测不出缺陷**：最初的「半初始化实例」用例改的是同一实例的方法，
即便实现把坏实例永久缓存，那个引用后来照样能用 → 断言照样绿。改为让 cordis 语义下的
**新实例**接手才真正暴露问题。

## 5. 顺带查明：社区插件为什么也跳不了

| 插件 | 跳转方式 | 在当前运行时 |
|---|---|---|
| dsh-notify-me v1.1.8 | `window.focus()` + `sessions.open(id)` | 🔴 哑 —— `sessions.open` **方法不存在**，守卫直接 return |
| dsh-session-notify | `window.focus()` + `close()` | 🔴 本就不跳 |
| dsh-turn-notify v0.12 | `focus()` + 模拟点击侧边栏会话行（DOM hack） | 🟡 靠 workaround |
| dsh-my-notify v0.4 | `ctx.get('sessions', false)` | 🟡 同遇导航 API 缺失 |

根因是当年的 GUI **没有路由抽象**（无 `location.hash`、无 `/session/` 路径、无自定义 scheme，
故 M2 阶段已闭环删除 `{sessionUrl}` 深链变量）。pharos 当年是照抄 notify-me 的写法，
于是继承了这个从未生效的能力。**现在 `uiWorkspace.openSession` 存在了，
pharos 是这几家里唯一真正用上的。**

## 6. 方法论沉淀

### 6.1 静默失败必须自带观测

判断标准：**这个功能失败时，用户/调用方能否在 10 秒内分辨「失败了」还是「本来就这样」？**
不能，就加观测——不要等排查时再加。

本例中 `alreadyCurrent` 字段就是为此而生：导航到**当前会话**时，导航是成功的、界面也确实
不变，但这与「跳转失败」在外部观察上同形。这个字段把两者一眼分开。

### 6.2 观测代码要和被测代码同源

我曾让用户去查 `sessionId`，而该字段**根本不在我记录的摘要里**——`allKeys` 输出与代码
逐字吻合，我却据此编了整条推论。

> 观测工具本身也要被验证：先跑一遍确认它真的记了你以为的东西。
> 更稳的做法是让观测**穷尽**关键字段（宁可多记，别漏记）。

### 6.3 mock 的保真度决定测试的有效性

mock 照抄了「我认为宿主是什么样」，于是把错误假设固化成了假象
（本次：`strict` 参数声明了却从不使用；Notification 形态照抄 Web API）。
**mock 应当照抄「我已验证的宿主行为」，未验证的部分要么双形态、要么显式标注。**

### 6.4 注释里的宿主行为陈述要可回查

本仓库大量注释在陈述宿主行为（`open()` 不是导航、`scopes` 只在 `retain` 时 materialize）。
这些经回查**基本属实**，方向判断可靠。真正出问题的是**新增注释里那条我无法证实、
且经查是错的 cordis 推断**——而它恰好是新设计的推理起点。

> 建议：注释里引用宿主行为时，附上**可验证的定位**（文件 + 行号 + 关键代码片段），
> 并在真机验证后回填结论。本次错误 #2 就是因为只引了行号、没引 docstring 的语义。

### 6.5 不要在干净构建验证之前插入诊断代码

错误 #3：我没等干净构建就插入 `__PHAROS_TRACE` 并让你去点通知，那次失败很可能由它造成。
**顺序应该是：① 先让你验证干净构建；② 确认仍有问题；③ 再上探针。**

## 7. 遗留事项

- `debug()` 的四个观测字段**建议长期保留**并在设置页 Debug 区暴露。
- 待真机确认：同一次完成弹两条通知的修复（`completionUnread` 边沿改走 `maybeNotifyDone`），
  已在离线测试覆盖，需一次真机复验。
- 已知未做：`test()` 在无当前会话时用合成 id `console`，会被闸门拦下而点击无反馈
  （与官方 `sessionLinkState` 口径一致，属一致行为；如需改善应给页内 toast 加不可点视觉区分）。
