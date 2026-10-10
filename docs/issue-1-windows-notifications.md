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

本机改插件文件后，单独刷新曾因宿主仍请求旧 rev 产生 404，普通重启后恢复。最终只替换本机安装目录的 lib/client.js，原文件备份为 `%TEMP%/pharos-issue1-original-client.js`；这不是发布或升级包。最终源码仍在当前 Git issue 分支，版本号未发布。源码与安装文件 SHA-256 一致：`B04E16881049083CD77F4B733D037AA6831896A05F013EC6AE2D58A01492565E`。普通退出并重新启动后，再次以长 ID 触发，Windows 通知历史确认最终候选条目存在。

## 自动化回归与限制

`npm test` 覆盖浏览器 smoke 与 host。新增的 Windows 模型按上面的 ID 规则和 64 字符限制模拟“构造成功但原生不显示”，校准短 ID 成功、旧长 tag 失败；验证 done/error/interrupted/limit/job/remote/workflow 及需要操作都能收到 show。该模型是源码契约回归，不替代 Windows 实机。

反向检查：只把生产通知构造行改回旧 tag，smoke 出现 17 项失败（原有 v0.3 断言通过）；恢复去 tag 修复后全套通过。最终浏览器 M1 247 项、host 317 项均通过，另保留原有 v0.3 断言。

另外覆盖 unread 与 SSE 两种先后顺序的去重、完成三档与 visibilityState、异步失败只补一条、不重复声音、关闭后不补弹、构造失败、诊断队列容量。

真实完成和 remote 已在本机验证。其他事件走同一个 deliver 通道且有自动化覆盖，但未逐类制造真实错误、审批、中断和工作流任务。未验证其他 Windows/Electron 版本。shown 表示宿主显示回调，通知历史表示原生条目存在；没有保存系统横幅截图，也不据此声称验证了用户实际看到横幅、点击聚焦或所有免打扰场景。

## 再次排查

在“设置 → 消息通知”点击 Debug 刷新，先看 framesReceived/recentFrames，再看 recentNotifications：

- suppressed：按 reason 查总开关、完成时机或节流；SSE 上游过滤也可能先行拦截。
- dom-test：走的是设置页测试按钮，不能证明系统通知正常。
- requested：仅请求成功，长期无回调不能算显示成功。
- shown：收到宿主显示回调；仍需确认 Windows 横幅、通知中心和免打扰实际表现。
- denied/unavailable/constructor-error/error：检查权限或宿主通知通道；页面提示是兜底，不代表系统通知已修复。
