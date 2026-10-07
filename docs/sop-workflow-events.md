# dsh-pharos SOP：工作流提醒（workflowEvents / workflowLog）

> 适用版本：**v0.6.0**｜ 设置位置：**设置 → 消息通知 → 过滤**
> 本文只讲这两个开关**实际会发生什么**（全部源码级核实，非设想）。

---

## TL;DR

| 开关 | 默认 | 一句话效果 |
| --- | --- | --- |
| **工作流提醒** `workflowEvents` | **关** | 多 agent 工作流跑到「新阶段」或「子 agent 启动/结束」时弹系统通知 |
| **工作流日志** `workflowLog` | **关** | 工作流脚本的旁白日志（`log()`）进调试队列，**不弹通知** |

**两者互相独立**，可单独开启。开启需**重启 DSH** 生效，关闭即时生效。

---

## 一、开启后具体会发生什么

### 1.1 触发源：只有这 3 类事件会提醒

| 事件 | 宿主侧含义 | 通知正文（实际文案） |
| --- | --- | --- |
| `workflow/phase` | 工作流脚本进入一个新阶段 | `工作流「<工作流名>」进入阶段：<阶段标题>。` |
| `workflow/agent-start` | 脚本里某个 `agent()` 调用建立子 run | `工作流「<工作流名>」启动 agent <标签>（第 N 个）。` |
| `workflow/agent-end` | 某个 `agent()` 调用结束 | `工作流「<工作流名>」agent <标签> 结束（completed/failed/cancelled）。` |

> ⚠️ **关键前提：普通聊天不会触发这些事件。**
> 它们来自 DSH 的 workflow 运行时（`dsh-workflow` / `dsh-tool-workflow`）——
> **只有模型在执行多 agent 工作流任务、并且脚本里调用了 `phase()` / `agent()` 时才有事件**。
> 若你日常只用普通对话（不开工作流），开了这个开关也**不会收到任何通知**——这是正常的，不是故障。

### 1.2 通知走哪些渠道

与其它提醒类型完全一致（复用同一条 `deliver` 链路）：

- **系统通知**（macOS 通知中心）
- 通知不可用时 → **DOM toast** 兜底
- 页面在后台时 → **标题 `⏳` 闪烁** 兜底
- **提示音**：复用默认音型（上行二音），与「任务完成」同款
- 受**安静时段**（`quietHours`）与**主开关 `enabled`** 约束

### 1.3 不会做的事（避免误解）

- ❌ **不会**在点击通知时自动打开对应会话 —— 只有「需要你操作」类通知才跳会话，
  工作流通知只聚焦窗口（`deliver` 里 `openSession` 仅对 `attention` 生效）。
- ⚠️ 工作流**帧本身****不受**「跳过子代理事件」影响 —— 它的 `agentType` 恒为 `root`
  （刻意取舍，否则默认 `skipSubagents=true` 会把整组提醒吞掉）。
  但**子代理会话自己**的「任务已完成」通知会被该开关正确过滤 —— host 判出子代理后下发 sessionId
  （workflow 子 agent 走 `agent-start` 帧的 `childId`；**普通 subagent 委派**走 `agents` 元信息帧的
  `subagentSessionIds`，**v0.6.1 起支持**）。
- ❌ **不会**做累计统计或历史图表 —— 坚持「当轮/逐事件」口径，不落库。

### 1.4 去重规则（可能让你少收一条）

工作流帧的去重键带阶段/序号标识（`dedupeKey = workflow:<会话>:<子类>:<标识>`），
宿主侧 3 秒窗口内同键只发一次。副作用：

- 同一工作流在 **3 秒内两次进入同名阶段** → 第二次不重复提醒。
- 同一序号重复上报 → 不重复提醒。

---

## 二、`workflowLog` 是什么

工作流脚本可以调 `log(旁白文本)` 输出「正在做什么」的说明。开启后：

