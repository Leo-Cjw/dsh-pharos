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

用户点击后反馈 DSH 没有恢复前台。任何手动激活前，只读窗口清单仍为 strat；原生历史从 3 条变为 2 条，但消失的是汇总阶段，再验丙仍存在。这与指定点击对象不一致，原因未确定，不能据此推断用户点击了哪一条。随后手动打开 DSH 读取 Debug：navLog=[]，当前仍为 strat，三个槽位仍存在。固定 tag 候选的实机点击未通过，旧 remote 验收不能代替本轮结果。原始证据为 `%TEMP%/pharos-screenshot-raw-cf214de/candidate3-after-click.txt`。

### 唯一短 tag 与原生历史清理（2026-10-11）

撤回三个固定 tag。检查 [Electron 通知服务](https://github.com/electron/electron/blob/v44.0.0/shell/browser/notifications/platform_notification_service.cc)、[通知容器](https://github.com/electron/electron/blob/v44.0.0/shell/browser/notifications/notification_presenter.cc) 和 [Chromium 事件分发器](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/notifications/notification_event_dispatcher_impl.cc) 后，识别出同 ID 生命周期冲突：新 Web 监听注册后，宿主关闭同 ID 的旧原生通知，旧 close 可以移除新监听。这是源码链支持的原因推断，未捕获本机原生回调顺序，不能把它说成本机日志直接证明。

新实现对每条工作流通知生成唯一短 tag，最近三个通知对象分别保留各自的真实会话 ID。淘汰旧对象时 close 只释放对象，历史删除由本机 `/pharos/api/workflow-history` 负责：系统 Windows PowerShell 执行固定脚本，通过 stdin 接收严格校验的插件 tag，调用 [History.Remove](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationhistory.remove?view=winrt-26100)，并读回确认目标已不存在。只处理本应用 Notifications 组的指定工作流条目，不删除普通提醒；不接收命令、路径或 URL。请求串行批量执行，失败最多重试三次，迟到的旧 show 会再次排队；pending/running/failures/error 在 Debug 可见。没有可用 host 或清理失败时不能保证历史容量。旧版本和旧实例历史不会自动接管，重启仍不能延续旧点击监听。

第四轮 `pharos-workflow-candidate4` 收到 9 个提醒和 1 个静默日志，但自动清理后留下 8 条，容量未通过。查到 PowerShell 中 `@(... | ConvertFrom-Json)` 把多 tag 包成嵌套数组，拼接时产生包含空格的错误 ID；Remove 对不存在的 ID 不报错，因而子进程退出成功不能证明删除成功。已改为直接解析、逐项拼接，并增加原生历史读回校验和真实 Windows PowerShell 多 tag 解析测试。随后用修正后的程序清理这轮指定条目，读回确认删除；这次补清不计作自动容量通过。其他失败轮次的任务测试通知也按明确 tag 清理，普通提醒不受影响。

第五轮 `pharos-workflow-candidate5` 首次请求因上游 `fetch failed` 在工作流启动前失败，SSE 没有工作流事件；重试一次后真实工作流完成。独立 SSE 收到 9 个提醒和 1 个静默日志，Windows 原生历史自动清理后只剩 3 条：五验乙结束、五验甲结束、汇总阶段，没有手工删除本轮通知。原生 tag 为 `n#dsh-app://app#pharos-wf-mv3vm9lc-x55rx8i5-6/7/8`，各为 43 字符；此结果验证自动容量，不单独证明点击。

本轮指定点击“五验甲结束”，真实 childId 为 `01271189-87a6-433e-a629-f06ecd125371`，对应序号 7。点击前 Debug 确认当前为 strat（`session-52766c78-2c8b-4911-9f78-d20217e418ad`）、navLog=[]、上述三个唯一 tag 与各自会话对应，workflowHistoryCleanup 为 pending=0、running=false、failures=0、error=null，autoFocus=true；随后关闭设置，复查 strat，最小化 DSH，并把 Sourcetree 放到前台。电脑工具仍不能操作通知中心，因此请用户点击此确切通知。

用户反馈 DSH 未恢复前台。这次点击验收未通过：手动激活前只读窗口标题仍为 strat，历史剩下五验甲、五验乙，消失的是汇总阶段。无法确定这个差异的原因，也不能推断用户点了哪一条或证明目标监听已经失效。随后手动打开读取 Debug：currentSessionId 仍为 strat、navLog=[]、autoFocus=true，三个唯一 tag 的槽位仍存在，清理状态 pending=0、running=false、failures=0、error=null。没有进入插件导航或恢复请求的证据。日志保存于 `%TEMP%/pharos-screenshot-raw-cf214de/candidate5-after-click.txt`。保留同一进程，再次关闭设置、核对 strat、最小化并切到 Sourcetree；请用户在只剩两条子会话通知的情况下展开通知组，点击五验甲的正文区域，避免组标题或关闭按钮，继续核验确切条目的激活。当前仍不能宣布工作流点击通过。

第二次用户反馈仍未恢复前台，手动激活前标题仍为 strat，这轮全部通知已不在原生历史。随后 Debug 仍为 navLog=[]、当前 strat，清理无错误，三个槽位仍存在，记录于 `%TEMP%/pharos-screenshot-raw-cf214de/candidate5-after-click-recheck.txt`。不能继续要求点击已不存在的条目。

### 系统通知模式与立即关闭诊断（2026-10-11）

不改插件源码，正常退出后临时使用 Electron 自带 `ELECTRON_DEBUG_NOTIFICATIONS`、`--enable-logging=file`、`--log-file` 启动诊断进程，日志留在本机 `%TEMP%/pharos-candidate6-electron-native.log`；环境变量只传给本次子进程，未写入持久系统设置。首次启动窗口尚未暴露时只复查同一进程，没有重复启动；待窗口可操作后继续。

第六轮 `pharos-workflow-candidate6` 在 DSH 前台发出，三次阶段事件在子代理之前，最后三条均为真实子会话结束。SSE 收到 9 条提醒及 1 条静默日志，原生历史为 3 条。原生日志显示最后三条创建后约 20–30 毫秒就收到 `Notification dismissed`，当时尚未人工点击；没有插件 `Hiding notification` 调用日志。这比“客户端 shown、历史存在”更强：当前环境里 reminder 仍会立即关闭。日志没有输出具体 dismissal reason 或每次 dismissed 的 ID，不能据此断言全部原生原因。

第七轮 `pharos-workflow-candidate7` 脚本先等待 30 秒，期间工具明确切到 strat、最小化 DSH、将 Sourcetree 置于前台，再观察后台通知。仍收到 9 条提醒和 1 条静默日志，历史自动只保留最近 3 条子会话结束；原生日志再次记录立即 dismissed。随后普通完成提醒也立即 dismissed，说明本次现象不只出现在工作流容量路径。第七轮未再要求人工点击已知收到 close 的通知。SSE 证据为 `%TEMP%/pharos-workflow-candidate6-sse.jsonl`、`pharos-workflow-candidate7-sse.jsonl`。

只读 `CreateToastNotifier(...).Setting` 返回 Enabled；随后 `ToastNotificationManager.GetDefault().NotificationMode` 返回 **AlarmsOnly**。[微软 NotificationMode 文档](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmanagerforuser.notificationmode?view=winrt-26100) 将它定义为当前用户通知显示模式，[枚举文档](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmode?view=winrt-26100) 明确该模式抑制非闹钟通知。应用允许投递与系统仅允许闹钟是不同状态，不能用 Enabled 排除系统抑制。此 API 在较旧 Windows 上可能不可用。

系统模式与立即关闭已同时观测，但未完成模式切换对照，不能把 AlarmsOnly 宣称为唯一已证实原因，也不能声称已解决该模式下的通知中心点击。已请用户暂时手动关闭请勿打扰/专注模式，待只读确认模式后再运行正常模式对照；代理没有自动改动系统通知设置。当前候选仍待点击收口。

等待系统模式对照期间，已结束临时诊断启动，恢复服务端配置并正常退出、使用原应用启动入口重新打开。客户端 Debug 实际读回 configSource=server、sse=open、workflowEvents=false、workflowLog=false、sound=true、autoFocus=true、currentQuiet=true、workflowNotificationSlots=[]，当前仍为 strat；服务端此前同样读回上述配置。诊断启动参数及环境变量未延续到这次启动，关闭设置后保留可使用的 DSH。恢复证据为 `%TEMP%/pharos-screenshot-raw-cf214de/candidate7-client-config-restored.txt`。

第五轮原始记录为 `%TEMP%/pharos-workflow-candidate5-sse.jsonl`、`pharos-workflow-candidate5-history.json`、`pharos-screenshot-raw-cf214de/candidate5-before-click.txt`。源文件和安装文件对齐：client SHA-256 为 `D7A8BF3E3B105EB3657CEF5E14DC77D573ED0AD3E58CEA0F37A705AD603F7209`；notification-history SHA-256 为 `0ABB842B4471646577F3CD638AFF8F9D4EF6CC259A40C3FAB24DBEC147D8463C`。服务端测试配置已恢复并读回 workflowEvents=false、workflowLog=false、sound=true、autoFocus=true、currentQuiet=true；为保留本轮点击监听，客户端暂未重启，最终恢复仍需验收后正常重启并读回。

新实现完整 `npm test` 通过：浏览器 M1 327 项、host 353 项及原有 v0.3 断言。host 数量包含 Windows 上实际运行的 PowerShell 多 tag 解析测试。模型新增同 ID 旧 close 清除新监听的场景，覆盖 Web/EventEmitter 最近三个通知各自点击、异步清理失败重试、清理中迟到 show 的修订号、卸载停止请求，以及严格来源与 tag 校验、固定程序/stdin、子进程失败与超时。独立副本改回固定三个 tag 后产生 10 项 M1 失败，包含两种 API 的点击导航断言；该反向检查不能替代实机点击。`npm pack --dry-run` 返回 26 个文件，新增 `lib/host/notification-history.js` 已入包。版本仍为 0.6.3，未发布新版本，macOS 未实机重测。

### 正常通知模式对照（2026-10-12，待点击）

用户手动关闭专注模式后，反馈点击一条历史通知已能弹出 DSH。只读 Windows API 确认 NotificationMode=Unrestricted；当时窗口标题仍为 strat，历史条目的具体对象未确定，因此此反馈只作为窗口唤起证据，不计作指定子会话跳转通过。

解锁后，以相同源码正常退出并临时开启 Electron 原生日志重新启动，执行 `pharos-workflow-candidate8`。SSE 收到 9 条提醒和 1 条静默日志，原生历史自动保留八验甲、八验乙、八验丙结束三条，分别使用唯一短 tag 的序号 6/7/8。八验丙的真实目标 childId 为 `f3e74fa8-2fdc-4780-b5ba-d270f9ef5a9a`，tag 为 `n#dsh-app://app#pharos-wf-mv4jefs3-ne6z54nc-8`。本轮没有人工删除历史，系统模式仍读回 Unrestricted，但原生日志仍出现 dismissed，不能把此前 AlarmsOnly 认定为唯一原因。

准备切回 strat 时电脑工具报告有人操作，重新捕获的图像全黑；随后两次窗口激活失败，截图明确为 Windows 锁屏。无法确定锁屏发生在各通知之前还是之后，本轮不能作为“正常模式且桌面解锁”的完整对照。工具没有成功切到 strat、没有执行系统通知点击；当前监听仍保留，需再次解锁后建立点击前后的会话证据。服务端临时配置已恢复 workflowEvents=false、workflowLog=false、sound=true、autoFocus=true、currentQuiet=true；客户端为保留监听暂不重启，配置恢复需最终读回。

前一轮第七轮消息的实际回复也明确说明 workflow 环境没有 timer API，未执行请求中的 30 秒等待。第七轮曾在发送消息后切换会话和窗口，但不能把请求中的等待当作实际执行证据。第八轮没有再请求计时器或终端命令。独立 SSE 已正常退出，原始证据另存于本机 `C:/Users/cjw-9/.codex/visualizations/2026/10/10/01a1234a-9945-7cd1-a2eb-030b77a5a695/pharos-candidate8/`，避免临时文件被清理。

### 第八轮点击结果与原生回调实验（2026-10-12）

再次解锁后，点击前 Debug 明确为 strat（`session-52766c78-2c8b-4911-9f78-d20217e418ad`）、navLog=[]、autoFocus=true；三个槽位与上述甲乙丙真实 childId 一致，历史清理 pending=0、running=false、failures=0、error=null。关闭设置后再次观察 strat 主界面、最小化 DSH、把 Sourcetree 置于前台，才请求用户点击八验丙结束正文。

用户反馈未恢复前台。手动激活前窗口标题仍为 strat，NotificationMode=Unrestricted，本轮三条历史全部消失。Electron 原生日志在 10:03:16、10:03:20、10:03:22 明确记录三次 `Notification clicked`；日志未输出各次对象 ID，不能确定哪一次对应八验丙。随后手动激活读取 Debug，仍为 strat、navLog=[]、autoFocus=true、清理无错误。因此本轮点击未通过，已经确认原生层实际收到点击，而插件导航没有执行。证据保存在上述 candidate8 目录的 `before-click.txt`、`after-click.txt`、`after-click-native.log`。

继续检查 Electron 的 NonPersistentClick/Close 分发链，判断“原生关闭后 Chromium 删除 Web 点击监听”为源码支持的原因方向。本机仍未直接记录 Chromium 内部监听表。没有继续用新 tag 或调整聚焦方法代替链路修复，也没有把 ServiceWorker 作为已可用方案：所查 Electron 源码明确不支持 persistent notifications。

独立 Windows 原生实验已成功创建 Toast、注册 Activated/Dismissed/Failed，并在 Dismissed 后保留 Activated 委托。它使用系统 Windows PowerShell 的内联代码与内置 .NET 反射，不修改系统执行策略、不注册新协议、不修改 DSH 应用。实验实际记录 `dismissed:pharos-native-probe:TimedOut`，等待人工点击同一条历史通知检验 Activated；当前不计作修复或前台恢复通过。此实验尚未接入插件源码。

### 原生 Windows 适配候选（2026-10-12，第九轮待点击）

用户点击独立实验后，仍在运行的原生助手明确输出 `activated:pharos-native-probe`。同一对象先前已经输出 `dismissed:pharos-native-probe:TimedOut`，因此实测证实原生 Activated 委托可在超时后继续接收历史点击。实验进程已停止，实验不等同于 DSH 会话导航验收。

基于此结果，新 Windows 桌面通道由本机 host 惰性启动系统 Windows PowerShell 原生助手，通过固定内联脚本和 stdin JSON 发送标题/正文，不执行请求里的代码，不修改执行策略、不注册新协议。原生 tag 使用随机短 ID，会话 ID 只留在 host 映射。助手在 TimedOut 后保留 Activated，UserCanceled 后释放；激活经带对应客户端标识的 SSE 消息返回原始会话，各页面只消费自己的标识，再复用现有导航服务。自动聚焦仍由现有固定 `dsh://open` 接口处理，并读取当前服务端开关。原生事件不进入提醒总线或 Webhook，不再次响铃。

工作流按当前客户端只保留最近 3 个原生入口，淘汰先删除本应用 Pharos 组的指定历史并读回核实，删除失败不继续发送第四条。助手最多保留 512 个未释放条目，单条显示/删除命令 15 秒超时，宿主卸载关闭 stdin 并结束助手；原生失败只补一次页内提示，不再发送 Web 系统通知。macOS/普通浏览器不启用此通道，没有新 host 时仍走兼容旧路径。原生 ID 表示系统 API 已接收，不作为横幅可见的单独证明；退出/重启后旧点击仍不支持冷启动恢复。

完整 `npm test` 已通过：M1 336 项、host 353 项、另有原生助手/容量/生命周期/路由测试。新增页面断言覆盖原生通道不重发 Web 通知、最近三个键、目标/客户端不匹配拒绝、点击只导航一次、关闭自动聚焦仍后台切换、失败单次兜底与卸载。原生测试还在实际 Windows PowerShell 编译并运行助手 EOF 路径，没有弹真实通知。`npm pack --dry-run` 共 28 文件，包含 `.js` 和 `.ps1` 两个助手文件。

安装后正常退出重启，API 读回 desktopNativeNotifications=true、workflowEvents=true、workflowLog=true、sound=false、autoFocus=true。真实 `pharos-workflow-candidate9` 收到 9 条提醒和 1 条静默日志；原生历史自动只剩九验甲、九验丙、九验乙结束三条，均为本应用 Pharos 组、随机短 tag。最后的九验乙 target childId 为 `0dfd7cd2-bbd5-4ad1-aa14-9307b61a9798`，tag 为 `pharos-native-cd3ee74606976a7a6a923a50`。发送后工具观察到 strat 主界面、最小化 DSH，再将 Sourcetree 置于前台；此时系统模式读回 AlarmsOnly，不冒充正常模式。已请求用户点击九验乙正文，窗口恢复与子会话导航尚待核验。

本轮原始 SSE、历史和完整测试日志保存在本机 `C:/Users/cjw-9/.codex/visualizations/2026/10/10/01a1234a-9945-7cd1-a2eb-030b77a5a695/pharos-native-adaptation/`。版本仍为 0.6.3，未发布版本；临时验收开关需最终恢复并读回。

第九轮首次点击后，用户反馈 DSH 弹出但仍是 strat。读取窗口标题确认为 strat；Debug 为 navLog=[]、desktopNativeNotifications=true、三个 nativeNotifications 仍在且目标映射正确，系统历史同样仍为 3 条。未进入插件导航，不能先归因于 childId 的会话可达性闸门，也不能确定这次实际激活的对象。记录已保存为上述目录的 `candidate9-after-click.txt`。为核验确切单条入口，先保存容量证据，再只删除甲/丙两条本轮测试历史，读回只剩乙；保留同一进程，关闭设置、复查 strat、最小化并切到 Sourcetree，请用户再次点击乙正文。人工删减仅用于点击对照，不作为自动容量通过证据。

第九轮单条复查用户仍反馈窗口恢复、停留 strat；只读标题仍为 strat，九验乙历史仍为 1 条，系统模式为 Unrestricted。不能认定指定原生 Activated 已到达，更不能将窗口恢复当成会话跳转。没有继续要求重复点击同一条。随后正常退出旧宿主，确认助手进程结束；该条历史仍存在，已按精确 tag 清理，不将卸载视作历史必然清空。

后续诊断候选为每条通知显式持有独立 sink 和委托，回调使用绑定的原始 native ID；这属于生命周期加强，未证明此前是 GC 导致丢失。新增受同一来源围栏保护的 `GET /pharos/api/native-notifications`（需要 x-pharos-desktop:1），只提供助手 PID、pending/entries 数量和最近 20 条原生 ack/dismissed/activated 事件及关闭原因，不返回正文、密钥或完整会话 ID。接口请求的多余字段不会覆盖内部 event/id/retired 状态。

正常启动该候选后，用普通 remote 通知“原生链路定位10”验证已知主会话目标 `session-dec7e142-8c50-4818-9e4a-be1eed4fa6dc`；发出前工具确认 strat、最小化、Sourcetree 前台。原生助手明确记录 show ack，62 毫秒后收到同 ID 的 dismissed/TimedOut，证明关闭回调到 host 的传输可用；窗口系统模式此时为 AlarmsOnly，保留一个入口。已请求用户点击新通知，独立 SSE 观察连接同时保留；Activated 与主会话跳转尚待结果。关闭/激活链路不可用的确切原因仍未确认。该候选完整测试仍为 M1 336 项、host 353 项及原生助手测试通过；新增内部字段边界的测试也通过。

## 再次排查

在“设置 → 消息通知”点击 Debug 刷新，先看 framesReceived/recentFrames，再看 recentNotifications：

- suppressed：按 reason 查总开关、完成时机或节流；SSE 上游过滤也可能先行拦截。
- dom-test：走的是设置页测试按钮，不能证明系统通知正常。
- requested：仅请求成功，长期无回调不能算显示成功。
- shown：收到宿主显示回调；仍需确认 Windows 横幅、通知中心和免打扰实际表现。
- denied/unavailable/constructor-error/error：检查权限或宿主通知通道；页面提示是兜底，不代表系统通知已修复。
