# Issue #1：Windows 只有声音，没有系统通知

本记录对应 [issue #1](https://github.com/Leo-Cjw/dsh-pharos/issues/1)。2026-10-10 在用户的 Windows DSH 桌面环境定位并验证；源码基线为插件 0.6.2。以下将实机证据和模拟测试分开。

## 结论与依据

旧实现把完整会话 ID 写入 Web Notification `tag`：

```js
new Notification(title, { body, tag: `dsh-pharos:${sessionId}:${kind}`, silent: true })
```

这在 Electron Windows 通道会产生过长的原生 tag：

1. [Chromium Notification 实现](https://github.com/chromium/chromium/blob/152.0.7975.0/third_party/blink/renderer/modules/notifications/notification.cc) 在有 tag 时把它作为 token；无 tag 时生成随机 token。
2. [Chromium ID 生成器](https://github.com/chromium/chromium/blob/152.0.7975.0/content/browser/notifications/notification_id_generator.cc) 生成 `n#<origin>#<token>`。
3. [Electron 44 Windows 实现](https://github.com/electron/electron/blob/v44.0.0/shell/browser/notifications/win/windows_toast_notification.cc) 将完整 notification_id 传给 WinRT `put_Tag`。
4. [Microsoft ToastNotification.Tag 文档](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotification.tag) 规定 Creators Update 之后上限为 64 字符。

对于本机来源 `dsh-app://app`，原生前缀 `n#dsh-app://app#` 长 16 字符。典型会话 `session-` 加 UUID 长 44 字符，旧实现的 done 原生 tag 长 **76**，error **77**，attention **81**，remote **78**，均超过上限。短 ID 的手动触发可以低于上限，因此“POST 测试能弹、真实事件不能弹”并不矛盾。

上述长度由本地 Node 计算，限制来自微软文档。没有获取到本机原生 HRESULT；tag 超长的判断来自实现链、长度计算以及去掉 tag 后的实机对照，并非声称读取到了 Windows 错误日志。

此外，[Electron Web 通知委托](https://github.com/electron/electron/blob/v44.0.0/shell/browser/notifications/platform_notification_service.cc) 没有实现原生失败到 Web Notification `error` 的回传。旧代码只 catch 构造异常，不能靠“没抛异常”判断通知显示成功。

## 改动

- 系统通知不传 tag，让 Chromium 生成独立 token。本机通知历史里看到的原生 tag 长 48 字符；不包含会话 ID。双源完成节流和 SSE 帧去重继续生效。
- 修复 `completionUnread` 直接调用 notifyDone 的旁路，让 off/hidden/always、quiet hours、子代理过滤和节流共用 maybeNotifyDone。
- hidden 判断同时考虑 document.visibilityState 和 hasFocus。
- 增加 recentNotifications（最多 20 条，保存来源、状态、策略原因，不保存正文或密钥）。构造后是 requested，只有收到 onshow 才变成 shown。若收到 onerror，只补一次页内提示；迟到的失败受当前总开关、toast 和免打扰约束，不重复响铃。
- 设置页说明原有测试按钮测试页内提示和声音，不能作为 Windows 通知验收依据。
- 修复 Windows 下测试 URL 转路径产生双盘符的问题；路径断言使用系统解析后的绝对路径。

## 实机证据

| 检查 | 实际观察 |
| --- | --- |
| 配置与权限 | permission=granted；enabled/toast/sound=true；quietHours.enabled=false；host 配置在线；未配置 webhook |
| 事件链路 | 修复前能看到真实 error/done SSE 帧，排除了“完全没收到事件” |
| 长 tag 诊断候选 | 长 tag 的 remote 构造成功，保持 requested，没有 show/error 回调 |
| 去掉 tag 的 remote | 使用 `session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` 触发；Debug 记录 source=sse、result=shown；Windows 通知历史有对应“远程触发”条目 |
| 真实完成 | 新建一轮只回复“通知验收完成”、不调用工具的对话；发送后最小化 DSH；任务完成后，Windows 通知历史有“任务已完成”及该测试会话标题 |
| 原生 tag 对照 | 历史中旧短 ID 条目的 tag 为 `n#dsh-app://app#dsh-pharos::remote`；新 remote/done 是来源前缀加 32 位随机 token |

通知历史通过只读 WinRT `ToastNotificationManager.History.GetHistory('electron.app.DeepSeek Harness')` 读取。测试没有修改 Windows 通知/安全设置、权限、账户凭据或 webhook 配置。

本机改插件文件后，单独刷新曾因宿主仍请求旧 rev 产生 404，普通重启后恢复。上一轮本机验收只替换安装目录的 lib/client.js，原文件备份为 `%TEMP%/pharos-issue1-original-client.js`；这不是发布或升级包。该候选基于 0.6.2，验收时源码与安装文件 SHA-256 一致：`B04E16881049083CD77F4B733D037AA6831896A05F013EC6AE2D58A01492565E`。普通退出并重新启动后，再次以长 ID 触发，Windows 通知历史确认该候选条目存在。这个 hash 是当时的验收证据，不代表后续合并后的源码。

## 自动化回归与限制

`npm test` 覆盖浏览器 smoke 与 host。新增的 Windows 模型按上面的 ID 规则和 64 字符限制模拟“构造成功但原生不显示”，校准短 ID 成功、旧长 tag 失败；验证 done/error/interrupted/limit/job/remote/workflow 及需要操作都能收到 show。该模型是源码契约回归，不替代 Windows 实机。

反向检查：只把生产通知构造行改回旧 tag，smoke 出现 17 项失败（原有 v0.3 断言通过）；恢复去 tag 修复后全套通过。最终浏览器 M1 247 项、host 317 项均通过，另保留原有 v0.3 断言。

另外覆盖 unread 与 SSE 两种先后顺序的去重、完成三档与 visibilityState、异步失败只补一条、不重复声音、关闭后不补弹、构造失败、诊断队列容量。

真实完成和 remote 已在本机验证。其他事件走同一个 deliver 通道且有自动化覆盖，但未逐类制造真实错误、审批、中断和工作流任务。未验证其他 Windows/Electron 版本。shown 表示宿主显示回调，通知历史表示原生条目存在；没有保存系统横幅截图，也不据此声称验证了用户实际看到横幅、点击聚焦或所有免打扰场景。

## 合并 main（2026-10-10）

已将 `origin/main` 的 `e230be1`（v0.6.3 点击通知跳转修复）合入当前 issue 分支。保留去长 tag、显示回调和异步失败处理，同时保留 main 的导航服务获取、会话状态检查、所有通知类型的点击跳转以及 navLog/deliverLog。

测试桩保留 main 的 Web/EventEmitter 双形态；Windows tag 和 Web 异步错误用例明确使用 Web 形态，避免把 Electron 主进程的通知 API 当成渲染进程 API。合并后的 `npm test` 全部通过：浏览器 M1 280 项、host 317 项，以及原有 v0.3 断言。

合并当时只更新 Git 开发分支；上一节的实机结果属于合并前候选。后续加载和点击对照记录见下节。

## Windows 点击跳转检查（2026-10-10）

合并后再次核对本机安装文件：仍是上述 `B04E1688…` 的 0.6.2 修复候选，尚未加载合并版。安装文件中 `onclick` 只对 attention 调用 openSession，且 openSession 仍使用 `binding(id)?.session.open()`；因此完成、出错等通知没有跳转调用，attention 也没有真正切换主视图的入口。这是对安装源码的确认，不是实机点击结果。

开发分支已包含 main 的导航修复。补充 Windows 长 ID + Web Notifications 回归，把同一模型中的 done/error/interrupted/limit/job/remote/workflow/attention 通知从显示检查延伸到点击检查：每种都必须调用 `uiWorkspace.openSession`，并传入原始完整会话 ID。`npm test` 通过：浏览器 M1 288 项、host 317 项，以及原有 v0.3 断言。

首次尝试被窗口激活失败阻断（`failed to activate captured window`、截图全黑）。用户将 DSH 打开后，继续完成如下实机对照；期间用户按 Esc 停止的轮次均停止输入，收到“继续”后再恢复。

### 通知中心点击与最小化恢复

1. 加载合并候选，client SHA-256 为 `B96D2FFA9C86EB826FB6BE3CF1DEB4D69DD475DF6A2D1CBAE23279A660506829`，普通重启后设置页显示 v0.6.3。DSH 切到 `strat` 并最小化，向现有验收会话发送 remote；用户点击通知中心后反馈没有返回 DSH。Debug 确认 `result=shown`、`hasOn=false`、`navLog=[]`，当前会话仍是 strat。这次不是导航闸门失败，而是没有收到点击回调。
2. [Electron Windows 通知实现](https://github.com/electron/electron/blob/v44.0.0/shell/browser/notifications/win/windows_toast_notification.cc) 在横幅超时后调用 `NotificationDismissed(false, ...)`；[通知基类](https://github.com/electron/electron/blob/v44.0.0/shell/browser/notifications/notification.cc) 把关闭传给委托；[Web 通知委托](https://github.com/electron/electron/blob/v44.0.0/shell/browser/notifications/platform_notification_service.cc) 转成 Chromium 的 non-persistent close；[Chromium 事件分发器](https://github.com/chromium/chromium/blob/152.0.7975.0/content/browser/notifications/notification_event_dispatcher_impl.cc) 在 close 完成后删除监听。因此原生条目仍在通知中心，不等于 Web onclick 仍能触发。此判断来自源码链与本机对照，未读取本机原生超时事件日志。
3. Windows Electron 专用候选启用 `requireInteraction`（client SHA-256 `6A5628246AC1DCFA106A2D3C4643D44609B20D6E62ED260F97F21D04A60EE063`）。原生 XML 确认 `scenario="reminder"`；第二次 remote 的 Tag 为 `n#dsh-app://app#FB670229AEC9EE4EADFD5F31DCD98ECE`。用户点击后仍反馈窗口未恢复，但在任何手动激活前，窗口清单标题已从 strat 变成验收会话；该条通知也已从历史移除。说明点击与切会话已经恢复，窗口恢复仍失败。随后通过 computer-use 手动激活，主视图确认是目标会话；手动激活不计作通知自动聚焦通过。
4. `window.focus()` 不能满足本机最小化恢复。当前候选增加本机 POST `/pharos/api/desktop-focus`，只启动系统 `explorer.exe` 打开固定 `dsh://open`；本机 DSH app.asar 的 `focusPrimaryWindow` 会执行 restore/show/focus，协议已注册，Windows second-instance 也调用该入口。接口仅接受 loopback、JSON、自定义桌面请求头，拒绝跨站 Origin；不接受用户提供的命令或 URL，并尊重 enabled/autoFocus。浏览器只有 Windows Electron 在点击且开启自动聚焦时请求该入口。

最新 client 候选 SHA-256 为 `18EF619E8810531996B241199D85A11FB5D6F12CF1B8E2D783D90E9464F3C1A6`。已复制 client、host/routes 和新增 host/desktop 到本机插件目录，保留备份，普通退出并重新启动 DSH。此时完整 `npm test` 已通过：浏览器 M1 295 项、host 330 项，以及原有 v0.3 断言。Windows 模型覆盖先超时再点击、全部事件类型，以及自动聚焦开关；其他平台不启用 requireInteraction 或恢复请求。host 测试覆盖固定协议启动、平台分支、启动失败及恢复接口来源/开关校验，测试不实际启动应用。

第三次实机点击已确认跨会话跳转。重启后最初确实停在验收会话，但随后明确点击侧边栏 `strat`，重新读取窗口标题确认已切到 strat，才最小化并发出正文含“Windows 第三次验收”的 remote（帧 ID `45f720d9-ee31-4854-b10f-19de7aca210a`，原生 Tag `n#dsh-app://app#4E47D45C67FBCD42F447239B2D10E8E0`）。发出后另一次只读窗口清单仍显示 strat。此后未进行 computer-use 输入，直到用户反馈“跳到这个会话了”。用户反馈后、首次自动输入前，窗口清单和主视图均为验收会话。

设置页 Debug 保留的点击轨迹进一步确认：

```json
{
  "sessionId": "session-dec7e142-8c50-4818-9e4a-be1eed4fa6dc",
  "outcome": "navigated",
  "from": "system-notification",
  "via": "uiWorkspace",
  "alreadyCurrent": false,
  "currentAtClick": "session-52766c78-2c8b-4911-9f78-d20217e418ad"
}
```

其中 `currentAtClick` 是 strat 的 ID，目标 `sessionId` 是验收会话 ID，当前 `currentSessionId` 也等于目标；因此这不是“原本就在目标会话”产生的假通过。随后一条轨迹为 `outcome=focus-requested, via=desktop-protocol, status=200`。200 只代表协议启动请求成功，不单独当作前台聚焦的证明；本机用户反馈已跳到目标会话，首次自动输入前窗口已可见，结合跨会话轨迹构成此次实机结果。未另测所有 Windows 前台焦点限制或多桌面场景。

macOS 行为由平台分支回归保护，本次未在 macOS 实机重测。退出/重启 DSH 后旧通知的点击监听无法恢复；此次修复不提供冷启动会话深链。新通知会保留到点击或关闭，这是避免超时丢监听的行为变化。

该窗口恢复方案新增 `node:child_process`，历史“无 child_process”的投稿描述不再适用；README 已更新，不把本次适配视为已通过插件市场评审。

### 追加运行时回归（2026-10-10）

对本机已运行的 `/pharos/api/desktop-focus` 发出不会启动恢复动作的无效请求，实际响应为：GET 405、缺 `x-pharos-desktop` 403、跨站 Origin 403、text/plain 400，与自动化预期一致。此检查没有修改配置或启动协议。

后台应用场景 A 已通过：关闭设置，切到 strat 并重新观察标题，再将 Sourcetree 切到前台，DSH 保持未最小化。发送 remote 帧 `b19b4fe5-5d77-45f2-a7ac-5b457c689db2`，正文含“Windows 后台应用验证 A”；原生历史中 Tag 为 `n#dsh-app://app#7CFAC467E02A13902C573B66ECDC2790`，scenario 为 reminder。用户点击后明确反馈“是从 Sourcetree 自动返回 DSH 并切到验收会话，验收通过”；随后窗口清单与主视图也确认是目标会话。该场景的前台恢复结论依据用户实际点击反馈，通知历史只用于确认原生条目。

关闭自动聚焦的场景 B 已确认后台跳转：通过设置页将 autoFocus 从 true 改为 false，API 读回 false；关闭设置，明确切到 strat，重新读取标题后最小化 DSH，再将 Sourcetree 切到前台。发送 remote 帧 `31f6532c-4c01-4118-aa39-45168b1f21c1`，正文含“Windows 关闭自动聚焦验证 B”；原生 Tag 为 `n#dsh-app://app#20E5B8BFB1E30E686BAB20952860AA4C`，scenario 为 reminder。用户点击后反馈“仍留在 Sourcetree”。在任何手动激活前，只读窗口清单已显示验收会话标题，确认点击切换了后台会话且没有恢复前台；此结论不依赖随后手动打开 DSH。

B 的用户反馈后，工具两次手动激活 DSH 均返回 `failed to activate captured window`，当时尚未读取此次客户端 navLog。通过配置 API 仅恢复 autoFocus=true 并读回确认，再调用项目自身恢复接口，响应 requested=true；后续截图仍是桌面，因此没有把接口响应当作窗口已恢复的证明。

2026-10-11 收尾：用户反馈已打开 DSH 后，工具成功恢复窗口，主视图仍是验收会话。设置页自动聚焦复选框已勾选，点击 Debug 刷新后客户端实际 `config.autoFocus=true`，关闭设置后服务端 API 再次读回 true，确认原设置已恢复。诊断保留的 A/B 两次追加点击均为 `from=system-notification, outcome=navigated, alreadyCurrent=false, currentAtClick=session-52766c78-2c8b-4911-9f78-d20217e418ad`，目标和当前会话均为 `session-dec7e142-8c50-4818-9e4a-be1eed4fa6dc`，再次确认跨会话跳转。

B 点击后诊断中也有 `focus-requested, status=200`；该字段只记录 HTTP 成功，不检查响应中的 requested，也不证明窗口已恢复。接口在 autoFocus=false 时可返回 200 和 requested=false。因此 B 的“不恢复前台”结论依据用户仍留在 Sourcetree 的反馈，不能扩展为“客户端没有发出任何聚焦请求”。本次未保存 B 点击时恢复接口的响应正文。

## PR 评审收口：工作流容量与测试（2026-10-11）

评审提出的堆积风险已在本机实测，而非仅按代码推演：临时启用 workflowEvents/workflowLog，以三个阶段、三个并发子代理运行 `pharos-workflow-baseline`，原生通知历史留下 9 条 reminder（3 phase、3 agent-start、3 agent-end），后续复查仍存在。未配置 Webhook，未向外部渠道发送验收事件。

第一轮候选按 show 回调保留三条并调用旧对象 close，实机仍留下 8 条；客户端全部 9 条曾为 shown，但保留集合最终为空。这轮没有通过。Electron 的 [CloseNotificationWithId](https://github.com/electron/electron/blob/v44.0.0/shell/browser/notifications/notification_presenter.cc) 调用 Dismiss；Windows 的 [Dismiss](https://github.com/electron/electron/blob/v44.0.0/shell/browser/notifications/win/windows_toast_notification.cc) 使用 ToastNotifier.Hide。关闭回调与通知中心删除不能视为同一件事。因此撤回通过 close 回调维护历史容量的方案。

第二轮改为 Windows workflow 专用的三个固定短 tag：`pharos-wf-0/1/2`，其他通知仍不传 tag。候选 client SHA-256 为 `E27F89D73FF07FCF5C6D7DF6590BD84E62CBF24AFD279BAA70EF463AB2467E59`，源文件与本机安装文件一致，普通退出重启加载。真实工作流 `pharos-workflow-candidate2` 完成后，独立 SSE 观察收到 9 个提醒事件和 1 个静默 log；WinRT 原生历史只剩 3 条，分别为短标甲结束、短标丙结束和汇总阶段。原生 tag 为 `n#dsh-app://app#pharos-wf-0/1/2`，均为 27 字符且 scenario 为 reminder。此结果确认历史容量与短 tag 显示，不单独证明点击有效。

第二轮 SSE 中保留的两个子代理结束事件：

- 短标甲：帧 `0891a057-c230-4021-8f6a-ad12bd567400`，目标会话 `e8a8409b-5163-43e8-ae82-eb1df13186c3`。
- 短标丙：帧 `265473d4-70ba-454b-8c5a-ad8e9243bbcd`，目标会话 `cde58acd-9f01-49a7-9f95-e25e880496f4`。

已补两处评审指出的测试盲区：被节流抑制的事件保留 suppressed/throttled 诊断且不能推迟下一次允许提醒的时间；窗口恢复成功 spawn 后必须 unref，启动失败路径不调用。独立副本中反向加入节流错位、删除 unref 均导致对应测试失败。API 版本复用设置页版本，与 package.json 的 0.6.3 一致，没有擅自发布新版本。

完整 npm test 通过：浏览器 M1 320 项、host 333 项及原有 v0.3 断言。容量模型覆盖 Web/EventEmitter 两条点击路径，短 tag 的 64 字符边界、close 不清历史、同 tag 替换、缺失/迟到显示回调、旧对象迟到回调、构造失败不消耗槽位、三个保留项各自跳转、平台隔离与卸载；EventEmitter 仅是兼容性模型，真实 DSH 渲染进程仍为 Web API。独立副本删掉短 tag 后，容量与短标识断言共 6 项失败，确认模型能抓住本次回归。npm pack --dry-run 确认 host/desktop.js 入包。

评审的 Origin 归一化建议不作为本次必要修复：localhost 与 127.0.0.1 属不同 Origin，不能简单等同放行；现有来源围栏与路由矩阵仍通过。macOS 没有此次容量规则，未做 macOS 实机重测。

本轮短 tag 实机点击验收尚未完成，验收对象为上述短标甲结束通知。其目标是真实 childId；同轮汇总阶段通知的目标仅为工作流运行 ID，不可用来验证会话跳转。等待期间曾打开 DSH 核对客户端配置并补拍设置图，随后关闭设置页，确认仍停在 strat，再次最小化并把 Sourcetree 放到前台；没有重启进程或更换会话。不能把之前 remote 的点击通过沿用为本轮短 tag 的实机结果。

用户要求代理自行点击后，重新检查 Windows 界面工具：Sourcetree、DSH 均可选中，开始菜单可以打开并已关闭，但系统任务栏/通知中心不在可操作窗口列表，界面树也未返回系统面板控件。因此未执行通知中心点击；保留当前进程与通知，不将代码调用 onclick 或读取原生历史当作实际点击验收。

临时配置已通过 API 恢复 workflowEvents=false、workflowLog=false、sound=true、autoFocus=true，并读回确认；设置表单也显示工作流两开关关闭、声音与自动聚焦开启。首次客户端 Debug 仍保留进程载入时的 workflowEvents=true、workflowLog=true，sound=true、autoFocus=true、currentQuiet=true，当前会话为 strat，navLog=[]，三个槽位仍指向甲、丙及汇总阶段；当时为保留通知监听未重启。

后续两次 WinRT 读回均不再包含 `pharos-workflow-candidate2` 条目，DSH 仍停在 strat。重启前再次读取客户端 Debug，navLog=[]，三个槽位仍存在；没有点击或导航记录。原生历史消失的原因未确定，不能据此宣称点击通过或发生导航回归，也不能继续要求点击这轮已不存在的通知。

确认旧条目不存在后，从 DSH「应用 → 退出」正常退出；应用列表确认已停止，再启动现有客户端。新窗口读回 Debug：workflowEvents=false、workflowLog=false、sound=true、autoFocus=true、currentQuiet=true，configSource=server、sse=open、workflowNotificationSlots=[]，当前仍为 strat。服务端与客户端配置恢复均已完成；短 tag 点击验收需重建新一轮真实事件及可操作的通知中心入口。调试原始证据保存在本机 `%TEMP%/pharos-screenshot-raw-cf214de/client-debug-after-history-disappeared.txt` 与 `client-debug-final-restored.txt`。

基本设置和提醒时机两张已按实际安装的 `cf214de` 客户端重拍，并仅做 802×801 真实裁切，保留新容量提示和完成提醒三档选项；这不代替系统通知点击结果。

### 第三轮真实工作流复核（2026-10-11）

正常退出重启 DSH 后运行 `pharos-workflow-candidate3`，独立 SSE 连接收到 9 个提醒事件及 1 个静默 log。WinRT 历史再次确认只有 3 条该工作流进展：再验甲结束、再验丙结束、汇总阶段，分别使用 `pharos-wf-0/1/2`。稍后复查仍为 3 条，再验丙条目仍存在。原始记录为本机 `%TEMP%/pharos-workflow-candidate3-sse.jsonl` 与 `pharos-workflow-candidate3-history.json`。

点击验收指定再验丙结束通知，目标 childId 为 `2d5e418c-34ce-451a-94b0-8aa64ed9a157`。点击前已通过设置 Debug 读回：当前会话为 strat（`session-52766c78-2c8b-4911-9f78-d20217e418ad`）、navLog=[]、permission=granted、sse=open，`pharos-wf-1` 槽位指向上述 childId；随后关闭设置、再次观察 strat 主视图、最小化 DSH 并将 Sourcetree 切到前台。点击前调试证据保存在 `%TEMP%/pharos-screenshot-raw-cf214de/candidate3-before-click.txt`。

Windows 通知中心仍未成为电脑插件可操作窗口，因此已请用户点击上述确切条目，尚未取得点击后证据，不能宣布短 tag 点击通过。服务端测试配置已恢复 workflowEvents=false、workflowLog=false、sound=true、autoFocus=true、currentQuiet=true；为保留此次原生点击监听暂不重启客户端，客户端仍保留本轮临时配置，点击验收后需正常重启并核实恢复。

## 再次排查

在“设置 → 消息通知”点击 Debug 刷新，先看 framesReceived/recentFrames，再看 recentNotifications：

- suppressed：按 reason 查总开关、完成时机或节流；SSE 上游过滤也可能先行拦截。
- dom-test：走的是设置页测试按钮，不能证明系统通知正常。
- requested：仅请求成功，长期无回调不能算显示成功。
- shown：收到宿主显示回调；仍需确认 Windows 横幅、通知中心和免打扰实际表现。
- denied/unavailable/constructor-error/error：检查权限或宿主通知通道；页面提示是兜底，不代表系统通知已修复。