- 这些旁白**每 5 秒最多取 1 条**（按工作流 run 限流，避免刷屏）
- 帧带 `silent` 标记 → **只进 SSE 与调试队列，不弹通知、不发 webhook**
- 你可以在 DSH 控制台查看：

  ```js
  __dshPharos.debug().recentFrames
  // → [{ kind:'workflow', subtype:'log', silent:true, sessionTitle:'…', note:'…', ts:… }, …]
  ```

> 用途：长任务跑完后回看「它当时到底在干什么」。

**注意**：`recentFrames` 记录**所有**收到的 SSE 帧（容量 20 条），
且入队点在各类过滤**之前** —— 所以「提醒没来」时也能在这里看到帧，**这是排查首选**。

---

## 三、开关行为矩阵（重要：不对称）

| 操作 | 是否需重启 | 原因 |
| --- | --- | --- |
| **开启** `workflowEvents` / `workflowLog` | ✅ **需要重启 DSH** | 订阅在插件加载（`apply()`）时建立，必须重新加载才订阅 |
| **关闭** 两者 | ❌ 即时生效 | 每次事件都会重新读配置，关闭后立刻不再产出帧 |

> 设置页提示文案已写明这一点。若勾了没反应，多半是**忘了重启**。

---

## 四、排查 SOP（按顺序执行）

> 📋 **要实际验证？** 现成的多 agent 工作流 prompt + 预期结果 + 判定表见
> **[sop-verify-workflow-prompt.md](sop-verify-workflow-prompt.md)**。

**现象：开了 `workflowEvents` 但收不到通知**

1. **确认已重启 DSH** —— 最常见原因（见 §3）。
2. **确认任务确实产生了 workflow 事件** —— 普通对话不会产生（见 §1.1）。
   在 DSH 控制台执行：
   ```js
   __dshPharos.debug().recentFrames.filter(f => f.kind === 'workflow')
   ```
   - 有记录 → 事件到了，问题在通知侧（权限/安静时段/主开关），继续第 3 步
   - 无记录 → 事件根本没产生，或插件没订阅（回第 1 步）
3. **逐项排除**：
   ```js
   __dshPharos.debug()
   // permission: 'denied' → 系统通知未授权（macOS：系统设置 → 通知）
   // config.enabled: false → 主开关关了
   // config.quietHours.enabled: true 且当前在时段内 → 安静时段静默全部屏幕渠道
   ```
4. **看帧数**：
   ```js
   __dshPharos.debug().sse          // 'open' = SSE 已连上
   __dshPharos.debug().framesReceived  // 持续增长 = 帧在进
   ```

**现象：只有 `workflowLog` 开了却没反应**

预期行为：它**本来就不弹通知**。请用 §2 的 `recentFrames` 查看。

---

## 五、相关配置速查

`~/.dsh/profiles/desktop/pharos.json`（设置页改同样落盘这里）：

```jsonc
{
  "workflowEvents": false,  // 工作流提醒（阶段/agent 事件）—— 默认关
  "workflowLog": false,     // 工作流日志（旁白，仅调试队列）—— 默认关
}
```

**Webhook 用户注意**：工作流帧也会经 webhook 出站（`silent` 的 log 帧除外）。
可在设置页 Webhook 行的「事件类型」里选 `工作流` 精确控制；不选则视为全事件。

---

## 六、已知限制（v0.6.0）

1. **只覆盖 `workflow/*` 四类事件**，不覆盖 `tool-workflow/*`（后者是工具内部 run 进度，语义不同）。
2. **点击通知不跳会话**（见 §1.3）。
3. **同名阶段 3 秒内去重**（见 §1.4）。
4. **音效复用默认音型**，无专属 workflow 音型。
5. **实时提醒依赖页面打开** —— 与其它提醒类型一致：DSH 页面需保持打开（最小化/切后台可以）。
6. **未实机验证**：本版为 alpha，工作流路径尚未在真实多 agent 工作流任务上跑通端到端验证
   （自动化测试已覆盖归一、去重、静默、配置持久化，但真机跑一次仍建议作为验收步骤）。
