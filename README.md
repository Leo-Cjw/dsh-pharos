# dsh-pharos（法罗斯灯塔）

> 法罗斯灯塔（Pharos of Alexandria），世界七大奇迹之一，为夜航者引航。它在你离开 DSH 时替你守望：**任务完成、出错需要你知道、或是模型在等你操作**——灯塔亮起，把你唤回。

DSH 桌面端守望提醒插件：**「需要你操作」+「回复完成」**两路系统提醒 + 提示音 + 标题标记，专为"问完就切走、后台等结果"设计。能力对标社区四个同类插件（dsh-notify-me / dsh-turn-notify / dsh-my-notify / dsh-session-notify）中**浏览器半可实现**的部分，并为当前运行时（DSH 0.2.0-rc.2）原生实现：**零依赖、零 peer 声明**，无兼容性门槛。

## 提醒时机

| 时机 | 提醒内容 | 默认 |
| --- | --- | --- |
| 🔔 **需要你操作** — 审批请求 / 方案待确认（plan-review）/ 提问 | 系统通知 + 三音提示音 + 标题前缀 `🔔 需要你 · ` | 全时提醒；当前会话 + 页面在前台时**静默只留标题标记**（审批卡片本来就在眼前） |
| ⏳ **仍未处理** — 上面的待办 10 分钟没处理 | 补发一次系统通知 + 提示音，正文带「（仍未处理）」 | 每次请求至多补发一次，处理掉即撤销 |
| ✅ **回复完成** — 会话运行结束（含切走后完成的） | 系统通知 + 双音提示音 + **耗时小结**（「耗时 12 秒」） | 仅页面隐藏/后台时提醒 |

- 点通知：窗口回前台，并尽力打开对应会话。
- 通知不可用时（权限被拒 / 未授权）：窗口未聚焦时以 `⏳` 标题闪烁兜底 6 秒。
- 去重：同一待办只提醒一次；「完成」同会话节流（`minIntervalMs`，默认 6s）。
- 页面加载时已存在的待办补提醒一次；历史完成状态不补弹。
- 主开关关闭后：不弹通知、不响铃、不亮标记、不闪烁。

## 配置

配置存 `localStorage`（键 `dshPharos.config`），控制台实时生效：

```js
window.__dshPharos.config()           // 查看当前配置
window.__dshPharos.setConfig({
  enabled: true,               // 主开关
  toast: true,                 // 系统通知
  sound: true,                 // 提示音
  volume: 0.5,                 // 音量 0~1
  autoFocus: true,             // 点通知聚焦 DSH
  attentionHiddenOnly: false,  // 「需要你」仅页面隐藏时提醒
  doneHiddenOnly: true,        // 「回复完成」仅页面隐藏时提醒
  currentQuiet: true,          // 当前会话+前台：「需要你」静默只留标记
  minIntervalMs: 6000,         // 「完成」同会话节流
  reAlertMs: 600000,           // 未处理的「需要你」10 分钟后补发一次
  blinkFallback: true,         // 通知不可用时的 ⏳ 标题闪烁兜底
  language: "auto"             // 'auto' | 'zh' | 'en'
})
window.__dshPharos.resetConfig()      // 恢复默认
window.__dshPharos.test("attention")  // 测试「需要你」
window.__dshPharos.test("done")       // 测试「回复完成」
window.__dshPharos.debug()            // 绑定/权限/待办/定时器诊断
```

## 安装

通过公开 GitHub 仓库一键安装（零构建、零依赖，**仓库根即插件包**）：

- **桌面端（推荐）**：打开 DSH → 插件市场（dshmarket）→ 安装/添加 → 粘贴 GitHub 仓库地址（`github:<owner>/dsh-pharos` 或完整 URL）→ 安装 → **重启 DeepSeek Harness**
- **CLI**：`dsh plugin add github:<owner>/dsh-pharos`（具体语法以 `dsh plugin --help` 为准）

仓库结构（即安装后的布局）：

```
package.json        # dsh.bundle.patch + dsh.client 声明（browser 半，platform: web）
cordis.patch.yml    # 自挂载 loader 行（id/name: dsh-pharos）
lib/index.js        # host 半（no-op，仅为合法 Loader 行）
lib/client.js       # browser 半（全部逻辑：零 require 依赖）
```

重启后在控制台验证：`window.__dshPharos.test("done")`。

> ⚠️ 将 `<owner>` 替换为实际的 GitHub 用户名/组织后再安装。

