# dsh-pharos 验证用：多 agent 工作流 Prompt

> 用途：验证 `workflowEvents` / `workflowLog` 两个开关是否真的产生提醒。
> 依据：`app.asar` 内 `dsh-tool-workflow` 的 README 与工具描述（`workflow` 工具）核实。

---

## ⚠️ 验证前必做两步（否则一定看不到通知）

1. **设置 → 消息通知 → 过滤** → 勾选 **工作流提醒 (workflowEvents)**
2. **重启 DSH**（订阅在插件加载时建立，不重启不生效）

想同时验证 `workflowLog`，再勾 **工作流日志 (workflowLog)**（可独立勾选）。

---

## Prompt（复制这段发给 DSH）

```
请使用 workflow 工具跑一个多 agent 工作流，严格按下面的要求执行。

meta 请填：
- name: multi-agent-audit
- description: 并行审计三个来源并汇总

脚本要求：
1. 脚本里必须有 3 次 phase() 阶段推进，阶段标题分别用：
   「准备阶段」「分析阶段」「汇总阶段」
2. 必须有 3 个并发 agent 调用，用 await Promise.all，每个 agent 的
   options.label 分别是「读取员」「分析员」「校验员」，
   options.phase 分别对应上面三个阶段名
3. 每个 agent 执行前各有一次 log() 旁白输出
4. 最后 return 一个 JSON 对象汇总三个 agent 的结果

请把完整脚本写出来并执行。
```

> `meta.name` 是**必填**且要求「short kebab-case name」（工具描述原文），
> 所以这里指定 `multi-agent-audit` —— 这样通知标题里的工作流名是**可预期的**，
> 便于你判断通知内容是否正确。

---

## 为什么这样写（对照运行时事实）

| prompt 要素 | 对应运行时机制 | 会触发的 pharos 事件 |
| --- | --- | --- |
| 「使用 workflow 工具」 | 工具名就叫 `workflow`（`dsh-tool-workflow`）。官方 README 明确：**只在用户显式要求 workflow 时使用** —— 所以必须**显式点名**，否则模型会走普通 subagent 调用、**不产生任何 workflow 事件** | — |
| 3 次 `phase()` | `workflow/phase(info, title)` | ✅ 3 条「进入阶段：…」通知 |
| 3 个 `await agent(...)` | `workflow/agent-start(info, agent)` / `agent-end` | ✅ 3 条「启动 agent …」+ 3 条「…结束（completed）」 |
| `options.phase` | `WorkflowAgentInfo.phase` | 进正文与 Debug 队列 |
| `options.label` | `WorkflowAgentInfo.label` | 通知正文里的 agent 名 |
| `log()` 若干次 | `workflow/log(info, message)` | 只进 `debug().recentFrames`，**不弹通知**（需开 `workflowLog`） |

**脚本形态约束**（工具描述原文）：纯 JavaScript、**非 TypeScript**、顶层 `await` 可用、
**不要写 `export const meta`**（meta 是工具的独立参数）、以 `return <value>` 结尾。

---

## 预期观察结果

### 通知（开 workflowEvents）

标题固定为 **「工作流进展」**，正文形如（工作流名取自 `meta.name`）：

```
工作流「multi-agent-audit」进入阶段：准备阶段。
工作流「multi-agent-audit」启动 agent 读取员（第 1 个）。
工作流「multi-agent-audit」agent 读取员 结束（completed）。
…
```

共约 **9 条**（3 phase + 3 agent-start + 3 agent-end）。
若 `meta.name` 已被 pharos 兜底成空串，正文会退化为「工作流进入阶段：…」
（**不会**出现「工作流『工作流』」这种双前缀 —— 那是 v0.6.0 之前修掉的缺陷）。

### 排查（若没收到通知）

在 DSH 控制台执行：

```js
// ① 帧到了没？（关键：入队点在所有过滤之前，enabled 关/静默期也能看到）
__dshPharos.debug().recentFrames.filter(f => f.kind === 'workflow')

// ② 完整调试信息
__dshPharos.debug()   // 看 sse / framesReceived / permission / config

// ③ 检查设置是否真的落盘
//    设置页改完后，配置文件 ~/.dsh/profiles/desktop/pharos.json 里应有：
//    "workflowEvents": true
```

判定表：

| `recentFrames` 里有 workflow 帧？ | 含义 | 下一步 |
| --- | --- | --- |
| **有** | 事件已到宿主，链路通 | 查通知侧：`debug().permission` 是否 `denied`；`config.enabled`；`quietHours` 是否在时段内 |
| **没有** | 事件没产生 或 没订阅 | ① 确认**已重启 DSH**；② 确认 prompt 里**显式点名了 workflow 工具**（否则模型走普通 subagent，不产生事件） |

### 验证 workflowLog（可选）

勾选 `workflowLog` + 重启，再跑一次，然后：

```js
__dshPharos.debug().recentFrames.filter(f => f.subtype === 'log')
// → [{ kind:'workflow', subtype:'log', silent:true, note:'…', … }, …]
```

**不应该**看到通知弹窗或声音 —— 这是 `silent` 帧的预期行为（`silent: true` 表示
不弹通知且不外发 webhook）。如果 log 帧弹了通知，那才是 bug。

---

## 备选：更短的 prompt（若上面太长模型容易跑偏）

```
用 workflow 工具跑一个多 agent 工作流：3 个 phase() 阶段，每个阶段各派 1 个
agent（共 3 个），执行中各 log() 一句说明，最后 return 汇总结果。
```

---

## 已知限制（v0.6.0）

- 首次验证建议**保持工作区干净**（不要有大量待改文件），避免模型把工作流
  跑成普通 subagent 调用。
- 工作流脚本执行时间可能较长（每个 agent 都是一次真实模型调用），
  建议用上面的小规模脚本（3 agent 足够验证，不必上大任务）。
- 若模型在脚本里**没用 `phase()` / `agent()`**（例如它自行简化了编排），
  就不会产生对应事件 —— 此时以 `recentFrames` 为准，不要靠猜。
