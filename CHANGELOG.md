# Changelog

本文件记录 dsh-pharos 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.6.0] — 2026-10-06

工作流提醒（M2.5 里程碑）。经 5 轮方案评审（draft-3 → draft-7）共 29 条修订 / 19 条风险，
实施期又抓出并修复 3 个「方案写了但门禁没覆盖」的缺陷。

### 新增

- **工作流提醒**（`workflowEvents`，**默认关闭**）：订阅 `workflow/phase` · `agent-start` · `agent-end`，
  在多 agent 工作流进入新阶段、子 agent 启动/结束时弹系统通知（标题统一「工作流进展」，
  正文带工作流名）。开启需重启 DSH（订阅在插件加载时建立），关闭即时生效。
- **工作流日志**（`workflowLog`，**默认关闭**，与上一项**互相独立**）：订阅高频的 `workflow/log`，
  5s/run 限流采样后进 `debug().recentFrames` 环形队列，**不弹通知、不外发 webhook**。
- **Webhook 模板** 新增 `{cache}`（缓存命中率 ×100 取整）与 `{tps}`（1 位小数）两个 token，
  语义与既有 token 一致：有值才填、无值空串。
- `debug().recentFrames` 环形队列（20 条）：记录**所有** SSE 帧，入队点早于
  enabled/quietHours/kind 三道早退 —— 「提醒没来」这类最该排查的场景也能看到帧。
- 文档：`docs/sop-workflow-events.md`（效果与排查 SOP）、
  `docs/sop-verify-workflow-prompt.md`（验证用多 agent 工作流 prompt）、
  `docs/workflow-log-analyzer.js`（控制台分析器）、`docs/m2.5-plan.md`（完整方案与评审记录）。

### 修复

- **`skipSubagents` 对「本地 done 路径」无效**（v0.3 起存在的既有缺口，多 agent 场景首次暴露）：
  该判定原先只在 SSE 路径生效，而由 `uiSession` 边沿驱动的本地 done 路径无判定，
  导致子代理完成通知混进「任务已完成」。现由 host 在 `agent-start` 帧捎带 `childId`、
  浏览器半登记后据此过滤。
- **工作流阶段名显示裸 id**：`onSseFrame` 现在把 `frame.sessionTitle` 透传给
  `notificationFor`，复用已有字段而非新增 `title`。
- `client.js` 内嵌版本号长期与 `package.json` 不同步（徽章可能显示错版本）——现四处统一。

### 已知限制

- 「跳过子代理事件」对**工作流帧本身**无效（`agentType` 恒为 `root`，否则默认开关会吞掉整组）；
  子代理会话自己的完成通知会被正确过滤。
- 该过滤判据只覆盖 workflow 场景；普通 subagent 委派（不经 workflow）仍无法识别。
- 点击工作流通知只聚焦窗口，不跳转会话。
- 同名阶段 3 秒内去重；工作流提醒复用默认提示音型。
- 实时提醒依赖 DSH 页面保持打开（与其它提醒类型一致）。

[0.6.0]: https://github.com/Leo-Cjw/dsh-pharos/releases/tag/v0.6.0