## 开发

从 GitHub 克隆本仓库开发（`git clone git@github.com:<owner>/dsh-pharos.git && cd dsh-pharos`，零依赖、无需安装）。

- 冒烟测试：`node test/smoke.mjs`（Node ≥ 18；驱动真实 `lib/client.js`，27/27 断言，覆盖需要你/二次提醒/标题标记/完成耗时/主开关/点击跳转/闪烁兜底）
- 发布流程：改 `lib/` 与 `package.json` → 跑测试 → 升版本 → `git push` → 在 DSH 插件市场 / CLI 更新安装 → 重启后控制台 `window.__dshPharos.test("attention")` / `("done")` 验证
- 架构文档：[functional-architecture.md](docs/functional-architecture.md)（功能架构雏形：运行时能力核查 + 四仓库对标 + M0/M1/M2 里程碑）
- 架构图：[pharos-architecture.html](docs/diagrams/pharos-architecture.html)（浏览器半 × Host 半双层结构）· [pharos-sequence.html](docs/diagrams/pharos-sequence.html)（通知事件流）——浏览器打开即交互（主题切换/聚焦/导出）
- 对标仓库代码级分析：docs/research/（notify-me / turn-notify / my-notify / session-notify 逐文件报告）

## 工作原理

浏览器半订阅客户端 `sessions` 服务（硬依赖，本运行时必有）与 `ctx.uiSession`（惰性 `ctx.get()` 获取，避免 inject 硬门控导致条目停在 pending）：

- `uiSession.sessionStatus` 每会话发布 `{ running, pendingInteraction, completionUnread }`，一次订阅覆盖两路提醒：
  - `pendingInteraction` 出现 ⇒ 需要你（`kind` 为 approval / plan-review / question，正文取 toolName·reason 或问题文本）；消失 ⇒ 熄灭标记、撤销二次提醒
  - `running` true→false / `completionUnread` 边沿 ⇒ 回复完成，附客户端侧计时小结
- 二次提醒：「需要你」送达后挂 `reAlertMs` 定时器，触发时若该交互仍挂着则补发一次。
- 标题标记用 `setInterval` 轻量保前缀，避免布局层改写标题后被冲掉（标记激活时才跑）。

## 对标社区插件：做到了什么 / 没做什么

| 对标项 | 来源 | 本插件 |
| --- | --- | --- |
| 需要你操作（审批/提问/方案确认）+ 标题标记 | dsh-notify-me | ✅ |
| 已完成提醒（仅离开时）| dsh-notify-me / dsh-turn-notify | ✅ |
| 未处理二次提醒 | dsh-turn-notify（10 分钟）| ✅ |
| 通知不可用时标题闪烁兜底 | dsh-turn-notify | ✅（⏳，6s）|
| 耗时小结 | dsh-turn-notify / dsh-session-notify | ✅（客户端计时；token/TPS 需 host 侧数据，未做）|
| 点击通知直达会话 | dsh-notify-me / dsh-my-notify | ✅（best-effort）|
| 设置页（设置→消息通知）| dsh-turn-notify / dsh-my-notify | ❌（控制台 API + localStorage 代替）|
| 多事件分类（出错/被中断/达到上限）+ 独立音效 | dsh-turn-notify | ❌ 浏览器半拿不到 host 侧回合事件 |
| 出站 webhook（企微/飞书/钉钉）| dsh-my-notify | ❌ 需 host 半与远程 HTTP 能力 |
| 远程触发接口（本机 POST 通知）| dsh-my-notify | ❌ 需 host 侧路由（`ctx.router` 在目标运行时未见公共通路，以 `webServer.register` 代替）|
| Windows 原生推送 + 自定义图片 | dsh-session-notify | N/A（macOS 平台）|

## 已知限制

- 浏览器层方案：DSH 页面需保持打开（最小化/切后台可以；退出应用收不到）。
- Electron 页面通知需允许 DeepSeek Harness 的系统通知权限（macOS：系统设置 → 通知）。
- 首次页面加载后的第一声需要页面上有过一次用户交互（浏览器自动播放策略）。
- 出错/被中断/达到上限的区分需要 host 侧回合事件流（dsh-turn-notify / dsh-session-notify 的做法），浏览器半无此信号，未实现。
- 点通知"打开对应会话"为 best-effort（`sessions.binding(id)?.session.open()`），失败时仅聚焦窗口。

## License

MIT