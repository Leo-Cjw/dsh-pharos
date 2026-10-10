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

## 再次排查

在“设置 → 消息通知”点击 Debug 刷新，先看 framesReceived/recentFrames，再看 recentNotifications：

- suppressed：按 reason 查总开关、完成时机或节流；SSE 上游过滤也可能先行拦截。
- dom-test：走的是设置页测试按钮，不能证明系统通知正常。
- requested：仅请求成功，长期无回调不能算显示成功。
- shown：收到宿主显示回调；仍需确认 Windows 横幅、通知中心和免打扰实际表现。
- denied/unavailable/constructor-error/error：检查权限或宿主通知通道；页面提示是兜底，不代表系统通知已修复。
