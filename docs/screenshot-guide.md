# 截图维护清单

以根目录 `screenshots.json` 为入库清单，README 的图片引用须与清单一致。当前前两张是保留的 macOS 历史通知示例，其余为 2026-10-11 在 Windows DSH 本机拍摄的当前分支候选，版本标注 v0.6.3。截图不表示已经发布新版本。

| 文件 | 平台与内容 | 重拍检查点 |
| --- | --- | --- |
| `screenshot-1-notification.png` | macOS 完成通知 | 保留平台说明；通知须来自真实事件 |
| `screenshot-2-workflow-notifications.png` | macOS 工作流通知栈 | 不用来证明 Windows 工作流实机结果；主会话完成位于图中最上方 |
| `screenshot-3-overview.png` | Windows 插件详情 | 灯塔图标、实际安装版本与当前描述；不修改图中的版本文字 |
| `screenshot-4-settings-basic.png` | Windows 设置顶部 | 标题版本、当轮统计、自动保存说明、自动聚焦、Windows 通知保留和重启限制、完整语言选项 |
| `screenshot-5-settings-timing.png` | Windows 提醒时机与免打扰 | 展开完成提醒三档，但保持原选择；不再使用旧复选框图 |
| `screenshot-6-settings-filter-webhook.png` | Windows 免打扰、过滤、Webhook 空列表 | 工作流开关及重启提示完整，Webhook 文案为自动保存 |
| `screenshot-7-plugins-windows.png` | Windows 已安装插件列表 | 灯塔图标和当前描述，不保留旧 alpha 描述 |
| `screenshot-8-settings-debug.png` | Windows 高级、测试、Debug | 测试按钮只验证页内提示和声音的说明，以及自动保存状态；不是系统通知验收证明 |
| `screenshot-9-webhook-formats.png` | Windows Webhook 格式 | 简洁、详细、自定义三档；示例明确禁用且不含真实密钥 |

当前 Windows 图片由真实窗口捕获结果裁切而来，只去掉空白和无关背景，未缩放、合成界面、改写文字或绘制通知。原始窗口尺寸为 1920×1032；插件详情图裁为 980×530，已安装插件列表裁为 990×580，五张设置图均裁为 802×801，保留完整设置对话框和展开的提醒选项。原始完整窗口图已备份到本机 `%TEMP%/pharos-screenshot-raw-c334fb4`。

本次拍摄前备份本机安装副本的 package.json 到 `%TEMP%/pharos-screenshots-package-before.json`，再同步仓库元数据并正常重启 DSH，避免代码与详情页描述来自不同版本。为展示 Webhook 格式，仅临时加入一个 enabled=false、无 secret、地址为 `https://example.invalid/pharos` 的示例；拍完已恢复 webhooks=[]，读回 enabled=true、autoFocus=true。没有执行 Webhook 推送，也没有改变通知权限或操作系统设置。

## 尚缺的 Windows 通知横幅

当前窗口工具不能捕获 Windows 系统通知横幅或通知中心，尚未加入对应图片。取得真实截图后可新增 `screenshot-10-windows-notification.png`，同步清单和 README。正文应使用短测试会话名或明确的 remote 截图示例，保留 DSH 应用名和完整通知正文；不要将 remote 图标作真实完成事件。

系统横幅应由真实完成或本机 `/pharos/api/trigger` 触发；设置页测试按钮不是替代品。勿扰状态由用户自行处理，不为拍图自动修改系统通知或隐私设置。

## 校验

1. 打开每张新图，确认没有加载骨架、动画残影、截断关键选项或真实凭据。
2. 校验清单、README 引用和实际 PNG 一致，检查 PNG 尺寸及文件大小。
3. `npm pack --dry-run --json` 确认清单内图片入包。
4. 截图与文档更新不改变插件逻辑，无需因此重跑完整功能测试；涉及代码变化时按项目测试要求执行。

截图维护不自动触发发版、打 tag、市场投稿或 npm 发布。
